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
//      whole subtree.
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
// own process group: the whole group is killed, not just the child.
export function killTree(child, { group = false } = {}) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      killPidTree(child.pid);
      return;
    } catch (_) { /* fall through to SIGKILL */ }
  }
  if (group && process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (_) { /* fall through to SIGKILL on the child alone */ }
  }
  try { child.kill('SIGKILL'); } catch (_) {}
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
  const child = spawn(spawnableCmd(bin), shellSafeArgs(args), { stdio: ['pipe', 'pipe', 'pipe'], ...SPAWN_OPTS });

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
      killTree(child);
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
    killTree(child);
  }, timeout_ms);
  const onAbort = () => {
    cancelled = true;
    killTree(child);
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
