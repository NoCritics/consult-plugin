// The three delegate workers' command lines and output parsers. Pure: nothing
// here spawns a process. The supervisor takes workerCommand's result, spawns it
// the way spawn-cli.js does (spawnableCmd(cmd), shellSafeArgs(args),
// SPAWN_OPTS, cwd), feeds it stdinText, and hands the output lines to
// parseWorkerStream.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCmd, SPAWN_OPTS } from './resolve-cmd.js';
import { validateModel, validateReasoningEffort, validateSessionId } from './util.js';
import { hookArgs, reasoningCfg, findRolloutFile, codexHome } from './codex.js';
import { validateAgyEffort, parseAgyErrorLine, isPartialOutput, printTimeoutSeconds } from './agy.js';
import { CMD_UNSAFE_RE } from './spawn-cli.js';
import { prepareRunnerCall, isValidEnvName } from './local-runners.js';
import { isLoopback, validateBaseUrl } from './local.js';
import { parseWorkerWord } from './delegate-route.js';
import { taskFolder, taskFence, narrowerFence, projectSettings, fenceProtectedPaths, holdsConsultFiles } from './delegate-store.js';
import { realPathOfTarget, isInside } from './pi-fence.js';
import { rateLimitsFromTail } from './delegate-limits.js';
import { SANDBOX_ENV_POLICY_ARGS } from './delegate-fence.js';

export { lastRateLimitsIn } from './delegate-limits.js';

// What every worker is told before the brief. A read task is told, in words,
// to change nothing: only codex's sandbox and pi's tool set enforce it.
export function workerPreamble(folder, isWrite = true, worker = null, fence = null, layer = null) {
  const noCommands = worker === 'agy' ? " You can't run commands here (no git, tests or builds): check your work by reading the files." : '';
  if (fence === 'full' || fence === 'none') {
    if (!isWrite) {
      return `You are working alone on a delegated task. The project is in this folder: ${folder}. You may read files anywhere on this PC. ` +
        'This is a read-only task: answer in text. Do not create, edit or delete any files, ' +
        `and do not run git commit, push, stash, checkout or reset.${noCommands} When you finish, end with a short summary of your findings: ` +
        'what you looked at, what you found, and anything you could not check.';
    }
    return `You are working alone on a delegated task. The project is in this folder: ${folder}. You may work outside it on this PC when the task needs it. ` +
      `Do not run git commit, push, stash, checkout or reset.${noCommands} When you finish, end with a short summary: ` +
      `what you changed (files), how you checked it, and anything left undone. List every file you changed outside ${folder} by its full path.`;
  }
  let refusal = '';
  if (fence === 'fenced' && (layer === 'agy' || layer === 'sandbox')) refusal = ' Writes outside this folder are refused.';
  if (fence === 'fenced' && layer === 'guard') refusal = ' File edits outside this folder are refused.';
  if (!isWrite) {
    return `You are working alone on a delegated task. Work only inside this folder: ${folder}.${refusal} ` +
      'This is a read-only task: answer in text. Do not create, edit or delete any files, ' +
      'and do not run git commit, push, stash, checkout or reset.' + noCommands + ' When you finish, end with a short summary of your findings: ' +
      'what you looked at, what you found, and anything you could not check.';
  }
  return `You are working alone on a delegated task. Work only inside this folder: ${folder}.${refusal} ` +
    `Do not run git commit, push, stash, checkout or reset.${noCommands} When you finish, end with a short summary: ` +
    'what you changed (files), how you checked it, and anything left undone.';
}

// Put before a follow-up (or the continue prompt) of a read task, which the
// worker's session would otherwise treat as a licence to edit.
export const READ_ONLY_REMINDER = 'This is still a read-only task: answer in text and do not create, edit or delete any files.';

// What a resumed worker is told when nobody wrote a follow-up (a task resumed
// after a limit pause, say).
export const CONTINUE_PROMPT = 'Continue the task from where you stopped, and finish it.';

const PI_PROVIDER_PATH = fileURLToPath(new URL('./pi-provider.js', import.meta.url));
const PI_FENCE_PATH = fileURLToPath(new URL('./pi-fence.js', import.meta.url));
const MIN_CONTEXT_TOKENS = 16384;

