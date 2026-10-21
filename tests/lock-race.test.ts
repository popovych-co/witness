import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireLock, takeStale } from '../src/lock.js'

// Final review F15. A dead holder's lock is the normal state after a crash, and with waits
// every writer meets it at once: the steal must let exactly one of them in, and a release
// must never delete a lock another process holds.
const REPO = resolve(import.meta.dirname, '..')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const run = (script: string, args: string[]): Promise<number | null> => new Promise((done) => {
  const c = spawn(TSX, [script, ...args], { stdio: 'ignore' })
  c.on('close', (code) => done(code))
})

describe('lock steals under contention (B3)', () => {
  it('a dead holder\'s drive lock lets exactly one racer in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'witness-race-'))
    const script = join(dir, 'racer.ts')
    writeFileSync(script, `
      import { acquireDriveLock } from '${join(REPO, 'src', 'drive-presence.ts')}'
      import { appendFileSync } from 'node:fs'
      const [root, at] = process.argv.slice(2)
      while (Date.now() < Number(at)) { /* line up */ }
      const r = acquireDriveLock(root!, {})
      if (r.ok) { appendFileSync(root + '/winners', process.pid + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); r.value() }
    `)
    for (let trial = 0; trial < 3; trial++) {
      const root = mkdtempSync(join(tmpdir(), 'witness-race-root-'))
      mkdirSync(join(root, '.witness'))
      writeFileSync(join(root, '.witness', 'drive.lock'), JSON.stringify({ pid: 999_999 }))
      const at = String(Date.now() + 2_500)
      await Promise.all(Array.from({ length: 8 }, () => run(script, [root, at])))
      expect(readFileSync(join(root, 'winners'), 'utf8').trim().split('\n')).toHaveLength(1)
    }
  }, 60_000)

  // The race, in slow motion: B read a dead holder, A stole that lock and wrote its own, and
  // only then does B steal. B must find A's lock and leave it.
  it('a steal that finds a re-created live lock leaves it in place', () => {
    const root = mkdtempSync(join(tmpdir(), 'witness-race-root-'))
    mkdirSync(join(root, '.witness'))
    const p = join(root, '.witness', 'lock')
    writeFileSync(p, JSON.stringify({ pid: process.pid }))          // A's live lock
    expect(takeStale(p, (text) => text === JSON.stringify({ pid: 999_999 }))).toBe('busy')
    expect(readFileSync(p, 'utf8')).toBe(JSON.stringify({ pid: process.pid }))
    expect(readdirSync(join(root, '.witness'))).toEqual(['lock'])
  })

  it('a release never removes a lock another holder now owns', () => {
    const root = mkdtempSync(join(tmpdir(), 'witness-race-root-'))
    const r = acquireLock(root, process.pid, 0)
    expect(r.ok).toBe(true)
    const p = join(root, '.witness', 'lock')
    writeFileSync(p, JSON.stringify({ pid: 999_998 }))              // it was taken from us
    if (r.ok) r.value()
    expect(readFileSync(p, 'utf8')).toBe(JSON.stringify({ pid: 999_998 }))
  })
})
