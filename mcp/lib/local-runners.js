// Local runners: which kinds of local model server consult knows, how it
// reads a runner's key from the environment, and (in later sections) how it
// recognises a runner, reads llama-swap's inventory and switches runners.
// Ollama's own inventory rules stay in local-models.js.
//
// The runner code takes a runner's settings from its callers (see
// runnerSettings in settings.js). The one thing it imports from settings.js is
// the delegate.* key list and value check, for saveDelegateSettings; settings.js
// imports the lists below, so the two modules import each other. That cycle is
// deliberate and safe because each side uses the other's names only inside
// functions, never while its module loads: keep it that way (a test loads either
// one first in a fresh process).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopback, readCapped, validateBaseUrl, notListeningMessage, needsKeyMessage, keyRejectedMessage, keyMissingMessage } from './local.js';
import { DELEGATE_KEYS, delegateProblem } from './settings.js';
import { canReply, liveFacts, lmstudioFacts, vramMb, prepareLocalCall, LOCAL_SLOW_FLOOR_MS, NICKNAME_ROLES, NICKNAME_SPELLINGS, UNSAFE_NAME } from './local-models.js';

export { lmstudioFacts };

export const RUNNER_TYPES = Object.freeze(['ollama', 'llama-swap', 'lmstudio', 'llama-server', 'openai']);

// The keys a runner may have in the settings file, as `<runner>.<key>`.
export const RUNNER_KEYS = Object.freeze(['url', 'key_env', 'start', 'default', 'fast', 'vision', 'vision_best', 'big']);

// Where a runner listens when nobody moved it. llama-swap has none worth
// assuming (its own default, 8080, is llama-server's too) and `openai` covers
// servers that could be anywhere.
export const STANDARD_URLS = Object.freeze({
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  'llama-server': 'http://127.0.0.1:8080/v1'
});

// The 0.11.0 key for each role: the settings in use while `local_runner` is
// unset, and what an unset `ollama.<role>` falls back to (see runnerSettings).
export const LEGACY_ROLE_KEYS = Object.freeze({
  default: 'local_model',
  fast: 'local_model_fast',
  vision: 'local_model_vision',
  vision_best: 'local_model_vision_best',
  big: 'local_model_big'
});

// --- The key ---

export function isValidEnvName(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

// The user environment (HKCU\Environment) on Windows. The MCP server may have
// started before the variable was created, so its own environment can lack a
// variable the user has set. Any failure is a plain null: reg's output can
// hold the value, so none of it is ever logged or put in an error.
export function queryUserEnvironment(name) {
  if (process.platform !== 'win32' || !isValidEnvName(name)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Environment', '/v', name], { timeout: 3000, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(null); return; }
      for (const line of String(stdout).split(/\r?\n/)) {
        const found = /^\s*(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line);
        if (!found || found[1].toLowerCase() !== name.toLowerCase()) continue;
        let value = found[3];
        if (found[2] === 'REG_EXPAND_SZ') {
          value = value.replace(/%([^%]+)%/g, (whole, inner) => process.env[inner] ?? whole);
        }
        resolve(value === '' ? null : value);
        return;
      }
      resolve(null);
    });
  });
}

// Values found in the user environment, by variable name, for the life of the
// process; a 401 drops one (forgetCachedKey) so a changed key is read again.
const userEnvKeys = new Map();

export function forgetCachedKey(name) {
  userEnvKeys.delete(name);
}

// A runner's key by the name of the variable that holds it: this process's
// environment first, then the user environment. CONSULT_NO_USER_ENV=1 (for
// tests only) turns the second read off; it can never add a key.
export async function readKey(name, { env = process.env, readUserEnv = queryUserEnvironment } = {}) {
  if (!isValidEnvName(name)) return { key: null, source: null };
  const own = env[name];
  if (typeof own === 'string' && own !== '') return { key: own, source: 'process' };
  if (env.CONSULT_NO_USER_ENV === '1') return { key: null, source: null };
  if (userEnvKeys.has(name)) return { key: userEnvKeys.get(name), source: 'user-env' };
  const found = await readUserEnv(name);
  if (typeof found !== 'string' || found === '') return { key: null, source: null };
  userEnvKeys.set(name, found);
  return { key: found, source: 'user-env' };
}

// --- Recognising a runner ---

// The ports the probe tries: Ollama, LM Studio, llama-server (and a
// llama-swap started without arguments), and 9292, a common llama-swap pick.
export const PROBE_URLS = Object.freeze([
  'http://127.0.0.1:11434/v1',
  'http://127.0.0.1:1234/v1',
  'http://127.0.0.1:8080/v1',
  'http://127.0.0.1:9292/v1'
]);

// One address, however it is spelled: case, trailing slashes, and localhost
// for 127.0.0.1, so a configured runner is recognised among the probe's finds.
function normalUrl(url) {
  let text = String(url ?? '').trim().toLowerCase().replace(/\/+$/, '');
  text = text.replace(/^(https?:\/\/)localhost\.?(?=[:/]|$)/, '$1127.0.0.1');
  return text;
}

export function sameUrl(first, second) {
  return normalUrl(first) === normalUrl(second);
}

