// Read settings from .claude/consult.local.md (YAML frontmatter only).
// Project-level (cwd) wins; global (~/.claude/consult.local.md) is a fallback.
// We deliberately keep this dependency-free: just a tiny frontmatter parser.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BASE_URL, isLoopback, validateBaseUrl, LOCAL_REASONING_EFFORTS } from './local.js';
import { AGY_EFFORTS, AGY_IMAGE_ASPECT_RATIOS } from './agy.js';
import { DEFAULT_MAX_EDGE, CODEX_IMAGE_ASPECT_RATIOS } from './image.js';
import { REASONING_EFFORTS } from './util.js';
import { CONSULT_DEFAULTS } from './defaults.js';
import { RUNNER_TYPES, RUNNER_KEYS, STANDARD_URLS, LEGACY_ROLE_KEYS, isValidEnvName } from './local-runners.js';

export const DEFAULTS = Object.freeze({
  codex_model: null,                // null -> CLI default
  codex_reasoning_effort: null,     // minimal | low | medium | high | xhigh | max | ultra | null (model-dependent)
  codex_sandbox: 'read-only',
  codex_timeout_ms: null,           // null -> max(timeout_ms, 600000); see CODEX_TIMEOUT_FLOOR_MS
  codex_hooks: false,               // run the user's ~/.codex hooks on consult calls (off: --disable hooks)
  agy_model: null,                  // null -> CLI default; see `agy models`
  agy_effort: null,                 // low | medium | high | xhigh | max | null (model-dependent)
  agy_timeout_ms: null,             // null -> falls back to timeout_ms
  agy_image_dir: null,              // null -> <project>/consult-images, or ~/Pictures/consult-images
  agy_image_timeout_ms: CONSULT_DEFAULTS.agy_image_timeout_ms, // agy_generate_image takes ~1 min per image
  agy_image_aspect_ratio: '1:1',    // 1:1 2:3 3:2 3:4 4:3 9:16 16:9, or auto (agy picks from the content)
  codex_image_dir: null,            // null -> <project>/consult-images, or ~/Pictures/consult-images
  codex_image_timeout_ms: CONSULT_DEFAULTS.codex_image_timeout_ms, // codex_generate_image takes ~1 min per image
  codex_image_aspect_ratio: '1:1',  // 1:1 2:3 3:2 3:4 4:3 9:16 16:9, or auto (the model picks from the content)
  gemini_model: null,
  gemini_approval_mode: 'plan',     // "default" | "auto_edit" | "yolo" | "plan"
  claude_model: null,               // null -> CLI default
  local_base_url: DEFAULT_BASE_URL, // Ollama; LM Studio = http://127.0.0.1:1234/v1
  local_model: null,                // no sane default -- must be set to use ask_local
  local_api_key: null,              // Ollama/llama.cpp ignore it; LM Studio/vLLM may not
  local_temperature: null,          // null -> runner default
  local_reasoning_effort: null,     // "none" | "low" | "medium" | "high" | null
  local_timeout_ms: null,           // null -> falls back to timeout_ms
  local_image_max_edge: DEFAULT_MAX_EDGE, // downscale images past this long edge before sending
  local_vram_mb: null,              // null -> nvidia-smi's reading; decides which models fit the GPU
  local_model_fast: null,           // nicknames, written by /consult:setlocal after the user confirms
  local_model_vision: null,
  local_model_vision_best: null,
  local_model_big: null,
  council_use_bare: null,           // null -> auto-detect from ANTHROPIC_API_KEY env var
  council_timeout_ms: null,         // null -> falls back to timeout_ms
  timeout_ms: CONSULT_DEFAULTS.timeout_ms,
  log_calls: false                  // append every call to ~/.claude/consult-log.jsonl
});

// Keys only the Claude Code mod reads; they live in the same file.
const MOD_KEYS = ['notify_after_s', 'history_size', 'summary_model'];

