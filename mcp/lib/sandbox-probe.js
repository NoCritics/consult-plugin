// Runs INSIDE `codex sandbox -c sandbox_mode=workspace-write` (started by
// sandboxCheck in delegate-fence.js) and prints one JSON line:
//   { cwdWritable, homeRefused, internetRefused, loopbackOpen, childHomeRefused }
// The sandbox is trustworthy for pi only when all five are true. A null means
// the probe could not tell, which the caller treats as inconclusive (not cached).
// Self-contained on purpose: it imports nothing from consult.

import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const homeProbePath = path.join(os.homedir(), '.consult-sandbox-probe-' + process.pid);

function removeQuietly(target) {
  try { fs.rmSync(target, { force: true }); } catch (_) { /* nothing to remove */ }
}

// true: the sandbox refused (EACCES or EPERM). false: the page was reached.
// null: inconclusive (offline, a failed lookup, a timeout, a reset...), which
// the caller must not cache as a pass or a fail.
function internetIsRefused() {
  return new Promise((resolve) => {
    const request = https.get('https://example.com', { timeout: 5000 }, (response) => {
      response.resume();
      resolve(false);
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', (error) => resolve(error.code === 'EACCES' || error.code === 'EPERM' ? true : null));
  });
}

function loopbackIsOpen() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 1 });
    socket.setTimeout(5000, () => { socket.destroy(); resolve(false); });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    // Nothing listens on port 1, so a working loopback answers ECONNREFUSED.
    // EACCES means the sandbox blocked the attempt itself.
    socket.on('error', (error) => resolve(error.code === 'ECONNREFUSED'));
  });
}

// The child must prove it ran: it prints CHILD_REFUSED (exit 3) only when its
// own write was refused with EPERM or EACCES. A child that never started, or
// died some other way, is not a refusal.
function childIsRefused() {
  const script = 'try { require("fs").writeFileSync(process.argv[1], "probe"); console.log("CHILD_WROTE"); }'
    + ' catch (error) { if (error.code === "EPERM" || error.code === "EACCES") { console.log("CHILD_REFUSED"); process.exit(3); } throw error; }';
  const finished = spawnSync(process.execPath, ['-e', script, homeProbePath], { timeout: 10000, encoding: 'utf8' });
  return finished.status === 3 && String(finished.stdout).includes('CHILD_REFUSED');
}

// true: the write was refused with EPERM or EACCES, as childIsRefused requires of
// the child. false: it was written. null: it failed some other way (a missing home
// folder, a disk error), which says nothing about the sandbox.
function writeIsRefused(target) {
  try {
    fs.writeFileSync(target, 'probe');
    removeQuietly(target);
    return false;
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return true;
    return null;
  }
}

// Anything but a clean write reads as not writable.
const cwdWritable = writeIsRefused(path.join(process.cwd(), '.consult-sandbox-probe-' + process.pid)) === false;
const homeRefused = writeIsRefused(homeProbePath);
const [internetRefused, loopbackOpen] = await Promise.all([internetIsRefused(), loopbackIsOpen()]);
const childHomeRefused = childIsRefused();
removeQuietly(homeProbePath);

console.log(JSON.stringify({ cwdWritable, homeRefused, internetRefused, loopbackOpen, childHomeRefused }));
