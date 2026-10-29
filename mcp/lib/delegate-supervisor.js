// The delegate supervisor: one detached node process per task. It runs the
// worker, logs its output, enforces the time limit, the no-output watchdog,
// cancel and stop-when-Claude-Code-closes, kills the worker's whole process
// tree, and records how the task ended. `node delegate-run.js <task-id>` is
// the entry; launchSupervisor starts it.
//
// <data>/tasks/<id>/log.jsonl       the worker's stdout lines
//                   stderr.log      the worker's stderr
//                   final.md        the worker's last message
//                   cancel          a file that appears: stop the task
//                   supervisor-error.txt  only when even the failure could not be recorded
//
// The state comes from parsing what the worker printed, not only from its exit
// code: pi exits 0 on failure and agy reports SUCCESS when it was refused.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureCmd, SPAWN_OPTS, spawnableCmd } from './resolve-cmd.js';
import { shellSafeArgs, killTree, killPidTree } from './spawn-cli.js';
import { scrubPii, oneLine } from './util.js';
import { loadSettings, runnerSettings } from './settings.js';
import { readKey, runnerInventory } from './local-runners.js';
import { workerCommand, parseWorkerStream, noteStepEvent, codexRolloutLimits, deniedNames } from './delegate-workers.js';
import { gitState, endSnapshot, changedFiles, watchFolder, diffWatch } from './delegate-git.js';
import { recordLimit, recordLimitHit, hitKindOf } from './delegate-limits.js';
import { readTask, updateTask, updateTaskWhen, taskFolder, isAlive, isSessionAlive, isProcessAlive, isSupervisorLive, unmergedBase } from './delegate-store.js';

const RUN_SCRIPT_PATH = fileURLToPath(new URL('../delegate-run.js', import.meta.url));

const WATCHDOG_MS = 10 * 60 * 1000;
const POLL_MS = 1000;
const DEFAULT_TIME_LIMIT_MS = 3 * 60 * 60 * 1000;
const MIN_WATCHDOG_MS = 100;
const MIN_POLL_MS = 20;
const OUTPUT_WRITE_INTERVAL_MS = 10000;
const STDERR_KEEP_CHARS = 256 * 1024;
const RETAINED_LINES_MAX_CHARS = 32 * 1024 * 1024;
const LINE_MAX_CHARS = 8 * 1024 * 1024;
const SESSION_SCAN_LINES = 50;
const EXIT_GRACE_MS = 3000;
const KILL_GIVE_UP_MS = 10000;
const REAL_WORKER_SCAN_DELAY_MS = 2000;
const CLAIM_WAIT_MS = 3000;
// A supervisor waiting in the admission queue, or starting a local task,
// beats every PRE_RUN_BEAT_INTERVAL_MS, so a lock wait or a sleep of a few
// seconds does not make it look dead to a second launch or to the queue.
const PRE_RUN_BEAT_INTERVAL_MS = 5000;
const CLAIM_RETRY_MS = 100;
// The server's heartbeat counts as stale after this long (delegate-store.js); the
// same period of grace follows a resume from sleep.
const HEARTBEAT_STALE_MS = 45000;
const RESUME_SLACK_MS = 5000;
const SUCCESS_SUMMARY_MAX_CHARS = 120;
const FAILURE_SUMMARY_MAX_CHARS = 300;
const STDERR_SUMMARY_CHARS = 300;
// Files a read task changed: how many the record keeps, and how many the warning names.
const READ_ONLY_EDITS_KEPT = 50;
const READ_ONLY_EDITS_NAMED = 10;
const SURVIVORS_NAMED = 5;

// The command-line tool behind each worker, for the "not installed" check.
const CLI_NAMES = { codex: 'codex', agy: 'agy', local: 'pi' };

// ---- launching ----

// Starts `node delegate-run.js <id>` detached from the caller, so it outlives
// the server that started it, and records its pid. `env` is the supervisor's
// environment. Its cwd is the task folder, so no project settings file is read.
export function launchSupervisor(taskId, { env = process.env } = {}) {
  if (readTask(taskId) === null) throw new Error(`No delegate task with id ${JSON.stringify(taskId)}`);
  const child = spawn(process.execPath, [RUN_SCRIPT_PATH, taskId], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: taskFolder(taskId), env
  });
  child.on('error', () => {});
  child.unref();
  if (child.pid === undefined) throw new Error('The supervisor process could not be started.');
  // Another supervisor already running this task keeps its pid in the record;
  // the one just started will see that and step aside.
  updateTaskWhen(taskId, (current) => (
    isSupervisorLive(current, child.pid) ? null : { supervisor_pid: child.pid, supervisor_beat_at: Date.now() }
  ));
  return child.pid;
}

// ---- small helpers ----

function describeDuration(milliseconds) {
  if (milliseconds < 60000) return `${Math.round(milliseconds / 1000)} s`;
  if (milliseconds < 3600000) return `${Math.round(milliseconds / 60000)} min`;
  return `${Math.round(milliseconds / 360000) / 10} h`;
}

// The test overrides are read from the supervisor's own environment (or its
// options); nothing in the task record can change them.
function timingValue(option, environmentName, fallback, minimum) {
  if (typeof option === 'number' && option >= minimum) return option;
  const fromEnvironment = Number(process.env[environmentName]);
  if (process.env[environmentName] !== undefined && Number.isFinite(fromEnvironment) && fromEnvironment >= minimum) return fromEnvironment;
  return fallback;
}

