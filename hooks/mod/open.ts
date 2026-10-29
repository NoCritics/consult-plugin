import type { EngineInterface } from 'claude-code'

import { dataHome, fileName, isImagePath, isSafePath, isTextPath, openArgv, platformOf, revealArgv } from './files'
import type { Platform } from './files'

// What a button of the pane does with a path: open an image or a text report
// with the system's association, open a folder, or show a file in its folder.
// The Answers and the Delegated tabs both press these.

export type OpenAction = 'open' | 'reveal' | 'open-folder' | 'open-text'

// A path for comparing: forward slashes, no Windows long-path prefix, no trailing slash, and lower case on Windows.
function comparable(platform: Platform, path: string): string {
  let text = path.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '')
  if (platform === 'windows') text = text.toLowerCase()
  return text
}

// Whether the path is a folder that exists.
async function isFolder($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'dir'
  } catch {
    return false
  }
}

// Whether the path is a file that exists and, with every link followed, lies inside `folder`.
async function isFileInside($: EngineInterface, platform: Platform, path: string, folder: string | null): Promise<boolean> {
  if (folder === null) return false
  try {
    const file = await $.fs.stat(path, { resolve: true })
    const outer = await $.fs.stat(folder, { resolve: true })
    if (file.kind !== 'file' || file.realPath === undefined || outer.kind !== 'dir' || outer.realPath === undefined) return false
    return comparable(platform, file.realPath).startsWith(`${comparable(platform, outer.realPath)}/`)
  } catch {
    return false
  }
}

// A task's own folder under the data folder, or null for an id that is not the store's format.
export async function taskFolderOf($: EngineInterface, id: string): Promise<string | null> {
  const home = await dataHome($)
  if (home === null || !/^[0-9a-f]{6}$/.test(id)) return null
  return `${home}/tasks/${id}`
}

// `within`: for a file the tab got from a task, the folder it must lie in (null when that folder is not known).
// An undefined `within` asks nothing of the file beyond the action's own check.
export async function runOn($: EngineInterface, path: string, action: OpenAction, within?: string | null): Promise<void> {
  const platform = await platformOf($)
  let isAllowed = isSafePath(platform, path)
  if (action === 'open') isAllowed = isImagePath(platform, path)
  if (action === 'open-text') isAllowed = isTextPath(platform, path)
  if (!isAllowed) {
    const reason = action === 'open' ? 'not a local image path' : action === 'open-text' ? 'not a local text file' : 'not a local path'
    $.ui.toast(`consult: not opening ${fileName(path)}: ${reason}`)
    return
  }
  if (action === 'open-folder' && !(await isFolder($, path))) {
    $.ui.toast(`consult: not opening ${fileName(path)}: not a folder`)
    return
  }
  if (within !== undefined && !(await isFileInside($, platform, path, within))) {
    $.ui.toast(`consult: not opening ${fileName(path)}: not in the task's folder`)
    return
  }
  try {
    // explorer.exe exits 1 even when it opened the file: the code is ignored.
    await $.process.run(action === 'reveal' ? revealArgv(platform, path) : openArgv(platform, path))
  } catch {
    $.ui.toast(`consult: could not ${action === 'reveal' ? 'show' : 'open'} ${fileName(path)}`)
  }
}
