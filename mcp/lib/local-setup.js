// local_setup's work, shared by the MCP tool (consult.js) and the Claude Code
// mod's Local models tab (hooks/scripts/setlocal.js), so the two can't drift.
import os from 'node:os';

import { isLoopback } from './local.js';
import { proposeNicknames, describeFact, ollamaArch, NICKNAME_ROLES, NICKNAME_SPELLINGS } from './local-models.js';
import { measuredSpeed } from './local-speeds.js';
import {
  PROBE_URLS, isValidEnvName, runnerKey, runnerInventory, otherRunners, probeRunners, proposeSwapNicknames, saveRunnerSettings,
  unloadRunner, runnersHolding, mayReadSuppliedKey, sameUrl, isLmstudioInventory
} from './local-runners.js';
import { loadSettings, runnerSettings, runnerFor, configuredRunners } from './settings.js';
import { guardUnload } from './delegate-local.js';

// Ollama's (or LM Studio's) models in the shape llama-swap's proposal lists
// them, so the chat table and the pane's pickers can name and describe every model.
export function ollamaModels(facts, engine = 'Ollama') {
  const models = [];
  for (const fact of facts) {
    models.push({ id: fact.name, name: fact.label ?? fact.name, description: describeFact(fact), vision: fact.vision, arch: fact.arch ?? null, engine, decode_tps: null });
  }
  return models;
}

// A runner that passes names through proposes nothing: its rows say only
// what is saved, so the pane can draw a picker per nickname.
function passThroughRows(nicknames) {
  const rows = [];
  for (const role of NICKNAME_ROLES) {
    const saved = nicknames[role] ?? null;
    rows.push({ role, rule: null, rule_pick: [], proposed: [], saved, saved_state: saved === null ? 'none' : 'kept', replacement: null, reason: '' });
  }
  return rows;
}

// The settings lines a local_setup call asks to write, each model checked
// against the runner's list (stored by id, never an alias).
function setupChanges(type, args, inventory, discovered) {
  const changes = {};
  const problems = [];
  for (const [role, value] of Object.entries(args.save ?? {})) {
    const field = NICKNAME_SPELLINGS[role];
    if (!field) { problems.push(`\`${role}\` is not a nickname (use default, fast, vision, vision-best or big)`); continue; }
    if (value === null) { changes[`${type}.${field}`] = null; continue; }
    let stored = null;
    if (type === 'llama-swap' || type === 'ollama' || type === 'lmstudio') {
      if (!Array.isArray(inventory)) { problems.push(`${type}'s model list can't be read, so \`${value}\` can't be checked`); continue; }
      for (const fact of inventory) {
        const own = type === 'ollama' ? fact.name : fact.id;
        if (own === value || fact.aliases.includes(value)) stored = own;
      }
    } else if (typeof value === 'string' && value.trim() !== '') {
      stored = value;
    }
    if (stored === null) problems.push(`\`${value}\` (for ${role}) is not listed by ${type}`);
    else changes[`${type}.${field}`] = stored;
  }
  // A key pasted where its variable's name belongs is refused, and not repeated.
  if (args.key_env !== undefined && args.key_env !== null && !isValidEnvName(args.key_env)) {
    problems.push('the key variable is not a variable name (type the NAME of the variable that holds the key, e.g. LLAMA_SWAP_API_KEY, never the key)');
  }
  for (const field of ['url', 'key_env', 'start']) {
    if (args[field] !== undefined) changes[`${type}.${field}`] = args[field];
  }
  // A runner found by the probe but not yet in the settings: its address and
  // key variable go in with the first write, so the diff shows them.
  if (discovered.url && changes[`${type}.url`] === undefined) changes[`${type}.url`] = discovered.url;
  if (discovered.key_env && changes[`${type}.key_env`] === undefined) changes[`${type}.key_env`] = discovered.key_env;
  if (args.use === true) changes.local_runner = type;
  if (problems.length > 0) throw new Error(`Nothing was saved: ${problems.join('; ')}.`);
  return changes;
}

