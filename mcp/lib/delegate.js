// The delegate tools Claude calls: hand a background task to Codex, agy or a
// local model, watch it, read its result, merge its copy, follow it up, cancel
// it. Everything underneath (the task store, routing, git copies and merge,
// worker command lines, the supervisor, local admission, usage limits) lives in
// the other delegate-*.js modules; this file wires them into tools.
//
// callDelegateTool(name, args, context) answers with an MCP tool result. A
// refusal or a bad argument is a tool error result (isError), never a throw.
// `context` is what the server knows about the call:
//   settings    loadSettings()'s result
//   project     the session's project folder
//   sessionId   Claude Code's session id, or null
//   instanceId  this server's id (its heartbeat file)
// and, for tests: launch(taskId, { env }), supervisorEnv, makeCopy, startWaitMs
// (how long a local start waits to be admitted), pollMs (delegate_wait's poll),
// signal.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { scrubPii, validateReasoningEffort, callSignal, oneLine, sleepUnlessAborted } from './util.js';
import { validateAgyEffort } from './agy.js';
import { localConfigured, DELEGATE_WORKERS } from './settings.js';
import { NICKNAME_SPELLINGS } from './local-models.js';
import { WORKER_ALIASES, parseWorkerWord, workerForKind } from './delegate-route.js';
import { WORKER_FENCED, requireModelId } from './delegate-workers.js';
import { lastLimits, limitPolicy } from './delegate-limits.js';
import { isOutside, gitState, decideLocation, setupAllowed, setupGit, makeCopy, uncommittedCount, removeCopy, changedFiles, diffStat, mergeCopy } from './delegate-git.js';
import {
  dataHome, taskFolder, createTask, readTask, updateTask, updateTaskWhen, scanTasks, listTasks, indexRow,
  projectKey, projectSettings, saveProjectSettings, withLockFolder, removeTaskWhen, unmergedBase, isSupervisorLive, ACTIVE_STATES
} from './delegate-store.js';
import { launchSupervisor, copyWorkFolder } from './delegate-supervisor.js';

// ---- the words ----

const ROUTING_WHEN =
  "Background task run by Codex, agy or a local model instead of a Claude subagent. Use when the user names one of those workers or their models, or says 'through consult' / 'another model' / 'not Claude'.";
const ROUTING_NOT = 'For ordinary delegation use your own subagent tool.';
// When to use delegate and when not; the tool description opens with this and
// the server instructions (which stay loaded when tools are deferred) carry it.
export const DELEGATE_ROUTING_TEXT = `${ROUTING_WHEN} ${ROUTING_NOT}`;

export const GIT_SETUP_QUESTION =
  'This project has no git; a separate copy needs it. Set it up (`git init`, a `.gitignore`, a first commit)? Otherwise workers edit here.';

const KINDS = ['code', 'research', 'review', 'private', 'other'];
const TASK_MODES = ['read', 'write'];
const LOCATIONS = ['here', 'copy'];
// A follow-up goes to a task whose run has ended.
const SEND_STATES = ['done', 'held', 'failed', 'stopped', 'paused-limit', 'cancelled', 'conflict'];
const MERGE_STATES = ['done', 'held'];
const DEFAULT_WAIT_S = 120;
const MIN_WAIT_S = 1;
const MAX_WAIT_S = 1800;
const WAIT_POLL_MS = 1000;
const LOCAL_START_WAIT_MS = 4000;
const LOCAL_START_POLL_MS = 100;
const MAX_LISTED_TASKS = 100;
// The tools report the two workers that have usage limits worth showing.
const TOOL_LIMIT_WORKERS = ['codex', 'agy'];
const MAX_TITLE_CHARS = 120;
// A merge holds merge.lock for as long as it takes; a lock older than the stale time belongs to a dead holder.
const MERGE_LOCK_STALE_MS = 10 * 60 * 1000;
const MERGE_LOCK_PATIENCE_MS = 2 * 60 * 1000;
const FAILURE_SUMMARY_CHARS = 300;

// The nicknames as people write them (vision-best, not vision_best).
function uniqueNicknames() {
  const names = [];
  for (const spelling of Object.keys(NICKNAME_SPELLINGS)) {
    if (!spelling.includes('_')) names.push(spelling);
  }
  return names;
}

function aliasSentence() {
  const aliasesByWorker = {};
  for (const [alias, worker] of Object.entries(WORKER_ALIASES)) {
    if (aliasesByWorker[worker] === undefined) aliasesByWorker[worker] = [];
    aliasesByWorker[worker].push(alias);
  }
  const parts = [];
  for (const [worker, aliases] of Object.entries(aliasesByWorker)) parts.push(`${aliases.join(', ')} for ${worker}`);
  return `Aliases: ${parts.join('; ')}.`;
}

function workerChoices() {
  return `Use codex, agy, local or local:<nickname> (${uniqueNicknames().join(', ')}), a model-family alias (${Object.keys(WORKER_ALIASES).join(', ')}), or auto together with kind (${KINDS.join(', ')}).`;
}

// ---- tool definitions (consult.js lists these) ----

const ID_PROPERTY = { type: 'string', description: 'The task id returned by `delegate`.' };

