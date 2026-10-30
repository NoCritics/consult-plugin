// Antigravity CLI (`agy`) wrapper -- the default Google-side provider. The
// legacy `gemini` CLI stays available but opt-in: its free tier no longer
// works for individual accounts (IneligibleTierError / UNSUPPORTED_CLIENT).
//
// agy emits one JSON envelope on stdout:
//   { conversation_id, status, response, duration_seconds, num_turns,
//     usage: { input_tokens, output_tokens, thinking_tokens,
//              cache_read_tokens, total_tokens },
//     denied_actions?: [{ action, display_name }],
//     structured_output?, json_schema? }                 // with --json-schema
//
// Headless behaviours this wrapper has to handle (see CHANGELOG for when
// each appeared):
//   - A `--print-timeout` expiry returns status=SUCCESS with PARTIAL text,
//     exit 0, and a stderr warning. See PARTIAL_OUTPUT_RE.
//   - Tools it cannot get approval for are auto-denied and listed in
//     `denied_actions`; a fully refused turn has an empty `response`.
//   - Failures are structured: exit 1 + an envelope with status "ERROR", or
//     exit 3 + an `AGY_ERROR: {...}` stderr line (with the partial answer in
//     the envelope when it failed mid-stream). See agyFailure().
//   - Without `--print-timeout` a headless run has no time limit, so we always
//     pass one.
//
// agy is NOT read-only, and consult cannot make it so. What governs writes is
// agy's own ~/.gemini/antigravity-cli/settings.json:
//   - inside any `trustedWorkspaces` entry, headless agy creates and edits
//     files WITHOUT asking, whatever cwd it was launched from; elsewhere the
//     write is auto-denied. Shell commands are auto-denied everywhere. Reads
//     work everywhere (the image feature relies on that).
//   - `"permissions": { "deny": ["write_file(**)", "command(**)"] }` there
//     blocks writes even inside trusted workspaces.
//   - There is no per-invocation override: no flag, and JETSKI_APP_DATA_DIR is
//     not honoured. `--mode plan` and `--sandbox` do not prevent writes.
// So consult steers (AGY_ANSWER_ONLY_PREAMBLE) and reports (agyWritePosture).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './spawn-cli.js';
import {
  validateModel, validateSessionId, requireString,
  scrubPii, extractJson, removeTree, incompleteError
} from './util.js';
import { loadImages, detectImageType, readDimensions } from './image.js';

// What agy 1.3 accepts. Each model supports a subset (gemini-3.8-flash: low,
// medium, high) and agy rejects the rest with an error listing them.
export const AGY_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// Prepended to every agy prompt. Not enforcement -- it steers a model that has
// write tools toward answering in text, the only thing consult wants from it.
export const AGY_ANSWER_ONLY_PREAMBLE =
  'Answer in text only. Do not create, modify or delete any files and do not run commands, ' +
  'even if the question mentions files -- everything you need is in this message.\n\n';

// The stderr marker of a print-timeout partial, e.g.
//   [agy] print timeout after 2s with turn in progress; returning partial output
// A truncated answer returned as complete is worse than a clean failure (a
// council judge would rank a half-argument), so it is turned back into the
// timeout it is.
const PARTIAL_OUTPUT_RE = /print timeout after .*?(returning partial output|turn in progress)/i;

export function isPartialOutput(stderr) {
  return typeof stderr === 'string' && PARTIAL_OUTPUT_RE.test(stderr);
}

// Human-readable list of auto-denied tool actions, e.g. "RunCommand (command)".
export function describeDeniedActions(parsed) {
  const list = Array.isArray(parsed?.denied_actions) ? parsed.denied_actions : [];
  return list
    .map(d => d && (d.display_name || d.action) ? `${d.display_name || d.action}${d.display_name && d.action ? ` (${d.action})` : ''}` : null)
    .filter(Boolean);
}

export function validateAgyEffort(effort) {
  if (effort && !AGY_EFFORTS.includes(effort)) {
    throw new Error(`Invalid agy effort: ${JSON.stringify(effort)}. Allowed: ${AGY_EFFORTS.join(' | ')}`);
  }
}

// Give agy its own deadline slightly inside ours, so it exits cleanly and we
// get its structured output instead of tree-killing it mid-write. agy's clock
// starts after its own start-up (a few seconds), so the margin is 10% but at
// least 8s: a 30s call (timeout_s's minimum) gives agy 22s and still ends on
// agy's deadline, with its partial. The 10s floor keeps a tiny timeout_ms from
// producing "0s".
export function printTimeoutSeconds(timeout_ms) {
  const margin_ms = Math.max(timeout_ms * 0.1, 8000);
  return Math.max(10, Math.floor((timeout_ms - margin_ms) / 1000));
}

