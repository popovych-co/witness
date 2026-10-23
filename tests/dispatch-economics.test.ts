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
    const repo = await threeStepPlan({ session: { contextLimit: 15 }, implement: { stepsPerDispatch: 2 } })
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

const skill = (name: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'plugin', 'skills', name, 'SKILL.md'), 'utf8')
const implement = skill('witness-implement')
const router = readFileSync(join(import.meta.dirname, '..', 'plugin', 'commands', 'witness.md'), 'utf8')

// Row 191 §4.6 (amends rows 79–80). The CLI decides where a slice ends; the skill is how the
// session acts on what it prints. The step budget's count and the ~15-iteration trigger are
// retired: the first by `slice:`, the second by the adapter's measured warning. The scope
// trigger stays, since it is about scope, not size.
describe('implement skill carries the context-fill protocol (rows 79–80, 191)', () => {
  it.each([
    '--step <step-id>', 'step-close', 'slices:', 'steps:', 'context:',
    'slice: continue', 'slice: end', 'slice: gate', 'slice: own count', 'steps: unknown',
    'witness: context', 'never stop mid-red', 'finish the red→green you are in',
    "left the step's scope to fight infrastructure", 'dispatch-report',
    "the test's own name, never the spec tag", 'only inside the witnessed evidence cycle',
    'never whole into your context', 'keep the app server alive',
  ])('mentions %s', (s) => expect(implement).toContain(s))
  it.each(['~15 inner-loop iterations', 'dispatch-budget', 'at most the next'])('no longer says %s', (s) => expect(implement).not.toContain(s))
})

// Row 191 §4.6 (amends row 82). At a revise, a ship exit and `next`, the hand-over is a
// `relay:` with no `run:`: the work continues in this same home, so every surface that can
// meet one must end the turn on it rather than act on.
describe('the same-home relay ends the turn (rows 82 · 191)', () => {
  it('the router ends the turn on a relay: with no run:', () => {
    expect(router).toMatch(/`relay:` line is printed with no `run:`/)
  })
  it.each(['witness-implement', 'witness-plan', 'witness-decompose', 'witness-design'])('%s hands a settled revise to a fresh session', (s) => {
    expect(skill(s)).toContain('a fresh session takes the revise')
  })
  it('ship runs its next pass in a fresh session', () => {
    expect(skill('witness-ship')).toContain('the next ship pass runs in a fresh session')
  })
  it('the router stops at a relay: with no run:', () => {
    expect(router).toContain(
      "- A `relay:` line printed with no `run:` — by `next`, `gate`, `decide` (a `--revise` the human named included) or `ship`: the session reached its context limit, and the table's row applies.")
  })
  // Caution is a per-run mood (row 82), and the fresh session a relay opens is the same run.
  it('the --manual mood outlives a relay', () => {
    expect(router).toContain(
      'The mood outlives a relay: when you print a `relay:` line in an armed session, add that the fresh session starts with `/witness --manual`.')
  })
})

// Row 191 §4.6. Every stage skill but implement (its protocol is pinned above) carries the warning
// as a ground rule: the line is addressed to the session, which finishes the act it is in, while
// the hand-over stays the CLI's.
describe('the stage skills act on the context warning (row 191 §4.6)', () => {
  const BULLET = "- **A `witness: context …` line is addressed to you.** Once per session, when this session's context has filled to the configured limit, it follows a command's result. Finish the act you are in"
  it.each([
    ['witness-brainstorm', '(here: the interview, through its `recap`)'],
    ['witness-decompose', '(here: the specs, through their writes and the gate)'],
    ['witness-design', '(here: the look, through `witness design` and its gate)'],
    ['witness-plan', '(here: the plan, through its write and gate)'],
  ])('%s finishes its act, then hands back to /witness', (name, act) => {
    expect(skill(name)).toContain(
      `${BULLET} ${act} — a session that has done none yet does the one it was routed to — then hand back to /witness, whose \`next\` hands over to a fresh session.`)
  })
  it('witness-ship keeps working until the CLI prints a relay:', () => {
    expect(skill('witness-ship')).toContain(
      `${BULLET} (here: a fix, through the \`witness ship\` run that carries it). The hand-over is the CLI's: it happens only when the CLI prints a \`relay:\` line with no \`run:\`. When none prints, keep working.`)
  })
})
