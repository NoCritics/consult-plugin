// Claude CLI wrapper. Invokes `claude -p --output-format json` headless.
//
// Two modes:
//   - default (subscription/OAuth): `--safe-mode` -- Claude Code's own system
//     prompt loads, but every customization is off: CLAUDE.md, skills,
//     plugins, hooks, MCP servers (which would otherwise include THIS server,
//     plus every other one the user has configured, each spawned per call).
//   - bare (--bare): additionally skips keychain/OAuth, LSP, auto-memory. The
//     system prompt is whatever you pass via --system-prompt (we pass a
//     minimal one). Requires ANTHROPIC_API_KEY: OAuth is never read in bare
//     mode.
//
// Both modes also get `--tools ""` (a council participant answers, it does not
// act), `--strict-mcp-config`, `--no-session-persistence` (nothing to resume,
// don't litter ~/.claude/projects) and `--disable-slash-commands` (a prompt
// starting with `/` must reach the model as text, not run a skill).
//
// Resolution for bare:
//   - per-call `use_bare: true|false` always wins
//   - else auto-detect: bare if ANTHROPIC_API_KEY is set, else not
//   - if bare requested but key absent: throw clean error (no silent fallback)

import { runCli } from './spawn-cli.js';
import { EMPTY_ARG } from './resolve-cmd.js';
import { validateModel, requireString, scrubPii } from './util.js';

const BARE_SYSTEM_PROMPT =
  'You are a helpful AI assistant. Reply only with the answer to the prompt. ' +
  'Do not narrate, do not preamble, do not append meta-commentary.';

// Exported for unit tests -- the flag set is the contract, not an impl detail.
export const CLAUDE_COMMON_ARGS = Object.freeze([
  '-p', '--output-format', 'json',
  '--tools', EMPTY_ARG,   // see resolve-cmd.js: '' is dropped under shell:true
  '--strict-mcp-config',
  '--no-session-persistence',
  '--disable-slash-commands'
]);

export function buildClaudeArgs({ bare, model, system_prompt }) {
  const args = [...CLAUDE_COMMON_ARGS];
  if (bare) {
    args.push('--bare', '--system-prompt', system_prompt || BARE_SYSTEM_PROMPT);
  } else {
    args.push('--safe-mode');
    // Non-bare: append rather than replace so Claude Code's defaults stay.
    if (system_prompt) args.push('--append-system-prompt', system_prompt);
  }
  if (model) args.push('--model', model);
  return args;
}

function resolveBare(use_bare) {
  if (typeof use_bare === 'boolean') {
    if (use_bare && !process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'use_bare=true requested but ANTHROPIC_API_KEY env var is not set. ' +
        'Bare mode requires API-key auth (subscription/OAuth does not apply). ' +
        'Set ANTHROPIC_API_KEY or pass use_bare=false.'
      );
    }
    return use_bare;
  }
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function askClaude({ prompt, model, use_bare, system_prompt, timeout_ms = 180000 }) {
  requireString('prompt', prompt);
  validateModel(model);
  const bare = resolveBare(use_bare);

  const args = buildClaudeArgs({ bare, model, system_prompt });

  const { stdout, latency_ms } = await runCli({ cmd: 'claude', args, prompt, timeout_ms, label: 'claude' });

  let parsed;
  try { parsed = JSON.parse(stdout.trim()); }
  catch (e) {
    throw new Error(scrubPii(`claude JSON parse failed: ${e.message}. stdout (first 2000): ${stdout.slice(0, 2000)}`));
  }

  if (parsed.is_error) {
    throw new Error(scrubPii(`claude returned error: ${parsed.result || parsed.error || JSON.stringify(parsed).slice(0, 500)}`));
  }
  if (typeof parsed.result !== 'string') {
    throw new Error(scrubPii(`claude JSON missing .result field: ${JSON.stringify(parsed).slice(0, 500)}`));
  }

  let actualModel = model ?? '(claude default)';
  if (parsed.modelUsage && typeof parsed.modelUsage === 'object') {
    const names = Object.keys(parsed.modelUsage);
    if (names.length) actualModel = names[0];
  }

  return {
    response: parsed.result.trim(),
    model: actualModel,
    latency_ms,
    bare,
    cost_usd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null
  };
}
