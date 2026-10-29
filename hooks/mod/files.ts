import type { EngineInterface } from 'claude-code'

// Opening and revealing an image consult saved, per platform. Each path is
// one argv element: no shell, so spaces and non-ASCII names pass as they are.

export type Platform = 'windows' | 'mac' | 'linux'

export async function platformOf($: EngineInterface): Promise<Platform> {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  const home = await $.env.get('HOME')
  if (home !== undefined && home.startsWith('/Users/')) return 'mac'
  return 'linux'
}

// consult's delegate data folder (CONSULT_DELEGATE_HOME, else under the home folder), forward slashes kept as given.
export async function dataHome($: EngineInterface): Promise<string | null> {
  const override = await $.env.get('CONSULT_DELEGATE_HOME')
  if (override !== undefined && override !== '') return override.replace(/[\\/]+$/, '')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home}/.claude/consult-delegate` : null
}

function parentFolder(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : path
}

export function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(cut + 1)
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']

// Only an absolute local path reaches explorer.exe / open / xdg-open. On
// Windows that is a drive path: one starting with '/' would be read as a
// switch (/e,), a UNC path would open a file on another machine, and a comma
// would split explorer's /select, argument; a second ':' names a stream.
export function isSafePath(p: Platform, path: string): boolean {
  if (/[\u0000-\u001f"]/.test(path)) return false
  if (p === 'windows') {
    if (!/^[A-Za-z]:[\\/]/.test(path)) return false
    return !path.slice(2).includes(':') && !path.includes(',')
  }
  return path.startsWith('/') && !path.startsWith('//')
}

// Open hands the path to the system's file association, so only an image
// may be opened: a result naming run.bat must never run it.
export function isImagePath(p: Platform, path: string): boolean {
  if (!isSafePath(p, path)) return false
  const lower = path.toLowerCase()
  for (const extension of IMAGE_EXTENSIONS) {
    if (lower.endsWith(extension)) return true
  }
  return false
}

const TEXT_EXTENSIONS = ['.md', '.txt', '.log']

// A text report consult wrote itself (a worker's final.md): plain text, which
// the association shows in an editor, never runs.
export function isTextPath(p: Platform, path: string): boolean {
  if (!isSafePath(p, path)) return false
  const lower = path.toLowerCase()
  for (const extension of TEXT_EXTENSIONS) {
    if (lower.endsWith(extension)) return true
  }
  return false
}

export function openArgv(p: Platform, path: string): string[] {
  if (p === 'windows') return ['explorer.exe', path]
  if (p === 'mac') return ['open', path]
  return ['xdg-open', path]
}

export function revealArgv(p: Platform, path: string): string[] {
  if (p === 'windows') return ['explorer.exe', '/select,' + path]
  if (p === 'mac') return ['open', '-R', path]
  return ['xdg-open', parentFolder(path)]
}

// file:/// with forward slashes; spaces and non-ASCII percent-encoded.
export function fileUrl(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/')
  const encoded: string[] = []
  for (const segment of segments) {
    encoded.push(/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment))
  }
  const joined = encoded.join('/')
  return joined.startsWith('/') ? `file://${joined}` : `file:///${joined}`
}
