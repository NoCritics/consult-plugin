// The delegate task store: background tasks run by Codex, agy or a local model.
//
// <data>/tasks/<id>/state.json   the truth about one task (brief.md beside it)
// <data>/index.json              one row per task for the pane, newest first
// <data>/servers/<instance>.json a server's heartbeat; its mtime is the clock
//
// Every file is written to a temp file and renamed over the target, so a
// reader (another server, the mod) never sees half a file. Times are ms since
// the epoch. Per-project settings live in ~/.claude/consult-projects.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DELEGATE_WORKERS } from './settings.js';
import { removePiTemp, checkFilePath } from './delegate-fence.js';
import { realPathOfTarget, isInside } from './pi-fence.js';
import { isTaskId, sleepSync, lockLostError, writeFileAtomic, writeJsonAtomic, readJsonOrNull } from './json-file.js';

// The file helpers live in json-file.js (the fence needs them too); callers keep importing them from here.
export { isTaskId, writeJsonAtomic, readJsonOrNull };

const TASK_STATES = Object.freeze([
  'queued', 'running', 'done', 'merged', 'conflict', 'held', 'paused-limit', 'stopped', 'cancelled', 'failed'
]);
// A task is queued or running only while its supervisor lives.
export const ACTIVE_STATES = Object.freeze(['queued', 'running']);
export const STOP_REASONS = Object.freeze(['time-limit', 'watchdog', 'session-closed', 'supervisor-stopped', 'supervisor-died']);

const TASK_MODES = ['read', 'write'];
const TASK_LOCATIONS = ['here', 'copy'];
const WORKERS_EDIT_VALUES = ['auto', 'here', 'copy'];
const GIT_ANSWERS = ['ask', 'declined'];
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export const MAX_INDEX_ROWS = 200;
const HEARTBEAT_MAX_AGE_MS = 45000;
// A recorded supervisor counts as alive for a claim or a place in the queue
// while its beat is this recent (a pid alone can be recycled by an unrelated
// process); a supervisor beats at least every 10 s, and every 5 s while it
// waits for or starts a local task.
export const SUPERVISOR_BEAT_FRESH_MS = 30000;
// A running local task holds the runner while its supervisor has beaten this recently.
export const RUNNING_BEAT_FRESH_MS = 45000;
const FINISHED_STATES = ['done', 'merged', 'stopped', 'cancelled', 'failed'];
const LOCK_STALE_MS = 10000;
const LOCK_PATIENCE_MS = 15000;
const BREAKER_STALE_MS = 30000;
const LOCK_RETRY_MS = 5;
const LOCK_READ_PATIENCE_MS = 1000;
const LOCK_ASYNC_RETRY_MS = 20;

const INDEX_FIELDS = [
  'id', 'worker', 'model', 'title', 'project', 'state', 'location', 'mode', 'summary', 'fenced', 'fence', 'fence_layer',
  'started_at', 'ended_at', 'stop_reason', 'limit', 'queue_model', 'owner_instance', 'reported_at',
  'queue_waiting_long', 'keep_running', 'hold', 'owner_session', 'created_at', 'queued_at', 'read_only_edits', 'time_limit_ms'
];

// What each worker's tasks may do beyond the folder they work in. Codex is
// `fenced` (an enforced fence) or `full`; agy and local are `fenced` or `none`.
// A stored `soft` (0.16.0) reads as `fenced`.
export const FENCE_VALUES = Object.freeze({ codex: ['fenced', 'full'], agy: ['fenced', 'none'], local: ['fenced', 'none'] });
export const DEFAULT_FENCE = Object.freeze({ codex: 'fenced', agy: 'fenced', local: 'fenced' });

// A fence value as the worker reads it: a valid value as is, `soft` as `fenced`,
// anything else as the worker's default (`fenced` for an unknown worker).
export function normalFence(worker, value) {
  if (!Object.hasOwn(FENCE_VALUES, worker)) return 'fenced';
  if (FENCE_VALUES[worker].includes(value)) return value;
  if (value === 'soft') return 'fenced';
  return DEFAULT_FENCE[worker];
}

