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
//   pi          a pi stream (session from --session-id), exits 0
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

if (process.env.FAKE_START_LOG) fs.appendFileSync(process.env.FAKE_START_LOG, `${process.pid}\n`);

if (process.env.FAKE_REPORT_FILE) {
  const briefArgument = args.find((arg) => arg.startsWith('@'));
  const report = {
    args,
    promptStart: prompt.slice(0, 60),
    promptLength: prompt.length,
    briefFileStart: briefArgument ? fs.readFileSync(briefArgument.slice(1), 'utf8').slice(0, 60) : null,
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
  const grandchild = spawn(process.execPath, ['-e', `setInterval(() => {}, 1000) // ${GRANDCHILD_MARKER}`], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }); // detached: on Windows a child otherwise dies with its parent
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
  // An agy stream that ends well, after writing FAKE_WRITE_FILE (relative to the folder) and, when
  // FAKE_DELETE_FILE is set, deleting that file: a read task's worker that edited anyway.
  emit({ event: 'init', conversation_id: threadId });
  if (process.env.FAKE_WRITE_FILE) fs.writeFileSync(process.env.FAKE_WRITE_FILE, 'changed by the fake worker\n');
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
} else if (scenario === 'pi') {
  const sessionId = args[args.indexOf('--session-id') + 1];
  emit({ type: 'session', version: 3, id: sessionId });
  emit({ type: 'agent_start' });
  emit({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Wrote the file with pi.' }] }] });
  emit({ type: 'agent_settled' });
} else {
  process.stderr.write(`unknown FAKE_SCENARIO ${scenario}\n`);
  process.exitCode = 2;
}
