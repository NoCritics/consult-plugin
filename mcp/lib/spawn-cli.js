// Subprocess runner for codex / agy / gemini / claude. It owns three fixes
// every provider needs:
//
//   1. EPIPE safety: child.stdin must have an error listener before we write,
//      otherwise an early child exit becomes an unhandled error event that
//      crashes the MCP server.
//   2. Buffer cap: stdout/stderr were accumulated into unbounded JS strings.
//      A misbehaving CLI streaming MB of trace can OOM the server before the
//      timeout fires. We cap each stream at BUFFER_CAP and tree-kill the child
//      on overflow.
//   3. Tree-kill: on Windows with shell:true (required for .cmd shims, see
//      resolve-cmd.js), child.kill('SIGKILL') only kills cmd.exe, leaving the
//      real CLI grandchild running. We use `taskkill /T /F` to tear down the
//      whole subtree. On POSIX each CLI leads its own process group (detached)
//      and the group is killed, so a wrapper's own children stop too.
//
// Returns { stdout, stderr, code, latency_ms } on success. Throws CliError
// with `kind` in: timeout | buffer_overflow | spawn_error | nonzero_exit.

import { spawn, execFileSync } from 'node:child_process';
import { ensureCmd, SPAWN_OPTS, EMPTY_ARG, spawnableCmd } from './resolve-cmd.js';
import { scrubPii, callSignal, timeoutRetryHint } from './util.js';

// Under shell:true Node joins args with spaces, unescaped (what DEP0190 warns
// about): an arg with whitespace splits, and '' vanishes. Prompts go via stdin
// and ids are validated, so only args we build (system prompt, image and temp
// paths) can hold whitespace; those get double quotes. cmd.exe has no escape
// for " inside quotes and treats & | < > ^ % ! as operators, so we refuse those.
export const CMD_UNSAFE_RE = /["&|<>^%!]/;

export function shellSafeArgs(args) {
  if (!SPAWN_OPTS.shell) return args;
  return args.map((arg) => {
    const s = String(arg);
    if (s === EMPTY_ARG) return s;               // already the quoted empty
    if (!/\s/.test(s)) {
      if (CMD_UNSAFE_RE.test(s)) throw new CliError(`Refusing to pass argument containing cmd.exe metacharacters: ${JSON.stringify(s.slice(0, 80))}`, 'unsafe_arg');
      return s;
    }
    if (CMD_UNSAFE_RE.test(s)) throw new CliError(`Refusing to pass argument with both whitespace and cmd.exe metacharacters: ${JSON.stringify(s.slice(0, 80))}`, 'unsafe_arg');
    return `"${s}"`;
  });
}

const DEFAULT_BUFFER_CAP = 8 * 1024 * 1024; // 8 MiB per stream
const TAIL_BYTES = 2000;

class CliError extends Error {
  constructor(message, kind, extras = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extras);
  }
}

// Kills the process with this pid and everything under it (Windows). Throws when taskkill fails.
export function killPidTree(pid) {
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore', windowsHide: true, timeout: 5000
  });
}

// `group: true` is for a child spawned `detached` on POSIX, where it leads its
// own process group: the whole group is killed, not just the child. An exited
// child is left alone unless `evenIfExited` is also set (runCli only: a wrapper
// that exited can leave a grandchild holding stdout open, so its 'close' never
// fires; the delegate supervisor must not kill a finished worker's survivors).
export function killTree(child, { group = false, evenIfExited = false } = {}) {
  if (!child) return;
  const groupKill = group && process.platform !== 'win32' && child.pid;
  if (child.exitCode !== null && !(groupKill && evenIfExited)) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      killPidTree(child.pid);
      return;
    } catch (_) { /* fall through to SIGKILL */ }
  }
  if (groupKill) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (_) { /* fall through to SIGKILL on the child alone */ }
  }
  if (child.exitCode !== null) return;
  try { child.kill('SIGKILL'); } catch (_) {}
}

// On POSIX each CLI leads its own process group so a timeout or Cancel can kill
// the wrapper's children too (killTree with `group: true`). Windows keeps the
// shell:true + taskkill /T path and is not detached.
export function cliSpawnOptions(platform) {
  if (platform === 'win32') return {};
  return { detached: true };
}

// Every runCli child still running. On POSIX the children are detached, so the
// terminal's SIGHUP/SIGINT no longer reach them; the server kills them itself.
const liveCliChildren = new Set();

export function liveCliChildCount() {
  return liveCliChildren.size;
}

// Stops every CLI a call is still waiting on (server shutdown). `kill` is
// injectable for tests.
export function killAllCliChildren(kill = killTree) {
  for (const child of [...liveCliChildren]) kill(child, { group: true, evenIfExited: true });
}