export const DELEGATE_TOOLS = [
  {
    name: 'delegate',
    description:
      `${DELEGATE_ROUTING_TEXT} ` +
      `Workers: codex, agy, local, or local:<nickname> (${uniqueNicknames().join(', ')}) to pick a local model. ${aliasSentence()} ` +
      '`worker: "auto"` with a `kind` uses the user\'s default table: use it only when the user clearly pointed at consult without naming a worker, and say which worker it chose. ' +
      'Fences: codex works only inside its copy; agy is not fenced and can\'t run commands; local is not fenced, and read-only tasks get read tools only. ' +
      'A local worker keeps its own model calls on this machine, but it is not offline (its shell can reach the network), and Claude, which writes the brief and reads the result, is a cloud model. ' +
      'Write the brief yourself: the goal, the files involved, what done means and the constraints; the worker cannot see this conversation. ' +
      'Declare `mode`: "read" for research and review, "write" when it edits files. Write tasks run in a separate git copy of the project when it has git (merge it with delegate_merge). A copy starts from the project as it is now, uncommitted changes included (ignored files are not); the reply\'s `uncommitted` field says how many were in it. ' +
      'tasks that write in the real folder (no git) must not overlap: start the next only when the last has ended. ' +
      'The call returns at once with the task id and the task runs in the background: tell the user in one line which worker and where. Follow it with delegate_status, delegate_wait and delegate_result. ' +
      'When the reply has started: false it carries `ask` and a `question` for the user: ask it, then call delegate again. ' +
      'ask "worker": which worker (pass `worker`). ask "limit": the worker is near its usage limit; if the user says start anyway pass `confirm_limit: true` (not possible at 100%), otherwise another worker. Never switch a worker the user named on your own. ' +
      'ask "git-setup": put the question to the user and pass `git_setup: "yes"` or `"no"` with their answer.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: `Who does the task. ${workerChoices()}` },
        task_title: { type: 'string', description: 'A short title (a few words) shown in the pane and in notices.' },
        brief: { type: 'string', description: 'The whole task for the worker: goal, files, what done means, constraints. It reaches the worker on stdin or as a file, never in its command line.' },
        mode: { type: 'string', enum: TASK_MODES, description: '"read" for research and review (works in the real folder, writes nothing); "write" when it edits files.' },
        kind: { type: 'string', enum: KINDS, description: 'What kind of work this is. Required with worker "auto" (the table maps it to a worker; "other" asks the user); otherwise only recorded.' },
        model: { type: 'string', description: 'Optional model for the worker (Codex model id, agy model id, or a local model name or nickname). Omit for the worker\'s own default.' },
        effort: { type: 'string', description: 'Optional reasoning effort for codex or agy. Omit for the default.' },
        location: { type: 'string', enum: LOCATIONS, description: 'Optional override of where a write task works: "copy" (a separate git copy) or "here" (the real folder). Use it only when the user said so ("in a copy", "right here"); the project\'s setting decides otherwise.' },
        hold: { type: 'boolean', description: 'true: when it finishes, hold it for the user\'s review instead of treating it as ready to merge.' },
        confirm_limit: { type: 'boolean', description: 'true after the user chose to start anyway when the worker is near (not at) its usage limit.' },
        git_setup: { type: 'string', enum: ['yes', 'no'], description: 'The user\'s answer to the git-setup question: "yes" sets git up here and works in a copy; "no" is remembered and workers edit in place.' }
      },
      required: ['worker', 'task_title', 'brief', 'mode']
    }
  },
  {
    name: 'delegate_status',
    description:
      'Where delegated tasks stand: with `id` that one task; without it this project\'s tasks that are running, queued or waiting for you to act on (a result to read, a merge, a pause at a usage limit). ' +
      'Also the usage limits consult knows for codex and agy. Free and instant.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'A task id. Omit for this project\'s open tasks.' } } }
  },
  {
    name: 'delegate_list',
    description: 'Every delegated task, newest first (this project\'s only with `project_only: true`), as short rows, plus the usage limits consult knows for codex and agy. Free and instant.',
    inputSchema: { type: 'object', properties: { project_only: { type: 'boolean', description: 'Only this project\'s tasks.' } } }
  },
  {
    name: 'delegate_result',
    description:
      'The outcome of a delegated task: its state, the worker\'s final message, the files it changed and a `git diff --stat` (for a copy), the log path and any usage-limit information. ' +
      'Call it when a task is done (or paused, failed or stopped) and before merging. Readable from any project; from a session of the task\'s own project it also marks the result as seen and removes a finished copy that changed nothing.',
    inputSchema: { type: 'object', properties: { id: ID_PROPERTY }, required: ['id'] }
  },
  {
    name: 'delegate_merge',
    description:
      'Apply a finished (done or held) write task\'s copy to the project\'s working files, without touching git\'s index or committing anything. Only from a session of the task\'s own project. ' +
      'Returns what was applied, the files that clash (left with conflict markers: resolve them with both sides in view and tell the user), skipped files, and `held` files: files that run or configure tools are NOT applied; ' +
      'their versions sit beside them as <file>.task and you must ask the user before applying any of them (by your own edits, on their yes). A clean merge removes the copy and keeps the branch consult/<id>.',
    inputSchema: { type: 'object', properties: { id: ID_PROPERTY }, required: ['id'] }
  },
  {
    name: 'delegate_send',
    description:
      'Send a follow-up to a task whose run has ended (done, held, failed, stopped, paused at a limit, cancelled or conflict): the same worker resumes its own session, in the same folder, with your message. ' +
      'Also how to carry on after a usage-limit pause ("continue from the current state of this folder; check git diff first"). Refused while the task is queued or running, or after its copy was merged away. ' +
      'Works only from a session of the task\'s own project (it starts a worker there and makes this session the task\'s owner).',
    inputSchema: {
      type: 'object',
      properties: { id: ID_PROPERTY, message: { type: 'string', description: 'The follow-up for the worker.' } },
      required: ['id', 'message']
    }
  },
  {
    name: 'delegate_cancel',
    description: 'Stop a queued or running task. The worker is stopped within a few seconds; its copy is kept until the user clears the row.',
    inputSchema: { type: 'object', properties: { id: ID_PROPERTY }, required: ['id'] }
  },
  {
    name: 'delegate_wait',
    description:
      'Block until a delegated task changes state, or until `timeout_s` passes. With `id` it watches that task; without it, any task this session started. ' +
      'Returns the changed rows (or timed_out: true). Use it when you have nothing else to do and the user waits for the result.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A task id. Omit to watch every task this session started.' },
        timeout_s: { type: 'number', minimum: MIN_WAIT_S, maximum: MAX_WAIT_S, description: `How long to wait, 1-1800 seconds (default ${DEFAULT_WAIT_S}).` }
      }
    }
  }
];

export const DELEGATE_TOOL_NAMES = DELEGATE_TOOLS.map((tool) => tool.name);

// title, and the annotation set consult.js gives the tool
export const DELEGATE_TOOL_META = {
  delegate: ['Delegate a task to another model', 'delegate_start'],
  delegate_status: ['Delegated tasks: status', 'delegate_read'],
  delegate_list: ['Delegated tasks: list', 'delegate_read'],
  delegate_result: ['Delegated task: result', 'delegate_result'],
  delegate_merge: ['Delegated task: merge its copy', 'delegate_merge'],
  delegate_send: ['Delegated task: follow-up', 'delegate_control'],
  delegate_cancel: ['Delegated task: cancel', 'delegate_control'],
  delegate_wait: ['Wait for a delegated task', 'delegate_read']
};

// ---- small helpers ----

function requireText(args, field) {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`\`${field}\` is required.`);
  return value;
}

function requireTask(args) {
  const id = requireText(args, 'id').trim();
  const task = readTask(id);
  if (task === null) throw new Error(`No delegate task with id ${JSON.stringify(id)}.`);
  return task;
}