// The first line of a worker's final message that says something, without its
// bullet marks, cut to the summary length. A heading (`# Title`, or a whole
// line in bold) is not prose: it is the summary only when nothing else is there.
export function summaryLine(message) {
  let heading = null;
  for (const rawLine of message.split(/\r?\n/)) {
    // A thematic break (`---`, `***`, `___`, `* * *`) is tested before any mark is stripped.
    if (/^[-=_*\s]{3,}$/.test(rawLine)) continue;
    const isHeading = /^\s*#{1,6}\s/.test(rawLine) || /^\s*\*\*[^*]+\*\*\s*:?\s*$/.test(rawLine);
    const line = rawLine.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|>\s*)*/, '').replace(/\*\*|__|`/g, '').trim();
    if (line === '' || /^summary:?$/i.test(line)) continue;
    if (isHeading) {
      if (heading === null) heading = line;
      continue;
    }
    return oneLine(line, SUCCESS_SUMMARY_MAX_CHARS);
  }
  return heading === null ? null : oneLine(heading, SUCCESS_SUMMARY_MAX_CHARS);
}

// Last resort when the task record cannot be written.
export function writeSupervisorError(taskId, error) {
  try {
    const folder = taskFolder(taskId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'supervisor-error.txt'), `${new Date().toISOString()} ${String(error?.stack ?? error)}\n`);
  } catch (_) { /* nothing more can be done */ }
}

// ---- stopping ----

// Why the worker must stop now, or null: a cancel file, the owning session
// gone (unless the task is to keep running), the time limit, or no output for
// the watchdog period (not while a command or tool step it started is unfinished: a
// long build prints nothing). The last two only count once the worker has started.
function pendingStop(context, now = context.now()) {
  if (context.signalStop !== null) return context.signalStop;
  try {
    if (fs.existsSync(path.join(context.folder, 'cancel'))) {
      return { state: 'cancelled', stopReason: null, summary: 'Cancelled.' };
    }
    const live = readTask(context.taskId);
    const heartbeatCounts = now >= context.sessionCheckResumesAt;
    // The owner server's beat is stale and no other server of the same session is beating: a
    // restarted server (a /mcp reconnect) is the session still being there, and adopts the task.
    if (heartbeatCounts && live !== null && live.owner_instance && !live.keep_running && !isAlive(live.owner_instance, now) && !(live.owner_session && isSessionAlive(live.owner_session, now))) {
      return { state: 'stopped', stopReason: 'session-closed', summary: 'Stopped: the Claude Code session that started it closed.' };
    }
  } catch (_) {
    return null; // a read that failed this tick is tried again on the next
  }
  if (context.startedAt === null) return null;
  if (now - context.startedAt > context.timeLimitMs) {
    return { state: 'stopped', stopReason: 'time-limit', summary: `Stopped: the time limit of ${describeDuration(context.timeLimitMs)} was reached.` };
  }
  if (context.openSteps.size === 0 && now - context.lastOutputAt > context.watchdogMs) {
    return { state: 'stopped', stopReason: 'watchdog', summary: `Stopped: no output for ${describeDuration(context.watchdogMs)}.` };
  }
  return null;
}

// Called on every poll. A gap between polls much longer than the poll interval
// means the machine slept (or the process was frozen): the worker was frozen
// too, so its silence is not the watchdog's business, and the server's
// heartbeat is stale only because its process slept as well. The in-memory
// last-output time restarts, and the heartbeat is not held against the task
// for one stale period while the server catches up. The time limit stays wall-clock.
function noteTick(context, now) {
  const gap = now - context.lastTickAt;
  context.lastTickAt = now;
  if (gap <= 3 * context.pollMs + RESUME_SLACK_MS) return;
  if (context.startedAt !== null) context.lastOutputAt = now;
  context.sessionCheckResumesAt = now + HEARTBEAT_STALE_MS;
}

// ---- descendants that outlive their worker ----
//
// A worker that exits can leave descendants behind that hold its pipes open (a
// dev server, say). On POSIX they stay in the worker's process group. On
// Windows the recorded worker_pid is the shell's (cmd.exe), and by the time the
// worker exits the shell and the worker are both gone, so walking down from
// worker_pid finds nothing. Two one-shot reads of the process table cover it:
// one early in the run finds the real worker under the shell; one at the end
// walks the parent links down from both pids (a child keeps its parent's pid
// after the parent has died), keeping only processes created since the spawn.

const POWERSHELL_TIMEOUT_MS = 20000;

// Runs a PowerShell script (extraEnv is added to our environment) and answers its stdout,
// or null when it failed or timed out. Asynchronous: the supervisor stays responsive.
export function runPowerShell(script, { timeoutMs, extraEnv = {} }) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: { ...process.env, ...extraEnv } }, (error, output) => {
      resolve(error ? null : output);
    });
  });
}

// The same, synchronously; throws when the script failed or timed out.
function runPowerShellSync(script, { timeoutMs, extraEnv = {} }) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: { ...process.env, ...extraEnv } });
}

// The PowerShell that lists "pid" for the children of `rootPids` created since
// `startedAtMs` (and, unless `directOnly`, their children, and so on). A
// console host is not a worker.
export function descendantScript(rootPids, startedAtMs, directOnly) {
  const enqueueRoots = rootPids.map((pid) => `$queue.Enqueue([uint32]${Number(pid)});`).join(' ');
  return (
    `$start = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(startedAtMs)}).LocalDateTime; ` +
    '$all = Get-CimInstance Win32_Process; $queue = New-Object System.Collections.Queue; $seen = @{}; ' +
    `${enqueueRoots} ` +
    'while ($queue.Count -gt 0) { $parent = $queue.Dequeue(); foreach ($p in $all) { ' +
    "if ($p.ParentProcessId -eq $parent -and $p.ProcessId -ne $PID -and $p.Name -ne 'conhost.exe' -and $p.CreationDate -ge $start -and -not $seen.ContainsKey([int]$p.ProcessId)) { " +
    `$seen[[int]$p.ProcessId] = 1; $p.ProcessId; ${directOnly ? '' : '$queue.Enqueue($p.ProcessId)'} } } }`
  );
}

export function parsePids(output) {
  const pids = [];
  for (const row of output.split(/\r?\n/)) {
    if (/^\d+$/.test(row.trim())) pids.push(Number(row.trim()));
  }
  return pids;
}

// Win32: finds the real worker under the shell, once, in the background, and records it.
function findRealWorker(context, shellPid) {
  const script = descendantScript([shellPid], context.spawnedAtWall, true);
  runPowerShell(script, { timeoutMs: POWERSHELL_TIMEOUT_MS }).then((output) => {
    if (output === null) return;
    const [realPid] = parsePids(output);
    if (realPid === undefined) return;
    context.workerRealPid = realPid;
    try { context.io.updateTask(context.taskId, { worker_real_pid: realPid }); } catch (_) { /* the pid is kept in memory */ }
  });
}

// Where the end-of-run walk starts: the shell, and the real worker found under
// it. The worker has exited by then, so a process alive under its pid now is a
// recycled pid that belongs to someone else: walking down from it could kill
// that process's children.
export function leftoverRoots(shellPid, workerRealPid) {
  const roots = [shellPid];
  if (workerRealPid !== null && !isProcessAlive(workerRealPid)) roots.push(workerRealPid);
  return roots;
}

// The PowerShell that lists "pid name" for what a run left behind. A process
// created since `startedAtMs` whose command line names `folder` (as a whole
// path, not as the start of a longer name) is traced up through its live
// parents that were also created since. If the chain ends at a parent that is
// gone (or whose pid was reused by a younger process, or is one of
// `workerTreePids`, the worker's own shell and process) before it reaches a
// process that is older than the run, the topmost process of the chain is
// listed: a dev server started with Start-Process, through a launcher such as
// npm or cmd that is still alive, hangs from a parent that exited, and no walk
// down from the worker reaches it. A chain that reaches an older process (the
// supervisor, explorer, an editor started before the run) is not listed: it is
// the person's. A process that does not name the folder (a launcher that was
// given a relative path) is found only through one that does.
// The folder comes in CONSULT_ORPHAN_FOLDER, never in the script's text: PowerShell
// ends a quoted string at ' and at the curly quotes too. Pids and times are numbers.
export function orphanScript(startedAtMs, workerTreePids = []) {
  const treePids = [];
  for (const pid of workerTreePids) {
    if (Number.isInteger(pid) && pid > 0) treePids.push(pid);
  }
  return (
    `$start = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(startedAtMs)}).LocalDateTime; ` +
    `$tree = @(${treePids.join(',')}); ` +
    '$folder = $env:CONSULT_ORPHAN_FOLDER; ' +
    String.raw`$pattern = '(?i)' + [regex]::Escape($folder) + '(?=$|[/"''\s\\])'; ` +
    '$all = Get-CimInstance Win32_Process; $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }; ' +
    '$tops = @{}; ' +
    // Windows' own shell hosts (explorer restarted mid-run is newer than the
    // task) are the person's: a chain that reaches one is left alone.
    "$hosts = @('explorer.exe', 'sihost.exe', 'svchost.exe', 'userinit.exe', 'winlogon.exe', 'runtimebroker.exe', 'dllhost.exe'); " +
    "foreach ($p in $all) { if ($p.ProcessId -eq $PID -or $p.Name -eq 'conhost.exe' -or $p.CreationDate -lt $start -or $p.CommandLine -notmatch $pattern) { continue }; " +
    '$current = $p; $top = $null; ' +
    'for ($step = 0; $step -lt 64; $step++) { ' +
    'if ($hosts -contains $current.Name.ToLower()) { $top = $null; break }; ' +
    '$parent = $byId[[int]$current.ParentProcessId]; ' +
    'if ($null -ne $parent -and $hosts -contains $parent.Name.ToLower()) { break }; ' +
    'if ($null -eq $parent -or $parent.CreationDate -gt $current.CreationDate -or $tree -contains [int]$current.ParentProcessId) { $top = $current; break }; ' +
    'if ($parent.CreationDate -lt $start) { break }; ' +
    '$current = $parent }; ' +
    'if ($null -ne $top) { $tops[[int]$top.ProcessId] = $top.Name } }; ' +
    'foreach ($id in $tops.Keys) { "$id $($tops[$id])" }'
  );
}

export function parseProcessRows(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+)\s+(\S.*)$/.exec(line.trim());
    if (match !== null) rows.push({ pid: Number(match[1]), name: match[2] });
  }
  return rows;
}

// Win32, at every end of a run. A task in a copy: what is left running from the
// copy's folder is the task's, and is killed. A task in place: the project's own
// folder is also where the person's dev server runs, so nothing is killed; what
// looks like the task's is reported as a warning for delegate_result.
function handleOrphans(context, task, folder, shellPid) {
  if (process.platform !== 'win32' || context.spawnedAtWall === null) return;
  let rows;
  try {
    rows = parseProcessRows(runPowerShellSync(orphanScript(context.spawnedAtWall, [shellPid, context.workerRealPid]), { timeoutMs: POWERSHELL_TIMEOUT_MS, extraEnv: { CONSULT_ORPHAN_FOLDER: folder } }));
  } catch (_) {
    return; // could not look; the task's record is still written
  }
  if (rows.length === 0) return;
  if (task.location === 'copy') {
    for (const row of rows) {
      try {
        killPidTree(row.pid);
      } catch (_) { /* already gone */ }
    }
    return;
  }
  const named = rows.slice(0, SURVIVORS_NAMED).map((row) => `${row.name} (pid ${row.pid})`).join(', ');
  const more = rows.length - SURVIVORS_NAMED;
  context.survivorWarning = `${rows.length === 1 ? '1 process' : `${rows.length} processes`} that started during this task and run from the project folder may still be running: ${named}${more > 0 ? `, and ${more} more` : ''}. ` +
    "consult did not stop them, since the project folder is also where your own programs run; stop them yourself if they are the worker's.";
}

function killLeftovers(context, shellPid) {
  if (shellPid === undefined) return;
  if (process.platform !== 'win32') {
    try { process.kill(-shellPid, 'SIGKILL'); } catch (_) { /* no group left */ }
    return;
  }
  const roots = leftoverRoots(shellPid, context.workerRealPid);
  try {
    const output = runPowerShellSync(descendantScript(roots, context.spawnedAtWall, false), { timeoutMs: POWERSHELL_TIMEOUT_MS });
    for (const pid of parsePids(output)) {
      try {
        killPidTree(pid);
      } catch (_) { /* already gone */ }
    }
  } catch (_) { /* could not look; the task's record is still written */ }
}

// ---- recording the end ----

// Where a copy's worker runs: the copy of the project folder, which is the
// copy's root plus the project's path inside its repository.
export async function copyWorkFolder(task) {
  if (!task.worktree) throw new Error('This task works in a copy, but no copy was made for it.');
  const state = await gitState(task.project);
  if (state.root === null) return task.worktree;
  const inside = path.relative(fs.realpathSync.native(state.root), fs.realpathSync.native(task.project));
  if (inside.startsWith('..') || path.isAbsolute(inside)) return task.worktree;
  return path.join(task.worktree, inside);
}

// A run that ended with no summary and only refused commands (agy, exit 0) is neither done nor
// failed until its copy has been looked at, which is here: when the copy changed, the work is real
// and reviewable (done, or held), else it failed. In-place tasks cannot tell their changes apart.
// Answers { state } and, when set, summary and warning (done) or problem (text for the summary).
async function settleUnfinished(context, current, outcome, endCommit) {
  if (current.mode !== 'write' || typeof endCommit !== 'string') return { state: 'failed' };
  try {
    if ((await changedFiles(current.project, unmergedBase(current), endCommit)).length === 0) return { state: 'failed' };
  } catch (error) {
    return { state: 'failed', problem: ` (changes not checked: ${oneLine(context.redact(error.message), 120)})` };
  }
  return {
    state: current.hold ? 'held' : 'done',
    summary: 'agy made changes in the copy but gave no summary.',
    warning: `agy couldn't run ${deniedNames(outcome.denied).join(', ')} and gave no summary; its changes are in the copy — review them before merging.`
  };
}

