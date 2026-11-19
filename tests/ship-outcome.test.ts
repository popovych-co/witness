import { describe, expect, it } from 'vitest'
import { appendEntry, readStream, type Entry } from '../src/journal.js'
import { movesFlow } from '../src/progress.js'
import { journalOutcome, latestOutcome, standingRecord } from '../src/ship-outcome.js'
import { commitEntry, plannedRepo, type TestRepo } from './helpers.js'

// Row 242 (design §4.3.2, R14). `witness ship` journals the outcome it ends on as one entry kind. A
// transient or pending record always journals, counting its run; any other is skipped when the
// stream's latest entry is the same record, compared on its fields alone. A record stands only while
// it is the plan stream's latest entry and the worktree's HEAD is its head.

const PLAN = 'auth-refresh-plan-1'
const HEAD = 'a'.repeat(40)
const MERGE = { pr: 7, head: HEAD, base: 'b'.repeat(40), outcome: 'merge' as const, reason: 'no CI checks reported' }
const outcomes = (repo: TestRepo) => readStream(repo.root, PLAN).filter((e) => e.t === 'ship-outcome') as unknown as Array<Record<string, unknown>>

describe('the ship-outcome record (row 242)', () => {
  it('a merge record identical in its fields to the latest entry is skipped, whatever w and ctx say', async () => {
    const repo = await plannedRepo()
    expect(journalOutcome(repo.root, PLAN, MERGE)).toBe('journaled')
    expect(journalOutcome(repo.root, PLAN, MERGE)).toBe('same')
    expect(outcomes(repo)).toHaveLength(1)
    // the same record written by another CLI version and session is still the same record
    commitEntry(repo, PLAN, { t: 'ship-outcome', artifact: PLAN, ...MERGE, w: '0.0.1', ctx: { session: 'other' } })
    expect(journalOutcome(repo.root, PLAN, MERGE)).toBe('same')
    // a field that differs is a new record
    expect(journalOutcome(repo.root, PLAN, { ...MERGE, reason: 'no passing CI check' })).toBe('journaled')
    expect(outcomes(repo)).toHaveLength(3)
  }, 60_000)

  it('transient and pending records always journal, n counting the run', async () => {
    const repo = await plannedRepo()
    const rec = { pr: 7, head: HEAD, outcome: 'transient' as const, reason: 'the fetch failed' }
    for (let i = 0; i < 3; i++) expect(journalOutcome(repo.root, PLAN, rec)).toBe('journaled')
    expect(outcomes(repo).map((e) => e.n)).toEqual([1, 2, 3])
    journalOutcome(repo.root, PLAN, { ...rec, outcome: 'pending', reason: 'checks still pending' })
    expect(outcomes(repo).at(-1)?.n).toBe(4)
    journalOutcome(repo.root, PLAN, MERGE)
    journalOutcome(repo.root, PLAN, rec)
    expect(outcomes(repo).at(-1)?.n).toBe(1)
    expect(outcomes(repo).filter((e) => e.outcome === 'merge').at(-1)).not.toHaveProperty('n')
  }, 60_000)

  it('a record stands only while it is the latest entry and HEAD is its head', async () => {
    const repo = await plannedRepo()
    journalOutcome(repo.root, PLAN, MERGE)
    let entries = readStream(repo.root, PLAN)
    expect(latestOutcome(entries)).toMatchObject({ outcome: 'merge', pr: 7, head: HEAD })
    expect(standingRecord(entries, HEAD)).toMatchObject({ outcome: 'merge' })
    expect(standingRecord(entries, 'c'.repeat(40))).toBeUndefined()           // HEAD moved
    expect(standingRecord(entries, undefined)).toBeUndefined()
    appendEntry(repo.root, PLAN, { v: 1, t: 'retry', artifact: PLAN } as never)   // any later entry ends it
    entries = readStream(repo.root, PLAN)
    expect(latestOutcome(entries)).toBeUndefined()
    expect(standingRecord(entries, HEAD)).toBeUndefined()
    // a transient record never stands: it is drive's to re-check, not the human's
    journalOutcome(repo.root, PLAN, { head: HEAD, outcome: 'transient', reason: 'offline' })
    expect(standingRecord(readStream(repo.root, PLAN), HEAD)).toBeUndefined()
  }, 60_000)

  it('ENTRY_PROGRESS classes ship-outcome as an act', () => {
    expect(movesFlow({ v: 1, t: 'ship-outcome', artifact: PLAN, ...MERGE } as unknown as Entry)).toBe(true)
  })
})