export function sameProject(first, second) {
  return projectKey(first) === projectKey(second);
}

// A task that never got going is marked failed, so it is not left queued with
// nothing behind it. Never throws.
function failTask(taskId, reason) {
  try {
    updateTask(taskId, { state: 'failed', ended_at: Date.now(), summary: oneLine(`Failed: ${reason}`, FAILURE_SUMMARY_CHARS) });
  } catch (_) { /* the error the caller throws is what the user sees */ }
}

function taskView(task) {
  const view = indexRow(task);
  view.kind = task.kind ?? null;
  view.effort = task.effort ?? null;
  view.branch = task.branch ?? null;
  view.copy_removed = task.copy_removed === true;
  view.last_output_at = task.last_output_at ?? null;
  view.log_path = task.log_path ?? null;
  view.warning = task.warning ?? null;
  return view;
}

// What is known of each of `workers`' usage limits, with the policy's level and note.
export function limitsView(workers, now = Date.now()) {
  const known = lastLimits(now);
  const view = {};
  for (const worker of workers) {
    const policy = limitPolicy(worker, known, now);
    view[worker] = { ...(known[worker] ?? {}), level: policy.level, note: policy.note };
  }
  return view;
}

export function needsAttention(task) {
  if (ACTIVE_STATES.includes(task.state)) return true;
  if (['held', 'paused-limit'].includes(task.state)) return true;
  // The merge that left the conflict reported it (reported_at); it is listed again only if it never was.
  if (task.state === 'conflict') return task.reported_at === null;
  return task.reported_at === null && task.state !== 'merged' && task.state !== 'cancelled';
}

// final.md counts only when the task's latest run recorded it: a run that failed
// leaves final_path null, and an older run's answer is not its own.
function readFinalMessage(task) {
  if (!task.final_path) return null;
  try {
    return fs.readFileSync(path.join(taskFolder(task.id), 'final.md'), 'utf8');
  } catch (_) {
    return null;
  }
}

// How many local tasks are in front of this one: running on the runner, or queued earlier.
function localTasksAhead(task) {
  let ahead = 0;
  for (const other of scanTasks().tasks) {
    if (other.id === task.id || other.worker !== 'local') continue;
    if (other.state === 'running' || (other.state === 'queued' && other.created_at < task.created_at)) ahead++;
  }
  return ahead;
}

// A local task is admitted by its supervisor when the runner has room; a short
// wait tells the caller whether it is running or queued.
async function waitForLocalStart(taskId, waitMs) {
  const giveUpAt = Date.now() + waitMs;
  let task = readTask(taskId);
  while (task.state === 'queued' && Date.now() < giveUpAt) {
    await sleepUnlessAborted(LOCAL_START_POLL_MS, null);
    task = readTask(taskId);
  }
  return task;
}

// Where a copy task's worker runs (the supervisor computes it the same way). The task has
// started by now, so a failure to work it out only costs the answer, not the task.
async function workFolderOf(task) {
  try {
    return await copyWorkFolder(task);
  } catch (_) {
    return task.worktree;
  }
}

function launch(context, taskId) {
  return (context.launch ?? launchSupervisor)(taskId, { env: context.supervisorEnv ?? process.env });
}

// ---- delegate ----

function validateWorkerOptions(worker, model, effort) {
  requireModelId(model);
  if (worker === 'codex') validateReasoningEffort(effort);
  if (worker === 'agy') validateAgyEffort(effort);
}

// { worker, nickname } or { ask: question }.
function chooseWorker(args, settings) {
  const word = typeof args.worker === 'string' ? args.worker.trim() : '';
  if (word === '') throw new Error(`\`worker\` is required. ${workerChoices()}`);
  if (word.toLowerCase() === 'auto') {
    if (args.kind === undefined) throw new Error(`worker "auto" needs \`kind\` (${KINDS.join(', ')}): classify the task. ${workerChoices()}`);
    const named = workerForKind(args.kind, settings.delegate.table);
    if (!DELEGATE_WORKERS.includes(named)) {
      return {
        ask: 'This kind of task has no default worker. Which should take it: codex (writing and building code), agy (research or review) or local (private work)? Or keep it with one of your own subagents.'
      };
    }
    return { worker: named, nickname: null };
  }
  let parsed;
  try {
    parsed = parseWorkerWord(word);
  } catch (error) {
    throw new Error(`${error.message} ${workerChoices()}`);
  }
  if (parsed.worker === null) throw new Error(`Unknown worker ${JSON.stringify(word)}. ${workerChoices()}`);
  return parsed;
}

function limitQuestion(policy) {
  const advice = 'consult never switches a worker the user named, so put the choice to them.';
  if (policy.level === 'full') {
    return {
      started: false,
      ask: 'limit',
      question: `${policy.note}. Wait until the reset, use another worker, or hand it to one of your Claude subagents?`,
      then: `Wait: tell the user when it resets and call delegate again after that. Another worker: call delegate with that worker. A Claude subagent: use your own subagent tool. consult will not start a task on a full limit, even with confirm_limit. ${advice}`
    };
  }
  return {
    started: false,
    ask: 'limit',
    question: `${policy.note}. Start anyway, wait for the reset, or use another worker?`,
    then: `Start anyway: call delegate again with confirm_limit: true. Another worker: call delegate with that worker. Wait: tell the user when it resets and call delegate again after that. ${advice}`
  };
}

