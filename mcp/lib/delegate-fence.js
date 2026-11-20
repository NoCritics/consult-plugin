// Helpers for the pi fence: the per-task temp folders a sandboxed pi uses, the
// Codex sandbox self-test and its cache, and the pi launcher lookup.
// Nothing here starts a model; the supervisor wires these in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killTree, shellSafeArgs } from './spawn-cli.js';
import { SPAWN_OPTS, spawnableCmd, resolveCmd } from './resolve-cmd.js';
import { isTaskId, writeJsonAtomic, readJsonOrNull } from './json-file.js';

const PROBE_SCRIPT = fileURLToPath(new URL('./sandbox-probe.js', import.meta.url));
const SANDBOX_CHECK_BUDGET_MS = 60000;
const VERSION_BUDGET_MS = 15000;
// The environment policy every `codex sandbox` run of consult's pins (Ruling 16): the pi wrapper and the
// sandbox check both use it, so a ~/.codex/config.toml with shell_environment_policy.inherit = "core" or
// include_only cannot strip the variables either one needs.
export const SANDBOX_ENV_POLICY_ARGS = ['-c', 'shell_environment_policy.inherit=all', '-c', 'shell_environment_policy.ignore_default_excludes=true'];
// The probe's checks that decide the verdict, in order, by mode. With the network on, the internet and
// loopback lines say nothing about the fence, so only the file checks count.
const REQUIRED_CHECKS = {
  networkOff: ['cwdWritable', 'homeRefused', 'internetRefused', 'loopbackOpen', 'childHomeRefused'],
  networkOn: ['cwdWritable', 'homeRefused', 'childHomeRefused']
};
const NETWORK_ON_KEY_SUFFIX = '|network';
const NETWORK_ON_ARGS = ['-c', 'sandbox_workspace_write.network_access=true'];
// A check the probe could not decide (null): what `failed` says. Not a verdict, so not cached.
const INCONCLUSIVE_NAMES = {
  cwdWritable: 'cwdInconclusive', homeRefused: 'homeInconclusive', internetRefused: 'internetInconclusive',
  loopbackOpen: 'loopbackInconclusive', childHomeRefused: 'childHomeInconclusive'
};

// --- worker temp folders ---------------------------------------------------------

// One retry setting for deleting a folder: a virus scanner or reader can hold it open for a moment.
const REMOVE_FOLDER_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

// A folder that is locked is left alone. Callers that must know use fs.rmSync with REMOVE_FOLDER_OPTIONS.
function removeFolderQuietly(folder) {
  try {
    fs.rmSync(folder, REMOVE_FOLDER_OPTIONS);
  } catch (_) { /* best effort */ }
}