// Writes the task's final record. Never throws: when even that write fails,
// supervisor-error.txt in the task folder is all that is left.
async function recordEnd(context, outcome) {
  if (context.ended) return;
  context.ended = true;
  stopPreRunBeat(context);
  try {
    const current = readTask(context.taskId) ?? context.task;
    let summary = outcome.summary;
    const changes = { state: outcome.state, stop_reason: outcome.stopReason ?? null, ended_at: context.now() };
    const addWarning = (text) => {
      const existing = changes.warning ?? current.warning;
      changes.warning = typeof existing === 'string' && existing !== '' ? `${existing} ${text}` : text;
    };
    if (context.lastOutputAt !== null && context.startedAt !== null) changes.last_output_at = context.lastOutputAt;
    if (outcome.session) changes.worker_session = outcome.session;
    if (outcome.limit !== undefined) changes.limit = outcome.limit;
    if (outcome.limitHit) changes.limit_hit = outcome.limitHit;
    if (context.killAbandoned) summary += ` The worker (pid ${context.workerPid}) may still be running.`;
    if (outcome.denied && outcome.denied.length > 0) changes.denied = outcome.denied;
    if (outcome.finalMessage) {
      try {
        const finalPath = path.join(context.folder, 'final.md');
        fs.writeFileSync(finalPath, context.redact(outcome.finalMessage));
        changes.final_path = finalPath;
      } catch (error) {
        summary += ` (final.md not written: ${oneLine(error.message, 80)})`;
      }
    }
    if (current.location === 'copy' && current.worktree && fs.existsSync(current.worktree)) {
      try {
        changes.end_commit = await endSnapshot(current.worktree, current.project, current.start_commit);
      } catch (error) {
        summary += ` (snapshot failed: ${oneLine(context.redact(error.message), 120)})`;
      }
    }
    if (outcome.state === 'unfinished') {
      const settled = await settleUnfinished(context, current, outcome, changes.end_commit);
      changes.state = settled.state;
      if (settled.summary !== undefined) summary = settled.summary;
      if (settled.warning !== undefined) addWarning(settled.warning);
      if (settled.problem !== undefined) summary += settled.problem;
    }
    if (context.recordingProblem !== null) summary += ` (log problem: ${oneLine(context.recordingProblem, 80)})`;
    if (context.readOnlyEdits.length > 0) {
      const files = context.readOnlyEdits.slice(0, READ_ONLY_EDITS_KEPT);
      changes.read_only_edits = files;
      const shown = files.slice(0, READ_ONLY_EDITS_NAMED).join(', ');
      const more = context.readOnlyEdits.length - READ_ONLY_EDITS_NAMED;
      const warning = `agy changed ${context.readOnlyEdits.length === 1 ? '1 file' : `${context.readOnlyEdits.length} files`} in this read-only task: ${shown}${more > 0 ? `, and ${more} more` : ''}. ` +
        'Check them before relying on the result; the folder was in use meanwhile, so some may be your own edits.';
      addWarning(warning);
    }
    if (context.survivorWarning !== null) {
      addWarning(context.survivorWarning);
    }
    changes.summary = context.redact(summary);
    context.io.updateTask(context.taskId, changes);
    recordLearnedLimits(context, outcome);
  } catch (error) {
    writeSupervisorError(context.taskId, error);
  }
}

