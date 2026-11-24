import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUSY_DIR, BUSY_MAX_MS, busyHolder, busyIo, settleUntil, shipUntil, sweepDeadBusy, takeBusy,
} from '../src/busy.js'
import type { Config } from '../src/config.js'
import { deadlineFile, writeDeadline } from '../src/deadline.js'
import { tmpRepo } from './helpers.js'
import { scratchDir } from './scratch.js'

// Row 240 (design §4.1.2). Lean busy locks: machine-local files nobody waits for, created
// exclusively without following a link, live while the pid lives and `until` has not passed.

const repo = (): string => {
  const root = scratchDir('witness-busy-')
  execFileSync('git', ['init', '-q', root])
  return root
}
const lockFile = (root: string, target: string, kind = 'settle') => join(root, BUSY_DIR, `${target}.${kind}.json`)
const handLock = (root: string, target: string, body: unknown, kind = 'settle') => {
  mkdirSync(join(root, BUSY_DIR), { recursive: true })
  writeFileSync(lockFile(root, target, kind), typeof body === 'string' ? body : JSON.stringify(body))
}
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!
const OTHER = process.ppid                                   // a live pid that is not this one
const NOW = Date.now()
const cfg = (reviewerTimeoutMs: number, ciSettleMs = 30_000) =>
  ({ gates: { reviewerTimeoutMs }, ship: { ciSettleMs } }) as unknown as Config

const realCreate = busyIo.create
afterEach(() => { busyIo.create = realCreate })

