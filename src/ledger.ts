import { createHash, randomBytes } from 'node:crypto'
import { checkWaiver } from './checks.js'
import { isId } from './dsl.js'
import { readStream, type Entry } from './journal.js'
import { v, type Violation } from './refusal.js'
import type { GateRunEntry, OffVerdict, PartState } from './rounds.js'
import type { ReaderTool } from './settings.js'
import { treeReadable } from './snapshot.js'
import { LEDGER_STREAM } from './streams.js'
import { copiesInTree } from './switch-offs.js'
import { visible } from './toon.js'

// Row 269 (the trust design §3.3, LD). The repo ledger: what a human booked, kept on witness's own
// `ledger` stream until main no longer holds it. An item opens with a booking (an act), closes by
// observation at the merge stamp or the abandon (bookkeeping), or is dismissed by a human at a
// terminal (an act). Never owed work (the map's C21): nothing routes an open item.
//
// Row 274. Two kinds: `booked-check` (a lint part, row 270) and `booked-switch-off` (a switch-off line
// a judged round booked: `file`, `token`, and the copies of each line key it waives). A switch-off
// item closes when the merging tree no longer holds its line (`mergeCloses`).
// Row 276. A third: `booked-dropped` (a spec's lost passing tests a judged round booked: `spec`, the
// round's base counts, and the cases it waives). It closes once main has the cases back (`mergeCloses`).

export type LedgerKind = 'booked-check' | 'booked-switch-off' | 'booked-dropped'

// What an item books: the whole part (held at the part's base key: the base commit and its
// commands, the map's C19), or the multiset of diagnostic keys (16 hex) it covers.
export type LedgerSubject = { whole: true } | { diagnostics: Record<string, number> }

export type LedgerCause = 'rule-retired' | 'declined' | 'judged-wrong'
export const LEDGER_CAUSES: readonly LedgerCause[] = ['rule-retired', 'declined', 'judged-wrong']

export interface CheckOpen {
  v: 1
  t: 'ledger-open'
  id: string
  // 16 hex over (kind, check, plan, part, subject): a booking whose key is open reuses that item.
  key: string
  kind: 'booked-check'
  check: string
  plan: string
  gate: string
  round: number
  run_id: string
  part: string
  part_key: string
  tool?: ReaderTool
  subject: LedgerSubject
  note?: string
}

// Row 274. A switch-off line booked: `subject.lines` the copies of each line key (src/switch-offs.ts)
// it waives; its key is 16 hex over (kind, check, plan, file, token, the sorted lines).
export interface SwitchOffOpen {
  v: 1
  t: 'ledger-open'
  id: string
  key: string
  kind: 'booked-switch-off'
  check: string
  plan: string
  gate: string
  round: number
  run_id: string
  file: string
  token: string
  subject: { lines: Record<string, number> }
  note?: string
}

// Row 276. A spec's lost tests booked: `base` the booked round's base counts for the spec, `subject.cases`
// the cases it waives; its key is 16 hex over (kind, check, plan, spec, base passed, base skipped, cases).
export interface DroppedOpen {
  v: 1
  t: 'ledger-open'
  id: string
  key: string
  kind: 'booked-dropped'
  check: string
  plan: string
  gate: string
  round: number
  run_id: string
  spec: string
  base: { passed: number; skipped: number }
  subject: { cases: number }
  note?: string
}

export type LedgerOpen = CheckOpen | SwitchOffOpen | DroppedOpen

// `plan` is the observer: the merging plan, or the abandoned one.
export interface LedgerClosed { v: 1; t: 'ledger-closed'; id: string; by: 'merge' | 'abandon'; plan: string; pr?: number; tree?: string }

export interface LedgerDismissed { v: 1; t: 'ledger-dismissed'; id: string; cause: LedgerCause; note: string }

export type LedgerItem = (Omit<CheckOpen, 'v' | 't'> | Omit<SwitchOffOpen, 'v' | 't'> | Omit<DroppedOpen, 'v' | 't'>) & {
  state: 'open' | 'closed' | 'dismissed'
  end?: LedgerClosed | LedgerDismissed
}

// Row 274. A switch-off item or booking, named where a human reads it: its token in its file, spelled out.
export const offWhere = (token: string, file: string): string => `${visible(token)} in ${visible(file)}`

export type CheckItem = Extract<LedgerItem, { kind: 'booked-check' }>
export type SwitchOffItem = Extract<LedgerItem, { kind: 'booked-switch-off' }>
export type DroppedItem = Extract<LedgerItem, { kind: 'booked-dropped' }>

