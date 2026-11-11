// Resolve a CLI command to a concrete executable path on Windows.
// Node's `spawn` cannot find `.cmd` / `.bat` shims (which is how npm installs
// CLIs on Windows) without `shell: true`, and Node v18.20+ refuses to spawn
// .cmd directly without it (CVE-2024-27980). We resolve once at first use
// with `where`, cache the result, and let the spawn wrappers add shell:true
// via SPAWN_OPTS.
//
// `resolveCmd` always returns an entry (never throws) so module load is
// reliable even when one of two CLIs is missing. Callers that need to act
// on a missing CLI use `ensureCmd`, which throws a clean error.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SPAWN_OPTS = Object.freeze({ shell: process.platform === 'win32' });

// cmd.exe and CreateProcess look in the current folder (the project) before PATH
// for a bare program name, and the npm shims call a bare `node`. With this set,
// every child of this process skips the current folder.
if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';

// The executable as spawn should receive it. Under shell:true cmd.exe splits an
// unquoted path at its first space, so a CLI in `C:\Program Files\...` or a
// profile like `C:\Users\Jane Doe\...` failed to start ("'C:\Program' is not
// recognized"); it also splits at `,` `;` `=`, and runs an unquoted `&`, `|` or
// `^` as cmd syntax, so `C:\Tools\A&ver&B\codex.cmd` would run `ver`. The path
// is therefore always quoted. `%VAR%` expands even inside quotes and a quote
// cannot be escaped, so such a path is refused.
export function spawnableCmd(binPath) {
  if (!SPAWN_OPTS.shell) return binPath;
  if (/["%]/.test(binPath)) {
    throw new Error(`Refusing to run ${binPath}: a path with a quote or percent sign cannot be passed safely to cmd.exe. Move the CLI to a folder without them.`);
  }
  return `"${binPath}"`;
}

// An EMPTY argv element does not survive shell:true -- Node concatenates args
// into one command line, so '' vanishes and the flag before it swallows the
// flag after it (`--tools '' --strict-mcp-config` becomes
// `--tools --strict-mcp-config`). Verified on Node 24 / win32. A literal '""'
// reaches the child as an empty string. Use this wherever a CLI needs "".
export const EMPTY_ARG = SPAWN_OPTS.shell ? '""' : '';

const cache = new Map();

// Well-known install locations, checked when `where` comes up empty.
//
// An installer that edits the PATH registry (agy's does) cannot reach running
// processes: a terminal keeps its launch-time environment and passes it on, so
// this server stays blind to the new PATH until the terminal is replaced.
function knownLocations(name) {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

  if (process.platform === 'win32') {
    const npmGlobal = [path.join(appData, 'npm', `${name}.cmd`), path.join(appData, 'npm', `${name}.exe`)];
    switch (name) {
      case 'agy':    return [path.join(localAppData, 'agy', 'bin', 'agy.exe'), ...npmGlobal];
      case 'claude': return [path.join(localAppData, 'Programs', 'claude', 'claude.exe'), ...npmGlobal];
      // Codex's own installer (0.15x standalone) lives here; the npm package is
      // still a valid install so both are tried.
      case 'codex':  return [path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), ...npmGlobal];
      default:       return npmGlobal;   // gemini: npm-installed
    }
  }
  // POSIX: npm global prefixes and the usual manual-install spots.
  return [
    path.join(home, '.local', 'bin', name),
    path.join(home, '.npm-global', 'bin', name),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    path.join(programFiles, name, name)
  ];
}

function firstExisting(candidates) {
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (_) {}
  }
  return null;
}

// A CLI file is trusted only as an absolute path outside the project: `where`
// and cmd.exe look in the current folder first, so a repository that ships its
// own codex.cmd or agy.cmd would otherwise run it on the user's machine.
function windowsPathKey(file) {
  return path.win32.normalize(file).toLowerCase().replace(/\\+$/, '');
}

// where.exe prints a hit's long real path, while the project can be open
// through a junction or an 8.3 short name (C:\Users\RUNNER~1\...): a path is
// compared both as written and as its real long path.
function windowsPathKeys(file) {
  const keys = [windowsPathKey(file)];
  try {
    const realKey = windowsPathKey(fs.realpathSync.native(file));
    if (realKey !== keys[0]) keys.push(realKey);
  } catch (_) { /* a path that does not exist keeps its written form */ }
  return keys;
}

// Started from the home folder, one of its parents or a drive root, "inside the
// project" would cover every trusted install (%APPDATA%\npm, Program Files), so
// only the absolute-path rule applies there.
function isBroadFolder(projectKey) {
  if (/^[a-z]:$/.test(projectKey)) return true;
  for (const homeKey of windowsPathKeys(os.homedir())) {
    if (homeKey === projectKey || homeKey.startsWith(projectKey + '\\')) return true;
  }
  return false;
}

// True for the home folder, any parent of it and a drive root: a folder that must never become a sandbox write root.
export function isBroadWorkFolder(folder) {
  if (process.platform === 'win32') {
    for (const key of windowsPathKeys(folder)) {
      if (isBroadFolder(key)) return true;
    }
    return false;
  }
  const resolved = path.resolve(folder);
  const home = os.homedir();
  return resolved === path.parse(resolved).root || home === resolved || home.startsWith(resolved + path.sep);
}

