import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grantCommands } from '../src/allowlist.js'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { sessionHash } from '../src/context.js'
import { driveLoop, journalWatch, PAUSE_IDLE_MAX_MS, PAUSE_POLL_MS, watchSignature } from '../src/drive.js'
import { appendEntry, entryLine, journalRel, withJournalCtx } from '../src/journal.js'
import { readLive, writeLive } from '../src/live.js'
import { loadCanon } from '../src/scan.js'
import {
  type TestRepo, approve, autonomyOn, fakeClock, fakeCtx, fakeScenario, fixtureEnv, gateEnv, ghState, noopOpener, patchConfig, seededRepo,
  writeLocalConfig, writePlan, writeSpec, SCAFFOLDING_FIRST, startedThreeStepPlan,
} from './helpers.js'

const cfgOf = (repo: TestRepo): Config => {
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
  return r.value
}
const autoCtx = (repo: TestRepo, env: Record<string, string>, out: string[]): Ctx =>
  fakeCtx(repo.root, { env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), ...env }), out: (l) => out.push(l) })
const script = (body: string, name = 'agent'): string => {
  const bin = join(fakeScenario(), name)
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}
// A fake clock that runs a callback on its n-th sleep: the human's act, landing while drive waits.
const scripted = (acts: Record<number, () => Promise<void> | void>) => {
  const c = fakeClock(0)
  let n = 0
  const sleep = c.sleep
  return { ...c, sleep: async (ms: number) => { n += 1; await acts[n]?.(); return sleep(ms) } }
}

// An approved plan whose start a manual need blocks, and nothing else.
async function needBlocked(): Promise<TestRepo> {
  const repo = await seededRepo()
  await writeSpec(repo, 'a', { criteria: [{ id: 'ac-a', test: '@spec:a' }] })
  approve(repo, 'a')
  await writePlan(repo, 'a-plan-1', { parent: 'a', needs: [{ id: 'sbx', manual: 'Sandbox account', satisfied: false }],
    steps: [{ id: 's1', title: 'a', criteria: ['ac-a'] }] })
  approve(repo, 'a-plan-1')
  autonomyOn(repo)
  writeLocalConfig(repo.root, { notify: noopOpener() })
  return repo
}

