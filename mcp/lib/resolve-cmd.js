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

// The executable as spawn should receive it. Under shell:true cmd.exe splits an
// unquoted path at its first space, so a CLI in `C:\Program Files\...` or a
// profile like `C:\Users\Jane Doe\...` failed to start ("'C:\Program' is not
// recognized").
export function spawnableCmd(binPath) {
  return SPAWN_OPTS.shell && /\s/.test(binPath) ? `"${binPath}"` : binPath;
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

export function resolveCmd(name) {
  if (cache.has(name)) return cache.get(name);

  let entry = { path: name, found: true };
  if (process.platform === 'win32') {
    let found = null;
    try {
      const out = execFileSync('where', [name], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        windowsHide: true
      });
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      // Prefer .cmd first - npm-installed CLIs ship as .cmd shims on Windows.
      // A coexisting .exe with the same name is more likely to be an unrelated
      // tool (or stale install) than the npm shim we want.
      const ranked = (ext) => lines.find(l => l.toLowerCase().endsWith(ext));
      found = ranked('.cmd') || ranked('.exe') || ranked('.bat') || lines[0] || null;
    } catch (_) { /* not on PATH -- fall through to the known-location probe */ }

    // PATH lost the race with the installer; look where it would have landed.
    if (!found) found = firstExisting(knownLocations(name));
    entry = found ? { path: found, found: true } : { path: `${name}.cmd`, found: false };
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

export function ensureCmd(name) {
  const r = resolveCmd(name);
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
