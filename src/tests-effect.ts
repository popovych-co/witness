import { createHash } from 'node:crypto'
import { BASE_TESTS, baseTestsKey, baseTestsResult, parseBaseTestsKey, specCounts } from './base-tests.js'
import type { Config } from './config.js'
import { baseForSpec } from './history.js'
import { jobReading } from './jobs.js'
import { readStream, streamIds } from './journal.js'
import type { JunitCounts, TestOutcome } from './junit.js'
import { matchesTag } from './matcher.js'
import { runnerConfig, suiteKey, type RunnerConfig } from './runner.js'
import type { Canon, CanonDoc } from './scan.js'
import { codeTree } from './snapshot.js'
import { JOB_STREAM } from './streams.js'

// Row 275. The tests effect (§4 T3): passing tagged cases per spec never drop without a spec amendment.

export type FullSuite = Extract<RunnerConfig, { mode: 'full-suite' }>

export type BaseCounts =
  | { read: 'found'; from: 'ship' | 'job'; code: string; specs: Record<string, JunitCounts> }
  | { read: 'missing'; code: string; key: string }
  | { read: 'unreadable'; why: string }

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

// C29. The base's per-spec counts: any shipped summary whose code tree and suite match the base commit's
// — one code under one suite measures the same thing, so any match serves. Streams in `streamIds` order,
// each read newest first; a scan of every stream costs 31 ms on fewhats' 11 MB journal, so no index.
// Failing that, a done `base-tests` result under today's suite whose code is the base's, newest first:
// one result serves every base commit of its code. A ship line serves only on the stream it names, with
// well-formed counts (security review): the journal is witness's own state, read as the gates read it.
export function baseCounts(root: string, rc: FullSuite, base: string): BaseCounts {
  const code = codeTree(root, base)
  if (code === undefined) return { read: 'unreadable', why: "the base's code tree could not be read" }
  const suite = suiteKey(rc)
  for (const id of streamIds(root)) {
    if (id === JOB_STREAM) continue
    const entries = readStream(root, id)
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as Obj
      if (e.t !== 'gate-run' || e.gate !== 'ship' || e.artifact !== id || !isObj(e.junit)) continue
      if (e.junit.code !== code || e.junit.suite !== suite) continue
      const specs = specCounts(e.junit.specs, Number.MAX_SAFE_INTEGER)
      if (specs !== undefined) return { read: 'found', from: 'ship', code, specs }
    }
  }
  const shards = readStream(root, JOB_STREAM)
  for (let i = shards.length - 1; i >= 0; i--) {
    const e = shards[i] as Obj
    if (e.t !== 'job-shard' || e.kind !== BASE_TESTS || e.outcome !== 'done' || typeof e.key !== 'string') continue
    if (parseBaseTestsKey(e.key)?.suite !== suite) continue
    const result = baseTestsResult(e.result)
    if (result !== undefined && result.code === code) return { read: 'found', from: 'job', code, specs: result.specs }
  }
  return { read: 'missing', code, key: baseTestsKey(base, suite) }
}

// Row 275 (C30). One spec's passing cases a round lost against its base: the key is 16 hex over
// ['dropped', spec], a key space of its own beside a switch-off line's. `base` and `plan` are the spec's
// counts on each side; row 276 adds `booked` and `items` (the plan's own bookings of it).
export interface DroppedOff {
  kind: 'dropped'; key: string; spec: string; count: number; base: JunitCounts; plan: JunitCounts; booked?: number; items?: string[]
}

export function droppedKey(spec: string): string {
  return createHash('sha256').update(JSON.stringify(['dropped', spec])).digest('hex').slice(0, 16)
}

const countsOf = (tests: readonly TestOutcome[]): JunitCounts => ({
  passed: tests.filter((t) => t.status === 'passed').length,
  failed: tests.filter((t) => t.status === 'failed').length,
  skipped: tests.filter((t) => t.status === 'skipped').length,
})

// C30, for one spec. `skips` the plan's skipped cases beyond the base's — new skips always count; `failed`
// the new failures, the tests lane's red, never a loss; `lost` the passing cases gone beyond both: removed,
// untagged, renamed away or excluded. Counts net out, since the summary keeps no names.
function tally(plan: readonly TestOutcome[], base: JunitCounts, spec: string): { counts: JunitCounts; skips: number; lost: number } {
  const counts = countsOf(plan.filter((t) => matchesTag(t.name, spec)))
  const skips = Math.max(0, counts.skipped - base.skipped)
  const failed = Math.max(0, counts.failed - base.failed)
  return { counts, skips, lost: Math.max(0, base.passed - counts.passed - failed - skips) }
}

