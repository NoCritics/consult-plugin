// What the server does in the background for delegate: its heartbeat (the file
// whose mtime tells a supervisor that the Claude Code session is still there),
// the clean-up at start (worktree folders no task owns), and a sweep for tasks
// whose supervisor died without recording how they ended.
//
// A task is `queued` or `running` only while its supervisor lives. A supervisor
// killed hard (a crash, a reboot, a task manager) leaves the task in that state
// for ever, and its worker running. The sweep finds such tasks, kills the
// orphaned worker, takes the copy's end snapshot and records `stopped`
// (supervisor-died). A queued task that never got a supervisor is launched once
// more, then failed.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { scanTasks, indexRows, updateTaskWhen, isProcessAlive, isAlive, beat, projectKey, dataHome, ACTIVE_STATES, refreshIndex } from './delegate-store.js';
import { gitState, endSnapshot, pruneOrphans } from './delegate-git.js';
import { launchSupervisor, descendantScript, parsePids, orphanScript, parseProcessRows, runPowerShell } from './delegate-supervisor.js';

// A supervisor beats at least every 10 s; over this long without a beat, a pid
// that is alive may be someone else's (the pid was reused).
const SUPERVISOR_STALE_MS = 2 * 60 * 1000;
// A queued task with no supervisor this long was never launched.
const NEVER_LAUNCHED_MS = 2 * 60 * 1000;
// A copy task still without its copy this long was abandoned while it was being set up.
const COPY_SETUP_PATIENCE_MS = 10 * 60 * 1000;
// A recorded worker pid is the task's worker only if that process was created
// close to the run's start (the shell is created just before `started_at`).
const WORKER_STARTED_BEFORE_MS = 30000;
const WORKER_STARTED_AFTER_MS = 60000;
// What descends from such a worker was created after it, so the walk starts close to the run's start.
const DESCENDANT_STARTED_BEFORE_MS = 5000;
const BEAT_INTERVAL_MS = 10000;
const SWEEP_INTERVAL_MS = 60000;
const PROCESS_QUERY_TIMEOUT_MS = 20000;
// A heartbeat file untouched this long belongs to a server that is gone.
const STALE_HEARTBEAT_MS = 24 * 3600 * 1000;

// ---- old heartbeat files ----

// A server that is gone leaves its heartbeat file behind: one a day old is no
// one's. This server's own file is never removed. Returns the names removed.
export function sweepStaleHeartbeats({ ownInstanceId, now = Date.now(), folder = path.join(dataHome(), 'servers') }) {
  const removed = [];
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch (_) {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name === `${ownInstanceId}.json`) continue;
    try {
      const file = path.join(folder, name);
      if (now - fs.statSync(file).mtimeMs <= STALE_HEARTBEAT_MS) continue;
      fs.rmSync(file, { force: true });
      removed.push(name);
    } catch (_) { /* tried again at the next sweep */ }
  }
  return removed;
}

// ---- looking at processes ----

