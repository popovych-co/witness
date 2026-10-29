import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AWAKE_SCRIPT, CTRL_C_EXIT, awakeArgv, keepAwake, lostWhy } from '../src/awake.js'
import { fakeScenario } from './helpers.js'

const fake = (body: string) => {
  const bin = join(fakeScenario(), 'fake-awake')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}

describe('awakeArgv (row 211, issue #59)', () => {
  it('win32 holds SetThreadExecutionState from System32 PowerShell, the pid in the environment', () => {
    expect(awakeArgv({ SYSTEMROOT: 'D:\\Win' }, 'win32', 4242)).toEqual({
      file: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', AWAKE_SCRIPT],
      env: { WITNESS_AWAKE_PID: '4242' },
      shown: 'SetThreadExecutionState via powershell.exe until pid 4242 — an explicit sleep (Start › Sleep, a closed lid) still sleeps',
    })
    expect(AWAKE_SCRIPT).toContain('SetThreadExecutionState([uint32]2147483649)')
    expect(AWAKE_SCRIPT).toContain('Wait-Process -Id ([int]$env:WITNESS_AWAKE_PID)')
    expect(AWAKE_SCRIPT).not.toMatch(/WindowStyle|4242/)
  })
  it('darwin keeps caffeinate and its line', () => {
    expect(awakeArgv({}, 'darwin', 4242)).toEqual({ file: 'caffeinate', args: ['-ims', '-w', '4242'],
      shown: 'caffeinate -ims -w 4242 — a closed lid on battery still sleeps' })
  })
  it('elsewhere holds nothing unless the seam names a binary', () => {
    expect(awakeArgv({}, 'linux', 1)).toBeUndefined()
    expect(awakeArgv({ WITNESS_KEEP_AWAKE_BIN: '/x/fake' }, 'linux', 1)?.file).toBe('/x/fake')
    expect(awakeArgv({ WITNESS_KEEP_AWAKE_BIN: '/x/fake' }, 'win32', 1)?.args.at(-1)).toBe(AWAKE_SCRIPT)
  })
})

describe('lostWhy', () => {
  it('names an early non-zero exit; a signal, exit 0 and the win32 Ctrl+C status say nothing', () => {
    expect(lostWhy('win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 1, null)).toBe('powershell.exe exited 1')
    expect(lostWhy('darwin', '/usr/bin/caffeinate', 0, null)).toBeUndefined()
    expect(lostWhy('darwin', '/usr/bin/caffeinate', null, 'SIGINT')).toBeUndefined()
    expect(lostWhy('win32', 'powershell.exe', CTRL_C_EXIT, null)).toBeUndefined()
  })
})

// Review Focus 1
describe('keepAwake', () => {
  it('reports a helper that dies early, and nothing for one it stops', async () => {
    const lost: string[] = []
    keepAwake({ WITNESS_KEEP_AWAKE_BIN: fake('exit 1') }, 'darwin', process.pid, (w) => lost.push(w))
    await expect.poll(() => lost, { timeout: 5_000 }).toEqual(['fake-awake exited 1'])
    const quiet: string[] = []
    keepAwake({ WITNESS_KEEP_AWAKE_BIN: fake('exec sleep 30') }, 'darwin', process.pid, (w) => quiet.push(w)).stop()
    await new Promise((r) => setTimeout(r, 500))
    expect(quiet).toEqual([])
  })
})
