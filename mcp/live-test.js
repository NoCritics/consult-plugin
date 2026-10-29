// Live test: spawn the MCP server, fire ask_codex and ask_agy,
// confirm both round-trips work. This DOES cost real tokens.
// Run: node mcp/live-test.js
import { startServer, unpack, handshake, toolError } from './test-helpers.js';

const { send, waitFor, kill } = startServer();

await handshake(send, { clientName: 'live' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_codex', arguments: { prompt: 'Reply with exactly the four characters: PING' } } });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_agy', arguments: { prompt: 'Reply with exactly the four characters: PING' } } });

try {
  for (const [id, label] of [[2, 'ask_codex'], [3, 'ask_agy']]) {
    let r;
    try { r = await waitFor(id, 120000); }
    catch (e) { console.error(`FAIL: ${label} - ${e.message}`); continue; }
    const err = toolError(r);
    if (err) { console.error(`${label} ERROR:`, err); continue; }
    try {
      const obj = unpack(r);
      console.log(`${label}: model=${obj.model} latency=${obj.latency_ms}ms response=${JSON.stringify(obj.response).slice(0, 100)}`);
    } catch (e) {
      console.log(`${label} (unpack failed):`, e.message);
    }
  }
} finally {
  await kill();
}
process.exit(0);
