import { describe, expect, it } from 'vitest'
import { reservedId } from '../src/ask.js'
import { appendEntry } from '../src/journal.js'
import { itemKey, ledgerItems, ledgerTaken, newItemId, openItems } from '../src/ledger.js'
import { ENTRY_PROGRESS } from '../src/progress.js'
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
