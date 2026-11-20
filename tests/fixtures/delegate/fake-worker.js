// A stand-in for codex / pi in the supervisor tests (CONSULT_DELEGATE_TEST_BIN
// points at this file). It never talks to a model. FAKE_SCENARIO picks what it
// does; every scenario reads its stdin to the end first and, unless it says
// hang, exits on its own.
//
//   ok          a codex stream, writes worker-output.txt in its folder, exits 0 (FAKE_ANSWER_TAG, FAKE_NO_MESSAGE: see below)
//   fail        starts, writes to stderr, exits 1
//   limit       a codex "usage limit" failure (thread FAKE_THREAD_ID), exits 1
//   early       a codex stream with no terminal event, exits 0
//   hang        starts, writes partial.txt in its folder, then prints nothing and never exits
//   chatty      starts, then prints a line every 250 ms and never exits
//   grandchild  starts a child node process (pid in FAKE_GRANDCHILD_FILE), then hangs
//   lingering   a complete codex stream, exits 0, leaves a grandchild holding stdout open
//   reparent    (Windows) starts a node process through PowerShell Start-Process, so its parent is dead
//               when this exits (script orphan-marker.js in the cwd, pid in FAKE_GRANDCHILD_FILE), then a complete codex stream
//   reparent-chain  (Windows) like reparent, but through a launcher that stays alive: PowerShell starts
//               `cmd /c launch-dev.cmd` (which runs orphan-marker.js by its absolute path) and exits, so
//               the process that names the folder has a live parent whose own parent is dead
//   slow        a complete codex stream after FAKE_RUN_MS (default 8000) of silence, exits 0
//   agy-edit    an agy stream that writes FAKE_WRITE_FILE and deletes FAKE_DELETE_FILE first, exits 0
//   agy-denied  an agy stream that writes FAKE_WRITE_FILE (if set), then ends with an empty response and one denied RunCommand, exits 0
//   agy-replay  prints the lines of the file FAKE_STREAM_FILE as they are, then exits with FAKE_EXIT_CODE (default 0)
//   pi          a pi stream (session from --session-id), exits 0; it notes what was in --session-dir and writes s.jsonl there
//   pi-hang     as pi, then hangs
//   pi-launch-fail  prints Codex's sandbox launch failure on stderr and exits 1
//   opencode-answer  an opencode stream on the model after -m (session from --session, else FAKE_OPENCODE_SESSION or ses_fakeopencode1);
//               keeps a session note in XDG_DATA_HOME/opencode/opencode.db, writes FAKE_WRITE_FILE, FAKE_OTHER_FILE and
//               deletes FAKE_DELETE_FILE as the pi scenario does, exits 0; FAKE_REFUSED_FILE is a write the sandbox
//               refused: its write event ends in an error and nothing is written
//   opencode-ratelimit-then-answer  a provider.rate-limit error (retryAfterMs FAKE_RETRY_AFTER_MS, default 1000) and exit 1 when
//               the -m model is FAKE_LIMITED_MODEL; otherwise opencode-answer
//   opencode-all-limited  the rate-limit error on every model
//   opencode-error  an error event that is no limit, exit 1
//   opencode-read-other-change  as opencode-answer (the folder changes come from FAKE_OTHER_FILE and FAKE_DELETE_FILE)
//
// FAKE_ARGS_LOG: a JSON line (arguments, start of the prompt, cwd, PWD, XDG_DATA_HOME, TEMP) is appended at every opencode start.
//
// FAKE_START_LOG: a line with the pid is appended to this file at every start.
//
// FAKE_REPORT_FILE: a JSON note of what the worker was given (its arguments,
// the start of its prompt, the start of an @file argument, whether the key
// variable named by FAKE_KEY_VARIABLE was set, never its value).
// FAKE_ECHO_KEY=1 prints the key variable's value on stdout and stderr, to
// prove the supervisor keeps it out of the record.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const scenario = process.env.FAKE_SCENARIO || 'ok';
const threadId = process.env.FAKE_THREAD_ID || '5eed5eed-0000-4000-8000-000000000001';
const GRANDCHILD_MARKER = 'consult-fake-grandchild';

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function hangForever() {
  setInterval(() => {}, 1000);
}

const prompt = await readStdin();
const args = process.argv.slice(2);