// No `-p` flag: the prompt goes in via stdin and print mode is inferred from
// the piped stdin (`-p ""` with stdin fails with "empty prompt"). Prompts carry
// inlined files and can be hundreds of KB, past the Windows argv limit.
// runCli always pipes stdin, so agy can never drop into interactive mode.
//
// `--disable-slash-commands`: otherwise a prompt whose first line starts with
// `/` ("/etc/hosts has ...") is expanded as an agy slash command or skill and
// never reaches the model.
function buildArgs({ model, effort, conversation_id, timeout_ms }) {
  const args = ['--output-format', 'json', '--disable-slash-commands'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (conversation_id) args.push('--conversation', conversation_id);
  args.push('--print-timeout', `${printTimeoutSeconds(timeout_ms)}s`);
  return args;
}

// The `AGY_ERROR: {...}` stderr line of an agent/model-API failure. Loose about
// fields on purpose: the live shape is only reachable by breaking the backend.
const AGY_ERROR_LINE_RE = /^\s*AGY_ERROR:\s*(\{.*\})\s*$/m;
export function parseAgyErrorLine(stderr) {
  if (typeof stderr !== 'string') return null;
  const m = AGY_ERROR_LINE_RE.exec(stderr);
  if (!m) return null;
  try { const o = JSON.parse(m[1]); return o && typeof o === 'object' ? o : null; }
  catch (_) { return null; }
}

// Turn a non-zero agy exit into the best error available, richest first:
//   1. AGY_ERROR line (exit 3), with the partial answer if one was streamed
//   2. JSON envelope with status != SUCCESS (exit 1) -- parseAgyResult throws it
//   3. plain stderr tail
export function agyFailure({ stdout, stderr, code, label }) {
  const structured = parseAgyErrorLine(stderr);
  if (structured) {
    const msg = structured.message || structured.error || structured.detail || JSON.stringify(structured).slice(0, 400);
    const bits = [
      structured.status && `status=${structured.status}`,
      (structured.code ?? structured.http_code ?? structured.grpc_code) != null && `code=${structured.code ?? structured.http_code ?? structured.grpc_code}`,
      typeof structured.retryable === 'boolean' && `retryable=${structured.retryable}`,
      (structured.error_id || structured.id) && `id=${structured.error_id || structured.id}`
    ].filter(Boolean).join(' ');
    const summary = `${msg}${bits ? ` [${bits}]` : ''}`;
    let partial = '';
    try { partial = String(extractJson(stdout)?.response || '').trim(); } catch (_) { /* no envelope */ }
    const err = partial
      ? incompleteError({
          provider: 'agy',
          reason: `failed mid-answer (exit ${code}): ${summary}`,
          partial,
          partial_label: 'answer cut off by an error',
          note: structured.retryable === true ? 'agy marked this error retryable; retrying the same call may succeed.' : undefined
        })
      : new Error(scrubPii(`${label} failed (exit ${code}): ${summary}`));
    err.kind = structured.retryable === true ? 'retryable' : 'nonzero_exit';
    err.agy_error = structured;
    return err;
  }
  try { parseAgyResult(stdout, stderr); }   // throws on status=ERROR envelope
  catch (e) { return e; }
  return new Error(scrubPii(`${label} exited with code ${code}. stderr:\n${stderr.slice(-2000)}`));
}

// Parse agy's JSON envelope and enforce the `status` contract. A non-SUCCESS
// status with a populated `response` is still a failure.
export function parseAgyResult(stdout, stderr, printTimeoutMs = null) {
  let parsed;
  try { parsed = extractJson(stdout); }
  catch (eStdout) {
    if (eStdout.kind !== 'no_json') {
      throw new Error(scrubPii(`agy ${eStdout.message}. stdout tail:\n${stdout.slice(-2000)}`));
    }
    const combined = stdout + '\n' + stderr;
    try { parsed = extractJson(combined); }
    catch (_) {
      throw new Error(scrubPii(`agy produced no JSON output. Output tail:\n${combined.slice(-2000)}`));
    }
  }

  const status = parsed.status ?? 'UNKNOWN';
  if (status !== 'SUCCESS') {
    const detail = parsed.error || parsed.message || parsed.response || JSON.stringify(parsed).slice(0, 500);
    throw new Error(scrubPii(`agy returned status=${status}: ${detail}`));
  }
  if (typeof parsed.response !== 'string') {
    throw new Error(scrubPii(`agy JSON missing .response field: ${JSON.stringify(parsed).slice(0, 500)}`));
  }
  if (isPartialOutput(stderr)) {
    // Same shape as the codex timeout (util.js incompleteError), but agy's
    // partial really is the answer cut off mid-stream.
    throw incompleteError({
      provider: 'agy',
      timeout_ms: printTimeoutMs,
      setting: 'agy_timeout_ms',
      partial: parsed.response,
      partial_label: 'answer cut off mid-stream'
    });
  }
  if (!parsed.response.trim()) {
    // An empty SUCCESS means agy declined to act. Passing '' back would look
    // like the model had nothing to say.
    const denied = describeDeniedActions(parsed);
    throw new Error(
      'agy returned an empty response. This usually means it declined to act -- ' +
      'agy answers questions, but will not perform file edits or shell actions without approval, ' +
      'and cannot ask for it in headless mode. ' +
      (denied.length ? `Auto-denied: ${denied.join(', ')}. ` : '') +
      'Rephrase as a question, or use a tool that can act.'
    );
  }
  return parsed;
}

// agy reports its own duration; prefer it over our wall-clock, which includes
// process spawn.
function shape(parsed, fallbackLatency, model) {
  const denied = describeDeniedActions(parsed);
  return {
    response: parsed.response.trim(),
    // An answer can still have had a tool auto-denied along the way (it
    // answered from memory after being refused a command). Say so.
    ...(denied.length ? { denied_actions: denied } : {}),
    model: parsed.model || model || '(agy default)',
    session_id: parsed.conversation_id ?? null,
    latency_ms: typeof parsed.duration_seconds === 'number'
      ? Math.round(parsed.duration_seconds * 1000)
      : fallbackLatency,
    num_turns: parsed.num_turns ?? null,
    tokens: {
      input: parsed.usage?.input_tokens ?? null,
      output: parsed.usage?.output_tokens ?? null,
      thinking: parsed.usage?.thinking_tokens ?? null,
      cache_read: parsed.usage?.cache_read_tokens ?? null,
      total: parsed.usage?.total_tokens ?? null
    }
  };
}

// agy has no image flag, but it opens an image by absolute path on its own,
// in one turn, even outside the cwd. So "attaching" means naming the path.
function withImagePaths(prompt, loaded) {
  if (!loaded.length) return prompt;
  const list = loaded
    .map(i => `- ${i.path}${i.width && i.height ? ` (${i.type}, ${i.width}x${i.height})` : ` (${i.type})`}`)
    .join('\n');
  return (
    `View the following image file${loaded.length > 1 ? 's' : ''} and use them to answer:\n${list}\n\n${prompt}`
  );
}

// `discardConversation`: a one-shot ask has nothing to resume, so delete the
// conversation agy saved (~600KB each), as codex's --ephemeral does for codex.
// Runs on success and failure alike, from whatever envelope agy printed. A
// call killed before agy printed one (timeout, cancel) still leaves its files.
// `beforeDiscard(conversationId)` runs while the conversation's files still
// exist, on success and failure alike (a print-timeout can come after images
// were saved); image generation copies its results out there. It must not
// throw. Returning true keeps the conversation: a failed copy leaves the
// originals as the only copy of paid-for images.
async function runAgy({ args, prompt, timeout_ms, label, discardConversation = false, preamble = AGY_ANSWER_ONLY_PREAMBLE, beforeDiscard }) {
  let stdout = '';
  try {
    const run = await runCli({
      cmd: 'agy', args, prompt: preamble + prompt, timeout_ms, label, allowNonZeroExit: true
    });
    stdout = run.stdout;
    if (run.code !== 0) throw agyFailure({ stdout: run.stdout, stderr: run.stderr, code: run.code, label });
    // The call's own limit, not agy's earlier deadline inside it: that is the
    // number the caller set, and the one a retry should double.
    return { parsed: parseAgyResult(run.stdout, run.stderr, timeout_ms), latency_ms: run.latency_ms };
  } catch (e) {
    if (!stdout && typeof e?.stdout === 'string') stdout = e.stdout;
    throw e;
  } finally {
    await finishConversation({ stdout, beforeDiscard, discardConversation, discard: discardAgyConversation });
  }
}

// What runAgy does with the conversation once the call is over: let
// beforeDiscard copy results out, then delete the conversation unless
// beforeDiscard returned true to keep it. `discard` is injectable for tests.
export async function finishConversation({ stdout, beforeDiscard, discardConversation, discard }) {
  let keepConversation = false;
  if (beforeDiscard) {
    const id = conversationIdFrom(stdout);
    if (id) keepConversation = await beforeDiscard(id) === true;
  }
  if (discardConversation && !keepConversation) await discard(stdout);
}

export function conversationIdFrom(stdout) {
  try {
    const id = extractJson(stdout)?.conversation_id;
    if (typeof id !== 'string' || !id) return null;
    validateSessionId(id);
    return id;
  } catch (_) {
    return null;
  }
}

// Best effort: a failed delete must never turn a good answer into an error.
async function discardAgyConversation(stdout) {
  const id = conversationIdFrom(stdout);
  if (!id) return;
  try {
    await agyChatEnd({ session_id: id });
  } catch (_) {}
}

export async function askAgy(options) {
  const result = await runAgyTurn({ ...options, discardConversation: true });
  // The conversation is gone, so there is no session to hand back.
  delete result.session_id;
  return result;
}

// --- image generation --------------------------------------------------------
// agy 1.2+ hands image requests to a built-in `image-generator` subagent, whose
// generate_image tool makes one ~1K JPEG per call (1024x1024 at 1:1, 768x1376
// at 9:16, 1376x768 at 16:9; about a minute each) and saves it into the
// conversation's brain/ directory. consult copies them out before deleting the
// conversation.
//
// generate_image (agy 1.4.2) takes Prompt, AspectRatio (the seven below),
// ImagePaths (at most 3: more are dropped without a word) and ImageName. The
// subagent's tier (invoke_subagent's Model) picks the text model that writes
// the image prompt and judges the attempts, not the image model. None of it
// has a CLI flag, so the settings travel in the prompt; agy follows them.

export const AGY_IMAGE_PREAMBLE =
  'Generate the image(s) described below with your image generation tool. ' +
  'Do not create, modify or delete any other files and do not run commands. ' +
  'When done, reply briefly with one line per image giving its absolute path.\n\n';

export const AGY_IMAGE_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', 'auto'];
// flash_lite is left out: too weak to judge the images it makes.
export const AGY_IMAGE_TIERS = ['inherit', 'flash', 'pro'];
const AGY_IMAGE_MAX_REFERENCES = 3;
const AGY_IMAGE_MAX_COUNT = 4;
const AGY_IMAGE_EXTRA_IMAGE_MS = 120000;
const AGY_IMAGE_MAX_TIMEOUT_MS = 1800000;

// The call's image options, checked before anything is read or run. The
// aspect ratio falls back to the agy_image_aspect_ratio setting, then 1:1:
// left to itself, agy picks a ratio from the content.
export function imageOptions({ aspect_ratio, tier, count, exact_prompt, images } = {}, settings = {}) {
  const aspectRatio = aspect_ratio ?? settings.agy_image_aspect_ratio ?? '1:1';
  if (!AGY_IMAGE_ASPECT_RATIOS.includes(aspectRatio)) {
    throw new Error(`aspect_ratio must be one of ${AGY_IMAGE_ASPECT_RATIOS.join(', ')}; got ${JSON.stringify(aspectRatio)}.`);
  }
  const chosenTier = tier ?? 'inherit';
  if (!AGY_IMAGE_TIERS.includes(chosenTier)) {
    throw new Error(`tier must be one of ${AGY_IMAGE_TIERS.join(', ')}; got ${JSON.stringify(chosenTier)}.`);
  }
  const chosenCount = count ?? 1;
  if (!Number.isInteger(chosenCount) || chosenCount < 1 || chosenCount > AGY_IMAGE_MAX_COUNT) {
    throw new Error(`count must be a whole number from 1 to ${AGY_IMAGE_MAX_COUNT}; got ${JSON.stringify(chosenCount)}.`);
  }
  const exactPrompt = exact_prompt ?? false;
  if (typeof exactPrompt !== 'boolean') {
    throw new Error(`exact_prompt must be true or false; got ${JSON.stringify(exactPrompt)}.`);
  }
  if (Array.isArray(images) && images.length > AGY_IMAGE_MAX_REFERENCES) {
    throw new Error(
      `agy uses at most ${AGY_IMAGE_MAX_REFERENCES} reference images and drops the rest without saying which; ` +
      `got ${images.length}. Pass the ${AGY_IMAGE_MAX_REFERENCES} that matter most.`
    );
  }
  return { aspect_ratio: aspectRatio, tier: chosenTier, count: chosenCount, exact_prompt: exactPrompt };
}

// The "Image settings" lines put before the prompt.
export function imageSettingsBlock({ aspect_ratio, tier, count, exact_prompt }) {
  const lines = [`Make exactly ${count} image${count === 1 ? '' : 's'}, each with a separate generate_image call.`];
  if (tier !== 'inherit') lines.push(`Run the image-generator subagent at the "${tier}" tier.`);
  if (aspect_ratio !== 'auto') lines.push(`Set AspectRatio to "${aspect_ratio}".`);
  if (exact_prompt) lines.push('Use the prompt below as the generate_image Prompt, word for word, with nothing added or changed.');
  return `Image settings:\n${lines.map(line => `- ${line}`).join('\n')}\n\n`;
}

// The default limit: two minutes more for each image past the first, up to
// 30 minutes. A per-call timeout_s replaces it.
export function agyImageTimeoutMs(baseMs, count) {
  return Math.min(baseMs + (count - 1) * AGY_IMAGE_EXTRA_IMAGE_MS, AGY_IMAGE_MAX_TIMEOUT_MS);
}

const AGY_IMAGE_DIR_NAME = 'consult-images';

// Folders that are never a project: app installs and system locations. Claude
// Desktop 2.37 starts the server in its own install folder
// (%LOCALAPPDATA%\AnthropicClaude\app-<version>), which an update replaces.
export function hostAppDirs(env = process.env, home = os.homedir()) {
  const dirs = [env.LOCALAPPDATA, env.APPDATA, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.SystemRoot];
  if (process.platform === 'darwin') dirs.push('/Applications', '/System', path.join(home, 'Library'));
  if (process.platform === 'linux') dirs.push('/usr', '/opt', '/snap');
  return dirs.filter(Boolean);
}

// Where generated images land when the caller names no folder: the project's
// consult-images/. A host that starts the server in the home directory, at a
// drive root, inside the server's own folder or inside an app/system folder
// (Claude Desktop) has no project, so those use ~/Pictures/consult-images.
export function agyImageOutputDir({ output_dir, cwd = process.cwd(), home = os.homedir(), serverDir, appDirs = hostAppDirs() } = {}) {
  if (output_dir) {
    requireString('output_dir', output_dir);
    return path.resolve(cwd, output_dir);
  }
  const here = path.resolve(cwd);
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const isInside = (dir) => (norm(here) + path.sep).startsWith(norm(dir) + path.sep);
  const isRoot = path.parse(here).root.replace(/[\\/]+$/, '').toLowerCase() === norm(here);
  const noProject = isRoot || norm(here) === norm(home) ||
    (serverDir && isInside(serverDir)) || appDirs.some(isInside);
  if (noProject) return path.join(home, 'Pictures', AGY_IMAGE_DIR_NAME);
  return path.join(here, AGY_IMAGE_DIR_NAME);
}

function withReferenceImages(prompt, loaded) {
  if (!loaded.length) return prompt;
  const list = loaded
    .map(i => `- ${i.path}${i.width && i.height ? ` (${i.type}, ${i.width}x${i.height})` : ` (${i.type})`}`)
    .join('\n');
  return `Use the following image file${loaded.length > 1 ? 's' : ''} as reference:\n${list}\n\n${prompt}`;
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

// The image files saved in the top level of a conversation's brain/ directory,
// by file signature, once per distinct content. Subfolders are agy's own:
// .tempmediaStorage/ holds copies of every image the agent viewed, reference
// images included. `skipHashes` also drops a reference saved at the top level.
export function findGeneratedImages(brainDir, skipHashes = new Set()) {
  let entries;
  try { entries = fs.readdirSync(brainDir, { withFileTypes: true }); } catch (_) { return []; }
  const found = [];
  const seen = new Set(skipHashes);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(brainDir, entry.name);
    let buffer;
    try { buffer = fs.readFileSync(full); } catch (_) { continue; }
    const detected = detectImageType(buffer);
    if (!detected) continue;
    const hash = sha1(buffer);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const dims = readDimensions(buffer, detected.type) || {};
    found.push({ source: full, type: detected.type, bytes: buffer.length, width: dims.width ?? null, height: dims.height ?? null, mtimeMs: fs.statSync(full).mtimeMs });
  }
  found.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return found;
}

// Copy without overwriting: name.jpg, name-1.jpg, name-2.jpg ...
export function copyImagesTo(found, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  for (const image of found) {
    const ext = path.extname(image.source);
    const stem = path.basename(image.source, ext);
    let target = path.join(outDir, stem + ext);
    let n = 1;
    while (fs.existsSync(target)) {
      target = path.join(outDir, `${stem}-${n}${ext}`);
      n++;
    }
    fs.copyFileSync(image.source, target, fs.constants.COPYFILE_EXCL);
    copied.push({ path: target, type: image.type, width: image.width, height: image.height, bytes: image.bytes, source: image.source });
  }
  return copied;
}

// agy's reply names the brain/ paths, which are deleted with the conversation.
// Point it at the copies instead (backslash and forward-slash spellings).
export function retargetPaths(text, copied) {
  let out = text;
  for (const image of copied) {
    const forms = [
      [image.source, image.path],
      [image.source.replace(/\\/g, '/'), image.path.replace(/\\/g, '/')]
    ];
    for (const [from, to] of forms) out = out.split(from).join(to);
  }
  return out;
}

export async function agyGenerateImage({ prompt, model, effort, images, output_dir, serverDir, aspect_ratio, tier, count, exact_prompt, settings = {}, timeout_ms, base_timeout_ms = 300000 }) {
  requireString('prompt', prompt);
  validateModel(model);
  validateAgyEffort(effort);
  const requested = imageOptions({ aspect_ratio, tier, count, exact_prompt, images }, settings);
  const limitMs = timeout_ms ?? agyImageTimeoutMs(base_timeout_ms, requested.count);
  const outDir = agyImageOutputDir({ output_dir, serverDir });
  const references = images?.length ? loadImages(images) : [];
  // Fail on an unwritable folder now, not after two minutes of generation
  // whose results would then be deleted with the conversation.
  try { fs.mkdirSync(outDir, { recursive: true }); }
  catch (e) { throw new Error(`Cannot create the output folder ${outDir}: ${e.code || e.message}`); }
  const referenceHashes = new Set(references.map(r => sha1(r.buffer)));

  let copied = [];
  let copyError = null;
  let originalsDir = null;
  let run = null;
  let failure = null;
  try {
    run = await runAgy({
      args: buildArgs({ model, effort, timeout_ms: limitMs }),
      prompt: imageSettingsBlock(requested) + withReferenceImages(prompt, references),
      preamble: AGY_IMAGE_PREAMBLE,
      timeout_ms: limitMs,
      label: 'agy image',
      discardConversation: true,
      beforeDiscard: (id) => {
        const saved = saveConversationImages({ brainDir: path.join(agyStoreRoot(), 'brain', id), referenceHashes, outDir });
        ({ copied, copyError, originalsDir } = saved);
        return saved.keepOriginals;
      }
    });
  } catch (e) {
    failure = e;
  }
  return finishImageCall({ copied, copyError, originalsDir, failure, parsed: run?.parsed, latency_ms: run?.latency_ms, model, outDir, requested });
}

// Copies a conversation's generated images out before it is discarded. A copy
// error is returned, not thrown, with keepOriginals set so the caller leaves
// the conversation in place and can say where the images still are.
export function saveConversationImages({ brainDir, referenceHashes, outDir }) {
  let copied = [];
  try {
    const found = findGeneratedImages(brainDir, referenceHashes);
    if (found.length) copied = copyImagesTo(found, outDir);
  } catch (copyError) {
    return { copied, copyError, originalsDir: brainDir, keepOriginals: true };
  }
  return { copied, copyError: null, originalsDir: brainDir, keepOriginals: false };
}

// The result of an image call, decided from what was copied out and how agy
// ended. Images that agy saved before a print-timeout or a failure are kept
// and returned with a warning, rather than lost behind the error.
// `requested` (the call's image options) is echoed back, and a count agy fell
// short of is a warning: a retry or a smaller ask may be what is needed.
export function finishImageCall({ copied, copyError, originalsDir, failure, parsed, latency_ms, model, outDir, requested }) {
  if (copyError && !copied.length) {
    throw new Error(`agy made images but copying them to ${outDir} failed: ${copyError.code || copyError.message}. The originals are still in ${originalsDir}`);
  }
  const images = copied.map(({ source, ...image }) => image);
  const asked = requested ? { aspect_ratio: requested.aspect_ratio, tier: requested.tier, count: requested.count } : {};
  if (failure) {
    if (!copied.length) throw failure;
    // The shared timeout error names ask_agy's setting; images have their own.
    const reason = String(failure.message || failure).split('\n')[0].slice(0, 300)
      .replace(/`agy_timeout_ms`/g, '`agy_image_timeout_ms`');
    return {
      images,
      output_dir: outDir,
      warning: scrubPii(`agy did not finish cleanly (${reason}). The ${copied.length} image(s) it had already saved are kept; it may have meant to make more.`),
      model: model || '(agy default)',
      ...asked
    };
  }
  const result = shape(parsed, latency_ms, model);
  if (!copied.length) {
    const denied = describeDeniedActions(parsed);
    throw new Error(scrubPii(
      'agy finished without saving an image. ' +
      (denied.length ? `Auto-denied: ${denied.join(', ')}. ` : '') +
      `Its reply: ${result.response.slice(0, 1500)}`
    ));
  }
  const isShort = requested && copied.length < requested.count;
  return {
    images,
    output_dir: outDir,
    agy_reply: retargetPaths(result.response, copied),
    ...(isShort ? { warning: `asked for ${requested.count} images, agy saved ${copied.length}.` } : {}),
    ...(result.denied_actions ? { denied_actions: result.denied_actions } : {}),
    model: result.model,
    latency_ms: result.latency_ms,
    tokens: result.tokens,
    ...asked
  };
}

async function runAgyTurn({ prompt, model, effort, images, timeout_ms = 180000, discardConversation = false }) {
  requireString('prompt', prompt);
  validateModel(model);
  validateAgyEffort(effort);

  // Validate before spawning: agy would otherwise report a missing file as
  // prose in its answer, indistinguishable from a real reply.
  const loaded = images?.length ? loadImages(images) : [];

  const { parsed, latency_ms } = await runAgy({
    args: buildArgs({ model, effort, timeout_ms }),
    prompt: withImagePaths(prompt, loaded),
    timeout_ms,
    label: 'agy',
    discardConversation
  });
  const result = shape(parsed, latency_ms, model);
  if (loaded.length) {
    result.images = loaded.map(i => ({ path: i.path, type: i.type, width: i.width, height: i.height }));
  }
  return result;
}

export async function agyChatStart({ prompt, model, effort, timeout_ms = 180000 }) {
  const result = await runAgyTurn({ prompt, model, effort, timeout_ms });
  if (!result.session_id) {
    throw new Error('agy returned no conversation_id. Cannot resume this chat.');
  }
  return result;
}

// No `model` param: a resumed conversation keeps the model it started with.
export async function agyChatSend({ session_id, prompt, timeout_ms = 180000 }) {
  requireString('prompt', prompt);
  validateSessionId(session_id);  // also closes argv injection under shell:true

  const { parsed, latency_ms } = await runAgy({
    args: buildArgs({ conversation_id: session_id, timeout_ms }),
    prompt,
    timeout_ms,
    label: 'agy resume'
  });
  const result = shape(parsed, latency_ms);
  return { ...result, session_id: result.session_id || session_id };
}

// Each conversation is a SQLite db plus a brain/ directory (~600KB+ together):
//   ~/.gemini/antigravity-cli/conversations/<uuid>.db{,-shm,-wal}
//   ~/.gemini/antigravity-cli/brain/<uuid>/
// Exact-path deletion: we have the full UUID and the layout is flat.
function agyStoreRoot() {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

// A subagent (e.g. agy's image-generator) runs as a conversation of its own,
// with its own db and brain/ directory, recorded in the parent's
// brain/<id>/.system_generated/subagents/<subagent-id>.json. Deleting only the
// parent left ~2MB per image call behind.
export function agySubagentIds(brainDir) {
  let names;
  try { names = fs.readdirSync(path.join(brainDir, '.system_generated', 'subagents')); } catch (_) { return []; }
  const ids = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    try { validateSessionId(id); ids.push(id); } catch (_) { /* not a conversation id */ }
  }
  return ids;
}

export async function agyChatEnd({ session_id }, depth = 0) {
  validateSessionId(session_id);
  const root = agyStoreRoot();
  const convDir = path.join(root, 'conversations');

  let deleted = 0;
  const errors = [];
  let subagentsRemoved = 0;
  if (depth < 3) {
    for (const subId of agySubagentIds(path.join(root, 'brain', session_id))) {
      if (subId === session_id) continue;
      const sub = await agyChatEnd({ session_id: subId }, depth + 1);
      deleted += sub.deleted;
      subagentsRemoved += 1 + (sub.subagents_removed ?? 0);
      if (sub.errors) errors.push(...sub.errors);
    }
  }
  for (const suffix of ['.db', '.db-shm', '.db-wal']) {
    const p = path.join(convDir, `${session_id}${suffix}`);
    try {
      if (fs.existsSync(p)) { fs.unlinkSync(p); deleted++; }
    } catch (e) { errors.push(`${path.basename(p)}: ${e.code || e.message}`); }
  }

  const brainRemoved = removeTree(path.join(root, 'brain', session_id));
  if (brainRemoved) deleted++;

  return {
    participant: 'agy',
    session_id,
    deleted,
    brain_removed: brainRemoved,
    ...(subagentsRemoved ? { subagents_removed: subagentsRemoved } : {}),
    note: deleted > 0
      ? `removed ${deleted} conversation artifact(s)`
      : 'no conversation files matched (already deleted, wrong id, or never persisted)',
    ...(errors.length ? { errors } : {})
  };
}

// What agy's settings.json allows for file writes (see the header). Read-only;
// consult never modifies it. Reported by agyStatus so the caller can tell
// whether a stray "please fix this file" prompt could land on disk.
export function agyWritePosture(settingsPath = path.join(agyStoreRoot(), 'settings.json')) {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (_) { /* absent or unreadable */ }
  const trusted = Array.isArray(cfg?.trustedWorkspaces) ? cfg.trustedWorkspaces.map(String) : [];
  const deny = Array.isArray(cfg?.permissions?.deny) ? cfg.permissions.deny.map(String) : [];
  const writes_denied = deny.some(d => /^write_file\(/.test(d));
  const commands_denied = deny.some(d => /^command\(/.test(d));
  const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  const trusts_home = trusted.some(t => norm(t) === norm(os.homedir()));
  let level, note;
  if (writes_denied) {
    level = 'denied';
    note = 'A write_file deny rule is set: agy cannot modify files even inside trusted workspaces.';
  } else if (trusts_home) {
    level = 'home_trusted';
    note = 'Your HOME directory is a trusted agy workspace, so headless agy can create/edit ANY file under it without asking. ' +
      'To block: add {"permissions":{"deny":["write_file(**)","command(**)"]}} to settings.json (applies to interactive agy too), ' +
      'or narrow trustedWorkspaces.';
  } else if (trusted.length) {
    level = 'workspaces_trusted';
    note = 'Headless agy can create/edit files inside the listed trusted workspaces without asking; writes elsewhere are auto-denied.';
  } else {
    level = 'untrusted';
    note = 'No trusted workspaces: headless agy file writes are auto-denied everywhere.';
  }
  return { level, trusted_workspaces: trusted.map(scrubPii), write_deny_rule: writes_denied, command_deny_rule: commands_denied, note };
}

// Reachability/auth probe. `agy models` hits the backend but runs no
// inference, so it costs no tokens.
export async function agyStatus({ timeout_ms = 30000 } = {}) {
  try {
    const { stdout, stderr, code } = await runCli({
      cmd: 'agy', args: ['models'], timeout_ms,
      label: 'agy models', allowNonZeroExit: true
    });
    const text = `${stdout}\n${stderr}`;
    if (code !== 0) {
      return {
        authenticated: false,
        reason: /IneligibleTier|UNSUPPORTED_CLIENT/i.test(text) ? 'ineligible_tier' : 'error',
        details: scrubPii(text.slice(-600).trim()),
        hint: 'Run `agy` once interactively to complete sign-in, or reinstall from https://antigravity.google'
      };
    }
    // TSV: "<model-id>\t<display name>" per line, after a status line.
    const models = stdout.split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && l.includes('\t'))
      .map(l => l.split('\t')[0].trim())
      .filter(Boolean);
    return { authenticated: true, model_count: models.length, models, write_posture: agyWritePosture() };
  } catch (e) {
    const missing = e.kind === 'spawn_error';
    return {
      authenticated: false,
      reason: missing ? 'binary_missing' : 'error',
      details: scrubPii(String(e.message).slice(0, 600)),
      hint: missing
        ? 'agy is not on PATH and not in its default install location. Install it from https://antigravity.google, then open a NEW terminal and start Claude Code from it -- the installer updates the user PATH registry, which an already-running terminal (and anything it launches) will not pick up.'
        : 'Run `agy models` in a terminal to diagnose.'
    };
  }
}