// The other runners that hold a model now; an unknown state (null) is left
// out here and shown as unknown by local_status.
export function runnersHolding(others) {
  const holding = [];
  for (const other of others) {
    if (Array.isArray(other.loaded) && other.loaded.length > 0) holding.push(other);
  }
  return holding;
}

// Setup may read a key variable named in the call itself (not yet saved) only
// for a runner that asked for a key, at a standard probe address or the one
// configured for it: a tool call can't send a variable anywhere else.
export function mayReadSuppliedKey({ url, probe, configured }) {
  let known = false;
  for (const standard of PROBE_URLS) if (sameUrl(standard, url)) known = true;
  for (const runner of configured) if (sameUrl(runner.url, url)) known = true;
  if (!known) return false;
  for (const found of probe) {
    if (sameUrl(found.url, url) && found.needs_key) return true;
  }
  return false;
}

// The server root beside its OpenAI-compatible /v1 (Ollama's /api/*,
// llama-swap's /running and /unload live there).
export function runnerRoot(url) {
  return String(url ?? '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

// What kind of runner answered, from the bodies of its replies. A runner is
// known by what it says, not by its port: 8080 can be llama-server, Strata,
// or a llama-swap started without arguments. LM Studio greets with
// `{"lmstudio":true}` at /lmstudio-greeting.
export function classifyRunner({ tagsJson = null, modelsStatus = null, modelsJson = null, healthJson = null, greetingJson = null }) {
  if (Array.isArray(tagsJson?.models)) {
    for (const model of tagsJson.models) {
      if (typeof model?.digest === 'string' && model.digest !== '' && typeof model.size === 'number' && model.size > 0) return 'ollama';
    }
  }
  if (modelsJson?.src === 'llama-swap') return 'llama-swap';
  const entries = Array.isArray(modelsJson?.data) ? modelsJson.data : [];
  for (const entry of entries) {
    if (entry?.owned_by === 'llama-swap' || entry?.meta?.llamaswap) return 'llama-swap';
  }
  if (greetingJson?.lmstudio === true) return 'lmstudio';
  if (healthJson?.service === 'strata') return 'openai';
  for (const entry of entries) {
    if (entry?.owned_by === 'llamacpp') return 'llama-server';
  }
  if (modelsStatus === 200 && Array.isArray(modelsJson?.data)) return 'openai';
  return null;
}

export async function getJson(url, { key = null, timeoutMs = 3000 } = {}) {
  const headers = {};
  // A key only ever goes to this machine, and never follows a redirect.
  if (key && isLoopback(url)) headers.Authorization = `Bearer ${key}`;
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    let json = null;
    try { json = JSON.parse(await readCapped(response)); } catch (_) { /* not JSON */ }
    return { status: response.status, json };
  } catch (_) {
    return { status: null, json: null };
  }
}

// One address: is anything there, and what. GET only; never a completion, so
// a probe can't load a model.
async function probeOne(url, { key, keyEnv, timeoutMs, trySwapKey, swapKeyUrls, readKeyFor }) {
  const root = runnerRoot(url);
  const [tags, health, greeting] = await Promise.all([
    getJson(`${root}/api/tags`, { timeoutMs }),
    getJson(`${root}/health`, { timeoutMs }),
    getJson(`${root}/lmstudio-greeting`, { timeoutMs })
  ]);
  let models = await getJson(`${root}/v1/models`, { key, timeoutMs });
  let usedKeyEnv = key ? keyEnv : null;
  const up = tags.status !== null || health.status !== null || models.status !== null;
  let type = classifyRunner({ tagsJson: tags.json, modelsStatus: models.status, modelsJson: models.json, healthJson: health.json, greetingJson: greeting.json });
  // Setup only: a llama-swap that wants a key, when the usual variable exists,
  // on one of the standard probe ports. Never to any port that merely claims
  // to be llama-swap: a local program could answer that way to collect it.
  if (type === 'llama-swap' && models.status === 401 && !key && trySwapKey && swapKeyUrls.some(standard => sameUrl(standard, url)) && isLoopback(url)) {
    const found = await readKeyFor('LLAMA_SWAP_API_KEY');
    if (found.key) {
      const retried = await getJson(`${root}/v1/models`, { key: found.key, timeoutMs });
      if (retried.status === 200) {
        models = retried;
        usedKeyEnv = 'LLAMA_SWAP_API_KEY';
      }
    }
  }
  // Only the models that can reply count: Ollama and LM Studio say which
  // can only embed; on another server, `chat: false` in its metadata.
  const cannotReply = new Set();
  if (type === 'ollama') {
    for (const model of tags.json.models) {
      if (!canReply(model)) cannotReply.add(model.name);
    }
  }
  if (type === 'lmstudio') {
    const list = await getJson(`${root}/api/v1/models`, { key, timeoutMs });
    if (list.status === 200 && Array.isArray(list.json?.models)) {
      for (const model of list.json.models) {
        if (typeof model?.key === 'string' && model.type !== 'llm') cannotReply.add(model.key);
      }
    }
  }
  const ids = [];
  if (models.status === 200 && Array.isArray(models.json?.data)) {
    for (const entry of models.json.data) {
      if (typeof entry?.id === 'string' && !cannotReply.has(entry.id) && entryMetadata(entry).chat !== false) ids.push(entry.id);
    }
  }
  return { url, type, up, needs_key: models.status === 401, key_env: usedKeyEnv, models: ids };
}

// Every address worth a look: the standard ports plus the configured runners'
// own. `configured` is [{ type, url, key_env }]; a configured runner's key is
// sent to its own address only, and only when that address is this machine.
export async function probeRunners({ urls = null, configured = [], timeoutMs = 800, trySwapKey = false, swapKeyUrls = PROBE_URLS, readKeyFor = readKey } = {}) {
  const targets = [];
  const addTarget = (url) => {
    for (const target of targets) if (sameUrl(target, url)) return;
    targets.push(url);
  };
  for (const url of urls ?? PROBE_URLS) addTarget(url);
  for (const runner of configured) if (runner.url) addTarget(runner.url);
  const probes = [];
  for (const url of targets) {
    let key = null;
    let keyEnv = null;
    for (const runner of configured) {
      if (sameUrl(runner.url, url) && runner.key_env && isLoopback(url)) {
        key = (await readKeyFor(runner.key_env)).key;
        keyEnv = runner.key_env;
      }
    }
    probes.push(probeOne(url, { key, keyEnv, timeoutMs, trySwapKey, swapKeyUrls, readKeyFor }));
  }
  const found = await Promise.all(probes);
  for (const one of found) {
    let configuredAs = null;
    for (const runner of configured) {
      if (sameUrl(runner.url, one.url)) configuredAs = runner.type;
    }
    one.configured = configuredAs;
  }
  return found;
}

// --- llama-swap's inventory and nicknames ---

export const NO_MODEL_CONFIGURED =
  'No local model configured. Run /consult:setlocal to choose a runner and its models, ' +
  'or pass `model` to the tool. Call `local_status` to list what the runner has available.';

// A metadata word worth showing in a column: short, printable, or null.
function shortLabel(value) {
  if (typeof value !== 'string') return null;
  return /^[\w .+-]{1,20}$/.test(value) ? value : null;
}

// The facts a /v1/models entry carries: llama-swap's per-model `metadata:`
// (under meta.llamaswap), or a custom server's own `meta` object.
function entryMetadata(entry) {
  if (entry?.meta?.llamaswap && typeof entry.meta.llamaswap === 'object') return entry.meta.llamaswap;
  if (entry?.meta && typeof entry.meta === 'object') return entry.meta;
  return {};
}

// From llama-swap's /v1/models, or any OpenAI-style server's. Only the loaded
// model reports capabilities, so `vision` is often null (unknown); an alias
// `vision` counts as true. A server other than llama-swap may describe a
// model with the same fields in its own `meta` block.
export function swapFacts(modelsJson) {
  const facts = [];
  const entries = Array.isArray(modelsJson?.data) ? modelsJson.data : [];
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || entry.id === '' || UNSAFE_NAME.test(entry.id)) continue;
    const aliases = [];
    for (const alias of entry.meta?.llamaswap?.aliases ?? []) {
      if (typeof alias === 'string' && !UNSAFE_NAME.test(alias)) aliases.push(alias);
    }
    // The facts a config writes under the model's `metadata:` (arch, engine,
    // decode_tps, vision); a value of any other shape is left out. `chat:
    // false` marks a model that can't reply (an embedding model).
    const metadata = entryMetadata(entry);
    if (metadata.chat === false) continue;
    let vision = null;
    if (entry.capabilities && typeof entry.capabilities === 'object') vision = entry.capabilities.vision === true;
    if (typeof metadata.vision === 'boolean') vision = metadata.vision;
    if (aliases.includes('vision')) vision = true;
    let decodeTps = null;
    if (typeof metadata.decode_tps === 'number' && metadata.decode_tps > 0) decodeTps = metadata.decode_tps;
    if (typeof metadata.decode_tps === 'string' && /^~?\d+(\.\d+)?(-\d+(\.\d+)?)?$/.test(metadata.decode_tps)) decodeTps = metadata.decode_tps;
    facts.push({
      arch: shortLabel(metadata.arch),
      engine: shortLabel(metadata.engine),
      decode_tps: decodeTps,
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      description: typeof entry.description === 'string' ? entry.description : '',
      aliases,
      loaded: entry.status?.value === 'loaded',
      vision,
      context: typeof entry.context_length === 'number' ? entry.context_length : null
    });
  }
  facts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return facts;
}