// What the run taught about the plan's limits goes to limits.json (Task 9):
// codex's windows, and any worker's hit. Each write is its own attempt, and
// none can change the task, which is already written.
function recordLearnedLimits(context, outcome) {
  const worker = context.task.worker;
  const now = context.now();
  if (worker === 'codex' && outcome.limit) {
    try { context.io.recordLimit(worker, outcome.limit, now); } catch (_) { /* the limits are a convenience */ }
  }
  // A run a limit paused folds its hit into `limit` (kind and resets_at, in ms);
  // a run that finished keeps the rollout's hit as limitHit.
  let hit = outcome.limitHit ?? null;
  if (hit === null && outcome.state === 'paused-limit' && outcome.limit) {
    hit = { kind: outcome.limit.kind, resets_at: outcome.limit.resets_at ?? null };
  }
  if (hit !== null) {
    try { context.io.recordLimitHit(worker, hit, now); } catch (_) { /* the limits are a convenience */ }
  }
}

// What a worker that ran to its end left: the state, from the parse first and
// the exit code second.
function outcomeOfRun(context, exit, parsed, rolloutLimits) {
  const task = context.task;
  let limitHit = parsed.limitHit;
  if (rolloutLimits.limitHit !== null) {
    limitHit = limitHit === null ? rolloutLimits.limitHit : { ...limitHit, resets_at: limitHit.resets_at ?? rolloutLimits.limitHit.resets_at };
  }
  const windows = rolloutLimits.limit ?? parsed.limit ?? null;
  const finishedCleanly = exit.code === 0 && parsed.complete && parsed.error === null;
  // A hit the stream reported always pauses the task. One found only in the
  // rollout pauses it only when the run did not finish cleanly: a run that
  // finished and merely used up a window is done (its hit is kept as limit_hit).
  if (limitHit !== null && (parsed.limitHit !== null || !finishedCleanly)) {
    const limit = { ...(windows ?? {}), kind: limitHit.kind, resets_at: limitHit.resets_at };
    const what = hitKindOf(limitHit.kind).pausedPhrase;
    const resets = typeof limitHit.resets_at === 'number' ? ` (resets ${new Date(limitHit.resets_at).toISOString()})` : '';
    return {
      session: parsed.session, limit, denied: parsed.denied, finalMessage: parsed.finalMessage,
      state: 'paused-limit', summary: `Paused: ${task.worker} ${what}${resets}.`
    };
  }
  const base = { session: parsed.session, limit: windows, denied: parsed.denied, finalMessage: parsed.finalMessage, limitHit: rolloutLimits.limitHit };
  if (parsed.error !== null) {
    // An agy run that exited 0 with no summary, only refused commands: recordEnd settles it once the copy is looked at.
    const onlyRefused = parsed.refusedOnly === true && exit.code === 0 && parsed.finalMessage === null;
    return { ...base, state: onlyRefused ? 'unfinished' : 'failed', summary: oneLine(parsed.error, FAILURE_SUMMARY_MAX_CHARS) };
  }
  if (exit.code === 0 && parsed.complete) {
    const line = parsed.finalMessage === null ? null : summaryLine(parsed.finalMessage);
    return { ...base, state: task.hold ? 'held' : 'done', summary: line ?? 'Finished with no final message.' };
  }
  if (exit.code === 0) {
    return { ...base, state: 'failed', summary: "Failed: the worker's output ended early." };
  }
  const stderrTail = oneLine(scrubPii(context.redact(context.stderrTail))).slice(-STDERR_SUMMARY_CHARS);
  const reason = stderrTail === '' ? `the worker exited with code ${exit.code ?? 'unknown'}` : stderrTail;
  return { ...base, state: 'failed', summary: `Failed: ${reason}` };
}