// Every top-level key a settings file may hold. A runner's own settings are
// `<runner>.<key>` (RUNNER_TYPES x RUNNER_KEYS) and checked separately.
export const KNOWN_KEYS = Object.freeze([...Object.keys(DEFAULTS), ...MOD_KEYS, 'local_runner']);

// A settings key: letters, digits and _, plus . and - for `llama-swap.fast`.
// Only at the start of the line: indented lines are not read (see
// frontmatterWarnings), so a nested YAML block can't overwrite a top-level key.
const KEY_LINE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/;

function frontmatterLines(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1].split(/\r?\n/) : null;
}

export function isRunnerKey(key) {
  return key === 'local_runner' || (key.includes('.') && RUNNER_TYPES.includes(key.slice(0, key.indexOf('.'))));
}

// Delegate (background task) settings: `delegate.<key>`, global-only like the
// runner settings. They are not in KNOWN_KEYS: the mod keeps a copy of that
// list and does not read them.
export const DELEGATE_WORKERS = Object.freeze(['codex', 'agy', 'local']);
const DELEGATE_TABLE_KEYS = ['code', 'research', 'review', 'private'];
// A table row names a worker, or `ask`: the delegate tool then asks which worker, as for a task of kind `other`.
const DELEGATE_TABLE_CHOICES = Object.freeze([...DELEGATE_WORKERS, 'ask']);
export const DELEGATE_KEYS = Object.freeze([
  ...DELEGATE_TABLE_KEYS.map(kind => `delegate.${kind}`),
  'delegate.local_at_once', 'delegate.on_close', 'delegate.time_limit_min'
]);
const DELEGATE_TABLE_DEFAULTS = Object.freeze({ code: 'codex', research: 'agy', review: 'agy', private: 'local' });
const DELEGATE_ON_CLOSE = ['stop', 'keep'];
const LOCAL_AT_ONCE_MAX = 8;
const TIME_LIMIT_MIN_MINUTES = 10;
const TIME_LIMIT_MAX_MINUTES = 1440;
const DEFAULT_TIME_LIMIT_MINUTES = 180;

export function isDelegateKey(key) {
  return key.startsWith('delegate.');
}

// Settings that describe this machine, not a project: read from the global file only.
function isGlobalOnlyKey(key) {
  return isRunnerKey(key) || isDelegateKey(key);
}

// Why a `delegate.*` value is refused, or null when it is fine (or unset).
export function delegateProblem(key, value) {
  if (value === null) return null;
  const field = key.slice('delegate.'.length);
  if (DELEGATE_TABLE_KEYS.includes(field)) {
    return DELEGATE_TABLE_CHOICES.includes(value) ? null : `must be one of ${DELEGATE_TABLE_CHOICES.join(', ')}`;
  }
  if (field === 'on_close') {
    return DELEGATE_ON_CLOSE.includes(value) ? null : `must be one of ${DELEGATE_ON_CLOSE.join(', ')}`;
  }
  if (field === 'local_at_once') {
    const isSlotCount = Number.isInteger(value) && value >= 1 && value <= LOCAL_AT_ONCE_MAX;
    return value === 'auto' || isSlotCount ? null : `must be auto or a whole number from 1 to ${LOCAL_AT_ONCE_MAX}`;
  }
  if (field === 'time_limit_min') {
    const isInRange = Number.isInteger(value) && value >= TIME_LIMIT_MIN_MINUTES && value <= TIME_LIMIT_MAX_MINUTES;
    return isInRange ? null : `must be a whole number of minutes from ${TIME_LIMIT_MIN_MINUTES} to ${TIME_LIMIT_MAX_MINUTES}`;
  }
  return 'is not a delegate setting';
}

// The delegate settings in effect, from the (sanitized) global settings.
function delegateSettings(globalSettings) {
  const table = {};
  for (const kind of DELEGATE_TABLE_KEYS) {
    table[kind] = globalSettings[`delegate.${kind}`] ?? DELEGATE_TABLE_DEFAULTS[kind];
  }
  const minutes = globalSettings['delegate.time_limit_min'] ?? DEFAULT_TIME_LIMIT_MINUTES;
  return {
    table,
    local_at_once: globalSettings['delegate.local_at_once'] ?? 'auto',
    on_close: globalSettings['delegate.on_close'] ?? 'stop',
    time_limit_ms: minutes * 60000
  };
}