// The models known to read images, by name (llama-swap facts have an id,
// Ollama's a name), for an error that offers them.
export function seeingModels(inventory) {
  const names = [];
  if (!Array.isArray(inventory)) return names;
  for (const fact of inventory) {
    if (fact && typeof fact === 'object' && fact.vision === true) names.push(fact.id ?? fact.name);
  }
  return names;
}

function findSwapFact(facts, name) {
  for (const fact of facts) {
    if (fact.id === name || fact.aliases.includes(name)) return fact;
  }
  return null;
}

function aliasHolders(facts, word) {
  const holders = [];
  for (const fact of facts) {
    if (fact.aliases.includes(word)) holders.push(fact);
  }
  return holders;
}

// Proposals from the server's own aliases: a role word that is an alias of
// exactly one model proposes that model. Same row shape as Ollama's
// proposeNicknames, so /consult:setlocal shows both alike.
export function proposeSwapNicknames(facts, saved) {
  const mentioned = new Set();
  const rows = [];
  const seeing = [];
  for (const fact of facts) if (fact.vision === true) seeing.push(fact);
  for (const role of NICKNAME_ROLES) {
    let picks = [];
    let reason;
    let rule;
    if (role === 'vision_best') {
      rule = 'the `vision` pick';
      const visionHolders = aliasHolders(facts, 'vision');
      if (visionHolders.length === 1) picks = [visionHolders[0]];
    } else {
      rule = `llama-swap alias \`${role}\``;
      const holders = aliasHolders(facts, role);
      if (holders.length === 1) picks = [holders[0]];
    }
    const pickIds = [];
    for (const fact of picks) pickIds.push(fact.id);
    const savedName = typeof saved?.[role] === 'string' ? saved[role] : null;
    let state = 'none';
    let proposed = pickIds;
    if (savedName !== null) {
      const installed = findSwapFact(facts, savedName);
      if (installed) {
        state = 'kept';
        proposed = [installed.id];
      } else {
        state = 'gone';
      }
    }
    for (const id of proposed) mentioned.add(id);
    if (proposed.length === 0) {
      reason = `${rule}: no model qualifies; pick one from the list`;
    } else if (state === 'kept') {
      reason = 'saved';
    } else if (role === 'vision_best') {
      reason = seeing.length === 1 && seeing[0].id === proposed[0] ? 'the only model known to read images' : 'the same as `vision`';
    } else {
      reason = rule;
    }
    rows.push({ role, rule, rule_pick: pickIds, proposed, saved: savedName, saved_state: state, replacement: null, reason });
  }
  const newModels = [];
  const models = [];
  for (const fact of facts) {
    if (!mentioned.has(fact.id)) newModels.push(fact.id);
    models.push({ id: fact.id, name: fact.name, description: fact.description, vision: fact.vision, loaded: fact.loaded, arch: fact.arch, engine: fact.engine, decode_tps: fact.decode_tps });
  }
  return { rows, new_models: newModels, models };
}

