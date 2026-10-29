// Image handling for the vision-capable tools.
//
// Three providers, three completely different transports:
//   codex  -- native `-i <file>` flag; bytes never touch this process
//   agy    -- no image flag at all; it reads the path off disk itself
//   local  -- OpenAI `image_url` content part, base64 data URI (bytes DO
//             transit this process, so size matters here and only here)
//
// Downscaling is worth the code: Ollama tiles images, so pixels drive cost and
// latency (3000x2000: 4084 prompt tokens and 78s; 96x96: 37 tokens). A 1024
// long edge keeps the answer and cuts both ~10x.
//
// Deliberately dependency-free. PNG decoding needs only the built-in zlib,
// and screenshots -- the dominant vision case for a coding tool -- are PNG.
// JPEG/WebP/GIF cannot be resized without a real decoder, so for those we
// read the dimensions from the header, warn, and send as-is. See
// `resizeSupported` below.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Bytes read from disk per image before we refuse outright. This is a
// sanity ceiling, not the token budget -- downscaling handles the latter.
const MAX_FILE_BYTES = 32 * 1024 * 1024;

// Default long-edge target for `local`. ~1024 puts a typical screenshot in
// the few-hundred-token range instead of the few-thousand.
export const DEFAULT_MAX_EDGE = 1024;

// Shapes codex_generate_image accepts; kept here so settings.js can validate the
// setting without importing the Codex image runner.
export const CODEX_IMAGE_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', 'auto'];

