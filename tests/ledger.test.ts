import { describe, expect, it } from 'vitest'
import { reservedId } from '../src/ask.js'
import { appendEntry } from '../src/journal.js'
import { bookLines, bookingsOf, itemKey, ledgerItems, ledgerTaken, newItemId, openItems } from '../src/ledger.js'
import { ENTRY_PROGRESS } from '../src/progress.js'
import type { GateRunEntry } from '../src/rounds.js'
import { LEDGER_STREAM } from '../src/streams.js'
import { entryDetail } from '../src/verbs/log.js'
import { seededRepo, tmpRepo } from './helpers.js'

// Row 269. The repo ledger: witness's own `ledger` stream, folded into items that are open until
// observed gone (closed) or ended by a human (dismissed).

const SHA = 'a'.repeat(40)
const open = (id: string, over: Record<string, unknown> = {}) => ({
  t: 'ledger-open' as const, id, key: '0'.repeat(16), kind: 'booked-check', check: 'lint', plan: 'p1', gate: 'implement',
  round: 2, run_id: 'r-1', part: 'biome', part_key: `biome@${SHA}.000000000000`, tool: 'biome',
  subject: { diagnostics: { '1111111111111111': 2 } }, ...over,
})

describe('the ledger (row 269)', () => {
  it('folds open, closed and dismissed items; an item ends once; a malformed line is skipped', () => {
    const repo = tmpRepo()
    for (const e of [open('l-00000001'), open('l-00000002', { part: 'tsc' }),
      { t: 'ledger-closed', id: 'l-00000001', by: 'merge', plan: 'p2', pr: 7, tree: SHA },
      { t: 'ledger-dismissed', id: 'l-00000001', cause: 'judged-wrong', note: 'late' },
      { t: 'ledger-open', id: 42 }]) appendEntry(repo.root, LEDGER_STREAM, e as never)
    expect(ledgerItems(repo.root).map((i) => [i.id, i.state])).toEqual([['l-00000001', 'closed'], ['l-00000002', 'open']])
    expect(ledgerItems(repo.root)[0]!.end).toMatchObject({ t: 'ledger-closed', plan: 'p2' })
    expect(openItems(repo.root, { plan: 'p1', part: 'tsc' }).map((i) => i.id)).toEqual(['l-00000002'])
    expect(openItems(repo.root, { plan: 'p9' })).toEqual([])
  })

  it("an item's key names its plan, part and exact subject; a whole part's names the base it was booked against", () => {
    const k = (o: Record<string, unknown>) => itemKey(open('x', o) as never)
    expect(k({ subject: { diagnostics: { a: 1, b: 2 } } })).toBe(k({ subject: { diagnostics: { b: 2, a: 1 } } }))
    expect(k({})).not.toBe(k({ plan: 'p9' }))
    expect(k({ subject: { whole: true } })).not.toBe(k({ subject: { whole: true }, part_key: `biome@${'b'.repeat(40)}.000000000000` }))
    expect(k({})).toBe(k({ part_key: `biome@${'b'.repeat(40)}.000000000000` }))    // diagnostics hold across bases
    expect(k({})).toMatch(/^[0-9a-f]{16}$/)
    expect(newItemId()).toMatch(/^l-[0-9a-f]{8}$/)
  })

  it('ledger is a reserved id, and a stream another history holds is taken (Review Focus 4)', async () => {
    expect(reservedId('ledger')).toBe("witness's own ledger")
    const repo = await seededRepo()
    expect(ledgerTaken(repo.root)).toBeUndefined()
    appendEntry(repo.root, LEDGER_STREAM, { t: 'recap', effort: 'ledger' } as never)
    expect(ledgerTaken(repo.root)).toMatchObject({ rule: 'stream-taken' })
    const r = await repo.cli(['check'])
    expect(r.stdout + r.stderr).toContain("witness's ledger is held by a recap history — witness books and dismisses nothing until it moves")
  })

  it('a booking and a dismissal are acts, a close is bookkeeping (row 206)', () => {
    expect([ENTRY_PROGRESS['ledger-open'], ENTRY_PROGRESS['ledger-dismissed'], ENTRY_PROGRESS['ledger-closed']]).toEqual(['act', 'act', 'bookkeeping'])
  })

  it('log names each transition', () => {
    expect(entryDetail({ v: 1, ...open('l-00000001') } as never)).toBe('l-00000001 booked lint · biome · p1 implement r2 · 2 diagnostics')
    expect(entryDetail({ v: 1, ...open('l-00000001', { subject: { whole: true } }) } as never)).toBe('l-00000001 booked lint · biome · p1 implement r2 · whole part')
    expect(entryDetail({ v: 1, t: 'ledger-closed', id: 'l-00000001', by: 'merge', plan: 'p2', pr: 7 } as never)).toBe('l-00000001 closed — gone at the merge of p2 (pr #7)')
    expect(entryDetail({ v: 1, t: 'ledger-closed', id: 'l-00000001', by: 'abandon', plan: 'p1' } as never)).toBe('l-00000001 closed — p1 was abandoned')
    expect(entryDetail({ v: 1, t: 'ledger-dismissed', id: 'l-00000001', cause: 'judged-wrong', note: 'false alarm' } as never)).toBe('l-00000001 dismissed — judged-wrong: false alarm')
  })
})