async function startDelegate(args, context) {
  const title = oneLine(requireText(args, 'task_title'), MAX_TITLE_CHARS);
  const brief = requireText(args, 'brief');
  if (!TASK_MODES.includes(args.mode)) throw new Error('`mode` must be "read" or "write".');
  if (args.location !== undefined && !LOCATIONS.includes(args.location)) throw new Error('`location` must be "here" or "copy".');
  if (args.git_setup !== undefined && args.git_setup !== 'yes' && args.git_setup !== 'no') throw new Error('`git_setup` must be "yes" or "no".');
  if (args.kind !== undefined && !KINDS.includes(args.kind)) throw new Error(`\`kind\` must be one of ${KINDS.join(', ')}.`);

  const chosen = chooseWorker(args, context.settings);
  if (chosen.ask !== undefined) return { started: false, ask: 'worker', question: chosen.ask };
  const worker = chosen.worker;
  const model = args.model ?? chosen.nickname ?? null;
  const effort = args.effort ?? null;
  validateWorkerOptions(worker, model, effort);
  if (worker === 'local' && !localConfigured(context.settings)) {
    throw new Error('No local runner is set up, so a local task cannot start. Run /consult:setlocal first.');
  }
  const project = context.project;
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw new Error(`The project folder ${project} does not exist.`);

  // The usage limit comes before anything is changed (git setup included).
  let limitNote;
  if (worker === 'codex' || worker === 'agy') {
    const now = Date.now();
    const policy = limitPolicy(worker, lastLimits(now), now);
    if (policy.level === 'full') return limitQuestion(policy);
    if (policy.level === 'warn') {
      if (args.confirm_limit !== true) return limitQuestion(policy);
      limitNote = policy.note;
    }
  }

  // Where it works.
  const saved = projectSettings(project);
  const decide = (git, canSetup, gitSetting) => decideLocation({
    mode: args.mode, requested: args.location, projectSetting: saved.workers_edit, git, gitSetting, canSetup
  });
  let git = await gitState(project);
  let decision = decide(git, args.mode === 'write' && setupAllowed(project), saved.git);
  if (decision.ask === 'git-setup') {
    if (args.git_setup === 'yes') {
      try {
        await setupGit(project);
      } catch (error) {
        throw new Error(`Git setup failed: ${error.message}`);
      }
      git = await gitState(project);
      decision = decide(git, false, saved.git);
    } else if (args.git_setup === 'no') {
      saveProjectSettings(project, { git: 'declined' });
      decision = { location: 'here', ask: null };
    } else {
      return { started: false, ask: 'git-setup', question: GIT_SETUP_QUESTION };
    }
  }
  let locationNote;
  const wantedCopy = (args.location ?? saved.workers_edit) === 'copy';
  if (args.mode === 'write' && wantedCopy && decision.location === 'here') {
    locationNote = git.copiesSupported !== true
      ? 'A separate copy needs git 2.40 or newer; the worker edits the real folder.'
      : 'A separate copy needs a git project with a commit; the worker edits the real folder.';
  }

  const task = createTask({
    worker, model, effort, title, kind: args.kind ?? null, mode: args.mode, location: decision.location, project, brief,
    hold: args.hold === true,
    owner_session: context.sessionId ?? null,
    owner_instance: context.instanceId ?? null,
    keep_running: context.settings.delegate.on_close === 'keep',
    time_limit_ms: context.settings.delegate.time_limit_ms
  });
  let uncommitted;
  if (decision.location === 'copy') {
    // Counted before the copy is made: the copy's own snapshot is built with a temporary index and changes nothing here.
    const changeCount = await uncommittedCount(project);
    if (changeCount > 0) {
      uncommitted = {
        count: changeCount,
        note: `The copy starts from the project as it is now: its ${changeCount} uncommitted ${changeCount === 1 ? 'change is' : 'changes are'} in it, ignored files are not.`
      };
    }
    try {
      const copy = await (context.makeCopy ?? makeCopy)(project, task.id);
      // queued_at restarts the sweep's clock: a copy of a big project can take a while to make.
      updateTask(task.id, { worktree: copy.worktree, branch: copy.branch, start_commit: copy.start_commit, queued_at: Date.now() });
    } catch (error) {
      failTask(task.id, `could not make a copy of the project: ${error.message}`);
      throw new Error(`Could not make a separate copy of the project: ${error.message}`);
    }
  }
  try {
    launch(context, task.id);
  } catch (error) {
    failTask(task.id, `could not start the supervisor: ${error.message}`);
    throw new Error(`Could not start the task's supervisor: ${error.message}`);
  }

  let latest = readTask(task.id);
  const folder = decision.location === 'copy' ? await workFolderOf(latest) : project;
  if (worker === 'local') latest = await waitForLocalStart(task.id, context.startWaitMs ?? LOCAL_START_WAIT_MS);
  const result = {
    started: true, id: task.id, worker, model: latest.model ?? model, location: decision.location, folder,
    fenced: WORKER_FENCED[worker], state: latest.state
  };
  if (worker === 'local' && latest.state === 'queued') {
    result.queued = true;
    result.queue_model = latest.queue_model ?? null;
    result.ahead = localTasksAhead(latest);
  }
  if (latest.state === 'failed') result.summary = latest.summary;
  if (limitNote !== undefined) result.limit_note = limitNote;
  if (typeof latest.warning === 'string' && latest.warning !== '') result.context_warning = latest.warning;
  if (locationNote !== undefined) result.location_note = locationNote;
  if (uncommitted !== undefined) result.uncommitted = uncommitted;
  return result;
}

// ---- status and list ----

// Whether the call names a task (an absent, null or empty id does not).
function hasTaskId(args) {
  return args.id !== undefined && args.id !== null && args.id !== '';
}

async function statusTool(args, context) {
  if (hasTaskId(args)) {
    return { tasks: [taskView(requireTask(args))], limits: limitsView(TOOL_LIMIT_WORKERS) };
  }
  const rows = [];
  for (const task of listTasks({ project: context.project })) {
    if (needsAttention(task)) rows.push(indexRow(task));
  }
  return { tasks: rows, limits: limitsView(TOOL_LIMIT_WORKERS) };
}

async function listTool(args, context) {
  const tasks = args.project_only === true ? listTasks({ project: context.project }) : listTasks();
  const rows = [];
  for (const task of tasks) {
    if (rows.length >= MAX_LISTED_TASKS) break;
    rows.push(indexRow(task));
  }
  const result = { tasks: rows, limits: limitsView(TOOL_LIMIT_WORKERS) };
  if (tasks.length > rows.length) result.total = tasks.length;
  return result;
}

// ---- result ----

function resultNote(task) {
  if (task.state === 'paused-limit') {
    return 'Paused at a usage limit; the copy, the worker\'s session and the log are kept. Show the user what is done (the diff) and offer: carry on after the reset (delegate_send), hand the rest to another worker, give it to one of your subagents, or merge the partial work labelled unfinished.';
  }
  if (task.state === 'held') return 'Held for review: show the user the result and the diff, and merge only when they agree.';
  if (task.state === 'conflict') return 'The merge left conflicts; see `merge`. Resolve the markers with both sides in view and tell the user.';
  return undefined;
}