// A started plan whose full-suite runner this machine does not trust.
async function trustBlocked(notifier = noopOpener()): Promise<TestRepo> {
  const repo = await seededRepo()
  patchConfig(repo, { criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' }, ship: { test: 'pnpm test', lint: 'pnpm lint' } })
  repo.git('add', 'witness.config.yaml')
  repo.git('commit', '-m', 'full-suite')
  await writeSpec(repo, 'ingest', { criteria: [{ id: 'ac-i', test: '@spec:ingest' }] })
  approve(repo, 'ingest')
  await writePlan(repo, 'ingest-plan-1', { parent: 'ingest', steps: [{ id: 's1', title: 'ingest', criteria: ['ac-i'] }] })
  approve(repo, 'ingest-plan-1')
  await repo.cli(['start', 'ingest-plan-1'])
  autonomyOn(repo)
  writeLocalConfig(repo.root, { notify: notifier })
  return repo
}
const NO_TRUST = { WITNESS_TRUST_CMDS: '' }

// Row 202 (issue #56). Drive quit exactly when it was needed: once every target waited on the
// human, it printed its report and exited, so row 196's take-back never ran. Under autonomy it
// now pauses — prints and notifies what waits, lets the machine sleep, watches for the human's
// act and resumes by itself — and gives up only after a long idle limit.
describe('drive waits for the human (D202)', () => {
  it('a run whose last target waits on the human pauses, and a satisfied need resumes it', async () => {
    const repo = await needBlocked()
    const out: string[] = []
    const clock = scripted({ 2: async () => { await repo.cli(['satisfy', 'a-plan-1', '--need', 'sbx']) } })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('echo tick') }, out), { maxSpawns: 1 }, clock)
    expect(out).toContain('drive: waiting on you — 1 item(s)')
    expect(out).toContain('wait: unmet need · a-plan-1 · Sandbox account')
    expect(out.some((l) => l.startsWith('drive: taken back — a-plan-1'))).toBe(true)
    expect(out.filter((l) => /\] tick$/.test(l))).toHaveLength(1)
  }, 60000)

  it('a grant written only to allow.json resumes a trust-blocked target', async () => {
    const repo = await trustBlocked()
    const out: string[] = []
    const clock = scripted({ 2: () => grantCommands(repo.root, ['pnpm test']) })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { ...NO_TRUST, WITNESS_DRIVE_AGENT_BIN: script('echo tick') }, out), { maxSpawns: 1 }, clock)
    expect(out).toContain('drive: waits on you — ingest-plan-1 · trust grant')
    expect(out).toContain('drive: waiting on you — 1 item(s)')
    expect(out.some((l) => l.startsWith('drive: taken back — ingest-plan-1 · witness test-evidence ingest-plan-1'))).toBe(true)
    expect(out.some((l) => /\] tick$/.test(l))).toBe(true)
  }, 60000)

  it('the pause ends at the idle limit with the report and a notification', async () => {
    const repo = await needBlocked()
    const log = join(fakeScenario(), 'notified')
    writeLocalConfig(repo.root, { notify: script(`echo "$1" >> "${log}"`, 'notifier') })
    const out: string[] = []
    const clock = fakeClock(0)
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('echo tick') }, out), {}, clock)
    expect(out).toContain('drive: idle limit — waited 12h on you · the run ends')
    expect(clock.now()).toBeGreaterThanOrEqual(PAUSE_IDLE_MAX_MS)
    expect(clock.slept.every((ms) => ms === PAUSE_POLL_MS)).toBe(true)
    expect(out.some((l) => l.startsWith('drive: done — 0 merged · 1 wait on you'))).toBe(true)
    expect(code).toBe(0)                                   // waiting on the human is no failure
    expect(readFileSync(log, 'utf8')).toContain('1 wait on you')
    expect(readLive(repo.root, loadCanon(repo.root))).toMatchObject({ ended: 'idle-limit', asides: [{ target: 'a-plan-1', kind: 'kept', stop: 'unmet-need' }] })
  }, 120000)

  it('drive never wakes on its own log or live folder', async () => {
    const repo = await needBlocked()
    const before = watchSignature(repo.root)
    writeFileSync(join(repo.root, '.witness/drive.log'), 'x')
    writeLive(repo.root, { pid: 1, asides: [] })
    expect(watchSignature(repo.root)).toBe(before)
    grantCommands(repo.root, ['x'])
    expect(watchSignature(repo.root)).not.toBe(before)
  })

  it('a needs-you item is notified once per run, and an unrelated change re-enters the pause silently', async () => {
    const log = join(fakeScenario(), 'notified')
    const repo = await trustBlocked(script(`echo "$1" >> "${log}"`, 'notifier'))
    const out: string[] = []
    const clock = scripted({ 2: () => { writeFileSync(join(repo.root, '.witness', 'config.local.yaml'), `${readFileSync(join(repo.root, '.witness', 'config.local.yaml'), 'utf8')}# unrelated\n`) } })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { ...NO_TRUST, WITNESS_DRIVE_IDLE_MAX_MS: '30000', WITNESS_DRIVE_AGENT_BIN: script('echo tick') }, out), {}, clock)
    expect(out.filter((l) => l === 'drive: waiting on you — 1 item(s)')).toHaveLength(1)
    await expect.poll(() => existsSync(log) && readFileSync(log, 'utf8').includes('trust grant · ingest-plan-1'), { timeout: 5000 }).toBe(true)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines.filter((l) => l.includes('trust grant · ingest-plan-1'))).toHaveLength(1)
    expect(lines.find((l) => l.includes('trust grant · ingest-plan-1'))).toMatch(/^witness · [^:]+: trust grant · ingest-plan-1$/)
  }, 60000)

  it('keep-awake is released while paused', async () => {
    const repo = await needBlocked()
    // a second flow whose one session runs half a second and moves nothing: it is set aside as
    // stuck, and then everything waits on the human
    await writeSpec(repo, 'b', { criteria: [{ id: 'ac-b', test: '@spec:b' }] })
    approve(repo, 'b')
    await writePlan(repo, 'b-plan-1', { parent: 'b', steps: [{ id: 's1', title: 'b', criteria: ['ac-b'] }] })
    approve(repo, 'b-plan-1')
    await repo.cli(['start', 'b-plan-1'])
    const log = join(fakeScenario(), 'awake.log')
    const awake = script(`trap 'echo term >> "${log}"; exit 0' TERM\necho start >> "${log}"\nwhile :; do sleep 0.05; done`, 'awake')
    let during = ''
    const clock = scripted({
      1: async () => {
        for (let i = 0; i < 60 && !(existsSync(log) && readFileSync(log, 'utf8').includes('term')); i++) await new Promise((r) => setTimeout(r, 50))
        during = existsSync(log) ? readFileSync(log, 'utf8') : ''
      },
    })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_KEEP_AWAKE_BIN: awake, WITNESS_DRIVE_IDLE_MAX_MS: '10000', WITNESS_DRIVE_AGENT_BIN: script('sleep 0.5') }, out), {}, clock)
    expect(out).toContain('drive: waiting on you — 2 item(s)')
    expect(during.trim().split('\n')).toEqual(['start', 'term'])
  }, 60000)

  it('a run with nothing aside ends as before, and autonomy off never pauses', async () => {
    const repo = await needBlocked()
    patchConfig(repo, { autonomy: 'off' })
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'autonomy off')
    const out: string[] = []
    const clock = fakeClock(0)
    await driveLoop(repo.root, cfgOf(repo), fakeCtx(repo.root, { tty: true, env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), WITNESS_DRIVE_AGENT_BIN: script('echo tick') }), out: (l) => out.push(l) }), {}, clock)
    expect(out.join('\n')).not.toContain('drive: waiting on you')
    expect(clock.slept).toEqual([])
  }, 60000)
})