// ---- running a worker ----

// The child's environment: ours, then the worker command's own, and the pi
// key under the variable name the command names. The key goes nowhere else.
function childEnvironment(command, key) {
  const environment = { ...process.env, ...command.env };
  const keyName = command.env.CONSULT_PI_KEY_ENV;
  if (typeof keyName === 'string' && environment[keyName] === undefined && key !== null) environment[keyName] = key;
  return environment;
}

// Spawns the worker as spawn-cli.js does. CONSULT_DELEGATE_TEST_BIN (the
// supervisor's own environment only) swaps the worker's binary for a script
// run by node, or for any other program.
function spawnWorker(task, command, environment) {
  const testBin = process.env.CONSULT_DELEGATE_TEST_BIN;
  let program;
  let args;
  if (testBin) {
    const isScript = /\.[cm]?js$/i.test(testBin);
    program = isScript ? process.execPath : testBin;
    args = isScript ? [testBin, ...command.args] : command.args;
  } else {
    program = ensureCmd(CLI_NAMES[task.worker]);
    args = command.args;
  }
  return spawn(spawnableCmd(program), shellSafeArgs(args), {
    ...SPAWN_OPTS,
    cwd: command.cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  });
}

// Runs the worker to its end (or its stop) and returns how it ended.
async function runWorker(context, command, childEnvironmentValues) {
  const task = context.task;
  const logPath = path.join(context.folder, 'log.jsonl');
  const stderrLogPath = path.join(context.folder, 'stderr.log');
  const io = context.io;
  // A side effect (the log, a store write) that fails is noted and never costs the parse its data.
  const attempt = (sideEffect) => {
    try {
      sideEffect();
    } catch (error) {
      context.recordingProblem ??= error.message;
    }
  };
  attempt(() => io.appendFile(logPath, ''));
  // Everything before this (a claim, an admission, a runner lookup) may have
  // taken long; it was not a sleep, so the first poll must not read it as one.
  context.lastTickAt = context.now();
  const child = spawnWorker(task, command, childEnvironmentValues);
  context.child = child;
  context.workerPid = child.pid;
  context.spawnedAtWall = Date.now();
  context.startedAt = context.now();
  context.lastOutputAt = context.startedAt;
  // The run's own fields start clean: nothing an earlier run (a follow-up has
  // one) recorded about its outcome carries over. worker_session stays: it is
  // what a follow-up resumes.
  io.updateTask(task.id, {
    state: 'running', started_at: context.startedAt, ended_at: null, stop_reason: null, supervisor_pid: process.pid,
    supervisor_beat_at: context.startedAt, worker_pid: child.pid, worker_real_pid: null, log_path: logPath, fenced: command.fenced,
    followup: null, summary: null, final_path: null, end_commit: null, limit: null, limit_hit: null, denied: null,
    warning: command.warning ?? null, read_only_edits: null,
    ...(task.model === null && command.model ? { model: command.model } : {})
  });
  stopPreRunBeat(context); // that write carried the beat; the ticker below keeps it

  let spawnError = null;
  let exitInfo = null;
  let finishExit = null;
  let lingering = false;
  const exited = new Promise((resolve) => { finishExit = resolve; });
  let graceTimer = null;
  const settleExit = () => {
    clearTimeout(graceTimer);
    finishExit(exitInfo ?? { code: null, signal: null });
  };
  child.on('error', (error) => { spawnError = error; settleExit(); });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    // A descendant can hold the pipes open after the worker is gone.
    graceTimer = setTimeout(() => { lingering = true; settleExit(); }, EXIT_GRACE_MS);
  });
  child.on('close', (code, signal) => {
    exitInfo ??= { code, signal };
    settleExit();
  });

  const retainedLines = [];
  let retainedChars = 0;
  let linesSeen = 0;
  let sessionRecorded = false;
  let partialLine = '';
  let lastStoreWriteAt = 0;

  // A handler must never throw: it would take the supervisor down with the worker running.
  const guarded = (handler) => (...handlerArguments) => attempt(() => handler(...handlerArguments));
  // The bookkeeping that the parse and the watchdog depend on comes first, in
  // memory; each write to disk after it is on its own.
  // One store write carries the last output and the supervisor's beat, at most
  // every OUTPUT_WRITE_INTERVAL_MS, whether it is a tick or an output that asks.
  const writeBeat = () => {
    const now = context.now();
    if (now - lastStoreWriteAt < OUTPUT_WRITE_INTERVAL_MS) return;
    lastStoreWriteAt = now;
    attempt(() => io.updateTask(task.id, { last_output_at: context.lastOutputAt, supervisor_beat_at: now }));
  };
  // `logged` collects the redacted lines to append to the log, which the caller writes once.
  const takeLine = (line, logged) => {
    if (line === '') return;
    retainedLines.push(line);
    retainedChars += line.length;
    // The newest lines are the ones the parse needs, so the oldest go first.
    while (retainedChars > RETAINED_LINES_MAX_CHARS && retainedLines.length > 1) retainedChars -= retainedLines.shift().length;
    linesSeen++;
    attempt(() => noteStepEvent(task.worker, line, context.openSteps));
    attempt(() => { logged.push(`${context.redact(line)}\n`); });
    if (!sessionRecorded && linesSeen <= SESSION_SCAN_LINES) {
      attempt(() => {
        const session = parseWorkerStream(task.worker, [line]).session;
        if (session === null) return;
        io.updateTask(task.id, { worker_session: session });
        sessionRecorded = true;
      });
    }
  };

  // One append to the log for all the lines of a chunk.
  const takeLines = (lines) => {
    const logged = [];
    for (const line of lines) takeLine(line, logged);
    if (logged.length > 0) attempt(() => io.appendFile(logPath, logged.join('')));
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', guarded((text) => {
    context.lastOutputAt = context.now();
    partialLine += text;
    const completeLines = [];
    let newlineAt = partialLine.indexOf('\n');
    while (newlineAt !== -1) {
      completeLines.push(partialLine.slice(0, newlineAt).replace(/\r$/, ''));
      partialLine = partialLine.slice(newlineAt + 1);
      newlineAt = partialLine.indexOf('\n');
    }
    if (partialLine.length > LINE_MAX_CHARS) {
      completeLines.push(partialLine);
      partialLine = '';
    }
    context.sawOutput = true;
    takeLines(completeLines);
    writeBeat();
  }));
  child.stderr.on('data', guarded((text) => {
    context.stderrTail = (context.stderrTail + text).slice(-STDERR_KEEP_CHARS);
    attempt(() => io.appendFile(stderrLogPath, context.redact(text)));
  }));

  child.stdin.on('error', () => {}); // an early exit makes the write fail; the exit is handled
  if (command.stdinText !== null) {
    try { child.stdin.write(command.stdinText); } catch (_) { /* as above */ }
  }
  try { child.stdin.end(); } catch (_) { /* as above */ }

  // Every way of stopping the worker (the poll, a signal) comes through here:
  // once the worker has exited its outcome stands, and a stop decided now would replace it.
  context.requestStop = (stop) => {
    if (exitInfo !== null || context.stop !== null) return false;
    context.stop = { ...stop, at: Date.now() };
    io.killTree(child, { group: true });
    return true;
  };
  const ticker = setInterval(guarded(() => {
    noteTick(context, context.now());
    if (exitInfo !== null) return;
    writeBeat();
    // On Windows the shell's pid is the recorded one; find the worker under it
    // once, soon after the start, so the end can walk down from it.
    if (process.platform === 'win32' && !context.realWorkerSearched && (context.sawOutput || Date.now() - context.spawnedAtWall >= REAL_WORKER_SCAN_DELAY_MS)) {
      context.realWorkerSearched = true;
      findRealWorker(context, child.pid);
    }
    if (context.stop === null) {
      const stop = pendingStop(context);
      if (stop !== null) context.requestStop(stop);
      return;
    }
    if (Date.now() - context.stop.at > context.killGiveUpMs) {
      context.killAbandoned = true;
      settleExit(); // the kill did not take; record the stop anyway
    } else {
      io.killTree(child, { group: true });
    }
  }), context.pollMs);
  const exit = await exited;
  clearInterval(ticker);
  context.requestStop = null;
  // On Windows the walk runs at every end, not only when a descendant holds the pipes; on POSIX the group kill is for that case.
  if (lingering || process.platform === 'win32') killLeftovers(context, child.pid);
  // Whatever the exit was (a finish, a cancel, a limit, a close), a descendant can have outlived it.
  handleOrphans(context, task, task.location === 'copy' ? task.worktree : command.cwd, child.pid);

  if (partialLine !== '') takeLines([partialLine]);
  return { exit, spawnError, lines: retainedLines };
}