// The task's own fence when it is valid for its worker, else the worker's
// default (a task from before fences has none). A state.json an unfenced worker
// rewrote may name any worker: an unknown one reads as fenced.
export function taskFence(task) {
  return normalFence(task.worker, task.fence);
}

// The more restrictive of two fences for one worker: the first value in
// FENCE_VALUES (`fenced`) wins over the lifted one. A worker that is
// not fenced can rewrite a task's state.json, so the fence stored there never
// widens what the project's setting allows.
export function narrowerFence(worker, first, second) {
  const liftedValue = FENCE_VALUES[worker][1];
  if (first === liftedValue && second === liftedValue) return liftedValue;
  return DEFAULT_FENCE[worker];
}

export function dataHome(env = process.env) {
  return env.CONSULT_DELEGATE_HOME || path.join(os.homedir(), '.claude', 'consult-delegate');
}

export function taskFolder(id) {
  return path.join(dataHome(), 'tasks', id);
}

// ---- tasks ----

export function newTaskId() {
  while (true) {
    const id = randomBytes(3).toString('hex');
    if (!fs.existsSync(taskFolder(id))) return id;
  }
}

function requireOneOf(label, value, allowed) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
}

// Writes the task folder and returns the state. `spec` names the worker, mode,
// location, project and brief; `keep_running` is `delegate.on_close === 'keep'`
// as it stands when the task starts, and `time_limit_ms` the limit then.
export function createTask(spec) {
  requireOneOf('worker', spec.worker, DELEGATE_WORKERS);
  requireOneOf('mode', spec.mode, TASK_MODES);
  requireOneOf('location', spec.location, TASK_LOCATIONS);
  if (typeof spec.project !== 'string' || spec.project === '') throw new Error('project must be a folder path');
  const fence = spec.fence ?? DEFAULT_FENCE[spec.worker];
  requireOneOf('fence', fence, FENCE_VALUES[spec.worker]);
  const id = newTaskId();
  const createdAt = spec.created_at ?? Date.now();
  const state = {
    id,
    worker: spec.worker,
    model: spec.model ?? null,
    effort: spec.effort ?? null,
    title: spec.title ?? '',
    kind: spec.kind ?? null,
    project: spec.project,
    mode: spec.mode,
    location: spec.location,
    worktree: null,
    branch: null,
    start_commit: null,
    end_commit: null,
    state: 'queued',
    stop_reason: null,
    owner_instance: spec.owner_instance ?? null,
    owner_session: spec.owner_session ?? null,
    created_at: createdAt,
    // When it last began waiting: set again when a follow-up requeues it.
    queued_at: createdAt,
    started_at: null,
    ended_at: null,
    last_output_at: null,
    worker_session: null,
    pi_session: spec.worker === 'local' ? randomUUID() : null,
    supervisor_pid: null,
    summary: null,
    log_path: null,
    final_path: null,
    limit: null,
    fenced: null,
    fence,
    fence_layer: null,
    hold: spec.hold ?? false,
    keep_running: spec.keep_running ?? false,
    time_limit_ms: spec.time_limit_ms ?? null,
    reported_at: null,
    queue_model: spec.queue_model ?? null,
    queue_waiting_long: false
  };
  fs.mkdirSync(taskFolder(id), { recursive: true });
  writeFileAtomic(path.join(taskFolder(id), 'brief.md'), spec.brief ?? '');
  writeJsonAtomic(path.join(taskFolder(id), 'state.json'), state);
  rewriteIndex();
  return state;
}

// The commit that what is left to merge counts from: what the last merge applied
// (a conflict, then a follow-up), else where the copy started.
export function unmergedBase(task) {
  return typeof task.merged_commit === 'string' && task.merged_commit !== '' ? task.merged_commit : task.start_commit;
}