// stdout of a program, or null when it failed. Asynchronous: the server stays responsive.
function capture(program, args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(program, args, { encoding: 'utf8', windowsHide: true, timeout: PROCESS_QUERY_TIMEOUT_MS, env: { ...process.env, ...extraEnv } }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

function powershell(script, extraEnv = {}) {
  return runPowerShell(script, { timeoutMs: PROCESS_QUERY_TIMEOUT_MS, extraEnv });
}

// The command line of the process with this pid, or null when the system cannot say.
function commandLineOf(pid) {
  return process.platform === 'win32'
    ? powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`)
    : capture('ps', ['-p', String(Number(pid)), '-o', 'args=']);
}

// Whether the process with this pid is the supervisor of this task: `node
// delegate-run.js <task id>`. When the system cannot say, it counts as one: a
// task is not given up on a guess.
async function isSupervisorOf(task, lookup) {
  const commandLine = await lookup.commandLineOf(task.supervisor_pid);
  if (commandLine === null || commandLine.trim() === '') return true;
  return commandLine.includes('delegate-run.js') && commandLine.includes(task.id);
}

// The PowerShell that lists the pids among `rootPids` whose process was created
// around `startedAtMs`.
function rootsScript(rootPids, startedAtMs) {
  const wantedPids = rootPids.map((pid) => String(Number(pid))).join(',');
  return (
    `$from = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(startedAtMs - WORKER_STARTED_BEFORE_MS)}).LocalDateTime; ` +
    `$to = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(startedAtMs + WORKER_STARTED_AFTER_MS)}).LocalDateTime; ` +
    '$all = Get-CimInstance Win32_Process; ' +
    `foreach ($wanted in @(${wantedPids})) { foreach ($p in $all) { ` +
    'if ($p.ProcessId -eq $wanted -and $p.CreationDate -ge $from -and $p.CreationDate -le $to) { $p.ProcessId } } }'
  );
}

// Only this process, not its tree: the tree is found by Windows' own parent
// links, with no creation-time filter, and could include a reused pid's children.
async function killProcess(pid) {
  await capture('taskkill', ['/PID', String(pid), '/F']);
}

// Kills what a dead supervisor left running: the worker (the shell, and the real
// worker found under it) and everything that descends from them since the run
// started, each by pid from a list worked out here. On Windows a recorded pid is
// trusted only when that process was created around the run's start, so a pid
// reused by an unrelated process is left alone; on POSIX the worker leads its
// own process group.
async function killOrphanedWorker(task, now) {
  if (typeof task.started_at !== 'number') return;
  if (process.platform !== 'win32') {
    if (typeof task.worker_pid !== 'number') return;
    const elapsed = await capture('ps', ['-p', String(task.worker_pid), '-o', 'etimes=']);
    const processAgeSeconds = Number(elapsed);
    const runAgeSeconds = (now - task.started_at) / 1000;
    if (elapsed === null || !Number.isFinite(processAgeSeconds) || processAgeSeconds < runAgeSeconds - WORKER_STARTED_BEFORE_MS / 1000) return;
    try { process.kill(-task.worker_pid, 'SIGKILL'); } catch (_) { /* no group left */ }
    return;
  }
  const recordedRoots = [];
  for (const pid of [task.worker_pid, task.worker_real_pid]) {
    if (typeof pid === 'number' && !recordedRoots.includes(pid)) recordedRoots.push(pid);
  }
  if (recordedRoots.length > 0) await killRecordedTree(task, recordedRoots);
  // What the worker left running from the copy (a dev server started through a launcher), the
  // same cleanup the supervisor makes at an end. A task in place is not touched: its folder is the person's.
  if (task.location === 'copy' && task.worktree) await killCopyLeftovers(task, recordedRoots);
}

async function killRecordedTree(task, recordedRoots) {
  const roots = parsePids(await powershell(rootsScript(recordedRoots, task.started_at)) ?? '');
  if (roots.length === 0) return;
  const descendants = parsePids(await powershell(descendantScript(roots, task.started_at - DESCENDANT_STARTED_BEFORE_MS, false)) ?? '');
  const toKill = [...roots];
  for (const pid of descendants) {
    if (!toKill.includes(pid)) toKill.push(pid);
  }
  for (const pid of toKill) await killProcess(pid);
}

async function killCopyLeftovers(task, recordedRoots) {
  const output = await powershell(orphanScript(task.started_at - DESCENDANT_STARTED_BEFORE_MS, recordedRoots), { CONSULT_ORPHAN_FOLDER: task.worktree });
  if (output === null) return;
  for (const row of parseProcessRows(output)) await capture('taskkill', ['/PID', String(row.pid), '/T', '/F']);
}

// ---- the sweep ----

async function supervisorIsDead(task, now, lookup) {
  if (!isProcessAlive(task.supervisor_pid)) return true;
  const beatAt = typeof task.supervisor_beat_at === 'number' ? task.supervisor_beat_at : 0;
  if (now - beatAt <= SUPERVISOR_STALE_MS) return false;
  return !(await isSupervisorOf(task, lookup));
}

async function stopTaskOfDeadSupervisor(task, now, outcome, lookup) {
  await lookup.killWorker(task, now);
  let endCommit = null;
  if (task.location === 'copy' && task.worktree && fs.existsSync(task.worktree)) {
    try {
      endCommit = await endSnapshot(task.worktree, task.project, task.start_commit);
    } catch (_) { /* the copy is kept; the stop is recorded without an end snapshot */ }
  }
  const stopped = updateTaskWhen(task.id, (current) => {
    // Another server's sweep, or a new supervisor, got there first.
    if (!ACTIVE_STATES.includes(current.state) || current.supervisor_pid !== task.supervisor_pid) return null;
    const changes = {
      state: 'stopped', stop_reason: 'supervisor-died', ended_at: now,
      summary: 'Stopped: the supervisor process ended without recording how the task finished.'
    };
    if (endCommit !== null) changes.end_commit = endCommit;
    return changes;
  });
  if (stopped !== null) outcome.stopped.push(task.id);
}

async function handleQueuedWithoutSupervisor(task, now, launch, env, outcome) {
  const waitingSince = Math.max(task.created_at, task.queued_at ?? 0);
  const isUnlaunched = (current) => current.state === 'queued' && typeof current.supervisor_pid !== 'number';
  // A copy task whose copy is not made yet is still being set up (a big project takes a
  // while); a supervisor started now would find no copy. It is failed if it stays so.
  if (task.location === 'copy' && !task.worktree) {
    if (now - waitingSince <= COPY_SETUP_PATIENCE_MS) return;
    const failedSetup = updateTaskWhen(task.id, (current) => (
      isUnlaunched(current) && !current.worktree
        ? { state: 'failed', ended_at: now, summary: 'Failed: the copy of the project was never made.' }
        : null
    ));
    if (failedSetup !== null) outcome.failed.push(task.id);
    return;
  }
  if (now - waitingSince <= NEVER_LAUNCHED_MS) return;
  if (task.relaunched !== true) {
    const marked = updateTaskWhen(task.id, (current) => (isUnlaunched(current) ? { relaunched: true, queued_at: now } : null));
    if (marked === null) return;
    launch(task.id, { env });
    outcome.relaunched.push(task.id);
    return;
  }
  const failed = updateTaskWhen(task.id, (current) => (
    isUnlaunched(current)
      ? { state: 'failed', ended_at: now, summary: 'Failed: no supervisor ran this task, even after it was started again.' }
      : null
  ));
  if (failed !== null) outcome.failed.push(task.id);
}

// Finds the tasks whose supervisor is gone and settles them. Returns the ids of
// the tasks it { stopped, relaunched, failed }. One task's trouble never stops
// the others. A task that was never launched is the business of a session of its
// own project, so it is relaunched (or failed) only when it is in `project`.
// `io` replaces the process lookups (commandLineOf(pid), killWorker(task, now)) in tests.
export async function sweepDeadSupervisors({ now = Date.now(), launch = launchSupervisor, env = process.env, project = null, io = {} } = {}) {
  const outcome = { stopped: [], relaunched: [], failed: [] };
  const lookup = { commandLineOf, killWorker: killOrphanedWorker, ...io };
  for (const task of scanTasks().tasks) {
    if (!ACTIVE_STATES.includes(task.state)) continue;
    try {
      if (typeof task.supervisor_pid !== 'number') {
        if (task.state === 'queued' && project !== null && projectKey(task.project) === projectKey(project)) {
          await handleQueuedWithoutSupervisor(task, now, launch, env, outcome);
        }
      } else if (await supervisorIsDead(task, now, lookup)) {
        await stopTaskOfDeadSupervisor(task, now, outcome, lookup);
      }
    } catch (_) { /* tried again at the next sweep */ }
  }
  try {
    refreshIndex();
  } catch (_) { /* tried again at the next sweep */ }
  return outcome;
}

// A restarted server (a /mcp reconnect, a plugin reload, a crash Claude Code
// restarts) has a new instance id, and the tasks its session started still name
// the old one, whose heartbeat goes stale: their supervisors would stop them as
// "the session closed" while the session is open. The new server takes over
// this project's queued and running tasks of its own session whose owner has no
// live heartbeat. Returns the ids it adopted. Never throws.
export function adoptOwnTasks({ instanceId, sessionId, project, now = Date.now() }) {
  const adopted = [];
  if (!sessionId) return adopted;
  try {
    // The index rows only name candidates (a stale or missing row costs one
    // beat); updateTaskWhen re-reads each under its lock. No usable index: read every task.
    const candidates = indexRows() ?? scanTasks().tasks;
    for (const task of candidates) {
      if (!task || !ACTIVE_STATES.includes(task.state) || task.owner_session !== sessionId) continue;
      if (task.owner_instance === instanceId || projectKey(task.project) !== projectKey(project)) continue;
      if (task.owner_instance && isAlive(task.owner_instance, now)) continue;
      try {
        const changed = updateTaskWhen(task.id, (current) => (
          ACTIVE_STATES.includes(current.state) && current.owner_session === sessionId
            && current.owner_instance !== instanceId && !(current.owner_instance && isAlive(current.owner_instance, now))
            ? { owner_instance: instanceId }
            : null
        ));
        if (changed !== null) adopted.push(task.id);
      } catch (_) { /* tried again at the next beat */ }
    }
  } catch (_) { /* tried again at the next beat */ }
  return adopted;
}

// What the server does once when it starts. Never throws.
export async function sweepOnStart({ project, launch = launchSupervisor, env = process.env } = {}) {
  try {
    if ((await gitState(project)).isRepo) await pruneOrphans(project);
  } catch (_) { /* a failed clean-up is tried at the next start */ }
  try {
    await sweepDeadSupervisors({ launch, env, project });
  } catch (_) { /* tried again at the next sweep */ }
}

// The heartbeat (at once, then every `beatMs`), the start-up sweep, and the
// dead-supervisor sweep every `sweepMs`. The timers do not keep the process
// alive. `sweeps: false` keeps only the heartbeat (a test server that must not
// touch tasks it did not make). Returns { timers, stop() }.
export function startDelegateBackground({ instanceId, sessionId = null, project, launch = launchSupervisor, env = process.env, beatMs = BEAT_INTERVAL_MS, sweepMs = SWEEP_INTERVAL_MS, sweeps = true }) {
  const beatOnce = () => {
    try { beat(instanceId, sessionId); } catch (_) { /* the next beat tries again */ }
    // After the beat: the tasks it adopts name an owner that is now alive.
    adoptOwnTasks({ instanceId, sessionId, project });
  };
  beatOnce();
  const beatTimer = setInterval(beatOnce, beatMs);
  beatTimer.unref();
  if (!sweeps) {
    return { timers: [beatTimer], stop() { clearInterval(beatTimer); } };
  }
  let sweeping = false;
  const sweepOnce = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      sweepStaleHeartbeats({ ownInstanceId: instanceId });
      await sweepDeadSupervisors({ launch, env, project });
    } catch (_) { /* tried again at the next sweep */ } finally {
      sweeping = false;
    }
  };
  const sweepTimer = setInterval(sweepOnce, sweepMs);
  sweepTimer.unref();
  sweeping = true;
  sweepOnStart({ project, launch, env }).finally(() => { sweeping = false; });
  const timers = [beatTimer, sweepTimer];
  return {
    timers,
    stop() {
      for (const timer of timers) clearInterval(timer);
    }
  };
}
