// Local admission for delegate tasks. The runner (llama-swap on this machine)
// holds one model at a time, so two local tasks for different models queue and
// never swap the model out from under each other. Also the guard that keeps
// consult's own one-shot local calls (ask_local, a council's local member)
// from swapping the model under a running task.
//
// Everything here reads the store and the runner. It writes task records only
// in the admission, under <data>/local.lock: the admitted task's state, and
// the `skipped_by` count of the older waiting tasks it goes ahead of; while a
// task waits, its own `queue_model` and `queue_waiting_long`.

import path from 'node:path';
import { loadSettings, runnerSettings } from './settings.js';
import { oneLine, sleepUnlessAborted } from './util.js';
import { getJson, runnerRoot, runnerKey, runnerInventory, prepareRunnerCall, loadedModels, sameUrl } from './local-runners.js';
import { vramMb } from './local-models.js';
import { factFor } from './delegate-workers.js';
import {
  dataHome, scanTasks, readTask, updateTask, updateTaskWhen, withLockFolder, isProcessAlive,
  SUPERVISOR_BEAT_FRESH_MS, RUNNING_BEAT_FRESH_MS
} from './delegate-store.js';

const PROBE_TIMEOUT_MS = 3000;
// An extra slot is used only if each task still gets about this much context.
const MIN_CONTEXT_PER_SLOT = 16384;
// Memory the context (KV cache) of a model takes, beyond its file size, when
// judging whether a second model fits next to the first.
const CONTEXT_ALLOWANCE_MB = 2048;
const LOCAL_LOCK_STALE_MS = 30000;
const QUEUE_WAITING_LONG_MS = 30 * 60 * 1000;
// A failure in a tick is tried again on the next; this many in a row is not transient.
const MAX_FAILED_TICKS = 40;
// A task for the loaded model may go ahead of at most this many older waiting
// tasks, and an older task is passed over at most this many times.
const MAX_OVERTAKEN = 2;
const MAX_PARSED_SLOTS = 64;

// ---- what the runner can hold ----

function unknownCapacity() {
  return { loaded: [], canHoldTwo: false, freeVramMb: null };
}

