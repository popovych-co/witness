import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUSY_DIR } from '../src/busy.js'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { PAUSE_POLL_MS, driveLoop, settleAdmitsFor, watchSignature } from '../src/drive.js'
import { acquireDriveLock } from '../src/drive-presence.js'
import { appendEntry, readStream } from '../src/journal.js'
import { readLive } from '../src/live.js'
import { loadCanon } from '../src/scan.js'
import { waitLoop } from '../src/verbs/wait.js'
import { worktreePath } from '../src/worktree.js'
import {
  approve, autonomyOn, fakeClock, fakeCtx, fakeScenario, fixtureEnv, noopOpener, patchConfig, seededRepo, writeLocalConfig,
  writePlan, writeSpec, type TestRepo,
} from './helpers.js'

// Row 240 (design §4.1.2: Drive, An older drive). Drive meets a target another live process holds:
// it skips it and polls, never reads it as a cap or as no progress; its settle pass judges a spec's
// stop beside its plans' lanes; and a drive from before 0.29 is named rather than raced.

const OTHER = process.ppid
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!
const cfgOf = (repo: TestRepo): Config => {
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
  return r.value
}
const hold = (root: string, kind: 'settle' | 'ship', target: string, pid = OTHER) => {
  mkdirSync(join(root, BUSY_DIR), { recursive: true })
  writeFileSync(join(root, BUSY_DIR, `${target}.${kind}.json`), JSON.stringify({ pid, since: Date.now(), until: Date.now() + 3_600_000 }))
}
const unhold = (root: string, kind: 'settle' | 'ship', target: string) => rmSync(join(root, BUSY_DIR, `${target}.${kind}.json`), { force: true })

async function startedFlows(specs: string[]): Promise<TestRepo> {
  const repo = await seededRepo()
  for (const s of specs) {
    await writeSpec(repo, s, { criteria: [{ id: `ac-${s}`, test: `@spec:${s}` }] })
    approve(repo, s)
    await writePlan(repo, `${s}-plan-1`, { parent: s, steps: [{ id: 's1', title: s, criteria: [`ac-${s}`] }] })
    approve(repo, `${s}-plan-1`)
    await repo.cli(['start', `${s}-plan-1`])
  }
  autonomyOn(repo)
  writeLocalConfig(repo.root, { notify: noopOpener() })
  return repo
}
const autoCtx = (repo: TestRepo, env: Record<string, string>, out: string[]): Ctx =>
  fakeCtx(repo.root, { env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), WITNESS_DRIVE_IDLE_MAX_MS: '0', ...env }), out: (l) => out.push(l) })
const script = (body: string): string => {
  const bin = join(fakeScenario(), 'agent')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}
// A fake clock whose n-th pause-cadence sleep runs `on`, then sleeps as the fake does.
const clockWith = (on: (n: number) => void) => {
  const c = fakeClock(0)
  let n = 0
  const sleep = c.sleep
  return Object.assign(c, { sleep: async (ms: number) => { if (ms === PAUSE_POLL_MS) on(++n); await sleep(ms) } })
}

