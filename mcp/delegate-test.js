// Offline tests for the delegate feature: the task store, its index, the
// heartbeat, per-project settings and the delegate.* settings keys.
// No spawn of any worker, no LLM calls. Run: node mcp/delegate-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';

import {
  gitState, decideLocation, setupAllowed, setupGit, snapshot, makeCopy, endSnapshot,
  removeCopy, pruneOrphans, changedFiles, mergeCopy, HELD_PATH_RULES
} from './lib/delegate-git.js';
import {
  dataHome, newTaskId, createTask, readTask, updateTask, listTasks,
  beat, isAlive, isSessionAlive, projectSettings, saveProjectSettings, projectKey, taskFolder,
  withTaskLock, breakStaleLock, updateTaskWhen, withLockFolder
} from './lib/delegate-store.js';
import { loadSettings, frontmatterWarnings, DEFAULTS } from './lib/settings.js';
import { parseWorkerWord, workerForKind, WORKER_ALIASES } from './lib/delegate-route.js';
import {
  workerCommand, parseWorkerStream, noteStepEvent, contextWarning, codexRolloutLimits, workerPreamble, CONTINUE_PROMPT, READ_ONLY_REMINDER
} from './lib/delegate-workers.js';
import { launchSupervisor, runSupervisor } from './lib/delegate-supervisor.js';
import * as supervisorModule from './lib/delegate-supervisor.js';
import * as storeNamespace from './lib/delegate-store.js';
import * as gitNamespace from './lib/delegate-git.js';
import * as workersNamespace from './lib/delegate-workers.js';
import { swapFacts } from './lib/local-runners.js';
import { runnerCapacity, ceilingFor, admit, withLocalLock, guardOneShot, admitLocalTask } from './lib/delegate-local.js';
import { recordLimit, recordLimitHit, lastLimits, limitPolicy } from './lib/delegate-limits.js';
import { makeAsker } from './lib/council.js';
import { sleepUnlessAborted } from './lib/util.js';
import { fakeServer, startServer, handshake, unpack } from './test-helpers.js';

let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (ok ? '' : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`));
  if (!ok) failed++;
}
function truthy(label, got) {
  const ok = !!got;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (ok ? '' : `\n  got: ${JSON.stringify(got)}`));
  if (!ok) failed++;
}
function throws(label, fn) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  console.log((threw ? 'PASS' : 'FAIL') + ' ' + label + (threw ? '' : '\n  expected a throw, got none'));
  if (!threw) failed++;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-delegate-test-'));
const originalEnv = {
  CONSULT_DELEGATE_HOME: process.env.CONSULT_DELEGATE_HOME,
  CONSULT_PROJECTS_FILE: process.env.CONSULT_PROJECTS_FILE,
  CODEX_HOME: process.env.CODEX_HOME
};
process.env.CONSULT_DELEGATE_HOME = path.join(scratch, 'data');
process.env.CONSULT_PROJECTS_FILE = path.join(scratch, 'consult-projects.json');
// No test reads the user's real ~/.codex: whatever asks for the codex home gets an empty folder.
process.env.CODEX_HOME = path.join(scratch, 'default codex home');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

function sampleSpec(overrides = {}) {
  return {
    worker: 'codex', title: 'Add retries', project: path.join(scratch, 'project'),
    mode: 'write', location: 'copy', brief: '# Brief\nAdd retries to the fetcher.\n',
    ...overrides
  };
}

try {
  // ---- data folder ----
  eq('dataHome: the env override wins', dataHome({ CONSULT_DELEGATE_HOME: 'X:\\somewhere' }), 'X:\\somewhere');
  eq('dataHome: default is under ~/.claude', dataHome({}), path.join(os.homedir(), '.claude', 'consult-delegate'));
  eq('dataHome: reads the process env by default', dataHome(), path.join(scratch, 'data'));

  // ---- sleepUnlessAborted ----
  {
    const controller = new AbortController();
    for (let call = 0; call < 20; call++) await sleepUnlessAborted(1, controller.signal);
    eq('sleepUnlessAborted: a sleep that ran out leaves no abort listener behind', getEventListeners(controller.signal, 'abort').length, 0);
    const started = Date.now();
    const sleeping = sleepUnlessAborted(60000, controller.signal);
    eq('sleepUnlessAborted: one still sleeping holds one listener', getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort();
    await sleeping;
    truthy('sleepUnlessAborted: an abort ends the sleep at once', Date.now() - started < 5000);
    eq('sleepUnlessAborted: and leaves no listener either', getEventListeners(controller.signal, 'abort').length, 0);
    const alreadyAborted = Date.now();
    await sleepUnlessAborted(3000, controller.signal);
    truthy('sleepUnlessAborted: a signal that is already aborted does not sleep', Date.now() - alreadyAborted < 1000);
    const slept = Date.now();
    await sleepUnlessAborted(20, null);
    truthy('sleepUnlessAborted: with no signal it just sleeps', Date.now() - slept >= 15);
  }

  // ---- create / read / update ----
  {
    const created = createTask(sampleSpec({ keep_running: true, time_limit_ms: 600000, queue_model: 'qwen3.5:4b' }));
    truthy('createTask: id is 6 lowercase hex chars', /^[0-9a-f]{6}$/.test(created.id));
    eq('createTask: starts queued with no stop reason', [created.state, created.stop_reason], ['queued', null]);
    eq('createTask: copies the spec fields', [created.worker, created.title, created.mode, created.location], ['codex', 'Add retries', 'write', 'copy']);
    eq('createTask: keep_running, time limit and queue model are kept', [created.keep_running, created.time_limit_ms, created.queue_model], [true, 600000, 'qwen3.5:4b']);
    eq('createTask: flags default off', [created.hold, created.queue_waiting_long, created.fenced], [false, false, null]);
    truthy('createTask: created_at is a time in ms', Math.abs(created.created_at - Date.now()) < 5000);
    eq('createTask: unset fields are null', [created.model, created.worktree, created.start_commit, created.worker_session, created.supervisor_pid, created.summary, created.reported_at, created.owner_instance], [null, null, null, null, null, null, null, null]);
    eq('createTask: brief.md holds the brief', fs.readFileSync(path.join(dataHome(), 'tasks', created.id, 'brief.md'), 'utf8'), '# Brief\nAdd retries to the fetcher.\n');
    eq('createTask: state.json is the returned state', JSON.parse(fs.readFileSync(path.join(dataHome(), 'tasks', created.id, 'state.json'), 'utf8')), created);
    eq('readTask: round trip', readTask(created.id), created);
    eq('readTask: an unknown id is null', readTask('abcdef'), null);
    eq('readTask: a path-like id is null', readTask('..\\..\\x'), null);

    const updated = updateTask(created.id, { state: 'running', started_at: 123, summary: 'working' });
    eq('updateTask: returns the new state', [updated.state, updated.started_at, updated.summary, updated.title], ['running', 123, 'working', 'Add retries']);
    eq('updateTask: persisted', readTask(created.id), updated);
    eq('updateTask: id cannot change', updateTask(created.id, { id: 'ffffff' }).id, created.id);
    throws('updateTask: an unknown state is refused', () => updateTask(created.id, { state: 'sleeping' }));
    throws('updateTask: an unknown stop reason is refused', () => updateTask(created.id, { stop_reason: 'boredom' }));
    updateTask(created.id, { state: 'stopped', stop_reason: 'watchdog' });
    eq('updateTask: a valid stop reason is kept', readTask(created.id).stop_reason, 'watchdog');
    throws('updateTask: an unknown task is refused', () => updateTask('abcdef', { state: 'running' }));
    throws('createTask: an unknown worker is refused', () => createTask(sampleSpec({ worker: 'gemini' })));
    throws('createTask: an unknown mode is refused', () => createTask(sampleSpec({ mode: 'rw' })));
    throws('createTask: an unknown location is refused', () => createTask(sampleSpec({ location: 'cloud' })));
    throws('createTask: a missing project is refused', () => createTask(sampleSpec({ project: '' })));
    eq('createTask: a refused spec leaves no folder behind', fs.readdirSync(path.join(dataHome(), 'tasks')).length, 1);
    fs.rmSync(path.join(dataHome(), 'tasks', created.id), { recursive: true, force: true });
  }

  // ---- ids ----
  {
    const seen = new Set();
    for (let count = 0; count < 20; count++) {
      const id = newTaskId();
      seen.add(id);
      fs.mkdirSync(path.join(dataHome(), 'tasks', id), { recursive: true });
    }
    eq('newTaskId: 20 ids are all different', seen.size, 20);
    for (const id of seen) fs.rmSync(path.join(dataHome(), 'tasks', id), { recursive: true, force: true });
  }

  // ---- index.json and listTasks ----
  {
    const first = createTask(sampleSpec({ title: 'first', created_at: 1000 }));
    const third = createTask(sampleSpec({ title: 'third', created_at: 3000, worker: 'local', hold: true }));
    const second = createTask(sampleSpec({ title: 'second', created_at: 2000, project: path.join(scratch, 'other') }));
    const indexPath = path.join(dataHome(), 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    eq('index: newest first', index.tasks.map(row => row.title), ['third', 'second', 'first']);
    truthy('index: updated_at is a time in ms', Math.abs(index.updated_at - Date.now()) < 5000);
    eq('index: row fields', Object.keys(index.tasks[0]).sort(), [
      'id', 'worker', 'model', 'title', 'project', 'state', 'location', 'mode', 'summary', 'fenced',
      'started_at', 'ended_at', 'stop_reason', 'limit', 'queue_model', 'owner_instance', 'reported_at',
      'queue_waiting_long', 'keep_running', 'hold', 'owner_session', 'created_at', 'queued_at'
    ].sort());
    eq('index: hold is carried', index.tasks[0].hold, true);
    eq('index: no brief text in the index', JSON.stringify(index).includes('Add retries to the fetcher'), false);

    updateTask(first.id, { state: 'done', summary: 'all green', ended_at: 5000 });
    const after = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const firstRow = after.tasks.find(row => row.id === first.id);
    eq('index: updateTask rewrites the row', [firstRow.state, firstRow.summary, firstRow.ended_at], ['done', 'all green', 5000]);
    eq('index: order is by creation, not by update', after.tasks.map(row => row.title), ['third', 'second', 'first']);

    eq('listTasks: all, newest first', listTasks().map(task => task.id), [third.id, second.id, first.id]);
    eq('listTasks: by project', listTasks({ project: path.join(scratch, 'other') }).map(task => task.id), [second.id]);
    eq('listTasks: a project with no tasks', listTasks({ project: path.join(scratch, 'nothing') }), []);
    if (process.platform === 'win32') {
      eq('listTasks: project paths compare case-insensitively on Windows', listTasks({ project: path.join(scratch, 'OTHER') }).map(task => task.id), [second.id]);
    }

    fs.writeFileSync(path.join(dataHome(), 'tasks', 'zzzzzz.txt'), 'not a task');
    fs.mkdirSync(path.join(dataHome(), 'tasks', 'bbbbbb'));
    eq('listTasks: stray files and empty folders are skipped', listTasks().length, 3);
    fs.rmSync(path.join(dataHome(), 'tasks', 'zzzzzz.txt'));
    fs.rmSync(path.join(dataHome(), 'tasks', 'bbbbbb'), { recursive: true });
  }

  // ---- the index keeps at most 200 rows, newest first, and never drops an unfinished task; folders stay ----
  {
    // Folders written straight to disk: createTask rebuilds the index each
    // time, which is slow 200 times over. A final createTask rebuilds it.
    const writeFolders = (template, count, makeState) => {
      fs.mkdirSync(path.join(dataHome(), 'tasks'), { recursive: true });
      for (let number = 0; number < count; number++) {
        const id = (number + 1).toString(16).padStart(6, '0');
        fs.mkdirSync(path.join(dataHome(), 'tasks', id));
        fs.writeFileSync(path.join(dataHome(), 'tasks', id, 'state.json'), JSON.stringify({ ...template, id, ...makeState(number) }));
      }
    };
    const readIndex = () => JSON.parse(fs.readFileSync(path.join(dataHome(), 'index.json'), 'utf8'));

    fs.rmSync(path.join(dataHome(), 'tasks'), { recursive: true, force: true });
    const template = createTask(sampleSpec());
    fs.rmSync(path.join(dataHome(), 'tasks', template.id), { recursive: true, force: true });
    writeFolders(template, 204, number => ({ title: `task ${number}`, state: 'done', created_at: 10000 + number }));
    createTask(sampleSpec({ title: 'task 204', created_at: 10204 }));
    const finishedBehind = readIndex();
    eq('index: capped at 200 rows', finishedBehind.tasks.length, 200);
    eq('index: the newest finished rows fill the cap, a queued task is listed', [finishedBehind.tasks[0].title, finishedBehind.tasks[0].state, finishedBehind.tasks[1].title, finishedBehind.tasks[199].title], ['task 204', 'queued', 'task 203', 'task 5']);
    eq('index: the folders of dropped rows are kept', fs.readdirSync(path.join(dataHome(), 'tasks')).length, 205);

    fs.rmSync(path.join(dataHome(), 'tasks'), { recursive: true, force: true });
    writeFolders(template, 205, number => ({ title: `merged ${number}`, state: 'merged', created_at: 20000 + number }));
    const heldFolder = path.join(dataHome(), 'tasks', 'ffffff');
    fs.mkdirSync(heldFolder);
    fs.writeFileSync(path.join(heldFolder, 'state.json'), JSON.stringify({ ...template, id: 'ffffff', title: 'old held', state: 'held', created_at: 1 }));
    const newest = createTask(sampleSpec({ title: 'new running', created_at: 30000 }));
    updateTask(newest.id, { state: 'running' });
    const withHeld = readIndex();
    eq('index: still capped at 200 rows', withHeld.tasks.length, 200);
    eq('index: an old held task stays behind 200+ newer finished ones', withHeld.tasks[199].title, 'old held');
    eq('index: so does a running one, newest first', [withHeld.tasks[0].title, withHeld.tasks[0].state, withHeld.tasks[1].title], ['new running', 'running', 'merged 204']);
    eq('index: the oldest finished rows are the ones dropped', withHeld.tasks[198].title, 'merged 7');
    updateTask('ffffff', { state: 'cancelled' });
    eq('index: once finished, the old task is dropped', readIndex().tasks.some(row => row.title === 'old held'), false);
    fs.rmSync(path.join(dataHome(), 'tasks'), { recursive: true, force: true });
  }

  // ---- a reader never sees invalid JSON during rapid updates ----
  {
    const task = createTask(sampleSpec());
    const stateFile = path.join(dataHome(), 'tasks', task.id, 'state.json');
    const indexFile = path.join(dataHome(), 'index.json');
    const stopFile = path.join(scratch, 'stop-reader');
    const readerScript = path.join(scratch, 'reader.mjs');
    fs.writeFileSync(readerScript, [
      "import fs from 'node:fs';",
      'const [stateFile, indexFile, stopFile] = process.argv.slice(2);',
      'let reads = 0; const problems = [];',
      "console.log('ready');",
      'while (!fs.existsSync(stopFile)) {',
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
      '  for (const file of [stateFile, indexFile]) {',
      "    try { JSON.parse(fs.readFileSync(file, 'utf8')); reads++; }",
      '    catch (error) { problems.push(`${file}: ${error.message}`); }',
      '  }',
      '}',
      'console.log(JSON.stringify({ reads, problems: problems.slice(0, 5), problemCount: problems.length }));'
    ].join('\n'));
    const reader = spawn(process.execPath, [readerScript, stateFile, indexFile, stopFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    reader.stdout.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => reader.on('close', resolve));
    const startedAt = Date.now();
    while (!output.includes('ready') && Date.now() - startedAt < 10000) await new Promise(resolve => setTimeout(resolve, 20));
    // Spread over about half a second, so a slow machine's reader still reads many times while they land.
    for (let count = 0; count < 50; count++) {
      updateTask(task.id, { summary: `update ${count}`, last_output_at: count });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.writeFileSync(stopFile, '');
    await exited;
    const result = JSON.parse(output.trim().split('\n').pop());
    truthy('rapid updates: the reader read many times meanwhile', result.reads > 20);
    eq('rapid updates: no read failed to parse', [result.problemCount, result.problems], [0, []]);
    eq('rapid updates: the last update won', readTask(task.id).summary, 'update 49');
    eq('rapid updates: no temp files left behind', fs.readdirSync(path.join(dataHome(), 'tasks', task.id)).sort(), ['brief.md', 'state.json']);
  }

  // ---- two processes updating one task lose no write ----
  {
    const task = createTask(sampleSpec());
    const goFile = path.join(scratch, 'go-writers');
    const writerScript = path.join(scratch, 'writer.mjs');
    fs.writeFileSync(writerScript, [
      "import fs from 'node:fs';",
      `import { updateTask } from ${JSON.stringify(new URL('./lib/delegate-store.js', import.meta.url).href)};`,
      'const [taskId, prefix, goFile] = process.argv.slice(2);',
      "console.log('ready');",
      'while (!fs.existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);',
      'for (let count = 0; count < 30; count++) updateTask(taskId, { [`${prefix}_${count}`]: count });'
    ].join('\n'));
    const writers = [];
    for (const prefix of ['first', 'second']) {
      const child = spawn(process.execPath, [writerScript, task.id, prefix, goFile], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
      const writer = { output: '', exitCode: null };
      child.stdout.on('data', chunk => { writer.output += chunk; });
      writer.exited = new Promise(resolve => child.on('close', code => { writer.exitCode = code; resolve(); }));
      writers.push(writer);
    }
    const startedAt = Date.now();
    while (!writers.every(writer => writer.output.includes('ready')) && Date.now() - startedAt < 10000) await new Promise(resolve => setTimeout(resolve, 20));
    // A lock left by a dead process, found by both writers at the same moment:
    // only one may break it, and no write may be lost.
    const deadLock = path.join(taskFolder(task.id), '.lock');
    fs.mkdirSync(deadLock);
    const deadSince = new Date(Date.now() - 20000);
    fs.utimesSync(deadLock, deadSince, deadSince);
    fs.writeFileSync(goFile, '');
    await Promise.all(writers.map(writer => writer.exited));
    const final = readTask(task.id);
    const missing = [];
    for (const prefix of ['first', 'second']) {
      for (let count = 0; count < 30; count++) {
        if (final[`${prefix}_${count}`] !== count) missing.push(`${prefix}_${count}`);
      }
    }
    eq('concurrent updates: both writers finished cleanly', writers.map(writer => writer.exitCode), [0, 0]);
    eq('concurrent updates: all 60 writes are in the final state', missing, []);
    eq('concurrent updates: the lock is released', fs.existsSync(path.join(taskFolder(task.id), '.lock')), false);

    // A lock left by a dead process: fresh it blocks, stale (older than 10 s) it is broken.
    const lockPath = path.join(taskFolder(task.id), '.lock');
    fs.mkdirSync(lockPath);
    const longAgo = new Date(Date.now() - 20000);
    fs.utimesSync(lockPath, longAgo, longAgo);
    eq('lock: a stale lock is broken and the update goes through', updateTask(task.id, { summary: 'after stale lock' }).summary, 'after stale lock');
    eq('lock: and is released again', fs.existsSync(lockPath), false);
    throws('lock: an update to an unknown task still throws and leaves no lock', () => updateTask('abcdef', { summary: 'x' }));
  }

  // ---- breaking a stale lock never takes a live holder's lock ----
  {
    const task = createTask(sampleSpec());
    const lockPath = path.join(taskFolder(task.id), '.lock');
    const goFile = path.join(scratch, 'go-breakers');
    const stopFile = path.join(scratch, 'stop-breakers');
    const storeUrl = JSON.stringify(new URL('./lib/delegate-store.js', import.meta.url).href);
    const holderScript = path.join(scratch, 'holder.mjs');
    fs.writeFileSync(holderScript, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      `import { withTaskLock, taskFolder } from ${storeUrl};`,
      'const [taskId, goFile] = process.argv.slice(2);',
      "const tokenPath = path.join(taskFolder(taskId), '.lock', 'token');",
      'const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      'let held = 0; let violations = 0; let errors = 0;',
      "console.log('ready');",
      'while (!fs.existsSync(goFile)) pause(1);',
      'for (let round = 0; round < 150; round++) {',
      '  try {',
      '    withTaskLock(taskId, () => {',
      '      const token = `${process.pid}-${round}`;',
      '      try {',
      '        fs.writeFileSync(tokenPath, token);',
      '        pause(2);',
      "        if (fs.readFileSync(tokenPath, 'utf8') !== token) violations++;",
      '        fs.rmSync(tokenPath, { force: true });',
      '      } catch (_) { violations++; }',
      '      held++;',
      '    });',
      '  } catch (_) { errors++; }',
      '}',
      'console.log(JSON.stringify({ held, violations, errors }));'
    ].join(String.fromCharCode(10)));
    const breakerScript = path.join(scratch, 'breaker.mjs');
    fs.writeFileSync(breakerScript, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      `import { breakStaleLock, taskFolder } from ${storeUrl};`,
      'const [taskId, goFile, stopFile] = process.argv.slice(2);',
      "const lockPath = path.join(taskFolder(taskId), '.lock');",
      'const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      "console.log('ready');",
      'while (!fs.existsSync(goFile)) pause(1);',
      'while (!fs.existsSync(stopFile)) { breakStaleLock(lockPath); pause(1); }'
    ].join(String.fromCharCode(10)));
    const startChild = (script, args) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
      const running = { output: '', exitCode: null };
      child.stdout.on('data', chunk => { running.output += chunk; });
      running.exited = new Promise(resolve => child.on('close', code => { running.exitCode = code; resolve(); }));
      return running;
    };
    const holder = startChild(holderScript, [task.id, goFile]);
    const breakers = [];
    for (let count = 0; count < 3; count++) breakers.push(startChild(breakerScript, [task.id, goFile, stopFile]));
    const startedAt = Date.now();
    while (![holder, ...breakers].every(child => child.output.includes('ready')) && Date.now() - startedAt < 10000) await new Promise(resolve => setTimeout(resolve, 20));
    // The dead holder's lock, which the breakers hammer along with every fresh one.
    fs.mkdirSync(lockPath);
    const deadSince = new Date(Date.now() - 20000);
    fs.utimesSync(lockPath, deadSince, deadSince);
    fs.writeFileSync(goFile, '');
    await holder.exited;
    fs.writeFileSync(stopFile, '');
    await Promise.all(breakers.map(breaker => breaker.exited));
    const outcome = JSON.parse(holder.output.trim().split(String.fromCharCode(10)).pop());
    eq('stale breakers: the holder got the lock every round, past the dead one', [outcome.held, outcome.errors], [150, 0]);
    eq('stale breakers: no lock was ever taken from a holder', outcome.violations, 0);
    eq('stale breakers: the breakers exited cleanly', breakers.map(breaker => breaker.exitCode), [0, 0, 0]);
    eq('stale breakers: no lock or breaker folder is left', [fs.existsSync(lockPath), fs.existsSync(`${lockPath}.breaker`)], [false, false]);
  }

  // ---- a stale lock that cannot be broken ends in an error, not a spin ----
  {
    const task = createTask(sampleSpec());
    const lockPath = path.join(taskFolder(task.id), '.lock');
    const plantStaleLock = () => {
      fs.mkdirSync(lockPath);
      const longAgo = new Date(Date.now() - 20000);
      fs.utimesSync(lockPath, longAgo, longAgo);
    };
    const realRmSync = fs.rmSync;
    const realMkdirSync = fs.mkdirSync;
    let removeAttempts = 0;
    let lockAttempts = 0;
    plantStaleLock();
    fs.rmSync = (target, ...rest) => {
      if (String(target) === lockPath) {
        removeAttempts++;
        throw Object.assign(new Error('EPERM: stubbed'), { code: 'EPERM' });
      }
      return realRmSync(target, ...rest);
    };
    fs.mkdirSync = (target, ...rest) => {
      if (String(target) === lockPath) lockAttempts++;
      return realMkdirSync(target, ...rest);
    };
    let message = null;
    const startedAt = Date.now();
    try { withTaskLock(task.id, () => 'ran', { patienceMs: 400 }); } catch (error) { message = error.message; }
    const tookMs = Date.now() - startedAt;
    fs.rmSync = realRmSync;
    fs.mkdirSync = realMkdirSync;
    truthy('unbreakable lock: gives up with a clear error', message?.includes('locked by another process'));
    truthy('unbreakable lock: within the budget (0.4 s), not never', tookMs >= 350 && tookMs < 3000);
    truthy('unbreakable lock: it slept between tries (a spin would make thousands)', lockAttempts > 5 && lockAttempts < 200 && removeAttempts < 200);
    eq('unbreakable lock: the breaker folder is not left behind', fs.existsSync(`${lockPath}.breaker`), false);
    realRmSync(lockPath, { recursive: true, force: true });

    // A breaker folder that is fresh: another breaker is at work, so wait, and give up in time.
    plantStaleLock();
    fs.mkdirSync(`${lockPath}.breaker`);
    message = null;
    try { withTaskLock(task.id, () => 'ran', { patienceMs: 300 }); } catch (error) { message = error.message; }
    truthy('busy breaker: waits, then gives up with the same error', message?.includes('locked by another process'));
    // ...and one left by a dead breaker (30 s old) is removed, then the stale lock is broken.
    const breakerDeadSince = new Date(Date.now() - 40000);
    fs.utimesSync(`${lockPath}.breaker`, breakerDeadSince, breakerDeadSince);
    eq('dead breaker: its folder is removed and the stale lock is broken', withTaskLock(task.id, () => 'ran', { patienceMs: 2000 }), 'ran');
    eq('dead breaker: nothing is left behind', [fs.existsSync(lockPath), fs.existsSync(`${lockPath}.breaker`)], [false, false]);
  }

  // ---- a lock's owner file that is refused for a moment (a virus scanner on Windows) ----
  {
    const task = createTask(sampleSpec());
    const lockPath = path.join(taskFolder(task.id), '.lock');
    const ownerPath = path.join(lockPath, 'owner');
    const realReadFileSync = fs.readFileSync;
    let refusals = 0;
    const refuseOwnerReads = (count) => {
      refusals = count;
      fs.readFileSync = (target, ...rest) => {
        if (String(target) === ownerPath && refusals > 0) {
          refusals--;
          throw Object.assign(new Error('EPERM: stubbed'), { code: 'EPERM' });
        }
        return realReadFileSync(target, ...rest);
      };
    };
    try {
      let stillOwnedAfterRefusals = null;
      withTaskLock(task.id, (lock) => {
        refuseOwnerReads(3);
        stillOwnedAfterRefusals = lock.stillOwned();
        fs.readFileSync = realReadFileSync;
      });
      eq('lock owner file: a few refused reads are waited out, the holder still owns its lock', stillOwnedAfterRefusals, true);

      // A thief's owner file is brand new, which is what a scanner holds open: a read that stays refused proves nothing, so it is a lost lock.
      let stillOwnedAfterLongRefusal = null;
      let refusalWaitedMs = null;
      withTaskLock(task.id, (lock) => {
        refuseOwnerReads(1000000);
        const startedAt = Date.now();
        stillOwnedAfterLongRefusal = lock.stillOwned();
        refusalWaitedMs = Date.now() - startedAt;
        fs.readFileSync = realReadFileSync;
      });
      eq('lock owner file: a read refused past the 1 s window is a lost lock, after waiting about that long', [stillOwnedAfterLongRefusal, refusalWaitedMs >= 900 && refusalWaitedMs < 4000], [false, true]);

      let stillOwnedAfterIoError = null;
      withTaskLock(task.id, (lock) => {
        fs.readFileSync = (target, ...rest) => {
          if (String(target) === ownerPath) throw Object.assign(new Error('EIO: stubbed'), { code: 'EIO' });
          return realReadFileSync(target, ...rest);
        };
        stillOwnedAfterIoError = lock.stillOwned();
        fs.readFileSync = realReadFileSync;
      });
      eq('lock owner file: any other read error is a lost lock', stillOwnedAfterIoError, false);

      let afterOwnerRemoved = null;
      let afterTokenReplaced = null;
      withTaskLock(task.id, (lock) => {
        fs.writeFileSync(ownerPath, 'someone-else');
        afterTokenReplaced = lock.stillOwned();
        fs.rmSync(ownerPath, { force: true });
        afterOwnerRemoved = lock.stillOwned();
      });
      eq('lock owner file: a different token, or no owner file, is a lost lock at once', [afterTokenReplaced, afterOwnerRemoved], [false, false]);
      fs.rmSync(lockPath, { recursive: true, force: true });

      withTaskLock(task.id, () => { refuseOwnerReads(3); });
      fs.readFileSync = realReadFileSync;
      eq('lock owner file: a release whose reads are refused tries again and does not leak its lock', fs.existsSync(lockPath), false);

      // The exit hook of a lock folder removes the lock only when it can prove the lock is its own.
      const exitHooksBefore = new Set(process.listeners('exit'));
      const standaloneLock = path.join(scratch, 'exit hook lock');
      let hookLeftUnreadableLock = null;
      let hookRemovedOwnLock = null;
      await withLockFolder(standaloneLock, async () => {
        const hook = process.listeners('exit').find((listener) => !exitHooksBefore.has(listener));
        fs.readFileSync = (target, ...rest) => {
          if (String(target) === path.join(standaloneLock, 'owner')) throw Object.assign(new Error('EIO: stubbed'), { code: 'EIO' });
          return realReadFileSync(target, ...rest);
        };
        hook();
        fs.readFileSync = realReadFileSync;
        hookLeftUnreadableLock = fs.existsSync(standaloneLock);
        hook();
        hookRemovedOwnLock = !fs.existsSync(standaloneLock);
      });
      eq('lock owner file: the exit hook leaves a lock whose token it cannot read, and removes one it can prove is its own', [hookLeftUnreadableLock, hookRemovedOwnLock], [true, true]);
    } finally {
      fs.readFileSync = realReadFileSync;
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }

  // ---- heartbeat ----
  {
    beat('instance-a');
    const beatFile = path.join(dataHome(), 'servers', 'instance-a.json');
    const written = JSON.parse(fs.readFileSync(beatFile, 'utf8'));
    eq('beat: writes pid and time', [written.pid, Math.abs(written.at - Date.now()) < 5000], [process.pid, true]);
    eq('isAlive: a fresh beat', isAlive('instance-a'), true);
    eq('isAlive: never beat', isAlive('instance-b'), false);
    const oneMinuteAgo = new Date(Date.now() - 60000);
    fs.utimesSync(beatFile, oneMinuteAgo, oneMinuteAgo);
    eq('isAlive: false after a 60 s old mtime', isAlive('instance-a'), false);
    const thirtySecondsAgo = new Date(Date.now() - 30000);
    fs.utimesSync(beatFile, thirtySecondsAgo, thirtySecondsAgo);
    eq('isAlive: still alive at 30 s', isAlive('instance-a'), true);
    eq('isAlive: the clock can be passed in', isAlive('instance-a', Date.now() + 60000), false);
    beat('instance-a');
    eq('isAlive: a new beat revives it', isAlive('instance-a'), true);
    throws('beat: an id that is a path is refused', () => beat('..\\evil'));

    // The heartbeat names the server's session, so a restarted server (a new instance of the same session) keeps the session's tasks alive.
    const serversFolder = path.join(dataHome(), 'servers');
    const ageBeat = (instanceId, ageMs) => {
      const at = new Date(Date.now() - ageMs);
      fs.utimesSync(path.join(serversFolder, `${instanceId}.json`), at, at);
    };
    beat('instance-s1', 'session-one');
    eq('beat: the session is written', JSON.parse(fs.readFileSync(path.join(serversFolder, 'instance-s1.json'), 'utf8')).session, 'session-one');
    beat('instance-s2', null);
    eq('beat: no session is written as null', JSON.parse(fs.readFileSync(path.join(serversFolder, 'instance-s2.json'), 'utf8')).session, null);
    beat('instance-s3', '..\\not a plain id');
    eq('beat: a session that is not a plain id is written as null', JSON.parse(fs.readFileSync(path.join(serversFolder, 'instance-s3.json'), 'utf8')).session, null);
    eq('isSessionAlive: a fresh beat names the session', isSessionAlive('session-one'), true);
    eq('isSessionAlive: another session is not alive', isSessionAlive('session-two'), false);
    eq('isSessionAlive: no session is never alive', [isSessionAlive(null), isSessionAlive('')], [false, false]);
    ageBeat('instance-s1', 60000);
    eq('isSessionAlive: a stale beat does not count', isSessionAlive('session-one'), false);
    beat('instance-s4', 'session-one');
    eq('isSessionAlive: a second server of the session, beating lately, keeps it alive', isSessionAlive('session-one'), true);
    eq('isSessionAlive: the clock can be passed in', isSessionAlive('session-one', Date.now() + 60000), false);
    fs.writeFileSync(path.join(serversFolder, 'instance-torn.json'), '{"pid": 12, "se');
    fs.writeFileSync(path.join(serversFolder, 'instance-garbage.json'), 'not json at all');
    fs.writeFileSync(path.join(serversFolder, 'instance-array.json'), '[1,2]');
    fs.writeFileSync(path.join(serversFolder, 'not a beat.txt'), 'x');
    eq('isSessionAlive: torn and garbage files are skipped', [isSessionAlive('session-one'), isSessionAlive('session-two')], [true, false]);
    for (const leftover of ['instance-s1', 'instance-s2', 'instance-s3', 'instance-s4', 'instance-torn', 'instance-garbage', 'instance-array']) fs.rmSync(path.join(serversFolder, `${leftover}.json`), { force: true });
    fs.rmSync(path.join(serversFolder, 'not a beat.txt'), { force: true });
  }

  // ---- per-project settings ----
  {
    const project = path.join(scratch, 'My Projects', 'Имя');
    eq('projectSettings: defaults for an unknown project', projectSettings(project), { workers_edit: 'auto', git: 'ask' });
    eq('projectSettings: no file is created by reading', fs.existsSync(process.env.CONSULT_PROJECTS_FILE), false);
    const saved = saveProjectSettings(project, { workers_edit: 'copy' });
    eq('saveProjectSettings: returns the new settings', saved, { workers_edit: 'copy', git: 'ask' });
    eq('projectSettings: round trip', projectSettings(project), { workers_edit: 'copy', git: 'ask' });
    saveProjectSettings(project, { git: 'declined' });
    eq('saveProjectSettings: keeps what was not changed', projectSettings(project), { workers_edit: 'copy', git: 'declined' });
    eq('projectSettings: another project is unaffected', projectSettings(path.join(scratch, 'My Projects', 'Other')), { workers_edit: 'auto', git: 'ask' });
    eq('projects file: keyed by the absolute path (lower-cased on Windows)', Object.keys(JSON.parse(fs.readFileSync(process.env.CONSULT_PROJECTS_FILE, 'utf8'))), [process.platform === 'win32' ? project.toLowerCase() : project]);
    if (process.platform === 'win32') {
      eq('projectSettings: the key is case-normalised on Windows', projectSettings(project.toUpperCase()), { workers_edit: 'copy', git: 'declined' });
      eq('projectSettings: forward slashes find the same project', projectSettings(project.replaceAll('\\', '/')), { workers_edit: 'copy', git: 'declined' });
    }
    throws('saveProjectSettings: an unknown workers_edit is refused', () => saveProjectSettings(project, { workers_edit: 'sideways' }));
    throws('saveProjectSettings: an unknown git answer is refused', () => saveProjectSettings(project, { git: 'maybe' }));
    throws('saveProjectSettings: an unknown key is refused', () => saveProjectSettings(project, { colour: 'red' }));
    eq('saveProjectSettings: a refused save changes nothing', projectSettings(project), { workers_edit: 'copy', git: 'declined' });
    fs.writeFileSync(process.env.CONSULT_PROJECTS_FILE, '{ not json');
    eq('projectSettings: a broken file reads as defaults', projectSettings(project), { workers_edit: 'auto', git: 'ask' });
    throws('saveProjectSettings: a broken file is not overwritten', () => saveProjectSettings(project, { git: 'declined' }));
    eq('saveProjectSettings: the broken file is untouched', fs.readFileSync(process.env.CONSULT_PROJECTS_FILE, 'utf8'), '{ not json');
  }

  // ---- delegate.* settings ----
  // Runs loadSettings with a temporary home (global file) and project (cwd).
  function loadWith({ globalText = null, projectText = null }) {
    const originalCwd = process.cwd();
    const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const home = fs.mkdtempSync(path.join(scratch, 'home-'));
    const project = fs.mkdtempSync(path.join(scratch, 'proj-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(project, '.claude'));
    if (globalText !== null) fs.writeFileSync(path.join(home, '.claude', 'consult.local.md'), globalText);
    if (projectText !== null) fs.writeFileSync(path.join(project, '.claude', 'consult.local.md'), projectText);
    try {
      process.chdir(project);
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      return { settings: loadSettings(), home, project };
    } finally {
      process.chdir(originalCwd);
      for (const [name, value] of Object.entries(originalHome)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  }
  {
    const defaults = loadWith({}).settings.delegate;
    eq('settings.delegate: defaults', defaults, {
      table: { code: 'codex', research: 'agy', review: 'agy', private: 'local' },
      local_at_once: 'auto', on_close: 'stop', time_limit_ms: 180 * 60000
    });

    const globalText = '---\ndelegate.code: agy\ndelegate.research: local\ndelegate.review: codex\ndelegate.private: local\ndelegate.local_at_once: 3\ndelegate.on_close: keep\ndelegate.time_limit_min: 90\n---\n';
    const globalOnly = loadWith({ globalText });
    eq('settings.delegate: the global file sets every key', globalOnly.settings.delegate, {
      table: { code: 'agy', research: 'local', review: 'codex', private: 'local' },
      local_at_once: 3, on_close: 'keep', time_limit_ms: 90 * 60000
    });
    eq('settings.delegate: a good global file has no warnings', globalOnly.settings._warnings, []);

    const projectText = '---\ndelegate.on_close: keep\ndelegate.code: local\ntimeout_ms: 300000\n---\n';
    const both = loadWith({ globalText: '---\ndelegate.time_limit_min: 60\n---\n', projectText });
    eq('settings.delegate: a project file cannot set on_close or the table', [both.settings.delegate.on_close, both.settings.delegate.table.code], ['stop', 'codex']);
    eq('settings.delegate: the global file still counts next to a project file', both.settings.delegate.time_limit_ms, 60 * 60000);
    eq('settings: other project keys still apply', both.settings.timeout_ms, 300000);
    const projectFile = path.join(both.project, '.claude', 'consult.local.md');
    const projectWarnings = both.settings._warnings.filter(warning => warning.includes(projectFile));
    eq('settings.delegate: each project delegate line is warned about', projectWarnings.length, 2);
    truthy('settings.delegate: the warning names the key, the line and global-only', projectWarnings.some(warning => warning.includes('line 2') && warning.includes('`delegate.on_close`') && warning.includes('global-only')));

    const tooShort = loadWith({ globalText: '---\ndelegate.time_limit_min: 5\n---\n' });
    eq('settings.delegate: time_limit_min below 10 keeps the default', tooShort.settings.delegate.time_limit_ms, 180 * 60000);
    truthy('settings.delegate: time_limit_min 5 is refused with a warning', tooShort.settings._warnings.some(warning => warning.includes('line 2') && warning.includes('`delegate.time_limit_min`') && warning.includes('10')));

    eq('settings.delegate: time_limit_min 10 is allowed', loadWith({ globalText: '---\ndelegate.time_limit_min: 10\n---\n' }).settings.delegate.time_limit_ms, 10 * 60000);
    eq('settings.delegate: time_limit_min 1440 is allowed', loadWith({ globalText: '---\ndelegate.time_limit_min: 1440\n---\n' }).settings.delegate.time_limit_ms, 1440 * 60000);
    eq('settings.delegate: time_limit_min 1441 keeps the default', loadWith({ globalText: '---\ndelegate.time_limit_min: 1441\n---\n' }).settings.delegate.time_limit_ms, 180 * 60000);
    eq('settings.delegate: time_limit_min 12.5 keeps the default', loadWith({ globalText: '---\ndelegate.time_limit_min: 12.5\n---\n' }).settings.delegate.time_limit_ms, 180 * 60000);

    eq('settings.delegate: local_at_once auto', loadWith({ globalText: '---\ndelegate.local_at_once: auto\n---\n' }).settings.delegate.local_at_once, 'auto');
    eq('settings.delegate: local_at_once 8', loadWith({ globalText: '---\ndelegate.local_at_once: 8\n---\n' }).settings.delegate.local_at_once, 8);
    const zeroSlots = loadWith({ globalText: '---\ndelegate.local_at_once: 0\n---\n' });
    eq('settings.delegate: local_at_once 0 keeps auto', zeroSlots.settings.delegate.local_at_once, 'auto');
    truthy('settings.delegate: local_at_once 0 is warned about', zeroSlots.settings._warnings.some(warning => warning.includes('`delegate.local_at_once`')));
    eq('settings.delegate: local_at_once 9 keeps auto', loadWith({ globalText: '---\ndelegate.local_at_once: 9\n---\n' }).settings.delegate.local_at_once, 'auto');

    const badWorker = loadWith({ globalText: '---\ndelegate.code: gemini\n---\n' });
    eq('settings.delegate: an unknown worker keeps the default', badWorker.settings.delegate.table.code, 'codex');
    truthy('settings.delegate: an unknown worker is warned about', badWorker.settings._warnings.some(warning => warning.includes('`delegate.code`') && warning.includes('codex, agy, local')));
    const askRows = loadWith({ globalText: '---\ndelegate.code: ask\ndelegate.research: ask\ndelegate.review: ask\ndelegate.private: ask\n---\n' });
    eq('settings.delegate: a table row may be ask', Object.values(askRows.settings.delegate.table), ['ask', 'ask', 'ask', 'ask']);
    eq('settings.delegate: ask is not warned about', askRows.settings._warnings.filter(warning => warning.includes('delegate.')), []);
    const badClose = loadWith({ globalText: '---\ndelegate.on_close: forever\n---\n' });
    eq('settings.delegate: an unknown on_close keeps stop', badClose.settings.delegate.on_close, 'stop');
    truthy('settings.delegate: an unknown on_close is warned about', badClose.settings._warnings.some(warning => warning.includes('`delegate.on_close`')));
    const unknownKey = loadWith({ globalText: '---\ndelegate.colour: red\n---\n' });
    truthy('settings.delegate: an unknown delegate key is an unknown setting', unknownKey.settings._warnings.some(warning => warning.includes('unknown setting `delegate.colour`')));

    eq('frontmatterWarnings: a quoted value is read', frontmatterWarnings('---\ndelegate.on_close: "keep"\n---\n'), []);
    eq('frontmatterWarnings: a trailing comment is ignored', frontmatterWarnings('---\ndelegate.time_limit_min: 60 # an hour\n---\n'), []);
    eq('frontmatterWarnings: an empty value is just unset', frontmatterWarnings('---\ndelegate.on_close:\n---\n'), []);
  }

  // ---- routing words and the default table ----
  {
    eq('parseWorkerWord: Gemini is agy', parseWorkerWord('Gemini'), { worker: 'agy', nickname: null });
    eq('parseWorkerWord: local:fast carries the nickname', parseWorkerWord('local:fast'), { worker: 'local', nickname: 'fast' });
    eq('parseWorkerWord: local:vision-best is a nickname', parseWorkerWord('local:vision-best'), { worker: 'local', nickname: 'vision-best' });
    eq('parseWorkerWord: bare local has no nickname', parseWorkerWord('local'), { worker: 'local', nickname: null });
    throws('parseWorkerWord: an unknown nickname is refused', () => parseWorkerWord('local:turbo'));
    throws('parseWorkerWord: an empty nickname is refused', () => parseWorkerWord('local:'));
    eq('parseWorkerWord: CODEX is case-insensitive', parseWorkerWord('CODEX'), { worker: 'codex', nickname: null });
    eq('parseWorkerWord: LOCAL:Fast is case-insensitive', parseWorkerWord('LOCAL:Fast'), { worker: 'local', nickname: 'fast' });
    eq('parseWorkerWord: codexify is not codex', parseWorkerWord('codexify'), { worker: null, nickname: null });

    const aliasCases = [
      ['gpt', 'codex'], ['openai', 'codex'], ['gemini', 'agy'], ['argon', 'agy'],
      ['qwen', 'local'], ['llama', 'local'], ['offline', 'local']
    ];
    for (const [alias, worker] of aliasCases) {
      eq(`parseWorkerWord: alias ${alias} is ${worker}`, parseWorkerWord(alias).worker, worker);
    }
    eq('WORKER_ALIASES: maps every alias', WORKER_ALIASES, {
      gpt: 'codex', openai: 'codex', gemini: 'agy', argon: 'agy', qwen: 'local', llama: 'local', offline: 'local'
    });
    truthy('WORKER_ALIASES: is frozen', Object.isFrozen(WORKER_ALIASES));

    eq('parseWorkerWord: codex', parseWorkerWord('codex'), { worker: 'codex', nickname: null });
    eq('parseWorkerWord: an alias, any case', parseWorkerWord('OpenAI'), { worker: 'codex', nickname: null });
    eq('parseWorkerWord: local:big', parseWorkerWord('local:big'), { worker: 'local', nickname: 'big' });
    eq('parseWorkerWord: auto is left to the caller', parseWorkerWord('auto'), { worker: null, nickname: null });
    eq('parseWorkerWord: an unknown word', parseWorkerWord('claude'), { worker: null, nickname: null });
    eq('parseWorkerWord: not a string', parseWorkerWord(undefined), { worker: null, nickname: null });
    throws('parseWorkerWord: a bad nickname is refused', () => parseWorkerWord('local:..\\x'));

    const defaultTable = { code: 'codex', research: 'agy', review: 'agy', private: 'local' };
    eq('workerForKind: code', workerForKind('code', defaultTable), 'codex');
    eq('workerForKind: research', workerForKind('research', defaultTable), 'agy');
    eq('workerForKind: review', workerForKind('review', defaultTable), 'agy');
    eq('workerForKind: private', workerForKind('private', defaultTable), 'local');
    eq('workerForKind: other has no worker', workerForKind('other', defaultTable), null);
    eq('workerForKind: a table row that is ask comes back as ask', workerForKind('code', { ...defaultTable, code: 'ask' }), 'ask');
    eq('workerForKind: follows a changed table', workerForKind('code', { ...defaultTable, code: 'agy' }), 'agy');
    throws('workerForKind: an unknown kind is refused', () => workerForKind('chores', defaultTable));
  }

  // ---- git: where a task works ----
  {
    const withHistory = { isRepo: true, hasCommit: true, root: 'R', copiesSupported: true };
    const noGit = { isRepo: false, hasCommit: false, root: null, copiesSupported: true };
    const emptyRepo = { isRepo: true, hasCommit: false, root: 'R', copiesSupported: true };
    eq('decideLocation: a read task works here, even with git', decideLocation({ mode: 'read', requested: undefined, projectSetting: 'auto', git: withHistory }), { location: 'here', ask: null });
    eq('decideLocation: read beats a copy setting', decideLocation({ mode: 'read', requested: 'copy', projectSetting: 'copy', git: withHistory }), { location: 'here', ask: null });
    eq('decideLocation: write in a repo with a commit gets a copy', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'auto', git: withHistory }), { location: 'copy', ask: null });
    eq('decideLocation: write, no git, ask: here and ask to set up', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'auto', git: noGit, gitSetting: 'ask', canSetup: true }), { location: 'here', ask: 'git-setup' });
    eq('decideLocation: canSetup is false unless the caller says so (fail-safe)', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'auto', git: noGit, gitSetting: 'ask' }), { location: 'here', ask: null });
    eq('decideLocation: a git too old for copies works here, no ask, even with history', decideLocation({ mode: 'write', requested: 'copy', projectSetting: 'auto', git: { ...withHistory, copiesSupported: false }, canSetup: true }), { location: 'here', ask: null });
    eq('decideLocation: a git too old for copies does not ask to set up', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'auto', git: { ...noGit, copiesSupported: false }, gitSetting: 'ask', canSetup: true }), { location: 'here', ask: null });
    eq('decideLocation: a state without copiesSupported counts as unsupported', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'auto', git: { isRepo: true, hasCommit: true, root: 'R' } }), { location: 'here', ask: null });
    eq('decideLocation: write, no git, declined: here, no ask', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'auto', git: noGit, gitSetting: 'declined' }), { location: 'here', ask: null });
    eq('decideLocation: write in a repo without a commit asks to set up', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'auto', git: emptyRepo, gitSetting: 'ask', canSetup: true }), { location: 'here', ask: 'git-setup' });
    eq('decideLocation: no git and setup not allowed: here, no ask', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'auto', git: noGit, gitSetting: 'ask', canSetup: false }), { location: 'here', ask: null });
    eq('decideLocation: requested here beats setting copy', decideLocation({ mode: 'write', requested: 'here', projectSetting: 'copy', git: withHistory }), { location: 'here', ask: null });
    eq('decideLocation: requested copy beats setting here', decideLocation({ mode: 'write', requested: 'copy', projectSetting: 'here', git: withHistory }), { location: 'copy', ask: null });
    eq('decideLocation: setting here keeps a write task here', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'here', git: withHistory }), { location: 'here', ask: null });
    eq('decideLocation: setting copy without git asks to set up', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'copy', git: noGit, gitSetting: 'ask', canSetup: true }), { location: 'here', ask: 'git-setup' });
    eq('decideLocation: setting copy without git, declined: here', decideLocation({ mode: 'write', requested: undefined, projectSetting: 'copy', git: noGit, gitSetting: 'declined' }), { location: 'here', ask: null });
  }

  // ---- git: guard, setup, snapshot, copy ----
  {
    const gitFixtures = path.join(scratch, 'git fixtures');
    fs.mkdirSync(gitFixtures, { recursive: true });
    const gitSync = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const commitAll = (cwd, message) => {
      gitSync(cwd, 'add', '-A');
      gitSync(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', message);
    };
    const sameFolder = (a, b) => fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();

    // ---- setupAllowed ----
    const fakeHome = path.join(gitFixtures, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    eq('setupAllowed: false for the home folder', setupAllowed(fakeHome, { home: fakeHome }), false);
    eq('setupAllowed: false for the home folder written with a trailing slash', setupAllowed(fakeHome + path.sep, { home: fakeHome }), false);
    eq('setupAllowed: false for a drive root', setupAllowed(path.parse(scratch).root, { home: fakeHome }), false);
    eq('setupAllowed: false for the filesystem root', setupAllowed('/', { home: fakeHome }), false);
    const plainFolder = path.join(gitFixtures, 'plain project');
    fs.mkdirSync(plainFolder);
    eq('setupAllowed: true for an ordinary folder outside any repo', setupAllowed(plainFolder, { home: fakeHome }), true);
    const outerRepo = path.join(gitFixtures, 'outer repo');
    fs.mkdirSync(path.join(outerRepo, 'inner'), { recursive: true });
    gitSync(outerRepo, 'init');
    eq('setupAllowed: false for a subfolder of a repo', setupAllowed(path.join(outerRepo, 'inner'), { home: fakeHome }), false);

    // ---- gitState ----
    {
      eq('gitState: a plain folder is not a repo', await gitState(plainFolder), { isRepo: false, hasCommit: false, root: null, copiesSupported: true });
      const emptyState = await gitState(outerRepo);
      eq('gitState: a fresh repo has no commit', [emptyState.isRepo, emptyState.hasCommit], [true, false]);
      truthy('gitState: root of a fresh repo is the repo folder', sameFolder(emptyState.root, outerRepo));
    }

    // ---- setupGit ----
    {
      const fresh = path.join(gitFixtures, 'Имя with space setup');
      fs.mkdirSync(fresh);
      fs.writeFileSync(path.join(fresh, 'файл.txt'), 'hello\n');
      const state = await setupGit(fresh);
      eq('setupGit: leaves a repo with a commit', [state.isRepo, state.hasCommit], [true, true]);
      truthy('setupGit: writes a starter .gitignore when none exists', fs.readFileSync(path.join(fresh, '.gitignore'), 'utf8').split('\n').includes('node_modules/'));
      eq('setupGit: first commit message', gitSync(fresh, 'log', '-1', '--format=%s').trim(), 'Initial commit (consult)');
      eq('setupGit: the Cyrillic file is in the first commit', gitSync(fresh, '-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').includes('файл.txt'), true);

      const withIgnore = path.join(gitFixtures, 'has ignore');
      fs.mkdirSync(withIgnore);
      fs.writeFileSync(path.join(withIgnore, '.gitignore'), 'mine/\n');
      fs.writeFileSync(path.join(withIgnore, 'a.txt'), 'a\n');
      await setupGit(withIgnore);
      eq('setupGit: leaves an existing .gitignore untouched', fs.readFileSync(path.join(withIgnore, '.gitignore'), 'utf8'), 'mine/\n');

      let refusal = null;
      try { await setupGit(path.join(outerRepo, 'inner')); } catch (error) { refusal = error.message; }
      truthy('setupGit: refuses a folder inside another repo', refusal && refusal.includes('not allowed'));
      eq('setupGit: a refused setup creates no .git', fs.existsSync(path.join(outerRepo, 'inner', '.git')), false);

      const headBeforeSecondSetup = gitSync(fresh, 'rev-parse', 'HEAD').trim();
      let secondSetupRefusal = null;
      try { await setupGit(fresh); } catch (error) { secondSetupRefusal = error.message; }
      truthy('setupGit: refuses a project that already has a commit', secondSetupRefusal && secondSetupRefusal.includes('already has a commit'));
      eq('setupGit: a refused second setup leaves HEAD alone', gitSync(fresh, 'rev-parse', 'HEAD').trim(), headBeforeSecondSetup);

      // The "repo root is not the project" refusal: P has a .git FILE pointing at a gitdir whose
      // core.worktree is another folder W, and P's parent is not a repo, so setupAllowed(P) passes
      // while git reports W as the root of P. Nothing may be initialised or written in either folder.
      {
        const otherWorktree = path.join(gitFixtures, 'worktree W');
        const linkedProject = path.join(gitFixtures, 'project P');
        fs.mkdirSync(otherWorktree);
        fs.mkdirSync(linkedProject);
        gitSync(otherWorktree, 'init');
        const otherGitDir = path.join(otherWorktree, '.git');
        gitSync(otherWorktree, 'config', 'core.worktree', otherWorktree);
        fs.writeFileSync(path.join(linkedProject, '.git'), `gitdir: ${otherGitDir.replace(/\\/g, '/')}\n`);
        fs.writeFileSync(path.join(linkedProject, 'p.txt'), 'p\n');
        eq('setupGit root check: setupAllowed passes for P', setupAllowed(linkedProject, { home: fakeHome }), true);
        const linkedState = await gitState(linkedProject);
        eq('setupGit root check: git reports W, not P, as the root and no commit', [linkedState.isRepo, linkedState.hasCommit, sameFolder(linkedState.root, otherWorktree)], [true, false, true]);
        const linkedGitFileBefore = fs.readFileSync(path.join(linkedProject, '.git'), 'utf8');
        let rootRefusal = null;
        try { await setupGit(linkedProject); } catch (error) { rootRefusal = error.message; }
        truthy('setupGit: refuses a project whose repo root is another folder', rootRefusal && rootRefusal.includes('is inside the repository at'));
        eq('setupGit: the root refusal wrote no .gitignore in P', fs.existsSync(path.join(linkedProject, '.gitignore')), false);
        eq('setupGit: the root refusal wrote no .gitignore in W', fs.existsSync(path.join(otherWorktree, '.gitignore')), false);
        eq('setupGit: the root refusal left P\'s .git file alone', fs.readFileSync(path.join(linkedProject, '.git'), 'utf8'), linkedGitFileBefore);
        eq('setupGit: the root refusal made no commit in W', (await gitState(linkedProject)).hasCommit, false);
      }
    }

    // ---- setupGit with no git identity, and no hooks ----
    {
      const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
      const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
      const emptyConfig = path.join(gitFixtures, 'empty-gitconfig');
      fs.writeFileSync(emptyConfig, '');
      process.env.GIT_CONFIG_GLOBAL = emptyConfig;
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      try {
        const anonymous = path.join(gitFixtures, 'no identity');
        fs.mkdirSync(anonymous);
        fs.writeFileSync(path.join(anonymous, 'a.txt'), 'a\n');
        const hookMarker = path.join(gitFixtures, 'hook-ran.txt');
        gitSync(anonymous, 'init');
        const hookPath = path.join(anonymous, '.git', 'hooks', 'pre-commit');
        fs.writeFileSync(hookPath, `#!/bin/sh\necho ran > "${hookMarker.replace(/\\/g, '/')}"\nexit 1\n`);
        const state = await setupGit(anonymous);
        eq('setupGit: works without a configured identity', state.hasCommit, true);
        eq('setupGit: first commit used the fallback identity', gitSync(anonymous, 'log', '-1', '--format=%an <%ae>').trim(), 'consult <consult@localhost>');
        eq('setupGit: did not run the pre-commit hook', fs.existsSync(hookMarker), false);
        eq('setupGit: wrote no identity into the repo config', /user\./.test(fs.readFileSync(path.join(anonymous, '.git', 'config'), 'utf8')), false);
        fs.writeFileSync(path.join(anonymous, 'a.txt'), 'changed\n');
        const sha = await snapshot(anonymous);
        eq('snapshot: works without a configured identity', gitSync(anonymous, 'log', '-1', '--format=%an <%ae>', sha).trim(), 'consult <consult@localhost>');
      } finally {
        if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
        if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
      }
    }

    // ---- snapshot, copy, end snapshot, changed files, cleanup ----
    {
      const project = path.join(gitFixtures, 'Имя with space project');
      fs.mkdirSync(path.join(project, 'src'), { recursive: true });
      fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n');
      fs.writeFileSync(path.join(project, 'tracked.txt'), 'one\n');
      fs.writeFileSync(path.join(project, 'to-delete.txt'), 'bye\n');
      fs.writeFileSync(path.join(project, 'src', 'файл с пробелом.txt'), 'cyr\n');
      gitSync(project, 'init');
      commitAll(project, 'first');
      const headBefore = gitSync(project, 'rev-parse', 'HEAD').trim();

      fs.writeFileSync(path.join(project, 'tracked.txt'), 'one\nmodified\n');
      fs.rmSync(path.join(project, 'to-delete.txt'));
      fs.writeFileSync(path.join(project, 'untracked ново.txt'), 'new\n');
      fs.mkdirSync(path.join(project, 'node_modules'));
      fs.writeFileSync(path.join(project, 'node_modules', 'x'), 'ignored\n');
      const indexPath = path.join(project, '.git', 'index');
      const indexBefore = fs.readFileSync(indexPath);

      const sha = await snapshot(project);
      truthy('snapshot: returns a commit sha', /^[0-9a-f]{40}$/.test(sha));
      eq('snapshot: parent is HEAD', gitSync(project, 'rev-parse', `${sha}^`).trim(), headBefore);
      eq('snapshot: message', gitSync(project, 'log', '-1', '--format=%s', sha).trim(), 'consult snapshot');
      eq('snapshot: the user index is byte-identical', Buffer.compare(indexBefore, fs.readFileSync(indexPath)), 0);
      eq('snapshot: HEAD did not move', gitSync(project, 'rev-parse', 'HEAD').trim(), headBefore);
      eq('snapshot: leaves no temp index in .git', fs.readdirSync(path.join(project, '.git')).filter((name) => name.startsWith('index') && name !== 'index'), []);
      const snapshotFiles = gitSync(project, '-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', sha).split('\n').filter(Boolean);
      eq('snapshot: tree has the modified, kept and untracked files, not the deleted or ignored ones', snapshotFiles.sort(), ['.gitignore', 'src/файл с пробелом.txt', 'tracked.txt', 'untracked ново.txt'].sort());

      // A clean checkout under this machine's line-ending settings snapshots to exactly HEAD's tree.
      {
        const cloned = path.join(gitFixtures, 'Имя clean checkout');
        gitSync(gitFixtures, 'clone', '-q', project, cloned);
        const clonedSha = await snapshot(cloned);
        eq('snapshot: a clean checkout has HEAD\'s own tree (system autocrlf/filters honoured)', gitSync(cloned, 'rev-parse', `${clonedSha}^{tree}`).trim(), gitSync(cloned, 'rev-parse', 'HEAD^{tree}').trim());
      }

      const taskId = 'ab12cd';
      const copy = await makeCopy(project, taskId);
      eq('makeCopy: branch name', copy.branch, 'consult/ab12cd');
      eq('makeCopy: worktree lives under the data home', copy.worktree, path.join(process.env.CONSULT_DELEGATE_HOME, 'worktrees', taskId));
      eq('makeCopy: start commit is the snapshot taken', gitSync(project, 'rev-parse', `${copy.start_commit}^`).trim(), headBefore);
      eq('makeCopy: modified tracked file is modified in the snapshot', gitSync(project, 'show', `${copy.start_commit}:tracked.txt`), 'one\nmodified\n');
      eq('makeCopy: the copy is exactly the snapshot (nothing differs after checkout)', gitSync(copy.worktree, 'status', '--porcelain').trim(), '');
      eq('makeCopy: modified tracked file reached the copy', fs.readFileSync(path.join(copy.worktree, 'tracked.txt'), 'utf8').includes('modified'), true);
      eq('makeCopy: deleted file is absent from the copy', fs.existsSync(path.join(copy.worktree, 'to-delete.txt')), false);
      eq('makeCopy: untracked file is in the copy', fs.existsSync(path.join(copy.worktree, 'untracked ново.txt')), true);
      eq('makeCopy: ignored node_modules is absent from the copy', fs.existsSync(path.join(copy.worktree, 'node_modules')), false);
      eq('makeCopy: Cyrillic name with spaces is in the copy', fs.existsSync(path.join(copy.worktree, 'src', 'файл с пробелом.txt')), true);
      eq('makeCopy: the user index is still byte-identical', Buffer.compare(indexBefore, fs.readFileSync(indexPath)), 0);
      let unsafeRefusal = null;
      try { await makeCopy(project, '..\\evil'); } catch (error) { unsafeRefusal = error.message; }
      truthy('makeCopy: an unsafe task id is refused',unsafeRefusal && unsafeRefusal.includes('unsafe task id'));

      // The worker edits: rename, add, change, delete, plus an ignored file.
      fs.renameSync(path.join(copy.worktree, 'src', 'файл с пробелом.txt'), path.join(copy.worktree, 'src', 'переименован файл.txt'));
      fs.writeFileSync(path.join(copy.worktree, 'added file.txt'), 'added\n');
      fs.writeFileSync(path.join(copy.worktree, 'tracked.txt'), 'one\nmodified\nby worker\n');
      fs.rmSync(path.join(copy.worktree, 'untracked ново.txt'));
      fs.mkdirSync(path.join(copy.worktree, 'node_modules'));
      fs.writeFileSync(path.join(copy.worktree, 'node_modules', 'y'), 'ignored\n');
      const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);
      eq('endSnapshot: parent is the copy start', gitSync(project, 'rev-parse', `${endSha}^`).trim(), copy.start_commit);
      const endFiles = gitSync(project, '-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', endSha).split('\n').filter(Boolean);
      eq('endSnapshot: tree matches the copy, ignored files excluded', endFiles.sort(), ['.gitignore', 'added file.txt', 'src/переименован файл.txt', 'tracked.txt'].sort());

      const changes = await changedFiles(project, copy.start_commit, endSha);
      const byPath = {};
      for (const change of changes) byPath[change.path] = change;
      eq('changedFiles: modified', byPath['tracked.txt'], { status: 'M', path: 'tracked.txt' });
      eq('changedFiles: added, with spaces', byPath['added file.txt'], { status: 'A', path: 'added file.txt' });
      eq('changedFiles: deleted, Cyrillic', byPath['untracked ново.txt'], { status: 'D', path: 'untracked ново.txt' });
      eq('changedFiles: rename carries the old path, unquoted', byPath['src/переименован файл.txt'], { status: 'R', path: 'src/переименован файл.txt', oldPath: 'src/файл с пробелом.txt' });
      eq('changedFiles: nothing else', changes.length, 4);
      eq('changedFiles: same commit means no changes', await changedFiles(project, endSha, endSha), []);

      // removeCopy keeps the branch on request, then removes it.
      const task = { id: taskId, worktree: copy.worktree, branch: copy.branch };
      await removeCopy(project, task, { keepBranch: true });
      eq('removeCopy keepBranch: the worktree folder is gone', fs.existsSync(copy.worktree), false);
      eq('removeCopy keepBranch: the branch is still there', gitSync(project, 'branch', '--list', 'consult/ab12cd').trim(), 'consult/ab12cd');
      eq('removeCopy keepBranch: git forgot the worktree', gitSync(project, 'worktree', 'list', '--porcelain').includes('worktrees'), false);
      await removeCopy(project, task, { keepBranch: false });
      eq('removeCopy: removing again deletes the branch', gitSync(project, 'branch', '--list', 'consult/ab12cd').trim(), '');
      eq('removeCopy: the user index is still byte-identical', Buffer.compare(indexBefore, fs.readFileSync(indexPath)), 0);

      // removeCopy refuses a folder outside the worktrees folder.
      let outsideRefusal = null;
      try { await removeCopy(project, { id: 'x', worktree: project, branch: null }, { keepBranch: true }); } catch (error) { outsideRefusal = error.message; }
      truthy('removeCopy: refuses a worktree outside the data folder', outsideRefusal && outsideRefusal.includes('refusing'));
      eq('removeCopy: the project survived the refusal', fs.existsSync(path.join(project, 'tracked.txt')), true);

      // A worker rewrites its copy's .git file to point at a gitdir whose config runs a program.
      {
        const marker = path.join(scratch, 'fsmonitor-ran.txt');
        const markerForSh = marker.replace(/\\/g, '/');
        const fsmonitorScript = path.join(scratch, 'fsm.sh').replace(/\\/g, '/');
        fs.writeFileSync(fsmonitorScript, `#!/bin/sh\necho ran > "${markerForSh}"\nexit 1\n`, { mode: 0o755 });
        const fakeRepo = path.join(gitFixtures, 'fake gitdir repo');
        fs.mkdirSync(fakeRepo);
        gitSync(fakeRepo, 'init');
        fs.appendFileSync(path.join(fakeRepo, '.git', 'config'), `[core]\n\tfsmonitor = ${fsmonitorScript}\n\thooksPath = ${fakeRepo.replace(/\\/g, '/')}/.git/hooks\n`);

        const attacked = await makeCopy(project, 'ba5e11');
        fs.rmSync(path.join(attacked.worktree, '.git'), { force: true });
        fs.writeFileSync(path.join(attacked.worktree, '.git'), `gitdir: ${path.join(fakeRepo, '.git').replace(/\\/g, '/')}\n`);
        fs.writeFileSync(path.join(attacked.worktree, 'worker file.txt'), 'w\n');

        // Control: git trusting the rewritten .git file does run the program.
        try { gitSync(attacked.worktree, 'status'); } catch (_) { /* a failing fsmonitor is fine here */ }
        truthy('attack control: plain git in the tampered copy runs the fsmonitor program', fs.existsSync(marker));
        fs.rmSync(marker, { force: true });

        const goodSha = await endSnapshot(attacked.worktree, project, attacked.start_commit);
        eq('endSnapshot: a tampered .git file is ignored: the copy is still snapshotted from the project side', gitSync(project, '-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', goodSha).includes('worker file.txt'), true);
        eq('endSnapshot: the fsmonitor program never ran', fs.existsSync(marker), false);

        let strangerRefusal = null;
        try { await endSnapshot(fakeRepo, project, attacked.start_commit); } catch (error) { strangerRefusal = error.message; }
        truthy('endSnapshot: a folder the project does not list is refused', strangerRefusal && strangerRefusal.includes('not a worktree'));
        eq('endSnapshot: refusing a stranger ran nothing either', fs.existsSync(marker), false);

        await removeCopy(project, { id: 'ba5e11', worktree: attacked.worktree, branch: attacked.branch }, { keepBranch: false });
        eq('removeCopy: removes a tampered copy and runs nothing', [fs.existsSync(attacked.worktree), fs.existsSync(marker)], [false, false]);
        eq('removeCopy: the tampered copy no longer appears in the project', gitSync(project, 'worktree', 'list', '--porcelain').includes('ba5e11'), false);
      }

      const posixPath = (file) => file.replace(/\\/g, '/');
      const writeMarkerScript = (name, markerFile, body = '') => {
        const scriptPath = path.join(scratch, name);
        fs.writeFileSync(scriptPath, `#!/bin/sh\necho ran > "${posixPath(markerFile)}"\n${body}`, { mode: 0o755 });
        return posixPath(scriptPath);
      };

      // A worker's .gitattributes must not select a filter driver from the user's config.
      {
        const filterMarker = path.join(scratch, 'filter-ran.txt');
        const filterScript = writeMarkerScript('filter.sh', filterMarker, 'cat\n');
        const filterConfig = path.join(scratch, 'filter-gitconfig');
        fs.writeFileSync(filterConfig, `[user]\n\tname = t\n\temail = t@t\n[filter "x"]\n\tclean = ${filterScript}\n`);
        const savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = filterConfig;
        try {
          const filtered = await makeCopy(project, 'f11700');
          fs.writeFileSync(path.join(filtered.worktree, '.gitattributes'), '* filter=x\n');
          fs.writeFileSync(path.join(filtered.worktree, 'filtered file.txt'), 'f\n');
          execFileSync('git', ['add', '-A'], { cwd: filtered.worktree, env: { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'control-index') }, stdio: 'ignore' });
          truthy('filter control: plain git add in the copy runs the global filter driver', fs.existsSync(filterMarker));
          fs.rmSync(filterMarker, { force: true });
          const filteredSha = await endSnapshot(filtered.worktree, project, filtered.start_commit);
          eq('endSnapshot: the global filter driver never ran', fs.existsSync(filterMarker), false);
          eq('endSnapshot: the worker file is still in the snapshot', gitSync(project, '-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', filteredSha).includes('filtered file.txt'), true);
          await removeCopy(project, { id: 'f11700', worktree: filtered.worktree, branch: filtered.branch }, { keepBranch: false });
        } finally {
          if (savedGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobalConfig;
        }
      }

      // A worker's nested repository inside its copy: its config and attributes must not run anything.
      {
        const nestedMarker = path.join(scratch, 'nested-ran.txt');
        const nestedScript = writeMarkerScript('nested.sh', nestedMarker, 'cat\n');
        const nestedConfig = path.join(scratch, 'nested-gitconfig');
        fs.writeFileSync(nestedConfig, `[user]\n\tname = t\n\temail = t@t\n[filter "x"]\n\tclean = ${nestedScript}\n`);
        const savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = nestedConfig;
        try {
          const nested = await makeCopy(project, 'ae5700');
          const sub = path.join(nested.worktree, 'sub');
          fs.mkdirSync(sub);
          gitSync(sub, 'init');
          fs.writeFileSync(path.join(sub, 'a.txt'), 'a\n');
          gitSync(sub, 'add', '-A');
          gitSync(sub, 'commit', '-m', 'sub first');
          fs.appendFileSync(path.join(sub, '.git', 'config'), `[core]\n\tfsmonitor = ${nestedScript}\n`);
          fs.writeFileSync(path.join(sub, '.gitattributes'), '* filter=x\n');
          fs.writeFileSync(path.join(sub, 'b.txt'), 'b\n');
          try { gitSync(sub, 'status'); } catch (_) { /* a failing fsmonitor is fine here */ }
          truthy('nested control: plain git inside the nested repo runs its fsmonitor program', fs.existsSync(nestedMarker));
          fs.rmSync(nestedMarker, { force: true });
          const nestedSha = await endSnapshot(nested.worktree, project, nested.start_commit);
          eq('endSnapshot: nothing in the nested repository ran', fs.existsSync(nestedMarker), false);
          eq('endSnapshot: the nested repository is recorded as a single entry', gitSync(project, 'ls-tree', nestedSha, 'sub').trim().startsWith('160000 commit'), true);
          await removeCopy(project, { id: 'ae5700', worktree: nested.worktree, branch: nested.branch }, { keepBranch: false });
        } finally {
          if (savedGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobalConfig;
        }
      }

      // Windows runs a git.com sitting in the child's working folder before the real git.
      if (process.platform === 'win32') {
        const hostnameExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'hostname.exe');
        const savedNoDefault = process.env.NoDefaultCurrentDirectoryInExePath;
        delete process.env.NoDefaultCurrentDirectoryInExePath;
        const planted = await makeCopy(project, 'c0c0a1');
        const plantedInProject = path.join(project, 'git.com');
        const plantedInCopy = path.join(planted.worktree, 'git.com');
        try {
          fs.copyFileSync(hostnameExe, plantedInProject);
          fs.copyFileSync(hostnameExe, plantedInCopy);
          let spawnedRealGit = false;
          try {
            spawnedRealGit = execFileSync('git', ['--version'], { cwd: planted.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).startsWith('git version');
          } catch (_) {
            // hostname.exe rejects the argument and exits non-zero: the planted file ran
          }
          eq('git.com control: a plain spawn with cwd in the copy runs the planted git.com, not git', spawnedRealGit, false);
          const state = await gitState(project);
          eq('git.com: gitState still talks to real git', [state.isRepo, state.hasCommit], [true, true]);
          truthy('git.com: snapshot of the project works', /^[0-9a-f]{40}$/.test(await snapshot(project)));
          truthy('git.com: endSnapshot of the copy works', /^[0-9a-f]{40}$/.test(await endSnapshot(planted.worktree, project, planted.start_commit)));
          eq('git.com: setupAllowed still talks to real git', setupAllowed(path.join(project, 'new folder'), { home: fakeHome }), false);
        } finally {
          if (savedNoDefault !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = savedNoDefault;
          fs.rmSync(plantedInProject, { force: true });
          await removeCopy(project, { id: 'c0c0a1', worktree: planted.worktree, branch: planted.branch }, { keepBranch: false });
        }
      }

      // pruneOrphans: a folder with a task stays, one without goes.
      const owned = createTask({ worker: 'codex', title: 'owned', project, mode: 'write', location: 'copy', brief: 'b' });
      const ownedCopy = await makeCopy(project, owned.id);
      const orphanCopy = await makeCopy(project, 'ffffff');
      const vanished = await makeCopy(project, 'eeeeee');
      fs.rmSync(vanished.worktree, { recursive: true, force: true });
      const removedIds = await pruneOrphans(project);
      eq('pruneOrphans: removed only the folder with no task', removedIds, ['ffffff']);
      eq('pruneOrphans: the owned copy stays', fs.existsSync(ownedCopy.worktree), true);
      eq('pruneOrphans: the orphan folder is gone', fs.existsSync(orphanCopy.worktree), false);
      const registered = gitSync(project, 'worktree', 'list', '--porcelain');
      eq('pruneOrphans: git forgot the vanished and orphan worktrees', [registered.includes('eeeeee'), registered.includes('ffffff'), registered.includes(owned.id)], [false, false, true]);
      let missingStartRefusal = null;
      try { await endSnapshot(ownedCopy.worktree, project, undefined); } catch (error) { missingStartRefusal = error.message; }
      truthy('endSnapshot: with no start commit recorded or given, it refuses (never trusts the copy HEAD)', missingStartRefusal && missingStartRefusal.includes('no start commit'));
      updateTask(owned.id, { start_commit: ownedCopy.start_commit });
      truthy('endSnapshot: snapshots the copy against the start commit it is given', /^[0-9a-f]{40}$/.test(await endSnapshot(ownedCopy.worktree, project, ownedCopy.start_commit)));
      await removeCopy(project, { id: owned.id, worktree: ownedCopy.worktree, branch: ownedCopy.branch }, { keepBranch: false });
    }

    // ---- mergeCopy: a finished copy goes back file by file, the index untouched ----
    {
      // A repository whose checkouts are CRLF (blobs LF) on every machine, not only this one.
      const makeMergeProject = (name, files) => {
        const project = path.join(gitFixtures, name);
        fs.mkdirSync(project, { recursive: true });
        gitSync(project, 'init');
        gitSync(project, 'config', 'core.autocrlf', 'true');
        for (const [relativePath, content] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(project, relativePath)), { recursive: true });
          fs.writeFileSync(path.join(project, relativePath), content);
        }
        commitAll(project, 'first');
        return project;
      };
      const readText = (folder, relativePath) => fs.readFileSync(path.join(folder, relativePath), 'utf8');
      const writeText = (folder, relativePath, content) => {
        fs.mkdirSync(path.dirname(path.join(folder, relativePath)), { recursive: true });
        fs.writeFileSync(path.join(folder, relativePath), content);
      };
      const cachedDiffIsEmpty = (project) => {
        try {
          gitSync(project, 'diff', '--cached', '--quiet');
          return true;
        } catch (_) {
          return false;
        }
      };

      // Review Focus 1: the user and the task both edit src/app.css.
      {
        const project = makeMergeProject('merge focus one', {
          'src/app.css': 'a {\r\n  color: red;\r\n}\r\nb {\r\n  color: blue;\r\n}\r\n',
          'old.ts': 'old\r\n',
          'a.ts': 'export const a = 1;\r\nexport const aa = 2;\r\nexport const aaa = 3;\r\n'
        });
        const copy = await makeCopy(project, 'mc0001');
        writeText(copy.worktree, 'src/app.css', readText(copy.worktree, 'src/app.css').replace('color: red', 'color: green'));
        fs.rmSync(path.join(copy.worktree, 'old.ts'));
        fs.renameSync(path.join(copy.worktree, 'a.ts'), path.join(copy.worktree, 'b.ts'));
        writeText(copy.worktree, 'about.html', '<p>about</p>\n');
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);

        writeText(project, 'src/app.css', readText(project, 'src/app.css').replace('color: red', 'color: yellow'));
        writeText(project, 'src/new.ts', 'export const fresh = true;\r\n');
        const indexPath = path.join(project, '.git', 'index');
        const indexBefore = fs.readFileSync(indexPath);
        const headBefore = gitSync(project, 'rev-parse', 'HEAD').trim();

        const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
        eq('mergeCopy: applied holds the added, renamed-to, deleted and renamed-from files', merged.applied.slice().sort(), ['a.ts', 'about.html', 'b.ts', 'old.ts']);
        eq('mergeCopy: the file both sides edited is the only conflict', merged.conflicts, ['src/app.css']);
        eq('mergeCopy: nothing skipped', merged.skipped, []);
        const conflicted = readText(project, 'src/app.css');
        truthy('mergeCopy: the conflicted file has yours/task markers and both edits', conflicted.includes('<<<<<<< yours') && conflicted.includes('>>>>>>> task') && conflicted.includes('color: yellow') && conflicted.includes('color: green'));
        eq('mergeCopy: the user\'s untracked file is untouched', readText(project, 'src/new.ts'), 'export const fresh = true;\r\n');
        eq('mergeCopy: the deleted file is gone', fs.existsSync(path.join(project, 'old.ts')), false);
        eq('mergeCopy: the renamed-from file is gone', fs.existsSync(path.join(project, 'a.ts')), false);
        eq('mergeCopy: the renamed-to file arrives with CRLF', readText(project, 'b.ts'), 'export const a = 1;\r\nexport const aa = 2;\r\nexport const aaa = 3;\r\n');
        eq('mergeCopy: the added file is written in working-tree form (CRLF)', readText(project, 'about.html'), '<p>about</p>\r\n');
        eq('mergeCopy: git diff --cached is empty', cachedDiffIsEmpty(project), true);
        eq('mergeCopy: the user index is byte-identical', Buffer.compare(indexBefore, fs.readFileSync(indexPath)), 0);
        eq('mergeCopy: HEAD did not move', gitSync(project, 'rev-parse', 'HEAD').trim(), headBefore);
        eq('mergeCopy: no temp merge folder left behind', fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('consult-merge-')), []);
        await removeCopy(project, { id: 'mc0001', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // Clean merges, line endings, binary files, files one side removed, clashing additions.
      {
        const originalPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5]);
        const project = makeMergeProject('merge kinds', {
          'plain.txt': 'one\r\ntwo\r\n',
          'merge.txt': 'l1\r\nl2\r\nl3\r\nl4\r\nl5\r\n',
          'logo.png': originalPng,
          'gone.txt': 'gone\r\n',
          'doomed.txt': 'doomed\r\n',
          '.gitattributes': '*.dat -diff\n',
          'data.dat': 'x\r\ny\r\nz\r\n'
        });
        const copy = await makeCopy(project, 'mc0002');
        eq('mergeCopy: the copy checkout is CRLF, as the user\'s files are', readText(copy.worktree, 'plain.txt'), 'one\r\ntwo\r\n');
        writeText(copy.worktree, 'plain.txt', 'one\r\ntwo\r\nthree\r\n');
        writeText(copy.worktree, 'merge.txt', 'l1\r\nl2\r\nl3\r\nl4\r\nTASK5\r\n');
        const taskPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]);
        fs.writeFileSync(path.join(copy.worktree, 'logo.png'), taskPng);
        writeText(copy.worktree, 'gone.txt', 'gone changed\r\n');
        fs.rmSync(path.join(copy.worktree, 'doomed.txt'));
        writeText(copy.worktree, 'clash.txt', 'task version\r\n');
        writeText(copy.worktree, 'data.dat', 'x\r\ny\r\nTASK\r\n');
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);

        writeText(project, 'merge.txt', 'USER1\r\nl2\r\nl3\r\nl4\r\nl5\r\n');
        const userPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 7, 7]);
        fs.writeFileSync(path.join(project, 'logo.png'), userPng);
        fs.rmSync(path.join(project, 'gone.txt'));
        writeText(project, 'doomed.txt', 'doomed but the user kept working on it\r\n');
        writeText(project, 'clash.txt', 'user version\r\n');
        writeText(project, 'data.dat', 'USER\r\ny\r\nz\r\n');
        const indexPath = path.join(project, '.git', 'index');
        const indexBefore = fs.readFileSync(indexPath);

        const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
        eq('mergeCopy: clean changes are applied', merged.applied.slice().sort(), ['merge.txt', 'plain.txt']);
        eq('mergeCopy: binary (NUL or -diff) on both sides, removed-by-user, modified-by-user and clashing additions are conflicts', merged.conflicts.slice().sort(), ['clash.txt', 'data.dat', 'doomed.txt', 'gone.txt', 'logo.png']);
        eq('mergeCopy: nothing skipped (kinds)', merged.skipped, []);
        eq('mergeCopy: a file the user did not touch is written verbatim, CRLF kept', readText(project, 'plain.txt'), 'one\r\ntwo\r\nthree\r\n');
        eq('mergeCopy: a clean three-way merge keeps CRLF on every line', readText(project, 'merge.txt'), 'USER1\r\nl2\r\nl3\r\nl4\r\nTASK5\r\n');
        eq('mergeCopy: the user\'s binary file is kept as it was', Buffer.compare(fs.readFileSync(path.join(project, 'logo.png')), userPng), 0);
        eq('mergeCopy: logo.png.task holds the task\'s bytes', Buffer.compare(fs.readFileSync(path.join(project, 'logo.png.task')), taskPng), 0);
        eq('mergeCopy: a binary conflict has no markers in the user\'s file', fs.readFileSync(path.join(project, 'logo.png')).includes('<<<<<<<'), false);
        eq('mergeCopy: a -diff file changed on both sides is not merged: yours kept, task copy beside it', [readText(project, 'data.dat'), readText(project, 'data.dat.task')], ['USER\r\ny\r\nz\r\n', 'x\r\ny\r\nTASK\r\n']);
        eq('mergeCopy: a file the user removed stays removed', fs.existsSync(path.join(project, 'gone.txt')), false);
        eq('mergeCopy: ...and the task\'s version is saved beside it', readText(project, 'gone.txt.task'), 'gone changed\r\n');
        eq('mergeCopy: a file the task deleted but the user changed is kept', readText(project, 'doomed.txt'), 'doomed but the user kept working on it\r\n');
        const clashing = readText(project, 'clash.txt');
        truthy('mergeCopy: a file both sides added gets markers around both versions', clashing.includes('<<<<<<< yours') && clashing.includes('user version') && clashing.includes('task version') && clashing.includes('>>>>>>> task'));
        eq('mergeCopy: git diff --cached is empty (kinds)', cachedDiffIsEmpty(project), true);
        eq('mergeCopy: the user index is byte-identical (kinds)', Buffer.compare(indexBefore, fs.readFileSync(indexPath)), 0);
        await removeCopy(project, { id: 'mc0002', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // A folder in the user's tree that is a junction/symlink pointing elsewhere is never written through.
      {
        const project = makeMergeProject('merge junction', { 'linked/secret.txt': 'secret\r\n', 'keep.txt': 'keep\r\n' });
        const copy = await makeCopy(project, 'mc0003');
        writeText(copy.worktree, 'linked/secret.txt', 'secret changed by the task\r\n');
        writeText(copy.worktree, 'linked/new.txt', 'new from the task\r\n');
        writeText(copy.worktree, 'keep.txt', 'keep changed\r\n');
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);

        const outsideFolder = path.join(gitFixtures, 'outside the repo');
        fs.mkdirSync(outsideFolder, { recursive: true });
        fs.writeFileSync(path.join(outsideFolder, 'secret.txt'), 'secret\r\n');
        fs.rmSync(path.join(project, 'linked'), { recursive: true, force: true });
        let linkMade = false;
        try {
          fs.symlinkSync(outsideFolder, path.join(project, 'linked'), 'junction');
          linkMade = true;
        } catch (_) {
          console.log('SKIP mergeCopy: this OS refused to create a junction/symlink, folder-escape test not run');
        }
        if (linkMade) {
          const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
          eq('mergeCopy junction: only the file outside the link is applied', merged.applied, ['keep.txt']);
          const skippedPaths = merged.skipped.map((entry) => entry.path).sort();
          eq('mergeCopy junction: both files under the link are skipped', skippedPaths, ['linked/new.txt', 'linked/secret.txt']);
          truthy('mergeCopy junction: the reason names the link', merged.skipped.every((entry) => /symlink|junction/.test(entry.reason)));
          eq('mergeCopy junction: the file outside the repo is untouched', fs.readFileSync(path.join(outsideFolder, 'secret.txt'), 'utf8'), 'secret\r\n');
          eq('mergeCopy junction: nothing new appeared outside the repo', fs.readdirSync(outsideFolder), ['secret.txt']);
          // A Windows junction is removed as a folder, a POSIX symlink as a file.
          if (process.platform === 'win32') fs.rmdirSync(path.join(project, 'linked')); else fs.unlinkSync(path.join(project, 'linked'));
        }
        await removeCopy(project, { id: 'mc0003', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // A forged end commit: a symlink entry, .git paths, a path above the repository, a nested .git.
      {
        const project = makeMergeProject('merge forged', { 'keep.txt': 'keep\r\n' });
        const copy = await makeCopy(project, 'mc0004');
        const gitPlain = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const gitWithInput = (input, ...args) => execFileSync('git', args, { cwd: project, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const blobId = gitWithInput('forged\n', 'hash-object', '-w', '--stdin');
        const treeOf = (entryText) => gitWithInput(entryText, 'mktree', '-z');
        const innerTree = treeOf(`100644 blob ${blobId}\tconfig\0`);
        const escapeTree = treeOf(`100644 blob ${blobId}\tescape-marker.txt\0`);
        const startTreeText = execFileSync('git', ['ls-tree', '-z', `${copy.start_commit}^{tree}`], { cwd: project, encoding: 'utf8' });
        const forgedRoot = treeOf(
          startTreeText +
          `120000 blob ${blobId}\tevil-link\0` +
          `040000 tree ${innerTree}\t.git\0` +
          `040000 tree ${escapeTree}\t..\0` +
          `040000 tree ${innerTree}\tnested\0`
        );
        const forgedEnd = gitPlain('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', forgedRoot, '-p', copy.start_commit, '-m', 'forged');
        const gitConfigBefore = fs.readFileSync(path.join(project, '.git', 'config'));
        const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: forgedEnd });
        const reasonByPath = {};
        for (const entry of merged.skipped) reasonByPath[entry.path] = entry.reason;
        eq('mergeCopy forged: a symlink entry is skipped as "symlink"', reasonByPath['evil-link'], 'symlink');
        truthy('mergeCopy forged: a path under .git is skipped', typeof reasonByPath['.git/config'] === 'string' && /\.git/.test(reasonByPath['.git/config']));
        truthy('mergeCopy forged: a path above the repository is skipped', typeof reasonByPath['../escape-marker.txt'] === 'string');
        eq('mergeCopy forged: the safe nested file is applied', merged.applied, ['nested/config']);
        eq('mergeCopy forged: no symlink was created', fs.existsSync(path.join(project, 'evil-link')), false);
        eq('mergeCopy forged: .git/config is unchanged', Buffer.compare(gitConfigBefore, fs.readFileSync(path.join(project, '.git', 'config'))), 0);
        eq('mergeCopy forged: nothing was written above the repository', fs.existsSync(path.join(gitFixtures, 'escape-marker.txt')), false);
        await removeCopy(project, { id: 'mc0004', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // Unchanged-ness is judged the way git judges it (clean the bytes), so LF files under
      // autocrlf=true and eol=lf attributes with CRLF working copies are not "changed".
      {
        const project = makeMergeProject('merge line endings', {
          'lf-plain.txt': 'a\nb\nc\n',
          'lf-gone.txt': 'gone\n',
          'lf-merge.txt': 'l1\nl2\nl3\nl4\nl5\n',
          'run.sh': 'e1\ne2\n',
          '.gitattributes': '*.sh eol=lf\n'
        });
        writeText(project, 'run.sh', 'e1\r\ne2\r\n');
        const copy = await makeCopy(project, 'mc0005');
        writeText(copy.worktree, 'lf-plain.txt', 'a\r\nb\r\nc\r\nd\r\n');
        fs.rmSync(path.join(copy.worktree, 'lf-gone.txt'));
        writeText(copy.worktree, 'lf-merge.txt', 'l1\r\nl2\r\nl3\r\nl4\r\nTASK5\r\n');
        writeText(copy.worktree, 'run.sh', 'e1\ne2\ne3\n');
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);
        writeText(project, 'lf-merge.txt', 'USER1\nl2\nl3\nl4\nl5\n');

        const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
        eq('mergeCopy line endings: untouched LF files, a delete, a non-overlapping merge and an eol=lf file are all applied', merged.applied.slice().sort(), ['lf-gone.txt', 'lf-merge.txt', 'lf-plain.txt', 'run.sh']);
        eq('mergeCopy line endings: no conflicts', merged.conflicts, []);
        eq('mergeCopy line endings: an untouched LF file stays LF', readText(project, 'lf-plain.txt'), 'a\nb\nc\nd\n');
        eq('mergeCopy line endings: the task\'s delete of an untouched LF file is applied', fs.existsSync(path.join(project, 'lf-gone.txt')), false);
        eq('mergeCopy line endings: a both-edited LF file merges cleanly with no mixed endings', readText(project, 'lf-merge.txt'), 'USER1\nl2\nl3\nl4\nTASK5\n');
        eq('mergeCopy line endings: an eol=lf file with a CRLF working copy keeps CRLF', readText(project, 'run.sh'), 'e1\r\ne2\r\ne3\r\n');
        await removeCopy(project, { id: 'mc0005', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // One file that cannot be written does not stop the others, and is reported.
      {
        const project = makeMergeProject('merge read only', { 'a.txt': 'x\n', 'b.txt': 'x\n', 'c.txt': 'x\n' });
        const copy = await makeCopy(project, 'mc0006');
        for (const name of ['a.txt', 'b.txt', 'c.txt']) writeText(copy.worktree, name, 'x\r\ny\r\n');
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);
        const lockedFile = path.join(project, 'b.txt');
        fs.chmodSync(lockedFile, 0o444);
        let lockHolds = false;
        try {
          fs.accessSync(lockedFile, fs.constants.W_OK);
        } catch (_) {
          lockHolds = true;
        }
        if (!lockHolds) {
          console.log('SKIP mergeCopy read-only: this OS lets the file be written, failing-file test not run');
        } else {
          let merged = null;
          let thrown = null;
          try {
            merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
          } catch (error) {
            thrown = error.message;
          }
          eq('mergeCopy read-only: a failing file does not abort the merge', thrown, null);
          if (merged !== null) {
            eq('mergeCopy read-only: the other two files are applied', merged.applied.slice().sort(), ['a.txt', 'c.txt']);
            eq('mergeCopy read-only: the failing file is skipped with a reason', [merged.skipped.length, merged.skipped[0] && merged.skipped[0].path, typeof (merged.skipped[0] && merged.skipped[0].reason)], [1, 'b.txt', 'string']);
            eq('mergeCopy read-only: the failing file is untouched', readText(project, 'b.txt'), 'x\n');
          }
        }
        fs.chmodSync(lockedFile, 0o666);
        await removeCopy(project, { id: 'mc0006', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // diff.relative=true must not turn repo-root paths into project-relative ones; commit ids are validated.
      {
        const project = makeMergeProject('merge relative', { 'app/src/a.txt': 'a\n', 'top.txt': 'top\n' });
        gitSync(project, 'config', 'diff.relative', 'true');
        const subfolderProject = path.join(project, 'app');
        const copy = await makeCopy(subfolderProject, 'mc0007');
        writeText(copy.worktree, 'app/src/a.txt', 'a\r\nchanged\r\n');
        writeText(copy.worktree, 'top.txt', 'top\r\nchanged\r\n');
        const endSha = await endSnapshot(copy.worktree, subfolderProject, copy.start_commit);
        const changes = await changedFiles(subfolderProject, copy.start_commit, endSha);
        eq('changedFiles: diff.relative=true still gives repo-root paths', changes.map((change) => change.path).sort(), ['app/src/a.txt', 'top.txt']);
        const merged = await mergeCopy(subfolderProject, { start_commit: copy.start_commit, end_commit: endSha });
        eq('mergeCopy diff.relative: both files are applied at their repo paths', merged.applied.slice().sort(), ['app/src/a.txt', 'top.txt']);
        eq('mergeCopy diff.relative: the project file changed', readText(project, 'app/src/a.txt'), 'a\nchanged\n');
        eq('mergeCopy diff.relative: the file above the project folder changed', readText(project, 'top.txt'), 'top\nchanged\n');
        eq('mergeCopy diff.relative: nothing landed at a wrong path', fs.existsSync(path.join(project, 'app', 'app')) || fs.existsSync(path.join(project, 'app', 'top.txt')), false);

        let badStart = null;
        try { await mergeCopy(subfolderProject, { start_commit: '--output=evil.txt', end_commit: endSha }); } catch (error) { badStart = error.message; }
        truthy('mergeCopy: a start_commit that is not a commit id is refused', badStart && badStart.includes('start_commit'));
        let badEnd = null;
        try { await mergeCopy(subfolderProject, { start_commit: copy.start_commit, end_commit: 'HEAD' }); } catch (error) { badEnd = error.message; }
        truthy('mergeCopy: an end_commit that is not a commit id is refused', badEnd && badEnd.includes('end_commit'));
        eq('mergeCopy: a refused commit id wrote nothing', fs.existsSync(path.join(subfolderProject, 'evil.txt')), false);
        await removeCopy(subfolderProject, { id: 'mc0007', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // Files that run or configure tools are never written in place: the task's version is held beside them.
      {
        eq('HELD_PATH_RULES is frozen all the way down', [Object.isFrozen(HELD_PATH_RULES), Object.isFrozen(HELD_PATH_RULES.inertDotFiles), Object.isFrozen(HELD_PATH_RULES.heldBasenamePatterns), Object.isFrozen(HELD_PATH_RULES.heldFolders)], [true, true, true, true]);
        const project = makeMergeProject('merge held', {
          '.envrc': 'export A=1\n',
          '.github/workflows/x.yml': 'on: push\n',
          'keep.txt': 'k\n'
        });
        const copy = await makeCopy(project, 'mc0008');
        writeText(copy.worktree, '.claude/settings.json', '{"hooks":{}}\n');
        writeText(copy.worktree, '.github/workflows/x.yml', 'on: pull_request\n');
        fs.rmSync(path.join(copy.worktree, '.envrc'));
        writeText(copy.worktree, 'keep.txt', 'k\nchanged\n');
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);

        const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
        const heldReason = 'runs or configures tools: needs the user\'s OK';
        eq('mergeCopy held: the add, modify and delete of tool files are all held', merged.held.slice().sort((first, second) => first.path < second.path ? -1 : 1), [
          { path: '.claude/settings.json', task_copy: '.claude/settings.json.task', reason: heldReason },
          { path: '.envrc', task_copy: null, reason: heldReason },
          { path: '.github/workflows/x.yml', task_copy: '.github/workflows/x.yml.task', reason: heldReason }
        ]);
        eq('mergeCopy held: only the ordinary file is applied', merged.applied, ['keep.txt']);
        eq('mergeCopy held: the real files are untouched', [fs.existsSync(path.join(project, '.claude', 'settings.json')), readText(project, '.github/workflows/x.yml'), readText(project, '.envrc')], [false, 'on: push\n', 'export A=1\n']);
        eq('mergeCopy held: the side copies carry the task\'s versions', [readText(project, '.claude/settings.json.task').replace(/\r\n/g, '\n'), readText(project, '.github/workflows/x.yml.task').replace(/\r\n/g, '\n')], ['{"hooks":{}}\n', 'on: pull_request\n']);
        eq('mergeCopy held: task_copies lists the two copies written', merged.task_copies.slice().sort((first, second) => first.path < second.path ? -1 : 1), [
          { path: '.claude/settings.json', task_copy: '.claude/settings.json.task' },
          { path: '.github/workflows/x.yml', task_copy: '.github/workflows/x.yml.task' }
        ]);
        await removeCopy(project, { id: 'mc0008', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // A side copy never overwrites a file that is already there.
      {
        const project = makeMergeProject('merge side copies', { 'x.bin': Buffer.from([0, 1, 2, 3]), 'y.bin': Buffer.from([0, 1, 2, 3]) });
        const copy = await makeCopy(project, 'mc0009');
        const taskBytes = Buffer.from([0, 9, 9, 9]);
        fs.writeFileSync(path.join(copy.worktree, 'x.bin'), taskBytes);
        fs.writeFileSync(path.join(copy.worktree, 'y.bin'), taskBytes);
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);
        fs.writeFileSync(path.join(project, 'x.bin'), Buffer.from([0, 5, 5]));
        fs.writeFileSync(path.join(project, 'y.bin'), Buffer.from([0, 6, 6]));
        fs.writeFileSync(path.join(project, 'x.bin.task'), 'precious');
        fs.writeFileSync(path.join(project, 'y.bin.task'), 'taken');
        for (let number = 2; number <= 20; number++) fs.writeFileSync(path.join(project, `y.bin.task.${number}`), 'taken');

        const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
        eq('mergeCopy side copies: only the file whose copy was saved is a conflict (y.bin is reported once, in skipped)', merged.conflicts, ['x.bin']);
        eq('mergeCopy side copies: the existing x.bin.task is left intact', readText(project, 'x.bin.task'), 'precious');
        eq('mergeCopy side copies: the copy goes to x.bin.task.2', Buffer.compare(fs.readFileSync(path.join(project, 'x.bin.task.2')), taskBytes), 0);
        eq('mergeCopy side copies: task_copies names it', merged.task_copies, [{ path: 'x.bin', task_copy: 'x.bin.task.2' }]);
        eq('mergeCopy side copies: with .task to .task.20 all taken, the failure is reported', merged.skipped, [{ path: 'y.bin', reason: 'could not save a side copy' }]);
        eq('mergeCopy side copies: the taken names are untouched', [readText(project, 'y.bin.task'), readText(project, 'y.bin.task.20')], ['taken', 'taken']);
        await removeCopy(project, { id: 'mc0009', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // Short (8.3) names are refused everywhere: on Windows CLAUDE~1 is the ignored .claude folder.
      {
        const project = makeMergeProject('merge short names', { '.gitignore': '.claude/\n', 'keep.txt': 'k\n' });
        writeText(project, '.claude/settings.json', '{"user":true}\n');
        const copy = await makeCopy(project, 'mc0010');
        eq('mergeCopy short names: the ignored .claude folder is not in the copy', fs.existsSync(path.join(copy.worktree, '.claude')), false);
        writeText(copy.worktree, 'CLAUDE~1/settings.json', '{"hooks":{"SessionStart":[]}}\n');
        writeText(copy.worktree, 'FOO~1/x.txt', 'x\n');
        writeText(copy.worktree, 'keep.txt', 'k\nchanged\n');
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);

        const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
        eq('mergeCopy short names: only the ordinary file is applied', merged.applied, ['keep.txt']);
        const reasonByPath = {};
        for (const entry of merged.skipped) reasonByPath[entry.path] = entry.reason;
        eq('mergeCopy short names: CLAUDE~1 and FOO~1 are refused as short names', [reasonByPath['CLAUDE~1/settings.json'], reasonByPath['FOO~1/x.txt']], ['short (8.3) name', 'short (8.3) name']);
        eq('mergeCopy short names: nothing held, no side copies', [merged.held, merged.task_copies], [[], []]);
        eq('mergeCopy short names: the real .claude/settings.json is unchanged', readText(project, '.claude/settings.json'), '{"user":true}\n');
        eq('mergeCopy short names: no short-name folder was created', [fs.existsSync(path.join(project, 'FOO~1')), fs.readdirSync(path.join(project, '.claude'))], [false, ['settings.json']]);
        await removeCopy(project, { id: 'mc0010', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // Anything under or named like a dot-path is held unless it is a known inert file.
      {
        const project = makeMergeProject('merge dot paths', { '.gitignore': 'node_modules/\n', 'keep.txt': 'k\n' });
        const copy = await makeCopy(project, 'mc0011');
        writeText(copy.worktree, '.gitignore', 'node_modules/\n*.log\n');
        writeText(copy.worktree, 'src/.editorconfig', 'root = true\n');
        for (const name of ['.cursor/rules.md', '.lfsconfig', 'src/.env.local', 'CLAUDE.md', 'docs/AGENTS.md', '.github/.gitignore', 'mise.toml', 'docs/gemini.MD']) {
          writeText(copy.worktree, name, 'task\n');
        }
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);

        const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
        eq('mergeCopy dot paths: the inert dot files are applied', merged.applied.slice().sort(), ['.gitignore', 'src/.editorconfig']);
        eq('mergeCopy dot paths: tool config, agent instructions and files under dot-folders are held', merged.held.map((entry) => entry.path).sort(), ['.cursor/rules.md', '.github/.gitignore', '.lfsconfig', 'CLAUDE.md', 'docs/AGENTS.md', 'docs/gemini.MD', 'mise.toml', 'src/.env.local'].sort());
        eq('mergeCopy dot paths: held files were not written in place', ['.cursor/rules.md', '.lfsconfig', 'src/.env.local', 'CLAUDE.md', 'docs/AGENTS.md', '.github/.gitignore', 'mise.toml'].map((name) => fs.existsSync(path.join(project, name))), [false, false, false, false, false, false, false]);
        await removeCopy(project, { id: 'mc0011', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // Executable config and agent instructions are held by pattern, also under lookalike spellings.
      {
        const project = makeMergeProject('merge held patterns', { 'keep.txt': 'k\n' });
        const copy = await makeCopy(project, 'mc0012');
        const heldNames = [
          '.prettierrc.cjs', '.prettierrc.ts', 'CLAUDE.local.md', 'docs/AGENTS.override.md', 'agent.md',
          'mise.local.toml', 'mise/config.toml', 'eslint.config.mjs', 'prettier.config.js',
          // prettier config can name plugins (code), mise reads several files in its folders
          '.prettierrc.json', '.prettierrc', 'mise/conf.d/x.toml', 'tools/mise/config.local.toml', 'tools/mıse/tasks.txt',
          // NFKC + case folding maps these to agents.md, mise.toml and claude.md
          'agentſ.md', 'mıse.toml', 'ＣＬＡＵＤＥ.md'
        ];
        const appliedNames = ['.editorconfig', 'src/app.config.js', 'vite.config.ts'];
        for (const name of [...heldNames, ...appliedNames]) writeText(copy.worktree, name, 'task\n');
        // Lookalikes of .git are refused outright.
        writeText(copy.worktree, '．git/config', 'task\n');
        writeText(copy.worktree, '.gıt/config', 'task\n');
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);

        const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
        eq('mergeCopy held patterns: held by pattern or lookalike fold', merged.held.map((entry) => entry.path).sort(), heldNames.slice().sort());
        eq('mergeCopy held patterns: inert config files are applied', merged.applied.slice().sort(), appliedNames.slice().sort());
        const refusedPaths = merged.skipped.filter((entry) => entry.reason === 'path is inside .git').map((entry) => entry.path).sort();
        eq('mergeCopy held patterns: lookalikes of .git are refused', refusedPaths, ['.gıt/config', '．git/config'].sort());
        eq('mergeCopy held patterns: held files were not written in place', heldNames.map((name) => fs.existsSync(path.join(project, name))), heldNames.map(() => false));
        await removeCopy(project, { id: 'mc0012', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }

      // A rename with either side held is held whole: the old file stays, the new content sits beside the new path.
      {
        const project = makeMergeProject('merge held rename', { 'scripts/setup.sh': 'echo setup\n', '.husky/pre-push': 'echo push\n', 'plain/a.txt': 'a\nb\nc\n' });
        const copy = await makeCopy(project, 'mc0013');
        fs.mkdirSync(path.join(copy.worktree, '.husky'), { recursive: true });
        fs.renameSync(path.join(copy.worktree, 'scripts', 'setup.sh'), path.join(copy.worktree, '.husky', 'setup.sh'));
        fs.renameSync(path.join(copy.worktree, '.husky', 'pre-push'), path.join(copy.worktree, 'scripts', 'pre-push.sh'));
        fs.renameSync(path.join(copy.worktree, 'plain', 'a.txt'), path.join(copy.worktree, 'plain', 'b.txt'));
        const endSha = await endSnapshot(copy.worktree, project, copy.start_commit);

        const merged = await mergeCopy(project, { start_commit: copy.start_commit, end_commit: endSha });
        eq('mergeCopy held rename: an ordinary rename is applied as before', merged.applied.slice().sort(), ['plain/a.txt', 'plain/b.txt']);
        eq('mergeCopy held rename: a rename into a held path is held, with the path it came from', merged.held.map((entry) => [entry.path, entry.renamed_from]).sort(), [['.husky/setup.sh', 'scripts/setup.sh'], ['scripts/pre-push.sh', '.husky/pre-push']]);
        eq('mergeCopy held rename: the old file of a rename into a held path is not deleted', readText(project, 'scripts/setup.sh'), 'echo setup\n');
        eq('mergeCopy held rename: the new content goes beside the held new path', readText(project, '.husky/setup.sh.task').replace(/\r\n/g, '\n'), 'echo setup\n');
        eq('mergeCopy held rename: the held new path itself is not written', fs.existsSync(path.join(project, '.husky', 'setup.sh')), false);
        eq('mergeCopy held rename: a rename out of a held path keeps the held old file too', [readText(project, '.husky/pre-push'), fs.existsSync(path.join(project, 'scripts', 'pre-push.sh'))], ['echo push\n', false]);
        eq('mergeCopy held rename: and saves the new content beside the new path', readText(project, 'scripts/pre-push.sh.task').replace(/\r\n/g, '\n'), 'echo push\n');
        eq('mergeCopy held rename: nothing conflicted or skipped', [merged.conflicts, merged.skipped], [[], []]);
        await removeCopy(project, { id: 'mc0013', worktree: copy.worktree, branch: copy.branch }, { keepBranch: false });
      }
    }
  }

  // ---- worker command lines and stream parsers ----
  {
    const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'delegate');
    const fixtureLines = (name) => fs.readFileSync(path.join(fixtureDir, name), 'utf8').split(/\r?\n/).filter(Boolean);
    const briefText = '# Brief\nAdd retries to the fetcher.\n';
    const defaultSettings = { timeout_ms: 180000, delegate: { time_limit_ms: 10800000 } };
    const codexThread = '01a1742b-62a9-7593-8add-31fd439d28dc';
    const sessionUuid = '8f14e45f-ceea-4e67-a2b1-3c5d9e0f7a12';
    const argAfter = (args, flag) => args[args.indexOf(flag) + 1];
    const mentionsBrief = (args) => args.some((arg) => arg.includes('Add retries'));

    eq('workerPreamble: the exact text',
      workerPreamble('C:\\p'),
      'You are working alone on a delegated task. Work only inside this folder: C:\\p. Do not run git commit, push, stash, checkout or reset. When you finish, end with a short summary: what you changed (files), how you checked it, and anything left undone.');

    const agyNoCommands = " You can't run commands here (no git, tests or builds): check your work by reading the files.";
    eq('workerPreamble: agy write is also told it cannot run commands', workerPreamble('C:\\p', true, 'agy'), workerPreamble('C:\\p').replace(' When you finish', `${agyNoCommands} When you finish`));
    eq('workerPreamble: agy read is also told it cannot run commands', workerPreamble('C:\\p', false, 'agy'), workerPreamble('C:\\p', false).replace(' When you finish', `${agyNoCommands} When you finish`));
    eq('workerPreamble: codex and local text is unchanged', [workerPreamble('C:\\p', true, 'codex'), workerPreamble('C:\\p', false, 'local'), workerPreamble('C:\\p').includes("can't run commands")], [workerPreamble('C:\\p'), workerPreamble('C:\\p', false), false]);
    eq('workerPreamble: a read task is told to answer in text and to end with findings, not "what you changed"',
      workerPreamble('C:\\p', false),
      'You are working alone on a delegated task. Work only inside this folder: C:\\p. This is a read-only task: answer in text. Do not create, edit or delete any files, and do not run git commit, push, stash, checkout or reset. When you finish, end with a short summary of your findings: what you looked at, what you found, and anything you could not check.');
    for (const word of ['codex', 'agy']) {
      const readTask = createTask(sampleSpec({ worker: word, mode: 'read' }));
      const readCommand = workerCommand(readTask, { settings: defaultSettings });
      const promptSent = readCommand.stdinText ?? readCommand.briefFile.text;
      eq(`${word} read: the prompt starts with the read-only preamble`, promptSent.startsWith(workerPreamble(readTask.project, false, word)), true);
      eq(`${word} read: and never asks for "what you changed"`, promptSent.includes('what you changed'), false);
    }
    const agyWriteForPreamble = workerCommand(createTask(sampleSpec({ worker: 'agy', mode: 'write' })), { settings: defaultSettings });
    eq('a write task keeps the write preamble', agyWriteForPreamble.stdinText.startsWith(workerPreamble(agyWriteForPreamble.cwd, true, 'agy')), true);

    // codex
    const codexTask = createTask(sampleSpec({ worker: 'codex', mode: 'write' }));
    const codexFolder = path.join(scratch, 'work tree');
    const codexWriteCommand = workerCommand({ ...codexTask, worktree: codexFolder }, { settings: defaultSettings });
    eq('codex write: sandbox, network, hooks off, stdin marker, no -C (the folder is only the cwd)',
      [argAfter(codexWriteCommand.args, '-s'), codexWriteCommand.args.includes('sandbox_workspace_write.network_access=true'), codexWriteCommand.args.includes('-C'), codexWriteCommand.args.includes(codexFolder), argAfter(codexWriteCommand.args, '--disable'), codexWriteCommand.args.at(-1)],
      ['workspace-write', true, false, false, 'hooks', '-']);
    eq('codex write: starts with exec --json, fenced, runs in the folder, no extra env',
      [codexWriteCommand.args.slice(0, 3), codexWriteCommand.fenced, codexWriteCommand.cwd, codexWriteCommand.env, codexWriteCommand.briefFile], [['exec', '--json', '--color'], true, codexFolder, {}, null]);
    eq('codex write: the brief goes on stdin after the preamble, never in argv',
      [codexWriteCommand.stdinText, mentionsBrief(codexWriteCommand.args)], [`${workerPreamble(codexFolder)}\n\n${briefText}`, false]);
    const codexRead = workerCommand(createTask(sampleSpec({ worker: 'codex', mode: 'read' })), { settings: defaultSettings });
    eq('codex read: read-only and no network flag', [argAfter(codexRead.args, '-s'), codexRead.args.some((arg) => arg.includes('network_access')), codexRead.args.includes('workspace-write')], ['read-only', false, false]);
    const codexTuned = workerCommand(createTask(sampleSpec({ worker: 'codex', model: 'gpt-6-astra', effort: 'high' })), { settings: defaultSettings });
    eq('codex: model and effort become -m and -c', [argAfter(codexTuned.args, '-m'), codexTuned.args.includes('model_reasoning_effort=high')], ['gpt-6-astra', true]);
    throws('codex: a bad effort is refused', () => workerCommand(createTask(sampleSpec({ worker: 'codex', effort: 'loud' })), { settings: defaultSettings }));
    const codexResumed = workerCommand({ ...codexTask, worktree: codexFolder, worker_session: codexThread }, { settings: defaultSettings, resume: true, followUp: 'Also add a test.' });
    eq('codex resume: exec resume with the sandbox as a config override, session then stdin marker, no -s/-C/--color',
      [codexResumed.args.slice(0, 2), codexResumed.args.includes('sandbox_mode=workspace-write'), codexResumed.args.slice(-2), ['-s', '-C', '--color'].some((flag) => codexResumed.args.includes(flag)), codexResumed.args.includes('sandbox_workspace_write.network_access=true'), codexResumed.args.includes('hooks')],
      [['exec', 'resume'], true, [codexThread, '-'], false, true, true]);
    eq('codex resume: the follow-up alone is the stdin text and the process runs in the folder', [codexResumed.stdinText, codexResumed.cwd], ['Also add a test.', codexFolder]);
    const codexResumedRead = workerCommand({ ...createTask(sampleSpec({ worker: 'codex', mode: 'read' })), worker_session: codexThread }, { settings: defaultSettings, resume: true });
    eq('codex resume (read task): read-only override, no network, the continue prompt behind the read-only reminder', [codexResumedRead.args.includes('sandbox_mode=read-only'), codexResumedRead.args.some((arg) => arg.includes('network_access')), codexResumedRead.stdinText], [true, false, `${READ_ONLY_REMINDER}\n\n${CONTINUE_PROMPT}`]);
    throws('codex resume: no session to resume', () => workerCommand(codexTask, { settings: defaultSettings, resume: true }));

    // agy
    const agyTask = createTask(sampleSpec({ worker: 'agy', mode: 'write' }));
    const agyWrite = workerCommand(agyTask, { settings: defaultSettings });
    eq('agy write: stream-json, accept-edits, sandbox, add-dir, print timeout, no -p',
      [agyWrite.args.slice(0, 3), argAfter(agyWrite.args, '--mode'), agyWrite.args.includes('--sandbox'), argAfter(agyWrite.args, '--add-dir'), argAfter(agyWrite.args, '--print-timeout'), agyWrite.args.includes('-p') || agyWrite.args.includes('--print')],
      [['--output-format', 'stream-json', '--disable-slash-commands'], 'accept-edits', true, agyTask.project, '9720s', false]);
    eq('agy write: not fenced, brief on stdin only', [agyWrite.fenced, agyWrite.stdinText, mentionsBrief(agyWrite.args), agyWrite.briefFile, agyWrite.cwd], [false, `${workerPreamble(agyTask.project, true, 'agy')}\n\n${briefText}`, false, null, agyTask.project]);
    const agyRead = workerCommand(createTask(sampleSpec({ worker: 'agy', mode: 'read', time_limit_ms: 600000, model: 'gemini-3.8-flash', effort: 'low' })), { settings: defaultSettings });
    eq('agy read: no --mode, the task time limit, model and effort', [agyRead.args.includes('--mode'), argAfter(agyRead.args, '--print-timeout'), argAfter(agyRead.args, '--model'), argAfter(agyRead.args, '--effort')], [false, '540s', 'gemini-3.8-flash', 'low']);
    const agyResumed = workerCommand({ ...agyTask, worker_session: sessionUuid }, { settings: defaultSettings, resume: true, followUp: 'Next step.' });
    eq('agy resume: --conversation with the id, the follow-up on stdin', [argAfter(agyResumed.args, '--conversation'), agyResumed.stdinText], [sessionUuid, 'Next step.']);
    throws('agy: a bad effort is refused', () => workerCommand(createTask(sampleSpec({ worker: 'agy', effort: 'loud' })), { settings: defaultSettings }));

    // local (pi)
    const keySentinel = 'sk-test-sentinel-not-a-real-key';
    const originalKey = process.env.LLAMA_SWAP_API_KEY;
    process.env.LLAMA_SWAP_API_KEY = keySentinel;
    try {
      const swapRunner = {
        type: 'llama-swap', legacy: false, url: 'http://127.0.0.1:9292/v1', key_env: 'LLAMA_SWAP_API_KEY', start: null, api_key: null,
        nicknames: { default: 'qwen3.5-27b', fast: 'qwen3.5-4b', vision: null, vision_best: null, big: null }
      };
      const swapInventory = swapFacts({ data: [
        { id: 'qwen3.5-4b', context_length: 32768 },
        { id: 'qwen3.5-27b', context_length: 8192 }
      ] });
      const localTask = createTask(sampleSpec({ worker: 'local', mode: 'write' }));
      eq('createTask: a local task gets a pi session uuid, other workers none', [/^[0-9a-f-]{36}$/.test(localTask.pi_session), codexTask.pi_session], [true, null]);
      const localCommand = workerCommand({ ...localTask, model: 'fast' }, { settings: defaultSettings, runner: swapRunner, inventory: swapInventory });
      const taskDir = taskFolder(localTask.id);
      eq('local: pi json print mode with the extension, the resolved model and a fresh session id',
        [localCommand.args.slice(0, 7), argAfter(localCommand.args, '-e'), argAfter(localCommand.args, '--provider'), argAfter(localCommand.args, '--model'), argAfter(localCommand.args, '--session-dir'), argAfter(localCommand.args, '--session-id'), localCommand.args.includes('--session')],
        [['--mode', 'json', '-p', '--no-mcp', '--no-skills', '--no-extensions', '--no-prompt-templates'], path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'pi-provider.js'), 'consult-local', 'qwen3.5-4b', path.join(taskDir, 'pi-sessions'), localTask.pi_session, false]);
      eq('local: --no-approve, and the brief file is the last argument', [localCommand.args.includes('--no-approve'), localCommand.args.at(-1)], [true, `@${path.join(taskDir, 'prompt.md')}`]);
      eq('local: the brief is a file with the preamble, stdin is empty, not fenced',
        [localCommand.briefFile, localCommand.stdinText, localCommand.fenced, mentionsBrief(localCommand.args), localCommand.cwd],
        [{ path: path.join(taskDir, 'prompt.md'), text: `${workerPreamble(localTask.project)}\n\n${briefText}` }, null, false, false, localTask.project]);
      eq('local: env names the runner, the model, the context and the key VARIABLE',
        localCommand.env, { CONSULT_PI_BASE_URL: 'http://127.0.0.1:9292/v1', CONSULT_PI_MODEL: 'qwen3.5-4b', CONSULT_PI_KEY_ENV: 'LLAMA_SWAP_API_KEY', CONSULT_PI_CONTEXT: '32768' });
      eq('local: the key value is nowhere in the command', JSON.stringify(localCommand).includes(keySentinel), false);
      eq('local: no warning for a roomy model', localCommand.warning, null);
      const localReadTask = createTask(sampleSpec({ worker: 'local', mode: 'read' }));
      const localReadCommand = workerCommand({ ...localReadTask, model: 'fast' }, { settings: defaultSettings, runner: swapRunner, inventory: swapInventory });
      eq('local read: the brief file starts with the read-only preamble', localReadCommand.briefFile.text.startsWith(workerPreamble(localReadTask.project, false)), true);
      const bigCommand = workerCommand(localTask, { settings: defaultSettings, runner: swapRunner, inventory: swapInventory });
      eq('local: the default nickname resolves, and a small context warns', [bigCommand.model, bigCommand.env.CONSULT_PI_CONTEXT, typeof bigCommand.warning], ['qwen3.5-27b', '8192', 'string']);
      const wordCommand = workerCommand({ ...localTask, worker: 'local:fast' }, { settings: defaultSettings, runner: swapRunner, inventory: swapInventory });
      eq('local: a local:<nickname> worker word picks the nickname', wordCommand.model, 'qwen3.5-4b');
      const localResumed = workerCommand(localTask, { settings: defaultSettings, runner: swapRunner, inventory: swapInventory, resume: true, followUp: 'More.' });
      eq('local resume: --session with the same uuid, the follow-up as a file',
        [argAfter(localResumed.args, '--session'), localResumed.args.includes('--session-id'), localResumed.args.at(-1), localResumed.briefFile],
        [localTask.pi_session, false, `@${path.join(taskDir, 'followup.md')}`, { path: path.join(taskDir, 'followup.md'), text: 'More.' }]);
      const keylessRunner = { ...swapRunner, key_env: null };
      const keylessCommand = workerCommand(localTask, { settings: defaultSettings, runner: keylessRunner, inventory: swapInventory });
      eq('local: a runner without a key sets no key variable', 'CONSULT_PI_KEY_ENV' in keylessCommand.env, false);
      throws('local: a key variable with a runner that is not on this machine is refused', () => workerCommand(localTask, { settings: defaultSettings, runner: { ...swapRunner, url: 'http://example.com/v1' }, inventory: swapInventory }));
      throws('local: a key held in local_api_key cannot reach pi and is refused', () => workerCommand(localTask, { settings: defaultSettings, runner: { ...swapRunner, legacy: true, type: null, key_env: null, api_key: keySentinel }, inventory: null }));
      throws('local: no runner is refused', () => workerCommand(localTask, { settings: defaultSettings }));
    } finally {
      if (originalKey === undefined) delete process.env.LLAMA_SWAP_API_KEY; else process.env.LLAMA_SWAP_API_KEY = originalKey;
    }
    throws('workerCommand: an unknown worker is refused', () => workerCommand({ ...codexTask, worker: 'gizmo' }, { settings: defaultSettings }));

    // fix round 1: command lines
    {
      const fixRunner = {
        type: 'llama-swap', legacy: false, url: 'http://127.0.0.1:9292/v1', key_env: null, start: null, api_key: null,
        nicknames: { default: 'qwen3.5-4b', fast: null, vision: null, vision_best: null, big: null }
      };
      const fixInventory = swapFacts({ data: [{ id: 'qwen3.5-4b', context_length: 32768 }] });
      const readLocal = workerCommand(createTask(sampleSpec({ worker: 'local', mode: 'read' })), { settings: defaultSettings, runner: fixRunner, inventory: fixInventory });
      eq('local read: pi gets only its read-only built-in tools', argAfter(readLocal.args, '--tools'), 'read,grep,find,ls');
      eq('local read: no write, edit, bash or powershell tool, and project files stay ignored',
        [['write', 'edit', 'bash', 'powershell'].some((name) => argAfter(readLocal.args, '--tools').split(',').includes(name)), readLocal.args.includes('--no-approve')], [false, true]);
      const writeLocal = workerCommand(createTask(sampleSpec({ worker: 'local', mode: 'write' })), { settings: defaultSettings, runner: fixRunner, inventory: fixInventory });
      eq('local write: the default tools (no --tools), project files still ignored', [writeLocal.args.includes('--tools'), writeLocal.args.includes('--no-approve')], [false, true]);

      throws('codex: a model id starting with - is refused', () => workerCommand(createTask(sampleSpec({ worker: 'codex', model: '-evil' })), { settings: defaultSettings }));
      throws('agy: a model id starting with - is refused', () => workerCommand(createTask(sampleSpec({ worker: 'agy', model: '--sandbox' })), { settings: defaultSettings }));
      throws('local: a model id starting with - (after the nickname resolves) is refused',
        () => workerCommand(createTask(sampleSpec({ worker: 'local' })), { settings: defaultSettings, runner: { ...fixRunner, nicknames: { ...fixRunner.nicknames, default: '-evil' } }, inventory: null }));
      throws('codex resume: a session id starting with - is refused', () => workerCommand({ ...codexTask, worker_session: '--------' }, { settings: defaultSettings, resume: true }));

      const printSeconds = Number(argAfter(agyWrite.args, '--print-timeout').replace('s', ''));
      truthy('agy: --print-timeout ends before the task time limit, so agy emits its partial before the supervisor kills it', printSeconds > 0 && printSeconds < 10800);

      if (process.platform === 'win32') {
        const ampersandFolder = path.join(scratch, 'R&D');
        let agyRefusal = '';
        try { workerCommand({ ...agyTask, worktree: ampersandFolder }, { settings: defaultSettings }); } catch (error) { agyRefusal = error.message; }
        truthy('agy: a folder cmd.exe cannot pass is refused naming the folder and the character', agyRefusal.includes(ampersandFolder) && agyRefusal.includes('&'));
        let localRefusal = '';
        try { workerCommand({ ...createTask(sampleSpec({ worker: 'local' })), dir: path.join(scratch, 'a%b') }, { settings: defaultSettings, runner: fixRunner, inventory: fixInventory }); } catch (error) { localRefusal = error.message; }
        truthy('local: a task folder cmd.exe cannot pass is refused naming the folder and the character', localRefusal.includes('a%b') && localRefusal.includes('%'));
        const codexInAmpersand = workerCommand({ ...codexTask, worktree: ampersandFolder }, { settings: defaultSettings });
        eq('codex: the folder is only the cwd, so any folder works', codexInAmpersand.cwd, ampersandFolder);
      }
    }

    // contextWarning
    eq('contextWarning: 8192 is a sentence naming the model', /qwen3\.5-27b.*8192/.test(contextWarning({ id: 'qwen3.5-27b', context: 8192 })), true);
    eq('contextWarning: 32768 and 16384 are fine', [contextWarning({ id: 'm', context: 32768 }), contextWarning({ id: 'm', context: 16384 })], [null, null]);
    eq('contextWarning: an unknown context is no warning', [contextWarning({ id: 'm', context: null }), contextWarning(null)], [null, null]);

    // steps started and not finished (the watchdog is suspended while one is open)
    const openSteps = new Set();
    const stepsAfter = (worker, event) => { noteStepEvent(worker, JSON.stringify(event), openSteps); return [...openSteps]; };
    eq('steps codex: a command started is open', stepsAfter('codex', { type: 'item.started', item: { id: 'item_1', type: 'command_execution' } }), ['item_1']);
    eq('steps codex: an agent message is not a step', stepsAfter('codex', { type: 'item.started', item: { id: 'item_2', type: 'agent_message' } }), ['item_1']);
    eq('steps codex: the same item completed closes it', stepsAfter('codex', { type: 'item.completed', item: { id: 'item_1', type: 'command_execution' } }), []);
    eq('steps agy: an ACTIVE tool step is open, DONE closes it', [stepsAfter('agy', { event: 'step_update', step_update: { step_index: 4, state: 'ACTIVE', step_type: 'tool' } }), stepsAfter('agy', { event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'tool' } })], [['4'], []]);
    eq('steps agy: streaming text is not a step', stepsAfter('agy', { event: 'step_update', step_update: { step_index: 5, state: 'ACTIVE', step_type: 'agent_response' } }), []);
    eq('steps local (pi): tool_execution_start opens, tool_execution_end closes', [stepsAfter('local', { type: 'tool_execution_start', toolCallId: 'call_1' }), stepsAfter('local', { type: 'tool_execution_end', toolCallId: 'call_1' })], [['call_1'], []]);
    eq('steps: a line that is not JSON changes nothing', (noteStepEvent('codex', 'not json {', openSteps), [...openSteps]), []);

    // codex stream
    const codexParsed = parseWorkerStream('codex', fixtureLines('codex-write.jsonl'));
    eq('parse codex: session, the LAST agent message, nothing else',
      codexParsed, { finalMessage: 'Created `hello.txt` containing exactly `hi` (no newline). Node printed `1`. PowerShell’s `curl` alias rejected `-sI`; `curl.exe -sI https://example.com` then exited with code 1 and no output.', session: codexThread, limit: null, limitHit: null, error: null, denied: [], complete: true });
    const codexResumeParsed = parseWorkerStream('codex', fixtureLines('codex-resume.jsonl'));
    eq('parse codex resume: same thread, the new turn\'s message', [codexResumeParsed.session, codexResumeParsed.finalMessage.startsWith('Exit code: 1')], [codexThread, true]);
    const codexLimitStream = (event) => [JSON.stringify({ type: 'thread.started', thread_id: codexThread }), JSON.stringify(event)];
    eq('parse codex: an error event naming the usage limit is exhausted', parseWorkerStream('codex', codexLimitStream({ type: 'error', message: 'You\'ve hit your usage limit.' })).limitHit, { kind: 'exhausted', resets_at: null });
    eq('parse codex: a turn.failed naming a rate limit is throttled', parseWorkerStream('codex', codexLimitStream({ type: 'turn.failed', error: { message: '429 Too Many Requests' } })).limitHit, { kind: 'throttled', resets_at: null });
    const codexFailed = parseWorkerStream('codex', codexLimitStream({ type: 'turn.failed', error: { message: 'stream disconnected' } }));
    eq('parse codex: any other failure is the error', [codexFailed.error, codexFailed.limitHit], ['stream disconnected', null]);
    const codexRecovered = parseWorkerStream('codex', [...codexLimitStream({ type: 'error', message: 'Reconnecting... 1/5' }), JSON.stringify({ type: 'turn.completed', usage: {} })]);
    eq('parse codex: an error the turn recovered from is no error', [codexRecovered.error, codexRecovered.limitHit], [null, null]);
    eq('parse codex: unknown events and junk lines are skipped', parseWorkerStream('codex', ['not json', '{"type":"mystery"}', '[1]', '']).session, null);

    // codex limits from the rollout file
    const codexHomeFixture = path.join(fixtureDir, 'codex-home');
    const rolloutLimits = codexRolloutLimits(codexThread, { codexHome: codexHomeFixture });
    eq('codexRolloutLimits: the last token_count with rate_limits wins', [rolloutLimits.limit.primary.used_percent, rolloutLimits.limit.secondary.used_percent, rolloutLimits.limit.primary.resets_at, rolloutLimits.limitHit], [3, 1, 1792968375, null]);
    const reachedLimits = codexRolloutLimits('01a1742b-ffff-7000-8000-00000000cafe', { codexHome: codexHomeFixture });
    eq('codexRolloutLimits: a reached limit is exhausted with its window\'s reset', [reachedLimits.limit.primary.used_percent, reachedLimits.limitHit], [100, { kind: 'exhausted', resets_at: 1792975000000 }]);
    eq('codexRolloutLimits: no rollout for the thread gives nulls', codexRolloutLimits('01a1742b-0000-7000-8000-000000000000', { codexHome: codexHomeFixture }), { limit: null, limitHit: null });
    eq('codexRolloutLimits: no codex home gives nulls', codexRolloutLimits(codexThread, { codexHome: path.join(scratch, 'no-such-home') }), { limit: null, limitHit: null });
    const typedHome = path.join(scratch, 'typed-home', 'sessions', '2026', '10', '26');
    fs.mkdirSync(typedHome, { recursive: true });
    const typedLine = (reachedType, primaryPercent, secondaryPercent) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: primaryPercent, resets_at: 100 }, secondary: { used_percent: secondaryPercent, resets_at: 900 }, rate_limit_reached_type: reachedType } } }) + '\n';
    fs.writeFileSync(path.join(typedHome, 'rollout-2026-10-26T00-00-00-aaaaaaaa-0000-7000-8000-000000000001.jsonl'), typedLine('primary', 50, 10));
    fs.writeFileSync(path.join(typedHome, 'rollout-2026-10-26T00-00-00-aaaaaaaa-0000-7000-8000-000000000002.jsonl'), typedLine(null, 20, 100));
    fs.writeFileSync(path.join(typedHome, 'rollout-2026-10-26T00-00-00-aaaaaaaa-0000-7000-8000-000000000003.jsonl'), typedLine(null, 100, 100));
    eq('codexRolloutLimits: a reached type with no full window uses the primary reset', codexRolloutLimits('aaaaaaaa-0000-7000-8000-000000000001', { codexHome: path.join(scratch, 'typed-home') }).limitHit, { kind: 'exhausted', resets_at: 100000 });
    eq('codexRolloutLimits: a full secondary window alone is exhausted at its reset', codexRolloutLimits('aaaaaaaa-0000-7000-8000-000000000002', { codexHome: path.join(scratch, 'typed-home') }).limitHit, { kind: 'exhausted', resets_at: 900000 });
    eq('codexRolloutLimits: with both full, the later reset', codexRolloutLimits('aaaaaaaa-0000-7000-8000-000000000003', { codexHome: path.join(scratch, 'typed-home') }).limitHit, { kind: 'exhausted', resets_at: 900000 });

    // agy stream
    const agyParsed = parseWorkerStream('agy', fixtureLines('agy-write.jsonl'));
    eq('parse agy: conversation id, the result response, no denials',
      [agyParsed.session, agyParsed.finalMessage.startsWith('Created [agy-hello.txt]'), agyParsed.denied, agyParsed.error, agyParsed.limit, agyParsed.limitHit], ['23a2619a-a1a0-45b9-9299-40302c25505f', true, [], null, null, null]);
    const agyDenied = parseWorkerStream('agy', fixtureLines('agy-command-denied.jsonl'));
    eq('parse agy: an empty response with a denied command is "was refused"', [agyDenied.error, agyDenied.finalMessage, agyDenied.denied, agyDenied.session], ['agy was refused: RunCommand', null, [{ action: 'command', display_name: 'RunCommand' }], '38fcf5f3-0e07-4186-8344-218c814b5d37']);
    const agyFence = parseWorkerStream('agy', fixtureLines('agy-fence.jsonl'));
    eq('parse agy: a denied write is reported', [agyFence.error, agyFence.denied.length], ['agy was refused: WriteFile', 1]);
    const quotaLine = 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"message":"Quota exceeded for this account","retryable":false}\n';
    const agyQuota = parseWorkerStream('agy', [], { stderr: quotaLine });
    eq('parse agy: a quota error line on stderr is exhausted', [agyQuota.limitHit, agyQuota.error], [{ kind: 'exhausted', resets_at: null }, null]);
    const agyThrottled = parseWorkerStream('agy', [], { stderr: 'AGY_ERROR: {"status":"UNAVAILABLE","code":429,"message":"Too many requests","retryable":true}\n' });
    eq('parse agy: a 429 without a quota word is throttled', agyThrottled.limitHit, { kind: 'throttled', resets_at: null });
    const agyOther = parseWorkerStream('agy', fixtureLines('agy-write.jsonl'), { stderr: 'AGY_ERROR: {"status":"INTERNAL","code":500,"message":"backend fell over"}\n' });
    eq('parse agy: another error line is the error, the answer is kept', [agyOther.error, agyOther.finalMessage !== null, agyOther.limitHit], ['INTERNAL: backend fell over', true, null]);
    const agyBadStatus = parseWorkerStream('agy', [JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'ERROR', response: '', error: 'model refused' } })]);
    eq('parse agy: a non-SUCCESS result is an error', agyBadStatus.error, 'agy returned status=ERROR: model refused');
    const agyBadQuota = parseWorkerStream('agy', [JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'ERROR', response: '', message: 'RESOURCE_EXHAUSTED: quota' } })]);
    eq('parse agy: a non-SUCCESS result about quota is exhausted', [agyBadQuota.limitHit, agyBadQuota.error], [{ kind: 'exhausted', resets_at: null }, null]);
    eq('parse agy: a print-timeout partial is an error', parseWorkerStream('agy', fixtureLines('agy-write.jsonl'), { stderr: '[agy] print timeout after 2s with turn in progress; returning partial output\n' }).error, 'agy stopped at its time limit; its answer is partial.');

    // pi stream
    const piParsed = parseWorkerStream('local', fixtureLines('pi-write.jsonl'));
    eq('parse pi: session id from line 1, the last assistant text, no error', piParsed, { finalMessage: 'Created pi-hello.txt with the content "hi".', session: '01a17449-9a07-757c-aaea-181cb6f2bca2', limit: null, limitHit: null, error: null, denied: [], complete: true });
    const piResumed = parseWorkerStream('local', fixtureLines('pi-resume.jsonl'));
    eq('parse pi resume: the new turn\'s answer', [piResumed.session, piResumed.finalMessage], ['eb8ee81f-4fce-4052-9c39-405dfb40d096', 'pi-two.txt']);
    const piAuth = parseWorkerStream('local', fixtureLines('pi-error-auth.jsonl'));
    eq('parse pi: stopReason error is the error message', [piAuth.error.startsWith('401: '), piAuth.finalMessage, piAuth.limitHit], [true, null, null]);
    const piConnect = parseWorkerStream('local', fixtureLines('pi-error-connect.jsonl'));
    eq('parse pi: after the retries the last attempt\'s error stands', [piConnect.error, piConnect.finalMessage], ['Connection error.', null]);
    const piThrottled = parseWorkerStream('local', [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: '429: rate limit reached' }] })
    ]);
    eq('parse pi: a rate limit error is throttled, not an error', [piThrottled.limitHit, piThrottled.error], [{ kind: 'throttled', resets_at: null }, null]);
    // Only the phrasings of a usage limit count: a word like quota or a number like 429 alone is no limit.
    const limitOf = (message) => parseWorkerStream('codex', codexLimitStream({ type: 'error', message })).limitHit;
    const exhausted = { kind: 'exhausted', resets_at: null };
    const throttled = { kind: 'throttled', resets_at: null };
    for (const message of ['You\'ve hit your usage limit.', 'RESOURCE_EXHAUSTED: quota', 'insufficient_quota', 'You exceeded your current quota, please check your plan', 'Quota exceeded for this account', 'quota exceeded for metric generate_requests_per_day', 'Quota limit reached for tokens per minute']) {
      eq('parse codex: "' + message + '" is exhausted', limitOf(message), exhausted);
    }
    for (const message of ['Rate limit reached', 'request was rate-limited', 'Too Many Requests', '429 Too Many Requests', 'unexpected status 429', 'error code: 429', 'HTTP 429', 'HTTP/1.1 429 Slow down', '{"code":429,"message":"slow down"}']) {
      eq('parse codex: "' + message + '" is throttled', limitOf(message), throttled);
    }
    for (const message of ['Disk quota exceeded', 'SyntaxError at line 429', 'error code 4290', 'wrote 429 bytes', 'quota.json was not found']) {
      const notLimit = parseWorkerStream('codex', codexLimitStream({ type: 'error', message }));
      eq('parse codex: "' + message + '" is an error, not a limit', [notLimit.limitHit, notLimit.error], [null, message]);
    }
    const piOdd = parseWorkerStream('local', [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'SyntaxError at line 429' }] })
    ]);
    eq('parse pi: a line number 429 is an error, not a throttle', [piOdd.limitHit, piOdd.error], [null, 'SyntaxError at line 429']);
    const agyDisk = parseWorkerStream('agy', [], { stderr: 'AGY_ERROR: {"status":"INTERNAL","code":500,"message":"Disk quota exceeded"}\n' });
    eq('parse agy: a disk quota error is an error, not a limit', [agyDisk.limitHit, agyDisk.error], [null, 'INTERNAL: Disk quota exceeded']);
    eq('parse pi: a stream with no agent_end has nothing', parseWorkerStream('local', [JSON.stringify({ type: 'session', id: 's1' })]).finalMessage, null);
    throws('parse: an unknown worker is refused', () => parseWorkerStream('gizmo', []));

    // fix round 1: parsing fails closed
    {
      const codexLines = (...events) => events.map((event) => JSON.stringify(event));
      const started = { type: 'thread.started', thread_id: codexThread };
      const message = { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I will start.' } };
      const failedWithCode = parseWorkerStream('codex', codexLines(started, message, { type: 'turn.failed', error: { code: 'x' } }));
      eq('parse codex: a turn.failed with no message is still a failure', [failedWithCode.error, failedWithCode.finalMessage, failedWithCode.complete], ['codex turn failed {"code":"x"}', 'I will start.', true]);
      const failedWithNull = parseWorkerStream('codex', codexLines(started, message, { type: 'turn.failed', error: null }));
      eq('parse codex: a turn.failed with a null error is still a failure', failedWithNull.error, 'codex turn failed null');
      const failedWithBlank = parseWorkerStream('codex', codexLines(started, { type: 'turn.failed', error: { message: '  ' } }));
      truthy('parse codex: a blank message counts as no message', failedWithBlank.error.startsWith('codex turn failed'));
      const errorWithoutMessage = parseWorkerStream('codex', codexLines(started, { type: 'error', code: 7 }));
      truthy('parse codex: an error event with no message is still a failure', typeof errorWithoutMessage.error === 'string' && errorWithoutMessage.error.startsWith('codex error'));
      const failedHuge = parseWorkerStream('codex', codexLines(started, { type: 'turn.failed', error: { blob: 'y'.repeat(900) } }));
      truthy('parse codex: the JSON of an odd error is cut to 200 characters', failedHuge.error.length <= 'codex turn failed '.length + 200);
      eq('parse codex: a limit message in a turn.failed still counts', parseWorkerStream('codex', codexLines(started, { type: 'turn.failed', error: { message: 'usage limit reached' } })).limitHit, { kind: 'exhausted', resets_at: null });

      // complete: only when the terminal event was seen
      const withoutLast = (name) => fixtureLines(name).slice(0, -1);
      eq('parse codex: complete after turn.completed, not when cut before it',
        [parseWorkerStream('codex', fixtureLines('codex-write.jsonl')).complete, parseWorkerStream('codex', withoutLast('codex-write.jsonl')).complete], [true, false]);
      eq('parse codex: the cut stream still has what came before', parseWorkerStream('codex', withoutLast('codex-write.jsonl')).session, codexThread);
      eq('parse codex: complete after turn.failed', parseWorkerStream('codex', codexLines(started, { type: 'turn.failed', error: { message: 'boom' } })).complete, true);
      eq('parse codex: a lone error event is not the end', parseWorkerStream('codex', codexLines(started, { type: 'error', message: 'boom' })).complete, false);
      eq('parse agy: complete with the result line, not without',
        [parseWorkerStream('agy', fixtureLines('agy-write.jsonl')).complete, parseWorkerStream('agy', withoutLast('agy-write.jsonl')).complete, parseWorkerStream('agy', withoutLast('agy-write.jsonl')).session],
        [true, false, '23a2619a-a1a0-45b9-9299-40302c25505f']);
      eq('parse agy: the other agy fixtures are complete', [parseWorkerStream('agy', fixtureLines('agy-fence.jsonl')).complete, parseWorkerStream('agy', fixtureLines('agy-command-denied.jsonl')).complete], [true, true]);
      eq('parse pi: complete with agent_settled', parseWorkerStream('local', fixtureLines('pi-write.jsonl')).complete, true);
      eq('parse pi: with agent_settled cut off, a final agent_end (willRetry false) is still complete', parseWorkerStream('local', withoutLast('pi-write.jsonl')).complete, true);
      eq('parse pi: cut before the agent_end is not complete', parseWorkerStream('local', fixtureLines('pi-write.jsonl').slice(0, -2)).complete, false);
      const connectLines = fixtureLines('pi-error-connect.jsonl');
      let firstAgentEnd = -1;
      for (let index = 0; index < connectLines.length && firstAgentEnd === -1; index++) {
        if (connectLines[index].startsWith('{"type":"agent_end"')) firstAgentEnd = index;
      }
      const midRetry = parseWorkerStream('local', connectLines.slice(0, firstAgentEnd + 1));
      eq('parse pi: cut during the retries (willRetry true, no settle) is not complete', [midRetry.complete, midRetry.error], [false, 'Connection error.']);
      eq('parse pi: the settled error fixtures are complete', [parseWorkerStream('local', connectLines).complete, parseWorkerStream('local', fixtureLines('pi-error-auth.jsonl')).complete], [true, true]);
      const piAborted = parseWorkerStream('local', [...fixtureLines('pi-write.jsonl').slice(0, -1), JSON.stringify({ type: 'agent_settled', aborted: true })]);
      eq('parse pi: an aborted settle is an error', [piAborted.error, piAborted.complete], ['pi aborted', true]);

      // agy edges
      const agyResult = (result) => [JSON.stringify({ event: 'init', conversation_id: 'c1' }), JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '', ...result } })];
      const junkDenied = parseWorkerStream('agy', agyResult({ denied_actions: [null, 'x', 5, { action: 'command' }, {}, { display_name: 'WriteFile', action: 'write_file' }] }));
      eq('parse agy: denied entries that are not objects are dropped, names fall back to action then unknown',
        [junkDenied.denied, junkDenied.error], [[{ action: 'command' }, {}, { display_name: 'WriteFile', action: 'write_file' }], 'agy was refused: command, unknown, WriteFile']);
      const refusedWithError = parseWorkerStream('agy', agyResult({ denied_actions: [{ action: 'command', display_name: 'RunCommand' }] }), { stderr: 'AGY_ERROR: {"status":"INTERNAL","code":500,"message":"backend fell over"}\n' });
      eq('parse agy: a refusal keeps priority and gets the agy error appended', refusedWithError.error, 'agy was refused: RunCommand (also: INTERNAL: backend fell over)');
      const refusedWithQuota = parseWorkerStream('agy', agyResult({ denied_actions: [{ action: 'command', display_name: 'RunCommand' }] }), { stderr: quotaLine });
      eq('parse agy: a quota hit wins over a refusal, and then there is no error', [refusedWithQuota.limitHit, refusedWithQuota.error], [{ kind: 'exhausted', resets_at: null }, null]);
      const quotaOverPartial = parseWorkerStream('agy', fixtureLines('agy-write.jsonl'), { stderr: `${quotaLine}[agy] print timeout after 2s with turn in progress; returning partial output\n` });
      eq('parse agy: a quota hit also silences the partial-output error', quotaOverPartial.error, null);
      const envelopeQuotaPlainError = parseWorkerStream('agy',
        [JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'ERROR', response: '', message: 'RESOURCE_EXHAUSTED: quota' } })],
        { stderr: 'AGY_ERROR: {"status":"INTERNAL","message":"later hiccup"}\n' });
      eq('parse agy: a quota in the envelope is not lost to a later plain stderr error', [envelopeQuotaPlainError.limitHit, envelopeQuotaPlainError.error], [{ kind: 'exhausted', resets_at: null }, null]);
    }
  }

  // ---- the supervisor ----
  // Real supervisor processes (launchSupervisor) and the fake worker. The data
  // home, the projects and the worker script all sit under paths with a space
  // and Cyrillic (Review Focus 5); the worker, its cmd.exe shell and a
  // grandchild all start through the real spawn path.
  {
    const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'delegate');
    const supervisorHome = path.join(scratch, 'delegate Имя home');
    const projectsRoot = path.join(scratch, 'проекты Имя projects');
    const fakeUserHome = path.join(scratch, 'fake user home');
    const emptyCodexHome = path.join(scratch, 'empty codex home');
    const fakeWorkerPath = path.join(scratch, 'worker Имя bin', 'fake-worker.js');
    fs.mkdirSync(path.dirname(fakeWorkerPath), { recursive: true });
    fs.copyFileSync(path.join(fixtureRoot, 'fake-worker.js'), fakeWorkerPath);
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(fakeUserHome, { recursive: true });
    fs.mkdirSync(emptyCodexHome, { recursive: true });
    const hereProject = path.join(projectsRoot, 'plain Имя project');
    fs.mkdirSync(hereProject, { recursive: true });

    const BACKSTOP_MS = 25000; // a hang test that leaks stops itself
    const ENDED_STATES = ['done', 'held', 'failed', 'paused-limit', 'stopped', 'cancelled'];
    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const gitSync = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const sameFolder = (first, second) => fs.realpathSync.native(first).toLowerCase() === fs.realpathSync.native(second).toLowerCase();
    const isProcessAlive = (pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
    };
    const commandLineOf = (pid) => {
      try {
        if (process.platform === 'win32') {
          return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true });
        }
        return execFileSync('ps', ['-p', String(Number(pid)), '-o', 'args='], { encoding: 'utf8' });
      } catch (_) {
        return '';
      }
    };
    // A pid is only killed when its command line is still one of ours: a recycled pid must never take down a user's process.
    const killProcessTreeIfOurs = (pid) => {
      if (!/delegate-run\.js|fake-worker\.js|consult-fake-grandchild/.test(commandLineOf(pid))) return;
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(pid, 'SIGKILL');
      } catch (_) { /* already gone */ }
    };

    const savedEnv = {};
    const setEnv = (name, value) => {
      if (!(name in savedEnv)) savedEnv[name] = process.env[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    };
    const restoreEnv = () => {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
        delete savedEnv[name];
      }
    };

    const launchedPids = [];
    const recordedGrandchildPids = [];
    const supervisorEnv = (extra) => ({
      ...process.env,
      CONSULT_DELEGATE_TEST_BIN: fakeWorkerPath,
      CODEX_HOME: emptyCodexHome,
      CONSULT_NO_USER_ENV: '1',
      USERPROFILE: fakeUserHome,
      HOME: fakeUserHome,
      CONSULT_DELEGATE_WATCHDOG_MS: '600000',
      CONSULT_DELEGATE_POLL_MS: '200',
      ...extra
    });
    const launchWith = (task, extra = {}) => {
      const pid = launchSupervisor(task.id, { env: supervisorEnv(extra) });
      launchedPids.push(pid);
      return pid;
    };
    const waitForTask = async (id, isWanted, timeoutMs = 30000) => {
      const giveUpAt = Date.now() + timeoutMs;
      while (Date.now() < giveUpAt) {
        const current = readTask(id);
        if (current !== null && isWanted(current)) return current;
        await sleep(50);
      }
      return readTask(id);
    };
    const hasEnded = (task) => ENDED_STATES.includes(task.state);
    const isRunning = (task) => task.state === 'running' && task.started_at !== null;
    const newTask = (overrides = {}) => createTask({
      worker: 'codex', mode: 'write', location: 'here', project: hereProject, title: 'fake worker',
      brief: 'Do the thing.\n', time_limit_ms: BACKSTOP_MS, ...overrides
    });
    const makeRepo = (folderName, files) => {
      const repo = path.join(projectsRoot, folderName);
      for (const [relative, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
        fs.writeFileSync(path.join(repo, relative), text);
      }
      gitSync(repo, 'init');
      gitSync(repo, 'add', '-A');
      gitSync(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'first');
      return repo;
    };
    const newCopyTask = async (project, overrides = {}) => {
      const task = newTask({ location: 'copy', project, ...overrides });
      const copy = await makeCopy(project, task.id);
      return updateTask(task.id, { worktree: copy.worktree, branch: copy.branch, start_commit: copy.start_commit });
    };
    const reportFileFor = (task) => path.join(scratch, `fake-report-${task.id}.json`);
    const leftoverFakeProcesses = () => {
      let output;
      if (process.platform === 'win32') {
        const script = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match '^(node|cmd)\\.exe$' -and $_.CommandLine -and ($_.CommandLine -like '*fake-worker.js*' -or $_.CommandLine -like '*consult-fake-grandchild*') } | ForEach-Object { $_.ProcessId }";
        output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
      } else {
        const listing = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
        const found = [];
        for (const row of listing.split('\n')) {
          if (!/\bnode\b.*(fake-worker\.js|consult-fake-grandchild)/.test(row)) continue; // only node processes, not a shell whose command line mentions them
          const pid = row.trim().split(/\s+/)[0];
          if (pid !== String(process.pid)) found.push(pid);
        }
        output = found.join('\n');
      }
      return output.split(/\s+/).filter(Boolean);
    };

    // Runs async scenarios, at most `limit` at a time (the PC has little RAM).
    const runInPool = async (scenarios, limit) => {
      const queue = [...scenarios];
      const workers = [];
      for (let index = 0; index < limit; index++) {
        workers.push((async () => {
          while (queue.length > 0) {
            const scenario = queue.shift();
            try {
              await scenario.run();
            } catch (error) {
              console.log(`FAIL supervisor scenario ${scenario.name} threw: ${error.stack}`);
              failed++;
            }
          }
        })());
      }
      await Promise.all(workers);
    };

    const previousHome = process.env.CONSULT_DELEGATE_HOME;
    const previousNoDeprecation = process.noDeprecation;
    process.env.CONSULT_DELEGATE_HOME = supervisorHome;
    process.noDeprecation = true; // node warns about the shell:true spawn (as spawn-cli.js does) on every start
    try {
      const scenarios = [];

      scenarios.push({ name: 'ok in a copy', run: async () => {
        const repo = makeRepo('Имя copy project', { 'readme.txt': 'hello\n' });
        const task = await newCopyTask(repo);
        const reportFile = reportFileFor(task);
        const pid = launchWith(task, { FAKE_SCENARIO: 'ok', FAKE_REPORT_FILE: reportFile });
        const done = await waitForTask(task.id, hasEnded);
        eq('supervisor ok: state done, no stop reason', [done.state, done.stop_reason], ['done', null]);
        eq('supervisor ok: the summary is the first line of the final message, heading skipped', done.summary, 'Created worker-output.txt in the folder.');
        eq('supervisor ok: final.md holds the whole final message', fs.readFileSync(path.join(taskFolder(task.id), 'final.md'), 'utf8').includes('Second line of the message.'), true);
        eq('supervisor ok: final_path and log_path name the files', [done.final_path, done.log_path], [path.join(taskFolder(task.id), 'final.md'), path.join(taskFolder(task.id), 'log.jsonl')]);
        eq('supervisor ok: log.jsonl holds the four stdout lines', fs.readFileSync(path.join(taskFolder(task.id), 'log.jsonl'), 'utf8').split('\n').filter(Boolean).length, 4);
        eq('supervisor ok: the codex session is recorded', done.worker_session, '5eed5eed-0000-4000-8000-000000000001');
        eq('supervisor ok: supervisor_pid is the launched process, fenced is set', [done.supervisor_pid, done.fenced], [pid, true]);
        truthy('supervisor ok: started_at, ended_at and last_output_at are times', done.started_at > 0 && done.ended_at >= done.started_at && done.last_output_at >= done.started_at);
        eq('supervisor ok: the file the worker wrote is in the copy', fs.readFileSync(path.join(done.worktree, 'worker-output.txt'), 'utf8'), 'written by the fake worker\n');
        eq('supervisor ok: the project itself is untouched', fs.existsSync(path.join(repo, 'worker-output.txt')), false);
        truthy('supervisor ok: end_commit is a commit', /^[0-9a-f]{40}$/.test(done.end_commit ?? ''));
        eq('supervisor ok: end_commit holds the worker\'s file', gitSync(repo, 'show', `${done.end_commit}:worker-output.txt`), 'written by the fake worker\n');
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        eq('supervisor ok: the brief came on stdin, with the preamble', report.promptStart.startsWith('You are working alone on a delegated task.'), true);
        eq('supervisor ok: the worker ran in the copy', sameFolder(report.cwd, done.worktree), true);
        eq('supervisor ok: index.json shows the task done', JSON.parse(fs.readFileSync(path.join(supervisorHome, 'index.json'), 'utf8')).tasks.find((row) => row.id === task.id)?.state, 'done');
      } });

      scenarios.push({ name: 'ok in a subfolder of a repository', run: async () => {
        const repo = makeRepo('Имя monorepo', { 'pkg Имя/index.txt': 'x\n', 'other/y.txt': 'y\n' });
        const project = path.join(repo, 'pkg Имя');
        const task = await newCopyTask(project);
        const reportFile = reportFileFor(task);
        launchWith(task, { FAKE_SCENARIO: 'ok', FAKE_REPORT_FILE: reportFile });
        const done = await waitForTask(task.id, hasEnded);
        eq('supervisor subfolder: done', done.state, 'done');
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        eq('supervisor subfolder: the worker ran in the copy of the project folder', sameFolder(report.cwd, path.join(done.worktree, 'pkg Имя')), true);
        eq('supervisor subfolder: its file landed there', gitSync(repo, '-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', done.end_commit).split('\n').filter(Boolean).includes('pkg Имя/worker-output.txt'), true);
      } });

      scenarios.push({ name: 'held', run: async () => {
        const task = newTask({ hold: true });
        launchWith(task, { FAKE_SCENARIO: 'ok' });
        const held = await waitForTask(task.id, hasEnded);
        eq('supervisor hold: a finished task with hold set is held', held.state, 'held');
      } });

      scenarios.push({ name: 'fail', run: async () => {
        const task = newTask();
        launchWith(task, { FAKE_SCENARIO: 'fail' });
        const failedTask = await waitForTask(task.id, hasEnded);
        eq('supervisor fail: state failed', failedTask.state, 'failed');
        eq('supervisor fail: the summary is the stderr tail', failedTask.summary, 'Failed: boom: the fake worker failed on purpose');
        eq('supervisor fail: the session was recorded as soon as a line showed it', failedTask.worker_session, '5eed5eed-0000-4000-8000-000000000001');
        eq('supervisor fail: stderr.log has the worker\'s stderr', fs.readFileSync(path.join(taskFolder(task.id), 'stderr.log'), 'utf8'), 'boom: the fake worker failed on purpose\n');
        eq('supervisor fail: a task working in place has no end_commit', failedTask.end_commit, null);
      } });

      scenarios.push({ name: 'early end', run: async () => {
        const task = newTask();
        launchWith(task, { FAKE_SCENARIO: 'early' });
        const early = await waitForTask(task.id, hasEnded);
        eq('supervisor early: exit 0 without the terminal event is failed', [early.state, early.summary], ['failed', "Failed: the worker's output ended early."]);
      } });

      scenarios.push({ name: 'limit', run: async () => {
        const task = newTask();
        launchWith(task, {
          FAKE_SCENARIO: 'limit', CODEX_HOME: path.join(fixtureRoot, 'codex-home'), FAKE_THREAD_ID: '01a1742b-ffff-7000-8000-00000000cafe'
        });
        const paused = await waitForTask(task.id, hasEnded);
        eq('supervisor limit: paused-limit', paused.state, 'paused-limit');
        eq('supervisor limit: the kind and the rollout\'s reset time (ms) are recorded', [paused.limit?.kind, paused.limit?.resets_at], ['exhausted', 1792975000 * 1000]);
        eq('supervisor limit: the rollout\'s windows are kept as they are', [paused.limit?.primary?.used_percent, paused.limit?.secondary?.used_percent], [100, 41]);
      } });

      // agy's answer arrived in full, then its result line said ERROR (agy 1.2.10+ exits 3 on that).
      const replayAfterAnswer = (name, change) => {
        const lines = fs.readFileSync(path.join(fixtureRoot, 'agy-error-after-answer.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
        const changed = change(lines);
        const file = path.join(scratch, name);
        fs.writeFileSync(file, changed.join('\n') + '\n');
        return { FAKE_SCENARIO: 'agy-replay', FAKE_STREAM_FILE: file, FAKE_EXIT_CODE: '3' };
      };

      scenarios.push({ name: 'agy error after a complete answer', run: async () => {
        const task = newTask({ worker: 'agy', mode: 'read' });
        launchWith(task, replayAfterAnswer('agy-answer-then-error.jsonl', (lines) => lines));
        const done = await waitForTask(task.id, hasEnded);
        eq('agy: an error after a complete answer ends the task done with a warning', [done.state, done.summary, done.warning.includes('stream idle timeout')], ['done', 'The review found one issue.', true]);
        eq('agy: the answer is kept as the final message', fs.readFileSync(path.join(taskFolder(task.id), 'final.md'), 'utf8'), '### Findings\nThe review found one issue.\n');
        const held = newTask({ worker: 'agy', mode: 'read', hold: true });
        launchWith(held, replayAfterAnswer('agy-answer-then-error-hold.jsonl', (lines) => lines));
        eq('agy: the same on a task that asked for hold is held', (await waitForTask(held.id, hasEnded)).state, 'held');
      } });

      scenarios.push({ name: 'agy answer cut off mid-stream', run: async () => {
        const task = newTask({ worker: 'agy', mode: 'read' });
        launchWith(task, replayAfterAnswer('agy-cut-off.jsonl', (lines) => {
          const cutOff = [];
          for (const line of lines) cutOff.push(line.includes('"state":"DONE","step_type":"agent_response"') ? line.replace('"state":"DONE"', '"state":"ACTIVE"') : line);
          return cutOff;
        }));
        const failed = await waitForTask(task.id, hasEnded);
        eq('agy: an answer cut off mid-stream stays failed', [failed.state, failed.summary.includes('stream idle timeout'), (failed.warning ?? '').includes('stream idle timeout')], ['failed', true, false]);
      } });

      scenarios.push({ name: 'agy warning is scrubbed and capped', run: async () => {
        const task = newTask({ worker: 'agy', mode: 'read' });
        const longError = `key sk-abcdefghijklmnopqrstuvwxyz0123456789 ${'x'.repeat(20000)}`;
        launchWith(task, replayAfterAnswer('agy-answer-then-long-error.jsonl', (lines) => {
          const longer = [];
          for (const line of lines) longer.push(line.replace('API error (attempt 1): request failed: stream idle timeout (5m0s): context deadline exceeded', longError));
          return longer;
        }));
        const done = await waitForTask(task.id, hasEnded);
        const warning = done.warning ?? '';
        eq('agy: a warning carrying a key and 20 KB of text is stored scrubbed and capped', [done.state, warning.includes('sk-abcdefghijklmnopqrstuvwxyz'), warning.length > 0 && warning.length <= 600], ['done', false, true]);
      } });

      scenarios.push({ name: 'agy limit error after an answer', run: async () => {
        const task = newTask({ worker: 'agy', mode: 'read' });
        launchWith(task, replayAfterAnswer('agy-answer-then-limit.jsonl', (lines) => {
          const limited = [];
          for (const line of lines) limited.push(line.replace('API error (attempt 1): request failed: stream idle timeout (5m0s): context deadline exceeded', "You've hit your usage limit."));
          return limited;
        }));
        const paused = await waitForTask(task.id, hasEnded);
        eq('agy: a limit error after an answer still pauses', [paused.state, paused.limit?.kind], ['paused-limit', 'exhausted']);
      } });

      scenarios.push({ name: 'watchdog', run: async () => {
        const task = newTask();
        launchWith(task, { FAKE_SCENARIO: 'hang', CONSULT_DELEGATE_WATCHDOG_MS: '1000' });
        const stopped = await waitForTask(task.id, hasEnded);
        eq('supervisor watchdog: silent for the watchdog period is stopped', [stopped.state, stopped.stop_reason], ['stopped', 'watchdog']);
      } });

      scenarios.push({ name: 'watchdog waits for a command', run: async () => {
        const task = newTask();
        // 3 s, not 1: a loaded Windows runner can take over a second to start the worker, and the watchdog counts from the spawn.
        launchWith(task, { FAKE_SCENARIO: 'busy-step', FAKE_RUN_MS: '7000', CONSULT_DELEGATE_WATCHDOG_MS: '3000' });
        const finished = await waitForTask(task.id, hasEnded);
        eq('supervisor watchdog: silence inside one started command is not a hang', [finished.state, finished.stop_reason], ['done', null]);
      } });

      scenarios.push({ name: 'time limit covers a command', run: async () => {
        const task = newTask({ time_limit_ms: 7000 });
        launchWith(task, { FAKE_SCENARIO: 'busy-step', FAKE_NEVER_ENDS: '1', CONSULT_DELEGATE_WATCHDOG_MS: '3000' });
        const stopped = await waitForTask(task.id, hasEnded);
        eq('supervisor watchdog: a worker hung inside a command still meets the time limit', [stopped.state, stopped.stop_reason], ['stopped', 'time-limit']);
      } });

      scenarios.push({ name: 'time limit', run: async () => {
        const task = newTask({ time_limit_ms: 1000 });
        launchWith(task, { FAKE_SCENARIO: 'hang' });
        const stopped = await waitForTask(task.id, hasEnded);
        eq('supervisor time limit: stopped with time-limit', [stopped.state, stopped.stop_reason], ['stopped', 'time-limit']);
        eq('supervisor time limit: the summary says so', stopped.summary, 'Stopped: the time limit of 1 s was reached.');
      } });

      scenarios.push({ name: 'limit found only in the rollout', run: async () => {
        const task = newTask();
        launchWith(task, {
          FAKE_SCENARIO: 'fail', CODEX_HOME: path.join(fixtureRoot, 'codex-home'), FAKE_THREAD_ID: '01a1742b-ffff-7000-8000-00000000cafe'
        });
        const paused = await waitForTask(task.id, hasEnded);
        eq('supervisor limit: a failed run whose stream names no limit but whose rollout shows one is paused-limit', [paused.state, paused.limit?.kind, paused.limit?.resets_at], ['paused-limit', 'exhausted', 1792975000 * 1000]);
      } });

      scenarios.push({ name: 'cancel', run: async () => {
        const repo = makeRepo('Имя cancel project', { 'readme.txt': 'hello\n' });
        const task = await newCopyTask(repo);
        launchWith(task, { FAKE_SCENARIO: 'hang' });
        await waitForTask(task.id, isRunning);
        const giveUpAt = Date.now() + 15000;
        while (!fs.existsSync(path.join(task.worktree, 'partial.txt')) && Date.now() < giveUpAt) await sleep(50);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        const cancelled = await waitForTask(task.id, hasEnded);
        eq('supervisor cancel: a cancel file ends the task cancelled', [cancelled.state, cancelled.stop_reason], ['cancelled', null]);
        truthy('supervisor cancel: a cancelled copy is still snapshotted, with the partial work in it', /^[0-9a-f]{40}$/.test(cancelled.end_commit ?? '') && gitSync(repo, 'show', `${cancelled.end_commit}:partial.txt`) === 'work in progress\n');
      } });

      scenarios.push({ name: 'a cancel before the start', run: async () => {
        const task = newTask();
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        launchWith(task, { FAKE_SCENARIO: 'hang' });
        const cancelled = await waitForTask(task.id, hasEnded);
        eq('supervisor cancel: a cancel that came first means the worker never starts', [cancelled.state, cancelled.started_at], ['cancelled', null]);
      } });

      scenarios.push({ name: 'grandchild', run: async () => {
        const task = newTask();
        const pidFile = path.join(scratch, `grandchild-${task.id}.pid`);
        launchWith(task, { FAKE_SCENARIO: 'grandchild', FAKE_GRANDCHILD_FILE: pidFile });
        await waitForTask(task.id, isRunning);
        const giveUpAt = Date.now() + 15000;
        while (!fs.existsSync(pidFile) && Date.now() < giveUpAt) await sleep(50);
        const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
        recordedGrandchildPids.push(grandchildPid);
        eq('supervisor grandchild: the grandchild is running before the cancel', isProcessAlive(grandchildPid), true);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        const cancelled = await waitForTask(task.id, hasEnded);
        eq('supervisor grandchild: cancelled', cancelled.state, 'cancelled');
        eq('supervisor grandchild: the grandchild is gone once the task is cancelled (Review Focus 2)', isProcessAlive(grandchildPid), false);
      } });

      scenarios.push({ name: 'a stale owner heartbeat', run: async () => {
        beat('srv-stale');
        const task = newTask({ owner_instance: 'srv-stale', keep_running: false });
        launchWith(task, { FAKE_SCENARIO: 'hang' });
        const running = await waitForTask(task.id, isRunning);
        eq('supervisor heartbeat: a live owner keeps its task running', running.state, 'running');
        const past = new Date(Date.now() - 60000);
        fs.utimesSync(path.join(supervisorHome, 'servers', 'srv-stale.json'), past, past);
        const stopped = await waitForTask(task.id, hasEnded);
        eq('supervisor heartbeat: a stale owner with keep_running false stops the task', [stopped.state, stopped.stop_reason], ['stopped', 'session-closed']);
      } });

      scenarios.push({ name: 'a stale owner heartbeat with keep_running', run: async () => {
        beat('srv-stale-keep');
        const task = newTask({ owner_instance: 'srv-stale-keep', keep_running: true });
        launchWith(task, { FAKE_SCENARIO: 'hang' });
        await waitForTask(task.id, isRunning);
        const past = new Date(Date.now() - 60000);
        fs.utimesSync(path.join(supervisorHome, 'servers', 'srv-stale-keep.json'), past, past);
        await sleep(1500);
        eq('supervisor heartbeat: keep_running true keeps running with a stale owner', readTask(task.id).state, 'running');
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        eq('supervisor heartbeat: and it still cancels', (await waitForTask(task.id, hasEnded)).state, 'cancelled');
      } });

      // A /mcp reconnect: the old server's beat goes stale while a new server of the same session beats.
      const ageServerBeat = (instanceId, ageMs) => {
        const at = new Date(Date.now() - ageMs);
        fs.utimesSync(path.join(supervisorHome, 'servers', `${instanceId}.json`), at, at);
      };

      scenarios.push({ name: 'a restarted server of the same session', run: async () => {
        beat('srv-restart-a', 'session-restart');
        const task = newTask({ owner_instance: 'srv-restart-a', owner_session: 'session-restart', keep_running: false });
        launchWith(task, { FAKE_SCENARIO: 'slow', FAKE_RUN_MS: '20000' });
        await waitForTask(task.id, isRunning);
        ageServerBeat('srv-restart-a', 60000);
        beat('srv-restart-b', 'session-restart');
        await sleep(3000);
        eq('supervisor restart: the owner instance is stale, a fresh beat names the session: the task keeps running', readTask(task.id).state, 'running');
        const finished = await waitForTask(task.id, hasEnded, 40000);
        eq('supervisor restart: and it ends done', [finished.state, finished.stop_reason], ['done', null]);
      } });

      scenarios.push({ name: 'a fresh beat of another session', run: async () => {
        beat('srv-other-a', 'session-mine');
        const task = newTask({ owner_instance: 'srv-other-a', owner_session: 'session-mine', keep_running: false });
        launchWith(task, { FAKE_SCENARIO: 'hang' });
        await waitForTask(task.id, isRunning);
        beat('srv-other-b', 'session-someone-else');
        ageServerBeat('srv-other-a', 60000);
        const stopped = await waitForTask(task.id, hasEnded);
        eq('supervisor restart: a fresh beat naming another session does not keep the task', [stopped.state, stopped.stop_reason], ['stopped', 'session-closed']);
      } });

      scenarios.push({ name: 'a task with no owner session and a stale owner', run: async () => {
        beat('srv-nosession-a', null);
        const task = newTask({ owner_instance: 'srv-nosession-a', owner_session: null, keep_running: false });
        launchWith(task, { FAKE_SCENARIO: 'hang' });
        await waitForTask(task.id, isRunning);
        beat('srv-nosession-b', null);
        ageServerBeat('srv-nosession-a', 60000);
        const stopped = await waitForTask(task.id, hasEnded);
        eq('supervisor restart: with no owner session another server\'s beat changes nothing', [stopped.state, stopped.stop_reason], ['stopped', 'session-closed']);
      } });

      scenarios.push({ name: 'output keeps the watchdog quiet', run: async () => {
        const task = newTask();
        launchWith(task, { FAKE_SCENARIO: 'chatty', CONSULT_DELEGATE_WATCHDOG_MS: '1500' });
        const running = await waitForTask(task.id, isRunning);
        await sleep(2800);
        const later = readTask(task.id);
        eq('supervisor watchdog: a worker that keeps printing is not stopped', later.state, 'running');
        truthy('supervisor watchdog: last_output_at is recorded while it runs', later.last_output_at >= running.started_at);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        await waitForTask(task.id, hasEnded);
      } });

      // ---- fix round 1 ----
      {
        const probe = newTask();
        eq('updateTaskWhen: null leaves the task alone', [updateTaskWhen(probe.id, () => null), readTask(probe.id).summary], [null, null]);
        eq('updateTaskWhen: decides from the state under the lock', updateTaskWhen(probe.id, (current) => ({ summary: `was ${current.state}` })).summary, 'was queued');
        updateTaskWhen(probe.id, () => ({ state: 'stopped', stop_reason: 'supervisor-stopped' }));
        eq('updateTaskWhen: the new stop reason is accepted', readTask(probe.id).stop_reason, 'supervisor-stopped');
        throws('updateTaskWhen: a bad stop reason is refused', () => updateTaskWhen(probe.id, () => ({ stop_reason: 'bored' })));
      }
      const CAFE_THREAD = '01a1742b-ffff-7000-8000-00000000cafe';
      const waitForFile = async (file, timeoutMs) => {
        const giveUpAt = Date.now() + timeoutMs;
        while (!fs.existsSync(file) && Date.now() < giveUpAt) await sleep(50);
        return fs.existsSync(file);
      };
      const waitForPidGone = async (pid, timeoutMs) => {
        const giveUpAt = Date.now() + timeoutMs;
        while (isProcessAlive(pid) && Date.now() < giveUpAt) await sleep(50);
        return !isProcessAlive(pid);
      };

      scenarios.push({ name: 'clean run with a full rollout window', run: async () => {
        const task = newTask();
        launchWith(task, { FAKE_SCENARIO: 'ok', CODEX_HOME: path.join(fixtureRoot, 'codex-home'), FAKE_THREAD_ID: CAFE_THREAD });
        const done = await waitForTask(task.id, hasEnded, 15000);
        eq('supervisor limit: a clean run is done even when the rollout shows a full window', done.state, 'done');
        eq('supervisor limit: the rollout\'s hit is kept as limit_hit for a later warning', [done.limit_hit?.kind, done.limit_hit?.resets_at], ['exhausted', 1792975000 * 1000]);
        eq('supervisor limit: the windows are kept in limit, without a hit', [done.limit?.primary?.used_percent, done.limit?.kind], [100, undefined]);
      } });

      scenarios.push({ name: 'a stop that lands after the worker exited', run: async () => {
        const task = newTask();
        const exitMarker = path.join(scratch, `exit-${task.id}.txt`);
        const pidFile = path.join(scratch, `grandchild-${task.id}.pid`);
        launchWith(task, { FAKE_SCENARIO: 'lingering', FAKE_GRANDCHILD_FILE: pidFile, FAKE_EXIT_MARKER: exitMarker });
        const marked = await waitForFile(exitMarker, 15000);
        const workerPid = marked ? Number(fs.readFileSync(exitMarker, 'utf8')) : 0;
        if (await waitForFile(pidFile, 2000)) recordedGrandchildPids.push(Number(fs.readFileSync(pidFile, 'utf8')));
        if (workerPid > 0) await waitForPidGone(workerPid, 5000);
        await sleep(150);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), ''); // the supervisor is still waiting for the pipes to close
        const ended = await waitForTask(task.id, hasEnded, 20000);
        eq('supervisor late stop: a cancel after the worker exited does not replace its outcome', ended.state, 'done');
      } });

      scenarios.push({ name: 'a descendant holding the pipes open', run: async () => {
        const task = newTask();
        const exitMarker = path.join(scratch, `exit-${task.id}.txt`);
        const pidFile = path.join(scratch, `grandchild-${task.id}.pid`);
        launchWith(task, { FAKE_SCENARIO: 'lingering', FAKE_GRANDCHILD_FILE: pidFile, FAKE_EXIT_MARKER: exitMarker });
        const ended = await waitForTask(task.id, hasEnded, 25000);
        // On Windows worker_pid is the shell's; the real worker under it is found by one scan early in the run.
        if (process.platform === 'win32') {
          eq('supervisor lingering: the real worker under the shell is recorded', typeof ended.worker_real_pid === 'number' && ended.worker_real_pid !== ended.worker_pid, true);
        }
        const grandchildPid = (await waitForFile(pidFile, 2000)) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
        if (grandchildPid > 0) recordedGrandchildPids.push(grandchildPid);
        eq('supervisor lingering: the run still ends done', ended.state, 'done');
        eq('supervisor lingering: the descendant that held the pipes is killed before the end is recorded', grandchildPid > 0 && isProcessAlive(grandchildPid), false);
      } });

      // The reviewer's repro: a node worker runs `powershell Start-Process node <script>` in its folder and
      // exits; the PowerShell exits too, so the new process names a dead parent and no tree walk from the
      // worker reaches it. Windows only (it is how Windows agents start a dev server).
      if (process.platform !== 'win32') {
        console.log('SKIP supervisor re-parented descendants: they exist on Windows only');
      } else {
        const killMarker = (pidFile) => {
          if (!fs.existsSync(pidFile)) return;
          const pid = Number(fs.readFileSync(pidFile, 'utf8'));
          if (pid > 0 && /orphan-marker\.js/.test(commandLineOf(pid))) {
            try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) { /* already gone */ }
          }
        };
        const waitUntilDead = async (pid, timeoutMs) => {
          const giveUpAt = Date.now() + timeoutMs;
          while (isProcessAlive(pid) && Date.now() < giveUpAt) await sleep(100);
          return !isProcessAlive(pid);
        };

        scenarios.push({ name: 'a re-parented descendant of a copy task', run: async () => {
          const repo = makeRepo('Имя reparent copy', { 'readme.txt': 'hello\n' });
          const task = await newCopyTask(repo);
          const pidFile = path.join(scratch, `orphan-${task.id}.pid`);
          try {
            launchWith(task, { FAKE_SCENARIO: 'reparent', FAKE_GRANDCHILD_FILE: pidFile });
            const ended = await waitForTask(task.id, hasEnded, 40000);
            const markerPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
            eq('supervisor re-parented (copy): the worker ran and the run ended done', [ended.state, markerPid > 0], ['done', true]);
            eq('supervisor re-parented (copy): the process that names a dead parent and runs from the copy is killed at the end', markerPid > 0 && await waitUntilDead(markerPid, 8000), true);
          } finally {
            killMarker(pidFile);
          }
        } });

        scenarios.push({ name: 'a re-parented descendant of an in-place task', run: async () => {
          const folder = path.join(projectsRoot, 'Имя reparent here');
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, 'readme.txt'), 'hello\n');
          const task = newTask({ project: folder });
          const pidFile = path.join(scratch, `orphan-${task.id}.pid`);
          try {
            launchWith(task, { FAKE_SCENARIO: 'reparent', FAKE_GRANDCHILD_FILE: pidFile });
            const ended = await waitForTask(task.id, hasEnded, 40000);
            const markerPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
            eq('supervisor re-parented (here): the run ends done', ended.state, 'done');
            eq('supervisor re-parented (here): the survivor is not killed (it may be the person\'s own server)', markerPid > 0 && isProcessAlive(markerPid), true);
            truthy('supervisor re-parented (here): the warning names its pid and says it may still be running', (ended.warning ?? '').includes(String(markerPid)) && /still be running/.test(ended.warning ?? ''));
          } finally {
            killMarker(pidFile);
          }
        } });

        // The shape of `Start-Process npm run dev`: the process that names the folder (node, started by a .cmd
        // shim with the shim's own absolute path) has a LIVE parent (cmd) whose parent (the PowerShell) is gone.
        scenarios.push({ name: 'a re-parented chain of a copy task', run: async () => {
          const repo = makeRepo('Имя reparent chain copy', { 'readme.txt': 'hello\n' });
          const task = await newCopyTask(repo);
          const pidFile = path.join(scratch, `chain-${task.id}.pid`);
          try {
            launchWith(task, { FAKE_SCENARIO: 'reparent-chain', FAKE_GRANDCHILD_FILE: pidFile });
            const ended = await waitForTask(task.id, hasEnded, 40000);
            const markerPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
            eq('supervisor re-parented chain (copy): the worker ran and the run ended done', [ended.state, markerPid > 0], ['done', true]);
            eq('supervisor re-parented chain (copy): the server under a live launcher whose parent is dead is killed at the end', markerPid > 0 && await waitUntilDead(markerPid, 8000), true);
          } finally {
            killMarker(pidFile);
          }
        } });

        scenarios.push({ name: 'a re-parented chain of an in-place task', run: async () => {
          const folder = path.join(projectsRoot, 'Имя reparent chain here');
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, 'readme.txt'), 'hello\n');
          const task = newTask({ project: folder });
          const pidFile = path.join(scratch, `chain-${task.id}.pid`);
          try {
            launchWith(task, { FAKE_SCENARIO: 'reparent-chain', FAKE_GRANDCHILD_FILE: pidFile });
            const ended = await waitForTask(task.id, hasEnded, 40000);
            const markerPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
            eq('supervisor re-parented chain (here): the run ends done', ended.state, 'done');
            eq('supervisor re-parented chain (here): the survivor is not killed', markerPid > 0 && isProcessAlive(markerPid), true);
            truthy('supervisor re-parented chain (here): the warning names the launcher at the top of the chain and says it may still be running', /cmd\.exe \(pid \d+\)/.test(ended.warning ?? '') && /still be running/.test(ended.warning ?? ''));
          } finally {
            killMarker(pidFile);
          }
        } });

        // A process the person (here: this test) starts from a process that is older than the run, with the
        // copy's path in its command line: its live chain reaches a pre-spawn process, so it is left alone.
        scenarios.push({ name: 'a process of the person inside a copy task', run: async () => {
          const repo = makeRepo('Имя reparent person copy', { 'readme.txt': 'hello\n' });
          const task = await newCopyTask(repo);
          const personScript = path.join(task.worktree, 'person-marker.js');
          fs.writeFileSync(personScript, 'setInterval(() => {}, 1000);\n');
          let person = null;
          try {
            launchWith(task, { FAKE_SCENARIO: 'slow', FAKE_RUN_MS: '4000' });
            await waitForTask(task.id, isRunning);
            person = spawn(process.execPath, [personScript], { stdio: 'ignore', windowsHide: true });
            const ended = await waitForTask(task.id, hasEnded, 40000);
            await sleep(500);
            eq('supervisor person process (copy): the run ended done', ended.state, 'done');
            eq('supervisor person process (copy): a process started from an older process is not killed', isProcessAlive(person.pid), true);
          } finally {
            if (person !== null) { try { execFileSync('taskkill', ['/PID', String(person.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) { /* already gone */ } }
          }
        } });
      }

      scenarios.push({ name: 'two supervisors for one task', run: async () => {
        const task = newTask();
        const startLog = path.join(scratch, `starts-${task.id}.log`);
        const first = launchWith(task, { FAKE_SCENARIO: 'ok', FAKE_START_LOG: startLog });
        const second = launchWith(task, { FAKE_SCENARIO: 'ok', FAKE_START_LOG: startLog });
        await waitForTask(task.id, hasEnded, 20000);
        await waitForPidGone(first, 10000);
        await waitForPidGone(second, 10000);
        const starts = fs.existsSync(startLog) ? fs.readFileSync(startLog, 'utf8').split('\n').filter(Boolean).length : 0;
        eq('supervisor claim: two supervisors launched for one task run one worker', starts, 1);
        eq('supervisor claim: the record names a supervisor that was launched', launchedPids.includes(readTask(task.id).supervisor_pid), true);
      } });

      scenarios.push({ name: 'a follow-up on a finished task', run: async () => {
        const task = newTask();
        const firstReport = reportFileFor(task);
        const firstPid = launchWith(task, { FAKE_SCENARIO: 'ok', FAKE_REPORT_FILE: firstReport });
        const firstDone = await waitForTask(task.id, hasEnded, 20000);
        await waitForPidGone(firstPid, 10000);
        const secondReport = path.join(scratch, `fake-report-${task.id}-followup.json`);
        // What an earlier run left that this one must not inherit.
        updateTask(task.id, {
          followup: 'Also add a test.', state: 'queued', limit_hit: { kind: 'exhausted', resets_at: 1 }, denied: [{ action: 'command' }],
          limit: { primary: { used_percent: 1 } }, summary: 'stale summary', end_commit: 'a'.repeat(40)
        });
        launchWith(task, { FAKE_SCENARIO: 'ok', FAKE_REPORT_FILE: secondReport });
        const secondDone = await waitForTask(task.id, hasEnded, 20000);
        eq('supervisor follow-up: the earlier run\'s limit hit, denied list, limit, summary and end commit are gone',
          [secondDone.limit_hit ?? null, secondDone.denied ?? null, secondDone.limit ?? null, secondDone.summary, secondDone.end_commit ?? null],
          [null, null, null, 'Created worker-output.txt in the folder.', null]);
        eq('supervisor follow-up: the first run was done', firstDone.state, 'done');
        eq('supervisor follow-up: the same task is done again, and the follow-up is cleared', [secondDone.state, secondDone.followup], ['done', null]);
        const report = fs.existsSync(secondReport) ? JSON.parse(fs.readFileSync(secondReport, 'utf8')) : { args: [], promptStart: null };
        eq('supervisor follow-up: the worker got the follow-up text, not the brief', report.promptStart, 'Also add a test.');
        eq('supervisor follow-up: it resumed the first run\'s session', [report.args.includes('resume'), report.args.includes(firstDone.worker_session)], [true, true]);
      } });

      scenarios.push({ name: 'an agy read task that edits files (git project)', run: async () => {
        const repo = makeRepo('Имя agy read edit', { 'readme.txt': 'hello\n', 'src/gone.txt': 'bye\n', 'src/keep.txt': 'stay\n' });
        fs.writeFileSync(path.join(repo, 'readme.txt'), 'edited by the user before the task\n'); // already modified: the check compares before with after
        const task = newTask({ worker: 'agy', mode: 'read', project: repo });
        launchWith(task, { FAKE_SCENARIO: 'agy-edit', FAKE_WRITE_FILE: 'readme.txt', FAKE_DELETE_FILE: 'src/gone.txt' });
        const done = await waitForTask(task.id, hasEnded);
        eq('agy read edits: the run still ends done', done.state, 'done');
        eq('agy read edits: the files it changed are recorded (an already modified file, a deleted one)', [...(done.read_only_edits ?? [])].sort(), ['readme.txt', 'src/gone.txt']);
        truthy('agy read edits: the warning names them and says the task was read-only', /read-only/i.test(done.warning ?? '') && (done.warning ?? '').includes('readme.txt') && (done.warning ?? '').includes('src/gone.txt'));
        // The task's file is written before the index is rebuilt: give the rebuild a moment.
        const indexedEdits = async () => {
          const giveUpAt = Date.now() + 5000;
          let row = null;
          while (Date.now() < giveUpAt) {
            row = JSON.parse(fs.readFileSync(path.join(supervisorHome, 'index.json'), 'utf8')).tasks.find((candidate) => candidate.id === task.id);
            if (row?.read_only_edits) break;
            await sleep(50);
          }
          return row?.read_only_edits?.slice().sort();
        };
        eq('agy read edits: the index carries the files for the wake notice', await indexedEdits(), ['readme.txt', 'src/gone.txt']);
        eq('agy read edits: the git index is untouched', gitSync(repo, 'diff', '--cached', '--name-only'), '');
      } });

      scenarios.push({ name: 'an agy copy write task refused a command after writing', run: async () => {
        const repo = makeRepo('Имя agy denied', { 'readme.txt': 'hello\n' });
        const task = await newCopyTask(repo, { worker: 'agy' });
        launchWith(task, { FAKE_SCENARIO: 'agy-denied', FAKE_WRITE_FILE: 'blog.html' });
        const done = await waitForTask(task.id, hasEnded);
        eq('agy denied with changes: done, not failed', done.state, 'done');
        eq('agy denied with changes: the warning names the command and says to review', done.warning, "agy couldn't run RunCommand and gave no summary; its changes are in the copy — review them before merging.");
        eq('agy denied with changes: the denied list is kept and the snapshot is recorded', [done.denied?.length, typeof done.end_commit], [1, 'string']);
        const held = await newCopyTask(repo, { worker: 'agy', hold: true });
        launchWith(held, { FAKE_SCENARIO: 'agy-denied', FAKE_WRITE_FILE: 'blog2.html' });
        eq('agy denied with changes and hold: held', (await waitForTask(held.id, hasEnded)).state, 'held');
      } });

      scenarios.push({ name: 'an agy copy write task refused a command with nothing written', run: async () => {
        const repo = makeRepo('Имя agy denied empty', { 'readme.txt': 'hello\n' });
        const task = await newCopyTask(repo, { worker: 'agy' });
        launchWith(task, { FAKE_SCENARIO: 'agy-denied' });
        const failed = await waitForTask(task.id, hasEnded);
        eq('agy denied, no changes: stays failed', [failed.state, failed.summary, failed.warning ?? null], ['failed', 'agy was refused: RunCommand', null]);
      } });

      scenarios.push({ name: 'an agy in-place write task refused a command after writing', run: async () => {
        const repo = makeRepo('Имя agy denied here', { 'readme.txt': 'hello\n' });
        const task = newTask({ worker: 'agy', project: repo });
        launchWith(task, { FAKE_SCENARIO: 'agy-denied', FAKE_WRITE_FILE: 'blog.html' });
        eq('agy denied in place: stays failed', (await waitForTask(task.id, hasEnded)).state, 'failed');
      } });

      scenarios.push({ name: 'an agy read task that edits nothing', run: async () => {
        const repo = makeRepo('Имя agy read clean', { 'readme.txt': 'hello\n' });
        const task = newTask({ worker: 'agy', mode: 'read', project: repo });
        launchWith(task, { FAKE_SCENARIO: 'agy-edit' });
        const done = await waitForTask(task.id, hasEnded);
        eq('agy read clean: done with no warning and no edits', [done.state, done.warning ?? null, done.read_only_edits ?? null], ['done', null, null]);
      } });

      scenarios.push({ name: 'an agy read task that edits files (no git)', run: async () => {
        const folder = path.join(projectsRoot, 'Имя agy read plain');
        fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(folder, 'notes.txt'), 'n\n');
        fs.writeFileSync(path.join(folder, 'sub', 'old.txt'), 'o\n');
        const task = newTask({ worker: 'agy', mode: 'read', project: folder });
        launchWith(task, { FAKE_SCENARIO: 'agy-edit', FAKE_WRITE_FILE: 'created.txt', FAKE_DELETE_FILE: 'sub/old.txt' });
        const done = await waitForTask(task.id, hasEnded);
        eq('agy read edits, no git: a created and a deleted file are found by the listing', [...(done.read_only_edits ?? [])].sort(), ['created.txt', 'sub/old.txt']);
      } });

      scenarios.push({ name: 'a codex read task is not checked', run: async () => {
        const repo = makeRepo('Имя codex read', { 'readme.txt': 'hello\n' });
        const task = newTask({ worker: 'codex', mode: 'read', project: repo });
        launchWith(task, { FAKE_SCENARIO: 'ok' }); // the fake writes worker-output.txt; a real codex read-only sandbox would not
        const done = await waitForTask(task.id, hasEnded);
        eq('codex read: no edit check (its sandbox is the fence)', [done.state, done.read_only_edits ?? null], ['done', null]);
      } });

      scenarios.push({ name: 'a recorded supervisor pid that is not a live supervisor', run: async () => {
        const task = newTask();
        // The test process is alive, but it is no supervisor and has not beaten for a minute: a recycled pid.
        updateTask(task.id, { supervisor_pid: process.pid, supervisor_beat_at: Date.now() - 60000 });
        const pid = launchWith(task, { FAKE_SCENARIO: 'ok' });
        const done = await waitForTask(task.id, hasEnded, 8000);
        eq('supervisor claim: a live pid without a recent beat does not block the new supervisor', [done.state, done.supervisor_pid], ['done', pid]);
      } });

      scenarios.push({ name: 'a queued task whose supervisor beat 20 s ago', run: async () => {
        const task = newTask();
        // A supervisor waiting in the admission queue beats every 5 s; one that beat 20 s ago (a lock wait, a sleep) is still the claimant.
        updateTask(task.id, { supervisor_pid: process.pid, supervisor_beat_at: Date.now() - 20000 });
        launchWith(task, { FAKE_SCENARIO: 'ok' });
        await sleep(4500); // longer than the claim's wait
        const claimed = readTask(task.id);
        eq('supervisor claim: a live pid that beat 20 s ago still holds the task, so a second launch steps aside', [claimed.state, claimed.supervisor_pid], ['queued', process.pid]);
      } });

      scenarios.push({ name: 'a worker that is not installed', run: async () => {
        const task = newTask({ worker: 'agy' });
        const emptyFolder = path.join(scratch, 'no tools here');
        fs.mkdirSync(emptyFolder, { recursive: true });
        // `where` must still be found; the CLI must not be.
        const searchPath = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : emptyFolder;
        launchWith(task, { CONSULT_DELEGATE_TEST_BIN: '', PATH: searchPath, Path: undefined, LOCALAPPDATA: emptyFolder, APPDATA: emptyFolder });
        const failedTask = await waitForTask(task.id, hasEnded, 20000);
        eq('supervisor missing CLI: a failed task whose summary names the CLI', [failedTask.state, failedTask.summary.includes('agy CLI not found')], ['failed', true]);
      } });

      scenarios.push({ name: 'a worker that is found only inside the task project', run: async () => {
        if (process.platform !== 'win32') { console.log('PASS-SKIP supervisor project filter: Windows lookup only'); return; }
        const plantedProject = path.join(scratch, 'planted project');
        fs.mkdirSync(plantedProject, { recursive: true });
        fs.writeFileSync(path.join(plantedProject, 'agy.cmd'), '@echo off');
        const emptyFolder = path.join(scratch, 'no tools here either');
        fs.mkdirSync(emptyFolder, { recursive: true });
        const task = newTask({ worker: 'agy', project: plantedProject });
        const searchPath = plantedProject + ';' + path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
        launchWith(task, { CONSULT_DELEGATE_TEST_BIN: '', PATH: searchPath, Path: undefined, LOCALAPPDATA: emptyFolder, APPDATA: emptyFolder });
        const failedTask = await waitForTask(task.id, hasEnded, 20000);
        eq('supervisor project filter: a worker found only in the project is not run', [failedTask.state, failedTask.summary.includes('only inside the project folder')], ['failed', true]);
      } });

      await runInPool(scenarios, 4);

      // ---- fix round 1, in this process (hooks the real supervisor processes cannot be handed) ----
      const runCase = async (name, body) => {
        try {
          await body();
        } catch (error) {
          console.log(`FAIL supervisor case ${name} threw: ${error.stack}`);
          failed++;
        } finally {
          restoreEnv();
        }
      };
      const within = (promise, milliseconds) => Promise.race([promise, sleep(milliseconds)]);
      const codexSettings = { delegate: { time_limit_ms: BACKSTOP_MS } };
      const useFakeWorker = (scenario, extra = {}) => {
        setEnv('CONSULT_DELEGATE_TEST_BIN', fakeWorkerPath);
        setEnv('FAKE_SCENARIO', scenario);
        for (const [name, value] of Object.entries(extra)) setEnv(name, value);
      };

      await runCase('log and store faults', async () => {
        const task = newTask();
        fs.mkdirSync(path.join(taskFolder(task.id), 'log.jsonl')); // the log cannot be written
        let storeFaults = 0;
        useFakeWorker('ok');
        await runSupervisor(task.id, {
          settings: codexSettings, pollMs: 100,
          io: {
            updateTask: (id, changes) => {
              if (changes.state === undefined) { storeFaults++; throw new Error('store down'); } // every write but a state change fails
              return updateTask(id, changes);
            }
          }
        });
        const result = readTask(task.id);
        truthy('supervisor faults: the injected store fault fired', storeFaults >= 1);
        eq('supervisor faults: with no log and no side writes the outcome is still the real one', [result.state, result.summary.startsWith('Created worker-output.txt in the folder.')], ['done', true]);
        eq('supervisor faults: the parse had every line, so the session is known', result.worker_session, '5eed5eed-0000-4000-8000-000000000001');
      });

      await runCase('signal', async () => {
        const task = newTask();
        useFakeWorker('hang');
        const finished = runSupervisor(task.id, { settings: codexSettings, pollMs: 100 });
        const running = await waitForTask(task.id, isRunning, 10000);
        eq('supervisor signal: the worker\'s pid is recorded while it runs', typeof running.worker_pid === 'number' && isProcessAlive(running.worker_pid), true);
        process.emit('SIGTERM');
        const stopped = await waitForTask(task.id, hasEnded, 8000);
        eq('supervisor signal: SIGTERM stops the task with its own reason', [stopped.state, stopped.stop_reason], ['stopped', 'supervisor-stopped']);
        eq('supervisor signal: and the worker is gone', typeof running.worker_pid === 'number' && isProcessAlive(running.worker_pid), false);
        await within(finished, 3000);
      });

      await runCase('crash record', async () => {
        const task = newTask();
        updateTask(task.id, { state: 'running' });
        supervisorModule.recordSupervisorCrash(task.id, new Error('kaboom'));
        const crashed = readTask(task.id);
        eq('supervisor crash: an uncaught error makes a running task failed, with the message', [crashed.state, crashed.summary.includes('kaboom')], ['failed', true]);
      });

      await runCase('resume after sleep', async () => {
        let skewMs = 0;
        beat('srv-resume');
        const task = newTask({ owner_instance: 'srv-resume', keep_running: false, time_limit_ms: 600000 });
        useFakeWorker('hang');
        const finished = runSupervisor(task.id, { settings: codexSettings, pollMs: 100, watchdogMs: 5000, now: () => Date.now() + skewMs });
        await waitForTask(task.id, isRunning, 10000);
        skewMs += 120000; // the machine slept for two minutes
        await sleep(1000);
        eq('supervisor resume: after a sleep neither the watchdog nor a stale heartbeat stops the task', readTask(task.id).state, 'running');
        skewMs += 700000; // wall-clock time still counts against the time limit
        const stopped = await waitForTask(task.id, hasEnded, 8000);
        eq('supervisor resume: the time limit still counts wall-clock time', [stopped.state, stopped.stop_reason], ['stopped', 'time-limit']);
        await within(finished, 5000);
      });

      await runCase('write throttle', async () => {
        let skewMs = 0;
        let outputWrites = 0;
        const task = newTask();
        useFakeWorker('chatty');
        const finished = runSupervisor(task.id, {
          settings: codexSettings, pollMs: 300, watchdogMs: 60000, now: () => Date.now() + skewMs,
          io: {
            updateTask: (id, changes) => {
              if (Object.keys(changes).join() === 'last_output_at,supervisor_beat_at') outputWrites++;
              return updateTask(id, changes);
            }
          }
        });
        await waitForTask(task.id, isRunning, 10000);
        await sleep(1500);
        eq('supervisor throttle: a chatty worker costs one store write in the first seconds', outputWrites, 1);
        skewMs += 5000;
        await sleep(800);
        eq('supervisor throttle: and still one after 5 s', outputWrites, 1);
        skewMs += 5000;
        await sleep(1200);
        eq('supervisor throttle: the next write comes once 10 s have passed', outputWrites, 2);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        await within(finished, 5000);
      });

      await runCase('abandoned kill', async () => {
        const task = newTask();
        useFakeWorker('hang');
        const finished = runSupervisor(task.id, { settings: codexSettings, pollMs: 100, killGiveUpMs: 800, io: { killTree: () => {} } });
        const running = await waitForTask(task.id, isRunning, 10000);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        const cancelled = await waitForTask(task.id, hasEnded, 10000);
        eq('supervisor abandoned kill: the state is still the stop\'s', cancelled.state, 'cancelled');
        eq('supervisor abandoned kill: the summary says the worker may still run, with its pid', cancelled.summary.includes('may still be running') && cancelled.summary.includes(String(running.worker_pid)), true);
        await within(finished, 3000);
      });

      await runCase('error after a stop', async () => {
        const task = newTask();
        useFakeWorker('hang');
        const finished = runSupervisor(task.id, {
          settings: codexSettings, pollMs: 100,
          io: { rolloutLimits: () => { throw new Error('rollout unreadable'); } }
        });
        await waitForTask(task.id, isRunning, 10000);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        const cancelled = await waitForTask(task.id, hasEnded, 10000);
        eq('supervisor error after stop: the stop\'s state is kept', cancelled.state, 'cancelled');
        eq('supervisor error after stop: the error is added to the summary', cancelled.summary.includes('rollout unreadable'), true);
        await within(finished, 3000);
      });

      await runCase('limits learned at the end of a run', async () => {
        const fixtureCodexHome = path.join(fixtureRoot, 'codex-home');
        const limitsFile = path.join(supervisorHome, 'limits.json');
        const recordingIo = (calls, overrides = {}) => ({
          recordLimit: (...recorded) => { calls.push(['limit', ...recorded]); return recordLimit(...recorded); },
          recordLimitHit: (...recorded) => { calls.push(['hit', ...recorded]); return recordLimitHit(...recorded); },
          ...overrides
        });
        const fullWindow = { minutes: 300, used_percent: 100, resets_at: 1792975000 * 1000 };

        // A run the limit stopped: the windows and the hit are both recorded (windows' times in ms).
        fs.rmSync(limitsFile, { force: true });
        const pausedCalls = [];
        const pausedTask = newTask();
        useFakeWorker('limit', { CODEX_HOME: fixtureCodexHome, FAKE_THREAD_ID: CAFE_THREAD });
        await runSupervisor(pausedTask.id, { settings: codexSettings, pollMs: 100, io: recordingIo(pausedCalls) });
        const paused = readTask(pausedTask.id);
        eq('supervisor limits: a paused run records the codex windows and the hit once each', pausedCalls.map((call) => call[0]), ['limit', 'hit']);
        eq('supervisor limits: the windows are the rollout\'s, for codex', [pausedCalls[0][1], pausedCalls[0][2]?.primary?.used_percent, pausedCalls[0][2]?.secondary?.used_percent], ['codex', 100, 41]);
        eq('supervisor limits: the hit has the rollout\'s reset in ms, for codex', [pausedCalls[1][1], pausedCalls[1][2]], ['codex', { kind: 'exhausted', resets_at: 1792975000 * 1000 }]);
        truthy('supervisor limits: both are stamped with the run\'s end time', Math.abs(pausedCalls[0][3] - Date.now()) < 60000 && Math.abs(pausedCalls[1][3] - Date.now()) < 60000);
        restoreEnv(); // lastLimits reads the codex home: back to the empty one
        const learned = lastLimits(Date.now());
        eq('supervisor limits: limits.json holds them', [learned.codex?.windows[0], learned.codex?.hit?.resets_at], [fullWindow, 1792975000 * 1000]);

        // A clean run that used up a window is done, and records the same.
        const cleanCalls = [];
        const cleanTask = newTask();
        useFakeWorker('ok', { CODEX_HOME: fixtureCodexHome, FAKE_THREAD_ID: CAFE_THREAD });
        await runSupervisor(cleanTask.id, { settings: codexSettings, pollMs: 100, io: recordingIo(cleanCalls) });
        eq('supervisor limits: a clean run that used up a window records both and is still done', [readTask(cleanTask.id).state, cleanCalls.map((call) => call[0])], ['done', ['limit', 'hit']]);
        restoreEnv();

        // A run with no limit information records nothing.
        const quietCalls = [];
        const quietTask = newTask();
        useFakeWorker('ok');
        await runSupervisor(quietTask.id, { settings: codexSettings, pollMs: 100, io: recordingIo(quietCalls) });
        eq('supervisor limits: a run whose rollout says nothing records nothing', [readTask(quietTask.id).state, quietCalls], ['done', []]);
        restoreEnv();

        // A write that fails changes nothing about the task, and one failing does not stop the other.
        const failingCalls = [];
        const failingTask = newTask();
        useFakeWorker('limit', { CODEX_HOME: fixtureCodexHome, FAKE_THREAD_ID: CAFE_THREAD });
        await runSupervisor(failingTask.id, {
          settings: codexSettings, pollMs: 100,
          io: recordingIo(failingCalls, { recordLimit: () => { throw new Error('limits.json is locked'); } })
        });
        const failing = readTask(failingTask.id);
        eq('supervisor limits: a failing windows write leaves the task\'s state and summary as they were', [failing.state, failing.summary], [paused.state, paused.summary]);
        eq('supervisor limits: and the hit is still recorded', failingCalls.map((call) => call[0]), ['hit']);
        restoreEnv();
        const bothFailingTask = newTask();
        useFakeWorker('limit', { CODEX_HOME: fixtureCodexHome, FAKE_THREAD_ID: CAFE_THREAD });
        await runSupervisor(bothFailingTask.id, {
          settings: codexSettings, pollMs: 100,
          io: {
            recordLimit: () => { throw new Error('limits.json is locked'); },
            recordLimitHit: () => { throw new Error('limits.json is locked'); }
          }
        });
        const bothFailing = readTask(bothFailingTask.id);
        eq('supervisor limits: with both writes failing the task is still paused-limit, with the same record', [bothFailing.state, bothFailing.summary, bothFailing.limit?.kind], [paused.state, paused.summary, 'exhausted']);
        fs.rmSync(limitsFile, { force: true });
      });

      await runCase('session closed while waiting for admission', async () => {
        beat('srv-wait');
        const task = newTask({ worker: 'local', model: 'fake-model', mode: 'read', owner_instance: 'srv-wait', keep_running: false });
        useFakeWorker('hang');
        const finished = runSupervisor(task.id, {
          settings: { timeout_ms: 180000, local_runner: 'llama-swap', 'llama-swap.url': 'http://127.0.0.1:9292/v1', delegate: { time_limit_ms: BACKSTOP_MS } },
          pollMs: 100, inventoryFor: async () => swapFacts({ data: [{ id: 'fake-model' }] }),
          admit: () => new Promise(() => {})
        });
        await sleep(500);
        eq('supervisor admission: a live owner keeps a waiting task queued', readTask(task.id).state, 'queued');
        const past = new Date(Date.now() - 60000);
        fs.utimesSync(path.join(supervisorHome, 'servers', 'srv-wait.json'), past, past);
        const stopped = await waitForTask(task.id, hasEnded, 8000);
        eq('supervisor admission: a stale owner stops a waiting task, which never started', [stopped.state, stopped.stop_reason, stopped.started_at], ['stopped', 'session-closed', null]);
        await within(finished, 3000);
      });

      await runCase('beat while waiting for admission', async () => {
        let skewMs = 0;
        let beats = 0;
        const task = newTask({ worker: 'local', model: 'fake-model', mode: 'read' });
        useFakeWorker('hang');
        const finished = runSupervisor(task.id, {
          settings: { timeout_ms: 180000, local_runner: 'llama-swap', 'llama-swap.url': 'http://127.0.0.1:9292/v1', delegate: { time_limit_ms: BACKSTOP_MS } },
          pollMs: 100, now: () => Date.now() + skewMs, inventoryFor: async () => swapFacts({ data: [{ id: 'fake-model' }] }),
          admit: () => new Promise(() => {}),
          io: {
            updateTask: (id, changes) => {
              if (Object.keys(changes).join() === 'supervisor_beat_at') beats++;
              return updateTask(id, changes);
            }
          }
        });
        await sleep(400);
        skewMs += 4000;
        await sleep(400);
        eq('supervisor wait beat: nothing written after 4 s of waiting', beats, 0);
        skewMs += 1200;
        await sleep(400);
        eq('supervisor wait beat: a beat is written once 5 s have passed', beats, 1);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        await within(finished, 5000);
      });

      await runCase('beat during a slow start', async () => {
        let skewMs = 0;
        let beats = 0;
        const task = newTask({ worker: 'local', model: 'fake-model', mode: 'read' });
        useFakeWorker('hang');
        const finished = runSupervisor(task.id, {
          settings: { timeout_ms: 180000, local_runner: 'llama-swap', 'llama-swap.url': 'http://127.0.0.1:9292/v1', delegate: { time_limit_ms: BACKSTOP_MS } },
          pollMs: 100, now: () => Date.now() + skewMs, admit: async () => {},
          // The runner lookup after admission takes long; the runner must stay held meanwhile.
          inventoryFor: async () => { skewMs += 6000; await sleep(500); return swapFacts({ data: [{ id: 'fake-model' }] }); },
          io: {
            updateTask: (id, changes) => {
              if (Object.keys(changes).join() === 'supervisor_beat_at') beats++;
              return updateTask(id, changes);
            }
          }
        });
        await waitForTask(task.id, isRunning, 10000);
        eq('supervisor slow start: the beat goes on between admission and the first worker output', beats >= 1, true);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        await within(finished, 5000);
      });

      await runCase('beat while a codex task gets ready to start', async () => {
        let skewMs = 0;
        let clockMoved = false;
        let beats = 0;
        const repo = makeRepo('Имя codex beat project', { 'readme.txt': 'hello\n' });
        // No time limit of its own, so the supervisor reads the settings right after its claim; that read is where the clock jumps.
        const task = await newCopyTask(repo, { time_limit_ms: null });
        useFakeWorker('hang');
        const finished = runSupervisor(task.id, {
          settings: {
            get delegate() {
              if (!clockMoved) skewMs += 6000;
              clockMoved = true;
              return { time_limit_ms: BACKSTOP_MS };
            }
          },
          // Finding the copy's folder takes long; on Linux git answers in a few ms, so the wait is made here.
          copyWorkFolder: async (copyTask) => { await sleep(300); return supervisorModule.copyWorkFolder(copyTask); },
          pollMs: 20, now: () => Date.now() + skewMs,
          io: {
            updateTask: (id, changes) => {
              if (Object.keys(changes).join() === 'supervisor_beat_at') beats++;
              return updateTask(id, changes);
            }
          }
        });
        await waitForTask(task.id, isRunning, 10000);
        eq('supervisor codex start: the beat goes on from the claim until the worker runs, as it does for a local task', beats >= 1, true);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        await within(finished, 5000);
      });

      await runCase('roots of the leftover walk', async () => {
        const exited = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
        const exitedPid = exited.pid;
        await new Promise((resolve) => exited.on('exit', resolve));
        const roots = supervisorModule.leftoverRoots;
        eq('leftover roots: the shell alone when no real worker was found', roots(100, null), [100]);
        eq('leftover roots: a real worker that is gone stays a root (its children keep its pid)', roots(100, exitedPid), [100, exitedPid]);
        eq('leftover roots: a real worker pid that is alive now was recycled by someone else and is dropped', roots(100, process.pid), [100]);
      });

      // ---- fix round 2 ----
      await runCase('signal after the worker exited', async () => {
        const task = newTask();
        const exitMarker = path.join(scratch, `exit-${task.id}.txt`);
        const pidFile = path.join(scratch, `grandchild-${task.id}.pid`);
        useFakeWorker('lingering', { FAKE_GRANDCHILD_FILE: pidFile, FAKE_EXIT_MARKER: exitMarker });
        const finished = runSupervisor(task.id, { settings: codexSettings, pollMs: 100 });
        const marked = await waitForFile(exitMarker, 15000);
        const workerPid = marked ? Number(fs.readFileSync(exitMarker, 'utf8')) : 0;
        if (await waitForFile(pidFile, 2000)) recordedGrandchildPids.push(Number(fs.readFileSync(pidFile, 'utf8')));
        if (workerPid > 0) await waitForPidGone(workerPid, 5000);
        await sleep(150);
        process.emit('SIGTERM'); // the supervisor is waiting out the pipes' grace; the worker's outcome stands
        const ended = await waitForTask(task.id, hasEnded, 15000);
        eq('supervisor signal: a signal during the exit grace does not replace the worker\'s outcome', ended.state, 'done');
        await within(finished, 8000);
      });

      await runCase('a slow start is not a resume', async () => {
        let skewMs = 0;
        beat('srv-slow');
        const task = newTask({ worker: 'local', model: 'fake-model', mode: 'read', owner_instance: 'srv-slow', keep_running: false });
        useFakeWorker('hang');
        const finished = runSupervisor(task.id, {
          settings: { timeout_ms: 180000, local_runner: 'llama-swap', 'llama-swap.url': 'http://127.0.0.1:9292/v1', delegate: { time_limit_ms: BACKSTOP_MS } },
          pollMs: 100, now: () => Date.now() + skewMs, inventoryFor: async () => swapFacts({ data: [{ id: 'fake-model' }] }),
          admit: async () => {
            // A long admission, and the server went away meanwhile.
            skewMs += 120000;
            const past = new Date(Date.now() - 60000);
            fs.utimesSync(path.join(supervisorHome, 'servers', 'srv-slow.json'), past, past);
          }
        });
        const stopped = await waitForTask(task.id, hasEnded, 8000);
        eq('supervisor slow start: the gap before the first poll is not a resume, so the stale heartbeat still counts', [stopped.state, stopped.stop_reason], ['stopped', 'session-closed']);
        await within(finished, 5000);
      });

      // ---- in this process: what the real supervisor processes cannot be handed ----
      {
        // A local task: the brief goes in a file, the key reaches the worker's environment only, admission is asked.
        const KEY = 'sk-fake-test-key-0123456789abcdef';
        const localSettings = {
          timeout_ms: 180000, local_runner: 'llama-swap', 'llama-swap.url': 'http://127.0.0.1:9292/v1',
          'llama-swap.key_env': 'CONSULT_FAKE_PI_KEY', delegate: { time_limit_ms: BACKSTOP_MS }
        };
        const inventoryFor = async () => swapFacts({ data: [{ id: 'fake-model' }] });
        const task = newTask({ worker: 'local', model: 'fake-model', mode: 'read' });
        const reportFile = reportFileFor(task);
        const admitted = [];
        setEnv('CONSULT_DELEGATE_TEST_BIN', fakeWorkerPath);
        setEnv('FAKE_SCENARIO', 'pi');
        setEnv('FAKE_REPORT_FILE', reportFile);
        setEnv('FAKE_KEY_VARIABLE', 'CONSULT_FAKE_PI_KEY');
        setEnv('FAKE_ECHO_KEY', '1');
        setEnv('CONSULT_FAKE_PI_KEY', KEY);
        await runSupervisor(task.id, { settings: localSettings, inventoryFor, pollMs: 100, admit: async (admittedTask) => { admitted.push(admittedTask.id); } });
        const piTask = readTask(task.id);
        eq('supervisor local: admission was asked once, for this task', admitted, [task.id]);
        eq('supervisor local: pi\'s answer is the summary and the task is done', [piTask.state, piTask.summary], ['done', 'Wrote the file with pi.']);
        eq('supervisor local: the session is the one the task was created with', piTask.worker_session, task.pi_session);
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        eq('supervisor local: the brief reached the worker as a file, not on stdin or argv', [report.promptLength, report.briefFileStart.startsWith('You are working alone'), report.args.some((arg) => arg.includes('Do the thing'))], [0, true, false]);
        eq('supervisor local: the key variable reached the worker', report.keyVariablePresent, true);
        let leakedIn = [];
        const folder = taskFolder(task.id);
        for (const name of fs.readdirSync(folder)) {
          const file = path.join(folder, name);
          if (fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes(KEY)) leakedIn.push(name);
        }
        if (fs.readFileSync(path.join(supervisorHome, 'index.json'), 'utf8').includes(KEY)) leakedIn.push('index.json');
        eq('supervisor local: the key value is in no file the supervisor wrote', leakedIn, []);
        eq('supervisor local: the worker echoed it and the log shows it redacted', fs.readFileSync(path.join(folder, 'log.jsonl'), 'utf8').includes('my key is [key]'), true);
        restoreEnv();
      }

      {
        // A codex task never asks for local admission.
        const task = newTask();
        let asked = 0;
        setEnv('CONSULT_DELEGATE_TEST_BIN', fakeWorkerPath);
        setEnv('FAKE_SCENARIO', 'ok');
        await runSupervisor(task.id, { settings: { delegate: { time_limit_ms: BACKSTOP_MS } }, pollMs: 100, admit: async () => { asked++; } });
        eq('supervisor admission: a codex task is done and never asks for admission', [readTask(task.id).state, asked], ['done', 0]);
        restoreEnv();
      }

      {
        // Waiting for admission: still queued, and a cancel ends it without a worker.
        const task = newTask({ worker: 'local', model: 'fake-model', mode: 'read' });
        let signalSeen = null;
        setEnv('CONSULT_DELEGATE_TEST_BIN', fakeWorkerPath);
        setEnv('FAKE_SCENARIO', 'hang');
        const localSettings = { timeout_ms: 180000, local_runner: 'llama-swap', 'llama-swap.url': 'http://127.0.0.1:9292/v1', delegate: { time_limit_ms: BACKSTOP_MS } };
        const finished = runSupervisor(task.id, {
          settings: localSettings, pollMs: 100, inventoryFor: async () => swapFacts({ data: [{ id: 'fake-model' }] }),
          admit: (admittedTask, { signal }) => { signalSeen = signal; return new Promise(() => {}); }
        });
        await sleep(500);
        eq('supervisor admission: while it waits the task stays queued', [readTask(task.id).state, readTask(task.id).started_at], ['queued', null]);
        fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
        await finished;
        const cancelled = readTask(task.id);
        eq('supervisor admission: a cancel during the wait ends it cancelled, never started', [cancelled.state, cancelled.started_at], ['cancelled', null]);
        eq('supervisor admission: the wait was told to stop', signalSeen?.aborted, true);
        restoreEnv();
      }

      {
        // Anything that goes wrong ends in a failed task with the message, not a throw.
        const badModel = newTask({ model: '-rf' });
        await runSupervisor(badModel.id, { settings: { delegate: { time_limit_ms: BACKSTOP_MS } }, pollMs: 100 });
        const failedTask = readTask(badModel.id);
        eq('supervisor errors: a command that cannot be built is a failed task naming the problem', [failedTask.state, failedTask.summary.includes('starts with "-"')], ['failed', true]);

        const finished = newTask();
        updateTask(finished.id, { state: 'done', summary: 'earlier' });
        await runSupervisor(finished.id, { settings: { delegate: { time_limit_ms: BACKSTOP_MS } }, pollMs: 100 });
        eq('supervisor errors: a task that is not queued is left as it is', [readTask(finished.id).state, readTask(finished.id).summary], ['done', 'earlier']);

        await runSupervisor('abcdef', { pollMs: 100 });
        eq('supervisor errors: when even the record cannot be written, supervisor-error.txt says why', fs.readFileSync(path.join(taskFolder('abcdef'), 'supervisor-error.txt'), 'utf8').includes('No delegate task'), true);
      }

      // ---- Task 8: local admission, the queue, and consult's own local calls ----
      // Fake runners only (fakeServer); a fresh data home so no earlier task counts as running.
      {
        const admissionHome = path.join(scratch, 'local admission home');
        process.env.CONSULT_DELEGATE_HOME = admissionHome;
        const servers = [];
        const serve = async (routes) => {
          const server = await fakeServer(routes);
          servers.push(server);
          return server;
        };
        const swapRunner = (url, extra = {}) => ({ type: 'llama-swap', url, key_env: null, start: null, legacy: false, api_key: null, nicknames: {}, ...extra });
        const runningEntry = (model, cmd = 'llama-server --port 10002 -np 1 -c 32768', state = 'ready') => ({ model, state, cmd, proxy: 'http://localhost:10002', ttl: 1800 });
        const modelEntry = (id) => ({ id, owned_by: 'llama-swap', context_length: 65536, meta: { llamaswap: { aliases: [`${id}:nothink`] } } });
        // A llama-swap whose /running answers what `held.models` holds now.
        const swapServer = (held, modelIds = ['fake-a', 'fake-b', 'fake-x', 'fake-y']) => serve({
          'GET /running': () => ({ json: { running: held.models } }),
          'GET /v1/models': () => ({ json: { data: modelIds.map(modelEntry) } })
        });
        const admissionSettings = (url, extra = {}) => ({
          ...DEFAULTS, local_runner: 'llama-swap', 'llama-swap.url': url, ...extra,
          delegate: { table: {}, local_at_once: 'auto', on_close: 'stop', time_limit_ms: BACKSTOP_MS }
        });
        const seedRunning = (model, title, url, extra = {}) => {
          const seeded = newTask({ worker: 'local', model, title, mode: 'read' });
          return updateTask(seeded.id, { state: 'running', runner_url: url, runner_model: model, supervisor_pid: process.pid, supervisor_beat_at: Date.now(), ...extra });
        };
        const seedWaiting = (model, createdAt) => {
          const seeded = newTask({ worker: 'local', model, mode: 'read', title: `waits for ${model}`, created_at: createdAt });
          return updateTask(seeded.id, { supervisor_pid: process.pid, supervisor_beat_at: Date.now() });
        };
        const endAllTasks = () => {
          for (const each of listTasks()) {
            if (each.state === 'running' || each.state === 'queued') updateTask(each.id, { state: 'done' });
          }
        };
        const startAdmission = (task, settings, options = {}) => {
          const handle = { controller: new AbortController(), failure: null };
          handle.done = admitLocalTask(task, { signal: handle.controller.signal, pollMs: 50, settings, ...options }).catch((error) => { handle.failure = error; });
          return handle;
        };
        const stateOf = (task) => readTask(task.id).state;
        const until = async (condition, timeoutMs = 20000) => {
          const giveUpAt = Date.now() + timeoutMs;
          while (!condition() && Date.now() < giveUpAt) await sleep(50);
        };
        const slowAnswer = (json, delayMs) => ({ stream: (response) => setTimeout(() => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(json));
        }, delayMs) });

        // -- what the runner can hold --
        {
          const cmds = [
            runningEntry('m-np', 'x -np 2 -c 1'), runningEntry('m-parallel', 'x --parallel 3'), runningEntry('m-equals', 'x --parallel=4'),
            runningEntry('m-none', 'x --port 1'), runningEntry('m-zero', 'x -np 0'), runningEntry('m-gone', 'x -np 2', 'stopped')
          ];
          const swap = await serve({ 'GET /running': () => ({ json: { running: cmds } }) });
          const capacity = await runnerCapacity(swapRunner(swap.url), 'test-key-123', {});
          eq('capacity llama-swap: slots come from -np / --parallel on the cmd, else 1; a stopped model is not loaded',
            capacity.loaded, [{ model: 'm-np', slots: 2, busy: 0 }, { model: 'm-parallel', slots: 3, busy: 0 }, { model: 'm-equals', slots: 4, busy: 0 }, { model: 'm-none', slots: 1, busy: 0 }, { model: 'm-zero', slots: 1, busy: 0 }]);
          eq('capacity llama-swap: it swaps (no groups to read) and has no VRAM figure', [capacity.canHoldTwo, capacity.freeVramMb], [false, null]);
          eq('capacity llama-swap: the key goes to the runner on this machine as a bearer header', swap.requests[0].headers.authorization, 'Bearer test-key-123');

          const locked = await serve({ 'GET /running': () => ({ status: 401, json: { error: 'key' } }) });
          eq('capacity: a runner that does not answer /running says nothing is known: nothing loaded, no room for two', await runnerCapacity(swapRunner(locked.url), null, {}), { loaded: [], canHoldTwo: false, freeVramMb: null });
          const downServer = await fakeServer({});
          await downServer.close();
          eq('capacity: a runner that is down is the same', await runnerCapacity(swapRunner(downServer.url), null, {}), { loaded: [], canHoldTwo: false, freeVramMb: null });

          const llamaServer = await serve({
            'GET /slots': () => ({ json: [{ id: 0, is_processing: true, n_ctx: 16384 }, { id: 1, is_processing: false, n_ctx: 16384 }] }),
            'GET /props': () => ({ json: { total_slots: 2, model_alias: 'props-alias' } }),
            'GET /v1/models': () => ({ json: { data: [modelEntry('fake-a')] } })
          });
          eq('capacity llama-server: /slots counts the busy slots, /v1/models names the model', await runnerCapacity(swapRunner(llamaServer.url, { type: 'llama-server' }), null, {}),
            { loaded: [{ model: 'fake-a', slots: 2, busy: 1 }], canHoldTwo: false, freeVramMb: null });
          const noSlotsRoute = await serve({ 'GET /props': () => ({ json: { total_slots: 3 } }), 'GET /v1/models': () => ({ json: { data: [modelEntry('fake-a')] } }) });
          eq('capacity llama-server: without /slots the slot count comes from /props, none busy', (await runnerCapacity(swapRunner(noSlotsRoute.url, { type: 'llama-server' }), null, {})).loaded, [{ model: 'fake-a', slots: 3, busy: 0 }]);

          const ollama = await serve({ 'GET /api/ps': () => ({ json: { models: [{ name: 'fake-a:latest', size: 4e9, size_vram: 3 * 1024 * 1024 * 1024 }] } }) });
          const ollamaRunner = swapRunner(ollama.url, { type: 'ollama' });
          eq('capacity ollama: no OLLAMA_* variables known means 1 slot, no room for two, free VRAM from the card', await runnerCapacity(ollamaRunner, null, { local_vram_mb: 8192 }),
            { loaded: [{ model: 'fake-a:latest', slots: 1, busy: 0 }], canHoldTwo: false, freeVramMb: 5120 });
          setEnv('OLLAMA_NUM_PARALLEL', '2');
          setEnv('OLLAMA_MAX_LOADED_MODELS', '2');
          eq('capacity ollama: OLLAMA_NUM_PARALLEL and OLLAMA_MAX_LOADED_MODELS from the environment', await runnerCapacity(ollamaRunner, null, { local_vram_mb: 8192 }),
            { loaded: [{ model: 'fake-a:latest', slots: 2, busy: 0 }], canHoldTwo: true, freeVramMb: 5120 });
          restoreEnv();

          const studio = await serve({ 'GET /api/v1/models': () => ({ json: { models: [
            { key: 'fake-a', type: 'llm', loaded_instances: [{ id: 'i1' }] }, { key: 'fake-b', type: 'llm', loaded_instances: [] }
          ] } }) });
          eq('capacity lmstudio: the loaded list, one slot each, no room for two', await runnerCapacity(swapRunner(studio.url, { type: 'lmstudio' }), null, {}),
            { loaded: [{ model: 'fake-a', slots: 1, busy: 0 }], canHoldTwo: false, freeVramMb: null });
        }

        // -- the ceiling --
        eq('ceilingFor: a number is the ceiling', ceilingFor(3, { loaded: [], canHoldTwo: false, freeVramMb: null }), 3);
        eq('ceilingFor: auto is the loaded slots', ceilingFor('auto', { loaded: [{ model: 'a', slots: 2, busy: 0 }], canHoldTwo: false, freeVramMb: null }), 2);
        eq('ceilingFor: auto with nothing loaded is 1', ceilingFor('auto', { loaded: [], canHoldTwo: false, freeVramMb: null }), 1);
        eq('ceilingFor: auto adds a second model when the runner can hold two', ceilingFor('auto', { loaded: [{ model: 'a', slots: 1, busy: 0 }], canHoldTwo: true, freeVramMb: 9000 }), 2);

        // -- the admission rules --
        {
          const factOf = (extra = {}) => ({ id: 'fake-a', context: 32768, ...extra });
          const capacityOf = (loaded, extra = {}) => ({ loaded, canHoldTwo: false, freeVramMb: null, ...extra });
          const taskOn = (model) => ({ id: 'aaaaaa', title: 't', model, runner_model: model });
          const verdict = (input) => admit({ model: 'fake-a', fact: factOf(), ceiling: 4, running: [], capacity: capacityOf([]), ...input });
          eq('admit: an idle runner takes it', verdict({}).ok, true);
          eq('admit: the loaded model with a free slot (2 slots, 1 task) is ok', verdict({ running: [taskOn('fake-a')], capacity: capacityOf([{ model: 'fake-a', slots: 2, busy: 0 }]) }).ok, true);
          eq('admit: the loaded model with no free slot (1 slot, 1 task) waits', verdict({ running: [taskOn('fake-a')], capacity: capacityOf([{ model: 'fake-a', slots: 1, busy: 0 }]) }).ok, false);
          eq('admit: 2 slots both busy waits', verdict({ running: [taskOn('fake-a'), taskOn('fake-a')], capacity: capacityOf([{ model: 'fake-a', slots: 2, busy: 0 }]) }).ok, false);
          eq('admit: unknown slots mean 1', verdict({ running: [taskOn('fake-a')], capacity: capacityOf([]) }).ok, false);
          eq('admit: a slot the runner reports busy counts even if no task of ours is on it', verdict({ running: [taskOn('fake-a')], capacity: capacityOf([{ model: 'fake-a', slots: 2, busy: 2 }]) }).ok, false);
          eq('admit: under 16K of context per slot waits', verdict({ fact: factOf({ context: 20000 }), running: [taskOn('fake-a')], capacity: capacityOf([{ model: 'fake-a', slots: 2, busy: 0 }]) }).ok, false);
          eq('admit: 16K of context per slot is enough', verdict({ fact: factOf({ context: 32768 }), running: [taskOn('fake-a')], capacity: capacityOf([{ model: 'fake-a', slots: 2, busy: 0 }]) }).ok, true);
          const swapping = verdict({ model: 'fake-b', fact: factOf({ id: 'fake-b' }), running: [taskOn('fake-a')], capacity: capacityOf([{ model: 'fake-a', slots: 1, busy: 0 }]) });
          eq('admit: another model on a runner that swaps waits, and the reason names the model in use', [swapping.ok, swapping.reason.includes('fake-a')], [false, true]);
          const bothFit = { canHoldTwo: true, freeVramMb: 6000 };
          const bigger = { model: 'fake-b', running: [taskOn('fake-a')], capacity: capacityOf([{ model: 'fake-a', slots: 1, busy: 0 }], bothFit) };
          eq('admit: another model when the runner holds two and free VRAM covers it and its context is ok', verdict({ ...bigger, fact: factOf({ id: 'fake-b', size_bytes: 4e9 }) }).ok, true);
          eq('admit: another model when free VRAM does not cover model plus context waits', verdict({ ...bigger, fact: factOf({ id: 'fake-b', size_bytes: 4e9 }), capacity: { ...bigger.capacity, freeVramMb: 5000 } }).ok, false);
          eq('admit: another model of unknown size waits', verdict({ ...bigger, fact: factOf({ id: 'fake-b' }) }).ok, false);
          eq('admit: a model that spills to RAM waits while anything runs', verdict({ fact: factOf({ fits_gpu: false }), running: [taskOn('fake-a')], capacity: capacityOf([{ model: 'fake-a', slots: 2, busy: 0 }]) }).ok, false);
          eq('admit: a model that spills to RAM runs alone', verdict({ fact: factOf({ fits_gpu: false }) }).ok, true);
          const atCeiling = verdict({ ceiling: 1, running: [taskOn('fake-a')], capacity: capacityOf([{ model: 'fake-a', slots: 2, busy: 0 }]) });
          eq('admit: never past the ceiling, even for the loaded model with a free slot', [atCeiling.ok, atCeiling.reason.includes('local_at_once')], [false, true]);
        }

        // -- the lock --
        {
          const lockPath = path.join(admissionHome, 'local.lock');
          let inside = 0;
          let overlapped = false;
          const critical = async () => {
            inside++;
            if (inside > 1) overlapped = true;
            await sleep(80);
            inside--;
            return 'done';
          };
          const results = await Promise.all([withLocalLock(critical), withLocalLock(critical), withLocalLock(critical)]);
          eq('withLocalLock: three admissions at once run one after another, and return the action\'s value', [overlapped, results], [false, ['done', 'done', 'done']]);
          let thrown = null;
          try { await withLocalLock(async () => { throw new Error('inside'); }); } catch (error) { thrown = error.message; }
          eq('withLocalLock: an action that throws still releases the lock', [thrown, fs.existsSync(lockPath)], ['inside', false]);
          fs.mkdirSync(lockPath, { recursive: true });
          const past = new Date(Date.now() - 31000);
          fs.utimesSync(lockPath, past, past);
          const brokenAt = Date.now();
          await withLocalLock(async () => {});
          eq('withLocalLock: a lock older than 30 s belongs to a dead holder and is broken at once', Date.now() - brokenAt < 2000, true);
          fs.mkdirSync(lockPath, { recursive: true });
          const young = new Date(Date.now() - 20000);
          fs.utimesSync(lockPath, young, young);
          setTimeout(() => fs.rmSync(lockPath, { recursive: true, force: true }), 300);
          const waitedFrom = Date.now();
          await withLocalLock(async () => {});
          eq('withLocalLock: a 20 s old lock is not stale: it waits for the holder', Date.now() - waitedFrom >= 250, true);

          // A holder that stalls past the stale time (a suspend, a slow probe) loses its lock to a waiter.
          // It must find that out, and must not remove the lock the waiter now holds.
          let firstStillOwnedAfterStall = null;
          let secondStillOwnedAtEnd = null;
          const first = withLocalLock(async (lock) => {
            const stalled = new Date(Date.now() - 31000);
            fs.utimesSync(lockPath, stalled, stalled);
            await sleep(500);
            firstStillOwnedAfterStall = lock.stillOwned();
          });
          await sleep(100);
          const second = withLocalLock(async (lock) => {
            await sleep(700); // the first one has left and released by now
            secondStillOwnedAtEnd = lock.stillOwned();
          });
          await Promise.all([first, second]);
          eq('withLocalLock: a holder that lost its stale lock to a waiter can tell', firstStillOwnedAfterStall, false);
          eq('withLocalLock: and its release does not remove the lock the waiter holds', [secondStillOwnedAtEnd, fs.existsSync(lockPath)], [true, false]);
        }

        // -- the task lock has the same rule --
        {
          const probe = newTask();
          const taskLock = path.join(taskFolder(probe.id), '.lock');
          let decided = 0;
          const startedAt = Date.now();
          const result = updateTaskWhen(probe.id, () => {
            decided++;
            if (decided === 1) {
              // Another process judged this lock stale and took it over while this one was inside; its own lock is 9.5 s old.
              fs.rmSync(taskLock, { recursive: true, force: true });
              fs.mkdirSync(taskLock);
              fs.writeFileSync(path.join(taskLock, 'owner'), 'someone-else');
              const nearlyStale = new Date(Date.now() - 9500);
              fs.utimesSync(taskLock, nearlyStale, nearlyStale);
            }
            return { summary: `decided ${decided}` };
          });
          eq('task lock: a holder that lost the lock writes nothing, and decides again from the state it then finds', [decided, result.summary, readTask(probe.id).summary], [2, 'decided 2', 'decided 2']);
          eq('task lock: and it left the other holder\'s lock alone until it went stale', Date.now() - startedAt >= 300, true);
          eq('task lock: the folder is released at the end', fs.existsSync(taskLock), false);
        }

        // -- a lock held by a process that exits --
        {
          const lockPath = path.join(admissionHome, 'local.lock');
          const localModule = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'delegate-local.js')).href;
          execFileSync(process.execPath, ['--input-type=module', '-e', `import { withLocalLock } from ${JSON.stringify(localModule)}; await withLocalLock(async () => { process.exit(0); });`], {
            env: { ...process.env, CONSULT_DELEGATE_HOME: admissionHome }, stdio: 'ignore'
          });
          const leftBehind = fs.existsSync(lockPath);
          fs.rmSync(lockPath, { recursive: true, force: true });
          eq('withLocalLock: a process that exits while holding it does not leave it behind', leftBehind, false);
        }

        // -- consult's own one-shot calls --
        const held = { models: [runningEntry('fake-a')] };
        const guardServer = await swapServer(held);
        const guardRunner = swapRunner(guardServer.url);
        {
          eq('guardOneShot: with no task running it passes without asking the runner anything', [await guardOneShot({ runner: guardRunner, model: 'fake-b' }), guardServer.requests.length], [undefined, 0]);
          const seeded = seedRunning('fake-a', 'unit tests', guardServer.url);
          let refusal = null;
          try { await guardOneShot({ runner: guardRunner, model: 'fake-b' }); } catch (error) { refusal = error.message; }
          eq('guardOneShot: another model while a task holds the runner is refused, naming the task, its title and its model',
            refusal, `local runner busy: task ${seeded.id} 'unit tests' is using fake-a; ask for that model, wait, or cancel the task`);
          eq('guardOneShot: the model the task holds passes', await guardOneShot({ runner: guardRunner, model: 'fake-a' }), undefined);
          const aliasInventory = swapFacts({ data: ['fake-a', 'fake-b'].map(modelEntry) });
          eq('guardOneShot: an alias of the model the task holds is that model, so it passes', await guardOneShot({ runner: guardRunner, model: 'fake-a:nothink', inventory: aliasInventory }), undefined);
          let aliasRefusal = null;
          try { await guardOneShot({ runner: guardRunner, model: 'fake-b:nothink', inventory: aliasInventory }); } catch (error) { aliasRefusal = error.message; }
          eq('guardOneShot: an alias of another model is still refused', aliasRefusal?.startsWith('local runner busy: task'), true);
          const elsewhere = seedRunning('fake-z', 'elsewhere', 'http://127.0.0.1:1/v1');
          updateTask(seeded.id, { state: 'done' });
          eq('guardOneShot: a task on another runner does not hold this one', await guardOneShot({ runner: guardRunner, model: 'fake-b' }), undefined);
          updateTask(elsewhere.id, { state: 'done' });
          const exited = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
          const deadPid = exited.pid;
          await new Promise((resolve) => exited.on('exit', resolve));
          seedRunning('fake-a', 'orphan', guardServer.url, { supervisor_pid: deadPid });
          eq('guardOneShot: a task whose supervisor is gone holds nothing', await guardOneShot({ runner: guardRunner, model: 'fake-b' }), undefined);
          endAllTasks();
          // A supervisor killed hard leaves `running` behind, and its pid may be alive again as someone else's process.
          const stale = seedRunning('fake-a', 'recycled', guardServer.url, { supervisor_beat_at: Date.now() - 60000 });
          eq('guardOneShot: a task whose supervisor is alive but has not beaten for 60 s holds nothing', await guardOneShot({ runner: guardRunner, model: 'fake-b' }), undefined);
          updateTask(stale.id, { supervisor_beat_at: Date.now() - 40000 });
          let stillHeld = null;
          try { await guardOneShot({ runner: guardRunner, model: 'fake-b' }); } catch (error) { stillHeld = error.message; }
          eq('guardOneShot: one that beat 40 s ago still holds the runner', stillHeld?.startsWith('local runner busy'), true);
          endAllTasks();
          // A record that cannot be read, and was written a moment ago, might be a running task: hold.
          const unreadableFolder = taskFolder('a1b2c3');
          fs.mkdirSync(unreadableFolder, { recursive: true });
          fs.writeFileSync(path.join(unreadableFolder, 'state.json'), '{ not json');
          let unreadableRefusal = null;
          try { await guardOneShot({ runner: guardRunner, model: 'fake-b' }); } catch (error) { unreadableRefusal = error.message; }
          eq('guardOneShot: a record it cannot read, written just now, counts as holding the runner', unreadableRefusal?.includes('a1b2c3'), true);
          const longAgo = new Date(Date.now() - 120000);
          fs.utimesSync(path.join(unreadableFolder, 'state.json'), longAgo, longAgo);
          eq('guardOneShot: and one that is old is only a broken file', await guardOneShot({ runner: guardRunner, model: 'fake-b' }), undefined);
          fs.rmSync(unreadableFolder, { recursive: true, force: true });
          const roomy = await serve({ 'GET /api/ps': () => ({ json: { models: [{ name: 'fake-a', size: 1, size_vram: 1 }] } }) });
          seedRunning('fake-a', 'on ollama', roomy.url);
          setEnv('OLLAMA_MAX_LOADED_MODELS', '2');
          eq('guardOneShot: a runner that can hold two passes another model', await guardOneShot({ runner: swapRunner(roomy.url, { type: 'ollama' }), model: 'fake-b', settings: { local_vram_mb: 8192 } }), undefined);
          restoreEnv();
          endAllTasks();
        }

        // -- the admission loop --
        {
          const loaded = { models: [runningEntry('fake-a')] };
          const swap = await swapServer(loaded);
          const settings = admissionSettings(swap.url);
          const first = newTask({ worker: 'local', model: 'fake-a', mode: 'read', title: 'first' });
          const firstHandle = startAdmission(first, settings);
          await firstHandle.done;
          const admittedFirst = readTask(first.id);
          eq('admission: an idle runner admits at once: running, with the runner and the model recorded', [admittedFirst.state, admittedFirst.runner_model, admittedFirst.runner_url], ['running', 'fake-a', swap.url]);
          const second = newTask({ worker: 'local', model: 'fake-a', mode: 'read', title: 'second' });
          updateTask(second.id, { supervisor_pid: process.pid, supervisor_beat_at: Date.now() });
          const secondHandle = startAdmission(second, settings);
          await sleep(400);
          eq('admission: the same model with its only slot taken waits, queued, and shows the model it waits for', [stateOf(second), readTask(second.id).queue_model], ['queued', 'fake-a']);
          updateTask(first.id, { state: 'done' });
          await secondHandle.done;
          eq('admission: once the slot is free the waiting task is admitted', stateOf(second), 'running');
          const third = newTask({ worker: 'local', model: 'fake-b', mode: 'read', title: 'third' });
          const thirdHandle = startAdmission(third, settings);
          await sleep(400);
          eq('admission: another model while the first runs waits (the runner swaps)', stateOf(third), 'queued');
          thirdHandle.controller.abort();
          await thirdHandle.done;
          eq('admission: an abort ends the wait quietly and leaves the task queued', [stateOf(third), thirdHandle.failure], ['queued', null]);
          const unknown = newTask({ worker: 'local', model: 'no-such-model-anywhere', mode: 'read', title: 'unknown' });
          const unknownHandle = startAdmission(unknown, settings);
          await within(unknownHandle.done, 3000);
          eq('admission: a model that cannot be resolved is not held back: the worker start reports it', [stateOf(unknown), unknownHandle.failure], ['queued', null]);
          endAllTasks();
        }

        // -- a model named by an alias --
        {
          const swap = await swapServer({ models: [] });
          const aliased = newTask({ worker: 'local', model: 'fake-a:nothink', mode: 'read', title: 'aliased' });
          await startAdmission(aliased, admissionSettings(swap.url)).done;
          eq('admission: a task that names an alias is recorded under the model\'s id, the one the runner reports', [stateOf(aliased), readTask(aliased.id).runner_model], ['running', 'fake-a']);
          endAllTasks();
        }

        // -- a failure inside a tick --
        {
          const swap = await swapServer({ models: [] });
          const settings = admissionSettings(swap.url);
          let calls = 0;
          const flaky = newTask({ worker: 'local', model: 'fake-a', mode: 'read', title: 'flaky' });
          const handle = { failure: null };
          await admitLocalTask(flaky, {
            signal: new AbortController().signal, pollMs: 20, settings,
            capacityFor: async (...capacityArguments) => {
              calls++;
              if (calls <= 2) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
              return runnerCapacity(...capacityArguments);
            }
          }).catch((error) => { handle.failure = error; });
          eq('admission: a transient failure in a tick is tried again on the next, and the task is then admitted', [handle.failure, stateOf(flaky), calls], [null, 'running', 3]);
          endAllTasks();
          const doomed = newTask({ worker: 'local', model: 'fake-a', mode: 'read', title: 'doomed' });
          await admitLocalTask(doomed, {
            signal: new AbortController().signal, pollMs: 20, settings,
            capacityFor: async () => { throw new Error('the runner probe is broken for good'); }
          }).catch((error) => { handle.failure = error.message; });
          eq('admission: a failure that never goes away ends the wait with its message', [handle.failure, stateOf(doomed)], ['the runner probe is broken for good', 'queued']);
          endAllTasks();
        }

        // -- a holder that lost the lock while it looked at the runner --
        {
          const slow = await serve({
            'GET /running': () => slowAnswer({ running: [] }, 500),
            'GET /v1/models': () => ({ json: { data: ['fake-a', 'fake-b'].map(modelEntry) } })
          });
          const settings = admissionSettings(slow.url);
          const taskA = newTask({ worker: 'local', model: 'fake-a', mode: 'read', title: 'a' });
          const taskB = newTask({ worker: 'local', model: 'fake-b', mode: 'read', title: 'b' });
          const handles = [startAdmission(taskA, settings)];
          await sleep(200);
          const stalled = new Date(Date.now() - 31000);
          fs.utimesSync(path.join(admissionHome, 'local.lock'), stalled, stalled); // the first one's probe is taking "30 s"
          handles.push(startAdmission(taskB, settings));
          await until(() => stateOf(taskA) === 'running' || stateOf(taskB) === 'running');
          await sleep(1500);
          eq('admission: a holder whose lock was taken over while it waited for the runner admits nothing', [stateOf(taskA), stateOf(taskB)].sort(), ['queued', 'running']);
          for (const handle of handles) handle.controller.abort();
          await Promise.all(handles.map((handle) => handle.done));
          endAllTasks();
        }

        // -- a holder that loses the local lock while its write waits out a refused rename --
        {
          const swap = await swapServer({ models: [] });
          const task = newTask({ worker: 'local', model: 'fake-a', mode: 'read', title: 'rename refused' });
          const statePath = path.join(taskFolder(task.id), 'state.json');
          const localLockPath = path.join(admissionHome, 'local.lock');
          const realRenameSync = fs.renameSync;
          let refusedUntil = null;
          fs.renameSync = (from, to, ...rest) => {
            if (String(to) === statePath && (refusedUntil === null || Date.now() < refusedUntil)) {
              if (refusedUntil === null) {
                refusedUntil = Date.now() + 400;
                fs.writeFileSync(path.join(localLockPath, 'owner'), 'someone-else'); // the local lock is taken over meanwhile
              }
              throw Object.assign(new Error('EPERM: stubbed'), { code: 'EPERM' });
            }
            return realRenameSync(from, to, ...rest);
          };
          let handle = null;
          try {
            handle = startAdmission(task, admissionSettings(swap.url));
            await until(() => refusedUntil !== null, 5000);
            await sleep(900);
          } finally {
            fs.renameSync = realRenameSync;
          }
          eq('admission: a write that lost the local lock while its rename was refused admits nothing', stateOf(task), 'queued');
          handle.controller.abort();
          fs.rmSync(localLockPath, { recursive: true, force: true });
          await handle.done;
          endAllTasks();
        }

        // -- the skipped_by write for an older task has the same rule --
        {
          const swap = await swapServer({ models: [runningEntry('fake-y', 'llama-server -np 4 -c 65536')] });
          seedRunning('fake-y', 'holder', swap.url);
          const base = Date.now() - 600000;
          const oldest = seedWaiting('fake-x', base);
          const jumper = seedWaiting('fake-y', base + 1000);
          const oldestStatePath = path.join(taskFolder(oldest.id), 'state.json');
          const localLockPath = path.join(admissionHome, 'local.lock');
          const realRenameSync = fs.renameSync;
          let refusedUntil = null;
          fs.renameSync = (from, to, ...rest) => {
            if (String(to) === oldestStatePath && (refusedUntil === null || Date.now() < refusedUntil)) {
              if (refusedUntil === null) {
                refusedUntil = Date.now() + 400;
                fs.writeFileSync(path.join(localLockPath, 'owner'), 'someone-else'); // the local lock is taken over meanwhile
              }
              throw Object.assign(new Error('EPERM: stubbed'), { code: 'EPERM' });
            }
            return realRenameSync(from, to, ...rest);
          };
          let handle = null;
          try {
            handle = startAdmission(jumper, admissionSettings(swap.url));
            await until(() => refusedUntil !== null, 5000);
            await sleep(900);
          } finally {
            fs.renameSync = realRenameSync;
          }
          eq('admission: a skipped_by write that lost the local lock while its rename was refused lands nowhere, and the newer task is not admitted',
            [readTask(oldest.id).skipped_by ?? 0, stateOf(jumper)], [0, 'queued']);
          handle.controller.abort();
          fs.rmSync(localLockPath, { recursive: true, force: true });
          await handle.done;
          endAllTasks();
        }

        // -- two admissions on one snapshot --
        {
          const slow = await serve({
            'GET /running': () => slowAnswer({ running: [] }, 250),
            'GET /v1/models': () => ({ json: { data: ['fake-a', 'fake-b'].map(modelEntry) } })
          });
          const settings = admissionSettings(slow.url);
          const taskA = newTask({ worker: 'local', model: 'fake-a', mode: 'read', title: 'a' });
          const taskB = newTask({ worker: 'local', model: 'fake-b', mode: 'read', title: 'b' });
          const handles = [startAdmission(taskA, settings), startAdmission(taskB, settings)];
          await until(() => stateOf(taskA) === 'running' || stateOf(taskB) === 'running');
          await sleep(800); // the other one polls the lock and the runner meanwhile
          eq('two admissions started together for different models: the second sees the first running and waits',[stateOf(taskA), stateOf(taskB)].sort(), ['queued', 'running']);
          for (const handle of handles) handle.controller.abort();
          await Promise.all(handles.map((handle) => handle.done));
          endAllTasks();
        }

        // -- the queue order --
        {
          const loaded = { models: [runningEntry('fake-y', 'llama-server -np 4 -c 65536')] };
          const swap = await swapServer(loaded);
          const settings = admissionSettings(swap.url);
          seedRunning('fake-y', 'holder', swap.url);
          const base = Date.now() - 600000;
          const oldest = seedWaiting('fake-x', base);
          const jumpers = [seedWaiting('fake-y', base + 1000), seedWaiting('fake-y', base + 2000), seedWaiting('fake-y', base + 3000)];
          const handles = [startAdmission(oldest, settings), ...jumpers.map((jumper) => startAdmission(jumper, settings))];
          await until(() => stateOf(jumpers[0]) === 'running' && stateOf(jumpers[1]) === 'running');
          await sleep(800); // the others keep polling meanwhile
          eq('queue: a task for the loaded model goes ahead of the oldest, which is for another model',[stateOf(jumpers[0]), stateOf(jumpers[1])], ['running', 'running']);
          eq('queue: the oldest was skipped twice, and the third newer task for the loaded model waits for it', [stateOf(oldest), readTask(oldest.id).skipped_by, stateOf(jumpers[2])], ['queued', 2, 'queued']);
          for (const jumper of jumpers.slice(0, 2)) updateTask(jumper.id, { state: 'done' });
          for (const each of listTasks()) {
            if (each.state === 'running' && each.title === 'holder') updateTask(each.id, { state: 'done' });
          }
          await until(() => stateOf(oldest) === 'running');
          await sleep(300);
          eq('queue: once the loaded model is idle the oldest runs, and the other waits behind it', [stateOf(oldest), stateOf(jumpers[2])], ['running', 'queued']);
          for (const handle of handles) handle.controller.abort();
          await Promise.all(handles.map((handle) => handle.done));
          endAllTasks();
        }

        // -- waiting too long --
        {
          const swap = await swapServer({ models: [runningEntry('fake-a')] });
          const settings = admissionSettings(swap.url);
          seedRunning('fake-a', 'holder', swap.url);
          const patient = seedWaiting('fake-b', Date.now() - 31 * 60000);
          const recent = seedWaiting('fake-b', Date.now() - 60000);
          // A follow-up requeues an old task: it has waited since the requeue, not since its creation.
          const followedUp = seedWaiting('fake-b', Date.now() - 3 * 3600000);
          updateTask(followedUp.id, { queued_at: Date.now() - 60000 });
          const waitedAgain = seedWaiting('fake-b', Date.now() - 3 * 3600000);
          updateTask(waitedAgain.id, { queued_at: Date.now() - 31 * 60000 });
          const handles = [startAdmission(patient, settings), startAdmission(recent, settings), startAdmission(followedUp, settings), startAdmission(waitedAgain, settings)];
          await until(() => readTask(patient.id).queue_waiting_long === true && readTask(waitedAgain.id).queue_waiting_long === true);
          await sleep(300);
          eq('queue: a task waiting more than 30 minutes is marked, one that waits less is not', [readTask(patient.id).queue_waiting_long, readTask(recent.id).queue_waiting_long], [true, false]);
          eq('queue: a follow-up on an old task is not marked until it has waited 30 minutes since its requeue', [readTask(followedUp.id).queue_waiting_long, readTask(waitedAgain.id).queue_waiting_long], [false, true]);
          for (const handle of handles) handle.controller.abort();
          await Promise.all(handles.map((handle) => handle.done));
          endAllTasks();
        }

        // -- two supervisors in the same tick (Review Focus 4) --
        {
          // End-to-end evidence only: each supervisor's launch gives its task a beat, so the newer sees the older as waiting and
          // steps back whatever the lock does. The lock itself is tested by the in-process admissions above on a slow runner.
          const swap = await serve({
            'GET /running': () => slowAnswer({ running: [] }, 300),
            'GET /v1/models': () => ({ json: { data: ['fake-a', 'fake-b'].map(modelEntry) } })
          });
          fs.mkdirSync(path.join(fakeUserHome, '.claude'), { recursive: true });
          fs.writeFileSync(path.join(fakeUserHome, '.claude', 'consult.local.md'), `---\nlocal_runner: llama-swap\nllama-swap.url: ${swap.url}\n---\n`);
          const taskA = newTask({ worker: 'local', model: 'fake-a', mode: 'read', title: 'first' });
          const taskB = newTask({ worker: 'local', model: 'fake-b', mode: 'read', title: 'second' });
          launchWith(taskA, { FAKE_SCENARIO: 'hang' });
          launchWith(taskB, { FAKE_SCENARIO: 'hang' });
          const giveUpAt = Date.now() + 25000;
          while (Date.now() < giveUpAt && ![taskA, taskB].some((each) => isRunning(readTask(each.id)))) await sleep(50);
          await sleep(1500); // the loser polls the lock and the runner several times meanwhile
          const states = [readTask(taskA.id).state, readTask(taskB.id).state].sort();
          eq('two supervisors started together for different models on a swapping runner: exactly one running, one queued', states, ['queued', 'running']);
          const winner = isRunning(readTask(taskA.id)) ? taskA : taskB;
          const loser = winner === taskA ? taskB : taskA;
          const winnerWorkerPid = readTask(winner.id).worker_pid;
          fs.writeFileSync(path.join(taskFolder(winner.id), 'cancel'), '');
          const next = await waitForTask(loser.id, isRunning, 25000);
          eq('the queued one starts once the running one is cancelled', [readTask(winner.id).state, next.state], ['cancelled', 'running']);
          const loserWorkerPid = next.worker_pid;
          fs.writeFileSync(path.join(taskFolder(loser.id), 'cancel'), '');
          await waitForTask(loser.id, hasEnded, 15000);
          eq('both are cancelled and both workers are gone', [stateOf(winner), stateOf(loser), await waitForPidGone(winnerWorkerPid, 5000), await waitForPidGone(loserWorkerPid, 5000)], ['cancelled', 'cancelled', true, true]);
        }

        // -- ask_local through the real tool handler, and a council member --
        {
          const holder = { models: [runningEntry('fake-a')] };
          const runner = await serve({
            'GET /running': () => ({ json: { running: holder.models } }),
            'GET /v1/models': () => ({ json: { data: ['fake-a', 'fake-b'].map(modelEntry) } }),
            'POST /v1/chat/completions': () => ({ stream: (response) => {
              response.writeHead(200, { 'Content-Type': 'text/event-stream' });
              response.write(`data: ${JSON.stringify({ model: 'fake-a', choices: [{ index: 0, delta: { content: 'four' }, finish_reason: null }] })}\n\n`);
              response.write('data: [DONE]\n\n');
              response.end();
            } })
          });
          const seeded = seedRunning('fake-a', 'unit tests', runner.url);
          const wanted = `local runner busy: task ${seeded.id} 'unit tests' is using fake-a; ask for that model, wait, or cancel the task`;
          fs.writeFileSync(path.join(fakeUserHome, '.claude', 'consult.local.md'), `---\nlocal_runner: llama-swap\nllama-swap.url: ${runner.url}\nllama-swap.default: fake-b\n---\n`);
          setEnv('USERPROFILE', fakeUserHome);
          setEnv('HOME', fakeUserHome);
          const mcp = startServer({ cwd: admissionHome });
          try {
            await handshake(mcp.send);
            mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_local', arguments: { prompt: 'hi', model: 'fake-b' } } });
            const refused = await mcp.waitFor(2, 20000);
            eq('ask_local through consult.js while a task holds another model: an error result with the task named', [refused.result?.isError, refused.result?.content?.[0]?.text], [true, wanted]);
            eq('ask_local: the refused call sent nothing to the model', runner.requests.filter((request) => request.method === 'POST').length, 0);
            mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_local', arguments: { prompt: 'hi', model: 'fake-a' } } });
            const answered = await mcp.waitFor(3, 20000);
            eq('ask_local: a call for the model the task holds goes through', [answered.result?.isError ?? false, unpack(answered).response], [false, 'four']);
            mcp.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'local_unload', arguments: { runner: 'llama-swap' } } });
            const unloadRefused = await mcp.waitFor(4, 20000);
            eq('local_unload while a task runs on the runner: an error result naming the task', [unloadRefused.result?.isError, unloadRefused.result?.content?.[0]?.text],
              [true, `local runner busy: task ${seeded.id} 'unit tests' is using fake-a; wait, or cancel the task, before unloading it`]);
            eq('local_unload: the refused call asked the runner to unload nothing', runner.requests.filter((request) => request.path === '/unload').length, 0);
          } finally {
            await mcp.kill();
          }
          restoreEnv();
          const ask = makeAsker('local', admissionSettings(runner.url, { 'llama-swap.default': 'fake-b' }), undefined, undefined, null);
          let councilRefusal = null;
          try { await ask('hi'); } catch (error) { councilRefusal = error.message; }
          eq('a local council member is refused the same way', councilRefusal, wanted);
          endAllTasks();
        }
        for (const server of servers) await server.close();
        process.env.CONSULT_DELEGATE_HOME = supervisorHome;
      }
    } finally {
      restoreEnv();
      process.env.CONSULT_DELEGATE_HOME = previousHome;
      process.noDeprecation = previousNoDeprecation;
      // Whatever a failed test left running must not outlive it. A supervisor on a starved
      // machine can take a while to exit after its last write; the wait ends as soon as all are gone.
      const giveUpAt = Date.now() + 60000;
      while (launchedPids.some(isProcessAlive) && Date.now() < giveUpAt) await sleep(100);
      for (const pid of launchedPids) {
        if (isProcessAlive(pid)) { console.log(`FAIL supervisor ${pid} was still running after its task ended`); failed++; killProcessTreeIfOurs(pid); }
      }
      for (const pid of recordedGrandchildPids) {
        if (isProcessAlive(pid)) killProcessTreeIfOurs(pid);
      }
    }
    const leftovers = leftoverFakeProcesses();
    for (const pid of leftovers) console.log(`  leftover ${pid}: ${commandLineOf(pid).trim().slice(0, 200)}`);
    eq('supervisor: no fake worker or grandchild process is left running', leftovers, []);
  }

  // ---- Task 9: usage limits (limits.json, the codex rollout fallback, the policy) ----
  {
    const limitsHome = path.join(scratch, 'limits home');
    const limitsCodexHome = path.join(scratch, 'limits codex home');
    const previousDelegateHome = process.env.CONSULT_DELEGATE_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CONSULT_DELEGATE_HOME = limitsHome;
    process.env.CODEX_HOME = limitsCodexHome;
    fs.mkdirSync(limitsHome, { recursive: true });
    fs.mkdirSync(limitsCodexHome, { recursive: true });
    const limitsFile = path.join(limitsHome, 'limits.json');
    const MINUTE = 60000;
    const HOUR = 60 * MINUTE;
    const now = new Date(2026, 9, 27, 12, 0, 0).getTime(); // local noon, far from a date change
    const seconds = (milliseconds) => Math.round(milliseconds / 1000); // codex writes resets_at in epoch seconds
    const codexLimit = (primaryPercent, primaryResetsAt, secondaryPercent = null, secondaryResetsAt = null) => ({
      primary: primaryPercent === null ? null : { used_percent: primaryPercent, window_minutes: 300, resets_at: seconds(primaryResetsAt) },
      secondary: secondaryPercent === null ? null : { used_percent: secondaryPercent, window_minutes: 10080, resets_at: seconds(secondaryResetsAt) }
    });
    const forgetLimits = () => fs.rmSync(limitsFile, { force: true });
    const guarded = (label, body) => {
      try {
        body();
      } catch (error) {
        console.log(`FAIL ${label} threw: ${error.message}`);
        failed++;
      }
    };
    // A rollout file under <codex home>/sessions/YYYY/MM/DD (local date, daysBack days before `now`), modified at `modifiedAt`.
    const writeRollout = (daysBack, name, rateLimits, modifiedAt) => {
      const day = new Date(now);
      day.setDate(day.getDate() - daysBack);
      const folder = path.join(limitsCodexHome, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      fs.mkdirSync(folder, { recursive: true });
      const lines = [JSON.stringify({ type: 'session_meta', payload: { id: name } })];
      if (rateLimits !== null) lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rateLimits } }));
      const file = path.join(folder, `rollout-2026-10-27T10-00-00-${name}.jsonl`);
      fs.writeFileSync(file, lines.join('\n') + '\n');
      fs.utimesSync(file, new Date(modifiedAt), new Date(modifiedAt));
    };
    const forgetRollouts = () => fs.rmSync(path.join(limitsCodexHome, 'sessions'), { recursive: true, force: true });
    const window = (minutes, usedPercent, resetsAt) => ({ minutes, used_percent: usedPercent, resets_at: resetsAt });

    try {
      // -- recording, and reading it back --
      guarded('limits: nothing recorded', () => {
        forgetLimits();
        const empty = lastLimits(now);
        eq('lastLimits: with nothing recorded and no rollout there is nothing', [empty.codex, empty.agy], [null, null]);
      });
      guarded('limits: record and read', () => {
        forgetLimits();
        const resetsAtPrimary = now + 2 * HOUR;
        const resetsAtSecondary = now + 70 * HOUR;
        recordLimit('codex', codexLimit(92, resetsAtPrimary, 41, resetsAtSecondary), now - 10 * MINUTE);
        const read = lastLimits(now);
        eq('lastLimits: the windows come from primary then secondary, with their times in ms', read.codex.windows,
          [window(300, 92, seconds(resetsAtPrimary) * 1000), window(10080, 41, seconds(resetsAtSecondary) * 1000)]);
        eq('lastLimits: the reading\'s time, fresh, and no hit', [read.codex.at, read.codex.stale, read.codex.hit], [now - 10 * MINUTE, false, null]);
        truthy('recordLimit: limits.json is in the data folder, and no temp file is left beside it', fs.existsSync(limitsFile) && fs.readdirSync(limitsHome).filter((name) => name.startsWith('limits.json.')).length === 0);
      });
      guarded('limits: null windows', () => {
        forgetLimits();
        recordLimit('codex', codexLimit(30, now + HOUR, null), now);
        eq('recordLimit: a null window is skipped', lastLimits(now).codex.windows.map((each) => each.minutes), [300]);
        recordLimit('codex', { primary: null, secondary: null }, now + MINUTE);
        recordLimit('codex', null, now + MINUTE);
        eq('recordLimit: a limit with no window teaches nothing, and keeps what was known', [lastLimits(now).codex.windows.length, lastLimits(now).codex.at], [1, now]);
      });
      guarded('limits: stale', () => {
        forgetLimits();
        recordLimit('codex', codexLimit(50, now + 3 * HOUR), now - 29 * MINUTE);
        eq('lastLimits: a reading 29 min old is not stale', lastLimits(now).codex.stale, false);
        recordLimit('codex', codexLimit(50, now + 3 * HOUR), now - 40 * MINUTE);
        const old = lastLimits(now);
        eq('lastLimits: a reading 40 min old is stale', [old.codex.stale, old.codex.at], [true, now - 40 * MINUTE]);
      });
      guarded('limits: a hit', () => {
        forgetLimits();
        recordLimitHit('agy', { kind: 'exhausted', resets_at: null }, now - 10 * MINUTE);
        eq('lastLimits: an agy hit with no reset time', lastLimits(now).agy, { hit_at: now - 10 * MINUTE, resets_at: null, kind: 'exhausted' });
        recordLimitHit('agy', { kind: 'throttled', resets_at: now + HOUR }, now - MINUTE);
        eq('lastLimits: the latest agy hit wins, its reset in ms', lastLimits(now).agy, { hit_at: now - MINUTE, resets_at: now + HOUR, kind: 'throttled' });
        recordLimit('codex', codexLimit(10, now + HOUR), now);
        recordLimitHit('codex', { kind: 'exhausted', resets_at: now + HOUR }, now);
        const both = lastLimits(now);
        eq('lastLimits: a codex hit sits with the codex windows; other records are kept', [both.codex.hit, both.codex.windows.length, both.agy.hit_at], [{ hit_at: now, resets_at: now + HOUR, kind: 'exhausted' }, 1, now - MINUTE]);
      });
      guarded('limits: bad file', () => {
        fs.writeFileSync(limitsFile, '{ this is not json');
        eq('lastLimits: a corrupt limits.json is empty, not a throw', [lastLimits(now).codex, lastLimits(now).agy], [null, null]);
        fs.writeFileSync(limitsFile, '[1,2]');
        eq('lastLimits: so is one of the wrong shape', [lastLimits(now).codex, lastLimits(now).agy], [null, null]);
        recordLimitHit('agy', { kind: 'exhausted', resets_at: null }, now);
        eq('recordLimitHit: writing over a corrupt file starts it again', lastLimits(now).agy, { hit_at: now, resets_at: null, kind: 'exhausted' });
        forgetLimits();
      });

      // -- fresh codex data from the newest rollout --
      guarded('limits: rollout fallback', () => {
        forgetLimits();
        forgetRollouts();
        writeRollout(0, 'aaaa0001', codexLimit(50, now + 2 * HOUR, 20, now + 60 * HOUR), now - 5 * MINUTE);
        const fromRollout = lastLimits(now);
        eq('lastLimits: with nothing recorded the newest rollout of today gives the windows', fromRollout.codex.windows, [window(300, 50, seconds(now + 2 * HOUR) * 1000), window(10080, 20, seconds(now + 60 * HOUR) * 1000)]);
        eq('lastLimits: its time is the file\'s modification time', [fromRollout.codex.at, fromRollout.codex.stale], [now - 5 * MINUTE, false]);

        recordLimit('codex', codexLimit(70, now + HOUR), now - 2 * MINUTE);
        eq('lastLimits: a recorded reading under 30 min old is used as it is, the rollouts are not read', lastLimits(now).codex.windows[0].used_percent, 70);

        recordLimit('codex', codexLimit(70, now + HOUR), now - 45 * MINUTE);
        const newer = lastLimits(now);
        eq('lastLimits: a recorded reading over 30 min old gives way to a newer rollout', [newer.codex.windows[0].used_percent, newer.codex.stale], [50, false]);

        forgetRollouts();
        writeRollout(0, 'aaaa0002', codexLimit(10, now + HOUR), now - 50 * MINUTE);
        const keptRecorded = lastLimits(now);
        eq('lastLimits: a rollout older than the recorded reading does not replace it; the data is stale', [keptRecorded.codex.windows[0].used_percent, keptRecorded.codex.stale], [70, true]);
      });
      guarded('limits: rollout choice', () => {
        forgetLimits();
        forgetRollouts();
        writeRollout(0, 'bbbb0001', codexLimit(10, now + HOUR), now - 20 * MINUTE);
        writeRollout(0, 'bbbb0002', codexLimit(80, now + HOUR), now - 3 * MINUTE);
        writeRollout(1, 'bbbb0003', codexLimit(40, now + HOUR), now - 10 * MINUTE);
        eq('lastLimits: the newest rollout by modification time wins, across today and yesterday', lastLimits(now).codex.windows[0].used_percent, 80);
        forgetRollouts();
        writeRollout(1, 'bbbb0004', codexLimit(33, now + HOUR), now - 15 * MINUTE);
        eq('lastLimits: yesterday\'s folder is read too', lastLimits(now).codex.windows[0].used_percent, 33);
        forgetRollouts();
        writeRollout(2, 'bbbb0005', codexLimit(99, now + HOUR), now - MINUTE);
        eq('lastLimits: a rollout two days back is not looked at', lastLimits(now).codex, null);
        forgetRollouts();
        writeRollout(-1, 'bbbb0009', codexLimit(44, now + HOUR), now - MINUTE);
        eq('lastLimits: tomorrow\'s folder is read too (codex may name folders by UTC date)', lastLimits(now).codex.windows[0].used_percent, 44);
        forgetRollouts();
        writeRollout(0, 'bbbb0006', codexLimit(25, now + HOUR), now - 8 * MINUTE);
        writeRollout(0, 'bbbb0007', null, now - MINUTE); // a session that has not counted tokens yet
        eq('lastLimits: a newest rollout with no rate limits yet is passed over for the next', lastLimits(now).codex.windows[0].used_percent, 25);
        forgetRollouts();
        writeRollout(0, 'bbbb0008', codexLimit(60, now + HOUR), now - 90 * MINUTE);
        eq('lastLimits: a rollout over 30 min old is used, and marked stale', [lastLimits(now).codex.windows[0].used_percent, lastLimits(now).codex.stale], [60, true]);
        forgetRollouts();
      });

      // -- big rollout files are read from their tail --
      guarded('limits: rollout tail', () => {
        const junkLine = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1000) } }) + '\n';
        const junkBlock = junkLine.repeat(1000); // about 1 MB
        const appendJunk = (file, megabytes) => {
          for (let each = 0; each < megabytes; each++) fs.appendFileSync(file, junkBlock);
        };
        // A rollout with `headMegabytes` of junk, then the reading, then `tailMegabytes` of junk (tail may be a fraction: kilobytes of junk lines).
        const writeBigRollout = (name, headMegabytes, rateLimits, tailMegabytes, tailKilobytes = 0) => {
          writeRollout(0, name, null, now - MINUTE);
          const folder = path.join(limitsCodexHome, 'sessions', String(new Date(now).getFullYear()), twoDigitsOf(new Date(now).getMonth() + 1), twoDigitsOf(new Date(now).getDate()));
          const file = path.join(folder, `rollout-2026-10-27T10-00-00-${name}.jsonl`);
          fs.writeFileSync(file, '');
          appendJunk(file, headMegabytes);
          fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rateLimits } }) + '\n');
          appendJunk(file, tailMegabytes);
          fs.appendFileSync(file, junkLine.repeat(tailKilobytes));
          fs.utimesSync(file, new Date(now - MINUTE), new Date(now - MINUTE));
        };
        const twoDigitsOf = (number) => String(number).padStart(2, '0');
        const realReadFileSync = fs.readFileSync;
        // Reading a whole rollout is what is not allowed: a rollout can be hundreds of MB.
        fs.readFileSync = (target, ...rest) => {
          if (String(target).endsWith('.jsonl')) throw new Error('a rollout was read whole');
          return realReadFileSync(target, ...rest);
        };
        try {
          forgetLimits();
          forgetRollouts();
          writeBigRollout('cccc0001', 6, codexLimit(61, now + HOUR), 0, 100);
          eq('lastLimits: a reading near the end of a 6 MB rollout is found, without reading the file whole', lastLimits(now).codex?.windows[0].used_percent, 61);
          forgetRollouts();
          writeBigRollout('cccc0002', 1, codexLimit(62, now + HOUR), 1);
          eq('lastLimits: a reading 1 MB from the end is found by widening the tail once', lastLimits(now).codex?.windows[0].used_percent, 62);
          forgetRollouts();
          writeBigRollout('cccc0003', 0, codexLimit(63, now + HOUR), 5);
          eq('lastLimits: a reading more than 4 MB from the end counts as no reading', lastLimits(now).codex, null);
          forgetRollouts();
        } finally {
          fs.readFileSync = realReadFileSync;
          forgetRollouts();
        }
      });

      // -- the policy --
      guarded('limits: policy, the plain cases', () => {
        const readingWith = (primaryPercent, secondaryPercent = null, at = now - MINUTE) => {
          forgetLimits();
          recordLimit('codex', codexLimit(primaryPercent, now + 130 * MINUTE, secondaryPercent, now + 70 * HOUR), at);
          return lastLimits(now);
        };
        const ok = limitPolicy('codex', readingWith(89), now);
        eq('limitPolicy: 89 % is ok', ok.level, 'ok');
        const warn = limitPolicy('codex', readingWith(92), now);
        eq('limitPolicy: 92 % of the 5-hour window warns', warn.level, 'warn');
        truthy('limitPolicy: the warning names the window, the percent and the reset', /5-hour/.test(warn.note) && /92 ?%/.test(warn.note) && /resets/.test(warn.note));
        truthy('limitPolicy: the reset is a clock time and a wait', /\d\d:\d\d/.test(warn.note) && warn.note.includes('in about 2 h 10 min'));
        eq('limitPolicy: exactly 90 % warns', limitPolicy('codex', readingWith(90), now).level, 'warn');
        eq('limitPolicy: 100 % is full', limitPolicy('codex', readingWith(100), now).level, 'full');
        const weekly = limitPolicy('codex', readingWith(20, 100), now);
        eq('limitPolicy: a full weekly window is full', weekly.level, 'full');
        truthy('limitPolicy: and its note says weekly and recommends another worker', /weekly/.test(weekly.note) && /another worker/.test(weekly.note) && /resets/.test(weekly.note));
        const weeklyWarn = limitPolicy('codex', readingWith(20, 93), now);
        truthy('limitPolicy: a weekly window at 93 % warns and recommends another worker', weeklyWarn.level === 'warn' && /another worker/.test(weeklyWarn.note));
        truthy('limitPolicy: a 5-hour window does not recommend another worker', !/another worker/.test(warn.note));
        const both = limitPolicy('codex', readingWith(95, 96), now);
        truthy('limitPolicy: two windows near their limit are both named', both.level === 'warn' && /5-hour/.test(both.note) && /weekly/.test(both.note));
        const mixed = limitPolicy('codex', readingWith(95, 100), now);
        eq('limitPolicy: the worst window sets the level', mixed.level, 'full');
        forgetLimits();
        const unusual = limitPolicy('codex', { codex: { windows: [window(60, 95, now + HOUR)], at: now, stale: false, hit: null }, agy: null }, now);
        truthy('limitPolicy: any other window is named by its length', unusual.level === 'warn' && unusual.note.includes('60-minute'));
        eq('limitPolicy: a worker with no figures is ok, with no note', [limitPolicy('codex', lastLimits(now), now), limitPolicy('local', lastLimits(now), now)], [{ level: 'ok', note: '' }, { level: 'ok', note: '' }]);
        eq('limitPolicy: no limits at all is ok', limitPolicy('agy', null, now), { level: 'ok', note: '' });
      });
      guarded('limits: policy, windows that have reset', () => {
        forgetLimits();
        recordLimit('codex', codexLimit(100, now - MINUTE, 95, now + 70 * HOUR), now - 20 * MINUTE);
        const afterReset = limitPolicy('codex', lastLimits(now), now);
        eq('limitPolicy: a full window whose reset is past has reset, so only the other window counts', afterReset.level, 'warn');
        truthy('limitPolicy: and the note is about the other window', /weekly/.test(afterReset.note) && !/5-hour/.test(afterReset.note));
        forgetLimits();
        recordLimit('codex', codexLimit(100, now - MINUTE), now - 20 * MINUTE);
        eq('limitPolicy: a full window that has reset alone is ok', limitPolicy('codex', lastLimits(now), now).level, 'ok');
      });
      guarded('limits: policy, a window with no reset time', () => {
        const unknownReset = (minutes) => ({ primary: { used_percent: 100, window_minutes: minutes, resets_at: null }, secondary: null });
        forgetLimits();
        recordLimit('codex', unknownReset(300), now - 3 * 24 * HOUR);
        eq('limitPolicy: a full 5-hour window with no reset time, read 3 days ago, has long reset', limitPolicy('codex', lastLimits(now), now).level, 'ok');
        recordLimit('codex', unknownReset(300), now - 2 * HOUR);
        eq('limitPolicy: the same read 2 hours ago still counts', limitPolicy('codex', lastLimits(now), now).level, 'full');
        recordLimit('codex', unknownReset(10080), now - 3 * 24 * HOUR);
        eq('limitPolicy: a weekly window with no reset time read 3 days ago still counts', limitPolicy('codex', lastLimits(now), now).level, 'full');
        recordLimit('codex', unknownReset(10080), now - 8 * 24 * HOUR);
        eq('limitPolicy: and one read 8 days ago does not', limitPolicy('codex', lastLimits(now), now).level, 'ok');
        forgetLimits();
      });
      guarded('limits: policy, stale figures', () => {
        forgetLimits();
        recordLimit('codex', codexLimit(92, now + 130 * MINUTE), now - 40 * MINUTE);
        const old = lastLimits(now);
        eq('lastLimits: data 40 min old is stale', old.codex.stale, true);
        const policy = limitPolicy('codex', old, now);
        truthy('limitPolicy: stale figures still count, and the note says how old they are', policy.level === 'warn' && policy.note.includes('(figures from 40 min ago)'));
        forgetLimits();
        recordLimit('codex', codexLimit(92, now + 130 * MINUTE), now - 5 * MINUTE);
        truthy('limitPolicy: fresh figures carry no such remark', !limitPolicy('codex', lastLimits(now), now).note.includes('figures from'));
        const ageNote = (age) => {
          forgetLimits();
          recordLimit('codex', { primary: { used_percent: 92, window_minutes: 10080, resets_at: null }, secondary: null }, now - age);
          return limitPolicy('codex', lastLimits(now), now).note;
        };
        truthy('limitPolicy: figures 90 min old are still in minutes', ageNote(90 * MINUTE).includes('(figures from 90 min ago)'));
        truthy('limitPolicy: figures 100 min old are in hours', ageNote(100 * MINUTE).includes('(figures from 2 h ago)'));
        truthy('limitPolicy: figures 47 h old are in hours', ageNote(47 * HOUR).includes('(figures from 47 h ago)'));
        truthy('limitPolicy: figures 72 h old are in days', ageNote(72 * HOUR).includes('(figures from 3 days ago)'));
        forgetLimits();
      });
      guarded('limits: policy, hits', () => {
        forgetLimits();
        recordLimitHit('agy', { kind: 'exhausted', resets_at: null }, now - 10 * MINUTE);
        const noReset = limitPolicy('agy', lastLimits(now), now);
        eq('limitPolicy: an agy hit 10 min ago with no reset time is full, reset unknown', noReset, { level: 'full', note: 'agy hit its limit 10 min ago; reset unknown' });
        forgetLimits();
        recordLimitHit('agy', { kind: 'exhausted', resets_at: null }, now - 90 * MINUTE);
        eq('limitPolicy: an agy hit over an hour ago with no reset time is not held against it', limitPolicy('agy', lastLimits(now), now).level, 'ok');
        forgetLimits();
        recordLimitHit('agy', { kind: 'exhausted', resets_at: now + 3 * HOUR }, now - 90 * MINUTE);
        const withReset = limitPolicy('agy', lastLimits(now), now);
        truthy('limitPolicy: an agy hit whose reset is ahead is full, and says when', withReset.level === 'full' && /resets/.test(withReset.note) && withReset.note.includes('in about 3 h'));
        forgetLimits();
        recordLimitHit('agy', { kind: 'exhausted', resets_at: now - MINUTE }, now - 3 * HOUR);
        eq('limitPolicy: an agy hit whose reset is past has reset', limitPolicy('agy', lastLimits(now), now).level, 'ok');
        eq('limitPolicy: an agy hit says nothing about codex', limitPolicy('codex', lastLimits(now), now).level, 'ok');
        forgetLimits();
        recordLimit('codex', codexLimit(40, now + 2 * HOUR), now - 20 * MINUTE);
        recordLimitHit('codex', { kind: 'exhausted', resets_at: now + HOUR }, now - 20 * MINUTE);
        const codexHit = limitPolicy('codex', lastLimits(now), now);
        truthy('limitPolicy: a codex hit whose reset is ahead is full even when the windows read lower', codexHit.level === 'full' && /resets/.test(codexHit.note));
        recordLimit('codex', codexLimit(40, now + 2 * HOUR), now - 5 * MINUTE);
        eq('limitPolicy: a later reading that shows the room back supersedes the hit', limitPolicy('codex', lastLimits(now), now).level, 'ok');
        forgetLimits();
        recordLimitHit('agy', { kind: 'throttled', resets_at: null }, now - 2 * MINUTE);
        eq('limitPolicy: a throttled hit 2 min ago is a warning, not full', limitPolicy('agy', lastLimits(now), now), { level: 'warn', note: 'agy was rate limited 2 min ago' });
        forgetLimits();
        recordLimitHit('agy', { kind: 'throttled', resets_at: null }, now - 6 * MINUTE);
        eq('limitPolicy: a throttled hit over 5 min ago is ok', limitPolicy('agy', lastLimits(now), now).level, 'ok');
        forgetLimits();
        recordLimitHit('agy', { kind: 'throttled', resets_at: now + 20 * MINUTE }, now - 6 * MINUTE);
        eq('limitPolicy: a throttled hit with its reset still ahead stays a warning', limitPolicy('agy', lastLimits(now), now).level, 'warn');
        forgetLimits();
      });
    } finally {
      forgetRollouts();
      process.env.CONSULT_DELEGATE_HOME = previousDelegateHome;
      process.env.CODEX_HOME = previousCodexHome;
    }
  }

  // ---- Task 10 (a): what the tools build on (store fields, diff stat, rollout tail, exports) ----
  {
    const previousDelegateHome = process.env.CONSULT_DELEGATE_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const toolsHome = path.join(scratch, 'tools base home');
    const toolsCodexHome = path.join(scratch, 'tools base codex home');
    process.env.CONSULT_DELEGATE_HOME = toolsHome;
    process.env.CODEX_HOME = toolsCodexHome;
    fs.mkdirSync(toolsHome, { recursive: true });
    fs.mkdirSync(toolsCodexHome, { recursive: true });
    const guarded = (label, body) => {
      try {
        body();
      } catch (error) {
        console.log(`FAIL ${label} threw: ${error.message}`);
        failed++;
      }
    };
    try {
      guarded('store: new fields', () => {
        const storeModule = storeNamespace;
        const created = createTask(sampleSpec({ kind: 'review', owner_session: 'session-1' }));
        eq('createTask: kind and owner_session are kept', [created.kind, created.owner_session], ['review', 'session-1']);
        const plain = createTask(sampleSpec());
        eq('createTask: kind and owner_session default to null', [plain.kind, plain.owner_session], [null, null]);
        eq('createTask: queued_at starts as the creation time', [created.queued_at, plain.queued_at], [created.created_at, plain.created_at]);
        const datedPlain = createTask(sampleSpec({ created_at: 4242 }));
        eq('createTask: queued_at follows a given creation time', datedPlain.queued_at, 4242);
        fs.rmSync(path.join(toolsHome, 'tasks', datedPlain.id), { recursive: true, force: true });
        eq('updateTask: supervisor-died is a stop reason', updateTask(created.id, { state: 'stopped', stop_reason: 'supervisor-died' }).stop_reason, 'supervisor-died');
        eq('STOP_REASONS lists supervisor-died', storeModule.STOP_REASONS.includes('supervisor-died'), true);
        const indexRowFn = storeModule.indexRow;
        eq('indexRow is exported', typeof indexRowFn, 'function');
        if (typeof indexRowFn === 'function') {
          const fromIndex = JSON.parse(fs.readFileSync(path.join(toolsHome, 'index.json'), 'utf8')).tasks.find((row) => row.id === created.id);
          eq('indexRow: the row index.json holds for the task', indexRowFn(readTask(created.id)), fromIndex);
          eq('indexRow: the row carries the owner session and the creation time (the mod keys its notices on them)', [fromIndex.owner_session, fromIndex.created_at], ['session-1', created.created_at]);
        }
        fs.rmSync(path.join(toolsHome, 'tasks', created.id), { recursive: true, force: true });
        fs.rmSync(path.join(toolsHome, 'tasks', plain.id), { recursive: true, force: true });
      });

      await (async () => {
        const repo = path.join(scratch, 'diff stat Имя repo');
        const inRepo = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'sub', 'file.txt'), 'one\n');
        inRepo('init');
        inRepo('config', 'diff.relative', 'true');
        inRepo('add', '-A');
        inRepo('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'first');
        const first = inRepo('rev-parse', 'HEAD').trim();
        fs.writeFileSync(path.join(repo, 'sub', 'file.txt'), 'one\ntwo\n');
        fs.writeFileSync(path.join(repo, 'sub', 'Имя файл.txt'), 'new\n');
        inRepo('add', '-A');
        inRepo('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'second');
        const second = inRepo('rev-parse', 'HEAD').trim();
        eq('diffStat is exported', typeof gitNamespace.diffStat, 'function');
        if (typeof gitNamespace.diffStat === 'function') {
          const stat = await gitNamespace.diffStat(path.join(repo, 'sub'), first, second);
          truthy('diffStat: names the files by their repository path, even with diff.relative set, and totals', stat.includes('sub/file.txt') && /2 files changed, 2 insertions/.test(stat));
          truthy('diffStat: a Cyrillic name with a space is printed as it is', stat.includes('sub/Имя файл.txt'));
        }
      })();

      guarded('workers: rollout tail', () => {
        eq('lastRateLimitsIn is still exported from the workers module', typeof workersNamespace.lastRateLimitsIn, 'function');
        eq('WORKER_FENCED names the fence of each worker', workersNamespace.WORKER_FENCED, { codex: true, agy: false, local: false });
        const junkLine = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1000) } }) + '\n';
        const sessionFolder = path.join(toolsCodexHome, 'sessions', '2026', '10', '27');
        fs.mkdirSync(sessionFolder, { recursive: true });
        const writeRollout = (thread, headMegabytes, tailMegabytes) => {
          const file = path.join(sessionFolder, `rollout-2026-10-27T10-00-00-${thread}.jsonl`);
          fs.writeFileSync(file, '');
          for (let each = 0; each < headMegabytes; each++) fs.appendFileSync(file, junkLine.repeat(1000));
          const rateLimits = { primary: { used_percent: 64, window_minutes: 300, resets_at: 1792975000 }, secondary: null };
          fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rateLimits } }) + '\n');
          for (let each = 0; each < tailMegabytes; each++) fs.appendFileSync(file, junkLine.repeat(1000));
          fs.appendFileSync(file, junkLine.repeat(100));
        };
        writeRollout('bbbbbbbb-0000-7000-8000-000000000001', 6, 0);
        writeRollout('bbbbbbbb-0000-7000-8000-000000000002', 1, 1);
        writeRollout('bbbbbbbb-0000-7000-8000-000000000003', 0, 5);
        const realReadFileSync = fs.readFileSync;
        // A rollout can be hundreds of MB: it is never read whole.
        fs.readFileSync = (target, ...rest) => {
          if (String(target).endsWith('.jsonl')) throw new Error('a rollout was read whole');
          return realReadFileSync(target, ...rest);
        };
        try {
          eq('codexRolloutLimits: a reading near the end of a 6 MB rollout is found without reading the file whole',
            codexRolloutLimits('bbbbbbbb-0000-7000-8000-000000000001', { codexHome: toolsCodexHome }).limit?.primary?.used_percent, 64);
          eq('codexRolloutLimits: a reading 1 MB from the end is found by widening the tail once',
            codexRolloutLimits('bbbbbbbb-0000-7000-8000-000000000002', { codexHome: toolsCodexHome }).limit?.primary?.used_percent, 64);
          eq('codexRolloutLimits: a reading more than 4 MB from the end counts as none',
            codexRolloutLimits('bbbbbbbb-0000-7000-8000-000000000003', { codexHome: toolsCodexHome }), { limit: null, limitHit: null });
        } finally {
          fs.readFileSync = realReadFileSync;
        }
      });

      guarded('supervisor: orphanFolderEnv gives the real path too', () => {
        const realFolder = fs.mkdtempSync(path.join(scratch, 'orphan-real-'));
        const linkedFolder = `${realFolder}-link`;
        fs.symlinkSync(realFolder, linkedFolder, process.platform === 'win32' ? 'junction' : 'dir');
        try {
          const realKey = fs.realpathSync.native(realFolder);
          eq('orphanFolderEnv: a folder through a link is looked for by both paths', supervisorModule.orphanFolderEnv(linkedFolder), { CONSULT_ORPHAN_FOLDER: linkedFolder, CONSULT_ORPHAN_FOLDER_REAL: realKey });
          eq('orphanFolderEnv: a folder that is its own real path is given once', supervisorModule.orphanFolderEnv(realKey), { CONSULT_ORPHAN_FOLDER: realKey });
          eq('orphanFolderEnv: a folder that is gone is looked for as written', supervisorModule.orphanFolderEnv(path.join(scratch, 'no such folder')), { CONSULT_ORPHAN_FOLDER: path.join(scratch, 'no such folder') });
          // A worker that swapped its copy for a link to another folder must not point the cleanup there.
          eq('orphanFolderEnv: a real path still inside the copies folder is looked for', supervisorModule.orphanFolderEnv(linkedFolder, { within: scratch }), { CONSULT_ORPHAN_FOLDER: linkedFolder, CONSULT_ORPHAN_FOLDER_REAL: realKey });
          const elsewhere = fs.mkdtempSync(path.join(scratch, 'copies-root-'));
          eq('orphanFolderEnv: a real path that leaves the copies folder is not', supervisorModule.orphanFolderEnv(linkedFolder, { within: elsewhere }), { CONSULT_ORPHAN_FOLDER: linkedFolder });
        } finally {
          if (process.platform === 'win32') fs.rmdirSync(linkedFolder); else fs.unlinkSync(linkedFolder);
        }
      });

      guarded('supervisor: exports the sweep reuses', () => {
        eq('descendantScript, parsePids and copyWorkFolder are exported', [typeof supervisorModule.descendantScript, typeof supervisorModule.parsePids, typeof supervisorModule.copyWorkFolder], ['function', 'function', 'function']);
        if (typeof supervisorModule.parsePids === 'function') eq('parsePids: the numeric rows only', supervisorModule.parsePids('12\r\nabc\n 34 \n'), [12, 34]);
        if (typeof supervisorModule.descendantScript === 'function') truthy('descendantScript: walks from the given pids', supervisorModule.descendantScript([4321], 1700000000000, false).includes('[uint32]4321'));
      });

      guarded('supervisor: the orphan trace never takes a Windows shell host for the task', () => {
        const script = supervisorModule.orphanScript(Date.now(), []);
        for (const host of ['explorer.exe', 'sihost.exe', 'svchost.exe', 'userinit.exe', 'winlogon.exe']) {
          truthy(`orphan query: ${host} ends a chain as the person's`, script.toLowerCase().includes(`'${host}'`));
        }
      });

      guarded('supervisor: a folder name with PowerShell quotes runs nothing in the orphan query', () => {
        if (process.platform !== 'win32') return;
        // ’ (U+2019) also ends a single-quoted PowerShell string.
        const folder = `C:\\nowhere\\x\u2019; Write-Output 'INJECTED'; \u2019y`;
        const script = supervisorModule.orphanScript(Date.now());
        const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CONSULT_ORPHAN_FOLDER: folder } });
        eq('orphan query: nothing of the folder name runs', output.includes('INJECTED'), false);
      });
    } finally {
      process.env.CONSULT_DELEGATE_HOME = previousDelegateHome;
      process.env.CODEX_HOME = previousCodexHome;
    }
  }

  // ---- Task 10 (b): the eight tools (lib/delegate.js) ----
  // Handlers are called the way consult.js calls them. Most use a stub for the
  // supervisor launch; the copy start and the follow-up run a real supervisor
  // with the fake worker.
  {
    const toolsRoot = path.join(scratch, 'tools Имя root');
    const toolsDataHome = path.join(toolsRoot, 'data');
    const toolsCodexHome = path.join(toolsRoot, 'codex');
    const fakeUserHome = path.join(toolsRoot, 'user home');
    const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'delegate');
    const fakeWorkerPath = path.join(fixtureDirectory, 'fake-worker.js');
    const previousEnv = {};
    for (const name of ['CONSULT_DELEGATE_HOME', 'CONSULT_PROJECTS_FILE', 'CODEX_HOME', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID']) previousEnv[name] = process.env[name];
    process.env.CONSULT_DELEGATE_HOME = toolsDataHome;
    process.env.CONSULT_PROJECTS_FILE = path.join(toolsRoot, 'consult-projects.json'); // earlier blocks leave theirs in any state
    process.env.CODEX_HOME = toolsCodexHome;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    for (const folder of [toolsDataHome, toolsCodexHome, fakeUserHome]) fs.mkdirSync(folder, { recursive: true });

    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const isAlive = (pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
    };
    // Every section gets its own, small data folder: the store rewrites index.json by
    // scanning every task on each update, so one folder shared by a hundred tasks made
    // the sections several times slower.
    let sectionCount = 0;
    const guardedAsync = async (label, body) => {
      const sectionHome = path.join(toolsRoot, `data ${++sectionCount}`);
      fs.mkdirSync(sectionHome, { recursive: true });
      process.env.CONSULT_DELEGATE_HOME = sectionHome;
      beat('instance-a');
      beat('instance-b');
      const startedAtMs = Date.now();
      try {
        await body();
      } catch (error) {
        console.log(`FAIL ${label} threw: ${error.stack}`);
        failed++;
      }
      if (process.env.DELEGATE_TEST_TIMING) console.log(`TIMING ${label}: ${Date.now() - startedAtMs} ms`);
    };
    // The pid of a process that has already exited.
    const deadPidNow = async () => {
      const finished = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
      await new Promise((resolve) => finished.on('exit', resolve));
      return finished.pid;
    };
    const makeRepo = (name, files) => {
      const repo = path.join(toolsRoot, name);
      for (const [relative, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
        fs.writeFileSync(path.join(repo, relative), text);
      }
      gitIn(repo, 'init');
      gitIn(repo, 'add', '-A');
      gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'first');
      return repo;
    };
    const makePlainFolder = (name) => {
      const folder = path.join(toolsRoot, name);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'readme.txt'), 'hello\n');
      return folder;
    };

    const fakeSettings = (delegateOverrides = {}) => ({
      ...DEFAULTS, local_runner: 'llama-swap', _source: null, _global: {}, _warnings: [],
      delegate: { table: { code: 'codex', research: 'agy', review: 'agy', private: 'local' }, local_at_once: 'auto', on_close: 'stop', time_limit_ms: 3 * 3600000, ...delegateOverrides }
    });
    const launchedIds = [];
    const realLaunchedPids = [];
    const stubLaunch = (taskId) => { launchedIds.push(taskId); return 4242; };
    const contextFor = (project, overrides = {}) => ({
      settings: fakeSettings(), project, sessionId: 'session-a', instanceId: 'instance-a', launch: stubLaunch, startWaitMs: 0, pollMs: 50, ...overrides
    });

    let toolsModule = null;
    try {
      toolsModule = await import('./lib/delegate.js');
    } catch (error) {
      console.log(`FAIL lib/delegate.js could not be loaded: ${error.message}`);
      failed++;
    }
    let sweepModule = null;
    try {
      sweepModule = await import('./lib/delegate-sweep.js');
    } catch (error) {
      console.log(`FAIL lib/delegate-sweep.js could not be loaded: ${error.message}`);
      failed++;
    }

    // One call the way the server makes it: the MCP result, parsed.
    const call = async (name, args, context) => {
      const result = await toolsModule.callDelegateTool(name, args, context);
      const text = result.content[0].text;
      if (result.isError === true) return { isError: true, text };
      return { isError: false, value: JSON.parse(text), text };
    };
    const briefArgs = (overrides = {}) => ({ worker: 'codex', task_title: 'Add retries', brief: 'Add retries to the fetcher.', mode: 'write', ...overrides });
    const waitForTask = async (id, isWanted, timeoutMs = 30000) => {
      const giveUpAt = Date.now() + timeoutMs;
      while (Date.now() < giveUpAt) {
        const current = readTask(id);
        if (current !== null && isWanted(current)) return current;
        await sleep(50);
      }
      return readTask(id);
    };
    // A finished copy: the task, its worktree with `files` written into it, and an end commit.
    const finishedCopy = async (project, files, overrides = {}) => {
      const task = createTask({ worker: 'codex', mode: 'write', location: 'copy', project, title: 'finished', brief: 'b\n', owner_instance: 'instance-a', ...overrides });
      const copy = await makeCopy(project, task.id);
      updateTask(task.id, { worktree: copy.worktree, branch: copy.branch, start_commit: copy.start_commit });
      for (const [relative, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(copy.worktree, relative)), { recursive: true });
        fs.writeFileSync(path.join(copy.worktree, relative), text);
      }
      const endCommit = await endSnapshot(copy.worktree, project, copy.start_commit);
      fs.writeFileSync(path.join(taskFolder(task.id), 'final.md'), '## Summary\nDid it.\n');
      return updateTask(task.id, { state: 'done', end_commit: endCommit, summary: 'Did it.', ended_at: Date.now(), final_path: path.join(taskFolder(task.id), 'final.md'), log_path: path.join(taskFolder(task.id), 'log.jsonl') });
    };

    try {
      if (toolsModule !== null) {
        await guardedAsync('tools: definitions', async () => {
          const names = toolsModule.DELEGATE_TOOLS.map((tool) => tool.name);
          eq('the eight tools are defined', names, ['delegate', 'delegate_status', 'delegate_list', 'delegate_result', 'delegate_merge', 'delegate_send', 'delegate_cancel', 'delegate_wait']);
          const description = toolsModule.DELEGATE_TOOLS[0].description;
          truthy('delegate: the description opens with the routing text', description.startsWith(toolsModule.DELEGATE_ROUTING_TEXT) && description.startsWith('Background task run by Codex, agy or a local model in the project folder:'));
          const missingAliases = Object.keys(WORKER_ALIASES).filter((alias) => !description.includes(alias));
          eq('delegate: every worker alias is listed', missingAliases, []);
          truthy('delegate: the fences are in plain words', /codex[^.]*only inside its copy/i.test(description) && /agy[^.]*not fenced[^.]*can't run commands/i.test(description) && /local[^.]*not fenced[^.]*read-only tasks get read tools only/i.test(description));
          truthy('delegate: local is not called private beyond its model calls', /not offline/.test(description) && /Claude[^.]*cloud/.test(description));
          const schema = toolsModule.DELEGATE_TOOLS[0].inputSchema;
          eq('delegate: worker has no enum (local:fast and aliases must pass)', schema.properties.worker.enum, undefined);
          eq('delegate: required arguments', schema.required, ['worker', 'task_title', 'brief', 'mode']);
          const waitSchema = toolsModule.DELEGATE_TOOLS[7].inputSchema.properties.timeout_s;
          eq('delegate_wait: timeout_s is 1 to 1800 (not the 30 s floor of the ask tools)', [waitSchema.minimum, waitSchema.maximum], [1, 1800]);
          eq('clampWaitSeconds: bounds', [toolsModule.clampWaitSeconds(0), toolsModule.clampWaitSeconds(99999), toolsModule.clampWaitSeconds(45), toolsModule.clampWaitSeconds(undefined), toolsModule.clampWaitSeconds('x')], [1, 1800, 45, 120, 120]);
          const sendDescription = toolsModule.DELEGATE_TOOLS.find((tool) => tool.name === 'delegate_send').description;
          truthy('delegate_send: the description says it works only from a session of the task\'s own project', /only from a (Claude Code )?session of the task's own project/.test(sendDescription));
          const commandText = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'delegate.md'), 'utf8');
          const allowedTools = /^allowed-tools: (\[.*\])$/m.exec(commandText);
          const allowedNames = allowedTools === null ? [] : JSON.parse(allowedTools[1]);
          eq('delegate.md pre-approves what the command itself calls, not delegate_merge or delegate_send', [allowedNames.includes('mcp__plugin_consult_consult__delegate'), allowedNames.some((name) => /delegate_(merge|send)$/.test(name))], [true, false]);
          const stepEight = commandText.split('\n').find((line) => line.startsWith('8.')) ?? '';
          truthy('delegate.md step 8 says merge and send are for a session of the task\'s own project', /delegate_merge/.test(stepEight) && /delegate_send/.test(stepEight) && /own project/.test(stepEight));
          eq('every tool has a title entry',toolsModule.DELEGATE_TOOLS.every((tool) => typeof toolsModule.DELEGATE_TOOL_META[tool.name]?.[0] === 'string'), true);
        });

        await guardedAsync('delegate: workers and kinds', async () => {
          const project = makePlainFolder('plain workers');
          const refusal = await call('delegate', briefArgs({ worker: 'bogus' }), contextFor(project));
          truthy('delegate: an unknown worker is an error result naming the choices', refusal.isError && /codex, agy, local/.test(refusal.text) && /local:<nickname>/.test(refusal.text) && /gpt/.test(refusal.text));
          const badNickname = await call('delegate', briefArgs({ worker: 'local:C:\\evil' }), contextFor(project));
          truthy('delegate: a bad local nickname is an error result naming the nicknames', badNickname.isError && /vision-best/.test(badNickname.text));
          const noKind = await call('delegate', briefArgs({ worker: 'auto' }), contextFor(project));
          truthy('delegate: auto without a kind is an error result', noKind.isError && /kind/.test(noKind.text));
          const badMode = await call('delegate', briefArgs({ mode: 'rw' }), contextFor(project));
          truthy('delegate: a bad mode is an error result', badMode.isError && /mode/.test(badMode.text));
          const noBrief = await call('delegate', briefArgs({ brief: '  ' }), contextFor(project));
          truthy('delegate: an empty brief is an error result', noBrief.isError && /brief/.test(noBrief.text));
          const badModel = await call('delegate', briefArgs({ model: '--evil' }), contextFor(project));
          truthy('delegate: a model that starts with - is an error result', badModel.isError);
          const badEffort = await call('delegate', briefArgs({ effort: 'bogus' }), contextFor(project));
          truthy('delegate: a bad effort is an error result', badEffort.isError && /effort/.test(badEffort.text));
          eq('delegate: none of those made a task', listTasks({ project }).length, 0);

          const other = await call('delegate', briefArgs({ worker: 'auto', kind: 'other' }), contextFor(project));
          eq('delegate: auto with kind other asks which worker', [other.value.started, other.value.ask, typeof other.value.question], [false, 'worker', 'string']);
          const unsetRow = await call('delegate', briefArgs({ worker: 'auto', kind: 'code' }), contextFor(project, { settings: fakeSettings({ table: { code: 'ask', research: 'agy', review: 'agy', private: 'local' } }) }));
          eq('delegate: a table row that is not a worker asks which worker', [unsetRow.value.started, unsetRow.value.ask], [false, 'worker']);
          const askResearch = await call('delegate', briefArgs({ worker: 'auto', kind: 'research' }), contextFor(project, { settings: fakeSettings({ table: { code: 'codex', research: 'ask', review: 'agy', private: 'local' } }) }));
          eq('delegate: a table row that is ask answers exactly as kind other does', [askResearch.value, listTasks({ project }).length], [other.value, 0]);
          const gptWord = await call('delegate', briefArgs({ worker: 'GPT', mode: 'read' }), contextFor(project));
          eq('delegate: an alias in any case names its worker', [gptWord.value.started, gptWord.value.worker], [true, 'codex']);
          const geminiWord = await call('delegate', briefArgs({ worker: 'gemini', mode: 'read' }), contextFor(project));
          eq('delegate: gemini is agy', geminiWord.value.worker, 'agy');
          const tableReview = await call('delegate', briefArgs({ worker: 'auto', kind: 'review', mode: 'read' }), contextFor(project));
          eq('delegate: auto with kind review goes to the table\'s agy', [tableReview.value.worker, readTask(tableReview.value.id).kind], ['agy', 'review']);
          const localFast = await call('delegate', briefArgs({ worker: 'local:fast', mode: 'read' }), contextFor(project));
          eq('delegate: local:fast is worker local with the nickname as its model', [localFast.value.worker, localFast.value.model, readTask(localFast.value.id).model], ['local', 'fast', 'fast']);
          const noRunner = await call('delegate', briefArgs({ worker: 'local', mode: 'read' }), contextFor(project, { settings: { ...fakeSettings(), local_runner: undefined } }));
          truthy('delegate: a local task with no local runner set up is an error result pointing at setlocal', noRunner.isError && /setlocal/.test(noRunner.text));

          const started = readTask(gptWord.value.id);
          eq('delegate: the task records its owner, project, title, mode and settings', [started.owner_session, started.owner_instance, started.project, started.title, started.mode, started.keep_running, started.time_limit_ms], ['session-a', 'instance-a', project, 'Add retries', 'read', false, 3 * 3600000]);
          const keeping = await call('delegate', briefArgs({ mode: 'read', hold: true, model: 'gpt-6.1-sol', effort: 'high' }), contextFor(project, { settings: fakeSettings({ on_close: 'keep', time_limit_ms: 600000 }) }));
          const keepingTask = readTask(keeping.value.id);
          eq('delegate: on_close keep, the time limit, hold, model and effort are recorded', [keepingTask.keep_running, keepingTask.time_limit_ms, keepingTask.hold, keepingTask.model, keepingTask.effort], [true, 600000, true, 'gpt-6.1-sol', 'high']);
          eq('delegate: a read task works in the project itself', [started.location, gptWord.value.location, gptWord.value.folder], ['here', 'here', project]);
          eq('delegate: the stub was asked to launch each started task', launchedIds.includes(gptWord.value.id) && launchedIds.includes(tableReview.value.id), true);
          eq('delegate: fenced is known up front', [gptWord.value.fenced, geminiWord.value.fenced, localFast.value.fenced], [true, false, false]);
        });

        await guardedAsync('delegate: git', async () => {
          const plain = makePlainFolder('plain nogit');
          const asked = await call('delegate', briefArgs({ worker: 'agy' }), contextFor(plain));
          eq('delegate: a write task in a project with no git asks about git setup, with the spec\'s words', [asked.value.started, asked.value.ask, asked.value.question],
            [false, 'git-setup', 'This project has no git; a separate copy needs it. Set it up (`git init`, a `.gitignore`, a first commit)? Otherwise workers edit here.']);
          eq('delegate: asking made no task', listTasks({ project: plain }).length, 0);
          const declined = await call('delegate', briefArgs({ worker: 'agy', git_setup: 'no' }), contextFor(plain));
          eq('delegate: git_setup no starts the task here', [declined.value.started, declined.value.location], [true, 'here']);
          eq('delegate: and is remembered for the project', projectSettings(plain).git, 'declined');
          const later = await call('delegate', briefArgs({ worker: 'agy' }), contextFor(plain));
          eq('delegate: the next call does not ask again', [later.value.started, later.value.location], [true, 'here']);

          const toSetUp = makePlainFolder('plain setup');
          const yes = await call('delegate', briefArgs({ worker: 'codex', git_setup: 'yes' }), contextFor(toSetUp));
          eq('delegate: git_setup yes sets git up and starts in a copy', [yes.value.started, yes.value.location], [true, 'copy']);
          eq('delegate: the project now has a commit', gitIn(toSetUp, 'rev-parse', '--verify', 'HEAD').trim().length, 40);
          const yesTask = readTask(yes.value.id);
          truthy('delegate: the copy was made before launch and recorded', yesTask.worktree && fs.existsSync(yesTask.worktree) && yesTask.branch === `consult/${yes.value.id}` && /^[0-9a-f]{40}$/.test(yesTask.start_commit));
          eq('delegate: the worker\'s folder is the copy', path.resolve(yes.value.folder).toLowerCase(), path.resolve(yesTask.worktree).toLowerCase());
          truthy('delegate: the sweep\'s clock restarts when the copy is made', yesTask.queued_at >= yesTask.created_at && typeof yesTask.queued_at === 'number');

          const repo = makeRepo('git repo for copy', { 'readme.txt': 'hello\n', 'sub Имя/a.txt': 'a\n' });
          const fromSubfolder = await call('delegate', briefArgs({ worker: 'codex' }), contextFor(path.join(repo, 'sub Имя')));
          const subTask = readTask(fromSubfolder.value.id);
          eq('delegate: a project that is a subfolder of a repository works in the same subfolder of the copy', path.resolve(fromSubfolder.value.folder).toLowerCase(), path.join(subTask.worktree, 'sub Имя').toLowerCase());

          const forcedHere = await call('delegate', briefArgs({ worker: 'codex', location: 'here' }), contextFor(repo));
          eq('delegate: the user\'s "here" beats auto', [forcedHere.value.started, forcedHere.value.location], [true, 'here']);
          saveProjectSettings(repo, { workers_edit: 'here' });
          const settingHere = await call('delegate', briefArgs({ worker: 'codex' }), contextFor(repo));
          eq('delegate: the project\'s Workers edit setting is used', settingHere.value.location, 'here');
          const overridden = await call('delegate', briefArgs({ worker: 'codex', location: 'copy' }), contextFor(repo));
          eq('delegate: an explicit copy beats the project setting', overridden.value.location, 'copy');
          saveProjectSettings(repo, { workers_edit: 'auto' });
          const readOnly = await call('delegate', briefArgs({ worker: 'codex', mode: 'read' }), contextFor(repo));
          eq('delegate: a read task in a git project still works in the real folder', readOnly.value.location, 'here');
          const wanted = await call('delegate', briefArgs({ worker: 'codex', location: 'copy' }), contextFor(makePlainFolder('wants copy'), { settings: fakeSettings() }));
          eq('delegate: a copy asked for in a project with no git and no answer asks', wanted.value.ask, 'git-setup');
        });

        await guardedAsync('delegate: usage limits', async () => {
          const project = makePlainFolder('plain limits');
          const minute = 60000;
          const codexWindows = (percent, resetsAt) => ({ primary: { used_percent: percent, window_minutes: 300, resets_at: Math.round(resetsAt / 1000) }, secondary: null });
          const limitsFile = path.join(dataHome(), 'limits.json');
          fs.rmSync(limitsFile, { force: true });
          recordLimit('codex', codexWindows(92, Date.now() + 40 * minute), Date.now());
          const warned = await call('delegate', briefArgs({ mode: 'read' }), contextFor(project));
          eq('delegate: codex at 92% asks about the limit and starts nothing', [warned.value.started, warned.value.ask], [false, 'limit']);
          truthy('delegate: the question has the numbers and the three ways out', /92%/.test(warned.value.question) && /start anyway/i.test(warned.value.question) && /wait/.test(warned.value.question) && /another worker/.test(warned.value.question));
          const confirmed = await call('delegate', briefArgs({ mode: 'read', confirm_limit: true }), contextFor(project));
          eq('delegate: confirm_limit starts it', [confirmed.value.started, confirmed.value.worker], [true, 'codex']);
          truthy('delegate: and carries the limit note', /92%/.test(confirmed.value.limit_note));
          const agyUnaffected = await call('delegate', briefArgs({ worker: 'agy', mode: 'read' }), contextFor(project));
          eq('delegate: the codex figure says nothing about agy', [agyUnaffected.value.started, agyUnaffected.value.limit_note], [true, undefined]);
          recordLimit('codex', codexWindows(100, Date.now() + 40 * minute), Date.now());
          const full = await call('delegate', briefArgs({ mode: 'read', confirm_limit: true }), contextFor(project));
          eq('delegate: codex at 100% asks even with confirm_limit', [full.value.started, full.value.ask], [false, 'limit']);
          truthy('delegate: the full question offers waiting, another worker or a Claude subagent', /reset/.test(full.value.question) && /another worker/.test(full.value.question) && /subagent/.test(full.value.question));
          recordLimit('codex', codexWindows(100, Date.now() - minute), Date.now());
          const reset = await call('delegate', briefArgs({ mode: 'read' }), contextFor(project));
          eq('delegate: a full window whose reset has passed is not in the way', reset.value.started, true);
          fs.rmSync(limitsFile, { force: true });
          recordLimitHit('agy', { kind: 'exhausted', resets_at: Date.now() + 3 * 3600000 }, Date.now() - minute);
          const agyFull = await call('delegate', briefArgs({ worker: 'agy', mode: 'read', confirm_limit: true }), contextFor(project));
          eq('delegate: agy after a hit asks, whatever confirm_limit says', [agyFull.value.started, agyFull.value.ask], [false, 'limit']);
          const localFree = await call('delegate', briefArgs({ worker: 'local', mode: 'read' }), contextFor(project));
          eq('delegate: local has no usage limit', localFree.value.started, true);
          fs.rmSync(limitsFile, { force: true });
          recordLimit('codex', codexWindows(95, Date.now() + 40 * minute), Date.now());
          const untouched = makePlainFolder('limit blocks git');
          const blocked = await call('delegate', briefArgs({ worker: 'codex', git_setup: 'yes' }), contextFor(untouched));
          eq('delegate: a limit question comes before git setup runs', [blocked.value.ask, fs.existsSync(path.join(untouched, '.git'))], ['limit', false]);
          fs.rmSync(limitsFile, { force: true });
        });

        await guardedAsync('delegate: a copy that cannot be made', async () => {
          const repo = makeRepo('git repo broken copy', { 'readme.txt': 'hello\n' });
          const before = launchedIds.length;
          const failing = await call('delegate', briefArgs({ worker: 'codex' }), contextFor(repo, { makeCopy: async () => { throw new Error('disk full'); } }));
          truthy('delegate: a copy that cannot be made is an error result', failing.isError && /disk full/.test(failing.text));
          eq('delegate: nothing was launched', launchedIds.length, before);
          const rows = listTasks({ project: repo });
          eq('delegate: the task is marked failed, not left queued', [rows.length, rows[0]?.state, /disk full/.test(rows[0]?.summary ?? '')], [1, 'failed', true]);
        });

        await guardedAsync('delegate: uncommitted changes and a copy', async () => {
          const clean = makeRepo('git repo clean copy', { 'readme.txt': 'hello\n' });
          const cleanStart = await call('delegate', briefArgs({ worker: 'codex' }), contextFor(clean));
          eq('delegate: a copy of a clean project carries no uncommitted note', [cleanStart.value.started, cleanStart.value.location, 'uncommitted' in cleanStart.value], [true, 'copy', false]);

          const dirty = makeRepo('git repo dirty copy', { 'readme.txt': 'hello\n', 'kept.txt': 'kept\n' });
          fs.writeFileSync(path.join(dirty, 'readme.txt'), 'changed\n');
          fs.writeFileSync(path.join(dirty, 'new file.txt'), 'new\n');
          const indexPath = path.join(dirty, '.git', 'index');
          const indexBefore = fs.readFileSync(indexPath);
          const dirtyStart = await call('delegate', briefArgs({ worker: 'codex' }), contextFor(dirty));
          eq('delegate: a copy of a project with a modified and an untracked file counts two', [dirtyStart.value.started, dirtyStart.value.uncommitted?.count], [true, 2]);
          eq('delegate: and the note says what the copy holds, in the count\'s words', dirtyStart.value.uncommitted?.note, "The copy starts from the project as it is now: its 2 uncommitted changes are in it, ignored files are not.");
          eq('delegate: counting touched nothing of the user\'s index', Buffer.compare(indexBefore, fs.readFileSync(indexPath)), 0);

          const single = makeRepo('git repo one change', { 'readme.txt': 'hello\n' });
          fs.writeFileSync(path.join(single, 'readme.txt'), 'changed\n');
          const singleStart = await call('delegate', briefArgs({ worker: 'codex' }), contextFor(single));
          eq('delegate: one change is said in the singular', [singleStart.value.uncommitted?.count, singleStart.value.uncommitted?.note], [1, "The copy starts from the project as it is now: its 1 uncommitted change is in it, ignored files are not."]);

          eq('uncommittedCount: counts the dirty project', await gitNamespace.uncommittedCount(dirty), 2);
          // On Linux git reads a two-file repository within 1 ms; two thousand untracked files it does not.
          const crowded = makeRepo('git repo crowded', { 'readme.txt': 'hello\n' });
          for (let index = 0; index < 2000; index++) fs.writeFileSync(path.join(crowded, `untracked ${index}.txt`), 'x\n');
          eq('uncommittedCount: a call that outlives its time limit is no count', await gitNamespace.uncommittedCount(crowded, { timeoutMs: 1 }), 0);
          const hereStart = await call('delegate', briefArgs({ worker: 'codex', location: 'here' }), contextFor(dirty));
          eq('delegate: a task working here has no note (no copy is made)', [hereStart.value.location, 'uncommitted' in hereStart.value], ['here', false]);
          const description = toolsModule.DELEGATE_TOOLS[0].description;
          truthy('delegate: the description says a copy starts from the folder as it is now', /A copy starts from the project as it is now, uncommitted changes included/.test(description));
        });

        await guardedAsync('delegate: a launch that fails', async () => {
          const project = makePlainFolder('plain launch fails');
          const failing = await call('delegate', briefArgs({ mode: 'read' }), contextFor(project, { launch: () => { throw new Error('spawn failed'); } }));
          truthy('delegate: a supervisor that cannot start is an error result', failing.isError && /spawn failed/.test(failing.text));
          const newest = listTasks({ project }).find((task) => task.summary && /spawn failed/.test(task.summary));
          eq('delegate: and the task is marked failed', newest?.state, 'failed');
        });

        await guardedAsync('delegate: a local task waits for admission', async () => {
          const project = makePlainFolder('plain local wait');
          const queued = await call('delegate', briefArgs({ worker: 'local', mode: 'read' }), contextFor(project, { startWaitMs: 300 }));
          eq('delegate: a local task that the runner has not admitted is reported queued with its place', [queued.value.started, queued.value.queued, typeof queued.value.ahead], [true, true, 'number']);
          const admitting = await call('delegate', briefArgs({ worker: 'local', mode: 'read' }), contextFor(project, {
            startWaitMs: 3000,
            launch: (id) => { setTimeout(() => updateTask(id, { state: 'running', started_at: Date.now(), warning: 'qwen3.5-4b has a context window of only 8192 tokens.' }), 150); return 4242; }
          }));
          eq('delegate: a local task admitted within the wait is not queued', [admitting.value.queued, admitting.value.state], [undefined, 'running']);
          truthy('delegate: its context warning is passed on', /8192/.test(admitting.value.context_warning));
        });

        await guardedAsync('delegate_status, delegate_list', async () => {
          const projectA = makePlainFolder('plain list A');
          const projectB = makePlainFolder('plain list B');
          const inA = await call('delegate', briefArgs({ mode: 'read' }), contextFor(projectA));
          const inB = await call('delegate', briefArgs({ mode: 'read', task_title: 'other project' }), contextFor(projectB));
          updateTask(inB.value.id, { state: 'done', summary: 'finished', ended_at: Date.now() });
          const one = await call('delegate_status', { id: inA.value.id }, contextFor(projectA));
          eq('delegate_status: one task by id', [one.value.tasks.length, one.value.tasks[0].id, one.value.tasks[0].state], [1, inA.value.id, 'queued']);
          truthy('delegate_status: the row has the index fields', ['title', 'worker', 'state', 'location', 'summary', 'project'].every((field) => field in one.value.tasks[0]));
          eq('delegate_status: no brief text in the row', JSON.stringify(one.value).includes('Add retries to the fetcher'), false);
          truthy('delegate_status: limits ride along', one.value.limits && 'codex' in one.value.limits && 'agy' in one.value.limits);
          const missing = await call('delegate_status', { id: 'abcdef' }, contextFor(projectA));
          truthy('delegate_status: an unknown id is an error result', missing.isError && /abcdef/.test(missing.text));
          const attention = await call('delegate_status', {}, contextFor(projectA));
          const attentionIds = attention.value.tasks.map((row) => row.id);
          eq('delegate_status: with no id, this project\'s active tasks only', [attentionIds.includes(inA.value.id), attentionIds.includes(inB.value.id)], [true, false]);
          const everything = await call('delegate_list', {}, contextFor(projectA));
          const everythingIds = everything.value.tasks.map((row) => row.id);
          eq('delegate_list: every project\'s tasks', [everythingIds.includes(inA.value.id), everythingIds.includes(inB.value.id)], [true, true]);
          const onlyMine = await call('delegate_list', { project_only: true }, contextFor(projectA));
          const onlyMineIds = onlyMine.value.tasks.map((row) => row.id);
          eq('delegate_list: project_only keeps this project\'s', [onlyMineIds.includes(inA.value.id), onlyMineIds.includes(inB.value.id)], [true, false]);
          truthy('delegate_list: limits ride along', onlyMine.value.limits && 'codex' in onlyMine.value.limits);
        });

        await guardedAsync('delegate_result', async () => {
          const repo = makeRepo('git repo result', { 'readme.txt': 'hello\n', 'keep.txt': 'keep\n' });
          const changed = await finishedCopy(repo, { 'new Имя.txt': 'new\n', 'readme.txt': 'hello\nmore\n' });
          const result = await call('delegate_result', { id: changed.id }, contextFor(repo));
          eq('delegate_result: state, final message, log path', [result.value.state, result.value.final_message, result.value.log_path], ['done', '## Summary\nDid it.\n', path.join(taskFolder(changed.id), 'log.jsonl')]);
          eq('delegate_result: the changed files', result.value.changed.map((file) => `${file.status} ${file.path}`).sort(), ['A new Имя.txt', 'M readme.txt']);
          truthy('delegate_result: a diff stat with the totals', /2 files changed/.test(result.value.diff_stat) && result.value.diff_stat.includes('new Имя.txt'));
          truthy('delegate_result: sets reported_at', typeof readTask(changed.id).reported_at === 'number');
          eq('delegate_result: a copy with changes is kept', [fs.existsSync(readTask(changed.id).worktree), result.value.copy_removed], [true, undefined]);

          const unchanged = await finishedCopy(repo, {});
          const readElsewhere = await call('delegate_result', { id: unchanged.id }, contextFor(makePlainFolder('result read from elsewhere')));
          eq('delegate_result: read from another project it still answers', [readElsewhere.isError, readElsewhere.value?.state, readElsewhere.value?.changed], [false, 'done', []]);
          eq('delegate_result: but from another project it removes nothing and the owner can still see the task as unseen', [fs.existsSync(unchanged.worktree), readTask(unchanged.id).copy_removed, readTask(unchanged.id).reported_at, gitIn(repo, 'branch', '--list', unchanged.branch).includes(unchanged.branch)], [true, undefined, null, true]);
          truthy('delegate_result: and says the copy is left for a session of the task\'s own project', /left/.test(readElsewhere.value.note) && readElsewhere.value.note.includes(path.basename(repo)));
          const unseen = await call('delegate_status', {}, contextFor(repo));
          eq('delegate_status: the task is still in its owner project\'s open list', unseen.value.tasks.some((row) => row.id === unchanged.id), true);
          const nothing = await call('delegate_result', { id: unchanged.id }, contextFor(repo));
          eq('delegate_result: no changes means no files', [nothing.value.changed, nothing.value.copy_removed], [[], true]);
          const afterNothing = readTask(unchanged.id);
          eq('delegate_result: a finished copy with no changes is removed at once, branch too', [fs.existsSync(unchanged.worktree), afterNothing.copy_removed, gitIn(repo, 'branch', '--list', unchanged.branch).trim()], [false, true, '']);
          truthy('delegate_result: and says so', /removed/.test(nothing.value.note));

          const locked = await finishedCopy(repo, {});
          const lockedResult = await call('delegate_result', { id: locked.id }, contextFor(repo, { removeCopy: async () => { throw new Error('EBUSY: the folder is in use'); } }));
          eq('delegate_result: a copy that cannot be removed does not cost the result', [lockedResult.isError, lockedResult.value?.state, lockedResult.value?.final_message], [false, 'done', '## Summary\nDid it.\n']);
          truthy('delegate_result: the problem is in the note, and the copy is still recorded', /EBUSY/.test(lockedResult.value.note) && readTask(locked.id).copy_removed === undefined && fs.existsSync(locked.worktree));

          const running = createTask({ worker: 'codex', mode: 'write', location: 'here', project: repo, title: 'still going', brief: 'b\n' });
          updateTask(running.id, { state: 'running' });
          const stillRunning = await call('delegate_result', { id: running.id }, contextFor(repo));
          eq('delegate_result: a running task has no final message and is not marked reported', [stillRunning.value.state, stillRunning.value.final_message, readTask(running.id).reported_at], ['running', null, null]);

          const longReport = createTask({ worker: 'agy', mode: 'read', location: 'here', project: repo, title: 'long report', brief: 'b\n' });
          const longReportPath = path.join(taskFolder(longReport.id), 'final.md');
          const longReportText = `## Findings\n${'A finding with its source.\n'.repeat(3000)}`;
          fs.writeFileSync(longReportPath, longReportText);
          updateTask(longReport.id, { state: 'done', summary: 'Found things.', ended_at: Date.now(), final_path: longReportPath });
          const longResult = await call('delegate_result', { id: longReport.id }, contextFor(repo));
          truthy('delegate_result: a very long report comes back as its start and the path of final.md',
            longResult.value.final_message.startsWith('## Findings\n') && longResult.value.final_message.includes(longReportPath) && longResult.value.final_message.length < longReportText.length / 5);

          const failedTask = createTask({ worker: 'agy', mode: 'read', location: 'here', project: repo, title: 'failed one', brief: 'b\n' });
          updateTask(failedTask.id, { state: 'failed', summary: 'Failed: boom', limit: { kind: 'exhausted', resets_at: 5 }, denied: ['shell'], warning: 'careful' });
          const failedResult = await call('delegate_result', { id: failedTask.id }, contextFor(repo));
          eq('delegate_result: a failed task gives its summary, limit, denied and warning', [failedResult.value.summary, failedResult.value.limit, failedResult.value.denied, failedResult.value.warning, failedResult.value.final_message], ['Failed: boom', { kind: 'exhausted', resets_at: 5 }, ['shell'], 'careful', null]);
          const elsewhere = await call('delegate_result', { id: failedTask.id }, contextFor(makePlainFolder('another project asks')));
          eq('delegate_result: a result can be read from another project', elsewhere.isError, false);
          const missing = await call('delegate_result', { id: 'abcdef' }, contextFor(repo));
          truthy('delegate_result: an unknown id is an error result', missing.isError);
        });

        await guardedAsync('delegate_merge', async () => {
          const repo = makeRepo('git repo merge', { 'readme.txt': 'hello\n', 'c.txt': 'base\n' });
          const clean = await finishedCopy(repo, { 'added.txt': 'added\n' });
          const refusedElsewhere = await call('delegate_merge', { id: clean.id }, contextFor(makePlainFolder('merge from elsewhere')));
          truthy('delegate_merge: refused from a session of another project, naming the project', refusedElsewhere.isError && refusedElsewhere.text.includes(path.basename(repo)));
          eq('delegate_merge: and nothing was applied', fs.existsSync(path.join(repo, 'added.txt')), false);
          const spelledInUpperCase = process.platform === 'win32' ? repo.toUpperCase() : repo;
          // Two merges of one task at once (one in another letter case, which Windows paths ignore): the second waits its turn on the lock and finds it merged.
          let mergeCalls = 0;
          const countingMerge = (...mergeArguments) => { mergeCalls++; return gitNamespace.mergeCopy(...mergeArguments); };
          const bothAtOnce = await Promise.all([
            call('delegate_merge', { id: clean.id }, contextFor(spelledInUpperCase, { mergeCopy: countingMerge })),
            call('delegate_merge', { id: clean.id }, contextFor(repo, { mergeCopy: countingMerge }))
          ]);
          const sameProjectOtherSpelling = bothAtOnce.find((outcome) => !outcome.isError) ?? bothAtOnce[0];
          const secondMerge = bothAtOnce.find((outcome) => outcome.isError);
          eq('delegate_merge: two merges of one task at once: exactly one merges, once', [bothAtOnce.filter((outcome) => !outcome.isError).length, mergeCalls], [1, 1]);
          truthy('delegate_merge: the other is refused because the task is merged (not because of its project)', secondMerge !== undefined && /merged/.test(secondMerge.text) && !/belongs to the project/.test(secondMerge.text));
          eq('delegate_merge: the project in another letter case (Windows paths ignore case) is the same project; a clean merge applies the file and the state is merged', [sameProjectOtherSpelling.isError, sameProjectOtherSpelling.value?.state, fs.readFileSync(path.join(repo, 'added.txt'), 'utf8').replace(/\r\n/g, '\n')], [false, 'merged', 'added\n']); // this machine's git may write files with CRLF
          eq('delegate_merge: the result is the merge result', [sameProjectOtherSpelling.value.applied, sameProjectOtherSpelling.value.conflicts, sameProjectOtherSpelling.value.held, sameProjectOtherSpelling.value.skipped], [['added.txt'], [], [], []]);
          const merged = readTask(clean.id);
          eq('delegate_merge: a clean merge removes the copy and keeps the branch', [fs.existsSync(clean.worktree), merged.copy_removed, gitIn(repo, 'branch', '--list', clean.branch).includes(clean.branch)], [false, true, true]);
          eq('delegate_merge: the state in the record', [merged.state, typeof merged.reported_at], ['merged', 'number']);
          eq('delegate_merge: the user\'s index was not touched', gitIn(repo, 'diff', '--cached', '--name-only').trim(), '');
          eq('delegate_merge: the merge lock is released', fs.existsSync(path.join(dataHome(), 'merge.lock')), false);
          const again = await call('delegate_merge', { id: clean.id }, contextFor(repo));
          truthy('delegate_merge: a merged task cannot be merged again', again.isError && /merged/.test(again.text));

          const workingTask = createTask({ worker: 'codex', mode: 'write', location: 'copy', project: repo, title: 'running', brief: 'b\n' });
          updateTask(workingTask.id, { state: 'running' });
          const refusedRunning = await call('delegate_merge', { id: workingTask.id }, contextFor(repo));
          truthy('delegate_merge: refused unless the task is done or held', refusedRunning.isError && /running/.test(refusedRunning.text));
          const inPlace = createTask({ worker: 'codex', mode: 'write', location: 'here', project: repo, title: 'in place', brief: 'b\n' });
          updateTask(inPlace.id, { state: 'done' });
          const refusedInPlace = await call('delegate_merge', { id: inPlace.id }, contextFor(repo));
          truthy('delegate_merge: a task that worked in place has nothing to merge', refusedInPlace.isError && /in place|nothing to merge/.test(refusedInPlace.text));

          // One held task with a file that runs tools, a clash and a clean file: all three findings from one merge.
          const conflicting = await finishedCopy(repo, { 'ok.txt': 'ok\n', '.github/workflows/ci.yml': 'name: x\n', 'c.txt': 'theirs\n' }, { hold: true });
          updateTask(conflicting.id, { state: 'held' });
          fs.writeFileSync(path.join(repo, 'c.txt'), 'mine\n');
          const conflicted = await call('delegate_merge', { id: conflicting.id }, contextFor(repo));
          eq('delegate_merge: a held task can be merged; a file that runs tools is held, not applied', [conflicted.value.applied, conflicted.value.held.map((entry) => entry.path), fs.existsSync(path.join(repo, '.github', 'workflows', 'ci.yml'))], [['ok.txt'], ['.github/workflows/ci.yml'], false]);
          truthy('delegate_merge: the result says plainly that held files were not applied and Claude must ask the user', /NOT applied/.test(conflicted.value.note) && /ask the user/.test(conflicted.value.note));
          eq('delegate_merge: the held file\'s version sits beside it', fs.readFileSync(path.join(repo, '.github', 'workflows', 'ci.yml.task'), 'utf8').replace(/\r\n/g, '\n'), 'name: x\n');
          eq('delegate_merge: a clash gives the state conflict and keeps the copy', [conflicted.value.state, conflicted.value.conflicts, fs.existsSync(conflicting.worktree), readTask(conflicting.id).state, readTask(conflicting.id).copy_removed], ['conflict', ['c.txt'], true, 'conflict', undefined]);
          truthy('delegate_merge: the conflict markers are in the user\'s file', /<<<<<<< yours/.test(fs.readFileSync(path.join(repo, 'c.txt'), 'utf8')));
          truthy('delegate_merge: the result tells Claude to resolve with both sides in view', /both sides/.test(conflicted.value.note));
          const resultAfter = await call('delegate_result', { id: conflicting.id }, contextFor(repo));
          eq('delegate_result: a conflicted task still shows what the merge found', resultAfter.value.merge.conflicts, ['c.txt']);

          const noChange = await finishedCopy(repo, {});
          await call('delegate_result', { id: noChange.id }, contextFor(repo));
          const mergeNoChange = await call('delegate_merge', { id: noChange.id }, contextFor(repo));
          eq('delegate_merge: a task whose copy was removed for having no changes has nothing to apply', [mergeNoChange.isError, mergeNoChange.value?.state, mergeNoChange.value?.applied], [false, 'merged', []]);
        });

        await guardedAsync('delegate_merge: resolving a conflict', async () => {
          const repo = makeRepo('git repo conflict resolution', { 'readme.txt': 'hello\n', 'c.txt': 'base\n' });
          const clashing = await finishedCopy(repo, { 'c.txt': 'theirs\n' });
          fs.writeFileSync(path.join(repo, 'c.txt'), 'mine\n');
          const conflicted = await call('delegate_merge', { id: clashing.id }, contextFor(repo));
          eq('conflict resolution: the first merge leaves a conflict', [conflicted.value.state, conflicted.value.conflicts], ['conflict', ['c.txt']]);
          const statusAfter = await call('delegate_status', {}, contextFor(repo));
          eq('conflict resolution: a conflict that was reported by the merge is not listed again as needing attention', statusAfter.value.tasks.map((row) => row.id).includes(clashing.id), false);

          const stillMarked = await call('delegate_merge', { id: clashing.id }, contextFor(repo));
          truthy('conflict resolution: markers left in the file: refused, naming the file', stillMarked.isError && stillMarked.text.includes('c.txt') && /marker/i.test(stillMarked.text));
          eq('conflict resolution: and the task is still a conflict with its copy', [readTask(clashing.id).state, fs.existsSync(clashing.worktree)], ['conflict', true]);

          fs.writeFileSync(path.join(repo, 'c.txt'), 'resolved by hand\n');
          const resolved = await call('delegate_merge', { id: clashing.id }, contextFor(repo));
          eq('conflict resolution: with the markers gone the task is merged', [resolved.isError, resolved.value?.state, resolved.value?.conflicts], [false, 'merged', []]);
          const afterwards = readTask(clashing.id);
          eq('conflict resolution: the copy is removed and the branch kept', [fs.existsSync(clashing.worktree), afterwards.copy_removed, gitIn(repo, 'branch', '--list', clashing.branch).includes(clashing.branch)], [false, true, true]);
          eq('conflict resolution: the resolved file is untouched, the index too', [fs.readFileSync(path.join(repo, 'c.txt'), 'utf8'), gitIn(repo, 'diff', '--cached', '--name-only').trim()], ['resolved by hand\n', '']);
          const mergedAgain = await call('delegate_merge', { id: clashing.id }, contextFor(repo));
          truthy('conflict resolution: a merged task is not merged again', mergedAgain.isError);

          // A file the person deleted while resolving has no markers either.
          const deleting = await finishedCopy(repo, { 'd.txt': 'theirs\n' });
          fs.writeFileSync(path.join(repo, 'd.txt'), 'mine\n');
          const deletingConflict = await call('delegate_merge', { id: deleting.id }, contextFor(repo));
          eq('conflict resolution: a second clash', deletingConflict.value?.state, 'conflict');
          fs.rmSync(path.join(repo, 'd.txt'));
          const deletedResolved = await call('delegate_merge', { id: deleting.id }, contextFor(repo));
          eq('conflict resolution: a conflicted file that was deleted counts as resolved', [deletedResolved.isError, deletedResolved.value?.state], [false, 'merged']);
        });

        await guardedAsync('delegate_merge: a follow-up after a conflict', async () => {
          const repo = makeRepo('git repo follow-up after conflict', { 'readme.txt': 'hello\n', 'c.txt': 'base\n' });
          const clashing = await finishedCopy(repo, { 'c.txt': 'theirs\n' });
          fs.writeFileSync(path.join(repo, 'c.txt'), 'mine\n');
          const conflicted = await call('delegate_merge', { id: clashing.id }, contextFor(repo));
          eq('follow-up after conflict: the first merge leaves a conflict', [conflicted.value.state, conflicted.value.conflicts], ['conflict', ['c.txt']]);
          eq('follow-up after conflict: the merge records what it merged', readTask(clashing.id).merged_commit, clashing.end_commit);
          fs.writeFileSync(path.join(repo, 'c.txt'), 'resolved by hand\n');

          // The follow-up runs in the same copy and ends with a new snapshot of it.
          const fixed = readTask(clashing.id);
          fs.writeFileSync(path.join(fixed.worktree, 'd.txt'), 'from the follow-up\n');
          const secondEnd = await endSnapshot(fixed.worktree, repo, fixed.start_commit);
          updateTask(clashing.id, { state: 'done', end_commit: secondEnd, merge_result: null });
          const second = await call('delegate_merge', { id: clashing.id }, contextFor(repo));
          eq('follow-up after conflict: only the change the follow-up made is applied, no new conflict', [second.isError, second.value?.state, second.value?.applied, second.value?.conflicts], [false, 'merged', ['d.txt'], []]);
          eq('follow-up after conflict: the file the person resolved is untouched', fs.readFileSync(path.join(repo, 'c.txt'), 'utf8'), 'resolved by hand\n');
          eq('follow-up after conflict: the file of the follow-up is in the project', fs.readFileSync(path.join(repo, 'd.txt'), 'utf8').replace(/\r\n/g, '\n'), 'from the follow-up\n');
        });

        await guardedAsync('delegate_merge: a file one merge skipped is tried again by the next', async () => {
          // A clash on c.txt makes the task a conflict (a follow-up is possible); y.bin is a binary clash whose
          // side copy has no free name, so the merge skips it.
          const setUp = async (name, followUp) => {
            const repo = makeRepo('git repo ' + name, { 'readme.txt': 'hello\n', 'c.txt': 'base\n', 'y.bin': Buffer.from([0, 1, 2, 3]) });
            const task = await finishedCopy(repo, { 'c.txt': 'theirs\n', 'y.bin': Buffer.from([0, 9, 9, 9]) });
            fs.writeFileSync(path.join(repo, 'c.txt'), 'mine\n');
            fs.writeFileSync(path.join(repo, 'y.bin'), Buffer.from([0, 5, 5]));
            fs.writeFileSync(path.join(repo, 'y.bin.task'), 'taken');
            for (let number = 2; number <= 20; number++) fs.writeFileSync(path.join(repo, 'y.bin.task.' + number), 'taken');
            const first = await call('delegate_merge', { id: task.id }, contextFor(repo));
            eq(name + ': the first merge is a conflict and skips y.bin', [first.value.state, first.value.conflicts, first.value.skipped], ['conflict', ['c.txt'], [{ path: 'y.bin', reason: 'could not save a side copy' }]]);
            eq(name + ': the task records the skipped file with the commit it was diffed from', readTask(task.id).unmerged_paths, [{ path: 'y.bin', base: task.start_commit }]);
            // The person resolves c.txt and puts y.bin back as it was; the follow-up then ends with a new snapshot.
            fs.writeFileSync(path.join(repo, 'c.txt'), 'resolved by hand\n');
            fs.writeFileSync(path.join(repo, 'y.bin'), Buffer.from([0, 1, 2, 3]));
            const fixed = readTask(task.id);
            for (const [file, content] of Object.entries(followUp)) fs.writeFileSync(path.join(fixed.worktree, file), content);
            const secondEnd = await endSnapshot(fixed.worktree, repo, fixed.start_commit);
            updateTask(task.id, { state: 'done', end_commit: secondEnd, merge_result: null });
            return { task, repo };
          };
          const plain = await setUp('skipped carried', { 'd.txt': 'from the follow-up\n' });
          const second = await call('delegate_merge', { id: plain.task.id }, contextFor(plain.repo));
          eq('skipped carried: the next merge applies the follow-up\'s file and the one the first skipped', [second.isError, second.value?.state, second.value?.applied.slice().sort(), second.value?.skipped], [false, 'merged', ['d.txt', 'y.bin'], []]);
          eq('skipped carried: y.bin is the task\'s version now', Array.from(fs.readFileSync(path.join(plain.repo, 'y.bin'))), [0, 9, 9, 9]);
          eq('skipped carried: nothing is left to carry', readTask(plain.task.id).unmerged_paths, []);

          // A file both carried and changed again by the follow-up is applied once, with the follow-up's content.
          const again = await setUp('skipped and changed again', { 'y.bin': Buffer.from([0, 7, 7, 7]) });
          const third = await call('delegate_merge', { id: again.task.id }, contextFor(again.repo));
          eq('skipped and changed again: applied once', [third.value?.state, third.value?.applied, third.value?.skipped], ['merged', ['y.bin'], []]);
          eq('skipped and changed again: with the later version', Array.from(fs.readFileSync(path.join(again.repo, 'y.bin'))), [0, 7, 7, 7]);
        });

        await guardedAsync('delegate_result: a follow-up that changed nothing after a merge keeps the undo branch', async () => {
          const repo = makeRepo('git repo result keeps branch', { 'readme.txt': 'hello\n', 'c.txt': 'base\n' });
          const clashing = await finishedCopy(repo, { 'c.txt': 'theirs\n' });
          fs.writeFileSync(path.join(repo, 'c.txt'), 'mine\n');
          await call('delegate_merge', { id: clashing.id }, contextFor(repo));
          fs.writeFileSync(path.join(repo, 'c.txt'), 'resolved by hand\n');
          // The follow-up ends without a single edit.
          const fixed = readTask(clashing.id);
          const secondEnd = await endSnapshot(fixed.worktree, repo, fixed.start_commit);
          updateTask(clashing.id, { state: 'done', end_commit: secondEnd, merge_result: null });
          const view = await call('delegate_result', { id: clashing.id }, contextFor(repo));
          eq('result keeps branch: nothing came after the merge', view.value?.changed, []);
          eq('result keeps branch: the copy goes, the branch stays as the undo', [fs.existsSync(clashing.worktree), gitIn(repo, 'branch', '--list', clashing.branch).includes(clashing.branch), view.value?.branch], [false, true, clashing.branch]);
          eq('result keeps branch: the record keeps the branch name', [readTask(clashing.id).copy_removed, readTask(clashing.id).branch], [true, clashing.branch]);
          truthy('result keeps branch: the note says the branch is kept', /branch/.test(view.value?.note ?? '') && /kept/.test(view.value?.note ?? '') && !/branch were removed/.test(view.value?.note ?? ''));
          const mergeAgain = await call('delegate_merge', { id: clashing.id }, contextFor(repo));
          eq('result keeps branch: the next merge is a merged task with nothing applied', [mergeAgain.isError, mergeAgain.value?.state, mergeAgain.value?.applied], [false, 'merged', []]);
          truthy('result keeps branch: and it says there is nothing new, not that the task changed no files', /nothing new/.test(mergeAgain.value?.note ?? '') && !/changed no files/.test(mergeAgain.value?.note ?? ''));
          eq('result keeps branch: the branch is still there', gitIn(repo, 'branch', '--list', clashing.branch).includes(clashing.branch), true);

          // A task never merged that changed nothing still loses its branch.
          const untouched = await finishedCopy(repo, {});
          const emptyView = await call('delegate_result', { id: untouched.id }, contextFor(repo));
          eq('result keeps branch: a task never merged that changed nothing loses copy and branch', [emptyView.value?.changed, fs.existsSync(untouched.worktree), gitIn(repo, 'branch', '--list', untouched.branch).includes(untouched.branch)], [[], false, false]);
        });

        await guardedAsync('delegate_result: after a merge and a follow-up', async () => {
          const repo = makeRepo('git repo result after follow-up', { 'readme.txt': 'hello\n', 'c.txt': 'base\n' });
          const clashing = await finishedCopy(repo, { 'c.txt': 'theirs\n' });
          fs.writeFileSync(path.join(repo, 'c.txt'), 'mine\n');
          await call('delegate_merge', { id: clashing.id }, contextFor(repo));
          fs.writeFileSync(path.join(repo, 'c.txt'), 'resolved by hand\n');
          const fixed = readTask(clashing.id);
          fs.writeFileSync(path.join(fixed.worktree, 'd.txt'), 'from the follow-up\n');
          const secondEnd = await endSnapshot(fixed.worktree, repo, fixed.start_commit);
          updateTask(clashing.id, { state: 'done', end_commit: secondEnd, merge_result: null });
          const view = await call('delegate_result', { id: clashing.id }, contextFor(repo));
          eq('result after a follow-up: only what came after the earlier merge is listed', view.value?.changed?.map((file) => `${file.status} ${file.path}`), ['A d.txt']);
          truthy('result after a follow-up: the diff stat counts only that change', /1 file changed/.test(view.value?.diff_stat ?? ''));
        });

        await guardedAsync('index rebuilds: one at a time, the last to start wins', async () => {
          const project = makePlainFolder('index lock');
          const task = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'racing', brief: 'b\n' });
          const indexPath = path.join(dataHome(), 'index.json');
          const lockPath = path.join(dataHome(), 'index.lock');
          const stateInIndex = () => JSON.parse(fs.readFileSync(indexPath, 'utf8')).tasks.find((row) => row.id === task.id).state;
          eq('index lock: the index starts out queued, with no lock left', [stateInIndex(), fs.existsSync(lockPath)], ['queued', false]);

          // A rebuild in flight: another process holds the lock having read the queued state, and writes that older
          // snapshot a moment later. A rebuild that starts meanwhile has to wait its turn and so writes after it.
          const holderSource = [
            "const fs = require('fs'), path = require('path');",
            'const [home, holdMs] = process.argv.slice(1);',
            "const indexPath = path.join(home, 'index.json');",
            "const lockPath = path.join(home, 'index.lock');",
            "const snapshot = fs.readFileSync(indexPath, 'utf8');",
            'fs.mkdirSync(lockPath);',
            "fs.writeFileSync(path.join(lockPath, 'owner'), 'holder');",
            "console.log('locked');",
            'setTimeout(() => { fs.writeFileSync(indexPath, snapshot); fs.rmSync(lockPath, { recursive: true }); }, Number(holdMs));'
          ].join('\n');
          const holder = spawn(process.execPath, ['-e', holderSource, dataHome(), '1500'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
          const holderExit = new Promise((resolve) => holder.on('exit', resolve));
          await new Promise((resolve) => holder.stdout.once('data', resolve));
          const startedAt = Date.now();
          updateTask(task.id, { state: 'running', started_at: startedAt });
          const waitedMs = Date.now() - startedAt;
          await holderExit;
          truthy('index lock: a rebuild waits while another holds the lock', waitedMs >= 1000);
          eq('index lock: the rebuild that started later wrote last, so the index shows the newer state', stateInIndex(), 'running');
          eq('index lock: and the lock is released', fs.existsSync(lockPath), false);

          // A lock older than the stale limit belongs to a holder that died: it is broken, not waited for.
          fs.mkdirSync(lockPath);
          fs.writeFileSync(path.join(lockPath, 'owner'), 'dead holder');
          const longAgo = new Date(Date.now() - 60000);
          fs.utimesSync(lockPath, longAgo, longAgo);
          const staleStartedAt = Date.now();
          updateTask(task.id, { state: 'done', ended_at: Date.now() });
          truthy('index lock: a stale lock is broken at once', Date.now() - staleStartedAt < 5000);
          eq('index lock: and the rebuild goes through', [stateInIndex(), fs.existsSync(lockPath)], ['done', false]);
        });

        await guardedAsync('delegate_send: refusals and setup', async () => {
          const project = makePlainFolder('plain send');
          const base = (state, overrides = {}) => {
            const task = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'to resume', brief: 'b\n', owner_instance: 'instance-b', ...overrides });
            return updateTask(task.id, { state, worker_session: '5eed5eed-0000-4000-8000-000000000001', ended_at: Date.now(), supervisor_pid: 99999, supervisor_beat_at: Date.now() });
          };
          for (const state of ['queued', 'running']) {
            const busy = await call('delegate_send', { id: base(state).id, message: 'more' }, contextFor(project));
            truthy(`delegate_send: refused while ${state}`, busy.isError && new RegExp(state).test(busy.text));
          }
          const merged = await call('delegate_send', { id: base('merged').id, message: 'more' }, contextFor(project));
          truthy('delegate_send: refused from merged', merged.isError);
          const noMessage = await call('delegate_send', { id: base('done').id, message: ' ' }, contextFor(project));
          truthy('delegate_send: an empty message is an error result', noMessage.isError && /message/.test(noMessage.text));
          const noSession = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'no session', brief: 'b\n' });
          updateTask(noSession.id, { state: 'failed' });
          const refusedNoSession = await call('delegate_send', { id: noSession.id, message: 'more' }, contextFor(project));
          truthy('delegate_send: a task with no recorded worker session is refused with a clear message', refusedNoSession.isError && /session/.test(refusedNoSession.text));
          const copyGone = base('done', { location: 'copy' });
          updateTask(copyGone.id, { copy_removed: true });
          const refusedCopyGone = await call('delegate_send', { id: copyGone.id, message: 'more' }, contextFor(project));
          truthy('delegate_send: a task whose copy was removed is refused: start a new task', refusedCopyGone.isError && /the copy was removed after merging; start a new task/.test(refusedCopyGone.text));
          const writeElsewhere = await call('delegate_send', { id: base('done').id, message: 'more' }, contextFor(makePlainFolder('send from elsewhere')));
          truthy('delegate_send: a write task is not resumed from another project', writeElsewhere.isError && writeElsewhere.text.includes(path.basename(project)));
          const rollbackTask = base('conflict', { owner_instance: 'instance-b', owner_session: 'session-b' });
          fs.writeFileSync(path.join(taskFolder(rollbackTask.id), 'cancel'), 'stop\n');
          updateTask(rollbackTask.id, { reported_at: 7, queue_waiting_long: true, merge_result: { conflicts: ['old.txt'] }, relaunched: true, queued_at: 5 });
          const beforeRollback = readTask(rollbackTask.id);
          const rolledBack = await call('delegate_send', { id: rollbackTask.id, message: 'more' }, contextFor(project, { launch: () => { throw new Error('spawn failed'); } }));
          truthy('delegate_send: a supervisor that cannot start is an error result', rolledBack.isError && /spawn failed/.test(rolledBack.text));
          const afterRollback = readTask(rollbackTask.id);
          const restoredKeys = ['state', 'followup', 'supervisor_pid', 'supervisor_beat_at', 'queued_at', 'reported_at', 'merge_result', 'owner_instance', 'owner_session', 'queue_waiting_long', 'relaunched', 'skipped_by'];
          const changedByRollback = restoredKeys.filter((key) => JSON.stringify(afterRollback[key] ?? null) !== JSON.stringify(beforeRollback[key] ?? null));
          eq('delegate_send: when the launch fails everything it changed is put back (owner, merge result, state, clocks)', changedByRollback, []);
          eq('delegate_send: and the cancel file it removed is back', fs.readFileSync(path.join(taskFolder(rollbackTask.id), 'cancel'), 'utf8'), 'stop\n');

          for (const state of ['done', 'held', 'failed', 'stopped', 'paused-limit', 'cancelled', 'conflict']) {
            const task = base(state, { owner_instance: 'instance-b' });
            fs.writeFileSync(path.join(taskFolder(task.id), 'cancel'), '');
            updateTask(task.id, { reported_at: 1, queue_waiting_long: true, merge_result: { conflicts: ['old.txt'], applied: [], held: [], skipped: [], task_copies: [] } });
            const before = launchedIds.length;
            const sent = await call('delegate_send', { id: task.id, message: 'Please add tests.' }, contextFor(project));
            const after = readTask(task.id);
            eq(`delegate_send from ${state}: queued again with the follow-up, no supervisor recorded`, [sent.isError, after.state, after.followup, after.supervisor_pid, after.supervisor_beat_at], [false, 'queued', 'Please add tests.', null, null]);
            eq(`delegate_send from ${state}: launched once; the old cancel file is gone; ownership moves here`, [launchedIds.length - before, launchedIds.at(-1), fs.existsSync(path.join(taskFolder(task.id), 'cancel')), after.owner_instance, after.owner_session], [1, task.id, false, 'instance-a', 'session-a']);
            eq(`delegate_send from ${state}: the result is not reported yet, and the last merge's findings are not shown again`, [after.reported_at, typeof after.queued_at, after.merge_result], [null, 'number', null]);
          }
          const readTaskElsewhere = createTask({ worker: 'agy', mode: 'read', location: 'here', project, title: 'read one', brief: 'b\n' });
          updateTask(readTaskElsewhere.id, { state: 'done', worker_session: '5eed5eed-0000-4000-8000-000000000002' });
          const readSend = await call('delegate_send', { id: readTaskElsewhere.id, message: 'and the tests?' }, contextFor(makePlainFolder('read send elsewhere')));
          truthy('delegate_send: a read-only task is not followed up from another project either, and ownership stays', readSend.isError && readSend.text.includes(path.basename(project)) && readTask(readTaskElsewhere.id).state === 'done' && readTask(readTaskElsewhere.id).owner_instance === null);
          const localTask = createTask({ worker: 'local', mode: 'read', location: 'here', project, title: 'local one', brief: 'b\n' });
          updateTask(localTask.id, { state: 'done' });
          const localSend = await call('delegate_send', { id: localTask.id, message: 'again' }, contextFor(project));
          eq('delegate_send: a local task resumes its pi session (always recorded)', localSend.isError, false);
        });

        await guardedAsync('delegate_cancel', async () => {
          const project = makePlainFolder('plain cancel');
          const running = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'running', brief: 'b\n' });
          updateTask(running.id, { state: 'running', supervisor_pid: process.pid, supervisor_beat_at: Date.now() });
          const cancelled = await call('delegate_cancel', { id: running.id }, contextFor(project));
          eq('delegate_cancel: a running task gets the cancel file (the supervisor does the rest)', [cancelled.isError, fs.existsSync(path.join(taskFolder(running.id), 'cancel')), readTask(running.id).state], [false, true, 'running']);
          const queuedLive = createTask({ worker: 'local', mode: 'read', location: 'here', project, title: 'queued live', brief: 'b\n' });
          updateTask(queuedLive.id, { supervisor_pid: process.pid, supervisor_beat_at: Date.now() });
          await call('delegate_cancel', { id: queuedLive.id }, contextFor(project));
          eq('delegate_cancel: a queued task with a live supervisor gets the cancel file too', [fs.existsSync(path.join(taskFolder(queuedLive.id), 'cancel')), readTask(queuedLive.id).state], [true, 'queued']);
          const queuedDead = createTask({ worker: 'local', mode: 'read', location: 'here', project, title: 'queued dead', brief: 'b\n' });
          updateTask(queuedDead.id, { supervisor_pid: null });
          const direct = await call('delegate_cancel', { id: queuedDead.id }, contextFor(project));
          const afterDirect = readTask(queuedDead.id);
          eq('delegate_cancel: a queued task with no supervisor is cancelled directly', [direct.value.state, afterDirect.state, typeof afterDirect.ended_at], ['cancelled', 'cancelled', 'number']);
          const queuedStale = createTask({ worker: 'local', mode: 'read', location: 'here', project, title: 'queued stale', brief: 'b\n' });
          updateTask(queuedStale.id, { supervisor_pid: process.pid, supervisor_beat_at: Date.now() - 5 * 60000 });
          await call('delegate_cancel', { id: queuedStale.id }, contextFor(project));
          eq('delegate_cancel: a stale beat counts as no supervisor', readTask(queuedStale.id).state, 'cancelled');
          const finished = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'finished', brief: 'b\n' });
          updateTask(finished.id, { state: 'done' });
          const tooLate = await call('delegate_cancel', { id: finished.id }, contextFor(project));
          truthy('delegate_cancel: a task that has ended says so', tooLate.isError && /done/.test(tooLate.text));
          eq('delegate_cancel: and writes no cancel file', fs.existsSync(path.join(taskFolder(finished.id), 'cancel')), false);
        });

        await guardedAsync('delegate_wait', async () => {
          const project = makePlainFolder('plain wait');
          const waiter = { sessionId: 'session-w', instanceId: 'instance-w' };
          const running = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'waits', brief: 'b\n', owner_session: 'session-w', owner_instance: 'instance-w' });
          updateTask(running.id, { state: 'running' });
          setTimeout(() => updateTask(running.id, { state: 'done', summary: 'finished' }), 300);
          const startedAt = Date.now();
          const woken = await call('delegate_wait', { id: running.id, timeout_s: 20 }, contextFor(project, waiter));
          eq('delegate_wait: returns the changed row when the task changes state', [woken.value.timed_out, woken.value.changed.map((row) => [row.id, row.state])], [false, [[running.id, 'done']]]);
          truthy('delegate_wait: and does so long before its 20 s timeout', Date.now() - startedAt < 15000);
          const already = await call('delegate_wait', { id: running.id, timeout_s: 20 }, contextFor(project));
          eq('delegate_wait: a task that has already ended is returned at once', [already.value.timed_out, already.value.changed[0]?.state], [false, 'done']);

          const second = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'session wait', brief: 'b\n', owner_session: 'session-w', owner_instance: 'instance-w' });
          const strangers = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'someone else\'s', brief: 'b\n', owner_session: 'session-z', owner_instance: 'instance-z' });
          updateTask(second.id, { state: 'running' });
          updateTask(strangers.id, { state: 'running' });
          setTimeout(() => updateTask(strangers.id, { state: 'done' }), 200);
          setTimeout(() => updateTask(second.id, { state: 'failed', summary: 'Failed: x' }), 500);
          const any = await call('delegate_wait', { timeout_s: 20 }, contextFor(project, waiter));
          eq('delegate_wait: with no id, a change of one of this session\'s tasks wakes it (another session\'s does not)', any.value.changed.map((row) => row.id), [second.id]);

          const idle = await call('delegate_wait', { timeout_s: 20 }, contextFor(project, { sessionId: 'session-idle', instanceId: 'instance-idle' }));
          eq('delegate_wait: with nothing of this session running it says so at once', [idle.value.timed_out, idle.value.changed, typeof idle.value.note], [false, [], 'string']);

          const stuck = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'never ends', brief: 'b\n', owner_session: 'session-w', owner_instance: 'instance-w' });
          updateTask(stuck.id, { state: 'running' });
          const patient = Date.now();
          const timedOut = await call('delegate_wait', { id: stuck.id, timeout_s: 1 }, contextFor(project, waiter));
          eq('delegate_wait: gives up at the timeout', [timedOut.value.timed_out, timedOut.value.changed], [true, []]);
          truthy('delegate_wait: after about a second', Date.now() - patient >= 900 && Date.now() - patient < 20000);
          const aborter = new AbortController();
          setTimeout(() => aborter.abort(), 200);
          const abortStart = Date.now();
          const aborted = await call('delegate_wait', { id: stuck.id, timeout_s: 60 }, contextFor(project, { ...waiter, signal: aborter.signal }));
          truthy('delegate_wait: stops when the call is cancelled, long before its 60 s timeout', Date.now() - abortStart < 30000 && aborted.value.timed_out === true);
          const noTask = await call('delegate_wait', { id: 'abcdef', timeout_s: 1 }, contextFor(project));
          truthy('delegate_wait: an unknown id is an error result', noTask.isError);
        });

        // Real supervisors with the fake worker: a copy start, then a follow-up in the same session.
        await guardedAsync('delegate: real supervisor, copy and follow-up', async () => {
          const repo = makeRepo('Имя git repo real', { 'readme.txt': 'hello\n' });
          beat('instance-a'); // the earlier tests took a while; a supervisor stops a task whose owner has no fresh beat
          const reportFile = path.join(toolsRoot, 'fake-report.json');
          const supervisorEnv = {
            ...process.env, CONSULT_DELEGATE_TEST_BIN: fakeWorkerPath, CODEX_HOME: toolsCodexHome, CONSULT_NO_USER_ENV: '1',
            USERPROFILE: fakeUserHome, HOME: fakeUserHome, CONSULT_DELEGATE_WATCHDOG_MS: '600000', CONSULT_DELEGATE_POLL_MS: '200',
            FAKE_SCENARIO: 'ok', FAKE_REPORT_FILE: reportFile
          };
          const realLaunch = (taskId, options) => {
            const pid = launchSupervisor(taskId, options);
            realLaunchedPids.push(pid);
            return pid;
          };
          const context = contextFor(repo, { launch: realLaunch, supervisorEnv });
          const started = await call('delegate', briefArgs(), context);
          eq('delegate: a write task in a git project starts in a copy', [started.value.started, started.value.location, started.value.worker], [true, 'copy', 'codex']);
          const done = await waitForTask(started.value.id, (task) => task.state === 'done' || task.state === 'failed');
          eq('delegate: the worker ran and finished in the copy', [done.state, fs.readFileSync(path.join(done.worktree, 'worker-output.txt'), 'utf8')], ['done', 'written by the fake worker\n']);
          eq('delegate: the project itself is untouched', fs.existsSync(path.join(repo, 'worker-output.txt')), false);
          const firstReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
          truthy('delegate: the brief reached the worker on stdin with the preamble', firstReport.promptStart.startsWith('You are working alone on a delegated task.'));
          const result = await call('delegate_result', { id: started.value.id }, context);
          eq('delegate_result: the finished copy\'s files and message', [result.value.changed.map((file) => file.path), result.value.final_message.includes('Created worker-output.txt')], [['worker-output.txt'], true]);

          const sent = await call('delegate_send', { id: started.value.id, message: 'Please also add tests.' }, context);
          eq('delegate_send: starts a new run in the same task', [sent.isError, sent.value?.id, sent.value?.started], [false, started.value.id, true]);
          const second = await waitForTask(started.value.id, (task) => task.state === 'done' && task.ended_at > done.ended_at);
          eq('delegate_send: the same task finished again, in the same folder', [second.state, second.worktree], ['done', done.worktree]);
          const secondReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
          truthy('delegate_send: the worker was resumed with the recorded session', secondReport.args.includes('resume') && secondReport.args.includes('5eed5eed-0000-4000-8000-000000000001'));
          eq('delegate_send: the follow-up text is what the worker was given', secondReport.promptStart, 'Please also add tests.');
          eq('delegate_send: the second run ran in the same copy', fs.realpathSync.native(secondReport.cwd).toLowerCase(), fs.realpathSync.native(done.worktree).toLowerCase());
        });

        // A follow-up's result is its own: the previous run's final.md does not stand in for it.
        await guardedAsync('delegate_result: follow-ups', async () => {
          const repo = makeRepo('Имя git repo followup', { 'readme.txt': 'hello\n' });
          beat('instance-a');
          const supervisorEnvFor = (scenario, extra = {}) => ({
            ...process.env, CONSULT_DELEGATE_TEST_BIN: fakeWorkerPath, CODEX_HOME: toolsCodexHome, CONSULT_NO_USER_ENV: '1',
            USERPROFILE: fakeUserHome, HOME: fakeUserHome, CONSULT_DELEGATE_WATCHDOG_MS: '600000', CONSULT_DELEGATE_POLL_MS: '200',
            FAKE_SCENARIO: scenario, ...extra
          });
          const realLaunch = (taskId, options) => {
            const pid = launchSupervisor(taskId, options);
            realLaunchedPids.push(pid);
            return pid;
          };
          const started = await call('delegate', briefArgs(), contextFor(repo, { launch: realLaunch, supervisorEnv: supervisorEnvFor('ok') }));
          const first = await waitForTask(started.value.id, (task) => task.state === 'done');
          truthy('follow-up: the first run wrote its answer', (await call('delegate_result', { id: first.id }, contextFor(repo))).value.final_message.includes('Created worker-output.txt'));

          await call('delegate_send', { id: first.id, message: 'Now fail.' }, contextFor(repo, { launch: realLaunch, supervisorEnv: supervisorEnvFor('fail') }));
          const failed = await waitForTask(first.id, (task) => task.state === 'failed');
          const failedResult = await call('delegate_result', { id: first.id }, contextFor(repo));
          eq('follow-up: a failed follow-up does not show the previous answer', [failed.state, failedResult.value.final_message], ['failed', null]);

          await call('delegate_send', { id: first.id, message: 'Try again.' }, contextFor(repo, { launch: realLaunch, supervisorEnv: supervisorEnvFor('ok', { FAKE_ANSWER_TAG: 'third run' }) }));
          const third = await waitForTask(first.id, (task) => task.state === 'done' && task.ended_at > failed.ended_at);
          eq('follow-up: a successful follow-up shows its own answer', [third.state, (await call('delegate_result', { id: first.id }, contextFor(repo))).value.final_message], ['done', '## Summary\nCreated worker-output.txt in the folder.\nTag: third run\nSecond line of the message.\n']);

          // A run that finishes without any message shows none, not the third run's.
          await call('delegate_send', { id: first.id, message: 'Say nothing.' }, contextFor(repo, { launch: realLaunch, supervisorEnv: supervisorEnvFor('ok', { FAKE_NO_MESSAGE: '1' }) }));
          const silent = await waitForTask(first.id, (task) => task.state === 'done' && task.ended_at > third.ended_at);
          eq('follow-up: a follow-up that ends with no message shows none', [silent.state, (await call('delegate_result', { id: first.id }, contextFor(repo))).value.final_message], ['done', null]);

          // A follow-up cancelled while it is still queued shows no answer from the earlier run either.
          const queuedOnly = await call('delegate', briefArgs(), contextFor(repo, { launch: realLaunch, supervisorEnv: supervisorEnvFor('ok') }));
          const finishedOnce = await waitForTask(queuedOnly.value.id, (task) => task.state === 'done');
          await call('delegate_send', { id: finishedOnce.id, message: 'Never runs.' }, contextFor(repo, { launch: () => 4242 }));
          const stillQueued = readTask(finishedOnce.id);
          eq('follow-up: a queued follow-up has no earlier answer on file', [stillQueued.state, stillQueued.final_path, fs.existsSync(path.join(taskFolder(finishedOnce.id), 'final.md'))], ['queued', null, false]);
          await call('delegate_cancel', { id: finishedOnce.id }, contextFor(repo));
          eq('follow-up: a follow-up cancelled while queued shows no previous answer', [(await call('delegate_result', { id: finishedOnce.id }, contextFor(repo))).value.final_message], [null]);
        });
      }

      // ---- dead supervisors and the startup sweeps ----
      if (sweepModule !== null) {
        await guardedAsync('sweep: elapsedSeconds reads ps etime, which macOS has and etimes is not', async () => {
          eq('elapsedSeconds: mm:ss, hh:mm:ss and dd-hh:mm:ss',
            [sweepModule.elapsedSeconds('   00:05\n'), sweepModule.elapsedSeconds('01:02:03'), sweepModule.elapsedSeconds('2-01:02:03')],
            [5, 3723, 2 * 86400 + 3723]);
          eq('elapsedSeconds: nothing readable is null', [sweepModule.elapsedSeconds(null), sweepModule.elapsedSeconds(''), sweepModule.elapsedSeconds('12345')], [null, null, null]);
        });

        // The sweeps look at every task in the data folder: each section has its own. The
        // bookkeeping cases use a process lookup that is injected (io); the real
        // PowerShell lookups are exercised by one kill test and one command-line check.
        await guardedAsync('sweep: dead supervisors', async () => {
          const project = makePlainFolder('plain sweep');
          const otherProject = makePlainFolder('plain sweep elsewhere');
          const deadPid = await deadPidNow();
          const relaunches = [];
          const killed = [];
          const commandLinesAsked = [];
          let commandLine = null; // what the injected lookup says a live pid is running
          const fakeProcesses = {
            commandLineOf: async (pid) => { commandLinesAsked.push(pid); return commandLine; },
            killWorker: async (task) => { killed.push(task.id); }
          };
          const sweep = (extra = {}) => sweepModule.sweepDeadSupervisors({ project, launch: (id) => { relaunches.push(id); return 4242; }, env: process.env, io: fakeProcesses, ...extra });
          // A task with a live pid (this process) and a stale beat, swept with `commandLine` as its command line; then retired.
          const staleBeatCase = async (title, line) => {
            const task = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title, brief: 'b\n' });
            updateTask(task.id, { state: 'running', started_at: Date.now() - 1000, supervisor_pid: process.pid, supervisor_beat_at: Date.now() - 3 * 60000 });
            commandLine = typeof line === 'function' ? line(task.id) : line;
            await sweep();
            const after = readTask(task.id);
            updateTask(task.id, { state: 'done' });
            return after;
          };

          const dead = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'dead supervisor', brief: 'b\n' });
          updateTask(dead.id, { state: 'running', started_at: Date.now() - 1000, supervisor_pid: deadPid, supervisor_beat_at: Date.now() });
          const deadQueued = createTask({ worker: 'local', mode: 'read', location: 'here', project, title: 'dead queued', brief: 'b\n' });
          updateTask(deadQueued.id, { supervisor_pid: deadPid, supervisor_beat_at: Date.now() });
          const alive = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'live supervisor', brief: 'b\n' });
          updateTask(alive.id, { state: 'running', started_at: Date.now() - 1000, supervisor_pid: process.pid, supervisor_beat_at: Date.now() - 10000 });
          const finishedTask = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'finished', brief: 'b\n' });
          updateTask(finishedTask.id, { state: 'done', supervisor_pid: deadPid });
          const outcome = await sweep();
          const stoppedDead = readTask(dead.id);
          eq('sweep: a running task whose supervisor is gone is stopped, reason supervisor-died', [stoppedDead.state, stoppedDead.stop_reason, typeof stoppedDead.ended_at], ['stopped', 'supervisor-died', 'number']);
          truthy('sweep: with a summary that says so', /supervisor/i.test(stoppedDead.summary));
          eq('sweep: a queued task whose supervisor is gone is stopped too', readTask(deadQueued.id).state, 'stopped');
          eq('sweep: a task whose supervisor is alive and has beaten lately is left alone', readTask(alive.id).state, 'running');
          eq('sweep: a finished task is not touched', readTask(finishedTask.id).state, 'done');
          eq('sweep: the ids it stopped are returned', outcome.stopped.sort(), [dead.id, deadQueued.id].sort());
          eq('sweep: the orphaned worker is looked for in each task it stops, and only those', killed.sort(), [dead.id, deadQueued.id].sort());
          eq('sweep: a live pid with a fresh beat is not even asked about', commandLinesAsked, []);
          const again = await sweep();
          eq('sweep: a second pass has nothing to do', [again.stopped, again.relaunched, again.failed], [[], [], []]);

          const notOurs = await staleBeatCase('recycled pid', 'node C:\\somewhere\\other-script.js');
          eq('sweep: a pid that is alive but is not a delegate-run.js process, with a beat over 2 min old, counts as dead', [notOurs.state, notOurs.stop_reason], ['stopped', 'supervisor-died']);
          const ours = await staleBeatCase('slow supervisor', (id) => `"C:\\node.exe" C:\\x\\mcp\\delegate-run.js ${id}`);
          eq('sweep: a delegate-run.js process for this task with an old beat is left alone (it may have slept)', ours.state, 'running');
          const someoneElses = await staleBeatCase('pid of another task\'s supervisor', '"C:\\node.exe" C:\\x\\mcp\\delegate-run.js abcdef');
          eq('sweep: a delegate-run.js process for another task is not this task\'s supervisor', [someoneElses.state, someoneElses.stop_reason], ['stopped', 'supervisor-died']);
          const unknown = await staleBeatCase('cannot tell', null);
          eq('sweep: when the command line cannot be read the task is not given up on', unknown.state, 'running');
          const realLookup = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'real lookup', brief: 'b\n' });
          updateTask(realLookup.id, { state: 'running', started_at: Date.now() - 1000, supervisor_pid: process.pid, supervisor_beat_at: Date.now() - 3 * 60000 });
          await sweepModule.sweepDeadSupervisors({ project, launch: () => 1, env: process.env, io: { killWorker: async () => {} } });
          eq('sweep: the real command-line lookup tells this test process from a supervisor', readTask(realLookup.id).stop_reason, 'supervisor-died');

          const indexFile = path.join(process.env.CONSULT_DELEGATE_HOME, 'index.json');
          const staleIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
          for (const row of staleIndex.tasks) {
            if (row.id === realLookup.id) row.state = 'running';
          }
          fs.writeFileSync(indexFile, JSON.stringify(staleIndex));
          await sweepModule.sweepDeadSupervisors({ project, launch: () => 1, env: process.env, io: { killWorker: async () => {} } });
          const healedRow = JSON.parse(fs.readFileSync(indexFile, 'utf8')).tasks.find((row) => row.id === realLookup.id);
          eq('sweep: an index row a lost race left stale is rebuilt from the task folders', healedRow.state, 'stopped');
          const settledAt = fs.statSync(indexFile).mtimeMs;
          await new Promise((resolve) => setTimeout(resolve, 30));
          await sweepModule.sweepDeadSupervisors({ project, launch: () => 1, env: process.env, io: { killWorker: async () => {} } });
          eq('sweep: an index that is already right is not written again', fs.statSync(indexFile).mtimeMs, settledAt);

          const never = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'never launched', brief: 'b\n', created_at: Date.now() - 3 * 60000 });
          const fresh = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'just created', brief: 'b\n', created_at: Date.now() - 30000 });
          const resent = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title: 'just resent', brief: 'b\n', created_at: Date.now() - 3 * 60000 });
          updateTask(resent.id, { queued_at: Date.now() - 20000 });
          const neverElsewhere = createTask({ worker: 'codex', mode: 'write', location: 'here', project: otherProject, title: 'never launched, other project', brief: 'b\n', created_at: Date.now() - 3 * 60000 });
          const first = await sweep();
          eq('sweep: a never-launched task of another project is left for that project\'s session', [first.relaunched.includes(neverElsewhere.id), relaunches.includes(neverElsewhere.id), readTask(neverElsewhere.id).relaunched], [false, false, undefined]);
          eq('sweep: a queued task with no supervisor for over 2 min is relaunched once', [first.relaunched.includes(never.id), readTask(never.id).relaunched, relaunches.filter((id) => id === never.id).length], [true, true, 1]);
          eq('sweep: a young one, and one queued again lately, are left', [first.relaunched.includes(fresh.id), first.relaunched.includes(resent.id)], [false, false]);
          eq('sweep: the clock restarts at the relaunch', readTask(never.id).state, 'queued');
          updateTask(never.id, { queued_at: Date.now() - 3 * 60000 });
          const second = await sweep();
          const neverAfter = readTask(never.id);
          eq('sweep: the second time it is failed', [second.failed.includes(never.id), neverAfter.state, /supervisor/i.test(neverAfter.summary)], [true, 'failed', true]);
          eq('sweep: and not launched again', relaunches.filter((id) => id === never.id).length, 1);

          const copying = createTask({ worker: 'codex', mode: 'write', location: 'copy', project, title: 'copy being made', brief: 'b\n', created_at: Date.now() - 4 * 60000 });
          const abandoned = createTask({ worker: 'codex', mode: 'write', location: 'copy', project, title: 'copy abandoned', brief: 'b\n', created_at: Date.now() - 11 * 60000 });
          const abandonedElsewhere = createTask({ worker: 'codex', mode: 'write', location: 'copy', project: otherProject, title: 'copy abandoned, other project', brief: 'b\n', created_at: Date.now() - 11 * 60000 });
          const third = await sweep();
          eq('sweep: nor is another project\'s abandoned copy task failed from here', [third.failed.includes(abandonedElsewhere.id), readTask(abandonedElsewhere.id).state], [false, 'queued']);
          eq('sweep: a copy task whose copy is not made yet is not launched (a big project takes a while)', [third.relaunched.includes(copying.id), relaunches.includes(copying.id), readTask(copying.id).state], [false, false, 'queued']);
          eq('sweep: one still without its copy after 10 min is failed, not launched', [third.failed.includes(abandoned.id), readTask(abandoned.id).state, /copy/.test(readTask(abandoned.id).summary), relaunches.includes(abandoned.id)], [true, 'failed', true, false]);
        });

        await guardedAsync('sweep: an orphaned worker is killed, and a copy is snapshotted', async () => {
          const repo = makeRepo('git repo sweep', { 'readme.txt': 'hello\n' });
          const grandchildFile = path.join(toolsRoot, 'sweep-grandchild.pid');
          const worker = spawn(process.execPath, [fakeWorkerPath], {
            stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
            env: { ...process.env, FAKE_SCENARIO: 'grandchild', FAKE_GRANDCHILD_FILE: grandchildFile }
          });
          worker.unref();
          const startedAt = Date.now();
          const giveUpAt = Date.now() + 15000;
          while (!fs.existsSync(grandchildFile) && Date.now() < giveUpAt) await sleep(50);
          const grandchildPid = Number(fs.readFileSync(grandchildFile, 'utf8'));
          const task = await finishedCopy(repo, { 'half-done.txt': 'partial\n' });
          const deadPid = await deadPidNow();
          updateTask(task.id, { state: 'running', end_commit: null, started_at: startedAt, worker_pid: worker.pid, supervisor_pid: deadPid, supervisor_beat_at: Date.now() });
          // A second dead task records a pid that now belongs to an unrelated, later process: the same sweep must leave that process alone.
          const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
          const unrelated = createTask({ worker: 'codex', mode: 'write', location: 'here', project: repo, title: 'recycled worker pid', brief: 'b\n' });
          updateTask(unrelated.id, { state: 'running', started_at: Date.now() - 10 * 60000, worker_pid: bystander.pid, supervisor_pid: deadPid, supervisor_beat_at: Date.now() });
          try {
            truthy('sweep: the orphaned worker and its grandchild are running before the sweep', isAlive(worker.pid) && isAlive(grandchildPid));
            await sweepModule.sweepDeadSupervisors({ project: repo, launch: () => 1, env: process.env });
            const killedBy = Date.now() + 15000;
            while ((isAlive(worker.pid) || isAlive(grandchildPid)) && Date.now() < killedBy) await sleep(100);
            eq('sweep: the worker and its grandchild are dead', [isAlive(worker.pid), isAlive(grandchildPid)], [false, false]);
            const after = readTask(task.id);
            eq('sweep: the task is stopped, supervisor-died', [after.state, after.stop_reason], ['stopped', 'supervisor-died']);
            truthy('sweep: the copy was snapshotted: an end commit holds the worker\'s file', /^[0-9a-f]{40}$/.test(after.end_commit ?? '') && gitIn(repo, 'show', `${after.end_commit}:half-done.txt`) === 'partial\n');
            eq('sweep: the task is stopped but a process that is not its worker is not killed', [readTask(unrelated.id).state, isAlive(bystander.pid)], ['stopped', true]);
          } finally {
            for (const pid of [worker.pid, grandchildPid, bystander.pid]) {
              if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone */ } }
            }
          }
        });

        await guardedAsync('sweep: a re-parented chain left by a copy task is killed when the sweep stops the task', async () => {
          if (process.platform !== 'win32') {
            console.log('SKIP sweep re-parented chain: re-parented descendants exist on Windows only');
            return;
          }
          const repo = makeRepo('git repo sweep chain', { 'readme.txt': 'hello\n' });
          const task = await finishedCopy(repo, {});
          const pidFile = path.join(toolsRoot, 'sweep-chain.pid');
          fs.writeFileSync(path.join(task.worktree, 'orphan-marker.js'), "require('fs').writeFileSync(process.env.FAKE_GRANDCHILD_FILE, String(process.pid)); setInterval(() => {}, 1000);\n");
          fs.writeFileSync(path.join(task.worktree, 'launch-dev.cmd'), `@"${process.execPath}" "%~dp0orphan-marker.js"\r\n`);
          const personScript = path.join(task.worktree, 'person-marker.js');
          fs.writeFileSync(personScript, 'setInterval(() => {}, 1000);\n');
          const startedAt = Date.now();
          let person = null;
          let chainPid = 0;
          try {
            execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -WindowStyle Hidden -FilePath cmd -ArgumentList '/c','.\\launch-dev.cmd'"], { cwd: task.worktree, env: { ...process.env, FAKE_GRANDCHILD_FILE: pidFile }, stdio: 'ignore', windowsHide: true });
            person = spawn(process.execPath, [personScript], { stdio: 'ignore', windowsHide: true });
            const giveUpAt = Date.now() + 15000;
            while (!fs.existsSync(pidFile) && Date.now() < giveUpAt) await sleep(50);
            chainPid = Number(fs.readFileSync(pidFile, 'utf8'));
            const deadPid = await deadPidNow();
            updateTask(task.id, { state: 'running', end_commit: null, started_at: startedAt - 1000, worker_pid: deadPid, supervisor_pid: deadPid, supervisor_beat_at: Date.now() });
            truthy('sweep chain: the server is running before the sweep', isAlive(chainPid));
            await sweepModule.sweepDeadSupervisors({ project: repo, launch: () => 1, env: process.env });
            const killedBy = Date.now() + 15000;
            while (isAlive(chainPid) && Date.now() < killedBy) await sleep(100);
            eq('sweep chain: the task is stopped', readTask(task.id).state, 'stopped');
            eq('sweep chain: the server under a live launcher whose parent is dead is killed', isAlive(chainPid), false);
            eq('sweep chain: a process started from an older, living process is not killed', isAlive(person.pid), true);
          } finally {
            for (const pid of [chainPid, person?.pid ?? 0]) {
              if (pid > 0 && isAlive(pid)) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) { /* already gone */ } }
            }
          }
        });

        await guardedAsync('sweep: startup and the heartbeat', async () => {
          const orphanFolder = path.join(dataHome(), 'worktrees', 'abc123');
          fs.mkdirSync(orphanFolder, { recursive: true });
          const repo = makeRepo('git repo startup', { 'readme.txt': 'hello\n' });
          const notRepo = makePlainFolder('plain startup');
          await sweepModule.sweepOnStart({ project: notRepo, launch: () => 1, env: process.env });
          eq('startup: in a folder that is not a git repository the worktrees folder is left alone', fs.existsSync(orphanFolder), true);
          await sweepModule.sweepOnStart({ project: repo, launch: () => 1, env: process.env });
          eq('startup: in a git project an orphaned worktree folder is pruned', fs.existsSync(orphanFolder), false);

          const beatFile = path.join(dataHome(), 'servers', 'instance-hb.json');
          fs.rmSync(beatFile, { force: true });
          const background = sweepModule.startDelegateBackground({ instanceId: 'instance-hb', project: notRepo, launch: () => 1, env: process.env, beatMs: 100, sweepMs: 100000 });
          try {
            eq('heartbeat: the first beat is written at once', fs.existsSync(beatFile), true);
            const firstBeat = fs.statSync(beatFile).mtimeMs;
            await sleep(450);
            truthy('heartbeat: and again on its timer', fs.statSync(beatFile).mtimeMs > firstBeat);
          } finally {
            background.stop();
          }
          const stoppedAt = fs.statSync(beatFile).mtimeMs;
          await sleep(350);
          eq('heartbeat: stop() ends it', fs.statSync(beatFile).mtimeMs, stoppedAt);
          const unrefd = sweepModule.startDelegateBackground({ instanceId: 'instance-hb2', project: notRepo, launch: () => 1, env: process.env, sweeps: false });
          truthy('heartbeat: the timers do not keep the process alive', unrefd.timers.every((timer) => timer.hasRef() === false));
          unrefd.stop();
          const strandedPid = await deadPidNow();
          const stranded = createTask({ worker: 'codex', mode: 'read', location: 'here', project: notRepo, title: 'stranded', brief: 'b\n' });
          updateTask(stranded.id, { state: 'running', started_at: Date.now(), supervisor_pid: strandedPid, supervisor_beat_at: Date.now() });
          const heartbeatOnly = sweepModule.startDelegateBackground({ instanceId: 'instance-hb3', project: notRepo, launch: () => 1, env: process.env, sweeps: false });
          await sleep(300);
          heartbeatOnly.stop();
          eq('startup: with sweeps off only the heartbeat runs (a task with no supervisor is left)', [fs.existsSync(path.join(dataHome(), 'servers', 'instance-hb3.json')), readTask(stranded.id).state], [true, 'running']);
          const sweepingBackground = sweepModule.startDelegateBackground({ instanceId: 'instance-hb4', project: notRepo, launch: () => 1, env: process.env });
          const settledBy = Date.now() + 15000;
          while (readTask(stranded.id).state === 'running' && Date.now() < settledBy) await sleep(100);
          sweepingBackground.stop();
          eq('startup: with sweeps on the same task is settled at once', readTask(stranded.id).stop_reason, 'supervisor-died');
          const guardedSweep = await sweepModule.sweepOnStart({ project: path.join(toolsRoot, 'does not exist'), launch: () => 1, env: process.env }).then(() => 'ok', () => 'threw');
          eq('startup: a sweep that fails does not throw', guardedSweep, 'ok');
        });

        await guardedAsync('sweep: a restarted server adopts its session\'s running tasks', async () => {
          const project = makePlainFolder('plain adoption');
          const serversFolder = path.join(dataHome(), 'servers');
          fs.mkdirSync(serversFolder, { recursive: true });
          const agedBeat = (instanceId, ageMs) => {
            const file = path.join(serversFolder, `${instanceId}.json`);
            fs.writeFileSync(file, '{}');
            const at = new Date(Date.now() - ageMs);
            fs.utimesSync(file, at, at);
          };
          agedBeat('instance-adopt-a', 5 * 60000);
          const makeOwned = (title, session, instance, state = 'running', taskProject = project) => {
            const task = createTask({ worker: 'codex', mode: 'write', location: 'here', project: taskProject, title, brief: 'b\n', owner_session: session, owner_instance: instance });
            updateTask(task.id, { state, started_at: Date.now(), supervisor_pid: process.pid, supervisor_beat_at: Date.now() });
            return task.id;
          };
          const mine = makeOwned('adopt mine', 'session-S', 'instance-adopt-a');
          const mineQueued = makeOwned('adopt mine queued', 'session-S', 'instance-adopt-a', 'queued');
          const orphanless = makeOwned('adopt no owner instance', 'session-S', null);
          const otherSession = makeOwned('adopt other session', 'session-T', 'instance-adopt-a');
          const otherProject = makeOwned('adopt other project', 'session-S', 'instance-adopt-a', 'running', makePlainFolder('plain adoption elsewhere'));
          const finished = makeOwned('adopt finished', 'session-S', 'instance-adopt-a', 'done');
          beat('instance-adopt-live');
          const ownedByLive = makeOwned('adopt live owner', 'session-S', 'instance-adopt-live');
          eq('adoption: before it, the old owner counts as gone', storeNamespace.isAlive('instance-adopt-a'), false);
          const adopted = sweepModule.adoptOwnTasks({ instanceId: 'instance-adopt-b', sessionId: 'session-S', project });
          eq('adoption: the session\'s running and queued tasks of this project, whose owner is gone or unknown, are taken over', adopted.sort(), [mine, mineQueued, orphanless].sort());
          eq('adoption: owner_instance is now this server', [readTask(mine).owner_instance, readTask(mineQueued).owner_instance, readTask(orphanless).owner_instance], ['instance-adopt-b', 'instance-adopt-b', 'instance-adopt-b']);
          eq('adoption: a task of another session is not adopted', readTask(otherSession).owner_instance, 'instance-adopt-a');
          eq('adoption: a task of another project is not adopted', readTask(otherProject).owner_instance, 'instance-adopt-a');
          eq('adoption: a finished task is not adopted', readTask(finished).owner_instance, 'instance-adopt-a');
          eq('adoption: a task whose owner is alive is not adopted', readTask(ownedByLive).owner_instance, 'instance-adopt-live');
          eq('adoption: without a session id nothing is adopted', sweepModule.adoptOwnTasks({ instanceId: 'instance-adopt-b', sessionId: null, project }), []);
          eq('adoption: a second pass has nothing left to do', sweepModule.adoptOwnTasks({ instanceId: 'instance-adopt-b', sessionId: 'session-S', project }), []);

          // The heartbeat does it: the new server beats, adopts, and the old owner's stale beat no longer matters.
          const later = makeOwned('adopt by the heartbeat', 'session-S', 'instance-adopt-a');
          const background = sweepModule.startDelegateBackground({ instanceId: 'instance-adopt-c', sessionId: 'session-S', project, launch: () => 1, env: process.env, beatMs: 100000, sweeps: false });
          try {
            eq('adoption: the first beat adopts', readTask(later).owner_instance, 'instance-adopt-c');
            truthy('adoption: and the task\'s owner is alive, so its supervisor keeps it running', storeNamespace.isAlive(readTask(later).owner_instance));
          } finally {
            background.stop();
          }
          for (const id of [mine, mineQueued, orphanless, otherSession, otherProject, ownedByLive, later]) updateTask(id, { state: 'done' });
        });

        await guardedAsync('sweep: adoption picks its candidates from the index and falls back to every task without one', async () => {
          const project = makePlainFolder('plain adoption index');
          const indexFile = path.join(dataHome(), 'index.json');
          const makeStale = (title) => {
            const task = createTask({ worker: 'codex', mode: 'write', location: 'here', project, title, brief: 'b\n', owner_session: 'session-I', owner_instance: 'instance-index-old' });
            updateTask(task.id, { state: 'running', started_at: Date.now(), supervisor_pid: process.pid, supervisor_beat_at: Date.now() });
            return task.id;
          };
          const adoptNow = () => sweepModule.adoptOwnTasks({ instanceId: 'instance-index-new', sessionId: 'session-I', project });
          const resetOwner = (ids) => { for (const id of ids) updateTask(id, { owner_instance: 'instance-index-old' }); };

          const inIndex = makeStale('index lists it');
          const missingFromIndex = makeStale('index lacks it');
          const changedSince = makeStale('index is out of date');
          const validIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
          const staleRows = [];
          for (const row of validIndex.tasks) {
            if (row.id !== missingFromIndex) staleRows.push(row);
          }
          updateTask(changedSince, { owner_session: 'session-other' });
          // Written after the change: the index still shows the old session for this task.
          const rowsBeforeChange = [];
          for (const row of staleRows) rowsBeforeChange.push(row.id === changedSince ? { ...row, owner_session: 'session-I' } : row);
          fs.writeFileSync(indexFile, JSON.stringify({ updated_at: Date.now(), tasks: rowsBeforeChange }));
          eq('adoption by index: only a task the index lists and the task file confirms is adopted', adoptNow(), [inIndex]);
          eq('adoption by index: a task missing from a valid index is not looked at', readTask(missingFromIndex).owner_instance, 'instance-index-old');
          eq('adoption by index: a row the task file contradicts is left alone', readTask(changedSince).owner_instance, 'instance-index-old');

          updateTask(changedSince, { owner_session: 'session-I' });
          resetOwner([inIndex]);
          const fallbacks = [
            ['absent', () => fs.rmSync(indexFile, { force: true })],
            ['not JSON', () => fs.writeFileSync(indexFile, 'not json {')],
            ['tasks not an array', () => fs.writeFileSync(indexFile, JSON.stringify({ tasks: 5 }))],
            ['not an object', () => fs.writeFileSync(indexFile, '7')]
          ];
          for (const [label, breakIndex] of fallbacks) {
            resetOwner([inIndex, missingFromIndex, changedSince]);
            breakIndex();
            eq(`adoption by index: an index that is ${label} falls back to reading every task`, adoptNow().sort(), [inIndex, missingFromIndex, changedSince].sort());
          }
          for (const id of [inIndex, missingFromIndex, changedSince]) updateTask(id, { state: 'done' });
        });

        await guardedAsync('sweep: stale heartbeat files', async () => {
          const serversFolder = path.join(dataHome(), 'servers');
          fs.mkdirSync(serversFolder, { recursive: true });
          const DAY_MS = 24 * 3600000;
          const writeBeat = (name, ageMs) => {
            const file = path.join(serversFolder, name);
            fs.writeFileSync(file, '{}');
            const at = new Date(Date.now() - ageMs);
            fs.utimesSync(file, at, at);
            return file;
          };
          const old = writeBeat('instance-old.json', DAY_MS + 60000);
          const recent = writeBeat('instance-recent.json', DAY_MS - 3600000);
          const own = writeBeat('instance-own.json', 3 * DAY_MS);
          const notABeat = writeBeat('notes.txt', 3 * DAY_MS);
          const removed = sweepModule.sweepStaleHeartbeats({ ownInstanceId: 'instance-own' });
          eq('stale heartbeats: a file older than a day goes', fs.existsSync(old), false);
          eq('stale heartbeats: a younger one stays', fs.existsSync(recent), true);
          eq('stale heartbeats: this server\'s own file stays however old', fs.existsSync(own), true);
          eq('stale heartbeats: only .json files are looked at', fs.existsSync(notABeat), true);
          eq('stale heartbeats: it says what it removed', removed, ['instance-old.json']);
          eq('stale heartbeats: a folder that is missing is no trouble', sweepModule.sweepStaleHeartbeats({ ownInstanceId: 'x', now: Date.now(), folder: path.join(serversFolder, 'nope') }), []);

          // The minute sweep does it: a timer here is short, and the server's own beat stays.
          const second = writeBeat('instance-old2.json', 2 * DAY_MS);
          const background = sweepModule.startDelegateBackground({ instanceId: 'instance-own2', project: makePlainFolder('plain stale beats'), launch: () => 1, env: process.env, beatMs: 100000, sweepMs: 100 });
          try {
            const own2 = path.join(serversFolder, 'instance-own2.json');
            const aged = new Date(Date.now() - 3 * DAY_MS);
            fs.utimesSync(own2, aged, aged);
            const goneBy = Date.now() + 5000;
            while (fs.existsSync(second) && Date.now() < goneBy) await sleep(50);
            eq('stale heartbeats: the periodic sweep removes an old file', fs.existsSync(second), false);
            eq('stale heartbeats: and never the running server\'s own', fs.existsSync(own2), true);
          } finally {
            background.stop();
          }
        });

        await guardedAsync('supervisor: summaryLine prefers prose to a heading', async () => {
          const summaryLine = supervisorModule.summaryLine;
          eq('summaryLine: a heading then a sentence gives the sentence', summaryLine('# Repository Summary (delegate-live)\n\nThe repo is a two-page static site.\nMore.'), 'The repo is a two-page static site.');
          eq('summaryLine: a heading alone gives the heading', summaryLine('## Done\n'), 'Done');
          eq('summaryLine: a bold line by itself is a heading too', summaryLine('**Summary**\n\nAdded the footer.'), 'Added the footer.');
          eq('summaryLine: a rule is skipped', summaryLine('---\nAdded the footer.'), 'Added the footer.');
          eq('summaryLine: a bullet loses its mark', summaryLine('# Result\n- Changed two files.'), 'Changed two files.');
          for (const rule of ['***', '___', '* * *', '- - -', '_ _ _', '=====', '*****']) {
            eq(`summaryLine: the rule ${JSON.stringify(rule)} is skipped`, summaryLine(`${rule}\nAdded the footer.`), 'Added the footer.');
          }
          eq('summaryLine: a rule after a heading is skipped too', summaryLine('# Result\n***\nDid it.'), 'Did it.');
          eq('summaryLine: a rule alone gives null', summaryLine('***\n___\n'), null);
          eq('summaryLine: nothing to say gives null', summaryLine('\n  \n'), null);
          eq('summaryLine: a bold word inside prose is not a heading', summaryLine('**Done** the work.'), 'Done the work.');
        });
      }
    } finally {
      // Whatever a failed test left running must not outlive it.
      const giveUpAt = Date.now() + 15000;
      while (realLaunchedPids.some(isAlive) && Date.now() < giveUpAt) await sleep(100);
      for (const pid of realLaunchedPids) {
        if (isAlive(pid)) { console.log(`FAIL supervisor ${pid} was still running`); failed++; try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } }
      }
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
    const leftovers = (() => {
      try {
        if (process.platform === 'win32') {
          const script = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match '^(node|cmd)\\.exe$' -and $_.CommandLine -and ($_.CommandLine -like '*fake-worker.js*' -or $_.CommandLine -like '*consult-fake-grandchild*') } | ForEach-Object { $_.ProcessId }";
          return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).split(/\s+/).filter(Boolean);
        }
        const found = [];
        for (const row of execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n')) {
          if (/\bnode\b.*(fake-worker\.js|consult-fake-grandchild)/.test(row)) found.push(row.trim().split(/\s+/)[0]);
        }
        return found.filter((pid) => pid !== String(process.pid));
      } catch (_) {
        return [];
      }
    })();
    eq('tools: no fake worker or grandchild process is left running', leftovers, []);
  }

  // ---- Task 11: hooks/scripts/delegate.js, the pane's door to delegate ----
  // The script is spawned the way the pane spawns it: its own node process, one
  // JSON object on stdout. Own data folder, projects file, codex home and user
  // home; never the person's.
  {
    const doorRoot = path.join(scratch, 'door Имя root');
    const doorHome = path.join(doorRoot, 'user home');
    const doorCodexHome = path.join(doorRoot, 'codex');
    const doorProjectsFile = path.join(doorRoot, 'consult-projects.json');
    const globalSettingsPath = path.join(doorHome, '.claude', 'consult.local.md');
    const doorScript = fileURLToPath(new URL('../hooks/scripts/delegate.js', import.meta.url));
    const previousEnv = {};
    for (const name of ['CONSULT_DELEGATE_HOME', 'CONSULT_PROJECTS_FILE', 'CODEX_HOME']) previousEnv[name] = process.env[name];
    process.env.CONSULT_PROJECTS_FILE = doorProjectsFile;
    process.env.CODEX_HOME = doorCodexHome;
    fs.mkdirSync(path.dirname(globalSettingsPath), { recursive: true });
    fs.mkdirSync(doorCodexHome, { recursive: true });

    let sectionCount = 0;
    const doorSection = async (label, body) => {
      const sectionHome = path.join(doorRoot, `data ${++sectionCount}`);
      fs.mkdirSync(sectionHome, { recursive: true });
      process.env.CONSULT_DELEGATE_HOME = sectionHome;
      fs.rmSync(doorProjectsFile, { force: true });
      fs.rmSync(globalSettingsPath, { force: true });
      fs.rmSync(`${globalSettingsPath}.bak`, { force: true });
      try {
        await body();
      } catch (error) {
        console.log(`FAIL ${label} threw: ${error.stack}`);
        failed++;
      }
    };
    const runDoor = (project, ...args) => new Promise((resolve) => {
      const env = { ...process.env, HOME: doorHome, USERPROFILE: doorHome };
      execFile(process.execPath, [doorScript, project, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 60000 }, (error, stdout, stderr) => {
        let json;
        try { json = JSON.parse(stdout); } catch (_) { json = { unparsed: stdout, stderr }; }
        resolve({ code: error ? error.code : 0, stdout, stderr, json });
      });
    });
    const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const makePlain = (name) => {
      const folder = path.join(doorRoot, name);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'readme.txt'), 'hello\n');
      return folder;
    };
    const makeRepo = (name) => {
      const repo = makePlain(name);
      gitIn(repo, 'init');
      gitIn(repo, 'add', '-A');
      gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'first');
      return repo;
    };
    const addTask = (project, overrides = {}, changes = {}) => {
      const task = createTask({ worker: 'codex', title: 'a task', project, mode: 'write', location: 'here', brief: 'b\n', ...overrides });
      return updateTask(task.id, changes);
    };
    // This process stands in for a supervisor that beat just now.
    const liveSupervisor = () => ({ supervisor_pid: process.pid, supervisor_beat_at: Date.now() });
    const indexIds = () => JSON.parse(fs.readFileSync(path.join(dataHome(), 'index.json'), 'utf8')).tasks.map((row) => row.id);
    const hasCancelFile = (id) => fs.existsSync(path.join(taskFolder(id), 'cancel'));
    const oneJsonObject = (result) => result.stdout.trimEnd().split('\n').length === 1 && result.json !== null && typeof result.json === 'object' && !Array.isArray(result.json);

    try {
      // ---- show ----
      await doorSection('door: show', async () => {
        const projectA = makePlain('door project a');
        const projectB = makePlain('door project b');
        const projectC = makePlain('door project c');
        const now = Date.now();
        const running = addTask(projectA, { title: 'About page', location: 'copy', created_at: now - 3000 }, { state: 'running', started_at: now - 5000, fenced: true, summary: null });
        const done = addTask(projectA, { title: 'review CSS', worker: 'agy', mode: 'read', created_at: now - 2000 }, { state: 'done', started_at: 1000, ended_at: 61000, summary: 'Reviewed the CSS.', reported_at: 70000, fenced: false });
        const queued = addTask(projectA, { title: 'unit tests', worker: 'local', keep_running: true, hold: true, queue_model: 'qwen', created_at: now - 1000 });
        const merged = addTask(projectA, { title: 'Contact page', location: 'copy', created_at: now - 4000 }, { state: 'merged', reported_at: 70000, merge_result: { applied: ['a.html', 'b.css', 'c.js'], conflicts: [], skipped: [], held: [], task_copies: [] } });
        const conflicted = addTask(projectA, { title: 'fix auth test', location: 'copy', created_at: now - 4500 }, { state: 'conflict', reported_at: 70000, merge_result: { applied: ['x.js'], conflicts: ['src/auth.ts', 'src/b.ts'], skipped: [], held: [], task_copies: [] } });
        const otherRunning = addTask(projectB, {}, { state: 'running' });
        const otherQueued = addTask(projectB, {}, {});
        addTask(projectB, {}, { state: 'done', reported_at: null });
        addTask(projectB, {}, { state: 'done', reported_at: 5 });
        addTask(projectB, {}, { state: 'merged', reported_at: null });
        addTask(projectB, {}, { state: 'cancelled', reported_at: null });
        addTask(projectB, {}, { state: 'conflict', reported_at: null });
        addTask(projectB, {}, { state: 'conflict', reported_at: 5 }); // the merge that left it reported it
        addTask(projectC, {}, { state: 'merged' });

        const shown = await runDoor(projectA, 'show');
        eq('door show: exit 0, one JSON object, no error', [shown.code, oneJsonObject(shown), shown.json.error], [0, true, undefined]);
        eq('door show: this project\'s rows, newest first', shown.json.rows?.map((row) => row.id), [queued.id, done.id, running.id, merged.id, conflicted.id]);
        const mergedRow = shown.json.rows?.find((row) => row.id === merged.id) ?? {};
        const conflictRow = shown.json.rows?.find((row) => row.id === conflicted.id) ?? {};
        eq('door show: a merged row counts the files applied, a conflict row names its first file', [mergedRow.merged_files, mergedRow.first_conflict, conflictRow.first_conflict], [3, null, 'src/auth.ts']);
        eq('door show: a row with no merge has neither', [shown.json.rows?.find((row) => row.id === running.id)?.merged_files, shown.json.rows?.find((row) => row.id === running.id)?.first_conflict], [null, null]);
        const doneRow = shown.json.rows?.find((row) => row.id === done.id) ?? {};
        eq('door show: a row carries what the tab needs', {
          worker: doneRow.worker, title: doneRow.title, state: doneRow.state, mode: doneRow.mode, location: doneRow.location, fenced: doneRow.fenced,
          summary: doneRow.summary, reported_at: doneRow.reported_at, keep_running: doneRow.keep_running, hold: doneRow.hold, elapsed_ms: doneRow.elapsed_ms
        }, { worker: 'agy', title: 'review CSS', state: 'done', mode: 'read', location: 'here', fenced: false, summary: 'Reviewed the CSS.', reported_at: 70000, keep_running: false, hold: false, elapsed_ms: 60000 });
        eq('door show: a row with no final.md has no report_path', [doneRow.report_path, shown.json.rows?.find((row) => row.id === running.id)?.report_path], [null, null]);
        const reportFile = path.join(taskFolder(done.id), 'final.md');
        fs.writeFileSync(reportFile, '## Summary\nReviewed.\n');
        const reported = await runDoor(projectA, 'show');
        eq('door show: once final.md exists the row names it as report_path', reported.json.rows?.find((row) => row.id === done.id)?.report_path, reportFile);
        // The paths come from the id, the data folder and the project: nothing in state.json is one.
        const evil = path.join(doorRoot, 'evil.bat');
        fs.writeFileSync(evil, 'echo hi\n');
        const elsewhereNote = path.join(doorRoot, 'notes.md');
        fs.writeFileSync(elsewhereNote, 'x\n');
        updateTask(done.id, { final_path: elsewhereNote, log_path: evil, worktree: evil, project: projectA });
        const crafted = (await runDoor(projectA, 'show')).json.rows?.find((row) => row.id === done.id) ?? {};
        eq('door show: a crafted final_path, log_path and worktree change no path', [crafted.report_path, crafted.log_path, crafted.folder], [reportFile, null, projectA]);
        const logFile = path.join(taskFolder(done.id), 'log.jsonl');
        fs.writeFileSync(logFile, '{}\n');
        eq('door show: the log is the task folder\'s log.jsonl once it exists', (await runDoor(projectA, 'show')).json.rows?.find((row) => row.id === done.id)?.log_path, logFile);
        fs.rmSync(reportFile);
        eq('door show: with final.md gone there is no report, whatever final_path says', (await runDoor(projectA, 'show')).json.rows?.find((row) => row.id === done.id)?.report_path, null);
        updateTask(running.id, { worktree: evil });
        eq('door show: a copy task whose worktree folder does not exist shows the project', (await runDoor(projectA, 'show')).json.rows?.find((row) => row.id === running.id)?.folder, projectA);
        const copyFolder = path.join(dataHome(), 'worktrees', running.id);
        fs.mkdirSync(copyFolder, { recursive: true });
        eq('door show: a copy task shows <data>/worktrees/<id> once that folder exists, not the recorded worktree', (await runDoor(projectA, 'show')).json.rows?.find((row) => row.id === running.id)?.folder, copyFolder);
        fs.rmSync(copyFolder, { recursive: true, force: true });
        updateTask(running.id, { worktree: null });
        // A state.json whose id is not its folder's name is not a task: it cannot stand in for another.
        const forger = addTask(projectA, { title: 'forger', created_at: now - 100 });
        const forgerFile = path.join(taskFolder(forger.id), 'state.json');
        const forgerState = JSON.parse(fs.readFileSync(forgerFile, 'utf8'));
        fs.writeFileSync(forgerFile, JSON.stringify({ ...forgerState, id: merged.id }));
        const forged = await runDoor(projectA, 'show');
        eq('door show: a state whose id is another task\'s is not listed, and the other task is listed once', [forged.json.rows?.some((row) => row.title === 'forger'), forged.json.rows?.filter((row) => row.id === merged.id).length], [false, 1]);
        eq('readTask: a state whose id differs from its folder is no task', [readTask(forger.id), readTask(merged.id)?.title], [null, 'Contact page']);
        eq('listTasks leaves it out', listTasks().some((row) => row.title === 'forger'), false);
        const clearForged = await runDoor(projectA, 'clear', merged.id === forger.id ? 'x' : forger.id, JSON.stringify({ discard: true }));
        eq('door clear by the forger\'s folder name reaches no task', [typeof clearForged.json.error, readTask(merged.id)?.state], ['string', 'merged']);
        fs.rmSync(taskFolder(forger.id), { recursive: true, force: true });
        const queuedRow = shown.json.rows?.find((row) => row.id === queued.id) ?? {};
        eq('door show: a queued row has no elapsed time; keep_running, hold and the queue model show', [queuedRow.elapsed_ms, queuedRow.keep_running, queuedRow.hold, queuedRow.queue_model], [null, true, true, 'qwen']);
        const runningRow = shown.json.rows?.find((row) => row.id === running.id) ?? {};
        truthy('door show: a running row\'s elapsed time counts from its start', runningRow.elapsed_ms >= 5000 && runningRow.elapsed_ms < 120000);
        eq('door show: other projects are only counts (finished and not yet reported, running)', shown.json.elsewhere, [{ project: projectB, finished: 2, running: 2 }]);
        const { local_slots: defaultSlots, ...defaultSettings } = shown.json.settings;
        eq('door show: the defaults', defaultSettings, {
          workers_edit: 'auto', table: { code: 'codex', research_review: 'agy', private: 'local' }, local_at_once: 'auto', on_close: 'stop', time_limit_min: 180
        });
        truthy('door show: with local_at_once auto, local_slots is what auto comes to now (a whole number, at least 1)', Number.isInteger(defaultSlots) && defaultSlots >= 1);
        eq('door show: usage limits start out ok for every worker', ['codex', 'agy', 'local'].map((worker) => [worker, shown.json.limits?.[worker]?.level, shown.json.limits?.[worker]?.note]), [['codex', 'ok', ''], ['agy', 'ok', ''], ['local', 'ok', '']]);
        eq('door show: a folder with no git', shown.json.git, { isRepo: false, declined: false, setupAllowed: true });
        truthy('door show: never mentions the other projects\' task ids in its rows', !JSON.stringify(shown.json.rows).includes(otherRunning.id) && !JSON.stringify(shown.json.rows).includes(otherQueued.id));

        const repo = makeRepo('door show repo');
        const inRepo = await runDoor(repo, 'show');
        eq('door show: a repo', [inRepo.json.git?.isRepo, inRepo.json.git?.declined, inRepo.json.rows, inRepo.json.elsewhere?.length], [true, false, [], 2]);
        const insideRepo = path.join(repo, 'sub');
        fs.mkdirSync(insideRepo);
        eq('door show: a folder inside a repo is never offered git setup', (await runDoor(insideRepo, 'show')).json.git, { isRepo: true, declined: false, setupAllowed: false });

        recordLimit('codex', { primary: { used_percent: 92, window_minutes: 300, resets_at: Math.floor((Date.now() + 3600000) / 1000) } }, Date.now());
        recordLimitHit('agy', { resets_at: Date.now() + 3600000 }, Date.now());
        const limited = await runDoor(projectA, 'show');
        eq('door show: the limits level and note per worker', [limited.json.limits?.codex?.level, limited.json.limits?.agy?.level, limited.json.limits?.local?.level], ['warn', 'full', 'ok']);
        truthy('door show: a limit note says what is used', /92%/.test(limited.json.limits?.codex?.note ?? ''));
        truthy('door show: the codex windows come along', Array.isArray(limited.json.limits?.codex?.windows) && limited.json.limits.codex.windows.length === 1);

        fs.writeFileSync(globalSettingsPath, '---\ndelegate.research: codex\ndelegate.review: agy\ndelegate.private: agy\ndelegate.on_close: keep\ndelegate.time_limit_min: 45\ndelegate.local_at_once: 2\n---\n');
        saveProjectSettings(projectA, { workers_edit: 'copy', git: 'declined' });
        const configured = await runDoor(projectA, 'show');
        eq('door show: the saved settings, research and review differing show as mixed', configured.json.settings, {
          workers_edit: 'copy', table: { code: 'codex', research_review: 'mixed', private: 'agy' }, local_at_once: 2, on_close: 'keep', time_limit_min: 45, local_slots: null
        });
        eq('door show: git declined', configured.json.git?.declined, true);
        fs.writeFileSync(globalSettingsPath, '---\ndelegate.research: local\ndelegate.review: local\n---\n');
        eq('door show: research and review the same show as that value', (await runDoor(projectA, 'show')).json.settings?.table?.research_review, 'local');
      });

      // ---- cancel and stop-all ----
      await doorSection('door: cancel and stop-all', async () => {
        const projectA = makePlain('door cancel a');
        const projectB = makePlain('door cancel b');
        const running = addTask(projectA, {}, { state: 'running', ...liveSupervisor() });
        const liveQueued = addTask(projectA, {}, liveSupervisor());
        const deadQueued = addTask(projectA, {}, {});
        const done = addTask(projectA, {}, { state: 'done' });
        const cancelRunning = await runDoor(projectA, 'cancel', running.id);
        eq('door cancel: a running task gets its cancel file, its state is the supervisor\'s to change', [cancelRunning.json.error, cancelRunning.json.cancelling, hasCancelFile(running.id), readTask(running.id).state], [undefined, true, true, 'running']);
        const cancelLive = await runDoor(projectA, 'cancel', liveQueued.id);
        eq('door cancel: a queued task under a live supervisor gets the cancel file', [cancelLive.json.error, hasCancelFile(liveQueued.id), readTask(liveQueued.id).state], [undefined, true, 'queued']);
        const cancelDead = await runDoor(projectA, 'cancel', deadQueued.id);
        const afterDead = readTask(deadQueued.id);
        eq('door cancel: a queued task nobody runs is cancelled at once', [cancelDead.json.error, afterDead.state, typeof afterDead.ended_at, hasCancelFile(deadQueued.id)], [undefined, 'cancelled', 'number', false]);
        const cancelDone = await runDoor(projectA, 'cancel', done.id);
        eq('door cancel: a finished task is refused', [typeof cancelDone.json.error, cancelDone.code, readTask(done.id).state, hasCancelFile(done.id)], ['string', 0, 'done', false]);
        eq('door cancel: an unknown id is an error', typeof (await runDoor(projectA, 'cancel', 'ffffff')).json.error, 'string');
        eq('door cancel: no id is an error', typeof (await runDoor(projectA, 'cancel')).json.error, 'string');
        const elsewhere = addTask(projectB, {}, { state: 'running', ...liveSupervisor() });
        const cancelElsewhere = await runDoor(projectA, 'cancel', elsewhere.id);
        eq('door cancel: stopping works for a task of another project too', [cancelElsewhere.json.error, hasCancelFile(elsewhere.id)], [undefined, true]);

        fs.rmSync(path.join(taskFolder(running.id), 'cancel'));
        fs.rmSync(path.join(taskFolder(liveQueued.id), 'cancel'));
        fs.rmSync(path.join(taskFolder(elsewhere.id), 'cancel'));
        const queuedElsewhere = addTask(projectB, {}, {});
        const failedTask = addTask(projectB, {}, { state: 'failed' });
        const stoppedAll = await runDoor(projectA, 'stop-all');
        eq('door stop-all: the ids of every queued and running task, in every project', [stoppedAll.json.error, [...(stoppedAll.json.stopped ?? [])].sort()], [undefined, [running.id, liveQueued.id, elsewhere.id, queuedElsewhere.id].sort()]);
        eq('door stop-all: running and live ones get the cancel file; a queued one nobody runs is cancelled', [hasCancelFile(running.id), hasCancelFile(liveQueued.id), hasCancelFile(elsewhere.id), readTask(queuedElsewhere.id).state], [true, true, true, 'cancelled']);
        eq('door stop-all: finished tasks are left alone', [readTask(done.id).state, readTask(failedTask.id).state, readTask(deadQueued.id).state], ['done', 'failed', 'cancelled']);
        eq('door stop-all: asked again, it asks the three that are still running again, not the ended ones', (await runDoor(projectA, 'stop-all')).json.stopped?.length, 3);
      });

      // ---- clear ----
      await doorSection('door: clear', async () => {
        const projectA = makePlain('door clear a');
        const projectB = makePlain('door clear b');
        for (const state of ['queued', 'running']) {
          const active = addTask(projectA, {}, state === 'running' ? { state } : {});
          const refused = await runDoor(projectA, 'clear', active.id);
          truthy(`door clear: a ${state} task is refused and says to cancel it`, typeof refused.json.error === 'string' && /cancel/i.test(refused.json.error) && fs.existsSync(taskFolder(active.id)));
        }
        for (const state of ['done', 'held', 'conflict', 'paused-limit']) {
          const unfinished = addTask(projectA, {}, { state, reported_at: 123 });
          const refused = await runDoor(projectA, 'clear', unfinished.id);
          truthy(`door clear: a ${state} write task is refused: its work is not merged`, typeof refused.json.error === 'string' && /merge it, or clear it with discard to throw its changes away/.test(refused.json.error) && fs.existsSync(taskFolder(unfinished.id)) && readTask(unfinished.id).state === state);
        }
        const readNotReported = addTask(projectA, { mode: 'read', worker: 'agy' }, { state: 'done', reported_at: null });
        eq('door clear: a read-only answer nobody has read yet is refused', [typeof (await runDoor(projectA, 'clear', readNotReported.id)).json.error, fs.existsSync(taskFolder(readNotReported.id))], ['string', true]);
        const readReported = addTask(projectA, { mode: 'read', worker: 'agy' }, { state: 'done', reported_at: 123 });
        const clearedRead = await runDoor(projectA, 'clear', readReported.id);
        eq('door clear: a read-only answer that was reported can go', [clearedRead.json.error, clearedRead.json.cleared, fs.existsSync(taskFolder(readReported.id))], [undefined, readReported.id, false]);
        for (const state of ['held', 'paused-limit']) {
          const readUnreported = addTask(projectA, { mode: 'read', worker: 'agy' }, { state, reported_at: null });
          eq(`door clear: a read-only ${state} task nobody has read is refused`, [typeof (await runDoor(projectA, 'clear', readUnreported.id)).json.error, fs.existsSync(taskFolder(readUnreported.id))], ['string', true]);
          const thrownAway = await runDoor(projectA, 'clear', readUnreported.id, '{"discard":true}');
          eq(`door clear: a read-only ${state} task goes with discard`, [thrownAway.json.error, thrownAway.json.cleared, fs.existsSync(taskFolder(readUnreported.id))], [undefined, readUnreported.id, false]);
          const readSeen = addTask(projectA, { mode: 'read', worker: 'agy' }, { state, reported_at: 123 });
          const clearedSeen = await runDoor(projectA, 'clear', readSeen.id);
          eq(`door clear: a read-only ${state} task that was reported goes plainly`, [clearedSeen.json.error, clearedSeen.json.cleared, fs.existsSync(taskFolder(readSeen.id))], [undefined, readSeen.id, false]);
        }

        for (const state of ['merged', 'cancelled', 'failed', 'stopped']) {
          const finished = addTask(projectA, {}, { state });
          const cleared = await runDoor(projectA, 'clear', finished.id);
          eq(`door clear: a ${state} task goes: its folder and its row`, [cleared.code, cleared.json.error, cleared.json.cleared, fs.existsSync(taskFolder(finished.id)), indexIds().includes(finished.id)], [0, undefined, finished.id, false, false]);
        }
        const elsewhere = addTask(projectB, {}, { state: 'failed' });
        const refusedElsewhere = await runDoor(projectA, 'clear', elsewhere.id);
        eq('door clear: a task of another project is refused and left alone', [typeof refusedElsewhere.json.error, fs.existsSync(taskFolder(elsewhere.id)), readTask(elsewhere.id).state], ['string', true, 'failed']);
        eq('door clear: an unknown id is an error', typeof (await runDoor(projectA, 'clear', 'ffffff')).json.error, 'string');
        eq('door clear: a path is not an id', typeof (await runDoor(projectA, 'clear', '..')).json.error, 'string');

        // discard: the user chose to throw unmerged work away (the tab asks first)
        for (const state of ['done', 'held', 'conflict', 'paused-limit']) {
          const unfinished = addTask(projectA, {}, { state, reported_at: null });
          const discarded = await runDoor(projectA, 'clear', unfinished.id, '{"discard":true}');
          eq(`door clear: a ${state} task goes with discard`, [discarded.json.error, discarded.json.cleared, fs.existsSync(taskFolder(unfinished.id)), indexIds().includes(unfinished.id)], [undefined, unfinished.id, false, false]);
        }
        const stillGoing = addTask(projectA, {}, { state: 'running' });
        const refusedGoing = await runDoor(projectA, 'clear', stillGoing.id, '{"discard":true}');
        eq('door clear: discard does not clear a running task', [/cancel/i.test(refusedGoing.json.error ?? ''), fs.existsSync(taskFolder(stillGoing.id))], [true, true]);
        const otherDone = addTask(projectB, {}, { state: 'done' });
        const refusedOther = await runDoor(projectA, 'clear', otherDone.id, '{"discard":true}');
        eq('door clear: discard does not reach another project\'s task', [typeof refusedOther.json.error, fs.existsSync(taskFolder(otherDone.id))], ['string', true]);
        const withoutFlag = addTask(projectA, {}, { state: 'done' });
        const notTrue = await runDoor(projectA, 'clear', withoutFlag.id, '{"discard":"yes"}');
        eq('door clear: only discard: true counts', [typeof notTrue.json.error, fs.existsSync(taskFolder(withoutFlag.id))], ['string', true]);
        eq('door clear: a bad second argument is an error', [typeof (await runDoor(projectA, 'clear', withoutFlag.id, 'nope')).json.error, fs.existsSync(taskFolder(withoutFlag.id))], ['string', true]);
      });

      await doorSection('door: clear when the project is no longer a git repository', async () => {
        const repo = makeRepo('door clear gone repo');
        const task = addTask(repo, { location: 'copy' }, {});
        const copy = await makeCopy(repo, task.id);
        updateTask(task.id, { worktree: copy.worktree, branch: copy.branch, start_commit: copy.start_commit, state: 'failed' });
        fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
        const cleared = await runDoor(repo, 'clear', task.id);
        eq('door clear: a project that is no longer a repo still lets the task go', [cleared.json.error, cleared.json.cleared, fs.existsSync(copy.worktree), fs.existsSync(taskFolder(task.id)), indexIds().includes(task.id)], [undefined, task.id, false, false, false]);
        truthy('door clear: and the result says what git was not told', typeof cleared.json.note === 'string' && /no longer a git repository/.test(cleared.json.note));
        const again = await runDoor(repo, 'clear', task.id);
        eq('door clear: a second clear finds nothing to clear', typeof again.json.error, 'string');
      });

      await doorSection('door: clear removes a task\'s copy and its branch, nothing else', async () => {
        const repo = makeRepo('door clear repo');
        gitIn(repo, 'branch', 'feature');
        gitIn(repo, 'branch', 'consult/decoy');
        const headBefore = gitIn(repo, 'rev-parse', 'HEAD');
        const branchesBefore = gitIn(repo, 'branch', '--list', 'feature', 'consult/decoy').split(/\s+/).filter(Boolean).sort();
        const finishedWithCopy = async (state, overrides = {}) => {
          const task = addTask(repo, { location: 'copy' }, {});
          const copy = await makeCopy(repo, task.id);
          return updateTask(task.id, { worktree: copy.worktree, branch: copy.branch, start_commit: copy.start_commit, state, ...overrides });
        };
        const failedTask = await finishedWithCopy('failed');
        truthy('door clear setup: the copy and its branch exist', fs.existsSync(failedTask.worktree) && gitIn(repo, 'branch', '--list', failedTask.branch).includes(failedTask.id));
        const cleared = await runDoor(repo, 'clear', failedTask.id);
        eq('door clear: a failed copy task goes, with its copy and its branch', [cleared.json.error, cleared.json.cleared, fs.existsSync(failedTask.worktree), gitIn(repo, 'branch', '--list', failedTask.branch).trim(), fs.existsSync(taskFolder(failedTask.id)), indexIds().includes(failedTask.id)], [undefined, failedTask.id, false, '', false, false]);

        const mergedTask = await finishedWithCopy('merged');
        await removeCopy(repo, mergedTask, { keepBranch: true });
        updateTask(mergedTask.id, { worktree: null, copy_removed: true });
        truthy('door clear setup: a merged task keeps only its branch', gitIn(repo, 'branch', '--list', mergedTask.branch).includes(mergedTask.id));
        const clearedMerged = await runDoor(repo, 'clear', mergedTask.id);
        eq('door clear: a merged task\'s branch (the undo) goes with its row', [clearedMerged.json.error, gitIn(repo, 'branch', '--list', mergedTask.branch).trim(), fs.existsSync(taskFolder(mergedTask.id))], [undefined, '', false]);

        const stoppedTask = await finishedWithCopy('stopped', { branch: 'feature' });
        const clearedOddBranch = await runDoor(repo, 'clear', stoppedTask.id);
        eq('door clear: the branch is always consult/<id>, whatever the task file says', [clearedOddBranch.json.error, gitIn(repo, 'branch', '--list', 'feature', 'consult/decoy').split(/\s+/).filter(Boolean).sort()], [undefined, branchesBefore]);
        eq('door clear: its own branch went too', gitIn(repo, 'branch', '--list', `consult/${stoppedTask.id}`).trim(), '');
        eq('door clear: the user\'s HEAD is where it was', gitIn(repo, 'rev-parse', 'HEAD'), headBefore);
        eq('door clear: the worktree list shows only the repo', gitIn(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
        eq('door clear: the user\'s working tree has no change', gitIn(repo, 'status', '--porcelain'), '');

        // discard of unmerged work: the copy and the branch are gone
        const doneTask = await finishedWithCopy('done');
        fs.writeFileSync(path.join(doneTask.worktree, 'new.txt'), 'unmerged\n');
        const refusedDone = await runDoor(repo, 'clear', doneTask.id);
        eq('door clear: unmerged work is refused without discard, copy and branch intact', [typeof refusedDone.json.error, fs.existsSync(doneTask.worktree), gitIn(repo, 'branch', '--list', doneTask.branch).includes(doneTask.id)], ['string', true, true]);
        const discardedDone = await runDoor(repo, 'clear', doneTask.id, '{"discard":true}');
        eq('door clear: with discard the copy, the branch and the task are gone', [discardedDone.json.error, discardedDone.json.copy_removed, discardedDone.json.branch_deleted, fs.existsSync(doneTask.worktree), gitIn(repo, 'branch', '--list', doneTask.branch).trim(), fs.existsSync(taskFolder(doneTask.id))], [undefined, true, true, false, '', false]);
        eq('door clear: a discard leaves the user\'s repo as it was', [gitIn(repo, 'rev-parse', 'HEAD'), gitIn(repo, 'status', '--porcelain'), fs.existsSync(path.join(repo, 'new.txt'))], [headBefore, '', false]);

        // the claim is made under the task's lock, before anything is deleted
        const revived = await finishedWithCopy('failed');
        const staleRead = readTask(revived.id);
        updateTask(revived.id, { state: 'queued' });
        const delegateLib = await import('./lib/delegate.js');
        let claimRefusal = null;
        try { await delegateLib.claimForClear(staleRead.id, repo, false); } catch (error) { claimRefusal = error.message; }
        eq('claim: a task revived after it was read is refused, and nothing is deleted or marked', [typeof claimRefusal, fs.existsSync(revived.worktree), gitIn(repo, 'branch', '--list', revived.branch).includes(revived.id), readTask(revived.id).state, readTask(revived.id).clearing ?? false], ['string', true, true, 'queued', false]);
        const revivedClear = await runDoor(repo, 'clear', revived.id, '{"discard":true}');
        eq('door clear: a revived task stays fully intact even with discard', [typeof revivedClear.json.error, fs.existsSync(revived.worktree), gitIn(repo, 'branch', '--list', revived.branch).includes(revived.id), fs.existsSync(taskFolder(revived.id))], ['string', true, true, true]);

        const claimed = await finishedWithCopy('failed');
        const claim = await delegateLib.claimForClear(claimed.id, repo, false);
        eq('claim: a clearable task is marked clearing, with the time of the mark', [claim.id, readTask(claimed.id).clearing, typeof readTask(claimed.id).clearing_at, readTask(claimed.id).state], [claimed.id, true, 'number', 'failed']);
        let secondClaim = null;
        try { await delegateLib.claimForClear(claimed.id, repo, false); } catch (error) { secondClaim = error.message; }
        truthy('claim: a task already being cleared is refused', typeof secondClaim === 'string' && /being cleared/.test(secondClaim));
        const sendContext = { settings: { delegate: {} }, project: repo, sessionId: 's', instanceId: 'i', launch: () => 1, startWaitMs: 0 };
        const sendResult = await delegateLib.callDelegateTool('delegate_send', { id: claimed.id, message: 'again' }, sendContext);
        eq('delegate_send refuses a task that is being cleared and starts nothing', [sendResult.isError, /being cleared/.test(sendResult.content[0].text), readTask(claimed.id).state], [true, true, 'failed']);
        updateTask(claimed.id, { state: 'done', end_commit: claimed.start_commit });
        const mergeResult = await delegateLib.callDelegateTool('delegate_merge', { id: claimed.id }, sendContext);
        eq('delegate_merge refuses a task that is being cleared', [mergeResult.isError, /being cleared/.test(mergeResult.content[0].text)], [true, true]);
        eq('claim: the claim carries a random token, stored with the mark', [typeof claim.clearing_token, claim.clearing_token.length >= 16, readTask(claimed.id).clearing_token === claim.clearing_token], ['string', true, true]);
        delegateLib.releaseClear(claimed.id, claim.clearing_token);
        eq('releaseClear: the mark goes, the task is as before', [readTask(claimed.id).clearing, fs.existsSync(claimed.worktree)], [false, true]);

        // the mark expires: a clear that died leaves a mark that stops mattering after two minutes
        eq('the clearing mark is good for ten minutes', delegateLib.CLEARING_MARK_FRESH_MS, 600000);
        updateTask(claimed.id, { state: 'failed', clearing: true, clearing_at: Date.now() - delegateLib.CLEARING_MARK_FRESH_MS - 1000 });
        const staleSend = await delegateLib.callDelegateTool('delegate_send', { id: claimed.id, message: 'again' }, sendContext);
        truthy('delegate_send ignores an expired mark (it fails for its own reasons, not "being cleared")', !/being cleared/.test(staleSend.content[0].text));
        // (copy_removed makes the merge a bookkeeping step that leaves the copy alone)
        updateTask(claimed.id, { state: 'done', copy_removed: true, clearing_at: Date.now() - delegateLib.CLEARING_MARK_FRESH_MS - 1000 });
        const staleMerge = await delegateLib.callDelegateTool('delegate_merge', { id: claimed.id }, sendContext);
        eq('delegate_merge ignores an expired mark', [staleMerge.isError === true, readTask(claimed.id).state], [false, 'merged']);
        updateTask(claimed.id, { state: 'failed', copy_removed: false });
        const reclaimed = await delegateLib.claimForClear(claimed.id, repo, false);
        truthy('claim: an expired mark is claimed again, with a fresh time', reclaimed.clearing === true && Date.now() - reclaimed.clearing_at < 60000);
        updateTask(claimed.id, { clearing_at: undefined });
        const noTimeClaim = await delegateLib.claimForClear(claimed.id, repo, false);
        eq('claim: a mark with no time (from before marks expired) counts as expired', typeof noTimeClaim.clearing_at, 'number');
        updateTask(claimed.id, { clearing_at: Date.now() - 30000 });
        let freshRefusal = null;
        try { await delegateLib.claimForClear(claimed.id, repo, false); } catch (error) { freshRefusal = error.message; }
        truthy('claim: a mark half a minute old still holds', /being cleared/.test(freshRefusal ?? ''));
        updateTask(claimed.id, { clearing_at: Date.now() - delegateLib.CLEARING_MARK_FRESH_MS + 60000 });
        let almostExpired = null;
        try { await delegateLib.claimForClear(claimed.id, repo, false); } catch (error) { almostExpired = error.message; }
        truthy('claim: a mark nine minutes old still holds', /being cleared/.test(almostExpired ?? ''));
        delegateLib.releaseClear(claimed.id, noTimeClaim.clearing_token);
        eq('releaseClear: also clears the time', [readTask(claimed.id).clearing, readTask(claimed.id).clearing_at], [false, null]);

        // a clear waits for no merge: while merge.lock is held it is refused, with nothing marked
        const { withLockFolder } = storeNamespace;
        let lockedRefusal = null;
        await withLockFolder(path.join(dataHome(), 'merge.lock'), async () => {
          try { await delegateLib.claimForClear(claimed.id, repo, true, { mergeWaitMs: 150 }); } catch (error) { lockedRefusal = error.message; }
        });
        truthy('claim: while a merge holds merge.lock the clear is refused (not waited for)', /merge is in progress/.test(lockedRefusal ?? '') && readTask(claimed.id).clearing === false);
        const afterMerge = await delegateLib.claimForClear(claimed.id, repo, true, { mergeWaitMs: 150 });
        eq('claim: once the merge lock is free the clear goes ahead', afterMerge.clearing, true);
        delegateLib.releaseClear(claimed.id, afterMerge.clearing_token);

        // claim identity: a clear whose mark expired and was taken over by a second clear
        const firstClear = await delegateLib.claimForClear(claimed.id, repo, false);
        updateTask(claimed.id, { clearing_at: Date.now() - delegateLib.CLEARING_MARK_FRESH_MS - 1000 });
        const secondClear = await delegateLib.claimForClear(claimed.id, repo, false);
        truthy('claim: a second clear that takes over an expired mark gets its own token', secondClear.clearing_token !== firstClear.clearing_token);
        delegateLib.releaseClear(claimed.id, firstClear.clearing_token);
        eq('releaseClear: the first clear\'s release leaves the second clear\'s mark alone', [readTask(claimed.id).clearing, readTask(claimed.id).clearing_token === secondClear.clearing_token], [true, true]);
        let lostClaim = null;
        try { delegateLib.keepClaim(claimed.id, firstClear.clearing_token); } catch (error) { lostClaim = error.message; }
        truthy('keepClaim: the first clear learns it lost its claim', /lost its claim/.test(lostClaim ?? ''));
        eq('finishClear: the first clear\'s final step removes nothing', [delegateLib.finishClear(claimed.id, firstClear.clearing_token, false), fs.existsSync(taskFolder(claimed.id))], [false, true]);
        updateTask(claimed.id, { clearing_at: Date.now() - delegateLib.CLEARING_MARK_FRESH_MS + 60000 });
        delegateLib.keepClaim(claimed.id, secondClear.clearing_token);
        truthy('keepClaim: the owner of the mark renews its time', Date.now() - readTask(claimed.id).clearing_at < 60000);
        updateTask(claimed.id, { state: 'queued' });
        eq('finishClear: a task that is no longer clearable (revived) is not removed, even with the right token', [delegateLib.finishClear(claimed.id, secondClear.clearing_token, true), fs.existsSync(taskFolder(claimed.id))], [false, true]);
        updateTask(claimed.id, { state: 'failed' });
        delegateLib.releaseClear(claimed.id, secondClear.clearing_token);

        // a follow-up that revives a task after its mark expired wipes the mark: the stale clear removes nothing
        const revivedByEnd = await finishedWithCopy('failed');
        updateTask(revivedByEnd.id, { worker_session: 'session-x' });
        const staleClear = await delegateLib.claimForClear(revivedByEnd.id, repo, false);
        updateTask(revivedByEnd.id, { clearing_at: Date.now() - delegateLib.CLEARING_MARK_FRESH_MS - 1000 });
        const sentAfterExpiry = await delegateLib.callDelegateTool('delegate_send', { id: revivedByEnd.id, message: 'again' }, sendContext);
        eq('delegate_send revives a task whose mark expired, and takes the mark off', [sentAfterExpiry.isError === true, readTask(revivedByEnd.id).state, readTask(revivedByEnd.id).clearing, readTask(revivedByEnd.id).clearing_token], [false, 'queued', false, null]);
        eq('finishClear: the stale clear\'s final step leaves the revived task\'s folder and copy', [delegateLib.finishClear(revivedByEnd.id, staleClear.clearing_token, true), fs.existsSync(taskFolder(revivedByEnd.id)), fs.existsSync(revivedByEnd.worktree)], [false, true, true]);

        // any failure after the claim takes the mark off: here the copy is outside the worktrees folder
        const outside = path.join(doorRoot, 'outside the worktrees folder');
        fs.mkdirSync(outside, { recursive: true });
        const outsideTask = addTask(repo, { location: 'copy' }, { state: 'failed', worktree: outside });
        const failedClear = await runDoor(repo, 'clear', outsideTask.id);
        truthy('door clear: a copy that cannot be removed is an error naming it', /not under the delegate worktrees folder/.test(failedClear.json.error ?? '') && fs.existsSync(outside));
        eq('door clear: and the mark is off, the task still there', [readTask(outsideTask.id).clearing ?? false, readTask(outsideTask.id).state], [false, 'failed']);
        const outsideClaim = await delegateLib.claimForClear(outsideTask.id, repo, false);
        eq('door clear: the task can be claimed again', outsideClaim.clearing, true);
        delegateLib.releaseClear(outsideTask.id, outsideClaim.clearing_token);
        updateTask(outsideTask.id, { worktree: null });
        const outsideCleared = await runDoor(repo, 'clear', outsideTask.id);
        eq('door clear: with the bad copy path gone the task clears', [outsideCleared.json.error, fs.existsSync(taskFolder(outsideTask.id)), fs.existsSync(outside)], [undefined, false, true]);
      });

      // ---- save ----
      await doorSection('door: save', async () => {
        const projectA = makePlain('door save a');
        const projectB = makePlain('door save b');
        const saved = await runDoor(projectA, 'save', JSON.stringify({ workers_edit: 'copy' }));
        const projectsFile = JSON.parse(fs.readFileSync(doorProjectsFile, 'utf8'));
        eq('door save: workers_edit goes to the projects file under the project\'s key', [saved.json.error, projectsFile[projectKey(projectA)]?.workers_edit, saved.json.settings?.workers_edit], [undefined, 'copy', 'copy']);
        eq('door save: a project-only save says no global file was written', saved.json.global_written, false);
        eq('door save: other projects are unaffected', projectSettings(projectB).workers_edit, 'auto');
        eq('door save: nothing is written to the global file for a project setting', fs.existsSync(globalSettingsPath), false);

        const original = '---\r\n# my notes\r\ntimeout_ms: 600000\r\nlocal_runner: llama-swap\r\n---\r\nBody text\r\n';
        fs.writeFileSync(globalSettingsPath, original);
        const keep = await runDoor(projectA, 'save', JSON.stringify({ on_close: 'keep' }));
        eq('door save: on_close goes to the global file as delegate.on_close, every other byte kept', [keep.json.error, fs.readFileSync(globalSettingsPath, 'utf8')], [undefined, '---\r\n# my notes\r\ntimeout_ms: 600000\r\nlocal_runner: llama-swap\r\ndelegate.on_close: keep\r\n---\r\nBody text\r\n']);
        eq('door save: a save that wrote the global file says so', keep.json.global_written, true);
        eq('door save: the first save keeps a .bak of the file as it was', fs.readFileSync(`${globalSettingsPath}.bak`, 'utf8'), original);
        eq('door save: the settings come back as show reads them', keep.json.settings, { workers_edit: 'copy', table: { code: 'codex', research_review: 'agy', private: 'local' }, local_at_once: 'auto', on_close: 'keep', time_limit_min: 180 });
        const second = await runDoor(projectA, 'save', JSON.stringify({ time_limit_min: 45, local_at_once: 3, keep_backup: true }));
        eq('door save: keep_backup leaves the first .bak alone and still saves', [second.json.error, fs.readFileSync(`${globalSettingsPath}.bak`, 'utf8'), fs.readFileSync(globalSettingsPath, 'utf8').includes('delegate.time_limit_min: 45\r\n'), fs.readFileSync(globalSettingsPath, 'utf8').includes('delegate.local_at_once: 3\r\n')], [undefined, original, true, true]);
        eq('door save: the numbers come back as numbers', [second.json.settings?.time_limit_min, second.json.settings?.local_at_once], [45, 3]);
        const reset = await runDoor(projectA, 'save', JSON.stringify({ time_limit_min: null, keep_backup: true }));
        eq('door save: null puts a setting back to its default', [reset.json.error, reset.json.settings?.time_limit_min, fs.readFileSync(globalSettingsPath, 'utf8').includes('time_limit_min')], [undefined, 180, false]);

        const tableSaved = await runDoor(projectA, 'save', JSON.stringify({ table: { research_review: 'codex', code: 'local' }, keep_backup: true }));
        const tableText = fs.readFileSync(globalSettingsPath, 'utf8');
        eq('door save: the research/review row writes both delegate.research and delegate.review', [tableSaved.json.error, tableText.includes('delegate.research: codex'), tableText.includes('delegate.review: codex'), tableText.includes('delegate.code: local')], [undefined, true, true, true]);
        eq('door save: the table comes back as three rows', tableSaved.json.settings?.table, { code: 'local', research_review: 'codex', private: 'local' });
        const askSaved = await runDoor(projectA, 'save', JSON.stringify({ table: { code: 'ask', research_review: 'ask', private: 'ask' } }));
        const askText = fs.readFileSync(globalSettingsPath, 'utf8');
        eq('door save: a table row may be ask (all four lines)', [askSaved.json.error, ['code', 'research', 'review', 'private'].every((kind) => askText.includes(`delegate.${kind}: ask`))], [undefined, true]);
        eq('door save: ask comes back in the three rows, and show agrees', [askSaved.json.settings?.table, (await runDoor(projectA, 'show')).json.settings?.table], [{ code: 'ask', research_review: 'ask', private: 'ask' }, { code: 'ask', research_review: 'ask', private: 'ask' }]);
        const mixedAsk = await runDoor(projectA, 'save', JSON.stringify({ table: { research_review: 'agy' } }));
        eq('door save: research ask and review agy are put right with one row', mixedAsk.json.settings?.table?.research_review, 'agy');
        await runDoor(projectA, 'save', JSON.stringify({ table: { code: 'local', research_review: 'codex', private: 'local' } }));

        const textBefore = fs.readFileSync(globalSettingsPath, 'utf8');
        const projectsBefore = fs.readFileSync(doorProjectsFile, 'utf8');
        const refusals = [
          [{ on_close: 'banana' }, ['delegate.on_close', 'stop, keep']],
          [{ time_limit_min: 5 }, ['delegate.time_limit_min', '10']],
          [{ time_limit_min: '180' }, ['delegate.time_limit_min']],
          [{ local_at_once: 9 }, ['delegate.local_at_once', 'auto']],
          [{ local_at_once: 0 }, ['delegate.local_at_once']],
          [{ table: { code: 'gemini' } }, ['delegate.code', 'codex, agy, local']],
          [{ table: { research_review: 'mixed' } }, ['codex, agy, local']],
          [{ table: { nope: 'codex' } }, ['nope']],
          [{ nope: 1 }, ['nope']],
          [{ workers_edit: 'sideways' }, ['workers_edit', 'auto, here, copy']],
          [{ on_close: 'stop', workers_edit: 'sideways' }, ['workers_edit']],
          [{ workers_edit: 'here', on_close: 'banana' }, ['delegate.on_close']]
        ];
        for (const [change, words] of refusals) {
          const refused = await runDoor(projectA, 'save', JSON.stringify(change));
          truthy(`door save: ${JSON.stringify(change)} is refused naming ${words.join(' / ')}`, typeof refused.json.error === 'string' && words.every((word) => refused.json.error.includes(word)) && refused.code === 0);
        }
        eq('door save: refused saves write nothing, not even half of a mixed one', [fs.readFileSync(globalSettingsPath, 'utf8'), fs.readFileSync(doorProjectsFile, 'utf8')], [textBefore, projectsBefore]);

        const unreadable = await runDoor(projectA, 'save', 'not json');
        eq('door save: bad JSON is an error', typeof unreadable.json.error, 'string');
        eq('door save: a JSON array is an error', typeof (await runDoor(projectA, 'save', '[1]')).json.error, 'string');
        const nothing = await runDoor(projectA, 'save', '{}');
        eq('door save: no change at all is fine, writes nothing and says so', [nothing.json.error, nothing.json.global_written, fs.readFileSync(globalSettingsPath, 'utf8')], [undefined, false, textBefore]);
        eq('door save: a refused save has no global_written to trust', (await runDoor(projectA, 'save', JSON.stringify({ on_close: 'banana' }))).json.global_written, undefined);

        // keep_backup counts only when there is a .bak to keep: a first save that
        // touched no global file made none.
        fs.rmSync(`${globalSettingsPath}.bak`, { force: true });
        const projectOnly = await runDoor(projectA, 'save', JSON.stringify({ workers_edit: 'here' }));
        const unbacked = fs.readFileSync(globalSettingsPath, 'utf8');
        const afterProjectOnly = await runDoor(projectA, 'save', JSON.stringify({ on_close: 'stop', keep_backup: true }));
        eq('door save: keep_backup with no .bak still makes the backup of the file as it was', [projectOnly.json.error, afterProjectOnly.json.error, fs.existsSync(`${globalSettingsPath}.bak`) ? fs.readFileSync(`${globalSettingsPath}.bak`, 'utf8') : null], [undefined, undefined, unbacked]);

        // git and workers_edit: set, and null puts them back
        const declined = await runDoor(projectA, 'save', JSON.stringify({ git: 'declined' }));
        eq('door save: git declined is saved and shows', [declined.json.error, projectSettings(projectA).git, (await runDoor(projectA, 'show')).json.git?.declined], [undefined, 'declined', true]);
        const asked = await runDoor(projectA, 'save', JSON.stringify({ git: null, workers_edit: null }));
        eq('door save: null puts git back to ask and workers_edit to auto', [asked.json.error, projectSettings(projectA), asked.json.settings?.workers_edit, (await runDoor(projectA, 'show')).json.git?.declined], [undefined, { workers_edit: 'auto', git: 'ask' }, 'auto', false]);
        eq('door save: a made-up git answer is refused', typeof (await runDoor(projectA, 'save', JSON.stringify({ git: 'maybe' }))).json.error, 'string');
        const nullStore = (() => {
          saveProjectSettings(projectB, { git: 'declined', workers_edit: 'copy' });
          return saveProjectSettings(projectB, { git: null, workers_edit: null });
        })();
        eq('saveProjectSettings: null resets', nullStore, { workers_edit: 'auto', git: 'ask' });

        fs.rmSync(globalSettingsPath);
        fs.rmSync(`${globalSettingsPath}.bak`, { force: true });
        const fresh = await runDoor(projectA, 'save', JSON.stringify({ on_close: 'keep' }));
        eq('door save: with no global file one is made, and there is nothing to back up', [fresh.json.error, fs.readFileSync(globalSettingsPath, 'utf8'), fs.existsSync(`${globalSettingsPath}.bak`)], [undefined, '---\ndelegate.on_close: keep\n---\n', false]);
      });

      // ---- the output contract ----
      await doorSection('door: output contract', async () => {
        const projectA = makePlain('door contract a');
        const unknown = await runDoor(projectA, 'explode');
        eq('door: an unknown command is an error object, exit 0', [unknown.code, oneJsonObject(unknown), typeof unknown.json.error], [0, true, 'string']);
        truthy('door: the unknown-command error lists the commands', ['show', 'cancel', 'clear', 'stop-all', 'save'].every((word) => unknown.json.error.includes(word)));
        const noArguments = await new Promise((resolve) => {
          execFile(process.execPath, [doorScript], { cwd: os.tmpdir(), env: { ...process.env, HOME: doorHome, USERPROFILE: doorHome }, encoding: 'utf8', timeout: 60000 }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout }));
        });
        eq('door: no arguments is an error object, exit 0', [noArguments.code, typeof JSON.parse(noArguments.stdout).error], [0, 'string']);
        const brokenIndex = await runDoor(projectA, 'show');
        eq('door show: an empty store is fine', [brokenIndex.json.rows, brokenIndex.json.elsewhere], [[], []]);
        fs.mkdirSync(path.join(dataHome(), 'tasks', 'abcdef'), { recursive: true });
        fs.writeFileSync(path.join(dataHome(), 'tasks', 'abcdef', 'state.json'), '{ not json');
        const withBrokenTask = await runDoor(projectA, 'show');
        eq('door show: an unreadable task file does not break the tab', [withBrokenTask.code, oneJsonObject(withBrokenTask), withBrokenTask.json.error], [0, true, undefined]);
        fs.writeFileSync(doorProjectsFile, '{ not json');
        const withBrokenProjects = await runDoor(projectA, 'show');
        eq('door show: an unreadable projects file means the defaults', [withBrokenProjects.json.error, withBrokenProjects.json.settings?.workers_edit], [undefined, 'auto']);
        const saveIntoBroken = await runDoor(projectA, 'save', JSON.stringify({ workers_edit: 'copy' }));
        truthy('door save: an unreadable projects file is an error and is left as it is', typeof saveIntoBroken.json.error === 'string' && fs.readFileSync(doorProjectsFile, 'utf8') === '{ not json');
      });

      await doorSection('door: show caps this project\'s rows', async () => {
        const project = makePlain('door cap project');
        const base = addTask(project, {}, { state: 'merged' });
        // 204 more task files written straight away (creating them one by one rescans the store each time).
        for (let count = 1; count <= 204; count++) {
          const id = `a${count.toString(16).padStart(5, '0')}`;
          fs.mkdirSync(taskFolder(id), { recursive: true });
          fs.writeFileSync(path.join(taskFolder(id), 'state.json'), JSON.stringify({ ...base, id, created_at: base.created_at + count }));
        }
        const shown = await runDoor(project, 'show');
        eq('door show: at most the 200 newest rows of the project', [shown.json.error, shown.json.rows?.length, shown.json.rows?.[0]?.id, shown.json.rows?.[199]?.id], [undefined, 200, `a${(204).toString(16).padStart(5, '0')}`, `a${(5).toString(16).padStart(5, '0')}`]);
      });

      // ---- the pieces the script is built from ----
      await doorSection('door: library pieces', async () => {
        const runners = await import('./lib/local-runners.js');
        eq('rewriteDelegateLines, saveDelegateSettings and rewriteRunnerLines are exported', [typeof runners.rewriteDelegateLines, typeof runners.saveDelegateSettings, typeof runners.rewriteRunnerLines], ['function', 'function', 'function']);
        const text = '---\ntimeout_ms: 1\nlocal_runner: llama-swap\ndelegate.on_close: keep # why\n---\nbody\n';
        eq('rewriteDelegateLines: a replaced line keeps its comment, a new line goes last, null removes', runners.rewriteDelegateLines(text, { 'delegate.on_close': 'stop', 'delegate.code': 'local' }), '---\ntimeout_ms: 1\nlocal_runner: llama-swap\ndelegate.on_close: stop # why\ndelegate.code: local\n---\nbody\n');
        eq('rewriteDelegateLines: null removes a line', runners.rewriteDelegateLines(text, { 'delegate.on_close': null }), '---\ntimeout_ms: 1\nlocal_runner: llama-swap\n---\nbody\n');
        for (const key of ['local_runner', 'timeout_ms', 'llama-swap.url', 'delegate.nope', 'delegate']) {
          throws(`rewriteDelegateLines: ${key} is not a delegate setting`, () => runners.rewriteDelegateLines(text, { [key]: 'x' }));
        }
        throws('rewriteRunnerLines still refuses delegate keys', () => runners.rewriteRunnerLines(text, { 'delegate.on_close': 'stop' }));
        throws('rewriteDelegateLines: a value with a line break is refused', () => runners.rewriteDelegateLines(text, { 'delegate.on_close': 'stop\nlocal_runner: x' }));

        const repo = makeRepo('door library repo');
        gitIn(repo, 'branch', 'consult/abc123');
        gitIn(repo, 'branch', 'main-copy');
        eq('deleteTaskBranch: deletes consult/<id> and says so', [await gitNamespace.deleteTaskBranch(repo, 'abc123'), gitIn(repo, 'branch', '--list', 'consult/abc123').trim()], [true, '']);
        eq('deleteTaskBranch: a branch that is not there is not an error', await gitNamespace.deleteTaskBranch(repo, 'abc123'), false);
        for (const unsafe of ['../x', 'main-copy x', '', '-D', 'a/b']) {
          let refused = false;
          try { await gitNamespace.deleteTaskBranch(repo, unsafe); } catch (_) { refused = true; }
          eq(`deleteTaskBranch: ${JSON.stringify(unsafe)} is not a task id`, refused, true);
        }
        eq('deleteTaskBranch: other branches are untouched', gitIn(repo, 'branch', '--list', 'main-copy').includes('main-copy'), true);
        eq('deleteTaskBranch: a folder that is not a repo is not an error', await gitNamespace.deleteTaskBranch(makePlain('door not a repo'), 'abc123'), false);

        const task = addTask(repo, {}, { state: 'failed' });
        eq('removeTaskWhen: a refusing check leaves the task', [storeNamespace.removeTaskWhen(task.id, () => false), fs.existsSync(taskFolder(task.id)), indexIds().includes(task.id)], [false, true, true]);
        eq('removeTaskWhen: the check sees the task as it is under the lock', storeNamespace.removeTaskWhen(task.id, (current) => current.state === 'failed' && current.id === task.id), true);
        eq('removeTaskWhen: the folder and the index row are gone', [fs.existsSync(taskFolder(task.id)), indexIds().includes(task.id)], [false, false]);
        eq('removeTaskWhen: a task that is already gone is false', storeNamespace.removeTaskWhen(task.id, () => true), false);
        const delegateModule = await import('./lib/delegate.js');
        eq('delegate.js exports cancelTask and sameProject for the door', [typeof delegateModule.cancelTask, typeof delegateModule.sameProject], ['function', 'function']);
        eq('limitsView(workers) is exported and answers for the workers asked', [typeof delegateModule.limitsView, Object.keys(delegateModule.limitsView?.(['codex', 'agy', 'local'], Date.now()) ?? {}), Object.keys(delegateModule.limitsView?.(['codex', 'agy'], Date.now()) ?? {})], ['function', ['codex', 'agy', 'local'], ['codex', 'agy']]);
        // local-runners.js and settings.js import each other on purpose (inside functions only): either may load first.
        for (const first of ['local-runners.js', 'settings.js']) {
          const probe = `import(${JSON.stringify(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', first)).href)}).then(async () => { const runners = await import('./lib/local-runners.js'); const settings = await import('./lib/settings.js'); console.log(JSON.stringify([typeof runners.saveDelegateSettings, typeof settings.delegateProblem, runners.rewriteDelegateLines(null, { 'delegate.on_close': 'keep' })])); })`;
          const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' });
          eq(`${first} loaded first in a fresh process works`, JSON.parse(out), ['function', 'function', '---\ndelegate.on_close: keep\n---\n']);
        }
        eq('sameProject: ignores case on Windows and a trailing separator', delegateModule.sameProject(repo, repo + path.sep), true);
        const plan = (fields) => delegateModule.clearPlan({ state: 'done', mode: 'write', location: 'copy', reported_at: null, ...fields });
        eq('clearPlan: a running or queued task is refused, and so is a state with nothing to clear',
          [plan({ state: 'running' }), plan({ state: 'queued' }), plan({ state: 'sleeping' })], ['refuse', 'refuse', 'refuse']);
        eq('clearPlan: merged, cancelled, failed and stopped go at once',
          ['merged', 'cancelled', 'failed', 'stopped'].map((state) => plan({ state })), ['now', 'now', 'now', 'now']);
        eq('clearPlan: a copy\'s unmerged work is confirmed, a conflict apart', [plan({}), plan({ state: 'held' }), plan({ state: 'paused-limit' }), plan({ state: 'conflict' })],
          ['confirm-discard', 'confirm-discard', 'confirm-discard', 'confirm-conflict']);
        eq('clearPlan: unmerged work done in place is confirmed as its own kind', plan({ location: 'here', state: 'conflict' }), 'confirm-in-place');
        eq('clearPlan: a read-only answer is confirmed until Claude has fetched it',
          [plan({ mode: 'read', location: 'here' }), plan({ mode: 'read', location: 'here', reported_at: 5 }), plan({ mode: 'read', state: 'conflict' })], ['confirm-unread', 'now', 'refuse']);
      });
    } finally {
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  }
} finally {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  // Windows may still hold a file of a process that has only just exited.
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) { /* the system clears the temp folder in time */ }
}

console.log('\n' + (failed === 0 ? 'ALL PASSED' : `${failed} FAIL(S)`));
process.exit(failed === 0 ? 0 : 1);
