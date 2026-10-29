// Shared validators and filesystem helpers. Hoisted from per-provider files
// to keep the validation contract uniform across codex/gemini/claude paths
// and to give the chat_end implementations one walk-and-delete helper.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

// The current tool call's AbortSignal, set by the request handler. runCli and
// the local HTTP client read it, so a call the host cancels (or gives up on)
// stops its CLI instead of running on to the end, still spending tokens.
export const callContext = new AsyncLocalStorage();

export function callSignal() {
  return callContext.getStore()?.signal;
}

const MODEL_NAME_RE = /^[A-Za-z0-9._:/\-]+$/;
const SESSION_ID_RE = /^[A-Fa-f0-9-]{8,64}$/;
// Codex `model_reasoning_effort`. This is the API's enum (verified against
// codex-cli 0.154.0); which values a given model honours is model-dependent --
// gpt-6-astra rejects `minimal` with a clear 400 that names its own list, and
// we let that message through rather than second-guessing it here.
export const REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const REASONING_EFFORT_SET = new Set(REASONING_EFFORTS);

export function validateModel(model) {
  if (model && !MODEL_NAME_RE.test(model)) {
    throw new Error(`Invalid model name: ${JSON.stringify(model)}. Allowed chars: A-Z a-z 0-9 . _ : / -`);
  }
}

// Rejects shell metacharacters that would otherwise become argv injection when
// spawn runs with shell:true on Windows. Every provider's session id fits this
// shape; anything else is a bug or attack and we refuse early.
export function validateSessionId(session_id) {
  if (!session_id || typeof session_id !== 'string') throw new Error('`session_id` is required.');
  if (!SESSION_ID_RE.test(session_id)) throw new Error(`session_id has unexpected shape: ${JSON.stringify(session_id)}`);
}

// MCP schema enum catches bad values at the boundary, but lib-layer validation
// is defense-in-depth since this value is interpolated into a `-c` config arg.
export function validateReasoningEffort(effort) {
  if (effort && !REASONING_EFFORT_SET.has(effort)) {
    throw new Error(`Invalid reasoning_effort: ${JSON.stringify(effort)}. Allowed: ${REASONING_EFFORTS.join(' | ')} (model-dependent)`);
  }
}

export function requireString(name, value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`\`${name}\` is required.`);
  }
}

// Brace-balanced JSON extraction from CLI output that may carry a preamble
// (gemini-cli prints a truecolor warning before its payload; agy is usually
// clean but we don't want to depend on that). Distinguishes "no JSON present"
// from "found an object but it wouldn't parse" so callers can give actionable
// errors -- `err.kind` is 'no_json' or 'parse_error'.
export function extractJson(buf) {
  const i = buf.indexOf('{');
  if (i < 0) {
    const err = new Error('no JSON object found in output');
    err.kind = 'no_json';
    throw err;
  }
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < buf.length; j++) {
    const ch = buf[j];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; continue; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = buf.slice(i, j + 1);
        try { return JSON.parse(slice); }
        catch (e) {
          const err = new Error(`JSON parse failed: ${e.message}. Slice (first 500): ${slice.slice(0, 500)}`);
          err.kind = 'parse_error';
          throw err;
        }
      }
    }
  }
  const err = new Error('JSON object never closed (unbalanced braces)');
  err.kind = 'parse_error';
  throw err;
}

// Recursively remove a directory tree. Used by chat_end paths where a provider
// stores per-conversation state as a directory rather than a flat file (agy's
// `brain/<uuid>/`). Returns true if something was removed. Never throws.
export function removeTree(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

// Walk `root` to bounded depth and unlink files whose basename matches the
// predicate. Sync to keep call sites simple; depth/breadth-cap protects the
// event loop. Returns { matches, deleted, errors } -- never throws.
// `verify(fullPath)` optionally gates each delete: return false to keep the file.
export function walkAndDelete({ root, predicate, verify, maxDepth = 6 }) {
  const matches = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && predicate(e.name)) matches.push(p);
    }
  };
  walk(root, 0);
  let deleted = 0, skipped = 0;
  const errors = [];
  for (const f of matches) {
    try {
      if (verify && !verify(f)) { skipped++; continue; }
      fs.unlinkSync(f);
      deleted++;
    }
    catch (e) { errors.push(`${path.basename(f)}: ${e.code || e.message}`); }
  }
  return { matches: matches.length, deleted, skipped, errors };
}

