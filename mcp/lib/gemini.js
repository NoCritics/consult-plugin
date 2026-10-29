// Gemini CLI wrapper. Uses `-o json` and parses from the first `{` to skip
// the warning preamble ("Warning: True color...", "YOLO mode...", etc).

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './spawn-cli.js';
import { validateModel, validateSessionId, requireString, walkAndDelete, readHead, scrubPii, extractJson } from './util.js';

// `stats.models` normally has one entry. Aligns with claude.js which also
// takes the first key of modelUsage -- consistent across providers.
function pickActualModel(parsed, fallback) {
  const stats = parsed.stats?.models;
  const names = stats && typeof stats === 'object' ? Object.keys(stats) : [];
  return names.length ? names[0] : (fallback ?? '(gemini default)');
}

// Use the attached form `--prompt=` (single argv element with empty value)
// instead of `-p ""`. The latter collapses to a single empty token under
// cmd.exe shell:true on Windows, which yargs then mis-parses. Real prompt
// travels via stdin, which gemini concatenates with the (empty) -p value.
function buildArgs({ model, approval_mode, session_kind, session_id }) {
  const args = ['--prompt='];
  if (model) args.push('-m', model);
  if (session_kind === 'start') args.push('--session-id', session_id);
  else if (session_kind === 'resume') args.push('--resume', session_id);
  args.push('--approval-mode', approval_mode, '-o', 'json', '--skip-trust');
  return args;
}

async function runGemini({ args, prompt, timeout_ms }) {
  const { stdout, stderr, latency_ms } = await runCli({
    cmd: 'gemini', args, prompt, timeout_ms, label: 'gemini'
  });
  // Try stdout first -- the real response goes there. Only fall back to
  // combined if stdout has no `{` at all (gemini-cli writes everything to
  // stderr in some failure modes). Without this, a stderr JSON-shaped warning
  // emitted before stdout's payload would hijack the parse.
  let parsed;
  try { parsed = extractJson(stdout); }
  catch (eStdout) {
    if (eStdout.kind !== 'no_json') {
      throw new Error(scrubPii(`gemini ${eStdout.message}. stdout tail:\n${stdout.slice(-2000)}`));
    }
    const combined = stdout + '\n' + stderr;
    try { parsed = extractJson(combined); }
    catch (eFinal) { throw new Error(scrubPii(`gemini ${eFinal.message}. Output tail:\n${combined.slice(-2000)}`)); }
  }
  if (!parsed.response) throw new Error(scrubPii(`gemini JSON missing .response field: ${JSON.stringify(parsed).slice(0, 500)}`));
  return { parsed, latency_ms };
}

export async function askGemini({ prompt, model, approval_mode = 'plan', timeout_ms = 180000 }) {
  requireString('prompt', prompt);
  validateModel(model);
  const args = buildArgs({ model, approval_mode });
  const { parsed, latency_ms } = await runGemini({ args, prompt, timeout_ms });
  return {
    response: String(parsed.response).trim(),
    model: pickActualModel(parsed, model),
    latency_ms,
    session_id: parsed.session_id
  };
}

export async function geminiChatStart({ prompt, model, approval_mode = 'plan', timeout_ms = 180000 }) {
  requireString('prompt', prompt);
  validateModel(model);
  const session_id = randomUUID();
  const args = buildArgs({ model, approval_mode, session_kind: 'start', session_id });
  const { parsed, latency_ms } = await runGemini({ args, prompt, timeout_ms });
  return {
    response: String(parsed.response).trim(),
    session_id: parsed.session_id || session_id,
    model: pickActualModel(parsed, model),
    latency_ms
  };
}

// No `model` param: chat-send inherits the model from the session that
// `chat_start` created. The MCP schema for consult_chat_send mirrors this --
// it doesn't accept a model override either.
export async function geminiChatSend({ session_id, prompt, approval_mode = 'plan', timeout_ms = 180000 }) {
  requireString('prompt', prompt);
  validateSessionId(session_id);  // also closes argv injection surface for shell:true
  const args = buildArgs({ approval_mode, session_kind: 'resume', session_id });
  const { parsed, latency_ms } = await runGemini({ args, prompt, timeout_ms });
  return {
    response: String(parsed.response).trim(),
    session_id: parsed.session_id || session_id,
    model: pickActualModel(parsed),
    latency_ms
  };
}