// An opencode stream, shaped as opencode-read.jsonl and opencode-ratelimit.jsonl have it.
function opencodeRun() {
  const model = args[args.indexOf('-m') + 1];
  const sessionId = args.includes('--session') ? args[args.indexOf('--session') + 1] : (process.env.FAKE_OPENCODE_SESSION || 'ses_fakeopencode1');
  if (process.env.FAKE_ARGS_LOG) {
    const folders = Object.fromEntries(['PWD', 'XDG_DATA_HOME', 'TEMP'].map((name) => [name, process.env[name] ?? null]));
    fs.appendFileSync(process.env.FAKE_ARGS_LOG, `${JSON.stringify({ args, promptStart: prompt.slice(0, 120), cwd: process.cwd(), folders })}\n`);
  }
  // The session database lives in XDG_DATA_HOME; a staged copy is what a follow-up finds there.
  const databaseFolder = path.join(process.env.XDG_DATA_HOME, 'opencode');
  fs.mkdirSync(databaseFolder, { recursive: true });
  fs.appendFileSync(path.join(databaseFolder, 'opencode.db'), `${sessionId} ${model}\n`);
  const common = { sessionID: sessionId };
  emit({ type: 'step_start', ...common, part: { type: 'step-start', messageID: 'msg_1' } });
  const rateLimited = scenario === 'opencode-all-limited' || (scenario === 'opencode-ratelimit-then-answer' && model === process.env.FAKE_LIMITED_MODEL);
  if (rateLimited) {
    emit({ type: 'error', ...common, error: { type: 'provider.rate-limit', status: 429, message: 'Rate limit exceeded: free-models-per-min', retryAfterMs: Number(process.env.FAKE_RETRY_AFTER_MS || 1000) } });
    process.exitCode = 1;
    return;
  }
  if (scenario === 'opencode-error') {
    emit({ type: 'error', ...common, error: { type: 'provider.error', status: 500, message: 'The model fell over.' } });
    process.exitCode = 1;
    return;
  }
  if (process.env.FAKE_WRITE_FILE) {
    const target = path.resolve(process.env.FAKE_WRITE_FILE);
    emit({ type: 'tool_use', ...common, part: { type: 'tool', tool: 'write', state: { status: 'completed', input: { path: target, content: 'changed by the fake worker\n' } } } });
    fs.writeFileSync(target, 'changed by the fake worker\n');
  }
  if (process.env.FAKE_REFUSED_FILE) {
    const refused = path.resolve(process.env.FAKE_REFUSED_FILE);
    emit({ type: 'tool_use', ...common, part: { type: 'tool', tool: 'write', state: { status: 'error', input: { path: refused, content: 'never lands\n' }, error: `Unable to write ${refused}` } } });
  }
  if (process.env.FAKE_OTHER_FILE) fs.writeFileSync(process.env.FAKE_OTHER_FILE, 'changed by another session\n');
  if (process.env.FAKE_DELETE_FILE) fs.rmSync(process.env.FAKE_DELETE_FILE);
  emit({ type: 'text', ...common, part: { type: 'text', text: `Answer from ${model}.` } });
  emit({ type: 'step_finish', ...common, part: { type: 'step-finish', reason: 'stop', cost: 0 } });
}

if (process.env.FAKE_START_LOG) fs.appendFileSync(process.env.FAKE_START_LOG, `${process.pid}\n`);

if (process.env.FAKE_REPORT_FILE) {
  const briefArgument = args.find((arg) => arg.startsWith('@'));
  const report = {
    args,
    promptStart: prompt.slice(0, 60),
    promptLength: prompt.length,
    briefFileStart: briefArgument ? fs.readFileSync(briefArgument.slice(1), 'utf8').slice(0, 60) : null,
    settingsText: args.includes('--settings') ? fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8') : null,
    cwd: process.cwd(),
    keyVariablePresent: Boolean(process.env.FAKE_KEY_VARIABLE && process.env[process.env.FAKE_KEY_VARIABLE])
  };
  fs.writeFileSync(process.env.FAKE_REPORT_FILE, JSON.stringify(report));
}
if (process.env.FAKE_ECHO_KEY === '1' && process.env.FAKE_KEY_VARIABLE) {
  const keyValue = process.env[process.env.FAKE_KEY_VARIABLE] || '';
  emit({ type: 'item.completed', item: { type: 'agent_message', text: `my key is ${keyValue}` } });
  process.stderr.write(`key again: ${keyValue}\n`);
}

