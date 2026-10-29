#!/usr/bin/env node
// The Claude Code mod's Local models tab: runs local_setup's own code
// (mcp/lib/local-setup.js) and prints one JSON object, the same object the
// tool returns:
//   node setlocal.js <project dir> show [runner]
//   node setlocal.js <project dir> preview '{"runner":"llama-swap","save":{"fast":"fast"}}'
//   node setlocal.js <project dir> save '{"runner":"llama-swap","save":{"fast":"fast"},"use":true}'
//   node setlocal.js <project dir> unload <runner>
// A refusal (bad JSON, an unknown command, a change setup won't make) prints
// {"error": "<message>"} and exits 0; only a crash exits 1.
//
// The project comes as an argument and the mod starts this in the plugin's
// own folder, so nothing planted in the project (a node.exe) is what runs.
// Like health.js it is run with $.process.run, not $.mcp.call (the permission
// check would refuse or ask). It reads a runner's key itself from the
// variable the settings name; the key is never in argv or in what it prints.
//
// Node built-ins and the server's lib only.

// Same DEP0190 filter as auth-check.js; the output read is stdout alone.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.code === 'DEP0190') return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

import { setupLocal, unloadLocal } from '../../mcp/lib/local-setup.js';
import { keepBackup } from '../../mcp/lib/local-runners.js';
import { loadSettings } from '../../mcp/lib/settings.js';

// loadSettings reads the project's file from the working directory.
function settingsOf(project) {
  const startedIn = process.cwd();
  process.chdir(project);
  try {
    return loadSettings();
  } finally {
    process.chdir(startedIn);
  }
}

function changeFrom(text) {
  let change;
  try {
    change = JSON.parse(text);
  } catch (_) {
    throw new Error('the change is not JSON');
  }
  if (change === null || typeof change !== 'object' || Array.isArray(change)) throw new Error('the change must be a JSON object');
  return change;
}

async function answer(project, command, argument) {
  const settings = settingsOf(project);
  const reloadSettings = () => settingsOf(project);
  if (command === 'show') {
    return setupLocal(argument ? { runner: argument } : {}, settings, { reloadSettings });
  }
  if (command === 'preview') {
    return setupLocal({ ...changeFrom(argument), preview: true }, settings, { reloadSettings });
  }
  if (command === 'save') {
    const change = changeFrom(argument);
    delete change.preview;
    if (change.keep_backup === true) keepBackup();
    delete change.keep_backup;
    return setupLocal(change, settings, { reloadSettings });
  }
  if (command === 'unload') {
    return unloadLocal(argument, settings);
  }
  throw new Error(`unknown command \`${command}\` (show, preview, save or unload)`);
}

async function main() {
  const [project, command, argument] = process.argv.slice(2);
  let result;
  try {
    result = await answer(project, command, argument);
  } catch (error) {
    result = { error: error.message };
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

// No process.exit(): called while fetch's connections are still closing it
// trips a libuv assertion on Windows and the run dies with a crash code.
// The process ends by itself once the connections close.
main().then(
  () => { process.exitCode = 0; },
  (error) => {
    process.stderr.write(`setlocal.js: ${error.message}\n`);
    process.exitCode = 1;
  }
);
