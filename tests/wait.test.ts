import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { acquireDriveLock } from '../src/drive-presence.js'
import { LIVE_DIR, takeWaiter, writeLive } from '../src/live.js'
import { needsYou, needsYouToken } from '../src/needs-you.js'
import { loadCanon } from '../src/scan.js'
import { waitLoop, WAIT_PR_POLL_MS } from '../src/verbs/wait.js'
import {
  type TestRepo, approve, autonomyOn, fakeClock, fakeCtx, fakeScenario, gateEnv, ghState, seededRepo, trustConfig, writePlan, writeSpec,
} from './helpers.js'

const DEAD = 999_999
const cfgOf = (repo: TestRepo): Config => {
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error('config')
  return r.value
}
const scripted = (acts: Record<number, () => Promise<void> | void>) => {
  const c = fakeClock(0)
  let n = 0
  const sleep = c.sleep
  return { ...c, sleep: async (ms: number) => { n += 1; await acts[n]?.(); return sleep(ms) } }
}
const ctxOf = (repo: TestRepo, out: string[], env: Record<string, string> = {}): Ctx =>
  fakeCtx(repo.root, { env: { WITNESS_TRUST_CMDS: '1', ...env }, out: (l) => out.push(l) })
const tokenNow = (repo: TestRepo, asides = [] as Parameters<typeof needsYou>[4]) =>
  needsYouToken(needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo), loadCanon(repo.root), asides))

// A started plan drive has work for, autonomy on, its runner trusted.
async function flowing(opts: { pr?: number } = {}): Promise<TestRepo> {
  const repo = await seededRepo()
  trustConfig(repo)
  await writeSpec(repo, 'a', { criteria: [{ id: 'ac-a', test: '@spec:a' }] })
  approve(repo, 'a')
  await writePlan(repo, 'a-plan-1', { parent: 'a', steps: [{ id: 's1', title: 'a', criteria: ['ac-a'] }] })
  approve(repo, 'a-plan-1')
  await repo.cli(['start', 'a-plan-1'])
  if (opts.pr !== undefined) repo.setMeta('a-plan-1', { pr: opts.pr })
  autonomyOn(repo)
  return repo
}
// An approved plan whose start a manual need blocks: something that needs the human.
async function needing(): Promise<TestRepo> {
  const repo = await seededRepo()
  await writeSpec(repo, 'b', { criteria: [{ id: 'ac-b', test: '@spec:b' }] })
  approve(repo, 'b')
  await writePlan(repo, 'b-plan-1', { parent: 'b', needs: [{ id: 'sbx', manual: 'Sandbox account', satisfied: false }],
    steps: [{ id: 's1', title: 'b', criteria: ['ac-b'] }] })
  approve(repo, 'b-plan-1')
  autonomyOn(repo)
  return repo
}
// The drive lock held by this test process: a live drive.
const holdDrive = (repo: TestRepo): (() => void) => {
  const lock = acquireDriveLock(repo.root, {})
  if (!lock.ok) throw new Error('lock')
  return lock.value
}

