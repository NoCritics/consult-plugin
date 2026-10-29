// Codex CLI wrapper. Every call uses `--json`: the JSONL event stream carries
// the session id (chat), codex's own failure reason, and the completed
// messages that survive a timeout kill. One-shot asks also pass `-o`, which
// holds the clean final answer.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runCli } from './spawn-cli.js';
import { CONSULT_DEFAULTS } from './defaults.js';
import { ensureCmd, SPAWN_OPTS, spawnableCmd } from './resolve-cmd.js';
import {
  validateModel, validateReasoningEffort, validateSessionId,
  requireString, scrubPii, incompleteError
} from './util.js';
import { loadImages } from './image.js';

// Codex gets at least this long unless `codex_timeout_ms` says otherwise:
// image reviews at high effort run well past the 180s global default. A floor
// rather than a higher global timeout_ms, so a wedged local runner or a
// council judge round does not inherit a 10-minute wait. Claude Code
// backgrounds MCP calls after 120s, so a long codex call does not block.
export const CODEX_TIMEOUT_FLOOR_MS = CONSULT_DEFAULTS.codex_timeout_floor_ms;

export function codexTimeoutMs({ codex_timeout_ms, timeout_ms }) {
  if (codex_timeout_ms) return codex_timeout_ms;
  return Math.max(timeout_ms || 0, CODEX_TIMEOUT_FLOOR_MS);
}

// Codex runs the user's own hooks (~/.codex/hooks.json) on every turn, headless
// ones included. They are written for interactive sessions, and a Stop hook
// that blocks the stop makes codex keep working after its answer is done --
// racing the timeout. So consult calls pass `--disable hooks` (codex's
// per-invocation feature toggle, valid on `exec resume` too) unless asked.
export function hookArgs(run_hooks) {
  return run_hooks ? [] : ['--disable', 'hooks'];
}

// Per-call `run_hooks` (a tool argument) wins over the `codex_hooks` setting,
// which wins over the default (off). Only a real boolean counts as a choice --
// anything else falls through, the same way invalid settings fall back.
export function codexRunHooks(callValue, settings) {
  if (typeof callValue === 'boolean') return callValue;
  return settings?.codex_hooks === true;
}

// The model and reasoning effort codex ran, for a result's `model` and
// `reasoning_effort` fields. A chat's rollout records both per turn
// (`turn_context`), which is exact. A one-shot ask is --ephemeral and leaves
// no rollout, so it falls back to what config.toml selects: the top-level
// keys, or the active profile's.
export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// The rollout file of a session: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
// under the codex home. null when there is none.
export function findRolloutFile(session_id, home = codexHome()) {
  try {
    const sessionsDir = path.join(home, 'sessions');
    for (const relativePath of fs.readdirSync(sessionsDir, { recursive: true })) {
      if (String(relativePath).endsWith(`-${session_id}.jsonl`)) return path.join(sessionsDir, String(relativePath));
    }
  } catch (_) {}
  return null;
}

// Reads only the keys that pick model and effort; codex is the real TOML parser.
export function configuredCodex(tomlText) {
  const keys = { model: 'model', model_reasoning_effort: 'reasoning_effort' };
  let table = '';
  let profile = null;
  const top = { model: null, reasoning_effort: null };
  const profiles = {};
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = line.match(/^\[([^\[\]]+)\]$/);
    if (header) {
      table = header[1].trim();
      continue;
    }
    const pair = line.match(/^(model|model_reasoning_effort|profile)\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (!pair) continue;
    const value = pair[2] ?? pair[3];
    if (table === '') {
      if (pair[1] === 'profile') profile = value;
      else top[keys[pair[1]]] = value;
      continue;
    }
    const profileTable = table.match(/^profiles\.(?:"([^"]+)"|'([^']+)'|([\w-]+))$/);
    if (!profileTable || pair[1] === 'profile') continue;
    const profileName = profileTable[1] ?? profileTable[2] ?? profileTable[3];
    profiles[profileName] = profiles[profileName] || {};
    profiles[profileName][keys[pair[1]]] = value;
  }
  const active = (profile && profiles[profile]) || {};
  return {
    model: active.model ?? top.model,
    reasoning_effort: active.reasoning_effort ?? top.reasoning_effort
  };
}

// The last turn's settings: a resumed chat appends a turn_context per turn.
export function rolloutTurn(jsonlText) {
  const turn = { model: null, reasoning_effort: null };
  for (const line of jsonlText.split(/\r?\n/)) {
    if (!line.includes('"turn_context"')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== 'turn_context') continue;
      if (typeof event.payload?.model === 'string') turn.model = event.payload.model;
      if (typeof event.payload?.effort === 'string') turn.reasoning_effort = event.payload.effort;
    } catch (_) {}
  }
  return turn;
}