// C30, C31. Per base spec still in canon (`live`), sorted: its loss is its new skips plus its lost passing
// cases, or its new skips alone for the licensed spec, whose removals are listed and never counted. A
// spec gone from canon (renamed, abandoned) is not compared; a count of 0 is no hit.
export function droppedCases(
  plan: readonly TestOutcome[], base: Readonly<Record<string, JunitCounts>>, live: ReadonlySet<string>, licensed: string | undefined,
): { offs: DroppedOff[]; licensed: Array<{ spec: string; lost: number }> } {
  const offs: DroppedOff[] = []
  const listed: Array<{ spec: string; lost: number }> = []
  for (const spec of Object.keys(base).filter((s) => live.has(s)).sort()) {
    const b = base[spec]!
    const { counts, skips, lost } = tally(plan, b, spec)
    const licensedHere = spec === licensed
    if (licensedHere && lost > 0) listed.push({ spec, lost })
    const count = skips + (licensedHere ? 0 : lost)
    if (count > 0) offs.push({ kind: 'dropped', key: droppedKey(spec), spec, count, base: b, plan: counts })
  }
  return { offs, licensed: listed }
}

// C31. "Without a spec amendment", through row 160's one derivation of a spec's delta: the plan's own
// parent is licensed when no other plan realizes it, or when the newest one's pin differs from this
// plan's `derives-from` — this plan implements an amendment.
export function licensedSpec(root: string, canon: Canon, plan: CanonDoc): string | undefined {
  const parent = plan.meta.parent
  if (typeof parent !== 'string') return undefined
  const prior = baseForSpec(root, canon, parent, String(plan.meta.id))
  return prior.kind === 'empty' || prior.sha !== String(plan.meta['derives-from']) ? parent : undefined
}

export interface TestsEffect {
  read: 'compared' | 'not-checked'
  why?: string
  specs?: number
  offs: DroppedOff[]
  licensed: Array<{ spec: string; lost: number }>
  owes?: { kind: 'base-tests'; key: string }
  base?: Record<string, JunitCounts>
}

const notChecked = (why: string, owes?: TestsEffect['owes']): TestsEffect =>
  ({ read: 'not-checked', why, offs: [], licensed: [], ...(owes !== undefined ? { owes } : {}) })

// Row 275 (§3.5's rule for T3's test half; C32). A round's tests effect: its own suite run against the
// base's counts. With no base it reads not checked — never green, never red — and a missing base owes
// the base suite. `base` holds the counts of the specs it compared.
export function testsEffect(
  root: string, canon: Canon, cfg: Config, plan: CanonDoc, base: string, suite: readonly TestOutcome[] | undefined,
): TestsEffect {
  const rc = runnerConfig(cfg)
  if (rc.ok && rc.value.mode !== 'full-suite') return notChecked('the runner is filtered — the tests effect reads a full-suite junit report')
  if (!rc.ok || rc.value.mode !== 'full-suite' || suite === undefined) return notChecked('no full-suite run this round')
  const found = baseCounts(root, rc.value, base)
  if (found.read === 'unreadable') return notChecked(found.why)
  if (found.read === 'missing') {
    const owes = { kind: 'base-tests' as const, key: found.key }
    if (cfg.scratch.prepare === undefined) return notChecked('the base suite is not measured, and scratch runs are off — scratch.prepare is not set', owes)
    const reading = jobReading(root, { kind: BASE_TESTS, key: found.key, shards: 1 })
    if (reading.state === 'pending') return notChecked('the base suite is not measured yet — drive runs it', owes)
    if (reading.state === 'not-measured') return notChecked(`the base suite is not measured — ${reading.why}`, owes)
    return notChecked("the base suite's result could not be read", owes)
  }
  const live = new Set(canon.docs.filter((d) => d.meta.type === 'spec').map((d) => String(d.meta.id)))
  const compared = Object.keys(found.specs).filter((s) => live.has(s)).sort()
  const parent = plan.meta.parent
  const parentLost = typeof parent === 'string' && compared.includes(parent) && tally(suite, found.specs[parent]!, parent).lost > 0
  const { offs, licensed } = droppedCases(suite, found.specs, live, parentLost ? licensedSpec(root, canon, plan) : undefined)
  return { read: 'compared', specs: compared.length, offs, licensed, base: Object.fromEntries(compared.map((s) => [s, found.specs[s]!])) }
}