const witnessCli = (): string => {
  const repo = resolve(import.meta.dirname, '..')
  return `${join(repo, 'node_modules', '.bin', 'tsx')} ${join(repo, 'src', 'bin.ts')}`
}

// A started plan, autonomy on; `drive.caps.spawns` when a cap is the point.
async function startedFlow(opts: { spawns?: number; pr?: number } = {}): Promise<TestRepo> {
  const repo = await seededRepo()
  if (opts.spawns !== undefined) {
    patchConfig(repo, { drive: { caps: { spawns: opts.spawns } } })
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'caps')
  }
  await writeSpec(repo, 'a', { criteria: [{ id: 'ac-a', test: '@spec:a' }] })
  approve(repo, 'a')
  await writePlan(repo, 'a-plan-1', { parent: 'a', steps: [{ id: 's1', title: 'a', criteria: ['ac-a'] }] })
  approve(repo, 'a-plan-1')
  await repo.cli(['start', 'a-plan-1'])
  if (opts.pr !== undefined) repo.setMeta('a-plan-1', { pr: opts.pr })
  autonomyOn(repo)
  writeLocalConfig(repo.root, { notify: noopOpener() })
  return repo
}
const ticks = (out: string[]) => out.filter((l) => /\] tick$/.test(l)).length

// Row 207. Row 196 took back only what a human set aside; drive's own verdicts and the merge
// stayed aside for good, which a paused drive would then hold forever. Each records its key
// now and comes back when its record moves — the human's `witness retry` for a fix that leaves
// no other record — and a release is a new chance: the target's per-run use starts over.
describe('what drive set aside comes back (D207)', () => {
  it('a stuck target comes back when the human retries it', async () => {
    const repo = await startedFlow()
    const out: string[] = []
    const clock = scripted({ 2: async () => { expect((await repo.cli(['retry', 'a-plan-1'])).code).toBe(0) } })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_IDLE_MAX_MS: '30000', WITNESS_DRIVE_AGENT_BIN: script('echo tick') }, out), {}, clock)
    expect(out).toContain('drive: no progress — witness test-evidence a-plan-1 --phase red --step s1')
    expect(out.some((l) => l.startsWith('drive: taken back — a-plan-1'))).toBe(true)
    expect(ticks(out)).toBe(2)
  }, 60000)

  it('a capped target starts its spawn count over on release', async () => {
    const repo = await startedFlow({ spawns: 1 })
    // every session moves its target, so the cap — not the stall — is what sets it aside
    const agent = script(`echo tick\nWITNESS_DRIVE= exec ${witnessCli()} retry a-plan-1`)
    const out: string[] = []
    const clock = scripted({ 2: async () => { expect((await repo.cli(['retry', 'a-plan-1'])).code).toBe(0) } })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_IDLE_MAX_MS: '30000', WITNESS_DRIVE_AGENT_BIN: agent }, out), {}, clock)
    expect(out.filter((l) => l.startsWith('drive: capped — a-plan-1'))).toHaveLength(2)
    expect(out.some((l) => l.startsWith('drive: taken back — a-plan-1'))).toBe(true)
    expect(ticks(out)).toBe(2)
  }, 60000)

  it('a merge aside leaves when the merge stamp lands', async () => {
    const repo = await startedFlow({ pr: 7 })
    const scenario = fakeScenario()
    ghState(scenario, 7, 'OPEN')
    const agent = script("echo tick\necho 'ship: merge PR #7 on GitHub when ready'")
    const out: string[] = []
    const clock = scripted({
      2: async () => {
        ghState(scenario, 7, 'MERGED')
        await repo.cli(['next'], { env: gateEnv(scenario) })            // the chat's lazy stamp
      },
    })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_IDLE_MAX_MS: '30000', WITNESS_DRIVE_AGENT_BIN: agent }, out), {}, clock)
    expect(out).toContain('drive: merge — ship: merge PR #7 on GitHub when ready')
    expect(out).toContain('drive: released — a-plan-1 · done')
    expect(ticks(out)).toBe(1)
    expect(out.some((l) => /^drive: done — \d+ merged · 0 wait on you/.test(l))).toBe(true)
  }, 60000)
})

