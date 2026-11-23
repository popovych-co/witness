import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { DEADLINE_DIR, writeDeadline } from '../src/deadline.js'
import { driveLoop } from '../src/drive.js'
import { startJob } from '../src/drive-jobs.js'
import { JOB_STREAM, jobReading, type JobShardEntry } from '../src/jobs.js'
import { readStream } from '../src/journal.js'
import { TURN_DIR, runnerLockPath } from '../src/runner-lock.js'
import { loadCanon } from '../src/scan.js'
import type { Ticker } from '../src/session-clock.js'
import {
  approve, autonomyOn, fakeCtx, fakeScenario, fixtureEnv, noopOpener, patchConfig, seededRepo, writeLocalConfig,
  writePlan, writeSpec, type TestRepo,
} from './helpers.js'

// Row 257 (spec §3.5). Drive runs jobs one shard at a time beside its sessions, boxes each from the
// child's own "running" line, and journals what the shard ended on.

// tests/drive-busy.test.ts's started flows under autonomy, its context and its scripted agent.
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
// tests/drive.test.ts's CLI as a command a /bin/sh fake can exec.
function witnessCli(): string {
  const repo = resolve(import.meta.dirname, '..')
  return `${join(repo, 'node_modules', '.bin', 'tsx')} ${join(repo, 'src', 'bin.ts')}`
}


const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!
const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }
const fixture = (o: Record<string, unknown>) =>
  JSON.stringify({ key: 'k1', shards: 1, turn: false, gated: true, boxMs: 30_000, cmd: 'true', ...o })
const shards = (root: string) => readStream(root, JOB_STREAM) as unknown as JobShardEntry[]
// A drive with nothing for a session to do, and jobs: the brainstorm is set aside, the jobs run.
const jobsOnly = async (job: string, extra: Record<string, string> = {}, signal?: AbortSignal) => {
  const repo = await seededRepo({ noRecap: true })
  const out: string[] = []
  const env = fixtureEnv({ WITNESS_BIN: witnessCli(), WITNESS_KEEP_AWAKE_BIN: noopOpener(), WITNESS_FIXTURE_JOB: job, ...extra })
  return { repo, out, run: () => driveLoop(repo.root, cfgOf(repo.root), fakeCtx(repo.root, { tty: true, env, out: (l) => out.push(l) }), signal ? { signal } : {}) }
}

