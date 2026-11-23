import { describe, expect, it } from 'vitest'
import { reservedId } from '../src/ask.js'
import { loadConfig, type Config } from '../src/config.js'
import { acquireDriveLock } from '../src/drive-presence.js'
import {
  JOB_STREAM, jobKinds, jobReading, jobState, jobTrustOwed, jobsBlocked, journalShard, nextShard, type JobKind, type JobShardEntry, type JobUnit,
} from '../src/jobs.js'
import { appendEntry, readStream } from '../src/journal.js'
import { ENTRY_PROGRESS, movesFlow } from '../src/progress.js'
import { loadCanon } from '../src/scan.js'
import { grantCommands } from '../src/allowlist.js'
import { patchConfig, seededRepo, tmpRepo } from './helpers.js'

const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }
const fixture = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ key: 'k1', shards: 1, turn: false, gated: true, boxMs: 1_000, cmd: 'true', ...o })
const unit: JobUnit = { kind: 'fixture', key: 'k1', shards: 2 }
const e = (shard: number, outcome: JobShardEntry['outcome'], extra: Partial<JobShardEntry> = {}): JobShardEntry =>
  ({ v: 1, t: 'job-shard', kind: 'fixture', key: 'k1', shard, of: 2, outcome, ms: 10, ...extra })
const kind = (name: string, gated: boolean, units: JobUnit[]): JobKind =>
  ({ kind: name, turn: false, gated, boxMs: () => 1_000, owed: () => units, run: () => ({ outcome: 'done' }) })
const pick = (n: ReturnType<typeof nextShard>) => n && [n.kind.kind, n.unit.key, n.shard]

describe('job state (row 257)', () => {
  it('a unit is missing until every shard is done, in shard order', () => {
    expect(jobState([], unit)).toEqual({ state: 'missing', next: 1 })
    expect(jobState([e(1, 'done', { result: 'a' })], unit)).toEqual({ state: 'missing', next: 2 })
    expect(jobState([e(2, 'done', { result: 'b' }), e(1, 'done', { result: 'a' })], unit)).toEqual({ state: 'done', results: ['a', 'b'] })
  })

  it('two strikes on a shard read not measured; one strike runs it again', () => {
    expect(jobState([e(1, 'timeout', { why: 'box 1s passed' })], unit)).toEqual({ state: 'missing', next: 1 })
    expect(jobState([e(1, 'timeout', { why: 'box 1s passed' }), e(1, 'failed', { why: 'exit 9 without a result' })], unit))
      .toEqual({ state: 'not-measured', shard: 1, why: 'exit 9 without a result' })
    expect(jobState([e(1, 'timeout', { why: 'x' }), e(1, 'done', { result: 1 }), e(2, 'done', { result: 2 })], unit))
      .toEqual({ state: 'done', results: [1, 2] })
  })

  it("another key's, kind's or shard count's entries are not this unit's", () => {
    expect(jobState([e(1, 'done', { key: 'k2' }), e(1, 'done', { kind: 'other' }), e(1, 'done', { of: 3 })], unit))
      .toEqual({ state: 'missing', next: 1 })
  })
})

describe('the jobs stream (row 257)', () => {
  it('journalShard appends a bookkeeping entry and commits it under its own subject', async () => {
    const repo = await seededRepo()
    expect(journalShard(repo.root, { kind: 'fixture', key: 'k1', shard: 1, of: 2, outcome: 'done', ms: 12, result: { exit: 0 } }).ok).toBe(true)
    const [entry] = readStream(repo.root, JOB_STREAM)
    expect(entry).toMatchObject({ t: 'job-shard', kind: 'fixture', key: 'k1', shard: 1, of: 2, outcome: 'done', ms: 12, result: { exit: 0 } })
    expect(repo.git('log', '-1', '--format=%s')).toBe('job(fixture): k1 1/2 done')
    expect(ENTRY_PROGRESS['job-shard']).toBe('bookkeeping')
    expect(movesFlow(entry!)).toBe(false)
  })

  it("jobs is witness's own: a stream holding another history refuses the write, and check names it", async () => {
    const repo = await seededRepo()
    expect(reservedId('jobs')).toBe("witness's own job results")
    appendEntry(repo.root, JOB_STREAM, { t: 'retry', artifact: 'x' })
    const r = journalShard(repo.root, { kind: 'fixture', key: 'k1', shard: 1, of: 1, outcome: 'done', ms: 1 })
    expect(!r.ok && r.violations[0]!.rule).toBe('stream-taken')
    expect((await repo.cli(['check'])).stdout).toMatch(/reserved-stream-taken/)
  })

  it('a taken stream is named with its foreign kind spelled out, never raw (security review)', async () => {
    const repo = await seededRepo()
    appendEntry(repo.root, JOB_STREAM, { t: 'x\u001b[2Jy' as 'retry' })
    const why = jobsBlocked(repo.root)!
    expect(why).toContain('the jobs stream starts with')
    expect(why).not.toMatch(/\u001b/)
  })

  it('witness log jobs shows each shard', async () => {
    const repo = await seededRepo()
    journalShard(repo.root, { kind: 'fixture', key: 'k1', shard: 1, of: 2, outcome: 'timeout', ms: 1_500, why: 'box 1s passed' })
    expect((await repo.cli(['log', JOB_STREAM])).stdout).toContain('fixture k1 1/2 timeout 2s')
  })
})