// pi's own read-only set (createReadOnlyTools in its core/tools/index.js, and
// the `--tools read,grep,find,ls` example in its --help): no write, edit, bash
// or powershell.
const PI_READ_ONLY_TOOLS = 'read,grep,find,ls';

// An id that starts with `-` would be read by the worker's CLI as a flag.
export function requireModelId(model) {
  validateModel(model);
  if (typeof model === 'string' && model.startsWith('-')) {
    throw new Error(`Model id ${JSON.stringify(model)} starts with "-", which the worker's command line would read as a flag.`);
  }
}

function requireSessionId(sessionId) {
  validateSessionId(sessionId);
  if (sessionId.startsWith('-')) {
    throw new Error(`Session id ${JSON.stringify(sessionId)} starts with "-", which the worker's command line would read as a flag.`);
  }
}

// spawn-cli.js refuses these characters in an argument on Windows (cmd.exe
// treats them as operators). Say so now, with the folder named, instead of
// failing later at spawn. Each entry is { label, value }.
function requireSpawnablePaths(entries) {
  if (!SPAWN_OPTS.shell) return;
  for (const entry of entries) {
    const found = new Set();
    for (const character of entry.value) {
      if (CMD_UNSAFE_RE.test(character)) found.add(character);
    }
    if (found.size > 0) {
      throw new Error(
        `The ${entry.label} \`${entry.value}\` contains ${[...found].join(' ')}, which cmd.exe cannot pass safely ` +
        'on a command line. Use a folder whose path has none of " & | < > ^ % !'
      );
    }
  }
}

// ---- command lines ----

// codex resume takes no -s or -C: the sandbox goes in as a config override
// (bare word, not quoted, like reasoningCfg: shellSafeArgs refuses a `"`), and
// the process runs in the folder (`cwd` in the result).
function codexArgs({ task, isWrite, resume, fence }) {
  requireModelId(task.model);
  validateReasoningEffort(task.effort);
  let sandbox = 'read-only';
  if (isWrite) sandbox = fence === 'full' ? 'danger-full-access' : 'workspace-write';
  const networkArgs = [];
  if (isWrite && fence !== 'full') networkArgs.push('-c', 'sandbox_workspace_write.network_access=true');
  const modelArgs = [];
  if (task.model) modelArgs.push('-m', task.model);
  if (task.effort) modelArgs.push('-c', reasoningCfg(task.effort));
  if (!resume) {
    return [
      'exec', '--json', '--color', 'never', '--skip-git-repo-check', '-s', sandbox,
      ...networkArgs, ...hookArgs(false), ...modelArgs, '-'
    ];
  }
  requireSessionId(task.worker_session);
  return [
    'exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode=${sandbox}`,
    ...networkArgs, ...hookArgs(false), ...modelArgs, task.worker_session, '-'
  ];
}

const AGY_SETTINGS_FILE = 'agy-settings.json';

// Why a fenced agy or Codex write task cannot run in a folder that holds consult's
// own files (Rulings 15 and 20): the worker may write anywhere in that folder, and
// with it consult's settings and its tasks' state. Used at start, at a follow-up and here.
function consultFolderRefusal(worker, folder) {
  const label = worker === 'codex' ? 'Codex' : worker;
  return `${label} can't be fenced in a folder that holds consult's own files (${folder}). Run it in a project folder, or lift ${label}'s fence for this project in the Delegated tab.`;
}

// Throws that refusal when `worker` is agy or Codex, the task writes, its fence is on and `folder`
// holds consult's files. Each caller decides `fenced` its own way, and whether the folder is the real one.
export function refuseInConsultFolder({ worker, isWrite, fenced, folder }) {
  if ((worker === 'agy' || worker === 'codex') && isWrite && fenced && holdsConsultFiles(folder)) {
    throw new Error(consultFolderRefusal(worker, folder));
  }
}

