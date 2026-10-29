// Verify chat_end actually removes session files from disk. Starts a chat
// with each participant, locates the session file (proves it exists), calls
// chat_end, verifies the file is gone. Costs real tokens for the start call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, unpack, handshake, toolError } from './test-helpers.js';

const { send, waitFor, kill } = startServer();

function findSessionFiles(participant, session_id) {
  const matches = [];
  if (participant === 'agy') {
    // Flat layout: conversations/<uuid>.db{,-shm,-wal}
    const dir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) {}
    return names.filter(n => n.startsWith(session_id + '.db')).map(n => path.join(dir, n));
  }
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const needle = session_id;
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) {
        if (participant === 'codex' && e.name.includes(needle)) matches.push(p);
      }
    }
  };
  walk(root);
  return matches;
}

let nextId = 2;
async function runEndTest(participant) {
  const startId = nextId++;
  console.log(`\n[${participant}] chat_start...`);
  send({ jsonrpc: '2.0', id: startId, method: 'tools/call', params: { name: 'consult_chat_start', arguments: { participant, prompt: 'Reply: OK.' } } });
  const r1 = await waitFor(startId, 180000);
  if (toolError(r1)) { console.error('start ERROR:', toolError(r1)); return false; }
  const o1 = unpack(r1);
  console.log(`  session_id=${o1.session_id}`);

  const before = findSessionFiles(participant, o1.session_id);
  console.log(`  pre-end files on disk: ${before.length} (${before.map(p => path.basename(p)).join(', ') || 'none'})`);
  if (before.length === 0) {
    console.log(`  WARN: could not locate session file before deletion; layout assumption may be wrong.`);
  }

  const endId = nextId++;
  send({ jsonrpc: '2.0', id: endId, method: 'tools/call', params: { name: 'consult_chat_end', arguments: { participant, session_id: o1.session_id } } });
  const r2 = await waitFor(endId, 30000);
  if (toolError(r2)) { console.error('end ERROR:', toolError(r2)); return false; }
  const o2 = unpack(r2);
  console.log(`  end result: deleted=${o2.deleted} note=${o2.note}`);

  const after = findSessionFiles(participant, o1.session_id);
  console.log(`  post-end files on disk: ${after.length}`);

  // agy's `deleted` also counts its brain/<id>/ directory, which
  // findSessionFiles does not list -- so require "at least", and check the
  // brain dir is gone separately.
  const brainGone = participant !== 'agy' ||
    !fs.existsSync(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', o1.session_id));
  const ok = before.length > 0 && after.length === 0 && o2.deleted >= before.length && brainGone;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${participant} chat_end ${ok ? 'removed all matching files' : 'did not fully clean up'}.`);
  return ok;
}

try {
  await handshake(send, { clientName: 'chat-end-test' });
  const codexOk = await runEndTest('codex');
  const agyOk = await runEndTest('agy');
  console.log(`\nResult: codex=${codexOk ? 'PASS' : 'FAIL'}, agy=${agyOk ? 'PASS' : 'FAIL'}`);
  await kill();
  process.exit(codexOk && agyOk ? 0 : 1);
} catch (e) {
  console.error('test crashed:', e.message);
  await kill();
  process.exit(2);
}
