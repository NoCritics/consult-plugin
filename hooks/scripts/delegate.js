#!/usr/bin/env node
// The Claude Code mod's Delegated tab: runs the delegate feature's own code
// (mcp/lib/delegate*.js) and prints one JSON object:
//   node delegate.js <project dir> show
//     -> {"rows":[...this project's tasks, newest first; each also carries elapsed_ms, folder,
//                  log_path, report_path, branch, copy_removed, merged_files and first_conflict],
//         "elsewhere":[{"project","finished","running"}],   other projects: counts only
//         "limits":{"codex":{"level","note",...},"agy":{...},"local":{...}},
//         "settings":{"workers_edit","table":{"code","research_review","private"},   (each codex, agy,
//                     local or ask; research_review is "mixed" when the two differ)
//                     "fence":{"codex","agy","local"}, "local_fence_check": "sandbox", "guard" or
//                     "unchecked" (what holds a fenced Local task: Codex's sandbox, consult's guard, or
//                     no cached check yet),
//                     "local_at_once","local_slots","on_close","time_limit_min"},
//                     local_slots: what auto comes to now, null when local_at_once is a number or
//                     the runner did not answer in 2.5 s
//         "git":{"isRepo","declined","setupAllowed"}}
//   node delegate.js <project dir> cancel <task id>
//   node delegate.js <project dir> clear <task id> ['{"discard":true}']
//     ->  {"cleared":"<id>","copy_removed":bool,"branch_deleted":bool}
//     Without discard, a done, held, conflict or paused-limit task is refused:
//     its work is unmerged. With "discard":true it goes anyway and that work is
//     GONE (its copy and branch are deleted), so the tab must ask the person to
//     confirm before it sends discard. A clear is refused for a moment ("a merge
//     is in progress") while a merge holds merge.lock; the tab may just offer it
//     again.
//   node delegate.js <project dir> stop-all             ->  {"stopped":["<id>",...],"failed":[]}
//   node delegate.js <project dir> save '{"workers_edit":"copy","table":{"research_review":"agy"},"on_close":"keep"}'
//     ->  {"settings":{...},"global_written":true|false}
//     (a null value puts a setting back to its default; "git":"declined" or null
//     is also taken: null asks about git again). global_written says whether the
//     global consult.local.md was written by this save. The tab sends
//     "keep_backup":true only after a save of this session that returned
//     global_written: true (that save made the .bak); even then it counts only
//     if a .bak exists.
// A refusal (an unknown command or task, a value a setting does not take, a
// task that cannot be cleared) prints {"error": "<message>"} and exits 0.
//
// Stopping is allowed for tasks of any project (the safe direction); clear
// acts only on tasks of <project dir>. Clearing removes the task's copy and its
// branch consult/<id> and nothing else: it never commits, stashes or resets.
// Project settings are saved in ~/.claude/consult-projects.json, the global
// delegate.* ones in ~/.claude/consult.local.md (the first save of a process
// keeps a .bak; keep_backup: true in the JSON leaves an earlier .bak alone, as
// setlocal.js does, but only when that .bak exists).
//
// The mod starts this in the plugin's own folder, so nothing planted in the
// project (a node.exe) is what runs. Like health.js and setlocal.js it is run
// with $.process.run, not $.mcp.call (the permission check would refuse or
// ask). Node built-ins and the server's lib only; no key is read or printed.

// Same DEP0190 filter as auth-check.js; the output read is stdout alone.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.code === 'DEP0190') return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, DELEGATE_WORKERS } from '../../mcp/lib/settings.js';
import { saveDelegateSettings, keepBackup } from '../../mcp/lib/local-runners.js';
import { gitState, setupAllowed, removeCopy, deleteTaskBranch, decideLocation } from '../../mcp/lib/delegate-git.js';
import {
  listTasks, readTask, indexRow, projectSettings, saveProjectSettings, MAX_INDEX_ROWS, isTaskId, dataHome, taskFolder, ACTIVE_STATES
} from '../../mcp/lib/delegate-store.js';
import {
  cancelTask, sameProject, needsAttention, limitsView, claimForClear, keepClaim, finishClear, releaseClear, clearPlan
} from '../../mcp/lib/delegate.js';
import { autoLocalSlots } from '../../mcp/lib/delegate-local.js';
import { readCodexVersion } from '../../mcp/lib/delegate-fence.js';
import { cachedPiLayer } from '../../mcp/lib/delegate-supervisor.js';

