import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'
import { readStream } from '../src/journal.js'

const THREE_STEPS = {
  steps: [
    { id: 's1', title: 'first', criteria: ['ac-rotate'] },
    { id: 's2', title: 'second', criteria: ['ac-rotate'] },
    { id: 's3', title: 'third', scaffolding: true },
  ],
}
const THREE_STEP_BODY = '## Step: s1\nA.\n\n## Step: s2\nB.\n\n## Step: s3\nC.\n'

async function planReady(budgetYaml = '') {
  const repo = await seededRepo()
  if (budgetYaml) {
    repo.write('witness.config.yaml', repo.read('witness.config.yaml') + budgetYaml)
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'budget config', '-m', 'Witness-State: 1')
  }
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1', THREE_STEPS, THREE_STEP_BODY)
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  return repo
}

describe('start surfaces the dispatch budget (row 79)', () => {
  it('prints dispatch-budget and the arithmetic on a fresh start', async () => {
    const repo = await planReady()
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('dispatch-budget: 3')
    expect(r.stdout).toContain('dispatches: 3 step(s) ≈ 1 dispatch(es) at budget 3')
  })

  it('honors a configured budget and re-prints on re-attach', async () => {
    const repo = await planReady('implement:\n  stepsPerDispatch: 2\n')
    await repo.cli(['start', 'auth-refresh-plan-1'])
    const again = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('dispatch-budget: 2')
    expect(again.stdout).toContain('dispatches: 3 step(s) ≈ 2 dispatch(es) at budget 2')
  })
})

describe('plan gate surfaces the dispatch arithmetic (row 79)', () => {
  it('prints the dispatches line on a plan gate run', async () => {
    const repo = await planReady()
    const scenario = fakeScenario()
    putVerdict(scenario, {
      findings: [],
      coverage: [{ anchor: '## Step: s1', note: 'read' }, { anchor: '## Step: s2', note: 'read' }],
    })
    const r = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    expect(r.stdout).toContain('dispatches: 3 step(s) ≈ 1 dispatch(es) at budget 3')
  })
})

describe('dispatch-report journals telemetry (row 81)', () => {
  it('appends a dispatch entry with a derived ordinal', async () => {
    const repo = await planReady()
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
    const repo = await planReady()
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