function agyArgs({ task, workFolder, taskDir, isWrite, resume, timeLimitMs, fence }) {
  requireModelId(task.model);
  validateAgyEffort(task.effort);
  requireSpawnablePaths([{ label: 'work folder', value: workFolder }]);
  const args = ['--output-format', 'stream-json', '--disable-slash-commands', '--add-dir', workFolder];
  if (isWrite) args.push('--mode', 'accept-edits');
  args.push('--sandbox');
  // A fenced agy trusts only its work folder: a per-task settings file says so.
  if (fence === 'fenced') {
    const settingsFile = path.join(taskDir, AGY_SETTINGS_FILE);
    requireSpawnablePaths([{ label: 'agy settings file', value: settingsFile }]);
    args.push('--settings', settingsFile);
  }
  if (task.model) args.push('--model', task.model);
  if (task.effort) args.push('--effort', task.effort);
  if (resume) {
    requireSessionId(task.worker_session);
    args.push('--conversation', task.worker_session);
  }
  // agy's own deadline sits inside the task's, so it ends and emits its partial
  // before the supervisor's kill.
  if (typeof timeLimitMs === 'number') args.push('--print-timeout', `${printTimeoutSeconds(timeLimitMs)}s`);
  return args;
}

// The inventory entry for a model, by id or name or alias (llama-swap's facts
// have an id, Ollama's a name).
export function factFor(inventory, model) {
  if (!Array.isArray(inventory)) return null;
  for (const fact of inventory) {
    if (fact?.id === model || fact?.name === model) return fact;
    if (Array.isArray(fact?.aliases) && fact.aliases.includes(model)) return fact;
  }
  return null;
}

// A sentence when the model's context window is too small for a worker, else null.
export function contextWarning(fact) {
  const context = fact?.context;
  if (typeof context !== 'number' || context >= MIN_CONTEXT_TOKENS) return null;
  const name = fact.id ?? fact.name ?? 'This model';
  return `${name} has a context window of only ${context} tokens. A worker's own instructions and tools take several thousand ` +
    `of them, so the task may run out of room or fail; a model with ${MIN_CONTEXT_TOKENS} or more suits it better.`;
}