const TABLE_ROWS = {
  code: ['delegate.code'],
  research_review: ['delegate.research', 'delegate.review'],
  private: ['delegate.private']
};
const GLOBAL_SETTINGS = ['local_at_once', 'on_close', 'time_limit_min'];
const COMMANDS = 'show, cancel, clear, stop-all or save';
// The runner is asked how many tasks it can run at once for show's `local_slots`; it must not hold show up.
const LOCAL_SLOTS_LIMIT_MS = 2500;

function errorText(error) {
  return error?.message || String(error);
}

function requireTask(id) {
  if (typeof id !== 'string' || id === '') throw new Error('Say which task: it needs a task id.');
  const task = readTask(id);
  if (task === null) throw new Error(`No delegate task with id ${JSON.stringify(id)}.`);
  return task;
}

// ---- show ----

function elapsedMs(task, now) {
  if (typeof task.started_at !== 'number') return null;
  if (typeof task.ended_at === 'number') return Math.max(0, task.ended_at - task.started_at);
  return task.state === 'running' ? Math.max(0, now - task.started_at) : null;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function isFolder(folder) {
  try {
    return fs.statSync(folder).isDirectory();
  } catch (_) {
    return false;
  }
}

// The paths the tab links and opens. An unfenced worker can rewrite its own
// state.json, so none of these is read from it: they are built from the task
// id (checked against the store's format), the data folder and the project
// this script was asked about. Absent files are null.
function pathsOf(task, project) {
  if (!isTaskId(task.id)) return { folder: null, log_path: null, report_path: null };
  let folder = project;
  if (task.location === 'copy') {
    const copy = path.join(dataHome(), 'worktrees', task.id);
    if (isFolder(copy)) folder = copy;
  }
  const log = path.join(taskFolder(task.id), 'log.jsonl');
  const report = path.join(taskFolder(task.id), 'final.md');
  return { folder, log_path: isFile(log) ? log : null, report_path: isFile(report) ? report : null };
}

function rowOf(task, now, project) {
  const row = indexRow(task);
  row.elapsed_ms = elapsedMs(task, now);
  Object.assign(row, pathsOf(task, project));
  row.branch = task.branch ?? null;
  row.copy_removed = task.copy_removed === true;
  // What the server allows for Clear, so the tab's buttons follow it.
  row.clear_kind = clearPlan(task);
  // What the tab's state label says of a merge: the files applied, the first left in conflict.
  const merge = task.merge_result;
  row.merged_files = Array.isArray(merge?.applied) ? merge.applied.length : null;
  row.first_conflict = Array.isArray(merge?.conflicts) && merge.conflicts.length > 0 ? String(merge.conflicts[0]) : null;
  return row;
}

// Counts only, by project: tasks still going, and ended ones that want action.
function countsElsewhere(tasks, project) {
  const counts = [];
  for (const task of tasks) {
    if (sameProject(task.project, project)) continue;
    let entry = null;
    for (const existing of counts) {
      if (sameProject(existing.project, task.project)) entry = existing;
    }
    if (entry === null) {
      entry = { project: task.project, finished: 0, running: 0 };
      counts.push(entry);
    }
    if (ACTIVE_STATES.includes(task.state)) entry.running++;
    else if (needsAttention(task)) entry.finished++;
  }
  const shown = [];
  for (const entry of counts) {
    if (entry.finished > 0 || entry.running > 0) shown.push(entry);
  }
  return shown;
}

// What holds a fenced Local task, for the tab's note: 'sandbox' (Codex's sandbox: Codex and
// pi's launcher are there and the cached check of this Codex passed), 'guard' (consult's guard
// alone: the supervisor's own pre-checks rule the sandbox out, or the cached check failed) or
// 'unchecked' (no cached check for this Codex yet). It is the start reply's cachedPiLayer, so Codex
// is found the supervisor's way (findCodexForFence, which the test suites turn off) and never probed.
// Write tasks are what the note is about (pi read tasks have no tool that writes): when the project's
// write tasks run in a copy, the checks on the work folder itself are left out, as a copy never fails them.
// Codex's version comes from the sync readCodexVersion (5 s), only when the cache cannot answer without it.
async function localFenceCheck(project, git) {
  const saved = projectSettings(project);
  const layer = await cachedPiLayer({ readCodexVersion }, project, [], {
    skipFolderChecks: decideLocation({ mode: 'write', projectSetting: saved.workers_edit, git, gitSetting: saved.git }).location === 'copy'
  });
  return layer.kind ?? 'unchecked';
}

// The delegate settings are global-only, so the project's own settings file
// has nothing to add and nothing needs to run inside the project.
function settingsView(project) {
  const delegate = loadSettings().delegate;
  const { research, review } = delegate.table;
  const shownProject = projectSettings(project);
  const view = {
    workers_edit: shownProject.workers_edit,
    table: { code: delegate.table.code, research_review: research === review ? research : 'mixed', private: delegate.table.private },
    fence: shownProject.fence,
    local_at_once: delegate.local_at_once,
    on_close: delegate.on_close,
    time_limit_min: delegate.time_limit_ms / 60000
  };
  return view;
}

// What `local_at_once: auto` comes to now, for the tab's "auto (n)"; null when the
// setting is a number, or the runner does not answer in time (it is only shown).
async function localSlotsFor(settings) {
  if (settings.local_at_once !== 'auto') return null;
  let timer = null;
  try {
    const giveUp = new Promise((resolve) => { timer = setTimeout(() => resolve(null), LOCAL_SLOTS_LIMIT_MS); });
    return await Promise.race([autoLocalSlots(), giveUp]);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function gitView(project, state) {
  // Setting git up is offered only for a folder that is not a repository.
  return { isRepo: state.isRepo, declined: projectSettings(project).git === 'declined', setupAllowed: state.isRepo ? false : setupAllowed(project) };
}

async function show(project) {
  const now = Date.now();
  const tasks = listTasks();
  const rows = [];
  for (const task of tasks) {
    if (rows.length >= MAX_INDEX_ROWS) break;
    if (sameProject(task.project, project)) rows.push(rowOf(task, now, project));
  }
  const settings = settingsView(project);
  const [localSlots, state] = await Promise.all([localSlotsFor(settings), gitState(project)]);
  settings.local_slots = localSlots;
  // Only the tab's show needs local_fence_check (a save's reply is not drawn from; the tab shows again after it).
  settings.local_fence_check = await localFenceCheck(project, state);
  const git = gitView(project, state);
  return {
    rows,
    elsewhere: countsElsewhere(tasks, project),
    limits: limitsView(DELEGATE_WORKERS, now),
    settings,
    git
  };
}

// ---- cancel, stop-all ----

function stopAll() {
  const stopped = [];
  const failed = [];
  for (const task of listTasks()) {
    if (!ACTIVE_STATES.includes(task.state)) continue;
    try {
      cancelTask(task);
      stopped.push(task.id);
    } catch (error) {
      // Ended since the list was read: nothing to stop.
      const current = readTask(task.id);
      if (current !== null && ACTIVE_STATES.includes(current.state)) failed.push({ id: task.id, error: errorText(error) });
    }
  }
  return { stopped, failed };
}

// ---- clear ----

function discardFrom(text) {
  if (text === undefined) return false;
  return objectFrom(text, 'the options').discard === true;
}

// The task is claimed first (marked clearing under its lock, which refuses a
// task that may not go); only then are its copy and branch deleted, so a
// follow-up cannot revive a task whose copy is being removed.
async function clear(project, id, optionsText) {
  const discard = discardFrom(optionsText);
  const task = await claimForClear(id, project, discard);
  const token = task.clearing_token;
  let branchDeleted = false;
  let note = '';
  // Whatever goes wrong from here on, the mark comes off the task that stays
  // (releaseClear touches only this claim's mark). The mark is renewed between
  // the slow steps; a clear that lost its claim stops and deletes nothing more.
  try {
    if (task.worktree) note = await removeCopy(task.project, task, { keepBranch: true });
    keepClaim(id, token);
    if (task.branch) branchDeleted = await deleteTaskBranch(task.project, task.id);
    keepClaim(id, token);
    if (!finishClear(id, token, discard)) throw new Error(`Task ${id} was not removed: it changed while it was being cleared.`);
  } catch (error) {
    if (readTask(id) === null) throw error;
    try {
      releaseClear(id, token);
    } catch (releaseError) {
      throw new Error(`${errorText(error)} (and the clearing mark could not be taken off the task: ${errorText(releaseError)})`);
    }
    throw error;
  }
  const result = { cleared: id, copy_removed: Boolean(task.worktree), branch_deleted: branchDeleted };
  if (note !== '') result.note = `${note} A stale worktree registration may remain.`;
  return result;
}

// ---- save ----

function objectFrom(text, what) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error(`${what} is not JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${what} must be a JSON object`);
  return parsed;
}

// The change as { project: {...}, global: {...} }: the project's keys for
// consult-projects.json and the `delegate.*` lines for the global file.
function splitChange(change) {
  const split = { project: {}, global: {} };
  for (const [key, value] of Object.entries(change)) {
    if (key === 'workers_edit' || key === 'git' || key === 'fence') {
      split.project[key] = value;
    } else if (GLOBAL_SETTINGS.includes(key)) {
      split.global[`delegate.${key}`] = value;
    } else if (key === 'table') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('`table` must be an object of rows');
      for (const [row, worker] of Object.entries(value)) {
        if (!(row in TABLE_ROWS)) throw new Error(`Unknown table row \`${row}\` (${Object.keys(TABLE_ROWS).join(', ')}).`);
        for (const settingKey of TABLE_ROWS[row]) split.global[settingKey] = worker;
      }
    } else {
      throw new Error(`Unknown setting \`${key}\` (workers_edit, git, fence, table, ${GLOBAL_SETTINGS.join(', ')}).`);
    }
  }
  return split;
}

function save(project, text) {
  const change = objectFrom(text, 'the change');
  const keepEarlierBackup = change.keep_backup === true;
  delete change.keep_backup;
  const split = splitChange(change);
  const home = os.homedir();
  const hasGlobalChange = Object.keys(split.global).length > 0;
  // Everything is checked before anything is written, so a refused value
  // never leaves half of a save behind.
  if (hasGlobalChange) saveDelegateSettings({ changes: split.global, home, preview: true });
  if (Object.keys(split.project).length > 0) saveProjectSettings(project, split.project);
  if (hasGlobalChange) {
    // Only when there is a .bak to keep: a first save that wrote no global file made none.
    const earlierBackup = path.join(home, '.claude', 'consult.local.md.bak');
    if (keepEarlierBackup && fs.existsSync(earlierBackup)) keepBackup();
    saveDelegateSettings({ changes: split.global, home });
  }
  return { settings: settingsView(project), global_written: hasGlobalChange };
}

// ---- main ----

async function answer(project, command, argument, options) {
  if (command === 'show') return show(project);
  if (command === 'cancel') return cancelTask(requireTask(argument));
  if (command === 'clear') return clear(project, argument, options);
  if (command === 'stop-all') return stopAll();
  if (command === 'save') return save(project, argument);
  throw new Error(`unknown command \`${command}\` (${COMMANDS})`);
}

async function main() {
  const [projectArgument, command, argument, options] = process.argv.slice(2);
  let result;
  try {
    if (!projectArgument) throw new Error(`usage: delegate.js <project dir> <command> (${COMMANDS})`);
    result = await answer(path.resolve(projectArgument), command, argument, options);
  } catch (error) {
    result = { error: errorText(error) };
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().then(
  () => { process.exitCode = 0; },
  (error) => {
    process.stderr.write(`delegate.js: ${errorText(error)}\n`);
    process.exitCode = 1;
  }
);
