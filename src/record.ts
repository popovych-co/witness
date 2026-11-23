import type { TestcaseOutcomes } from './criteria.js'
import { effortAbandoned, effortCause, effortStreams, readStream, type Entry, type FixCause, type RecapEntry } from './journal.js'
import { mergeClock, mergesBetween, type MergeClock } from './merge-clock.js'
import type { Canon } from './scan.js'

// Row 254. The track record: a measured baseline for the human, computed from the journal, canon and
// the merge clock, never inferred — a fold with no data reads "not measured". Decision 8: no gate,
// arbiter, recommend, autonomy, settle, next or decide path reads it (tests/record-surfaces.test.ts
// guards that), so nothing here can tighten or loosen what witness lets through.

// One live fix effort. An escape the clock could charge carries `charged`; one it could not, the
// reason; a decision or a fix with no cause carries neither (decisions are never charged).
export interface FixRow {
  effort: string
  cause?: FixCause
  charged?: { plan: string; version: string; age: number }
  uncharged?: 'nothing-shipped-before' | 'order-unknown'
}
export interface VersionRow { version: string; escapes: number; plans: number }
export interface EscapesFold {
  measured: boolean          // once one live fix effort carries a cause
  fixes: FixRow[]            // every live fix effort, sorted by slug
  escapes: number
  decisions: number
  plans: number              // shipped plans not made by a chore
  byVersion: VersionRow[]
}

// A ship gate-run's `w` names the CLI that ran it; anything else reads `unknown`.
const VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,24}$/

interface Effort { slug: string; entries: Entry[]; cls?: RecapEntry['class']; abandoned: boolean }
interface ShippedPlan { id: string; parent: string; version: string }

const wrote = (e: Effort, id: string, created?: true) =>
  e.entries.some((x) => x.t === 'write' && x.artifact === id && (created === undefined || x.created === true))

// A plan's maker: the effort whose write of it created it; with none, `effortOf`'s rule
// (src/reviewed.ts) — a live writer before an abandoned one, then by slug — over the streams read once.
function makerOf(efforts: readonly Effort[], id: string): Effort | undefined {
  const created = efforts.find((e) => wrote(e, id, true))
  if (created) return created
  return efforts.filter((e) => wrote(e, id))
    .sort((a, b) => (a.abandoned === b.abandoned ? a.slug.localeCompare(b.slug) : a.abandoned ? 1 : -1))[0]
}

function shippedPlans(root: string, canon: Canon, efforts: readonly Effort[]): ShippedPlan[] {
  return canon.docs.filter((d) => d.meta.type === 'plan').flatMap((d) => {
    const id = String(d.meta.id)
    const stream = readStream(root, id)
    if (!stream.some((e) => e.t === 'status' && e.cause === 'merge')) return []
    if (makerOf(efforts, id)?.cls === 'chore') return []        // chores are never charged, nor counted
    const w = stream.filter((e) => e.t === 'gate-run' && e.gate === 'ship').at(-1)?.w
    return [{ id, parent: String(d.meta.parent), version: typeof w === 'string' && VERSION.test(w) ? w : 'unknown' }]
  })
}

// Approximate by design: the last non-chore plan of a spec the fix amended that shipped before the fix
// was born. Charged only when the clock places every candidate — one it cannot place may have shipped
// after the plan that would be charged (review focus 1: never charged to a wrong plan).
function charge(fix: Effort, plans: readonly ShippedPlan[], clock: MergeClock | undefined): Pick<FixRow, 'charged' | 'uncharged'> {
  const amended = new Set(fix.entries.filter((x) => x.t === 'write').map((x) => String(x.artifact)))
  const candidates = plans.filter((p) => amended.has(p.parent))
  const birth = clock?.born.get(fix.slug)
  if (clock === undefined || birth === undefined || candidates.some((p) => !clock.merged.has(p.id))) {
    return { uncharged: 'order-unknown' }
  }
  const before = candidates.filter((p) => clock.merged.get(p.id)! < birth)
    .sort((a, b) => clock.merged.get(b.id)! - clock.merged.get(a.id)!)
  const last = before[0]
  if (last === undefined) return { uncharged: 'nothing-shipped-before' }
  return { charged: { plan: last.id, version: last.version, age: mergesBetween(clock, clock.merged.get(last.id)!, birth) } }
}