// The pi command for a local task. The runner's address and the NAME of its
// key variable reach the pi extension (pi-provider.js) through env; the key's
// value stays in the environment pi inherits and is never read here.
function localCommand({ task, nickname, workFolder, taskDir, isWrite, resume, promptText, settings, runner, inventory, fenced, fenceLayer, piLayer }) {
  if (runner === null || runner === undefined) throw new Error('A local task needs the local runner (runnerSettings(settings)).');
  if (runner.key_env && (!isValidEnvName(runner.key_env) || !isLoopback(runner.url))) {
    throw new Error(`The runner's key variable ${JSON.stringify(runner.key_env)} is not a valid name, or ${runner.url} is not on this machine; a key from the environment is only sent to this machine.`);
  }
  if (runner.legacy && runner.api_key) {
    throw new Error('A delegated local task reaches pi through an environment variable for the key, but this runner takes its key from `local_api_key`. Run /consult:setlocal to choose a runner with a `key_env`.');
  }
  validateBaseUrl(runner.url);
  const prepared = prepareRunnerCall({ runner, requested: task.model ?? nickname, images: undefined, settings, inventory });
  requireModelId(prepared.model);
  if (!task.pi_session) throw new Error(`Task ${task.id} has no pi_session to run or resume.`);
  requireSessionId(task.pi_session);
  requireSpawnablePaths([{ label: 'task folder', value: taskDir }, { label: 'pi extension', value: PI_PROVIDER_PATH }, { label: 'pi guard extension', value: PI_FENCE_PATH }]);
  const fact = factFor(inventory, prepared.model);

  const env = { CONSULT_PI_BASE_URL: runner.url, CONSULT_PI_MODEL: prepared.model };
  if (runner.key_env) env.CONSULT_PI_KEY_ENV = runner.key_env;
  if (typeof fact?.context === 'number') env.CONSULT_PI_CONTEXT = String(fact.context);

  // A fenced task runs with consult's guard extension and, when the layer is
  // the sandbox, inside Codex's sandbox. Its sessions live in a temp folder
  // the supervisor copies back from; a lifted task keeps them in the task folder.
  let sessionDir = path.join(taskDir, 'pi-sessions');
  if (fenceLayer !== null) {
    sessionDir = piLayer.temp.sessions;
    env.PI_CODING_AGENT_DIR = piLayer.temp.agent;
    // Codex's sandbox makes only the TEMP of its own process writable, so TEMP is the root
    // that holds pi-sessions, agent and tmp: all three stay writable, the shared %TEMP% does not.
    env.TEMP = piLayer.temp.root;
    env.TMP = piLayer.temp.root;
    env.GIT_OPTIONAL_LOCKS = '0';
    env.CONSULT_FENCE_DIR = workFolder;
    // consult's own files inside the work folder: the guard refuses writes to them too.
    env.CONSULT_FENCE_PROTECTED = JSON.stringify(fenceProtectedPaths(workFolder));
  }
  const briefPath = path.join(taskDir, resume ? 'followup.md' : 'prompt.md');
  const args = [
    '--mode', 'json', '-p', '--no-mcp', '--no-skills', '--no-extensions', '--no-prompt-templates', '--no-approve',
    '-e', PI_PROVIDER_PATH
  ];
  if (fenceLayer !== null) args.push('-e', PI_FENCE_PATH);
  args.push(
    '--provider', 'consult-local', '--model', prepared.model,
    '--session-dir', sessionDir,
    resume ? '--session' : '--session-id', task.pi_session
  );
  // A read task gets pi's read-only tools only. A write task keeps the default
  // tools: pi has no fence, which the user accepted.
  if (!isWrite) args.push('--tools', PI_READ_ONLY_TOOLS);
  args.push(`@${briefPath}`);
  const command = {
    cmd: resolveCmd('pi').path, args, env, stdinText: null,
    briefFile: { path: briefPath, text: promptText },
    files: [], fenceLayer, fenceReason: fenceLayer !== null ? (piLayer.reason ?? null) : null,
    cwd: workFolder, fenced: fenceLayer !== null ? fenceLayer === 'sandbox' : fenced, model: prepared.model, warning: contextWarning(fact)
  };
  if (fenceLayer === 'sandbox') {
    requireSpawnablePaths([{ label: 'pi launcher', value: piLayer.launcherPath }]);
    command.wrapper = {
      program: piLayer.codexPath,
      launcherPath: piLayer.launcherPath,
      // The environment policy is pinned (Ruling 16), the same as for the sandbox check.
      args: ['sandbox', '-c', 'sandbox_mode=workspace-write', ...SANDBOX_ENV_POLICY_ARGS, '--', process.execPath, piLayer.launcherPath]
    };
  }
  return command;
}