// Gemini stores chats at ~/.gemini/tmp/<project>/chats/session-<ts>-<8hex>.jsonl
// where <8hex> is the first segment of the session UUID. The filename match is
// just a candidate filter; we then read the file head and require the full UUID
// to appear before unlinking. Defends against the birthday collision on 8-hex
// shortIds (~50% chance at ~5k sessions, non-negligible at scale).
export async function geminiChatEnd({ session_id }) {
  validateSessionId(session_id);
  const shortId = session_id.split('-')[0].toLowerCase();
  if (shortId.length !== 8) {
    throw new Error(`session_id first segment must be 8 hex chars (UUID format), got: ${JSON.stringify(shortId)}`);
  }
  const suffix = `-${shortId}.jsonl`;
  const tmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  const lowerId = session_id.toLowerCase();
  const { matches, deleted, skipped, errors } = walkAndDelete({
    root: tmpDir,
    predicate: (name) => name.startsWith('session-') && name.toLowerCase().endsWith(suffix),
    verify: (fullPath) => {
      try { return readHead(fullPath).toLowerCase().includes(lowerId); }
      catch (_) { return false; }
    },
    maxDepth: 4
  });
  let note;
  if (deleted > 0) {
    note = `removed ${deleted} session file(s)` + (skipped ? ` (kept ${skipped} shortId match(es) lacking full UUID)` : '');
  } else if (matches > 0) {
    note = `${matches} file(s) matched the shortId but none contained the full UUID -- nothing deleted (collision avoided)`;
  } else {
    note = 'no session file matched (already aged out, wrong id, or stored under a different project)';
  }
  return {
    participant: 'gemini',
    session_id,
    deleted,
    ...(skipped ? { skipped } : {}),
    note,
    ...(errors.length ? { errors } : {})
  };
}

// Differentiate auth failure from binary-missing / network / unknown errors so
// the consumer can give actionable advice instead of always saying "log in."
//
// `ineligible_tier` is checked FIRST because it masquerades as an auth error
// but no amount of re-logging-in fixes it: Google withdrew the Gemini CLI's
// free tier for individuals ("UNSUPPORTED_CLIENT"), so the account is valid
// and simply not entitled to this client.
export function classifyError(message) {
  const msg = String(message);
  if (/IneligibleTier|UNSUPPORTED_CLIENT|no longer supported|migrate to the Antigravity/i.test(msg)) return 'ineligible_tier';
  if (/ENOENT|not\s+found\s+on\s+PATH|failed to start/i.test(msg)) return 'binary_missing';
  if (/401|403|unauthor|not\s+authenticated|login\s+required|expired\s+credentials/i.test(msg)) return 'unauthenticated';
  if (/quota|rate\s*limit|RESOURCE_EXHAUSTED|429/i.test(msg)) return 'rate_limited';
  if (/ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'network';
  return 'unknown';
}

const REASON_HINTS = {
  ineligible_tier:
    'Google has withdrawn Gemini CLI free-tier access for individual accounts (UNSUPPORTED_CLIENT). ' +
    'Re-authenticating will NOT help. Either set a GEMINI_API_KEY (paid AI Studio key, which the CLI ' +
    'uses instead of OAuth), or use ask_agy (Antigravity), which serves the same Gemini models ' +
    'and is the default Google provider; the council already uses agy, not gemini.',
  binary_missing:
    'The gemini CLI is not on PATH. Install it with `npm i -g @google/gemini-cli`, or fix PATH.',
  unauthenticated:
    'Gemini has no headless login flow. Open a terminal and run `gemini` once interactively to complete OAuth.',
  rate_limited:
    'Gemini is rate-limited or out of quota. Wait and retry, or use a different participant.',
  network:
    'Could not reach Google. Check connectivity/proxy settings.'
};

// The useful part of a CLI failure is usually at the END of stderr -- the
// beginning is boilerplate (e.g. gemini's truecolor warning). Slicing from the
// front hid the real error behind that warning, which made every failure look
// like `reason: unknown`. Keep the tail instead.
function errorDetail(message, max = 600) {
  const msg = String(message);
  return msg.length <= max ? msg : '...' + msg.slice(-max);
}

export async function geminiAuthCheck({ timeout_ms = 30000 } = {}) {
  try {
    const result = await askGemini({
      prompt: 'Reply with exactly: PONG',
      approval_mode: 'plan',
      timeout_ms
    });
    const ok = /pong/i.test(result.response);
    return {
      authenticated: ok,
      reason: ok ? 'ok' : 'unexpected_response',
      details: ok ? 'gemini ping succeeded' : `unexpected response: ${result.response.slice(0, 200)}`
    };
  } catch (e) {
    const reason = classifyError(e.message);
    return {
      authenticated: false,
      reason,
      // `fatal` tells the caller that retrying or re-authenticating is pointless,
      // so it can stop suggesting `gemini login` for a tier the account cannot use.
      fatal: reason === 'ineligible_tier',
      hint: REASON_HINTS[reason] ?? null,
      details: `gemini ping failed (${reason}): ${errorDetail(e.message)}`
    };
  }
}
