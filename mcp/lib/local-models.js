// Local model inventory: the facts a choice needs, nickname proposals, and
// name resolution. Everything here is read from Ollama's `/api/tags` at call
// time; nothing names a model in code, because the user's list changes
// whenever they download or delete one.
//
// Nicknames are the user's, confirmed through /consult:setlocal. Consult
// proposes them from facts and never changes one by itself. The one automatic
// step is a quant swap: a saved model is gone and exactly one installed model
// has the same name before the colon. The result always says so.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONSULT_DEFAULTS } from './defaults.js';
import { readCapped } from './local.js';

// A model that doesn't fit the GPU can take 2+ minutes to load and then
// writes a few tokens a second, so its calls get at least this long. Shared
// with the mod's bar through defaults.json.
export const LOCAL_SLOW_FLOOR_MS = CONSULT_DEFAULTS.local_slow_floor_ms;

// What a model needs beyond its file to run on the GPU: the context cache at
// the server's OLLAMA_CONTEXT_LENGTH, plus the desktop. Checked against the
// user's load tests: 6.6 GB models load fully on 8 GB, 11 GB ones run ~43%.
const VRAM_HEADROOM_MB = 1024;

// Two picks this close in size are a tie the user decides (e.g. the regular
// and the abliterated 27B at one quant).
const TIE_SIZE_BYTES = 0.2e9;

export const NICKNAME_ROLES = Object.freeze(['default', 'fast', 'vision', 'vision_best', 'big']);

// The spellings a caller may use for each role.
export const NICKNAME_SPELLINGS = Object.freeze({
  default: 'default',
  fast: 'fast',
  vision: 'vision',
  'vision-best': 'vision_best',
  vision_best: 'vision_best',
  big: 'big'
});

const NO_MODEL_CONFIGURED =
  'No local model configured. Set `local_model` in .claude/consult.local.md ' +
  '(e.g. `local_model: qwen3.5:9b`) or pass `model` to the tool. ' +
  'Call `local_status` to list what the runner has available.';

export function baseName(name) {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(0, colon);
}

// Bits per weight read from a quant label: Q5_K_M -> 5, IQ4_XS -> 4,
// ud-iq3_xxs -> 3. Unknown labels rank lowest.
export function quantRank(quant) {
  const found = /(?:^|[^a-z])i?q(\d+)/i.exec(String(quant ?? ''));
  return found ? Number(found[1]) : 0;
}

function parseParams(parameterSize) {
  const found = /^([\d.]+)\s*([BM])?/i.exec(String(parameterSize ?? ''));
  if (!found) return 0;
  const value = Number(found[1]);
  return found[2] && found[2].toUpperCase() === 'M' ? value / 1000 : value;
}

function canonicalOf(names) {
  const sorted = [...names].sort();
  for (const name of sorted) {
    if (!name.endsWith(':latest')) return name;
  }
  return sorted[0];
}

