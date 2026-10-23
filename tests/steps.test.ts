import { describe, expect, it } from 'vitest'
import type { Entry } from '../src/journal.js'
import type { CanonDoc } from '../src/scan.js'
import {
  checkStep, closedAt, closingIndex, implementGated, lastRedVacuous, openRed, redCycleClosed, redInFlight, redOpenStep, stepProgress,
  stepsLine,
} from '../src/steps.js'

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
  // A green with no outcome observed nothing, so it closes nothing, though none of its tests failed.
  it('closes nothing on a green with no outcome', () => {
    expect(stepProgress(plan, [red('s1'), { ...green('s1'), tests: [] }] as Entry[])).toMatchObject({ done: 0, next: { id: 's1' } })
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
  // Final review I1. A red is in flight wherever it stands: ahead of the first unclosed step, or
  // re-opened on a closed one. Its step is named; an untagged red names none, and a vacuous one
  // opens nothing.
  it('redOpenStep names the step of the red in flight, wherever it stands', () => {
    expect(redOpenStep(plan, [red('s2')] as Entry[])).toBe('s2')
    expect(redOpenStep(plan, [red('s1'), green('s1'), red('s1')] as Entry[])).toBe('s1')
    expect(redOpenStep(plan, [red('s2'), red('s1')] as Entry[])).toBe('s1')
    expect(redOpenStep(plan, [red('s1'), green('s1')] as Entry[])).toBeUndefined()
    expect(redOpenStep(plan, [red(), red('s2', { vacuous: true, tests: [{ name: 'a @spec:x', ok: true }] })] as Entry[])).toBeUndefined()
    // a step an amend removed is no step of the plan, and its red routes nothing
    expect(redOpenStep(plan, [red('gone')] as Entry[])).toBeUndefined()
  })
  // Re-review. A red is open at the evidence level (D192: while the latest non-vacuous run saw a
  // failure). Every run executes the parent tag's whole suite, so a passing green clears it
  // whatever step it names, or none; a failing green leaves it open and a vacuous red changes
  // nothing. Step closure is untouched: s1 still waits for a green tagged with it.
  it('a red is open until any passing green, whatever step it names', () => {
    const vacuous = red('s1', { vacuous: true, tests: [{ name: 'a @spec:x', ok: true }] })
    expect(redInFlight([red('s1'), green()] as Entry[])).toBe(false)
    expect(openRed([red('s1'), green()] as Entry[], 's1')).toBe(false)
    expect(redInFlight([red('s1'), green('s2')] as Entry[])).toBe(false)
    expect(stepProgress(plan, [red('s1'), green('s2')] as Entry[])).toMatchObject({ done: 0, next: { id: 's1' } })
    expect(redOpenStep(plan, [red('s1'), green('s1', false)] as Entry[])).toBe('s1')
    expect(redOpenStep(plan, [red('s1'), vacuous] as Entry[])).toBe('s1')
    // one red is open at a time: the latest
    expect(redOpenStep(plan, [red('s1'), red('s2')] as Entry[])).toBe('s2')
    expect(openRed([red('s1'), red('s2')] as Entry[], 's1')).toBe(false)
    // untagged (a fix round's, a legacy cycle's): in flight, and no step's to route
    expect(redInFlight([red()] as Entry[])).toBe(true)
    expect(redOpenStep(plan, [red()] as Entry[])).toBeUndefined()
  })
  // D192. One reading for every reader: a red is in flight while the latest non-vacuous run saw a
  // failure, and its step is the latest genuine red's. Read from the latest red alone, `next` and the
  // verdict at a step close disagreed on the two shapes below.
  it('a red is in flight while the latest non-vacuous run saw a failure', () => {
    // A green that failed after a passing one: the last green failed, so a red is in flight again,
    // and s1's own cycle stays closed. Closing is untouched.
    const regressed = [red('s1'), green('s1'), green('s1', false)] as Entry[]
    expect(redInFlight(regressed)).toBe(true)
    expect(redOpenStep(plan, regressed)).toBe('s1')
    expect(openRed(regressed, 's1')).toBe(true)
    expect(redCycleClosed(regressed)).toBe(true)
    expect(stepProgress(plan, regressed)).toMatchObject({ done: 1, next: { id: 's2' } })
    expect(redInFlight([...regressed, green()] as Entry[])).toBe(false)
    // A vacuous red is no cycle (Plan's call 3), so the genuine red before it stays in flight.
    const vacuous = red('s1', { vacuous: true, tests: [{ name: 'a @spec:x', ok: true }] })
    expect(redInFlight([red('s1'), vacuous] as Entry[])).toBe(true)
    // D191's legacy shape: the red the skill tagged, then the untagged green `next` routes, passing.
    expect(redInFlight([red(), red('s2'), green()] as Entry[])).toBe(false)
    expect(redOpenStep(plan, [red(), red('s2'), green()] as Entry[])).toBeUndefined()
    // A failing green with no genuine red before it is in flight too, with no step to name.
    expect(redInFlight([green('s1', false)] as Entry[])).toBe(true)
    expect(redOpenStep(plan, [green('s1', false)] as Entry[])).toBeUndefined()
    // An entry with no outcome saw nothing, so it changes nothing either way.
    const blank = { ...green('s1'), tests: [] }
    expect(redInFlight([red('s1'), blank] as Entry[])).toBe(true)
    expect(redInFlight([red('s1'), green('s1'), blank] as Entry[])).toBe(false)
  })
  // D192. The latest genuine red's cycle closes at a green tagged with its step after it. Once it has,
  // a red still in flight is a later run's failure, and the step holds no open red of its own.
  it("redCycleClosed reads whether the latest genuine red's own cycle closed", () => {
    const failedAfter = [red('s1'), green('s1'), green('s2', false)] as Entry[]
    expect(redInFlight(failedAfter)).toBe(true)
    expect(redOpenStep(plan, failedAfter)).toBe('s1')
    expect(redCycleClosed(failedAfter)).toBe(true)
    // a red re-opened on the closed step is its own again
    expect(redCycleClosed([red('s1'), green('s1'), red('s1')] as Entry[])).toBe(false)
    // a green naming another step closes no cycle of s1's, and a failing one none at all
    expect(redCycleClosed([red('s1'), green('s2')] as Entry[])).toBe(false)
    expect(redCycleClosed([red('s1'), green('s1', false)] as Entry[])).toBe(false)
    // a vacuous red is no red: the genuine one before it is the latest
    const vacuous = red('s2', { vacuous: true, tests: [{ name: 'a @spec:x', ok: true }] })
    expect(redCycleClosed([red('s1'), green('s1'), vacuous] as Entry[])).toBe(true)
    // no genuine red, or one naming no step: no cycle of a step's
    expect(redCycleClosed([green('s1', false)] as Entry[])).toBe(false)
    expect(redCycleClosed([red(), green()] as Entry[])).toBe(false)
  })
  it('lastRedVacuous reads the latest red tagged with the step', () => {
    const vacuous = red('s2', { vacuous: true, tests: [{ name: 'a @spec:x', ok: true }] })
    expect(lastRedVacuous([red('s1'), green('s1'), vacuous] as Entry[], 's2')).toBe(true)
    expect(lastRedVacuous([vacuous, green('s2')] as Entry[], 's2')).toBe(true)
    expect(lastRedVacuous([vacuous, red('s2')] as Entry[], 's2')).toBe(false)
    expect(lastRedVacuous([vacuous] as Entry[], 's1')).toBe(false)
    expect(lastRedVacuous([] as Entry[], 's2')).toBe(false)
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
  // A plan with no criteria step (its spec's criteria delta was empty) has no step a cycle could
  // be: its evidence is asked for no step, and untagged evidence leaves its progress known.
  const chore = planDoc([{ id: 's1', scaffolding: true }])
  it('checkStep owes no --step on a plan with no criteria step', () => {
    expect(checkStep(chore, [], undefined, 'evidence')).toEqual([])
    expect(checkStep(chore, [close('s1')] as Entry[], undefined, 'evidence')).toEqual([])
  })
  it('untagged evidence leaves a plan with no criteria step known', () => {
    expect(stepsLine(stepProgress(chore, [red(), green()] as Entry[]))).toBe('0/1 done · next s1')
    expect(stepsLine(stepProgress(chore, [close('s1'), red(), green()] as Entry[]))).toBe('1/1 done')
  })
  // step-close's already-closed check reads the step alone (Plan's call 6): a close stays found
  // where a legacy plan's untagged evidence leaves the progress unknown.
  it('closingIndex finds a scaffolding close on a legacy plan', () => {
    const entries = [red(), green(), close('s3')] as Entry[]
    expect(stepProgress(plan, entries)).toEqual({ known: false })
    expect(closingIndex({ id: 's3', kind: 'scaffolding' }, entries)).toBe(2)
  })
})
