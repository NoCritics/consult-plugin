// Git for delegate: where a task works, the snapshot copy, cleanup, guarded setup.
//
// A write task works in a git worktree under <data>/worktrees/<task-id>, started
// from a snapshot commit of the user's working tree as it is right now (tracked
// changes, deletions and untracked non-ignored files). The snapshot is built
// with a temporary index file, so the user's own index is never read for
// writing or touched; consult's own commits run no hooks and write no config.
// Paths coming back from git are always NUL-separated so Cyrillic names and
// spaces arrive raw instead of quoted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { dataHome, readTask } from './delegate-store.js';

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const SAFE_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_ID_PATTERN = /^[0-9a-f]{40,64}$/;
const FALLBACK_IDENTITY = { name: 'consult', email: 'consult@localhost' };
const STARTER_GITIGNORE_LINES = ['node_modules/', '.env*', 'dist/', 'build/', '.venv/', '__pycache__/', '.DS_Store'];
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
// The count of uncommitted changes only informs a note: a start does not wait longer than this for it.
const UNCOMMITTED_COUNT_LIMIT_MS = 5000;
const INHERITED_GIT_LOCATION_VARIABLES = ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE'];

// The one place a git command line is built, for both the async and the sync
// caller. Git runs with no shell, every path its own argument, and:
// - a neutral working folder consult owns, with the repository chosen by -C. On
//   Windows a program started with its cwd inside a worker's folder would pick
//   up a planted git.com from there.
// - GIT_OPTIONAL_LOCKS=0 so consult never takes the user's index lock for a
//   status-like refresh; callers that write pass their own extra environment.
// - core.fsmonitor off and core.hooksPath at the null device (command-line -c
//   beats any config file), and inherited GIT_DIR / GIT_WORK_TREE /
//   GIT_INDEX_FILE dropped, so no repository setting can make consult's git run
//   a program. The system and global config stay: line-ending and filter
//   settings live there, and the commit identity.
let neutralFolderMade = null;

