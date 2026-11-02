import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detachArgv } from '../src/drive.js'

// Real files, as tests/spawn.test.ts resolves them: on win32 resolution IS a filesystem walk.
// `platform` is passed in, so the Windows branch runs on any host.
function binDir(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'witness-detach-'))
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), '')
  }
  return dir
}
const winEnv = (path: string): Record<string, string> =>
  ({ PATH: path, PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows' })
const value = <T>(r: { ok: true; value: T } | { ok: false }): T => {
  if (!r.ok) throw new Error('refused')
  return r.value
}

// Row 221 (#68). `drive --detach` under WITNESS_BIN starts the bin itself on Windows, where
// there is no /bin/sh: split as a command line, resolved like every other spawn.
describe('detachArgv', () => {
  it('posix keeps exec through /bin/sh, so the printed pid is the CLI\'s own', () => {
    expect(value(detachArgv('node /w/bin.js', ['--detach'], {}, 'darwin'))).toMatchObject({
      file: '/bin/sh', args: ['-c', 'exec node /w/bin.js "$@"', 'witness', 'drive', '--detach'], windowsVerbatimArguments: false,
    })
  })

  it('win32 starts the bin\'s image directly, its args ending with drive and the caller\'s args', () => {
    const dir = binDir('node.exe')
    const r = value(detachArgv('node C:\\w\\dist\\bin.js', ['--detach'], winEnv(dir), 'win32'))
    expect(r.file).toBe(join(dir, 'node.exe'))
    expect(r.args).toEqual(['C:\\w\\dist\\bin.js', 'drive', '--detach'])
    expect(r.windowsVerbatimArguments).toBe(false)
  })

  it('win32 honours a quoted first word with spaces (an install under Program Files)', () => {
    const dir = binDir('Program Files/nodejs/node.exe')
    const node = join(dir, 'Program Files', 'nodejs', 'node.exe')
    const r = value(detachArgv(`"${node}" C:\\w\\bin.js`, [], winEnv(''), 'win32'))
    expect(r.file).toBe(node)
    expect(r.args).toEqual(['C:\\w\\bin.js', 'drive'])
  })

  it('win32 runs an npm .cmd shim through System32 cmd.exe, verbatim', () => {
    const dir = binDir('witness.cmd')
    const r = value(detachArgv('witness', ['--detach'], winEnv(dir), 'win32'))
    expect(r.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(r.windowsVerbatimArguments).toBe(true)
    expect(r.args.at(-1)).toContain(join(dir, 'witness.cmd'))
  })

  it('win32 refuses a bin nothing on PATH answers to, instead of a spawn that fails later', () => {
    const r = detachArgv('nowhere C:\\w\\bin.js', [], winEnv(binDir()), 'win32')
    expect(r.ok ? 'ok' : r.violations.map((x) => x.rule)).toEqual(['not-on-path'])
  })

  it('with no bin runs this CLI\'s own bin.js under this node', () => {
    const r = value(detachArgv(undefined, ['--detach'], {}, 'win32'))
    expect(r.file).toBe(process.execPath)
    expect(r.args.slice(1)).toEqual(['drive', '--detach'])
    expect(r.args[0]).toMatch(/bin\.js$/)
  })
})
