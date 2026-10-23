import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sessionHash } from '../src/context.js'
import { readStream } from '../src/journal.js'
import {
  PLAN_BLOCKING, SCAFFOLDING_FIRST, TOKEN_BROKEN, TOKEN_FIXED, TOKEN_TESTS_TAGGED, TOKEN_TESTS_UNTAGGED, addOrigin, autonomyOn,
  behaviorOnMain, commitEntry, evidenceCycle, fakeScenario, fixtureEnv, gateEnv, measuredEnv, plannedRepo, putVerdict,
  shippableRepo, startedThreeStepPlan, untaggedRed, type CliResult, type TestRepo,
} from './helpers.js'

const at = (tokens: number) => measuredEnv('S1', tokens, 1_000_000)
const lines = (r: CliResult) => r.stdout.split('\n')
// The report closes the verb's output, in the order the spec shows it (§4.6).
const report = (r: CliResult) => lines(r).slice(-3)

// `verify-red --step s1` at 170k on a branch whose base commit holds the untagged suite and
// `baseToken`, and whose next commit adds the tagged tests and the fixed implementation.
async function verifyRed(baseToken: string): Promise<CliResult> {
  const { repo, wt, planId } = await startedThreeStepPlan()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, encoding: 'utf8' }).trim()
  writeFileSync(join(wt, 'src/token.ts'), baseToken)
  writeFileSync(join(wt, 'tests/token.test.ts'), TOKEN_TESTS_UNTAGGED)
  git('add', '-A'); git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
  writeFileSync(join(wt, 'tests/token.test.ts'), TOKEN_TESTS_TAGGED)
  git('add', '-A'); git('commit', '-m', 'tagged tests')
  return repo.cli(['verify-red', planId, '--base', base, '--step', 's1'], { cwd: wt, env: { ...fixtureEnv(), ...at(170_000) } })
}