// Row 276. Where a switch-offs item or booking is, as a human reads it: a line's token in its file, or a
// spec's tests — spelled out.
export function bookedWhere(x: { kind: 'booked-switch-off'; token: string; file: string } | { kind: 'booked-dropped'; spec: string }): string {
  return x.kind === 'booked-switch-off' ? offWhere(x.token, x.file) : `tests of ${visible(x.spec)}`
}

const str = (x: unknown): x is string => typeof x === 'string' && x !== ''

function subjectOf(x: unknown): LedgerSubject | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const s = x as Record<string, unknown>
  if (s.whole === true) return { whole: true }
  const d = s.diagnostics
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined
  const counts = Object.entries(d as Record<string, unknown>)
  if (counts.length === 0 || !counts.every(([, n]) => Number.isInteger(n) && (n as number) >= 1)) return undefined
  return { diagnostics: Object.fromEntries(counts) as Record<string, number> }
}

// Row 274. A switch-off item's lines: at least one key, each with a positive count.
function linesOf(x: unknown): { lines: Record<string, number> } | undefined {
  if (typeof x !== 'object' || x === null) return undefined
  const l = (x as Record<string, unknown>).lines
  if (typeof l !== 'object' || l === null || Array.isArray(l)) return undefined
  const counts = Object.entries(l as Record<string, unknown>)
  if (counts.length === 0 || !counts.every(([k, n]) => k !== '' && Number.isInteger(n) && (n as number) >= 1)) return undefined
  return { lines: Object.fromEntries(counts) as Record<string, number> }
}

// A line a hand edit or an older witness left with a required field missing or mistyped is no item.
function openOf(e: Entry): LedgerOpen | undefined {
  if (e.t !== 'ledger-open') return undefined
  if (!str(e.id) || !str(e.key) || !str(e.check) || !str(e.plan) || !str(e.gate) || !Number.isInteger(e.round) || !str(e.run_id)) return undefined
  if (e.kind === 'booked-check') {
    const subject = subjectOf(e.subject)
    if (!str(e.part) || !str(e.part_key) || subject === undefined) return undefined
    return { ...(e as unknown as CheckOpen), subject }
  }
  if (e.kind === 'booked-switch-off') {
    const subject = linesOf(e.subject)
    if (!str(e.file) || !str(e.token) || subject === undefined) return undefined
    return { ...(e as unknown as SwitchOffOpen), subject }
  }
  if (e.kind === 'booked-dropped') {
    const b = e.base as Record<string, unknown> | undefined
    const s = e.subject as Record<string, unknown> | undefined
    const count = (n: unknown, min: number) => Number.isInteger(n) && (n as number) >= min
    if (!isId(e.spec) || typeof b !== 'object' || b === null || !count(b.passed, 0) || !count(b.skipped, 0)) return undefined
    if (typeof s !== 'object' || s === null || !count(s.cases, 1)) return undefined
    return { ...(e as unknown as DroppedOpen), base: { passed: b.passed as number, skipped: b.skipped as number }, subject: { cases: s.cases as number } }
  }
  return undefined
}

function endOf(e: Entry): LedgerClosed | LedgerDismissed | undefined {
  if (!str(e.id)) return undefined
  if (e.t === 'ledger-closed' && (e.by === 'merge' || e.by === 'abandon') && str(e.plan)) return e as unknown as LedgerClosed
  if (e.t === 'ledger-dismissed' && LEDGER_CAUSES.includes(e.cause as LedgerCause) && typeof e.note === 'string') return e as unknown as LedgerDismissed
  return undefined
}

// Every item, in open order. An item's first end wins; a later one, or an end for no open, is ignored.
export function ledgerItems(root: string): LedgerItem[] {
  const items = new Map<string, LedgerItem>()
  for (const e of readStream(root, LEDGER_STREAM)) {
    const o = openOf(e)
    if (o !== undefined) {
      if (!items.has(o.id)) {
        const { v: _v, t: _t, ...rest } = o
        items.set(o.id, { ...rest, state: 'open' })
      }
      continue
    }
    const end = endOf(e)
    const item = end === undefined ? undefined : items.get(end.id)
    if (item === undefined || item.state !== 'open' || end === undefined) continue
    item.state = end.t === 'ledger-closed' ? 'closed' : 'dismissed'
    item.end = end
  }
  return [...items.values()]
}

// `part` names a lint part: only `booked-check` items hold one.
export function openItems(root: string, by: { plan?: string; part?: string } = {}): LedgerItem[] {
  return ledgerItems(root).filter((i) => i.state === 'open'
    && (by.plan === undefined || i.plan === by.plan) && (by.part === undefined || (i.kind === 'booked-check' && i.part === by.part)))
}