async function resultTool(args, context) {
  let task = requireTask(args);
  // A result can be read from any project, but only a session of the task's own project
  // acts on it: removes its empty copy, or marks it seen (which hides it from its owner's open list).
  const inOwnProject = sameProject(task.project, context.project);
  const output = {
    id: task.id, title: task.title, worker: task.worker, model: task.model, state: task.state, stop_reason: task.stop_reason ?? null,
    summary: task.summary ?? null, location: task.location, mode: task.mode, final_message: readFinalMessage(task),
    changed: null, diff_stat: null, branch: task.branch ?? null, log_path: task.log_path ?? null,
    limit: task.limit ?? null, limit_hit: task.limit_hit ?? null, denied: task.denied ?? null, warning: task.warning ?? null
  };
  let note = resultNote(task);
  const baseCommit = unmergedBase(task);
  if (task.location === 'copy' && typeof baseCommit === 'string' && typeof task.end_commit === 'string') {
    try {
      output.changed = await changedFiles(task.project, baseCommit, task.end_commit);
      output.diff_stat = await diffStat(task.project, baseCommit, task.end_commit);
    } catch (error) {
      note = `${note ? `${note} ` : ''}Could not read what the copy changed: ${error.message}`;
    }
  }
  if (Array.isArray(output.changed) && output.changed.length === 0 && MERGE_STATES.includes(task.state) && task.worktree && task.copy_removed !== true) {
    // Once a merge applied part of the task, its branch is the undo for that: only a copy never merged loses it.
    const wasMerged = typeof task.merged_commit === 'string' && task.merged_commit !== '';
    const nothingNew = wasMerged ? 'The task changed nothing since its earlier merge' : 'The task changed no files';
    if (!inOwnProject) {
      note = `${nothingNew}. Its copy is left for a session in ${task.project} to remove.`;
    } else {
      try {
        await (context.removeCopy ?? removeCopy)(task.project, task, { keepBranch: wasMerged });
        task = updateTask(task.id, wasMerged ? { worktree: null, copy_removed: true } : { worktree: null, branch: null, copy_removed: true });
        output.branch = task.branch ?? null;
        note = wasMerged ? `${nothingNew}; its copy was removed and the branch ${task.branch} is kept as the undo.` : 'The task changed no files; its copy and branch were removed.';
      } catch (error) {
        note = `${nothingNew}, but its copy could not be removed (${error.message}); it is tried again at the next result.`;
      }
    }
  }
  if (task.copy_removed === true) output.copy_removed = true;
  if (task.merge_result !== undefined && task.merge_result !== null) output.merge = task.merge_result;
  if (task.worker === 'codex' || task.worker === 'agy') {
    const now = Date.now();
    const policy = limitPolicy(task.worker, lastLimits(now), now);
    if (policy.level !== 'ok') output.limit_note = policy.note;
  }
  if (note !== undefined) output.note = note;
  if (inOwnProject && !ACTIVE_STATES.includes(task.state)) updateTask(task.id, { reported_at: Date.now() });
  return output;
}

// ---- merge ----

function mergeNotes(result, task, copyKept) {
  const notes = [];
  if (result.held.length > 0) {
    notes.push(
      `Files in \`held\` were NOT applied: they run or configure tools. Their versions sit beside them (see task_copies, <file>.task). ` +
      'You must ask the user before applying any of them; apply one only on their yes, by your own edits.'
    );
  }
  if (result.conflicts.length > 0) {
    notes.push(`Resolve the conflict markers in ${result.conflicts.join(', ')} with both sides in view, tell the user, then call delegate_merge on this task again to mark it merged (it checks that no markers are left). A binary clash keeps the user's file with the task's version beside it.`);
  }
  if (result.skipped.length > 0) notes.push(`Not touched: ${result.skipped.map((entry) => `${entry.path} (${entry.reason})`).join(', ')}.`);
  notes.push(copyNote(task, copyKept));
  return notes.join(' ');
}

// What the person is told about the task's copy after a merge.
function copyNote(task, copyKept) {
  if (copyKept) return `The copy is kept at ${task.worktree}; the branch is ${task.branch}.`;
  return `The copy was removed; the branch ${task.branch} is kept as the undo. Nothing is committed: the files are in the working tree.`;
}

// Removes the merged task's copy when `nothingLeft` (the merge left nothing behind), else keeps it.
async function removeMergedCopyIfClean(task, context, nothingLeft) {
  return nothingLeft ? removeMergedCopy(task, context) : { copyKept: true, removalProblem: '' };
}

async function removeMergedCopy(task, context) {
  try {
    await (context.removeCopy ?? removeCopy)(task.project, task, { keepBranch: true });
    updateTask(task.id, { worktree: null, copy_removed: true });
    return { copyKept: false, removalProblem: '' };
  } catch (error) {
    return { copyKept: true, removalProblem: ` The copy could not be removed (${error.message}).` };
  }
}

// A line of git's conflict markers: `<<<<<<< yours` or `>>>>>>> task`. (A bare `=======` is
// also a Markdown heading underline, so it does not count.)
const CONFLICT_MARKER_PATTERN = /^(?:<{7}|>{7})(?:\s.*)?$/m;

// Whether the file still holds conflict markers. A file that is gone, is not a
// text file or lies outside the project has none.
function hasConflictMarkers(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (isOutside(root, absolute)) return false;
  let bytes;
  try {
    if (!fs.statSync(absolute).isFile()) return false;
    bytes = fs.readFileSync(absolute);
  } catch (_) {
    return false;
  }
  if (bytes.includes(0)) return false;
  return CONFLICT_MARKER_PATTERN.test(bytes.toString('utf8'));
}

// delegate_merge on a conflict task: once no file the merge listed still has
// markers, the task is merged (its clean files and resolved files are in the
// project already), the copy goes and the branch stays as the undo.
async function resolveConflict(task) {
  const recorded = Array.isArray(task.merge_result?.conflicts) ? task.merge_result.conflicts : [];
  const root = (await gitState(task.project)).root;
  if (root === null) throw new Error(`${task.project} is no longer a git repository, so consult cannot check the conflicted files.`);
  const stillMarked = [];
  for (const relativePath of recorded) {
    if (typeof relativePath === 'string' && hasConflictMarkers(root, relativePath)) stillMarked.push(relativePath);
  }
  if (stillMarked.length > 0) {
    throw new Error(`Task ${task.id} still has conflict markers in ${stillMarked.join(', ')}. Resolve them with both sides in view, then call delegate_merge again.`);
  }
  await withLockFolder(path.join(dataHome(), 'merge.lock'), async () => {
    const latest = readTask(task.id);
    if (latest === null || latest.state !== 'conflict') {
      throw new Error(`Task ${task.id} is ${latest === null ? 'gone' : latest.state}; it may have been settled while this call waited its turn.`);
    }
    refuseWhileClearing(latest);
    updateTask(task.id, { state: 'merged', reported_at: Date.now() });
  }, { staleMs: MERGE_LOCK_STALE_MS, patienceMs: MERGE_LOCK_PATIENCE_MS });
  const previous = task.merge_result ?? {};
  const held = Array.isArray(previous.held) ? previous.held : [];
  const skipped = Array.isArray(previous.skipped) ? previous.skipped : [];
  const nothingLeft = held.length === 0 && skipped.length === 0;
  const { copyKept, removalProblem } = await removeMergedCopyIfClean(task, {}, nothingLeft && Boolean(task.worktree));
  const output = {
    id: task.id, state: 'merged', applied: previous.applied ?? [], conflicts: [], skipped, held, task_copies: previous.task_copies ?? [],
    copy_removed: !copyKept, branch: task.branch
  };
  output.note = 'The conflicted files have no markers left, so the task is marked merged. ' +
    copyNote(task, copyKept) + removalProblem;
  return output;
}