function listedNames(facts) {
  const names = [];
  for (const fact of facts) names.push(fact.id);
  return names.join(', ');
}

function savedOrGone(facts, savedName, label) {
  const fact = findSwapFact(facts, savedName);
  if (fact) return fact;
  throw new Error(`${label} points to \`${savedName}\`, which llama-swap no longer lists; run /consult:setlocal. Listed: ${listedNames(facts)}.`);
}

// A requested model on llama-swap: the user's nickname first (before any
// server alias of the same name), then an id or alias as given, then a
// unique fragment. With nothing requested: the saved default, the server's
// `default` alias, or the only model listed.
export function resolveSwapModel(requested, facts, saved) {
  if (requested === null || requested === undefined || requested === '') {
    if (typeof saved?.default === 'string') return { model: savedOrGone(facts, saved.default, '`default`').id };
    const holders = aliasHolders(facts, 'default');
    if (holders.length === 1) return { model: holders[0].id, resolved_from: 'server alias default' };
    if (facts.length === 1) return { model: facts[0].id, resolved_from: 'the only model' };
    throw new Error(NO_MODEL_CONFIGURED);
  }
  const role = NICKNAME_SPELLINGS[requested];
  if (role) {
    if (typeof saved?.[role] === 'string') {
      return { model: savedOrGone(facts, saved[role], `nickname \`${requested}\``).id, resolved_from: requested };
    }
    const holders = aliasHolders(facts, requested);
    if (holders.length === 1) return { model: holders[0].id, resolved_from: `server alias ${requested}` };
    throw new Error(`There is no \`${requested}\` nickname saved yet; run /consult:setlocal to set one up.`);
  }
  if (findSwapFact(facts, requested)) return { model: requested };
  const needle = requested.toLowerCase();
  const matches = [];
  for (const fact of facts) {
    let hit = fact.id.toLowerCase().includes(needle);
    for (const alias of fact.aliases) {
      if (alias.toLowerCase().includes(needle)) hit = true;
    }
    if (hit) matches.push(fact.id);
  }
  if (matches.length === 1) return { model: matches[0], resolved_from: requested };
  if (matches.length > 1) {
    throw new Error(`\`${requested}\` matches several models: ${matches.join(', ')}. Name one of them, or use a nickname.`);
  }
  throw new Error(`llama-swap lists no model matching \`${requested}\`. Listed: ${listedNames(facts)}.`);
}

// --- What is loaded, and unloading ---