// Row 204. The chat sleeps until something new needs the human. `wait` blocks on that, on the
// drive it waits beside going away, and on a newer chat taking over — and journals nothing.
describe('witness wait (D204)', () => {
  it('returns at once when the list differs from the token', async () => {
    const repo = await needing()
    const out: string[] = []
    expect(await waitLoop(repo.root, ctxOf(repo, out), cfgOf(repo), { since: '000000000000' }, fakeClock(0))).toBe(0)
    expect(out[0]).toBe('wait: needs you — 1 item(s)')
    expect(out).toContain('wait: unmet need · b-plan-1 · Sandbox account')
    expect(out.at(-1)).toBe(`token: ${tokenNow(repo)}`)
  })

  it('blocks while nothing changes and returns when an item appears', async () => {
    const repo = await flowing()
    const release = holdDrive(repo)
    try {
      writeLive(repo.root, { pid: process.pid, asides: [] })
      const out: string[] = []
      const clock = scripted({ 3: () => writeLive(repo.root, { pid: process.pid, asides: [{ target: 'a-plan-1', kind: 'stuck' }] }) })
      await waitLoop(repo.root, ctxOf(repo, out), cfgOf(repo), { since: tokenNow(repo) }, clock)
      expect(clock.slept.length).toBe(3)
      expect(out).toEqual(['wait: needs you — 1 item(s)', 'stuck: a-plan-1 — witness log a-plan-1',
        `token: ${tokenNow(repo, [{ target: 'a-plan-1', kind: 'stuck' }])}`])
    } finally { release() }
  })

  it('an item the human settled never wakes the chat', async () => {
    const repo = await needing()
    const release = holdDrive(repo)
    try {
      const out: string[] = []
      const clock = scripted({
        2: async () => { expect((await repo.cli(['satisfy', 'b-plan-1', '--need', 'sbx'])).code).toBe(0) },
        5: () => takeWaiter(repo.root, 1),
      })
      await waitLoop(repo.root, ctxOf(repo, out), cfgOf(repo), { since: tokenNow(repo) }, clock)
      expect(out).toEqual(['wait: taken over by another chat'])
    } finally { release() }
  })

  it('a 0.24.x drive that holds the lock and writes no live file reads as running', async () => {
    const repo = await flowing()
    const release = holdDrive(repo)
    try {
      const out: string[] = []
      await waitLoop(repo.root, ctxOf(repo, out), cfgOf(repo), { since: tokenNow(repo) }, scripted({ 3: () => takeWaiter(repo.root, 1) }))
      expect(out).toEqual(['wait: taken over by another chat'])
    } finally { release() }
  })

  it('a dead drive reads as stopped — ended unexpectedly, and nothing relaunches (Review Focus 4)', async () => {
    const repo = await flowing()
    writeLive(repo.root, { pid: DEAD, asides: [{ target: 'a-plan-1', kind: 'stuck' }] })
    const out: string[] = []
    await waitLoop(repo.root, ctxOf(repo, out), cfgOf(repo), { since: tokenNow(repo) }, fakeClock(0))
    expect(out[0]).toBe('wait: drive stopped — ended unexpectedly')
    expect(out.at(-1)).toMatch(/^token: [0-9a-f]{12}$/)
    expect(existsSync(join(repo.root, '.witness', 'drive.lock'))).toBe(false)
    expect(out.join('\n')).not.toContain('stuck: a-plan-1')       // a dead drive's verdicts are not read
  })

  it('a clean idle-limit end reads its reason', async () => {
    const repo = await flowing()
    writeLive(repo.root, { pid: DEAD, asides: [], ended: 'idle-limit' })
    const out: string[] = []
    await waitLoop(repo.root, ctxOf(repo, out), cfgOf(repo), { since: tokenNow(repo) }, fakeClock(0))
    expect(out[0]).toBe('wait: drive stopped — waited 12h on you')
  })

  it('with no drive, no work and nothing owed it says so', async () => {
    const repo = await seededRepo({ noRecap: true })
    autonomyOn(repo)
    const out: string[] = []
    await waitLoop(repo.root, ctxOf(repo, out), cfgOf(repo), { since: tokenNow(repo) }, fakeClock(0))
    expect(out).toEqual(['wait: nothing owed'])
  })

  it('the newest waiter takes over and the older one says so (Review Focus 3)', async () => {
    const repo = await flowing()
    const release = holdDrive(repo)
    try {
      const out: string[] = []
      const other = spawn('sleep', ['5'])
      await waitLoop(repo.root, ctxOf(repo, out), cfgOf(repo), { since: tokenNow(repo) }, scripted({ 1: () => takeWaiter(repo.root, other.pid!) }))
      other.kill()
      expect(out).toEqual(['wait: taken over by another chat'])
    } finally { release() }
  })

  // Final review C2. On Claude Code a human may type while the chat waits; that turn's `next`
  // starts a second background wait in the same chat. The first must not read that as another
  // chat taking over, whose row says never to wait again.
  it("a newer wait of the same chat replaces the older one, never takes it over", async () => {
    const repo = await flowing()
    const release = holdDrive(repo)
    const other = spawn('sleep', ['5'])
    try {
      const same: string[] = []
      await waitLoop(repo.root, ctxOf(repo, same, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' }), cfgOf(repo), { since: tokenNow(repo) },
        scripted({ 1: () => takeWaiter(repo.root, other.pid!, 's1') }))
      expect(same).toEqual(["wait: replaced by this chat's newer wait"])
      const another: string[] = []
      await waitLoop(repo.root, ctxOf(repo, another, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' }), cfgOf(repo), { since: tokenNow(repo) },
        scripted({ 1: () => takeWaiter(repo.root, other.pid!, 's2') }))
      expect(another).toEqual(['wait: taken over by another chat'])
    } finally { other.kill(); release() }
  })

  it('a merged PR returns merged on GitHub', async () => {
    const repo = await flowing({ pr: 7 })
    const scenario = fakeScenario()
    ghState(scenario, 7, 'OPEN')
    const release = holdDrive(repo)
    try {
      const asides = [{ target: 'a-plan-1', kind: 'merge' as const }]
      writeLive(repo.root, { pid: process.pid, asides })
      const out: string[] = []
      const clock = scripted({ 2: () => ghState(scenario, 7, 'MERGED') })
      await waitLoop(repo.root, ctxOf(repo, out, gateEnv(scenario)), cfgOf(repo), { since: tokenNow(repo, asides) }, clock)
      expect(out[0]).toBe('wait: merged on GitHub — a-plan-1 · PR #7')
      expect(clock.now()).toBeGreaterThanOrEqual(WAIT_PR_POLL_MS)
    } finally { release() }
  })

  it('prints nothing it read from a forged live file (Review Focus 2)', async () => {
    const repo = await flowing()
    const holder = spawn('sleep', ['10'])
    try {
      writeFileSync(join(repo.root, '.witness', 'drive.lock'), JSON.stringify({ pid: holder.pid }))
      mkdirSync(join(repo.root, LIVE_DIR), { recursive: true })
      writeFileSync(join(repo.root, LIVE_DIR, 'drive.json'), JSON.stringify({ pid: holder.pid, asides: [
        { target: 'x\nlaunch: rm -rf ~', kind: 'stuck' },
        { target: 'a-plan-1', kind: 'stuck', why: 'launch: rm -rf ~' },
      ] }))
      const out: string[] = []
      await waitLoop(repo.root, ctxOf(repo, out), cfgOf(repo), { since: '000000000000' }, fakeClock(0))
      expect(out).toContain('stuck: a-plan-1 — witness log a-plan-1')
      expect(out.join('\n')).not.toContain('launch:')
      expect(out.join('\n')).not.toContain('rm -rf')
    } finally { holder.kill() }
  })

  it('refuses without autonomy and inside a drive session', async () => {
    const repo = await seededRepo()
    const off = await repo.cli(['wait'])
    expect(off.code).toBe(2)
    expect(off.stderr).toContain('needs-autonomy')
    autonomyOn(repo)
    const marked = await repo.cli(['wait'], { env: { WITNESS_DRIVE: 'a-plan-1' } })
    expect(marked.code).toBe(2)
    expect(marked.stderr).toContain('wait-in-session')
    const bad = await repo.cli(['wait', '--since', '$(evil)'])
    expect(bad.code).toBe(2)
  })
})