function readConfigured() {
  try {
    return configuredCodex(fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8'));
  } catch (_) {
    return { model: null, reasoning_effort: null };
  }
}

function readSessionTurn(session_id) {
  const rolloutPath = findRolloutFile(session_id);
  if (rolloutPath !== null) {
    try {
      return rolloutTurn(fs.readFileSync(rolloutPath, 'utf8'));
    } catch (_) {}
  }
  return { model: null, reasoning_effort: null };
}

// "gpt-6-astra (codex default)" when codex chose, the value alone when the
// caller did, the bare note when it cannot be found.
export function codexDefaultLabel(requested, resolved) {
  if (requested) return requested;
  return resolved ? `${resolved} (codex default)` : '(codex default)';
}

// For a one-shot ask or a chat's first turn. The rollout, when there is one,
// confirms what ran; config.toml covers an ephemeral ask.
export function describeRun({ model, reasoning_effort, session_id }) {
  const ran = session_id ? readSessionTurn(session_id) : { model: null, reasoning_effort: null };
  const configured = readConfigured();
  return {
    model: codexDefaultLabel(model, ran.model ?? configured.model),
    reasoning_effort: codexDefaultLabel(reasoning_effort, ran.reasoning_effort ?? configured.reasoning_effort)
  };
}

function isValid(validate, value) {
  try {
    validate(value);
    return true;
  } catch (_) {
    return false;
  }
}

function tmpFile(suffix = '.txt') {
  return path.join(os.tmpdir(), `consult-codex-${randomBytes(6).toString('hex')}${suffix}`);
}

// Safe to interpolate: validateReasoningEffort enforces the enum. Unquoted on
// purpose -- a bare word is not valid TOML, so codex takes it as a raw string,
// and a literal `"` in an argv element is what shellSafeArgs refuses.
export function reasoningCfg(effort) {
  return `model_reasoning_effort=${effort}`;
}

export async function askCodex({ prompt, model, reasoning_effort, sandbox = 'read-only', images, run_hooks = false, timeout_ms = CODEX_TIMEOUT_FLOOR_MS }) {
  requireString('prompt', prompt);
  validateModel(model);
  validateReasoningEffort(reasoning_effort);

  // Codex reads images itself via `-i`; validate the paths so a bad one fails
  // clearly instead of as an opaque CLI error.
  const loaded = images?.length ? loadImages(images) : [];

  const outFile = tmpFile();
  // `--ephemeral`: a one-shot ask has nothing to resume, so leave no session
  // on disk (the chat paths need theirs and omit it).
  //
  // Codex does not stream message text: each message arrives whole when it
  // completes, and `-o` is written only at exit. So after a timeout kill the
  // completed `agent_message` events in the JSONL are the only partial.
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', sandbox, '-o', outFile, '--json', '--color', 'never', ...hookArgs(run_hooks)];
  if (model) args.push('-m', model);
  if (reasoning_effort) args.push('-c', reasoningCfg(reasoning_effort));
  // Repeat the flag per file rather than relying on `-i a b c` variadic
  // parsing, which would swallow the following `-` positional.
  for (const img of loaded) args.push('-i', img.path);
  args.push('-');

  let latency_ms, stdout = '';
  try {
    try {
      ({ latency_ms, stdout } = await runCli({ cmd: 'codex', args, prompt, timeout_ms, label: 'codex exec' }));
    } catch (e) {
      throw codexTimeoutError(e, timeout_ms) ?? e;
    }

    let response = '';
    let readErr = null;
    try { response = fs.readFileSync(outFile, 'utf8').trim(); } catch (e) { readErr = e; }
    if (!response) {
      // The JSONL knows why: an expired token or a turn.failed lands there
      // even when -o stays empty. Fall back to its last message if it has one.
      const { response: fromJsonl, failure } = parseCodexJsonl(stdout);
      if (fromJsonl.trim()) response = fromJsonl.trim();
      else if (failure) throw noResponseError(failure, stdout);
      else if (readErr) throw new Error(`codex output file unreadable (${readErr.code}): ${outFile}.`);
      else throw new Error('codex exec returned no content.');
    }
    return {
      response,
      ...describeRun({ model, reasoning_effort }),
      latency_ms,
      hooks_ran: Boolean(run_hooks),
      ...(loaded.length ? { images: loaded.map(i => ({ path: i.path, type: i.type, width: i.width, height: i.height })) } : {})
    };
  } finally {
    try { fs.unlinkSync(outFile); } catch (_) {}
  }
}

// Parse JSONL output from `codex exec --json`. Events of interest:
//   thread.started    -> session id (also emitted on resume)
//   item.started      -> what codex is doing (reasoning, web_search, ...)
//   item.completed    -> agent_message text (last one is the answer)
//   error             -> { message }        \ terminal failures; codex reports
//   turn.failed       -> { error: message } / these instead of an agent_message
//
// Capturing the failure events matters: without them an expired token surfaces
// as the generic "returned no agent_message" plus 2KB of log tail, when codex
// already handed us a one-line reason. Last failure wins -- codex may retry
// internally and emit several before giving up.
export function parseCodexJsonl(buf) {
  let thread_id = null, response = '', failure = null;
  const messages = [];
  // item id -> item type, for items started but not completed (what codex was
  // doing when killed: "web_search", "command_execution", "reasoning", ...).
  const inFlight = new Map();
  for (const line of buf.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch (_) { continue; }
    if (ev.type === 'thread.started' && ev.thread_id) thread_id = ev.thread_id;
    if (ev.type === 'item.started' && ev.item?.id) inFlight.set(ev.item.id, ev.item.type || 'unknown');
    if (ev.type === 'item.completed' && ev.item?.id) inFlight.delete(ev.item.id);
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
      response = ev.item.text;
      messages.push(ev.item.text);
    }
    if (ev.type === 'error' && typeof ev.message === 'string') failure = ev.message;
    if (ev.type === 'turn.failed' && typeof ev.error?.message === 'string') failure = ev.error.message;
  }
  return { thread_id, response, failure, messages, in_flight: [...inFlight.values()] };
}

