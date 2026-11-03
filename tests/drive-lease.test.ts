import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDriveLock, driveHolder, holdLease, renewDriveLock } from '../src/drive-presence.js'
import { autonomyOn, seededRepo } from './helpers.js'

const TEN_MIN = 10 * 60_000
const lockPath = (root: string) => join(root, '.witness', 'drive.lock')
const writeLock = (root: string, pid: number, ageMs = 0): void => {
  mkdirSync(join(root, '.witness'), { recursive: true })
  writeFileSync(lockPath(root), JSON.stringify({ pid, log: join(root, '.witness', 'drive.log'), lease: 1 }))
  const at = (Date.now() - ageMs) / 1000
  utimesSync(lockPath(root), at, at)
}

// A live process that is not this one. `renewEveryMs` makes it a drive that wakes: after
// `wakeAfterMs` it renews the lock's lease as drive does.
const children: ChildProcess[] = []
afterEach(() => { for (const c of children.splice(0)) c.kill() })
async function liveOther(lock?: string, wakeAfterMs = 0, renewEveryMs = 0): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `
    const fs = require('fs'); const [p, wake, every] = process.argv.slice(1)
    if (p && Number(every) > 0) setTimeout(() => setInterval(() => { const t = Date.now() / 1000; fs.utimesSync(p, t, t) }, Number(every)), Number(wake))
    process.stdout.write('up\\n'); setTimeout(() => {}, 60_000)
  `, lock ?? '', String(wakeAfterMs), String(renewEveryMs)], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  await once(child.stdout!, 'data')
  return child
}

// Row 224 (#69). The drive lock is a lease: a live pid is not enough, the lock must have been
// renewed within DRIVE_LEASE_MS. A lock left by a drive stopped hard (taskkill /F, kill -9, a
// reboot) expires, so a reused pid never reads as a running drive or gets a printed stop.
describe('the drive lock is a lease (#69)', () => {
  it('a live pid behind an expired lease is no drive, and next prints no watch line', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    writeLock(repo.root, process.pid, TEN_MIN)
    expect(driveHolder(repo.root)).toBeUndefined()
    const res = await repo.cli(['next'], { env: { CLAUDECODE: '1' } })
    expect(res.stdout).not.toContain('watch:')
  })

  it('a renewed lease is a drive again', async () => {
    const repo = await seededRepo()
    writeLock(repo.root, process.pid, TEN_MIN)
    expect(renewDriveLock(repo.root)).toBe(true)
    expect(driveHolder(repo.root)?.pid).toBe(process.pid)
  })

  it('renews only its own lock, and never through a link', async () => {
    const repo = await seededRepo()
    const other = await liveOther()
    writeLock(repo.root, other.pid!, TEN_MIN)
    const before = statSync(lockPath(repo.root)).mtimeMs
    expect(renewDriveLock(repo.root)).toBe(false)
    expect(statSync(lockPath(repo.root)).mtimeMs).toBe(before)
    // a link at the lock path naming this pid is no lock of ours, and its target is untouched
    const target = join(repo.root, 'elsewhere.json')
    writeFileSync(target, JSON.stringify({ pid: process.pid }))
    const old = (Date.now() - TEN_MIN) / 1000
    utimesSync(target, old, old)
    const targetBefore = statSync(target).mtimeMs
    rmSync(lockPath(repo.root))
    symlinkSync(target, lockPath(repo.root))
    expect(renewDriveLock(repo.root)).toBe(false)
    expect(statSync(target).mtimeMs).toBe(targetBefore)
  })

  it('a new drive takes over an expired lease once the grace passes with no renewal', async () => {
    const repo = await seededRepo()
    const other = await liveOther()
    writeLock(repo.root, other.pid!, TEN_MIN)
    const r = acquireDriveLock(repo.root, {}, process.pid, 300)
    expect(r.ok).toBe(true)
    expect(driveHolder(repo.root)?.pid).toBe(process.pid)
    if (r.ok) r.value()
  })

  // Review Focus 2. A drive whose host slept past the lease renews within a renewal interval
  // of waking; a second drive started at that moment waits out the grace and finds it renewed.
  it('a drive that wakes during the grace keeps its lock; a fresh lease is never taken', async () => {
    const repo = await seededRepo()
    const waking = await liveOther(lockPath(repo.root), 200, 50)
    writeLock(repo.root, waking.pid!, TEN_MIN)
    const r = acquireDriveLock(repo.root, {}, process.pid, 2_000)
    expect(r.ok ? 'taken' : r.violations[0]!.rule).toBe('drive-running')
    expect(driveHolder(repo.root)?.pid).toBe(waking.pid)

    const fresh = await liveOther()
    writeLock(repo.root, fresh.pid!)
    const again = acquireDriveLock(repo.root, {}, process.pid, 300)
    expect(again.ok ? 'taken' : again.violations[0]!.rule).toBe('drive-running')
  })

  // The running drive keeps its lease from the moment it holds the lock to its release —
  // through sessions, pauses and a human's answer alike — and stops when the lease is lost.
  it('a held lease renews on its interval and reports a lease taken from it', async () => {
    const repo = await seededRepo()
    writeLock(repo.root, process.pid, TEN_MIN)
    let lost = 0
    const stop = holdLease(repo.root, () => { lost += 1 }, 40)
    try {
      await new Promise((r) => setTimeout(r, 150))
      expect(driveHolder(repo.root)?.pid).toBe(process.pid)
      const other = await liveOther()
      writeLock(repo.root, other.pid!)
      await new Promise((r) => setTimeout(r, 150))
      expect(lost).toBe(1)
    } finally {
      stop()
    }
  })

  // Final review I1. A drive started by 0.27.0 wrote {pid, log} and never renews it: read by its
  // pid alone, as it was then, so an upgrade mid-run never lets a second drive take its lock.
  it('a lock a pre-lease drive wrote is read by its pid alone', async () => {
    const repo = await seededRepo()
    const legacy = await liveOther()
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    writeFileSync(lockPath(repo.root), JSON.stringify({ pid: legacy.pid, log: join(repo.root, '.witness', 'drive.log') }))
    const old = (Date.now() - TEN_MIN) / 1000
    utimesSync(lockPath(repo.root), old, old)
    expect(driveHolder(repo.root)?.pid).toBe(legacy.pid)
    const r = acquireDriveLock(repo.root, {}, process.pid, 300)
    expect(r.ok ? 'taken' : r.violations[0]!.rule).toBe('drive-running')
  })
})
