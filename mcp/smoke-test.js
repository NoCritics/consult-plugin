// Tiny MCP client to verify the server initializes and lists tools.
// Does NOT call any LLM. Run: node mcp/smoke-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, unpack, handshake } from './test-helpers.js';

// The server writes its heartbeat into the delegate data folder: a temp one, never the user's.
const delegateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-smoke-'));
process.env.CONSULT_DELEGATE_HOME = delegateHome;
// This one server does its start-up sweeps (the test servers skip them): a task
// whose supervisor is gone must be settled when it starts.
process.env.CONSULT_DELEGATE_TEST_NO_SWEEP = '0';
const { createTask, updateTask, readTask } = await import('./lib/delegate-store.js');
const exited = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
await new Promise(resolve => exited.on('exit', resolve));
const orphan = createTask({ worker: 'codex', mode: 'read', location: 'here', project: delegateHome, title: 'orphan', brief: 'b' });
updateTask(orphan.id, { state: 'running', started_at: Date.now(), supervisor_pid: exited.pid, supervisor_beat_at: Date.now() });
const { send, waitFor, kill, getBuf, scratchFolder } = startServer();

await handshake(send, { clientName: 'smoke' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codex_login_status', arguments: {} } });
// Offline error-path checks: the bad effort is rejected by validation before
// codex is spawned, so neither call costs anything.
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_codex', arguments: { prompt: 'x', reasoning_effort: 'bogus' } } });
send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ask_codex', arguments: { prompt: 'x', timeout_s: 5 } } });
// The delegate tools: a bad worker is refused before anything starts; delegate_wait takes its own short timeouts.
send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delegate', arguments: { worker: 'bogus', task_title: 't', brief: 'b', mode: 'read' } } });
send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'delegate_wait', arguments: { timeout_s: 1 } } });

let failed = false;

