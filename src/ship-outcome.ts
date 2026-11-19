import { journalRel, appendEntry, entryLine, readStream, type Entry } from './journal.js'
import { acquireLock } from './lock.js'
import { stateCommit } from './gitio.js'
import { withTxn } from './txn.js'

// Row 242 (design §4.3.2, R14). `witness ship` journals the outcome it ends on, whichever phase, as
// one entry kind, so drive, `next`, `needsYou` and the report classify a hold from the record and
// never from ship's words. `pr` is absent before a PR exists; `head` is the worktree's HEAD at the
// outcome; `base` the remote ship branch's commit as ship last fetched it; `n` counts a run of
// re-check outcomes (`transient`, `pending`), so drive tells a re-check from a session that did
// nothing.
export type ShipOutcome = 'merge' | 'fix' | 'transient' | 'pending' | 'red' | 're-gate' | 'merged'
export interface ShipOutcomeEntry {
  t: 'ship-outcome'; artifact: string; pr?: number; head: string; base?: string; outcome: ShipOutcome; reason: string; n?: number
}
export interface ShipOutcomeRecord { pr?: number; head: string; base?: string; outcome: ShipOutcome; reason: string }

const RECHECK: ReadonlySet<ShipOutcome> = new Set(['transient', 'pending'])

// The plan stream's latest entry, when it is a ship outcome.
export function latestOutcome(entries: Entry[]): ShipOutcomeEntry | undefined {
  const last = entries.at(-1)
  return last?.t === 'ship-outcome' ? last as unknown as ShipOutcomeEntry : undefined
}

// A record the human must clear stands while it is the stream's latest entry and the worktree's
// HEAD is its head: any later entry or a moved HEAD ends it.
export function standingRecord(entries: Entry[], head: string | undefined): ShipOutcomeEntry | undefined {
  const rec = latestOutcome(entries)
  return rec !== undefined && (rec.outcome === 'merge' || rec.outcome === 'fix') && head !== undefined && rec.head === head ? rec : undefined
}

const same = (a: ShipOutcomeEntry, b: ShipOutcomeRecord): boolean =>
  a.outcome === b.outcome && a.pr === b.pr && a.head === b.head && a.base === b.base && a.reason === b.reason

// Journals the record under the state lock, read again there, as every journaling verb does. A
// re-check outcome always journals, `n` one more than the run it continues; any other is skipped
// when the stream's latest entry is the same record — compared on its fields alone, never on the
// line, which carries the writer's `w` and `ctx`. `refused`: the repo lock or the state commit
// refused — the outcome stands unrecorded, and the next ship run records it.
export function journalOutcome(root: string, planId: string, rec: ShipOutcomeRecord): 'journaled' | 'same' | 'refused' {
  const lock = acquireLock(root)
  if (!lock.ok) return 'refused'
  try {
    const latest = latestOutcome(readStream(root, planId))
    const recheck = RECHECK.has(rec.outcome)
    if (!recheck && latest !== undefined && same(latest, rec)) return 'same'
    const n = recheck ? (latest !== undefined && RECHECK.has(latest.outcome) ? (latest.n ?? 1) + 1 : 1) : undefined
    const entry: ShipOutcomeEntry = {
      t: 'ship-outcome', artifact: planId, ...(rec.pr !== undefined ? { pr: rec.pr } : {}), head: rec.head,
      ...(rec.base !== undefined ? { base: rec.base } : {}), outcome: rec.outcome, reason: rec.reason, ...(n !== undefined ? { n } : {}),
    }
    const marker = { op: `ship-outcome(${planId})`, files: [journalRel(planId)], journalMulti: [{ stream: planId, line: entryLine(entry as unknown as Entry) }] }
    const txn = withTxn(root, marker, () => {
      appendEntry(root, planId, entry as unknown as Entry)
      return stateCommit(root, marker.files, marker.op)
    })
    return txn.ok ? 'journaled' : 'refused'
  } finally {
    lock.value()
  }
}