export function readTask(id) {
  if (!isTaskId(id)) return null;
  const state = readJsonOrNull(path.join(taskFolder(id), 'state.json'));
  // A state.json is the task of the folder it is in. One that names another id (a worker can rewrite its
  // own) is no task: it must not stand in for the one it names.
  if (state !== null && state.id !== id) return null;
  return state;
}

// Windows answers EPERM, EBUSY or EACCES, not EEXIST, when a folder is made or
// removed while another process still has it open or delete-pending (or a
// virus scanner or indexer is looking at it); all of them mean "try again".
function isTransientFileError(error) {
  return error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES';
}

// Removes a lock folder that is older than LOCK_STALE_MS (its holder died).
// Returns true when the lock is gone, false when it is still there (or was
// not stale after all) and the caller should wait. Breakers go one at a time:
// each takes the `.lock.breaker` folder first and checks the lock's age again
// inside it, so a breaker that saw an old lock cannot remove the fresh one a
// holder made after another breaker removed the old one. Only breakers make
// `.lock.breaker`, so one left by a dead breaker is simply removed once it is
// older than BREAKER_STALE_MS.
export function breakStaleLock(lockPath, staleMs = LOCK_STALE_MS) {
  const breakerPath = `${lockPath}.breaker`;
  try {
    fs.mkdirSync(breakerPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      let breakerAgeMs = 0;
      try { breakerAgeMs = Date.now() - fs.statSync(breakerPath).mtimeMs; } catch (_) { return false; }
      if (breakerAgeMs > BREAKER_STALE_MS) {
        try { fs.rmdirSync(breakerPath); } catch (_) { /* another breaker removed it, or it is busy */ }
      }
    }
    return false;
  }
  try {
    let lockAgeMs = 0;
    try { lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch (_) { return true; /* already gone */ }
    if (lockAgeMs <= staleMs) return false;
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  } finally {
    try { fs.rmdirSync(breakerPath); } catch (_) { /* a leftover is broken once it is old */ }
  }
}

// A lock is a folder made exclusively (mkdir fails if it exists) with a file
// inside that holds a random token of its holder. A lock older than its stale
// time is taken to belong to a holder that died and is broken, but a holder
// that was only slow (a suspend, a long request) is still inside: it checks
// `stillOwned()` before it writes, and its release removes the folder only
// while the token in it is its own, so it never takes down the lock of the
// process that broke its own.
const LOCK_OWNER_FILE = 'owner';

// Makes the lock folder and writes the token. Throws mkdir's error (EEXIST: held).
function takeLockFolder(lockPath) {
  fs.mkdirSync(lockPath);
  const token = randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(path.join(lockPath, LOCK_OWNER_FILE), token);
  } catch (error) {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch (_) { /* broken as stale later */ }
    throw error;
  }
  return token;
}

