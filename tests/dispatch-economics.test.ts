import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeScenario, gateEnv, putVerdict, threeStepPlan } from './helpers.js'
import { readStream } from '../src/journal.js'

// Row 79, amended by row 191 §4.10. Under a measured harness the number of slices cannot be
// known in advance, so the run's shape is the rule that cuts it: the limit, and the step budget
// an unmeasured session falls back to.
describe('start surfaces the slice shape (rows 79 · 191)', () => {
  it('start prints slices, steps and the opening context', async () => {
    const repo = await threeStepPlan()
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('slices: by context — relay at 20% (step budget 3 if unmeasured)')
    expect(r.stdout).toContain('steps: 0/3 done · next s1')
    expect(r.stdout).toContain('context: unmeasured (no adapter) — step budget 3')
    expect(r.stdout).toContain('help: implement inside the worktree; witness test-evidence auth-refresh-plan-1 --phase red|green --step <id> as you go')
    expect(r.stdout).not.toContain('dispatch-budget:')
    expect(r.stdout).not.toContain('dispatches:')
  })

  it('a configured budget and limit show in slices', async () => {
    const repo = await threeStepPlan('session:\n  contextLimit: 15\nimplement:\n  stepsPerDispatch: 2\n')
    const first = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('slices: by context — relay at 15% (step budget 2 if unmeasured)')
    const again = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('slices: by context — relay at 15% (step budget 2 if unmeasured)')
    expect(again.stdout).not.toContain('dispatch-budget:')
  })
})

describe('plan gate surfaces the slice shape (rows 79 · 191)', () => {
  it('the plan gate prints slices', async () => {
    const repo = await threeStepPlan()
    const scenario = fakeScenario()
    putVerdict(scenario, {
      findings: [],
      coverage: [{ anchor: '## Step: s1', note: 'read' }, { anchor: '## Step: s2', note: 'read' }],
    })
    const r = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    expect(r.stdout).toContain('slices: by context — relay at 20% (step budget 3 if unmeasured)')
    expect(r.stdout).not.toContain('dispatches:')
  })
})

describe('dispatch-report journals telemetry (row 81)', () => {
  it('appends a dispatch entry with a derived ordinal', async () => {
    const repo = await threeStepPlan()
    await repo.cli(['start', 'auth-refresh-plan-1'])
    const r1 = await repo.cli(['dispatch-report', 'auth-refresh-plan-1',
      '--steps-assigned', '3', '--steps-completed', '3',
      '--tokens', '294737', '--tool-uses', '683', '--duration-ms', '10440000'])
    expect(r1.code).toBe(0)
    expect(r1.stdout).toContain('dispatch: auth-refresh-plan-1 · #1 · 3/3 step(s)')
    const r2 = await repo.cli(['dispatch-report', 'auth-refresh-plan-1',
      '--steps-assigned', '3', '--steps-completed', '1'])
    expect(r2.stdout).toContain('#2 · 1/3')
    const entries = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'dispatch')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      v: 1, t: 'dispatch', plan: 'auth-refresh-plan-1', ordinal: 1,
      steps_assigned: 3, steps_completed: 3, reported: true,
      usage: { tokens: 294737, tool_uses: 683, duration_ms: 10440000 },
    })
    expect(entries[1]).toMatchObject({ ordinal: 2 })
    expect((entries[1] as Record<string, unknown>).usage).toBeUndefined()
  })

  it('refuses an unknown plan and malformed counts', async () => {
    const repo = await threeStepPlan()
    const unknown = await repo.cli(['dispatch-report', 'nope', '--steps-assigned', '1', '--steps-completed', '0'])
    expect(unknown.code).toBe(2)
    const bad = await repo.cli(['dispatch-report', 'auth-refresh-plan-1', '--steps-assigned', '-1', '--steps-completed', '0'])
    expect(bad.code).toBe(2)
    const missing = await repo.cli(['dispatch-report', 'auth-refresh-plan-1'])
    expect(missing.code).toBe(2)
  })
})

describe('implement skill carries the economics protocol (rows 79–80)', () => {
  const skill = readFileSync(
    join(import.meta.dirname, '..', 'plugin', 'skills', 'witness-implement', 'SKILL.md'), 'utf8')

  it.each([
    'dispatch-budget',                       // budget read from start output
    'at most the next',                      // ≤N steps per dispatch
    'never stop mid-red',                    // relay only at evidence-cycle boundaries
    '~15 inner-loop iterations',             // early-exit countable trigger
    'finish the red→green you are in',       // early-exit exit ramp
    'dispatch-report',                       // telemetry call at the slice boundary
    "the test's own name, never the spec tag", // loop width: exact test
    'only inside the witnessed evidence cycle', // suite runs at step close only
    'never whole into your context',         // fat artifacts read by section, not whole
    'keep the app server alive',             // D66 guidance line
  ])('mentions %s', (snippet) => {
    expect(skill).toContain(snippet)
  })
})
