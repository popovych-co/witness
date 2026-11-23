import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DRIVE_DEADLINE_FILE_ENV, sessionToken } from '../src/deadline.js'
import {
  TURN_DIR, behindJob, headTicket, runnerLockPath, sweepTurnQueue, turnHolder, turnIo, withRunnerTurn, type TurnTicket,
} from '../src/runner-lock.js'
import { fakeCtx, fakeScenario, fixtureEnv, patchConfig, seededRepo, tmpRepo } from './helpers.js'

// The CLI child of tests/runner-exec.test.ts: the source CLI under node, its pid the witness's own.
const REPO = resolve(import.meta.dirname, '..')
const TSX_LOADER = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href
function turnChild(cwd: string, cmd: string[], env: Record<string, string> = {}): Promise<{ code: number | null }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, join(REPO, 'src', 'bin.ts'), 'turn', '--', ...cmd],
      { cwd, env: fixtureEnv(env) as NodeJS.ProcessEnv, stdio: 'ignore' })
    child.on('close', (code) => done({ code }))
  })
}
const OTHER = process.ppid                                    // alive, and not this process
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!
const tickets = (root: string): string[] =>
  existsSync(join(root, TURN_DIR)) ? readdirSync(join(root, TURN_DIR)).filter((n) => n.endsWith('.json')).sort() : []