describe('job reading and the next shard (row 257)', () => {
  it('missing is pending while a drive holds the repo and not measured without one', async () => {
    const repo = await seededRepo()
    expect(jobReading(repo.root, unit)).toEqual({ state: 'not-measured', why: 'no drive runs jobs in this repo' })
    const held = acquireDriveLock(repo.root, {})
    expect(held.ok).toBe(true)
    expect(jobReading(repo.root, unit)).toEqual({ state: 'pending' })
    journalShard(repo.root, { kind: 'fixture', key: 'k1', shard: 1, of: 2, outcome: 'done', ms: 1, result: 'a' })
    journalShard(repo.root, { kind: 'fixture', key: 'k1', shard: 2, of: 2, outcome: 'done', ms: 1, result: 'b' })
    expect(jobReading(repo.root, unit)).toEqual({ state: 'done', results: ['a', 'b'] })
    if (held.ok) held.value()
  })

  it('nextShard: gated kinds first, the first missing shard, struck-out units skipped', async () => {
    const repo = await seededRepo()
    const [cfg, canon] = [cfgOf(repo.root), loadCanon(repo.root)]
    const idle = kind('idle', false, [{ kind: 'idle', key: 'i1', shards: 1 }])
    const base = kind('base', true, [{ kind: 'base', key: 'b1', shards: 2 }, { kind: 'base', key: 'b2', shards: 1 }])
    const next = () => pick(nextShard(repo.root, cfg, canon, [idle, base]))
    expect(next()).toEqual(['base', 'b1', 1])
    journalShard(repo.root, { kind: 'base', key: 'b1', shard: 1, of: 2, outcome: 'done', ms: 1 })
    expect(next()).toEqual(['base', 'b1', 2])
    journalShard(repo.root, { kind: 'base', key: 'b1', shard: 2, of: 2, outcome: 'timeout', ms: 1, why: 'x' })
    journalShard(repo.root, { kind: 'base', key: 'b1', shard: 2, of: 2, outcome: 'timeout', ms: 1, why: 'x' })
    expect(next()).toEqual(['base', 'b2', 1])
    journalShard(repo.root, { kind: 'base', key: 'b2', shard: 1, of: 1, outcome: 'done', ms: 1 })
    expect(next()).toEqual(['idle', 'i1', 1])
  })

  it('production registers no kind; the test-only fixture registers from its env', () => {
    expect(jobKinds({})).toEqual([])
    const env = { WITNESS_FIXTURE_JOB: JSON.stringify({ key: 'k1', shards: 2, turn: true, gated: false, boxMs: 1_000, cmd: 'true' }) }
    expect(jobKinds(env).map((k) => [k.kind, k.turn, k.gated, k.boxMs({} as Config)])).toEqual([['fixture', true, false, 1_000]])
    expect(jobKinds({ WITNESS_FIXTURE_JOB: '{' })).toEqual([])
    expect(jobKinds({ WITNESS_FIXTURE_JOB: JSON.stringify({ key: 'K!', shards: 2 }) })).toEqual([])
  })
})

describe('jobs in the scratch (row 258)', () => {
  it('a kind says whether it runs in the scratch and which commands it runs (row 258)', async () => {
    const repo = await seededRepo()
    const [kind] = jobKinds({ WITNESS_FIXTURE_JOB: fixture({ scratch: true }) })
    expect(kind).toMatchObject({ kind: 'fixture', scratch: true })
    expect(kind!.commands(cfgOf(repo.root))).toEqual([])
    expect(jobKinds({ WITNESS_FIXTURE_JOB: fixture() })[0]).toMatchObject({ scratch: false })
    expect(jobKinds({ WITNESS_FIXTURE_JOB: fixture({ scratch: 'yes' }) })).toEqual([])
  })
})

describe('job trust (row 260)', () => {
  it('a scratch kind whose setup command is untrusted is blocked, and nextShard skips it (row 260)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { scratch: { prepare: 'sh prepare.sh' } })
    const kinds = jobKinds({ WITNESS_FIXTURE_JOB: fixture({ scratch: true }) })
    const owed = jobTrustOwed(repo.root, {}, cfgOf(repo.root), kinds)
    expect(owed).toEqual({ blocked: new Set(['fixture']), commands: [{ cmd: 'sh prepare.sh', source: 'scratch.prepare' }] })
    expect(nextShard(repo.root, cfgOf(repo.root), loadCanon(repo.root), kinds, owed.blocked)).toBeUndefined()
    grantCommands(repo.root, ['sh prepare.sh'])
    expect(jobTrustOwed(repo.root, {}, cfgOf(repo.root), kinds)).toEqual({ blocked: new Set(), commands: [] })
    expect(jobTrustOwed(repo.root, {}, cfgOf(repo.root), jobKinds({ WITNESS_FIXTURE_JOB: fixture() })).blocked.size).toBe(0)
  })
})
