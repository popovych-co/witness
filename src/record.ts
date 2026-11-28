import type { TestcaseOutcomes } from './criteria.js'
import { effortAbandoned, effortCause, effortStreams, readStream, type Entry, type FixCause, type RecapEntry } from './journal.js'
import { mergeClock, mergesBetween, type MergeClock } from './merge-clock.js'
import type { Canon } from './scan.js'
import { READER_TOOLS, type ReaderTool } from './settings.js'
import { kv, rows, visible } from './toon.js'
import { tryGit } from './gitio.js'
import { ledgerItems, mergedPlan, type ToleratedItem } from './ledger.js'
import { allowance, ruleKey } from './tolerated.js'

// Row 254. The track record: a measured baseline for the human, computed from the journal, canon and
// the merge clock, never inferred — a fold with no data reads "not measured". Decision 8: no gate,
// arbiter, recommend, autonomy, settle, next or decide path reads it (tests/record-surfaces.test.ts
// guards that), so nothing here can tighten or loosen what witness lets through.

// One live fix effort. An escape the clock could charge carries `charged`; one it could not, the
// reason; a decision or a fix with no cause carries neither (decisions are never charged).
// `no-amended-spec`: its writes name no spec in canon — recapped but not yet decomposed, or its spec
// renamed since — so there is nothing to charge against (slice 3 review M1).
export interface FixRow {
  effort: string
  cause?: FixCause
  charged?: { plan: string; version: string; age: number }
  uncharged?: 'nothing-shipped-before' | 'order-unknown' | 'no-amended-spec'
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
function charge(fix: Effort, plans: readonly ShippedPlan[], specs: ReadonlySet<string>,
  clock: MergeClock | undefined): Pick<FixRow, 'charged' | 'uncharged'> {
  const amended = new Set(fix.entries.filter((x) => x.t === 'write').map((x) => String(x.artifact)).filter((id) => specs.has(id)))
  if (amended.size === 0) return { uncharged: 'no-amended-spec' }
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
  const specs = new Set(canon.docs.filter((d) => d.meta.type === 'spec').map((d) => String(d.meta.id)))
  const live = efforts.filter((e) => e.cls === 'fix' && !e.abandoned).sort((a, b) => a.slug.localeCompare(b.slug))
  // The clock is one `git log`, read only when an escape needs it.
  let clock: MergeClock | undefined
  let clockRead = false
  const fixes: FixRow[] = live.map((e) => {
    const cause = effortCause(e.entries)
    if (cause !== 'escape') return { effort: e.slug, ...(cause !== undefined ? { cause } : {}) }
    if (!clockRead) { clock = mergeClock(root); clockRead = true }
    return { effort: e.slug, cause, ...charge(e, plans, specs, clock) }
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

// Row 282. The checks fixes added: the guards merged plans journaled (`guard` entries, row 280) — lint
// guards by (tool, rule) with the plans that added them, test guards counted. A plan still in flight
// adds none. Not measured until a merged plan journals one. Tolerated spots wait for T4b.
export type ChecksFold =
  | { measured: false }
  | { measured: true; lint: Array<{ tool: ReaderTool; rule: string; plans: string[] }>; tests: number }

export function checksFold(root: string, canon: Canon): ChecksFold {
  const lint = new Map<string, { tool: ReaderTool; rule: string; plans: Set<string> }>()
  let tests = 0
  let any = false
  for (const d of canon.docs) {
    if (d.meta.type !== 'plan') continue
    const id = String(d.meta.id)
    const stream = readStream(root, id)
    if (!stream.some((e) => e.t === 'status' && e.cause === 'merge')) continue
    for (const e of stream) {
      if (e.t !== 'guard') continue
      any = true
      const rule = e.rule as { tool?: unknown; rule?: unknown } | undefined
      // Security review: journal text from any branch — only a reader tool counts; the rule is spelled out when printed.
      if (e.kind === 'lint' && (READER_TOOLS as readonly unknown[]).includes(rule?.tool) && typeof rule?.rule === 'string') {
        const key = JSON.stringify([rule!.tool, rule!.rule])
        const row = lint.get(key) ?? lint.set(key, { tool: rule!.tool as ReaderTool, rule: rule!.rule as string, plans: new Set() }).get(key)!
        row.plans.add(id)
      } else if (e.kind === 'test') tests++
    }
  }
  if (!any) return { measured: false }
  const rowsOut = [...lint.values()].map((r) => ({ tool: r.tool, rule: r.rule, plans: [...r.plans].sort() }))
    .sort((a, b) => (a.tool + a.rule < b.tool + b.rule ? -1 : a.tool + a.rule > b.tool + b.rule ? 1 : 0))
  return { measured: true, lint: rowsOut, tests }
}

// Row 287 (§4 T1). The tolerated spots main still holds: per (tool, rule) of the open sets whose plan merged,
// Σ per key of the copies capped by the lines main's HEAD holds (the allowance's cap, so two sets naming one
// key never count past HEAD's lines), and how many such sets. Measured once checks added is; a HEAD git cannot
// name reads not measured.
export type ToleratedFold = { measured: false } | { measured: true; rules: Array<{ tool: ReaderTool; rule: string; spots: number; sets: number }> }

export function toleratedFold(root: string, _canon: Canon, checks: ChecksFold): ToleratedFold {
  if (!checks.measured) return { measured: false }
  const head = tryGit(root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}')
  if (!head.ok || head.out.trim() === '') return { measured: false }
  const sets = ledgerItems(root).filter((i): i is ToleratedItem => i.kind === 'tolerated-set' && i.state === 'open' && mergedPlan(root, i.plan))
  // No plan is "own" here: every set is a merged one, capped by HEAD's lines.
  const allowed = allowance(root, '', head.out.trim(), sets)
  const byRule = new Map<string, { tool: ReaderTool; rule: string; spots: number; sets: number }>()
  for (const s of sets) {
    const rk = ruleKey(s.tool, s.rule)
    const row = byRule.get(rk) ?? { tool: s.tool, rule: s.rule, spots: [...(allowed.get(rk)?.values() ?? [])].reduce((a, n) => a + n, 0), sets: 0 }
    row.sets += 1
    byRule.set(rk, row)
  }
  const rules = [...byRule.values()].sort((a, b) => (a.tool !== b.tool ? (a.tool < b.tool ? -1 : 1) : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0))
  return { measured: true, rules }
}

// Row 254. The track record: its four folds, each "not measured" until it has data. `checks` (checks
// added) lands with T4a (row 282) — tolerated spots with T4b (row 287) — and `repairs` with T8b. Plain
// data: the models entry exports it.
export interface TrackRecord {
  escapes: EscapesFold
  live: LiveFold
  checks: ChecksFold
  tolerated: ToleratedFold
  repairs: { measured: false }
}

export function record(root: string, canon: Canon): TrackRecord {
  const checks = checksFold(root, canon)
  return { escapes: escapesFold(root, canon), live: liveFold(root, canon), checks, tolerated: toleratedFold(root, canon, checks), repairs: { measured: false } }
}

// Row 282: lint guards count once per plan that added each (tool, rule).
const lintAdded = (c: Extract<ChecksFold, { measured: true }>) => c.lint.reduce((n, r) => n + r.plans.length, 0)

const owing = (r: TrackRecord) => r.escapes.fixes.filter((f) => f.cause === undefined).map((f) => f.effort)

// The `record:` line: ids, counts and versions only, never a test name.
export function recordLine(r: TrackRecord): string {
  const e = r.escapes
  const owed = owing(r).length
  const escapes = (e.measured ? `escapes ${e.escapes} of ${e.plans} shipped plans (approximate) · decisions ${e.decisions}` : 'escapes not measured') +
    (owed === 0 ? '' : owed === 1 ? ' · 1 fix needs a cause' : ` · ${owed} fixes need a cause`)
  const live = r.live.measured
    ? `live specs failing ${r.live.failing.length} · could not verify ${r.live.couldNotVerify.length} of ${r.live.specs}`
    : 'live specs failing not measured'
  const c = r.checks
  const t = r.tolerated
  const held = t.measured ? `tolerated spots ${t.rules.reduce((n, x) => n + x.spots, 0)}` : 'tolerated spots not measured'
  const checks = c.measured
    ? `checks added ${lintAdded(c) + c.tests} (lint ${lintAdded(c)} · test ${c.tests}) · ${held}`
    : 'checks added not measured'
  return [escapes, live, checks, 'repairs not measured'].join(' · ')
}

// The open work: fixes still owing a cause, a list that shrinks to nothing as the human names them.
// Bare `witness` runs on every SessionStart, so the `help:` line reaches an agent's context: it names the
// act as the human's (Settled 1; the house wording of decide's human-only acts — slice 3 review I1).
export function owedRows(r: TrackRecord): string[] {
  const slugs = owing(r)
  if (slugs.length === 0) return []
  return [kv('cause-owed', slugs.join(' · ')),
    "help: the human names each fix's cause, in their own chat or terminal — witness recap --effort <slug> --cause escape|decision"]
}

const chargedCell = (f: FixRow) =>
  f.charged ? f.charged.plan
  : f.uncharged === 'nothing-shipped-before' ? 'none (nothing shipped before)'
  : f.uncharged === 'order-unknown' ? 'none (order unknown)'
  : f.uncharged === 'no-amended-spec' ? 'none (no amended spec)'
  : '—'
const ageCell = (f: FixRow) => (f.charged ? (f.charged.age === 1 ? '1 merge' : `${f.charged.age} merges`) : '—')

// `witness status --record`: the line, then every fix and its charge, the versions, and the open work.
export function recordTables(r: TrackRecord): string[] {
  const e = r.escapes
  return [
    kv('record', recordLine(r)),
    ...(e.fixes.length === 0 ? [] : [
      ...rows('fixes', ['effort', 'cause', 'charged', 'version', 'age'], e.fixes.map((f) => ({
        effort: f.effort, cause: f.cause ?? 'none', charged: chargedCell(f), version: f.charged?.version ?? '—', age: ageCell(f),
      }))),
      kv('note', 'a charge is approximate — the last plan of the amended spec that shipped before the fix'),
    ]),
    ...(e.measured ? rows('escapes-by-version', ['version', 'escapes', 'plans'], e.byVersion as unknown as Array<Record<string, unknown>>) : []),
    // Row 282: each lint check a fix added, by tool and rule (spelled out), with the plans that added it.
    ...(r.checks.measured && r.checks.lint.length > 0
      ? rows('checks-added', ['check', 'plans'], r.checks.lint.map((x) => ({ check: `${x.tool} ${visible(x.rule)}`, plans: x.plans.join(' · ') })))
      : []),
    // Row 287: the tolerated spots main still holds, by tool and rule (spelled out), with the sets holding them.
    ...(r.tolerated.measured && r.tolerated.rules.length > 0
      ? rows('tolerated', ['tool', 'rule', 'spots', 'sets'], r.tolerated.rules.map((x) => ({ tool: x.tool, rule: visible(x.rule), spots: x.spots, sets: x.sets })))
      : []),
    ...owedRows(r),
  ]
}