describe('takeBusy and busyHolder (row 240)', () => {
  it('takes, reads busy from another pid, releases', () => {
    const root = repo()
    const a = takeBusy(root, 'settle', 'a-plan-1', NOW + 60_000, { pid: OTHER })
    expect(a.taken).toBe(true)
    const b = takeBusy(root, 'settle', 'a-plan-1', NOW + 60_000, { pid: process.pid })
    expect(b).toEqual({ taken: false, holder: { pid: OTHER, since: expect.any(Number), until: NOW + 60_000 } })
    expect(busyHolder(root, 'settle', 'a-plan-1', { pid: process.pid })?.pid).toBe(OTHER)
    // the ship marker is a separate file: a held settle lock never makes ship busy
    expect(busyHolder(root, 'ship', 'a-plan-1', { pid: process.pid })).toBeUndefined()
    if (a.taken) a.release()
    expect(existsSync(lockFile(root, 'a-plan-1'))).toBe(false)
    expect(takeBusy(root, 'settle', 'a-plan-1', NOW + 60_000, { pid: process.pid }).taken).toBe(true)
  })

  it('a release never removes a lock another process took over since', () => {
    const root = repo()
    const a = takeBusy(root, 'settle', 'a-plan-1', NOW + 60_000, { pid: OTHER })
    handLock(root, 'a-plan-1', { pid: process.pid, since: NOW, until: NOW + 60_000 })
    if (a.taken) a.release()
    expect(JSON.parse(readFileSync(lockFile(root, 'a-plan-1'), 'utf8')).pid).toBe(process.pid)
  })

  it('a lock naming the caller\'s own pid is not busy to it', () => {
    const root = repo()
    handLock(root, 'a-plan-1', { pid: process.pid, since: NOW, until: NOW + 60_000 })
    expect(busyHolder(root, 'settle', 'a-plan-1', { pid: process.pid })).toBeUndefined()
    expect(takeBusy(root, 'settle', 'a-plan-1', NOW + 60_000, { pid: process.pid }).taken).toBe(true)
  })

  it('a dead pid\'s lock is taken over through the steal guard', () => {
    const root = repo()
    handLock(root, 'a-plan-1', { pid: deadPid(), since: NOW, until: NOW + 60_000 })
    expect(busyHolder(root, 'settle', 'a-plan-1', { pid: process.pid })).toBeUndefined()
    expect(takeBusy(root, 'settle', 'a-plan-1', NOW + 60_000, { pid: process.pid }).taken).toBe(true)
    expect(JSON.parse(readFileSync(lockFile(root, 'a-plan-1'), 'utf8')).pid).toBe(process.pid)
    expect(existsSync(`${lockFile(root, 'a-plan-1')}.steal`)).toBe(false)
  })

  it('a lock past its until, or whose until lies more than 24 h after its since, is stale', () => {
    const root = repo()
    handLock(root, 'past', { pid: OTHER, since: NOW - 10_000, until: NOW - 1 })
    handLock(root, 'span', { pid: OTHER, since: NOW - 23 * 3_600_000, until: NOW + 2 * 3_600_000 })
    handLock(root, 'fresh', { pid: OTHER, since: NOW - 1_000, until: NOW + 3_600_000 })
    for (const t of ['past', 'span']) {
      expect(busyHolder(root, 'settle', t, { pid: process.pid }), t).toBeUndefined()
      expect(takeBusy(root, 'settle', t, NOW + 60_000, { pid: process.pid }).taken, t).toBe(true)
    }
    expect(busyHolder(root, 'settle', 'fresh', { pid: process.pid })?.pid).toBe(OTHER)
  })

  // Review Focus 1
  it('a non-numeric, negative or far-future until, and a symlink at the lock path, read as stale', () => {
    const root = repo()
    handLock(root, 'nan', { pid: OTHER, since: NOW, until: 'soon' })
    handLock(root, 'neg', { pid: OTHER, since: NOW, until: -5 })
    handLock(root, 'far', { pid: OTHER, since: NOW, until: NOW + 40 * 365 * 86_400_000 })
    const outside = join(root, 'outside.json')
    writeFileSync(outside, JSON.stringify({ pid: OTHER, since: NOW, until: NOW + 60_000 }))
    symlinkSync(outside, lockFile(root, 'link'))
    for (const t of ['nan', 'neg', 'far', 'link']) {
      expect(busyHolder(root, 'settle', t, { pid: process.pid }), t).toBeUndefined()
      expect(takeBusy(root, 'settle', t, NOW + 60_000, { pid: process.pid }).taken, t).toBe(true)
    }
    // the link itself was replaced, never what it pointed at
    expect(JSON.parse(readFileSync(outside, 'utf8')).pid).toBe(OTHER)
  })

  // Final review: a `since` far ahead of now (a tampered lock, a clock set wrong) is never live, so
  // no target stays busy forever; drive's sweep drops it too.
  it('a lock whose since lies far in the future is stale, and swept', () => {
    const root = repo()
    const since = NOW + 30 * 365 * 86_400_000
    handLock(root, 'future', { pid: OTHER, since, until: since + 1_000 })
    expect(busyHolder(root, 'settle', 'future', { pid: process.pid })).toBeUndefined()
    expect(sweepDeadBusy(root, { pid: process.pid })).toBe(1)
    handLock(root, 'future', { pid: OTHER, since, until: since + 1_000 })
    expect(takeBusy(root, 'settle', 'future', NOW + 60_000, { pid: process.pid }).taken).toBe(true)
  })

  // Final review (Windows): a scanner holding the file a moment fails the release's unlink; it is
  // retried, as a create is, so the lock never outlives its taker's release.
  it('an unlink EBUSY or EPERM on release is retried', () => {
    const root = repo()
    const t = takeBusy(root, 'settle', 'a-plan-1', NOW + 60_000, { pid: process.pid })
    let n = 0
    const realUnlink = busyIo.unlink
    busyIo.unlink = (p) => { n++; if (n <= 2) throw Object.assign(new Error('scanner'), { code: n === 1 ? 'EBUSY' : 'EPERM' }); realUnlink(p) }
    try { if (t.taken) t.release() } finally { busyIo.unlink = realUnlink }
    expect(n).toBe(3)
    expect(existsSync(lockFile(root, 'a-plan-1'))).toBe(false)
  })

  it('an empty file is a write in progress for one second, then stale', () => {
    const root = repo()
    handLock(root, 'a-plan-1', '')
    const t0 = Date.now()
    expect(takeBusy(root, 'settle', 'a-plan-1', NOW + 60_000, { pid: process.pid }).taken).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
  })

  it('EPERM or EBUSY on create is retried, then refuses lock-unwritable naming the folder', () => {
    const root = repo()
    let n = 0
    busyIo.create = (p, text) => {
      n++
      if (n <= 2) throw Object.assign(new Error('scanner'), { code: n === 1 ? 'EPERM' : 'EBUSY' })
      realCreate(p, text)
    }
    expect(takeBusy(root, 'settle', 'a-plan-1', NOW + 60_000, { pid: process.pid }).taken).toBe(true)
    expect(n).toBe(3)
    busyIo.create = () => { throw Object.assign(new Error('held'), { code: 'EACCES' }) }
    const r = takeBusy(root, 'settle', 'b-plan-1', NOW + 60_000, { pid: process.pid })
    expect(r.taken).toBe(false)
    expect(!r.taken && 'refused' in r && r.refused[0]).toMatchObject({ rule: 'lock-unwritable', field: BUSY_DIR })
  })

  it('a target outside the id rule names no file', () => {
    const root = repo()
    const r = takeBusy(root, 'settle', '../escape', NOW + 60_000, { pid: process.pid })
    expect(r.taken).toBe(false)
    expect(!r.taken && 'refused' in r).toBe(true)
    expect(existsSync(join(root, BUSY_DIR))).toBe(false)
    expect(existsSync(join(root, '.witness', 'live', 'escape.settle.json'))).toBe(false)
    expect(busyHolder(root, 'settle', '../escape', { pid: process.pid })).toBeUndefined()
  })

  it('a symlinked live folder is refused, and nothing is written through it', () => {
    const root = repo()
    const elsewhere = scratchDir('witness-elsewhere-')
    mkdirSync(join(root, '.witness'), { recursive: true })
    symlinkSync(elsewhere, join(root, '.witness', 'live'))
    const r = takeBusy(root, 'settle', 'a-plan-1', NOW + 60_000, { pid: process.pid })
    expect(!r.taken && 'refused' in r && r.refused[0]!.rule).toBe('lock-unwritable')
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('sweepDeadBusy removes dead holders\' locks and the caller\'s own, and keeps a live one', () => {
    const root = repo()
    handLock(root, 'dead', { pid: deadPid(), since: NOW, until: NOW + 60_000 })
    handLock(root, 'mine', { pid: process.pid, since: NOW, until: NOW + 60_000 }, 'ship')
    handLock(root, 'live', { pid: OTHER, since: NOW, until: NOW + 60_000 })
    expect(sweepDeadBusy(root, { pid: process.pid })).toBe(2)
    expect(readdirSync(join(root, BUSY_DIR)).sort()).toEqual(['live.settle.json'])
  })
})

describe('the bound a taker writes (row 240)', () => {
  it('settleUntil: 2·3·T + 2·LOCK_WAIT_MS + 2 min; inside a session the later of that and the deadline; capped at 24 h', () => {
    expect(settleUntil(cfg(600_000), {}, 0)).toBe(6 * 600_000 + 60_000 + 120_000)
    expect(settleUntil(cfg(600_000), { WITNESS_DRIVE_DEADLINE: String(9e6) }, 0)).toBe(9e6)
    expect(settleUntil(cfg(600_000), { WITNESS_DRIVE_DEADLINE: String(1e6) }, 0)).toBe(3_780_000)
    // P20 inverted: a reviewer timeout above 240 minutes no longer makes the lock stale at birth
    expect(settleUntil(cfg(15_000_000), {}, 0)).toBe(BUSY_MAX_MS)
    expect(settleUntil(cfg(600_000), { WITNESS_DRIVE_DEADLINE: String(9e9) }, 0)).toBe(BUSY_MAX_MS)
  })

  it('a deadline drive moved later is the bound (row 256)', () => {
    const repo = tmpRepo()
    writeDeadline(repo.root, '77-3', 9e6)
    expect(settleUntil(cfg(600_000), {
      WITNESS_DRIVE_DEADLINE: String(1e6), WITNESS_DRIVE_DEADLINE_FILE: deadlineFile(repo.root, '77-3'),
    }, 0)).toBe(9e6)
  })

  it('shipUntil: 3·T + ciSettleMs + 30 min + 2·the settle estimate + 10 min, by the same rule', () => {
    expect(shipUntil(cfg(600_000), {}, 0)).toBe(1_800_000 + 30_000 + 1_800_000 + 2 * 3_780_000 + 600_000)
    expect(shipUntil(cfg(600_000), { WITNESS_DRIVE_DEADLINE: String(2e7) }, 0)).toBe(2e7)
    expect(shipUntil(cfg(6_000_000), {}, 0)).toBe(BUSY_MAX_MS)
  })
})