// Read up to `n` bytes from the start of `filePath`. Used by chat_end paths to
// verify file contents (full UUID) before deleting a short-id match.
export function readHead(filePath, n = 65536) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(n);
    const bytes = fs.readSync(fd, buf, 0, n, 0);
    return buf.slice(0, bytes).toString('utf8');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Redact sensitive substrings from text crossing trust boundaries (e.g. CLI
// stderr surfacing to MCP clients). Catches common API key shapes and the
// user's home directory path. Not bulletproof -- defense-in-depth, not the
// primary control.
const HOME_DIR = os.homedir();
const HOME_RE = HOME_DIR && HOME_DIR.length > 3
  ? new RegExp(HOME_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  : null;
const SCRUB_PATTERNS = [
  [/sk-(?:proj-|ant-)?[A-Za-z0-9_\-]{20,}/g, 'sk-***'],
  [/AIza[0-9A-Za-z_\-]{30,}/g, 'AIza***'],
  [/ghp_[A-Za-z0-9]{30,}/g, 'ghp_***'],
  [/((?:Bearer|Token)\s+)[A-Za-z0-9._\-]{16,}/gi, '$1***'],
  [/((?:api[_-]?key|authorization|x-api-key)\s*[=:]\s*["']?)[A-Za-z0-9._\-]{8,}/gi, '$1***'],
];

export function scrubPii(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [re, replacement] of SCRUB_PATTERNS) out = out.replace(re, replacement);
  if (HOME_RE) out = out.replace(HOME_RE, '~');
  return out;
}

// ---------------------------------------------------------------------------
// Incomplete-answer errors (shared by codex and agy).
//
// A provider's text at timeout is not an answer, and the caller (usually a
// model) must not mistake it for one: an "INCOMPLETE" first line, the setting
// to raise, then the partial between markers. The partial keeps its beginning
// and is capped. err.kind is 'timeout', matching runCli's own timeouts.
export const PARTIAL_CAP_CHARS = 30000;

// The per-call `timeout_s` argument. The ceiling is Claude Code's idle timeout
// for a stdio MCP server (30 minutes by default): consult sends nothing while a
// call runs, so a longer call would be cut off by the host, not by consult.
export const TIMEOUT_S_MIN = 30;
export const TIMEOUT_S_MAX = 1800;

export function timeoutMsFromSeconds(timeout_s) {
  if (timeout_s === undefined || timeout_s === null) return undefined;
  if (typeof timeout_s !== 'number' || !Number.isFinite(timeout_s)) {
    throw new Error(`timeout_s must be a number of seconds; got ${JSON.stringify(timeout_s)}.`);
  }
  if (timeout_s < TIMEOUT_S_MIN || timeout_s > TIMEOUT_S_MAX) {
    throw new Error(`timeout_s must be between ${TIMEOUT_S_MIN} and ${TIMEOUT_S_MAX} seconds (30 minutes); got ${timeout_s}.`);
  }
  return Math.round(timeout_s * 1000);
}

// What a timed-out call should try next: roughly double the limit, within the
// ceiling, or say the ceiling is reached.
export function timeoutRetryHint(timeout_ms, setting) {
  const usedSeconds = Math.round(timeout_ms / 1000);
  if (usedSeconds >= TIMEOUT_S_MAX) {
    return `It already had the ${TIMEOUT_S_MAX / 60}-minute maximum: narrow the prompt or lower the effort, and retry.`;
  }
  const suggested = Math.min(TIMEOUT_S_MAX, Math.max(TIMEOUT_S_MIN, usedSeconds * 2));
  return `Retry with \`timeout_s: ${suggested}\` (up to ${TIMEOUT_S_MAX}), raise \`${setting}\` in .claude/consult.local.md, or narrow the prompt.`;
}

export function incompleteError({ provider, timeout_ms, setting, partial = '', partial_label, note, reason }) {
  const text = String(partial || '').trim();
  // `reason` replaces the timeout wording for non-timeout cut-offs (agy ending
  // a streamed answer on a model error); everything after it reads the same.
  const lines = [reason
    ? `INCOMPLETE: ${provider} ${reason}, so there is no complete answer. Do not treat any text below as the full response.`
    : `INCOMPLETE: ${provider} did not finish within ${timeout_ms}ms, so there is no complete answer. ` +
      `Do not treat any text below as the full response. ${timeoutRetryHint(timeout_ms, setting)}`
  ];
  if (note) lines.push(note);
  if (text) {
    const shown = text.length > PARTIAL_CAP_CHARS ? text.slice(0, PARTIAL_CAP_CHARS) : text;
    const cut = text.length > shown.length ? ` -- showing the first ${shown.length} of ${text.length} chars` : '';
    lines.push(
      `----- BEGIN PARTIAL ${provider.toUpperCase()} OUTPUT (${partial_label || 'unfinished'}${cut}) -----`,
      shown,
      `----- END PARTIAL ${provider.toUpperCase()} OUTPUT -----`
    );
  } else {
    lines.push(`${provider} produced no usable text before the deadline.`);
  }
  const err = new Error(scrubPii(lines.join('\n')));
  err.kind = 'timeout';
  err.incomplete = true;
  err.partial = text;
  return err;
}

// The text on one line (runs of whitespace become one space), cut to maxChars with an ellipsis.
export function oneLine(text, maxChars = Infinity) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

// Resolves after the wait, or at once when the signal (if any) aborts. Whichever
// comes first takes the other away, so a signal that outlives many sleeps does
// not collect a listener per sleep.
export function sleepUnlessAborted(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