// spawnableCmd refuses a path cmd.exe cannot take safely; callers test for
// kind 'spawn_error', so the refusal is raised as one.
export function spawnableCmdOrError(bin, label) {
  try {
    return spawnableCmd(bin);
  } catch (e) {
    throw new CliError(scrubPii(`${label} CLI failed to start: ${e.message}`), 'spawn_error', { label });
  }
}

export async function runCli({
  cmd,
  args,
  prompt = '',
  timeout_ms = 180000,
  label = cmd,
  bufferCap = DEFAULT_BUFFER_CAP,
  allowNonZeroExit = false
}) {
  const bin = ensureCmd(cmd);
  const signal = callSignal();
  if (signal?.aborted) throw new CliError(`${label} not started: the call was cancelled.`, 'cancelled', { label });
  const started = Date.now();
  let spawnErr = null;
  let timedOut = false;
  let bufferOverflow = false;
  let cancelled = false;

  // The child inherits the MCP server's cwd. None of the providers need to
  // relocate it -- prompts carry their own context (files are inlined by the
  // orchestrator before the tool call).
  const child = spawn(spawnableCmdOrError(bin, label), shellSafeArgs(args), { stdio: ['pipe', 'pipe', 'pipe'], ...SPAWN_OPTS, ...cliSpawnOptions(process.platform) });

  liveCliChildren.add(child);

  // EPIPE safety -- attach BEFORE the first write. If the child exits before
  // consuming stdin, the write triggers an error event; without a listener
  // Node bubbles it as an unhandled exception and kills the server.
  child.stdin.on('error', () => {});

  let stdout = '', stderr = '';
  const onChunk = (which) => (chunk) => {
    // Single overflow flag gates BOTH streams. Without this, capping stdout
    // doesn't stop stderr (and vice versa) -- chunks would keep accumulating
    // on the other stream between the kill signal and actual process death.
    if (bufferOverflow) return;
    const current = which === 'stdout' ? stdout : stderr;
    if (current.length >= bufferCap) {
      bufferOverflow = true;
      killTree(child, { group: true, evenIfExited: true });
      return;
    }
    const text = chunk.toString('utf8');
    if (which === 'stdout') stdout += text;
    else stderr += text;
  };
  child.stdout.on('data', onChunk('stdout'));
  child.stderr.on('data', onChunk('stderr'));

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child, { group: true, evenIfExited: true });
  }, timeout_ms);
  const onAbort = () => {
    cancelled = true;
    killTree(child, { group: true, evenIfExited: true });
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  if (prompt) {
    try { child.stdin.write(prompt); } catch (_) { /* EPIPE handled by listener */ }
  }
  try { child.stdin.end(); } catch (_) {}

  const code = await new Promise((resolve) => {
    child.on('close', resolve);
    child.on('error', (err) => { spawnErr = err; resolve(127); });
  });
  liveCliChildren.delete(child);
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);

  const latency_ms = Date.now() - started;
  if (cancelled) {
    throw new CliError(`${label} stopped after ${latency_ms}ms: the call was cancelled.`, 'cancelled', { label, code, latency_ms, stdout, stderr });
  }
  // Scrub the user-facing message (which embeds stderr) for API keys and the
  // home-dir path. Raw stderr/stdout remain on the error object for internal
  // diagnostics (logs, debugging) but never round-trip to MCP clients verbatim.
  const stderrTail = scrubPii(stderr.slice(-TAIL_BYTES));

  if (timedOut) {
    throw new CliError(
      `${label} timed out after ${timeout_ms}ms. ${timeoutRetryHint(timeout_ms, 'timeout_ms')} stderr:\n${stderrTail}`,
      'timeout', { label, code, latency_ms, stdout, stderr }
    );
  }
  if (bufferOverflow) {
    throw new CliError(
      `${label} exceeded output buffer (${bufferCap} bytes). Killed. stderr tail:\n${stderrTail}`,
      'buffer_overflow', { label, code, latency_ms, stdout, stderr }
    );
  }
  if (spawnErr) {
    throw new CliError(
      scrubPii(`${label} CLI failed to start: ${spawnErr.code || ''} ${spawnErr.message}. Check that '${cmd}' is on PATH.`),
      'spawn_error', { label, latency_ms, stdout, stderr }
    );
  }
  if (code !== 0 && !allowNonZeroExit) {
    throw new CliError(
      `${label} exited with code ${code}. stderr:\n${stderrTail}`,
      'nonzero_exit', { label, code, latency_ms, stdout, stderr }
    );
  }

  return { stdout, stderr, code, latency_ms };
}