// Inside the project in either spelling of either path means inside.
function isOutsideProject(file, projectFolder) {
  if (!path.win32.isAbsolute(file)) return false;
  const projectKeys = windowsPathKeys(projectFolder);
  for (const projectKey of projectKeys) {
    if (isBroadFolder(projectKey)) return true;
  }
  for (const fileKey of windowsPathKeys(file)) {
    for (const projectKey of projectKeys) {
      if (fileKey === projectKey || fileKey.startsWith(projectKey + '\\')) return false;
    }
  }
  return true;
}

// True when a resolved program is an absolute Windows path inside this folder.
// The supervisor runs from the task folder, so resolveCmd's own filter (which
// compares with process.cwd()) cannot see the project; it asks this instead.
// The same home-folder and drive-root exemption applies.
export function isInsideFolder(file, folder) {
  return path.win32.isAbsolute(file) && !isOutsideProject(file, folder);
}

// Prefer .cmd first - npm-installed CLIs ship as .cmd shims on Windows.
// A coexisting .exe with the same name is more likely to be an unrelated
// tool (or stale install) than the npm shim we want.
export function pickWindowsHit(lines, projectFolder) {
  const trusted = [];
  for (const line of lines) {
    if (isOutsideProject(line, projectFolder)) trusted.push(line);
  }
  const ranked = (ext) => trusted.find(l => l.toLowerCase().endsWith(ext));
  return ranked('.cmd') || ranked('.exe') || ranked('.bat') || trusted[0] || null;
}

// The hits `pickWindowsHit` skips, so the user can be told why a CLI that
// `where` found is not used.
export function refusedWindowsHits(lines, projectFolder) {
  const refused = [];
  for (const line of lines) {
    if (!isOutsideProject(line, projectFolder)) refused.push(line);
  }
  return refused;
}

// `$PATH:<name>` searches the PATH directories only; a bare name would search
// the current folder (the project) first. where.exe is called by its System32
// path because libuv would otherwise run a where.exe planted in the project.
export function whereCommand(name) {
  return { file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), args: [`$PATH:${name}`] };
}

export function resolveCmd(name) {
  if (cache.has(name)) return cache.get(name);

  let entry = { path: name, found: true };
  if (process.platform === 'win32') {
    let found = null;
    let refused = null;
    try {
      const where = whereCommand(name);
      const out = execFileSync(where.file, where.args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        windowsHide: true
      });
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      found = pickWindowsHit(lines, process.cwd());
      refused = refusedWindowsHits(lines, process.cwd())[0] ?? null;
    } catch (_) { /* not on PATH -- fall through to the known-location probe */ }

    // PATH lost the race with the installer; look where it would have landed.
    if (!found) {
      const candidates = [];
      for (const candidate of knownLocations(name)) {
        if (isOutsideProject(candidate, process.cwd())) candidates.push(candidate);
      }
      found = firstExisting(candidates);
    }
    entry = found ? { path: found, found: true } : { path: `${name}.cmd`, found: false, refused };
  } else {
    // POSIX: spawn resolves PATH itself, so only step in when it would fail.
    try {
      execFileSync('sh', ['-c', `command -v ${JSON.stringify(name)}`], { stdio: 'ignore' });
    } catch (_) {
      const found = firstExisting(knownLocations(name));
      entry = found ? { path: found, found: true } : { path: name, found: false };
    }
  }
  cache.set(name, entry);
  return entry;
}

// Returns a usable absolute path or throws a clear error pointing at the
// real fix (install / PATH). Use this from spawn wrappers right before
// invoking the CLI.
const INSTALL_HINTS = {
  codex: 'npm i -g @openai/codex',
  gemini: 'npm i -g @google/gemini-cli',
  agy: 'install from https://antigravity.google',
  claude: 'see https://claude.com/claude-code'
};

// Said when the only hit for a CLI sits in the project folder, which consult
// never runs: it is not "not installed", and PATH is not what needs fixing.
export function missingMessage(name, refusedPath) {
  return `Found ${name} only inside the project folder (${refusedPath}); consult won't run it. ` +
    `Install ${name} outside the project, or put its folder on PATH.`;
}

export function ensureCmd(name) {
  const r = resolveCmd(name);
  if (!r.found && r.refused) {
    const err = new Error(missingMessage(name, r.refused));
    err.kind = 'spawn_error';
    throw err;
  }
  if (!r.found) {
    const install = INSTALL_HINTS[name] ? ` Install it: ${INSTALL_HINTS[name]}.` : '';
    // The new-terminal note matters for installers that write the user PATH
    // registry: the terminal keeps the environment it started with and hands
    // it to everything it launches, so restarting Claude Code in the SAME
    // terminal still cannot see the binary (see the header comment).
    // kind 'spawn_error' is what callers test for "binary missing" (agyStatus,
    // codexLoginStatus, codexChatEnd). Without it a missing CLI read as a
    // generic error, because this throw happens before anything is spawned.
    const err = new Error(
      `${name} CLI not found on PATH or in its default install location.${install} ` +
      `If you just installed it, open a NEW terminal and start Claude Code from there -- ` +
      `restarting Claude Code in the same terminal keeps the old PATH. Otherwise fix PATH so \`where ${name}\` succeeds.`
    );
    err.kind = 'spawn_error';
    throw err;
  }
  return r.path;
}