// Copies a folder's files and subfolders into `target` (made where missing); links and other entries are
// skipped. Not fs.cpSync: on Windows, Node 22's cpSync ends the process when a path is not ASCII (22.23.4).
// Throws when `source` itself is a link or junction: a sandboxed pi can swap its temp sessions folder for
// one, and the copy-back must not bring another folder's files into the task.
export function copyFolder(source, target) {
  if (!fs.lstatSync(source).isDirectory()) throw new Error(`${source} is not a folder (a link or junction is not followed)`);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyFolder(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

// Per sandboxed worker: the temp folder under %TEMP% (rootEnv replaces it; the test suites point it at a
// scratch folder), the subfolders made in it, the one subfolder copied back to the task folder as
// `authority`, and what the copy is called in an error message.
const WORKER_TEMP = {
  local: {
    folderName: 'consult-pi', rootEnv: 'CONSULT_PI_TEMP_ROOT',
    subfolders: { sessions: 'pi-sessions', agent: 'agent', tmp: 'tmp' },
    copied: 'sessions', authority: 'pi-sessions', copyName: 'pi sessions'
  },
  opencode: {
    folderName: 'consult-opencode', rootEnv: 'CONSULT_OPENCODE_TEMP_ROOT',
    subfolders: { data: 'data', cache: 'cache', state: 'state', config: 'config', tmp: 'tmp' },
    copied: 'data', authority: 'opencode-data', copyName: 'opencode data'
  }
};

export function workerTempFolders(worker, taskId) {
  if (!isTaskId(taskId)) throw new Error('not a task id: ' + JSON.stringify(taskId));
  const spec = WORKER_TEMP[worker];
  if (spec === undefined) throw new Error('no temp folders for worker: ' + JSON.stringify(worker));
  const root = path.join(process.env[spec.rootEnv] || path.join(os.tmpdir(), spec.folderName), taskId);
  const folders = { root };
  for (const [name, folderName] of Object.entries(spec.subfolders)) folders[name] = path.join(root, folderName);
  return folders;
}

// The task's temp folders for a worker, made where missing. What is in them is left as it is.
export function makeWorkerTempFolders(worker, taskId) {
  const folders = workerTempFolders(worker, taskId);
  for (const name of Object.keys(WORKER_TEMP[worker].subfolders)) fs.mkdirSync(folders[name], { recursive: true });
  return folders;
}

// True when an earlier run left session files in the temp folder (its copy-back failed, or its supervisor
// died). That copy is newer than the task folder's, so the supervisor copies it back first.
export function hasLeftoverSessions(worker, taskId) {
  try {
    return fs.readdirSync(workerTempFolders(worker, taskId)[WORKER_TEMP[worker].copied]).length > 0;
  } catch (_) {
    return false;
  }
}

// Copies the task folder's copy (pi-sessions, opencode-data), the authority, into an emptied temp folder for
// a run. The supervisor has copied any leftover temp copy back before this (hasLeftoverSessions). The other
// temp subfolders are kept.
export function stageSessions(worker, taskDir, taskId) {
  const spec = WORKER_TEMP[worker];
  fs.rmSync(workerTempFolders(worker, taskId)[spec.copied], REMOVE_FOLDER_OPTIONS);
  const folders = makeWorkerTempFolders(worker, taskId);
  // A supervisor that died inside returnSessions can leave the authority as
  // <authority>.old with nothing at <authority>: that is still the authority.
  const authority = path.join(taskDir, spec.authority);
  const authorityOld = path.join(taskDir, spec.authority + '.old');
  const source = fs.existsSync(authority) ? authority : authorityOld;
  if (fs.existsSync(source)) copyFolder(source, folders[spec.copied]);
  return folders;
}

// Copies the temp folder back over the task folder's copy. Never throws:
// returns null on success (or when nothing was staged), else the error message
// for the caller to put in the task's stderr.log. The old folder is replaced
// only after the new copy is complete, so a failed copy loses nothing.
export function returnSessions(worker, taskDir, taskId) {
  const spec = WORKER_TEMP[worker];
  const folders = workerTempFolders(worker, taskId);
  const authority = path.join(taskDir, spec.authority);
  const incoming = path.join(taskDir, spec.authority + '.incoming');
  const authorityOld = path.join(taskDir, spec.authority + '.old');
  try {
    if (!fs.existsSync(folders[spec.copied])) return null;
    fs.rmSync(incoming, { recursive: true, force: true });
    copyFolder(folders[spec.copied], incoming);
    // Swap by renames, so there is never a moment with no authority folder: the
    // old folder steps aside, the new one moves in, then the old one goes.
    if (fs.existsSync(authority)) {
      fs.rmSync(authorityOld, REMOVE_FOLDER_OPTIONS);
      fs.renameSync(authority, authorityOld);
    }
    try {
      fs.renameSync(incoming, authority);
    } catch (error) {
      if (!fs.existsSync(authority) && fs.existsSync(authorityOld)) fs.renameSync(authorityOld, authority);
      throw error;
    }
    fs.rmSync(authorityOld, REMOVE_FOLDER_OPTIONS);
    return null;
  } catch (error) {
    try { fs.rmSync(incoming, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    return `could not copy ${spec.copyName} back: ${error.message}`;
  }
}

export function removeWorkerTemp(worker, taskId) {
  if (!isTaskId(taskId) || WORKER_TEMP[worker] === undefined) return;
  // A locked folder is left for the next sweep.
  removeFolderQuietly(workerTempFolders(worker, taskId).root);
}

// The Codex that would wrap a fenced pi, as resolveCmd finds it. The one lookup the
// supervisor and the Delegated tab share: the test suites set CONSULT_DELEGATE_TEST_NO_CODEX
// so neither ever starts a real Codex. Only the fence uses this; ask_codex and Codex
// tasks find Codex through resolveCmd as before.
export function findCodexForFence() {
  if (process.env.CONSULT_DELEGATE_TEST_NO_CODEX) return { path: 'codex', found: false };
  return resolveCmd('codex');
}

// pi.cmd cannot start under the sandbox; node on the launcher beside it can.
export function piLauncherFor(piCmdPath) {
  const launcher = path.join(path.dirname(piCmdPath), 'pi-launcher.js');
  return fs.existsSync(launcher) ? launcher : null;
}

// --- the Codex sandbox check -------------------------------------------------

// run(command, args, { cwd, timeoutMs, env }) -> { code, stdout, stderr, timedOut }
// `env`, when given, is the whole environment of the child.
// How a CLI is started the way spawn-cli.js does: under cmd.exe (Windows) the
// program is quoted and arguments with spaces are quoted, so an npm codex.cmd works.
export function spawnPlanFor(command, args) {
  return { file: spawnableCmd(command), args: shellSafeArgs(args), shell: SPAWN_OPTS.shell };
}

function defaultRun(command, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const plan = spawnPlanFor(command, args);
    const child = spawn(plan.file, plan.args, { cwd, env: env ?? process.env, windowsHide: true, shell: plan.shell });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// The sandbox-check cache file (one of consult's own files, see consultProtectedPaths).
export function checkFilePath() {
  return process.env.CONSULT_SANDBOX_CHECK_FILE || path.join(os.homedir(), '.claude', 'consult-sandbox-check.json');
}

function readCacheFile() {
  try {
    const parsed = readJsonOrNull(checkFilePath());
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// Codex's path in the key is its real long path (case-folded on Windows): the MCP server, the supervisor
// and the tab's hook can find the same file through different spellings (an 8.3 short PATH entry, a junction).
function keyPath(codexPath) {
  let real = codexPath;
  try { real = fs.realpathSync.native(codexPath); } catch (_) { /* a missing file keys as written */ }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function cacheKey(codexPath, version, network = false) {
  return keyPath(codexPath) + '|' + version + (network ? NETWORK_ON_KEY_SUFFIX : '');
}

// Whether a cache key is for this mode, given the prefix cacheKey(path, '') makes.
function keyIsOfMode(key, prefix, network) {
  return key.startsWith(prefix) && key.endsWith(NETWORK_ON_KEY_SUFFIX) === network;
}

// A pass holds for that Codex version for good; a failure is trusted for an hour, then the next caller probes again.
const FAILED_CHECK_TTL_MS = 60 * 60 * 1000;

// The cached result for this Codex at this version, or null. Read only.
export function readSandboxCheck(codexPath, version, now = Date.now, network = false) {
  return resultOfEntry(readCacheFile()[cacheKey(codexPath, version, network)], now);
}

function resultOfEntry(entry, now) {
  if (!entry || typeof entry.ok !== 'boolean') return null;
  if (!entry.ok) {
    const checkedAtMs = Date.parse(entry.checkedAt);
    // No readable time: treat the failure as old, so it is probed again.
    if (Number.isNaN(checkedAtMs) || now() - checkedAtMs >= FAILED_CHECK_TTL_MS) return null;
  }
  return { ok: entry.ok, failed: entry.failed ?? null };
}

// The Codex file's mtime and size, or null when it cannot be read.
function fileStamp(codexPath) {
  try {
    const stat = fs.statSync(codexPath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (_) {
    return null;
  }
}

// Whether the file's mtime and size can stand for Codex's version: only for a real program, a .exe on
// Windows. A .cmd, .bat or .ps1 shim, or another launcher, stays the same when the Codex behind it updates.
function stampNamesCodex(codexPath) {
  return process.platform === 'win32' && /\.exe$/i.test(codexPath);
}

// The cached result for the Codex file at this path, found by the file's own mtime and size instead
// of by its version, so no `codex --version` is started to read it. Entries written before the stamp
// existed have none and are not found. Same expiry as readSandboxCheck.
function readSandboxCheckByFile(codexPath, entries, now, network) {
  if (!stampNamesCodex(codexPath)) return null;
  const stamp = fileStamp(codexPath);
  if (stamp === null) return null;
  const prefix = cacheKey(codexPath, '');
  for (const key of Object.keys(entries)) {
    const entry = entries[key];
    if (!keyIsOfMode(key, prefix, network) || !entry || entry.mtimeMs !== stamp.mtimeMs || entry.size !== stamp.size) continue;
    return resultOfEntry(entry, now);
  }
  return null;
}

// Whether the cache holds an entry for this Codex path that still counts: a pass, or a failure under an hour old.
function hasEntryThatCounts(codexPath, entries, now, network) {
  const prefix = cacheKey(codexPath, '');
  for (const key of Object.keys(entries)) {
    if (keyIsOfMode(key, prefix, network) && resultOfEntry(entries[key], now) !== null) return true;
  }
  return false;
}

// What the cache says of this Codex, without probing it: { ok, failed }, or null when it has no verdict.
// Codex is not run when the cache has no entry for its path that still counts, nor when the file's stamp
// finds the entry (a .exe on Windows). Otherwise `readVersion(codexPath)` (Codex's version or null) names
// it: by default one `codex --version` within sandboxCheck's budget; the tab passes the sync readCodexVersion.
export async function readCachedSandboxCheck(codexPath, { readVersion = (codexFile) => codexVersionByRun(codexFile, defaultRun), now = Date.now, network = false } = {}) {
  const entries = readCacheFile();
  if (!hasEntryThatCounts(codexPath, entries, now, network)) return null;
  const foundByFile = readSandboxCheckByFile(codexPath, entries, now, network);
  if (foundByFile !== null) return foundByFile;
  const version = await readVersion(codexPath);
  if (version === null) return null;
  return resultOfEntry(entries[cacheKey(codexPath, version, network)], now);
}

function writeSandboxCheck(key, result, now, stamp) {
  const entries = readCacheFile();
  entries[key] = { ok: result.ok, failed: result.failed, checkedAt: new Date(now()).toISOString(), ...(stamp ?? {}) };
  writeJsonAtomic(checkFilePath(), entries);
}

function lastJsonLine(text) {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line); } catch (_) { /* keep looking */ }
  }
  return null;
}

// The probe runs in the shape pi does (Ruling 19): its cwd is a work folder and its
// TEMP and TMP a temp folder of its own, both inside one fresh folder, so Codex
// grants write access to those two and not to the real %TEMP%.
async function runProbe(codexPath, run, network) {
  const probeFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-sandbox-check-'));
  const workFolder = path.join(probeFolder, 'work');
  const tempFolder = path.join(probeFolder, 'temp');
  try {
    fs.mkdirSync(workFolder);
    fs.mkdirSync(tempFolder);
    const finished = await run(
      codexPath,
      ['sandbox', '-c', 'sandbox_mode=workspace-write', ...(network ? NETWORK_ON_ARGS : []), ...SANDBOX_ENV_POLICY_ARGS, '--', process.execPath, PROBE_SCRIPT],
      { cwd: workFolder, timeoutMs: SANDBOX_CHECK_BUDGET_MS, env: { ...process.env, TEMP: tempFolder, TMP: tempFolder } }
    );
    if (finished.timedOut) return { timedOut: true };
    const probe = lastJsonLine(finished.stdout);
    if (probe === null) {
      // The sandbox never ran the probe (for example "windows sandbox failed: ..."):
      // that says nothing about the sandbox's rules, so it is not cached.
      const firstLine = (finished.stderr.trim().split(/\r?\n/)[0] || 'the probe printed nothing').slice(0, 200);
      return { inconclusive: 'the sandbox could not start the check: ' + firstLine };
    }
    for (const name of REQUIRED_CHECKS[network ? 'networkOn' : 'networkOff']) {
      // null: the probe could not tell (offline, a failed lookup, a home write that failed some
      // other way than a refusal). Not a verdict.
      if (probe[name] === null) return { inconclusive: INCONCLUSIVE_NAMES[name] };
      if (probe[name] !== true) return { ok: false, failed: name };
    }
    return { ok: true, failed: null };
  } finally {
    removeFolderQuietly(probeFolder);
  }
}

// Codex's version as the cache key spells it (its `--version` output, trimmed), or
// null when it does not answer in 5 s. Sync, for the tab. Started the way
// sandboxCheck starts it, so an npm codex.cmd works too.
export function readCodexVersion(codexPath) {
  try {
    const plan = spawnPlanFor(codexPath, ['--version']);
    const finished = spawnSync(plan.file, plan.args, { cwd: os.tmpdir(), timeout: 5000, windowsHide: true, encoding: 'utf8', shell: plan.shell });
    if (finished.error || finished.status !== 0 || typeof finished.stdout !== 'string') return null;
    const version = finished.stdout.trim();
    return version === '' ? null : version;
  } catch (_) {
    return null;
  }
}

// Codex's version through `run` (its `--version` output, trimmed), or null when it does not answer within the budget.
async function codexVersionByRun(codexPath, run) {
  const versionRun = await run(codexPath, ['--version'], { cwd: os.tmpdir(), timeoutMs: VERSION_BUDGET_MS });
  const version = versionRun.stdout.trim();
  if (versionRun.code !== 0 || versionRun.timedOut || version === '') return null;
  return version;
}

const checksInProgress = new Map();

// { ok, failed, cached }. `failed` names the first probe check that did not
// hold. A timeout, a probe that never ran, and a check the probe could not decide
// (offline internet, a home write that failed some other way) are
// { ok: false, cached: false } with a reason in `failed`, and are not cached. A
// cache that cannot be written still returns the verdict, with cached: false.
// Callers for the same Codex at once share one run.
export async function sandboxCheck({ codexPath, run = defaultRun, now = Date.now, network = false }) {
  const version = await codexVersionByRun(codexPath, run);
  if (version === null) return { ok: false, failed: 'codex --version did not answer', cached: false };
  const key = cacheKey(codexPath, version, network);
  const cachedEntry = readSandboxCheck(codexPath, version, now, network);
  if (cachedEntry !== null) return { ...cachedEntry, cached: true };

  if (!checksInProgress.has(key)) {
    const started = (async () => {
      const outcome = await runProbe(codexPath, run, network);
      if (outcome.timedOut) return { ok: false, failed: 'the check took over 60 s', cached: false };
      if (outcome.inconclusive) return { ok: false, failed: outcome.inconclusive, cached: false };
      try {
        writeSandboxCheck(key, outcome, now, fileStamp(codexPath));
      } catch (_) {
        // The verdict stands; it is just not kept, so the next task checks again.
      }
      return { ok: outcome.ok, failed: outcome.failed, cached: false };
    })().finally(() => checksInProgress.delete(key));
    checksInProgress.set(key, started);
  }
  return checksInProgress.get(key);
}
