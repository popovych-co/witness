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
  // Final review: under Constrained Language Mode a blocked Add-Type only ends its statement, so
  // without Stop the helper reached Wait-Process holding nothing and never exited early.
  it('stops at the first error, so a helper that cannot hold the host exits and is reported', () => {
    expect(AWAKE_SCRIPT.split('\n')[0]).toBe("$ErrorActionPreference = 'Stop'")
    expect(AWAKE_SCRIPT.split('\n').at(-1)).toContain('-ErrorAction SilentlyContinue')   // a pid already gone still ends quietly
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

  // Deferred from 0.25.1's review: `exited 1` / `exited 3` named nothing a reader could act on.
  it('names the cause: its own exit 3, else the last line the helper said', () => {
    expect(lostWhy('win32', 'powershell.exe', 3, null)).toBe('powershell.exe exited 3 — SetThreadExecutionState refused the request')
    expect(lostWhy('win32', 'powershell.exe', 1, null, 'Add-Type : Cannot add type. Compilation errors occurred.'))
      .toBe('powershell.exe exited 1: Add-Type : Cannot add type. Compilation errors occurred.')
  })
})

// Review Focus 1
describe('keepAwake', () => {
  it('reports a helper that dies early, and nothing for one it stops', async () => {
    const lost: string[] = []
    keepAwake({ WITNESS_KEEP_AWAKE_BIN: fake('exit 1') }, 'darwin', process.pid, (w) => lost.push(w))
    await expect.poll(() => lost, { timeout: 5_000 }).toEqual(['fake-awake exited 1'])
    const said: string[] = []
    // Windows PowerShell 5.1's error view: the message first, then where and why (final review).
    const ps = ['Add-Type : Cannot add type. Compilation errors occurred.', 'At line:2 char:6', '+ $k = Add-Type -Name Awake', '+      ~~~~~~~~',
      '    + CategoryInfo          : InvalidData: (:) [Add-Type], InvalidOperationException',
      '    + FullyQualifiedErrorId : COMPILER_ERRORS,Microsoft.PowerShell.Commands.AddTypeCommand']
    keepAwake({ WITNESS_KEEP_AWAKE_BIN: fake(`${ps.map((l) => `echo '${l}' >&2`).join('; ')}; exit 1`) }, 'darwin', process.pid, (w) => said.push(w))
    await expect.poll(() => said, { timeout: 5_000 }).toEqual(['fake-awake exited 1: Add-Type : Cannot add type. Compilation errors occurred.'])
    const quiet: string[] = []
    keepAwake({ WITNESS_KEEP_AWAKE_BIN: fake('exec sleep 30') }, 'darwin', process.pid, (w) => quiet.push(w)).stop()
    await new Promise((r) => setTimeout(r, 500))
    expect(quiet).toEqual([])
  })
})
