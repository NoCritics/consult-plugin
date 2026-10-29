// Live test: codex_generate_image end to end through the MCP server. Two calls:
// two 16:9 images, then one transparent image. Checks that every file is in the
// output folder, is a PNG, that the 16:9 ones are wider than tall, that the
// transparent one has an alpha channel, that codex_reply doesn't point into
// Codex's own folder, and that Codex's generated_images folder was not left with
// anything new. Uses the Codex usage quota, ~3 min.
// Run: node mcp/codex-image-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, unpack, handshake, toolError } from './test-helpers.js';
import { detectImageType } from './lib/image.js';

const codexImagesDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-codex-image-test-'));
const testStart = Date.now();
// PNG colour type is byte 25 of the file: 6 is RGBA (it has real alpha).
const PNG_COLOUR_TYPE_OFFSET = 25;
const PNG_COLOUR_TYPE_RGBA = 6;

let failed = false;
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
  if (!ok) failed = true;
}

function checkFilesInOutputFolder(result) {
  for (const image of result.images) {
    const bytes = fs.existsSync(image.path) ? fs.readFileSync(image.path) : null;
    const inFolder = path.dirname(image.path) === outDir;
    const detected = bytes === null ? null : detectImageType(bytes);
    const isPng = detected !== null && detected.type === 'png';
    check(inFolder && isPng, `${image.path} (${image.type}, ${image.width}x${image.height}, ${image.bytes} bytes) is a PNG in the output folder`);
  }
  check(result.images.length > 0, 'at least one image returned');
  check(!/\.codex/i.test(result.codex_reply), 'codex_reply does not point into .codex');
  console.log('codex_reply:', JSON.stringify(result.codex_reply).slice(0, 300));
}

const { send, waitFor, kill } = startServer();
try {
  await handshake(send, { clientName: 'codex-image' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codex_generate_image', arguments: {
    prompt: 'A flat yellow star centred on a plain white background.',
    count: 2,
    aspect_ratio: '16:9',
    transparent_background: false,
    output_dir: outDir
  } } });
  const wideReply = await waitFor(2, 600000);
  const wideError = toolError(wideReply);
  if (wideError) {
    console.error('FAIL: codex_generate_image (16:9) error:', wideError);
    failed = true;
  } else {
    const wide = unpack(wideReply);
    console.log(`16:9 call: ${wide.images.length} image(s) in ${wide.latency_ms}ms`);
    check(wide.images.length === 2, 'two images returned for count 2');
    checkFilesInOutputFolder(wide);
    for (const image of wide.images) {
      check(image.width > image.height, `${path.basename(image.path)} is wider than tall`);
    }
  }

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codex_generate_image', arguments: {
    prompt: 'A single red apple, no shadow, as a sticker.',
    transparent_background: true,
    output_dir: outDir
  } } });
  const clearReply = await waitFor(3, 400000);
  const clearError = toolError(clearReply);
  if (clearError) {
    console.error('FAIL: codex_generate_image (transparent) error:', clearError);
    failed = true;
  } else {
    const clear = unpack(clearReply);
    console.log(`transparent call: ${clear.images.length} image(s) in ${clear.latency_ms}ms`);
    checkFilesInOutputFolder(clear);
    for (const image of clear.images) {
      const colourType = fs.readFileSync(image.path)[PNG_COLOUR_TYPE_OFFSET];
      check(colourType === PNG_COLOUR_TYPE_RGBA, `${path.basename(image.path)} has PNG colour type ${colourType} (6 = RGBA)`);
    }
  }

  // Codex keeps what it generates in generated_images/<id>/; consult must have removed its own.
  const leftBehind = [];
  if (fs.existsSync(codexImagesDir)) {
    for (const entry of fs.readdirSync(codexImagesDir)) {
      if (fs.statSync(path.join(codexImagesDir, entry)).mtimeMs >= testStart) leftBehind.push(entry);
    }
  }
  check(leftBehind.length === 0, `no new folder left in ${codexImagesDir}${leftBehind.length ? ': ' + leftBehind.join(', ') : ''}`);
} finally {
  await kill();
}
console.log(`images kept in ${outDir}`);
console.log(failed ? 'FAILED' : 'ALL PASSED');
process.exit(failed ? 1 : 0);
