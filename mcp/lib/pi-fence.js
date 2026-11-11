// A pi extension for delegate's fenced local worker (Layer 2: the guard).
// delegate-workers.js passes it with `-e` next to pi-provider.js and sets
// CONSULT_FENCE_DIR to the work folder. It refuses `write` and `edit` calls
// whose target is outside that folder. bash and everything else pass: under
// the Codex sandbox Windows fences bash, and without it commands cannot be
// checked.
//
// CONSULT_FENCE_PROTECTED (a JSON array of paths) names consult's own files
// and folders that sit inside the work folder (fenceProtectedPaths in
// delegate-store.js). Writes to them are refused even though they are inside.
// A list that cannot be read refuses every write.
//
// realPathOfTarget and isInside are also used by consult itself (delegate-store.js,
// delegate-workers.js); pi uses only the default export.
//
// pi 1.4.0 (docs/extensions.md and dist/core/extensions/types.d.ts in
// @earendil-works/pi-coding-agent): pi.on('tool_call', async (event, ctx) => ...)
// gets { toolName, toolCallId, input }; write and edit inputs carry `path`.
// Returning { block: true, reason } stops the call; returning nothing allows
// it. A handler that throws blocks too, which is the fail-closed we want.
//
// Not isInsideFolder from resolve-cmd.js: that treats the home folder, its
// parents and drive roots as containing nothing, so a project at home would
// look empty here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARDED_TOOLS = ['write', 'edit'];

// The path as pi's own write and edit tools read it (pi 1.4.0,
// dist/utils/paths.js resolvePath with normalizeUnicodeSpaces and
// stripAtPrefix): unicode spaces become plain spaces, one leading '@' is
// dropped, Git Bash style /c/x becomes C:\x, '~' and '~/' '~\' expand to the
// home folder, file:// URLs become paths. Mirrored, not imported: pi's
// package does not export it to extensions. The base folder goes through the
// same normalisation. Whatever still starts with '~' or '@' is refused by the
// caller.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeLikePi(input) {
  let normalized = input.replace(UNICODE_SPACES, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized.startsWith('/') && !normalized.startsWith('//') && !normalized.includes('\\')) {
    const gitBashDrive = normalized.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (gitBashDrive) normalized = `${gitBashDrive[1].toUpperCase()}:\\${(gitBashDrive[2] ?? '').replaceAll('/', '\\')}`;
  }
  if (normalized === '~') return os.homedir();
  if (normalized.startsWith('~/') || normalized.startsWith('~\\')) return path.join(os.homedir(), normalized.slice(2));
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

function resolveLikePi(input, baseDirectory) {
  const normalized = normalizeLikePi(input);
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(normalizeLikePi(baseDirectory), normalized);
}

// The real path of `target`, which may not exist yet: the realpath of its
// nearest existing parent (junctions and symlinks resolved), then the missing
// tail put back. Existence is tested with lstat, so a dangling link counts as
// present: its stored target is followed instead of being treated as missing.
export function realPathOfTarget(target, linkDepth = 0) {
  let existing = target;
  const missingTail = [];
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (_) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missingTail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  try {
    return path.join(fs.realpathSync.native(existing), ...missingTail);
  } catch (error) {
    if (linkDepth >= 40) throw error;
    // A link whose target does not exist (realpath fails): check where it points.
    const stored = fs.readlinkSync(existing).replace(/^\\\\\?\\/, '');
    return realPathOfTarget(path.join(path.resolve(path.dirname(existing), stored), ...missingTail), linkDepth + 1);
  }
}

// Lowercase, backslash separators, no trailing separator.
function comparable(folderOrFile) {
  return folderOrFile.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export function isInside(target, fenceDirectory) {
  const targetKey = comparable(target);
  const fenceKey = comparable(fenceDirectory);
  return targetKey === fenceKey || targetKey.startsWith(fenceKey + '\\');
}

// The fence folder's real path and the protected list, resolved on the first guarded call and kept:
// neither changes during a pi run. Each is kept with the environment text it came from, so a
// changed variable (the unit tests change them between calls) is read again.
let resolvedFence = null;
let resolvedProtected = null;

function realFenceDirectory(fenceDirectoryRaw) {
  if (resolvedFence === null || resolvedFence.raw !== fenceDirectoryRaw) {
    resolvedFence = { raw: fenceDirectoryRaw, real: fs.realpathSync.native(path.resolve(fenceDirectoryRaw)) };
  }
  return resolvedFence.real;
}

// The real paths of the protected entries, or null when the list cannot be read (every write is refused then).
function realProtectedPaths(protectedRaw) {
  if (resolvedProtected === null || resolvedProtected.raw !== protectedRaw) {
    let protectedPaths;
    try {
      protectedPaths = JSON.parse(protectedRaw);
    } catch (_) {
      protectedPaths = null;
    }
    let real = null;
    if (Array.isArray(protectedPaths)) {
      real = [];
      for (const protectedPath of protectedPaths) {
        if (typeof protectedPath !== 'string' || protectedPath === '') continue;
        real.push(realPathOfTarget(path.resolve(protectedPath)));
      }
    }
    resolvedProtected = { raw: protectedRaw, real };
  }
  return resolvedProtected.real;
}

export default function (pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (!GUARDED_TOOLS.includes(event.toolName)) return undefined;

    const fenceDirectoryRaw = process.env.CONSULT_FENCE_DIR;
    const requested = event.input?.path ?? event.input?.file_path;
    if (!fenceDirectoryRaw) {
      return { block: true, reason: 'This task is fenced, but no work folder was given, so no writes are allowed.' };
    }
    if (typeof requested !== 'string' || requested === '') {
      return { block: true, reason: `This task is fenced to ${fenceDirectoryRaw}; this ${event.toolName} call names no path.` };
    }

    // pi resolves against ctx.cwd when it has one (write.js: ctx?.cwd || cwd).
    const normalizedRequest = normalizeLikePi(requested);
    if (normalizedRequest.startsWith('~') || normalizedRequest.startsWith('@')) {
      return { block: true, reason: `This task is fenced to ${fenceDirectoryRaw}; ${requested} is not a path the guard can check.` };
    }
    const target = realPathOfTarget(resolveLikePi(requested, ctx?.cwd || process.cwd()));
    const fenceDirectory = realFenceDirectory(fenceDirectoryRaw);
    const protectedRaw = process.env.CONSULT_FENCE_PROTECTED;
    if (protectedRaw !== undefined && protectedRaw !== '') {
      const protectedReals = realProtectedPaths(protectedRaw);
      if (protectedReals === null) {
        return { block: true, reason: `This task is fenced to ${fenceDirectoryRaw}, and the list of consult's own files could not be read, so no writes are allowed.` };
      }
      for (const protectedReal of protectedReals) {
        // A protected folder that holds the work folder (a copy under consult's data) adds nothing:
        // the rest of it is outside the fence anyway.
        const holdsFence = isInside(fenceDirectory, protectedReal) && !isInside(protectedReal, fenceDirectory);
        if (holdsFence) continue;
        if (isInside(target, protectedReal)) {
          return { block: true, reason: `This task is fenced to ${fenceDirectoryRaw}; ${target} is one of consult's own files, which a fenced worker may not change.` };
        }
      }
    }
    if (isInside(target, fenceDirectory)) return undefined;
    return { block: true, reason: `This task is fenced to ${fenceDirectoryRaw}; ${target} is outside it.` };
  });
}