// A name that could break a settings line is never listed (it may be written
// into consult.local.md). local-runners.js applies the same rule.
export const UNSAFE_NAME = /[\x00-\x1f\x7f#]/;

// Ollama lists what each model can do; one that can only embed can't answer
// a chat. A model with no list (an older Ollama) is kept.
export function canReply(model) {
  if (!Array.isArray(model?.capabilities) || model.capabilities.length === 0) return true;
  return model.capabilities.includes('completion');
}

export function modelFacts(tags, vramMb) {
  const groups = new Map();
  for (const model of tags?.models ?? []) {
    if (!model || typeof model.name !== 'string') continue;
    // llama-server answers /api/tags in Ollama's shape with empty digests and
    // sizes; without them there are no facts to go on, so: no inventory.
    if (typeof model.digest !== 'string' || model.digest === '' || typeof model.size !== 'number' || model.size <= 0) return null;
    // A name is written into consult.local.md; one that could break a line never is.
    if (UNSAFE_NAME.test(model.name)) continue;
    if (!canReply(model)) continue;
    const key = model.digest || model.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  const usableBytes = typeof vramMb === 'number' && vramMb > 0 ? (vramMb - VRAM_HEADROOM_MB) * 1048576 : null;
  const facts = [];
  for (const members of groups.values()) {
    const names = [];
    for (const member of members) names.push(member.name);
    const name = canonicalOf(names);
    const first = members[0];
    const aliases = [];
    for (const other of [...names].sort()) {
      if (other !== name) aliases.push(other);
    }
    const capabilities = Array.isArray(first.capabilities) ? first.capabilities : [];
    const size = typeof first.size === 'number' ? first.size : 0;
    facts.push({
      name,
      aliases,
      digest: first.digest ?? null,
      size_bytes: size,
      size_gb: Math.round(size / 1e8) / 10,
      params_b: parseParams(first.details?.parameter_size),
      params: first.details?.parameter_size ?? null,
      quant: first.details?.quantization_level ?? null,
      vision: capabilities.includes('vision'),
      thinking: capabilities.includes('thinking'),
      fits_gpu: usableBytes === null ? null : size <= usableBytes
    });
  }
  facts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return facts;
}

// LM Studio's /api/v1/models in the same shape, so its nicknames follow
// Ollama's rules. Chat models only (an embedding model can't answer). A
// parameter count like 35B-A3B or 512x56B is a mixture of experts. null when
// the answer isn't the model list.
export function lmstudioFacts(listJson, vramMb) {
  if (!Array.isArray(listJson?.models)) return null;
  const usableBytes = typeof vramMb === 'number' && vramMb > 0 ? (vramMb - VRAM_HEADROOM_MB) * 1048576 : null;
  const facts = [];
  for (const model of listJson.models) {
    if (model?.type !== 'llm' || typeof model.key !== 'string' || model.key === '' || UNSAFE_NAME.test(model.key)) continue;
    const params = typeof model.params_string === 'string' ? model.params_string : null;
    let arch = null;
    if (params !== null) arch = /-A\d|^\d+(\.\d+)?x\d/i.test(params) ? 'MoE' : 'dense';
    if (typeof model.architecture === 'string' && /moe$/i.test(model.architecture)) arch = 'MoE';
    const size = typeof model.size_bytes === 'number' ? model.size_bytes : 0;
    facts.push({
      id: model.key,
      name: model.key,
      aliases: [],
      label: typeof model.display_name === 'string' ? model.display_name : null,
      digest: null,
      size_bytes: size,
      size_gb: Math.round(size / 1e8) / 10,
      params_b: parseParams(params),
      params,
      quant: typeof model.quantization?.name === 'string' ? model.quantization.name : null,
      vision: model.capabilities?.vision === true,
      arch,
      loaded: Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0,
      fits_gpu: usableBytes === null ? null : size <= usableBytes
    });
  }
  facts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return facts;
}

function findFact(facts, name) {
  // Ollama reads a bare name as name:latest.
  const latest = name.includes(':') ? null : name + ':latest';
  for (const fact of facts) {
    if (fact.name === name || fact.aliases.includes(name)) return fact;
    if (latest !== null && (fact.name === latest || fact.aliases.includes(latest))) return fact;
  }
  return null;
}

// The name with its tag's trailing quant removed: qwen3.8-9b-distill:q5_k_m
// and :q4_k_m share one, mistral:7b-instruct-q8_0 keeps "7b-instruct", and
// qwen3.5:9b and qwen3.5:4b (sizes, not quants) differ.
function withoutQuant(name) {
  const colon = name.indexOf(':');
  if (colon < 0) return name;
  const tag = name.slice(colon + 1).replace(/(^|[-_.])(ud-)?(i?q\d+(_[a-z0-9]+)*|bf16|f16|f32)$/i, '');
  return name.slice(0, colon) + ':' + tag.toLowerCase();
}

// Other quants of the same model: the user's ruling is that only a quant
// change may be followed without asking.
function otherQuants(facts, name) {
  const stem = withoutQuant(name);
  const matches = [];
  for (const fact of facts) {
    if (withoutQuant(fact.name) === stem) matches.push(fact.name);
  }
  return matches.sort();
}

function bySizeThenName(a, b) {
  if (a.size_bytes !== b.size_bytes) return a.size_bytes - b.size_bytes;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// Every model within TIE_SIZE_BYTES of the first, in size order.
function withTies(sorted) {
  const picks = [];
  if (sorted.length === 0) return picks;
  for (const fact of sorted) {
    if (fact.size_bytes - sorted[0].size_bytes <= TIE_SIZE_BYTES) picks.push(fact);
  }
  return picks;
}

function smallest(candidates) {
  return withTies([...candidates].sort(bySizeThenName));
}

// Most parameters; then the higher-bit quant; then the smaller file.
function mostParams(candidates) {
  let most = -1;
  for (const fact of candidates) most = Math.max(most, fact.params_b);
  let bestQuant = -1;
  for (const fact of candidates) {
    if (fact.params_b === most) bestQuant = Math.max(bestQuant, quantRank(fact.quant));
  }
  const top = [];
  for (const fact of candidates) {
    if (fact.params_b === most && quantRank(fact.quant) === bestQuant) top.push(fact);
  }
  return withTies(top.sort(bySizeThenName));
}

function fitText(fact) {
  if (fact.fits_gpu === true) return 'fits the GPU';
  if (fact.fits_gpu === false) return 'partly on the CPU (slow)';
  return 'GPU fit unknown';
}

export function describeFact(fact) {
  return `${fact.params}, ${fact.size_gb} GB, ${fitText(fact)}, ${fact.vision ? 'reads images' : 'no vision'}`;
}

function rulePick(role, facts, fitKnown) {
  const fitting = [];
  for (const fact of facts) if (fact.fits_gpu === true) fitting.push(fact);
  if (role === 'fast') return fitKnown ? smallest(fitting) : [];
  if (role === 'default') return fitKnown ? mostParams(fitting) : [];
  if (role === 'vision') {
    const seeing = [];
    for (const fact of fitting) if (fact.vision) seeing.push(fact);
    return fitKnown ? mostParams(seeing) : [];
  }
  if (role === 'vision_best') {
    const seeing = [];
    for (const fact of facts) if (fact.vision) seeing.push(fact);
    return mostParams(seeing);
  }
  return mostParams(facts);
}

const RULES = Object.freeze({
  fast: 'smallest model that fits the GPU',
  default: 'most parameters among models that fit the GPU',
  vision: 'most parameters among vision models that fit the GPU',
  vision_best: 'most parameters among all vision models',
  big: 'most parameters overall'
});

// A saved value may itself be a nickname (`local_model: fast`): follow it.
function savedModelName(saved, role) {
  let value = saved[role] ?? null;
  let hops = 0;
  while (typeof value === 'string' && NICKNAME_SPELLINGS[value] && hops < NICKNAME_ROLES.length) {
    value = saved[NICKNAME_SPELLINGS[value]] ?? null;
    hops++;
  }
  return value;
}

export function proposeNicknames(facts, saved) {
  let fitKnown = false;
  for (const fact of facts) if (fact.fits_gpu !== null) fitKnown = true;
  const mentioned = new Set();
  const rows = [];
  for (const role of NICKNAME_ROLES) {
    const picks = rulePick(role, facts, fitKnown);
    const pickNames = [];
    for (const fact of picks) pickNames.push(fact.name);
    const savedName = savedModelName(saved, role);
    let state = 'none';
    let replacement = null;
    let proposed = pickNames;
    if (typeof savedName === 'string') {
      const installed = findFact(facts, savedName);
      if (installed) {
        state = 'kept';
        proposed = [installed.name];
        mentioned.add(installed.name);
      } else {
        const swaps = otherQuants(facts, savedName);
        if (swaps.length === 1) {
          state = 'replaced';
          replacement = swaps[0];
          proposed = [replacement];
          mentioned.add(replacement);
        } else {
          state = 'gone';
        }
      }
    }
    let reason;
    if (!fitKnown && (role === 'fast' || role === 'default' || role === 'vision')) {
      reason = `${RULES[role]}: GPU memory unknown, so nothing is proposed (set local_vram_mb)`;
    } else if (proposed.length === 0) {
      reason = `${RULES[role]}: no installed model qualifies`;
    } else {
      reason = describeFact(findFact(facts, proposed[0]));
      if (proposed.length > 1) reason += `; a tie with ${proposed.slice(1).join(', ')}, pick one`;
    }
    rows.push({ role, rule: RULES[role], rule_pick: pickNames, proposed, saved: savedName ?? null, saved_state: state, replacement, reason });
  }
  const newModels = [];
  for (const fact of facts) if (!mentioned.has(fact.name)) newModels.push(fact.name);
  return { rows, new_models: newModels, fit_known: fitKnown };
}

function goneMessage(label, savedName, swaps) {
  if (swaps.length > 1) {
    return `${label} points to \`${savedName}\`, which is no longer installed; several quants of ` +
      `${baseName(savedName)} are installed (${swaps.join(', ')}). Run /consult:setlocal to choose one.`;
  }
  return `${label} points to \`${savedName}\`, which is no longer installed; run /consult:setlocal`;
}

// A saved or requested full name: installed, or one quant swap, or an error.
function resolveSavedName(facts, savedName, label) {
  const installed = findFact(facts, savedName);
  if (installed) return { model: installed.name };
  const swaps = otherQuants(facts, savedName);
  if (swaps.length === 1) return { model: swaps[0], quant_swapped: `${savedName} → ${swaps[0]}` };
  throw new Error(goneMessage(label, savedName, swaps));
}

function installedList(facts) {
  const names = [];
  for (const fact of facts) names.push(fact.name);
  return names.join(', ');
}

export function resolveModel(requested, facts, saved) {
  if (requested === null || requested === undefined || requested === '') {
    const configured = savedModelName(saved, 'default');
    if (typeof configured !== 'string' || configured === '') throw new Error(NO_MODEL_CONFIGURED);
    return resolveSavedName(facts, configured, '`local_model`');
  }
  const exact = findFact(facts, requested);
  if (exact) return { model: exact.name };

  const role = NICKNAME_SPELLINGS[requested];
  if (role) {
    const savedName = savedModelName(saved, role);
    if (typeof savedName !== 'string') {
      throw new Error(`There is no \`${requested}\` nickname saved yet; run /consult:setlocal to set one up.`);
    }
    return { ...resolveSavedName(facts, savedName, `nickname \`${requested}\``), resolved_from: requested };
  }

  const colon = requested.indexOf(':');
  if (colon > 0 && colon < requested.length - 1) {
    const swaps = otherQuants(facts, requested);
    if (swaps.length === 1) return { model: swaps[0], quant_swapped: `${requested} → ${swaps[0]}` };
    if (swaps.length > 1) throw new Error(goneMessage(`\`${requested}\``, requested, swaps).replace(' points to', ' is'));
  }

  const needle = requested.toLowerCase();
  const matches = [];
  for (const fact of facts) {
    let hit = fact.name.toLowerCase().includes(needle);
    for (const alias of fact.aliases) {
      if (alias.toLowerCase().includes(needle)) hit = true;
    }
    if (hit) matches.push(fact.name);
  }
  if (matches.length === 1) return { model: matches[0], resolved_from: requested };
  if (matches.length > 1) {
    throw new Error(`\`${requested}\` matches several installed models: ${matches.join(', ')}. Name one of them, or use a nickname.`);
  }
  const nicknames = [];
  for (const one of NICKNAME_ROLES) {
    const value = savedModelName(saved, one);
    if (typeof value === 'string') nicknames.push(`${one} → ${value}`);
  }
  throw new Error(
    `No installed model matches \`${requested}\`. ` +
    (nicknames.length ? `Nicknames: ${nicknames.join(', ')}. ` : 'No nicknames are saved (run /consult:setlocal). ') +
    `Installed: ${installedList(facts)}.`
  );
}

// --- Reading the inventory ---

// Ollama's own API sits beside its OpenAI-compatible /v1. Any other layout
// is not Ollama, and gets names only, as before.
export function ollamaBase(base_url) {
  const found = /^(.*?)\/v1\/?$/.exec(String(base_url ?? ''));
  return found ? found[1] : null;
}

// Ollama's /api/tags, or null for any failure: a runner other than Ollama,
// one that is down, or an answer that isn't the model list.
// MoE or dense, from Ollama's /api/show: a model with experts is MoE. null
// when Ollama doesn't say (not running, model gone, no model_info).
export async function ollamaArch(base_url, name, timeout_ms = 3000) {
  const base = ollamaBase(base_url);
  if (base === null) return null;
  try {
    const response = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(timeout_ms)
    });
    if (!response.ok) return null;
    const info = JSON.parse(await readCapped(response))?.model_info;
    if (!info || typeof info !== 'object') return null;
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith('.expert_count') && typeof value === 'number' && value > 0) return 'MoE';
    }
    return 'dense';
  } catch (_) {
    return null;
  }
}