// Turn runCli's timeout into an INCOMPLETE error carrying the last complete
// message codex produced. Returns null for any other error.
export function codexTimeoutError(e, timeout_ms) {
  if (e?.kind !== 'timeout') return null;
  const { messages, in_flight } = parseCodexJsonl(e.stdout || '');
  const last = messages[messages.length - 1] || '';
  const activity = in_flight.length ? ` It was busy with: ${in_flight.join(', ')}.` : '';
  const note = messages.length
    ? `codex had completed ${messages.length} message(s); the last one is shown. It may be the answer it was still revising, ` +
      `or only a progress note -- codex does not stream text, so the message it was writing when stopped is lost.${activity}`
    : `codex does not stream text, and it had not completed any message yet.${activity}`;
  return incompleteError({
    provider: 'codex',
    timeout_ms,
    setting: 'codex_timeout_ms',
    partial: last,
    partial_label: 'last complete message',
    note
  });
}

// Shared no-response error builder. Prefers codex's own failure message over a
// raw stdout dump, and appends a re-auth hint when the failure looks like an
// expired/absent token (the most common cause in practice).
function noResponseError(failure, stdout) {
  if (!failure) {
    return new Error(scrubPii(`codex returned no agent_message. stdout tail:\n${stdout.slice(-2000)}`));
  }
  const hint = /token|auth|log ?in|sign ?in|401|unauthorized/i.test(failure)
    ? ' Run `codex login` in a terminal, or call the `codex_login_start` tool.'
    : '';
  return new Error(scrubPii(`codex failed: ${failure}${hint}`));
}

export async function codexChatStart({ prompt, model, reasoning_effort, sandbox = 'read-only', run_hooks = false, timeout_ms = CODEX_TIMEOUT_FLOOR_MS }) {
  requireString('prompt', prompt);
  validateModel(model);
  validateReasoningEffort(reasoning_effort);

  const args = ['exec', '--skip-git-repo-check', '-s', sandbox, '--json', '--color', 'never', ...hookArgs(run_hooks)];
  if (model) args.push('-m', model);
  if (reasoning_effort) args.push('-c', reasoningCfg(reasoning_effort));
  args.push('-');

  let stdout, latency_ms;
  try {
    ({ stdout, latency_ms } = await runCli({ cmd: 'codex', args, prompt, timeout_ms, label: 'codex exec' }));
  } catch (e) {
    throw codexTimeoutError(e, timeout_ms) ?? e;
  }
  const { thread_id, response, failure } = parseCodexJsonl(stdout);
  if (!response) throw noResponseError(failure, stdout);
  if (!thread_id) throw new Error('codex emitted no thread.started event. Cannot resume.');
  return { response: response.trim(), session_id: thread_id, ...describeRun({ model, reasoning_effort, session_id: thread_id }), latency_ms, hooks_ran: Boolean(run_hooks) };
}