const sorted = (counts: Record<string, number>): Array<[string, number]> =>
  Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

export type KeyFields =
  | Pick<CheckOpen, 'kind' | 'check' | 'plan' | 'part' | 'part_key' | 'subject'>
  | Pick<SwitchOffOpen, 'kind' | 'check' | 'plan' | 'file' | 'token' | 'subject'>
  | Pick<DroppedOpen, 'kind' | 'check' | 'plan' | 'spec' | 'base' | 'subject'>

// The idempotence key: a whole part's names the base it was booked against (its part key), a
// per-diagnostic one names its exact multiset and holds across bases. Row 274: a switch-off item's
// names its file, token and exact lines; the lint formula is unchanged, so no open item's key moves.
// Row 276: a loss's names its spec, the base counts it was booked against and its cases; the other two
// formulas are unchanged, so no open item's key moves.
export function itemKey(o: KeyFields): string {
  if (o.kind === 'booked-dropped') {
    return createHash('sha256').update(JSON.stringify([o.kind, o.check, o.plan, o.spec, o.base.passed, o.base.skipped, o.subject.cases]))
      .digest('hex').slice(0, 16)
  }
  if (o.kind === 'booked-switch-off') {
    return createHash('sha256').update(JSON.stringify([o.kind, o.check, o.plan, o.file, o.token, sorted(o.subject.lines)])).digest('hex').slice(0, 16)
  }
  const subject = 'whole' in o.subject ? o.part_key : sorted(o.subject.diagnostics)
  return createHash('sha256').update(JSON.stringify([o.kind, o.check, o.plan, o.part, subject])).digest('hex').slice(0, 16)
}

export const newItemId = (): string => `l-${randomBytes(4).toString('hex')}`

// F7: a stream an older witness wrote under this name is another artifact's history.
export function ledgerTaken(root: string): Violation | undefined {
  const first = readStream(root, LEDGER_STREAM)[0]
  if (first === undefined || first.t === 'ledger-open') return undefined
  return v(LEDGER_STREAM, 'stream-taken', `the stream starts with ${visible(String(first.t))}`,
    'a stream for ledger items alone — witness check names the artifact that holds it')
}

// Row 270 (settled point 3). What one part of a checks-only round books: per diagnostic where the
// lane gave the part a `book`, whole otherwise (held at the part's base key until main moves, C19).
// Row 274: what one switch-off line of a judged round books — the copies its bookings leave uncovered.
export type Booking =
  | { kind: 'booked-check'; part: string; part_key: string; tool?: ReaderTool; subject: LedgerSubject }
  | { kind: 'booked-switch-off'; file: string; token: string; subject: { lines: Record<string, number> } }
  | { kind: 'booked-dropped'; spec: string; base: { passed: number; skipped: number }; subject: { cases: number } }

// Never `pending` (drive is measuring the base: book once it lands), `untrusted` (a trust grant comes
// first) or a passing state.
const BOOKABLE: ReadonlySet<PartState> = new Set<PartState>(['red', 'new', 'not-measured', 'not-judged'])

const unbooked = (o: OffVerdict): number => Math.max(0, o.count - (o.booked ?? 0))

// The bookable parts of `run` when it is checks only, its withheld (last) check is `check`, and that
// check carries a waiver. Row 274: on a round lenses ran (not checks only, not malformed), each line of
// `check` — red, carrying the judge's waiver — with copies its bookings leave uncovered, one booking per
// line. `[]` for any other run.
export function bookingsOf(run: GateRunEntry, check: string): Booking[] {
  const waiver = checkWaiver(check)
  if (waiver === undefined) return []
  if (run.checks_only !== true) {
    if (waiver !== 'judge' || run.outcome === 'malformed') return []
    const c = run.checks.find((x) => x.name === check)
    if (c === undefined || c.ok || c.offs === undefined) return []
    return c.offs.flatMap((o): Booking[] => {
      if (unbooked(o) === 0) return []
      // Row 276: a spec's lost tests book the cases its bookings leave uncovered, against the round's base.
      if (o.kind === 'dropped') {
        return [{ kind: 'booked-dropped', spec: o.spec, base: { passed: o.base.passed, skipped: o.base.skipped }, subject: { cases: unbooked(o) } }]
      }
      return [{ kind: 'booked-switch-off', file: o.file, token: o.token, subject: { lines: { [o.key]: unbooked(o) } } }]
    })
  }
  const last = run.checks.at(-1)
  if (last === undefined || last.name !== check) return []
  return (last.parts ?? []).flatMap((p) => (BOOKABLE.has(p.state) && p.key !== undefined
    ? [{ kind: 'booked-check' as const, part: p.part, part_key: p.key,
        subject: p.book !== undefined ? { diagnostics: { ...p.book } } : { whole: true as const } }]
    : []))
}

