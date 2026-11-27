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

const dropOpen = (id: string, over: Record<string, unknown> = {}) => ({
  t: 'ledger-open' as const, id, key: '0'.repeat(16), kind: 'booked-dropped', check: 'switch-offs', plan: 'p1', gate: 'implement',
  round: 2, run_id: 'r-1', spec: 'auth-refresh', base: { passed: 2, skipped: 0 }, subject: { cases: 1 }, ...over,
})
describe('booked lost tests (row 276)', () => {
  it('folds a booked loss; one missing its spec, base or cases is skipped (row 276)', () => {
    const repo = tmpRepo()
    for (const e of [dropOpen('l-00000001'), dropOpen('l-00000002', { spec: 'Bad Id' }), dropOpen('l-00000003', { base: { passed: -1, skipped: 0 } }),
      dropOpen('l-00000004', { subject: { cases: 0 } }), dropOpen('l-00000005', { base: { passed: 2 } })]) appendEntry(repo.root, LEDGER_STREAM, e as never)
    expect(ledgerItems(repo.root)).toEqual([expect.objectContaining({ id: 'l-00000001', kind: 'booked-dropped', spec: 'auth-refresh',
      base: { passed: 2, skipped: 0 }, subject: { cases: 1 }, state: 'open' })])
  })
  it("a loss's key names its plan, spec, base and cases; the other kinds' keys are what they were (row 276)", () => {
    expect(itemKey(open('x') as never)).toBe('4be5507e7e9c3d22')
    expect(itemKey(offOpen('x') as never)).toBe('4367487ea42fc1c0')                // today's switch-off key, computed at RED
    const k = (o: Record<string, unknown>) => itemKey(dropOpen('x', o) as never)
    expect(k({})).toMatch(/^[0-9a-f]{16}$/)
    expect(k({})).not.toBe(k({ spec: 'other' })); expect(k({})).not.toBe(k({ subject: { cases: 2 } }))
    expect(k({})).not.toBe(k({ plan: 'p2' })); expect(k({})).not.toBe(k({ base: { passed: 3, skipped: 0 } }))
    expect(k({})).not.toBe(k({ base: { passed: 2, skipped: 1 } }))
  })
  it('a judged round books each loss its bookings leave uncovered, with its base counts (row 276)', () => {
    const loss = { kind: 'dropped', key: 'd'.repeat(16), spec: 'auth-refresh', count: 2, base: { passed: 3, failed: 0, skipped: 1 }, plan: { passed: 1, failed: 0, skipped: 1 } }
    const run = { checks_only: undefined, outcome: 'stopped', round: 1, run_id: 'r', checks: [
      { name: 'switch-offs', ok: false, offs: [loss, { ...loss, key: 'e'.repeat(16), spec: 'b', count: 1, booked: 1, items: ['l-00000009'] }] }] }
    expect(bookingsOf(run as never, 'switch-offs')).toEqual([
      { kind: 'booked-dropped', spec: 'auth-refresh', base: { passed: 3, skipped: 1 }, subject: { cases: 2 } }])
  })
  it('log names a booked loss by its spec, with its cases (row 276)', () => {
    expect(entryDetail({ v: 1, ...dropOpen('l-00000001') } as never)).toBe('l-00000001 booked switch-offs · tests of auth-refresh · p1 implement r2 · 1 case')
  })
})

// Row 278. A loosened hit booked: per (tool, rule) the hidden spots it waives, or a part's restored definitions.
const looseOpen = (id: string, over: Record<string, unknown> = {}) => ({
  t: 'ledger-open' as const, id, key: '0'.repeat(16), kind: 'booked-loosened', check: 'switch-offs', plan: 'p1', gate: 'implement',
  round: 2, run_id: 'r-1', tool: 'biome', rule: 'lint/test/noBad', subject: { hidden: { [`${'a'.repeat(16)}`]: { file: 'src/a.ts', copies: 1 } } }, ...over,
})
const partOpen = (id: string, over: Record<string, unknown> = {}) => ({
  t: 'ledger-open' as const, id, key: '0'.repeat(16), kind: 'booked-loosened', check: 'switch-offs', plan: 'p1', gate: 'implement',
  round: 2, run_id: 'r-1', part: 'lint', subject: { defs: { 'package.json#scripts': `json:${'b'.repeat(16)}`, '.gitignore': null } }, ...over,
})
const hid = (key: string, over: Record<string, unknown> = {}) =>
  ({ kind: 'loosened', key, count: 1, tool: 'biome', rule: 'lint/test/noBad', file: 'src/a.ts', line: 1, ...over })
