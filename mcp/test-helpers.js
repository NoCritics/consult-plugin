// Shared boilerplate for the integration test scripts. Each spins up the MCP
// server as a subprocess, drives it over stdio, and parses framed responses
// from the accumulated buffer. Keeping this in one place keeps the individual
// tests focused on the assertion -- not the JSON-RPC framing.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the server relative to THIS file, not the caller's cwd. Tests are run
// both from the repo root (`node mcp/unit-test.js`) and from mcp/ (`npm test`),
// and a cwd-relative path only works from one of them.
const SERVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'consult.js');

// The server writes a heartbeat, sweeps delegate tasks and prunes worktrees when
// it starts, so a test server gets its own delegate data, projects file and
// project folder unless the test names them, and does no sweeps (a test that
// wants them sets CONSULT_DELEGATE_TEST_NO_SWEEP=0). Never the user's real files.
// (The codex home stays: the live tests need the user's codex login.)
function isolatedServerEnv(scratchFolder) {
  const env = { ...process.env };
  const isolated = {
    CONSULT_DELEGATE_HOME: path.join(scratchFolder, 'delegate'),
    CONSULT_PROJECTS_FILE: path.join(scratchFolder, 'consult-projects.json'),
    CLAUDE_PROJECT_DIR: path.join(scratchFolder, 'project'),
    CONSULT_DELEGATE_TEST_NO_SWEEP: '1'
  };
  for (const [name, value] of Object.entries(isolated)) {
    if (env[name] === undefined) env[name] = value;
  }
  return env;
}

// `env` names variables set for this server whatever the test process has.
export function startServer({ cwd = process.cwd(), tagStderr = true, env = {} } = {}) {
  const scratchFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-server-test-'));
  fs.mkdirSync(path.join(scratchFolder, 'project'));
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: { ...isolatedServerEnv(scratchFolder), ...env } });
  // Tests call kill() and then exit at once, so the folder is removed in kill() too (not only on 'exit').
  const removeScratchFolder = () => {
    try { fs.rmSync(scratchFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch (_) { /* the temp folder is cleared by the system in time */ }
  };
  child.on('exit', removeScratchFolder);
  let buf = '';
  child.stdout.on('data', d => { buf += d.toString('utf8'); });
  if (tagStderr) {
    child.stderr.on('data', d => process.stderr.write('[server stderr] ' + d));
  }

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

  const waitFor = (id, timeoutMs = 180000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) return resolve(msg);
        } catch (_) {}
      }
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for id=${id}`));
      setTimeout(tick, 250);
    };
    tick();
  });

  // Resolves once the server has exited (termination is asynchronous, on Windows especially) and
  // its temp folder is gone. Callers await it before they exit.
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((resolve) => child.once('exit', resolve));
      try { child.kill('SIGKILL'); } catch (_) {}
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 10000))]);
    }
    removeScratchFolder();
  };
  const getBuf = () => buf;

  return { child, send, waitFor, kill, getBuf, scratchFolder };
}

// MCP responses wrap content as `{ result: { content: [{ type: 'text', text }] } }`.
// Tools in this server always return JSON text -- unpack parses it. Throws if
// the response has no text payload (caller should check `result.error` first).
// Since v0.8.0 a provider failure comes back as a tool result with isError
// (only unknown tools are protocol errors). Returns the error text from either
// form, or null on success -- live tests check this before unpack().
export function toolError(msg) {
  if (msg?.error) return JSON.stringify(msg.error).slice(0, 800);
  if (msg?.result?.isError) return String(msg.result.content?.[0]?.text ?? '(no text)').slice(0, 800);
  return null;
}

export function unpack(msg) {
  const txt = msg?.result?.content?.[0]?.text;
  if (!txt) throw new Error(`no text in result: ${JSON.stringify(msg).slice(0, 500)}`);
  return JSON.parse(txt);
}

// A local HTTP server for tests: `routes` maps "METHOD /path" to a function
// (request, body) -> { status, json | text, headers }. Records every request.
export async function fakeServer(routes) {
  const http = await import('node:http');
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const pathOnly = request.url.split('?')[0];
      requests.push({ method: request.method, path: pathOnly, headers: request.headers, body });
      const route = routes[`${request.method} ${pathOnly}`];
      if (!route) { response.writeHead(404); response.end('404 page not found'); return; }
      const answer = route(request, body);
      if (typeof answer.stream === 'function') { answer.stream(response); return; }
      response.writeHead(answer.status ?? 200, { 'Content-Type': answer.json !== undefined ? 'application/json' : 'text/plain', ...(answer.headers ?? {}) });
      response.end(answer.json !== undefined ? JSON.stringify(answer.json) : (answer.text ?? ''));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const close = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  return { root: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/v1`, requests, close };
}

// Convenience: send initialize + initialized notification. Returns when the
// server has had a chance to process them (small fixed delay -- the server
// doesn't ack the notification).
export async function handshake(send, { clientName = 'test', clientVersion = '0.0.0', delayMs = 300 } = {}) {
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: clientName, version: clientVersion } }
  });
  await new Promise(r => setTimeout(r, delayMs));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