// Final review (a) I3. An aside set when a lane ends keyed on the line the lane STARTED with: a
// session that moved its target before it timed out read as a key move at once, so drive released
// it with no human act and wiped its caps.
describe('a lane-end aside keys on the state after the session (final review)', () => {
  it('a session that moves its target and then times out stays aside', async () => {
    // a timeout generous enough for the step close to land even under a loaded suite
    const { repo, planId } = await startedThreeStepPlan({ drive: { sessionTimeoutMs: 6000 } }, SCAFFOLDING_FIRST)
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const agent = script(`echo tick\n${witnessCli()} step-close ${planId} --step s1 > /dev/null\nsleep 30`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_IDLE_MAX_MS: '0', WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 3 }, fakeClock(0))
    expect(out.some((l) => l.startsWith('drive: spawn-timeout — '))).toBe(true)
    expect(out.some((l) => l.startsWith(`drive: taken back — ${planId}`))).toBe(false)
    expect(ticks(out)).toBe(1)
  }, 60000)
})

// Final review (b) I3. A human act that lands while a round runs — between its take-back and the
// pause — was never seen: the pause took its signature at its own entry, which already held it.
describe('an act that lands during a round (final review)', () => {
  it('a grant made while drive sets the target aside still resumes it', async () => {
    const repo = await trustBlocked()
    const out: string[] = []
    const ctx = fakeCtx(repo.root, {
      env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), ...NO_TRUST, WITNESS_DRIVE_IDLE_MAX_MS: '60000', WITNESS_DRIVE_AGENT_BIN: script('echo tick') }),
      out: (l) => {
        out.push(l)
        if (l === 'drive: waits on you — ingest-plan-1 · trust grant') grantCommands(repo.root, ['pnpm test'])
      },
    })
    await driveLoop(repo.root, cfgOf(repo), ctx, { maxSpawns: 1 }, fakeClock(0))
    expect(out.some((l) => l.startsWith('drive: taken back — ingest-plan-1'))).toBe(true)
    expect(out.some((l) => /\] tick$/.test(l))).toBe(true)
  }, 60000)
})