// Problems a reader would otherwise pass over in silence: an unknown key, a
// runner that isn't one, an indented line. Each is "line <n>: ..." with the
// file's own line number (the opening --- is line 1); the loaders put the
// file's path in front. Never thrown: one bad line never disables consult.
export function frontmatterWarnings(text, { projectScope = false } = {}) {
  const lines = frontmatterLines(text);
  if (lines === null) return [];
  const warnings = [];
  const runnerLines = [];
  const seenAt = new Map();
  let runnerChosen = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 2;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\s/.test(line)) {
      warnings.push(`line ${lineNumber}: indented lines aren't supported; write \`runner.key: value\``);
      continue;
    }
    const found = KEY_LINE.exec(line);
    if (!found) continue;
    const key = found[1];
    if (seenAt.has(key)) {
      warnings.push(`line ${lineNumber}: \`${key}\` is set again (line ${seenAt.get(key)}); only the last one counts`);
      seenAt.set(key, lineNumber);
      continue;
    }
    seenAt.set(key, lineNumber);
    if (projectScope && isGlobalOnlyKey(key)) {
      const kind = isRunnerKey(key) ? 'runner' : 'delegate';
      warnings.push(`line ${lineNumber}: ignored \`${key}\`: ${kind} settings are global-only (~/.claude/consult.local.md)`);
      continue;
    }
    if (isDelegateKey(key)) {
      if (!DELEGATE_KEYS.includes(key)) {
        warnings.push(`line ${lineNumber}: unknown setting \`${key}\``);
        continue;
      }
      const problem = delegateProblem(key, parseValue(found[2]));
      if (problem !== null) warnings.push(`line ${lineNumber}: ignored \`${key}\`: ${problem}`);
      continue;
    }
    if (key === 'local_runner') {
      runnerChosen = true;
      const value = found[2].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
      if (value !== '' && value !== 'null' && !RUNNER_TYPES.includes(value)) {
        warnings.push(`line ${lineNumber}: \`local_runner\` must be one of ${RUNNER_TYPES.join(', ')}`);
      }
      continue;
    }
    if (KNOWN_KEYS.includes(key)) continue;
    const dot = key.indexOf('.');
    if (dot > 0) {
      const prefix = key.slice(0, dot);
      if (!RUNNER_TYPES.includes(prefix)) {
        warnings.push(`line ${lineNumber}: unknown runner \`${prefix}\` in \`${key}\``);
        continue;
      }
      if (RUNNER_KEYS.includes(key.slice(dot + 1))) {
        runnerLines.push(key);
        continue;
      }
    }
    warnings.push(`line ${lineNumber}: unknown setting \`${key}\``);
  }
  if (!projectScope && !runnerChosen && runnerLines.length > 0) {
    warnings.push(`\`local_runner\` isn't set, so the runner settings (${runnerLines.join(', ')}) are not used`);
  }
  return warnings;
}

