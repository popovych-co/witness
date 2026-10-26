import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { notify, notifyArgv, TOAST_SCRIPT } from '../src/notify.js'
import { fakeScenario } from './helpers.js'

const script = (body: string): string => {
  const bin = join(fakeScenario(), 'notifier')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}

// Row 203 (issue #56: "notify: none on win32"). Windows gets a toast by default, through Windows
// PowerShell 5.1 named by its absolute System32 path — never PATH (row 201's taskkill precedent)
// — with the text in the environment, never in the command. And a notification never stalls
// drive: per-round notifications start in the background.
describe('notify (D203)', () => {
  it('win32 names System32 PowerShell by absolute path and keeps the message out of argv', () => {
    const r = notifyArgv('win32', undefined, 'witness drive', 'a "b" $(evil)', { SYSTEMROOT: 'C:\\Windows' })!
    expect(r.argv[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(r.argv.join(' ')).not.toContain('$(evil)')
    expect(r.env).toEqual({ WITNESS_NOTIFY_TITLE: 'witness drive', WITNESS_NOTIFY_TEXT: 'a "b" $(evil)' })
    expect(TOAST_SCRIPT).toContain('$env:WITNESS_NOTIFY_TEXT')
    expect(r.argv.at(-1)).toBe(TOAST_SCRIPT)
  })

  it('falls back to C:\\Windows when SYSTEMROOT is unset, whatever its case', () => {
    expect(notifyArgv('win32', undefined, 't', 'm', {})!.argv[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(notifyArgv('win32', undefined, 't', 'm', { SystemRoot: 'D:\\Win' })!.argv[0]).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('a configured notifier still wins on win32', () => {
    expect(notifyArgv('win32', '/bin/ping-me', 'witness drive', 'm')).toEqual({ argv: ['/bin/ping-me', 'm'] })
  })

  it('a background notify returns without waiting', () => {
    const slow = script('sleep 5')
    const t0 = Date.now()
    expect(notify(slow, 't', 'm', 'darwin', { wait: false }).outcome).toBe('started')
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('a background notify still reports a notifier that is not there', () => {
    expect(notify('/no/such/notifier', 't', 'm', 'darwin', { wait: false })).toEqual({ outcome: 'failed', command: '/no/such/notifier' })
  })
})