// Final review (b) M7. An item notified once is not notified again in a run (n5) — but a target
// released by the human's act and set aside anew is a new item: a second trust grant, a target
// stuck again after a retry.
describe('a release makes the next item on that target news (final review)', () => {
  it('a target stuck again after a retry is notified again', async () => {
    const repo = await startedFlow()
    const log = join(fakeScenario(), 'notified')
    writeLocalConfig(repo.root, { notify: script(`echo "$1" >> "${log}"`, 'notifier') })
    const out: string[] = []
    const clock = scripted({ 2: async () => { expect((await repo.cli(['retry', 'a-plan-1'])).code).toBe(0) } })
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_IDLE_MAX_MS: '30000', WITNESS_DRIVE_AGENT_BIN: script('echo tick') }, out), {}, clock)
    expect(ticks(out)).toBe(2)
    await expect.poll(() => readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('stuck · a-plan-1')).length, { timeout: 5000 }).toBe(2)
  }, 60000)
})

// Wait (at most 10 s) for the test to see a line; exit 3 if it never does.
const awaitFlag = (flag: string): string =>
  `i=0; while [ ! -f "${flag}" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; [ -f "${flag}" ] || exit 3`
// An approved spec with one plan, `p`, written for it in the repo's effort.
async function flowRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'p', { parent: 'auth-refresh' })
  return repo
}

