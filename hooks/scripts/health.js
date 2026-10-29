#!/usr/bin/env node
// The Claude Code mod's health check: runs the server's own status checks for
// the services named on the command line (codex, agy, local) and prints one
// JSON object, each service's status body or null when its check failed:
//   node health.js <project dir> codex agy local
//     ->  {"codex":{...},"agy":{...},"local":null}
//
// The project comes as an argument and the mod starts this in the plugin's
// own folder, so nothing planted in the project (a node.exe) is what runs.
//
// The mod runs this with $.process.run rather than calling the status tools
// through $.mcp.call: that goes through the permission check, which auto mode
// refuses at session start and default mode would ask the person about.
//
// Imports the server's lib like auth-check.js does: Node built-ins only.

// Same DEP0190 filter as auth-check.js; the output read is stdout alone.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.code === 'DEP0190') return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

import { codexLoginStatus } from '../../mcp/lib/codex.js';
import { agyStatus } from '../../mcp/lib/agy.js';
import { isLoopback, localStatus } from '../../mcp/lib/local.js';
import { loadSettings, runnerSettings } from '../../mcp/lib/settings.js';
import { runnerKey, swapStatus } from '../../mcp/lib/local-runners.js';

// Each under the mod's 15 s limit, so a slow service still leaves the others.
const CODEX_TIMEOUT_MS = 10000;
const AGY_TIMEOUT_MS = 12000;

async function checkOrNull(check) {
  try {
    return await check();
  } catch (_) {
    return null;
  }
}

async function main() {
  const [project, ...services] = process.argv.slice(2);
  // loadSettings reads the project's file from the working directory.
  const startedIn = process.cwd();
  process.chdir(project);
  const settings = loadSettings();
  process.chdir(startedIn);
  const checks = {};
  if (services.includes('codex')) {
    checks.codex = checkOrNull(() => codexLoginStatus({ timeout_ms: CODEX_TIMEOUT_MS }));
  }
  if (services.includes('agy')) {
    checks.agy = checkOrNull(() => agyStatus({ timeout_ms: AGY_TIMEOUT_MS }));
  }
  // This check runs unasked at every session start: a runner off this
  // machine (a project file can name any host) is never contacted.
  // The runner in use (runner settings come from the global file only).
  const runner = runnerSettings(settings);
  if (services.includes('local') && isLoopback(runner.url)) {
    checks.local = checkOrNull(async () => {
      const { api_key } = await runnerKey(runner);
      if (runner.type === 'llama-swap') return swapStatus(runner, api_key);
      return localStatus({
        base_url: runner.url,
        api_key,
        configured_model: runner.nicknames.default,
      });
    });
  }
  const bodies = {};
  for (const service of services) {
    bodies[service] = service in checks ? await checks[service] : null;
  }
  process.stdout.write(JSON.stringify(bodies) + '\n');
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`consult health: ${error?.message ?? error}\n`);
    process.exit(1);
  }
);