// `task` is a task record (delegate-store.js). The work folder is its
// worktree, or the project itself for a task that works in place. `brief`
// defaults to the task's brief.md. A resume continues the worker's session
// (worker_session, or pi_session for a local task) with `followUp`.
export function workerCommand(task, { settings, runner = null, inventory = null, resume = false, followUp = null, brief = null, piLayer = null, fence: givenFence = null }) {
  const word = parseWorkerWord(task.worker);
  if (word.worker === null) throw new Error(`Unknown delegate worker ${JSON.stringify(task.worker)}.`);
  const workFolder = task.worktree ?? task.project;
  const taskDir = task.dir ?? taskFolder(task.id);
  const isWrite = task.mode === 'write';
  // The stored worker is the plain name; a local:<nickname> word still reads as local.
  // The fence used is the narrower of the task's own and the project's current one.
  // The supervisor decides the fence once, before it stages anything, and passes it as `fence`.
  const fence = givenFence ?? narrowerFence(word.worker, taskFence({ ...task, worker: word.worker }), projectSettings(task.project).fence[word.worker]);
  const fenced = fence === 'fenced';
  // Which mechanism holds the fence: agy's trusted-workspace settings. (Codex and local layers come with their own tasks.)
  if (word.worker === 'local' && fenced && piLayer === null) throw new Error('A fenced local task needs piLayer (the sandbox or the guard, with its temp folders).');
  let fenceLayer = null;
  if (word.worker === 'agy' && fenced) fenceLayer = 'agy';
  if (word.worker === 'local' && fenced) fenceLayer = piLayer.kind;
  let promptText;
  if (resume) {
    promptText = followUp ?? CONTINUE_PROMPT;
    if (!isWrite) promptText = `${READ_ONLY_REMINDER}\n\n${promptText}`;
  } else {
    promptText = `${workerPreamble(workFolder, isWrite, word.worker, fence, fenceLayer)}\n\n${brief ?? fs.readFileSync(path.join(taskDir, 'brief.md'), 'utf8')}`;
  }

  if (word.worker === 'local') {
    return localCommand({ task, nickname: word.nickname, workFolder, taskDir, isWrite, resume, promptText, settings, runner, inventory, fenced, fenceLayer, piLayer });
  }
  let cmd;
  let args;
  const files = [];
  if (word.worker === 'codex') {
    // The last stop before a fenced Codex write task gets a folder holding consult's files as its write root (Ruling 20).
    refuseInConsultFolder({ worker: 'codex', isWrite, fenced, folder: workFolder });
    cmd = resolveCmd('codex').path;
    args = codexArgs({ task, isWrite, resume, fence });
  } else {
    const timeLimitMs = task.time_limit_ms ?? settings?.delegate?.time_limit_ms;
    // The last stop before agy would trust a folder holding consult's files (delegate and delegate_send refuse earlier).
    refuseInConsultFolder({ worker: 'agy', isWrite, fenced, folder: workFolder });
    cmd = resolveCmd('agy').path;
    args = agyArgs({ task, workFolder, taskDir, isWrite, resume, timeLimitMs, fence });
    // A read task can write nowhere, so it trusts no folder. agy 1.5.3 was checked live (2026-11-08) to still read its --add-dir folder with an empty list.
    if (fenced) files.push({ path: path.join(taskDir, AGY_SETTINGS_FILE), text: JSON.stringify({ trustedWorkspaces: isWrite ? [workFolder] : [] }) });
  }
  return {
    cmd, args, env: {}, files, fenceLayer,
    stdinText: promptText, briefFile: null, cwd: workFolder, fenced, model: task.model ?? null, warning: null
  };
}

// ---- output ----

function parseJsonLines(lines) {
  const rows = Array.isArray(lines) ? lines : String(lines).split(/\r?\n/);
  const events = [];
  for (const row of rows) {
    const text = String(row).trim();
    if (!text.startsWith('{')) continue;
    try {
      const event = JSON.parse(text);
      if (event && typeof event === 'object') events.push(event);
    } catch (_) {}
  }
  return events;
}

// Only the phrasings of a usage limit count: a bare "quota" ("Disk quota exceeded")
// or a bare 429 ("line 429") is an ordinary failure. A 429 counts as an HTTP status:
// after status, code or HTTP, in a quoted JSON key, or before "Too Many Requests".
const EXHAUSTED_PATTERN = /usage limit|resource_exhausted|insufficient_quota|exceeded your (?:current )?quota|quota exceeded for|quota.{0,60}(?:requests|tokens|per minute|per day)/i;
const THROTTLED_PATTERN = /rate.?limit|too many requests|\b(?:status|code|http)\b(?:\/[\d.]+)?["']?\s*[:=]?\s*429\b/i;

// A failure message as a limit hit (`kind`, resets_at unknown), or null.
// A quota is spent until its window ends; a throttle passes.
export function limitFromMessage(message) {
  if (EXHAUSTED_PATTERN.test(message)) return { kind: 'exhausted', resets_at: null };
  if (THROTTLED_PATTERN.test(message)) return { kind: 'throttled', resets_at: null };
  return null;
}

// A failure event always counts: its message when it has a usable one, else a
// label and a short JSON of what it did carry.
function failureText(label, message, whole) {
  if (typeof message === 'string' && message.trim() !== '') return message;
  return `${label} ${JSON.stringify(whole === undefined ? null : whole).slice(0, 200)}`;
}

function parseCodexStream(events) {
  const result = { finalMessage: null, session: null, limit: null, limitHit: null, error: null, denied: [], complete: false };
  let failure = null;
  for (const event of events) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') result.session = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      result.finalMessage = event.item.text;
    }
    if (event.type === 'error') {
      const { type, ...rest } = event;
      failure = failureText('codex error', event.message, rest);
    }
    if (event.type === 'turn.failed') {
      failure = failureText('codex turn failed', event.error?.message ?? event.error, event.error);
      result.complete = true;
    }
    // codex reports a stream hiccup it recovers from as an `error` too.
    if (event.type === 'turn.completed') {
      failure = null;
      result.complete = true;
    }
  }
  if (failure !== null) {
    result.limitHit = limitFromMessage(failure);
    if (result.limitHit === null) result.error = failure;
  }
  return result;
}