async function mergeTool(args, context) {
  const task = requireTask(args);
  if (!sameProject(task.project, context.project)) {
    throw new Error(`Task ${task.id} belongs to the project ${task.project}. Open a Claude Code session there to merge it; consult never edits another project from this session.`);
  }
  refuseWhileClearing(task);
  // A second delegate_merge on a conflict is how Claude says the markers are resolved.
  if (task.state === 'conflict') return resolveConflict(task);
  if (!MERGE_STATES.includes(task.state)) {
    throw new Error(`Task ${task.id} is ${task.state}; only a done or held task can be merged (or a conflict, once its markers are resolved).`);
  }
  if (task.location !== 'copy') {
    throw new Error('This task worked in place, so its changes are already in the project; there is nothing to merge.');
  }
  if (task.copy_removed === true) {
    updateTask(task.id, { state: 'merged', reported_at: Date.now() });
    return {
      id: task.id, state: 'merged', applied: [], conflicts: [], skipped: [], held: [], task_copies: [], copy_removed: true,
      note: typeof task.merged_commit === 'string' && task.merged_commit !== ''
        ? `The task has changed nothing since its earlier merge, so there is nothing new to merge. The branch ${task.branch} is kept as the undo.`
        : 'The task changed no files, so there was nothing to apply.'
    };
  }
  if (typeof task.start_commit !== 'string' || typeof task.end_commit !== 'string') {
    throw new Error(`Task ${task.id} has no end snapshot (its copy could not be snapshotted when it ended), so consult cannot merge it. Look in ${task.worktree} by hand.`);
  }

  // The merge and the new state are written under the lock: a second merge of the same
  // task, queued on it, then finds the task merged and is refused.
  const { result, state } = await withLockFolder(path.join(dataHome(), 'merge.lock'), async () => {
    const latest = readTask(task.id);
    if (latest !== null) refuseWhileClearing(latest);
    if (latest === null || !MERGE_STATES.includes(latest.state)) {
      throw new Error(`Task ${task.id} is ${latest === null ? 'gone' : latest.state}; only a done or held task can be merged (it may have been merged while this call waited its turn).`);
    }
    // A task that was merged before (a conflict, then a follow-up) goes on from what that merge applied.
    // The files that merge skipped are tried again, each from the commit it was diffed from.
    const base = unmergedBase(latest);
    const carried = Array.isArray(latest.unmerged_paths) ? latest.unmerged_paths : [];
    const merged = await (context.mergeCopy ?? mergeCopy)(latest.project, { start_commit: base, end_commit: latest.end_commit, carried });
    const newState = merged.conflicts.length > 0 ? 'conflict' : 'merged';
    // The skipped files of this merge replace the earlier ones.
    const baseByPath = new Map();
    for (const entry of carried) baseByPath.set(entry?.path, entry?.base);
    const unmergedPaths = [];
    for (const skipped of merged.skipped) unmergedPaths.push({ path: skipped.path, base: baseByPath.get(skipped.path) ?? base });
    updateTask(task.id, { state: newState, merge_result: merged, merged_commit: latest.end_commit, unmerged_paths: unmergedPaths, reported_at: Date.now() });
    return { result: merged, state: newState };
  }, { staleMs: MERGE_LOCK_STALE_MS, patienceMs: MERGE_LOCK_PATIENCE_MS });

  // The copy goes only when the merge left nothing behind; this is outside the lock.
  const nothingLeft = result.conflicts.length === 0 && result.held.length === 0 && result.skipped.length === 0;
  const { copyKept, removalProblem } = await removeMergedCopyIfClean(task, context, nothingLeft);
  const output = { id: task.id, state, ...result, copy_removed: !copyKept, branch: task.branch };
  output.note = mergeNotes(result, task, copyKept) + removalProblem;
  return output;
}

// ---- send, cancel ----