// Newest version first by its numbers, a release before its own prerelease, `unknown` last.
function versionOrder(a: string, b: string): number {
  if (a === 'unknown' || b === 'unknown') return a === b ? 0 : a === 'unknown' ? 1 : -1
  const nums = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number)
  const [x, y] = [nums(a), nums(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i]! - x[i]!
  return a.length - b.length || a.localeCompare(b)
}

export function escapesFold(root: string, canon: Canon): EscapesFold {
  const efforts: Effort[] = effortStreams(root).map((slug) => {
    const entries = readStream(root, slug)
    return { slug, entries, cls: entries.filter((e): e is RecapEntry => e.t === 'recap').at(-1)?.class, abandoned: effortAbandoned(entries) }
  })
  const plans = shippedPlans(root, canon, efforts)
  const live = efforts.filter((e) => e.cls === 'fix' && !e.abandoned).sort((a, b) => a.slug.localeCompare(b.slug))
  // The clock is one `git log`, read only when an escape needs it.
  let clock: MergeClock | undefined
  let clockRead = false
  const fixes: FixRow[] = live.map((e) => {
    const cause = effortCause(e.entries)
    if (cause !== 'escape') return { effort: e.slug, ...(cause !== undefined ? { cause } : {}) }
    if (!clockRead) { clock = mergeClock(root); clockRead = true }
    return { effort: e.slug, cause, ...charge(e, plans, clock) }
  })
  const versions = new Map<string, VersionRow>()
  const row = (version: string) => versions.get(version) ?? versions.set(version, { version, escapes: 0, plans: 0 }).get(version)!
  for (const p of plans) row(p.version).plans++
  for (const f of fixes) if (f.charged) row(f.charged.version).escapes++
  return {
    measured: fixes.some((f) => f.cause !== undefined),
    fixes,
    escapes: fixes.filter((f) => f.cause === 'escape').length,
    decisions: fixes.filter((f) => f.cause === 'decision').length,
    plans: plans.length,
    byVersion: [...versions.values()].sort((a, b) => versionOrder(a.version, b.version)),
  }
}

// Row 254. Live specs failing: each live spec read by its latest drift run. Only runs that carry
// outcomes (row 251: full-suite runs from T1 on) are measured.
export interface LiveFold {
  measured: boolean                                   // once a live spec's latest drift run carries outcomes
  specs: number                                       // live specs whose latest drift run carries outcomes
  failing: Array<{ spec: string; tests: string[] }>
  couldNotVerify: string[]
  unconfirmed: string[]
}

const isOutcomes = (x: unknown): x is TestcaseOutcomes =>
  typeof x === 'object' && x !== null && typeof (x as TestcaseOutcomes).failed === 'number' &&
  Array.isArray((x as TestcaseOutcomes).failing)

// The failing names of a run that names any — a red with at least one failed testcase; undefined for
// a pass, a red that names none ("could not verify"), or a run with no outcomes.
const namedRed = (e: Entry | undefined): string[] | undefined =>
  e !== undefined && e.ok !== true && isOutcomes(e.outcomes) && e.outcomes.failed > 0
    ? e.outcomes.failing.filter((n): n is string => typeof n === 'string') : undefined

// The debounce: a named red is failing only in the names it shares with the run before it, itself a
// named red; one failure alone is unconfirmed. A red with no named failure — 0 tagged, every tagged
// case skipped, a failing `cmd`, a suite that did not run — could not verify, never failing or passing.
export function liveFold(root: string, canon: Canon): LiveFold {
  const out: LiveFold = { measured: false, specs: 0, failing: [], couldNotVerify: [], unconfirmed: [] }
  const live = canon.docs.filter((d) => d.meta.type === 'spec' && String(d.meta.status) === 'live')
    .map((d) => String(d.meta.id)).sort()
  for (const spec of live) {
    const runs = readStream(root, spec).filter((e) => e.t === 'drift-check')
    const latest = runs.at(-1)
    if (latest === undefined || !isOutcomes(latest.outcomes)) continue
    out.specs++
    if (latest.ok === true) continue
    const now = namedRed(latest)
    if (now === undefined) { out.couldNotVerify.push(spec); continue }
    const before = new Set(namedRed(runs.at(-2)) ?? [])
    const shared = [...new Set(now.filter((n) => before.has(n)))].sort()
    if (shared.length > 0) out.failing.push({ spec, tests: shared })
    else out.unconfirmed.push(spec)
  }
  out.measured = out.specs > 0
  return out
}
