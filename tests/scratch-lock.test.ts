import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ok, type Result } from '../src/refusal.js'
import { SCRATCH_LOCK, releaseDeadScratch, scratchHolder, withScratchLock } from '../src/scratch-lock.js'
import { fakeCtx, tmpRepo } from './helpers.js'

const value = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.violations)); return r.value }
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!

// Holders are child processes spawned async (row 213), killed after each test.
const children: ChildProcess[] = []
const sleeper = (): Promise<number> => new Promise((res, rej) => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  children.push(c)
  c.once('spawn', () => res(c.pid!))
  c.once('error', rej)
})
afterEach(() => { for (const c of children.splice(0)) c.kill() })

const writeLock = (root: string, l: Record<string, unknown>) => {
  mkdirSync(join(root, '.witness', 'live', 'scratch'), { recursive: true })
  writeFileSync(join(root, SCRATCH_LOCK), JSON.stringify(l))
}
const readLock = (root: string) => JSON.parse(readFileSync(join(root, SCRATCH_LOCK), 'utf8')) as { pid: number; since: number; until: number; job?: string }

describe('the scratch is held while its holder lives (row 279)', () => {
  it('a live holder past its old lease keeps the scratch: neither the sweep nor a reader frees it (row 279)', async () => {
    const repo = tmpRepo()
    const pid = await sleeper()
    writeLock(repo.root, { pid, since: Date.now() - 3_600_000, until: Date.now() - 1_800_000 })   // a host that slept
    expect(scratchHolder(repo.root)?.pid).toBe(pid)
    expect(releaseDeadScratch(repo.root)).toBe(false)
    expect(readLock(repo.root).pid).toBe(pid)
  })

  it("a dead holder's lock is freed by the sweep and taken over by the next taker", () => {
    const repo = tmpRepo()
    const ctx = fakeCtx(repo.root)
    writeLock(repo.root, { pid: deadPid(), since: Date.now(), until: Date.now() + 60_000 })
    expect(scratchHolder(repo.root)).toBeUndefined()
    expect(releaseDeadScratch(repo.root)).toBe(true)
    writeLock(repo.root, { pid: deadPid(), since: Date.now(), until: Date.now() + 60_000 })
    expect(withScratchLock(repo.root, ctx, () => ok(scratchHolder(repo.root)?.pid))).toEqual(ok(process.pid))
  })

  it('a lock names until = since + 7 days, and a job hold names its kind', () => {
    const repo = tmpRepo()
    const ctx = fakeCtx(repo.root)
    const held = value(withScratchLock(repo.root, ctx, () => ok(readLock(repo.root)), { job: 'lint-effect' }))
    expect(held).toMatchObject({ pid: process.pid, job: 'lint-effect' })
    expect(held.until - held.since).toBe(7 * 86_400_000)
    const plain = value(withScratchLock(repo.root, ctx, () => ok(readLock(repo.root))))
    expect(plain.job).toBeUndefined()
  })

  it('a lock whose since is in the future is stale', async () => {
    const repo = tmpRepo()
    const pid = await sleeper()
    writeLock(repo.root, { pid, since: Date.now() + 3_600_000, until: Date.now() + 7_200_000 })
    expect(scratchHolder(repo.root)).toBeUndefined()
    expect(releaseDeadScratch(repo.root)).toBe(true)
  })

  it('a lock an older witness wrote, or one with no until, reads by its pid; a job name must be a string', async () => {
    const repo = tmpRepo()
    const pid = await sleeper()
    writeLock(repo.root, { pid, since: Date.now() })
    expect(scratchHolder(repo.root)).toMatchObject({ pid })
    writeLock(repo.root, { pid, since: Date.now(), job: 'base-lint' })
    expect(scratchHolder(repo.root)?.job).toBe('base-lint')
    writeLock(repo.root, { pid, since: Date.now(), job: 7 })
    expect(scratchHolder(repo.root)).toBeUndefined()
  })
})