try {
  const listMsg = await waitFor(2, 20000);
  const list = listMsg?.result?.tools;
  if (!list) {
    console.error('FAIL: no tools/list response. Raw:\n' + getBuf().slice(0, 2000));
    await kill();
    process.exit(1);
  }
  console.log('tools/list OK -', list.length, 'tools:', list.map(t => t.name).join(', '));

  // The per-call hooks switch must be discoverable by the calling model.
  for (const toolName of ['ask_codex', 'consult_chat_start', 'consult_chat_send', 'council_vote']) {
    const prop = list.find(t => t.name === toolName)?.inputSchema?.properties?.run_hooks;
    if (prop?.type !== 'boolean') { console.error(`FAIL: ${toolName} has no boolean run_hooks in its schema`); failed = true; }
  }
  if (!/run_hooks/.test(list.find(t => t.name === 'ask_codex').description)) { console.error('FAIL: ask_codex description does not mention run_hooks'); failed = true; }
  if (!failed) console.log('run_hooks exposed on ask_codex, chat start/send, council_vote OK');

  // Every long-running tool takes a per-call timeout_s, bounded 30-1800.
  const timedTools = ['ask_codex', 'ask_agy', 'ask_local', 'ask_gemini', 'agy_generate_image', 'codex_generate_image', 'consult_chat_start', 'consult_chat_send', 'council_vote'];
  let timeoutOk = true;
  for (const toolName of timedTools) {
    const prop = list.find(t => t.name === toolName)?.inputSchema?.properties?.timeout_s;
    if (prop?.type !== 'number' || prop.minimum !== 30 || prop.maximum !== 1800) {
      console.error(`FAIL: ${toolName} has no timeout_s (number, 30-1800) in its schema`);
      failed = true;
      timeoutOk = false;
    }
  }
  if (timeoutOk) console.log('timeout_s exposed on all', timedTools.length, 'long-running tools OK');

  // codex_generate_image: listed, with transparency and at most 5 reference images.
  const codexImageProps = list.find(t => t.name === 'codex_generate_image')?.inputSchema?.properties;
  if (codexImageProps?.transparent_background?.type !== 'boolean' || codexImageProps?.images?.maxItems !== 5) {
    console.error('FAIL: codex_generate_image is missing, has no boolean transparent_background, or images.maxItems is not 5');
    failed = true;
  } else {
    console.log('codex_generate_image listed with transparent_background and images.maxItems 5 OK');
  }

  // The delegate feature: eight tools, whose description opens with the routing text.
  const delegateNames = ['delegate', 'delegate_status', 'delegate_list', 'delegate_result', 'delegate_merge', 'delegate_send', 'delegate_cancel', 'delegate_wait'];
  const missingDelegate = delegateNames.filter(name => !list.some(tool => tool.name === name));
  if (missingDelegate.length) {
    console.error('FAIL: tools/list lacks the delegate tools:', missingDelegate.join(', '));
    failed = true;
  } else if (!list.find(tool => tool.name === 'delegate').description.startsWith('Background task run by Codex, agy or a local model instead of a Claude subagent.')) {
    console.error('FAIL: the delegate description does not open with the routing text');
    failed = true;
  } else {
    console.log('delegate tools listed, description opens with the routing text OK');
  }

  // Annotations: a result read marks the task seen and may remove an empty copy, a merge writes the user's files.
  const hintsOf = (name) => list.find(tool => tool.name === name)?.annotations ?? {};
  if (hintsOf('delegate_result').destructiveHint !== true || hintsOf('delegate_merge').destructiveHint !== true ||
      hintsOf('delegate_wait').readOnlyHint !== true || hintsOf('delegate_status').readOnlyHint !== true) {
    console.error('FAIL: delegate tool annotations are wrong:', JSON.stringify({ result: hintsOf('delegate_result'), merge: hintsOf('delegate_merge'), wait: hintsOf('delegate_wait') }));
    failed = true;
  } else {
    console.log('delegate tool annotations OK (result and merge destructive, status and wait read-only)');
  }

  // Server instructions reach Claude even when tool definitions are deferred
  // (tool search). Claude Code truncates them at 2,048 chars, so they must fit,
  // and they must name every tool or Claude has to search blind for it.
  const instructions = (await waitFor(1, 5000))?.result?.instructions || '';
  const unnamed = list.map(t => t.name).filter(n => !instructions.includes(n));
  if (!instructions || instructions.length > 2048 || unnamed.length) {
    console.error('FAIL: server instructions missing, over 2048 chars, or not naming:', unnamed.join(', '), '(length', instructions.length + ')');
    failed = true;
  } else {
    console.log('server instructions OK -', instructions.length, 'chars, name all tools');
  }
  if (!instructions.includes("Background task run by Codex, agy or a local model instead of a Claude subagent. Use when the user names one of those workers or their models, or says 'through consult' / 'another model' / 'not Claude'.")) {
    console.error('FAIL: the server instructions lack the delegate routing text');
    failed = true;
  } else {
    console.log('server instructions carry the delegate routing text OK');
  }

  const callMsg = await waitFor(3, 10000);
  if (callMsg.error) {
    console.error('codex_login_status returned error:', JSON.stringify(callMsg.error));
  } else {
    const obj = unpack(callMsg);
    console.log('codex_login_status OK - body:', JSON.stringify(obj).slice(0, 200));
  }

  // A provider failure must come back as a tool RESULT with isError, so the
  // calling model reads it -- not as a JSON-RPC protocol error.
  const badCall = await waitFor(4, 10000);
  const badText = badCall?.result?.content?.[0]?.text ?? '';
  if (badCall.error || badCall.result?.isError !== true || !/reasoning_effort/.test(badText)) {
    console.error('FAIL: tool failure not returned as isError result:', JSON.stringify(badCall).slice(0, 400));
    failed = true;
  } else {
    console.log('tool error as isError result OK -', badText.slice(0, 80));
  }

  // An unknown tool is still a protocol error.
  const unknown = await waitFor(5, 10000);
  if (!unknown.error) {
    console.error('FAIL: unknown tool did not produce a protocol error:', JSON.stringify(unknown).slice(0, 300));
    failed = true;
  } else {
    console.log('unknown tool -> protocol error OK');
  }

  // An out-of-range timeout_s is refused before anything is spawned.
  const shortTimeout = await waitFor(6, 10000);
  const shortText = shortTimeout?.result?.content?.[0]?.text ?? '';
  if (shortTimeout?.result?.isError !== true || !/timeout_s must be between 30 and 1800/.test(shortText)) {
    console.error('FAIL: timeout_s: 5 was not refused as a tool error:', JSON.stringify(shortTimeout).slice(0, 300));
    failed = true;
  } else {
    console.log('timeout_s out of range -> isError OK');
  }

  // A bad delegate worker is an error result naming the choices, and starts nothing.
  const badWorker = await waitFor(7, 10000);
  const badWorkerText = badWorker?.result?.content?.[0]?.text ?? '';
  if (badWorker?.result?.isError !== true || !/codex, agy, local/.test(badWorkerText) || !/local:<nickname>/.test(badWorkerText)) {
    console.error('FAIL: delegate with a bad worker was not refused with the choices:', JSON.stringify(badWorker).slice(0, 400));
    failed = true;
  } else {
    console.log('delegate with a bad worker -> isError naming the choices OK');
  }

  // delegate_wait is not held to the 30 s floor of the ask tools' timeout_s.
  const waited = await waitFor(8, 10000);
  if (waited?.result?.isError === true || unpack(waited).timed_out !== false) {
    console.error('FAIL: delegate_wait with timeout_s: 1 failed:', JSON.stringify(waited).slice(0, 400));
    failed = true;
  } else {
    console.log('delegate_wait takes a 1 s timeout OK');
  }

  // The server beats from the start, into the delegate data folder.
  const serversFolder = path.join(delegateHome, 'servers');
  const beatFiles = fs.existsSync(serversFolder) ? fs.readdirSync(serversFolder) : [];
  if (beatFiles.length !== 1 || !/\.json$/.test(beatFiles[0])) {
    console.error('FAIL: the server wrote no single heartbeat file in the delegate data folder:', JSON.stringify(beatFiles));
    failed = true;
  } else {
    console.log('heartbeat file written OK');
  }

  // The start-up sweep settled the task whose supervisor was gone.
  const settleBy = Date.now() + 10000;
  while (readTask(orphan.id).state !== 'stopped' && Date.now() < settleBy) await new Promise(resolve => setTimeout(resolve, 100));
  const settled = readTask(orphan.id);
  if (settled.state !== 'stopped' || settled.stop_reason !== 'supervisor-died') {
    console.error('FAIL: the start-up sweep did not stop the task whose supervisor was gone:', JSON.stringify({ state: settled.state, stop_reason: settled.stop_reason }));
    failed = true;
  } else {
    console.log('start-up sweep stopped a task whose supervisor died OK');
  }
} finally {
  // kill() resolves once the server has exited and its own temp folder is removed.
  await kill();
  if (typeof scratchFolder !== 'string' || fs.existsSync(scratchFolder)) {
    console.error('FAIL: kill() did not wait for the server to exit and remove its temp folder:', scratchFolder);
    failed = true;
  } else {
    console.log('kill() waits for the exit and removes the temp folder OK');
  }
  try { fs.rmSync(delegateHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch (_) { /* the system clears the temp folder in time */ }
}

// The Claude Desktop extension runs the server with CONSULT_DELEGATE=off (its manifest sets it):
// no delegate tools, no delegate text in the instructions, no heartbeat or sweeps.
const desktopHome = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-smoke-off-'));
const desktop = startServer({ env: { CONSULT_DELEGATE: 'off', CONSULT_DELEGATE_HOME: desktopHome, CONSULT_DELEGATE_TEST_NO_SWEEP: '0' } });
try {
  await handshake(desktop.send, { clientName: 'smoke-off' });
  desktop.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  desktop.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delegate_status', arguments: {} } });
  const desktopList = (await desktop.waitFor(2, 20000))?.result?.tools ?? [];
  const desktopNames = desktopList.map(tool => tool.name).sort();
  const delegateListed = desktopNames.filter(name => name.startsWith('delegate'));
  if (desktopNames.length === 0 || delegateListed.length > 0) {
    console.error('FAIL: with CONSULT_DELEGATE=off tools/list is empty or has delegate tools:', delegateListed.join(', '));
    failed = true;
  } else {
    console.log('CONSULT_DELEGATE=off: no delegate tools in tools/list OK');
  }
  const desktopInstructions = (await desktop.waitFor(1, 5000))?.result?.instructions || '';
  if (desktopInstructions === '' || /delegate/i.test(desktopInstructions)) {
    console.error('FAIL: with CONSULT_DELEGATE=off the instructions are empty or mention delegate');
    failed = true;
  } else {
    console.log('CONSULT_DELEGATE=off: instructions carry no delegate text OK');
  }
  const desktopCall = await desktop.waitFor(3, 10000);
  if (!desktopCall.error) {
    console.error('FAIL: with CONSULT_DELEGATE=off a delegate tool call was not a protocol error:', JSON.stringify(desktopCall).slice(0, 300));
    failed = true;
  } else {
    console.log('CONSULT_DELEGATE=off: a delegate tool call is an unknown-tool error OK');
  }
  // The Desktop manifest lists tools for display; it must list what that server offers.
  const manifestNames = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')).tools.map(tool => tool.name).sort();
  if (JSON.stringify(manifestNames) !== JSON.stringify(desktopNames)) {
    console.error('FAIL: manifest.json tools differ from tools/list of the Desktop server:', JSON.stringify({ manifestNames, desktopNames }));
    failed = true;
  } else {
    console.log('manifest.json tool list matches the Desktop server OK');
  }
  const manifestEnv = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')).server?.mcp_config?.env;
  if (manifestEnv?.CONSULT_DELEGATE !== 'off') {
    console.error('FAIL: manifest.json server.mcp_config.env lacks CONSULT_DELEGATE: "off"');
    failed = true;
  } else {
    console.log('manifest.json sets CONSULT_DELEGATE=off OK');
  }
  // Give a heartbeat time to appear (the normal server writes one at once).
  await new Promise(resolve => setTimeout(resolve, 2000));
  if (fs.existsSync(path.join(desktopHome, 'servers'))) {
    console.error('FAIL: with CONSULT_DELEGATE=off the server wrote a heartbeat:', JSON.stringify(fs.readdirSync(path.join(desktopHome, 'servers'))));
    failed = true;
  } else {
    console.log('CONSULT_DELEGATE=off: no heartbeat written OK');
  }
} finally {
  await desktop.kill();
  try { fs.rmSync(desktopHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch (_) { /* the system clears the temp folder in time */ }
}
process.exit(failed ? 1 : 0);