// The value on a `key: value` line, as parseFrontmatter reads it.
function parseValue(rawValue) {
  // A quoted value ends at its closing quote; otherwise ` # ...` is a trailing
  // comment, as in YAML (a `#` with no space before it stays in the value).
  const quoted = rawValue.match(/^(['"])(.*?)\1/);
  if (quoted) return quoted[2];
  const val = rawValue.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
  if (val === '' || val.toLowerCase() === 'null') return null;
  // Floats matter for `local_temperature` (0.0-2.0). Integers stay integers.
  if (/^-?\d+(?:\.\d+)?$/.test(val)) return Number(val);
  if (val === 'true' || val === 'false') return val === 'true';
  return val;
}

export function parseFrontmatter(text) {
  // Strip a leading UTF-8 BOM. Windows editors (Notepad, some VS Code configs)
  // prepend one and the regex-from-line-start would otherwise silently miss.
  // Accepts files starting with `---\n...\n---\n` (YAML-ish key: value lines).
  const lines = frontmatterLines(text);
  if (lines === null) return {};
  const out = {};
  for (const line of lines) {
    const mm = line.match(KEY_LINE);
    if (!mm) continue;
    out[mm[1]] = parseValue(mm[2]);
  }
  return out;
}

const ENUMS = {
  codex_reasoning_effort: [...REASONING_EFFORTS, null],
  codex_sandbox: ['read-only', 'workspace-write', 'danger-full-access'],
  gemini_approval_mode: ['default', 'auto_edit', 'yolo', 'plan'],
  agy_effort: [...AGY_EFFORTS, null],
  agy_image_aspect_ratio: AGY_IMAGE_ASPECT_RATIOS,
  codex_image_aspect_ratio: CODEX_IMAGE_ASPECT_RATIOS,
  local_reasoning_effort: [...LOCAL_REASONING_EFFORTS, null]
};

const POSITIVE_INTS = ['timeout_ms', 'council_timeout_ms', 'local_timeout_ms', 'agy_timeout_ms', 'agy_image_timeout_ms', 'codex_image_timeout_ms', 'codex_timeout_ms', 'local_image_max_edge', 'local_vram_mb'];
const MODEL_NAMES = ['local_model', 'local_model_fast', 'local_model_vision', 'local_model_vision_best', 'local_model_big'];
const BOOLEANS = ['council_use_bare', 'log_calls', 'codex_hooks'];

export function sanitize(parsed) {
  const out = { ...parsed };
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (key in out && !allowed.includes(out[key])) {
      // Drop invalid values silently and let DEFAULTS win.
      delete out[key];
    }
  }
  for (const key of POSITIVE_INTS) {
    if (key in out && (typeof out[key] !== 'number' || out[key] <= 0)) delete out[key];
  }
  for (const key of BOOLEANS) {
    if (key in out && typeof out[key] !== 'boolean') delete out[key];
  }
  for (const key of MODEL_NAMES) {
    if (key in out && out[key] !== null && (typeof out[key] !== 'string' || out[key].trim() === '')) delete out[key];
  }
  // Temperature is a float in [0, 2] per the OpenAI API. Out-of-range values
  // make runners 400, so drop them here rather than surfacing that later.
  if ('local_temperature' in out &&
      (typeof out.local_temperature !== 'number' || out.local_temperature < 0 || out.local_temperature > 2)) {
    delete out.local_temperature;
  }
  // A malformed base_url would throw on every ask_local. Drop it so the
  // loopback default wins -- consistent with how every other bad value degrades.
  if ('local_base_url' in out && out.local_base_url !== null) {
    try { validateBaseUrl(out.local_base_url); }
    catch (_) { delete out.local_base_url; }
  }
  // Runner settings: the same rules per key, so a bad line degrades to unset.
  if ('local_runner' in out && !RUNNER_TYPES.includes(out.local_runner)) delete out.local_runner;
  for (const key of Object.keys(out)) {
    if (isDelegateKey(key) && (out[key] === null || delegateProblem(key, out[key]) !== null)) delete out[key];
  }
  for (const key of Object.keys(out)) {
    if (!key.includes('.') || !isRunnerKey(key)) continue;
    const field = key.slice(key.indexOf('.') + 1);
    const value = out[key];
    if (!RUNNER_KEYS.includes(field) || value === null) { delete out[key]; continue; }
    if (typeof value !== 'string' || value.trim() === '') { delete out[key]; continue; }
    if (field === 'url') {
      try { validateBaseUrl(value); } catch (_) { delete out[key]; }
    } else if (field === 'key_env' && !isValidEnvName(value)) {
      delete out[key];
    }
  }
  return out;
}

// The runner in use and its settings. With `local_runner` unset this is the
// 0.11.0 path (`legacy: true`): local_base_url, local_api_key and the
// local_model* lines, as before. With `local_runner: ollama`, those 0.11.0
// lines in the global file fill whatever `ollama.*` leaves unset.
export function runnerSettings(settings, requestedType = undefined) {
  const wanted = requestedType === undefined ? settings?.local_runner : requestedType;
  const type = RUNNER_TYPES.includes(wanted) ? wanted : null;
  const nicknames = {};
  if (type === null) {
    for (const [role, legacyKey] of Object.entries(LEGACY_ROLE_KEYS)) nicknames[role] = settings?.[legacyKey] ?? null;
    return {
      type: null, legacy: true,
      url: settings?.local_base_url ?? DEFAULT_BASE_URL,
      key_env: null, start: null, api_key: settings?.local_api_key ?? null,
      nicknames
    };
  }
  // The 0.11.0 lines Ollama may fill from: the global file's (runner settings
  // are global-only), which is the file in effect when there is no project file.
  const legacySource = settings._global ?? settings;
  for (const [role, legacyKey] of Object.entries(LEGACY_ROLE_KEYS)) {
    let value = settings[`${type}.${role}`] ?? null;
    if (value === null && type === 'ollama') value = legacySource[legacyKey] ?? null;
    nicknames[role] = value;
  }
  let url = settings[`${type}.url`] ?? null;
  if (url === null && type === 'ollama') url = legacySource.local_base_url ?? null;
  if (url === null) url = STANDARD_URLS[type] ?? null;
  return {
    type, legacy: false, url,
    key_env: settings[`${type}.key_env`] ?? null,
    start: settings[`${type}.start`] ?? null,
    api_key: null,
    nicknames
  };
}

// The runner types the settings mention: the one in use and every type with
// a `<runner>.*` line. Each as runnerSettings gives it.
export function configuredRunners(settings) {
  const types = [];
  if (RUNNER_TYPES.includes(settings?.local_runner)) types.push(settings.local_runner);
  for (const key of Object.keys(settings ?? {})) {
    const dot = key.indexOf('.');
    if (dot <= 0) continue;
    const type = key.slice(0, dot);
    if (RUNNER_TYPES.includes(type) && !types.includes(type)) types.push(type);
  }
  const runners = [];
  for (const type of types) runners.push(runnerSettings(settings, type));
  return runners;
}

// A runner a call may name with `runner`: one the settings mention, or a
// type with a standard address. Never an address.
export function runnerFor(settings, type) {
  if (!RUNNER_TYPES.includes(type)) {
    throw new Error(`Unknown runner \`${type}\`. Use one of: ${RUNNER_TYPES.join(', ')}.`);
  }
  for (const runner of configuredRunners(settings)) {
    if (runner.type === type) return runner;
  }
  const runner = runnerSettings(settings, type);
  if (runner.url === null) {
    throw new Error(`\`${type}\` isn't set up: it has no standard address. Run /consult:setlocal ${type} to add it.`);
  }
  return runner;
}

// Whether the person set up a local model at all: a runner chosen, or (the
// 0.11.0 way) a local_model. The session-start check, the mod's band and the
// council all ask this.
export function localConfigured(settings) {
  if (RUNNER_TYPES.includes(settings?.local_runner)) return true;
  return typeof settings?.local_model === 'string' && settings.local_model !== '';
}

// Resolution order: project-level (cwd) wins, then global (~/.claude/...),
// then built-in DEFAULTS. First file found wins -- they don't merge layer by
// layer, to keep precedence simple and predictable.
//
// Cached by (path, mtimeMs). Invalidates on file modification; falls through to
// the next candidate if the cached file is deleted. The cache is keyed on the
// FIRST matching candidate, so a newly-created higher-priority file (cwd)
// correctly displaces a cached lower-priority hit (home).

let cache = null; // { path: string|null, mtimeMs: number, settings: object }

function warnIfProjectEscalation(parsed, sourcePath, isProjectScope) {
  if (!isProjectScope) return;
  if (parsed.codex_sandbox === 'danger-full-access') {
    process.stderr.write(
      `[consult] WARNING: project-scoped config at ${sourcePath} sets ` +
      `codex_sandbox=danger-full-access. This grants Codex full disk-write ` +
      `access whenever invoked from this directory. If this project came from ` +
      `a source you don't fully trust (PR review, downloaded repo, etc.), ` +
      `consider moving sandbox overrides to global ~/.claude/consult.local.md.\n`
    );
  }
  // A project-scoped config is attacker-controlled in any repo you didn't
  // write. Pointing local_base_url off-box turns "consult a local model" into
  // "POST every prompt to a stranger's server" -- silently, since the tool
  // still appears to work. Same threat shape as the sandbox escalation above.
  if (parsed.local_base_url && !isLoopback(parsed.local_base_url)) {
    process.stderr.write(
      `[consult] WARNING: project-scoped config at ${sourcePath} sets ` +
      `local_base_url=${parsed.local_base_url}, which is NOT a loopback address. ` +
      `Every ask_local prompt from this directory will be sent to that host. ` +
      `If you did not add this yourself, treat it as prompt exfiltration and ` +
      `remove it. Remote endpoints belong in global ~/.claude/consult.local.md.\n`
    );
  }
}

export function loadSettings() {
  const projectPath = path.join(process.cwd(), '.claude', 'consult.local.md');
  const globalPath = path.join(os.homedir(), '.claude', 'consult.local.md');
  // A host that starts the server in the home directory (rather than a
  // project) would otherwise read the GLOBAL file as a project file and apply
  // the project-scope security warnings to it.
  const sameFile = path.resolve(projectPath).toLowerCase() === path.resolve(globalPath).toLowerCase();
  const candidates = [
    ...(sameFile ? [] : [{ path: projectPath, projectScope: true }]),
    { path: globalPath, projectScope: false },
  ];
  // Runner settings (`local_runner`, `<runner>.*`) describe this machine, not a
  // project: they are read from the global file whichever file is in effect,
  // and a project file's are ignored with a warning.
  const globalStat = statOrNull(globalPath);
  for (const { path: p, projectScope } of candidates) {
    const stat = statOrNull(p);
    if (stat === null) continue;
    const globalMtime = globalStat ? globalStat.mtimeMs : 0;
    if (cache && cache.path === p && cache.mtimeMs === stat.mtimeMs && cache.globalMtimeMs === globalMtime) {
      return cache.settings;
    }
    try {
      const text = fs.readFileSync(p, 'utf8');
      const parsed = sanitize(parseFrontmatter(text));
      warnIfProjectEscalation(parsed, p, projectScope);
      const warnings = [];
      for (const warning of frontmatterWarnings(text, { projectScope })) warnings.push(`${p} ${warning}`);
      let global = parsed;
      if (projectScope) {
        for (const key of Object.keys(parsed)) {
          if (isGlobalOnlyKey(key)) delete parsed[key];
        }
        global = {};
        if (globalStat !== null) {
          try {
            const globalText = fs.readFileSync(globalPath, 'utf8');
            global = sanitize(parseFrontmatter(globalText));
            for (const warning of frontmatterWarnings(globalText)) warnings.push(`${globalPath} ${warning}`);
          } catch (_) { /* no global file: no runner settings */ }
        }
      }
      const globalOnlyKeys = {};
      for (const key of Object.keys(global)) {
        if (isGlobalOnlyKey(key)) globalOnlyKeys[key] = global[key];
      }
      const settings = {
        ...DEFAULTS, ...parsed, ...globalOnlyKeys,
        delegate: delegateSettings(global), _source: p, _global: global, _warnings: warnings
      };
      cache = { path: p, mtimeMs: stat.mtimeMs, globalMtimeMs: globalMtime, settings };
      return settings;
    } catch (_) { /* fall through */ }
  }
  if (cache && cache.path === null) return cache.settings;
  const settings = { ...DEFAULTS, delegate: delegateSettings({}), _source: null, _global: {}, _warnings: [] };
  cache = { path: null, mtimeMs: 0, globalMtimeMs: 0, settings };
  return settings;
}

function statOrNull(filePath) {
  try { return fs.statSync(filePath); } catch (_) { return null; }
}