// `home`, `reloadSettings` and `probeUrls` are for tests: the person's home,
// their settings after a write, and the standard ports.
export async function setupLocal(args, settings, { home = os.homedir(), reloadSettings = loadSettings, probeUrls = PROBE_URLS } = {}) {
  // A tool call never points consult off this machine, nor contacts such an
  // address: a remote runner is a line the person writes by hand.
  if (args.url !== undefined && !isLoopback(args.url)) {
    throw new Error(`Setup only uses addresses on this machine; ${args.url} is not one. A remote runner is added by editing ~/.claude/consult.local.md by hand.`);
  }
  const configured = configuredRunners(settings);
  const inUse = runnerSettings(settings);
  const probe = await probeRunners({ urls: probeUrls, configured, trySwapKey: true, swapKeyUrls: probeUrls });
  const type = args.runner ?? inUse.type;
  const configuredSummary = [];
  for (const runner of configured) configuredSummary.push({ type: runner.type, url: runner.url, in_use: runner.type === inUse.type });
  const overview = {
    probe,
    configured: configuredSummary,
    in_use: inUse.type,
    settings_warnings: settings._warnings ?? []
  };
  if (!type) return { ...overview, runner: null, proposal: null, note: 'No runner is in use: pick one of the runners found (or give its address) and call again with `runner`.' };

  const savedRunner = runnerSettings(settings, type);
  let runner = savedRunner;
  const known = configured.some(one => one.type === type);
  const discovered = { url: null, key_env: null };
  if (args.url !== undefined) runner = { ...runner, url: args.url };
  // A saved key belongs to the address it was saved for: a new address gets it
  // only when this call names the variable again (also in what is written).
  const movesToNewUrl = args.url !== undefined && args.key_env === undefined && !sameUrl(args.url, savedRunner.url);
  if (movesToNewUrl) runner = { ...runner, key_env: null };
  if (args.key_env !== undefined) runner = { ...runner, key_env: args.key_env };
  if (args.start !== undefined) runner = { ...runner, start: args.start };
  if (!known || runner.url === null) {
    for (const found of probe) {
      if (found.type !== type || !found.up) continue;
      if (runner.url === null || (!known && args.url === undefined)) {
        if (runner.url !== found.url) discovered.url = found.url;
        runner = { ...runner, url: found.url };
      }
      // Not for a new address: a key variable found on the standard port stays there.
      if (!runner.key_env && found.key_env && sameUrl(runner.url, found.url)) {
        discovered.key_env = found.key_env;
        runner = { ...runner, key_env: found.key_env };
      }
      break;
    }
  }
  if (runner.url === null) {
    return { ...overview, runner: type, proposal: null, note: `${type} wasn't found on this machine and has no standard address: ask the user for its address and call again with \`url\`.` };
  }
  // A key variable named in this call (not saved yet) is read only for a
  // runner that asked for a key at a standard or configured address: a tool
  // call can't send an arbitrary variable to an arbitrary local port.
  let keyRunner = runner;
  const suppliedKeyEnv = args.key_env !== undefined && args.key_env !== savedRunner.key_env;
  if (suppliedKeyEnv && !mayReadSuppliedKey({ url: runner.url, probe, configured })) keyRunner = { ...runner, key_env: null };
  const { api_key } = await runnerKey(keyRunner);
  const inventory = await runnerInventory(runner, api_key, settings);
  // Ollama says MoE or dense per model; asked here, for the listing, not on each call.
  if (type === 'ollama' && Array.isArray(inventory)) {
    await Promise.all(inventory.map(async fact => { fact.arch = await ollamaArch(runner.url, fact.name); }));
  }
  const writing = args.save !== undefined || args.use !== undefined || args.url !== undefined || args.key_env !== undefined || args.start !== undefined;
  let written = null;
  if (writing) {
    const changes = setupChanges(type, args, inventory, discovered);
    if (movesToNewUrl) changes[`${type}.key_env`] = null;
    written = saveRunnerSettings({ changes, home, preview: args.preview === true });
  }
  // After a write the file changed: read it again so the proposal shows the new state.
  const nicknames = written && args.preview !== true ? runnerSettings(reloadSettings(), type).nicknames : runner.nicknames;
  let proposal = null;
  if (type === 'llama-swap' && Array.isArray(inventory)) proposal = proposeSwapNicknames(inventory, nicknames);
  else if (type === 'ollama' && Array.isArray(inventory)) proposal = { ...proposeNicknames(inventory, nicknames), models: ollamaModels(inventory) };
  else if (type === 'lmstudio' && isLmstudioInventory(inventory)) proposal = { ...proposeNicknames(inventory, nicknames), models: ollamaModels(inventory, 'LM Studio') };
  else if (Array.isArray(inventory)) proposal = { rows: passThroughRows(nicknames), models: inventory, note: `${type} passes model names through: save a \`default\` to use one without naming it.` };
  // A model with no speed written down gets the one measured on this
  // machine's own calls, if any.
  if (proposal !== null && Array.isArray(proposal.models)) {
    const models = [];
    for (const entry of proposal.models) {
      const model = typeof entry === 'string' ? { id: entry } : entry;
      const measured = model.decode_tps === undefined || model.decode_tps === null ? measuredSpeed({ home, runner: type, model: model.id }) : null;
      if (measured !== null) models.push({ ...model, measured_tps: measured });
      else models.push(entry);
    }
    proposal = { ...proposal, models };
  }
  const otherLoaded = await otherRunners({ configured, exceptUrl: runner.url, urls: probeUrls });
  return {
    ...overview,
    runner: type,
    url: runner.url,
    reachable: inventory !== null,
    // What is saved for this runner, whether or not it is running: a pane
    // shows these when there is no proposal to pick from.
    saved_nicknames: nicknames,
    start: runner.start,
    proposal,
    other_loaded: runnersHolding(otherLoaded),
    ...(written ? { [args.preview === true ? 'preview' : 'saved']: written } : {})
  };
}

// local_unload: the runner named (or the one in use) frees its memory.
export async function unloadLocal(runnerName, settings) {
  const runner = runnerFor(settings, runnerName);
  guardUnload({ runner });
  const { api_key } = await runnerKey(runner);
  return { runner: runner.type, url: runner.url, ...(await unloadRunner(runner, api_key)) };
}