// Read under the caller's repo lock: per booking, the open item whose key it matches (reused, no
// entry: the idempotence key) or a fresh id and its `ledger-open`. An id the ledger ever held is
// minted again, never reused. Slice 2 review I1: an item the anchor's part already applies is never
// the match — what is left to book is beyond it (a booked line duplicated has the booked key again),
// so reusing it would book nothing and offer the booking again forever.
// Row 274: a switch-off booking's item is the line's (its key in the run's `offs`), its check the one
// holding that line; an item the line already applies is likewise never the match.
export function bookLines(root: string, plan: string, gate: string, run: GateRunEntry, bookings: readonly Booking[], note?: string):
Array<{ id: string; entry?: LedgerOpen }> {
  const items = ledgerItems(root)
  const taken = new Set(items.map((i) => i.id))
  const open = items.filter((i) => i.state === 'open')
  const mint = (): string => {
    let id = newItemId()
    while (taken.has(id)) id = newItemId()
    taken.add(id)
    return id
  }
  const common = { gate, round: run.round, run_id: run.run_id, ...(note !== undefined ? { note } : {}) }
  return bookings.map((b) => {
    // Row 276: a loss's item is its spec's (the run's dropped hit for it); an item the hit already applies
    // is never the match, as for a line.
    if (b.kind === 'booked-dropped') {
      const holds = (o: OffVerdict) => o.kind === 'dropped' && o.spec === b.spec
      const holder = run.checks.find((c) => c.offs?.some(holds) === true)
      const check = holder?.name ?? ''
      const key = itemKey({ kind: b.kind, check, plan, spec: b.spec, base: b.base, subject: b.subject })
      const applied = new Set((holder?.offs ?? []).filter(holds).flatMap((o) => o.items ?? []))
      const same = open.find((i) => itemKey(i) === key && !applied.has(i.id))
      if (same !== undefined) return { id: same.id }
      const id = mint()
      const entry: DroppedOpen = { v: 1, t: 'ledger-open', id, key, kind: b.kind, check, plan, ...common, spec: b.spec, base: b.base, subject: b.subject }
      return { id, entry }
    }
    if (b.kind === 'booked-switch-off') {
      const holds = (o: OffVerdict) => o.kind !== 'dropped' && Object.hasOwn(b.subject.lines, o.key)
      const holder = run.checks.find((c) => c.offs?.some(holds) === true)
      const check = holder?.name ?? ''
      const key = itemKey({ kind: b.kind, check, plan, file: b.file, token: b.token, subject: b.subject })
      const applied = new Set((holder?.offs ?? []).filter(holds).flatMap((o) => o.items ?? []))
      const same = open.find((i) => itemKey(i) === key && !applied.has(i.id))
      if (same !== undefined) return { id: same.id }
      const id = mint()
      const entry: SwitchOffOpen = { v: 1, t: 'ledger-open', id, key, kind: b.kind, check, plan, ...common, file: b.file, token: b.token, subject: b.subject }
      return { id, entry }
    }
    const check = run.checks.at(-1)?.name ?? ''
    const key = itemKey({ kind: b.kind, check, plan, part: b.part, part_key: b.part_key, subject: b.subject })
    const applied = new Set(run.checks.at(-1)?.parts?.find((p) => p.part === b.part)?.items ?? [])
    const same = open.find((i) => itemKey(i) === key && !applied.has(i.id))
    if (same !== undefined) return { id: same.id }
    const id = mint()
    const entry: CheckOpen = {
      v: 1, t: 'ledger-open', id, key, kind: b.kind, check, plan, ...common,
      part: b.part, part_key: b.part_key, ...(b.tool !== undefined ? { tool: b.tool } : {}), subject: b.subject,
    }
    return { id, entry }
  })
}