describe('drive runs jobs (row 257)', () => {
  it('a shard that times out twice reads not measured and never runs a third time; the start sweeps what a dead drive left', async () => {
    const { repo, out, run } = await jobsOnly(fixture({ boxMs: 1_500, cmd: 'sleep 30' }))
    const dead = deadPid()
    mkdirSync(join(repo.root, TURN_DIR), { recursive: true })
    writeFileSync(join(repo.root, TURN_DIR, `1-${dead}.json`), JSON.stringify({ pid: dead, since: 1, until: Date.now() + 50_000 }))
    writeDeadline(repo.root, `${dead}-1`, 1)
    await run()
    expect(shards(repo.root).map((x) => [x.shard, x.outcome])).toEqual([[1, 'timeout'], [1, 'timeout']])
    expect(out.filter((l) => l === 'job: fixture k1 1/1 — started')).toHaveLength(2)
    expect(jobReading(repo.root, { kind: 'fixture', key: 'k1', shards: 1 })).toMatchObject({ state: 'not-measured' })
    expect(out.some((l) => /^jobs: fixture \S+ — 2 shard\(s\) · 2 timed out$/.test(l))).toBe(true)
    expect(existsSync(join(repo.root, TURN_DIR)) ? readdirSync(join(repo.root, TURN_DIR)) : []).toEqual([])
    expect(readdirSync(join(repo.root, DEADLINE_DIR)).filter((n) => n.endsWith('.json'))).toEqual([])
  }, 90_000)

  it('a stuck session beside a running job is set aside after one spawn (§3.5 acceptance)', async () => {
    const repo = await startedFlows(['a'])
    const log = join(fakeScenario(), 'spawned')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo.root), autoCtx(repo, {
      WITNESS_BIN: witnessCli(), WITNESS_DRIVE_AGENT_BIN: script(`echo "$WITNESS_DRIVE" >> "${log}"`),
      WITNESS_FIXTURE_JOB: fixture({ shards: 2, cmd: 'sleep 2' }),
    }, out), { maxSpawns: 5 })
    expect(readFileSync(log, 'utf8')).toBe('a-plan-1\n')
    expect(out.some((l) => l.startsWith('drive: no progress — '))).toBe(true)
    expect(shards(repo.root).map((x) => x.outcome)).toEqual(['done', 'done'])
  }, 90_000)

  it("a session waiting behind a job is not stopped by its own deadline (§3.5 acceptance, row 256)", async () => {
    const repo = await startedFlows(['a'])
    patchConfig(repo, { drive: { sessionTimeoutMs: 10_000 } })
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'a short session')
    const through = join(fakeScenario(), 'through')
    const agent = script([
      `for i in $(seq 1 200); do grep -q '"job"' "${runnerLockPath(repo.root)}" 2>/dev/null && break; sleep 0.1; done`,
      `$WITNESS_BIN turn -- true && touch "${through}"`,
    ].join('\n'))
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo.root), autoCtx(repo, {
      WITNESS_BIN: witnessCli(), WITNESS_DRIVE_AGENT_BIN: agent,
      WITNESS_FIXTURE_JOB: fixture({ turn: true, boxMs: 120_000, cmd: 'sleep 20' }),
    }, out), { maxSpawns: 1 })
    expect(existsSync(through)).toBe(true)
    expect(out.some((l) => /\] ended .* · timed out · /.test(l))).toBe(false)
    expect(out.some((l) => /\] waited \S+ behind job fixture — not counted against drive\.sessionTimeoutMs$/.test(l))).toBe(true)
  }, 120_000)

  it('a child that dies without a result is a failed strike (Review Focus 5)', async () => {
    const { repo, run } = await jobsOnly(fixture({}), { WITNESS_CRASH_AFTER: 'job-result' })
    await run()
    expect(shards(repo.root).map((x) => [x.outcome, x.why])).toEqual([
      ['failed', 'exit 9 without a result'], ['failed', 'exit 9 without a result'],
    ])
  }, 90_000)

  it('a drive stopped mid-job stops the job and journals nothing (Review Focus 5)', async () => {
    const stop = new AbortController()
    const { repo, out, run } = await jobsOnly(fixture({ cmd: 'sleep 30' }), {}, stop.signal)
    const done = run()
    for (let i = 0; i < 400 && !out.includes('job: fixture k1 1/1 — started'); i++) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 3_000))
    stop.abort()
    await done
    expect(shards(repo.root)).toEqual([])
    expect(out).toContain('job: fixture k1 1/1 — stopped')
  }, 90_000)

  it('a host sleep inside a box is not box time (Review Focus 1)', async () => {
    const repo = await seededRepo({ noRecap: true })
    const out: string[] = []
    let offset = 0
    let armed = 0
    // The box's first arm is the moment the host "sleeps" an hour: its first check comes an hour late.
    const ticker: Ticker = {
      now: () => performance.now() + offset,
      after: (ms, fn) => { if (armed++ === 0) offset += 3_600_000; const t = setTimeout(fn, ms); return () => clearTimeout(t) },
    }
    const env = fixtureEnv({ WITNESS_BIN: witnessCli(), WITNESS_FIXTURE_JOB: fixture({ boxMs: 4_000, cmd: 'sleep 2' }) })
    const job = startJob(repo.root, cfgOf(repo.root), fakeCtx(repo.root, { env, out: (l) => out.push(l) }), loadCanon(repo.root),
      { signal: new AbortController().signal, ticker })
    await job!.end
    expect(shards(repo.root).map((x) => x.outcome)).toEqual(['done'])
    expect(out.some((l) => /^\[job fixture\] host slept \S+ — not counted against its box$/.test(l))).toBe(true)
  }, 60_000)
})
