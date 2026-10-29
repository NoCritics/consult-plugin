// Live chat continuity test: starts a chat session with each participant,
// sends a follow-up that requires memory of the first turn, verifies recall.
// Costs real tokens on both providers. Run: node mcp/chat-test.js
import { startServer, unpack, handshake, toolError } from './test-helpers.js';

const { send, waitFor, kill } = startServer();

let nextId = 2;
async function runChatTest(participant, number) {
  const startId = nextId++;
  console.log(`\n[${participant}] Turn 1: chat_start with number ${number}...`);
  send({
    jsonrpc: '2.0', id: startId, method: 'tools/call',
    params: { name: 'consult_chat_start', arguments: { participant, prompt: `Remember the number ${number}. Reply with: OK.` } }
  });
  const r1 = await waitFor(startId, 180000);
  if (toolError(r1)) { console.error(`  ERROR:`, toolError(r1)); return false; }
  const o1 = unpack(r1);
  console.log(`  session_id=${o1.session_id} model=${o1.model} latency=${o1.latency_ms}ms`);
  console.log(`  response=${JSON.stringify(o1.response).slice(0, 200)}`);

  // Turn 2 runs inside try/finally so the session is deleted even when the
  // turn fails -- agy keeps ~600KB per conversation.
  try {
    const sendId = nextId++;
    console.log(`[${participant}] Turn 2: chat_send asking for number back...`);
    send({
      jsonrpc: '2.0', id: sendId, method: 'tools/call',
      params: { name: 'consult_chat_send', arguments: { participant, session_id: o1.session_id, prompt: 'What number did I just ask you to remember? Reply with just the digits.' } }
    });
    const r2 = await waitFor(sendId, 180000);
    if (toolError(r2)) { console.error(`  ERROR:`, toolError(r2)); return false; }
    const o2 = unpack(r2);
    console.log(`  session_id=${o2.session_id} model=${o2.model} latency=${o2.latency_ms}ms`);
    console.log(`  response=${JSON.stringify(o2.response).slice(0, 200)}`);

    const ok = new RegExp(number).test(o2.response);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${participant} ${ok ? 'recalled' : 'did NOT recall'} ${number}.`);
    return ok;
  } finally {
    const endId = nextId++;
    send({ jsonrpc: '2.0', id: endId, method: 'tools/call', params: { name: 'consult_chat_end', arguments: { participant, session_id: o1.session_id } } });
    await waitFor(endId, 30000).catch(() => {});
  }
}

try {
  await handshake(send, { clientName: 'chat-test' });
  const codexOk = await runChatTest('codex', 4271);
  const agyOk = await runChatTest('agy', 9183);
  console.log(`\nResult: codex=${codexOk ? 'PASS' : 'FAIL'}, agy=${agyOk ? 'PASS' : 'FAIL'}`);
  await kill();
  process.exit(codexOk && agyOk ? 0 : 1);
} catch (e) {
  console.error('test crashed:', e.message);
  await kill();
  process.exit(2);
}