if (scenario === 'ok') {
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  fs.writeFileSync('worker-output.txt', 'written by the fake worker\n');
  // FAKE_ANSWER_TAG makes this run's message distinct; FAKE_NO_MESSAGE=1 ends the run without one.
  const answerTag = process.env.FAKE_ANSWER_TAG ? `Tag: ${process.env.FAKE_ANSWER_TAG}\n` : '';
  if (process.env.FAKE_NO_MESSAGE !== '1') emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `## Summary\nCreated worker-output.txt in the folder.\n${answerTag}Second line of the message.\n` } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
} else if (scenario === 'fail') {
  emit({ type: 'thread.started', thread_id: threadId });
  process.stderr.write('boom: the fake worker failed on purpose\n');
  process.exitCode = 1;
} else if (scenario === 'limit') {
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'error', message: 'You have hit your usage limit.' });
  emit({ type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  process.exitCode = 1;
} else if (scenario === 'early') {
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Halfway there.' } });
} else if (scenario === 'hang') {
  emit({ type: 'thread.started', thread_id: threadId });
  fs.writeFileSync('partial.txt', 'work in progress\n');
  hangForever();
} else if (scenario === 'chatty') {
  emit({ type: 'thread.started', thread_id: threadId });
  let tick = 0;
  setInterval(() => emit({ type: 'item.completed', item: { type: 'agent_message', text: `tick ${tick++}` } }), 250);
} else if (scenario === 'grandchild') {
  const grandchild = spawn(process.execPath, ['-e', `setInterval(() => {}, 1000) // ${GRANDCHILD_MARKER}`], { stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_GRANDCHILD_FILE, String(grandchild.pid));
  emit({ type: 'thread.started', thread_id: threadId });
  hangForever();
} else if (scenario === 'lingering') {
  // A complete codex stream and exit 0, but a grandchild is left holding stdout open.
  const grandchild = spawn(process.execPath, ['-e', `setInterval(() => {}, 1000) // ${GRANDCHILD_MARKER}`], { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform === 'win32' }); // detached on Windows only: there a child otherwise dies with its parent; on POSIX it would leave the worker's process group, as a real CLI's child does not
  grandchild.unref();
  fs.writeFileSync(process.env.FAKE_GRANDCHILD_FILE, String(grandchild.pid));
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Lingered.' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  // The supervisor reads the process table now and then; give it time to see the grandchild.
  setTimeout(() => fs.writeFileSync(process.env.FAKE_EXIT_MARKER, String(process.pid)), 3000); // written just before this process exits
} else if (scenario === 'reparent') {
  const markerScript = path.join(process.cwd(), 'orphan-marker.js');
  fs.writeFileSync(markerScript, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
  const startCommand = `Start-Process -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '"${markerScript}"','"${process.env.FAKE_GRANDCHILD_FILE}"'`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', startCommand], { stdio: 'ignore', windowsHide: true });
  const waitUntil = Date.now() + 15000;
  while (!fs.existsSync(process.env.FAKE_GRANDCHILD_FILE) && Date.now() < waitUntil) await new Promise((resolve) => setTimeout(resolve, 100));
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Started a server and left.' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
} else if (scenario === 'reparent-chain') {
  const markerScript = path.join(process.cwd(), 'orphan-marker.js');
  fs.writeFileSync(markerScript, "require('fs').writeFileSync(process.env.FAKE_GRANDCHILD_FILE, String(process.pid)); setInterval(() => {}, 1000);\n");
  fs.writeFileSync(path.join(process.cwd(), 'launch-dev.cmd'), `@"${process.execPath}" "%~dp0orphan-marker.js"\r\n`);
  const startCommand = "Start-Process -WindowStyle Hidden -FilePath cmd -ArgumentList '/c','.\\launch-dev.cmd'";
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', startCommand], { stdio: 'ignore', windowsHide: true });
  const waitUntil = Date.now() + 15000;
  while (!fs.existsSync(process.env.FAKE_GRANDCHILD_FILE) && Date.now() < waitUntil) await new Promise((resolve) => setTimeout(resolve, 100));
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Started a server and left.' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
} else if (scenario === 'slow') {
  emit({ type: 'thread.started', thread_id: threadId });
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_RUN_MS || 8000)));
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Took its time.' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
} else if (scenario === 'busy-step') {
  // One long command: item.started, FAKE_RUN_MS of silence, then item.completed. With FAKE_NEVER_ENDS=1 it never ends.
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'npm run build', aggregated_output: '', exit_code: null, status: 'in_progress' } });
  if (process.env.FAKE_NEVER_ENDS === '1') hangForever();
  else {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_RUN_MS || 3500)));
    emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'npm run build', aggregated_output: 'built\n', exit_code: 0, status: 'completed' } });
    emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Built it.' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }
} else if (scenario === 'agy-edit') {
  // An agy stream that ends well. FAKE_WRITE_FILE (relative to the folder) is written through agy's
  // own step, shaped as agy 1.5.11 reports one (agy-edit.jsonl): edit_file for a file that exists,
  // else write_file, an absolute Path, ACTIVE then DONE. A read task's worker that edited anyway.
  // FAKE_OTHER_FILE is written and FAKE_DELETE_FILE deleted with no step: another session at work
  // in the same folder meanwhile.
  emit({ event: 'init', conversation_id: threadId });
  if (process.env.FAKE_WRITE_FILE) {
    const target = path.resolve(process.env.FAKE_WRITE_FILE);
    const toolName = fs.existsSync(target) ? 'edit_file' : 'write_file';
    const step = (state) => ({ event: 'step_update', step_update: { conversation_id: threadId, step_index: 1, state, step_type: 'tool', tool_name: toolName, tool_info: { name: toolName, parameters: { Path: target } } } });
    emit(step('ACTIVE'));
    fs.writeFileSync(target, 'changed by the fake worker\n');
    emit(step('DONE'));
  }
  if (process.env.FAKE_OTHER_FILE) fs.writeFileSync(process.env.FAKE_OTHER_FILE, 'changed by another session\n');
  if (process.env.FAKE_DELETE_FILE) fs.rmSync(process.env.FAKE_DELETE_FILE);
  emit({ event: 'result', result: { conversation_id: threadId, status: 'SUCCESS', response: 'Reviewed the code.' } });
} else if (scenario === 'agy-denied') {
  // The shape of a real run that wrote its files, then tried a command and was refused: no response,
  // one denied action, status SUCCESS, exit 0.
  emit({ event: 'init', conversation_id: threadId });
  if (process.env.FAKE_WRITE_FILE) fs.writeFileSync(process.env.FAKE_WRITE_FILE, 'written by the fake worker\n');
  emit({ event: 'result', result: { conversation_id: threadId, status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
} else if (scenario === 'agy-replay') {
  // A recorded agy stream, printed unchanged; agy 1.2.10+ exits 3 after an ERROR result.
  process.stdout.write(fs.readFileSync(process.env.FAKE_STREAM_FILE, 'utf8'));
  process.exitCode = Number(process.env.FAKE_EXIT_CODE || 0);
} else if (scenario.startsWith('opencode-')) {
  opencodeRun();
} else if (scenario === 'pi-launch-fail') {
  process.stderr.write('windows sandbox failed: runner failed during SpawnChild\n');
  process.exitCode = 1;
} else if (scenario === 'pi' || scenario === 'pi-hang') {
  // pi's session folder: note what was staged there, and leave a session file.
  const sessionDir = args[args.indexOf('--session-dir') + 1];
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'seen.txt'), fs.readdirSync(sessionDir).join(','));
  fs.writeFileSync(path.join(sessionDir, 's.jsonl'), 'a session line\n');
  if (scenario === 'pi-hang') {
    emit({ type: 'session', version: 3, id: 'hanging' });
    hangForever();
  }
  const sessionId = args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--session') + 1];
  emit({ type: 'session', version: 3, id: sessionId });
  emit({ type: 'agent_start' });
  // FAKE_WRITE_FILE (relative to the folder) is written through pi's own write tool, shaped as
  // pi-write.jsonl reports one; FAKE_OTHER_FILE is written and FAKE_DELETE_FILE deleted with no
  // tool call: another session at work in the same folder meanwhile.
  if (process.env.FAKE_WRITE_FILE) {
    emit({ type: 'tool_execution_start', toolCallId: 'fake-call-1', toolName: 'write', args: { path: process.env.FAKE_WRITE_FILE, content: 'changed by the fake worker\n' } });
    fs.writeFileSync(process.env.FAKE_WRITE_FILE, 'changed by the fake worker\n');
  }
  if (process.env.FAKE_OTHER_FILE) fs.writeFileSync(process.env.FAKE_OTHER_FILE, 'changed by another session\n');
  if (process.env.FAKE_DELETE_FILE) fs.rmSync(process.env.FAKE_DELETE_FILE);
  emit({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Wrote the file with pi.' }] }] });
  emit({ type: 'agent_settled' });
} else {
  process.stderr.write(`unknown FAKE_SCENARIO ${scenario}\n`);
  process.exitCode = 2;
}
