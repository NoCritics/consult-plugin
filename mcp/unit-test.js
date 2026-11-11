// Offline unit tests for lib helpers and council aggregation.
// No spawn, no LLM calls. Run: node mcp/unit-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// The Codex sandbox check cache is a scratch file for the whole run, never the user's ~/.claude one (unless the caller set one).
const ownsCheckFile = !process.env.CONSULT_SANDBOX_CHECK_FILE;
if (ownsCheckFile) process.env.CONSULT_SANDBOX_CHECK_FILE = path.join(os.tmpdir(), 'consult-unit-check-' + randomBytes(4).toString('hex') + '.json');
const topLevelCheckFile = process.env.CONSULT_SANDBOX_CHECK_FILE;

import { scrubPii, readHead, walkAndDelete } from './lib/util.js';
import { loadSettings, parseFrontmatter, sanitize, frontmatterWarnings, runnerSettings, localConfigured, KNOWN_KEYS } from './lib/settings.js';
import {
  bordaScores, tiedAtTop, parseRanking,
  ALL_PARTICIPANTS as COUNCIL_ALL_PARTICIPANTS,
  DEFAULT_PARTICIPANTS as COUNCIL_DEFAULT_PARTICIPANTS,
  VISION_PARTICIPANTS as COUNCIL_VISION_PARTICIPANTS
} from './lib/council.js';
import { stripReasoning, extractMessage, isLoopback, validateBaseUrl, validateLocalReasoningEffort } from './lib/local.js';
import { classifyError } from './lib/gemini.js';
import { validateAgyEffort, isPartialOutput, describeDeniedActions, parseAgyErrorLine, agyWritePosture, AGY_ANSWER_ONLY_PREAMBLE, AGY_EFFORTS } from './lib/agy.js';
import { validateReasoningEffort, REASONING_EFFORTS } from './lib/util.js';
import { buildClaudeArgs, CLAUDE_COMMON_ARGS } from './lib/claude.js';
import { shellSafeArgs, runCli, cliSpawnOptions, killTree, killAllCliChildren, liveCliChildCount, spawnableCmdOrError } from './lib/spawn-cli.js';
import { callContext } from './lib/util.js';
import { SPAWN_OPTS, EMPTY_ARG, ensureCmd, isInsideFolder, pickWindowsHit, spawnableCmd, whereCommand, refusedWindowsHits, missingMessage } from './lib/resolve-cmd.js';
import { codexTimeoutMs, CODEX_TIMEOUT_FLOOR_MS, hookArgs, codexRunHooks, parseCodexJsonl, codexTimeoutError, configuredCodex, rolloutTurn, codexDefaultLabel } from './lib/codex.js';
import { incompleteError, PARTIAL_CAP_CHARS, timeoutMsFromSeconds, timeoutRetryHint } from './lib/util.js';
import { parseAgyResult, agyFailure, conversationIdFrom, agyImageOutputDir, findGeneratedImages, copyImagesTo, retargetPaths, agySubagentIds, finishImageCall, saveConversationImages, finishConversation, hostAppDirs, AGY_IMAGE_PREAMBLE } from './lib/agy.js';
import { imageOptions, imageSettingsBlock, agyImageTimeoutMs, agyGenerateImage, AGY_IMAGE_ASPECT_RATIOS, AGY_IMAGE_TIERS } from './lib/agy.js';
import { DEFAULTS } from './lib/settings.js';
import { CODEX_IMAGE_ASPECT_RATIOS, codexImageOptions, shapeSentence, codexImageBrief, codexImageArgs, codexImageTimeoutMs, codexGenerateImage } from './lib/codex-image.js';
import crypto from 'node:crypto';
import { extractJson } from './lib/util.js';
import { fakeServer } from './test-helpers.js';
import { detectImageType, readDimensions, downscalePng, resizeSupported, DEFAULT_MAX_EDGE } from './lib/image.js';
import { prepareLocalCall } from './lib/local-models.js';
import { rewriteLocalModelLines, settingsTargetPath, saveNicknames } from './lib/local-models.js';
import { ollamaBase, fetchTags, vramMb, resetVramCacheForTests, savedNicknames, LOCAL_SLOW_FLOOR_MS } from './lib/local-models.js';
import { modelFacts, baseName, proposeNicknames, resolveModel, quantRank } from './lib/local-models.js';
import { spillLongAnswer, isLongText, LONG_ANSWER_BYTES, PREVIEW_CHARS, KEEP_ANSWERS } from './lib/long-answer.js';

let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (ok ? '' : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`));
  if (!ok) failed++;
}
function truthy(label, got) {
  const ok = !!got;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (ok ? '' : `\n  got: ${JSON.stringify(got)}`));
  if (!ok) failed++;
}
function throws(label, fn) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  console.log((threw ? 'PASS' : 'FAIL') + ' ' + label + (threw ? '' : '\n  expected a throw, got none'));
  if (!threw) failed++;
}

// --- scrubPii ---
eq('scrubPii redacts sk- key', scrubPii('Error: sk-abcdefghijklmnopqrstuvwxyz123456'), 'Error: sk-***');
eq('scrubPii redacts sk-proj key', scrubPii('token=sk-proj-abc123def456ghi789jkl012mno345'), 'token=sk-***');
eq('scrubPii redacts AIza key', scrubPii('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q'), 'AIza***');
eq('scrubPii redacts Bearer', scrubPii('Authorization: Bearer abcdef0123456789xyzpqr'), 'Authorization: Bearer ***');
eq('scrubPii redacts api_key=', scrubPii('api_key=secretvalue12345'), 'api_key=***');
truthy('scrubPii redacts homedir', !scrubPii(`error in ${os.homedir()}/.foo`).includes(os.homedir()));
eq('scrubPii passes through innocuous', scrubPii('hello world'), 'hello world');
eq('scrubPii handles non-string', scrubPii(42), 42);

// --- readHead ---
const tmpFile = path.join(os.tmpdir(), `consult-unit-${randomBytes(4).toString('hex')}.txt`);
fs.writeFileSync(tmpFile, 'first line\nsecond line\n');
try {
  eq('readHead returns full content under cap', readHead(tmpFile), 'first line\nsecond line\n');
  eq('readHead truncates at byte cap', readHead(tmpFile, 5), 'first');
} finally { fs.unlinkSync(tmpFile); }

// --- walkAndDelete with verify ---
const sandboxDir = path.join(os.tmpdir(), `consult-walk-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(sandboxDir, { recursive: true });
const matchFile = path.join(sandboxDir, 'session-123.jsonl');
const decoyFile = path.join(sandboxDir, 'session-456.jsonl');
fs.writeFileSync(matchFile, 'contains FULL-UUID-xyz');
fs.writeFileSync(decoyFile, 'does not contain it');
try {
  const r = walkAndDelete({
    root: sandboxDir,
    predicate: (n) => n.startsWith('session-') && n.endsWith('.jsonl'),
    verify: (full) => fs.readFileSync(full, 'utf8').includes('FULL-UUID-xyz')
  });
  eq('walkAndDelete deletes only verified', r.deleted, 1);
  eq('walkAndDelete reports skipped', r.skipped, 1);
  eq('walkAndDelete reports matches', r.matches, 2);
  truthy('verified file gone', !fs.existsSync(matchFile));
  truthy('unverified file kept', fs.existsSync(decoyFile));
} finally {
  try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
}

// --- council: Borda scoring (real implementation, imported) ---
// 3 candidates -> 1st=2pts, 2nd=1pt, 3rd=0pts.
eq('borda: unanimous winner',
  bordaScores(['A', 'B', 'C'], [{ ranking: ['A', 'B', 'C'] }, { ranking: ['A', 'B', 'C'] }]),
  { A: 4, B: 2, C: 0 });
eq('borda: split decision',
  bordaScores(['A', 'B', 'C'], [{ ranking: ['A', 'B', 'C'] }, { ranking: ['B', 'A', 'C'] }]),
  { A: 3, B: 3, C: 0 });
eq('borda: 2-way degraded council', bordaScores(['A', 'B'], [{ ranking: ['B', 'A'] }]), { A: 0, B: 1 });
eq('borda: 4-way (local participating)',
  bordaScores(['A', 'B', 'C', 'D'], [{ ranking: ['D', 'C', 'B', 'A'] }]),
  { A: 0, B: 1, C: 2, D: 3 });

// --- council: tie surfacing (real implementation, imported) ---
eq('tied_at_top: 3-way tie', tiedAtTop({ A: 4, B: 4, C: 4 }), ['A', 'B', 'C']);
eq('tied_at_top: 2-way tie at top', tiedAtTop({ A: 4, B: 4, C: 2 }), ['A', 'B']);
eq('tied_at_top: no tie', tiedAtTop({ A: 4, B: 2, C: 0 }), ['A']);
eq('tied_at_top: full order matters', tiedAtTop({ A: 1, B: 5, C: 5 }), ['B', 'C']);

// --- council: ranking parser ---
eq('parseRanking: clean', parseRanking('1st: B\n2nd: A\n3rd: C', ['A', 'B', 'C']), ['B', 'A', 'C']);
eq('parseRanking: lowercase letters normalised', parseRanking('1st: b\n2nd: a\n3rd: c', ['A', 'B', 'C']), ['B', 'A', 'C']);
eq('parseRanking: rejects duplicate label', parseRanking('1st: A\n2nd: A\n3rd: C', ['A', 'B', 'C']), null);
eq('parseRanking: rejects wrong count', parseRanking('1st: A\n2nd: B', ['A', 'B', 'C']), null);
eq('parseRanking: rejects unknown label', parseRanking('1st: A\n2nd: B\n3rd: Z', ['A', 'B', 'C']), null);
eq('parseRanking: rejects prose-only (the retry trigger)', parseRanking('I think A is best.', ['A', 'B', 'C']), null);

// --- local: reasoning stripping ---
eq('stripReasoning: inline <think>', stripReasoning('<think>deliberating</think>Four'), 'Four');
eq('stripReasoning: <thinking> variant', stripReasoning('<thinking>hmm</thinking>Four'), 'Four');
eq('stripReasoning: multiple blocks', stripReasoning('<think>a</think>X<think>b</think>Y'), 'XY');
eq('stripReasoning: unclosed opener drops remainder', stripReasoning('<think>cut off mid-thought'), '');
eq('stripReasoning: answer before unclosed opener survives', stripReasoning('Four<think>wait, actually'), 'Four');
eq('stripReasoning: plain text untouched', stripReasoning('Four'), 'Four');
eq('stripReasoning: non-string', stripReasoning(null), '');

// --- local: message extraction across runner dialects ---
eq('extractMessage: ollama `reasoning` field',
  extractMessage({ content: 'Four', reasoning: 'long cot' }),
  { response: 'Four', reasoning: 'long cot' });
eq('extractMessage: vLLM `reasoning_content` field',
  extractMessage({ content: 'Four', reasoning_content: 'long cot' }),
  { response: 'Four', reasoning: 'long cot' });
eq('extractMessage: inline think (LM Studio / llama.cpp)',
  extractMessage({ content: '<think>cot</think>Four' }),
  { response: 'Four', reasoning: null });
eq('extractMessage: reasoning-only yields empty response',
  extractMessage({ content: '', reasoning: 'ran out of context' }),
  { response: '', reasoning: 'ran out of context' });
eq('extractMessage: blank reasoning normalises to null',
  extractMessage({ content: 'Four', reasoning: '   ' }),
  { response: 'Four', reasoning: null });

// --- local: base_url guards ---
truthy('isLoopback: 127.0.0.1', isLoopback('http://127.0.0.1:11434/v1'));
truthy('isLoopback: localhost', isLoopback('http://localhost:1234/v1'));
truthy('isLoopback: ipv6 ::1', isLoopback('http://[::1]:8080/v1'));
truthy('isLoopback: rejects remote host', !isLoopback('https://evil.example.com/v1'));
truthy('isLoopback: rejects LAN address', !isLoopback('http://192.168.1.50:11434/v1'));
truthy('isLoopback: rejects garbage', !isLoopback('not-a-url'));
truthy('validateBaseUrl: accepts http', !!validateBaseUrl('http://127.0.0.1:11434/v1'));
throws('validateBaseUrl: rejects non-url', () => validateBaseUrl('nope'));
throws('validateBaseUrl: rejects file scheme', () => validateBaseUrl('file:///etc/passwd'));
throws('validateLocalReasoningEffort: rejects unknown', () => validateLocalReasoningEffort('ultra'));
truthy('validateLocalReasoningEffort: allows none', validateLocalReasoningEffort('none') === undefined);

// --- image: format detection by signature, not extension ---
// Minimal but real headers for each format, built by hand so the tests need
// no fixture files.
const pngBytes = (w, h) => {
  const b = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const jpegBytes = (w, h) => Buffer.from([
  0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255
]);
const gifBytes = (w, h) => {
  const b = Buffer.alloc(10);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
};
const webpBytes = (w, h) => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8 ', 12, 'latin1');
  b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28);
  return b;
};

eq('detectImageType: png', detectImageType(pngBytes(1, 1))?.type, 'png');
eq('detectImageType: jpeg', detectImageType(jpegBytes(1, 1))?.type, 'jpeg');
eq('detectImageType: gif', detectImageType(gifBytes(1, 1))?.type, 'gif');
eq('detectImageType: webp', detectImageType(webpBytes(1, 1))?.type, 'webp');
eq('detectImageType: mime for png', detectImageType(pngBytes(1, 1))?.mime, 'image/png');
eq('detectImageType: rejects text', detectImageType(Buffer.from('not an image at all')), null);
eq('detectImageType: rejects empty', detectImageType(Buffer.alloc(0)), null);
// A truncated PNG signature must not pass -- guards against a 4-byte prefix match.
eq('detectImageType: rejects partial signature', detectImageType(Buffer.from([137, 80, 78, 71])), null);

// --- image: dimension parsing per format ---
eq('readDimensions: png', readDimensions(pngBytes(1920, 1080), 'png'), { width: 1920, height: 1080 });
eq('readDimensions: jpeg', readDimensions(jpegBytes(800, 600), 'jpeg'), { width: 800, height: 600 });
eq('readDimensions: gif', readDimensions(gifBytes(320, 240), 'gif'), { width: 320, height: 240 });
eq('readDimensions: webp', readDimensions(webpBytes(640, 480), 'webp'), { width: 640, height: 480 });
eq('readDimensions: garbage yields null', readDimensions(Buffer.from('xx'), 'png'), null);

// --- image: resize support is PNG-only (no decoder dependency) ---
truthy('resizeSupported: png', resizeSupported('png'));
truthy('resizeSupported: not jpeg', !resizeSupported('jpeg'));
truthy('resizeSupported: not webp', !resizeSupported('webp'));