async function sendTool(args, context) {
  const task = requireTask(args);
  const message = requireText(args, 'message');
  refuseWhileClearing(task);
  // A follow-up starts a worker in the task's project and makes the sender the task's owner:
  // both belong to a session of that project, whatever the task's mode.
  if (!sameProject(task.project, context.project)) {
    throw new Error(`Task ${task.id} belongs to the project ${task.project}. Send the follow-up from a Claude Code session there; consult does not resume another project's task from this session.`);
  }
  if (!SEND_STATES.includes(task.state)) {
    throw new Error(`Task ${task.id} is ${task.state}; a follow-up goes to a task whose run has ended (${SEND_STATES.join(', ')}).`);
  }
  const session = task.worker === 'local' ? task.pi_session : task.worker_session;
  if (typeof session !== 'string' || session === '') {
    throw new Error(`Task ${task.id} has no recorded worker session to resume (the worker stopped before it reported one). Start a new task with the brief instead.`);
  }
  if (task.location === 'copy') {
    if (task.copy_removed === true) throw new Error('the copy was removed after merging; start a new task');
    if (!task.worktree || !fs.existsSync(task.worktree)) throw new Error('The task\'s copy no longer exists; start a new task.');
  }
  const queuedAt = Date.now();
  // What the update below changes, as it was, so a launch that fails can put it all back.
  let previous = null;
  const updated = updateTaskWhen(task.id, (current) => {
    if (!SEND_STATES.includes(current.state) || isClearing(current)) return null;
    const changes = {
      followup: message, state: 'queued', supervisor_pid: null, supervisor_beat_at: null, queued_at: queuedAt, reported_at: null,
      merge_result: null, owner_instance: context.instanceId ?? null, owner_session: context.sessionId ?? null,
      queue_waiting_long: false, skipped_by: 0, relaunched: false,
      // The follow-up has no answer yet: a run that ends before the worker starts must not show the old one.
      final_path: null,
      // A clear whose mark expired must not finish on a task that is running again.
      clearing: false, clearing_at: null, clearing_token: null
    };
    previous = {};
    for (const key of Object.keys(changes)) previous[key] = current[key] ?? null;
    return changes;
  });
  if (updated === null) throw new Error(`Task ${task.id} changed state while the follow-up was sent; check delegate_status.`);
  // A cancel file left by an earlier run would stop this one at once.
  const cancelPath = path.join(taskFolder(task.id), 'cancel');
  let cancelText = null;
  try { cancelText = fs.readFileSync(cancelPath, 'utf8'); } catch (_) { /* no cancel file */ }
  fs.rmSync(cancelPath, { force: true });
  const finalPath = path.join(taskFolder(task.id), 'final.md');
  let finalText = null;
  try { finalText = fs.readFileSync(finalPath, 'utf8'); } catch (_) { /* no earlier answer */ }
  fs.rmSync(finalPath, { force: true });
  try {
    launch(context, task.id);
  } catch (error) {
    updateTask(task.id, previous);
    if (finalText !== null) fs.writeFileSync(finalPath, finalText);
    if (cancelText !== null) fs.writeFileSync(cancelPath, cancelText);
    throw new Error(`Could not start the task's supervisor: ${error.message}`);
  }
  let latest = readTask(task.id);
  const folder = task.location === 'copy' ? await workFolderOf(latest) : task.project;
  if (task.worker === 'local') latest = await waitForLocalStart(task.id, context.startWaitMs ?? LOCAL_START_WAIT_MS);
  const result = { started: true, resumed: true, id: task.id, worker: task.worker, location: task.location, folder, state: latest.state };
  if (task.worker === 'local' && latest.state === 'queued') {
    result.queued = true;
    result.ahead = localTasksAhead(latest);
  }
  return result;
}

async function cancelTool(args) {
  return cancelTask(requireTask(args));
}

// ---- clear (the Delegated tab's Clear) ----

// Merged work and runs that ended with nothing to merge can go; done, held,
// conflict and paused-limit tasks hold work nobody has merged, and only go
// when the person chose to discard it.
const CLEARABLE_STATES = ['merged', 'cancelled', 'failed', 'stopped'];
const DISCARDABLE_STATES = ['done', 'held', 'conflict', 'paused-limit'];
// The states in which a read-only task holds an answer, not changes.
const READ_ANSWER_STATES = ['done', 'held', 'paused-limit'];

// What Clear does to this task, the one rule the tab's buttons follow too:
//   refuse            it cannot be cleared (it is running, or in a state that has nothing to clear)
//   now               it goes at once
//   confirm-unread    a read-only answer Claude has not fetched: only with discard
//   confirm-in-place  a task that worked in place, its work unmerged: only its record goes, with discard
//   confirm-discard   a copy's unmerged work: only with discard, and the work is gone
//   confirm-conflict  a conflict: only with discard; only the copy and its branch go
export function clearPlan(task) {
  if (ACTIVE_STATES.includes(task.state)) return 'refuse';
  if (CLEARABLE_STATES.includes(task.state)) return 'now';
  if (task.mode === 'read') {
    // A read-only answer Claude has already fetched has no work left to lose.
    if (!READ_ANSWER_STATES.includes(task.state)) return 'refuse';
    return typeof task.reported_at === 'number' ? 'now' : 'confirm-unread';
  }
  if (!DISCARDABLE_STATES.includes(task.state)) return 'refuse';
  if (task.location === 'here') return 'confirm-in-place';
  return task.state === 'conflict' ? 'confirm-conflict' : 'confirm-discard';
}

// Why a task cannot be cleared, or null when it can.
function clearRefusal(task, discard) {
  const plan = clearPlan(task);
  if (ACTIVE_STATES.includes(task.state)) return `Task ${task.id} is ${task.state}. Cancel it first, then clear it.`;
  if (plan === 'refuse') return `Task ${task.id} is ${task.state}; it cannot be cleared.`;
  if (plan === 'now' || discard === true) return null;
  if (plan === 'confirm-unread') {
    return `Task ${task.id}'s answer has not been reported to Claude yet; have Claude fetch it with delegate_result, or clear it with discard to throw the answer away.`;
  }
  return `Task ${task.id} is ${task.state} and its work has not been merged; merge it, or clear it with discard to throw its changes away.`;
}

// A clearing mark counts for this long after it was made or last renewed
// (keepClaim). A clear that died (its process was killed) leaves the mark
// behind; after this it is ignored, and the task can be sent to, merged or
// claimed again. Long, because one folder removal can take minutes on Windows
// with a virus scanner running; the clear renews the mark between its steps.
export const CLEARING_MARK_FRESH_MS = 10 * 60 * 1000;
// A clear does not wait for a merge in flight for longer than this: it is refused instead.
const CLEAR_MERGE_WAIT_MS = 2000;

function isClearing(task, now = Date.now()) {
  return task.clearing === true && typeof task.clearing_at === 'number' && now - task.clearing_at < CLEARING_MARK_FRESH_MS;
}

// Marks a task as being cleared, under its lock, when it may be cleared by
// `project`. Only after this succeeds may the caller delete its copy and branch:
// a follow-up or a merge refuses a task with a fresh mark, so nothing can revive
// it meanwhile. The claim is made while holding merge.lock, the lock a merge
// holds from its start to the new state: a clear never lands in the middle of a
// merge (it is refused after `mergeWaitMs`, not queued behind it). Throws the
// reason when it may not be cleared (then nothing is marked). Returns the
// task's new state; its `clearing_token` is the claim's identity: the clear
// hands it to keepClaim, finishClear and releaseClear, which act only while the
// task still carries it (a second clear that takes over an expired mark has its own).
export async function claimForClear(id, project, discard, { mergeWaitMs = CLEAR_MERGE_WAIT_MS } = {}) {
  const task = requireTask({ id });
  if (!sameProject(task.project, project)) {
    throw new Error(`Task ${id} belongs to ${task.project}. Open a session there to clear it.`);
  }
  let refusal = null;
  const claim = () => updateTaskWhen(id, (current) => {
    if (!sameProject(current.project, project)) {
      refusal = `Task ${id} belongs to ${current.project}. Open a session there to clear it.`;
    } else if (isClearing(current)) {
      refusal = `Task ${id} is already being cleared.`;
    } else {
      refusal = clearRefusal(current, discard);
    }
    return refusal === null ? { clearing: true, clearing_at: Date.now(), clearing_token: randomBytes(12).toString('hex') } : null;
  });
  let claimed;
  try {
    claimed = await withLockFolder(path.join(dataHome(), 'merge.lock'), claim, { staleMs: MERGE_LOCK_STALE_MS, patienceMs: mergeWaitMs });
  } catch (error) {
    if (error?.code === 'ELOCKED') throw new Error('A merge is in progress, so the task cannot be cleared right now. Try again in a moment.');
    throw error;
  }
  if (claimed === null) throw new Error(refusal ?? `Task ${id} changed while it was being cleared. Look at it again.`);
  return claimed;
}

