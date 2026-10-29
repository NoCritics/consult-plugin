#!/usr/bin/env node
// SessionStart hook: quickly check that codex is signed in, agy is installed,
// and -- only if the user configured a local model -- that the local runner is
// up. Prints one line per problem to stderr (hook stdout would be injected into
// the session) and never blocks the session.
//
// Imports the server's own resolver and settings loader instead of copying
// them: the plugin is always installed as a whole directory, and both modules
// use only Node built-ins, so ../../mcp/lib is always present and loadable.

// Suppress Node's DEP0190 the same way mcp/consult.js does: spawn(.., {shell:true})
// is required on Windows to launch .cmd shims, and the warning would otherwise
// print at every session start. Other warnings still surface.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.code === 'DEP0190') return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

import { spawn } from 'node:child_process';
import { resolveCmd, SPAWN_OPTS, spawnableCmd } from '../../mcp/lib/resolve-cmd.js';
import { loadSettings, runnerSettings, localConfigured } from '../../mcp/lib/settings.js';
import { fetchTags, modelFacts, resolveModel, savedNicknames } from '../../mcp/lib/local-models.js';
import { runnerKey, swapStatus, resolveSwapModel, asOllamaSettings } from '../../mcp/lib/local-runners.js';

function check(binPath, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(spawnableCmd(binPath), args, { stdio: ['ignore', 'pipe', 'pipe'], ...SPAWN_OPTS });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve({ exit: 124, out, err }); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exit: code ?? 0, out, err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ exit: 127, out, err: e.message }); });
  });
}

// Only called when a local runner (or 0.11.0's local_model) is configured --
// otherwise everyone without a local setup would get a warning every session
// for a feature they don't use. Says what to do in one line.
async function checkLocal(settings, timeoutMs) {
  const runner = runnerSettings(settings);
  const label = runner.type ?? 'local runner';
  let key;
  try { key = await runnerKey(runner); }
  catch (e) { return `[consult] ${e.message}`; }
  if (runner.type === 'llama-swap') {
    const status = await swapStatus(runner, key.api_key, timeoutMs);
    if (!status.reachable) return `[consult] llama-swap: not running at ${runner.url} (start: ${runner.start || 'llama-swap'}) - ask_local will fail until it is.`;
    if (status.reason === 'needs_key') return `[consult] llama-swap: needs its key - run /consult:setlocal, or add llama-swap.key_env to ~/.claude/consult.local.md.`;
    if (status.reason === 'key_missing') return `[consult] llama-swap: ${status.details}`;
    if (status.reason === 'key_rejected') return `[consult] llama-swap: rejected the key from ${runner.key_env}.`;
    if (!Array.isArray(status.models)) return null;
    try {
      // status.models carries each model's id and aliases, all resolution needs.
      resolveSwapModel(null, status.models, runner.nicknames);
      return null;
    } catch (e) {
      if (/No local model configured/.test(e.message)) return '[consult] llama-swap: no default model; run /consult:setlocal.';
      return `[consult] llama-swap: ${e.message}`;
    }
  }
  // Ollama (or the 0.11.0 settings): judge the default the way ask_local will:
  // it may be a nickname, or a quant the user swapped for another.
  const view = runner.type === 'ollama' ? asOllamaSettings(settings, runner.nicknames) : settings;
  const tags = await fetchTags(runner.url, timeoutMs);
  const facts = tags === null ? null : modelFacts(tags, null);
  if (facts !== null) {
    try {
      resolveModel(null, facts, savedNicknames(view));
      return null;
    } catch (e) {
      return `[consult] ${e.message}`;
    }
  }
  try {
    const headers = key.api_key ? { Authorization: `Bearer ${key.api_key}` } : {};
    const res = await fetch(`${runner.url.replace(/\/+$/, '')}/models`, { headers, redirect: key.api_key ? 'error' : 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return `[consult] ${label} at ${runner.url} returned HTTP ${res.status} - ask_local will fail.`;
    const body = await res.json().catch(() => null);
    const models = (body?.data || []).map(m => m.id);
    const model = runner.nicknames.default;
    if (model && models.length && !models.includes(model)) {
      return `[consult] the default local model "${model}" is not available - pick from: ${models.slice(0, 5).join(', ')}, or run /consult:setlocal.`;
    }
    return null;
  } catch (_) {
    const how = runner.start || (runner.type === null || runner.type === 'ollama' ? '`ollama serve`' : runner.type);
    return `[consult] no local model runner at ${runner.url} - start it (${how}) to enable ask_local.`;
  }
}

async function main() {
  // Drain the SessionStart payload without depending on it, and unref stdin so
  // it does not keep the process alive after main() returns.
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.unref();

  const settings = loadSettings();
  const codexBin = resolveCmd('codex');
  const agyBin = resolveCmd('agy');

  // `--version` for agy is free; anything that reaches the backend costs time.
  // The legacy gemini CLI is opt-in, so it is not checked.
  const [codex, agy, localWarning] = await Promise.all([
    codexBin.found ? check(codexBin.path, ['login', 'status'], 5000) : null,
    agyBin.found ? check(agyBin.path, ['--version'], 5000) : null,
    localConfigured(settings) ? checkLocal(settings, 3000) : null
  ]);

  const warnings = [];
  if (localWarning) warnings.push(localWarning);
  const settingsWarnings = settings._warnings ?? [];
  if (settingsWarnings.length > 0) {
    warnings.push(`[consult] settings: ${settingsWarnings[0]}${settingsWarnings.length > 1 ? ` (and ${settingsWarnings.length - 1} more; local_status lists them)` : ''}`);
  }
  if (!codex) {
    warnings.push('[consult] codex CLI not found - install it or fix PATH to enable ask_codex.');
  } else if (codex.exit !== 0 || /not\s+logged\s+in|signed\s+out/i.test(codex.out + codex.err)) {
    warnings.push('[consult] codex not authenticated - call MCP tool `codex_login_start` or run `codex login` in a terminal.');
  }
  if (!agy) {
    warnings.push('[consult] agy (Antigravity) CLI not found - install from https://antigravity.google to enable ask_agy. If you just installed it, open a NEW terminal and start Claude Code from there: a terminal keeps the PATH it started with.');
  } else if (agy.exit !== 0) {
    warnings.push('[consult] agy CLI invocation failed - run `agy --version` to diagnose.');
  }

  for (const w of warnings) process.stderr.write(w + '\n');
  // exitCode rather than process.exit() so pending stderr writes drain first.
  process.exitCode = 0;
}

main().catch((e) => { try { process.stderr.write(`[consult] auth-check error: ${e.message}\n`); } catch (_) {} process.exitCode = 0; });
