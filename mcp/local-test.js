// Integration test against a real local model runner. Unlike live-test.js /
// council-test.js this costs NOTHING -- inference happens on this machine --
// so it is safe to run on every change.
//
// Not wired into CI: a GitHub runner would have to pull a multi-GB model first.
// Run locally: node mcp/local-test.js
//
// Skips (exit 0) rather than fails when no runner is listening, so it can sit
// in a pre-commit sequence without breaking machines that have no local setup.
import { startServer, unpack, handshake, toolError } from './test-helpers.js';
import { localStatus } from './lib/local.js';
import { loadSettings, runnerSettings } from './lib/settings.js';
import { runnerKey, swapStatus, resolveSwapModel } from './lib/local-runners.js';

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (cond ? '' : `\n  ${detail}`));
  if (!cond) failed++;
};

const settings = loadSettings();
const runner = runnerSettings(settings);
let model;

if (runner.type === 'llama-swap') {
  // --- llama-swap: `fast` only, and only when it can't swap out a model the
  // user is working with (nothing loaded, or `fast`'s model already loaded).
  const { api_key } = await runnerKey(runner);
  const status = await swapStatus(runner, api_key);
  if (!status.reachable || !Array.isArray(status.models)) {
    console.log(`SKIP: llama-swap at ${runner.url} isn't usable (${status.reason}).`);
    console.log(`      ${status.details}`);
    process.exit(0);
  }
  let fast;
  try { fast = resolveSwapModel('fast', status.models, runner.nicknames).model; }
  catch (e) {
    console.log(`SKIP: no \`fast\` model on llama-swap (${e.message}).`);
    process.exit(0);
  }
  if (status.loaded === null) {
    console.log(`SKIP: llama-swap didn't say which model is loaded; the test could swap out one you're using.`);
    process.exit(0);
  }
  const others = status.loaded.filter(name => name !== fast);
  if (others.length > 0) {
    console.log(`SKIP: llama-swap has ${others.join(', ')} loaded; the test would swap it out for ${fast}.`);
    process.exit(0);
  }
  model = 'fast';
  console.log(`Runner: llama-swap at ${runner.url}`);
  console.log(`Using:  fast (${fast})\n`);
} else {
  // --- Pre-flight: is anything actually listening? ---
  const status = await localStatus({
    base_url: runner.url,
    api_key: (await runnerKey(runner)).api_key,
    configured_model: runner.nicknames.default
  });

  if (!status.reachable) {
    console.log(`SKIP: no local runner at ${status.base_url} (${status.reason}).`);
    console.log(`      ${status.details}`);
    process.exit(0);
  }
  if (!status.models.length) {
    console.log(`SKIP: runner at ${status.base_url} is up but has no models pulled.`);
    process.exit(0);
  }

  // Prefer the configured model; otherwise take whatever the runner has. Picking
  // the smallest available keeps the test fast -- the tag usually encodes size
  // (qwen3.5:2b < qwen3.5:9b), so a plain sort by length-then-name is a decent
  // heuristic without hardcoding model names.
  const configured = runner.nicknames.default;
  model = (configured && status.models.includes(configured))
    ? configured
    : [...status.models].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];

  console.log(`Runner: ${status.base_url}`);
  console.log(`Models: ${status.models.join(', ')}`);
  console.log(`Using:  ${model}\n`);
}

const { send, waitFor, kill } = startServer();
await handshake(send, { clientName: 'local-test' });

try {
  // 1. local_status over MCP
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'local_status', arguments: {} } });
  const st = unpack(await waitFor(2, 20000));
  ok('local_status reports reachable', st.reachable === true, JSON.stringify(st).slice(0, 200));
  ok('local_status lists models', Array.isArray(st.models) && st.models.length > 0, JSON.stringify(st.models));
  ok('local_status names the runner', typeof st.runner === 'string', JSON.stringify(st.runner));

  // 2. ask_local round-trip with thinking disabled (fast + deterministic-ish)
  send({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'ask_local', arguments: { prompt: 'Reply with exactly: PONG', model, reasoning_effort: 'none' } }
  });
  const r3 = await waitFor(3, 180000);
  if (toolError(r3)) {
    ok('ask_local round-trip', false, toolError(r3).slice(0, 300));
  } else {
    const a = unpack(r3);
    ok('ask_local returns a response', typeof a.response === 'string' && a.response.length > 0, JSON.stringify(a).slice(0, 200));
    ok('ask_local says PONG', /pong/i.test(a.response), `got: ${JSON.stringify(a.response).slice(0, 120)}`);
    ok('ask_local reports token usage', typeof a.tokens?.completion === 'number', JSON.stringify(a.tokens));
    ok('reasoning_effort=none suppresses reasoning', a.reasoning_chars === 0, `reasoning_chars=${a.reasoning_chars}`);
    ok('no <think> leaks into response', !/<\/?think/i.test(a.response), JSON.stringify(a.response).slice(0, 120));
    console.log(`     (${a.latency_ms}ms, ${a.tokens?.completion} completion tokens, model=${a.model})`);
  }

  // 3. Unknown model -> actionable 404, not a raw HTTP dump
  send({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'ask_local', arguments: { prompt: 'hi', model: 'definitely-not-pulled:0b' } }
  });
  const r4 = await waitFor(4, 30000);
  const msg4 = toolError(r4) || JSON.stringify(r4.result);
  ok('unknown model gives an actionable error', /not available|pull|lists no model/i.test(msg4), msg4.slice(0, 200));

  // 4. Empty prompt is rejected before any network call
  send({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'ask_local', arguments: { prompt: '   ', model } }
  });
  const r5 = await waitFor(5, 15000);
  const msg5 = toolError(r5) || JSON.stringify(r5.result);
  ok('blank prompt rejected', /required/i.test(msg5), msg5.slice(0, 200));
} finally {
  await kill();
}

console.log('\n' + (failed === 0 ? 'ALL PASSED' : `${failed} FAIL(S)`));
process.exit(failed === 0 ? 0 : 1);
