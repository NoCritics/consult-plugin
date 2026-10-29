import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { fileName, fileUrl, isImagePath, isSafePath, isTextPath, openArgv, platformOf, revealArgv } from '../hooks/mod/files'

function envDollar(env: Record<string, string>): EngineInterface {
  return { env: { get: async (name: string) => env[name] } } as unknown as EngineInterface
}

describe('files', () => {
  test('a path with spaces and a non-ASCII name stays one argv element', () => {
    const path = 'C:\\a b\\é.jpg'
    expect(openArgv('windows', path)).toEqual(['explorer.exe', 'C:\\a b\\é.jpg'])
    expect(revealArgv('windows', path)).toEqual(['explorer.exe', '/select,C:\\a b\\é.jpg'])
  })

  test('mac and linux', () => {
    expect(openArgv('mac', '/Users/me/a b.png')).toEqual(['open', '/Users/me/a b.png'])
    expect(revealArgv('mac', '/Users/me/a b.png')).toEqual(['open', '-R', '/Users/me/a b.png'])
    expect(openArgv('linux', '/home/me/x.png')).toEqual(['xdg-open', '/home/me/x.png'])
    expect(revealArgv('linux', '/home/me/pics/x.png')).toEqual(['xdg-open', '/home/me/pics'])
  })

  test('fileUrl', () => {
    expect(fileUrl('C:\\a b\\x.jpg')).toBe('file:///C:/a%20b/x.jpg')
    expect(fileUrl('C:\\pics\\pomme é.png')).toBe('file:///C:/pics/pomme%20%C3%A9.png')
    expect(fileUrl('/home/me/x y.png')).toBe('file:///home/me/x%20y.png')
  })

  test('fileName', () => {
    expect(fileName('C:\\a b\\x.jpg')).toBe('x.jpg')
    expect(fileName('/home/me/x.png')).toBe('x.png')
  })

  test('only image files may be opened', () => {
    expect(isImagePath('windows', 'C:\\a b\\é.JPG')).toBe(true)
    expect(isImagePath('linux', '/home/me/x.webp')).toBe(true)
    expect(isImagePath('windows', 'C:\\x\\run.bat')).toBe(false)
    expect(isImagePath('windows', 'C:\\x\\pic.png.exe')).toBe(false)
    expect(isImagePath('windows', 'relative\\x.png')).toBe(false)
  })

  test('only a safe text file may be opened as a report', () => {
    expect(isTextPath('windows', 'C:\\Users\\me\\.claude\\consult-delegate\\tasks\\ab12\\final.md')).toBe(true)
    expect(isTextPath('linux', '/home/me/notes.TXT')).toBe(true)
    expect(isTextPath('linux', '/home/me/run.log')).toBe(true)
    expect(isTextPath('windows', 'C:\\x\\run.bat')).toBe(false)
    expect(isTextPath('windows', 'C:\\x\\final.md.exe')).toBe(false)
    expect(isTextPath('windows', '\\\\server\\share\\final.md')).toBe(false)
    expect(isTextPath('windows', 'final.md')).toBe(false)
  })

  test('a path explorer.exe could read as a switch, a share or a second argument is refused', () => {
    expect(isSafePath('windows', 'C:\\proj\\consult-images\\a b.jpg')).toBe(true)
    expect(isSafePath('windows', '/e,C:\\x.png')).toBe(false)
    expect(isSafePath('windows', '\\\\server\\share\\x.png')).toBe(false)
    expect(isSafePath('windows', 'C:\\a,b\\x.png')).toBe(false)
    expect(isSafePath('windows', 'C:\\a\\b:stream.png')).toBe(false)
    expect(isSafePath('linux', '/home/me/x.png')).toBe(true)
    expect(isSafePath('linux', '//server/x.png')).toBe(false)
    expect(isSafePath('mac', '-R.png')).toBe(false)
    expect(isImagePath('windows', '/e,C:\\x.png')).toBe(false)
  })

  test('platformOf', async () => {
    expect(await platformOf(envDollar({ OS: 'Windows_NT' }))).toBe('windows')
    expect(await platformOf(envDollar({ HOME: '/Users/me' }))).toBe('mac')
    expect(await platformOf(envDollar({ HOME: '/home/me' }))).toBe('linux')
  })
})