// ---- the beat before the worker runs ----

// A task that waits (a local one for the runner), looks the runner up, makes
// its copy's folder and builds its command must keep showing a live
// supervisor: the queue frees the runner under a running task whose beat has
// gone stale. This beats every PRE_RUN_BEAT_INTERVAL_MS from the claim until
// the worker's own ticker takes over.
function startPreRunBeat(context) {
  let lastBeatAt = context.now();
  context.preRunBeat = setInterval(() => {
    const now = context.now();
    if (now - lastBeatAt < PRE_RUN_BEAT_INTERVAL_MS) return;
    lastBeatAt = now;
    try { context.io.updateTask(context.taskId, { supervisor_beat_at: now }); } catch (_) { /* the next tick tries again */ }
  }, context.pollMs);
}

function stopPreRunBeat(context) {
  clearInterval(context.preRunBeat);
  context.preRunBeat = null;
}

// ---- the main entry ----

// Supervises one task from `queued` to its end. `admit(task, { signal, pollMs,
// settings, inventoryFor, now })` is the local-model admission
// (delegate-local.js): awaited before a local worker starts, and it marks the
// task `running` when it lets it through; the signal aborts when the task is
// cancelled or stopped while it waits. The
// other options are for tests: `settings`, `inventoryFor(runner, key,
// settings)`, `watchdogMs`, `pollMs`, `killGiveUpMs`, a clock `now`, and `io`
// (replacements for `updateTask`, `appendFile`, `killTree` and `rolloutLimits`
// that inject faults). A task with a `followup` resumes the worker's session
// with that text. Never throws.
export async function runSupervisor(taskId, options = {}) {
  const context = {
    taskId, task: null, folder: taskFolder(taskId), child: null, ended: false, stop: null, signalStop: null,
    startedAt: null, lastOutputAt: null, openSteps: new Set(), stderrTail: '', recordingProblem: null, secrets: [],
    workerPid: null, workerRealPid: null, spawnedAtWall: null, killAbandoned: false, requestStop: null,
    sawOutput: false, realWorkerSearched: false, preRunBeat: null, readOnlyEdits: [], survivorWarning: null,
    timeLimitMs: DEFAULT_TIME_LIMIT_MS,
    now: options.now ?? Date.now,
    io: { updateTask, appendFile: fs.appendFileSync, killTree, rolloutLimits: codexRolloutLimits, recordLimit, recordLimitHit, ...options.io },
    watchdogMs: timingValue(options.watchdogMs, 'CONSULT_DELEGATE_WATCHDOG_MS', WATCHDOG_MS, MIN_WATCHDOG_MS),
    pollMs: timingValue(options.pollMs, 'CONSULT_DELEGATE_POLL_MS', POLL_MS, MIN_POLL_MS),
    killGiveUpMs: options.killGiveUpMs ?? KILL_GIVE_UP_MS,
    lastTickAt: 0,
    sessionCheckResumesAt: 0,
    redact: (text) => {
      let redacted = text;
      for (const secret of context.secrets) redacted = redacted.replaceAll(secret, '[key]');
      return redacted;
    }
  };
  context.lastTickAt = context.now();
  const killWorkerOnExit = () => { if (context.child !== null) killTree(context.child, { group: true }); };
  // A signal to the supervisor stops the task, as a cancel would, with a reason of its own.
  // A second one gives up waiting; the exit hook still kills the worker.
  let signalsSeen = 0;
  const signalHandlers = {};
  for (const signalName of ['SIGTERM', 'SIGINT', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) {
    signalHandlers[signalName] = () => {
      signalsSeen++;
      if (signalsSeen > 1) process.exit(1);
      context.signalStop = { state: 'stopped', stopReason: 'supervisor-stopped', summary: `Stopped: the supervisor received ${signalName}.` };
      if (context.requestStop !== null) context.requestStop(context.signalStop);
    };
    process.on(signalName, signalHandlers[signalName]);
  }
  process.on('exit', killWorkerOnExit);
  try {
    await superviseTask(context, options);
  } catch (error) {
    if (context.child !== null) killTree(context.child, { group: true });
    // Without a task record there is nothing to put a failure into.
    if (context.task === null) {
      writeSupervisorError(taskId, error);
      return;
    }
    const message = oneLine(scrubPii(context.redact(error?.message ?? String(error))), FAILURE_SUMMARY_MAX_CHARS);
    // A stop already decided keeps its state; the error is added to what it says.
    if (context.stop !== null) {
      await recordEnd(context, { state: context.stop.state, stopReason: context.stop.stopReason, summary: `${context.stop.summary} (then an error: ${message})` });
    } else {
      await recordEnd(context, { state: 'failed', summary: `Failed: ${message}` });
    }
  } finally {
    stopPreRunBeat(context);
    killWorkerOnExit(); // does nothing once the worker has exited; else no path leaves it running
    process.off('exit', killWorkerOnExit);
    for (const [signalName, handler] of Object.entries(signalHandlers)) process.off(signalName, handler);
  }
}

// For the entry's last-chance handler: whatever a crash left behind in the
// record becomes `failed` with the message, when the task has not ended.
export function recordSupervisorCrash(taskId, error) {
  try {
    const task = readTask(taskId);
    if (task !== null && (task.state === 'queued' || task.state === 'running')) {
      updateTask(taskId, {
        state: 'failed', ended_at: Date.now(),
        summary: `Failed: the supervisor crashed: ${oneLine(scrubPii(String(error?.message ?? error)), FAILURE_SUMMARY_MAX_CHARS)}`
      });
    }
  } catch (_) { /* the error file below is what is left */ }
  writeSupervisorError(taskId, error);
}

async function superviseTask(context, options) {
  if (readTask(context.taskId) === null) throw new Error(`No delegate task with id ${JSON.stringify(context.taskId)}`);
  // Claim the task: only a queued task starts, and only one supervisor at a
  // time. Another supervisor that is still alive gets a moment to finish (a
  // follow-up can be launched just as the last run's supervisor exits).
  let task = null;
  const giveUpClaimAt = Date.now() + CLAIM_WAIT_MS;
  while (task === null) {
    let blockedByLiveSupervisor = false;
    task = updateTaskWhen(context.taskId, (current) => {
      if (current.state !== 'queued') return null;
      if (isSupervisorLive(current, process.pid)) {
        blockedByLiveSupervisor = true;
        return null;
      }
      return { supervisor_pid: process.pid, supervisor_beat_at: Date.now() };
    });
    if (task !== null || !blockedByLiveSupervisor || Date.now() >= giveUpClaimAt) break;
    await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_MS));
  }
  if (task === null) return;
  context.task = task;
  // Whatever comes before the worker's first write (an admission, a runner
  // lookup, the copy's folder) must show a live supervisor; recordEnd and the
  // worker's first write stop it.
  startPreRunBeat(context);

  const settings = options.settings ?? loadSettings();
  context.timeLimitMs = task.time_limit_ms ?? settings.delegate?.time_limit_ms ?? DEFAULT_TIME_LIMIT_MS;

  // A cancel that came before anything started ends the task here.
  const early = pendingStop(context);
  if (early !== null) {
    await recordEnd(context, early);
    return;
  }

  // Local tasks wait for the runner to have room; the task stays queued.
  if (task.worker === 'local') {
    const aborter = new AbortController();
    let stoppedWhileWaiting = null;
    const waitTicker = setInterval(() => {
      noteTick(context, context.now());
      stoppedWhileWaiting = pendingStop(context);
      if (stoppedWhileWaiting !== null) aborter.abort();
    }, context.pollMs);
    const stopSignal = new Promise((resolve) => aborter.signal.addEventListener('abort', resolve));
    const admission = Promise.resolve().then(() => (options.admit ?? (async () => {}))(task, {
      signal: aborter.signal, pollMs: context.pollMs, settings, inventoryFor: options.inventoryFor, now: context.now
    }));
    admission.catch(() => {}); // a rejection after a stop is of no interest
    try {
      await Promise.race([admission, stopSignal]);
    } finally {
      clearInterval(waitTicker);
    }
    if (stoppedWhileWaiting !== null) {
      await recordEnd(context, stoppedWhileWaiting);
      return;
    }
    context.lastTickAt = context.now(); // a long wait for admission is not a sleep
  }

  let runner = null;
  let inventory = null;
  let key = null;
  if (task.worker === 'local') {
    runner = runnerSettings(settings);
    if (runner.key_env) {
      key = (await readKey(runner.key_env)).key;
      if (key !== null) context.secrets.push(key);
    }
    try {
      inventory = await (options.inventoryFor ?? runnerInventory)(runner, key, settings);
    } catch (_) {
      inventory = null; // the runner's own answer says what is wrong
    }
  }

  const workFolder = task.location === 'copy' ? await copyWorkFolder(task) : null;
  if (workFolder !== null) fs.mkdirSync(workFolder, { recursive: true });
  // A follow-up continues the worker's session with its text.
  const isFollowUp = typeof task.followup === 'string' && task.followup !== '';
  const command = workerCommand(workFolder === null ? task : { ...task, worktree: workFolder }, {
    settings, runner, inventory, resume: isFollowUp, followUp: isFollowUp ? task.followup : null
  });
  if (command.briefFile !== null) {
    fs.mkdirSync(path.dirname(command.briefFile.path), { recursive: true });
    fs.writeFileSync(command.briefFile.path, command.briefFile.text);
  }

  // A worker that cannot be started (the tool is missing, an argument cannot be
  // passed safely) throws here, and ends in the catch of runSupervisor.
  // agy cannot be fenced: a read task is checked for files it changed anyway.
  const checksReadOnly = task.worker === 'agy' && task.mode === 'read';
  const folderBefore = checksReadOnly ? await watchFolder(command.cwd) : null;
  const run = await runWorker(context, command, childEnvironment(command, key));
  if (checksReadOnly) context.readOnlyEdits = diffWatch(folderBefore, await watchFolder(command.cwd)) ?? [];

  const parsed = parseWorkerStream(task.worker, run.lines, { stderr: context.stderrTail });
  let rolloutLimits = { limit: null, limitHit: null };
  if (task.worker === 'codex' && parsed.session !== null) {
    rolloutLimits = context.io.rolloutLimits(parsed.session, { codexHome: options.codexHome });
  }
  if (context.stop !== null) {
    await recordEnd(context, {
      state: context.stop.state, stopReason: context.stop.stopReason, summary: context.stop.summary,
      session: parsed.session, limit: rolloutLimits.limit ?? undefined, denied: parsed.denied, finalMessage: parsed.finalMessage
    });
    return;
  }
  if (run.spawnError !== null) {
    await recordEnd(context, { state: 'failed', summary: `Failed: could not start the worker: ${oneLine(scrubPii(run.spawnError.message), 200)}` });
    return;
  }
  await recordEnd(context, outcomeOfRun(context, run.exit, parsed, rolloutLimits));
}
