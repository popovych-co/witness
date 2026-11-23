import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { driveHolder } from './drive-presence.js'
import { stateCommit } from './gitio.js'
import { appendEntry, entryLine, journalRel, readStream, type Entry } from './journal.js'
import { acquireLock } from './lock.js'
import { refuse, v, type Result } from './refusal.js'
import { execCommand } from './runner.js'
import type { Canon } from './scan.js'
import { logSafe } from './toon.js'
import { pendingTxn, withTxn } from './txn.js'

// Row 257 (spec §3.5, DJ). Jobs are machine work no session does — a base tree's lint, a
// mutation run, an explore — that drive runs beside its sessions. A kind names what it owes as
// units (a key such as `<part>@<tree>`), each cut into time-boxed shards; drive runs one shard at a
// time as a `witness job` child and journals how it ended on witness's own `jobs` stream. A shard
// that timed out or failed twice reads "not measured" and never runs again for that key, so a job
// that cannot finish costs two boxes, never a loop. A shard is bookkeeping (row 206): machine work,
// never a flow's motion. Gates read results through `jobReading`, which says "not measured" when a
// result is missing and no drive runs jobs — nothing reads green by absence.
//
// Production registers no kind until T2c's base lint; the test-only fixture exists only under
// WITNESS_FIXTURE_JOB.
export const JOB_STREAM = 'jobs'
export const MAX_STRIKES = 2
// A result line rides one pipe write: on macOS a write past 64 KiB followed by `process.exit` was cut
// at 65,536 bytes (probed), so a result is capped well below it. A kind with more keeps it elsewhere
// and journals a reference.
export const RESULT_MAX_BYTES = 49_152
export const JOB_ENV = 'WITNESS_JOB'                  // drive's mark on its job child (`witness job` reads it)
export const FIXTURE_JOB_ENV = 'WITNESS_FIXTURE_JOB'  // test-only: never documented
const MAX_SHARDS = 1_000

export type JobOutcome = 'done' | 'timeout' | 'failed'
export interface JobUnit { kind: string; key: string; shards: number }
export type JobResult = { outcome: 'done'; result?: unknown } | { outcome: 'failed'; why: string }
export interface JobKind {
  kind: string                                        // an id (isId)
  turn: boolean                                       // its shards take the test turn
  gated: boolean                                      // a gate reads its results; false: it yields the turn to plan work
  boxMs(cfg: Config): number                          // each shard's time box, in awake ms
  owed(root: string, cfg: Config, canon: Canon): JobUnit[]
  run(root: string, ctx: Ctx, cfg: Config, unit: JobUnit, shard: number): JobResult   // in the job child
}
export interface JobShardEntry {
  v: 1; t: 'job-shard'; kind: string; key: string; shard: number; of: number
  outcome: JobOutcome; ms: number; result?: unknown; why?: string
}
export type JobState =
  | { state: 'done'; results: unknown[] } | { state: 'missing'; next: number } | { state: 'not-measured'; shard: number; why: string }
export type JobReading = { state: 'done'; results: unknown[] } | { state: 'pending' } | { state: 'not-measured'; why: string }

const KEY_RE = /^[a-z0-9][a-z0-9._@-]{0,199}$/
export const isJobKey = (key: string): boolean => KEY_RE.test(key)
const OUTCOMES: readonly JobOutcome[] = ['done', 'timeout', 'failed']
const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_SHARDS

// A shard entry as witness writes it; a hand-edited line of another shape is no shard.
export function isShardEntry(e: Entry): e is Entry & JobShardEntry {
  return e.t === 'job-shard' && typeof e.kind === 'string' && typeof e.key === 'string' && isCount(e.of) &&
    isCount(e.shard) && (e.shard as number) <= (e.of as number) && OUTCOMES.includes(e.outcome as JobOutcome) &&
    typeof e.ms === 'number' && Number.isFinite(e.ms)
}

const shardsOf = (entries: readonly Entry[], unit: Pick<JobUnit, 'kind' | 'key'>): JobShardEntry[] =>
  entries.filter((e): e is Entry & JobShardEntry => isShardEntry(e) && e.kind === unit.kind && e.key === unit.key)

export function shardEntries(root: string, unit: Pick<JobUnit, 'kind' | 'key'>): JobShardEntry[] {
  return shardsOf(readStream(root, JOB_STREAM), unit)
}

// A unit's state from its shard entries. Only entries of this kind and key cut into this many shards
// count. A shard is done at its first `done`; before that, each timeout or failure is a strike, and
// a shard with MAX_STRIKES strikes reads not measured — the lowest such shard, with its last
// strike's reason. Otherwise the lowest shard not done is the next to run, and when every shard is
// done the results come in shard order, each shard's first.
export function jobState(entries: readonly JobShardEntry[], unit: JobUnit): JobState {
  const mine = entries.filter((e) => e.kind === unit.kind && e.key === unit.key && e.of === unit.shards)
  const done = new Map<number, JobShardEntry>()
  const strikes = new Map<number, JobShardEntry[]>()
  for (const e of mine) {
    if (done.has(e.shard)) continue
    if (e.outcome === 'done') { done.set(e.shard, e); continue }
    strikes.set(e.shard, [...(strikes.get(e.shard) ?? []), e])
  }
  for (let shard = 1; shard <= unit.shards; shard++) {
    const s = strikes.get(shard) ?? []
    if (!done.has(shard) && s.length >= MAX_STRIKES) {
      return { state: 'not-measured', shard, why: s.at(-1)!.why ?? `shard ${shard} ended ${s.at(-1)!.outcome} twice` }
    }
  }
  for (let shard = 1; shard <= unit.shards; shard++) if (!done.has(shard)) return { state: 'missing', next: shard }
  return { state: 'done', results: Array.from({ length: unit.shards }, (_, i) => done.get(i + 1)!.result) }
}