const ticket = (root: string, name: string): TurnTicket => JSON.parse(readFileSync(join(root, TURN_DIR, name), 'utf8'))
const putTicket = (root: string, t: TurnTicket) => {
  mkdirSync(join(root, TURN_DIR), { recursive: true })
  writeFileSync(join(root, TURN_DIR, `${t.since}-${t.pid}.json`), JSON.stringify(t))
}
const putLock = (root: string, body: object) => {
  mkdirSync(join(root, '.witness'), { recursive: true })
  writeFileSync(runnerLockPath(root), JSON.stringify(body))
}
async function until(pred: () => boolean, ms = 20_000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('the queued turn (row 255)', () => {
  it('waiters take the turn in the order they came, each holding a ticket while it waits', async () => {
    const repo = tmpRepo()
    const log = join(fakeScenario(), 'order')
    const holder = turnChild(repo.root, ['sh', '-c', 'sleep 10'])   // outlasts three CLI start-ups
    await until(() => existsSync(runnerLockPath(repo.root)) && tickets(repo.root).length === 0)
    const waiters: Array<Promise<{ code: number | null }>> = []
    for (const w of ['w1', 'w2', 'w3']) {
      waiters.push(turnChild(repo.root, ['sh', '-c', `echo ${w} >> "${log}"`]))
      await until(() => tickets(repo.root).length === waiters.length)
    }
    expect((await Promise.all([holder, ...waiters])).map((r) => r.code)).toEqual([0, 0, 0, 0])
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['w1', 'w2', 'w3'])
    expect(tickets(repo.root)).toEqual([])
  }, 60_000)

  it('a ticket names the session it waits for, from the deadline file drive handed it', async () => {
    const repo = tmpRepo()
    putLock(repo.root, { pid: OTHER })
    const waiter = turnChild(repo.root, ['true'], { [DRIVE_DEADLINE_FILE_ENV]: join(repo.root, '.witness', 'live', 'deadline', '77-3.json') })
    await until(() => tickets(repo.root).length === 1)
    const t = ticket(repo.root, tickets(repo.root)[0]!)
    expect(t.session).toBe('77-3')
    expect(t.job).toBeUndefined()
    unlinkSync(runnerLockPath(repo.root))
    expect((await waiter).code).toBe(0)
  }, 60_000)

  it('a waiter whose ticket was removed puts it back with the place it had', async () => {
    const repo = tmpRepo()
    putLock(repo.root, { pid: OTHER })
    const waiter = turnChild(repo.root, ['true'])
    await until(() => tickets(repo.root).length === 1)
    const name = tickets(repo.root)[0]!
    const was = ticket(repo.root, name)
    unlinkSync(join(repo.root, TURN_DIR, name))
    await until(() => tickets(repo.root).length === 1, 5_000)
    expect(ticket(repo.root, tickets(repo.root)[0]!).since).toBe(was.since)
    unlinkSync(runnerLockPath(repo.root))
    expect((await waiter).code).toBe(0)
  }, 60_000)

  it('a dead waiter and a live pid whose lease lapsed never hold the queue (Review Focus 2)', () => {
    const repo = tmpRepo()
    const now = Date.now()
    putTicket(repo.root, { pid: deadPid(), since: now - 10_000, until: now + 50_000 })
    putTicket(repo.root, { pid: OTHER, since: now - 9_000, until: now - 1 })
    const t0 = Date.now()
    expect(withRunnerTurn(repo.root, fakeCtx(repo.root), 'x', () => 42)).toBe(42)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(tickets(repo.root)).toEqual([])
  })

  it('sweepTurnQueue removes stale tickets and keeps live ones', () => {
    const repo = tmpRepo()
    const now = Date.now()
    putTicket(repo.root, { pid: deadPid(), since: now - 2, until: now + 50_000 })
    putTicket(repo.root, { pid: OTHER, since: now - 1, until: now - 1 })
    putTicket(repo.root, { pid: OTHER, since: now, until: now + 50_000 })
    expect(sweepTurnQueue(repo.root)).toBe(2)
    expect(tickets(repo.root)).toEqual([`${now}-${OTHER}.json`])
  })

  it('an ungated job yields to plan work; a gated one keeps its place; ties go by pid', () => {
    const job: TurnTicket = { pid: 1, since: 1, until: 9e15, job: 'explore', gated: false }
    const plan: TurnTicket = { pid: 2, since: 2, until: 9e15 }
    expect(headTicket([job, plan])).toBe(plan)
    expect(headTicket([{ ...job, gated: true }, plan])?.pid).toBe(1)
    expect(headTicket([job])).toBe(job)
    expect(headTicket([{ pid: 9, since: 5, until: 9e15 }, { pid: 3, since: 5, until: 9e15 }])?.pid).toBe(3)
    expect(headTicket([])).toBeUndefined()
  })

  it('a job holder writes its kind and take time into the lock; re-entry takes no ticket', () => {
    const repo = tmpRepo()
    withRunnerTurn(repo.root, fakeCtx(repo.root), 'x', () => {
      expect(turnHolder(repo.root)).toMatchObject({ pid: process.pid, job: 'fixture' })
      expect(typeof turnHolder(repo.root)!.since).toBe('number')
      withRunnerTurn(repo.root, fakeCtx(repo.root), 'inner', () => expect(tickets(repo.root)).toEqual([]))
    }, { job: 'fixture', gated: true })
    expect(existsSync(runnerLockPath(repo.root))).toBe(false)
  })

  it('drive.parallelSuites: true writes no ticket and no lock (Review Focus 4)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { drive: { parallelSuites: true } })
    withRunnerTurn(repo.root, fakeCtx(repo.root), 'x', () => {
      expect(existsSync(runnerLockPath(repo.root))).toBe(false)
      expect(tickets(repo.root)).toEqual([])
    })
  })

  it('behindJob names the job holding the turn while the session waits — never a session holder or an older lock (Review Focus 3)', () => {
    const repo = tmpRepo()
    const now = Date.now()
    putLock(repo.root, { pid: OTHER, since: now, job: 'fixture' })
    putTicket(repo.root, { pid: process.pid, since: now, until: now + 50_000, session: '77-3' })
    expect(behindJob(repo.root, '77-3')).toBe('fixture')
    expect(behindJob(repo.root, '77-4')).toBeUndefined()
    putLock(repo.root, { pid: OTHER })
    expect(turnHolder(repo.root)).toEqual({ pid: OTHER })
    expect(behindJob(repo.root, '77-3')).toBeUndefined()
  })

  it('a renewal a Windows scanner blocks is best effort: the wait goes on and the run is not lost (slice 1 review I1)', () => {
    const repo = tmpRepo()
    // An orphan holder that outlives one renewal (10 s), then dies, so the in-process wait is bounded.
    const holder = Number(spawnSync('sh', ['-c', 'sleep 11 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim())
    putLock(repo.root, { pid: holder })
    const io = { ...turnIo }
    const busy = () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }) }
    turnIo.rename = busy
    turnIo.rm = busy
    try {
      expect(withRunnerTurn(repo.root, fakeCtx(repo.root), 'x', () => 42)).toBe(42)
    } finally {
      Object.assign(turnIo, io)
    }
    expect(tickets(repo.root)).toEqual([])
  }, 30_000)

  it("sessionToken reads the token from the deadline file's name alone", () => {
    expect(sessionToken({ [DRIVE_DEADLINE_FILE_ENV]: '/r/.witness/live/deadline/77-3.json' })).toBe('77-3')
    expect(sessionToken({ [DRIVE_DEADLINE_FILE_ENV]: '/r/evil.json' })).toBeUndefined()
    expect(sessionToken({ [DRIVE_DEADLINE_FILE_ENV]: '/r/0-3.json' })).toBeUndefined()
    expect(sessionToken({})).toBeUndefined()
  })
})