// Row 274 (§3.3). The ledger's second kind: a switch-off line a judged round booked.
const offOpen = (id: string, over: Record<string, unknown> = {}) => ({
  t: 'ledger-open' as const, id, key: '0'.repeat(16), kind: 'booked-switch-off', check: 'switch-offs', plan: 'p1', gate: 'implement',
  round: 2, run_id: 'r-1', file: 'src/a.ts', token: 'eslint-disable-next-line', subject: { lines: { '1111111111111111': 1 } }, ...over,
})
// A judged round whose switch-offs check holds two lines, each partly or wholly booked.
const judged = (over: Partial<GateRunEntry> = {}) => ({ checks_only: undefined, outcome: 'stopped', round: 1, run_id: 'r', checks: [
  { name: 'diff', ok: true },
  { name: 'switch-offs', ok: false, offs: [
    { key: 'k1', token: 't', file: 'a.ts', line: 3, count: 2, booked: 1, items: ['l-00000001'] },
    { key: 'k2', token: 't', file: 'b.ts', line: 1, count: 1, booked: 1, items: ['l-00000002'] }] },
  { name: 'evidence', ok: true }], ...over }) as unknown as GateRunEntry

describe('booked switch-offs (row 274)', () => {
  it('folds a booked switch-off item; one missing its file, token or lines is skipped (row 274)', () => {
    const repo = tmpRepo()
    for (const e of [offOpen('l-00000001'), offOpen('l-00000002', { file: undefined }), offOpen('l-00000003', { token: '' }),
      offOpen('l-00000004', { subject: { lines: {} } }), offOpen('l-00000005', { subject: { lines: { k: 0 } } })]) appendEntry(repo.root, LEDGER_STREAM, e as never)
    expect(ledgerItems(repo.root)).toEqual([expect.objectContaining({ id: 'l-00000001', kind: 'booked-switch-off', file: 'src/a.ts',
      token: 'eslint-disable-next-line', subject: { lines: { '1111111111111111': 1 } }, state: 'open' })])
    expect(openItems(repo.root, { plan: 'p1', part: 'biome' })).toEqual([])
  })

  it("a switch-off item's key names its plan, file, token and lines; a lint item's key is what it was (row 274)", () => {
    // today's lint keys, computed at RED from row 269's formula
    expect(itemKey(open('x') as never)).toBe('4be5507e7e9c3d22')
    expect(itemKey(open('x', { subject: { whole: true } }) as never)).toBe('c684c70004089db8')
    const k = (o: Record<string, unknown>) => itemKey(offOpen('x', o) as never)
    expect(k({})).toMatch(/^[0-9a-f]{16}$/)
    expect(k({})).not.toBe(k({ file: 'src/b.ts' }))
    expect(k({})).not.toBe(k({ token: '@ts-ignore' }))
    expect(k({})).not.toBe(k({ plan: 'p9' }))
    expect(k({})).not.toBe(k({ subject: { lines: { '1111111111111111': 2 } } }))
    expect(k({ subject: { lines: { a: 1, b: 2 } } })).toBe(k({ subject: { lines: { b: 2, a: 1 } } }))
  })

  it('a judged round books each line its bookings leave uncovered; checks-only, malformed and human-waived stay as they were (row 274)', () => {
    expect(bookingsOf(judged(), 'switch-offs')).toEqual([{ kind: 'booked-switch-off', file: 'a.ts', token: 't', subject: { lines: { k1: 1 } } }])
    expect(bookingsOf(judged({ outcome: 'malformed' } as never), 'switch-offs')).toEqual([])
    expect(bookingsOf(judged({ checks_only: true }), 'switch-offs')).toEqual([])
    expect(bookingsOf(judged(), 'lint')).toEqual([])
    expect(bookingsOf(judged(), 'diff')).toEqual([])
  })

  it('a booked line duplicated books a fresh item, never the one the line already applies (Review Focus 2, T2e I1)', () => {
    const repo = tmpRepo()
    // l-00000001 is open for k1 (one copy) and the run's line k1 lists it in `items`: the copy left books anew
    appendEntry(repo.root, LEDGER_STREAM, offOpen('l-00000001', { file: 'a.ts', token: 't', subject: { lines: { k1: 1 } } }) as never)
    const lines = bookLines(repo.root, 'p1', 'implement', judged(), bookingsOf(judged(), 'switch-offs'))
    expect(lines).toEqual([{ id: expect.not.stringMatching(/^l-00000001$/), entry: expect.objectContaining({
      kind: 'booked-switch-off', check: 'switch-offs', plan: 'p1', file: 'a.ts', token: 't', subject: { lines: { k1: 1 } } }) }])
    // the same booking with no item applied reuses the open one: the idempotence key
    const fresh = judged({ checks: [{ name: 'switch-offs', ok: false, offs: [{ key: 'k1', token: 't', file: 'a.ts', line: 3, count: 1 }] }] } as never)
    expect(bookLines(repo.root, 'p1', 'implement', fresh, bookingsOf(fresh, 'switch-offs'))).toEqual([{ id: 'l-00000001' }])
  })

  it('log names a switch-off booking: its token and file, spelled out (Review Focus 3)', () => {
    expect(entryDetail({ v: 1, ...offOpen('l-00000001') } as never)).toBe('l-00000001 booked switch-offs · eslint-disable-next-line in src/a.ts · p1 implement r2')
    const odd = `src/we${String.fromCodePoint(0x202e)}ird.ts`
    expect(entryDetail({ v: 1, ...offOpen('l-00000001', { file: odd }) } as never)).toContain('eslint-disable-next-line in src/we\\u{202e}ird.ts')
  })
})