export function deniedNames(denied) {
  const names = [];
  for (const entry of denied) names.push(entry.display_name || entry.action || 'unknown');
  return names;
}

const AGY_WRITE_ACTIONS = ['write_file', 'edit_file'];
const AUTO_DENIED_PATTERN = /auto-denied/i;

// True when the run says a write was refused: the result's denied_actions names
// write_file or edit_file, or stderr has agy's "auto-denied" line.
function writeWasDenied(events, stderr) {
  if (typeof stderr === 'string' && AUTO_DENIED_PATTERN.test(stderr)) return true;
  for (const event of events) {
    if (event?.event !== 'result' || !Array.isArray(event.result?.denied_actions)) continue;
    for (const entry of event.result.denied_actions) {
      if (entry !== null && typeof entry === 'object' && AGY_WRITE_ACTIONS.includes(entry.action)) return true;
    }
  }
  return false;
}

// The paths of the write_file/edit_file steps that point outside the work
// folder, once each, in order, in full (a relative path is resolved against the
// work folder). With the fence on, agy refuses these writes but still emits the
// step: nothing in the step marks it refused, so a path is reported only when the
// run also says a write was denied (writeWasDenied). Compared strictly, by real
// path and ignoring case, with no broad-folder exemption.
export function refusedOutside(events, workFolder, stderr = '') {
  const paths = [];
  if (!writeWasDenied(events, stderr)) return paths;
  let realWorkFolder;
  try {
    realWorkFolder = realPathOfTarget(path.resolve(workFolder));
  } catch (_) {
    // A work folder that cannot be resolved (a link loop) is compared as written.
    realWorkFolder = path.resolve(workFolder);
  }
  for (const event of events) {
    const step = event?.event === 'step_update' ? event.step_update : null;
    if (step === null || typeof step !== 'object') continue;
    const toolName = step.tool_info?.name ?? step.tool_name;
    if (toolName !== 'write_file' && toolName !== 'edit_file') continue;
    const parameters = step.tool_info?.parameters;
    if (parameters === null || typeof parameters !== 'object') continue;
    let target = null;
    for (const key of ['Path', 'TargetFile', 'AbsolutePath']) {
      if (typeof parameters[key] === 'string' && parameters[key] !== '') {
        target = parameters[key];
        break;
      }
    }
    if (target === null) continue;
    const resolvedTarget = path.resolve(workFolder, target);
    let inside = false;
    try {
      inside = isInside(realPathOfTarget(resolvedTarget), realWorkFolder);
    } catch (_) { /* a path that cannot be resolved (a link loop) counts as outside */ }
    if (inside || paths.includes(resolvedTarget)) continue;
    paths.push(resolvedTarget);
  }
  return paths;
}