// The token in the lock's owner file, or null when there is none (no file, or
// no lock folder). Any other read error is thrown, a refused read included.
function readLockToken(lockPath) {
  try {
    return fs.readFileSync(path.join(lockPath, LOCK_OWNER_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// A lock is owned only when its owner file can be read and holds our token.
// On Windows a virus scanner can hold the owner file open for a moment and
// refuse the read (EPERM, EBUSY, EACCES): that is waited out for
// LOCK_READ_PATIENCE_MS. A read that stays refused, or fails any other way,
// proves nothing, so it counts as lost: a lock is only taken over after its
// holder was slow past the stale time, and the thief's fresh owner file is
// just what a scanner holds. Losing costs a retry; keeping a lost lock would
// let two holders write, and let our exit hook remove the thief's lock.
function lockStillOwned(lockPath, token) {
  const giveUpAt = Date.now() + LOCK_READ_PATIENCE_MS;
  while (true) {
    try {
      return readLockToken(lockPath) === token;
    } catch (error) {
      if (!isTransientFileError(error) || Date.now() >= giveUpAt) return false;
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

// Runs `action(lock)` holding the task's lock: a `.lock` folder in the task
// folder. The supervisor, the owning server and the pane script all write one
// state.json, so a read-merge-write must not interleave. `lock.stillOwned()`
// says whether the lock is still this call's; a write through writeJsonAtomic
// checks it right before the rename, and an action that lost the lock is run
// again from the start. A stale lock (LOCK_STALE_MS) is broken. Every pass
// through the retry loop checks the patience budget and either makes progress
// or sleeps.
export function withTaskLock(id, action, { patienceMs = LOCK_PATIENCE_MS } = {}) {
  const lockPath = path.join(taskFolder(id), '.lock');
  const giveUpAt = Date.now() + patienceMs;
  while (true) {
    let token = null;
    while (token === null) {
      try {
        token = takeLockFolder(lockPath);
      } catch (error) {
        if (error.code !== 'EEXIST' && !isTransientFileError(error)) throw error;
        if (Date.now() >= giveUpAt) throw new Error(`Delegate task ${id} is locked by another process`);
        if (error.code === 'EEXIST') {
          let lockAgeMs = 0;
          try { lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch (_) { continue; /* released meanwhile */ }
          if (lockAgeMs > LOCK_STALE_MS && breakStaleLock(lockPath)) continue;
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    try {
      return action({ stillOwned: () => lockStillOwned(lockPath, token) });
    } catch (error) {
      if (error.code !== 'ELOCKLOST' || Date.now() >= giveUpAt) throw error;
    } finally {
      releaseLock(lockPath, token);
    }
  }
}

// The same lock for an action that awaits (the local admission holds one
// across a request to the runner): broken when older than `staleMs`. The
// waiting sleeps on the event loop, not the thread, so a holder in this same
// process can finish. `action({ stillOwned })`: the holder asks before it
// writes whether it still holds the lock. Gives up after `patienceMs` with an
// error whose code is ELOCKED. A process that exits inside the action takes
// its lock folder with it.
export async function withLockFolder(lockPath, action, { staleMs = LOCK_STALE_MS, patienceMs = LOCK_PATIENCE_MS } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const giveUpAt = Date.now() + patienceMs;
  let token = null;
  while (token === null) {
    try {
      token = takeLockFolder(lockPath);
    } catch (error) {
      if (error.code !== 'EEXIST' && !isTransientFileError(error)) throw error;
      if (Date.now() >= giveUpAt) throw Object.assign(new Error(`${path.basename(lockPath)} is locked by another process`), { code: 'ELOCKED' });
      if (error.code === 'EEXIST') {
        let lockAgeMs = 0;
        try { lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch (_) { continue; /* released meanwhile */ }
        if (lockAgeMs > staleMs && breakStaleLock(lockPath, staleMs)) continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_ASYNC_RETRY_MS));
    }
  }
  const releaseOnExit = () => {
    // Only a token that was read and is ours: an unreadable one may be the thief's.
    try {
      if (lockStillOwned(lockPath, token)) fs.rmSync(lockPath, { recursive: true, force: true });
    } catch (_) { /* broken as stale later */ }
  };
  process.on('exit', releaseOnExit);
  try {
    return await action({ stillOwned: () => lockStillOwned(lockPath, token) });
  } finally {
    process.off('exit', releaseOnExit);
    releaseLock(lockPath, token);
  }
}

// An unreleased lock only costs the next writer LOCK_STALE_MS of waiting, so
// a release that keeps failing is given up on rather than thrown. A lock that
// is no longer this holder's (broken as stale, and taken by another) is left.
// A refused read of the owner file is tried again like any refused removal.
function releaseLock(lockPath, token) {
  const giveUpAt = Date.now() + LOCK_PATIENCE_MS;
  let tokenRemoved = false;
  while (true) {
    try {
      if (!tokenRemoved) {
        if (readLockToken(lockPath) !== token) return;
        fs.rmSync(path.join(lockPath, LOCK_OWNER_FILE), { force: true });
        tokenRemoved = true;
      }
      fs.rmdirSync(lockPath);
      return;
    } catch (error) {
      if (!isTransientFileError(error) || Date.now() >= giveUpAt) return; // else: already broken as stale
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

// Merges `changes` into the task's state (its id never changes) and rewrites
// the index when a field the index shows changed. Returns the new state.
export function updateTask(id, changes) {
  return updateTaskWhen(id, () => changes);
}

// Whether a field the index shows differs between two states of a task.
function indexRowChanged(before, after) {
  const beforeRow = indexRow(before);
  const afterRow = indexRow(after);
  for (const field of INDEX_FIELDS) {
    if (JSON.stringify(beforeRow[field]) !== JSON.stringify(afterRow[field])) return true;
  }
  return false;
}

// Like updateTask, but the changes are decided under the lock from the state
// as it is then: `decide(current)` returns the changes, or null to leave the
// task alone. Returns the new state, or null when nothing was changed.
// `alsoOwned`, when given, is a second lock the caller holds (the local
// admission's): it is asked before every rename attempt together with the
// task's own, and a write whose second lock was lost is decided again.
export function updateTaskWhen(id, decide, { alsoOwned = null } = {}) {
  if (readTask(id) === null) throw new Error(`No delegate task with id ${JSON.stringify(id)}`);
  let indexChanged = false;
  const updated = withTaskLock(id, (lock) => {
    indexChanged = false;
    const current = readTask(id);
    if (current === null) throw new Error(`No delegate task with id ${JSON.stringify(id)}`);
    const changes = decide(current);
    if (changes === null) return null;
    if (changes.state !== undefined) requireOneOf('state', changes.state, TASK_STATES);
    if (changes.stop_reason !== undefined && changes.stop_reason !== null) requireOneOf('stop_reason', changes.stop_reason, STOP_REASONS);
    const merged = { ...current, ...changes, id: current.id };
    const stillOwned = alsoOwned === null ? lock.stillOwned : () => lock.stillOwned() && alsoOwned();
    writeJsonAtomic(path.join(taskFolder(id), 'state.json'), merged, stillOwned);
    indexChanged = indexRowChanged(current, merged);
    return merged;
  });
  if (indexChanged) rewriteIndex();
  return updated;
}

// Removes a task's folder, and so its row in the index, when `allowed(current)`
// says so; it is asked under the task's lock, with the state as it is then.
// True when the task was removed, false when it was refused or already gone.
export function removeTaskWhen(id, allowed) {
  if (readTask(id) === null) return false;
  const removed = withTaskLock(id, () => {
    const current = readTask(id);
    if (current === null || !allowed(current)) return false;
    fs.rmSync(taskFolder(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    removePiTemp(id);
    return true;
  });
  if (removed) rewriteIndex();
  return removed;
}

// Every task folder's state, newest first, and the folders whose state.json
// exists but cannot be read (after one more try: a reader can be refused for
// a moment on Windows) as { id, modifiedAt }. A folder with no state.json
// (half made, or stray) is in neither.
export function scanTasks() {
  let names;
  try {
    names = fs.readdirSync(path.join(dataHome(), 'tasks'));
  } catch (error) {
    if (error.code === 'ENOENT') return { tasks: [], unreadable: [] };
    throw error;
  }
  const tasks = [];
  const unreadable = [];
  for (const name of names) {
    let state = null;
    try {
      try {
        state = readTask(name);
      } catch (_) {
        sleepSync(25);
        state = readTask(name);
      }
    } catch (_) {
      let modifiedAt = 0;
      try { modifiedAt = fs.statSync(path.join(taskFolder(name), 'state.json')).mtimeMs; } catch (__) { /* gone meanwhile */ }
      unreadable.push({ id: name, modifiedAt });
    }
    if (state !== null) tasks.push(state);
  }
  tasks.sort((first, second) => second.created_at - first.created_at || (first.id < second.id ? -1 : 1));
  return { tasks, unreadable };
}

function allTasks() {
  return scanTasks().tasks;
}

// The index is rebuilt from the folders. Reading the folders, building the rows
// and writing them happen holding `index.lock` in the data folder, so a rebuild
// that read the folders earlier can never write after one that read them later.
// A task that is not finished (queued, running, held, paused, conflict) is always
// listed; the newest finished ones fill the rest of the MAX_INDEX_ROWS. An index
// whose rows are already right is not written again, so its readers see no change.
// A lock that cannot be had in time leaves the rebuild to the server's periodic
// sweep (refreshIndex), as does a crash in the middle of the write.
function rewriteIndex() {
  try {
    withIndexLock((lock) => rebuildIndex(lock));
  } catch (error) {
    if (error.code !== 'ELOCKED' && error.code !== 'ELOCKLOST') throw error;
  }
}

// The same lock as withTaskLock, on `index.lock` in the data folder.
function withIndexLock(action) {
  fs.mkdirSync(dataHome(), { recursive: true });
  const lockPath = path.join(dataHome(), 'index.lock');
  const giveUpAt = Date.now() + LOCK_PATIENCE_MS;
  while (true) {
    let token = null;
    while (token === null) {
      try {
        token = takeLockFolder(lockPath);
      } catch (error) {
        if (error.code !== 'EEXIST' && !isTransientFileError(error)) throw error;
        if (Date.now() >= giveUpAt) throw Object.assign(new Error('The delegate index is locked by another process'), { code: 'ELOCKED' });
        if (error.code === 'EEXIST') {
          let lockAgeMs = 0;
          try { lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch (_) { continue; /* released meanwhile */ }
          if (lockAgeMs > LOCK_STALE_MS && breakStaleLock(lockPath)) continue;
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    try {
      return action({ stillOwned: () => lockStillOwned(lockPath, token) });
    } catch (error) {
      if (error.code !== 'ELOCKLOST' || Date.now() >= giveUpAt) throw error;
    } finally {
      releaseLock(lockPath, token);
    }
  }
}

function rebuildIndex(lock) {
  const tasks = allTasks();
  let finishedSlots = MAX_INDEX_ROWS;
  for (const state of tasks) {
    if (!FINISHED_STATES.includes(state.state)) finishedSlots--;
  }
  const rows = [];
  for (const state of tasks) {
    if (FINISHED_STATES.includes(state.state)) {
      if (finishedSlots <= 0) continue;
      finishedSlots--;
    }
    rows.push(indexRow(state));
  }
  const indexPath = path.join(dataHome(), 'index.json');
  let written = null;
  try {
    written = readJsonOrNull(indexPath);
  } catch (_) { /* unreadable: written again below */ }
  if (written !== null && JSON.stringify(written.tasks) === JSON.stringify(rows)) return;
  writeJsonAtomic(indexPath, { updated_at: Date.now(), tasks: rows }, lock.stillOwned);
}

// Rebuilds the index from the task folders. A write skips the rebuild when no
// field the index shows changed, so a row left stale by two rebuilds racing
// is healed here; the server's periodic sweep calls it.
export function refreshIndex() {
  rewriteIndex();
}

// The rows of index.json, or null when it is absent, unreadable or not shaped
// like an index (the caller then reads the task folders instead). A row is a
// hint about a task, never its state: read the task before acting on it.
export function indexRows() {
  try {
    const index = readJsonOrNull(path.join(dataHome(), 'index.json'));
    if (index === null || typeof index !== 'object' || !Array.isArray(index.tasks)) return null;
    return index.tasks;
  } catch (_) {
    return null;
  }
}

// The fields of a task that index.json (and the tools' lists) show.
export function indexRow(state) {
  const row = {};
  for (const field of INDEX_FIELDS) row[field] = state[field];
  return row;
}

// Every task's full state, newest first, optionally only one project's.
export function listTasks({ project } = {}) {
  const tasks = allTasks();
  if (project === undefined) return tasks;
  const wantedKey = projectKey(project);
  const matching = [];
  for (const task of tasks) {
    if (projectKey(task.project) === wantedKey) matching.push(task);
  }
  return matching;
}

// Whether a process with this pid exists (EPERM: it does, and is not ours).
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// ---- heartbeat ----

// A server calls this every few seconds; its file's mtime is the proof of life.
// The file also names the server's Claude Code session, so a task whose owner
// server was replaced (a /mcp reconnect) is still known to have a live session.
export function beat(instanceId, session = process.env.CLAUDE_CODE_SESSION_ID || null) {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) throw new Error(`Invalid instance id ${JSON.stringify(instanceId)}`);
  const plainSession = typeof session === 'string' && SESSION_ID_PATTERN.test(session) ? session : null;
  writeJsonAtomic(path.join(dataHome(), 'servers', `${instanceId}.json`), { pid: process.pid, at: Date.now(), session: plainSession });
}

// Whether any server has beaten lately (the same rule as isAlive) and names this session.
// A torn, garbage or unreadable file is skipped.
export function isSessionAlive(session, now = Date.now()) {
  if (typeof session !== 'string' || !SESSION_ID_PATTERN.test(session)) return false;
  const serversFolder = path.join(dataHome(), 'servers');
  let names;
  try {
    names = fs.readdirSync(serversFolder);
  } catch (_) {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = path.join(serversFolder, name);
      if (now - fs.statSync(file).mtimeMs > HEARTBEAT_MAX_AGE_MS) continue;
      const content = readJsonOrNull(file);
      if (content !== null && typeof content === 'object' && content.session === session) return true;
    } catch (_) { /* a beat being written, or not a beat */ }
  }
  return false;
}

// Whether the task's recorded supervisor is running: its pid is alive and it has beaten
// recently (a pid alone can be recycled). `exceptPid` is a supervisor that does not count (the caller's own).
export function isSupervisorLive(task, exceptPid = null) {
  if (typeof task.supervisor_pid !== 'number' || task.supervisor_pid === exceptPid) return false;
  if (typeof task.supervisor_beat_at !== 'number' || Date.now() - task.supervisor_beat_at >= SUPERVISOR_BEAT_FRESH_MS) return false;
  return isProcessAlive(task.supervisor_pid);
}

export function isAlive(instanceId, now = Date.now()) {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) return false;
  try {
    const beatenAt = fs.statSync(path.join(dataHome(), 'servers', `${instanceId}.json`)).mtimeMs;
    return now - beatenAt <= HEARTBEAT_MAX_AGE_MS;
  } catch (_) {
    return false;
  }
}

// ---- per-project settings ----

function projectsFile() {
  return process.env.CONSULT_PROJECTS_FILE || path.join(os.homedir(), '.claude', 'consult-projects.json');
}

// ---- consult's own files (Ruling 15) ----

// The folder that holds mcp/: consult's code, pi-fence.js included.
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// What a fenced worker must never write: the data home (tasks, their state.json,
// the index), the projects settings file, the sandbox-check file and consult's code.
export function consultProtectedPaths() {
  return [dataHome(), projectsFile(), checkFilePath(), PLUGIN_ROOT];
}

// How the paths below are compared: real paths (junctions resolved, a missing tail
// kept), case-insensitive, with no broad-folder exemption (unlike isInsideFolder).
function realOf(folderOrFile) {
  return realPathOfTarget(path.resolve(folderOrFile));
}

function isTaskCopy(realWorkFolder) {
  const copiesFolder = realOf(path.join(dataHome(), 'worktrees'));
  return isInside(realWorkFolder, copiesFolder) && !isInside(copiesFolder, realWorkFolder);
}

// The protected paths a fenced worker in `workFolder` could reach: those inside
// it (or equal to it), and the work folder itself when it sits inside one of them
// (a project inside consult's data or code). A task's copy, at
// <data>/worktrees/<id>, is consult's own place for work and is not counted.
// A path that cannot be resolved (a link loop) fails closed: the whole work folder is guarded.
export function fenceProtectedPaths(workFolder) {
  try {
    const realWorkFolder = realOf(workFolder);
    const copy = isTaskCopy(realWorkFolder);
    const reachable = [];
    for (const protectedPath of consultProtectedPaths()) {
      const realProtected = realOf(protectedPath);
      if (isInside(realProtected, realWorkFolder)) {
        reachable.push(protectedPath);
        continue;
      }
      if (!copy && isInside(realWorkFolder, realProtected) && !reachable.includes(workFolder)) reachable.push(workFolder);
    }
    return reachable;
  } catch (_) {
    return [workFolder];
  }
}

// True when a fenced worker in `workFolder` could rewrite consult's own files:
// pi then gets the guard only, and a fenced agy write task is refused.
export function holdsConsultFiles(workFolder) {
  return fenceProtectedPaths(workFolder).length > 0;
}

// The key a project is stored under: its absolute path, lower-cased on Windows
// (paths there ignore case).
export function projectKey(project) {
  const absolute = path.resolve(project);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function projectSettings(project) {
  let all = null;
  try { all = readJsonOrNull(projectsFile()); } catch (_) { /* unreadable: defaults */ }
  const saved = all?.[projectKey(project)] ?? {};
  const fence = {};
  for (const worker of Object.keys(FENCE_VALUES)) {
    fence[worker] = normalFence(worker, saved.fence?.[worker]);
  }
  return {
    workers_edit: WORKERS_EDIT_VALUES.includes(saved.workers_edit) ? saved.workers_edit : 'auto',
    git: GIT_ANSWERS.includes(saved.git) ? saved.git : 'ask',
    fence
  };
}

// Saves `changes` (workers_edit, git and/or fence) for the project and returns
// its settings. A null value puts that setting back to its default (auto, ask;
// for `fence`, a worker's null puts that worker back; others keep theirs). A
// file that is not valid JSON is left as it is and the save fails.
export function saveProjectSettings(project, changes) {
  const defaults = { workers_edit: 'auto', git: 'ask' };
  const resolved = {};
  for (const key of Object.keys(changes)) {
    if (key === 'fence') {
      const changedWorkers = {};
      for (const worker of Object.keys(changes.fence)) {
        if (!Object.hasOwn(FENCE_VALUES, worker)) throw new Error(`Unknown fence worker ${JSON.stringify(worker)}`);
        const fenceValue = changes.fence[worker] === null ? DEFAULT_FENCE[worker] : changes.fence[worker];
        requireOneOf(`fence for ${worker}`, fenceValue, FENCE_VALUES[worker]);
        changedWorkers[worker] = fenceValue;
      }
      resolved.fence = changedWorkers;
      continue;
    }
    const value = changes[key] === null ? defaults[key] : changes[key];
    if (key === 'workers_edit') requireOneOf('workers_edit', value, WORKERS_EDIT_VALUES);
    else if (key === 'git') requireOneOf('git', value, GIT_ANSWERS);
    else throw new Error(`Unknown project setting ${JSON.stringify(key)}`);
    resolved[key] = value;
  }
  let all;
  try {
    all = readJsonOrNull(projectsFile()) ?? {};
  } catch (error) {
    throw new Error(`${projectsFile()} is not valid JSON (${error.message}); fix or delete it`);
  }
  const key = projectKey(project);
  // Merge only what changed into the entry as it is on disk now, so a save never
  // brings back an older value of a setting it did not touch.
  const entry = all[key] !== null && typeof all[key] === 'object' && !Array.isArray(all[key]) ? { ...all[key] } : {};
  for (const setting of Object.keys(resolved)) {
    if (setting !== 'fence') {
      entry[setting] = resolved[setting];
      continue;
    }
    const rawFence = entry.fence !== null && typeof entry.fence === 'object' && !Array.isArray(entry.fence) ? { ...entry.fence } : {};
    for (const worker of Object.keys(resolved.fence)) rawFence[worker] = resolved.fence[worker];
    entry.fence = rawFence;
  }
  all[key] = entry;
  writeJsonAtomic(projectsFile(), all);
  return projectSettings(project);
}
