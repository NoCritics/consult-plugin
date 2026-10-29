// --- GPT image generation through the Codex CLI --------------------------------
// codex exec has the built-in image_gen tool behind `--enable image_generation`.
// It has no aspect-ratio or count parameter, so those settings travel in the
// brief: the shape as a closing sentence on the image prompt, the count as an
// instruction to call the tool once per image.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hookArgs, reasoningCfg, parseCodexJsonl, codexTimeoutError, codexHome, codexRunHooks, describeRun } from './codex.js';
import { runCli, shellSafeArgs } from './spawn-cli.js';
import { loadImages, CODEX_IMAGE_ASPECT_RATIOS } from './image.js';
import { agyImageOutputDir, findGeneratedImages, copyImagesTo, retargetPaths } from './agy.js';
import { limitFromMessage } from './delegate-workers.js';
import { requireString, validateModel, validateSessionId, scrubPii } from './util.js';

export { CODEX_IMAGE_ASPECT_RATIOS };
const CODEX_IMAGE_MAX_REFERENCES = 5;
const CODEX_IMAGE_MAX_COUNT = 4;
const CODEX_IMAGE_EXTRA_IMAGE_MS = 120000;
const CODEX_IMAGE_MAX_TIMEOUT_MS = 1800000;

const SHAPE_SENTENCES = {
  '1:1': 'Square 1:1 composition (as wide as tall).',
  '16:9': 'Wide landscape 16:9 composition (much wider than tall).',
  '3:2': 'Landscape 3:2 composition (wider than tall).',
  '4:3': 'Landscape 4:3 composition (a little wider than tall).',
  '9:16': 'Tall portrait 9:16 composition (much taller than wide).',
  '2:3': 'Portrait 2:3 composition (taller than wide).',
  '3:4': 'Portrait 3:4 composition (a little taller than wide).'
};

// The call's image options, checked before anything is read or run. The aspect
// ratio falls back to the codex_image_aspect_ratio setting, then 1:1.
export function codexImageOptions({ aspect_ratio, transparent_background, count, exact_prompt, images } = {}, settings = {}) {
  const aspectRatio = aspect_ratio ?? settings.codex_image_aspect_ratio ?? '1:1';
  if (!CODEX_IMAGE_ASPECT_RATIOS.includes(aspectRatio)) {
    throw new Error(`aspect_ratio must be one of ${CODEX_IMAGE_ASPECT_RATIOS.join(', ')}; got ${JSON.stringify(aspectRatio)}.`);
  }
  const chosenCount = count ?? 1;
  if (!Number.isInteger(chosenCount) || chosenCount < 1 || chosenCount > CODEX_IMAGE_MAX_COUNT) {
    throw new Error(`count must be a whole number from 1 to ${CODEX_IMAGE_MAX_COUNT}; got ${JSON.stringify(chosenCount)}.`);
  }
  const transparent = transparent_background ?? false;
  if (typeof transparent !== 'boolean') {
    throw new Error(`transparent_background must be true or false; got ${JSON.stringify(transparent)}.`);
  }
  const exactPrompt = exact_prompt ?? false;
  if (typeof exactPrompt !== 'boolean') {
    throw new Error(`exact_prompt must be true or false; got ${JSON.stringify(exactPrompt)}.`);
  }
  if (Array.isArray(images) && images.length > CODEX_IMAGE_MAX_REFERENCES) {
    throw new Error(`At most ${CODEX_IMAGE_MAX_REFERENCES} reference images are allowed; got ${images.length}.`);
  }
  return { aspect_ratio: aspectRatio, transparent_background: transparent, count: chosenCount, exact_prompt: exactPrompt };
}

// The closing sentence that tells the image model the shape; null for auto.
export function shapeSentence(aspect_ratio) {
  return SHAPE_SENTENCES[aspect_ratio] ?? null;
}

// The prompt codex receives on stdin: instructions, the reference list, then
// the image prompt with its shape sentence.
export function codexImageBrief({ aspect_ratio, transparent_background, count, exact_prompt }, prompt, referencePaths) {
  const plural = count === 1 ? '' : 's';
  const shape = shapeSentence(aspect_ratio);
  const lines = [
    `Make exactly ${count} image${plural}` + (count === 1 ? ' with the image_gen tool.' : `, each with its own separate image_gen call.`),
    'Do not run shell commands, scripts or code other than the image_gen tool, and write no files.',
    'If the image tool fails or refuses, do not retry and do not substitute anything: reply with the reason.'
  ];
  if (transparent_background) lines.push('Set transparent_background: true on every image.');
  if (referencePaths.length > 0) lines.push('Pass the reference images listed below as referenced_image_paths.');
  if (exact_prompt) {
    lines.push('Use the image prompt below as the image_gen prompt word for word, with nothing added or changed.');
  } else if (shape !== null) {
    lines.push(`You may expand the image prompt below, but keep its final sentence ("${shape}") at the end of the image prompt you send.`);
  } else {
    lines.push('You may expand the image prompt below.');
  }
  lines.push(`When done, reply with one line per image giving its saved path.`);

  let brief = lines.join('\n') + '\n\n';
  if (referencePaths.length > 0) brief += `Reference images:\n${referencePaths.map(one => `- ${one}`).join('\n')}\n\n`;
  brief += `Image prompt:\n${prompt}` + (shape === null ? '' : ` ${shape}`) + '\n';
  return brief;
}