function parseAgyStream(events, { stderr = '', workFolder = null } = {}) {
  const result = { finalMessage: null, session: null, limit: null, limitHit: null, error: null, warning: null, denied: [], complete: false, refusedOnly: false, refusedPaths: [] };
  let envelope = null;
  let lastStep = null;
  for (const event of events) {
    if (event.event === 'init' && typeof event.conversation_id === 'string') result.session = event.conversation_id;
    if (event.event === 'step_update' && event.step_update && typeof event.step_update === 'object') lastStep = event.step_update;
    if (event.event === 'result' && event.result && typeof event.result === 'object') envelope = event.result;
  }
  if (workFolder !== null) result.refusedPaths = refusedOutside(events, workFolder, stderr);
  const failures = [];
  let refusal = null;
  if (envelope !== null) {
    result.complete = true;
    if (typeof envelope.conversation_id === 'string') result.session = envelope.conversation_id;
    if (Array.isArray(envelope.denied_actions)) {
      for (const entry of envelope.denied_actions) {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) result.denied.push(entry);
      }
    }
    const response = typeof envelope.response === 'string' ? envelope.response : '';
    if (response.trim() !== '') result.finalMessage = response;
    if (envelope.status !== 'SUCCESS') {
      failures.push(`agy returned status=${envelope.status}: ${envelope.error || envelope.message || response || 'no detail'}`);
    } else if (result.finalMessage === null && result.denied.length > 0) {
      refusal = `agy was refused: ${deniedNames(result.denied).join(', ')}`;
    }
  }
  const agyError = parseAgyErrorLine(stderr);
  if (agyError !== null) {
    failures.push([agyError.status, agyError.message || agyError.error || agyError.detail].filter(Boolean).join(': ') || JSON.stringify(agyError).slice(0, 400));
  }
  for (const failure of failures) {
    if (result.limitHit === null) result.limitHit = limitFromMessage(failure);
  }
  result.refusedOnly = refusal !== null && failures.length === 0;
  // agy can finish its answer and then report ERROR (its connection dropped
  // afterwards). When the last step is the answer, done, and the result line is
  // the only failure, the answer stands and the error is only a warning.
  // Residual risk: a model that narrates text before tool calls and then stalls has that text accepted;
  // the rule relies on the last step being the DONE agent_response.
  const answerArrived = lastStep !== null && lastStep.step_type === 'agent_response' && lastStep.state === 'DONE' && result.finalMessage !== null;
  if (answerArrived && result.limitHit === null && refusal === null && agyError === null && failures.length === 1 && envelope.status !== 'SUCCESS' && !isPartialOutput(stderr)) {
    result.warning = `agy's answer arrived in full, then it reported an error: ${failures[0]}`;
    return result;
  }
  // A limit hit wins over every error; otherwise a refusal keeps priority and
  // carries any other failure after it.
  if (result.limitHit === null) {
    if (refusal !== null) result.error = failures.length > 0 ? `${refusal} (also: ${failures.join('; ')})` : refusal;
    else if (failures.length > 0) result.error = failures.join('; ');
    // The print timeout sits inside the task's time limit: what agy returned is cut off.
    else if (isPartialOutput(stderr)) result.error = 'agy stopped at its time limit; its answer is partial.';
  }
  return result;
}