// --- image: PNG decode -> downscale -> encode round trip ---
// Build a real 2-colour PNG through the encoder, shrink it, and re-read the
// output. Exercises inflate, un-filtering, the box filter, and re-encoding.
{
  const { execFileSync } = await import('node:child_process');
  const zlib = await import('node:zlib');
  const mkPng = (W, H) => {
    const crcTable = (() => { const t = new Int32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
    const crc = (buf) => { let x = 0xFFFFFFFF; for (const b of buf) x = crcTable[(x ^ b) & 0xFF] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
      return Buffer.concat([len, td, c]); };
    const raw = Buffer.alloc(H * (1 + W * 3));
    for (let y = 0; y < H; y++) { const off = y * (1 + W * 3); raw[off] = 0;
      for (let x = 0; x < W; x++) { const p = off + 1 + x * 3;
        const inSq = x > W * 0.25 && x < W * 0.75 && y > H * 0.25 && y < H * 0.75;
        if (inSq) { raw[p] = 0; raw[p + 1] = 0; raw[p + 2] = 255; } else { raw[p] = 255; raw[p + 1] = 255; raw[p + 2] = 0; } } }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };

  const big = mkPng(800, 400);
  const r = downscalePng(big, 200);
  truthy('downscalePng: reports resized', r.resized === true);
  eq('downscalePng: preserves aspect ratio', [r.to.width, r.to.height], [200, 100]);
  eq('downscalePng: output is a valid PNG', detectImageType(r.buffer)?.type, 'png');
  eq('downscalePng: output dims match header', readDimensions(r.buffer, 'png'), { width: 200, height: 100 });
  truthy('downscalePng: output is smaller than input', r.buffer.length < big.length);

  // Content check: centre pixel should still be blue-ish after the box filter,
  // proving we decoded and resampled rather than emitting garbage.
  const round2 = downscalePng(r.buffer, 20);
  eq('downscalePng: re-downscales its own output', [round2.to.width, round2.to.height], [20, 10]);

  const small = mkPng(64, 64);
  const noop = downscalePng(small, 200);
  truthy('downscalePng: no-op when already within maxEdge', noop.resized === false && noop.buffer === small);
  eq('downscalePng: no-op reason', noop.reason, 'already_small');

  // Corrupt / truncated inputs must degrade to "can't resize", never throw --
  // a PNG signature is only 8 bytes, so a truncated file reaches the decoder.
  truthy('downscalePng: undecodable input passes through', downscalePng(Buffer.from('nonsense'), 100).reason === 'undecodable');
  truthy('downscalePng: truncated PNG does not throw',
    downscalePng(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), 100).reason === 'undecodable');
  truthy('downscalePng: signature-only PNG does not throw',
    downscalePng(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 100).reason === 'undecodable');
  truthy('downscalePng: header claiming zero dimensions does not throw',
    downscalePng(Buffer.concat([pngBytes(0, 0), Buffer.alloc(16)]), 100).reason === 'undecodable');
  truthy('downscalePng: valid header but no IDAT does not throw',
    downscalePng(Buffer.concat([pngBytes(10, 10), Buffer.alloc(16)]), 5).reason === 'undecodable');
}

// --- council: which participants can receive images ---
eq('vision participants', [...COUNCIL_VISION_PARTICIPANTS], ['codex', 'agy', 'local']);
truthy('claude is NOT vision-capable here', !COUNCIL_VISION_PARTICIPANTS.includes('claude'));
truthy('legacy gemini is NOT vision-capable here', !COUNCIL_VISION_PARTICIPANTS.includes('gemini'));

// --- shared: extractJson (used by both gemini and agy) ---
eq('extractJson: bare object', extractJson('{"a":1}'), { a: 1 });
eq('extractJson: skips preamble (gemini truecolor warning)',
  extractJson('Warning: True color not detected.\n{"a":1}'), { a: 1 });
eq('extractJson: nested braces', extractJson('{"a":{"b":{"c":2}}}'), { a: { b: { c: 2 } } });
eq('extractJson: braces inside strings do not confuse depth',
  extractJson('{"s":"}{ not real }{","n":1}'), { s: '}{ not real }{', n: 1 });
eq('extractJson: escaped quote inside string',
  extractJson('{"s":"say \\"hi\\" }","n":2}'), { s: 'say "hi" }', n: 2 });
eq('extractJson: ignores trailing output after object',
  extractJson('{"a":1}\nRipgrep is not available.'), { a: 1 });
throws('extractJson: throws when no JSON present', () => extractJson('no json here'));
throws('extractJson: throws on unbalanced braces', () => extractJson('{"a":1'));

// --- agy: validators ---
eq('agy efforts (agy 1.3, model-dependent)', [...AGY_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max']);
truthy('validateAgyEffort: allows max', validateAgyEffort('max') === undefined);
throws('validateAgyEffort: rejects unknown', () => validateAgyEffort('extreme'));
throws('validateAgyEffort: rejects codex-style none', () => validateAgyEffort('none'));
truthy('validateAgyEffort: allows high', validateAgyEffort('high') === undefined);
truthy('validateAgyEffort: allows null (CLI default)', validateAgyEffort(null) === undefined);

// --- agy: settings integration ---
eq('sanitize: drops bad agy effort', sanitize({ agy_effort: 'extreme' }), {});
eq('sanitize: keeps agy effort', sanitize({ agy_effort: 'high' }), { agy_effort: 'high' });
// agy_mode was removed; an old config line must still load (unknown keys are inert).
truthy('sanitize: an old agy_mode line does not throw', sanitize({ agy_mode: 'plan' }) !== null);
eq('sanitize: drops non-positive agy timeout', sanitize({ agy_timeout_ms: -5 }), {});
eq('sanitize: keeps agy timeout', sanitize({ agy_timeout_ms: 300000 }), { agy_timeout_ms: 300000 });

// --- gemini: error classification ---
// ineligible_tier must win over the generic auth patterns: the message also
// contains auth-ish words, but re-authenticating cannot fix a withdrawn tier.
eq('classifyError: ineligible tier', classifyError('Error authenticating: IneligibleTierError: UNSUPPORTED_CLIENT'), 'ineligible_tier');
eq('classifyError: antigravity migration notice', classifyError('please migrate to the Antigravity suite'), 'ineligible_tier');
eq('classifyError: unauthenticated', classifyError('HTTP 401 unauthorized'), 'unauthenticated');
eq('classifyError: binary missing', classifyError('spawn ENOENT'), 'binary_missing');
eq('classifyError: rate limited', classifyError('RESOURCE_EXHAUSTED: quota exceeded'), 'rate_limited');
eq('classifyError: network', classifyError('getaddrinfo EAI_AGAIN'), 'network');
eq('classifyError: unknown fallback', classifyError('something odd happened'), 'unknown');

// --- settings: frontmatter parsing (real implementation, imported) ---
eq('parseFrontmatter: int', parseFrontmatter('---\ntimeout_ms: 5000\n---'), { timeout_ms: 5000 });
eq('parseFrontmatter: float (local_temperature needs it)',
  parseFrontmatter('---\nlocal_temperature: 0.7\n---'), { local_temperature: 0.7 });
eq('parseFrontmatter: bool', parseFrontmatter('---\nlog_calls: true\n---'), { log_calls: true });
eq('parseFrontmatter: explicit null', parseFrontmatter('---\ncodex_model: null\n---'), { codex_model: null });
eq('parseFrontmatter: strips quotes', parseFrontmatter('---\nlocal_model: "qwen3.5:9b"\n---'), { local_model: 'qwen3.5:9b' });
eq('parseFrontmatter: trailing comments dropped', parseFrontmatter('---\ntimeout_ms: 5000   # note\nlog_calls: true # on\ncodex_model: gpt-6.1-sol  # pin\nlocal_api_key:   # unset\n---'),
  { timeout_ms: 5000, log_calls: true, codex_model: 'gpt-6.1-sol', local_api_key: null });
eq('parseFrontmatter: # inside quotes or without a space is kept', parseFrontmatter('---\nlocal_model: "a # b"  # c\nlocal_base_url: http://h/v1#x\n---'),
  { local_model: 'a # b', local_base_url: 'http://h/v1#x' });
eq('parseFrontmatter: tolerates BOM', parseFrontmatter('﻿---\ntimeout_ms: 10\n---'), { timeout_ms: 10 });
eq('parseFrontmatter: CRLF line endings', parseFrontmatter('---\r\ntimeout_ms: 10\r\n---'), { timeout_ms: 10 });
eq('parseFrontmatter: no frontmatter -> empty', parseFrontmatter('just prose'), {});
eq('parseFrontmatter: ignores body after close',
  parseFrontmatter('---\ntimeout_ms: 10\n---\nlog_calls: true\n'), { timeout_ms: 10 });

// --- settings: sanitize drops invalid, keeps valid (real implementation) ---
eq('sanitize: drops bad enum', sanitize({ codex_sandbox: 'yolo-mode' }), {});
eq('sanitize: keeps good enum', sanitize({ codex_sandbox: 'read-only' }), { codex_sandbox: 'read-only' });
eq('sanitize: drops out-of-range temperature', sanitize({ local_temperature: 5 }), {});
eq('sanitize: drops negative temperature', sanitize({ local_temperature: -1 }), {});
eq('sanitize: keeps in-range temperature', sanitize({ local_temperature: 0.7 }), { local_temperature: 0.7 });
eq('sanitize: drops malformed base_url', sanitize({ local_base_url: 'not-a-url' }), {});
eq('sanitize: keeps valid base_url', sanitize({ local_base_url: 'http://127.0.0.1:1234/v1' }), { local_base_url: 'http://127.0.0.1:1234/v1' });
eq('sanitize: drops non-positive timeout', sanitize({ local_timeout_ms: 0 }), {});
eq('sanitize: drops non-bool log_calls', sanitize({ log_calls: 'yes' }), {});
eq('sanitize: drops bad local effort', sanitize({ local_reasoning_effort: 'ultra' }), {});
eq('sanitize: keeps none effort', sanitize({ local_reasoning_effort: 'none' }), { local_reasoning_effort: 'none' });

// --- settings: defaults + project-scoped resolution ---
// Drive loadSettings through a real project-scoped file by chdir'ing into a
// temp dir. This exercises the actual cwd candidate path, unlike the old test
// which tried (and admitted it failed) to fake os.homedir().
//
// The defaults block runs with BOTH cwd and home pointed at empty temp dirs.
// Without that it read the developer's real ~/.claude/consult.local.md and
// passed or failed depending on the machine (it failed the day a global file
// with timeout_ms: 600000 was created). os.homedir() reads USERPROFILE on
// Windows and HOME elsewhere, at call time.
{
  const origCwd = process.cwd();
  const origEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-empty-'));
  process.chdir(emptyDir);
  process.env.HOME = emptyDir;
  process.env.USERPROFILE = emptyDir;
  let s;
  try { s = loadSettings(); }
  finally {
    process.chdir(origCwd);
    for (const [k, v] of Object.entries(origEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
  eq('defaults: no config file found', s._source, null);
  eq('defaults: codex_timeout_ms unset (floor applies)', s.codex_timeout_ms, null);
  eq('defaults: codex hooks off', s.codex_hooks, false);
  eq('defaults: local_base_url is loopback ollama', s.local_base_url, 'http://127.0.0.1:11434/v1');
  eq('defaults: local_model unset', s.local_model, null);
  eq('defaults: timeout_ms', s.timeout_ms, 180000);
  truthy('defaults: no agy_mode setting', !('agy_mode' in s));
  eq('defaults: agy_model unset (CLI default)', s.agy_model, null);
}

// --- council: participant policy ---
// Guards the v0.5 switch: agy replaced gemini in the defaults, and both gemini
// and local must stay opt-in. A regression here silently changes what every
// bare council_vote call costs and which providers it hits.
eq('council defaults are claude/codex/agy', [...COUNCIL_DEFAULT_PARTICIPANTS], ['claude', 'codex', 'agy']);
eq('council allows all five', [...COUNCIL_ALL_PARTICIPANTS], ['claude', 'codex', 'agy', 'gemini', 'local']);
truthy('gemini is NOT a default', !COUNCIL_DEFAULT_PARTICIPANTS.includes('gemini'));
truthy('local is NOT a default', !COUNCIL_DEFAULT_PARTICIPANTS.includes('local'));
truthy('gemini is still allowed', COUNCIL_ALL_PARTICIPANTS.includes('gemini'));
{
  const origCwd = process.cwd();
  const projDir = path.join(os.tmpdir(), `consult-proj-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.join(projDir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, '.claude', 'consult.local.md'),
    '---\nlocal_model: qwen3.5:9b\nlocal_reasoning_effort: none\nlocal_temperature: 0.2\n---\n'
  );
  try {
    process.chdir(projDir);
    const s = loadSettings();
    eq('project cfg: local_model read', s.local_model, 'qwen3.5:9b');
    eq('project cfg: effort read', s.local_reasoning_effort, 'none');
    eq('project cfg: float temperature read', s.local_temperature, 0.2);
    eq('project cfg: unset key falls back to default', s.timeout_ms, 180000);
    truthy('project cfg: _source points at the file', String(s._source).includes('consult.local.md'));
    const again = loadSettings();
    truthy('project cfg: cache returns identical object', again === s);
  } finally {
    process.chdir(origCwd);
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch (_) {}
  }
}


// ---- v0.7.0: agy 1.1.28+ headless semantics ----
truthy('isPartialOutput: 1.2.1 marker',
  isPartialOutput('[agy] print timeout after 2s with turn in progress; returning partial output\n'));
truthy('isPartialOutput: ignores unrelated stderr', !isPartialOutput('jetski: no output produced -- a tool required permission'));
truthy('isPartialOutput: non-string safe', !isPartialOutput(undefined));
eq('describeDeniedActions: 1.2.1 shape',
  describeDeniedActions({ denied_actions: [{ action: 'command', display_name: 'RunCommand' }] }),
  ['RunCommand (command)']);
eq('describeDeniedActions: display_name only', describeDeniedActions({ denied_actions: [{ display_name: 'X' }] }), ['X']);
eq('describeDeniedActions: absent', describeDeniedActions({}), []);
eq('conversationIdFrom: success envelope', conversationIdFrom('{"conversation_id":"aa34bbab-8f2c-4f61-b0a5-ae7f2da43547","status":"SUCCESS"}'), 'aa34bbab-8f2c-4f61-b0a5-ae7f2da43547');
eq('conversationIdFrom: error envelope with empty id', conversationIdFrom('{"conversation_id":"","status":"ERROR"}'), null);
eq('conversationIdFrom: no JSON (killed before printing)', conversationIdFrom(''), null);
eq('conversationIdFrom: unsafe id refused', conversationIdFrom('{"conversation_id":"a & del x"}'), null);

eq('describeDeniedActions: garbage entries dropped', describeDeniedActions({ denied_actions: [null, {}, 'x'] }), []);

// ---- v0.7.0: codex reasoning effort enum (API enum, model-dependent) ----
eq('REASONING_EFFORTS: full API enum', [...REASONING_EFFORTS], ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
for (const e of REASONING_EFFORTS) validateReasoningEffort(e);
truthy('validateReasoningEffort: accepts every enum value', true);
throws('validateReasoningEffort: rejects bogus', () => validateReasoningEffort('bogus'));
throws('validateReasoningEffort: rejects an unknown level', () => validateReasoningEffort('extreme'));
eq('sanitize: keeps xhigh codex effort', sanitize({ codex_reasoning_effort: 'xhigh' }), { codex_reasoning_effort: 'xhigh' });
eq('sanitize: keeps max codex effort', sanitize({ codex_reasoning_effort: 'max' }), { codex_reasoning_effort: 'max' });
eq('sanitize: drops bogus codex effort', sanitize({ codex_reasoning_effort: 'extreme' }), {});
eq('sanitize: keeps ultra codex effort', sanitize({ codex_reasoning_effort: 'ultra' }), { codex_reasoning_effort: 'ultra' });
eq('sanitize: keeps max agy effort', sanitize({ agy_effort: 'max' }), { agy_effort: 'max' });

// ---- v0.7.0: claude participant flag contract ----
{
  const common = ['--tools', EMPTY_ARG, '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'];
  for (const flag of common) truthy(`CLAUDE_COMMON_ARGS has ${flag || '""'}`, CLAUDE_COMMON_ARGS.includes(flag));
  const nb = buildClaudeArgs({ bare: false, model: 'm', system_prompt: 'sp' });
  truthy('claude non-bare: --safe-mode', nb.includes('--safe-mode'));
  truthy('claude non-bare: no --bare', !nb.includes('--bare'));
  truthy('claude non-bare: append-system-prompt', nb.includes('--append-system-prompt'));
  const b = buildClaudeArgs({ bare: true, model: 'm' });
  truthy('claude bare: --bare', b.includes('--bare'));
  truthy('claude bare: no --safe-mode', !b.includes('--safe-mode'));
  truthy('claude bare: --system-prompt', b.includes('--system-prompt'));
  eq('claude: --tools is immediately followed by the empty arg', nb[nb.indexOf('--tools') + 1], EMPTY_ARG);
}

// ---- v0.7.0: shell:true argv quoting ----
if (SPAWN_OPTS.shell) {
  eq('EMPTY_ARG is a quoted empty under shell:true', EMPTY_ARG, '""');
  eq('shellSafeArgs: quotes whitespace, leaves plain args', shellSafeArgs(['-p', 'a b', EMPTY_ARG, 'x=y']), ['-p', '"a b"', '""', 'x=y']);
  throws('shellSafeArgs: rejects cmd metachar', () => shellSafeArgs(['a&b']));
  throws('shellSafeArgs: rejects quote inside spaced arg', () => shellSafeArgs(['say "hi" now']));
} else {
  eq('EMPTY_ARG is empty on POSIX', EMPTY_ARG, '');
  eq('shellSafeArgs: pass-through on POSIX', shellSafeArgs(['a b', '']), ['a b', '']);
}



// ---- v0.7.0: agy write posture (reads agy's own settings.json, never writes it) ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-agyposture-'));
  const p = path.join(dir, 'settings.json');
  const posture = (cfg) => { fs.writeFileSync(p, JSON.stringify(cfg)); return agyWritePosture(p); };
  eq('agyWritePosture: missing file -> untrusted', agyWritePosture(path.join(dir, 'nope.json')).level, 'untrusted');
  eq('agyWritePosture: no trust, no deny -> untrusted', posture({}).level, 'untrusted');
  eq('agyWritePosture: home trusted', posture({ trustedWorkspaces: [os.homedir()] }).level, 'home_trusted');
  eq('agyWritePosture: home trusted (trailing sep, case)', posture({ trustedWorkspaces: [os.homedir().toUpperCase() + path.sep] }).level, 'home_trusted');
  eq('agyWritePosture: some workspace trusted', posture({ trustedWorkspaces: [path.join(os.homedir(), 'proj')] }).level, 'workspaces_trusted');
  const d = posture({ trustedWorkspaces: [os.homedir()], permissions: { deny: ['write_file(**)', 'command(**)'] } });
  eq('agyWritePosture: deny rule wins over trust', d.level, 'denied');
  truthy('agyWritePosture: reports both deny rules', d.write_deny_rule && d.command_deny_rule);
  truthy('agyWritePosture: scrubs home from trusted list', !JSON.stringify(posture({ trustedWorkspaces: [os.homedir()] }).trusted_workspaces).includes(os.homedir()));
  fs.rmSync(dir, { recursive: true, force: true });
}
truthy('AGY_ANSWER_ONLY_PREAMBLE: ends with a blank line so the prompt starts fresh', AGY_ANSWER_ONLY_PREAMBLE.endsWith('\n\n'));


// ---- v0.7.1: agy 1.2.6+ structured failure line ----
eq('parseAgyErrorLine: parses a 1.2.6 line',
  parseAgyErrorLine('some log\nAGY_ERROR: {"status":"UNAVAILABLE","code":503,"retryable":true,"error_id":"abc","message":"backend down"}\n'),
  { status: 'UNAVAILABLE', code: 503, retryable: true, error_id: 'abc', message: 'backend down' });
eq('parseAgyErrorLine: absent', parseAgyErrorLine('[agy] print timeout after 2s'), null);
eq('parseAgyErrorLine: malformed JSON -> null', parseAgyErrorLine('AGY_ERROR: {not json}'), null);
eq('parseAgyErrorLine: non-string safe', parseAgyErrorLine(undefined), null);
eq('parseAgyErrorLine: ignores a non-object payload', parseAgyErrorLine('AGY_ERROR: 42'), null);


// ---- v0.8.0: codex timeout floor (codex_timeout_ms) ----
eq('codexTimeoutMs: floor applies over the 180s global default', codexTimeoutMs({ codex_timeout_ms: null, timeout_ms: 180000 }), 600000);
eq('codexTimeoutMs: a higher global timeout_ms still wins', codexTimeoutMs({ codex_timeout_ms: null, timeout_ms: 900000 }), 900000);
eq('codexTimeoutMs: explicit codex_timeout_ms wins, even below the floor', codexTimeoutMs({ codex_timeout_ms: 120000, timeout_ms: 900000 }), 120000);
eq('codexTimeoutMs: floor constant', CODEX_TIMEOUT_FLOOR_MS, 600000);
eq('sanitize: keeps codex_timeout_ms', sanitize({ codex_timeout_ms: 900000 }), { codex_timeout_ms: 900000 });
eq('sanitize: drops non-positive codex_timeout_ms', sanitize({ codex_timeout_ms: 0 }), {});
eq('sanitize: keeps boolean codex_hooks', sanitize({ codex_hooks: true }), { codex_hooks: true });
eq('sanitize: drops non-boolean codex_hooks', sanitize({ codex_hooks: 'yes' }), {});

// ---- v0.8.0: codex hooks off by default ----
eq('hookArgs: off by default -> --disable hooks', hookArgs(false), ['--disable', 'hooks']);
eq('hookArgs: codex_hooks true -> no flag', hookArgs(true), []);

// ---- v0.8.0: codex JSONL partial extraction ----
{
  // Shape recorded from codex-cli 0.160.0 --json, killed mid-turn.
  const killed = [
    '{"type":"thread.started","thread_id":"01a1-x"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"I will check the image first."}}',
    '{"type":"item.started","item":{"id":"i1","type":"web_search"}}',
    '{"type":"item.completed","item":{"id":"i1","type":"web_search"}}',
    '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Option A: fade, 240ms ease-out."}}',
    '{"type":"item.started","item":{"id":"i3","type":"reasoning"}}'
  ].join('\n');
  const p = parseCodexJsonl(killed);
  eq('parseCodexJsonl: collects every completed message', p.messages, ['I will check the image first.', 'Option A: fade, 240ms ease-out.']);
  eq('parseCodexJsonl: reports items still in flight', p.in_flight, ['reasoning']);

  const timeoutErr = Object.assign(new Error('codex exec timed out'), { kind: 'timeout', stdout: killed, stderr: 'header noise' });
  const e = codexTimeoutError(timeoutErr, 600000);
  truthy('codexTimeoutError: says INCOMPLETE first', e.message.startsWith('INCOMPLETE: codex did not finish within 600000ms'));
  truthy('codexTimeoutError: names the setting to raise', e.message.includes('codex_timeout_ms'));
  truthy('codexTimeoutError: labels the partial', e.message.includes('BEGIN PARTIAL CODEX OUTPUT (last complete message)'));
  eq('codexTimeoutError: partial is the LAST complete message', e.partial, 'Option A: fade, 240ms ease-out.');
  truthy('codexTimeoutError: warns it may be a progress note', e.message.includes('progress note'));
  truthy('codexTimeoutError: names what codex was doing', e.message.includes('busy with: reasoning'));
  truthy('codexTimeoutError: not the raw stderr tail', !e.message.includes('header noise'));
  eq('codexTimeoutError: kind stays timeout', e.kind, 'timeout');
  truthy('codexTimeoutError: incomplete flag', e.incomplete === true);

  const nothing = codexTimeoutError(Object.assign(new Error('t'), { kind: 'timeout', stdout: '{"type":"turn.started"}' }), 600000);
  truthy('codexTimeoutError: no message yet -> says so', nothing.message.includes('had not completed any message yet'));
  eq('codexTimeoutError: no message -> empty partial', nothing.partial, '');
  eq('codexTimeoutError: non-timeout errors pass through', codexTimeoutError(Object.assign(new Error('x'), { kind: 'nonzero_exit' }), 1), null);
}

// ---- v0.8.0: shared incompleteError ----
{
  const big = 'A'.repeat(PARTIAL_CAP_CHARS + 500);
  const e = incompleteError({ provider: 'codex', timeout_ms: 1, setting: 'codex_timeout_ms', partial: big });
  eq('incompleteError: caps the partial at PARTIAL_CAP_CHARS (keeps the head)', e.message.split('\n').find(l => l.startsWith('AAA')).length, PARTIAL_CAP_CHARS);
  truthy('incompleteError: says it is truncated', e.message.includes(`showing the first ${PARTIAL_CAP_CHARS} of ${PARTIAL_CAP_CHARS + 500} chars`));
  eq('incompleteError: full partial kept on the error object', e.partial.length, PARTIAL_CAP_CHARS + 500);
  truthy('incompleteError: END marker present', e.message.includes('END PARTIAL CODEX OUTPUT'));
}

// ---- v0.8.0: agy partial output reads the same as codex ----
{
  const envelope = JSON.stringify({ conversation_id: 'c', status: 'SUCCESS', response: 'Rivers are among the most dyn', num_turns: 1, usage: {} });
  let err = null;
  try { parseAgyResult(envelope, '[agy] print timeout after 162s with turn in progress; returning partial output\n', 162000); }
  catch (e) { err = e; }
  truthy('agy partial: throws', err !== null);
  truthy('agy partial: same INCOMPLETE first line as codex', err.message.startsWith('INCOMPLETE: agy did not finish within 162000ms'));
  truthy('agy partial: names agy_timeout_ms', err.message.includes('agy_timeout_ms'));
  truthy('agy partial: labelled as cut off mid-stream', err.message.includes('BEGIN PARTIAL AGY OUTPUT (answer cut off mid-stream)'));
  eq('agy partial: partial text carried', err.partial, 'Rivers are among the most dyn');
  eq('agy partial: kind timeout', err.kind, 'timeout');
}


// ---- v0.8.0: agy 1.2.10+ exit 3 with a partial response ----
{
  const stdout = JSON.stringify({ conversation_id: 'c', status: 'ERROR', response: 'Option A is a 240ms fade, and Option B', error: 'model stream interrupted' });
  const stderr = 'AGY_ERROR: {"status":"UNAVAILABLE","code":503,"retryable":true,"error_id":"e1","message":"model stream interrupted"}\n';
  const e = agyFailure({ stdout, stderr, code: 3, label: 'agy' });
  truthy('agy exit 3 + partial: INCOMPLETE first line with the reason', e.message.startsWith('INCOMPLETE: agy failed mid-answer (exit 3): model stream interrupted'));
  truthy('agy exit 3 + partial: labelled partial', e.message.includes('BEGIN PARTIAL AGY OUTPUT (answer cut off by an error)'));
  truthy('agy exit 3 + partial: retryable note', e.message.includes('retryable'));
  eq('agy exit 3 + partial: kind retryable', e.kind, 'retryable');
  eq('agy exit 3 + partial: partial carried', e.partial, 'Option A is a 240ms fade, and Option B');
  const bare = agyFailure({ stdout: '', stderr, code: 3, label: 'agy' });
  truthy('agy exit 3, no partial: plain failure, not INCOMPLETE', bare.message.startsWith('agy failed (exit 3)') && !bare.incomplete);
}


// ---- v0.8.1: per-call run_hooks (tool arg > codex_hooks setting > off) ----
eq('codexRunHooks: default off', codexRunHooks(undefined, { codex_hooks: false }), false);
eq('codexRunHooks: setting on', codexRunHooks(undefined, { codex_hooks: true }), true);
eq('codexRunHooks: call true beats setting off', codexRunHooks(true, { codex_hooks: false }), true);
eq('codexRunHooks: call false beats setting on', codexRunHooks(false, { codex_hooks: true }), false);
eq('codexRunHooks: non-boolean call value falls through to setting', codexRunHooks('yes', { codex_hooks: false }), false);
eq('codexRunHooks: missing settings -> off', codexRunHooks(undefined, undefined), false);

// --- cancellation: a cancelled call stops its CLI ---
{
  const controller = new AbortController();
  const started = Date.now();
  const pending = callContext.run({ signal: controller.signal }, () =>
    runCli({ cmd: 'node', args: ['-e', 'setInterval(Date.now,1000)'], timeout_ms: 30000, label: 'idle node' }));
  setTimeout(() => controller.abort(), 300);
  let kind = null;
  try { await pending; } catch (e) { kind = e.kind; }
  eq('runCli: abort kills the child and reports cancelled', kind, 'cancelled');
  truthy('runCli: stops promptly after abort (< 10s)', Date.now() - started < 10000);
  let preKind = null;
  try { await callContext.run({ signal: AbortSignal.abort() }, () => runCli({ cmd: 'node', args: ['-v'], label: 'node' })); } catch (e) { preKind = e.kind; }
  eq('runCli: already-cancelled call does not start', preKind, 'cancelled');
}

// --- shutdown: the server stops the CLIs a call is still waiting on ---
{
  const pending = runCli({ cmd: 'node', args: ['-e', 'setInterval(Date.now,1000)'], timeout_ms: 30000, label: 'idle node' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  eq('killAllCliChildren: a running call is tracked', liveCliChildCount(), 1);
  const seen = [];
  killAllCliChildren((child, options) => { seen.push([typeof child.pid, options]); });
  eq('killAllCliChildren: kills each live child as a process group', seen, [['number', { group: true, evenIfExited: true }]]);
  killAllCliChildren();
  let shutdownKind = null;
  try { await pending; } catch (e) { shutdownKind = e.kind; }
  truthy('killAllCliChildren: the call ends', shutdownKind !== null);
  eq('killAllCliChildren: nothing is tracked once the call has ended', liveCliChildCount(), 0);
}
if (SPAWN_OPTS.shell) {
  let refusal = null;
  try { spawnableCmdOrError('C:\\Tools\\%PATH%\\codex.cmd', 'Codex'); } catch (e) { refusal = e; }
  eq('runCli: a program path cmd.exe cannot take is a spawn_error', [refusal?.kind, /Codex CLI failed to start/.test(refusal?.message ?? '')], ['spawn_error', true]);
} else {
  console.log('PASS-SKIP runCli: unsafe program path (Windows only)');
}

// --- POSIX: a timeout or Cancel stops the CLI's own children too (process groups) ---
eq('runCli: CLIs get their own process group on linux', cliSpawnOptions('linux').detached, true);
eq('runCli: CLIs get their own process group on darwin', cliSpawnOptions('darwin').detached, true);
truthy('runCli: Windows CLIs are not detached', cliSpawnOptions('win32').detached !== true);
{
  // The delegate supervisor calls killTree(child, { group: true }) after every run: for an exited worker it must do nothing.
  const realKill = process.kill;
  let killCalls = 0;
  process.kill = () => { killCalls++; };
  try {
    killTree({ pid: 424242, exitCode: 0, kill: () => { killCalls++; } }, { group: true });
  } finally { process.kill = realKill; }
  eq('killTree: group mode does nothing for an exited child', killCalls, 0);
}
if (process.platform === 'win32') {
  console.log('PASS-SKIP runCli: a timeout ends a child that holds stdout (POSIX only)');
} else {
  const started = Date.now();
  let timeoutError = null;
  let groupExistedBeforeTimeout = false;
  // The shell prints its pid (it leads the group), then waits on a background sleep that holds stdout.
  const pending = runCli({ cmd: 'sh', args: ['-c', 'echo $$; sleep 30 & wait'], timeout_ms: 1500, label: 'sleeper' });
  let pgrepMissing = false;
  // Poll for the shell (up to ~1s, under the 1500ms timeout); pgrep exits 1 while nothing matches yet.
  for (let attempt = 0; attempt < 20 && !groupExistedBeforeTimeout && !pgrepMissing; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    let pgrepOutput = '';
    try { pgrepOutput = execFileSync('pgrep', ['-f', 'sleep 30 & wait']).toString(); } catch (e) { if (e.code === 'ENOENT') pgrepMissing = true; }
    for (const line of pgrepOutput.split('\n')) {
      const candidate = Number.parseInt(line, 10);
      if (!Number.isInteger(candidate)) continue;
      try { process.kill(-candidate, 0); groupExistedBeforeTimeout = true; } catch (_) { /* not a group leader */ }
    }
  }
  try { await pending; } catch (e) { timeoutError = e; }
  eq('runCli: a timeout on a child that holds stdout reports timeout', timeoutError?.kind, 'timeout');
  truthy('runCli: the timeout settles within 3s', Date.now() - started < 3000);
  if (pgrepMissing) console.log('PASS-SKIP runCli: the CLI led its own process group before the timeout (pgrep not installed)');
  else truthy('runCli: the CLI led its own process group before the timeout', groupExistedBeforeTimeout);
  const leaderPid = Number.parseInt(String(timeoutError?.stdout).trim(), 10);
  // The killed sleep may linger briefly as a zombie that still counts for the group.
  let groupGone = false;
  for (let attempt = 0; attempt < 20 && !groupGone; attempt++) {
    try { process.kill(-leaderPid, 0); } catch (_) { groupGone = true; }
    if (!groupGone) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  truthy('runCli: the whole process group is gone after a timeout', Number.isInteger(leaderPid) && groupGone);
}

// --- codex model and effort in results ---
eq('configuredCodex: top-level keys', configuredCodex('model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n[projects.\'C:\\x\']\ntrust_level = "trusted"\n'), { model: 'gpt-6-astra', reasoning_effort: 'xhigh' });
eq('configuredCodex: keys inside another table are not defaults', configuredCodex('[tui]\nmodel = "nope"\nmodel_reasoning_effort = "low"\n'), { model: null, reasoning_effort: null });
eq('configuredCodex: active profile wins', configuredCodex('model = "a"\nmodel_reasoning_effort = "high"\nprofile = "fast"\n[profiles.fast]\nmodel = \'b\'\nmodel_reasoning_effort = "low"\n[profiles.slow]\nmodel = "c"\n'), { model: 'b', reasoning_effort: 'low' });
eq('configuredCodex: quoted profile name', configuredCodex('profile = "my.p"\n[profiles."my.p"]\nmodel = "d"\n'), { model: 'd', reasoning_effort: null });
eq('configuredCodex: profile sets only effort -> top-level model', configuredCodex('model = "a"\nprofile = "p"\n[profiles.p]\nmodel_reasoning_effort = "high"\n'), { model: 'a', reasoning_effort: 'high' });
eq('configuredCodex: none set', configuredCodex('# empty\n'), { model: null, reasoning_effort: null });
eq('rolloutTurn: last turn_context wins', rolloutTurn([
  '{"type":"session_meta","payload":{"model_provider":"openai"}}',
  '{"type":"turn_context","payload":{"model":"first","effort":"low"}}',
  'not json "turn_context"',
  '{"type":"turn_context","payload":{"model":"second","effort":"high"}}'
].join('\n')), { model: 'second', reasoning_effort: 'high' });
eq('rolloutTurn: none recorded', rolloutTurn('{"type":"session_meta","payload":{}}'), { model: null, reasoning_effort: null });
eq('codexDefaultLabel: codex chose', codexDefaultLabel(undefined, 'gpt-6-astra'), 'gpt-6-astra (codex default)');
eq('codexDefaultLabel: caller chose', codexDefaultLabel('low', 'xhigh'), 'low');
eq('codexDefaultLabel: unknown', codexDefaultLabel(undefined, null), '(codex default)');


// ---- missing CLI is reported as a missing binary ----
// ensureCmd throws before anything spawns; callers (agyStatus, codexLoginStatus)
// detect "missing" by kind === 'spawn_error', so the throw must carry it.
{
  let err = null;
  try { ensureCmd('consult-no-such-cli-xyz'); } catch (e) { err = e; }
  eq('ensureCmd: missing CLI has kind spawn_error', err?.kind, 'spawn_error');
  truthy('ensureCmd: message says not found', /not found/.test(err?.message));
}

// ---- v0.8.3: server started in the home directory reads the global file as global ----
{
  const origCwd = process.cwd();
  const origEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  // A non-loopback base_url triggers the PROJECT-scope warning if the file is
  // misread as a project file.
  fs.writeFileSync(path.join(home, '.claude', 'consult.local.md'), '---\nlocal_base_url: http://10.0.0.5:11434/v1\n---\n');
  const origWrite = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = (chunk) => { warned += String(chunk); return true; };
  let s;
  try {
    process.chdir(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    s = loadSettings();
  } finally {
    process.stderr.write = origWrite;
    process.chdir(origCwd);
    for (const [k, v] of Object.entries(origEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
  eq('loadSettings: cwd == home reads the global file', s.local_base_url, 'http://10.0.0.5:11434/v1');
  truthy('loadSettings: cwd == home is NOT treated as project scope', !/project/i.test(warned));
}
// The same home reached through a link (macOS: /var is /private/var) is still home.
{
  const origCwd = process.cwd();
  const origEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-linkedhome-'));
  const linkedHome = `${home}-link`;
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'consult.local.md'), '---\nlocal_base_url: http://10.0.0.6:11434/v1\n---\n');
  fs.symlinkSync(home, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
  const origWrite = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = (chunk) => { warned += String(chunk); return true; };
  let s;
  try {
    process.chdir(home);
    process.env.HOME = linkedHome;
    process.env.USERPROFILE = linkedHome;
    s = loadSettings();
  } finally {
    process.stderr.write = origWrite;
    process.chdir(origCwd);
    for (const [k, v] of Object.entries(origEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(linkedHome, { force: true, recursive: false });
    fs.rmSync(home, { recursive: true, force: true });
  }
  eq('loadSettings: a home reached through a link reads the global file', s.local_base_url, 'http://10.0.0.6:11434/v1');
  truthy('loadSettings: a home reached through a link is NOT treated as project scope', !/project/i.test(warned));
}

// ---- v0.9.1: agy_generate_image helpers ----
{
  const home = path.resolve('/fakehome');
  const serverDir = path.resolve('/srv/consult/mcp');
  eq('agyImageOutputDir: project cwd -> <cwd>/consult-images',
    agyImageOutputDir({ cwd: path.resolve('/work/proj'), home, serverDir }), path.join(path.resolve('/work/proj'), 'consult-images'));
  eq('agyImageOutputDir: cwd == home -> ~/Pictures/consult-images',
    agyImageOutputDir({ cwd: home, home, serverDir }), path.join(home, 'Pictures', 'consult-images'));
  eq('agyImageOutputDir: drive root -> ~/Pictures/consult-images',
    agyImageOutputDir({ cwd: path.parse(home).root, home, serverDir }), path.join(home, 'Pictures', 'consult-images'));
  eq('agyImageOutputDir: inside the server folder -> ~/Pictures/consult-images',
    agyImageOutputDir({ cwd: path.join(serverDir, 'lib'), home, serverDir }), path.join(home, 'Pictures', 'consult-images'));
  eq('agyImageOutputDir: sibling with the server folder as name prefix is a project',
    agyImageOutputDir({ cwd: serverDir + '-other', home, serverDir }), path.join(serverDir + '-other', 'consult-images'));
  const localAppData = path.join(home, 'AppData', 'Local');
  eq('agyImageOutputDir: Claude Desktop install folder -> ~/Pictures/consult-images',
    agyImageOutputDir({ cwd: path.join(localAppData, 'AnthropicClaude', 'app-2.37337.1'), home, serverDir, appDirs: [localAppData] }), path.join(home, 'Pictures', 'consult-images'));
  eq('agyImageOutputDir: a project is not mistaken for an app folder',
    agyImageOutputDir({ cwd: path.join(home, 'source', 'proj'), home, serverDir, appDirs: [localAppData] }), path.join(home, 'source', 'proj', 'consult-images'));
  truthy('hostAppDirs: Windows env yields LOCALAPPDATA and Program Files',
    hostAppDirs({ LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:\\P' }).includes('C:\\L') && hostAppDirs({ LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:\\P' }).includes('C:\\P'));
  eq('agyImageOutputDir: explicit relative folder resolves against cwd',
    agyImageOutputDir({ output_dir: 'art', cwd: path.resolve('/work/proj'), home, serverDir }), path.join(path.resolve('/work/proj'), 'art'));

  const png = (w, h, extra) => {
    const b = Buffer.alloc(33 + extra);
    b.writeUInt32BE(0x89504E47, 0); b.writeUInt32BE(0x0D0A1A0A, 4);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    b[32] = extra; // vary the content so hashes differ
    return b;
  };
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-brain-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-imgout-'));
  try {
    const reference = png(8, 8, 1);
    fs.writeFileSync(path.join(brain, 'cat_1.png'), png(1024, 1024, 2));
    fs.mkdirSync(path.join(brain, '.tempmediaStorage'), { recursive: true });
    fs.writeFileSync(path.join(brain, '.tempmediaStorage', 'media_1.png'), png(64, 64, 9));   // agy's viewed-image cache
    fs.writeFileSync(path.join(brain, 'cat_1_copy.png'), png(1024, 1024, 2));   // same bytes as cat_1
    fs.writeFileSync(path.join(brain, 'reference_seen.png'), reference);
    fs.writeFileSync(path.join(brain, 'dog_2.png'), png(512, 256, 3));
    fs.writeFileSync(path.join(brain, 'task.md'), '# not an image');
    const found = findGeneratedImages(brain, new Set([crypto.createHash('sha1').update(reference).digest('hex')]));
    eq('findGeneratedImages: top-level distinct images only; no reference, cache or text',
      found.map(f => path.basename(f.source).replace('_copy', '')).sort(), ['cat_1.png', 'dog_2.png']);
    eq('findGeneratedImages: reads dimensions', found.find(f => f.source.endsWith('dog_2.png')) && [found.find(f => f.source.endsWith('dog_2.png')).width, found.find(f => f.source.endsWith('dog_2.png')).height], [512, 256]);
    eq('findGeneratedImages: missing folder -> none', findGeneratedImages(path.join(brain, 'nope')), []);

    fs.writeFileSync(path.join(out, 'cat_1.png'), 'already here');
    const copied = copyImagesTo(found, out);
    eq('copyImagesTo: never overwrites, numbers the copy',
      copied.map(c => path.basename(c.path)).sort(), ['cat_1-1.png', 'dog_2.png']);
    eq('copyImagesTo: existing file untouched', fs.readFileSync(path.join(out, 'cat_1.png'), 'utf8'), 'already here');

    const one = copied[0];
    const reply = `Saved: ${one.source} and [link](file:///${one.source.replace(/\\/g, '/')})`;
    const retargeted = retargetPaths(reply, copied);
    truthy('retargetPaths: replaces both spellings of the brain path',
      !retargeted.includes(one.source) && !retargeted.includes(one.source.replace(/\\/g, '/')) && retargeted.includes(one.path));
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
  {
    // agy image: a failed copy keeps the conversation and names where the originals are
    const keptBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-keptbrain-'));
    const blocker = path.join(keptBrain, 'not-a-folder');
    fs.writeFileSync(path.join(keptBrain, 'cat_1.png'), png(64, 64, 4));
    fs.writeFileSync(blocker, 'a file where the output folder should be');
    try {
      const failed = saveConversationImages({ brainDir: keptBrain, referenceHashes: new Set(), outDir: path.join(blocker, 'out') });
      truthy('saveConversationImages: a failed copy records the error and asks to keep the originals', failed.copyError && failed.keepOriginals === true && failed.copied.length === 0);
      let message = '';
      try { finishImageCall({ ...failed, outDir: '/out', parsed: { response: 'ok' } }); } catch (e) { message = e.message; }
      truthy('finishImageCall: a failed copy names the folder that still holds the originals', message.includes('The originals are still in ' + keptBrain));
      const good = saveConversationImages({ brainDir: keptBrain, referenceHashes: new Set(), outDir: path.join(keptBrain, 'fine') });
      truthy('saveConversationImages: a good copy lets the conversation be discarded', !good.copyError && good.keepOriginals === false && good.copied.length === 1);
    } finally {
      fs.rmSync(keptBrain, { recursive: true, force: true });
    }
  }
  {
    const envelope = JSON.stringify({ conversation_id: '13047bc5-43bb-43e7-a77e-45e2191bba28', status: 'SUCCESS' });
    const discardsFor = async (options) => {
      let discards = 0;
      await finishConversation({ stdout: envelope, discardConversation: true, discard: async () => { discards++; }, ...options });
      return discards;
    };
    eq('finishConversation: beforeDiscard returning true keeps the conversation', await discardsFor({ beforeDiscard: async () => true }), 0);
    eq('finishConversation: beforeDiscard returning false discards', await discardsFor({ beforeDiscard: async () => false }), 1);
    eq('finishConversation: beforeDiscard returning nothing discards', await discardsFor({ beforeDiscard: async () => undefined }), 1);
    eq('finishConversation: no beforeDiscard discards', await discardsFor({}), 1);
    eq('finishConversation: discard not requested -> never discards', await discardsFor({ discardConversation: false }), 0);
  }
  truthy('AGY_IMAGE_PREAMBLE asks for the image tool and no other files', /image generation tool/.test(AGY_IMAGE_PREAMBLE) && /Do not create, modify or delete any other files/.test(AGY_IMAGE_PREAMBLE));
  {
    const copiedOne = [{ path: '/out/a.jpg', source: '/brain/x/a.jpg', type: 'jpeg', width: 1024, height: 1024, bytes: 10 }];
    const timeout = new Error('INCOMPLETE: agy timed out after 270000ms\nBEGIN PARTIAL');
    truthy('finishImageCall: the timeout hint names the image setting',
      /`agy_image_timeout_ms`/.test(finishImageCall({ copied: [{ path: '/o/a.jpg', source: '/b/a.jpg' }], failure: new Error('INCOMPLETE: late. Raise `agy_timeout_ms` and retry.'), outDir: '/o' }).warning));
    const kept = finishImageCall({ copied: copiedOne, failure: timeout, outDir: '/out' });
    truthy('finishImageCall: a print-timeout after saving keeps the images, with a warning',
      kept.images.length === 1 && !('source' in kept.images[0]) && /did not finish cleanly \(INCOMPLETE: agy timed out after 270000ms\)/.test(kept.warning));
    let rethrown = null;
    try { finishImageCall({ copied: [], failure: timeout, outDir: '/out' }); } catch (e) { rethrown = e; }
    eq('finishImageCall: a failure with no images rethrows it', rethrown, timeout);
    throws('finishImageCall: success without an image is an error',
      () => finishImageCall({ copied: [], parsed: { status: 'SUCCESS', response: 'I could not.' }, outDir: '/out' }));
    throws('finishImageCall: a copy failure with nothing copied is an error',
      () => finishImageCall({ copied: [], copyError: Object.assign(new Error('x'), { code: 'EACCES' }), parsed: { response: 'ok' }, outDir: '/out' }));
    const ok = finishImageCall({ copied: copiedOne, parsed: { status: 'SUCCESS', response: 'Saved /brain/x/a.jpg', duration_seconds: 56 }, outDir: '/out' });
    truthy('finishImageCall: success re-points the reply and reports latency',
      ok.agy_reply === 'Saved /out/a.jpg' && ok.latency_ms === 56000 && !ok.warning);
  }
  eq('settings: a bad agy_image_timeout_ms is dropped', 'agy_image_timeout_ms' in sanitize({ agy_image_timeout_ms: -1 }), false);

  const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-subagents-'));
  try {
    fs.mkdirSync(path.join(sub, '.system_generated', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.system_generated', 'subagents', '13047bc5-43bb-43e7-a77e-45e2191bba28.json'), '{}');
    fs.writeFileSync(path.join(sub, '.system_generated', 'subagents', 'bad name & x.json'), '{}');
    fs.writeFileSync(path.join(sub, '.system_generated', 'subagents', 'notes.txt'), '');
    eq('agySubagentIds: valid ids from the subagents folder only', agySubagentIds(sub), ['13047bc5-43bb-43e7-a77e-45e2191bba28']);
    eq('agySubagentIds: no folder -> none', agySubagentIds(path.join(sub, 'nope')), []);
  } finally {
    fs.rmSync(sub, { recursive: true, force: true });
  }
}

// ---- v0.9.2: per-call timeout_s ----
{
  eq('timeoutMsFromSeconds: absent -> undefined (settings decide)', timeoutMsFromSeconds(undefined), undefined);
  eq('timeoutMsFromSeconds: null -> undefined', timeoutMsFromSeconds(null), undefined);
  eq('timeoutMsFromSeconds: 30 s floor accepted', timeoutMsFromSeconds(30), 30000);
  eq('timeoutMsFromSeconds: 1800 s ceiling accepted', timeoutMsFromSeconds(1800), 1800000);
  eq('timeoutMsFromSeconds: fractional seconds round to ms', timeoutMsFromSeconds(90.5), 90500);
  throws('timeoutMsFromSeconds: below 30 s refused', () => timeoutMsFromSeconds(29));
  throws('timeoutMsFromSeconds: above 30 min refused', () => timeoutMsFromSeconds(1801));
  throws('timeoutMsFromSeconds: a string refused', () => timeoutMsFromSeconds('600'));
  throws('timeoutMsFromSeconds: NaN refused', () => timeoutMsFromSeconds(NaN));

  truthy('timeoutRetryHint: doubles a 10-minute limit',
    /timeout_s: 1200/.test(timeoutRetryHint(600000, 'timeout_ms')) && /`timeout_ms`/.test(timeoutRetryHint(600000, 'timeout_ms')));
  truthy('timeoutRetryHint: doubling stops at the 30-minute ceiling', /timeout_s: 1800/.test(timeoutRetryHint(1200000, 'agy_timeout_ms')));
  truthy('timeoutRetryHint: never suggests below the 30 s floor', /timeout_s: 30\b/.test(timeoutRetryHint(10000, 'timeout_ms')));
  truthy('timeoutRetryHint: at the ceiling it says so instead',
    /already had the 30-minute maximum/.test(timeoutRetryHint(1800000, 'timeout_ms')) && !/timeout_s:/.test(timeoutRetryHint(1800000, 'timeout_ms')));

  const incomplete = incompleteError({ provider: 'agy', timeout_ms: 180000, setting: 'agy_timeout_ms', partial: 'half an answer' });
  truthy('incompleteError: suggests a per-call timeout_s and still names the setting',
    /Retry with `timeout_s: 360`/.test(incomplete.message) && /`agy_timeout_ms`/.test(incomplete.message));
}

// ---- v0.8.3: version lockstep across plugin, package and Desktop manifest ----
{
  const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8')).version;
  const pluginV = read('../.claude-plugin/plugin.json');
  eq('version: package.json matches plugin.json', read('./package.json'), pluginV);
  eq('version: manifest.json matches plugin.json', read('./manifest.json'), pluginV);
}

// ---- v0.15.0: the bundled SDK matches the locked one and needs no node_modules ----
{
  const bundle = fs.readFileSync(new URL('./vendor/mcp-sdk.js', import.meta.url), 'utf8');
  const lock = JSON.parse(fs.readFileSync(new URL('./package-lock.json', import.meta.url), 'utf8'));
  const lockedSdk = lock.packages['node_modules/@modelcontextprotocol/sdk'].version;
  const stamped = /from @modelcontextprotocol\/sdk (\S+)\. Do not edit\./.exec(bundle.split('\n')[0]);
  eq('vendor: bundle was built from the locked SDK (run npm run build:vendor)', stamped && stamped[1], lockedSdk);
  const notBuiltIn = [];
  for (const line of bundle.split('\n')) {
    const imported = /^import\b.*\bfrom\s+['"]([^'"]+)['"]/.exec(line);
    if (imported && !imported[1].startsWith('node:')) notBuiltIn.push(imported[1]);
  }
  eq('vendor: bundle imports only node built-ins', notBuiltIn, []);
}

// ---- v0.10.0: the mod's frontmatter reader and this one agree; one list of defaults ----
{
  const { SETTINGS_CASES } = await import('../tests/fixtures/settings-cases.mjs');
  for (const one of SETTINGS_CASES) {
    const parsed = sanitize(parseFrontmatter(one.text));
    const agreed = {};
    for (const key of Object.keys(one.expect.raw)) agreed[key] = parsed[key];
    eq(`settings parity: ${one.name}`, agreed, one.expect.raw);
    eq(`settings parity: ${one.name}: warnings`, frontmatterWarnings(one.text), one.expect.warnings ?? []);
    eq(`settings parity: ${one.name}: runner in use`, runnerSettings(parsed).type, one.expect.runner ?? null);
  }

  eq('settings parity: a fence key in a project file is global-only', frontmatterWarnings('---\ndelegate.fence.codex: full\n---\n', { projectScope: true }), ['line 2: ignored `delegate.fence.codex`: delegate settings are global-only (~/.claude/consult.local.md)']);

  const { CONSULT_DEFAULTS } = await import('./lib/defaults.js');
  const shared = JSON.parse(fs.readFileSync(new URL('./lib/defaults.json', import.meta.url), 'utf8'));
  eq('defaults: defaults.js reads defaults.json', { ...CONSULT_DEFAULTS }, shared);
  truthy('defaults: frozen', Object.isFrozen(CONSULT_DEFAULTS));
  eq('defaults: codex floor comes from defaults.json', CODEX_TIMEOUT_FLOOR_MS, shared.codex_timeout_floor_ms);
  const { DEFAULTS } = await import('./lib/settings.js');
  eq('defaults: settings.js timeout_ms comes from defaults.json', DEFAULTS.timeout_ms, shared.timeout_ms);
  eq('defaults: settings.js agy_image_timeout_ms comes from defaults.json', DEFAULTS.agy_image_timeout_ms, shared.agy_image_timeout_ms);
  eq('defaults: settings.js codex_image_timeout_ms comes from defaults.json', DEFAULTS.codex_image_timeout_ms, shared.codex_image_timeout_ms);
}

// hooks/scripts/health.js, the Claude Code mod's start-of-session check: it
// runs unasked, so a project's settings must not send it off this machine.
{
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../hooks/scripts/health.js', import.meta.url));
  const runHealth = (baseUrl) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-health-'));
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', 'consult.local.md'), `---\nlocal_model: qwen3.5:9b\nlocal_base_url: ${baseUrl}\n---\n`);
    // A home of its own: the person's global file (runner settings) would
    // otherwise decide which runner the script checks.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-health-home-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, CONSULT_NO_USER_ENV: '1' };
    try {
      const ran = spawnSync(process.execPath, [script, project, 'local'], { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 30000 });
      try {
        return JSON.parse(ran.stdout);
      } catch (_) {
        return { stdout: ran.stdout, stderr: ran.stderr };
      }
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
  eq('health script: a project pointing local off this machine is not probed', runHealth('http://203.0.113.1:9/v1'), { local: null });
  const loopback = runHealth('http://127.0.0.1:9/v1').local;
  eq('health script: a loopback runner is probed from the project given', [loopback?.reachable, loopback?.base_url], [false, 'http://127.0.0.1:9/v1']);
}

// ---- v0.10.0: agy_generate_image options ----
{
  eq('imageOptions: defaults', imageOptions({}), { aspect_ratio: '1:1', tier: 'inherit', count: 1, exact_prompt: false });
  eq('imageOptions: the setting gives the default ratio', imageOptions({}, { agy_image_aspect_ratio: '16:9' }).aspect_ratio, '16:9');
  eq('imageOptions: the argument beats the setting', imageOptions({ aspect_ratio: '3:4' }, { agy_image_aspect_ratio: '16:9' }).aspect_ratio, '3:4');
  eq('imageOptions: every option passes through',
    imageOptions({ aspect_ratio: 'auto', tier: 'pro', count: 4, exact_prompt: true }), { aspect_ratio: 'auto', tier: 'pro', count: 4, exact_prompt: true });
  eq('AGY_IMAGE_ASPECT_RATIOS: agy\'s seven plus auto', AGY_IMAGE_ASPECT_RATIOS, ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', 'auto']);
  eq('AGY_IMAGE_TIERS: inherit, flash, pro', AGY_IMAGE_TIERS, ['inherit', 'flash', 'pro']);
  throws('imageOptions: a ratio agy\'s tool does not take is refused', () => imageOptions({ aspect_ratio: '5:4' }));
  throws('imageOptions: flash_lite is not offered', () => imageOptions({ tier: 'flash_lite' }));
  throws('imageOptions: count 0 is refused', () => imageOptions({ count: 0 }));
  throws('imageOptions: count 5 is refused', () => imageOptions({ count: 5 }));
  throws('imageOptions: a fractional count is refused', () => imageOptions({ count: 1.5 }));
  throws('imageOptions: a count given as text is refused', () => imageOptions({ count: '2' }));
  throws('imageOptions: exact_prompt must be a boolean', () => imageOptions({ exact_prompt: 'yes' }));
  let tooMany = null;
  try { imageOptions({ images: ['a.png', 'b.png', 'c.png', 'd.png'] }); } catch (e) { tooMany = e; }
  truthy('imageOptions: 4 references are refused, naming the limit', /at most 3 reference images/.test(String(tooMany?.message)));
  eq('imageOptions: 3 references are fine', imageOptions({ images: ['a.png', 'b.png', 'c.png'] }).count, 1);

  const full = imageSettingsBlock({ aspect_ratio: '9:16', tier: 'pro', count: 2, exact_prompt: true });
  truthy('imageSettingsBlock: names the ratio as agy\'s AspectRatio', full.includes('Set AspectRatio to "9:16"'));
  truthy('imageSettingsBlock: names the tier', full.includes('"pro" tier'));
  truthy('imageSettingsBlock: asks for each image as its own call', /exactly 2 images/.test(full) && /separate generate_image call/.test(full));
  truthy('imageSettingsBlock: exact_prompt asks for the prompt word for word', /word for word/.test(full));
  const plain = imageSettingsBlock({ aspect_ratio: '1:1', tier: 'inherit', count: 1, exact_prompt: false });
  truthy('imageSettingsBlock: the default still sends the ratio', plain.includes('Set AspectRatio to "1:1"'));
  truthy('imageSettingsBlock: inherit names no tier', !/tier/.test(plain));
  truthy('imageSettingsBlock: no word-for-word line by default', !/word for word/.test(plain));
  truthy('imageSettingsBlock: one image', /exactly 1 image\b/.test(plain));
  truthy('imageSettingsBlock: auto sends no ratio', !/AspectRatio/.test(imageSettingsBlock({ aspect_ratio: 'auto', tier: 'inherit', count: 1, exact_prompt: false })));

  eq('agyImageTimeoutMs: one image keeps the base', agyImageTimeoutMs(300000, 1), 300000);
  eq('agyImageTimeoutMs: two minutes more per extra image', agyImageTimeoutMs(300000, 4), 660000);
  eq('agyImageTimeoutMs: capped at 30 minutes', agyImageTimeoutMs(1700000, 4), 1800000);

  eq('settings: agy_image_aspect_ratio defaults to 1:1', DEFAULTS.agy_image_aspect_ratio, '1:1');
  eq('settings: a valid agy_image_aspect_ratio is kept', sanitize({ agy_image_aspect_ratio: '16:9' }).agy_image_aspect_ratio, '16:9');
  eq('settings: an invalid agy_image_aspect_ratio is dropped', 'agy_image_aspect_ratio' in sanitize({ agy_image_aspect_ratio: '5:4' }), false);
  eq('settings: 16:9 parses from frontmatter as text', parseFrontmatter('---\nagy_image_aspect_ratio: 16:9\n---\n').agy_image_aspect_ratio, '16:9');

  eq('settings: codex_image_aspect_ratio defaults to 1:1', DEFAULTS.codex_image_aspect_ratio, '1:1');
  eq('settings: a valid codex_image_aspect_ratio is kept', sanitize({ codex_image_aspect_ratio: '16:9' }).codex_image_aspect_ratio, '16:9');
  eq('settings: an invalid codex_image_aspect_ratio is dropped', 'codex_image_aspect_ratio' in sanitize({ codex_image_aspect_ratio: '5:4' }), false);
  eq('settings: a positive codex_image_timeout_ms is kept', sanitize({ codex_image_timeout_ms: 420000 }).codex_image_timeout_ms, 420000);
  eq('settings: a bad codex_image_timeout_ms is dropped', 'codex_image_timeout_ms' in sanitize({ codex_image_timeout_ms: -1 }), false);
  truthy('settings: KNOWN_KEYS has the codex image keys',
    KNOWN_KEYS.includes('codex_image_dir') && KNOWN_KEYS.includes('codex_image_timeout_ms') && KNOWN_KEYS.includes('codex_image_aspect_ratio'));

  const copiedOne = [{ path: '/out/a.jpg', source: '/brain/x/a.jpg', type: 'jpeg', width: 768, height: 1376, bytes: 10 }];
  const requested = { aspect_ratio: '9:16', tier: 'pro', count: 2, exact_prompt: false };
  const short = finishImageCall({ copied: copiedOne, parsed: { status: 'SUCCESS', response: 'Saved /brain/x/a.jpg' }, outDir: '/out', requested });
  truthy('finishImageCall: fewer images than asked for is a warning', /asked for 2 images, agy saved 1/.test(String(short.warning)));
  eq('finishImageCall: the result reports what was asked for', [short.aspect_ratio, short.tier, short.count], ['9:16', 'pro', 2]);
  const enough = finishImageCall({ copied: copiedOne, parsed: { status: 'SUCCESS', response: 'Saved' }, outDir: '/out', requested: { ...requested, count: 1 } });
  eq('finishImageCall: no warning when the count was met', enough.warning, undefined);

  let refused = null;
  try { await agyGenerateImage({ prompt: 'x', images: ['/nope/1.png', '/nope/2.png', '/nope/3.png', '/nope/4.png'], output_dir: os.tmpdir() }); } catch (e) { refused = e; }
  truthy('agyGenerateImage: 4 references are refused before any file is read or agy runs', /at most 3 reference images/.test(String(refused?.message)));
}

// --- v0.11.0: local model facts ---
function throwsWith(label, fn, pattern) {
  let message = null;
  try { fn(); } catch (e) { message = String(e?.message ?? e); }
  const ok = message !== null && pattern.test(message);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (ok ? '' : `\n  got: ${JSON.stringify(message)}\n  want: ${pattern}`));
  if (!ok) failed++;
}
function row(proposal, role) {
  for (const one of proposal.rows) if (one.role === role) return one;
  return null;
}
function tagModel(name, size, digest, params, quant, capabilities) {
  return { name, model: name, size, digest, details: { parameter_size: params, quantization_level: quant }, capabilities };
}
// Ollama's /api/tags on the user's machine, 2026-10-19 (digests shortened).
const LOCAL_TAGS = { models: [
  tagModel('qwen3.8-9b-distill:q4_k_m', 5780090311, '5acccdd1b64b', '9.2B', 'Q4_K_M', ['tools', 'thinking', 'completion']),
  tagModel('qwen3.8-27b:ud-iq4_xs', 15180453608, '1939e390fed7', '27.3B', 'IQ4_XS', ['tools', 'thinking', 'completion', 'vision']),
  tagModel('qwen3.8-27b:ud-iq3_xxs', 11862468329, '14d49494ca2a', '27.3B', 'IQ3_XXS', ['tools', 'thinking', 'completion', 'vision']),
  tagModel('qwen3.5-9b:latest', 5966095719, 'f1b6a4527aea', '9.0B', 'Q4_K_M', ['tools', 'thinking', 'completion']),
  tagModel('qwen3.6-35b-a3b:ud-iq3_xxs', 13211155567, 'a75def8c68dd', '34.7B', 'IQ3_XXS', ['tools', 'thinking', 'completion']),
  tagModel('qwen3.5-9b-mtp:q4_k_m', 5868827111, '68ffc74bae99', '9.2B', 'Q4_K_M', ['tools', 'thinking', 'completion']),
  tagModel('qwen3.5-9b:ud-q4_k_xl', 5966095719, 'f1b6a4527aea', '9.0B', 'Q4_K_M', ['tools', 'thinking', 'completion']),
  tagModel('huihui-qwen3.8-27b-abliterated:ud-iq4_xs', 15334642888, '39225943f823', '27.3B', 'IQ4_XS', ['tools', 'thinking', 'completion', 'vision']),
  tagModel('qwen3.5:4b', 3324173934, 'd8b0f5e9760c', '4.2B', 'Q4_K_M', ['completion', 'vision', 'tools', 'thinking'])
] };
const NO_NICKNAMES = { default: null, fast: null, vision: null, vision_best: null, big: null };
{
  const facts = modelFacts(LOCAL_TAGS, 8151);
  const factNamed = (name) => facts.find(f => f.name === name);
  eq('facts: alias pair is one model', facts.filter(f => f.name.startsWith('qwen3.5-9b:')).length, 1);
  eq('facts: alias kept', factNamed('qwen3.5-9b:ud-q4_k_xl').aliases, ['qwen3.5-9b:latest']);
  eq('facts: 5.8 GB fits', factNamed('qwen3.8-9b-distill:q4_k_m').fits_gpu, true);
  eq('facts: 11.9 GB does not fit', factNamed('qwen3.8-27b:ud-iq3_xxs').fits_gpu, false);
  eq('facts: unknown vram', modelFacts(LOCAL_TAGS, null)[0].fits_gpu, null);
  eq('facts: one fact', factNamed('qwen3.5:4b'), { name: 'qwen3.5:4b', aliases: [], digest: 'd8b0f5e9760c', size_bytes: 3324173934, size_gb: 3.3, params_b: 4.2, params: '4.2B', quant: 'Q4_K_M', vision: true, thinking: true, fits_gpu: true });
  eq('baseName', baseName('qwen3.8-27b:ud-iq4_xs'), 'qwen3.8-27b');
  eq('quantRank', [quantRank('Q5_K_M'), quantRank('IQ4_XS'), quantRank('ud-iq3_xxs'), quantRank('Q8_0'), quantRank('F16?')], [5, 4, 3, 8, 0]);

  const none = NO_NICKNAMES;
  const p = proposeNicknames(facts, none);
  eq('propose: fast', row(p, 'fast').proposed, ['qwen3.5:4b']);
  eq('propose: default tie (same params, quant, size within 0.2 GB)', row(p, 'default').proposed, ['qwen3.8-9b-distill:q4_k_m', 'qwen3.5-9b-mtp:q4_k_m']);
  eq('propose: vision', row(p, 'vision').proposed, ['qwen3.5:4b']);
  eq('propose: vision_best tie', [...row(p, 'vision_best').proposed].sort(), ['huihui-qwen3.8-27b-abliterated:ud-iq4_xs', 'qwen3.8-27b:ud-iq4_xs']);
  eq('propose: big', row(p, 'big').proposed, ['qwen3.6-35b-a3b:ud-iq3_xxs']);
  truthy('propose: reason built from facts', /4\.2B, 3\.3 GB, fits the GPU, reads images/.test(row(p, 'fast').reason));
  eq('propose: nothing saved means every model is new', p.new_models.length, 8);
  eq('propose: fit known', p.fit_known, true);
  const unknownFit = proposeNicknames(modelFacts(LOCAL_TAGS, null), none);
  eq('propose: fit unknown leaves fit roles empty', [row(unknownFit, 'fast').proposed, row(unknownFit, 'default').proposed, row(unknownFit, 'vision').proposed], [[], [], []]);
  eq('propose: fit unknown still proposes big', row(unknownFit, 'big').proposed, ['qwen3.6-35b-a3b:ud-iq3_xxs']);

  const swapped = proposeNicknames(facts, { ...none, default: 'qwen3.8-9b-distill:q5_k_m', fast: 'qwen3.5:4b', big: 'llama4:q4' });
  eq('propose: quant swap row', [row(swapped, 'default').saved_state, row(swapped, 'default').replacement, row(swapped, 'default').proposed], ['replaced', 'qwen3.8-9b-distill:q4_k_m', ['qwen3.8-9b-distill:q4_k_m']]);
  eq('propose: kept row', row(swapped, 'fast').saved_state, 'kept');
  eq('propose: gone row falls back to the rule', [row(swapped, 'big').saved_state, row(swapped, 'big').proposed], ['gone', ['qwen3.6-35b-a3b:ud-iq3_xxs']]);
  truthy('propose: saved models are not new', !swapped.new_models.includes('qwen3.5:4b') && !swapped.new_models.includes('qwen3.8-9b-distill:q4_k_m'));

  eq('resolve: default quant swap', resolveModel(null, facts, { ...none, default: 'qwen3.8-9b-distill:q5_k_m' }), { model: 'qwen3.8-9b-distill:q4_k_m', quant_swapped: 'qwen3.8-9b-distill:q5_k_m → qwen3.8-9b-distill:q4_k_m' });
  eq('resolve: exact name', resolveModel('qwen3.8-27b:ud-iq3_xxs', facts, none), { model: 'qwen3.8-27b:ud-iq3_xxs' });
  eq('resolve: alias gives the canonical name', resolveModel('qwen3.5-9b:latest', facts, none), { model: 'qwen3.5-9b:ud-q4_k_xl' });
  eq('resolve: nickname', resolveModel('fast', facts, { ...none, fast: 'qwen3.5:4b' }), { model: 'qwen3.5:4b', resolved_from: 'fast' });
  eq('resolve: vision-best spelling', resolveModel('vision-best', facts, { ...none, vision_best: 'qwen3.8-27b:ud-iq4_xs' }).model, 'qwen3.8-27b:ud-iq4_xs');
  eq('resolve: default nickname', resolveModel('default', facts, { ...none, default: 'qwen3.5:4b' }).model, 'qwen3.5:4b');
  eq('resolve: local_model may hold a nickname', resolveModel(null, facts, { ...none, default: 'fast', fast: 'qwen3.5:4b' }).model, 'qwen3.5:4b');
  eq('resolve: fragment', resolveModel('distill', facts, none), { model: 'qwen3.8-9b-distill:q4_k_m', resolved_from: 'distill' });
  eq('resolve: alias fragment counts once', resolveModel('qwen3.5-9b:', facts, none).model, 'qwen3.5-9b:ud-q4_k_xl');
  eq('resolve: a gone full name with one quant left swaps', resolveModel('qwen3.6-35b-a3b:q4_k_m', facts, none).quant_swapped, 'qwen3.6-35b-a3b:q4_k_m → qwen3.6-35b-a3b:ud-iq3_xxs');
  throwsWith('resolve: nothing configured', () => resolveModel(null, facts, none), /No local model configured/);
  throwsWith('resolve: ambiguous fragment names the candidates', () => resolveModel('27b', facts, none), /qwen3\.8-27b:ud-iq4_xs/);
  throwsWith('resolve: whole model gone', () => resolveModel('big', facts, { ...none, big: 'llama4:q4' }), /`big` points to `llama4:q4`, which is no longer installed; run \/consult:setlocal/);
  throwsWith('resolve: two remaining quants are named, never picked', () => resolveModel('vision_best', facts, { ...none, vision_best: 'qwen3.8-27b:q8_0' }), /qwen3\.8-27b:ud-iq3_xxs[\s\S]*qwen3\.8-27b:ud-iq4_xs/);
  throwsWith('resolve: unsaved nickname', () => resolveModel('vision', facts, none), /no `vision` nickname[\s\S]*\/consult:setlocal/);
  throwsWith('resolve: no match lists the models', () => resolveModel('llama', facts, none), /qwen3\.5:4b/);
}

// --- v0.11.0: live inventory, VRAM and settings keys ---
{
  eq('ollamaBase: strips /v1', ollamaBase('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  eq('ollamaBase: strips /v1/', ollamaBase('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234');
  eq('ollamaBase: no /v1 is not the Ollama layout', ollamaBase('http://127.0.0.1:8080/api'), null);
  eq('fetchTags: an unreachable runner is null', await fetchTags('http://127.0.0.1:9/v1', 500), null);
  eq('fetchTags: a non-Ollama base is null', await fetchTags('http://127.0.0.1:9/other', 500), null);

  resetVramCacheForTests();
  eq('vramMb: the setting wins and the runner is not used', await vramMb({ local_vram_mb: 6000 }, () => { throw new Error('ran'); }), 6000);
  resetVramCacheForTests();
  eq('vramMb: nvidia-smi output is read', await vramMb({}, async () => '8151\n'), 8151);
  let runs = 0;
  resetVramCacheForTests();
  await vramMb({}, async () => { runs++; return '8151'; });
  await vramMb({}, async () => { runs++; return '8151'; });
  eq('vramMb: nvidia-smi runs once per process', runs, 1);
  resetVramCacheForTests();
  eq('vramMb: a failing runner is null', await vramMb({}, async () => { throw new Error('ENOENT'); }), null);
  resetVramCacheForTests();
  eq('vramMb: garbage output is null', await vramMb({}, async () => 'No devices were found'), null);
  resetVramCacheForTests();

  eq('savedNicknames', savedNicknames({ local_model: 'a:1', local_model_fast: 'b:1', local_model_vision: null, local_model_vision_best: 'c:1', local_model_big: undefined }),
    { default: 'a:1', fast: 'b:1', vision: null, vision_best: 'c:1', big: null });
  eq('sanitize: a non-string nickname is dropped', 'local_model_fast' in sanitize({ local_model_fast: 5 }), false);
  eq('sanitize: a string nickname stays', sanitize({ local_model_big: 'x:1' }).local_model_big, 'x:1');
  eq('sanitize: a bad local_vram_mb is dropped', 'local_vram_mb' in sanitize({ local_vram_mb: -1 }), false);
  eq('sanitize: local_vram_mb stays', sanitize({ local_vram_mb: 8151 }).local_vram_mb, 8151);
  eq('DEFAULTS: nickname keys default to null', [DEFAULTS.local_vram_mb, DEFAULTS.local_model_fast, DEFAULTS.local_model_vision, DEFAULTS.local_model_vision_best, DEFAULTS.local_model_big], [null, null, null, null, null]);
  eq('defaults: the slow-model floor comes from defaults.json', LOCAL_SLOW_FLOOR_MS, 1200000);
}

// --- v0.11.0: saving nicknames ---
{
  const original = '﻿---\r\n# Global consult settings\r\ntimeout_ms: 600000\r\nlocal_model: old:q5   # picked in August\r\nlocal_model_big: gone:1\r\n---\r\nBody text stays.\r\n';
  const rewritten = rewriteLocalModelLines(original, { local_model: 'new:q4', local_model_fast: 'qwen3.5:4b', local_model_big: null });
  eq('rewrite: BOM, CRLF, comments and the body are kept; the comment on a replaced line too',
    rewritten,
    '﻿---\r\n# Global consult settings\r\ntimeout_ms: 600000\r\nlocal_model: new:q4   # picked in August\r\nlocal_model_fast: qwen3.5:4b\r\n---\r\nBody text stays.\r\n');
  const parsed = parseFrontmatter(rewritten);
  eq('rewrite: reads back', [parsed.local_model, parsed.local_model_fast, 'local_model_big' in parsed, parsed.timeout_ms], ['new:q4', 'qwen3.5:4b', false, 600000]);
  eq('rewrite: no frontmatter gets a block on top', rewriteLocalModelLines('Just notes.\n', { local_model_fast: 'a:1' }), '---\nlocal_model_fast: a:1\n---\nJust notes.\n');
  eq('rewrite: no file creates one', rewriteLocalModelLines(null, { local_model: 'a:1' }), '---\nlocal_model: a:1\n---\n');
  eq('rewrite: only local_model lines are touched', rewriteLocalModelLines('---\nlocal_model_vision: a:1\nlocal_reasoning_effort: none\n---\n', { local_model_vision: 'b:2' }), '---\nlocal_model_vision: b:2\nlocal_reasoning_effort: none\n---\n');
  throws('rewrite: other keys are refused', () => rewriteLocalModelLines('---\n---\n', { timeout_ms: '1' }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-nick-'));
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  eq('target: global when the project has no file', settingsTargetPath(project, home), path.join(home, '.claude', 'consult.local.md'));
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude', 'consult.local.md'), '---\ntimeout_ms: 600000\n---\n');
  eq('target: the project file when it exists', settingsTargetPath(project, home), path.join(project, '.claude', 'consult.local.md'));

  const facts = modelFacts(LOCAL_TAGS, 8151);
  const saved = saveNicknames({ save: { default: 'qwen3.8-9b-distill:q4_k_m', fast: 'qwen3.5:4b', 'vision-best': 'qwen3.8-27b:ud-iq4_xs', big: null }, facts, cwd: project, home });
  eq('save: the project file is written', saved.path, path.join(project, '.claude', 'consult.local.md'));
  eq('save: written keys', saved.written, { local_model: 'qwen3.8-9b-distill:q4_k_m', local_model_fast: 'qwen3.5:4b', local_model_vision_best: 'qwen3.8-27b:ud-iq4_xs', local_model_big: null });
  eq('save: the file reads back', fs.readFileSync(saved.path, 'utf8'), '---\ntimeout_ms: 600000\nlocal_model: qwen3.8-9b-distill:q4_k_m\nlocal_model_fast: qwen3.5:4b\nlocal_model_vision_best: qwen3.8-27b:ud-iq4_xs\n---\n');
  const before = fs.readFileSync(saved.path, 'utf8');
  throwsWith('save: an uninstalled model is refused by name', () => saveNicknames({ save: { fast: 'llama4:q4', big: 'nope:1' }, facts, cwd: project, home }), /llama4:q4[\s\S]*nope:1/);
  eq('save: a refused save leaves the file alone', fs.readFileSync(saved.path, 'utf8'), before);
  throwsWith('save: an unknown role is refused', () => saveNicknames({ save: { tiny: 'qwen3.5:4b' }, facts, cwd: project, home }), /tiny/);
  const aliasSave = saveNicknames({ save: { default: 'qwen3.5-9b:latest' }, facts, cwd: project, home });
  eq('save: an alias is accepted as given', aliasSave.written.local_model, 'qwen3.5-9b:latest');

  const fresh = path.join(dir, 'fresh-project');
  fs.mkdirSync(fresh);
  const created = saveNicknames({ save: { fast: 'qwen3.5:4b' }, facts, cwd: fresh, home });
  eq('save: no settings file anywhere creates the global one', [created.path, fs.readFileSync(created.path, 'utf8')], [path.join(home, '.claude', 'consult.local.md'), '---\nlocal_model_fast: qwen3.5:4b\n---\n']);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- v0.11.0: preparing a local call ---
{
  const facts = modelFacts(LOCAL_TAGS, 8151);
  const settings = { timeout_ms: 180000, local_timeout_ms: null, local_model: 'qwen3.8-9b-distill:q4_k_m', local_model_fast: 'qwen3.5:4b', local_model_vision: 'qwen3.5:4b' };
  const call = (over) => prepareLocalCall({ requested: null, images: undefined, settings, callTimeoutMs: null, facts, ...over });
  eq('prepare: a nickname resolves', call({ requested: 'fast' }), { model: 'qwen3.5:4b', timeout_ms: 180000, notes: { resolved_from: 'fast' } });
  eq('prepare: an image to a model without vision switches to the vision nickname', call({ images: ['a.png'] }), { model: 'qwen3.5:4b', timeout_ms: 180000, notes: { switched_for_images: 'qwen3.8-9b-distill:q4_k_m → qwen3.5:4b' } });
  eq('prepare: an image to a vision model stays', call({ requested: 'qwen3.8-27b:ud-iq3_xxs', images: ['a.png'] }).model, 'qwen3.8-27b:ud-iq3_xxs');
  throwsWith('prepare: no vision nickname names the vision models', () => call({ images: ['a.png'], settings: { ...settings, local_model_vision: null } }), /qwen3\.5:4b[\s\S]*\/consult:setlocal/);
  eq('prepare: a slow model gets the floor', call({ requested: 'big', settings: { ...settings, local_model_big: 'qwen3.6-35b-a3b:ud-iq3_xxs' } }).timeout_ms, 1200000);
  eq('prepare: a higher timeout_ms beats the floor', call({ requested: 'qwen3.6-35b-a3b:ud-iq3_xxs', settings: { ...settings, timeout_ms: 1500000 } }).timeout_ms, 1500000);
  eq('prepare: local_timeout_ms wins over the floor', call({ requested: 'qwen3.6-35b-a3b:ud-iq3_xxs', settings: { ...settings, local_timeout_ms: 120000 } }).timeout_ms, 120000);
  eq('prepare: timeout_s on the call wins', call({ requested: 'qwen3.6-35b-a3b:ud-iq3_xxs', callTimeoutMs: 90000 }).timeout_ms, 90000);
  eq('prepare: a council uses council_timeout_ms as the base', call({ requested: 'fast', inCouncil: true, settings: { ...settings, council_timeout_ms: 240000 } }).timeout_ms, 240000);
  eq('prepare: no inventory passes the name through, as before', prepareLocalCall({ requested: 'anything', images: ['a.png'], settings, callTimeoutMs: null, facts: null }), { model: 'anything', timeout_ms: 180000, notes: {} });
  eq('prepare: no inventory and no model falls back to local_model', prepareLocalCall({ requested: undefined, settings, callTimeoutMs: null, facts: null }).model, 'qwen3.8-9b-distill:q4_k_m');
  eq('prepare: a quant swap is reported', call({ settings: { ...settings, local_model: 'qwen3.8-9b-distill:q5_k_m' } }).notes, { quant_swapped: 'qwen3.8-9b-distill:q5_k_m → qwen3.8-9b-distill:q4_k_m' });
}

// --- v0.11.0 final review fixes ---
{
  const sized = modelFacts({ models: [
    tagModel('qwen3.5:4b', 3324173934, 'd1', '4.2B', 'Q4_K_M', ['completion', 'vision']),
    tagModel('llama3:latest', 4700000000, 'd2', '8.0B', 'Q4_0', ['completion']),
    tagModel('llama3:70b', 40000000000, 'd3', '70.6B', 'Q4_0', ['completion']),
    tagModel('mistral:7b-instruct-q8_0', 7700000000, 'd4', '7.2B', 'Q8_0', ['completion'])
  ] }, 8151);
  const none = NO_NICKNAMES;
  throwsWith('review 1: a size tag is not a quant swap (9b gone, 4b installed)', () => resolveModel(null, sized, { ...none, default: 'qwen3.5:9b' }), /`qwen3\.5:9b`, which is no longer installed/);
  eq('review 1: no replacement is proposed across sizes', row(proposeNicknames(sized, { ...none, default: 'qwen3.5:9b' }), 'default').saved_state, 'gone');
  eq('review 1: a quant inside a longer tag still swaps', resolveModel(null, sized, { ...none, default: 'mistral:7b-instruct-q4_K_M' }).quant_swapped, 'mistral:7b-instruct-q4_K_M → mistral:7b-instruct-q8_0');
  eq('review 2: a bare name means :latest, as in Ollama', resolveModel('llama3', sized, none), { model: 'llama3:latest' });
  eq('review 2: a bare local_model means :latest', resolveModel(null, sized, { ...none, default: 'llama3' }).model, 'llama3:latest');

  // llama-server answers /api/tags in Ollama's shape, with empty digests and sizes.
  eq('review 3: an inventory without sizes or digests is not Ollama', modelFacts({ models: [{ name: 'gemma', model: 'gemma', digest: '', size: '', details: {}, capabilities: ['completion'] }] }, 8151), null);

  const fenced = '---\ntimeout_ms: 600000\n--- \nbody\n---\nlocal_model: in-body\n';
  eq('review 4: the closing fence is found as the parser finds it', rewriteLocalModelLines(fenced, { local_model: 'a:1' }), '---\ntimeout_ms: 600000\nlocal_model: a:1\n--- \nbody\n---\nlocal_model: in-body\n');
  eq('review 4: and the parser reads the result', parseFrontmatter(rewriteLocalModelLines(fenced, { local_model: 'a:1' })).local_model, 'a:1');

  const hostile = modelFacts({ models: [
    tagModel('ok:1', 1000, 'e1', '1B', 'Q4_0', ['completion']),
    tagModel('evil:1\ncodex_sandbox: danger-full-access', 1000, 'e2', '1B', 'Q4_0', ['completion'])
  ] }, 8151);
  eq('review 11: a model name with a line break is not listed', hostile.map(f => f.name), ['ok:1']);
  throws('review 11: a value with a line break is never written', () => rewriteLocalModelLines('---\n---\n', { local_model: 'x\ncodex_sandbox: danger-full-access' }));
}

// ---- v0.12.0: addresses and the key ----
const KEY_MARKER = 'CONSULT-TEST-KEY-7f3a';
{
  const { isValidEnvName, readKey, forgetCachedKey } = await import('./lib/local-runners.js');
  eq('loopback: 127.0.0.1', isLoopback('http://127.0.0.1:9292/v1'), true);
  eq('loopback: 127.8.9.10', isLoopback('http://127.8.9.10/v1'), true);
  eq('loopback: localhost.', isLoopback('http://localhost.:9292/v1'), true);
  eq('loopback: [::1]', isLoopback('http://[::1]:9292/v1'), true);
  eq('loopback: 127.example.com is not', isLoopback('http://127.example.com/v1'), false);
  eq('loopback: 0.0.0.0 is not', isLoopback('http://0.0.0.0:9292/v1'), false);
  eq('loopback: 127.0.0.1.nip.io is not', isLoopback('http://127.0.0.1.nip.io/v1'), false);
  eq('loopback: 127.0.0.256 is not', isLoopback('http://127.0.0.256/v1'), false);
  eq('env name: valid', isValidEnvName('LLAMA_SWAP_API_KEY'), true);
  eq('env name: spaces refused', isValidEnvName('A B'), false);
  eq('env name: leading digit refused', isValidEnvName('1KEY'), false);
  eq('key: from process env', await readKey('FAKE_KEY', { env: { FAKE_KEY: KEY_MARKER }, readUserEnv: async () => null }), { key: KEY_MARKER, source: 'process' });
  eq('key: from user env', await readKey('FAKE_KEY2', { env: {}, readUserEnv: async () => KEY_MARKER }), { key: KEY_MARKER, source: 'user-env' });
  let registryReads = 0;
  const counting = async () => { registryReads++; return KEY_MARKER; };
  await readKey('FAKE_KEY3', { env: {}, readUserEnv: counting });
  await readKey('FAKE_KEY3', { env: {}, readUserEnv: counting });
  eq('key: user env cached', registryReads, 1);
  forgetCachedKey('FAKE_KEY3');
  await readKey('FAKE_KEY3', { env: {}, readUserEnv: counting });
  eq('key: re-read after forget', registryReads, 2);
  eq('key: missing', await readKey('FAKE_KEY4', { env: {}, readUserEnv: async () => null }), { key: null, source: null });
  eq('key: an invalid name is never looked up', await readKey('A B', { env: { 'A B': KEY_MARKER }, readUserEnv: async () => KEY_MARKER }), { key: null, source: null });
  // The test-only switch can only turn the registry read off.
  eq('key: CONSULT_NO_USER_ENV skips the user env', await readKey('FAKE_KEY5', { env: { CONSULT_NO_USER_ENV: '1' }, readUserEnv: async () => KEY_MARKER }), { key: null, source: null });
  eq('key: CONSULT_NO_USER_ENV keeps the process env', await readKey('FAKE_KEY6', { env: { CONSULT_NO_USER_ENV: '1', FAKE_KEY6: KEY_MARKER }, readUserEnv: async () => null }), { key: KEY_MARKER, source: 'process' });
}

// ---- v0.12.0: runner settings come from the global file ----
// Runs loadSettings with a temporary home (global file) and project (cwd).
function loadWith({ globalText = null, projectText = null }) {
  const origCwd = process.cwd();
  const origEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-proj-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(project, '.claude'));
  if (globalText !== null) fs.writeFileSync(path.join(home, '.claude', 'consult.local.md'), globalText);
  if (projectText !== null) fs.writeFileSync(path.join(project, '.claude', 'consult.local.md'), projectText);
  try {
    process.chdir(project);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return { settings: loadSettings(), home, project };
  } finally {
    process.chdir(origCwd);
    for (const [k, v] of Object.entries(origEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}
{
  const globalText = '---\nlocal_runner: llama-swap\nllama-swap.url: http://127.0.0.1:9292/v1\nllama-swap.key_env: LLAMA_SWAP_API_KEY\nllama-swap.start: Desktop shortcut "llama-swap"\nllama-swap.default: qwen3.6-35b-a3b\nlocal_model: qwen3.8-9b-distill:q4_k_m\nlocal_model_fast: qwen3.5:4b\ntimeout_ms: 600000\n---\n';
  const projectText = '---\ntimeout_ms: 300000\nlocal_runner: ollama\nllama-swap.url: http://10.0.0.9:9292/v1\n---\n';
  const both = loadWith({ globalText, projectText });
  const runner = runnerSettings(both.settings);
  eq('runners: the project file is in effect for other keys', both.settings.timeout_ms, 300000);
  eq('runners: local_runner comes from the global file', runner.type, 'llama-swap');
  eq('runners: url comes from the global file', runner.url, 'http://127.0.0.1:9292/v1');
  eq('runners: key_env and start', [runner.key_env, runner.start], ['LLAMA_SWAP_API_KEY', 'Desktop shortcut "llama-swap"']);
  eq('runners: nicknames', runner.nicknames, { default: 'qwen3.6-35b-a3b', fast: null, vision: null, vision_best: null, big: null });
  const projectWarnings = both.settings._warnings.filter(w => w.includes(path.join(both.project, '.claude', 'consult.local.md')));
  eq('runners: each project runner line is warned about, with file and line', projectWarnings.length, 2);
  truthy('runners: the warning names the key and the line', projectWarnings.some(w => w.includes('line 3') && w.includes('`local_runner`') && w.includes('global-only')));
  truthy('runners: the remote url line too', projectWarnings.some(w => w.includes('line 4') && w.includes('`llama-swap.url`')));
  eq('runners: localConfigured with a runner', localConfigured(both.settings), true);

  const ollamaGlobal = '---\nlocal_runner: ollama\nollama.fast: qwen3.5:4b-new\nlocal_model: qwen3.8-9b-distill:q4_k_m\nlocal_model_fast: qwen3.5:4b\nlocal_model_vision_best: qwen3.8-27b:ud-iq4_xs\nlocal_base_url: http://127.0.0.1:11500/v1\n---\n';
  const ollama = runnerSettings(loadWith({ globalText: ollamaGlobal }).settings);
  eq('runners: ollama fills roles from the 0.11.0 lines', ollama.nicknames, { default: 'qwen3.8-9b-distill:q4_k_m', fast: 'qwen3.5:4b-new', vision: null, vision_best: 'qwen3.8-27b:ud-iq4_xs', big: null });
  eq('runners: ollama url from local_base_url', ollama.url, 'http://127.0.0.1:11500/v1');
  eq('runners: ollama url defaults to the standard address', runnerSettings(loadWith({ globalText: '---\nlocal_runner: ollama\n---\n' }).settings).url, 'http://127.0.0.1:11434/v1');
  eq('runners: llama-swap has no standard address', runnerSettings(loadWith({ globalText: '---\nlocal_runner: llama-swap\n---\n' }).settings).url, null);
  const swapIgnoresLegacy = runnerSettings(loadWith({ globalText: '---\nlocal_runner: llama-swap\nlocal_model: qwen3.5:4b\n---\n' }).settings);
  eq('runners: 0.11.0 lines are not used by other runners', swapIgnoresLegacy.nicknames.default, null);

  const legacy = loadWith({ globalText: '---\nlocal_model: qwen3.5:4b\nlocal_base_url: http://127.0.0.1:11434/v1\nlocal_api_key: abc\n---\n' }).settings;
  const legacyRunner = runnerSettings(legacy);
  eq('runners: unset local_runner is the 0.11.0 path', [legacyRunner.type, legacyRunner.legacy, legacyRunner.url, legacyRunner.nicknames.default], [null, true, 'http://127.0.0.1:11434/v1', 'qwen3.5:4b']);
  eq('runners: localConfigured with only local_model', localConfigured(legacy), true);
  eq('runners: localConfigured with neither', localConfigured(loadWith({ globalText: '---\ntimeout_ms: 600000\n---\n' }).settings), false);
  eq('runners: an invalid key_env is dropped', runnerSettings(loadWith({ globalText: '---\nlocal_runner: llama-swap\nllama-swap.key_env: A B\n---\n' }).settings).key_env, null);
  eq('runners: an invalid url is dropped', runnerSettings(loadWith({ globalText: '---\nlocal_runner: openai\nopenai.url: notaurl\n---\n' }).settings).url, null);
  eq('runners: indented lines are not read', parseFrontmatter('---\nllama-swap:\n  fast: x\n---\n').fast, undefined);
  truthy('runners: KNOWN_KEYS has the mod-only keys', KNOWN_KEYS.includes('notify_after_s') && KNOWN_KEYS.includes('history_size') && KNOWN_KEYS.includes('summary_model') && KNOWN_KEYS.includes('local_runner'));

  // The mod keeps its own copies of the lists; they must match.
  const modSource = fs.readFileSync(new URL('../hooks/mod/settings.ts', import.meta.url), 'utf8');
  const { RUNNER_TYPES, RUNNER_KEYS } = await import('./lib/local-runners.js');
  const listIn = (name) => {
    const found = new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(modSource);
    return found ? found[1].split(',').map(item => item.trim().replace(/^'|'$/g, '')).filter(Boolean) : null;
  };
  eq('mod lists: RUNNER_TYPES', listIn('RUNNER_TYPES'), [...RUNNER_TYPES]);
  eq('mod lists: RUNNER_KEYS', listIn('RUNNER_KEYS'), [...RUNNER_KEYS]);
  eq('mod lists: KNOWN_KEYS', [...listIn('KNOWN_KEYS')].sort(), [...KNOWN_KEYS].sort());
  const { DELEGATE_KEYS } = await import('./lib/settings.js');
  eq('mod lists: DELEGATE_KEYS', [...listIn('DELEGATE_KEYS')].sort(), [...DELEGATE_KEYS].sort());
}

// A streamed chat completion: each chunk is one `data:` event.
function sseStream(chunks, { end = true, delayMs = 5 } = {}) {
  return (response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let index = 0;
    const next = () => {
      if (index < chunks.length) {
        response.write(`data: ${JSON.stringify(chunks[index])}\n\n`);
        index++;
        setTimeout(next, delayMs);
      } else if (end) {
        response.write('data: [DONE]\n\n');
        response.end();
      }
    };
    next();
  };
}
const delta = (fields, extra = {}) => ({ model: 'm', choices: [{ index: 0, delta: fields, finish_reason: null }], ...extra });

// A recorded llama-swap answer from tests/fixtures/llama-swap/ (2026-10-20).
const llamaSwapFixture = (name) => JSON.parse(fs.readFileSync(new URL(`../tests/fixtures/llama-swap/${name}`, import.meta.url), 'utf8'));

// ---- v0.12.0: runner detection, llama-swap inventory and nicknames ----
{
  const {
    classifyRunner, swapFacts, proposeSwapNicknames, resolveSwapModel, loadedModels, unloadRunner, probeRunners
  } = await import('./lib/local-runners.js');
  const swapModels = llamaSwapFixture('models.json');
  const unauthorizedBody = llamaSwapFixture('unauthorized.json');
  const llamaServerModels = llamaSwapFixture('llama-server-models.json');
  const ollamaTags = { models: [tagModel('qwen3.5:4b', 3324173934, 'd1', '4.2B', 'Q4_K_M', ['completion', 'vision'])] };

  eq('classify: llama-swap models', classifyRunner({ modelsStatus: 200, modelsJson: swapModels }), 'llama-swap');
  eq('classify: llama-swap 401', classifyRunner({ modelsStatus: 401, modelsJson: unauthorizedBody }), 'llama-swap');
  eq('classify: ollama tags', classifyRunner({ tagsJson: ollamaTags, modelsStatus: 200, modelsJson: { data: [{ id: 'qwen3.5:4b', owned_by: 'library' }] } }), 'ollama');
  eq('classify: llama-server', classifyRunner({ modelsStatus: 200, modelsJson: llamaServerModels }), 'llama-server');
  // Strata's /health shape as the user reported it (2026-10-20); not recorded live.
  eq('classify: strata is openai', classifyRunner({ modelsStatus: 200, modelsJson: { data: [{ id: 'x' }] }, healthJson: { status: 'ok', service: 'strata' } }), 'openai');
  eq('classify: any other OpenAI-compatible', classifyRunner({ modelsStatus: 200, modelsJson: { object: 'list', data: [{ id: 'm', owned_by: 'someone' }] } }), 'openai');
  eq('classify: nothing', classifyRunner({ modelsStatus: 404, modelsJson: null }), null);

  const facts = swapFacts(swapModels);
  const factOf = (id) => facts.find(f => f.id === id);
  eq('swap facts: six listed', facts.map(f => f.id).sort(), ['flash-next', 'qwen3.5-4b', 'qwen3.5-9b', 'qwen3.6-35b-a3b', 'qwen3.8-27b', 'qwen3.8-9b-distill']);
  eq('swap facts: loaded 4b reads images', [factOf('qwen3.5-4b').vision, factOf('qwen3.5-4b').loaded, factOf('qwen3.5-4b').context], [true, true, 32768]);
  eq('swap facts: unloaded 9b vision unknown', [factOf('qwen3.5-9b').vision, factOf('qwen3.5-9b').loaded], [null, false]);
  eq('swap facts: aliases', factOf('flash-next').aliases, ['big', 'big:nothink', 'flash-next:nothink']);
  eq('swap facts: a vision alias means vision even unloaded', swapFacts({ data: [{ id: 'v', meta: { llamaswap: { aliases: ['vision'] } } }] })[0].vision, true);
  eq('swap facts: capabilities without vision is false', swapFacts({ data: [{ id: 't', capabilities: { function_calling: true } }] })[0].vision, false);
  eq('swap facts: an unsafe id is skipped', swapFacts({ data: [{ id: 'ok' }, { id: 'evil\nlocal_runner: openai' }] }).map(f => f.id), ['ok']);

  const table = (proposal) => {
    const out = {};
    for (const one of proposal.rows) out[one.role] = one.proposed;
    return out;
  };
  const proposal = proposeSwapNicknames(facts, NO_NICKNAMES);
  eq('swap proposal: the user\'s table', table(proposal), { default: ['qwen3.6-35b-a3b'], fast: ['qwen3.5-4b'], vision: ['qwen3.5-4b'], vision_best: ['qwen3.5-4b'], big: ['flash-next'] });
  eq('swap proposal: reason names the alias', row(proposal, 'fast').reason, 'llama-swap alias `fast`');
  eq('swap proposal: vision_best reason', row(proposal, 'vision_best').reason, 'the only model known to read images');
  eq('swap proposal: every model listed with its description', proposal.models.length, 6);
  truthy('swap proposal: descriptions carried', proposal.models.every(m => typeof m.description === 'string'));
  const savedProposal = proposeSwapNicknames(facts, { ...NO_NICKNAMES, fast: 'qwen3.5-9b', big: 'gone-model' });
  eq('swap proposal: a kept nickname proposes the saved model', [row(savedProposal, 'fast').proposed, row(savedProposal, 'fast').saved_state], [['qwen3.5-9b'], 'kept']);
  eq('swap proposal: a gone nickname', row(savedProposal, 'big').saved_state, 'gone');
  eq('swap proposal: no alias, nothing proposed', table(proposeSwapNicknames(swapFacts({ data: [{ id: 'a' }, { id: 'b' }] }), NO_NICKNAMES)).default, []);

  eq('swap resolve: saved nickname beats server alias', resolveSwapModel('fast', facts, { ...NO_NICKNAMES, fast: 'qwen3.5-9b' }), { model: 'qwen3.5-9b', resolved_from: 'fast' });
  eq('swap resolve: server alias when no nickname', resolveSwapModel('fast', facts, NO_NICKNAMES), { model: 'qwen3.5-4b', resolved_from: 'server alias fast' });
  eq('swap resolve: vision-best spelling', resolveSwapModel('vision-best', facts, { ...NO_NICKNAMES, vision_best: 'qwen3.5-4b' }), { model: 'qwen3.5-4b', resolved_from: 'vision-best' });
  eq('swap resolve: an id passes', resolveSwapModel('qwen3.5-9b', facts, NO_NICKNAMES), { model: 'qwen3.5-9b' });
  eq('swap resolve: :nothink passes as given', resolveSwapModel('fast:nothink', facts, NO_NICKNAMES), { model: 'fast:nothink' });
  eq('swap resolve: a unique fragment', resolveSwapModel('distill', facts, NO_NICKNAMES), { model: 'qwen3.8-9b-distill', resolved_from: 'distill' });
  eq('swap resolve: no model → saved default', resolveSwapModel(null, facts, { ...NO_NICKNAMES, default: 'qwen3.5-9b' }), { model: 'qwen3.5-9b' });
  eq('swap resolve: no model → server default alias', resolveSwapModel(null, facts, NO_NICKNAMES), { model: 'qwen3.6-35b-a3b', resolved_from: 'server alias default' });
  eq('swap resolve: no model → the only model', resolveSwapModel(null, swapFacts({ data: [{ id: 'solo' }] }), NO_NICKNAMES), { model: 'solo', resolved_from: 'the only model' });
  throwsWith('swap resolve: nothing configured', () => resolveSwapModel(null, swapFacts({ data: [{ id: 'a' }, { id: 'b' }] }), NO_NICKNAMES), /No local model configured/);
  throwsWith('swap resolve: gone nickname', () => resolveSwapModel('big', facts, { ...NO_NICKNAMES, big: 'gone-model' }), /gone-model[\s\S]*\/consult:setlocal/);
  throwsWith('swap resolve: ambiguous fragment', () => resolveSwapModel('qwen3.5', facts, NO_NICKNAMES), /qwen3\.5-4b[\s\S]*qwen3\.5-9b/);
  throwsWith('swap resolve: no match lists models', () => resolveSwapModel('llama', facts, NO_NICKNAMES), /flash-next/);

  // Loaded models and unloading, against fake runners.
  const swap = await fakeServer({
    'GET /running': () => ({ json: llamaSwapFixture('running.json') }),
    'GET /unload': () => ({ text: 'OK' })
  });
  const ollama = await fakeServer({
    'GET /api/ps': () => ({ json: { models: [{ name: 'qwen3.5:4b', model: 'qwen3.5:4b' }] } }),
    'POST /api/generate': () => ({ json: { done: true } })
  });
  try {
    eq('loaded: llama-swap /running', await loadedModels({ type: 'llama-swap', url: swap.url }, KEY_MARKER), ['qwen3.5-4b']);
    eq('loaded: the key went as Bearer', swap.requests[0].headers.authorization, `Bearer ${KEY_MARKER}`);
    eq('loaded: ollama /api/ps', await loadedModels({ type: 'ollama', url: ollama.url }, null), ['qwen3.5:4b']);
    eq('loaded: other runners report nothing', await loadedModels({ type: 'openai', url: ollama.url }, null), []);
    eq('unload: llama-swap', await unloadRunner({ type: 'llama-swap', url: swap.url }, KEY_MARKER), { unloaded: ['qwen3.5-4b'] });
    truthy('unload: llama-swap called /unload', swap.requests.some(r => r.method === 'GET' && r.path === '/unload'));
    eq('unload: ollama', await unloadRunner({ type: 'ollama', url: ollama.url }, null), { unloaded: ['qwen3.5:4b'] });
    const generate = ollama.requests.find(r => r.path === '/api/generate');
    eq('unload: ollama keep_alive 0 by the loaded name', JSON.parse(generate.body), { model: 'qwen3.5:4b', keep_alive: 0 });
    eq('loaded: a key never goes to a non-loopback url (and unknown is null)', (await loadedModels({ type: 'llama-swap', url: 'http://127.example.com:9/v1' }, KEY_MARKER)), null);
  } finally {
    await swap.close();
    await ollama.close();
  }

  // The probe: what answers where, with no key unless it is allowed.
  const swapUnauthorized = await fakeServer({
    'GET /v1/models': (request) => (request.headers.authorization === `Bearer ${KEY_MARKER}` ? { json: swapModels } : { status: 401, json: unauthorizedBody })
  });
  try {
    const found = await probeRunners({ urls: [swapUnauthorized.url], configured: [], timeoutMs: 1500, readKeyFor: async () => ({ key: null, source: null }) });
    eq('probe: llama-swap without a key', [found[0].type, found[0].up, found[0].needs_key], ['llama-swap', true, true]);
    const swapKey = async (name) => (name === 'LLAMA_SWAP_API_KEY' ? { key: KEY_MARKER, source: 'process' } : { key: null, source: null });
    const withKey = await probeRunners({ urls: [swapUnauthorized.url], configured: [], timeoutMs: 1500, trySwapKey: true, swapKeyUrls: [swapUnauthorized.url], readKeyFor: swapKey });
    eq('probe: llama-swap with LLAMA_SWAP_API_KEY', [withKey[0].type, withKey[0].needs_key, withKey[0].key_env, withKey[0].models.length], ['llama-swap', false, 'LLAMA_SWAP_API_KEY', 6]);
    // The guess goes only to the standard probe ports, never to any port that claims to be llama-swap.
    const sentBefore = swapUnauthorized.requests.filter(r => r.headers.authorization === `Bearer ${KEY_MARKER}`).length;
    await probeRunners({ urls: [swapUnauthorized.url], configured: [], timeoutMs: 1500, trySwapKey: true, readKeyFor: swapKey });
    eq('probe: no key guess to a port outside the standard list', swapUnauthorized.requests.filter(r => r.headers.authorization === `Bearer ${KEY_MARKER}`).length, sentBefore);
    const closed = await probeRunners({ urls: ['http://127.0.0.1:1/v1'], configured: [], timeoutMs: 800, readKeyFor: async () => ({ key: null, source: null }) });
    eq('probe: nothing listening', [closed[0].up, closed[0].type], [false, null]);
    truthy('probe: never asks for a completion', swapUnauthorized.requests.every(r => !r.path.includes('completions')));
  } finally {
    await swapUnauthorized.close();
  }
}

// ---- v0.12.0: streaming calls, progress, stall guard, errors ----
{
  const { askLocal } = await import('./lib/local.js');
  const answered = await fakeServer({
    'POST /v1/chat/completions': () => ({ stream: sseStream([
      delta({ role: 'assistant', reasoning_content: 'Let me ' }),
      delta({ reasoning_content: 'think' }),
      delta({ content: 'fo' }),
      delta({ content: 'ur' }),
      { model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { model: 'm', choices: [], usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 } }
    ]) })
  });
  const inlineThink = await fakeServer({
    'POST /v1/chat/completions': () => ({ stream: sseStream([delta({ content: '<think>abc' }), delta({ content: '</think>' }), delta({ content: 'four' })]) })
  });
  const stall = await fakeServer({
    'POST /v1/chat/completions': () => ({ stream: sseStream([delta({ reasoning_content: 'hmm' }), delta({ content: 'par' })], { end: false }) })
  });
  const unauthorized = await fakeServer({
    'POST /v1/chat/completions': () => ({ status: 401, json: { src: 'llama-swap', error: { message: 'unauthorized: invalid or missing API key' } } })
  });
  const noVision = await fakeServer({
    'POST /v1/chat/completions': () => ({ status: 500, json: { error: { code: 500, message: 'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj', type: 'server_error' } } })
  });
  const thinkingChunks = [];
  for (let index = 0; index < 40; index++) thinkingChunks.push(delta({ reasoning_content: 'ponder ' }));
  const thinker = await fakeServer({
    'POST /v1/chat/completions': () => ({ stream: sseStream(thinkingChunks, { end: false, delayMs: 50 }) })
  });
  const pathNamed = await fakeServer({
    'POST /v1/chat/completions': () => ({ stream: sseStream([{ model: 'D:\\models\\x\\x.gguf', choices: [{ index: 0, delta: { content: '4' }, finish_reason: 'stop' }] }]) })
  });
  const elsewhere = await fakeServer({ 'POST /v1/chat/completions': () => ({ json: {} }) });
  const redirecting = await fakeServer({
    'POST /v1/chat/completions': () => ({ status: 307, headers: { Location: `${elsewhere.url}/chat/completions` }, text: '' })
  });
  const pngPath = path.join(os.tmpdir(), `consult-test-${process.pid}.png`);
  fs.writeFileSync(pngPath, pngBytes(1, 1));
  try {
    const plain = await askLocal({ prompt: 'x', model: 'm', base_url: answered.url });
    eq('stream: answer without reasoning', plain.response, 'four');
    eq('stream: reasoning chars counted', plain.reasoning_chars, 12);
    eq('stream: usage and finish', [plain.tokens, plain.finish_reason], [{ prompt: 7, completion: 9, total: 16 }, 'stop']);
    const sent = JSON.parse(answered.requests[0].body);
    eq('stream: asks for a stream with usage', [sent.stream, sent.stream_options], [true, { include_usage: true }]);
    eq('stream: inline think stripped', (await askLocal({ prompt: 'x', model: 'm', base_url: inlineThink.url })).response, 'four');
    eq('stream: the runner is named in the result', (await askLocal({ prompt: 'x', model: 'm', base_url: answered.url, runner_label: 'llama-swap' })).runner, 'llama-swap');

    const stalled = await askLocal({ prompt: 'x', model: 'm', base_url: stall.url, stall_ms: 300 }).catch(error => error.message);
    truthy('stream: stall → INCOMPLETE with the partial answer', stalled.startsWith('INCOMPLETE:') && stalled.includes('par') && !stalled.includes('hmm'));

    const stillThinking = await askLocal({ prompt: 'x', model: 'm', base_url: thinker.url, timeout_ms: 400, stall_ms: 5000 }).catch(error => error.message);
    truthy('stream: out of time while still thinking says so, without the reasoning', stillThinking.startsWith('INCOMPLETE:') && stillThinking.includes('still thinking') && !stillThinking.includes('ponder'));
    eq('stream: the result names the model consult asked for, not the runner\'s file path', (await askLocal({ prompt: 'x', model: 'fast', base_url: pathNamed.url })).model, 'fast');

    const phases = [];
    await askLocal({ prompt: 'x', model: 'm', base_url: answered.url, onProgress: (progress) => phases.push(progress.phase) });
    truthy('stream: progress says waiting, then answering', phases[0] === 'waiting' && phases.includes('answering'));

    // A port that was listening a moment ago and isn't now (port 1 is on fetch's blocked list).
    const gone = await fakeServer({});
    await gone.close();
    const refused = await askLocal({ prompt: 'x', model: 'm', base_url: gone.url, runner_label: 'llama-swap', start_hint: 'Desktop shortcut "llama-swap"' }).catch(error => error.message);
    truthy('error: refused names the runner and how to start it', refused.includes('No local model runner is listening at') && refused.includes('(llama-swap)') && refused.includes('Desktop shortcut "llama-swap"'));

    const noKeyEnv = await askLocal({ prompt: 'x', model: 'm', base_url: unauthorized.url, runner_label: 'llama-swap' }).catch(error => error.message);
    truthy('error: 401 without key_env says how to add it', noKeyEnv.includes('needs its key') && noKeyEnv.includes('llama-swap.key_env'));
    const rejected = await askLocal({ prompt: 'x', model: 'm', base_url: unauthorized.url, api_key: KEY_MARKER, key_env: 'FAKE_KEY', runner_label: 'llama-swap' }).catch(error => error);
    truthy('error: a rejected key is named by its variable, never shown', rejected.message.includes('rejected the key from FAKE_KEY') && !rejected.message.includes(KEY_MARKER));
    eq('error: a rejected key carries the status', rejected.status, 401);
    const missingVariable = await askLocal({ prompt: 'x', model: 'm', base_url: unauthorized.url, key_env: 'FAKE_MISSING', runner_label: 'llama-swap' }).catch(error => error.message);
    truthy('error: key_env set but the variable is missing', missingVariable.includes('FAKE_MISSING is not set'));
    eq('error: nothing was sent without the key', unauthorized.requests.length, 2);

    const redirected = await askLocal({ prompt: 'x', model: 'm', base_url: redirecting.url, api_key: KEY_MARKER }).catch(error => error.message);
    truthy('keyed request refuses redirects', elsewhere.requests.length === 0 && typeof redirected === 'string' && !redirected.includes(KEY_MARKER));

    const imageRefused = await askLocal({ prompt: 'x', model: 'qwen3.5-9b', base_url: noVision.url, images: [pngPath] }).catch(error => error);
    truthy('error: a named model that can\'t read images says so', imageRefused.message.includes("`qwen3.5-9b` can't read images") && imageRefused.code === 'images_refused');
  } finally {
    fs.rmSync(pngPath, { force: true });
    for (const server of [answered, inlineThink, stall, unauthorized, noVision, thinker, pathNamed, elsewhere, redirecting]) await server.close();
  }
}

// ---- v0.12.0: preparing a call, saving runner settings, the double-load guard ----
{
  const { prepareRunnerCall, rewriteRunnerLines, saveRunnerSettings, lineDiff, checkDoubleLoad, swapFacts, resetBackupForTests } = await import('./lib/local-runners.js');
  const facts = swapFacts(llamaSwapFixture('models.json'));
  const base = { timeout_ms: 600000, council_timeout_ms: null, local_timeout_ms: null };
  const swapRunner = (nicknames = {}) => ({ type: 'llama-swap', legacy: false, url: 'http://127.0.0.1:9292/v1', nicknames: { ...NO_NICKNAMES, ...nicknames } });
  const prepare = (fields) => prepareRunnerCall({ settings: base, callTimeoutMs: null, inventory: facts, images: undefined, requested: null, inCouncil: false, ...fields });
  const noImages = prepare({ runner: swapRunner(), requested: 'fast' });
  eq('prepare: llama-swap nickname word → server alias', [noImages.model, noImages.notes.resolved_from], ['qwen3.5-4b', 'server alias fast']);
  eq('prepare: llama-swap floor is 20 minutes', noImages.timeout_ms, 1200000);
  eq('prepare: timeout_s wins over the floor', prepare({ runner: swapRunner(), requested: 'fast', callTimeoutMs: 60000 }).timeout_ms, 60000);
  eq('prepare: local_timeout_ms wins over the floor', prepareRunnerCall({ runner: swapRunner(), requested: 'fast', settings: { ...base, local_timeout_ms: 90000 }, callTimeoutMs: null, inventory: facts }).timeout_ms, 90000);
  const image = ['x.png'];
  const named = prepare({ runner: swapRunner(), requested: 'qwen3.5-9b', images: image });
  eq('images: a named model with unknown vision keeps the call', [named.model, named.notes.vision], ['qwen3.5-9b', 'unknown']);
  const implicit = prepare({ runner: swapRunner({ default: 'qwen3.6-35b-a3b', vision: 'qwen3.5-4b' }), images: image });
  eq('images: an implicit default with unknown vision switches', [implicit.model, implicit.notes.switched_for_images], ['qwen3.5-4b', 'qwen3.6-35b-a3b → qwen3.5-4b']);
  // The facts a llama-swap config writes under a model's `metadata:`.
  const described = swapFacts({ data: [
    { id: 'moe', meta: { llamaswap: { arch: 'MoE', engine: 'Strata', decode_tps: 7, vision: false } } },
    { id: 'range', meta: { llamaswap: { arch: 'dense', engine: 'llama.cpp', decode_tps: '5-6', vision: true } } },
    { id: 'odd', meta: { llamaswap: { arch: { nested: 1 }, engine: 'x'.repeat(80), decode_tps: -3 } } },
    { id: 'bare' }
  ] });
  const byId = {};
  for (const fact of described) byId[fact.id] = fact;
  eq('swapFacts: metadata arch, engine, speed and vision', [byId.moe.arch, byId.moe.engine, byId.moe.decode_tps, byId.moe.vision], ['MoE', 'Strata', 7, false]);
  eq('swapFacts: a speed range stays as written', [byId.range.decode_tps, byId.range.vision], ['5-6', true]);
  eq('swapFacts: odd metadata is dropped', [byId.odd.arch, byId.odd.engine, byId.odd.decode_tps], [null, null, null]);
  eq('swapFacts: no metadata, no facts', [byId.bare.arch, byId.bare.engine, byId.bare.decode_tps], [null, null, null]);
  const knownNo = swapFacts({ data: [{ id: 'txt', capabilities: { function_calling: true } }, { id: 'eye', meta: { llamaswap: { aliases: ['vision'] } } }] });
  eq('images: a named model known not to read images switches', prepareRunnerCall({ runner: swapRunner(), requested: 'txt', images: image, settings: base, inventory: knownNo }).model, 'eye');
  throwsWith('images: no vision model to switch to', () => prepareRunnerCall({ runner: swapRunner(), requested: 'txt', images: image, settings: base, inventory: swapFacts({ data: [{ id: 'txt', capabilities: {} }] }) }), /can't read images/);
  eq('images: a saved vision_best nickname is kept', prepare({ runner: swapRunner({ vision_best: 'qwen3.8-27b' }), requested: 'vision-best', images: image }).model, 'qwen3.8-27b');
  const passThrough = prepareRunnerCall({ runner: swapRunner({ default: 'qwen3.6-35b-a3b' }), requested: null, settings: base, inventory: null });
  eq('prepare: no inventory passes the saved default through', passThrough.model, 'qwen3.6-35b-a3b');
  const other = prepareRunnerCall({ runner: { type: 'llama-server', url: 'http://127.0.0.1:8080/v1', nicknames: { ...NO_NICKNAMES } }, requested: null, settings: base, inventory: swapFacts({ data: [{ id: 'solo-model' }] }) });
  eq('prepare: other runners use the only listed model', [other.model, other.timeout_ms], ['solo-model', 600000]);
  const ollamaRunner = { type: 'ollama', url: 'http://127.0.0.1:11434/v1', nicknames: { ...NO_NICKNAMES, fast: 'qwen3.5:4b', default: 'qwen3.6-35b-a3b:ud-iq3_xxs' } };
  const ollamaFacts = modelFacts(LOCAL_TAGS, 8151);
  eq('prepare: ollama uses its own nicknames', prepareRunnerCall({ runner: ollamaRunner, requested: 'fast', settings: base, inventory: ollamaFacts }).model, 'qwen3.5:4b');
  eq('prepare: ollama non-fitting model gets the same floor', prepareRunnerCall({ runner: ollamaRunner, requested: null, settings: base, inventory: ollamaFacts }).timeout_ms, 1200000);

  // The save step: owned lines only, everything else byte for byte.
  const original = '﻿---\r\n# Global consult settings\r\ntimeout_ms: 600000 # long reviews\r\nlocal_model: qwen3.8-9b-distill:q4_k_m\r\nlocal_model_fast: qwen3.5:4b\r\n---\r\nbody\r\n';
  const swapped = rewriteRunnerLines(original, { local_runner: 'llama-swap', 'llama-swap.url': 'http://127.0.0.1:9292/v1', 'llama-swap.fast': 'qwen3.5-4b' });
  eq('save: new lines go before the closing fence, BOM and CRLF kept', swapped, '﻿---\r\n# Global consult settings\r\ntimeout_ms: 600000 # long reviews\r\nlocal_model: qwen3.8-9b-distill:q4_k_m\r\nlocal_model_fast: qwen3.5:4b\r\nlocal_runner: llama-swap\r\nllama-swap.url: http://127.0.0.1:9292/v1\r\nllama-swap.fast: qwen3.5-4b\r\n---\r\nbody\r\n');
  const ollamaSaved = rewriteRunnerLines(original, { local_runner: 'ollama', 'ollama.fast': 'qwen3.5:4b' });
  eq('save: an ollama line replaces its 0.11.0 line in place when a runner is chosen', ollamaSaved, '﻿---\r\n# Global consult settings\r\ntimeout_ms: 600000 # long reviews\r\nlocal_model: qwen3.8-9b-distill:q4_k_m\r\nollama.fast: qwen3.5:4b\r\nlocal_runner: ollama\r\n---\r\nbody\r\n');
  const noRunner = rewriteRunnerLines(original, { 'ollama.fast': 'qwen3.5:4b' });
  truthy('save: with no runner chosen the 0.11.0 lines stay', noRunner.includes('local_model_fast: qwen3.5:4b') && noRunner.includes('ollama.fast: qwen3.5:4b'));
  eq('save: null removes a line', rewriteRunnerLines('---\nllama-swap.big: flash-next\nx_y: 1\n---\n', { 'llama-swap.big': null }), '---\nx_y: 1\n---\n');
  throws('save: an unsafe value is refused', () => rewriteRunnerLines('---\n---\n', { 'llama-swap.fast': 'a\nlocal_runner: openai' }));
  throws('save: a non-runner key is refused', () => rewriteRunnerLines('---\n---\n', { codex_sandbox: 'danger-full-access' }));
  throws('save: an invalid key_env is refused', () => rewriteRunnerLines('---\n---\n', { 'llama-swap.key_env': 'A B' }));
  throwsWith('save: setup never saves an address off this machine', () => rewriteRunnerLines('---\n---\n', { 'openai.url': 'https://example.com/v1' }), /on this machine[\s\S]*by hand/);
  throws('save: nor a look-alike of one', () => rewriteRunnerLines('---\n---\n', { 'llama-swap.url': 'http://127.example.com:9292/v1' }));
  eq('diff: removed and added lines with numbers', lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n'), ['- 2: b', '+ 2: B', '+ 4: d']);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-save-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const settingsPath = path.join(home, '.claude', 'consult.local.md');
  fs.writeFileSync(settingsPath, '---\ntimeout_ms: 600000\n---\n');
  resetBackupForTests();
  try {
    const preview = saveRunnerSettings({ changes: { local_runner: 'llama-swap' }, home, preview: true });
    eq('save: preview shows the diff and writes nothing', [preview.diff, fs.readFileSync(settingsPath, 'utf8'), fs.existsSync(settingsPath + '.bak')], [['+ 3: local_runner: llama-swap'], '---\ntimeout_ms: 600000\n---\n', false]);
    const written = saveRunnerSettings({ changes: { local_runner: 'llama-swap' }, home });
    eq('save: writes the global file', [written.path, fs.readFileSync(settingsPath, 'utf8')], [settingsPath, '---\ntimeout_ms: 600000\nlocal_runner: llama-swap\n---\n']);
    eq('save: .bak holds the file before the first write', fs.readFileSync(settingsPath + '.bak', 'utf8'), '---\ntimeout_ms: 600000\n---\n');
    saveRunnerSettings({ changes: { 'llama-swap.fast': 'qwen3.5-4b' }, home });
    eq('save: .bak is written once per process', fs.readFileSync(settingsPath + '.bak', 'utf8'), '---\ntimeout_ms: 600000\n---\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  // The double-load guard: only when `runner` names another runner.
  const busy = await fakeServer({ 'GET /running': () => ({ json: { running: [{ model: 'qwen3.6-35b-a3b', state: 'ready' }] } }) });
  try {
    const inUse = { type: 'llama-swap', url: busy.url };
    let guarded = null;
    try { await checkDoubleLoad({ requested: 'ollama', inUse, key: KEY_MARKER }); } catch (error) { guarded = error.message; }
    truthy('guard: another runner while a model is loaded is refused', typeof guarded === 'string' && guarded.includes('qwen3.6-35b-a3b') && guarded.includes('local_unload'));
    const before = busy.requests.length;
    await checkDoubleLoad({ requested: 'llama-swap', inUse, key: KEY_MARKER });
    await checkDoubleLoad({ requested: null, inUse, key: KEY_MARKER });
    eq('guard: the runner in use, or none named, checks nothing', busy.requests.length, before);
  } finally {
    await busy.close();
  }

  // llama-swap's status body, and what other runners hold.
  const { swapStatus, otherRunners } = await import('./lib/local-runners.js');
  const swapModelsJson = llamaSwapFixture('models.json');
  const gateway = await fakeServer({
    'GET /v1/models': (request) => (request.headers.authorization === `Bearer ${KEY_MARKER}` ? { json: swapModelsJson } : { status: 401, json: { src: 'llama-swap', error: { message: 'unauthorized' } } }),
    'GET /running': () => ({ json: { running: [{ model: 'qwen3.5-4b', state: 'ready' }] } })
  });
  const otherOllama = await fakeServer({
    'GET /api/tags': () => ({ json: LOCAL_TAGS }),
    'GET /api/ps': () => ({ json: { models: [{ name: 'qwen3.5:4b' }] } }),
    'GET /v1/models': () => ({ json: { object: 'list', data: [{ id: 'qwen3.5:4b', owned_by: 'library' }] } })
  });
  try {
    const runner = { type: 'llama-swap', url: gateway.url, start: 'Desktop shortcut "llama-swap"', key_env: 'FAKE_KEY', nicknames: { ...NO_NICKNAMES, fast: 'qwen3.5-4b', big: 'gone-model' } };
    const up = await swapStatus(runner, KEY_MARKER);
    eq('swap status: reachable, six models, the loaded one', [up.reachable, up.models.length, up.loaded], [true, 6, ['qwen3.5-4b']]);
    eq('swap status: nicknames say whether they resolve', up.nicknames, { fast: { model: 'qwen3.5-4b', resolves: true }, big: { model: 'gone-model', resolves: false } });
    const keyless = await swapStatus({ ...runner, key_env: null }, null);
    truthy('swap status: no key says how to add one', keyless.reachable === true && keyless.reason === 'needs_key' && keyless.details.includes('llama-swap.key_env'));
    const rejected = await swapStatus(runner, 'wrong');
    truthy('swap status: a rejected key names the variable', rejected.reason === 'key_rejected' && rejected.details.includes('FAKE_KEY') && !rejected.details.includes('wrong'));
    const goneServer = await fakeServer({});
    await goneServer.close();
    const down = await swapStatus({ ...runner, url: goneServer.url }, KEY_MARKER);
    truthy('swap status: not running gives the start hint', down.reachable === false && down.details.includes('Desktop shortcut "llama-swap"'));

    const others = await otherRunners({
      configured: [{ type: 'llama-swap', url: gateway.url, key_env: 'FAKE_KEY' }, { type: 'ollama', url: otherOllama.url, key_env: null }],
      exceptUrl: gateway.url,
      urls: [],
      readKeyFor: async () => ({ key: KEY_MARKER, source: 'process' })
    });
    eq('other runners: what each other runner holds', others, [{ type: 'ollama', url: otherOllama.url, up: true, loaded: ['qwen3.5:4b'] }]);
    // A llama-swap nobody configured gets no key: what it holds is unknown (null).
    const keyedBefore = gateway.requests.filter(r => r.headers.authorization === `Bearer ${KEY_MARKER}`).length;
    const unconfigured = await otherRunners({ configured: [], exceptUrl: otherOllama.url, urls: [gateway.url], readKeyFor: async () => ({ key: KEY_MARKER, source: 'process' }) });
    eq('other runners: an unconfigured llama-swap gets no key', gateway.requests.filter(r => r.headers.authorization === `Bearer ${KEY_MARKER}`).length, keyedBefore);
    eq('other runners: and what it holds is unknown', unconfigured, [{ type: 'llama-swap', url: gateway.url, up: true, loaded: null }]);
  } finally {
    await gateway.close();
    await otherOllama.close();
  }
}

// ---- v0.12.0 final review fixes ----
{
  const lr = await import('./lib/local-runners.js');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');

  // 1: the SessionStart hook must run, not die on a syntax error.
  const hookHome = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-hook-'));
  try {
    const hook = fileURLToPath(new URL('../hooks/scripts/auth-check.js', import.meta.url));
    const ran = spawnSync(process.execPath, [hook], { input: '{}', cwd: hookHome, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: hookHome, USERPROFILE: hookHome } });
    truthy('review 1: auth-check.js runs without a syntax error', ran.status === 0 && !/SyntaxError/.test(ran.stderr));
    // The guard resolves real paths: a hook path spelled with another drive-letter case still runs.
    if (process.platform === 'win32') {
      fs.mkdirSync(path.join(hookHome, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(hookHome, '.claude', 'consult.local.md'), '---\nnot_a_setting: 1\n---\n');
      const flipped = hook[0] === hook[0].toLowerCase() ? hook[0].toUpperCase() + hook.slice(1) : hook[0].toLowerCase() + hook.slice(1);
      const ranFlipped = spawnSync(process.execPath, [flipped], { input: '{}', cwd: hookHome, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: hookHome, USERPROFILE: hookHome } });
      truthy('review 1: auth-check.js runs through a path with another drive-letter case', ranFlipped.status === 0 && /\[consult\] settings:/.test(ranFlipped.stderr));
    } else {
      truthy('review 1: auth-check.js runs through a path with another drive-letter case', true);
    }
    const health = fileURLToPath(new URL('../hooks/scripts/health.js', import.meta.url));
    const checked = spawnSync(process.execPath, [health, hookHome], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: hookHome, USERPROFILE: hookHome } });
    truthy('review 1: health.js runs too', checked.status === 0 && !/SyntaxError/.test(checked.stderr));
  } finally {
    fs.rmSync(hookHome, { recursive: true, force: true });
  }

  // The hook reports a CLI found only inside the project as such, not as "not installed".
  const { missingCliWarning } = await import('../hooks/scripts/auth-check.js');
  truthy('auth-check: a project-only hit is reported as such',
    missingCliWarning('codex', { found: false, refused: 'C:\\proj\\codex.cmd' }, 'FALLBACK').includes('only inside the project folder (C:\\proj\\codex.cmd)'));
  eq('auth-check: a CLI that is simply missing keeps the install wording', missingCliWarning('agy', { found: false, refused: null }, 'FALLBACK'), 'FALLBACK');
  if (process.platform === 'win32') {
    const projectFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-hookproj-'));
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-hookhome-'));
    try {
      fs.writeFileSync(path.join(projectFolder, 'codex.cmd'), '@echo off');
      const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      const hook = fileURLToPath(new URL('../hooks/scripts/auth-check.js', import.meta.url));
      const ran = spawnSync(process.execPath, [hook], {
        input: '{}', cwd: projectFolder, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, PATH: `${projectFolder};${system32}`, Path: undefined, HOME: emptyHome, USERPROFILE: emptyHome, LOCALAPPDATA: emptyHome, APPDATA: emptyHome }
      });
      truthy('auth-check: at session start a codex.cmd found only in the project is named as such', /codex only inside the project folder|Found codex only inside the project folder/.test(ran.stderr) && !/codex CLI not found/.test(ran.stderr));
    } finally {
      fs.rmSync(projectFolder, { recursive: true, force: true });
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  } else {
    console.log('PASS-SKIP auth-check: project-only codex.cmd at session start (Windows only)');
  }

  // L-b: a project file can name a runner off this machine; the session-start check never contacts it.
  const { checkLocal } = await import('../hooks/scripts/auth-check.js');
  const realFetch = globalThis.fetch;
  const fetchedUrls = [];
  globalThis.fetch = async (url) => { fetchedUrls.push(String(url)); throw new Error('no network in this test'); };
  try {
    const offMachine = await checkLocal({ local_model: 'm', local_base_url: 'http://203.0.113.5:11434/v1' }, 1000);
    eq('auth-check: a runner off this machine is never contacted at session start', [offMachine, fetchedUrls], [null, []]);
  } finally {
    globalThis.fetch = realFetch;
  }

  // 2: addresses compare normalised; an unknown loaded state never crashes setup.
  eq('review 2: same runner, different spelling', [lr.sameUrl('http://localhost:9292/v1/', 'http://127.0.0.1:9292/v1'), lr.sameUrl('http://127.0.0.1:9292/v1', 'http://127.0.0.1:11434/v1')], [true, false]);
  eq('review 2: runners holding models skips unknown ones', lr.runnersHolding([{ type: 'llama-swap', loaded: null }, { type: 'ollama', loaded: [] }, { type: 'ollama', loaded: ['m'] }]), [{ type: 'ollama', loaded: ['m'] }]);
  const spelled = await fakeServer({ 'GET /running': () => ({ json: { running: [{ model: 'qwen3.5-4b', state: 'ready' }] } }), 'GET /v1/models': () => ({ json: { data: [{ id: 'qwen3.5-4b', owned_by: 'llama-swap' }] } }) });
  try {
    const others = await lr.otherRunners({ configured: [{ type: 'llama-swap', url: spelled.url.replace('127.0.0.1', 'localhost') + '/', key_env: 'FAKE_KEY' }], exceptUrl: spelled.url.replace('127.0.0.1', 'localhost') + '/', urls: [spelled.url], readKeyFor: async () => ({ key: KEY_MARKER, source: 'process' }) });
    eq('review 2: the runner in use, spelled differently, is not an "other" runner', others, []);
  } finally {
    await spelled.close();
  }

  // 3: the double-load guard fails closed when it can't tell.
  const locked = await fakeServer({ 'GET /running': () => ({ status: 401, json: { src: 'llama-swap' } }) });
  try {
    let refused = null;
    try { await lr.checkDoubleLoad({ requested: 'ollama', inUse: { type: 'llama-swap', url: locked.url }, key: null }); } catch (error) { refused = error.message; }
    truthy('review 3: unknown loaded state is refused, not taken as empty', typeof refused === 'string' && /can't tell/i.test(refused));
    eq('review 3: loadedModels says unknown as null', await lr.loadedModels({ type: 'llama-swap', url: locked.url }, null), null);
  } finally {
    await locked.close();
  }

  // 4: a duplicate key is warned about, and a save takes effect.
  eq('review 4: duplicate key warned', frontmatterWarnings('---\nlocal_runner: llama-swap\nllama-swap.default: old\nllama-swap.default: old2\n---\n'), ['line 4: `llama-swap.default` is set again (line 3); only the last one counts']);
  const deduped = lr.rewriteRunnerLines('---\nllama-swap.default: old\nx_y: 1\nllama-swap.default: old2\n---\n', { 'llama-swap.default': 'new' });
  eq('review 4: the save replaces every copy', deduped, '---\nllama-swap.default: new\nx_y: 1\n---\n');
  eq('review 4: and the reader reads it', parseFrontmatter(deduped)['llama-swap.default'], 'new');

  // 5: a llama-swap whose list can't be read still lets askLocal say what's wrong.
  const unread = lr.prepareRunnerCall({ runner: { type: 'llama-swap', url: 'http://127.0.0.1:9292/v1', nicknames: { ...NO_NICKNAMES } }, requested: null, settings: { timeout_ms: 600000 }, inventory: null });
  eq('review 5: no list, no saved default → the server\'s default alias', [unread.model, unread.notes.resolved_from], ['default', 'server alias default (unchecked)']);

  // 6: nicknames work on LM Studio, with its facts or with none.
  const studio = { type: 'lmstudio', url: 'http://127.0.0.1:1234/v1', nicknames: { ...NO_NICKNAMES, fast: 'qwen2.5-7b-instruct' } };
  const studioFacts = lr.lmstudioFacts({ models: [{ type: 'llm', key: 'qwen2.5-7b-instruct', size_bytes: 1 }] }, null);
  eq('review 6: a saved nickname on lmstudio', lr.prepareRunnerCall({ runner: studio, requested: 'fast', settings: { timeout_ms: 600000 }, inventory: studioFacts }).model, 'qwen2.5-7b-instruct');
  eq('review 6: a name passes through', lr.prepareRunnerCall({ runner: studio, requested: 'other-model', settings: { timeout_ms: 600000 }, inventory: null }).model, 'other-model');

  // 7: a missing key variable is named as missing, not "add key_env".
  const gate = await fakeServer({ 'GET /v1/models': () => ({ status: 401, json: { src: 'llama-swap' } }) });
  try {
    const missing = await lr.swapStatus({ type: 'llama-swap', url: gate.url, key_env: 'FAKE_MISSING', nicknames: {} }, null);
    truthy('review 7: status says the variable is not set', missing.reason === 'key_missing' && missing.details.includes('FAKE_MISSING is not set'));
  } finally {
    await gate.close();
  }

  // 14: unload reports a refusal instead of success.
  const stubborn = await fakeServer({ 'GET /running': () => ({ json: { running: [{ model: 'm', state: 'ready' }] } }), 'GET /unload': () => ({ status: 500, text: 'no' }) });
  try {
    let failure = null;
    try { await lr.unloadRunner({ type: 'llama-swap', url: stubborn.url }, KEY_MARKER); } catch (error) { failure = error.message; }
    truthy('review 14: a failed unload is an error', typeof failure === 'string' && failure.includes('500'));
  } finally {
    await stubborn.close();
  }

  // 15: a key variable named in a setup call is read only for a runner that asked for a key on a standard or configured address.
  const probe = [{ url: 'http://127.0.0.1:9292/v1', type: 'llama-swap', up: true, needs_key: true }];
  eq('review 15: standard port that asked for a key', lr.mayReadSuppliedKey({ url: 'http://127.0.0.1:9292/v1', probe, configured: [] }), true);
  eq('review 15: an address nobody probed or configured', lr.mayReadSuppliedKey({ url: 'http://127.0.0.1:5555/v1', probe, configured: [] }), false);
  eq('review 15: a runner that did not ask for a key', lr.mayReadSuppliedKey({ url: 'http://127.0.0.1:9292/v1', probe: [{ ...probe[0], needs_key: false }], configured: [] }), false);
}

// ---- v0.13.0: lib/local-setup.js, local_setup's body shared with the pane ----
// Settings read with `home` as the home folder and an empty project.
function settingsIn(home) {
  const origCwd = process.cwd();
  const origEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-proj-'));
  try {
    process.chdir(project);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return loadSettings();
  } finally {
    process.chdir(origCwd);
    for (const [k, v] of Object.entries(origEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(project, { recursive: true, force: true });
  }
}
{
  const { setupLocal } = await import('./lib/local-setup.js');
  const { resetBackupForTests } = await import('./lib/local-runners.js');
  const swap = await fakeServer({
    'GET /v1/models': () => ({ json: llamaSwapFixture('models.json') }),
    'GET /running': () => ({ json: { running: [] } })
  });
  // A fresh home per case: loadSettings caches by path and modification time,
  // and a file rewritten within the same millisecond would read as the old one.
  const homes = [];
  const homeWith = (text) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-setup-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'consult.local.md'), text);
    homes.push(home);
    return home;
  };
  const setupIn = (home, args) => setupLocal(args, settingsIn(home), { home, reloadSettings: () => settingsIn(home), probeUrls: [] });
  resetBackupForTests();
  try {
    const none = await setupIn(homeWith('---\ntimeout_ms: 600000\n---\n'), {});
    eq('setupLocal: no runner in use', [none.in_use, none.proposal, none.note.startsWith('No runner is in use')], [null, null, true]);

    const fileText = `---\ntimeout_ms: 600000\nllama-swap.url: ${swap.url}\n---\n`;
    const swapHome = homeWith(fileText);
    const preview = await setupIn(swapHome, { runner: 'llama-swap', preview: true, use: true, save: { fast: 'fast' } });
    const diffText = (preview.preview?.diff ?? []).join('\n');
    truthy('setupLocal: preview shows the nickname by id', /llama-swap\.fast: qwen3\.5-4b/.test(diffText));
    truthy('setupLocal: preview shows local_runner', /local_runner: llama-swap/.test(diffText));
    eq('setupLocal: preview writes nothing', fs.readFileSync(path.join(swapHome, '.claude', 'consult.local.md'), 'utf8'), fileText);

    let refused = null;
    try { await setupIn(swapHome, { url: 'http://10.0.0.5:9292/v1' }); } catch (error) { refused = error.message; }
    truthy('setupLocal: an address off this machine is refused', typeof refused === 'string' && refused.includes('Setup only uses addresses on this machine'));

    // Review 7: a key pasted where its variable's name belongs is never written.
    let badName = null;
    try { await setupIn(swapHome, { runner: 'llama-swap', key_env: 'sk-abc.def 123', preview: true }); } catch (error) { badName = error.message; }
    truthy('setupLocal: a key_env that is not a variable name is refused', typeof badName === 'string' && badName.includes('not a variable name'));
    truthy('setupLocal: the refusal does not repeat what was typed', typeof badName === 'string' && !badName.includes('sk-abc'));

    // C3: a saved key goes only to the address it was saved for. A new address
    // gets it back only when the call names the variable again.
    process.env.CONSULT_C3_KEY = KEY_MARKER;
    const addressB = await fakeServer({
      'GET /v1/models': () => ({ json: llamaSwapFixture('models.json') }),
      'GET /running': () => ({ json: { running: [] } })
    });
    try {
      const keyedHome = homeWith(`---\nllama-swap.url: ${swap.url}\nllama-swap.key_env: CONSULT_C3_KEY\n---\n`);
      const moved = await setupIn(keyedHome, { runner: 'llama-swap', url: addressB.url, preview: true });
      const keyedWithoutName = addressB.requests.filter(request => request.headers.authorization !== undefined).length;
      truthy('local_setup: moving to a new url drops the saved key_env from the write', /^- \d+: llama-swap\.key_env: CONSULT_C3_KEY/m.test((moved.preview?.diff ?? []).join('\n')));
      eq('local_setup: a new url gets no key unless key_env is given again', [addressB.requests.length > 0, keyedWithoutName], [true, 0]);
      await setupIn(keyedHome, { runner: 'llama-swap', url: addressB.url, key_env: 'CONSULT_C3_KEY', preview: true });
      const keyedWithName = addressB.requests.filter(request => request.headers.authorization === `Bearer ${KEY_MARKER}`).length;
      truthy('local_setup: a new url gets the key when key_env is given again', keyedWithName > 0);
    } finally {
      delete process.env.CONSULT_C3_KEY;
      await addressB.close();
    }

    // A key variable discovered on a standard port stays with that port.
    process.env.LLAMA_SWAP_API_KEY = KEY_MARKER;
    const standardPort = await fakeServer({
      'GET /v1/models': (request) => (request.headers.authorization === `Bearer ${KEY_MARKER}` ? { json: llamaSwapFixture('models.json') } : { status: 401, json: { src: 'llama-swap', error: { message: 'unauthorized' } } }),
      'GET /running': () => ({ json: { running: [] } })
    });
    const otherPort = await fakeServer({
      'GET /v1/models': () => ({ json: llamaSwapFixture('models.json') }),
      'GET /running': () => ({ json: { running: [] } })
    });
    try {
      const discoveredHome = homeWith('---\ntimeout_ms: 600000\n---\n');
      const discoveredShown = await setupLocal({ runner: 'llama-swap', url: otherPort.url, preview: true }, settingsIn(discoveredHome), { home: discoveredHome, reloadSettings: () => settingsIn(discoveredHome), probeUrls: [standardPort.url] });
      const keyedOther = otherPort.requests.filter(request => request.headers.authorization !== undefined).length;
      eq('local_setup: a key variable found on a standard port is not sent to a new url', [otherPort.requests.length > 0, keyedOther, /key_env/.test((discoveredShown.preview?.diff ?? []).join('\n'))], [true, 0, false]);
    } finally {
      delete process.env.LLAMA_SWAP_API_KEY;
      await standardPort.close();
      await otherPort.close();
    }

    // Review 5: a runner that passes names through gets the five rows, with what is saved.
    const passthrough = await fakeServer({ 'GET /v1/models': () => ({ json: { data: [{ id: 'm-one' }, { id: 'm-two' }] } }) });
    try {
      const openaiHome = homeWith(`---\nlocal_runner: openai\nopenai.url: ${passthrough.url}\nopenai.default: m-two\n---\n`);
      const shown = await setupIn(openaiHome, { runner: 'openai' });
      const rows = shown.proposal?.rows ?? [];
      eq('setupLocal: a pass-through runner has the five rows', rows.map(one => one.role), ['default', 'fast', 'vision', 'vision_best', 'big']);
      eq('setupLocal: its saved default is kept', [rows[0]?.saved, rows[0]?.saved_state, rows[1]?.saved, rows[1]?.saved_state], ['m-two', 'kept', null, 'none']);
      eq('setupLocal: and its models are listed', shown.proposal?.models.map(one => one.id), ['m-one', 'm-two']);
    } finally {
      await passthrough.close();
    }

    // A runner that isn't running still answers with what is saved for it,
    // so the pane can show its nicknames and how it is started.
    const downHome = homeWith('---\nlocal_runner: llama-swap\nllama-swap.url: http://127.0.0.1:9/v1\nllama-swap.default: qwen3.6-35b-a3b\nllama-swap.start: Desktop shortcut "llama-swap"\n---\n');
    const down = await setupIn(downHome, {});
    eq('setupLocal: a stopped runner is unreachable, with no proposal', [down.reachable, down.proposal], [false, null]);
    eq('setupLocal: its saved nicknames come back', down.saved_nicknames, { default: 'qwen3.6-35b-a3b', fast: null, vision: null, vision_best: null, big: null });
    eq('setupLocal: and its start note', down.start, 'Desktop shortcut "llama-swap"');
  } finally {
    await swap.close();
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  }
}

// Ollama's proposal lists its models as llama-swap's does, for the pane's pickers.
{
  const { ollamaModels } = await import('./lib/local-setup.js');
  const fact = { name: 'qwen3.5:4b', aliases: [], params: '4.7B', size_gb: 3.4, fits_gpu: true, vision: true };
  eq('ollamaModels: id, name, description and vision', ollamaModels([fact]), [{ id: 'qwen3.5:4b', name: 'qwen3.5:4b', description: '4.7B, 3.4 GB, fits the GPU, reads images', vision: true, arch: null, engine: 'Ollama', decode_tps: null }]);
}

// hooks/scripts/setlocal.js, the Local models tab's door to setupLocal.
{
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../hooks/scripts/setlocal.js', import.meta.url));
  const SECRET = 'sk-test-secret-123';
  const swap = await fakeServer({
    'GET /v1/models': (request) => request.headers.authorization === `Bearer ${SECRET}`
      ? { json: llamaSwapFixture('models.json') }
      : { status: 401, json: { src: 'llama-swap', error: 'unauthorized' } },
    'GET /running': () => ({ json: { running: [] } })
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-setlocal-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-setlocal-proj-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const settingsPath = path.join(home, '.claude', 'consult.local.md');
  // The child gets its own home and the fake runner's key; never the person's
  // LLAMA_SWAP_API_KEY, so the standard-port probe guesses no key.
  const env = { ...process.env, HOME: home, USERPROFILE: home, CONSULT_NO_USER_ENV: '1', FAKE_SWAP_KEY: SECRET };
  delete env.LLAMA_SWAP_API_KEY;
  const printed = [];
  const runScript = (args) => new Promise(resolve => {
    execFile(process.execPath, [script, project, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
      printed.push(stdout, stderr);
      let json = null;
      try { json = JSON.parse(stdout); } catch (_) { json = { unparsed: stdout, stderr }; }
      resolve({ code: error ? error.code : 0, json });
    });
  });
  try {
    fs.writeFileSync(settingsPath, '---\ntimeout_ms: 600000\n---\n');
    const shown = await runScript(['show']);
    eq('setlocal.js: show with no runner set', [shown.code, shown.json.in_use, shown.json.proposal], [0, null, null]);

    const fileText = `---\ntimeout_ms: 600000\nllama-swap.url: ${swap.url}\nllama-swap.key_env: FAKE_SWAP_KEY\n---\n`;
    fs.writeFileSync(settingsPath, fileText);
    const change = JSON.stringify({ runner: 'llama-swap', save: { fast: 'fast' }, use: true });
    const preview = await runScript(['preview', change]);
    truthy('setlocal.js: preview shows the diff', (preview.json.preview?.diff ?? []).join('\n').includes('llama-swap.fast: qwen3.5-4b'));
    eq('setlocal.js: preview writes nothing', fs.readFileSync(settingsPath, 'utf8'), fileText);
    // process.exit() while fetch's connections close trips a libuv assertion on
    // Windows (the pane read it as "the setup script failed"): every run that
    // talked to a runner exits 0.
    const exitCodes = [preview.code];
    for (let run = 0; run < 5; run++) exitCodes.push((await runScript(['preview', change])).code);
    eq('setlocal.js: runs that reach a runner exit 0', exitCodes, [0, 0, 0, 0, 0, 0]);

    const saved = await runScript(['save', change]);
    eq('setlocal.js: save names the file it wrote', saved.json.saved?.path, settingsPath);
    truthy('setlocal.js: save wrote the nickname', fs.readFileSync(settingsPath, 'utf8').includes('llama-swap.fast: qwen3.5-4b'));

    // Review 2: each pane save is a new process; after the first, the pane asks
    // to keep the .bak, so it still holds the file from before the first save.
    const beforeFirst = fs.readFileSync(settingsPath + '.bak', 'utf8');
    await runScript(['save', JSON.stringify({ runner: 'llama-swap', save: { big: 'big' }, keep_backup: true })]);
    eq('setlocal.js: keep_backup leaves the first .bak alone', fs.readFileSync(settingsPath + '.bak', 'utf8'), beforeFirst);
    truthy('setlocal.js: and still saves', fs.readFileSync(settingsPath, 'utf8').includes('llama-swap.big: flash-next'));

    const badJson = await runScript(['preview', 'not json']);
    eq('setlocal.js: bad JSON is an error object, exit 0', [badJson.code, typeof badJson.json.error], [0, 'string']);
    const unknown = await runScript(['explode']);
    eq('setlocal.js: an unknown command is an error object', typeof unknown.json.error, 'string');
    const refused = await runScript(['preview', JSON.stringify({ runner: 'llama-swap', url: 'http://10.0.0.5:9292/v1' })]);
    truthy('setlocal.js: a refused setup is an error object', String(refused.json.error).includes('Setup only uses addresses on this machine'));

    truthy('setlocal.js: never prints the key', !printed.join('\n').includes(SECRET));
  } finally {
    await swap.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

// ---- v0.13.1: model facts without writing them: measured speed, Ollama's MoE or dense ----
{
  const { askLocal, decodeRate } = await import('./lib/local.js');
  eq('decodeRate: tokens after the first, over the time from first to last', decodeRate({ tokens: 101, firstAt: 1000, lastAt: 3000 }), 50);
  eq('decodeRate: too few tokens to judge', decodeRate({ tokens: 5, firstAt: 1000, lastAt: 3000 }), null);
  eq('decodeRate: too short a span to judge', decodeRate({ tokens: 50, firstAt: 1000, lastAt: 1100 }), null);
  eq('decodeRate: no timing', decodeRate({ tokens: 50, firstAt: null, lastAt: null }), null);

  const chunks = [];
  for (let index = 0; index < 20; index++) chunks.push(delta({ content: 'w ' }));
  chunks.push({ model: 'm', choices: [], usage: { prompt_tokens: 3, completion_tokens: 20, total_tokens: 23 } });
  const steady = await fakeServer({ 'POST /v1/chat/completions': () => ({ stream: sseStream(chunks, { delayMs: 20 }) }) });
  const quick = await fakeServer({ 'POST /v1/chat/completions': () => ({ stream: sseStream([delta({ content: 'four' })]) }) });
  try {
    const timed = await askLocal({ prompt: 'x', model: 'm', base_url: steady.url });
    truthy('askLocal: a long enough answer reports its decode speed', typeof timed.decode_tps === 'number' && timed.decode_tps > 10 && timed.decode_tps < 200);
    eq('askLocal: a one-token answer reports none', (await askLocal({ prompt: 'x', model: 'm', base_url: quick.url })).decode_tps, null);
    const { measuredSpeed } = await import('./lib/local-speeds.js');
    const speedsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-record-'));
    fs.mkdirSync(path.join(speedsHome, '.claude'));
    try {
      await askLocal({ prompt: 'x', model: 'm', base_url: steady.url, runner_label: 'llama-swap' });
      eq('askLocal: keeps no speed unless asked to', fs.existsSync(path.join(speedsHome, '.claude', 'consult-speeds.json')), false);
      await askLocal({ prompt: 'x', model: 'm', base_url: steady.url, runner_label: 'llama-swap', record_speed: true, speeds_home: speedsHome });
      truthy('askLocal: record_speed keeps the speed for its runner and model', typeof measuredSpeed({ home: speedsHome, runner: 'llama-swap', model: 'm' }) === 'number');
    } finally {
      fs.rmSync(speedsHome, { recursive: true, force: true });
    }
  } finally {
    await steady.close();
    await quick.close();
  }
}
{
  const { recordSpeed, measuredSpeed } = await import('./lib/local-speeds.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-speeds-'));
  fs.mkdirSync(path.join(home, '.claude'));
  try {
    eq('measuredSpeed: nothing measured yet', measuredSpeed({ home, runner: 'llama-swap', model: 'm' }), null);
    for (const tps of [30, 50, 40]) recordSpeed({ home, runner: 'llama-swap', model: 'm', tps });
    eq('measuredSpeed: the median of the calls seen', measuredSpeed({ home, runner: 'llama-swap', model: 'm' }), 40);
    eq('measuredSpeed: per runner', measuredSpeed({ home, runner: 'ollama', model: 'm' }), null);
    for (const tps of [90, 90, 90, 90, 90]) recordSpeed({ home, runner: 'llama-swap', model: 'm', tps });
    eq('measuredSpeed: only the last five calls count', measuredSpeed({ home, runner: 'llama-swap', model: 'm' }), 90);
    recordSpeed({ home, runner: 'llama-swap', model: 'm', tps: null });
    recordSpeed({ home, runner: 'llama-swap', model: 'm', tps: -4 });
    eq('recordSpeed: no speed, nothing kept', measuredSpeed({ home, runner: 'llama-swap', model: 'm' }), 90);
    fs.writeFileSync(path.join(home, '.claude', 'consult-speeds.json'), 'not json');
    eq('measuredSpeed: a broken file reads as nothing measured', measuredSpeed({ home, runner: 'llama-swap', model: 'm' }), null);
    recordSpeed({ home, runner: 'llama-swap', model: 'm', tps: 12.34 });
    eq('recordSpeed: a broken file starts over', measuredSpeed({ home, runner: 'llama-swap', model: 'm' }), 12);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
{
  const { setupLocal, ollamaModels } = await import('./lib/local-setup.js');
  const { recordSpeed } = await import('./lib/local-speeds.js');
  const { resetBackupForTests } = await import('./lib/local-runners.js');
  const swap = await fakeServer({ 'GET /v1/models': () => ({ json: llamaSwapFixture('models.json') }), 'GET /running': () => ({ json: { running: [] } }) });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-measured-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'consult.local.md'), `---\nlocal_runner: llama-swap\nllama-swap.url: ${swap.url}\n---\n`);
  resetBackupForTests();
  try {
    recordSpeed({ home, runner: 'llama-swap', model: 'qwen3.5-9b', tps: 44 });
    const shown = await setupLocal({}, settingsIn(home), { home, reloadSettings: () => settingsIn(home), probeUrls: [] });
    let nine = null;
    for (const model of shown.proposal?.models ?? []) if (model.id === 'qwen3.5-9b') nine = model;
    eq('setupLocal: a model with no written speed carries the measured one', nine?.measured_tps, 44);
  } finally {
    await swap.close();
    fs.rmSync(home, { recursive: true, force: true });
  }

  const moe = { name: 'qwen3.6:35b-a3b', aliases: [], params: '35B', size_gb: 20, fits_gpu: false, vision: false, arch: 'MoE' };
  const [listed] = ollamaModels([moe]);
  eq('ollamaModels: type and engine', [listed.arch, listed.engine], ['MoE', 'Ollama']);

  const { ollamaArch } = await import('./lib/local-models.js');
  const ollama = await fakeServer({
    'POST /api/show': (request, body) => {
      const name = JSON.parse(body).model;
      if (name === 'moe') return { json: { model_info: { 'general.architecture': 'qwen3moe', 'qwen3moe.expert_count': 128 } } };
      if (name === 'dense') return { json: { model_info: { 'general.architecture': 'qwen3', 'qwen3.block_count': 36 } } };
      return { status: 404, json: { error: 'model not found' } };
    }
  });
  try {
    eq('ollamaArch: experts mean MoE', await ollamaArch(ollama.url, 'moe'), 'MoE');
    eq('ollamaArch: none mean dense', await ollamaArch(ollama.url, 'dense'), 'dense');
    eq('ollamaArch: unknown model, unknown', await ollamaArch(ollama.url, 'gone'), null);
    eq('ollamaArch: nothing listening, unknown', await ollamaArch('http://127.0.0.1:9/v1', 'moe'), null);
  } finally {
    await ollama.close();
  }
}

// ---- v0.13.2: LM Studio, and facts from a custom OpenAI-style server ----
// A recorded LM Studio answer from tests/fixtures/lmstudio/ (2026-10-24).
const lmstudioFixture = (name) => JSON.parse(fs.readFileSync(new URL(`../tests/fixtures/lmstudio/${name}`, import.meta.url), 'utf8'));
{
  const { classifyRunner, probeRunners, lmstudioFacts, loadedModels, unloadRunner, runnerInventory, prepareRunnerCall, swapFacts } = await import('./lib/local-runners.js');
  const { setupLocal } = await import('./lib/local-setup.js');
  const v1Models = lmstudioFixture('v1-models.json');
  const apiModels = lmstudioFixture('api-v1-models.json');

  eq('lmstudio classify: its greeting', classifyRunner({ greetingJson: { lmstudio: true }, modelsStatus: 200, modelsJson: v1Models }), 'lmstudio');
  eq('lmstudio classify: without the greeting it is any OpenAI server', classifyRunner({ modelsStatus: 200, modelsJson: v1Models }), 'openai');

  const facts = lmstudioFacts(apiModels, 8192);
  const factNamed = (name) => facts.find(one => one.name === name);
  eq('lmstudio facts: chat models only (the embedding model is left out)', facts.map(one => one.name).sort(), [
    'huihui-qwen3.6-35b-a3b-abliterated-i1', 'qwen3.5-9b', 'qwen3.6-35b-a3b', 'qwen3.8-27b', 'qwen3.8-9b-distill', 'qwen3.8-flash-next-gsq-rco', 'qwen3_5-4b'
  ]);
  const big27 = factNamed('qwen3.8-27b');
  eq('lmstudio facts: the 27B', [big27.params_b, big27.quant, big27.vision, big27.arch, big27.fits_gpu, big27.size_bytes, big27.loaded], [27, 'IQ4_XS', true, 'dense', false, 15180457232, false]);
  eq('lmstudio facts: 35B-A3B is MoE', factNamed('huihui-qwen3.6-35b-a3b-abliterated-i1').arch, 'MoE');
  eq('lmstudio facts: 512x56B is MoE and the most parameters', [factNamed('qwen3.8-flash-next-gsq-rco').arch, factNamed('qwen3.8-flash-next-gsq-rco').params_b], ['MoE', 512]);
  eq('lmstudio facts: the 4B fits, reads images, no quant named', [factNamed('qwen3_5-4b').fits_gpu, factNamed('qwen3_5-4b').vision, factNamed('qwen3_5-4b').quant], [true, true, null]);
  eq('lmstudio facts: the display name is kept', factNamed('qwen3.8-27b').label, 'Qwen3.8 27B UD');
  eq('lmstudio facts: no VRAM reading, fit unknown', lmstudioFacts(apiModels, null)[0].fits_gpu, null);
  const oddOnes = lmstudioFacts({ models: [
    { type: 'llm', key: 'evil\nlocal_runner: openai', size_bytes: 5 },
    { type: 'llm', key: 'held', params_string: '7B', size_bytes: 5, loaded_instances: [{ id: 'held' }], capabilities: {} }
  ] }, null);
  eq('lmstudio facts: an unsafe key is skipped, a loaded one says so', oddOnes.map(one => [one.name, one.loaded, one.vision]), [['held', true, false]]);
  eq('lmstudio facts: not the model list, none', lmstudioFacts({ error: 'x' }, null), null);

  const withLoaded4b = [];
  for (const model of apiModels.models) {
    if (model.key === 'qwen3_5-4b') withLoaded4b.push({ ...model, loaded_instances: [{ id: 'qwen3_5-4b', config: {} }] });
    else withLoaded4b.push(model);
  }
  const lm = await fakeServer({
    'GET /lmstudio-greeting': () => ({ json: { lmstudio: true } }),
    'GET /v1/models': () => ({ json: v1Models }),
    'GET /api/v1/models': () => ({ json: { models: withLoaded4b } }),
    'POST /api/v1/models/unload': (request, body) => ({ json: { instance_id: JSON.parse(body).instance_id } })
  });
  const plainServer = await fakeServer({ 'GET /v1/models': () => ({ json: { data: [{ id: 'only-one' }] } }) });
  try {
    const [found] = await probeRunners({ urls: [lm.url] });
    eq('lmstudio probe: told apart from openai, chat models counted', [found.type, found.up, found.models.length], ['lmstudio', true, 7]);
    eq('lmstudio loaded: from loaded_instances', await loadedModels({ type: 'lmstudio', url: lm.url }, null), ['qwen3_5-4b']);
    eq('lmstudio loaded: nothing when the list is not there (as before 0.13.2)', await loadedModels({ type: 'lmstudio', url: plainServer.url }, null), []);
    eq('lmstudio unload: each loaded instance', await unloadRunner({ type: 'lmstudio', url: lm.url }, null), { unloaded: ['qwen3_5-4b'] });
    const unload = lm.requests.find(one => one.path === '/api/v1/models/unload');
    eq('lmstudio unload: by its instance id', JSON.parse(unload.body), { instance_id: 'qwen3_5-4b' });

    const lmRunner = (nicknames = {}) => ({ type: 'lmstudio', url: lm.url, nicknames: { default: null, fast: null, vision: null, vision_best: null, big: null, ...nicknames } });
    const inventory = await runnerInventory(lmRunner(), null, { local_vram_mb: 8192 });
    eq('lmstudio inventory: the facts', [inventory.length, inventory.find(one => one.name === 'qwen3_5-4b').loaded], [7, true]);
    const settings = { timeout_ms: 180000 };
    eq('lmstudio call: a nickname', prepareRunnerCall({ runner: lmRunner({ fast: 'qwen3_5-4b' }), requested: 'fast', settings, inventory }).model, 'qwen3_5-4b');
    eq('lmstudio call: a fragment naming one model', prepareRunnerCall({ runner: lmRunner(), requested: 'abliterated', settings, inventory }).model, 'huihui-qwen3.6-35b-a3b-abliterated-i1');
    eq('lmstudio call: images go to the vision nickname', prepareRunnerCall({ runner: lmRunner({ default: 'qwen3.8-9b-distill', vision: 'qwen3_5-4b' }), images: ['a.png'], settings, inventory }).model, 'qwen3_5-4b');
    const plainInventory = await runnerInventory({ type: 'openai', url: plainServer.url, nicknames: {} }, null, settings);
    eq('openai call: the only model, from facts', prepareRunnerCall({ runner: { type: 'openai', url: plainServer.url, nicknames: { default: null } }, settings, inventory: plainInventory }).model, 'only-one');
  } finally {
    await lm.close();
    await plainServer.close();
  }

  // An LM Studio without /api/v1/models (an older one) works as in 0.13.1: by name.
  const { checkDoubleLoad } = await import('./lib/local-runners.js');
  const olderLm = await fakeServer({
    'GET /lmstudio-greeting': () => ({ json: { lmstudio: true } }),
    'GET /v1/models': () => ({ json: v1Models })
  });
  const olderHome = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-lmstudio-old-'));
  fs.mkdirSync(path.join(olderHome, '.claude'));
  fs.writeFileSync(path.join(olderHome, '.claude', 'consult.local.md'), `---\nlmstudio.url: ${olderLm.url}\n---\n`);
  try {
    const olderRunner = { type: 'lmstudio', url: olderLm.url, nicknames: { default: null, fast: 'qwen3_5-4b', vision: null, vision_best: null, big: null } };
    const olderInventory = await runnerInventory(olderRunner, null, {});
    eq('older lmstudio: the names from /v1/models', olderInventory.map(one => one.id).length, 8);
    eq('older lmstudio: a nickname resolves', prepareRunnerCall({ runner: olderRunner, requested: 'fast', settings: { timeout_ms: 180000 }, inventory: olderInventory }).model, 'qwen3_5-4b');
    eq('older lmstudio: a nickname resolves with no list at all', prepareRunnerCall({ runner: olderRunner, requested: 'fast', settings: { timeout_ms: 180000 }, inventory: null }).model, 'qwen3_5-4b');
    eq('older lmstudio: what is loaded reads as nothing, as before', await loadedModels(olderRunner, null), []);
    let refusedCall = null;
    try { await checkDoubleLoad({ requested: 'ollama', inUse: olderRunner, key: null }); } catch (error) { refusedCall = error.message; }
    eq('older lmstudio: a call to another runner is not refused', refusedCall, null);
    const olderSetup = (args) => setupLocal(args, settingsIn(olderHome), { home: olderHome, reloadSettings: () => settingsIn(olderHome), probeUrls: [] });
    const olderShown = await olderSetup({ runner: 'lmstudio' });
    eq('older lmstudio setup: reachable, its names listed', [olderShown.reachable, olderShown.proposal.models.length], [true, 8]);
    const olderPreview = await olderSetup({ runner: 'lmstudio', preview: true, save: { fast: 'qwen3_5-4b' } });
    truthy('older lmstudio setup: a listed name saves', (olderPreview.preview?.diff ?? []).join('\n').includes('lmstudio.fast: qwen3_5-4b'));
  } finally {
    await olderLm.close();
    fs.rmSync(olderHome, { recursive: true, force: true });
  }

  // Ollama: a model that can only embed isn't one that can reply.
  const { modelFacts } = await import('./lib/local-models.js');
  const withEmbed = { models: [
    tagModel('qwen3.5:4b', 3324173934, 'd1', '4.2B', 'Q4_K_M', ['completion', 'vision']),
    tagModel('nomic-embed-text:latest', 274302450, 'e1', '137M', 'F16', ['embedding']),
    tagModel('older:latest', 1000, 'o1', '1B', 'Q4_K_M', undefined)
  ] };
  eq('ollama facts: an embedding model is left out, one with no capabilities listed is kept', modelFacts(withEmbed, null).map(one => one.name), ['older:latest', 'qwen3.5:4b']);
  const ollamaWithEmbed = await fakeServer({
    'GET /api/tags': () => ({ json: withEmbed }),
    'GET /v1/models': () => ({ json: { object: 'list', data: [{ id: 'qwen3.5:4b' }, { id: 'nomic-embed-text:latest' }, { id: 'older:latest' }] } })
  });
  try {
    const [ollamaFound] = await probeRunners({ urls: [ollamaWithEmbed.url] });
    eq('ollama probe: chat models counted', [ollamaFound.type, ollamaFound.models], ['ollama', ['qwen3.5:4b', 'older:latest']]);
  } finally {
    await ollamaWithEmbed.close();
  }

  // A custom server describes its models with the fields llama-swap's metadata uses.
  const [custom] = swapFacts({ data: [{ id: 'mine', description: 'my server', meta: { arch: 'MoE', engine: 'vLLM', decode_tps: 40, vision: true } }] });
  eq('custom facts: read from meta', [custom.arch, custom.engine, custom.decode_tps, custom.vision, custom.description], ['MoE', 'vLLM', 40, true, 'my server']);
  const [llamaCpp] = swapFacts({ data: [{ id: 'g', meta: { vocab_type: 2, n_params: 4000000000, size: 3000000000 } }] });
  eq('custom facts: other meta fields are not facts', [llamaCpp.arch, llamaCpp.engine, llamaCpp.decode_tps, llamaCpp.vision], [null, null, null, null]);
  const [wrongShapes] = swapFacts({ data: [{ id: 'w', meta: { arch: 'x'.repeat(40), engine: { a: 1 }, decode_tps: 'fast', vision: 'yes' } }] });
  eq('custom facts: values of the wrong shape are left out', [wrongShapes.arch, wrongShapes.engine, wrongShapes.decode_tps, wrongShapes.vision], [null, null, null, null]);

  // `chat: false` in a model's metadata (llama-swap) or meta (a custom server): it can't reply.
  const notChat = { object: 'list', data: [
    { id: 'talker', owned_by: 'llama-swap', meta: { llamaswap: { type: 'model' } } },
    { id: 'embedder', owned_by: 'llama-swap', meta: { llamaswap: { type: 'model', chat: false } } }
  ] };
  eq('chat false: left out of llama-swap facts', swapFacts(notChat).map(one => one.id), ['talker']);
  eq('chat false: left out of a custom server facts', swapFacts({ data: [{ id: 'a' }, { id: 'b', meta: { chat: false } }] }).map(one => one.id), ['a']);
  eq('chat: only false counts', swapFacts({ data: [{ id: 'a', meta: { chat: 'no' } }] }).map(one => one.id), ['a']);
  const swapWithEmbedder = await fakeServer({ 'GET /v1/models': () => ({ json: notChat }) });
  try {
    const [swapFound] = await probeRunners({ urls: [swapWithEmbedder.url] });
    eq('chat false: not counted by the probe', [swapFound.type, swapFound.models], ['llama-swap', ['talker']]);
  } finally {
    await swapWithEmbedder.close();
  }

  // Setup on LM Studio proposes nicknames and checks what it saves.
  const lmSetup = await fakeServer({
    'GET /lmstudio-greeting': () => ({ json: { lmstudio: true } }),
    'GET /v1/models': () => ({ json: v1Models }),
    'GET /api/v1/models': () => ({ json: apiModels })
  });
  const lmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-lmstudio-'));
  fs.mkdirSync(path.join(lmHome, '.claude'));
  fs.writeFileSync(path.join(lmHome, '.claude', 'consult.local.md'), `---\nlocal_vram_mb: 8192\nlmstudio.url: ${lmSetup.url}\n---\n`);
  try {
    const setupIn = (args) => setupLocal(args, settingsIn(lmHome), { home: lmHome, reloadSettings: () => settingsIn(lmHome), probeUrls: [] });
    const shown = await setupIn({ runner: 'lmstudio' });
    const proposed = {};
    for (const one of shown.proposal.rows) proposed[one.role] = one.proposed;
    eq('lmstudio setup: proposals from facts', [proposed.fast, proposed.big], [['qwen3_5-4b'], ['qwen3.8-flash-next-gsq-rco']]);
    const listed = shown.proposal.models.find(one => one.id === 'huihui-qwen3.6-35b-a3b-abliterated-i1');
    eq('lmstudio setup: models listed with type and engine', [listed.arch, listed.engine, listed.vision], ['MoE', 'LM Studio', true]);
    let refused = null;
    try { await setupIn({ runner: 'lmstudio', preview: true, save: { fast: 'no-such-model' } }); } catch (error) { refused = error.message; }
    truthy('lmstudio setup: a model it does not list is refused', typeof refused === 'string' && refused.includes('is not listed by lmstudio'));
    const preview = await setupIn({ runner: 'lmstudio', preview: true, save: { fast: 'qwen3_5-4b' } });
    truthy('lmstudio setup: a listed model is saved', (preview.preview?.diff ?? []).join('\n').includes('lmstudio.fast: qwen3_5-4b'));
  } finally {
    await lmSetup.close();
    fs.rmSync(lmHome, { recursive: true, force: true });
  }
}

// --- codex_generate_image helpers ---
{
  eq('codexImageOptions: defaults', codexImageOptions({}, {}), { aspect_ratio: '1:1', transparent_background: false, count: 1, exact_prompt: false });
  eq('codexImageOptions: setting supplies the ratio', codexImageOptions({}, { codex_image_aspect_ratio: '9:16' }).aspect_ratio, '9:16');
  eq('codexImageOptions: explicit ratio beats the setting', codexImageOptions({ aspect_ratio: '16:9' }, { codex_image_aspect_ratio: '9:16' }).aspect_ratio, '16:9');
  throws('codexImageOptions: unknown ratio', () => codexImageOptions({ aspect_ratio: '5:4' }));
  throws('codexImageOptions: count 0', () => codexImageOptions({ count: 0 }));
  throws('codexImageOptions: count 5', () => codexImageOptions({ count: 5 }));
  throws('codexImageOptions: count 1.5', () => codexImageOptions({ count: 1.5 }));
  throws('codexImageOptions: transparent_background not boolean', () => codexImageOptions({ transparent_background: 'yes' }));
  throws('codexImageOptions: exact_prompt not boolean', () => codexImageOptions({ exact_prompt: 1 }));
  throws('codexImageOptions: six images', () => codexImageOptions({ images: ['a', 'b', 'c', 'd', 'e', 'f'] }));
  let sixImagesMessage = '';
  try { codexImageOptions({ images: ['a', 'b', 'c', 'd', 'e', 'f'] }); } catch (error) { sixImagesMessage = error.message; }
  truthy('codexImageOptions: the image limit message names 5 and 6', sixImagesMessage.includes('5') && sixImagesMessage.includes('6'));
  eq('codexImageOptions: five images are fine', codexImageOptions({ images: ['a', 'b', 'c', 'd', 'e'] }).count, 1);

  eq('shapeSentence: auto is null', shapeSentence('auto'), null);
  eq('shapeSentence: 16:9', shapeSentence('16:9'), 'Wide landscape 16:9 composition (much wider than tall).');
  for (const ratio of CODEX_IMAGE_ASPECT_RATIOS) {
    if (ratio === 'auto') continue;
    truthy(`shapeSentence: ${ratio} names its ratio`, shapeSentence(ratio).includes(ratio));
  }

  const plain = { aspect_ratio: 'auto', transparent_background: false, count: 1, exact_prompt: false };
  const plainBrief = codexImageBrief(plain, 'A cat.', []);
  truthy('codexImageBrief: exactly 1 image', plainBrief.includes('exactly 1 image'));
  truthy('codexImageBrief: names image_gen', plainBrief.includes('image_gen'));
  truthy('codexImageBrief: forbids shell commands and file writes, except the image tool', plainBrief.includes('Do not run shell commands, scripts or code other than the image_gen tool, and write no files.'));
  truthy('codexImageBrief: no retry', plainBrief.includes('do not retry'));
  truthy('codexImageBrief: no transparency unless asked', !plainBrief.includes('transparent_background: true'));
  truthy('codexImageBrief: no references unless given', !plainBrief.includes('referenced_image_paths'));
  const threeBrief = codexImageBrief({ ...plain, count: 3 }, 'A cat.', []);
  truthy('codexImageBrief: exactly 3 images', threeBrief.includes('exactly 3 images'));
  truthy('codexImageBrief: separate calls', threeBrief.includes('separate image_gen call'));
  truthy('codexImageBrief: transparent background', codexImageBrief({ ...plain, transparent_background: true }, 'A cat.', []).includes('transparent_background: true'));
  const referenceBrief = codexImageBrief(plain, 'A cat.', ['C:\\my pics\\a.png', 'C:\\Users\\Влад\\b.png']);
  truthy('codexImageBrief: both reference paths verbatim', referenceBrief.includes('C:\\my pics\\a.png') && referenceBrief.includes('C:\\Users\\Влад\\b.png'));
  truthy('codexImageBrief: references go in referenced_image_paths', referenceBrief.includes('referenced_image_paths'));
  const exactBrief = codexImageBrief({ ...plain, aspect_ratio: '16:9', exact_prompt: true }, 'A red fox.', []);
  truthy('codexImageBrief: exact prompt followed by the shape sentence', exactBrief.includes('A red fox. Wide landscape 16:9 composition (much wider than tall).'));
  truthy('codexImageBrief: exact prompt word for word', exactBrief.includes('word for word'));
  const expandBrief = codexImageBrief({ ...plain, aspect_ratio: '1:1' }, 'A red fox.', []);
  truthy('codexImageBrief: prompt followed by the square sentence', expandBrief.includes('A red fox. Square 1:1 composition (as wide as tall).'));
  truthy('codexImageBrief: shape sentence kept at the end', expandBrief.includes('keep its final sentence') && expandBrief.includes('at the end of the image prompt'));

  eq('codexImageArgs: bare command line', codexImageArgs({ outFile: 'C:\\t\\o.txt', referencePaths: [] }),
    ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--enable', 'image_generation', ...hookArgs(false), '-o', 'C:\\t\\o.txt', '--json', '--color', 'never', '-c', 'model_reasoning_effort=low', '-']);
  const modelArgs = codexImageArgs({ model: 'gpt-6.1-sol', outFile: 'o.txt', referencePaths: ['one.png', 'two.png'] });
  const modelAt = modelArgs.indexOf('-m');
  truthy('codexImageArgs: model passed', modelAt >= 0 && modelArgs[modelAt + 1] === 'gpt-6.1-sol');
  const referenceFlags = [];
  for (let at = 0; at < modelArgs.length; at++) {
    if (modelArgs[at] === '-i') referenceFlags.push(modelArgs[at + 1]);
  }
  eq('codexImageArgs: one -i per reference, in order', referenceFlags, ['one.png', 'two.png']);
  eq('codexImageArgs: stdin marker is last', modelArgs[modelArgs.length - 1], '-');
  let spacedPathThrew = false;
  try { shellSafeArgs(codexImageArgs({ outFile: 'o.txt', referencePaths: ['C:\\my pics\\a.png'] })); } catch (_) { spacedPathThrew = true; }
  truthy('codexImageArgs: a reference path with a space is shell-safe', !spacedPathThrew);
  let cyrillicPathThrew = false;
  try { shellSafeArgs(codexImageArgs({ outFile: 'o.txt', referencePaths: ['C:\\Users\\Влад\\b.png'] })); } catch (_) { cyrillicPathThrew = true; }
  truthy('codexImageArgs: a Cyrillic reference path is shell-safe', !cyrillicPathThrew);

  eq('codexImageTimeoutMs: one image keeps the base', codexImageTimeoutMs(300000, 1), 300000);
  eq('codexImageTimeoutMs: two minutes more per extra image', codexImageTimeoutMs(300000, 4), 660000);
  eq('codexImageTimeoutMs: capped at 30 minutes', codexImageTimeoutMs(1700000, 4), 1800000);
}

// --- codex_generate_image: running Codex and collecting the images ---
{
  const threadId = '019e0000-aaaa-bbbb-cccc-000000000001';
  const tinyPng = (variant) => {
    const bytes = pngBytes(16, 16);
    bytes[8] = variant; // differs per image so the copies are not deduplicated
    return bytes;
  };
  const startedLine = `{"type":"thread.started","thread_id":"${threadId}"}\n`;
  // A fake codex run that writes imageCount images into the thread folder and
  // answers with the first one's path (or `reply`).
  const codexImageRun = (imageCount, folder, { reply, stderr = '' } = {}) => {
    const calls = [];
    const fake = async (spec) => {
      calls.push(spec);
      fs.mkdirSync(folder, { recursive: true });
      for (let n = 1; n <= imageCount; n++) fs.writeFileSync(path.join(folder, `exec-${n}.png`), tinyPng(n));
      const text = reply ?? path.join(folder, 'exec-1.png');
      return { stdout: startedLine + JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } }) + '\n', stderr, code: 0, latency_ms: 5 };
    };
    return { fake, calls };
  };
  const callImage = async (extra, makeRun) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-codexhome-'));
    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-codexout-'));
    const folder = path.join(tmpHome, 'generated_images', threadId);
    const scripted = makeRun(folder, tmpOut);
    let result = null;
    let error = null;
    try {
      result = await codexGenerateImage({ prompt: 'A cat.', home: tmpHome, output_dir: tmpOut, run: scripted.fake, ...extra });
    } catch (e) {
      error = e;
    }
    const outcome = { result, error, calls: scripted.calls || [], tmpOut, folderGone: !fs.existsSync(folder), outFiles: fs.readdirSync(tmpOut).sort(), homeEntries: fs.readdirSync(tmpHome).sort() };
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpOut, { recursive: true, force: true });
    return outcome;
  };

  const two = await callImage({ count: 2 }, (folder) => codexImageRun(2, folder));
  eq('codexGenerateImage: two asked, two written -> two copies', two.result.images.length, 2);
  eq('codexGenerateImage: the copies are in the output folder', two.outFiles, ['exec-1.png', 'exec-2.png']);
  truthy('codexGenerateImage: codex_reply names the copy, not the thread folder', two.result.codex_reply.includes(two.tmpOut) && !two.result.codex_reply.includes('generated_images'));
  truthy('codexGenerateImage: the thread folder is removed', two.folderGone);
  eq('codexGenerateImage: no warning when the count matches', two.result.warning, undefined);
  eq('codexGenerateImage: echoes the options', [two.result.aspect_ratio, two.result.transparent_background, two.result.count], ['1:1', false, 2]);
  eq('codexGenerateImage: image entries carry no source path', Object.keys(two.result.images[0]).sort(), ['bytes', 'height', 'path', 'type', 'width']);

  const sandboxed = await callImage({ settings: { codex_sandbox: 'workspace-write' } }, (folder) => codexImageRun(1, folder));
  const sentArgs = sandboxed.calls[0].args;
  truthy('codexGenerateImage: args are ephemeral', sentArgs.includes('--ephemeral'));
  eq('codexGenerateImage: the sandbox stays read-only whatever the setting says', sentArgs[sentArgs.indexOf('-s') + 1], 'read-only');
  eq('codexGenerateImage: image_generation is enabled', sentArgs[sentArgs.indexOf('--enable') + 1], 'image_generation');
  eq('codexGenerateImage: runs the codex command with the image label', [sandboxed.calls[0].cmd, sandboxed.calls[0].label], ['codex', 'codex image']);
  eq('codexGenerateImage: one image asked gets the base limit', sandboxed.calls[0].timeout_ms, 300000);

  const short = await callImage({ count: 2 }, (folder) => codexImageRun(1, folder));
  eq('codexGenerateImage: two asked, one written -> warning', [short.result.images.length, short.result.warning], [1, 'asked for 2, Codex saved 1.']);
  const surplus = await callImage({ count: 1 }, (folder) => codexImageRun(2, folder));
  eq('codexGenerateImage: one asked, two written -> warning, both kept', [surplus.result.images.length, surplus.result.warning], [2, 'asked for 1, Codex saved 2.']);

  const collision = await callImage({}, (folder, tmpOut) => {
    fs.writeFileSync(path.join(tmpOut, 'exec-1.png'), 'mine');
    return codexImageRun(1, folder);
  });
  eq('codexGenerateImage: an existing file is not overwritten, the copy is numbered', collision.outFiles, ['exec-1-1.png', 'exec-1.png']);

  const refusalStderr = 'ERROR codex_core::tools::router: error=image generation failed: http 400 Bad Request: Some("{\\n  \\"error\\": {\\"code\\": \\"moderation_blocked\\", \\"moderation_details\\": {\\"moderation_stage\\": \\"input\\"}}}")';
  const refused = await callImage({}, (folder) => codexImageRun(0, folder, { reply: 'The tool refused.', stderr: refusalStderr }));
  truthy('codexGenerateImage: a refusal throws, naming the stage', refused.error && refused.error.message.includes('refused') && refused.error.message.includes('stage input') && refused.error.message.includes('The tool refused.'));
  const refusedNoStage = await callImage({}, (folder) => codexImageRun(0, folder, { reply: 'No.', stderr: '"code": "moderation_blocked"' }));
  truthy('codexGenerateImage: a refusal without a stage omits it', refusedNoStage.error && refusedNoStage.error.message.includes('refused') && !refusedNoStage.error.message.includes('stage'));
  const limited = await callImage({}, (folder) => codexImageRun(0, folder, { reply: "You've hit your usage limit." }));
  truthy('codexGenerateImage: a usage limit in the reply throws', limited.error && limited.error.message.includes('usage limit'));
  const nothing = await callImage({}, (folder) => codexImageRun(0, folder, { reply: 'Done.', stderr: 'ERROR image generation failed: boom' }));
  truthy('codexGenerateImage: no image and no known cause throws, with the logged line', nothing.error && nothing.error.message.includes('Codex finished without saving an image') && nothing.error.message.includes('Its reply: Done.') && nothing.error.message.includes('Codex logged: ERROR image generation failed: boom'));

  const realTimeoutMessage = 'codex image timed out after 300000ms. Retry with `timeout_s: 600` (up to 1800), raise `timeout_ms` in .claude/consult.local.md, or narrow the prompt. stderr:\n';
  const timeoutAfterImage = await callImage({ count: 2 }, (folder) => ({
    fake: async () => {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'exec-1.png'), tinyPng(1));
      throw Object.assign(new Error(realTimeoutMessage), { kind: 'timeout', stdout: startedLine, stderr: '' });
    }
  }));
  eq('codexGenerateImage: a timeout after one of two images keeps it', timeoutAfterImage.result?.images.length, 1);
  truthy('codexGenerateImage: the kept image comes with a did-not-finish warning', timeoutAfterImage.result?.warning.includes('did not finish cleanly'));
  truthy('codexGenerateImage: the warning names the image timeout setting, not timeout_ms', timeoutAfterImage.result?.warning.includes('`codex_image_timeout_ms`') && !timeoutAfterImage.result.warning.includes('`timeout_ms`'));
  truthy('codexGenerateImage: the thread folder is removed after a failed run', timeoutAfterImage.folderGone);

  const timeoutNoImage = await callImage({}, () => ({
    fake: async () => { throw Object.assign(new Error('x'), { kind: 'timeout', stdout: startedLine, stderr: '' }); }
  }));
  truthy('codexGenerateImage: a timeout with no image is INCOMPLETE and names the image setting', timeoutNoImage.error && timeoutNoImage.error.message.startsWith('INCOMPLETE:') && timeoutNoImage.error.message.includes('codex_image_timeout_ms') && !/codex_timeout_ms/.test(timeoutNoImage.error.message));

  const missingReference = await callImage({ images: [path.join(os.tmpdir(), 'consult-no-such-image.png')] }, (folder) => codexImageRun(1, folder));
  truthy('codexGenerateImage: a missing reference image throws', missingReference.error !== null);
  eq('codexGenerateImage: run is never called for a missing reference', missingReference.calls.length, 0);

  const lockedDelete = await callImage({ remove: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } }, (folder) => codexImageRun(1, folder));
  eq('codexGenerateImage: a delete that fails does not hide the result', [lockedDelete.error, lockedDelete.result?.images.length], [null, 1]);

  const limitFailure = Object.assign(new Error("codex image exited with code 1. stderr:\nERROR: You've hit your usage limit. Try again at 5pm.\nmore log"), { kind: 'exit', stdout: startedLine, stderr: "ERROR: You've hit your usage limit. Try again at 5pm.\nmore log" });
  const limitedByExit = await callImage({}, () => ({ fake: async () => { throw limitFailure; } }));
  truthy('codexGenerateImage: a usage-limit exit quotes the limit line', limitedByExit.error && limitedByExit.error.message.includes("You've hit your usage limit. Try again at 5pm.") && !limitedByExit.error.message.includes('exited with code'));
  const limitedByReply = await callImage({}, (folder) => codexImageRun(0, folder, { reply: "I could not.\nYou've hit your usage limit.\nBye", stderr: 'noise' }));
  truthy('codexGenerateImage: a usage limit in the reply quotes only that line', limitedByReply.error && limitedByReply.error.message.endsWith("You've hit your usage limit.") );

  const turnFailedOnly = await callImage({}, (folder) => ({
    fake: async () => ({
      stdout: startedLine + '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}\n',
      stderr: '', code: 0, latency_ms: 5
    })
  }));
  truthy('codexGenerateImage: a limit only in Codex\'s own failure event is reported as a limit', turnFailedOnly.error && turnFailedOnly.error.message.includes('usage limit'));

  const authFailed = await callImage({}, () => ({
    fake: async () => ({
      stdout: startedLine + '{"type":"turn.failed","error":{"message":"401 Unauthorized: token expired"}}\n',
      stderr: '', code: 0, latency_ms: 5
    })
  }));
  truthy('codexGenerateImage: no image after a failed turn quotes what Codex reported', authFailed.error && authFailed.error.message.includes('Codex reported: 401 Unauthorized: token expired'));
  truthy('codexGenerateImage: an auth failure points at codex login', authFailed.error && authFailed.error.message.includes('codex login'));
  const plainFailed = await callImage({}, () => ({
    fake: async () => ({
      stdout: startedLine + '{"type":"turn.failed","error":{"message":"The server is busy."}}\n',
      stderr: '', code: 0, latency_ms: 5
    })
  }));
  truthy('codexGenerateImage: a non-auth failure is quoted without the login hint', plainFailed.error && plainFailed.error.message.includes('Codex reported: The server is busy.') && !plainFailed.error.message.includes('codex login'));

  // A copy failure keeps Codex's thread folder, so the originals are not lost.
  const copyFails = await callImage({ output_dir: path.join(os.tmpdir(), 'consult-copy-fails') }, (folder, tmpOut) => {
    const scripted = codexImageRun(1, folder);
    return {
      calls: scripted.calls,
      fake: async (spec) => {
        const ran = await scripted.fake(spec);
        // The output folder becomes a file, so the copy cannot write into it.
        fs.rmSync(path.join(os.tmpdir(), 'consult-copy-fails'), { recursive: true, force: true });
        fs.writeFileSync(path.join(os.tmpdir(), 'consult-copy-fails'), 'in the way');
        return ran;
      }
    };
  });
  fs.rmSync(path.join(os.tmpdir(), 'consult-copy-fails'), { recursive: true, force: true });
  truthy('codexGenerateImage: a failed copy throws', copyFails.error && copyFails.error.message.includes('copying them'));
  truthy('codexGenerateImage: a failed copy keeps the thread folder and names it', copyFails.error && !copyFails.folderGone && copyFails.error.message.includes('originals are still in') && copyFails.error.message.includes(threadId));

  if (SPAWN_OPTS.shell) {
    const ampersandReference = path.join(os.tmpdir(), 'consult-a&b.png');
    fs.writeFileSync(ampersandReference, pngBytes(16, 16));
    const ampersand = await callImage({ images: [ampersandReference] }, (folder) => codexImageRun(1, folder));
    fs.rmSync(ampersandReference, { force: true });
    truthy('codexGenerateImage: a reference path with & throws', ampersand.error !== null);
    eq('codexGenerateImage: run is never called for an unsafe reference path', ampersand.calls.length, 0);
  }

  const traversal = await callImage({}, (folder, tmpOut) => {
    fs.mkdirSync(path.resolve(folder, '..', '..'), { recursive: true });
    fs.writeFileSync(path.resolve(folder, '..', '..', 'keep.txt'), 'keep');
    return { fake: async () => ({ stdout: '{"type":"thread.started","thread_id":".."}\n', stderr: '', code: 0, latency_ms: 5 }) };
  });
  truthy('codexGenerateImage: a thread id that is a path collects and deletes nothing', traversal.homeEntries.includes('keep.txt') && traversal.error && traversal.error.message.includes('without saving'));
}

// --- resolve-cmd: a CLI file inside the project is never run (Windows lookup) ---
eq("resolve: a project's own codex.cmd is never picked",
  pickWindowsHit(['C:\\proj\\codex.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'], 'C:\\proj'),
  'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd');
eq('resolve: a hit inside the project is refused even when PATH lists it',
  pickWindowsHit(['C:\\proj\\node_modules\\.bin\\codex.cmd'], 'c:/PROJ'), null);
eq('resolve: a relative hit is refused', pickWindowsHit(['codex.cmd'], 'C:\\proj'), null);
eq('resolve: a sibling folder sharing the project name prefix is not the project',
  pickWindowsHit(['C:\\proj-tools\\codex.cmd'], 'C:\\proj'), 'C:\\proj-tools\\codex.cmd');
if (process.platform === 'win32') {
  const homeNpmShim = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd');
  eq('resolve: from the home folder the npm install is still found', pickWindowsHit([homeNpmShim], os.homedir()), homeNpmShim);
  eq('resolve: from a parent of the home folder the install is still found', pickWindowsHit([homeNpmShim], path.dirname(os.homedir())), homeNpmShim);
  eq('resolve: from a drive root the install is still found',
    pickWindowsHit(['C:\\Program Files\\x\\codex.exe'], 'C:\\'), 'C:\\Program Files\\x\\codex.exe');
  eq('resolve: a relative hit is still refused from the home folder', pickWindowsHit(['codex.cmd'], os.homedir()), null);
  eq('resolve: whereCommand uses the System32 where.exe and $PATH:<name>',
    [whereCommand('codex').file.toLowerCase().endsWith('\\system32\\where.exe'), path.isAbsolute(whereCommand('codex').file) || process.platform !== 'win32', whereCommand('codex').args],
    [true, true, ['$PATH:codex']]);
}
eq('resolve: isInsideFolder sees a program in the project, not beside it',
  [isInsideFolder('C:\\proj\\bin\\agy.cmd', 'C:\\proj'), isInsideFolder('C:\\proj-tools\\agy.cmd', 'C:\\proj'), isInsideFolder('agy', 'C:\\proj')], [true, false, false]);
eq('resolve: isInsideFolder exempts a drive root', isInsideFolder('C:\\Program Files\\agy.exe', 'C:\\'), false);
// where.exe prints a hit's long real path, while the project can be open through a
// junction or an 8.3 short name (GitHub's Windows runners: C:\Users\RUNNER~1\...).
if (process.platform === 'win32') {
  const realProject = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-realproj-'));
  const linkedProject = `${realProject}-link`;
  try {
    fs.writeFileSync(path.join(realProject, 'codex.cmd'), '@echo off');
    fs.symlinkSync(realProject, linkedProject, 'junction');
    eq('resolve: a project opened through a junction still refuses its own codex.cmd',
      [pickWindowsHit([path.join(realProject, 'codex.cmd')], linkedProject), isInsideFolder(path.join(realProject, 'codex.cmd'), linkedProject)], [null, true]);
    eq('resolve: and a hit spelled through the junction is refused from the real folder',
      pickWindowsHit([path.join(linkedProject, 'codex.cmd')], realProject), null);
  } finally {
    try { fs.rmdirSync(linkedProject); } catch (_) {}
    fs.rmSync(realProject, { recursive: true, force: true });
  }
} else {
  console.log('PASS-SKIP resolve: a project opened through a junction (Windows only)');
}
{
  const { refuseProgramInsideProject } = await import('./lib/delegate-supervisor.js');
  let refusal = '';
  try { refuseProgramInsideProject('C:\\proj\\agy.cmd', 'agy', ['C:\\other', 'C:\\proj']); } catch (e) { refusal = e.message; }
  truthy('delegate: a worker program inside the project is refused with the project-folder message', refusal.includes('only inside the project folder (C:\\proj\\agy.cmd)'));
  let outside = null;
  try { refuseProgramInsideProject('C:\\tools\\agy.cmd', 'agy', ['C:\\proj', null, undefined]); } catch (e) { outside = e; }
  eq('delegate: a worker program outside the project is allowed', outside, null);
}
eq('resolve: refusedWindowsHits lists what was skipped', refusedWindowsHits(['C:\\proj\\codex.cmd', 'C:\\n\\codex.cmd'], 'C:\\proj'), ['C:\\proj\\codex.cmd']);
truthy('resolve: a project-only hit is reported as such, not as not installed',
  missingMessage('codex', 'C:\\proj\\codex.cmd').includes('only inside the project folder (C:\\proj\\codex.cmd)') && !/not installed/.test(missingMessage('codex', 'x')));
eq('resolve: .cmd is still preferred outside the project',
  pickWindowsHit(['C:\\a\\codex.exe', 'C:\\b\\codex.cmd'], 'C:\\proj'), 'C:\\b\\codex.cmd');
eq('resolve: .exe beats .bat, and the first line is the last resort',
  [pickWindowsHit(['C:\\a\\x.bat', 'C:\\b\\x.exe'], 'C:\\proj'), pickWindowsHit(['C:\\a\\x.ps1'], 'C:\\proj')],
  ['C:\\b\\x.exe', 'C:\\a\\x.ps1']);
if (SPAWN_OPTS.shell) {
  for (const character of ['&', '(', ')', '^', '|', '<', '>', '!']) {
    const risky = `C:\\Tools\\A${character}B\\codex.cmd`;
    eq(`spawnableCmd: a path with ${character} is quoted`, spawnableCmd(risky), `"${risky}"`);
  }
  eq('spawnableCmd: a plain path is quoted too (cmd also splits at , ; =)', spawnableCmd('C:\\Tools\\a,b\\codex.cmd'), '"C:\\Tools\\a,b\\codex.cmd"');
  eq('spawnableCmd: no folder trick needed, plain path quoted', spawnableCmd('C:\\Tools\\codex.cmd'), '"C:\\Tools\\codex.cmd"');
  eq('resolve: the server sets NoDefaultCurrentDirectoryInExePath', process.env.NoDefaultCurrentDirectoryInExePath, '1');
  for (const unsafe of ['C:\\Tools\\a"b\\codex.cmd', 'C:\\Tools\\%PATH%\\codex.cmd']) {
    let message = '';
    try { spawnableCmd(unsafe); } catch (e) { message = e.message; }
    truthy(`spawnableCmd: ${unsafe} is refused and named`, message.includes(unsafe));
  }
}

// ---- long answers go to a file ----
{
  const answersFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-answers-'));
  try {
    const short = { response: 'short answer', model: 'm' };
    eq('long answer: a short answer is returned unchanged', spillLongAnswer(short, 'ask_agy', { dir: answersFolder }), short);
    eq('long answer: nothing is written for a short answer', fs.readdirSync(answersFolder), []);
    const atLimit = { response: 'x'.repeat(LONG_ANSWER_BYTES), model: 'm' };
    eq('long answer: an answer exactly at the limit is returned unchanged', spillLongAnswer(atLimit, 'ask_agy', { dir: answersFolder }), atLimit);
    const lines = [];
    for (let index = 0; index < 4000; index += 1) lines.push(`line ${index}: ${'word '.repeat(4)}`);
    const fullAnswer = lines.join('\n');
    const spilled = spillLongAnswer({ response: fullAnswer, model: 'gemini/4 argon', latency_ms: 5 }, 'ask_agy', { dir: answersFolder, now: new Date('2026-10-31T01:02:03.004Z') });
    truthy('long answer: the result names the saved file', typeof spilled.full_answer_path === 'string' && spilled.full_answer_path.startsWith(answersFolder));
    eq('long answer: the result gives the full length', spilled.response_chars, fullAnswer.length);
    truthy('long answer: the response starts with the answer and says where the rest is', spilled.response.startsWith(fullAnswer.slice(0, PREVIEW_CHARS)) && spilled.response.includes(spilled.full_answer_path) && spilled.response.includes(String(fullAnswer.length)));
    truthy('long answer: the response stays well under the limit', spilled.response.length < PREVIEW_CHARS + 500);
    eq('long answer: other fields are kept', [spilled.model, spilled.latency_ms], ['gemini/4 argon', 5]);
    const saved = fs.readFileSync(spilled.full_answer_path, 'utf8');
    truthy('long answer: the file holds the whole answer with its line breaks', saved.endsWith(fullAnswer) && saved.split('\n').length > 4000);
    truthy('long answer: the file name is safe and dated', /^2026-10-31T01-02-03-004Z-ask_agy-gemini-4-argon-[0-9a-f]{6}\.md$/.test(path.basename(spilled.full_answer_path)));
    truthy('long answer: the limit counts bytes, so dense text is long sooner', isLongText('漢'.repeat(14000)) && !isLongText('x'.repeat(14000)));
    const ownNote = path.join(answersFolder, 'my-notes.md');
    fs.writeFileSync(ownNote, 'mine');
    for (let index = 0; index < KEEP_ANSWERS + 5; index += 1) {
      spillLongAnswer({ response: fullAnswer, model: 'm' }, 'ask_codex', { dir: answersFolder, now: new Date(Date.UTC(2026, 10, 1, 0, 0, index)) });
    }
    truthy('long answer: a file consult did not write is never removed', fs.existsSync(ownNote));
    fs.unlinkSync(ownNote);
    const kept = fs.readdirSync(answersFolder).sort();
    eq('long answer: the folder keeps the newest answers only', kept.length, KEEP_ANSWERS);
    truthy('long answer: the oldest answers are the ones removed', kept[0].startsWith('2026-11-01T00-00-05'));
    // A folder that can't be made: a file stands where it should be.
    const blocked = path.join(answersFolder, 'blocked');
    fs.writeFileSync(blocked, 'a file, not a folder');
    const unsaved = { response: fullAnswer, model: 'm' };
    eq('long answer: when it cannot be saved the whole answer comes back', spillLongAnswer(unsaved, 'ask_agy', { dir: path.join(blocked, 'inside') }), unsaved);
  } finally {
    fs.rmSync(answersFolder, { recursive: true, force: true });
  }
}

// --- fence helpers: pi temp folders, the Codex sandbox check, the pi guard ---
{
  const fenceHelpers = await import('./lib/delegate-fence.js');
  const { stagePiSessions, returnPiSessions, removePiTemp, piTempFolders, piLauncherFor, sandboxCheck, readSandboxCheck, readCachedSandboxCheck, spawnPlanFor, readCodexVersion } = fenceHelpers;
  const { default: piFenceExtension } = await import('./lib/pi-fence.js');
  const fenceScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-fence-test-'));
  const previousCheckFile = process.env.CONSULT_SANDBOX_CHECK_FILE;
  const previousFenceDir = process.env.CONSULT_FENCE_DIR;
  process.env.CONSULT_SANDBOX_CHECK_FILE = path.join(fenceScratch, 'check.json');
  const previousPiTempRoot = process.env.CONSULT_PI_TEMP_ROOT;
  process.env.CONSULT_PI_TEMP_ROOT = path.join(fenceScratch, 'consult-pi');
  const fenceTaskId = (process.pid % 0xffffff).toString(16).padStart(6, '0');
  try {
    const taskDirWithSessions = path.join(fenceScratch, 'task');
    fs.mkdirSync(path.join(taskDirWithSessions, 'pi-sessions'), { recursive: true });
    fs.writeFileSync(path.join(taskDirWithSessions, 'pi-sessions', 'a.jsonl'), 'a');
    const staged = stagePiSessions(taskDirWithSessions, fenceTaskId);
    eq('stage: copies sessions in', fs.readdirSync(staged.sessions), ['a.jsonl']);
    eq('stage: folders are under consult-pi/<id>', staged.root, path.join(fenceScratch, 'consult-pi', fenceTaskId));
    eq('stage: agent and tmp exist', [fs.existsSync(staged.agent), fs.existsSync(staged.tmp)], [true, true]);
    fs.writeFileSync(path.join(staged.agent, 'auth.json'), '{}');
    fs.writeFileSync(path.join(staged.sessions, 'stale.jsonl'), 'x');
    const restaged = stagePiSessions(taskDirWithSessions, fenceTaskId);
    eq('stage: a stale temp copy never survives', fs.readdirSync(restaged.sessions), ['a.jsonl']);
    eq('stage: agent is kept', fs.existsSync(path.join(restaged.agent, 'auth.json')), true);
    fs.writeFileSync(path.join(restaged.sessions, 'b.jsonl'), 'y');
    returnPiSessions(taskDirWithSessions, fenceTaskId);
    eq('return: copies back', fs.readdirSync(path.join(taskDirWithSessions, 'pi-sessions')).sort(), ['a.jsonl', 'b.jsonl']);
    removePiTemp(fenceTaskId);
    eq('removePiTemp: removes the folder', fs.existsSync(piTempFolders(fenceTaskId).root), false);
    eq('removePiTemp: a missing folder does not throw', (() => { removePiTemp(fenceTaskId); return true; })(), true);
    eq('return: with nothing staged does not throw and keeps the authority', (() => { returnPiSessions(taskDirWithSessions, fenceTaskId); return fs.readdirSync(path.join(taskDirWithSessions, 'pi-sessions')).length; })(), 2);
    // F5: the swap never leaves a moment with no pi-sessions, and a crash inside it is recoverable.
    eq('return: no .old or .incoming is left behind', fs.readdirSync(taskDirWithSessions).sort(), ['pi-sessions']);
    const crashedTask = path.join(fenceScratch, 'crashed task');
    fs.mkdirSync(path.join(crashedTask, 'pi-sessions.old'), { recursive: true });
    fs.writeFileSync(path.join(crashedTask, 'pi-sessions.old', 'kept.jsonl'), 'k');
    eq('stage: with pi-sessions missing, pi-sessions.old is the authority', fs.readdirSync(stagePiSessions(crashedTask, fenceTaskId).sessions), ['kept.jsonl']);
    returnPiSessions(crashedTask, fenceTaskId);
    eq('return: after a crash it restores pi-sessions and clears .old', [fs.readdirSync(path.join(crashedTask, 'pi-sessions')), fs.existsSync(path.join(crashedTask, 'pi-sessions.old'))], [['kept.jsonl'], false]);
    // Non-ASCII folders and nested session folders go both ways (Node 22's cpSync ended the process on Windows here).
    const cyrillicTask = path.join(fenceScratch, 'задача Имя task');
    fs.mkdirSync(path.join(cyrillicTask, 'pi-sessions', 'папка'), { recursive: true });
    fs.writeFileSync(path.join(cyrillicTask, 'pi-sessions', 'папка', 'сессия.jsonl'), 'nested');
    const cyrillicStaged = stagePiSessions(cyrillicTask, fenceTaskId);
    eq('stage: a non-ASCII nested session is copied in', fs.readFileSync(path.join(cyrillicStaged.sessions, 'папка', 'сессия.jsonl'), 'utf8'), 'nested');
    fs.writeFileSync(path.join(cyrillicStaged.sessions, 'папка', 'новая.jsonl'), 'new');
    returnPiSessions(cyrillicTask, fenceTaskId);
    eq('return: a non-ASCII nested session is copied back', fs.readdirSync(path.join(cyrillicTask, 'pi-sessions', 'папка')).sort(), ['новая.jsonl', 'сессия.jsonl']);
    // A temp sessions folder swapped for a junction (pi can write its temp root) is not followed, and a
    // junction inside it is skipped: the authority keeps what it had.
    const elsewhere = path.join(fenceScratch, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'not a session');
    const linkedStaged = stagePiSessions(cyrillicTask, fenceTaskId);
    fs.symlinkSync(elsewhere, path.join(linkedStaged.sessions, 'inner link'), 'junction');
    returnPiSessions(cyrillicTask, fenceTaskId);
    eq('return: a junction inside the sessions is skipped', fs.readdirSync(path.join(cyrillicTask, 'pi-sessions')).sort(), ['папка']);
    fs.rmSync(linkedStaged.sessions, { recursive: true, force: true });
    fs.symlinkSync(elsewhere, linkedStaged.sessions, 'junction');
    const linkedReturn = returnPiSessions(cyrillicTask, fenceTaskId);
    eq('return: a sessions folder that is a junction is refused, with a message', typeof linkedReturn === 'string' && linkedReturn.includes('not a folder'), true);
    eq('return: and the authority keeps what it had', fs.readdirSync(path.join(cyrillicTask, 'pi-sessions')).sort(), ['папка']);
    fs.unlinkSync(linkedStaged.sessions);
    // F6: only a real task id becomes a path.
    for (const badId of ['..', '..\\x', 'ABCDEF', 'abc', 'a/b', '', undefined]) {
      throws('piTempFolders: ' + JSON.stringify(badId) + ' is refused', () => piTempFolders(badId));
      eq('removePiTemp: ' + JSON.stringify(badId) + ' is a no-op', (() => { removePiTemp(badId); return true; })(), true);
    }
    removePiTemp(fenceTaskId);

    // F10: a codex.cmd is started the way spawn-cli.js does, so it works under cmd.exe.
    const cmdPath = 'C:/Users/Jane Doe/npm/codex.cmd';
    const nodePath = 'C:/Program Files/nodejs/node.exe';
    const cmdPlan = spawnPlanFor(cmdPath, ['sandbox', '-c', 'sandbox_mode=workspace-write', '--', nodePath, 'C:/p/probe.js']);
    // readCodexVersion starts Codex the way sandboxCheck does, so a .cmd works (execFile alone fails on it).
    if (process.platform === 'win32') {
      const versionFolder = path.join(fenceScratch, 'version stub');
      fs.mkdirSync(versionFolder, { recursive: true });
      fs.writeFileSync(path.join(versionFolder, 'codex.cmd'), '@echo off\r\necho  codex-cli 7.8.9  \r\n');
      fs.writeFileSync(path.join(versionFolder, 'broken.cmd'), '@echo off\r\nexit /b 3\r\n');
      fs.writeFileSync(path.join(versionFolder, 'silent.cmd'), '@echo off\r\n');
      eq('readCodexVersion: a .cmd path answers with the trimmed output', readCodexVersion(path.join(versionFolder, 'codex.cmd')), 'codex-cli 7.8.9');
      eq('readCodexVersion: a nonzero exit, no output and a missing program are null', [readCodexVersion(path.join(versionFolder, 'broken.cmd')), readCodexVersion(path.join(versionFolder, 'silent.cmd')), readCodexVersion(path.join(versionFolder, 'nothing.cmd'))], [null, null, null]);
    }
    eq('spawnPlanFor: a .cmd path is quoted, spaced args are quoted, and the shell is used (Windows)',
      [cmdPlan.file, cmdPlan.args, cmdPlan.shell],
      SPAWN_OPTS.shell
        ? ['"' + cmdPath + '"', ['sandbox', '-c', 'sandbox_mode=workspace-write', '--', '"' + nodePath + '"', 'C:/p/probe.js'], true]
        : [cmdPath, ['sandbox', '-c', 'sandbox_mode=workspace-write', '--', nodePath, 'C:/p/probe.js'], false]);
    const { isBroadWorkFolder } = await import('./lib/resolve-cmd.js');
    eq('isBroadWorkFolder: the home folder, its parent and a drive root are broad; a project under it is not',
      [isBroadWorkFolder(os.homedir()), isBroadWorkFolder(path.dirname(os.homedir())), isBroadWorkFolder(path.parse(os.homedir()).root), isBroadWorkFolder(path.join(os.homedir(), 'some', 'project'))],
      [true, true, true, false]);

    const fakePiBin = path.join(fenceScratch, 'pibin');
    const emptyDir = path.join(fenceScratch, 'empty');
    fs.mkdirSync(fakePiBin);
    fs.mkdirSync(emptyDir);
    fs.writeFileSync(path.join(fakePiBin, 'pi-launcher.js'), '');
    eq('launcher: found beside pi.cmd', piLauncherFor(path.join(fakePiBin, 'pi.cmd')), path.join(fakePiBin, 'pi-launcher.js'));
    eq('launcher: absent', piLauncherFor(path.join(emptyDir, 'pi.cmd')), null);

    // sandboxCheck with a fake run
    const allTrue = JSON.stringify({ cwdWritable: true, homeRefused: true, internetRefused: true, loopbackOpen: true, childHomeRefused: true });
    // The cache keys Codex by its real long path, case-folded on Windows, however the caller spells it.
    function sandboxCacheKey(codexPath, version) {
      let real = codexPath;
      try { real = fs.realpathSync.native(codexPath); } catch (_) { /* a path that does not exist keys as written */ }
      return (process.platform === 'win32' ? real.toLowerCase() : real) + '|' + version;
    }
    function fakeRun(version, probeJson, counter) {
      return async (command, args) => {
        if (args.includes('--version')) return { code: 0, stdout: version + '\n', stderr: '', timedOut: false };
        if (counter) counter.runs += 1;
        return { code: 0, stdout: probeJson + '\n', stderr: '', timedOut: false };
      };
    }
    eq('check: passes and caches', await sandboxCheck({ codexPath: 'C:\\c\\codex.exe', run: fakeRun('codex-cli 0.167.0', allTrue) }), { ok: true, failed: null, cached: false });
    eq('check: second call is cached', (await sandboxCheck({ codexPath: 'C:\\c\\codex.exe', run: fakeRun('codex-cli 0.167.0', allTrue) })).cached, true);
    eq('check: another version checks again', (await sandboxCheck({ codexPath: 'C:\\c\\codex.exe', run: fakeRun('codex-cli 0.168.0', allTrue) })).cached, false);
    eq('check: the old version stays cached', readSandboxCheck('C:\\c\\codex.exe', 'codex-cli 0.167.0'), { ok: true, failed: null });
    // The server, the supervisor and the tab can find one Codex file through different spellings of its path.
    if (process.platform === 'win32') {
      const spellingFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-long-folder-name-'));
      try {
        const longPath = path.join(spellingFolder, 'codex.exe');
        fs.writeFileSync(longPath, '');
        const shortFolder = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${spellingFolder}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
        const shortPath = path.join(shortFolder, 'codex.exe');
        eq('check: the test really has two spellings of one file', [shortPath.toLowerCase() !== longPath.toLowerCase(), fs.existsSync(shortPath)], [true, true]);
        await sandboxCheck({ codexPath: shortPath, run: fakeRun('codex-cli 0.167.0', allTrue) });
        eq('check: a verdict cached under the 8.3 short spelling is found under the long one', readSandboxCheck(longPath, 'codex-cli 0.167.0'), { ok: true, failed: null });
        eq('check: and under a different letter case', readSandboxCheck(longPath.toUpperCase(), 'codex-cli 0.167.0'), { ok: true, failed: null });
      } finally {
        fs.rmSync(spellingFolder, { recursive: true, force: true });
      }
    }
    // A failed entry is trusted for an hour; a pass for the same Codex version never expires.
    {
      const clockNow = Date.parse('2026-11-08T12:00:00Z');
      const minutesAgo = (minutes) => new Date(clockNow - minutes * 60 * 1000).toISOString();
      const cacheKeyFor = (codexPath) => sandboxCacheKey(codexPath, 'codex-cli 0.167.0');
      fs.writeFileSync(process.env.CONSULT_SANDBOX_CHECK_FILE, JSON.stringify({
        [cacheKeyFor('C:\\ttl\\fresh.exe')]: { ok: false, failed: 'homeRefused', checkedAt: minutesAgo(59) },
        [cacheKeyFor('C:\\ttl\\stale.exe')]: { ok: false, failed: 'homeRefused', checkedAt: minutesAgo(61) },
        [cacheKeyFor('C:\\ttl\\old-pass.exe')]: { ok: true, failed: null, checkedAt: minutesAgo(30 * 24 * 60) }
      }));
      const ttlCounter = { runs: 0 };
      const freshFailure = await sandboxCheck({ codexPath: 'C:\\ttl\\fresh.exe', run: fakeRun('codex-cli 0.167.0', allTrue, ttlCounter), now: () => clockNow });
      eq('check: a failure 59 min old is used', [freshFailure, ttlCounter.runs], [{ ok: false, failed: 'homeRefused', cached: true }, 0]);
      const staleFailure = await sandboxCheck({ codexPath: 'C:\\ttl\\stale.exe', run: fakeRun('codex-cli 0.167.0', allTrue, ttlCounter), now: () => clockNow });
      eq('check: a failure 61 min old is probed again', [staleFailure, ttlCounter.runs], [{ ok: true, failed: null, cached: false }, 1]);
      const oldPass = await sandboxCheck({ codexPath: 'C:\\ttl\\old-pass.exe', run: fakeRun('codex-cli 0.167.0', allTrue, ttlCounter), now: () => clockNow });
      eq('check: a pass 30 days old is still used', [oldPass, ttlCounter.runs], [{ ok: true, failed: null, cached: true }, 1]);
      eq('read: an expired failure reads as no entry', readSandboxCheck('C:\\ttl\\fresh.exe', 'codex-cli 0.167.0', () => clockNow + 2 * 60 * 1000), null);
    }
    // readCachedSandboxCheck: what the cache says of a Codex without probing it. The file's mtime and size find
    // the entry with no `codex --version` run, but only for a real .exe on Windows (R6); with no entry that still
    // counts, Codex is not run at all (R5). `readVersion` is a spy, so each case shows whether Codex would be run.
    {
      const versionSpy = (version) => {
        const spy = { calls: 0 };
        spy.read = async () => { spy.calls += 1; return version; };
        return spy;
      };
      const stampTrusted = process.platform === 'win32';
      const stampedCodex = path.join(fenceScratch, 'stamped-codex.exe');
      fs.writeFileSync(stampedCodex, 'not a real codex');
      const stampedNow = Date.now();
      const stampedCounter = { runs: 0 };
      await sandboxCheck({ codexPath: stampedCodex, run: fakeRun('codex-cli 0.167.0', allTrue, stampedCounter), now: () => stampedNow });
      const exeSpy = versionSpy(null);
      eq('cached: an .exe whose stamp matches is found by the file alone, and Codex is not run',
        [await readCachedSandboxCheck(stampedCodex, { readVersion: exeSpy.read, now: () => stampedNow }), exeSpy.calls],
        [stampTrusted ? { ok: true, failed: null } : null, stampTrusted ? 0 : 1]);
      const writtenEntry = JSON.parse(fs.readFileSync(process.env.CONSULT_SANDBOX_CHECK_FILE, 'utf8'))[sandboxCacheKey(stampedCodex, 'codex-cli 0.167.0')];
      eq('cached: the entry carries the file mtime and size', [writtenEntry.mtimeMs, writtenEntry.size], [fs.statSync(stampedCodex).mtimeMs, fs.statSync(stampedCodex).size]);
      // A .cmd shim stays the same when Codex updates, so its stamp is not trusted: Codex is asked its version.
      const stampedShim = path.join(fenceScratch, 'stamped-codex.cmd');
      fs.writeFileSync(stampedShim, '@echo off\r\n');
      await sandboxCheck({ codexPath: stampedShim, run: fakeRun('codex-cli 0.167.0', allTrue), now: () => stampedNow });
      const shimEntry = JSON.parse(fs.readFileSync(process.env.CONSULT_SANDBOX_CHECK_FILE, 'utf8'))[sandboxCacheKey(stampedShim, 'codex-cli 0.167.0')];
      eq('cached: the .cmd entry carries a matching stamp too', [shimEntry.mtimeMs, shimEntry.size], [fs.statSync(stampedShim).mtimeMs, fs.statSync(stampedShim).size]);
      const updatedShimSpy = versionSpy('codex-cli 0.168.0');
      eq('cached: a .cmd whose stamp matches still asks Codex its version, and an updated Codex finds nothing',
        [await readCachedSandboxCheck(stampedShim, { readVersion: updatedShimSpy.read, now: () => stampedNow }), updatedShimSpy.calls], [null, 1]);
      const sameShimSpy = versionSpy('codex-cli 0.167.0');
      eq('cached: a .cmd at the cached version is found through its version',
        [await readCachedSandboxCheck(stampedShim, { readVersion: sameShimSpy.read, now: () => stampedNow }), sameShimSpy.calls], [{ ok: true, failed: null }, 1]);
      const touched = new Date(Date.now() + 5000);
      fs.utimesSync(stampedCodex, touched, touched);
      const touchedSpy = versionSpy(null);
      eq('cached: an .exe with a changed mtime falls back to its version',
        [await readCachedSandboxCheck(stampedCodex, { readVersion: touchedSpy.read, now: () => stampedNow }), touchedSpy.calls], [null, 1]);
      const missingSpy = versionSpy('codex-cli 0.167.0');
      eq('cached: no entry for the path is null, and Codex is not run',
        [await readCachedSandboxCheck(path.join(fenceScratch, 'no-such-codex.exe'), { readVersion: missingSpy.read }), missingSpy.calls], [null, 0]);
      // Hand-written entries: failed ones expire after an hour, the same as readSandboxCheck.
      const failedCodex = path.join(fenceScratch, 'failed-codex.exe');
      fs.writeFileSync(failedCodex, 'x');
      const failedStat = fs.statSync(failedCodex);
      const failedKey = sandboxCacheKey(failedCodex, 'codex-cli 0.167.0');
      const failedClock = Date.parse('2026-11-08T12:00:00Z');
      const writeFailedEntry = (minutesOld, withStamp) => fs.writeFileSync(process.env.CONSULT_SANDBOX_CHECK_FILE, JSON.stringify({
        [failedKey]: { ok: false, failed: 'homeRefused', checkedAt: new Date(failedClock - minutesOld * 60000).toISOString(), ...(withStamp ? { mtimeMs: failedStat.mtimeMs, size: failedStat.size } : {}) }
      }));
      writeFailedEntry(59, true);
      const freshFailureSpy = versionSpy('codex-cli 0.167.0');
      eq('cached: a failure 59 min old is used',
        [await readCachedSandboxCheck(failedCodex, { readVersion: freshFailureSpy.read, now: () => failedClock }), freshFailureSpy.calls], [{ ok: false, failed: 'homeRefused' }, stampTrusted ? 0 : 1]);
      writeFailedEntry(61, true);
      const expiredSpy = versionSpy('codex-cli 0.167.0');
      eq('cached: only a failure 61 min old is null, and Codex is not run',
        [await readCachedSandboxCheck(failedCodex, { readVersion: expiredSpy.read, now: () => failedClock }), expiredSpy.calls], [null, 0]);
      writeFailedEntry(59, false);
      const unstampedSpy = versionSpy('codex-cli 0.167.0');
      eq('cached: an entry written before the stamp existed is found through the version',
        [await readCachedSandboxCheck(failedCodex, { readVersion: unstampedSpy.read, now: () => failedClock }), unstampedSpy.calls], [{ ok: false, failed: 'homeRefused' }, 1]);
      const silentSpy = versionSpy(null);
      eq('cached: a Codex that does not say its version finds nothing',
        [await readCachedSandboxCheck(failedCodex, { readVersion: silentSpy.read, now: () => failedClock }), silentSpy.calls], [null, 1]);
    }
    const homeWritable = JSON.stringify({ cwdWritable: true, homeRefused: false, internetRefused: true, loopbackOpen: true, childHomeRefused: false });
    eq('check: a failed probe names the first failing check', (await sandboxCheck({ codexPath: 'C:\\d\\codex.exe', run: fakeRun('codex-cli 0.167.0', homeWritable) })).failed, 'homeRefused');
    const timeoutRun = async (command, args) => (args.includes('--version')
      ? { code: 0, stdout: 'codex-cli 0.167.0\n', stderr: '', timedOut: false }
      : { code: null, stdout: '', stderr: '', timedOut: true });
    eq('check: timeout is not cached', [await sandboxCheck({ codexPath: 'C:\\e\\codex.exe', run: timeoutRun }), readSandboxCheck('C:\\e\\codex.exe', 'codex-cli 0.167.0')], [{ ok: false, failed: 'the check took over 60 s', cached: false }, null]);
    // F2/F3/F4: what an inconclusive probe is, and what is a real verdict.
    const inconclusiveCases = [
      ['internet unreachable (null)', JSON.stringify({ cwdWritable: true, homeRefused: true, internetRefused: null, loopbackOpen: true, childHomeRefused: true }), 'internetInconclusive'],
      ['no JSON line at all', 'windows sandbox failed: setup refresh', 'the sandbox could not start the check: ']
    ];
    for (const [label, probeText, wantedFailed] of inconclusiveCases) {
      const codexPath = 'C:\\inc-' + label.length + '\\codex.exe';
      const outcome = await sandboxCheck({ codexPath, run: async (command, args) => (args.includes('--version')
        ? { code: 0, stdout: 'codex-cli 0.167.0\n', stderr: '', timedOut: false }
        : { code: 1, stdout: label === 'no JSON line at all' ? '' : probeText + '\n', stderr: label === 'no JSON line at all' ? probeText + '\nmore' : '', timedOut: false }) });
      eq('check: ' + label + ' is inconclusive and not cached', [outcome.ok, outcome.cached, outcome.failed.startsWith(wantedFailed), readSandboxCheck(codexPath, 'codex-cli 0.167.0')], [false, false, true, null]);
    }
    eq('check: the launch failure line is named', (await sandboxCheck({ codexPath: 'C:\\inc-launch\\codex.exe', run: async (command, args) => (args.includes('--version')
      ? { code: 0, stdout: 'codex-cli 0.167.0\n', stderr: '', timedOut: false }
      : { code: 1, stdout: '', stderr: 'windows sandbox failed: boom\nmore', timedOut: false }) })).failed, 'the sandbox could not start the check: windows sandbox failed: boom');
    const internetReached = JSON.stringify({ cwdWritable: true, homeRefused: true, internetRefused: false, loopbackOpen: true, childHomeRefused: true });
    eq('check: internet reached is a cached failure', [(await sandboxCheck({ codexPath: 'C:\\h\\codex.exe', run: fakeRun('codex-cli 0.167.0', internetReached) })).failed, readSandboxCheck('C:\\h\\codex.exe', 'codex-cli 0.167.0')], ['internetRefused', { ok: false, failed: 'internetRefused' }]);
    const childNotRefused = JSON.stringify({ cwdWritable: true, homeRefused: true, internetRefused: true, loopbackOpen: true, childHomeRefused: false });
    eq('check: a child that is not refused is a cached failure', (await sandboxCheck({ codexPath: 'C:\\i\\codex.exe', run: fakeRun('codex-cli 0.167.0', childNotRefused) })).failed, 'childHomeRefused');
    const counter = { runs: 0 };
    const sharedRun = fakeRun('codex-cli 0.167.0', allTrue, counter);
    await Promise.all([
      sandboxCheck({ codexPath: 'C:\\f\\codex.exe', run: sharedRun }),
      sandboxCheck({ codexPath: 'C:\\f\\codex.exe', run: sharedRun })
    ]);
    eq('check: two at once share one run', counter.runs, 1);
    const probeCalls = [];
    await sandboxCheck({ codexPath: 'C:\\g\\codex.exe', run: async (command, args, options) => {
      if (args.includes('--version')) return { code: 0, stdout: 'codex-cli 0.167.0\n', stderr: '', timedOut: false };
      probeCalls.push({ args, cwd: options.cwd, temp: options.env?.TEMP, tmp: options.env?.TMP, cwdExisted: fs.existsSync(options.cwd), tempExisted: typeof options.env?.TEMP === 'string' && fs.existsSync(options.env.TEMP) });
      return { code: 0, stdout: allTrue + '\n', stderr: '', timedOut: false };
    } });
    const probeCall = probeCalls[0];
    const probeFolder = path.dirname(probeCall.cwd);
    eq('check: the probe runs in <probe>\\work of a temp folder that is removed afterwards', [path.dirname(probeFolder) === os.tmpdir(), path.basename(probeCall.cwd), probeCall.cwdExisted, fs.existsSync(probeFolder)], [true, 'work', true, false]);
    // Ruling 19: the probe runs in the same shape as pi: cwd is its work folder, TEMP and TMP its own temp folder.
    eq('check: the probe gets TEMP and TMP = <probe>\\temp, which exists, beside work', [probeCall.temp === path.join(probeFolder, 'temp'), probeCall.tmp === probeCall.temp, probeCall.tempExisted], [true, true, true]);
    // R3: the probe pins the environment policy the way the pi wrapper does, after sandbox_mode and before `--`.
    eq('check: the probe runs with the pi wrapper\'s environment policy', probeCall.args.slice(0, probeCall.args.indexOf('--') + 1),
      ['sandbox', '-c', 'sandbox_mode=workspace-write', '-c', 'shell_environment_policy.inherit=all', '-c', 'shell_environment_policy.ignore_default_excludes=true', '--']);

    // F6.2: a cache that cannot be written still returns the probe's verdict, uncached.
    {
      const blockingFile = path.join(fenceScratch, 'a file, not a folder');
      fs.writeFileSync(blockingFile, 'x');
      const keptCheckFile = process.env.CONSULT_SANDBOX_CHECK_FILE;
      process.env.CONSULT_SANDBOX_CHECK_FILE = path.join(blockingFile, 'check.json');
      let unwritable;
      try {
        unwritable = await sandboxCheck({ codexPath: 'C:\\unwritable\\codex.exe', run: fakeRun('codex-cli 0.167.0', allTrue) });
      } catch (error) {
        unwritable = 'threw: ' + error.message;
      } finally {
        process.env.CONSULT_SANDBOX_CHECK_FILE = keptCheckFile;
      }
      eq('check: a cache that cannot be written still gives the verdict, uncached', unwritable, { ok: true, failed: null, cached: false });
    }

    // F6.3: a home probe that failed some other way than EPERM/EACCES is inconclusive, not a pass.
    {
      const homeUnclear = JSON.stringify({ cwdWritable: true, homeRefused: null, internetRefused: true, loopbackOpen: true, childHomeRefused: true });
      const unclearOutcome = await sandboxCheck({ codexPath: 'C:\\home-unclear\\codex.exe', run: fakeRun('codex-cli 0.167.0', homeUnclear) });
      eq('check: homeRefused null is inconclusive and not cached', [unclearOutcome, readSandboxCheck('C:\\home-unclear\\codex.exe', 'codex-cli 0.167.0')], [{ ok: false, failed: 'homeInconclusive', cached: false }, null]);
      // The real probe script, with its write to home failing on purpose and the internet stubbed offline (no network is used).
      const probeHome = path.join(fenceScratch, 'probe home');
      fs.mkdirSync(probeHome, { recursive: true });
      const preload = path.join(fenceScratch, 'probe-preload.mjs');
      fs.writeFileSync(preload, [
        "import fs from 'node:fs';",
        "import https from 'node:https';",
        "import os from 'node:os';",
        "import { EventEmitter } from 'node:events';",
        'const wantedCode = process.env.PROBE_TEST_HOME_ERROR;',
        'const originalWrite = fs.writeFileSync;',
        'fs.writeFileSync = function (target, ...rest) {',
        '  if (String(target).startsWith(os.homedir())) { const error = new Error(wantedCode); error.code = wantedCode; throw error; }',
        '  return originalWrite.call(this, target, ...rest);',
        '};',
        "https.get = () => { const request = new EventEmitter(); request.destroy = () => {}; setImmediate(() => request.emit('error', Object.assign(new Error('offline'), { code: 'ENOTFOUND' }))); return request; };"
      ].join('\n'));
      const { fileURLToPath: probeUrlToPath, pathToFileURL: probePathToUrl } = await import('node:url');
      const probeScript = probeUrlToPath(new URL('./lib/sandbox-probe.js', import.meta.url));
      const runProbeScript = (errorCode) => {
        const output = execFileSync(process.execPath, ['--import', probePathToUrl(preload).href, probeScript], {
          cwd: fenceScratch, encoding: 'utf8', timeout: 30000, windowsHide: true,
          env: { ...process.env, USERPROFILE: probeHome, HOME: probeHome, PROBE_TEST_HOME_ERROR: errorCode }
        });
        return JSON.parse(output.trim().split(/\r?\n/).pop());
      };
      eq('probe: a home write refused with EPERM is refused', runProbeScript('EPERM').homeRefused, true);
      eq('probe: a home write refused with EACCES is refused', runProbeScript('EACCES').homeRefused, true);
      eq('probe: a home write that failed with EIO is inconclusive (null), not refused', runProbeScript('EIO').homeRefused, null);
    }

    // pi-fence guard
    async function guardFor(fenceDir, event, cwd) {
      if (fenceDir === undefined) delete process.env.CONSULT_FENCE_DIR; else process.env.CONSULT_FENCE_DIR = fenceDir;
      let handler = null;
      piFenceExtension({ on(name, registered) { if (name === 'tool_call') handler = registered; } });
      return handler(event, cwd ? { cwd } : {});
    }
    const guardWork = path.join(fenceScratch, 'guard work \u0416');
    const guardOther = path.join(fenceScratch, 'guard other');
    fs.mkdirSync(guardWork);
    fs.mkdirSync(guardOther);
    fs.symlinkSync(guardOther, path.join(guardWork, 'link'), 'junction');
    eq('guard: inside, folders not yet existing', await guardFor(guardWork, { toolName: 'write', input: { path: path.join(guardWork, 'sub', 'new', 'f.txt') } }), undefined);
    const dotDot = await guardFor(guardWork, { toolName: 'edit', input: { path: path.join(guardWork, '..', 'guard other', 'f.txt') } });
    eq('guard: .. out is blocked', dotDot.block, true);
    eq('guard: the reason is a sentence naming folder and path', dotDot.reason.startsWith('This task is fenced to ') && dotDot.reason.endsWith(' is outside it.'), true);
    eq('guard: drive case', await guardFor(guardWork, { toolName: 'write', input: { path: guardWork.toUpperCase().replace('\u0416', '\u0436') + '\\f.txt' } }), undefined);
    eq('guard: junction out is blocked', (await guardFor(guardWork, { toolName: 'write', input: { path: path.join(guardWork, 'link', 'f.txt') } })).block, true);
    eq('guard: a sibling sharing a prefix is outside', (await guardFor(guardWork, { toolName: 'write', input: { path: guardWork + ' two\\f.txt' } })).block, true);
    eq('guard: file_path is read too', (await guardFor(guardWork, { toolName: 'write', input: { file_path: path.join(guardOther, 'f.txt') } })).block, true);
    eq('guard: a relative path resolves against cwd', await guardFor(process.cwd(), { toolName: 'write', input: { path: 'new.txt' } }), undefined);
    eq('guard: a fence at the home folder is not treated as empty', await guardFor(os.homedir(), { toolName: 'write', input: { path: path.join(os.homedir(), 'x', 'f.txt') } }), undefined);
    eq('guard: bash allowed', await guardFor(guardWork, { toolName: 'bash', input: { command: 'echo > C:\\x' } }), undefined);
    eq('guard: read allowed', await guardFor(guardWork, { toolName: 'read', input: { path: 'C:\\x' } }), undefined);
    eq('guard: no fence dir blocks writes', (await guardFor(undefined, { toolName: 'write', input: { path: path.join(guardWork, 'f.txt') } })).block, true);
    // F1: pi normalises a path before writing; the guard must see what pi will write.
    const homeFile = await guardFor(guardWork, { toolName: 'write', input: { path: '~/x.txt' } });
    eq('guard: ~/x.txt is home, outside', homeFile.block, true);
    eq('guard: ~\\x.txt is home, outside', (await guardFor(guardWork, { toolName: 'write', input: { path: '~\\x.txt' } })).block, true);
    eq('guard: a bare ~ is home, outside', (await guardFor(guardWork, { toolName: 'edit', input: { path: '~' } })).block, true);
    eq('guard: @ then an outside path is blocked', (await guardFor(guardWork, { toolName: 'write', input: { path: '@' + path.join(guardOther, 'x.txt') } })).block, true);
    eq('guard: @ then a relative inside path is allowed', await guardFor(guardWork, { toolName: 'write', input: { path: '@sub\\x.txt' } }, guardWork), undefined);
    eq('guard: @@ is refused outright', (await guardFor(guardWork, { toolName: 'write', input: { path: '@@x.txt' } })).block, true);
    eq('guard: a non-breaking space is a plain space', await guardFor(guardWork, { toolName: 'write', input: { path: path.join(guardWork, 'a\u00A0b', 'x.txt') } }), undefined);
    eq('guard: Git Bash /c/ style outside paths are blocked', (await guardFor(guardWork, { toolName: 'write', input: { path: '/c/Windows/x.txt' } })).block, true);
    eq('guard: a file:// URL outside is blocked', (await guardFor(guardWork, { toolName: 'write', input: { path: 'file:///' + path.join(guardOther, 'x.txt').replaceAll('\\', '/') } })).block, true);
    // F7: a dangling link inside the fence that points outside is not "missing".
    const danglingTarget = path.join(fenceScratch, 'does not exist yet');
    fs.symlinkSync(danglingTarget, path.join(guardWork, 'dangling'), 'junction');
    eq('guard: a dangling junction out is blocked', (await guardFor(guardWork, { toolName: 'write', input: { path: path.join(guardWork, 'dangling', 'f.txt') } })).block, true);
    eq('guard: the dangling junction itself is blocked', (await guardFor(guardWork, { toolName: 'write', input: { path: path.join(guardWork, 'dangling') } })).block, true);
    eq('guard: a write with no path is blocked', (await guardFor(guardWork, { toolName: 'write', input: {} })).block, true);
    // F1 (Ruling 15): consult's own files are refused even inside the work folder (CONSULT_FENCE_PROTECTED, a JSON array).
    const consultData = path.join(guardWork, 'consult data');
    const consultProjects = path.join(guardWork, 'consult-projects.json');
    process.env.CONSULT_FENCE_PROTECTED = JSON.stringify([consultData, consultProjects]);
    const stateWrite = await guardFor(guardWork, { toolName: 'write', input: { path: path.join(consultData, 'tasks', 'abc123', 'state.json') } });
    eq('guard: a write into a protected folder inside the work folder is blocked, naming consult\'s files', [stateWrite?.block, /consult's own files/.test(stateWrite?.reason ?? '')], [true, true]);
    eq('guard: the protected projects file is blocked, in any case', (await guardFor(guardWork, { toolName: 'edit', input: { path: consultProjects.toUpperCase().replace('Ж', 'ж') } }))?.block, true);
    eq('guard: a relative path into a protected folder is blocked', (await guardFor(guardWork, { toolName: 'write', input: { path: 'consult data\\index.json' } }, guardWork))?.block, true);
    eq('guard: the rest of the work folder is still writable', await guardFor(guardWork, { toolName: 'write', input: { path: path.join(guardWork, 'consult data two', 'f.txt') } }), undefined);
    process.env.CONSULT_FENCE_PROTECTED = JSON.stringify([fenceScratch]);
    eq('guard: a protected folder that holds the work folder (a copy under consult\'s data) leaves the work folder writable', await guardFor(guardWork, { toolName: 'write', input: { path: path.join(guardWork, 'f.txt') } }), undefined);
    process.env.CONSULT_FENCE_PROTECTED = JSON.stringify([guardWork]);
    eq('guard: a protected path equal to the work folder blocks every write in it', (await guardFor(guardWork, { toolName: 'write', input: { path: path.join(guardWork, 'f.txt') } }))?.block, true);
    process.env.CONSULT_FENCE_PROTECTED = 'not json';
    eq('guard: an unreadable protected list blocks writes (fails closed)', (await guardFor(guardWork, { toolName: 'write', input: { path: path.join(guardWork, 'f.txt') } }))?.block, true);
    delete process.env.CONSULT_FENCE_PROTECTED;
  } finally {
    delete process.env.CONSULT_FENCE_PROTECTED;
    if (previousCheckFile === undefined) delete process.env.CONSULT_SANDBOX_CHECK_FILE; else process.env.CONSULT_SANDBOX_CHECK_FILE = previousCheckFile;
    if (previousFenceDir === undefined) delete process.env.CONSULT_FENCE_DIR; else process.env.CONSULT_FENCE_DIR = previousFenceDir;
    if (previousPiTempRoot === undefined) delete process.env.CONSULT_PI_TEMP_ROOT; else process.env.CONSULT_PI_TEMP_ROOT = previousPiTempRoot;
    removePiTemp(fenceTaskId);
    fs.rmSync(fenceScratch, { recursive: true, force: true });
  }
}

// --- F3 (Ruling 17): a test server gets no Codex for the fence and a scratch sandbox-check file by default ---
{
  const { isolatedServerEnv } = await import('./test-helpers.js');
  const namesToClear = ['CONSULT_DELEGATE_TEST_NO_CODEX', 'CONSULT_SANDBOX_CHECK_FILE'];
  const kept = {};
  for (const name of namesToClear) {
    kept[name] = process.env[name];
    delete process.env[name];
  }
  const serverScratch = path.join(os.tmpdir(), 'consult-isolated-env-test');
  try {
    if (typeof isolatedServerEnv !== 'function') {
      eq('isolatedServerEnv: exported', typeof isolatedServerEnv, 'function');
    } else {
      const defaults = isolatedServerEnv(serverScratch);
      eq('isolatedServerEnv: no Codex for the fence, and the check file is in the scratch folder', [defaults.CONSULT_DELEGATE_TEST_NO_CODEX, defaults.CONSULT_SANDBOX_CHECK_FILE], ['1', path.join(serverScratch, 'consult-sandbox-check.json')]);
      process.env.CONSULT_DELEGATE_TEST_NO_CODEX = '';
      process.env.CONSULT_SANDBOX_CHECK_FILE = 'X:\\chosen.json';
      const overridden = isolatedServerEnv(serverScratch);
      eq('isolatedServerEnv: a caller\'s own values win', [overridden.CONSULT_DELEGATE_TEST_NO_CODEX, overridden.CONSULT_SANDBOX_CHECK_FILE], ['', 'X:\\chosen.json']);
    }
  } finally {
    for (const name of namesToClear) {
      if (kept[name] === undefined) delete process.env[name]; else process.env[name] = kept[name];
    }
  }
}

// The run's own scratch check file goes with it.
if (ownsCheckFile) fs.rmSync(topLevelCheckFile, { force: true });

console.log('\n' + (failed === 0 ? 'ALL PASSED' : `${failed} FAIL(S)`));
process.exit(failed === 0 ? 0 : 1);