// The codex exec command line. The brief goes in on stdin (the trailing `-`).
export function codexImageArgs({ model, referencePaths, run_hooks, outFile }) {
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--enable', 'image_generation', ...hookArgs(run_hooks), '-o', outFile, '--json', '--color', 'never', '-c', reasoningCfg('low')];
  if (model) args.push('-m', model);
  for (const referencePath of referencePaths) args.push('-i', referencePath);
  args.push('-');
  return args;
}

// The default limit: two minutes more for each image past the first, up to
// 30 minutes. A per-call timeout replaces it.
export function codexImageTimeoutMs(baseMs, count) {
  return Math.min(baseMs + (count - 1) * CODEX_IMAGE_EXTRA_IMAGE_MS, CODEX_IMAGE_MAX_TIMEOUT_MS);
}

// The words that mean Codex is not signed in (the same test codex.js uses).
const AUTH_PATTERN = /token|auth|log ?in|sign ?in|401|unauthorized/i;

// Where the image_gen tool's refusal names its stage (stderr may escape the quotes).
const MODERATION_STAGE_PATTERN = /moderation_stage\\?"\s*:\s*\\?"(\w+)/;

// Runs codex exec with the image_gen tool, copies the images it saved out of
// its generated_images/<thread_id>/ folder into the output folder, and deletes
// that folder. `run` and `home` can be replaced for tests.
export async function codexGenerateImage({ prompt, model, images, output_dir, serverDir, aspect_ratio, transparent_background, count, exact_prompt, settings = {}, run_hooks, timeout_ms, base_timeout_ms = 300000, run = runCli, home = codexHome(), remove = fs.rmSync }) {
  requireString('prompt', prompt);
  validateModel(model);
  const requested = codexImageOptions({ aspect_ratio, transparent_background, count, exact_prompt, images }, settings);
  const limitMs = timeout_ms ?? codexImageTimeoutMs(base_timeout_ms, requested.count);
  const outDir = agyImageOutputDir({ output_dir, serverDir });
  const references = images?.length ? loadImages(images) : [];
  const referencePaths = [];
  for (const reference of references) referencePaths.push(reference.path);
  // A path cmd.exe cannot carry safely fails now, before any run starts.
  shellSafeArgs(codexImageArgs({ model, referencePaths, run_hooks: false, outFile: '' }));
  // Fail on an unwritable folder now, not after minutes of generation.
  try { fs.mkdirSync(outDir, { recursive: true }); }
  catch (e) { throw new Error(`Cannot create the output folder ${outDir}: ${e.code || e.message}`); }

  const outFile = path.join(os.tmpdir(), `consult-codex-image-${randomBytes(6).toString('hex')}.txt`);
  let copied = [];
  let copyError = null;
  let result = null;
  let failure = null;
  let threadFolder = null;
  try {
    try {
      result = await run({
        cmd: 'codex',
        args: codexImageArgs({ model, referencePaths, run_hooks: codexRunHooks(run_hooks, settings), outFile }),
        prompt: codexImageBrief(requested, prompt, referencePaths),
        timeout_ms: limitMs,
        label: 'codex image'
      });
    } catch (e) {
      failure = e;
    }
    const stdout = result ? result.stdout : String(failure?.stdout || '');
    const parsed = parseCodexJsonl(stdout);
    if (parsed.thread_id && isSafeThreadId(parsed.thread_id)) {
      threadFolder = path.join(home, 'generated_images', parsed.thread_id);
      try {
        const found = findGeneratedImages(threadFolder);
        if (found.length) copied = copyImagesTo(found, outDir);
      } catch (e) { copyError = e; }
    }
    let reply = parsed.response;
    try { reply = fs.readFileSync(outFile, 'utf8').trim() || reply; } catch (_) { /* no -o file */ }
    return finishCodexImageCall({
      copied, copyError, threadFolder, failure, codexFailure: parsed.failure,
      stderr: result ? result.stderr : String(failure?.stderr || ''),
      reply, latency_ms: result?.latency_ms, model, outDir, requested, limitMs
    });
  } finally {
    // Cleanup never replaces a result: a locked file (antivirus, a just-killed
    // Codex) leaves a leftover instead of failing a call that already paid.
    // After a failed copy the thread folder holds the only originals, so it stays.
    if (threadFolder && !copyError) removeQuietly(remove, threadFolder, { recursive: true });
    removeQuietly(remove, outFile, {});
  }
}