describe('drive and busy targets (row 240)', () => {
  it('drive skips a busy target and polls instead of ending or pausing for the human', async () => {
    const repo = await startedFlows(['a'])
    hold(repo.root, 'ship', 'a-plan-1')
    const log = join(fakeScenario(), 'spawned')
    const out: string[] = []
    let atRelease = ''
    const clock = clockWith((n) => { if (n === 2) { atRelease = out.join('\n'); unhold(repo.root, 'ship', 'a-plan-1') } })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "$WITNESS_DRIVE" >> "${log}"`) }, out), { maxSpawns: 1 }, clock)
    expect(clock.slept.filter((ms) => ms === PAUSE_POLL_MS).length).toBeGreaterThanOrEqual(2)
    // while it was busy: no session, no "done", no pause for the human
    expect(atRelease).not.toMatch(/drive: (idle|waiting on you|done)/)
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('a-plan-1\n')   // spawned once, after the release
  }, 60_000)

  it('the settle pass admits a lane\'s family member, and nothing set aside, busy or out of the flow (P18 inverted)', () => {
    const lanes = new Map([['a-plan-1', {}]])
    const none = new Map<string, unknown>()
    const free = () => false
    expect(settleAdmitsFor('a', { lanes, aside: none, busy: free })).toBe(true)              // the spec beside its plan's lane
    expect(settleAdmitsFor('a-plan-1', { lanes, aside: none, busy: free })).toBe(false)      // the lane settles its own
    expect(settleAdmitsFor('b-plan-1', { lanes, aside: new Map([['b-plan-1', {}]]), busy: free })).toBe(false)
    expect(settleAdmitsFor('b-plan-1', { lanes, aside: none, busy: (t) => t === 'b-plan-1' })).toBe(false)
    // a --flow drive settles only its flow
    expect(settleAdmitsFor('b-plan-1', { lanes: none, aside: none, flow: 'a-plan-1', busy: free })).toBe(false)
    expect(settleAdmitsFor('a-plan-1', { lanes: none, aside: none, flow: 'a-plan-1', busy: free })).toBe(true)
  })

  it('a busy parkAtCap sets nothing aside; the target is tried next round and then parks', async () => {
    const repo = await startedFlows(['a'])
    for (const round of [1, 2]) {
      appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'gate-run', gate: 'implement', artifact: 'a-plan-1', round,
        run_id: `ri${round}`, reviewed_sha: `s${round}`, prompts_sha: 'p', witness: '0', model: 'm', pin: 'm',
        checks: [], outcome: 'stopped' })
      appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'human-decision', gate: 'implement', artifact: 'a-plan-1', round, decision: 'revise' })
    }
    writeFileSync(join(worktreePath(repo.root, 'a-plan-1'), 'moved.txt'), 'the author kept working\n')
    patchConfig(repo, { drive: { caps: { rounds: 2 } } })
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'caps')
    hold(repo.root, 'settle', 'a-plan-1')
    const out: string[] = []
    let atRelease = ''
    const clock = clockWith((n) => { if (n === 1) { atRelease = out.join('\n'); unhold(repo.root, 'settle', 'a-plan-1') } })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('echo tick') }, out), {}, clock)
    expect(atRelease).not.toContain('drive: capped')
    expect(atRelease).not.toContain('drive: parked')
    expect(out.join('\n')).toContain('drive: parked — a-plan-1 · drive cap: implement ran 2 rounds')
  }, 60_000)

  it('a lane whose target is busy when it ends is no progress and no cap', async () => {
    const repo = await startedFlows(['a'])
    const log = join(fakeScenario(), 'spawned')
    const flag = join(fakeScenario(), 'took-ship')
    // the first session's end finds a human's `witness ship` holding the plan
    const agent = script(`echo "$WITNESS_DRIVE" >> "${log}"
if [ ! -f "${flag}" ]; then touch "${flag}"; mkdir -p "${join(repo.root, BUSY_DIR)}"; printf '{"pid":${OTHER},"since":%s000,"until":%s000}' "$(date +%s)" "$(( $(date +%s) + 3600 ))" > "${join(repo.root, BUSY_DIR, 'a-plan-1.ship.json')}"; fi`)
    const out: string[] = []
    let atRelease = ''
    const clock = clockWith((n) => { if (n === 1) { atRelease = out.join('\n'); unhold(repo.root, 'ship', 'a-plan-1') } })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {}, clock)
    expect(atRelease).not.toContain('drive: no progress')
    // after the release a second session runs, and only then does an unmoved key read as stuck
    expect(readFileSync(log, 'utf8')).toBe('a-plan-1\na-plan-1\n')
    expect(out.join('\n')).toContain('drive: no progress — ')
  }, 60_000)

  it('drive drops dead holders\' locks at start and after every session', async () => {
    const repo = await startedFlows(['a'])
    hold(repo.root, 'settle', 'a-plan-1', deadPid())
    const seen = join(fakeScenario(), 'seen')
    const lock = join(repo.root, BUSY_DIR, 'a-plan-1.settle.json')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, {
      WITNESS_DRIVE_AGENT_BIN: script(`[ -f "${lock}" ] && echo present >> "${seen}" || echo gone >> "${seen}"
mkdir -p "${join(repo.root, BUSY_DIR)}"; printf '{"pid":${deadPid()},"since":1,"until":9999999999999}' > "${join(repo.root, BUSY_DIR, 'a-plan-1.ship.json')}"`),
    }, out), { maxSpawns: 1 }, fakeClock(0))
    expect(readFileSync(seen, 'utf8')).toBe('gone\n')
    expect(existsSync(join(repo.root, BUSY_DIR, 'a-plan-1.ship.json'))).toBe(false)
  }, 60_000)

  it('the busy folder is in watchSignature; the repo lock is not', async () => {
    const repo = await startedFlows(['a'])
    const s0 = watchSignature(repo.root)
    writeFileSync(join(repo.root, '.witness', 'lock'), JSON.stringify({ pid: process.pid }))
    expect(watchSignature(repo.root)).toBe(s0)
    rmSync(join(repo.root, '.witness', 'lock'))
    hold(repo.root, 'settle', 'a-plan-1')
    expect(watchSignature(repo.root)).not.toBe(s0)
  }, 60_000)

  it('a drive whose state floor rises past its own version ends superseded', async () => {
    const repo = await startedFlows(['a'])
    appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'note', artifact: 'a-plan-1', text: 'from the future', w: '99.0.0' } as never)
    const out: string[] = []
    const log = join(fakeScenario(), 'spawned')
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo x >> "${log}"`) }, out), {}, fakeClock(0))
    expect(out).toContain('drive: superseded — a newer witness CLI took over')
    expect(existsSync(log)).toBe(false)
    expect(readLive(repo.root, loadCanon(repo.root))?.ended).toBe('superseded')
  }, 60_000)
})

