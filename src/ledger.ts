import { createHash, randomBytes } from 'node:crypto'
import { checkWaiver } from './checks.js'
import { readStream, type Entry } from './journal.js'
import { v, type Violation } from './refusal.js'
import type { GateRunEntry, PartState } from './rounds.js'
import type { ReaderTool } from './settings.js'
import { LEDGER_STREAM } from './streams.js'
import { visible } from './toon.js'

// Row 269 (the trust design §3.3, LD). The repo ledger: what a human booked, kept on witness's own
// `ledger` stream until main no longer holds it. An item opens with a booking (an act), closes by
// observation at the merge stamp or the abandon (bookkeeping), or is dismissed by a human at a
// terminal (an act). Never owed work (the map's C21): nothing routes an open item.

export type LedgerKind = 'booked-check'

// What an item books: the whole part (held at the part's base key: the base commit and its
// commands, the map's C19), or the multiset of diagnostic keys (16 hex) it covers.
export type LedgerSubject = { whole: true } | { diagnostics: Record<string, number> }

export type LedgerCause = 'rule-retired' | 'declined' | 'judged-wrong'
export const LEDGER_CAUSES: readonly LedgerCause[] = ['rule-retired', 'declined', 'judged-wrong']

export interface LedgerOpen {
  v: 1
  t: 'ledger-open'
  id: string
  // 16 hex over (kind, check, plan, part, subject): a booking whose key is open reuses that item.
  key: string
  kind: LedgerKind
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

// `plan` is the observer: the merging plan, or the abandoned one.
export interface LedgerClosed { v: 1; t: 'ledger-closed'; id: string; by: 'merge' | 'abandon'; plan: string; pr?: number; tree?: string }

export interface LedgerDismissed { v: 1; t: 'ledger-dismissed'; id: string; cause: LedgerCause; note: string }

export interface LedgerItem extends Omit<LedgerOpen, 'v' | 't'> {
  state: 'open' | 'closed' | 'dismissed'
  end?: LedgerClosed | LedgerDismissed
}

const str = (x: unknown): x is string => typeof x === 'string' && x !== ''
const KINDS: readonly string[] = ['booked-check']

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

// A line a hand edit or an older witness left with a required field missing or mistyped is no item.
function openOf(e: Entry): LedgerOpen | undefined {
  if (e.t !== 'ledger-open') return undefined
  const subject = subjectOf(e.subject)
  if (!str(e.id) || !str(e.key) || !KINDS.includes(String(e.kind)) || !str(e.check) || !str(e.plan) || !str(e.gate)
    || !Number.isInteger(e.round) || !str(e.run_id) || !str(e.part) || !str(e.part_key) || subject === undefined) return undefined
  return { ...(e as unknown as LedgerOpen), subject }
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

export function openItems(root: string, by: { plan?: string; part?: string } = {}): LedgerItem[] {
  return ledgerItems(root).filter((i) => i.state === 'open'
    && (by.plan === undefined || i.plan === by.plan) && (by.part === undefined || i.part === by.part))
}

// The idempotence key: a whole part's names the base it was booked against (its part key), a
// per-diagnostic one names its exact multiset and holds across bases.
export function itemKey(o: Pick<LedgerOpen, 'kind' | 'check' | 'plan' | 'part' | 'part_key' | 'subject'>): string {
  const subject = 'whole' in o.subject
    ? o.part_key
    : Object.entries(o.subject.diagnostics).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
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
export interface Booking { part: string; part_key: string; tool?: ReaderTool; subject: LedgerSubject }

// Never `pending` (drive is measuring the base: book once it lands), `untrusted` (a trust grant comes
// first) or a passing state.
const BOOKABLE: ReadonlySet<PartState> = new Set<PartState>(['red', 'new', 'not-measured', 'not-judged'])

// The bookable parts of `run` when it is checks only, its withheld (last) check is `check`, and that
// check carries a waiver; `[]` for any other run.
export function bookingsOf(run: GateRunEntry, check: string): Booking[] {
  if (run.checks_only !== true || checkWaiver(check) === undefined) return []
  const last = run.checks.at(-1)
  if (last === undefined || last.name !== check) return []
  return (last.parts ?? []).flatMap((p) => (BOOKABLE.has(p.state) && p.key !== undefined
    ? [{ part: p.part, part_key: p.key, subject: p.book !== undefined ? { diagnostics: { ...p.book } } : { whole: true as const } }]
    : []))
}

// Read under the caller's repo lock: per booking, the open item whose key it matches (reused, no
// entry: the idempotence key) or a fresh id and its `ledger-open`. An id the ledger ever held is
// minted again, never reused. Slice 2 review I1: an item the anchor's part already applies is never
// the match — what is left to book is beyond it (a booked line duplicated has the booked key again),
// so reusing it would book nothing and offer the booking again forever.
export function bookLines(root: string, plan: string, gate: string, run: GateRunEntry, bookings: readonly Booking[], note?: string):
Array<{ id: string; entry?: LedgerOpen }> {
  const check = run.checks.at(-1)?.name ?? ''
  const items = ledgerItems(root)
  const taken = new Set(items.map((i) => i.id))
  const open = items.filter((i) => i.state === 'open')
  return bookings.map((b) => {
    const kind: LedgerKind = 'booked-check'
    const key = itemKey({ kind, check, plan, part: b.part, part_key: b.part_key, subject: b.subject })
    const applied = new Set(run.checks.at(-1)?.parts?.find((p) => p.part === b.part)?.items ?? [])
    const same = open.find((i) => itemKey(i) === key && !applied.has(i.id))
    if (same !== undefined) return { id: same.id }
    let id = newItemId()
    while (taken.has(id)) id = newItemId()
    taken.add(id)
    const entry: LedgerOpen = {
      v: 1, t: 'ledger-open', id, key, kind, check, plan, gate, round: run.round, run_id: run.run_id,
      part: b.part, part_key: b.part_key, ...(b.tool !== undefined ? { tool: b.tool } : {}), subject: b.subject,
      ...(note !== undefined ? { note } : {}),
    }
    return { id, entry }
  })
}
