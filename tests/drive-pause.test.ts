import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grantCommands } from '../src/allowlist.js'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { driveLoop, PAUSE_IDLE_MAX_MS, PAUSE_POLL_MS, watchSignature } from '../src/drive.js'
import { readLive, writeLive } from '../src/live.js'
import { loadCanon } from '../src/scan.js'
import {
  type TestRepo, approve, autonomyOn, fakeClock, fakeCtx, fakeScenario, fixtureEnv, gateEnv, ghState, noopOpener, patchConfig, seededRepo,
  writeLocalConfig, writePlan, writeSpec,
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
