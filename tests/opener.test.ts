import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openArtifact, platformOpener, probeArgv } from '../src/opener.js'
import { waitForLine } from './helpers.js'

// A recorder standing in for `open`/`xdg-open`: appends its argv to a file so the
// test can assert WHICH path the CLI handed the platform. Spawn is detached and
// unawaited, so the assertion polls rather than reading immediately.
function recorder(): { cmd: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-opener-'))
  const log = join(dir, 'opened.txt')
  const cmd = join(dir, 'rec.sh')
  writeFileSync(cmd, `#!/bin/sh\necho "$1" >> "${log}"\n`)
  chmodSync(cmd, 0o755)
  return { cmd, log }
}

describe('openArtifact', () => {
  it('spawns the declared opener with the absolute artifact path', async () => {
    const { cmd, log } = recorder()
    const res = openArtifact(cmd, '/tmp/look.html')
    expect(res.outcome).toBe('spawned')
    expect(res.command).toBe(cmd)
    expect((await waitForLine(log)).trim()).toBe('/tmp/look.html')
  })

  it('resolves a bare override off PATH, not just an absolute path', async () => {
    // the documented escape hatch for nonstandard desktops is `opener: firefox` in
    // .witness/config.local.yaml, so the probe must be `command -v`, never existsSync
    const res = openArtifact('true', '/tmp/look.html')
    expect(res.outcome).toBe('spawned')
  })

  it('reports failed when the override does not resolve', () => {
    const res = openArtifact('witness-no-such-opener-xyz', '/tmp/look.html')
    expect(res.outcome).toBe('failed')
  })

  it('names the resolved command so the journal can record what was run', () => {
    const res = openArtifact(undefined, '/tmp/look.html')
    expect(res.command).toBe(platformOpener()[0])        // on win32, System32's cmd.exe by path
  })
})

// Row 201's doctrine: a Windows tool witness names starts from System32 by absolute path, never by
// a bare name a planted cmd.exe or where.exe earlier on PATH would answer to (notify, taskkill
// and the keep-awake helper already do). On win32 an absolute opener is probed by existence:
// `where` matches name patterns, not paths; POSIX `command -v` takes a path as it is.
describe('the platform opener on win32 (row 201)', () => {
  const env = { SYSTEMROOT: 'D:\\Win' }
  it('starts System32 cmd.exe by absolute path and probes with System32 where.exe', () => {
    expect(platformOpener('win32', env)).toEqual(['D:\\Win\\System32\\cmd.exe', '/c', 'start', ''])
    expect(probeArgv('code', 'win32', env)).toEqual({ file: 'D:\\Win\\System32\\where.exe', args: ['code'] })
  })
  it('probes an absolute opener by existence on win32, and through command -v elsewhere', () => {
    expect(probeArgv('D:\\Win\\System32\\cmd.exe', 'win32', env)).toEqual({ exists: 'D:\\Win\\System32\\cmd.exe' })
    expect(probeArgv('/usr/bin/open', 'darwin', {})).toEqual({ file: 'sh', args: ['-c', 'command -v /usr/bin/open'] })
    expect(probeArgv('xdg-open', 'linux', {})).toEqual({ file: 'sh', args: ['-c', 'command -v xdg-open'] })
  })
})