describe('booked loosened hits (row 278)', () => {
  it('folds a booked hidden rule and a booked part; one with a bad tool, rule, spot or definition is skipped (row 278)', () => {
    const repo = tmpRepo()
    for (const e of [looseOpen('l-00000001'), partOpen('l-00000002'), looseOpen('l-00000003', { tool: 'pylint' }),
      looseOpen('l-00000004', { rule: 'has space' }), looseOpen('l-00000005', { subject: { hidden: { k: { file: '', copies: 1 } } } }),
      looseOpen('l-00000006', { subject: { hidden: { k: { file: 'a', copies: 0 } } } }), looseOpen('l-00000007', { subject: { hidden: {} } }),
      partOpen('l-00000008', { subject: { defs: {} } }), partOpen('l-00000009', { subject: { defs: { a: 'nope' } } }),
      looseOpen('l-0000000a', { part: 'lint' }), looseOpen('l-0000000b', { rule: '' }),
      looseOpen('l-0000000c', { subject: { hidden: { k: { file: 'a', copies: 1, lineless: false } } } })]) appendEntry(repo.root, LEDGER_STREAM, e as never)
    expect(ledgerItems(repo.root).map((i) => i.id)).toEqual(['l-00000001', 'l-00000002', 'l-0000000b'])
    expect(ledgerItems(repo.root)[1]).toMatchObject({ kind: 'booked-loosened', part: 'lint', subject: { defs: { '.gitignore': null } } })
  })
  it('the fourth key formula; the other three never move (row 278)', () => {
    expect(itemKey(open('x') as never)).toBe('4be5507e7e9c3d22')
    expect(itemKey(offOpen('x') as never)).toBe('4367487ea42fc1c0')
    expect(itemKey(dropOpen('x') as never)).toBe('379a201944dc7b85')                // today's loss key, computed at RED
    const k = (o: Record<string, unknown>) => itemKey(looseOpen('x', o) as never)
    expect(k({})).toMatch(/^[0-9a-f]{16}$/)
    expect(k({})).not.toBe(k({ tool: 'eslint' })); expect(k({})).not.toBe(k({ rule: 'other' })); expect(k({})).not.toBe(k({ plan: 'p2' }))
    expect(k({})).not.toBe(k({ subject: { hidden: { [`${'a'.repeat(16)}`]: { file: 'src/a.ts', copies: 2 } } } }))
    const p = (o: Record<string, unknown>) => itemKey(partOpen('x', o) as never)
    expect(p({})).not.toBe(p({ part: 'other' })); expect(p({})).not.toBe(p({ subject: { defs: { '.gitignore': null } } }))
    expect(p({ subject: { defs: { a: null, b: null } } })).toBe(p({ subject: { defs: { b: null, a: null } } }))
  })
  it('a judged round books its unbooked hidden spots one booking per (tool, rule), and each loosened part its own (row 278)', () => {
    const part = { kind: 'loosened', key: 'p'.repeat(16), count: 1, part: 'lint', defs: { '.gitignore': 'c'.repeat(40) } }
    const run = { checks_only: undefined, outcome: 'stopped', round: 1, run_id: 'r', checks: [{ name: 'switch-offs', ok: false, offs: [
      hid('k1'), hid('k2', { file: 'src/b.ts', line: undefined, lineless: true }), hid('k3', { rule: 'other' }),
      hid('k4', { count: 2, booked: 1, items: ['l-00000009'] }), hid('k5', { booked: 1, items: ['l-00000009'] }), part] }] }
    expect(bookingsOf(run as never, 'switch-offs')).toEqual([
      { kind: 'booked-loosened', tool: 'biome', rule: 'lint/test/noBad',
        subject: { hidden: { k1: { file: 'src/a.ts', copies: 1 }, k2: { file: 'src/b.ts', copies: 1, lineless: true }, k4: { file: 'src/a.ts', copies: 1 } } } },
      { kind: 'booked-loosened', tool: 'biome', rule: 'other', subject: { hidden: { k3: { file: 'src/a.ts', copies: 1 } } } },
      { kind: 'booked-loosened', part: 'lint', subject: { defs: { '.gitignore': 'c'.repeat(40) } } },
    ])
  })
  it('an item the hit already applies is never reused; with none applied the open one is (row 278)', () => {
    const repo = tmpRepo()
    appendEntry(repo.root, LEDGER_STREAM, { ...looseOpen('l-00000001', { subject: { hidden: { k1: { file: 'src/a.ts', copies: 1 } } } }),
      key: itemKey(looseOpen('x', { subject: { hidden: { k1: { file: 'src/a.ts', copies: 1 } } } }) as never) } as never)
    const run = (applied: boolean) => ({ checks_only: undefined, outcome: 'stopped', round: 3, run_id: 'r', checks: [{ name: 'switch-offs', ok: false, offs: [
      hid('k1', applied ? { count: 2, booked: 1, items: ['l-00000001'] } : {})] }] }) as never
    expect(bookLines(repo.root, 'p1', 'implement', run(true), bookingsOf(run(true), 'switch-offs'))).toEqual([{ id: expect.not.stringMatching(/^l-00000001$/),
      entry: expect.objectContaining({ kind: 'booked-loosened', check: 'switch-offs', tool: 'biome', rule: 'lint/test/noBad', subject: { hidden: { k1: { file: 'src/a.ts', copies: 1 } } } }) }])
    expect(bookLines(repo.root, 'p1', 'implement', run(false), bookingsOf(run(false), 'switch-offs'))).toEqual([{ id: 'l-00000001' }])
  })
  it('log names a booked hidden rule and a booked part (row 278)', () => {
    expect(entryDetail({ v: 1, ...looseOpen('l-00000001') } as never)).toBe('l-00000001 booked switch-offs · biome lint/test/noBad hidden by check definitions · p1 implement r2 · 1 spot')
    expect(entryDetail({ v: 1, ...partOpen('l-00000002') } as never)).toBe('l-00000002 booked switch-offs · lint part lint loosened · p1 implement r2 · 2 definitions')
  })
})

