// Finds the opencode binary and works out which of its models are free, so a
// run never picks a paid one. opencode's `models` prints ids only; prices come
// from its catalog (models.dev data).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveCmd } from './resolve-cmd.js';
import { dataHome } from './delegate-store.js';
import { writeFileAtomic } from './json-file.js';
import { killTree, cliSpawnOptions } from './spawn-cli.js';

const MODELS_BUDGET_MS = 60_000;
const FREE_CACHE_MS = 60 * 60 * 1000;
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CATALOG_URL = 'https://models.opencode.ai/experimental/v2.0/api.json';
const NOT_INSTALLED = 'opencode is not installed (no opencode on PATH)';

// Under consult's per-user data home, never a shared temp folder another user could pre-plant.
export const defaultCatalogFolder = () => path.join(dataHome(), 'opencode-catalog');

export function findOpencodeBinary({ resolve = resolveCmd } = {}) {
  const resolved = resolve('opencode');
  if (!resolved.found) return { unavailable: NOT_INSTALLED };

  const found = resolved.path;
  // A bare name (POSIX) would put the program path under the current folder.
  if (!path.isAbsolute(found)) return { unavailable: `opencode resolved to ${found}, which is not an absolute path, so consult will not run it` };
  if (/\.exe$/i.test(found)) return { path: found };

  // An npm shim (opencode, opencode.cmd) sits next to node_modules; the shim
  // starts a Node wrapper, but the real program is the .exe inside the package.
  const exe = path.join(path.dirname(found), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
  if (!fs.existsSync(exe)) return { unavailable: `opencode was found at ${found} but its program is missing (${exe})` };
  return { path: exe };
}

// The only variables of ours opencode gets (compared in lower case: Windows
// does not tell SystemRoot from SYSTEMROOT). Nothing else of the supervisor's
// environment reaches it, so no key does. CODEX_HOME keeps Codex's sandbox on the
// Codex home its self-test used.
const OPENCODE_ENV_ALLOW_LIST = [
  'SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'CODEX_HOME'
].map((name) => name.toLowerCase());

// The environment of every opencode process consult starts (a run and the model listing): built here, not
// inherited. The allow-list, `openrouterKey` when given, PWD (opencode takes its folder
// from PWD, not from its cwd: measured), TEMP and the XDG folders under `workerTemp`
// ({ root, data, cache, state, config }), the switches that keep a project's own opencode config, plugins
// and the update check out, and `config` as OPENCODE_CONFIG_CONTENT.
export function opencodeEnvironment({ workFolder, workerTemp, config, openrouterKey }) {
  for (const name of ['root', 'data', 'cache', 'state', 'config']) {
    // An empty XDG value is dropped at spawn, and opencode would use the user's own folders.
    if (typeof workerTemp?.[name] !== 'string' || workerTemp[name] === '') throw new Error(`An opencode process needs its temp folders (workerTemp.${name} is missing).`);
  }
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (OPENCODE_ENV_ALLOW_LIST.includes(name.toLowerCase())) env[name] = value;
  }
  if (openrouterKey !== undefined) env.OPENROUTER_API_KEY = openrouterKey;
  return Object.assign(env, {
    PWD: workFolder,
    TEMP: workerTemp.root, TMP: workerTemp.root,
    XDG_DATA_HOME: workerTemp.data, XDG_CACHE_HOME: workerTemp.cache, XDG_STATE_HOME: workerTemp.state, XDG_CONFIG_HOME: workerTemp.config,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
    GIT_OPTIONAL_LOCKS: '0',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
  });
}

// opencode lists OpenRouter's models only when OPENROUTER_API_KEY is set, and any value will do (measured
// 2026-11-20), so the listing gets this placeholder, and only when the user has a key: no secret reaches it.
const LISTING_OPENROUTER_PLACEHOLDER = 'consult-model-listing-only';

// The model listing runs in the catalog folder, with no plugin or MCP server.
function listingEnvironment(cacheFolder) {
  const workerTemp = {
    root: cacheFolder,
    data: path.join(cacheFolder, 'data'),
    cache: path.join(cacheFolder, 'cache'),
    state: path.join(cacheFolder, 'state'),
    config: path.join(cacheFolder, 'config')
  };
  const openrouterKey = process.env.OPENROUTER_API_KEY === undefined ? undefined : LISTING_OPENROUTER_PLACEHOLDER;
  return opencodeEnvironment({ workFolder: cacheFolder, workerTemp, config: { mcp: {}, plugin: [] }, openrouterKey });
}