// No `model` param: chat-send inherits the model from the session that
// `chat_start` created. The MCP schema for consult_chat_send mirrors this --
// it doesn't accept a model override either.
export async function codexChatSend({ session_id, prompt, run_hooks = false, timeout_ms = CODEX_TIMEOUT_FLOOR_MS }) {
  requireString('prompt', prompt);
  validateSessionId(session_id);  // also closes argv injection surface for shell:true

  // `codex exec resume` does NOT accept -s sandbox or --color (inherited from session).
  const args = ['exec', 'resume', session_id, '--skip-git-repo-check', '--json', ...hookArgs(run_hooks)];
  // Resume re-reads config.toml for model and effort instead of keeping the
  // session's: a chat started at low effort would answer its next turn at the
  // configured xhigh. Pin both to the session's last turn. Values are checked
  // like caller input before they reach argv.
  const sessionTurn = readSessionTurn(session_id);
  if (sessionTurn.model && isValid(validateModel, sessionTurn.model)) args.push('-m', sessionTurn.model);
  if (sessionTurn.reasoning_effort && isValid(validateReasoningEffort, sessionTurn.reasoning_effort)) {
    args.push('-c', reasoningCfg(sessionTurn.reasoning_effort));
  }
  args.push('-');

  let stdout, latency_ms;
  try {
    ({ stdout, latency_ms } = await runCli({ cmd: 'codex', args, prompt, timeout_ms, label: 'codex exec resume' }));
  } catch (e) {
    throw codexTimeoutError(e, timeout_ms) ?? e;
  }
  const { response, failure } = parseCodexJsonl(stdout);
  if (!response) throw noResponseError(failure, stdout);
  // Reported from the rollout's new turn, so it shows what actually ran.
  const ran = readSessionTurn(session_id);
  return {
    response: response.trim(), session_id,
    model: ran.model ?? '(as the session started)',
    reasoning_effort: ran.reasoning_effort ?? '(as the session started)',
    latency_ms, hooks_ran: Boolean(run_hooks)
  };
}

// Codex keeps a session in two places: the rollout transcript under
// ~/.codex/sessions/ and a row in its state DB. `codex delete --force <uuid>`
// removes both, non-interactively; deleting only the file leaves a row that
// `codex doctor` flags. `--force` requires a full UUID, which is what
// chat_start returns.
export async function codexChatEnd({ session_id, timeout_ms = 30000 }) {
  validateSessionId(session_id);
  const { stdout, stderr, code } = await runCli({
    cmd: 'codex', args: ['delete', '--force', session_id], timeout_ms,
    label: 'codex delete', allowNonZeroExit: true
  });
  const deleted = code === 0 ? 1 : 0;
  return {
    participant: 'codex',
    session_id,
    deleted,
    note: deleted
      ? 'removed session via `codex delete --force` (rollout file + state DB row)'
      : scrubPii(`codex delete exited ${code}: ${`${stdout}
${stderr}`.trim().slice(-300) || 'no session matched (already deleted or wrong id)'}`)
  };
}

export async function codexLoginStatus({ timeout_ms = 10000 } = {}) {
  try {
    const { stdout, stderr, code } = await runCli({
      cmd: 'codex', args: ['login', 'status'], timeout_ms,
      label: 'codex login status', allowNonZeroExit: true
    });
    const text = (stdout + '\n' + stderr).trim();
    const authenticated = code === 0 && !/not\s+logged\s+in|signed\s+out/i.test(text);
    return { authenticated, exit_code: code, details: text };
  } catch (e) {
    return {
      authenticated: false,
      exit_code: e.kind === 'spawn_error' ? 127 : (e.code ?? null),
      details: e.message
    };
  }
}

// Detached background login. Returns as soon as the verification URL appears
// in output; the codex process keeps running until the user finishes the
// browser flow. Bespoke (not via runCli) because the lifecycle differs --
// we resolve mid-stream and unref the child.
export async function codexLoginStart({ timeout_ms = 15000 } = {}) {
  const codex = ensureCmd('codex');

  return new Promise((resolve, reject) => {
    const child = spawn(spawnableCmd(codex), ['login', '--device-auth'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      ...SPAWN_OPTS
    });

    let buf = '';
    let settled = false;
    const settle = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };

    const tryResolve = () => {
      if (settled) return;
      const m = buf.match(/https?:\/\/[^\s)\]"']+/);
      if (m) {
        settle(() => {
          try { child.unref(); } catch (_) {}
          resolve({ url: m[0], pid: child.pid, raw: buf.slice(0, 2000) });
        });
      }
    };

    child.stdout.on('data', d => { buf += d.toString('utf8'); tryResolve(); });
    child.stderr.on('data', d => { buf += d.toString('utf8'); tryResolve(); });

    const timer = setTimeout(() => {
      settle(() => {
        try {
          if (process.platform === 'win32' && child.pid) {
            execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
          } else {
            child.kill('SIGKILL');
          }
        } catch (_) {}
        reject(new Error(`codex login produced no URL in ${timeout_ms}ms. Output:\n${buf.slice(0, 2000)}`));
      });
    }, timeout_ms);

    child.on('error', (e) => {
      settle(() => reject(new Error(`codex login failed to start: ${e.message}`)));
    });

    child.on('close', (code) => {
      settle(() => reject(new Error(`codex login exited (code=${code}) before producing a URL. Output:\n${buf.slice(0, 2000)}`)));
    });
  });
}
