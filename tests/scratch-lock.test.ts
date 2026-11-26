import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRIVE_DEADLINE_FILE_ENV } from '../src/deadline.js'
import { ok, type Result } from '../src/refusal.js'
import { behindJob } from '../src/runner-lock.js'
import {
  SCRATCH_LOCK, releaseDeadScratch, scratchHolder, scratchWaiters, sweepScratchWaiters, withScratchLock, type ScratchWaiter,
} from '../src/scratch-lock.js'
import { fakeCtx, tmpRepo } from './helpers.js'

// The scratch lock's first pause runs `hook.onPause` once, when set; every other pause is the real one.
const hook = vi.hoisted(() => ({ onPause: undefined as undefined | (() => void) }))
vi.mock('../src/lock.js', async (orig) => {
  const actual = await orig<typeof import('../src/lock.js')>()
  return {
    ...actual,
    pause: (ms: number) => {
      const h = hook.onPause
      hook.onPause = undefined
      if (h) h()
      else actual.pause(ms)
    },
  }
})

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
const writeWaiter = (root: string, w: Record<string, unknown> & { pid: number }) => {
  mkdirSync(join(root, '.witness', 'live', 'scratch'), { recursive: true })
  writeFileSync(join(root, '.witness', 'live', 'scratch', `wait-${w.pid}.json`), JSON.stringify(w))
}
const markers = (root: string) => readdirSync(join(root, '.witness', 'live', 'scratch')).filter((n) => n.startsWith('wait-'))
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

  it('a live holder whose since reads in the future after the clock stepped back keeps the scratch (slice 1 review M1)', async () => {
    const repo = tmpRepo()
    const pid = await sleeper(); const waiter = await sleeper()
    writeLock(repo.root, { pid, since: Date.now() + 3_600_000, until: Date.now() + 7_200_000 })
    writeWaiter(repo.root, { pid: waiter, since: Date.now() + 3_600_000 })
    expect(scratchHolder(repo.root)?.pid).toBe(pid)
    expect(releaseDeadScratch(repo.root)).toBe(false)
    expect(scratchWaiters(repo.root).map((w) => w.pid)).toEqual([waiter])
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

describe('a session waiting on a job\'s scratch is held (row 279)', () => {
  it("a session waiting for a job's scratch is behind that job (row 279)", async () => {
    const repo = tmpRepo()
    const holder = await sleeper(); const waiter = await sleeper()
    writeLock(repo.root, { pid: holder, since: Date.now(), job: 'lint-effect' })
    writeWaiter(repo.root, { pid: waiter, since: Date.now(), session: '4242-1' })
    expect(behindJob(repo.root, '4242-1')).toBe('lint-effect')
    expect(behindJob(repo.root, '4242-2')).toBeUndefined()
  })

  it("a session waiting on a session's scratch is not held", async () => {
    const repo = tmpRepo()
    const holder = await sleeper(); const waiter = await sleeper()
    writeLock(repo.root, { pid: holder, since: Date.now() })
    writeWaiter(repo.root, { pid: waiter, since: Date.now(), session: '4242-1' })
    expect(behindJob(repo.root, '4242-1')).toBeUndefined()
  })

  it("a dead waiter's marker reads nothing and the sweep removes it", async () => {
    const repo = tmpRepo()
    const holder = await sleeper(); const live = await sleeper()
    writeLock(repo.root, { pid: holder, since: Date.now(), job: 'lint-effect' })
    const dead = deadPid()
    writeWaiter(repo.root, { pid: dead, since: Date.now(), session: '4242-1' })
    writeWaiter(repo.root, { pid: live, since: Date.now(), session: '4242-2' })
    expect(scratchWaiters(repo.root).map((w) => w.pid)).toEqual([live])
    expect(behindJob(repo.root, '4242-1')).toBeUndefined()
    expect(sweepScratchWaiters(repo.root)).toBe(1)
    expect(markers(repo.root)).toEqual([`wait-${live}.json`])
  })

  it('a waiter writes its marker before it pauses and removes it once it holds the scratch', async () => {
    const repo = tmpRepo()
    const holder = await sleeper()
    writeLock(repo.root, { pid: holder, since: Date.now(), job: 'lint-effect' })
    // the session is drive's token, read from the deadline file's name (`sessionToken`)
    const ctx = fakeCtx(repo.root, { env: { [DRIVE_DEADLINE_FILE_ENV]: join(repo.root, '.witness', 'live', 'deadline', '4242-1.json') } })
    let seen: ScratchWaiter[] = []
    let behind: string | undefined
    hook.onPause = () => {
      seen = scratchWaiters(repo.root)
      behind = behindJob(repo.root, '4242-1')
      rmSync(join(repo.root, SCRATCH_LOCK))   // the job's hold ends
    }
    const inside = value(withScratchLock(repo.root, ctx, () => ok(scratchWaiters(repo.root))))
    expect(seen).toMatchObject([{ pid: process.pid, session: '4242-1' }])
    expect(behind).toBe('lint-effect')
    expect(inside).toEqual([])
    expect(markers(repo.root)).toEqual([])
    expect(existsSync(join(repo.root, SCRATCH_LOCK))).toBe(false)
  })
})