function textOf(message) {
  const parts = [];
  for (const item of Array.isArray(message?.content) ? message.content : []) {
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n');
}

// pi exits 0 even on failure. `agent_end` comes once per retry attempt; the
// last one holds the real outcome: its last assistant message either answers
// or has stopReason "error". The stream is complete at `agent_settled`, or, if
// that line is missing, at a last `agent_end` that will not retry.
function parsePiStream(events) {
  const result = { finalMessage: null, session: null, limit: null, limitHit: null, error: null, denied: [], complete: false };
  let lastAgentEnd = null;
  let settled = null;
  for (const event of events) {
    if (event.type === 'session' && typeof event.id === 'string' && result.session === null) result.session = event.id;
    if (event.type === 'agent_end' && Array.isArray(event.messages)) lastAgentEnd = event;
    if (event.type === 'agent_settled') settled = event;
  }
  result.complete = settled !== null || (lastAgentEnd !== null && lastAgentEnd.willRetry === false);
  if (settled !== null && settled.aborted === true) result.error = 'pi aborted';
  if (lastAgentEnd === null) return result;
  let lastAssistant = null;
  for (const message of lastAgentEnd.messages) {
    if (message?.role === 'assistant') lastAssistant = message;
  }
  if (lastAssistant === null) return result;
  const text = textOf(lastAssistant);
  if (text.trim() !== '') result.finalMessage = text;
  if (lastAssistant.stopReason === 'error') {
    const message = typeof lastAssistant.errorMessage === 'string' ? lastAssistant.errorMessage : 'pi stopped with an error';
    if (THROTTLED_PATTERN.test(message)) result.limitHit = { kind: 'throttled', resets_at: null };
    else result.error = message;
  }
  return result;
}

// `lines` are the worker's stdout lines (an array, or the text). Unknown events
// are skipped. `stderr` matters for agy only (its quota error is a stderr line).
// Returns { finalMessage, session, limit, limitHit, error, denied, complete }, and for
// agy also { warning, refusedOnly, refusedPaths }: refusedPaths are the writes outside
// `workFolder` its fence refused (refusedOutside; empty without a workFolder).
// limitHit is null or { kind: 'exhausted' | 'throttled', resets_at }. `complete`
// is true only when the worker's terminal event was seen (codex: turn.completed
// or turn.failed; agy: the result line; pi: agent_settled, or a last agent_end
// that will not retry), so a stream cut short reads as incomplete.
export function parseWorkerStream(worker, lines, { stderr = '', workFolder = null } = {}) {
  const events = parseJsonLines(lines);
  if (worker === 'codex') return parseCodexStream(events);
  if (worker === 'agy') return parseAgyStream(events, { stderr, workFolder });
  if (worker === 'local') return parsePiStream(events);
  throw new Error(`Unknown delegate worker ${JSON.stringify(worker)}.`);
}

// Keeps `openSteps` (a Set of step ids) current from one stdout line of a
// worker: a command or tool step that starts is added, and removed when it
// finishes. The watchdog is suspended while one is open, since a worker busy
// inside one long command prints nothing until it ends (codex: item.started
// until item.completed; agy: a tool step ACTIVE until it is not; pi:
// tool_execution_start until tool_execution_end). A line that is not JSON, or
// not such an event, changes nothing.
export function noteStepEvent(worker, line, openSteps) {
  if (!line.includes('item.') && !line.includes('step_update') && !line.includes('tool_execution_')) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch (_) {
    return;
  }
  if (event === null || typeof event !== 'object') return;
  if (worker === 'codex' && typeof event.item?.id === 'string') {
    if (event.type === 'item.started' && event.item.type === 'command_execution') openSteps.add(event.item.id);
    if (event.type === 'item.completed') openSteps.delete(event.item.id);
  }
  if (worker === 'agy' && event.event === 'step_update' && event.step_update?.step_type === 'tool') {
    const stepId = String(event.step_update.step_index);
    if (event.step_update.state === 'ACTIVE') openSteps.add(stepId);
    else openSteps.delete(stepId);
  }
  if (worker === 'local' && typeof event.toolCallId === 'string') {
    if (event.type === 'tool_execution_start') openSteps.add(event.toolCallId);
    if (event.type === 'tool_execution_end') openSteps.delete(event.toolCallId);
  }
}

// ---- codex limits ----

// Codex's usage windows are not in `exec --json`; the run's rollout file holds
// them in its token_count events. Takes the last one carrying rate_limits, read
// from the end of the file (a rollout can be hundreds of MB).
// `limit` is { primary, secondary } exactly as the file has them (their
// resets_at is in epoch SECONDS); `limitHit` is { kind: 'exhausted', resets_at }
// when codex says it reached a limit or a window is at 100 %, else null, and
// its resets_at is in epoch MILLISECONDS, like the task store's times. A
// missing or unreadable file gives nulls.
export function codexRolloutLimits(threadId, { codexHome: home = codexHome() } = {}) {
  const none = { limit: null, limitHit: null };
  const rolloutPath = findRolloutFile(threadId, home);
  if (rolloutPath === null) return none;
  let rateLimits;
  try {
    rateLimits = rateLimitsFromTail(rolloutPath);
  } catch (_) {
    return none;
  }
  if (rateLimits === null) return none;

  const limit = { primary: rateLimits.primary ?? null, secondary: rateLimits.secondary ?? null };
  const reachedType = rateLimits.rate_limit_reached_type ?? null;
  const windows = [];
  for (const window of [limit.primary, limit.secondary]) {
    if (window && typeof window.used_percent === 'number' && window.used_percent >= 100) windows.push(window);
  }
  if (windows.length === 0 && reachedType !== null) {
    const named = /secondary/i.test(String(reachedType)) ? limit.secondary : limit.primary;
    if (named) windows.push(named);
  }
  if (windows.length === 0 && reachedType === null) return { limit, limitHit: null };
  // Blocked until the last exhausted window resets.
  let resetsAt = null;
  for (const window of windows) {
    if (typeof window.resets_at === 'number' && (resetsAt === null || window.resets_at > resetsAt)) resetsAt = window.resets_at;
  }
  return { limit, limitHit: { kind: 'exhausted', resets_at: resetsAt === null ? null : resetsAt * 1000 } };
}