describe("drive prints a session's journaled acts (row 214)", () => {
  // The fake waits on its act's line, so a drive that read the journal only at session end
  // deadlocks it into exit 3.
  it('a step close shows while the session still runs (issue #64)', async () => {
    const { repo, planId } = await startedThreeStepPlan({}, SCAFFOLDING_FIRST)
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const flag = join(fakeScenario(), 'seen')
    const agent = script(`${witnessCli()} step-close ${planId} --step s1 > /dev/null\n${awaitFlag(flag)}`)
    const seen = new RegExp(`^\\[1 \\w+/${planId}\\] journal: step-close step=s1$`)
    const out: string[] = []
    const ctx = fakeCtx(repo.root, {
      env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), WITNESS_DRIVE_IDLE_MAX_MS: '0', WITNESS_DRIVE_AGENT_BIN: agent }),
      out: (l) => { out.push(l); if (seen.test(l)) writeFileSync(flag, '') },
    })
    await driveLoop(repo.root, cfgOf(repo), ctx, { maxSpawns: 1 }, fakeClock(0))
    expect(out.find((l) => /^\[1 [^\]]*\] ended /.test(l))).toContain(' · exit 0 · ')
  }, 60000)

  // Review Focus 5: a line read mid-append fails to parse; it is read again once it is whole.
  it('an append in flight is read once it completes (issue #64)', async () => {
    const repo = await flowRepo()
    const poll = journalWatch(repo.root, 'p')
    const line = entryLine({ t: 'step-close', step: 's9' })
    const stream = join(repo.root, journalRel('p'))
    appendFileSync(stream, line.slice(0, 10))
    expect(poll()).toEqual([])
    appendFileSync(stream, `${line.slice(10)}\n`)
    expect(poll()).toEqual(['journal: step-close step=s9'])
    expect(poll()).toEqual([])
  }, 30000)

  it('bookkeeping prints nothing (issue #64)', async () => {
    const repo = await flowRepo()
    const poll = journalWatch(repo.root, 'p')
    appendFileSync(join(repo.root, journalRel('p')), `${entryLine({ t: 'dispatch', plan: 'p' })}\n`)
    expect(poll()).toEqual([])
  }, 30000)

  // D9: the flow is re-derived when the effort's stream moves, so a plan a spec's session writes
  // joins it, from its first entry.
  it('a plan written and gated mid-session joins the flow (issue #64)', async () => {
    const repo = await flowRepo()
    const poll = journalWatch(repo.root, 'auth-refresh')
    expect((await writePlan(repo, 'p2', { parent: 'auth-refresh' })).code).toBe(0)
    expect(poll()).toContainEqual(expect.stringMatching(/^journal: write artifact=p2 /))
    appendEntry(repo.root, 'p2', { t: 'gate-run', gate: 'plan', round: 1, outcome: 'passed', reviewed_sha: 'abc1234', verdicts: [] })
    expect(poll()).toContainEqual(expect.stringMatching(/^journal: gate-run gate plan r1 passed/))
  }, 30000)

  // Final review I2. A fix routes to the spec it amends, so a later effort writes the spec again and
  // plans it: the watch reads every effort that wrote a flow member, not only the first one.
  it('a spec a later effort amended is watched through that effort (issue #64)', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'], slug: 'zz-fix' })
    expect((await writeSpec(repo, 'auth-refresh', {}, '## Motivation\nTokens leak.\n\n## Behavior\nRotate before expiry, amended.\n', 'zz-fix')).code).toBe(0)
    approve(repo, 'auth-refresh')
    const poll = journalWatch(repo.root, 'auth-refresh')
    expect((await writePlan(repo, 'p2', { parent: 'auth-refresh' }, undefined, 'zz-fix')).code).toBe(0)
    expect(poll()).toContainEqual(expect.stringMatching(/^journal: write artifact=p2 /))
    appendEntry(repo.root, 'p2', { t: 'gate-run', gate: 'plan', round: 1, outcome: 'passed', reviewed_sha: 'abc1234', verdicts: [] })
    expect(poll()).toContainEqual(expect.stringMatching(/^journal: gate-run gate plan r1 passed/))
  }, 30000)

  // The same, when the amendment lands while the session runs: the effort joins once a watched
  // stream moves (here a bookkeeping line on the spec's own stream, which prints nothing).
  it('an effort that amends the spec mid-session joins the watch once the spec moves (issue #64)', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'], slug: 'zz-fix' })
    const poll = journalWatch(repo.root, 'auth-refresh')
    expect((await writeSpec(repo, 'auth-refresh', {}, '## Motivation\nTokens leak.\n\n## Behavior\nRotate before expiry, amended.\n', 'zz-fix')).code).toBe(0)
    approve(repo, 'auth-refresh')
    appendEntry(repo.root, 'auth-refresh', { t: 'drift-check', artifact: 'auth-refresh' })
    expect(poll()).toEqual([])
    repo.git('add', '-A')
    repo.git('commit', '-qm', 'drift check')
    expect((await writePlan(repo, 'p2', { parent: 'auth-refresh' }, undefined, 'zz-fix')).code).toBe(0)
    expect(poll()).toContainEqual(expect.stringMatching(/^journal: write artifact=p2 /))
  }, 30000)

  // P13: an entry carries the hash of the session that wrote it (row 191 §4.8).
  it('an entry from another session says so (issue #64)', async () => {
    const repo = await flowRepo()
    const poll = journalWatch(repo.root, 'p')
    withJournalCtx({ session: sessionHash('S-1') }, () => appendEntry(repo.root, 'p', { t: 'step-close', step: 's1' }))
    withJournalCtx({ session: sessionHash('S-2') }, () => appendEntry(repo.root, 'p', { t: 'step-close', step: 's2' }))
    expect(poll('S-1')).toEqual(['journal: step-close step=s1', 'journal: step-close step=s2 · not this session'])
  }, 30000)

  // P17: `entryDetail` throws on a hand-edited gate-run with no reviewed_sha.
  it('a hand-edited entry is skipped, not thrown (issue #64)', async () => {
    const repo = await flowRepo()
    const poll = journalWatch(repo.root, 'p')
    const stream = join(repo.root, journalRel('p'))
    appendFileSync(stream, '{"v":1,"t":"gate-run","gate":"plan"}\n')
    appendFileSync(stream, `${entryLine({ t: 'step-close', step: 's3' })}\n`)
    expect(poll()).toEqual(['journal: step-close step=s3'])
  }, 30000)

  it('a stream that shrank starts over (issue #64)', async () => {
    const repo = await flowRepo()
    const stream = join(repo.root, journalRel('p'))
    appendEntry(repo.root, 'p', { t: 'step-close', step: 's1' })
    appendEntry(repo.root, 'p', { t: 'step-close', step: 's2' })
    const poll = journalWatch(repo.root, 'p')
    writeFileSync(stream, `${readFileSync(stream, 'utf8').split('\n')[0]}\n`)
    expect(poll()).toEqual([])
    appendEntry(repo.root, 'p', { t: 'step-close', step: 's9' })
    expect(poll()).toEqual(['journal: step-close step=s9'])
  }, 30000)
})
