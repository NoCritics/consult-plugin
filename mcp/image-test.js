// Live test: agy_generate_image end to end through the MCP server. Checks that
// the images land in the output folder and that agy's conversation, and its
// image-generator subagent's, are gone afterwards. Costs real tokens, ~2 min.
// Run: node mcp/image-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, unpack, handshake, toolError } from './test-helpers.js';
import { detectImageType } from './lib/image.js';

const conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
const countConversations = () => fs.readdirSync(conversationsDir).filter(name => name.endsWith('.db')).length;
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-image-test-'));

const before = countConversations();
const { send, waitFor, kill } = startServer();
let failed = false;
try {
  await handshake(send, { clientName: 'image' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agy_generate_image', arguments: {
    prompt: 'A flat yellow star centred on a plain white background. One image.',
    output_dir: outDir
  } } });
  const reply = await waitFor(2, 330000);
  const err = toolError(reply);
  if (err) {
    console.error('FAIL: agy_generate_image error:', err);
    failed = true;
  } else {
    const result = unpack(reply);
    console.log(`agy_generate_image: ${result.images.length} image(s) in ${result.latency_ms}ms, model=${result.model}`);
    for (const image of result.images) {
      const ok = path.dirname(image.path) === outDir && fs.existsSync(image.path) && detectImageType(fs.readFileSync(image.path));
      console.log(`${ok ? 'PASS' : 'FAIL'} ${image.path} (${image.type}, ${image.width}x${image.height}, ${image.bytes} bytes)`);
      if (!ok) failed = true;
    }
    if (!result.images.length) { console.error('FAIL: no images returned'); failed = true; }
    if (/antigravity-cli[\\/]brain/i.test(result.agy_reply)) { console.error('FAIL: agy_reply still points into agy\'s brain folder'); failed = true; }
    console.log('agy_reply:', JSON.stringify(result.agy_reply).slice(0, 300));
  }
  const after = countConversations();
  if (after !== before) { console.error(`FAIL: ${after - before} agy conversation(s) left on disk`); failed = true; }
  else console.log(`PASS conversations unchanged (${before})`);
} finally {
  await kill();
}
console.log(`images kept in ${outDir}`);
console.log(failed ? 'FAILED' : 'ALL PASSED');
process.exit(failed ? 1 : 0);