// The models a runner has in memory now: llama-swap's /running, Ollama's
// /api/ps. null when it can't be read (no key, down, an odd answer): unknown
// is not "nothing loaded". Other runners can't say, so []. A key goes to this
// machine only.
export async function loadedModels(runner, key, timeoutMs = 3000) {
  const root = runnerRoot(runner.url);
  if (runner.type === 'llama-swap') {
    const running = await getJson(`${root}/running`, { key, timeoutMs });
    if (running.status !== 200 || !Array.isArray(running.json?.running)) return null;
    const names = [];
    for (const entry of running.json.running) {
      if (typeof entry?.model === 'string' && entry.state !== 'stopped' && entry.state !== 'shutdown') names.push(entry.model);
    }
    return names;
  }
  if (runner.type === 'ollama') {
    const ps = await getJson(`${root}/api/ps`, { timeoutMs });
    if (ps.status !== 200 || !Array.isArray(ps.json?.models)) return null;
    const names = [];
    for (const entry of ps.json.models) {
      if (typeof entry?.name === 'string') names.push(entry.name);
    }
    return names;
  }
  if (runner.type === 'lmstudio') {
    // An LM Studio without /api/v1 can't say: nothing, as before 0.13.2.
    const list = await getJson(`${root}/api/v1/models`, { key, timeoutMs });
    if (list.status !== 200 || !Array.isArray(list.json?.models)) return [];
    const names = [];
    for (const model of list.json.models) {
      if (typeof model?.key === 'string' && Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0) names.push(model.key);
    }
    return names;
  }
  return [];
}