// Row 269 (§3.3, the map's C18). What the merge stamp of `plan` observes, read under its lock: from the
// plan's last ship round that ran lint with parts — the tree that merges — every open item whose plan
// is this one or merged before it closes when its part reads green there, or the part's `cleared`
// lists it. No such round observes nothing, and closes nothing: nothing reads gone by absence. An
// item of a plan still in flight waits for its own merge, since its booking reaches main only then.
//
// Row 274 (§3.3). A booked switch-off closes when the line is gone, read from the plan's newest ship round
// alone (unit review M-a): its `reviewed_tree` is what merged. The plan's own items close when that tree
// holds no line they book. Another merged plan's close only where the round's base (`reviewed_base`)
// held a line it books and the tree holds none — this merge took it out; a tree cut before that plan
// merged says nothing about its line (unit review I1). A missing file holds none; an unreadable tree or
// base, a round with no base, or a read git fails observes nothing (`copiesInTree` undefined).
//
// Row 276 (§3.3). A booked loss closes once main has the spec's cases back, read from the same newest ship
// round's junit summary: short is fewer passing or more skipped than the item's base. The plan's own items
// close when the summary is not short; another merged plan's only where the round's base counts
// (`junit.base`) were short and the summary is not — this merge restored them (unit review I1, applied to
// counts). A round with no summary, or no base counts for the spec, observes nothing.
export function mergeCloses(root: string, plan: string, pr: number): LedgerClosed[] {
  const runs = readStream(root, plan).filter((e) => e.t === 'gate-run' && e.gate === 'ship') as unknown as GateRunEntry[]
  const mergedBefore = new Map<string, boolean>()
  const merged = (p: string): boolean => {
    if (p === plan) return true
    if (!isId(p)) return false
    if (!mergedBefore.has(p)) {
      mergedBefore.set(p, readStream(root, p).some((e) => e.t === 'status' && e.to === 'done' && e.cause === 'merge'))
    }
    return mergedBefore.get(p)!
  }
  const open = openItems(root)
  const observed = [...runs].reverse().find((r) => (r.checks ?? []).some((c) => c.name === 'lint' && c.parts !== undefined))
  const parts = observed?.checks.find((c) => c.name === 'lint' && c.parts !== undefined)?.parts ?? []
  const lint = observed === undefined ? [] : open.flatMap((i) => {
    // M-g (T2e slice 3): the lint observation reads lint items alone.
    if (i.kind !== 'booked-check' || i.check !== 'lint' || !merged(i.plan)) return []
    const part = parts.find((p) => p.part === i.part)
    if (part === undefined || !(part.state === 'green' || (part.cleared ?? []).includes(i.id))) return []
    const close: LedgerClosed = { v: 1, t: 'ledger-closed', id: i.id, by: 'merge', plan, pr, ...(observed.reviewed_tree !== undefined ? { tree: observed.reviewed_tree } : {}) }
    return [close]
  })
  const newest = runs.at(-1)
  const tree = newest?.reviewed_tree !== undefined && treeReadable(root, newest.reviewed_tree) ? newest.reviewed_tree : undefined
  const base = newest?.reviewed_base !== undefined && treeReadable(root, newest.reviewed_base) ? newest.reviewed_base : undefined
  const offs = tree === undefined ? [] : open.flatMap((i) => {
    if (i.kind !== 'booked-switch-off' || !merged(i.plan)) return []
    const keys = new Set(Object.keys(i.subject.lines))
    if (copiesInTree(root, tree, i.file, i.token, keys) !== 0) return []
    if (i.plan !== plan && (base === undefined || (copiesInTree(root, base, i.file, i.token, keys) ?? 0) === 0)) return []
    const close: LedgerClosed = { v: 1, t: 'ledger-closed', id: i.id, by: 'merge', plan, pr, tree }
    return [close]
  })
  const summary = newest?.junit
  const count = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0
  const short = (c: { passed?: unknown; skipped?: unknown } | undefined, b: { passed: number; skipped: number }): boolean | undefined =>
    c === undefined || typeof c !== 'object' || !count(c.passed) || !count(c.skipped) ? undefined : c.passed < b.passed || c.skipped > b.skipped
  const drops = summary === undefined ? [] : open.flatMap((i) => {
    if (i.kind !== 'booked-dropped' || !merged(i.plan)) return []
    const now = short(summary.specs?.[i.spec] ?? { passed: 0, skipped: 0 }, i.base)
    if (now !== false) return []
    if (i.plan !== plan && short(summary.base?.[i.spec], i.base) !== true) return []
    const close: LedgerClosed = { v: 1, t: 'ledger-closed', id: i.id, by: 'merge', plan, pr, ...(newest?.reviewed_tree !== undefined ? { tree: newest.reviewed_tree } : {}) }
    return [close]
  })
  return [...lint, ...offs, ...drops]
}

// Row 269. An abandoned plan never merges, so nothing it booked reaches main: each of its open items
// closes in the abandon's own transaction.
export function abandonCloses(root: string, plans: readonly string[]): LedgerClosed[] {
  return openItems(root).filter((i) => plans.includes(i.plan))
    .map((i): LedgerClosed => ({ v: 1, t: 'ledger-closed', id: i.id, by: 'abandon', plan: i.plan }))
}
