import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { DEADLINE_DIR, writeDeadline } from '../src/deadline.js'
import { driveLoop } from '../src/drive.js'
import { startJob } from '../src/drive-jobs.js'
import { JOB_STREAM, jobReading, journalShard, type JobShardEntry } from '../src/jobs.js'
import { appendEntry, readStream } from '../src/journal.js'
import { grantCommands } from '../src/allowlist.js'
import { TURN_DIR, runnerLockPath } from '../src/runner-lock.js'
import { SCRATCH_LOCK } from '../src/scratch-lock.js'
import { loadCanon } from '../src/scan.js'
import type { Ticker } from '../src/session-clock.js'
import {
  approve, autonomyOn, fakeCtx, fakeLint, fakeScenario, fixtureEnv, noopOpener, patchConfig, seededRepo, writeLocalConfig,
  writePlan, writeSpec, type TestRepo,
} from './helpers.js'
import { baseLintKey } from '../src/base-lint.js'
import { acquireDriveLock } from '../src/drive-presence.js'

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
// An orphan living `s` seconds: its shell exits at once, so it is never this process's zombie (row 213).
const orphan = (s: number): number => Number(spawnSync('sh', ['-c', `sleep ${s} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout.trim())
const lockAt = (root: string, l: { pid: number; since: number; until: number }) => {
  mkdirSync(join(root, '.witness', 'live', 'scratch'), { recursive: true })
  writeFileSync(join(root, SCRATCH_LOCK), JSON.stringify(l))
}
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
    // Two CLI start-ups count against the limit (the job child's, then the agent's turn): 20 s leaves a slow
    // runner room, and the 30 s job still outlasts it, so the session lives only because it was held.
    patchConfig(repo, { drive: { sessionTimeoutMs: 20_000 } })
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'a short session')
    const through = join(fakeScenario(), 'through')
    const agent = script([
      `for i in $(seq 1 200); do grep -q '"job"' "${runnerLockPath(repo.root)}" 2>/dev/null && break; sleep 0.1; done`,
      `$WITNESS_BIN turn -- true && touch "${through}"`,
    ].join('\n'))
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo.root), autoCtx(repo, {
      WITNESS_BIN: witnessCli(), WITNESS_DRIVE_AGENT_BIN: agent,
      WITNESS_FIXTURE_JOB: fixture({ turn: true, boxMs: 120_000, cmd: 'sleep 30' }),
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

  it('a refused journal write turns jobs off for the run, said once; a taken stream never costs a box (slice 3 review I1)', async () => {
    // The shard's own command writes a foreign first entry, so drive's journal write is refused.
    const foreign = `printf '{"v":1,"t":"retry","artifact":"x"}\\n' >> .witness/journal/${JOB_STREAM}.jsonl`
    const { repo, out, run } = await jobsOnly(fixture({ shards: 2, cmd: `mkdir -p .witness/journal && ${foreign}` }))
    await run()
    expect(out.filter((l) => l.endsWith(' — started'))).toEqual(['job: fixture k1 1/2 — started'])
    expect(out.filter((l) => l.startsWith('drive: jobs off for this run — '))).toHaveLength(1)
    expect(out.some((l) => l.startsWith('jobs: off for this run — '))).toBe(true)
    // A second drive meets the taken stream before it spawns anything.
    const again: string[] = []
    const env = fixtureEnv({ WITNESS_BIN: witnessCli(), WITNESS_KEEP_AWAKE_BIN: noopOpener(), WITNESS_FIXTURE_JOB: fixture({ shards: 2, cmd: 'true' }) })
    await driveLoop(repo.root, cfgOf(repo.root), fakeCtx(repo.root, { tty: true, env, out: (l) => again.push(l) }), {})
    expect(again.filter((l) => l.endsWith(' — started'))).toEqual([])
    expect(again.filter((l) => l.startsWith('drive: jobs off for this run — '))).toHaveLength(1)
  }, 90_000)

  it('a job queued behind a turn holder that is not drive\'s never keeps the run: it is stopped and journals nothing (slice 3 review I2)', async () => {
    const holder = Number(spawnSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim())
    const { repo, out, run } = await jobsOnly(fixture({ turn: true, boxMs: 1_000, cmd: 'true' }))
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    writeFileSync(runnerLockPath(repo.root), JSON.stringify({ pid: holder }))
    const t0 = Date.now()
    try {
      await run()
    } finally {
      try { process.kill(holder) } catch { /* gone */ }
    }
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(out).toContain('job: fixture k1 1/1 — stopped')
    expect(shards(repo.root)).toEqual([])
  }, 60_000)

  it('a repo with no job kind never says jobs are off, even when its jobs stream is taken (final review F4)', async () => {
    const repo = await seededRepo({ noRecap: true })
    appendEntry(repo.root, JOB_STREAM, { t: 'retry', artifact: 'x' })
    const out: string[] = []
    const env = fixtureEnv({ WITNESS_BIN: witnessCli(), WITNESS_KEEP_AWAKE_BIN: noopOpener() })
    await driveLoop(repo.root, cfgOf(repo.root), fakeCtx(repo.root, { tty: true, env, out: (l) => out.push(l) }), {})
    expect(out.filter((l) => l.includes('jobs off'))).toEqual([])
  }, 60_000)

  it('no shard starts while a crashed transaction waits, and jobs stay on for the run (final review F3)', async () => {
    const { repo, out, run } = await jobsOnly(fixture({ cmd: 'true' }), { WITNESS_DRIVE_AGENT_BIN: script('true') })
    writeFileSync(join(repo.root, '.witness', 'txn.json'), JSON.stringify({ op: 'x', files: [], pid: deadPid() }))
    await run()
    expect(out.filter((l) => l.endsWith(' — started') && l.startsWith('job: '))).toEqual([])
    expect(out.filter((l) => l.includes('jobs off'))).toEqual([])
  }, 60_000)

  it('a superseded drive stops its job and journals nothing (final review F2)', async () => {
    const began = join(fakeScenario(), 'began')
    const { repo, out, run } = await jobsOnly(fixture({ boxMs: 60_000, cmd: `touch "${began}" && sleep 20` }))
    const done = run()
    for (let i = 0; i < 600 && !existsSync(began); i++) await new Promise((r) => setTimeout(r, 50))
    // A newer CLI journals and commits: the floor moves past this one while the shard runs.
    appendFileSync(join(repo.root, '.witness', 'journal', 'newer.jsonl'), `${JSON.stringify({ v: 1, w: '99.0.0', t: 'retry', artifact: 'x' })}\n`)
    repo.git('add', '.witness/journal/newer.jsonl'); repo.git('commit', '-m', 'a newer CLI journals')
    const t0 = Date.now()
    await done
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(out).toContain('drive: superseded — a newer witness CLI took over')
    expect(out).toContain('job: fixture k1 1/1 — stopped')
    expect(shards(repo.root)).toEqual([])
  }, 60_000)

  it('the human pause is said while jobs still run, and a running job keeps the idle limit off (final review F1)', async () => {
    const repo = await startedFlows(['a'])
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo.root), autoCtx(repo, {
      WITNESS_BIN: witnessCli(), WITNESS_DRIVE_AGENT_BIN: script('true'),
      WITNESS_FIXTURE_JOB: fixture({ shards: 2, cmd: 'sleep 2' }),
    }, out), { maxSpawns: 5 })
    const waiting = out.findIndex((l) => l.startsWith('drive: waiting on you'))
    const second = out.indexOf('job: fixture k1 2/2 — started')
    expect(waiting).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(waiting)
    expect(shards(repo.root).map((x) => x.outcome)).toEqual(['done', 'done'])
  }, 90_000)
})

describe('drive runs jobs in the scratch (row 258)', () => {
  it('a scratch job\'s wait for the scratch is never boxed, and its record rides the shard (row 258)', async () => {
    const { repo, run } = await jobsOnly(fixture({ boxMs: 4_000, turn: false, scratch: true }))
    lockAt(repo.root, { pid: orphan(6), since: Date.now(), until: Date.now() + 60_000 })
    await run()
    expect(shards(repo.root).map((x) => x.outcome)).toEqual(['done'])
    // The shard ran at the commit before the one drive journaled it in.
    const ran = repo.git('rev-parse', 'HEAD~1')
    expect(repo.git('log', '-1', '--format=%s')).toMatch(/^job\(fixture\): k1 1\/1 done/)
    expect(shards(repo.root)[0]!.result).toEqual({ exit: 0, tree: repo.git('rev-parse', `${ran}^{tree}`), commit: ran })
  }, 90_000)
})

describe('job trust in drive (row 260)', () => {
  it('a job whose setup command is untrusted waits for the human\'s grant and strikes nothing (row 260)', async () => {
    const { repo, out, run } = await jobsOnly(fixture({ turn: false, scratch: true }), { WITNESS_TRUST_CMDS: '0' })
    patchConfig(repo, { scratch: { prepare: 'true' } })
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'prepare')
    await run()
    expect(out).toContain('drive: jobs wait for a trust grant — true (scratch.prepare)')
    expect(out.some((l) => /wait: trust grant · jobs · true \(scratch\.prepare\)/.test(l))).toBe(true)
    expect(out.some((l) => /run: witness trust --cmd true$/.test(l))).toBe(true)
    expect(out.some((l) => l.startsWith('job: fixture'))).toBe(false)
    expect(shards(repo.root)).toEqual([])
    expect((await repo.cli(['trust', '--cmd', 'true'])).code).toBe(0)
    out.length = 0
    await run()
    expect(shards(repo.root).map((x) => x.outcome)).toEqual(['done'])
  }, 120_000)
})

describe('job trust in drive — slice 3 review (row 260)', () => {
  it('a blocked kind that owes no shard raises no jobs wait (I2)', async () => {
    const { repo, out, run } = await jobsOnly(fixture({ turn: false, scratch: true }), { WITNESS_TRUST_CMDS: '0' })
    patchConfig(repo, { scratch: { prepare: 'true' } })
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'prepare')
    expect(journalShard(repo.root, { kind: 'fixture', key: 'k1', shard: 1, of: 1, outcome: 'done', ms: 1 }).ok).toBe(true)
    await run()
    expect(out.join('\n')).not.toContain('jobs wait for a trust grant')
    expect(out.some((l) => /wait: trust grant · jobs/.test(l))).toBe(false)
  }, 120_000)
})

describe('job trust — final review (row 260)', () => {
  it('a kind\'s own command is granted by the line its wait offers (I1)', async () => {
    const job = fixture({ turn: false, commands: ['echo lint'] })
    const { repo, out, run } = await jobsOnly(job, { WITNESS_TRUST_CMDS: '0' })
    await run()
    expect(out).toContain('drive: jobs wait for a trust grant — echo lint (job: fixture)')
    expect(out.some((l) => /run: witness trust --cmd 'echo lint'$/.test(l))).toBe(true)
    expect(shards(repo.root)).toEqual([])
    const granted = await repo.cli(['trust', '--cmd', 'echo lint'], { env: { WITNESS_FIXTURE_JOB: job } })
    expect(granted.code, granted.stderr).toBe(0)
    out.length = 0
    await run()
    expect(shards(repo.root).map((x) => x.outcome)).toEqual(['done'])
  }, 120_000)
})

describe('the base lint in drive (row 263)', () => {
  it('drive runs the base lint a gate left pending, with the config as it stands at the job (row 263)', async () => {
    const repo = await startedFlows(['a'])
    const stale = cfgOf(repo.root)
    const cmd = fakeLint(repo)
    patchConfig(repo, { ship: { lint: { biome: cmd.check } }, readers: { biome: cmd.sarif } })
    repo.write('src/old.ts', 'BAD\n')
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'a lint part and its reader')
    const fresh = cfgOf(repo.root)
    const key = baseLintKey(fresh.ship.lint![0]!, cmd.sarif, repo.git('rev-parse', 'HEAD'))
    // a whole ship round, as tests/drive-busy.test.ts writes one: settle reads its fields
    appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'gate-run', gate: 'ship', artifact: 'a-plan-1', round: 1, run_id: 'rs1',
      reviewed_sha: 's1', prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', outcome: 'stopped',
      checks: [{ name: 'lint', ok: false, parts: [{ part: 'biome', state: 'pending', key }] }] })
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'the ship round')   // a journal entry is committed state
    grantCommands(repo.root, [cmd.check, cmd.sarif])
    const out: string[] = []
    await driveLoop(repo.root, stale, autoCtx(repo, { WITNESS_BIN: witnessCli(), WITNESS_DRIVE_AGENT_BIN: script('true'), WITNESS_TRUST_CMDS: '0' }, out), { maxSpawns: 1 })
    expect(shards(repo.root).filter((s) => s.kind === 'base-lint')).toEqual([expect.objectContaining({ key, outcome: 'done', result: expect.objectContaining({ exit: 1 }) })])
    expect(out.some((l) => l.startsWith('drive: jobs wait for a trust grant'))).toBe(false)
  }, 180_000)
})

describe('the base lint in drive — slice 3 review (row 263)', () => {
  it('drive starts no base-lint shard while the config file cannot be read, so none is struck (I3)', async () => {
    const repo = await startedFlows(['a'])
    const cmd = fakeLint(repo)
    // autonomy off: drive's own re-read of it (F9) never stops the run on the unreadable file
    patchConfig(repo, { autonomy: 'off', ship: { lint: { biome: cmd.check } }, readers: { biome: cmd.sarif } })
    repo.write('src/old.ts', 'BAD\n')
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'a lint part and its reader')
    const cfg = cfgOf(repo.root)
    const key = baseLintKey(cfg.ship.lint![0]!, cmd.sarif, repo.git('rev-parse', 'HEAD'))
    appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'gate-run', gate: 'ship', artifact: 'a-plan-1', round: 1, run_id: 'rs1',
      reviewed_sha: 's1', prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', outcome: 'stopped',
      checks: [{ name: 'lint', ok: false, parts: [{ part: 'biome', state: 'pending', key }] }] })
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'the ship round')
    grantCommands(repo.root, [cmd.check, cmd.sarif])
    // mid-edit: the file on disk does not load (its first line unparseable YAML)
    repo.write('witness.config.yaml', `ship: [\n${repo.read('witness.config.yaml')}`)
    const out: string[] = []
    await driveLoop(repo.root, cfg, autoCtx(repo, { WITNESS_BIN: witnessCli(), WITNESS_DRIVE_AGENT_BIN: script('true'), WITNESS_TRUST_CMDS: '0' }, out), { maxSpawns: 1 })
    expect(shards(repo.root).filter((s) => s.kind === 'base-lint')).toEqual([])
  }, 180_000)
})

// Row 267. A stop red only for drive's base lint: as 'drive runs the base lint a gate left pending', the
// ship round a checks-only one.
async function waitingStop(opts: { jobsOff?: boolean } = {}) {
  const repo = await startedFlows(['a'])
  const stale = cfgOf(repo.root)
  const cmd = fakeLint(repo)
  patchConfig(repo, { ship: { lint: { biome: cmd.check } }, readers: { biome: cmd.sarif } })
  repo.write('src/old.ts', 'BAD\n')
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'a lint part and its reader')
  const key = baseLintKey(cfgOf(repo.root).ship.lint![0]!, cmd.sarif, repo.git('rev-parse', 'HEAD'))
  appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'gate-run', gate: 'ship', artifact: 'a-plan-1', round: 1, run_id: 'rs1',
    reviewed_sha: 's1', prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', outcome: 'stopped', checks_only: true,
    checks: [{ name: 'lint', ok: false, parts: [{ part: 'biome', state: 'pending', key }] }] })
  // slice 3 review I1's foreign first entry: drive's first job write is refused, so jobs turn off
  if (opts.jobsOff === true) appendEntry(repo.root, JOB_STREAM, { t: 'retry', artifact: 'x' })
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'the ship round')
  grantCommands(repo.root, [cmd.check, cmd.sarif])
  const out: string[] = []
  // the drive verb's lock, which `driveLoop` itself does not take: with no drive holding the repo no
  // part reads pending (`jobReading`)
  const held = acquireDriveLock(repo.root, {})
  try {
    await driveLoop(repo.root, stale, autoCtx(repo, { WITNESS_BIN: witnessCli(), WITNESS_DRIVE_AGENT_BIN: script('true'), WITNESS_TRUST_CMDS: '0' }, out), { maxSpawns: 1 })
  } finally {
    if (held.ok) held.value()
  }
  return { repo, key, out }
}

describe('a stop waiting on drive\'s base lint (row 267)', () => {
  it('drive leaves a stop waiting on its base lint, runs the lint, then routes the re-gate (row 267)', async () => {
    const { repo, key, out } = await waitingStop()
    expect(shards(repo.root).filter((s) => s.kind === 'base-lint')).toEqual([expect.objectContaining({ key, outcome: 'done' })])
    expect(readStream(repo.root, 'a-plan-1').filter((e) => e.t === 'human-decision' && (e as unknown as { gate: string }).gate === 'ship')).toEqual([])
    const waited = out.findIndex((l) => l === 'drive: waiting — a-plan-1 · drive lints the base of biome first')
    const routed = out.findIndex((l) => l.includes('re-run owed — witness gate ship a-plan-1'))
    expect(waited).toBeGreaterThanOrEqual(0)
    expect(routed).toBeGreaterThan(waited)
    expect(out.filter((l) => l.startsWith('drive: waiting — '))).toHaveLength(1)
  }, 180_000)

  it('with jobs off, a stop waiting on its base lint is set aside for the human with the reason (Review Focus 2)', async () => {
    const { out } = await waitingStop({ jobsOff: true })
    expect(out.some((l) => l.startsWith('drive: waits on you — a-plan-1 · decision · drive lints the base of biome first, but jobs are off for this run'))).toBe(true)
  }, 180_000)
})