// Frees a runner's memory. Ollama: each loaded model by the name /api/ps
// reports (not a nickname), with keep_alive 0. llama-swap: /unload. LM
// Studio: each loaded instance by its id.
export async function unloadRunner(runner, key, timeoutMs = 15000) {
  const loaded = await loadedModels(runner, key);
  const root = runnerRoot(runner.url);
  const headers = { 'Content-Type': 'application/json' };
  if (key && isLoopback(runner.url)) headers.Authorization = `Bearer ${key}`;
  if (runner.type === 'llama-swap') {
    const response = await fetch(`${root}/unload`, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`llama-swap at ${runner.url} refused to unload (HTTP ${response.status}).`);
    return { unloaded: loaded ?? [] };
  }
  if (runner.type === 'ollama') {
    if (loaded === null) throw new Error(`Ollama at ${runner.url} didn't say what it has loaded, so nothing was unloaded.`);
    for (const model of loaded) {
      const response = await fetch(`${root}/api/generate`, {
        method: 'POST', headers, redirect: 'error',
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`Ollama at ${runner.url} refused to unload ${model} (HTTP ${response.status}).`);
    }
    return { unloaded: loaded };
  }
  if (runner.type === 'lmstudio') {
    const list = await getJson(`${root}/api/v1/models`, { key, timeoutMs });
    if (list.status !== 200 || !Array.isArray(list.json?.models)) throw new Error(`LM Studio at ${runner.url} didn't say what it has loaded, so nothing was unloaded.`);
    const unloaded = [];
    for (const model of list.json.models) {
      if (typeof model?.key !== 'string' || !Array.isArray(model.loaded_instances) || model.loaded_instances.length === 0) continue;
      for (const instance of model.loaded_instances) {
        if (typeof instance?.id !== 'string') continue;
        const response = await fetch(`${root}/api/v1/models/unload`, {
          method: 'POST', headers, redirect: 'error',
          body: JSON.stringify({ instance_id: instance.id }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) throw new Error(`LM Studio at ${runner.url} refused to unload ${model.key} (HTTP ${response.status}).`);
      }
      unloaded.push(model.key);
    }
    return { unloaded };
  }
  throw new Error(`${runner.type} has no way to unload a model from consult; stop it from its own app.`);
}

// Before a call that names a runner other than the one in use: refuse while
// the one in use holds a model, so two runners never fill memory at once.
// The ordinary path (no `runner`, or the one in use) checks nothing.
export async function checkDoubleLoad({ requested, inUse, key }) {
  if (!requested || !inUse?.type || requested === inUse.type) return;
  const loaded = await loadedModels(inUse, key);
  if (loaded === null) {
    throw new Error(
      `Can't tell whether ${inUse.type} at ${inUse.url} has a model loaded (it didn't say: down, or its key is missing). ` +
      `Check with \`local_status\`, unload it (\`local_unload\` with runner "${inUse.type}"), or call without \`runner\`.`
    );
  }
  if (loaded.length === 0) return;
  throw new Error(
    `${inUse.type} still has \`${loaded.join('`, `')}\` loaded; unload it first (\`local_unload\` with runner "${inUse.type}") ` +
    'or call without `runner`. Two runners holding models at once can run this machine out of memory.'
  );
}

// --- Status ---

// local_status's body for a llama-swap: reachable or why not (with what to
// do), its models, the loaded one, and whether each saved nickname still
// names a listed model. GET only.
export async function swapStatus(runner, apiKey, timeoutMs = 5000) {
  const root = runnerRoot(runner.url);
  const models = await getJson(`${root}/v1/models`, { key: apiKey, timeoutMs });
  if (models.status === null) {
    return { reachable: false, url: runner.url, reason: 'unreachable', details: notListeningMessage(runner.url, 'llama-swap', runner.start) };
  }
  if (models.status === 401 || models.status === 403) {
    if (!apiKey && runner.key_env) return { reachable: true, url: runner.url, reason: 'key_missing', details: keyMissingMessage(runner.key_env) };
    if (!apiKey) return { reachable: true, url: runner.url, reason: 'needs_key', details: needsKeyMessage(runner.url, 'llama-swap') };
    return { reachable: true, url: runner.url, reason: 'key_rejected', details: keyRejectedMessage(runner.url, 'llama-swap', runner.key_env) };
  }
  if (models.status !== 200) {
    return { reachable: false, url: runner.url, reason: 'http_error', details: `llama-swap at ${runner.url} answered HTTP ${models.status}.` };
  }
  const facts = swapFacts(models.json);
  const nicknames = {};
  for (const role of NICKNAME_ROLES) {
    const saved = runner.nicknames?.[role];
    if (typeof saved === 'string') nicknames[role] = { model: saved, resolves: findSwapFact(facts, saved) !== null };
  }
  const listed = [];
  for (const fact of facts) {
    listed.push({ id: fact.id, name: fact.name, description: fact.description, aliases: fact.aliases, loaded: fact.loaded, vision: fact.vision });
  }
  return { reachable: true, url: runner.url, models: listed, model_count: listed.length, loaded: await loadedModels(runner, apiKey), nicknames };
}

// For local_status and setup: every other runner that answers, and what it
// has loaded, so a model held by two runners at once is visible.
// A key goes only to the address configured with it (no guessing here): a
// llama-swap nobody configured shows `loaded: null`, unknown.
export async function otherRunners({ configured, exceptUrl, urls = PROBE_URLS, readKeyFor = readKey }) {
  const found = await probeRunners({ urls, configured, timeoutMs: 800, trySwapKey: false, readKeyFor });
  const others = [];
  for (const one of found) {
    if (!one.up || sameUrl(one.url, exceptUrl) || (one.type !== 'ollama' && one.type !== 'llama-swap' && one.type !== 'lmstudio')) continue;
    let key = null;
    for (const runner of configured) {
      if (sameUrl(runner.url, one.url) && runner.key_env && isLoopback(one.url)) key = (await readKeyFor(runner.key_env)).key;
    }
    // A llama-swap with no configured key isn't asked: what it holds is unknown.
    const loaded = one.type === 'llama-swap' && key === null ? null : await loadedModels({ type: one.type, url: one.url }, key);
    others.push({ type: one.type, url: one.url, up: true, loaded });
  }
  return others;
}

// --- A runner's key and inventory ---

// The key for a runner: from the variable its settings name, sent only to
// this machine. `key_env` is returned so errors can name it (never the value).
export async function runnerKey(runner, readKeyFor = readKey) {
  if (runner.legacy) return { api_key: runner.api_key ?? null, key_env: null };
  if (!runner.key_env) return { api_key: null, key_env: null };
  if (!isLoopback(runner.url)) {
    throw new Error(`${runner.type}.key_env is set, but ${runner.url} is not on this machine; a key from the environment is only sent to this machine.`);
  }
  return { api_key: (await readKeyFor(runner.key_env)).key, key_env: runner.key_env };
}

// What a call can resolve against: Ollama's or LM Studio's facts
// (local-models.js), or the llama-swap-style facts above for every other
// runner (a custom server's `meta` included). null when the
// list can't be read; the call then goes ahead and the runner's own answer
// says what is wrong.
export async function runnerInventory(runner, apiKey, settings) {
  if (runner.type === null || runner.type === 'ollama') {
    return (await liveFacts({ ...settings, local_base_url: runner.url })).facts;
  }
  if (runner.type === 'lmstudio') {
    const list = await getJson(`${runnerRoot(runner.url)}/api/v1/models`, { key: apiKey });
    const facts = list.status === 200 ? lmstudioFacts(list.json, await vramMb(settings)) : null;
    if (facts !== null) return facts;
    // An older LM Studio: the names from /v1/models, below.
  }
  const models = await getJson(`${runnerRoot(runner.url)}/v1/models`, { key: apiKey });
  if (models.status !== 200 || !Array.isArray(models.json?.data)) return null;
  return swapFacts(models.json);
}

// LM Studio's own facts (size and all), not the names from /v1/models an
// older LM Studio without /api/v1 gives.
export function isLmstudioInventory(inventory) {
  if (!Array.isArray(inventory)) return false;
  for (const fact of inventory) {
    if (typeof fact?.size_bytes !== 'number') return false;
  }
  return true;
}

// --- Preparing a call ---

export function asOllamaSettings(settings, nicknames) {
  return {
    ...settings,
    local_model: nicknames.default,
    local_model_fast: nicknames.fast,
    local_model_vision: nicknames.vision,
    local_model_vision_best: nicknames.vision_best,
    local_model_big: nicknames.big
  };
}

// The model and time limit for one call on a runner, and notes for the
// result. Ollama, LM Studio and the 0.11.0 path keep local-models.js's
// rules; llama-swap gets its nicknames, the image rules and the slow floor;
// other runners pass the name through.
export function prepareRunnerCall({ runner, requested = null, images, settings, callTimeoutMs = null, inventory = null, inCouncil = false }) {
  if (runner.type === null) {
    return prepareLocalCall({ requested, images, settings, callTimeoutMs, facts: inventory, inCouncil });
  }
  if (runner.type === 'ollama' || (runner.type === 'lmstudio' && isLmstudioInventory(inventory))) {
    return prepareLocalCall({ requested, images, settings: asOllamaSettings(settings, runner.nicknames), callTimeoutMs, facts: inventory, inCouncil });
  }
  const base = inCouncil ? (settings.council_timeout_ms ?? settings.timeout_ms) : settings.timeout_ms;
  const explicit = callTimeoutMs ?? settings.local_timeout_ms ?? null;
  const notes = {};
  // A role word the user saved a nickname for is that model, on any runner.
  let named = requested || null;
  const role = named ? NICKNAME_SPELLINGS[named] : null;
  if (role && typeof runner.nicknames[role] === 'string') {
    notes.resolved_from = named;
    named = runner.nicknames[role];
  }
  if (runner.type !== 'llama-swap') {
    let model = named || runner.nicknames.default || null;
    if (!model && Array.isArray(inventory) && inventory.length === 1) {
      model = inventory[0].id;
      notes.resolved_from = 'the only model';
    }
    if (!model) throw new Error(NO_MODEL_CONFIGURED);
    return { model, timeout_ms: explicit ?? base, notes };
  }
  // llama-swap: one model loaded at a time, flash-next loads for minutes and
  // a Strata load isn't bounded by llama-swap's health check: the slow floor.
  const timeout_ms = explicit ?? Math.max(base, LOCAL_SLOW_FLOOR_MS);
  if (!Array.isArray(inventory)) {
    // The list couldn't be read (down, or no key): send the call anyway so the
    // runner's own answer says what is wrong. With no saved default, ask for
    // the server's `default` alias.
    let model = named || runner.nicknames.default || null;
    if (!model) {
      model = 'default';
      notes.resolved_from = 'server alias default (unchecked)';
    }
    return { model, timeout_ms, notes };
  }
  const resolution = resolveSwapModel(requested || null, inventory, runner.nicknames);
  if (resolution.resolved_from) notes.resolved_from = resolution.resolved_from;
  let model = resolution.model;
  if (Array.isArray(images) && images.length > 0) {
    const vision = findSwapFact(inventory, model)?.vision ?? null;
    // A model the caller named keeps the call unless it is known not to read
    // images; an implicit default needs to be known to read them.
    const keep = vision === true || (Boolean(requested) && vision === null);
    if (keep && vision === null) notes.vision = 'unknown';
    if (!keep) {
      let target = null;
      if (typeof runner.nicknames.vision === 'string') {
        target = savedOrGone(inventory, runner.nicknames.vision, 'nickname `vision`').id;
      } else {
        const holders = aliasHolders(inventory, 'vision');
        if (holders.length === 1) target = holders[0].id;
      }
      if (target === null) {
        const seeing = seeingModels(inventory);
        throw new Error(
          `\`${model}\` can't read images and no \`vision\` nickname is saved. ` +
          `Models known to read images: ${seeing.length ? seeing.join(', ') : 'none'}. Pass one as \`model\`, or run /consult:setlocal.`
        );
      }
      notes.switched_for_images = `${model} → ${target}`;
      model = target;
    }
  }
  return { model, timeout_ms, notes };
}

// --- Saving runner settings ---

// The 0.11.0 line each Ollama setting replaces in place once a runner is chosen.
const LEGACY_LINES = { 'ollama.url': 'local_base_url' };
for (const [role, legacyKey] of Object.entries(LEGACY_ROLE_KEYS)) LEGACY_LINES[`ollama.${role}`] = legacyKey;

function checkRunnerChange(key, value) {
  const dot = key.indexOf('.');
  const isRunnerSetting = key === 'local_runner' || (dot > 0 && RUNNER_TYPES.includes(key.slice(0, dot)) && RUNNER_KEYS.includes(key.slice(dot + 1)));
  if (!isRunnerSetting) throw new Error(`Only runner settings can be written here, not \`${key}\`.`);
  if (value === null) return;
  if (typeof value !== 'string' || value.trim() === '' || UNSAFE_NAME.test(value)) {
    throw new Error(`Not a value that can be written for \`${key}\`: ${JSON.stringify(value)}.`);
  }
  if (key === 'local_runner' && !RUNNER_TYPES.includes(value)) throw new Error(`\`local_runner\` must be one of ${RUNNER_TYPES.join(', ')}.`);
  if (key.endsWith('.url')) {
    validateBaseUrl(value);
    // Setup writes on a tool call, so it never chooses where prompts go off
    // this machine; a remote runner is a line the person writes by hand.
    if (!isLoopback(value)) {
      throw new Error(`Setup only saves addresses on this machine; ${value} is not one. A remote runner is added by editing ~/.claude/consult.local.md by hand.`);
    }
  }
  if (key.endsWith('.key_env') && !isValidEnvName(value)) throw new Error(`\`${key}\` must be an environment variable name (letters, digits, _).`);
}

// Runner settings only: a key that is not one is refused.
export function rewriteRunnerLines(text, changes) {
  for (const [key, value] of Object.entries(changes)) checkRunnerChange(key, value);
  return rewriteLines(text, changes);
}

// `delegate.*` settings only, with the values settings.js would accept.
export function rewriteDelegateLines(text, changes) {
  for (const [key, value] of Object.entries(changes)) checkDelegateChange(key, value);
  return rewriteLines(text, changes);
}

function checkDelegateChange(key, value) {
  if (!DELEGATE_KEYS.includes(key)) throw new Error(`Only delegate settings can be written here, not \`${key}\`.`);
  const problem = delegateProblem(key, value);
  if (problem !== null) throw new Error(`\`${key}\` ${problem} (got ${JSON.stringify(value)}).`);
}

// Sets or removes (null) lines in a consult.local.md text and leaves
// every other byte alone: the BOM, the line ends, comments, other keys, the
// body. A replaced line keeps its trailing `# comment`. Once a runner is
// chosen, an `ollama.*` line takes the place of its 0.11.0 line, so the file
// never holds both. A text with no frontmatter gets a block on top. The keys
// and values are the callers' to check.
function rewriteLines(text, changes) {
  if (text === null || text === undefined) text = '';
  const bom = text.charCodeAt(0) === 0xFEFF ? '﻿' : '';
  if (bom) text = text.slice(1);
  const eol = /^[^\n]*\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let closing = -1;
  if (lines[0] === '---') {
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
  const present = new Set();
  let runnerLine = false;
  for (let index = 1; index < closing; index++) {
    const found = /^([A-Za-z0-9_.-]+)\s*:/.exec(lines[index]);
    if (!found) continue;
    present.add(found[1]);
    if (found[1] === 'local_runner') runnerLine = true;
  }
  const runnerChosen = pending.has('local_runner') ? pending.get('local_runner') !== null : runnerLine;
  // legacy line -> the ollama key that replaces it in place
  const replacements = new Map();
  if (runnerChosen) {
    for (const [key, legacyKey] of Object.entries(LEGACY_LINES)) {
      if (pending.has(key) && pending.get(key) !== null && !present.has(key)) replacements.set(legacyKey, key);
    }
  }
  const kept = [lines[0]];
  // A key set twice reads as its last line; a save keeps one copy, so the
  // value it writes is the one that counts.
  const handled = new Set();
  for (let index = 1; index < closing; index++) {
    const line = lines[index];
    const found = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line);
    let key = found ? found[1] : null;
    if (key !== null && replacements.has(key)) key = replacements.get(key);
    if (key !== null && handled.has(key)) continue;
    if (key === null || !pending.has(key)) {
      kept.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    handled.add(key);
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

// The lines that differ between two texts, as "- <old line>: text" and
// "+ <new line>: text", in file order (a longest-common-subsequence diff).
export function lineDiff(before, after) {
  const strip = (text) => String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const oldLines = strip(before);
  const newLines = strip(after);
  const rows = oldLines.length + 1;
  const columns = newLines.length + 1;
  const common = [];
  for (let row = 0; row < rows; row++) common.push(new Array(columns).fill(0));
  for (let row = oldLines.length - 1; row >= 0; row--) {
    for (let column = newLines.length - 1; column >= 0; column--) {
      common[row][column] = oldLines[row] === newLines[column]
        ? common[row + 1][column + 1] + 1
        : Math.max(common[row + 1][column], common[row][column + 1]);
    }
  }
  const out = [];
  let row = 0;
  let column = 0;
  while (row < oldLines.length || column < newLines.length) {
    if (row < oldLines.length && column < newLines.length && oldLines[row] === newLines[column]) {
      row++;
      column++;
    } else if (column < newLines.length && (row >= oldLines.length || common[row][column + 1] >= common[row + 1][column])) {
      out.push(`+ ${column + 1}: ${newLines[column]}`);
      column++;
    } else {
      out.push(`- ${row + 1}: ${oldLines[row]}`);
      row++;
    }
  }
  // Removals first within each changed stretch, as people read a diff.
  return out.sort((a, b) => lineOf(a) - lineOf(b) || (a[0] === '-' ? -1 : 1));
}

function lineOf(entry) {
  return Number(/^[-+] (\d+):/.exec(entry)[1]);
}

let backedUp = false;

export function resetBackupForTests() {
  backedUp = false;
}

// The pane saves through a new setlocal.js process each time: after its first
// save it asks to keep the .bak, which holds the file from before that save.
export function keepBackup() {
  backedUp = true;
}

// Writes runner settings to the global file (they are read from nowhere
// else). `preview` returns the diff and writes nothing. Before the first
// write in this process the file is copied to consult.local.md.bak.
export function saveRunnerSettings({ changes, home, preview = false }) {
  return saveGlobalLines(rewriteRunnerLines, { changes, home, preview });
}

// The same for `delegate.*` settings (global-only like the runner's), through
// the same line rewrite and the same .bak rule.
export function saveDelegateSettings({ changes, home, preview = false }) {
  return saveGlobalLines(rewriteDelegateLines, { changes, home, preview });
}

function saveGlobalLines(rewrite, { changes, home, preview }) {
  const target = path.join(home, '.claude', 'consult.local.md');
  let text = null;
  try { text = fs.readFileSync(target, 'utf8'); } catch (_) { /* a new file */ }
  const next = rewrite(text, changes);
  const diff = lineDiff(text ?? '', next);
  if (preview) return { path: target, diff };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!backedUp && text !== null) fs.writeFileSync(`${target}.bak`, text);
  backedUp = true;
  fs.writeFileSync(target, next);
  return { path: target, diff, written: changes };
}