function holdsClaim(task, token) {
  return typeof token === 'string' && token !== '' && task.clearing === true && task.clearing_token === token;
}

// Changes a task only while it still carries this claim. True when it did.
function updateWhileClaimed(id, token, changes) {
  if (readTask(id) === null) return false;
  return updateTaskWhen(id, (current) => (holdsClaim(current, token) ? changes : null)) !== null;
}

// Renews the mark's time between the clear's slow steps. Throws when the claim
// was lost (the mark expired and another clear took the task, or it is gone):
// the clear must then delete nothing more.
export function keepClaim(id, token) {
  if (!updateWhileClaimed(id, token, { clearing_at: Date.now() })) {
    throw new Error(`The clear of task ${id} lost its claim (it took too long and the task was handed on); nothing more was deleted.`);
  }
}

// Takes the mark back when the clearing failed and the task stays, only if it
// is still this claim's: another clear's mark is left alone. True when removed.
export function releaseClear(id, token) {
  return updateWhileClaimed(id, token, { clearing: false, clearing_at: null, clearing_token: null });
}

// The clear's last step: removes the task (folder and index row), only while it
// still carries this claim and is in a state the claim allowed. A task that was
// revived meanwhile, or taken over by a second clear, is left alone. True when removed.
export function finishClear(id, token, discard) {
  return removeTaskWhen(id, (current) => holdsClaim(current, token) && clearRefusal(current, discard) === null);
}

function refuseWhileClearing(task) {
  if (isClearing(task)) throw new Error(`Task ${task.id} is being cleared from the Delegated tab; it can no longer be used.`);
}

// Also what the Delegated tab's Cancel and Stop all do (hooks/scripts/delegate.js).
export function cancelTask(task) {
  if (!ACTIVE_STATES.includes(task.state)) {
    throw new Error(`Task ${task.id} is ${task.state}, not running; there is nothing to cancel.`);
  }
  if (task.state === 'queued' && !isSupervisorLive(task)) {
    const cancelled = updateTaskWhen(task.id, (current) => (
      current.state === 'queued' && !isSupervisorLive(current) ? { state: 'cancelled', ended_at: Date.now(), summary: 'Cancelled.' } : null
    ));
    if (cancelled !== null) return { id: task.id, state: 'cancelled', note: 'It had not started.' };
  }
  fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), `${new Date().toISOString()}\n`);
  return {
    id: task.id, state: task.state, cancelling: true,
    note: 'The supervisor stops the worker within a few seconds. The copy, if any, is kept until the user clears the row. delegate_status shows when it has ended.'
  };
}

// ---- wait ----

export function clampWaitSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WAIT_S;
  return Math.min(MAX_WAIT_S, Math.max(MIN_WAIT_S, Math.round(value)));
}

function isOwnedBy(task, context) {
  if (context.sessionId) return task.owner_session === context.sessionId;
  return task.owner_instance === context.instanceId;
}

async function waitTool(args, context) {
  const timeoutMs = clampWaitSeconds(args.timeout_s) * 1000;
  const pollMs = context.pollMs ?? WAIT_POLL_MS;
  const signal = context.signal ?? callSignal();
  const hasId = hasTaskId(args);
  const namedId = hasId ? String(args.id).trim() : null;

  // The tasks being watched, now: [task, ...]. Without an id: this session's tasks, found by
  // scanning the store for the first look and, after that, by reading just the tasks of that look.
  const watchedNow = (knownIds = null) => {
    if (hasId) {
      const task = readTask(namedId);
      return task === null ? [] : [task];
    }
    const owned = [];
    if (knownIds === null) {
      for (const task of scanTasks().tasks) {
        if (isOwnedBy(task, context)) owned.push(task);
      }
      return owned;
    }
    for (const knownId of knownIds) {
      let task = null;
      try {
        task = readTask(knownId);
      } catch (_) { /* being written; the next poll reads it */ }
      if (task !== null && isOwnedBy(task, context)) owned.push(task);
    }
    return owned;
  };
  if (hasId) requireTask(args);
  const baseline = new Map();
  let anyActive = false;
  for (const task of watchedNow()) {
    baseline.set(task.id, task.state);
    if (ACTIVE_STATES.includes(task.state)) anyActive = true;
  }
  if (!anyActive) {
    if (hasId) {
      const task = readTask(namedId);
      return { timed_out: false, changed: [taskView(task)], note: `The task is already ${task.state}.` };
    }
    return { timed_out: false, changed: [], note: 'None of this session\'s tasks is queued or running.' };
  }

  const giveUpAt = Date.now() + timeoutMs;
  while (Date.now() < giveUpAt && !signal?.aborted) {
    await sleepUnlessAborted(Math.min(pollMs, Math.max(0, giveUpAt - Date.now())), signal);
    const changed = [];
    for (const task of watchedNow([...baseline.keys()])) {
      const before = baseline.get(task.id);
      if (before !== undefined && task.state !== before) changed.push(taskView(task));
    }
    if (changed.length > 0) return { timed_out: false, changed };
  }
  return { timed_out: true, changed: [] };
}

// ---- the entry ----

const HANDLERS = {
  delegate: startDelegate,
  delegate_status: statusTool,
  delegate_list: listTool,
  delegate_result: resultTool,
  delegate_merge: mergeTool,
  delegate_send: sendTool,
  delegate_cancel: cancelTool,
  delegate_wait: waitTool
};

export async function callDelegateTool(name, args, context) {
  const handler = HANDLERS[name];
  if (handler === undefined) throw Object.assign(new Error(`Unknown tool: ${name}`), { unknownTool: true });
  try {
    const value = await handler(args ?? {}, context);
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: scrubPii(String(error?.message ?? error)) }] };
  }
}