const SIGNATURES = [
  { type: 'png',  mime: 'image/png',  test: b => b.length > 8 && b.readUInt32BE(0) === 0x89504E47 && b.readUInt32BE(4) === 0x0D0A1A0A },
  { type: 'jpeg', mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { type: 'gif',  mime: 'image/gif',  test: b => b.length > 6 && b.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/) },
  { type: 'webp', mime: 'image/webp', test: b => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' }
];

// Sniff the actual bytes rather than trusting the extension -- a `.png` that
// is really a JPEG would otherwise reach the runner mislabelled in its data
// URI mime type, and some runners reject that outright.
export function detectImageType(buf) {
  for (const s of SIGNATURES) {
    try { if (s.test(buf)) return { type: s.type, mime: s.mime }; } catch (_) {}
  }
  return null;
}

// --- dimension parsing (header-only, all formats) ---------------------------
// Cheap enough to run on every image: tells us whether a resize is even needed
// and lets us warn accurately for formats we cannot resize.

function pngSize(b) {
  // IHDR is always the first chunk: 8-byte sig, 4 len, 4 type, then w/h.
  if (b.length < 24) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegSize(b) {
  // Walk the marker segments to the first SOFn (excluding DHT/DAC/RST).
  // Bound is `length - 8` because the widest read in the loop is
  // readUInt16BE(i + 7), which touches byte i+8. A tighter bound would skip a
  // SOF that sits at the very end of the buffer.
  let i = 2;
  while (i < b.length - 8) {
    if (b[i] !== 0xFF) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    const isSOF = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    // JPEG stores height before width; return them in the same {width, height}
    // key order as the other parsers so callers can compare shapes uniformly.
    if (isSOF) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return null;
}

function gifSize(b) {
  if (b.length < 10) return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function webpSize(b) {
  const fourcc = b.subarray(12, 16).toString('latin1');
  try {
    if (fourcc === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3FFF, height: b.readUInt16LE(28) & 0x3FFF };
    if (fourcc === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
    }
    if (fourcc === 'VP8X') return {
      width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
      height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1
    };
  } catch (_) {}
  return null;
}

export function readDimensions(buf, type) {
  try {
    if (type === 'png') return pngSize(buf);
    if (type === 'jpeg') return jpegSize(buf);
    if (type === 'gif') return gifSize(buf);
    if (type === 'webp') return webpSize(buf);
  } catch (_) {}
  return null;
}

// --- validation -------------------------------------------------------------

/**
 * Resolve and validate one image path. Returns { path, type, mime, bytes,
 * width, height, buffer }. Throws with an actionable message otherwise.
 *
 * `buffer` is included because every caller that validates also needs the
 * bytes (local encodes them; codex/agy only need the path, but validating
 * without reading would mean two stat/read passes).
 */
function loadImage(p) {
  if (typeof p !== 'string' || !p.trim()) {
    throw new Error('Image path must be a non-empty string.');
  }
  const abs = path.resolve(p);

  let st;
  try { st = fs.statSync(abs); }
  catch (_) { throw new Error(`Image not found: ${abs}`); }
  if (!st.isFile()) throw new Error(`Image path is not a file: ${abs}`);
  if (st.size === 0) throw new Error(`Image file is empty: ${abs}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`Image is ${(st.size / 1048576).toFixed(1)}MB, over the ${MAX_FILE_BYTES / 1048576}MB limit: ${abs}`);
  }

  const buffer = fs.readFileSync(abs);
  const detected = detectImageType(buffer);
  if (!detected) {
    throw new Error(
      `Not a recognised image (checked file signature, not extension): ${abs}. ` +
      `Supported: PNG, JPEG, GIF, WebP.`
    );
  }
  const dims = readDimensions(buffer, detected.type) || {};
  return {
    path: abs,
    type: detected.type,
    mime: detected.mime,
    bytes: st.size,
    width: dims.width ?? null,
    height: dims.height ?? null,
    buffer
  };
}

/** Validate a list of paths, tagging which index failed. */
export function loadImages(paths) {
  if (!Array.isArray(paths)) throw new Error('`images` must be an array of file paths.');
  return paths.map((p, i) => {
    try { return loadImage(p); }
    catch (e) { throw new Error(`images[${i}]: ${e.message}`); }
  });
}

// --- PNG decode / downscale / encode ----------------------------------------
// Only PNG. Everything else needs a real codec, which would mean a dependency
// on a project that currently has exactly one.

export const resizeSupported = (type) => type === 'png';

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let x = 0xFFFFFFFF;
  for (const b of buf) x = table[(x ^ b) & 0xFF] ^ (x >>> 8);
  return (x ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a non-interlaced, 8-bit PNG to flat RGB. Returns null for anything
 * outside that (16-bit, Adam7 interlacing) rather than throwing -- callers
 * treat null as "can't resize, send as-is", which is a warning not an error.
 */
function decodePng(buf) {
  // Signature (8) + IHDR length/type/data/crc (25) = 33 bytes minimum. Without
  // this guard a truncated file that still matches the 8-byte PNG signature
  // throws ERR_OUT_OF_RANGE out of readUInt32BE and takes the server down --
  // callers expect null ("can't resize"), never an exception.
  if (buf.length < 33) return null;
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  const bitDepth = buf[24], colorType = buf[25], interlace = buf[28];
  if (bitDepth !== 8 || interlace !== 0) return null;

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = CHANNELS[colorType];
  if (!channels) return null;

  // Gather IDAT (may be split across chunks) and any palette.
  let pos = 8, palette = null;
  const idat = [];
  while (pos < buf.length - 8) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!idat.length) return null;
  if (colorType === 3 && !palette) return null;

  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); }
  catch (_) { return null; }

  const bpp = channels;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;

  // Undo per-scanline filters in place.
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.from(line);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) cur[i] = (cur[i] + a) & 0xFF;
      else if (filter === 2) cur[i] = (cur[i] + b) & 0xFF;
      else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xFF;
      else if (filter === 4) cur[i] = (cur[i] + paeth(a, b, c)) & 0xFF;
      else if (filter !== 0) return null;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }

  // Normalise every colour type to RGB. Alpha is composited onto white so a
  // transparent screenshot doesn't arrive as black boxes.
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, n = width * height; i < n; i++) {
    let r, g, b, a = 255;
    if (colorType === 0) { r = g = b = out[i]; }
    else if (colorType === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (colorType === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else { // palette
      const idx = out[i] * 3;
      if (idx + 2 >= palette.length) return null;
      r = palette[idx]; g = palette[idx + 1]; b = palette[idx + 2];
    }
    if (a !== 255) {
      const t = a / 255;
      r = Math.round(r * t + 255 * (1 - t));
      g = Math.round(g * t + 255 * (1 - t));
      b = Math.round(b * t + 255 * (1 - t));
    }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
  }
  return { width, height, rgb };
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// Box filter (average over the source rectangle) rather than nearest-neighbour.
// Nearest aliases badly on text, which is exactly what a screenshot contains.
function boxDownscale(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 3);
  const xr = sw / dw, yr = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(dy * yr), y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((dy + 1) * yr)));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * xr), x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((dx + 1) * xr)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 3;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      const o = (dy * dw + dx) * 3;
      dst[o] = Math.round(r / n); dst[o + 1] = Math.round(g / n); dst[o + 2] = Math.round(b / n);
    }
  }
  return dst;
}

/**
 * Shrink a PNG so its long edge is at most `maxEdge`. Returns the original
 * buffer unchanged when it already fits or cannot be decoded.
 */
export function downscalePng(buf, maxEdge) {
  const decoded = decodePng(buf);
  if (!decoded) return { buffer: buf, resized: false, reason: 'undecodable' };
  const { width, height, rgb } = decoded;
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { buffer: buf, resized: false, reason: 'already_small' };

  const scale = maxEdge / longEdge;
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));
  const out = encodePng(dw, dh, boxDownscale(rgb, width, height, dw, dh));
  return { buffer: out, resized: true, from: { width, height }, to: { width: dw, height: dh } };
}

/**
 * Turn validated images into OpenAI content parts for `local`, downscaling
 * where possible. Returns { parts, warnings } -- warnings are surfaced on the
 * tool result rather than thrown, since an oversized image still works, just
 * slowly.
 */
export function prepareImagesForLocal(images, maxEdge = DEFAULT_MAX_EDGE) {
  const parts = [];
  const warnings = [];
  for (const img of images) {
    let buffer = img.buffer;
    let mime = img.mime;

    if (img.type === 'png') {
      const r = downscalePng(buffer, maxEdge);
      if (r.resized) {
        warnings.push(
          `${path.basename(img.path)}: downscaled ${r.from.width}x${r.from.height} -> ${r.to.width}x${r.to.height} ` +
          `(long edge > ${maxEdge}px). Large images cost disproportionately more tokens and latency.`
        );
        buffer = r.buffer;
      } else if (r.reason === 'undecodable') {
        warnings.push(`${path.basename(img.path)}: PNG could not be decoded for resizing (16-bit or interlaced); sending at full size.`);
      }
    } else if (img.width && img.height && Math.max(img.width, img.height) > maxEdge) {
      // No decoder for these formats. Be explicit about the consequence and
      // the fix rather than silently sending a 12MP photo to a local model.
      warnings.push(
        `${path.basename(img.path)}: ${img.width}x${img.height} ${img.type.toUpperCase()} exceeds ${maxEdge}px and cannot be ` +
        `auto-resized (only PNG resizing is built in). Sending full size -- expect high token use and slow response. ` +
        `Convert to PNG, or resize it first.`
      );
    }

    parts.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` }
    });
  }
  return { parts, warnings };
}