export async function fetchTags(base_url, timeout_ms = 3000) {
  const base = ollamaBase(base_url);
  if (base === null) return null;
  try {
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(timeout_ms) });
    if (!response.ok) return null;
    const parsed = JSON.parse(await readCapped(response));
    return parsed && Array.isArray(parsed.models) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function runNvidiaSmi() {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

// One nvidia-smi run per server process: the card does not change.
let vramReading = null;

export function resetVramCacheForTests() {
  vramReading = null;
}

export async function vramMb(settings, runner = runNvidiaSmi) {
  if (typeof settings?.local_vram_mb === 'number' && settings.local_vram_mb > 0) return settings.local_vram_mb;
  if (vramReading === null) {
    vramReading = (async () => {
      try {
        const first = String(await runner()).split(/\r?\n/)[0].trim();
        const value = Number(first);
        return /^\d+$/.test(first) && value > 0 ? value : null;
      } catch (_) {
        return null;
      }
    })();
  }
  return vramReading;
}

export function savedNicknames(settings) {
  return {
    default: settings?.local_model ?? null,
    fast: settings?.local_model_fast ?? null,
    vision: settings?.local_model_vision ?? null,
    vision_best: settings?.local_model_vision_best ?? null,
    big: settings?.local_model_big ?? null
  };
}

// The facts for this call, or null facts when the inventory can't be read.
export async function liveFacts(settings) {
  const tags = await fetchTags(settings.local_base_url);
  if (tags === null) return { facts: null, vram_mb: null };
  const vram = await vramMb(settings);
  const facts = modelFacts(tags, vram);
  return { facts, vram_mb: facts === null ? null : vram };
}

// --- Saving confirmed nicknames ---

const MODEL_KEY = /^local_model(?:_fast|_vision|_vision_best|_big)?$/;

const ROLE_KEYS = Object.freeze({
  default: 'local_model',
  fast: 'local_model_fast',
  vision: 'local_model_vision',
  'vision-best': 'local_model_vision_best',
  vision_best: 'local_model_vision_best',
  big: 'local_model_big'
});

// Sets or removes (null) `local_model*` lines in a consult.local.md text and
// leaves every other byte alone: the BOM, the line ends, comments, other
// keys, the body. A replaced line keeps its trailing `# comment`. A text with
// no frontmatter gets a block on top; no text at all becomes just the block.
export function rewriteLocalModelLines(text, changes) {
  for (const key of Object.keys(changes)) {
    const value = changes[key];
    if (value !== null && (typeof value !== 'string' || value.trim() === '' || UNSAFE_NAME.test(value))) {
      throw new Error('Not a model name that can be written: ' + JSON.stringify(value) + '.');
    }
    if (!MODEL_KEY.test(key)) throw new Error(`Only local_model settings can be written here, not \`${key}\`.`);
  }
  if (text === null || text === undefined) text = '';
  const bom = text.charCodeAt(0) === 0xFEFF ? '﻿' : '';
  if (bom) text = text.slice(1);
  const eol = /^[^\n]*\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let closing = -1;
  if (lines[0] === '---') {
    // As parseFrontmatter: the first later line that starts with ---.
    for (let index = 1; index < lines.length; index++) {
      if (lines[index].startsWith('---')) { closing = index; break; }
    }
  }
  const pending = new Map(Object.entries(changes));
  if (closing < 0) {
    const block = ['---'];
    for (const [key, value] of pending) {
      if (value !== null) block.push(`${key}: ${value}`);
    }
    block.push('---');
    return bom + block.join(eol) + eol + text;
  }
  const kept = [lines[0]];
  for (let index = 1; index < closing; index++) {
    const line = lines[index];
    const found = /^\s*([A-Za-z0-9_]+)\s*:(.*)$/.exec(line);
    if (!found || !pending.has(found[1])) {
      kept.push(line);
      continue;
    }
    const key = found[1];
    const value = pending.get(key);
    pending.delete(key);
    if (value === null) continue;
    const comment = /(\s+#.*)$/.exec(found[2]);
    kept.push(`${key}: ${value}${comment ? comment[1] : ''}`);
  }
  for (const [key, value] of pending) {
    if (value !== null) kept.push(`${key}: ${value}`);
  }
  for (let index = closing; index < lines.length; index++) kept.push(lines[index]);
  return bom + kept.join(eol);
}

// The settings file in effect, as settings.js reads it: the project's when it
// exists, else the global one. Files don't merge, so writing to the other
// would change nothing.
export function settingsTargetPath(cwd, home) {
  const projectPath = path.join(cwd, '.claude', 'consult.local.md');
  if (fs.existsSync(projectPath)) return projectPath;
  return path.join(home, '.claude', 'consult.local.md');
}

// Writes the nicknames the user confirmed. Every model must be installed
// (or an alias of one); otherwise nothing is written and the error names
// each bad value. `null` removes a nickname.
export function saveNicknames({ save, facts, cwd, home }) {
  const changes = {};
  const problems = [];
  for (const [role, value] of Object.entries(save ?? {})) {
    const key = ROLE_KEYS[role];
    if (!key) {
      problems.push(`\`${role}\` is not a nickname (use default, fast, vision, vision-best or big)`);
      continue;
    }
    if (value !== null && (typeof value !== 'string' || !findFact(facts, value))) {
      problems.push(`\`${value}\` (for ${role}) is not installed`);
      continue;
    }
    changes[key] = value;
  }
  if (problems.length > 0) throw new Error(`Nothing was saved: ${problems.join('; ')}.`);
  if (Object.keys(changes).length === 0) throw new Error('Nothing was saved: no nicknames were given.');
  const target = settingsTargetPath(cwd, home);
  let text = null;
  try { text = fs.readFileSync(target, 'utf8'); } catch (_) { /* a new file */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rewriteLocalModelLines(text, changes));
  return { path: target, written: changes };
}

// --- Preparing a call ---

// The model and time limit for one ask_local (or a council's local member).
// With no inventory (a runner other than Ollama, or Ollama not answering)
// the name goes to the runner as given and the limit is today's, so the
// runner reports any problem itself.
export function prepareLocalCall({ requested, images, settings, callTimeoutMs, facts, inCouncil = false }) {
  const base = inCouncil ? (settings.council_timeout_ms ?? settings.timeout_ms) : settings.timeout_ms;
  const explicit = callTimeoutMs ?? settings.local_timeout_ms ?? null;
  if (facts === null || facts === undefined) {
    return { model: requested || settings.local_model, timeout_ms: explicit ?? base, notes: {} };
  }
  const saved = savedNicknames(settings);
  const resolution = resolveModel(requested || null, facts, saved);
  const notes = {};
  if (resolution.resolved_from) notes.resolved_from = resolution.resolved_from;
  if (resolution.quant_swapped) notes.quant_swapped = resolution.quant_swapped;
  let model = resolution.model;
  if (Array.isArray(images) && images.length > 0 && !findFact(facts, model).vision) {
    const seeing = [];
    for (const fact of facts) if (fact.vision) seeing.push(fact.name);
    if (typeof saved.vision !== 'string') {
      throw new Error(
        `\`${model}\` can't read images and no \`vision\` nickname is saved. ` +
        `Installed models that read images: ${seeing.length ? seeing.join(', ') : 'none'}. ` +
        'Pass one as `model`, or run /consult:setlocal.'
      );
    }
    const vision = resolveSavedName(facts, saved.vision, 'nickname `vision`');
    notes.switched_for_images = `${model} → ${vision.model}`;
    if (vision.quant_swapped) notes.quant_swapped = vision.quant_swapped;
    model = vision.model;
  }
  let timeout_ms = explicit;
  if (timeout_ms === null) {
    timeout_ms = findFact(facts, model).fits_gpu === false ? Math.max(base, LOCAL_SLOW_FLOOR_MS) : base;
  }
  return { model, timeout_ms, notes };
}
