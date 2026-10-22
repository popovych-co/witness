import { describe, expect, it } from 'vitest'
import type { Entry } from '../src/journal.js'
import type { CanonDoc } from '../src/scan.js'
import { checkStep, closedAt, closingIndex, implementGated, openRed, stepProgress, stepsLine } from '../src/steps.js'

const planDoc = (steps: Array<Record<string, unknown>>): CanonDoc =>
  ({ rel: 'plans/p.md', meta: { id: 'p', type: 'plan', parent: 'x', steps }, body: '', violations: [], satisfiedNeeds: [] })

const plan = planDoc([{ id: 's1', criteria: ['ac'] }, { id: 's2', criteria: ['ac'] }, { id: 's3', scaffolding: true }])
const red = (step?: string, x = {}) => ({ v: 1, t: 'test-evidence', artifact: 'p', phase: 'red', tests: [{ name: 'a @spec:x', ok: false }], ...(step ? { step } : {}), ...x })
const green = (step?: string, ok = true) => ({ v: 1, t: 'test-evidence', artifact: 'p', phase: 'green', tests: [{ name: 'a @spec:x', ok }], ...(step ? { step } : {}) })
const close = (step: string) => ({ v: 1, t: 'step-close', artifact: 'p', step })

describe('step progress (row 191 §4.3)', () => {
  it('a tagged red→green closes the step at the green', () => {
    const p = stepProgress(plan, [red('s1'), green('s1')] as Entry[])
    expect(p).toMatchObject({ known: true, done: 1, next: { id: 's2' } })
    expect(closedAt(p, 1)).toBe('s1')
  })
  it('a re-recorded green changes nothing', () => {
    const p = stepProgress(plan, [red('s1'), green('s1'), green('s1')] as Entry[])
    expect(closedAt(p, 2)).toBeUndefined()
  })
  it('closes nothing without a red, on a vacuous red, or on a failing green', () => {
    expect(stepProgress(plan, [green('s1')] as Entry[])).toMatchObject({ done: 0 })
    expect(stepProgress(plan, [red('s1', { vacuous: true, tests: [{ name: 'a', ok: true }] }), green('s1')] as Entry[])).toMatchObject({ done: 0 })
    expect(stepProgress(plan, [red('s1'), green('s1', false)] as Entry[])).toMatchObject({ done: 0 })
  })
  it('closes a scaffolding step at its step-close', () => {
    expect(stepProgress(plan, [close('s3')] as Entry[])).toMatchObject({ done: 1, next: { id: 's1' } })
  })
  it('next is the first unfinished step in manifest order', () => {
    expect(stepProgress(plan, [red('s2'), green('s2')] as Entry[])).toMatchObject({ next: { id: 's1' } })
  })
  it('untagged evidence before the first implement gate run makes progress unknown', () => {
    expect(stepProgress(plan, [red(), green()] as Entry[])).toEqual({ known: false })
  })
  it('untagged evidence after an implement gate run is a fix round', () => {
    const gate = { v: 1, t: 'gate-run', gate: 'implement' }
    expect(stepProgress(plan, [red('s1'), green('s1'), gate, red(), green()] as Entry[])).toMatchObject({ known: true, done: 1 })
  })
  it('only an implement gate run ends the pre-gate window', () => {
    const planGate = { v: 1, t: 'gate-run', gate: 'plan' }
    expect(implementGated([planGate] as Entry[])).toBe(false)
    expect(implementGated([planGate, { v: 1, t: 'gate-run', gate: 'implement' }] as Entry[])).toBe(true)
    expect(stepProgress(plan, [planGate, red(), green()] as Entry[])).toEqual({ known: false })
  })
  it('renders steps:', () => {
    expect(stepsLine(stepProgress(plan, [red('s1'), green('s1')] as Entry[]))).toBe('1/3 done · next s2')
    expect(stepsLine(stepProgress(plan, [red('s1'), green('s1'), red('s2'), green('s2'), close('s3')] as Entry[]))).toBe('3/3 done')
    expect(stepsLine({ known: false })).toBe('unknown (evidence predates step tags)')
  })
  it('openRed holds between a tagged red and its closing green', () => {
    expect(openRed([red('s1')] as Entry[], 's1')).toBe(true)
    expect(openRed([red('s1'), green('s1')] as Entry[], 's1')).toBe(false)
  })
  it.each([
    ['nope', 'evidence', 'unknown-step'], ['s3', 'evidence', 'scaffolding-step'],
    ['s1', 'close', 'criteria-step'], [undefined, 'close', 'required'],
  ])('checkStep(%s, %s) refuses %s', (step, verb, rule) => {
    expect(checkStep(plan, [], step, verb as 'evidence' | 'close')[0]).toMatchObject({ field: '--step', rule })
  })
  // Plan's call 4: owed only where the CLI can tell. After the first implement gate an untagged
  // cycle is a fix round, and a legacy plan's evidence never named its steps.
  it('checkStep requires a step for evidence while progress is known and no implement gate has run', () => {
    expect(checkStep(plan, [red('s1'), green('s1')] as Entry[], undefined, 'evidence')).toEqual([{
      field: '--step', rule: 'step-required', got: 'absent',
      want: "--step <id> — every cycle before the first implement gate is a plan step's · steps 1/3 done · next s2",
    }])
    expect(checkStep(plan, [red('s1'), green('s1'), { v: 1, t: 'gate-run', gate: 'implement' }] as Entry[], undefined, 'evidence')).toEqual([])
    expect(checkStep(plan, [red(), green()] as Entry[], undefined, 'evidence')).toEqual([])
  })
  // step-close's already-closed check reads the step alone (Plan's call 6): a close stays found
  // where a legacy plan's untagged evidence leaves the progress unknown.
  it('closingIndex finds a scaffolding close on a legacy plan', () => {
    const entries = [red(), green(), close('s3')] as Entry[]
    expect(stepProgress(plan, entries)).toEqual({ known: false })
    expect(closingIndex({ id: 's3', kind: 'scaffolding' }, entries)).toBe(2)
  })
})