// --standalone: without it opencode asks a background service, which fails when
// the user's own opencode already holds the service port.
function runBinary({ binary, args, env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...cliSpawnOptions(process.platform) });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => killTree(child, { group: true }), MODELS_BUDGET_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

async function fetchCatalog(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(MODELS_BUDGET_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

// opencode 2.3.0 wrote the catalog to <cache>/opencode/models.json itself; 2.3.2
// does not, so a missing file is fetched from the catalog URL opencode uses and
// stored at the same place.
async function loadCatalog(cacheFolder, fetchText, env, nowMs) {
  const file = path.join(cacheFolder, 'cache', 'opencode', 'models.json');
  if (fs.existsSync(file) && nowMs - fs.statSync(file).mtimeMs < CATALOG_MAX_AGE_MS) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { /* a truncated file (a write that was cut off) is fetched again below */ }
  }

  const text = await fetchText(env.OPENCODE_MODELS_URL || DEFAULT_CATALOG_URL);
  const catalog = JSON.parse(text);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Another supervisor may be writing it too: a rename, so a reader never sees half a file.
  writeFileAtomic(file, text);
  return catalog;
}

// Old catalogs: cost.input / cost.output. Current ones: cost.text.input.price.
// A model with no price at all is unknown, so not free.
function isFree(model) {
  const cost = model?.cost;
  if (!cost) return false;
  const input = typeof cost.input === 'number' ? cost.input : cost.text?.input?.price;
  const output = typeof cost.output === 'number' ? cost.output : cost.text?.output?.price;
  return input === 0 && output === 0;
}

let freeCache = null;

export async function readFreeModels({ binary, cacheFolder = defaultCatalogFolder(), run = runBinary, fetchText = fetchCatalog, env = process.env, now = Date.now } = {}) {
  if (freeCache && freeCache.cacheFolder === cacheFolder && freeCache.binary === binary && now() - freeCache.at < FREE_CACHE_MS) {
    return { ok: true, free: freeCache.free };
  }

  fs.mkdirSync(cacheFolder, { recursive: true, mode: 0o700 });
  // The price list does not depend on the listing, so both load at once.
  const catalogLoad = loadCatalog(cacheFolder, fetchText, env, now()).then((catalog) => ({ catalog }), (error) => ({ error }));
  const result = await run({ binary, args: ['models', '--standalone'], env: listingEnvironment(cacheFolder), cwd: cacheFolder, timeoutMs: MODELS_BUDGET_MS });
  if (result.code !== 0) {
    return { ok: false, reason: `opencode models failed (exit ${result.code}): ${String(result.stderr).trim().slice(0, 300)}` };
  }

  const listed = [];
  for (const line of String(result.stdout).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    if (/^[a-z0-9-]+\/\S+$/.test(line.trim())) listed.push(line.trim());
  }

  const { catalog, error } = await catalogLoad;
  if (error) return { ok: false, reason: `opencode's price list is not available (${error.message}), so no model can be checked as free` };

  const free = [];
  for (const id of listed) {
    const slash = id.indexOf('/');
    if (isFree(catalog[id.slice(0, slash)]?.models?.[id.slice(slash + 1)])) free.push(id);
  }
  freeCache = { cacheFolder, binary, free, at: now() };
  return { ok: true, free };
}

export function chooseModels({ listed, explicit, free }) {
  if (explicit) {
    if (free.includes(explicit)) return { ok: true, models: [explicit] };
    return { ok: false, reason: `${explicit} is not a free opencode model. Free ones: ${free.slice(0, 10).join(', ') || 'none found'}` };
  }

  const freeIds = new Set(free);
  const models = listed.filter((id) => freeIds.has(id));
  if (models.length === 0) return { ok: false, reason: 'none of the listed opencode models is free' };
  return { ok: true, models };
}

export function resetFreeModelsCache() { freeCache = null; }