// What a check reads. A missing result is pending while a drive holds the repo — it runs jobs — and
// otherwise not measured (the spec's chat-mode rule, in one place for every check).
export function jobReading(root: string, unit: JobUnit): JobReading {
  const s = jobState(shardEntries(root, unit), unit)
  if (s.state === 'done') return { state: 'done', results: s.results }
  if (s.state === 'not-measured') return { state: 'not-measured', why: s.why }
  return driveHolder(root) !== undefined ? { state: 'pending' } : { state: 'not-measured', why: 'no drive runs jobs in this repo' }
}

// The next shard drive runs: gated kinds before ungated ones, each in `kinds` order; within a kind,
// its units in `owed()` order; the first unit with a shard still to run. The stream is read once. A
// unit with a key outside isJobKey or a shard count outside 1…1000 is skipped, and a kind whose
// `owed` throws owes nothing this time.
export function nextShard(
  root: string, cfg: Config, canon: Canon, kinds: readonly JobKind[],
): { kind: JobKind; unit: JobUnit; shard: number } | undefined {
  const entries = readStream(root, JOB_STREAM)
  for (const kind of [...kinds.filter((k) => k.gated), ...kinds.filter((k) => !k.gated)]) {
    let units: JobUnit[]
    try { units = kind.owed(root, cfg, canon) } catch { continue }
    for (const unit of units) {
      if (unit.kind !== kind.kind || !isJobKey(unit.key) || !isCount(unit.shards)) continue
      const s = jobState(shardsOf(entries, unit), unit)
      if (s.state === 'missing') return { kind, unit, shard: s.next }
    }
  }
  return undefined
}

// Why no shard can be journaled in this repo now, before drive spends a box on one: the `jobs`
// stream holds another history (witness check names it).
export function jobsBlocked(root: string): string | undefined {
  const first = readStream(root, JOB_STREAM)[0]
  // `t` is another writer's text: spelled out before it reaches drive's log or report (logSafe).
  return first !== undefined && first.t !== 'job-shard' ? `the ${JOB_STREAM} stream starts with ${logSafe(String(first.t))} — witness check names it` : undefined
}

const streamTaken = (first: Entry) => v(JOB_STREAM, 'stream-taken', `the stream starts with ${first.t}`,
  'a stream for job results alone — witness check names the artifact that holds it')

// Journals one shard's outcome and commits it under its own subject. Drive calls it in-process: a
// job child stopped at its box dies at once (probe t2a-group-kill), so it never journals itself.
export function journalShard(root: string, entry: Omit<JobShardEntry, 'v' | 't'>): Result<{ sha: string }> {
  const lock = acquireLock(root)
  if (!lock.ok) return lock
  try {
    const pending = pendingTxn(root)
    if (pending) return refuse([v('.witness/txn.json', 'pending-txn', pending.op, 'witness recover --complete | --rollback')])
    // F7's rule for reserved streams: one an older witness wrote under this name is another
    // artifact's history, and shards appended to it would be read as part of that artifact.
    const first = readStream(root, JOB_STREAM)[0]
    if (first !== undefined && first.t !== 'job-shard') return refuse([streamTaken(first)])
    const full = { t: 'job-shard' as const, ...entry }
    const subject = `job(${entry.kind}): ${entry.key} ${entry.shard}/${entry.of} ${entry.outcome}`
    const stream = journalRel(JOB_STREAM)
    return withTxn(root, { op: subject, files: [stream], journalMulti: [{ stream: JOB_STREAM, line: entryLine(full) }] }, () => {
      appendEntry(root, JOB_STREAM, full)
      return stateCommit(root, [stream], subject)
    })
  } finally {
    lock.value()
  }
}

// The test-only fixture (WITNESS_FIXTURE_JOB, JSON `{ key, shards, turn, gated, boxMs, cmd, fail? }`),
// a seam on WITNESS_DRIVE_AGENT_BIN's precedent and never documented: anything malformed registers
// nothing. Its `cmd` is the suite's own, with `{shard}` and `{of}` filled in; it runs without a turn
// of its own — inside the verb's when the kind takes one.
function fixtureKind(raw: string | undefined): JobKind | undefined {
  if (raw === undefined) return undefined
  let o: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    o = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  const { key, shards, turn, gated, boxMs, cmd, fail } = o
  if (typeof key !== 'string' || !isJobKey(key) || !isCount(shards) || typeof turn !== 'boolean' || typeof gated !== 'boolean') return undefined
  if (typeof boxMs !== 'number' || !Number.isInteger(boxMs) || boxMs < 1 || typeof cmd !== 'string') return undefined
  if (fail !== undefined && typeof fail !== 'string') return undefined
  return {
    kind: 'fixture', turn, gated,
    boxMs: () => boxMs,
    owed: () => [{ kind: 'fixture', key, shards }],
    run: (root, ctx, _cfg, unit, shard) => {
      if (fail !== undefined) return { outcome: 'failed', why: fail }
      const filled = cmd.replaceAll('{shard}', String(shard)).replaceAll('{of}', String(unit.shards))
      return { outcome: 'done', result: { exit: execCommand(root, ctx, filled, { turn: false }).exitZero ? 0 : 1 } }
    },
  }
}

// The registered kinds. None in production until T2c.
export function jobKinds(env: Record<string, string | undefined>): JobKind[] {
  const fixture = fixtureKind(env[FIXTURE_JOB_ENV])
  return fixture !== undefined ? [fixture] : []
}