// The thread id names a folder that is deleted afterwards, so it must be a
// plain id and never a path.
function isSafeThreadId(threadId) {
  try { validateSessionId(threadId); return true; }
  catch (_) { return false; }
}

function removeQuietly(remove, target, options) {
  try { remove(target, { ...options, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (_) { /* leave it behind */ }
}

// The usage-limit error quoting the first line of `text` that reads as a limit
// (the lines around it are exit codes and logs); null when no line does.
function usageLimitFrom(text) {
  for (const line of text.split(/\r?\n/)) {
    const limit = limitFromMessage(line);
    if (limit) return new Error(scrubPii(`Codex usage limit reached (${limit.kind}): ${line.trim().slice(0, 300)}`));
  }
  return null;
}

// The result of an image call, decided from what was copied out and how codex
// ended. Codex exits 0 on a refusal, so a refusal is read from stderr and the
// reply. Images saved before a failure are kept and returned with a warning.
// `limitMs` is the limit the run had, for the timeout message.
export function finishCodexImageCall({ copied, copyError, threadFolder, failure, codexFailure = '', stderr = '', reply = '', latency_ms, model, outDir, requested, limitMs }) {
  if (copyError && copied.length === 0) {
    throw new Error(scrubPii(`Codex made images but copying them to ${outDir} failed: ${copyError.code || copyError.message}. The originals are still in ${threadFolder}`));
  }
  const images = [];
  for (const { source, ...image } of copied) images.push(image);
  const base = {
    images,
    output_dir: outDir,
    model: describeRun({ model, reasoning_effort: 'low' }).model,
    latency_ms,
    aspect_ratio: requested.aspect_ratio,
    transparent_background: requested.transparent_background,
    count: requested.count
  };

  if (failure) {
    const failureText = String(failure.message || failure);
    if (copied.length === 0) {
      const timeout = codexTimeoutError(failure, limitMs);
      if (timeout) {
        // The shared timeout error names ask_codex's setting; images have their own.
        timeout.message = timeout.message.replace(/codex_timeout_ms/g, 'codex_image_timeout_ms');
        throw timeout;
      }
      const limitError = usageLimitFrom([failureText, stderr, codexFailure || ''].join('\n'));
      if (limitError) throw limitError;
      throw failure;
    }
    // The shared timeout message names ask_codex's setting; images have their own.
    const reason = failureText.split('\n')[0].replace(/`timeout_ms`/g, '`codex_image_timeout_ms`').slice(0, 300);
    return {
      ...base,
      codex_reply: retargetPaths(reply, copied),
      warning: scrubPii(`Codex did not finish cleanly (${reason}). The ${copied.length} image(s) it had already saved are kept; it may have meant to make more.`)
    };
  }

  if (copied.length === 0) {
    if (stderr.includes('moderation_blocked') || reply.includes('moderation_blocked')) {
      const stageMatch = MODERATION_STAGE_PATTERN.exec(stderr) || MODERATION_STAGE_PATTERN.exec(reply);
      const stage = stageMatch ? `, stage ${stageMatch[1]}` : '';
      throw new Error(scrubPii(`Codex's image tool refused the prompt (OpenAI safety system${stage}). Codex said: ${reply.slice(0, 1500)}`));
    }
    const limitError = usageLimitFrom([stderr, reply, codexFailure || ''].join('\n'));
    if (limitError) throw limitError;
    let logged = '';
    const stderrLines = stderr.split(/\r?\n/);
    for (let at = stderrLines.length - 1; at >= 0; at--) {
      if (stderrLines[at].includes('image generation failed')) { logged = ` Codex logged: ${stderrLines[at].trim()}`; break; }
    }
    const reported = codexFailure ? ` Codex reported: ${codexFailure}` : '';
    const needsLogin = AUTH_PATTERN.test(codexFailure) || AUTH_PATTERN.test(stderr);
    const hint = needsLogin ? ' Run `codex login` in a terminal, or call the `codex_login_start` tool.' : '';
    throw new Error(scrubPii(`Codex finished without saving an image. Its reply: ${reply.slice(0, 1500)}${logged}${reported}${hint}`));
  }

  const warning = copied.length === requested.count ? {} : { warning: `asked for ${requested.count}, Codex saved ${copied.length}.` };
  return { ...base, codex_reply: retargetPaths(reply, copied), ...warning };
}
