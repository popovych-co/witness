import { describe, expect, it } from 'vitest'
import { CHECKS, checksSignature, checkTier, checkWaiver, runChecks } from '../src/checks.js'
import type { GateCheck, PartState } from '../src/rounds.js'

const step = (name: string, ok: boolean, ran: string[]) => ({ name, run: (): GateCheck => { ran.push(name); return { name, ok } } })

describe('the check registry (row 264)', () => {
  it('runs a gate\'s steps withholding tier first, then judged, each in registry order', async () => {
    const ran: string[] = []
    const r = await runChecks(['drift-lane', 'tests', 'implement-gate', 'lint'].map((n) => step(n, true, ran)))
    expect(ran).toEqual(['lint', 'implement-gate', 'tests', 'drift-lane'])
    expect(r.withheld).toBeUndefined()
    expect(r.checks.every((c) => typeof c.duration_ms === 'number')).toBe(true)
  })
  it('stops at the first withholding red and names it; no judged step runs', async () => {
    const ran: string[] = []
    const r = await runChecks([step('drift-lane', true, ran), step('lint', false, ran), step('evidence', true, ran)])
    expect(ran).toEqual(['lint'])
    expect(r).toMatchObject({ withheld: 'lint', checks: [{ name: 'lint', ok: false }] })
  })
  it('a judged red never cuts the round', async () => {
    const ran: string[] = []
    const r = await runChecks([step('evidence', false, ran), step('lint', true, ran), step('drift-lane', true, ran)])
    expect(ran).toEqual(['lint', 'evidence', 'drift-lane'])
    expect(r.withheld).toBeUndefined()
  })
  it('a step the registry lacks, or one naming another check, is a witness bug', async () => {
    await expect(runChecks([{ name: 'nope', run: () => ({ name: 'nope', ok: true }) }])).rejects.toThrow(/nope/)
    await expect(runChecks([{ name: 'lint', run: () => ({ name: 'tests', ok: true }) }])).rejects.toThrow(/lint/)
  })
  it("lint's waiver is the human's, switch-offs' the judge's, and no other check has one (rows 270, 273)", () => {
    expect(CHECKS.filter((c) => c.waiver !== undefined).map((c) => [c.name, c.waiver])).toEqual([['lint', 'human'], ['switch-offs', 'judge']])
    expect(checkWaiver('lint')).toBe('human')
    expect(checkWaiver('markers')).toBeUndefined()
  })
  it('a booking made since a round moves the signature: booked is a state term (row 270)', () => {
    const lint = (state: PartState): GateCheck[] => [{ name: 'lint', ok: state === 'booked', parts: [{ part: 'ui', state, key: 'k1' }] }]
    expect(checksSignature(lint('booked'))).not.toBe(checksSignature(lint('not-judged')))
  })
  it('lists each check once, the withholding tier first', () => {
    const names = CHECKS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    const first = CHECKS.findIndex((c) => c.tier === 'judged')
    expect(CHECKS.slice(first).every((c) => c.tier === 'judged')).toBe(true)
  })
  it('the signature: pending and not-measured are one term; a part\'s state and key join it; detail and duration never do', () => {
    const lint = (state: PartState, key?: string, extra: Partial<GateCheck> = {}): GateCheck[] =>
      [{ name: 'lint', ok: false, parts: [{ part: 'ui', state, ...(key !== undefined ? { key } : {}) }], ...extra }]
    expect(checksSignature(lint('pending', 'k1'))).toBe(checksSignature(lint('not-measured', 'k1')))
    expect(checksSignature(lint('pending', 'k1'))).not.toBe(checksSignature(lint('pending', 'k2')))
    expect(checksSignature(lint('pending', 'k1'))).not.toBe(checksSignature(lint('red', 'k1')))
    expect(checksSignature(lint('red', 'k1', { detail: 'a', duration_ms: 1 }))).toBe(checksSignature(lint('red', 'k1', { detail: 'b', duration_ms: 9 })))
  })
})

describe('the switch-offs check in the registry (row 273)', () => {
  it("switch-offs is judged and the judge's to waive, last in the registry (rows 273, 275)", () => {
    expect([checkTier('switch-offs'), checkWaiver('switch-offs')]).toEqual(['judged', 'judge'])
    expect(CHECKS.at(-1)!.name).toBe('switch-offs')
  })
  it('the signature never reads owes or the tests effect (row 275)', () => {
    expect(checksSignature([{ name: 'switch-offs', ok: true, owes: [{ kind: 'base-tests', key: 'k' }], tests_effect: { read: 'not-checked', why: 'w' } } as never]))
      .toBe(checksSignature([{ name: 'switch-offs', ok: true }]))
  })
  it("the signature reads a lost spec by its key and unbooked cases (row 275)", () => {
    const loss = { kind: 'dropped', key: 'd'.repeat(16), spec: 'a', count: 2, base: { passed: 2, failed: 0, skipped: 0 }, plan: { passed: 0, failed: 0, skipped: 0 } }
    expect(checksSignature([{ name: 'switch-offs', ok: false, offs: [loss] } as never])).toBe(`switch-offs:false::offs=${'d'.repeat(16)}x2`)
  })
  it('the signature reads each unbooked switch-off line with its copies; a check without offs reads as before (row 273)', () => {
    const sig = (offs: unknown[]) => checksSignature([{ name: 'switch-offs', ok: false, offs } as never])
    const line = { key: 'aaaaaaaaaaaaaaaa', token: 't', file: 'f', line: 1, count: 2 }
    expect(sig([line])).toBe('switch-offs:false::offs=aaaaaaaaaaaaaaaax2')
    expect(sig([{ ...line, booked: 1 }])).toBe('switch-offs:false::offs=aaaaaaaaaaaaaaaax1')
    expect(sig([{ ...line, booked: 2 }])).toBe('switch-offs:false::offs=')
    expect(sig([{ ...line, key: 'b'.repeat(16) }, line])).toBe(`switch-offs:false::offs=aaaaaaaaaaaaaaaax2+${'b'.repeat(16)}x2`)
    expect(checksSignature([{ name: 'diff', ok: true }])).toBe('diff:true:')
  })
})