describe('an older drive (row 240)', () => {
  const olderLock = (root: string, pid: number) =>
    writeFileSync(join(root, '.witness', 'drive.lock'), JSON.stringify({ pid, lease: 1 }))

  it('next beside a live drive lock without busy: 1 settles nothing and prints wait: older drive', async () => {
    const repo = await startedFlows(['a'])
    const holder = spawn('sleep', ['30'])
    try {
      olderLock(repo.root, holder.pid!)
      const before = readStream(repo.root, 'a-plan-1').length
      const r = await repo.cli(['next'], { env: { CLAUDECODE: '1' } })
      const out = r.stdout.split('\n')
      expect(out).toContain('wait: older drive — a witness drive from before 0.29 runs this repo · stop it, then say go')
      expect(out.some((l) => /^ {2}run: (kill|taskkill) /.test(l))).toBe(true)
      expect(out.some((l) => l.startsWith('next:'))).toBe(false)
      expect(readStream(repo.root, 'a-plan-1').length).toBe(before)
    } finally { holder.kill() }
  }, 60_000)

  it('wait beside an older drive says so and returns', async () => {
    const repo = await startedFlows(['a'])
    const holder = spawn('sleep', ['30'])
    try {
      olderLock(repo.root, holder.pid!)
      const out: string[] = []
      expect(await waitLoop(repo.root, fakeCtx(repo.root, { out: (l) => out.push(l) }), cfgOf(repo), {}, fakeClock(0))).toBe(0)
      expect(out[0]).toBe('wait: older drive — a witness drive from before 0.29 runs this repo · stop it, then say go')
      expect(out[1]).toMatch(/^ {2}run: (kill|taskkill) /)
    } finally { holder.kill() }
  }, 60_000)

  it('a drive of this version writes busy: 1, so its own readers never call it older', async () => {
    const repo = await startedFlows(['a'])
    const lock = acquireDriveLock(repo.root, {})
    if (!lock.ok) throw new Error('lock')
    try {
      expect(JSON.parse(readFileSync(join(repo.root, '.witness', 'drive.lock'), 'utf8')).busy).toBe(1)
      const r = await repo.cli(['next'], { env: { CLAUDECODE: '1' } })
      expect(r.stdout).not.toContain('older drive')
    } finally { lock.value() }
  }, 60_000)
})