// Row 284. A tolerated set: per (tool, rule) the old spots a lint guard's proof (or a human's booking) tolerates.
const K1 = '0123456789abcdef'
const tolOpen = (id: string, over: Record<string, unknown> = {}) => ({
  t: 'ledger-open' as const, id, key: '0'.repeat(16), kind: 'tolerated-set', check: 'tolerated', plan: 'p1', gate: 'implement',
  round: 2, run_id: 'r-1', tool: 'eslint', rule: 'no-x', origin: 'guard', anchor: 'src/token.ts',
  subject: { spots: { [K1]: { file: 'src/a.ts', copies: 2 } } }, ...over,
})
const tolRun = (checksOnly: boolean, tolerated: unknown[]) => ({ checks_only: checksOnly ? true : undefined, outcome: 'stopped', round: 3, run_id: 'r-3',
  checks: [{ name: 'markers', ok: true }, { name: 'tolerated', ok: false, tolerated }] }) as never
describe('tolerated sets (row 284)', () => {
  it('a tolerated-set item opens and keys over its spots; the four other formulas keep their pinned keys (row 284)', () => {
    const repo = tmpRepo()
    appendEntry(repo.root, LEDGER_STREAM, tolOpen('l-00000001') as never)
    expect(ledgerItems(repo.root)).toEqual([expect.objectContaining({ id: 'l-00000001', kind: 'tolerated-set', tool: 'eslint', rule: 'no-x', origin: 'guard', state: 'open' })])
    const spots = { [K1]: { file: 'src/a.ts', copies: 2 } }
    expect(itemKey({ kind: 'tolerated-set', check: 'tolerated', plan: 'p', tool: 'eslint', rule: 'no-x', subject: { spots } } as never)).toBe('ec15f22426444f86')  // the fifth formula, computed at GREEN
    const k = (o: Record<string, unknown>) => itemKey(tolOpen('x', o) as never)
    expect(k({})).not.toBe(k({ tool: 'biome' })); expect(k({})).not.toBe(k({ rule: 'no-y' })); expect(k({})).not.toBe(k({ plan: 'p2' }))
    expect(k({})).not.toBe(k({ subject: { spots: { [K1]: { file: 'src/a.ts', copies: 3 } } } }))
    expect(k({})).toBe(k({ origin: 'book', anchor: undefined }))
    expect(itemKey(open('x') as never)).toBe('4be5507e7e9c3d22')
    expect(itemKey(offOpen('x') as never)).toBe('4367487ea42fc1c0')
    expect(itemKey(dropOpen('x') as never)).toBe('379a201944dc7b85')
  })
  it('an open with a malformed tolerated subject is no item (row 284)', () => {
    const repo = tmpRepo()
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [i.toString(16).padStart(16, '0'), { file: 'a.ts', copies: 1 }]))
    for (const e of [tolOpen('l-00000001', { subject: { spots: {} } }), tolOpen('l-00000002', { subject: { spots: { [K1]: { file: 'a.ts', copies: 0 } } } }),
      tolOpen('l-00000003', { subject: { spots: { xyz: { file: 'a.ts', copies: 1 } } } }), tolOpen('l-00000004', { origin: 'x' }),
      tolOpen('l-00000005', { tool: 'rome' }), tolOpen('l-00000006', { subject: { spots: many } }), tolOpen('l-00000007', { rule: 'has space' }),
      tolOpen('l-00000008', { anchor: '' }), tolOpen('l-00000009', { subject: { spots: { [K1]: { file: '', copies: 1 } } } }),
      tolOpen('l-0000000a', { check: 'lint' }), tolOpen('l-0000000b', { origin: 'book', anchor: undefined })]) appendEntry(repo.root, LEDGER_STREAM, e as never)
    expect(ledgerItems(repo.root).map((i) => i.id)).toEqual(['l-0000000b'])
  })
  it('a re-proof close ends an item, as the merge and the abandon do (row 284)', () => {
    const repo = tmpRepo()
    appendEntry(repo.root, LEDGER_STREAM, tolOpen('l-00000001') as never)
    appendEntry(repo.root, LEDGER_STREAM, { t: 'ledger-closed', id: 'l-00000001', by: 'guard', plan: 'p1' } as never)
    expect(ledgerItems(repo.root)[0]).toMatchObject({ state: 'closed', end: { by: 'guard' } })
  })
  it("bookingsOf books the tolerated check's growth per rule, never past the cap (row 284)", () => {
    const verdicts = [
      { tool: 'eslint', rule: 'no-x', state: 'measured', spots: 2, allowed: 1, grown: { k1: { file: 'a.ts', copies: 1 } } },
      { tool: 'biome', rule: 'lint/a/b', state: 'measured', spots: 503, allowed: 0, grown: {}, over: 3 },
      { tool: 'biome', rule: 'lint/c/d', state: 'not-measured', why: 'biome-unwired' },
      { tool: 'eslint', rule: 'no-y', state: 'measured', spots: 1, allowed: 1, grown: {} },
    ]
    expect(bookingsOf(tolRun(true, verdicts), 'tolerated')).toEqual([{ kind: 'tolerated-set', tool: 'eslint', rule: 'no-x', subject: { spots: { k1: { file: 'a.ts', copies: 1 } } } }])
    expect(bookingsOf(tolRun(false, verdicts), 'tolerated')).toEqual([])
  })
  it('bookLines opens a tolerated set for a booking, and reuses an open one by key (row 284)', () => {
    const repo = tmpRepo()
    const spots = { [K1]: { file: 'a.ts', copies: 1 } }
    const run = tolRun(true, [{ tool: 'eslint', rule: 'no-x', state: 'measured', spots: 1, allowed: 0, grown: spots }])
    const [first] = bookLines(repo.root, 'p1', 'implement', run, bookingsOf(run, 'tolerated'), 'mine')
    expect(first!.entry).toEqual({ v: 1, t: 'ledger-open', id: first!.id, key: itemKey({ kind: 'tolerated-set', check: 'tolerated', plan: 'p1', tool: 'eslint', rule: 'no-x', subject: { spots } } as never),
      kind: 'tolerated-set', check: 'tolerated', plan: 'p1', gate: 'implement', round: 3, run_id: 'r-3', note: 'mine', tool: 'eslint', rule: 'no-x', origin: 'book', subject: { spots } })
    appendEntry(repo.root, LEDGER_STREAM, first!.entry as never)
    expect(bookLines(repo.root, 'p1', 'implement', run, bookingsOf(run, 'tolerated'))).toEqual([{ id: first!.id }])
  })
  it("log names a tolerated set's open and its close by a re-proof (row 284)", () => {
    expect(entryDetail({ v: 1, ...tolOpen('l-00000001') } as never)).toBe('opened tolerated set l-00000001 · eslint no-x · 2 spots')
    expect(entryDetail({ v: 1, t: 'ledger-closed', id: 'l-00000001', by: 'guard', plan: 'p1' } as never)).toBe('l-00000001 closed by a re-proof of its guard')
  })
})
