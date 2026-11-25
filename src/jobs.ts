import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { driveHolder } from './drive-presence.js'
import { stateCommit } from './gitio.js'
import { stateFloor } from './floor.js'
import { appendEntry, entryLine, journalRel, readStream, type Entry } from './journal.js'
import { acquireLock } from './lock.js'
import { refuse, v, type Result } from './refusal.js'
import { configCommands, trustedNow, type RunCommand } from './allowlist.js'
import { tryGit } from './gitio.js'
import { ok, type Result as Res } from './refusal.js'
import { execCommand } from './runner.js'
import { inScratch } from './scratch-checkout.js'
import { baseLintKind } from './base-lint.js'
import { baseTestsKind } from './base-tests.js'
import { lintEffectKind } from './lint-effect.js'
import type { Canon } from './scan.js'
import { logSafe, visible } from './toon.js'
import { JOB_STREAM } from './streams.js'
import { pendingTxn, withTxn } from './txn.js'
import { compareTriple, version } from './version.js'

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
export { JOB_STREAM }
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
  // Row 258. Its shards run in the scratch: the verb takes the scratch lock after the turn and before
  // `running`, so a wait for the scratch is never boxed; reset and prepare run inside the box.
  scratch: boolean
  // Row 260. The repo commands its shards run, checked trusted before a shard starts. A scratch
  // kind's `scratch.prepare` is added by that check, never listed here.
  commands(cfg: Config): RunCommand[]
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
// Row 260: a kind in `skip` (its commands untrusted) owes nothing this round.
export function nextShard(
  root: string, cfg: Config, canon: Canon, kinds: readonly JobKind[], skip?: ReadonlySet<string>,
): { kind: JobKind; unit: JobUnit; shard: number } | undefined {
  const entries = readStream(root, JOB_STREAM)
  for (const kind of [...kinds.filter((k) => k.gated), ...kinds.filter((k) => !k.gated)]) {
    if (skip?.has(kind.kind)) continue
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

// Row 260. The kinds a shard of which must not start now, and the commands that would free them: a
// kind is blocked while any command it runs — its own, and a scratch kind's `scratch.prepare` — is
// not trusted right now, and a scratch kind is blocked with no command while scratch runs are off
// (`check` names that). A blocked kind is skipped, never struck: the human's grant frees it. The
// commands are the untrusted ones, once each, in kind order.
export function jobTrustOwed(
  root: string, env: Record<string, string | undefined>, cfg: Config, kinds: readonly JobKind[],
): { blocked: Set<string>; commands: RunCommand[] } {
  const blocked = new Set<string>()
  const commands: RunCommand[] = []
  for (const kind of kinds) {
    if (kind.scratch && cfg.scratch.prepare === undefined) { blocked.add(kind.kind); continue }
    let own: RunCommand[]
    try { own = kind.commands(cfg) } catch { blocked.add(kind.kind); continue }
    const runs = kind.scratch && cfg.scratch.prepare !== 'none'
      ? [...own, { cmd: cfg.scratch.prepare as string, source: 'scratch.prepare' }] : own
    const untrusted = runs.filter((c) => !trustedNow(root, env, c.cmd))
    if (untrusted.length === 0) continue
    blocked.add(kind.kind)
    for (const c of untrusted) if (!commands.some((o) => o.cmd === c.cmd)) commands.push(c)
  }
  return { blocked, commands }
}

// Row 260 (final review). Every command witness runs headless on the repo's behalf: the config
// commands and each registered kind's own, once each. The targetless grant takes exactly these, so
// a jobs wait's offered grant always works, whatever a kind declares.
export function headlessCommands(cfg: Config, env: Record<string, string | undefined>): RunCommand[] {
  const out = [...configCommands(cfg)]
  for (const kind of jobKinds(env)) {
    let own: RunCommand[]
    try { own = kind.commands(cfg) } catch { continue }
    for (const c of own) if (!out.some((o) => o.cmd === c.cmd)) out.push(c)
  }
  return out
}

// Why no shard can be journaled in this repo now, before drive spends a box on one: the `jobs`
// stream holds another history (witness check names it).
export function jobsBlocked(root: string): string | undefined {
  const first = readStream(root, JOB_STREAM)[0]
  // `t` is another writer's text: spelled out before it reaches drive's log or report (logSafe).
  return first !== undefined && first.t !== 'job-shard' ? `the ${JOB_STREAM} stream starts with ${logSafe(String(first.t))} — witness check names it` : undefined
}

const streamTaken = (first: Entry) => v(JOB_STREAM, 'stream-taken', `the stream starts with ${visible(String(first.t))}`,
  'a stream for job results alone — witness check names the artifact that holds it')

// Journals one shard's outcome and commits it under its own subject. Drive calls it in-process: a
// job child stopped at its box dies at once (probe t2a-group-kill), so it never journals itself.
export function journalShard(root: string, entry: Omit<JobShardEntry, 'v' | 't'>): Result<{ sha: string }> {
  const lock = acquireLock(root)
  if (!lock.ok) return lock
  try {
    const pending = pendingTxn(root)
    if (pending) return refuse([v('.witness/txn.json', 'pending-txn', pending.op, 'witness recover --complete | --rollback')])
    // Drive journals in-process, past the floor dispatch enforces (`cli.ts`): a newer CLI that has
    // journaled owns the state, and this one writes nothing past it (final review F2).
    const floor = stateFloor(root)
    if (floor !== undefined && (compareTriple(floor.pin, version()) ?? 0) > 0) {
      return refuse([v('witness', 'cli-behind-state', `this CLI is ${version()}, this repository's state was written by ${floor.pin}`,
        'nothing — a newer witness CLI runs this repo now, and this drive journals no job past it')])
    }
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

// The test-only fixture (WITNESS_FIXTURE_JOB, JSON `{ key, shards, turn, gated, boxMs, cmd, fail?,
// scratch?, commands? }` — `commands` the repo commands it declares, as `job: fixture`), a seam on WITNESS_DRIVE_AGENT_BIN's precedent and never documented: anything
// malformed registers nothing. Its `cmd` is the suite's own, with `{shard}` and `{of}` filled in; it
// runs without a turn of its own — inside the verb's when the kind takes one. With `scratch` it runs
// in the scratch at the root's HEAD (row 258), and its result names the tree and commit it ran.
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
  const { key, shards, turn, gated, boxMs, cmd, fail, scratch, commands } = o
  if (typeof key !== 'string' || !isJobKey(key) || !isCount(shards) || typeof turn !== 'boolean' || typeof gated !== 'boolean') return undefined
  if (typeof boxMs !== 'number' || !Number.isInteger(boxMs) || boxMs < 1 || typeof cmd !== 'string') return undefined
  if (fail !== undefined && typeof fail !== 'string') return undefined
  if (scratch !== undefined && typeof scratch !== 'boolean') return undefined
  if (commands !== undefined && !(Array.isArray(commands) && commands.every((c) => typeof c === 'string'))) return undefined
  const declared = ((commands ?? []) as string[]).map((c) => ({ cmd: c, source: 'job: fixture' }))
  return {
    kind: 'fixture', turn, gated, scratch: scratch === true,
    boxMs: () => boxMs,
    commands: () => declared,
    owed: () => [{ kind: 'fixture', key, shards }],
    run: (root, ctx, cfg, unit, shard) => {
      if (fail !== undefined) return { outcome: 'failed', why: fail }
      const filled = cmd.replaceAll('{shard}', String(shard)).replaceAll('{of}', String(unit.shards))
      if (scratch !== true) return { outcome: 'done', result: { exit: execCommand(root, ctx, filled, { turn: false }).exitZero ? 0 : 1 } }
      const head = tryGit(root, 'rev-parse', '--verify', 'HEAD')
      const r = inScratch(root, ctx, cfg, { tree: head.ok ? head.out : 'HEAD' }, (dir): Res<{ value: number; load: string[] }> =>
        ok({ value: execCommand(dir, ctx, filled, { turn: false }).exitZero ? 0 : 1, load: [] }))
      if (!r.ok) return { outcome: 'failed', why: `${r.violations[0]!.rule}: ${r.violations[0]!.got}`.slice(0, 200) }
      return { outcome: 'done', result: { exit: r.value.value, tree: r.value.record.tree, commit: r.value.record.commit } }
    },
  }
}

// The registered kinds: the test-only fixture first when its env is set, then base-lint (row 263),
// the first production kind, lint-effect (row 277), then base-tests (row 275).
export function jobKinds(env: Record<string, string | undefined>): JobKind[] {
  const fixture = fixtureKind(env[FIXTURE_JOB_ENV])
  return [...(fixture !== undefined ? [fixture] : []), baseLintKind, lintEffectKind, baseTestsKind]
}
