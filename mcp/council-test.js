// Live test: spawn the MCP server and run an actual council_vote tournament.
// COSTS REAL TOKENS - small prompt, but ~6 LLM calls total.
// Run: node mcp/council-test.js
import { startServer, unpack, handshake, toolError } from './test-helpers.js';

const { send, waitFor, kill } = startServer();

await handshake(send, { clientName: 'council' });
send({
  jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: {
    name: 'council_vote',
    arguments: {
      prompt: 'In a single short sentence, define what makes a piece of writing memorable.',
      verbose: true
    }
  }
});

try {
  let res;
  try { res = await waitFor(2, 240000); }
  catch (e) { console.error('FAIL:', e.message); await kill(); process.exit(1); }

  if (toolError(res)) {
    console.error('council_vote ERROR:', toolError(res));
    await kill();
    process.exit(1);
  }

  const obj = unpack(res);
  console.log('=== COUNCIL RESULT ===');
  console.log('total_latency_ms:', obj.total_latency_ms);
  console.log('degraded:', obj.degraded, 'tied:', obj.tied, 'tied_at_top:', obj.tied_at_top);
  console.log('failures:', obj.failures || 'none');
  console.log('judge_failures:', obj.judge_failures || 'none');
  console.log('scores:', JSON.stringify(obj.scores, null, 2));
  console.log('winner:', obj.winner, '(' + obj.winner_model + ')');
  console.log('winner_response:', obj.winner_response);
  if (obj.rankings) {
    console.log('\nrankings:');
    for (const r of obj.rankings) {
      console.log(' ', r.judge.padEnd(7), r.ranking.join(' > '));
    }
  }
  if (obj.candidates) {
    console.log('\ncandidates:');
    for (const [label, c] of Object.entries(obj.candidates)) {
      console.log(`  [${label}] ${c.model} (${c.latency_ms}ms): ${JSON.stringify(c.response).slice(0, 200)}`);
    }
  }
} finally {
  await kill();
}
process.exit(0);