// Row 191 §4.4–§4.7. A step close is where the CLI decides whether the slice ends: the journal
// already carries the position, so a fresh session continues with nothing lost.
describe('the rule at a step close', () => {
  it('a green that closes a step prints context, steps and slice', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    const r = await evidenceCycle(repo, wt, planId, 's1', at(170_000))
    expect(r.code).toBe(0)
    expect(report(r)).toEqual(['context: 17% of 1M · limit 20%', 'steps: 1/3 done · next s2', 'slice: continue'])
  })

  it('the slice ends when the fill reached the limit', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    const r = await evidenceCycle(repo, wt, planId, 's1', at(210_000))
    expect(r.code).toBe(0)
    expect(lines(r)).toContain('slice: end — 21% reached the 20% limit')
  })

  it("the projection uses this session's growth", async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    await evidenceCycle(repo, wt, planId, 's1', at(100_000))
    const r = await evidenceCycle(repo, wt, planId, 's2', at(150_000))
    expect(r.code).toBe(0)
    expect(report(r)).toEqual([
      'context: 15% of 1M · limit 20% · next step ≈ +5%',
      'steps: 2/3 done · next s3',
      'slice: end — 15% + next step ≈ 20% passes the 20% limit',
    ])
  })

  // Rule 1: with no step left the session goes to the gate. The plan has recorded a growth
  // (s1→s2: +50k), but no step remains to carry it, so nothing is projected. A re-run close
  // journals nothing (Plan's call 6), so it decides nothing either.
  it('the last close says gate', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    await evidenceCycle(repo, wt, planId, 's1', at(100_000))
    await evidenceCycle(repo, wt, planId, 's2', at(150_000))
    const r = await repo.cli(['step-close', planId, '--step', 's3'], { cwd: wt, env: at(150_000) })
    expect(r.code).toBe(0)
    expect(report(r)).toEqual(['context: 15% of 1M · limit 20%', 'steps: 3/3 done', 'slice: gate — no steps remain'])
    expect(r.stdout).not.toContain('next step')
    const again = await repo.cli(['step-close', planId, '--step', 's3'], { cwd: wt, env: at(150_000) })
    expect(again.stdout).toBe(`step-close: ${planId} · s3 already closed`)
  })

  // The close is journaled before the report runs, so a config that will not load costs the
  // report and never the verb's exit.
  it('a config that will not load costs the report, not the close', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}session:\n  contextLimit: 0\n`)
    const r = await repo.cli(['step-close', planId, '--step', 's3'], { cwd: wt, env: at(250_000) })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`step-close: ${planId} · s3 closed`)
    expect(readStream(repo.root, planId).filter((e) => e.t === 'step-close')).toHaveLength(1)
  })

  // §4.4: a green that closes no step never ends a slice; a failing one reports nothing.
  it('a re-recorded green prints context alone', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    await evidenceCycle(repo, wt, planId, 's1', at(100_000))
    const green = () => repo.cli(['test-evidence', planId, '--phase', 'green', '--step', 's1'], { cwd: wt, env: { ...fixtureEnv(), ...at(120_000) } })
    const again = await green()
    expect(again.code).toBe(0)
    expect(lines(again)).toContain('context: 12% of 1M · limit 20%')
    expect(again.stdout).not.toContain('steps:')
    expect(again.stdout).not.toContain('slice:')
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    const failing = await green()
    expect(failing.code).toBe(1)
    expect(failing.stdout).not.toContain('context:')
  })

  // §4.7. s3 stays unfinished, so rule 1 does not fire.
  it('unmeasured counts steps per session against the budget', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan('implement:\n  stepsPerDispatch: 2\n')
    const s9 = { CLAUDE_CODE_SESSION_ID: 'S9' }
    const first = await evidenceCycle(repo, wt, planId, 's1', s9)
    expect(report(first)).toEqual(['context: unmeasured (no adapter) — step budget 2', 'steps: 1/3 done · next s2', 'slice: continue'])
    const second = await evidenceCycle(repo, wt, planId, 's2', s9)
    expect(lines(second)).toContain('slice: end — 2 step(s) closed this session · step budget 2 (context unmeasured)')
  })

  it('no session at all means own count', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    const r = await evidenceCycle(repo, wt, planId, 's1')
    expect(r.code).toBe(0)
    expect(report(r)).toEqual([
      'context: unmeasured (no adapter) — step budget 3',
      'steps: 1/3 done · next s2',
      "slice: own count — the CLI cannot count this session's steps · end after 3 step(s) by your own count",
    ])
  })

  // A reconstructed cycle closes a step as a witnessed one does: one report, after its green.
  it('verify-red reports once, after its green', async () => {
    const r = await verifyRed(TOKEN_BROKEN)
    expect(r.code).toBe(0)
    expect(lines(r).filter((l) => l.startsWith('context:'))).toHaveLength(1)
    expect(report(r)).toEqual(['context: 17% of 1M · limit 20%', 'steps: 1/3 done · next s2', 'slice: continue'])
  })

  // The behavior is already in the base, so the reconstructed red passes: a finding, not a cycle.
  it('a vacuous verify-red reports nothing', async () => {
    const r = await verifyRed(TOKEN_FIXED)
    expect(r.code).toBe(1)
    expect(r.stdout).not.toContain('context:')
  })

  // §4.3: a legacy plan's steps are not the CLI's to see, so until its implement gate every
  // passing green decides. After the gate an untagged green is a fix round.
  it('a legacy plan decides at each passing green until its implement gate', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    commitEntry(repo, planId, untaggedRed(planId))
    const green = () => repo.cli(['test-evidence', planId, '--phase', 'green'], { cwd: wt, env: { ...fixtureEnv(), ...at(250_000) } })
    const before = await green()
    expect(before.code).toBe(0)
    expect(report(before)).toEqual([
      'context: 25% of 1M · limit 20%',
      'steps: unknown (evidence predates step tags)',
      'slice: end — 25% reached the 20% limit',
    ])
    commitEntry(repo, planId, {
      t: 'gate-run', gate: 'implement', artifact: planId, round: 1, run_id: 'r-1', reviewed_sha: 'sha-before',
      prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'passed',
    })
    const after = await green()
    expect(after.code).toBe(0)
    expect(lines(after)).toContain('context: 25% of 1M · limit 20%')
    expect(after.stdout).not.toContain('slice:')
  })
})

const PLAN = 'auth-refresh-plan-1'
const RELAY = 'relay: /clear then /witness'
const warnAt = (pct: number) =>
  `warn: this session opens at ${pct}% of 1M — over the 20% limit before any work; each slice will be one step`

// One genuine red, journaled under the session `env` names: stage work that session made, which
// leaves the step's cycle open.
async function redIn(repo: TestRepo, wt: string, step: string, env: Record<string, string>): Promise<void> {
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
  const red = await repo.cli(['test-evidence', PLAN, '--phase', 'red', '--step', step], { cwd: wt, env: { ...fixtureEnv(), ...env } })
  expect(red.code).toBe(0)
}

// A plan gate stopped by a blocking finding and left for the human: autonomy is off.
async function stoppedPlanGate(): Promise<TestRepo> {
  const repo = await plannedRepo({ autonomy: false })
  const scenario = fakeScenario()
  putVerdict(scenario, PLAN_BLOCKING)
  expect((await repo.cli(['gate', 'plan', PLAN], { env: gateEnv(scenario) })).code).toBe(1)
  return repo
}

// The vitest-single fixture lands four files in the worktree diff, and coverage-minimum wants an
// anchor for each.
const SHIP_CLEAN = {
  coverage: ['.gitignore', 'package.json', 'src/token.ts', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' })),
  findings: [] as unknown[],
}

// A plan whose implement gate passed, with an origin for the ship gate to rebase on: a
// `witness ship` run from here reaches the ship gate.
async function atShipGate(): Promise<{ repo: TestRepo; scenario: string }> {
  const { repo } = await shippableRepo()
  addOrigin(repo)
  const scenario = fakeScenario()
  putVerdict(scenario, SHIP_CLEAN)
  expect((await repo.cli(['gate', 'implement', PLAN], { env: gateEnv(scenario) })).code).toBe(0)
  return { repo, scenario }
}

const relays = (r: CliResult) => lines(r).filter((l) => l.startsWith('relay:'))

// Row 191 §4.4–§4.6. Outside a step close the CLI hands over where the journal already carries
// the position: after a revise is handed to the session, at a ship exit, and at `next`. Each
// prints `context:` and a same-home `relay:` with no `run:`.
describe('the hand-overs', () => {
  it('next at home hands over once this session has acted and the fill reached the limit', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    expect((await evidenceCycle(repo, wt, PLAN, 's1', at(100_000))).code).toBe(0)
    const r = await repo.cli(['next'], { cwd: wt, env: at(210_000) })
    expect(r.code).toBe(0)
    expect(lines(r)).toContain(`next: witness test-evidence ${PLAN} --phase red --step s2`)
    expect(r.stdout).not.toMatch(/^run: /m)
    // Right after the routing unit the stage skills read verbatim.
    expect(lines(r).slice(-3)).toEqual([`home: ${wt}`, 'context: 21% of 1M · limit 20%', RELAY])
  })

  // §1: a session never relays mid-red. The green's close decides instead (rule 2 at a step
  // close), so nothing is lost by waiting for it.
  it('next does not hand over mid-red', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    expect((await evidenceCycle(repo, wt, PLAN, 's1', at(100_000))).code).toBe(0)
    await redIn(repo, wt, 's2', at(150_000))
    const r = await repo.cli(['next'], { cwd: wt, env: at(210_000) })
    expect(r.code).toBe(0)
    expect(lines(r)).toContain(`next: witness test-evidence ${PLAN} --phase green --step s2`)
    expect(relays(r)).toEqual([])
    expect(r.stdout).not.toContain('context:')
  })

  // A legacy plan's steps are not the CLI's to see (§4.3), so its open red comes from the
  // evidence report rather than a step: the same rule holds.
  it('next does not hand over mid-red on a legacy plan', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    commitEntry(repo, PLAN, untaggedRed(PLAN))
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    const red = await repo.cli(['test-evidence', PLAN, '--phase', 'red'], { cwd: wt, env: { ...fixtureEnv(), ...at(100_000) } })
    expect(red.code).toBe(0)
    const r = await repo.cli(['next'], { cwd: wt, env: at(210_000) })
    expect(r.code).toBe(0)
    expect(lines(r)).toContain(`next: witness test-evidence ${PLAN} --phase green`)
    expect(relays(r)).toEqual([])
  })

  // §4.5 "Before any work": the guard keeps a fresh session from handing over before it has
  // done anything, and the CLI says why such a session's slices will be short.
  it('a session that has not acted does not relay — it warns', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    const s2 = measuredEnv('S2', 260_000, 1_000_000)
    const started = await repo.cli(['start', PLAN], { env: s2 })
    expect(started.code).toBe(0)
    expect(lines(started)).toContain('context: 26% of 1M · limit 20%')
    expect(lines(started)).toContain(warnAt(26))
    const r = await repo.cli(['next'], { cwd: wt, env: s2 })
    expect(r.code).toBe(0)
    expect(relays(r)).toEqual([])
    expect(lines(r).indexOf(warnAt(26))).toBeGreaterThanOrEqual(0)
    expect(lines(r).indexOf(warnAt(26))).toBeLessThan(lines(r).findIndex((l) => l.startsWith('next: ')))
  })

  it('bookkeeping is not an act', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    const s3 = (tokens: number) => measuredEnv('S3', tokens, 1_000_000)
    expect((await repo.cli(['ask', 'x'], { env: s3(10_000) })).code).toBe(0)
    // The ask is this session's line, and still not its stage work.
    expect(readStream(repo.root, 'asks').find((e) => e.t === 'ask')?.ctx).toMatchObject({ session: sessionHash('S3') })
    const r = await repo.cli(['next'], { cwd: wt, env: s3(250_000) })
    expect(r.code).toBe(0)
    expect(relays(r)).toEqual([])
  })

  // Where this session's turn ends anyway there is nothing to hand over: at a decision left for
  // a human, and with the run handed to drive. gateEnv clears CI, so `next` settles under autonomy.
  it('next hands nothing over where the turn ends anyway', async () => {
    const repo = await plannedRepo({ autonomy: false })
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    const s8 = (tokens: number) => ({ ...gateEnv(scenario), ...measuredEnv('S8', tokens, 1_000_000) })
    expect((await repo.cli(['gate', 'plan', PLAN], { env: s8(100_000) })).code).toBe(1)
    const human = await repo.cli(['next'], { env: s8(220_000) })
    expect(lines(human)).toContain(`next: witness decide plan ${PLAN} --show`)
    expect(relays(human)).toEqual([])
    autonomyOn(repo)
    const drive = await repo.cli(['next'], { env: s8(220_000) })
    expect(lines(drive)).toContain('launch: witness drive --detach')
    expect(relays(drive)).toEqual([])
  })

  it('under the limit nothing hands over', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    expect((await evidenceCycle(repo, wt, PLAN, 's1', at(100_000))).code).toBe(0)
    const r = await repo.cli(['next'], { cwd: wt, env: at(150_000) })
    expect(r.code).toBe(0)
    expect(relays(r)).toEqual([])
    expect(r.stdout).not.toContain('context:')
  })

  // Plan's call 7: at a revise the guard holds by construction, the decision being an act.
  it('decide --revise hands over', async () => {
    const full = await stoppedPlanGate()
    const s4 = (tokens: number) => measuredEnv('S4', tokens, 1_000_000)
    const shown = await full.cli(['decide', 'plan', PLAN, '--show'], { env: s4(220_000) })
    expect(shown.code).toBe(0)
    expect(relays(shown)).toEqual([])
    const r = await full.cli(['decide', 'plan', PLAN, '--revise', '--note', 'x'], { env: s4(220_000) })
    expect(r.code).toBe(0)
    expect(lines(r).slice(-2)).toEqual(['context: 22% of 1M · limit 20%', RELAY])
    const room = await stoppedPlanGate()
    const under = await room.cli(['decide', 'plan', PLAN, '--revise', '--note', 'x'], { env: s4(100_000) })
    expect(under.code).toBe(0)
    expect(relays(under)).toEqual([])
  })

  it('a settled revise under autonomy hands over', async () => {
    const repo = await plannedRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    const r = await repo.cli(['gate', 'plan', PLAN], { env: { ...gateEnv(scenario), ...measuredEnv('S5', 220_000, 1_000_000) } })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain(`decided: plan ${PLAN} → revise`)
    expect(lines(r).slice(-2)).toEqual(['context: 22% of 1M · limit 20%', RELAY])
  })

  // The ship gate always stops, so the run exits with its decision owed: the ship exit is the
  // only hand-over point in it.
  it('a ship run prints one relay', async () => {
    const { repo, scenario } = await atShipGate()
    const r = await repo.cli(['ship', PLAN], { env: { ...gateEnv(scenario), ...measuredEnv('S6', 220_000, 1_000_000) } })
    expect(r.code).toBe(1)
    expect(relays(r)).toEqual([RELAY])
  })

  // Under autonomy the ship gate's own tail settles the revise inside the ship run, and the run
  // still hands over once, at its exit (Plan's call 7).
  it('a ship run whose gate settles a revise still prints one relay', async () => {
    const { repo, scenario } = await atShipGate()
    autonomyOn(repo)
    putVerdict(scenario, { ...SHIP_CLEAN, findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'rotation never fires' }] })
    const r = await repo.cli(['ship', PLAN], { env: { ...gateEnv(scenario), ...measuredEnv('S7', 220_000, 1_000_000) } })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain(`decided: ship ${PLAN} → revise`)
    expect(relays(r)).toEqual([RELAY])
  })

  // Not every ship exit follows an act: `revise owed` returns having journaled nothing. Without
  // the act guard, a session that opens over the limit would relay there, and so would every
  // fresh session after it, none of them making the edit.
  it('a ship exit that did nothing hands nothing over', async () => {
    const { repo, scenario } = await atShipGate()
    putVerdict(scenario, { ...SHIP_CLEAN, findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'rotation never fires' }] })
    // Autonomy off: the ship gate stops and a human revises, both outside any harness session.
    expect((await repo.cli(['ship', PLAN], { env: gateEnv(scenario) })).code).toBe(1)
    expect((await repo.cli(['decide', 'ship', PLAN, '--revise', '--note', 'x'], { env: gateEnv(scenario) })).code).toBe(0)
    const s9 = { ...gateEnv(scenario), ...measuredEnv('S9', 220_000, 1_000_000) }
    const routed = await repo.cli(['next'], { env: s9 })
    expect(lines(routed)).toContain(`next: witness ship ${PLAN}`)
    expect(lines(routed)).toContain(warnAt(22))
    expect(relays(routed)).toEqual([])
    const r = await repo.cli(['ship', PLAN], { env: s9 })
    expect(r.code).toBe(1)
    expect(lines(r)).toContain(`ship: ${PLAN} — revise owed`)
    expect(relays(r)).toEqual([])
  })
})

// Final review I1. A red open on a step other than the one `next` would route is a red in flight
// all the same: a scaffolding step left unclosed ahead of it, a red recorded out of order, a red
// re-opened on a closed step. `next` routes its green first and hands nothing over, and a step
// close says continue while it is open, so no slice ends mid-red.
describe('a red open on any step', () => {
  const routed = (r: CliResult) => lines(r).find((l) => l.startsWith('next: '))
  const slice = (r: CliResult) => lines(r).find((l) => l.startsWith('slice: '))

  it('ahead of an unclosed scaffolding step: next routes its green and hands nothing over', async () => {
    const { repo, wt } = await startedThreeStepPlan('', SCAFFOLDING_FIRST)
    await redIn(repo, wt, 's2', at(150_000))
    const r = await repo.cli(['next'], { cwd: wt, env: at(210_000) })
    expect(r.code).toBe(0)
    expect(routed(r)).toBe(`next: witness test-evidence ${PLAN} --phase green --step s2`)
    expect(lines(r)).toContain('note: steps 0/3 done · next s1 · s2 has an open red — its green comes first')
    expect(relays(r)).toEqual([])
  })

  it('recorded out of order: next routes its green and hands nothing over', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    await redIn(repo, wt, 's2', at(150_000))
    const r = await repo.cli(['next'], { cwd: wt, env: at(210_000) })
    expect(r.code).toBe(0)
    expect(routed(r)).toBe(`next: witness test-evidence ${PLAN} --phase green --step s2`)
    expect(relays(r)).toEqual([])
  })

  it('re-opened on a closed step: next routes its green and hands nothing over', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    expect((await evidenceCycle(repo, wt, PLAN, 's1', at(100_000))).code).toBe(0)
    await redIn(repo, wt, 's1', at(150_000))
    const r = await repo.cli(['next'], { cwd: wt, env: at(210_000) })
    expect(r.code).toBe(0)
    expect(routed(r)).toBe(`next: witness test-evidence ${PLAN} --phase green --step s1`)
    expect(lines(r)).toContain('note: steps 1/3 done · next s2 · s1 has an open red — its green comes first')
    expect(relays(r)).toEqual([])
  })

  it('a step close ahead of it says continue', async () => {
    const { repo, wt } = await startedThreeStepPlan('', SCAFFOLDING_FIRST)
    await redIn(repo, wt, 's2', at(150_000))
    const r = await repo.cli(['step-close', PLAN, '--step', 's1'], { cwd: wt, env: at(210_000) })
    expect(r.code).toBe(0)
    expect(report(r)).toEqual(['context: 21% of 1M · limit 20%', 'steps: 1/3 done · next s2', 'slice: continue'])
  })

  it('a step close while a red recorded out of order is open says continue', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    await redIn(repo, wt, 's2', at(150_000))
    const r = await repo.cli(['step-close', PLAN, '--step', 's3'], { cwd: wt, env: at(210_000) })
    expect(r.code).toBe(0)
    expect(slice(r)).toBe('slice: continue')
  })

  it('a step close while a red re-opened on a closed step is open says continue', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    expect((await evidenceCycle(repo, wt, PLAN, 's1', at(100_000))).code).toBe(0)
    await redIn(repo, wt, 's1', at(150_000))
    const r = await repo.cli(['step-close', PLAN, '--step', 's3'], { cwd: wt, env: at(210_000) })
    expect(r.code).toBe(0)
    expect(lines(r)).toContain('steps: 2/3 done · next s2')
    expect(slice(r)).toBe('slice: continue')
  })
})

// Final review I2. A legacy plan's steps are the skill's to count (§4.3), so `next` cannot tell
// whether any remain. Its gate row names the implement stage until its implement gate: the router
// hands it to the implement skill, whose own count decides, rather than running the gate verbatim
// — a fresh session after a relay would otherwise gate with steps left.
describe('a legacy plan after a relay', () => {
  it('routes its gate through the implement stage until its implement gate', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    commitEntry(repo, PLAN, untaggedRed(PLAN))           // an older CLI's untagged red: legacy
    const s1 = await evidenceCycle(repo, wt, PLAN, 's1', measuredEnv('S1', 42_000, 200_000))
    expect(lines(s1)).toContain('slice: end — 21% reached the 20% limit')
    const fresh = await repo.cli(['next'], { cwd: wt, env: measuredEnv('S2', 52_000, 200_000) })
    expect(fresh.code).toBe(0)
    expect(lines(fresh)).toContain(`next: witness gate implement ${PLAN}`)
    expect(lines(fresh)).toContain('stage: implement')
    // After its implement gate the plan's steps are behind it: a re-gate is the gate's own row.
    commitEntry(repo, PLAN, {
      t: 'gate-run', gate: 'implement', artifact: PLAN, round: 1, run_id: 'r-1', reviewed_sha: 'sha-before',
      prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'passed',
    })
    const after = await repo.cli(['next'], { cwd: wt, env: measuredEnv('S2', 52_000, 200_000) })
    expect(lines(after)).toContain(`next: witness gate implement ${PLAN}`)
    expect(after.stdout).not.toContain('stage:')
  })
})

// Final review I3, the spec's own anti-goal (§2: a session that opens over the limit and relays
// forever). s1's behavior predates the plan, so its red passes and `next` routes verify-red, whose
// red passes against the base too. A vacuous red is no act, and the green verify-red runs after it
// only confirms the restore: it journals nothing. So a session that does nothing else gets the same
// `next:` line back with no relay, and the router's same-line-twice stop ends the loop where a
// fresh session would otherwise re-run it forever.
describe('a vacuous red is no act', () => {
  const routed = (r: CliResult) => lines(r).find((l) => l.startsWith('next: '))

  it('a session that only re-runs a vacuous verify-red hands nothing over', async () => {
    const { repo, wt } = await behaviorOnMain()
    const over = (session: string) => ({ ...fixtureEnv(), ...measuredEnv(session, 52_000, 200_000) })   // 26%
    const red = await repo.cli(['test-evidence', PLAN, '--phase', 'red', '--step', 's1'], { cwd: wt, env: over('A') })
    expect(red.code).toBe(1)
    const a = await repo.cli(['next'], { cwd: wt, env: over('A') })
    expect(routed(a)).toBe(`next: witness verify-red ${PLAN} --step s1`)
    expect(relays(a)).toEqual([])
    // A fresh session runs the routed line, as each turn of the probe's loop opened one to.
    const first = await repo.cli(['next'], { cwd: wt, env: over('B') })
    const verified = await repo.cli(['verify-red', PLAN, '--step', 's1'], { cwd: wt, env: over('B') })
    expect(verified.code).toBe(1)
    expect(verified.stdout).toContain('verify-red: red NOT observed · green confirmed')
    const again = await repo.cli(['next'], { cwd: wt, env: over('B') })
    expect(routed(again)).toBe(routed(first))
    expect(relays(first)).toEqual([])
    expect(relays(again)).toEqual([])
    expect(readStream(repo.root, PLAN).filter((e) => e.t === 'test-evidence').map((e) => e.phase)).toEqual(['red', 'red'])
  })
})

// Re-review. A red is open until any passing green, whatever step that green names: every run
// executes the parent tag's whole suite. Read per step, the red the skill tags on a legacy plan
// stayed open for good once the agent ran the untagged green `next` routes there, and an open red
// outranks every verdict and every hand-over, so the plan's slice cut and `next`'s relay were off
// for the rest of it.
describe('an open red closes at any passing green', () => {
  const routed = (r: CliResult) => lines(r).find((l) => l.startsWith('next: '))
  const slice = (r: CliResult) => lines(r).find((l) => l.startsWith('slice: '))

  it("a legacy plan's routed untagged green closes the red the skill tagged", async () => {
    const { repo, wt } = await startedThreeStepPlan()
    commitEntry(repo, PLAN, untaggedRed(PLAN))           // an older CLI's untagged red: legacy
    await redIn(repo, wt, 's1', at(100_000))              // the skill names the step on its red
    const owed = await repo.cli(['next'], { cwd: wt, env: at(100_000) })
    expect(routed(owed)).toBe(`next: witness test-evidence ${PLAN} --phase green`)
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
    const green = await repo.cli(['test-evidence', PLAN, '--phase', 'green'], { cwd: wt, env: { ...fixtureEnv(), ...at(210_000) } })
    expect(green.code).toBe(0)
    expect(slice(green)).toBe('slice: end — 21% reached the 20% limit')
    // This session has acted, so `next` hands over where it stands.
    const after = await repo.cli(['next'], { cwd: wt, env: at(210_000) })
    expect(routed(after)).toBe(`next: witness gate implement ${PLAN}`)
    expect(relays(after)).toEqual([RELAY])
  })

  it('unmeasured, that green leaves the count to the skill', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    commitEntry(repo, PLAN, untaggedRed(PLAN))
    const unmeasured = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'U1' }
    await redIn(repo, wt, 's1', unmeasured)
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
    const green = await repo.cli(['test-evidence', PLAN, '--phase', 'green'], { cwd: wt, env: { ...fixtureEnv(), ...unmeasured } })
    expect(green.code).toBe(0)
    expect(slice(green)).toBe("slice: own count — the CLI cannot count this session's steps · end after 3 step(s) by your own count")
  })

  // A passing green after s2's genuine red cannot be recorded while that red stands (the run
  // includes s2's failing test), so the boundary pinned here is the other one: a failing green,
  // whatever step it names, leaves the red open.
  it('a failing green leaves the red open', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    await redIn(repo, wt, 's2', at(150_000))              // TOKEN_BROKEN stays in place
    const failing = await repo.cli(['test-evidence', PLAN, '--phase', 'green', '--step', 's1'], { cwd: wt, env: { ...fixtureEnv(), ...at(160_000) } })
    expect(failing.code).toBe(1)
    const r = await repo.cli(['next'], { cwd: wt, env: at(210_000) })
    expect(routed(r)).toBe(`next: witness test-evidence ${PLAN} --phase green --step s2`)
    expect(relays(r)).toEqual([])
    const closed = await repo.cli(['step-close', PLAN, '--step', 's3'], { cwd: wt, env: at(210_000) })
    expect(slice(closed)).toBe('slice: continue')
  })
})