function hardenedGitCall(directory, args, extraEnv) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of INHERITED_GIT_LOCATION_VARIABLES) delete env[name];
  Object.assign(env, extraEnv);
  const neutralFolder = path.join(dataHome(), 'git-cwd');
  if (neutralFolder !== neutralFolderMade) {
    fs.mkdirSync(neutralFolder, { recursive: true });
    neutralFolderMade = neutralFolder;
  }
  return {
    args: ['-C', directory, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NULL_DEVICE}`, ...args],
    options: { cwd: neutralFolder, env, maxBuffer: MAX_GIT_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' }
  };
}

function runGit(directory, args, extraEnv = {}, { timeoutMs } = {}) {
  const call = hardenedGitCall(directory, args, extraEnv);
  const options = timeoutMs === undefined ? call.options : { ...call.options, timeout: timeoutMs };
  return new Promise((resolve, reject) => {
    execFile('git', call.args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0]} failed in ${directory}: ${(stderr || error.message).trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function gitSucceeds(directory, args, extraEnv = {}) {
  try {
    await runGit(directory, args, extraEnv);
    return true;
  } catch (_) {
    return false;
  }
}

async function configValue(directory, key, extraEnv = {}) {
  try {
    return (await runGit(directory, ['config', '--get', key], extraEnv)).trim();
  } catch (_) {
    return '';
  }
}

// Environment for one commit-creating command: a fallback identity only for the
// parts the repo does not have configured. Nothing is written to git config.
async function identityEnvFor(directory, locationEnv = {}) {
  const env = {};
  if (await configValue(directory, 'user.name', locationEnv) === '') {
    env.GIT_AUTHOR_NAME = FALLBACK_IDENTITY.name;
    env.GIT_COMMITTER_NAME = FALLBACK_IDENTITY.name;
  }
  if (await configValue(directory, 'user.email', locationEnv) === '') {
    env.GIT_AUTHOR_EMAIL = FALLBACK_IDENTITY.email;
    env.GIT_COMMITTER_EMAIL = FALLBACK_IDENTITY.email;
  }
  return env;
}

const MIN_GIT_FOR_COPIES = { major: 2, minor: 40 };
let copiesSupportedPromise = null;

// Copies read attributes from a trusted commit (--attr-source), which needs git 2.40.
// Looked up once; a git that is missing or unreadable counts as unsupported.
function gitSupportsCopies() {
  if (copiesSupportedPromise === null) {
    copiesSupportedPromise = runGit(os.tmpdir(), ['version']).then((output) => {
      const match = /git version (\d+)\.(\d+)/.exec(output);
      if (match === null) return false;
      const major = Number(match[1]);
      const minor = Number(match[2]);
      return major > MIN_GIT_FOR_COPIES.major || (major === MIN_GIT_FOR_COPIES.major && minor >= MIN_GIT_FOR_COPIES.minor);
    }, () => false);
  }
  return copiesSupportedPromise;
}

export async function gitState(project) {
  const copiesSupported = await gitSupportsCopies();
  let topLevel;
  try {
    topLevel = (await runGit(project, ['rev-parse', '--show-toplevel'])).trim();
  } catch (_) {
    return { isRepo: false, hasCommit: false, root: null, copiesSupported };
  }
  const hasCommit = await gitSucceeds(project, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return { isRepo: true, hasCommit, root: path.normalize(topLevel), copiesSupported };
}

// Pure. `gitSetting` is the project's saved answer ('ask' | 'declined') and
// `canSetup` is the result of setupAllowed for the project (false unless the
// caller says otherwise); both only matter when there is no usable git history
// to copy from. A git too old for copies (`git.copiesSupported` not true) means
// working here, with no setup question.
export function decideLocation({ mode, requested, projectSetting, git, gitSetting = 'ask', canSetup = false }) {
  if (mode === 'read') return { location: 'here', ask: null };
  const wanted = requested || projectSetting || 'auto';
  if (wanted === 'here') return { location: 'here', ask: null };
  if (git.copiesSupported !== true) return { location: 'here', ask: null };
  const gitUsable = git.isRepo && git.hasCommit;
  if (gitUsable) return { location: 'copy', ask: null };
  const mayAsk = gitSetting === 'ask' && canSetup;
  return { location: 'here', ask: mayAsk ? 'git-setup' : null };
}

function comparablePath(folder) {
  let resolved = path.resolve(folder);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch (_) {
    // a folder that does not exist yet compares by its resolved text
  }
  resolved = resolved.replace(/[\\/]+$/, '') || path.parse(resolved).root;
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function setupAllowed(project, { home = os.homedir() } = {}) {
  const resolved = path.resolve(project);
  if (comparablePath(resolved) === comparablePath(home)) return false;
  const driveRoot = path.parse(resolved).root;
  if (comparablePath(resolved) === comparablePath(driveRoot)) return false;
  const call = hardenedGitCall(path.dirname(resolved), ['rev-parse', '--show-toplevel'], {});
  try {
    execFileSync('git', call.args, { ...call.options, stdio: 'ignore' });
    return false;
  } catch (_) {
    return true;
  }
}

// Only for a folder with no commit yet: a first commit is all this ever makes.
export async function setupGit(project) {
  if (!setupAllowed(project)) {
    throw new Error(`git setup is not allowed in ${project} (home folder, drive root, or inside another repository)`);
  }
  const before = await gitState(project);
  if (before.hasCommit) throw new Error(`git setup refused: ${project} already has a commit`);
  if (before.isRepo && comparablePath(before.root) !== comparablePath(project)) {
    throw new Error(`git setup refused: ${project} is inside the repository at ${before.root}`);
  }
  await runGit(project, ['init']);
  const gitignorePath = path.join(project, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, STARTER_GITIGNORE_LINES.join('\n') + '\n');
  }
  await runGit(project, ['add', '-A']);
  const identityEnv = await identityEnvFor(project);
  await runGit(
    project,
    ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--allow-empty', '-m', 'Initial commit (consult)'],
    identityEnv
  );
  return gitState(project);
}

// Commits the working tree of `directory` as it is now, on top of its HEAD,
// through a throwaway index file kept in the system temp folder.
// `locationEnv` pins GIT_DIR and GIT_WORK_TREE for a worker's copy (see
// trustedWorktreeLocation); for the user's own project it is empty.
// `attributesFrom` is the commit whose .gitattributes decide filters and line
// endings for `add -A` (the working tree's own .gitattributes are ignored, so a
// worker cannot select a filter driver); null means the parent commit.
async function snapshotOf(directory, locationEnv = {}, attributesFrom = null) {
  const tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-index-'));
  try {
    const parent = (await runGit(directory, ['rev-parse', '--verify', 'HEAD'], locationEnv)).trim();
    // The environment variable, not the option, and on every command after this one:
    // git hashes the files (and so runs filters) as late as write-tree, not in `add`.
    const indexEnv = { ...locationEnv, GIT_INDEX_FILE: path.join(tempFolder, 'index'), GIT_ATTR_SOURCE: attributesFrom || parent };
    await runGit(directory, ['read-tree', parent], indexEnv);
    await runGit(directory, ['add', '-A'], indexEnv);
    const tree = (await runGit(directory, ['write-tree'], indexEnv)).trim();
    const identityEnv = await identityEnvFor(directory, locationEnv);
    const commit = await runGit(directory, ['commit-tree', tree, '-p', parent, '-m', 'consult snapshot'], { ...indexEnv, ...identityEnv });
    return commit.trim();
  } finally {
    fs.rmSync(tempFolder, { recursive: true, force: true });
  }
}

export function snapshot(project) {
  return snapshotOf(project);
}

// A worker can rewrite the `.git` file inside its copy to point at a gitdir
// whose config runs a program. So that file is never used: the copy's git
// directory is found from the project's side (the `gitdir` file in the
// project's own .git/worktrees/<name>, which only the project side writes) and
// handed to git as GIT_DIR, together with GIT_WORK_TREE. The pair must match a
// worktree the project itself lists, or nothing runs.
async function trustedWorktreeLocation(project, worktree) {
  const listing = await runGit(project, ['worktree', 'list', '--porcelain', '-z']);
  const wantedWorktree = comparablePath(worktree);
  let listed = false;
  for (const field of listing.split('\0')) {
    if (field.startsWith('worktree ') && comparablePath(field.slice('worktree '.length)) === wantedWorktree) listed = true;
  }
  if (!listed) throw new Error(`${worktree} is not a worktree of ${project}`);
  const commonDir = path.normalize((await runGit(project, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const adminRoot = path.join(commonDir, 'worktrees');
  if (fs.existsSync(adminRoot)) {
    for (const adminName of fs.readdirSync(adminRoot)) {
      const adminDir = path.join(adminRoot, adminName);
      let recordedDotGit;
      try {
        recordedDotGit = fs.readFileSync(path.join(adminDir, 'gitdir'), 'utf8').trim();
      } catch (_) {
        continue;
      }
      const recordedFolder = path.dirname(path.normalize(recordedDotGit));
      if (path.basename(recordedDotGit) === '.git' && comparablePath(recordedFolder) === wantedWorktree) {
        return { GIT_DIR: adminDir, GIT_WORK_TREE: path.resolve(worktree) };
      }
    }
  }
  throw new Error(`no git directory of ${project} is registered for ${worktree}`);
}

// `project` is the user's project the copy was made from and `startCommit` the
// snapshot the copy started from (makeCopy's start_commit). The copy's own HEAD is
// not a substitute for the start commit: the worker may have committed to it.
export async function endSnapshot(worktree, project, startCommit) {
  if (!COMMIT_ID_PATTERN.test(startCommit || '')) throw new Error(`no start commit is known for ${worktree}`);
  return snapshotOf(worktree, await trustedWorktreeLocation(project, worktree), startCommit);
}

export function worktreesRoot() {
  return path.join(dataHome(), 'worktrees');
}

// How many files of the project differ from its last commit: tracked ones
// changed or deleted, and untracked ones that are not ignored. A read-only
// status that takes no lock and never touches the index. 0 when git cannot say.
export async function uncommittedCount(project, { timeoutMs = UNCOMMITTED_COUNT_LIMIT_MS } = {}) {
  try {
    const output = await runGit(project, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {}, { timeoutMs });
    return porcelainStatusEntries(output).length;
  } catch (_) {
    return 0;
  }
}

// The entries of `git status --porcelain=v1 -z`: { code, path, oldPath }, where oldPath is
// the field a rename or a copy carries after its path (else undefined).
function porcelainStatusEntries(output) {
  const entries = [];
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field === undefined || field.length < 4) continue;
    const entry = { code: field.slice(0, 2), path: field.slice(3), oldPath: undefined };
    if (entry.code[0] === 'R' || entry.code[0] === 'C' || entry.code[1] === 'R' || entry.code[1] === 'C') {
      index++;
      entry.oldPath = fields[index];
    }
    entries.push(entry);
  }
  return entries;
}

// ---- did a read-only task change anything? ----
//
// A read task given to agy is checked too: its fence holds writes made through
// its tools, and this catches any that got through another way. The folder is
// looked at before the run and after it, and the files that differ are told to
// the person. In a git project that is the read-only status (no lock, no index
// write) plus each listed file's size and mtime, so a file that was already
// modified and was edited again shows up too. Without git, or when git cannot
// answer in time, it is a capped listing of the folder (size and mtime).
const WATCH_STATUS_LIMIT_MS = 20000;
const WATCH_LISTING_LIMIT = 5000;
const WATCH_SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);

function fileSignature(absolutePath) {
  try {
    const stats = fs.statSync(absolutePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch (_) {
    return 'missing';
  }
}

async function gitWatch(folder) {
  const state = await gitState(folder);
  if (!state.isRepo || state.root === null) return null;
  try {
    const output = await runGit(folder, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], {}, { timeoutMs: WATCH_STATUS_LIMIT_MS });
    const entries = new Map();
    for (const entry of porcelainStatusEntries(output)) {
      entries.set(entry.path, `${entry.code}|${fileSignature(path.join(state.root, entry.path))}`);
      if (entry.oldPath) entries.set(entry.oldPath, `${entry.code}|from`);
    }
    return { source: 'git', entries, capped: false };
  } catch (_) {
    return null;
  }
}

function listingWatch(folder) {
  const entries = new Map();
  let capped = false;
  const visit = (directory, prefix) => {
    let children;
    try {
      children = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_) {
      return;
    }
    children.sort((first, second) => (first.name < second.name ? -1 : first.name > second.name ? 1 : 0));
    for (const child of children) {
      if (capped) return;
      const relative = prefix === '' ? child.name : `${prefix}/${child.name}`;
      if (child.isDirectory()) {
        if (!WATCH_SKIPPED_FOLDERS.has(child.name)) visit(path.join(directory, child.name), relative);
      } else if (child.isFile()) {
        if (entries.size >= WATCH_LISTING_LIMIT) {
          capped = true;
          return;
        }
        entries.set(relative, fileSignature(path.join(directory, child.name)));
      }
    }
  };
  visit(folder, '');
  return { source: 'listing', entries, capped };
}

// What the folder looks like now, for diffWatch. Never throws.
export async function watchFolder(folder) {
  try {
    return (await gitWatch(folder)) ?? listingWatch(folder);
  } catch (_) {
    return null;
  }
}

// The paths (sorted, forward slashes) that differ between two watches, or null
// when they cannot be compared. A capped listing cannot say what was deleted
// past its cap, so it reports only what both runs saw and what is new.
export function diffWatch(before, after) {
  if (before === null || after === null || before.source !== after.source) return null;
  const capped = before.capped || after.capped;
  const changed = [];
  for (const [relative, signature] of after.entries) {
    if (before.entries.get(relative) !== signature) changed.push(relative);
  }
  if (!capped) {
    for (const relative of before.entries.keys()) {
      if (!after.entries.has(relative)) changed.push(relative);
    }
  }
  return changed.sort();
}

export async function makeCopy(project, taskId) {
  if (!SAFE_TASK_ID_PATTERN.test(taskId)) throw new Error(`unsafe task id: ${JSON.stringify(taskId)}`);
  const startCommit = await snapshotOf(project);
  const branch = `consult/${taskId}`;
  const worktree = path.join(worktreesRoot(), taskId);
  fs.mkdirSync(worktreesRoot(), { recursive: true });
  await runGit(project, ['worktree', 'add', '-b', branch, worktree, startCommit]);
  return { worktree, branch, start_commit: startCommit };
}

// Whether `target` is not strictly inside `root` (the root itself counts as outside).
export function isOutside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative);
}

function isInsideWorktreesRoot(folder) {
  return !isOutside(path.resolve(worktreesRoot()), path.resolve(folder));
}

async function removeWorktreeFolder(project, folder) {
  if (!isInsideWorktreesRoot(folder)) throw new Error(`refusing to remove ${folder}: not under the delegate worktrees folder`);
  // Not `git worktree remove`: it would read the copy's own (worker-writable) .git file.
  fs.rmSync(folder, { recursive: true, force: true });
  try {
    await runGit(project, ['worktree', 'prune']);
  } catch (error) {
    // A project that is no longer a git repository has no registration to forget; any other failure is real.
    if (await gitSucceeds(project, ['rev-parse', '--git-dir'])) throw error;
    return 'The project is no longer a git repository, so git was not told the copy is gone.';
  }
  return '';
}

// Removes a task's copy (and, unless `keepBranch`, its branch). Returns a note
// of what could not be cleaned up because the project is no longer a git
// repository, or ''.
export async function removeCopy(project, task, { keepBranch = false } = {}) {
  const note = task.worktree ? await removeWorktreeFolder(project, task.worktree) : '';
  if (keepBranch || !task.branch) return note;
  if (!task.branch.startsWith('consult/')) throw new Error(`refusing to delete branch ${task.branch}: not a consult branch`);
  await deleteBranchIfPresent(project, task.branch);
  return note;
}

// Deletes the branch when the project has it. True when it was there.
async function deleteBranchIfPresent(project, branch) {
  const branchExists = await gitSucceeds(project, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (!branchExists) return false;
  await runGit(project, ['branch', '-D', branch]);
  return true;
}

// Deletes the branch `consult/<taskId>` (and nothing else) from the project.
// True when it was there, false when there was nothing to delete (no such
// branch, or not a repository). The name is made here from the id, never taken
// from a task file.
export async function deleteTaskBranch(project, taskId) {
  if (!SAFE_TASK_ID_PATTERN.test(taskId)) throw new Error(`unsafe task id: ${JSON.stringify(taskId)}`);
  return deleteBranchIfPresent(project, `consult/${taskId}`);
}

// Forgets worktrees whose folder is gone, and removes worktree folders that no
// task owns any more. Returns the ids of the folders it removed.
export async function pruneOrphans(project) {
  await runGit(project, ['worktree', 'prune']);
  const removed = [];
  if (!fs.existsSync(worktreesRoot())) return removed;
  for (const entry of fs.readdirSync(worktreesRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_TASK_ID_PATTERN.test(entry.name)) continue;
    if (readTask(entry.name) !== null) continue;
    await removeWorktreeFolder(project, path.join(worktreesRoot(), entry.name));
    removed.push(entry.name);
  }
  return removed;
}

// Takes the user's project, never a worker's copy: it compares two commits and
// needs no working tree. -z output: "<status>\0<path>\0", and for renames
// "R<score>\0<old>\0<new>\0". --no-relative: a diff.relative=true setting would
// otherwise print paths relative to the project folder instead of the repo root.
export async function changedFiles(project, from, to) {
  const output = await runGit(project, ['diff', '--name-status', '-M', '-z', '--no-ext-diff', '--no-relative', from, to]);
  const fields = output.split('\0');
  const changes = [];
  let position = 0;
  while (position < fields.length && fields[position] !== '') {
    const letter = fields[position][0];
    if (letter === 'R') {
      changes.push({ status: 'R', path: fields[position + 2], oldPath: fields[position + 1] });
      position += 3;
    } else {
      changes.push({ status: letter === 'T' ? 'M' : letter, path: fields[position + 1] });
      position += 2;
    }
  }
  return changes;
}

// `git diff --stat` between two commits of the user's project, for the result
// Claude reads. Hardened like changedFiles: no external diff program, and paths
// from the repository root whatever diff.relative says, and names with Cyrillic
// or spaces printed as they are instead of quoted.
export async function diffStat(project, from, to) {
  if (!COMMIT_ID_PATTERN.test(from || '') || !COMMIT_ID_PATTERN.test(to || '')) throw new Error('diffStat needs two commit ids');
  const unquotedPaths = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.quotepath', GIT_CONFIG_VALUE_0: 'false' };
  return (await runGit(project, ['diff', '--stat', '--no-ext-diff', '--no-relative', from, to], unquotedPaths)).trimEnd();
}

// ---- merging a finished copy back into the user's tree ----
//
// Files only: the user's index, HEAD and config are never touched (no `git add`),
// so `git diff --cached` stays as it was. Everything is judged in working-tree
// form: a blob in the object store may be normalised (line endings, filters), so
// it is converted with `cat-file --filters` using the PROJECT's own HEAD
// attributes (never the worker's) before it is compared, merged or written.
// Paths are relative to the repository root, which may be above the project.

const BINARY_SNIFF_BYTES = 8000;
const MERGE_ATTEMPTS = 2;
const SIDE_COPY_LIMIT = 20;
const HELD_REASON = 'runs or configures tools: needs the user\'s OK';

// Files that run something or configure a tool on their own once they are in a
// project (hooks, MCP servers, CI, direnv, editor and agent config, attributes
// that pick filter drivers) are almost all dot-paths, so the rule is an allowlist:
// mergeCopy never writes a path in place when ANY of its segments starts with a
// dot, except an inert dot file directly in a plain folder. The task's version is
// saved beside it and listed in `held`. Names that steer an agent or run code
// without being dot-files are held wherever they are: heldBasenamePatterns match
// the folded basename (CLAUDE.local.md, agent.md, mise.local.toml, the
// eslint/prettier config files editors load on open) and everything under a
// heldFolders folder is held (mise reads several files there). No .prettierrc*
// file is inert: prettier config can name plugins, which are code. Every segment
// is compared in two folds,
// both after the trailing dot/space folding used for .git: lower-case, and NFKC +
// upper + lower (so lookalike spellings fold too); either one matching holds it.
export const HELD_PATH_RULES = Object.freeze({
  inertDotFiles: Object.freeze([
    '.gitignore', '.gitkeep', '.editorconfig', '.prettierignore', '.eslintignore', '.dockerignore',
    '.nvmrc', '.node-version', '.python-version'
  ]),
  heldBasenamePatterns: Object.freeze([
    /^(claude|agents?|gemini)(\..+)?\.md$/,
    /^\.?mise(\..+)?\.toml$/,
    /^(eslint|prettier)\.config\.[a-z0-9]+$/
  ]),
  heldFolders: Object.freeze(['mise'])
});

// Like runGit, but stdout stays bytes and a non-zero exit status is returned
// instead of thrown (merge-file reports its conflict count that way). `input`,
// when given, is fed to git's stdin.
function runGitBytes(directory, args, extraEnv = {}, input = null) {
  const call = hardenedGitCall(directory, args, extraEnv);
  return new Promise((resolve, reject) => {
    const child = execFile('git', call.args, { ...call.options, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(new Error(`git ${args[0]} failed in ${directory}: ${error.message}`));
        return;
      }
      resolve({ status: error ? error.code : 0, stdout, stderr: stderr.toString('utf8') });
    });
    if (input !== null) {
      // git may exit before reading all of it; its exit status is what counts then
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

// Modes and blob ids of every changed path, keyed by the path after the change.
async function rawDiffEntries(project, from, to) {
  const output = await runGit(project, ['diff', '--raw', '--no-abbrev', '-M', '-z', '--no-ext-diff', '--no-relative', from, to]);
  const fields = output.split('\0');
  const entries = new Map();
  let position = 0;
  while (position < fields.length && fields[position] !== '') {
    const [oldMode, newMode, oldId, newId, statusText] = fields[position].slice(1).split(' ');
    const pathCount = statusText[0] === 'R' || statusText[0] === 'C' ? 2 : 1;
    entries.set(fields[position + pathCount], { oldMode, newMode, oldId, newId });
    position += 1 + pathCount;
  }
  return entries;
}

// Windows ignores trailing dots and spaces, and the name's case.
function foldedSegment(segment) {
  return segment.replace(/[. ]+$/, '').toLowerCase();
}

// The second fold: compatibility forms (fullwidth letters, long s) and case
// mappings that cross scripts (dotless i) land on the plain name.
function lookalikeFoldedSegment(segment) {
  return segment.replace(/[. ]+$/, '').normalize('NFKC').toUpperCase().toLowerCase();
}

function isGitDirectoryName(segment) {
  // Windows also knows the folder as GIT~1.
  for (const folded of [foldedSegment(segment), lookalikeFoldedSegment(segment)]) {
    if (folded === '.git' || /^git~\d+$/.test(folded)) return true;
  }
  return false;
}

function isHeldInFold(segments) {
  const basename = segments[segments.length - 1];
  for (const pattern of HELD_PATH_RULES.heldBasenamePatterns) {
    if (pattern.test(basename)) return true;
  }
  for (let index = 0; index < segments.length - 1; index++) {
    if (segments[index].startsWith('.')) return true;
    if (HELD_PATH_RULES.heldFolders.includes(segments[index])) return true;
  }
  if (!basename.startsWith('.')) return false;
  return !HELD_PATH_RULES.inertDotFiles.includes(basename);
}

function isHeldPath(relativePath) {
  const segments = relativePath.split('/');
  return isHeldInFold(segments.map(foldedSegment)) || isHeldInFold(segments.map(lookalikeFoldedSegment));
}

// Where the path really lands: the deepest existing part resolved through the
// filesystem (long names for 8.3 aliases, true case), the rest as written.
function resolvedRelativePath(root, relativePath) {
  const segments = relativePath.split('/');
  let deepestExisting = root;
  let existingCount = 0;
  for (const segment of segments) {
    const candidate = path.join(deepestExisting, segment);
    if (!fs.existsSync(candidate)) break;
    deepestExisting = candidate;
    existingCount++;
  }
  const resolvedPart = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(deepestExisting)).split(path.sep);
  return [...resolvedPart.filter((segment) => segment !== ''), ...segments.slice(existingCount)].join('/');
}

// The task's end commit is worker-controlled, so a path from it is only written
// or deleted after this passes: inside the repository, not under .git, and no
// existing component of it (including the file itself) a symlink or junction.
// Returns the reason it is refused, or null.
function unsafeTargetReason(root, relativePath) {
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return 'path escapes the repository';
    if (segment.includes('\\') || (process.platform === 'win32' && segment.includes(':'))) return 'path escapes the repository';
    // Refused on every platform, as git's protectNTFS does: on Windows CLAUDE~1 is
    // the existing .claude folder, which no name check on the raw path can see.
    if (/~[0-9]/.test(segment)) return 'short (8.3) name';
    if (isGitDirectoryName(segment)) return 'path is inside .git';
  }
  const resolved = path.resolve(root, ...segments);
  if (isOutside(root, resolved)) return 'path escapes the repository';
  let deepestExisting = root;
  let candidate = root;
  for (let index = 0; index < segments.length; index++) {
    candidate = path.join(candidate, segments[index]);
    let info;
    try {
      info = fs.lstatSync(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      return 'path cannot be inspected';
    }
    if (info.isSymbolicLink()) return 'symlink or junction in path';
    const isLast = index === segments.length - 1;
    if (isLast && !info.isFile()) return 'not a regular file';
    if (!isLast && !info.isDirectory()) return 'a parent of the path is not a folder';
    deepestExisting = candidate;
  }
  const realRoot = fs.realpathSync.native(root);
  const realDeepest = path.relative(realRoot, fs.realpathSync.native(deepestExisting));
  if (realDeepest.startsWith('..') || path.isAbsolute(realDeepest)) return 'path leaves the repository';
  return null;
}

function readWorkingFile(absolutePath) {
  try {
    return fs.readFileSync(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameBytes(first, second) {
  if (first === null || second === null) return first === second;
  return first.equals(second);
}

function hasNulByte(bytes) {
  return bytes !== null && bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

// 'crlf' or 'lf' by majority of the file's line breaks; null when it has none.
function lineEndingStyleOf(bytes) {
  let crlfCount = 0;
  let loneLfCount = 0;
  for (let position = 0; position < bytes.length; position++) {
    if (bytes[position] !== 0x0a) continue;
    if (position > 0 && bytes[position - 1] === 0x0d) crlfCount++;
    else loneLfCount++;
  }
  if (crlfCount === 0 && loneLfCount === 0) return null;
  return crlfCount > loneLfCount ? 'crlf' : 'lf';
}

// latin1 maps every byte to one character and back, so nothing else changes.
function withLineEndings(bytes, style) {
  const asLf = bytes.toString('latin1').replace(/\r\n/g, '\n');
  return Buffer.from(style === 'crlf' ? asLf.replace(/\n/g, '\r\n') : asLf, 'latin1');
}

// The task's text in the line-ending style the user's file already has, so a
// merged or replaced file never ends up with mixed endings. Binary content and
// a file with no line break to copy the style from are left as git produced them.
async function inStyleOf(context, relativePath, bytes, current) {
  const style = lineEndingStyleOf(current);
  if (style === null || hasNulByte(bytes) || hasNulByte(current)) return bytes;
  const converted = withLineEndings(bytes, style);
  if (converted.equals(bytes)) return bytes;
  if (await markedNoDiff(context, relativePath)) return bytes;
  return converted;
}

// The blob id git would store for these bytes at this path (clean filters, line
// endings and attributes of the project's HEAD applied), nothing written. A file
// is "as it was" when this equals the start blob id. null when git cannot say.
async function storedIdOf(context, relativePath, bytes) {
  const call = await runGitBytes(
    context.root,
    ['hash-object', '--stdin', `--path=${relativePath}`],
    { GIT_ATTR_SOURCE: context.attributesCommit },
    bytes
  );
  return call.status === 0 ? call.stdout.toString('utf8').trim() : null;
}

async function workingFormOfBlob(context, relativePath, blobId) {
  const call = await runGitBytes(
    context.root,
    ['cat-file', '--filters', `--path=${relativePath}`, blobId],
    { GIT_ATTR_SOURCE: context.attributesCommit }
  );
  if (call.status !== 0) throw new Error(`git cat-file failed for ${relativePath}: ${call.stderr.trim()}`);
  return call.stdout;
}

async function markedNoDiff(context, relativePath) {
  const call = await runGitBytes(
    context.root,
    ['check-attr', 'diff', '--', relativePath],
    { GIT_ATTR_SOURCE: context.attributesCommit }
  );
  return call.status === 0 && call.stdout.toString('utf8').trim().endsWith(': diff: unset');
}

// `git merge-file -p`: the exit status is the number of conflicts (0 = clean),
// and 128 or more is an error.
async function mergeThreeWay(context, currentBytes, baseBytes, theirsBytes) {
  const currentFile = path.join(context.tempFolder, 'current');
  const baseFile = path.join(context.tempFolder, 'base');
  const theirsFile = path.join(context.tempFolder, 'theirs');
  fs.writeFileSync(currentFile, currentBytes);
  fs.writeFileSync(baseFile, baseBytes);
  fs.writeFileSync(theirsFile, theirsBytes);
  const call = await runGitBytes(
    context.tempFolder,
    ['merge-file', '-p', '-L', 'yours', '-L', 'start', '-L', 'task', currentFile, baseFile, theirsFile]
  );
  return { conflictCount: call.status, merged: call.stdout };
}

// What to do to one file, decided from bytes only (nothing is written here):
// { write, taskCopy, remove, conflict, failure }.
async function decideOutcome(context, status, relativePath, entry, current) {
  const outcome = { write: null, taskCopy: null, remove: false, conflict: false, failure: null };
  // "As it was" and "already the task's" are judged the way git judges a file:
  // by the blob id its clean filters would store, not by raw bytes.
  const currentId = current === null ? null : await storedIdOf(context, relativePath, current);
  if (status === 'D') {
    if (current === null) return outcome;
    if (currentId === entry.oldId) {
      outcome.remove = true;
    } else {
      outcome.conflict = true;
    }
    return outcome;
  }
  if (currentId !== null && currentId === entry.newId) return outcome;
  const theirs = await workingFormOfBlob(context, relativePath, entry.newId);
  if (current === null && status === 'A') {
    outcome.write = theirs;
    return outcome;
  }
  if (current === null) {
    outcome.conflict = true;
    outcome.taskCopy = theirs;
    return outcome;
  }
  if (status === 'M' && currentId === entry.oldId) {
    outcome.write = await inStyleOf(context, relativePath, theirs, current);
    return outcome;
  }
  const base = status === 'M' ? await workingFormOfBlob(context, relativePath, entry.oldId) : Buffer.alloc(0);
  const looksBinary = hasNulByte(current) || hasNulByte(base) || hasNulByte(theirs) || await markedNoDiff(context, relativePath);
  if (looksBinary) {
    outcome.conflict = true;
    outcome.taskCopy = theirs;
    return outcome;
  }
  const merge = await mergeThreeWay(
    context,
    current,
    await inStyleOf(context, relativePath, base, current),
    await inStyleOf(context, relativePath, theirs, current)
  );
  if (merge.conflictCount >= 128) {
    outcome.failure = 'git merge-file failed';
    return outcome;
  }
  outcome.write = merge.merged;
  outcome.conflict = merge.conflictCount > 0;
  return outcome;
}

function blockedByMode(status, entry) {
  const modes = status === 'D' ? [entry.oldMode] : status === 'A' ? [entry.newMode] : [entry.oldMode, entry.newMode];
  for (const mode of modes) {
    if (mode === '120000') return 'symlink';
    if (mode === '160000') return 'submodule';
  }
  return null;
}

// Saves the task's version beside `relativePath` as <file>.task, or .task.2 to
// .task.20 when that name is taken (an existing file is never overwritten, hence
// the 'wx' flag). Each candidate passes the same path checks as a merge target.
// Returns the copy's repo-relative path, or null when none could be written.
function saveSideCopy(context, result, relativePath, bytes) {
  for (let number = 1; number <= SIDE_COPY_LIMIT; number++) {
    const copyPath = number === 1 ? `${relativePath}.task` : `${relativePath}.task.${number}`;
    if (unsafeTargetReason(context.root, copyPath) !== null) continue;
    const absoluteCopy = path.join(context.root, ...copyPath.split('/'));
    try {
      fs.mkdirSync(path.dirname(absoluteCopy), { recursive: true });
      fs.writeFileSync(absoluteCopy, bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    result.task_copies.push({ path: relativePath, task_copy: copyPath });
    return copyPath;
  }
  return null;
}

// A file that runs or configures a tool: the real file is left alone and the
// task's version is saved beside it (nothing to save for a delete). A rename held
// whole is listed under its new path, with the old one in `renamed_from`.
async function holdFile(context, result, status, relativePath, entry, renamedFrom = null) {
  let copyPath = null;
  if (status !== 'D') {
    const theirs = await workingFormOfBlob(context, relativePath, entry.newId);
    copyPath = saveSideCopy(context, result, relativePath, theirs);
    if (copyPath === null) {
      result.skipped.push({ path: relativePath, reason: 'could not save a side copy' });
      return;
    }
  }
  const held = { path: relativePath, task_copy: copyPath, reason: HELD_REASON };
  if (renamedFrom !== null) held.renamed_from = renamedFrom;
  result.held.push(held);
}

function isHeldTarget(context, relativePath) {
  return isHeldPath(relativePath) || isHeldPath(resolvedRelativePath(context.root, relativePath));
}

// `renamedFrom` is the old path of a rename held whole: the new path is held, and nothing is done to the old one.
async function applyOneChange(context, result, status, relativePath, entry, renamedFrom = null) {
  const modeReason = blockedByMode(status, entry);
  if (modeReason !== null) {
    result.skipped.push({ path: relativePath, reason: modeReason });
    return;
  }
  const unsafeReason = unsafeTargetReason(context.root, relativePath);
  if (unsafeReason !== null) {
    result.skipped.push({ path: relativePath, reason: unsafeReason });
    return;
  }
  if (renamedFrom !== null || isHeldTarget(context, relativePath)) {
    await holdFile(context, result, status, relativePath, entry, renamedFrom);
    return;
  }
  const absolutePath = path.join(context.root, ...relativePath.split('/'));
  for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
    const current = readWorkingFile(absolutePath);
    const outcome = await decideOutcome(context, status, relativePath, entry, current);
    if (outcome.failure !== null) {
      result.skipped.push({ path: relativePath, reason: outcome.failure });
      return;
    }
    // Re-checked right before writing: the user may have saved the file meanwhile.
    if (!sameBytes(current, readWorkingFile(absolutePath))) continue;
    if (outcome.taskCopy !== null && saveSideCopy(context, result, relativePath, outcome.taskCopy) === null) {
      // Reported once: nothing was written, so it is skipped rather than also a conflict.
      result.skipped.push({ path: relativePath, reason: 'could not save a side copy' });
      return;
    }
    if (outcome.write !== null) {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, outcome.write);
    }
    if (outcome.remove) fs.unlinkSync(absolutePath);
    (outcome.conflict ? result.conflicts : result.applied).push(relativePath);
    return;
  }
  result.skipped.push({ path: relativePath, reason: 'changed while merging' });
}

// One file failing (read-only, locked, a filter that errors) is recorded and the
// merge goes on, so the caller always has a full account of what was written.
async function mergeOneFile(context, result, status, relativePath, entry, renamedFrom = null) {
  try {
    if (entry === undefined) throw new Error('no diff entry for this path');
    await applyOneChange(context, result, status, relativePath, entry, renamedFrom);
  } catch (error) {
    result.skipped.push({ path: relativePath, reason: error.code || error.message });
  }
}

// A rename is merged as a delete of the old path and an add of the new one, unless
// either path is held: then the whole rename is held, so the user's old file is not
// deleted for a new file that was only saved beside its path.
async function mergeOneChange(context, result, change, entries) {
  const entry = entries.get(change.path);
  if (change.status === 'R') {
    const isOldSideUsable = entry !== undefined && blockedByMode('D', entry) === null && unsafeTargetReason(context.root, change.oldPath) === null;
    if (isOldSideUsable && (isHeldTarget(context, change.oldPath) || isHeldTarget(context, change.path))) {
      await mergeOneFile(context, result, 'A', change.path, entry, change.oldPath);
      return;
    }
    await mergeOneFile(context, result, 'D', change.oldPath, entry);
    await mergeOneFile(context, result, 'A', change.path, entry);
  } else {
    await mergeOneFile(context, result, change.status, change.path, entry);
  }
}

// Applies what the task changed between `start_commit` and `end_commit` to the
// user's working files. A file the user did not touch gets the task's version (in
// the file's own line-ending style); a file both sides changed is merged, and left
// with conflict markers (or, for a binary file, kept with the task's version saved
// beside it). Returns paths relative to the repository root:
// - applied: written, deleted, or already what the task made it.
// - conflicts: both sides changed; the user's file is kept (with markers if text).
// - skipped: [{ path, reason }] not touched: unsafe path, symlink/submodule entry,
//   a write that failed, a side copy that could not be saved.
// - held: [{ path, task_copy, reason }] files that run or configure tools
//   (HELD_PATH_RULES); never written in place. task_copy is null for a delete.
// - task_copies: [{ path, task_copy }] every side copy written (<file>.task, then
//   .task.2 ... .task.20; an existing file is never overwritten).
//
// `carried` is [{ path, base }]: files an earlier merge skipped, each with the commit
// it was diffed from. They are merged first, from their own base to `end_commit`, and
// a path both carried and changed since `start_commit` is merged once, from the older base.
export async function mergeCopy(project, { start_commit, end_commit, carried = [] }) {
  if (!COMMIT_ID_PATTERN.test(start_commit || '')) throw new Error('start_commit is not a commit id');
  if (!COMMIT_ID_PATTERN.test(end_commit || '')) throw new Error('end_commit is not a commit id');
  const state = await gitState(project);
  if (!state.isRepo || !state.hasCommit) throw new Error(`${project} has no git history to merge into`);
  const tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-merge-'));
  try {
    const context = {
      root: state.root,
      attributesCommit: (await runGit(project, ['rev-parse', '--verify', 'HEAD'])).trim(),
      tempFolder
    };
    const result = { applied: [], conflicts: [], skipped: [], held: [], task_copies: [] };
    // A state.json is writable by the worker: only a real commit id is diffed from.
    const pathsByBase = new Map();
    for (const entry of carried) {
      if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || !COMMIT_ID_PATTERN.test(entry.base || '')) continue;
      if (!pathsByBase.has(entry.base)) pathsByBase.set(entry.base, new Set());
      pathsByBase.get(entry.base).add(entry.path);
    }
    // Merged from the carried bases first, so a path in both ranges goes through once, from the older base.
    const done = new Set();
    for (const [base, wanted] of pathsByBase) {
      const changes = await changedFiles(project, base, end_commit);
      const entries = await rawDiffEntries(project, base, end_commit);
      for (const change of changes) {
        if (done.has(change.path) || !(wanted.has(change.path) || (change.status === 'R' && wanted.has(change.oldPath)))) continue;
        await mergeOneChange(context, result, change, entries);
        done.add(change.path);
        if (change.status === 'R') done.add(change.oldPath);
      }
    }
    const changes = await changedFiles(project, start_commit, end_commit);
    const entries = await rawDiffEntries(project, start_commit, end_commit);
    for (const change of changes) {
      if (done.has(change.path) || (change.status === 'R' && done.has(change.oldPath))) continue;
      await mergeOneChange(context, result, change, entries);
    }
    return result;
  } finally {
    fs.rmSync(tempFolder, { recursive: true, force: true });
  }
}