function positiveInteger(text) {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

// llama-swap does not report parallel slots; they are in the model's command
// line as `-np N` or `--parallel N`. No flag, or nonsense: 1.
function slotsFromCommand(command) {
  if (typeof command !== 'string') return 1;
  const found = /(?:^|\s)(?:-np|--parallel)(?:\s+|=)(\d+)(?=\s|$)/.exec(command);
  const slots = found === null ? null : positiveInteger(found[1]);
  return slots === null ? 1 : Math.min(slots, MAX_PARSED_SLOTS);
}

async function swapCapacity(root, key) {
  const running = await getJson(`${root}/running`, { key, timeoutMs: PROBE_TIMEOUT_MS });
  if (running.status !== 200 || !Array.isArray(running.json?.running)) return unknownCapacity();
  const loaded = [];
  for (const entry of running.json.running) {
    if (typeof entry?.model !== 'string' || entry.state === 'stopped' || entry.state === 'shutdown') continue;
    loaded.push({ model: entry.model, slots: slotsFromCommand(entry.cmd), busy: 0 });
  }
  // No groups are visible in /running or the config: a second model swaps the first out.
  return { loaded, canHoldTwo: false, freeVramMb: null };
}

async function llamaServerCapacity(root, key) {
  const [slots, props, models] = await Promise.all([
    getJson(`${root}/slots`, { key, timeoutMs: PROBE_TIMEOUT_MS }),
    getJson(`${root}/props`, { key, timeoutMs: PROBE_TIMEOUT_MS }),
    getJson(`${root}/v1/models`, { key, timeoutMs: PROBE_TIMEOUT_MS })
  ]);
  let totalSlots = null;
  let busy = 0;
  if (slots.status === 200 && Array.isArray(slots.json) && slots.json.length > 0) {
    totalSlots = slots.json.length;
    for (const slot of slots.json) {
      if (slot?.is_processing === true) busy++;
    }
  } else if (props.status === 200) {
    totalSlots = positiveInteger(props.json?.total_slots);
  }
  let model = null;
  const listed = models.json?.data?.[0]?.id;
  if (typeof listed === 'string') model = listed;
  else if (typeof props.json?.model_alias === 'string') model = props.json.model_alias;
  if (totalSlots === null || model === null) return unknownCapacity();
  return { loaded: [{ model, slots: totalSlots, busy }], canHoldTwo: false, freeVramMb: null };
}

// Ollama does not report its settings over HTTP; they are read from this
// process's environment, which is the server's only when it was started from
// the same one. Unknown: 1 slot, one model.
async function ollamaCapacity(root, settings) {
  const ps = await getJson(`${root}/api/ps`, { timeoutMs: PROBE_TIMEOUT_MS });
  if (ps.status !== 200 || !Array.isArray(ps.json?.models)) return unknownCapacity();
  const slots = positiveInteger(process.env.OLLAMA_NUM_PARALLEL) ?? 1;
  const maxLoaded = positiveInteger(process.env.OLLAMA_MAX_LOADED_MODELS) ?? 1;
  const loaded = [];
  let usedBytes = 0;
  for (const entry of ps.json.models) {
    if (typeof entry?.name !== 'string') continue;
    loaded.push({ model: entry.name, slots, busy: 0 });
    if (typeof entry.size_vram === 'number') usedBytes += entry.size_vram;
  }
  const totalMb = await vramMb(settings);
  const freeVramMb = typeof totalMb === 'number' ? Math.max(0, Math.round(totalMb - usedBytes / 1048576)) : null;
  return { loaded, canHoldTwo: maxLoaded >= 2 && freeVramMb !== null, freeVramMb };
}

async function lmstudioCapacity(runner, key) {
  const names = await loadedModels(runner, key, PROBE_TIMEOUT_MS);
  const loaded = [];
  for (const name of names ?? []) loaded.push({ model: name, slots: 1, busy: 0 });
  return { loaded, canHoldTwo: false, freeVramMb: null };
}

// What the runner holds now and whether it could hold a second model:
// `loaded` is [{ model, slots, busy }] (slots unknown = 1, busy 0 where the
// runner cannot say), `freeVramMb` null where it is not known. A runner that
// does not answer is "nothing known": nothing loaded, no room for two.
export async function runnerCapacity(runner, key, settings) {
  const root = runnerRoot(runner.url);
  const type = runner.type ?? 'ollama';
  if (type === 'llama-swap') return swapCapacity(root, key);
  if (type === 'llama-server') return llamaServerCapacity(root, key);
  if (type === 'ollama') return ollamaCapacity(root, settings);
  if (type === 'lmstudio') return lmstudioCapacity(runner, key);
  return unknownCapacity();
}

// The most local tasks that may run at once: a number the user set, or for
// `auto` the slots of what is loaded (plus one more model where the runner can
// hold two).
export function ceilingFor(setting, capacity) {
  if (typeof setting === 'number') return setting;
  let slots = 0;
  for (const entry of capacity.loaded) slots += entry.slots;
  if (capacity.canHoldTwo) slots += 1;
  return Math.max(1, slots);
}

// What `local_at_once: auto` comes to right now, as the queue would read it
// (the slots of what the runner holds; 1 where nothing is known). The tab shows it.
export async function autoLocalSlots(settings = loadSettings(), { capacityFor = runnerCapacity } = {}) {
  const runner = runnerSettings(settings);
  let key = null;
  try { key = (await runnerKey(runner)).api_key; } catch (_) { /* an unreadable key means nothing is known */ }
  return ceilingFor('auto', await capacityFor(runner, key, settings));
}

// ---- who holds the runner ----

// Ollama says `name:latest` for a bare name.
function sameModelName(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const bare = (name) => name.replace(/:latest$/, '');
  return bare(first) === bare(second);
}

// The model a running task has loaded: the one admission resolved, else what it asked for.
function heldModel(task) {
  return task.runner_model ?? task.model ?? null;
}

// A model by the id the runner reports it under: llama-swap takes an alias
// (`fast:nothink`) for the model it routes to, and /running names the id.
function canonicalName(inventory, name) {
  const fact = factFor(inventory, name);
  return fact?.id ?? fact?.name ?? name;
}

// A running local task on this runner whose supervisor is alive and has
// beaten lately. A supervisor killed hard leaves `running` behind, and Windows
// reuses its pid, so the pid alone would hold the runner forever. A task with
// no recorded address ran through an injected admission (a test): it is taken
// to be on the runner in use.
function holdsRunner(task, runner) {
  if (task.worker !== 'local' || task.state !== 'running') return false;
  if (typeof task.runner_url === 'string' && !sameUrl(task.runner_url, runner.url)) return false;
  if (typeof task.supervisor_beat_at !== 'number' || Date.now() - task.supervisor_beat_at >= RUNNING_BEAT_FRESH_MS) return false;
  return typeof task.supervisor_pid !== 'number' || isProcessAlive(task.supervisor_pid);
}

// Every local task, plus a stand-in `running` task for each record that could
// not be read and was written lately: it may be a running task, and the runner
// is held until it can be told. An old unreadable file is only a broken file.
function localTasksSnapshot() {
  const { tasks, unreadable } = scanTasks();
  const snapshot = [];
  for (const task of tasks) {
    if (task.worker === 'local') snapshot.push(task);
  }
  for (const record of unreadable) {
    if (Date.now() - record.modifiedAt >= RUNNING_BEAT_FRESH_MS) continue;
    snapshot.push({
      id: record.id, title: 'its record could not be read', worker: 'local', state: 'running',
      runner_model: 'an unknown model', supervisor_pid: null, supervisor_beat_at: Date.now(), created_at: record.modifiedAt
    });
  }
  return snapshot;
}

function tasksHolding(runner) {
  const holding = [];
  for (const task of localTasksSnapshot()) {
    if (holdsRunner(task, runner)) holding.push(task);
  }
  return holding;
}

// ---- the rules ----

function wait(reason) {
  return { ok: false, reason };
}

// Whether a task for `model` may start now. `running` is the local tasks
// holding the runner; `capacity` is runnerCapacity's answer; `fact` is the
// model's inventory entry (null when unknown); `ceiling` is the most tasks at once.
export function admit({ model, fact, capacity, running, ceiling }) {
  if (running.length >= ceiling) {
    return wait(`${running.length} local task${running.length === 1 ? ' is' : 's are'} running and the limit (local_at_once) is ${ceiling}`);
  }
  if (running.length === 0) return { ok: true };
  // A model that spills into system RAM is one task and nothing else.
  if (fact?.fits_gpu === false) {
    return wait(`${model} does not fit the GPU, so it runs alone; waiting for ${running.length} running task${running.length === 1 ? '' : 's'}`);
  }
  let onThisModel = 0;
  for (const task of running) {
    if (sameModelName(heldModel(task), model)) onThisModel++;
  }
  if (onThisModel > 0) {
    let slots = 1;
    let busy = 0;
    for (const entry of capacity.loaded) {
      if (sameModelName(entry.model, model)) {
        slots = entry.slots;
        busy = entry.busy;
      }
    }
    if (Math.max(busy, onThisModel) >= slots) return wait(`${model} has ${slots} slot${slots === 1 ? '' : 's'} and all are in use`);
    if (typeof fact?.context === 'number' && fact.context / slots < MIN_CONTEXT_PER_SLOT) {
      return wait(`${model} would give each of its ${slots} slots under ${MIN_CONTEXT_PER_SLOT} tokens of context`);
    }
    return { ok: true };
  }
  const inUse = [];
  for (const task of running) {
    const name = heldModel(task) ?? 'a model';
    if (!inUse.includes(name)) inUse.push(name);
  }
  if (!capacity.canHoldTwo) return wait(`${inUse.join(', ')} is loaded and the runner holds one model at a time; waiting for it to finish`);
  const neededMb = typeof fact?.size_bytes === 'number' ? fact.size_bytes / 1048576 + CONTEXT_ALLOWANCE_MB : null;
  if (neededMb === null || capacity.freeVramMb === null || capacity.freeVramMb < neededMb) {
    return wait(`${model} may not fit next to ${inUse.join(', ')} in the free GPU memory`);
  }
  return { ok: true };
}

// ---- the lock ----

// Runs `action` holding <data>/local.lock, so two admissions never decide on
// the same snapshot. A lock older than 30 s belongs to a holder that died.
export async function withLocalLock(action) {
  return withLockFolder(path.join(dataHome(), 'local.lock'), action, { staleMs: LOCAL_LOCK_STALE_MS });
}

// ---- consult's own one-shot calls ----

function busyError(blocking, advice) {
  return new Error(`local runner busy: task ${blocking.id} '${oneLine(blocking.title ?? '')}' is using ${heldModel(blocking) ?? "the runner's default model"}; ${advice}`);
}

// Throws when a running delegate task holds a different model on this runner
// and the runner would have to swap to answer. A call for the model the task
// holds passes (the runner queues it for a slot). `model` is the resolved
// model the call will ask for (an alias is the model it names, with the
// runner's `inventory`); `key` and `settings` are the runner's.
export async function guardOneShot({ runner, model, key = null, settings = null, inventory = null }) {
  const wanted = canonicalName(inventory, model);
  const different = [];
  for (const task of tasksHolding(runner)) {
    const held = heldModel(task);
    if (!sameModelName(held === null ? null : canonicalName(inventory, held), wanted)) different.push(task);
  }
  if (different.length === 0) return;
  const capacity = await runnerCapacity(runner, key, settings);
  if (capacity.canHoldTwo) return;
  throw busyError(different[0], 'ask for that model, wait, or cancel the task');
}

// Throws when a running delegate task holds a model on this runner: unloading
// it would pull the model out from under the task.
export function guardUnload({ runner }) {
  const holding = tasksHolding(runner);
  if (holding.length === 0) return;
  throw busyError(holding[0], 'wait, or cancel the task, before unloading it');
}

// ---- the queue ----

function resolveModel(task, runner, settings, inventory) {
  try {
    return canonicalName(inventory, prepareRunnerCall({ runner, requested: task.model, images: undefined, settings, inventory }).model);
  } catch (_) {
    return null; // the worker's start reports it
  }
}

function isWaiting(task, now) {
  return task.state === 'queued' && typeof task.supervisor_beat_at === 'number' && now - task.supervisor_beat_at < SUPERVISOR_BEAT_FRESH_MS;
}

// One look, under the lock: admits the task (state `running`, written before
// the lock is released) or says why it waits. Older waiting tasks go first;
// one whose model is already loaded may go ahead of a few that cannot start.
// The lock can be taken over while the runner is being asked (it is stale
// after 30 s); the writes below check that it is still this attempt's.
async function attempt({ task, runner, key, settings, inventory, model, signal, now, lock, capacityFor }) {
  const current = readTask(task.id);
  if (current === null || current.state !== 'queued') {
    throw Object.assign(new Error(`Delegate task ${task.id} is no longer queued.`), { code: 'ENOTQUEUED' });
  }
  const running = [];
  const waiting = [];
  for (const each of localTasksSnapshot()) {
    if (holdsRunner(each, runner)) running.push(each);
    else if (each.id === task.id || isWaiting(each, now)) waiting.push(each);
  }
  waiting.sort((first, second) => first.created_at - second.created_at || (first.id < second.id ? -1 : 1));
  const capacity = await capacityFor(runner, key, settings);
  const ceiling = ceilingFor(settings.delegate?.local_at_once ?? 'auto', capacity);
  const mine = admit({ model, fact: factFor(inventory, model), capacity, running, ceiling });

  const ahead = [];
  for (const each of waiting) {
    if (each.id === task.id) break;
    const eachModel = resolveModel(each, runner, settings, inventory);
    if (eachModel === null) continue; // about to fail at its start; not in the way
    if (admit({ model: eachModel, fact: factFor(inventory, eachModel), capacity, running, ceiling }).ok) {
      return { admitted: false, current }; // an older task can start now: it goes first
    }
    ahead.push(each);
  }
  let admitted = mine.ok;
  if (admitted && ahead.length > 0) {
    let modelIsLoaded = false;
    for (const entry of capacity.loaded) {
      if (sameModelName(entry.model, model)) modelIsLoaded = true;
    }
    for (const each of running) {
      if (sameModelName(heldModel(each), model)) modelIsLoaded = true;
    }
    let passedOverTooOften = false;
    for (const each of ahead) {
      if ((each.skipped_by ?? 0) >= MAX_OVERTAKEN) passedOverTooOften = true;
    }
    admitted = modelIsLoaded && ahead.length <= MAX_OVERTAKEN && !passedOverTooOften;
  }
  if (!admitted || signal.aborted) return { admitted: false, current };
  // Each write decides under the task's own lock whether this attempt still holds the local lock.
  // The rename inside each write checks the local lock too, so a lock lost during a refused rename does not ride out its retries.
  const stillHoldingLocalLock = { alsoOwned: lock.stillOwned };
  for (const each of ahead) updateTaskWhen(each.id, () => (lock.stillOwned() ? { skipped_by: (each.skipped_by ?? 0) + 1 } : null), stillHoldingLocalLock);
  const written = updateTaskWhen(task.id, (latest) => {
    if (!lock.stillOwned() || latest.state !== 'queued') return null;
    return { state: 'running', runner_url: runner.url, runner_model: model, queue_model: null, skipped_by: 0, supervisor_beat_at: now };
  }, stillHoldingLocalLock);
  return { admitted: written !== null, current };
}

// The admission the supervisor waits on for a local task: resolves when the
// task is admitted (its state is `running`), when the wait is aborted, or when
// its model cannot be resolved (the worker's start reports that). While it
// waits the task stays `queued`, shows the model it waits for, and after 30
// minutes is marked `queue_waiting_long`. A failure inside a tick (a refused
// file operation, a lock that stayed busy, a probe) is tried again on the
// next; only a task that is no longer queued, or MAX_FAILED_TICKS failures in
// a row, ends it with the error.
export async function admitLocalTask(task, { signal, pollMs = 1000, settings = loadSettings(), inventoryFor = runnerInventory, now = Date.now, capacityFor = runnerCapacity } = {}) {
  const runner = runnerSettings(settings);
  let key = null;
  try { key = (await runnerKey(runner)).api_key; } catch (_) { /* the worker's start reports a key that cannot be used */ }
  let inventory = null;
  let failedTicks = 0;
  while (!signal.aborted) {
    if (inventory === null) {
      try { inventory = await inventoryFor(runner, key, settings); } catch (_) { inventory = null; }
    }
    const model = resolveModel(task, runner, settings, inventory);
    if (model === null) return;
    let result = { admitted: false, current: null };
    try {
      result = await withLocalLock((lock) => attempt({ task, runner, key, settings, inventory, model, signal, now: now(), lock, capacityFor }));
      failedTicks = 0;
      if (result.admitted) return;
      const changes = {};
      if (result.current.queue_model !== model) changes.queue_model = model;
      // A follow-up requeues the task: it has waited since then, not since its creation.
      const waitingSince = Math.max(result.current.created_at, result.current.queued_at ?? 0);
      if (!result.current.queue_waiting_long && now() - waitingSince > QUEUE_WAITING_LONG_MS) changes.queue_waiting_long = true;
      // What the pane shows is not worth a failed tick; the next tick writes it again.
      if (Object.keys(changes).length > 0) {
        try { updateTask(task.id, changes); } catch (_) { /* tried again next tick */ }
      }
    } catch (error) {
      failedTicks++;
      if (error.code === 'ENOTQUEUED' || failedTicks >= MAX_FAILED_TICKS) throw error;
    }
    await sleepUnlessAborted(pollMs, signal);
  }
}
