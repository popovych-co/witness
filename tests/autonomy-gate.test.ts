import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { appendEntry, readStream } from '../src/journal.js'
import type { DecisionEntry, GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import {
  PLAN_BLOCKING, approve, autonomyOn, callCount, callFor, fakeCtx, fakeScenario, gateEnv, plannedRepo, putVerdict,
  seededRepo, shippableRepo, witnessDesign, writeDesign, writeSpec,
} from './helpers.js'

const cover = (ids: string[]) => ({
  coverage: ids.map((id) => ({ anchor: `${id} > ## Behavior`, note: 'read' })),
  findings: [],
})
const capture = (root: string, scenario: string, env: Record<string, string> = {}) => {
  const outs: string[] = []; const errs: string[] = []
  return {
    ctx: fakeCtx(root, { env: gateEnv(scenario, env), out: (l) => outs.push(l), err: (l) => errs.push(l) }),
    out: () => outs.join('\n'), err: () => errs.join('\n'),
  }
}
const decisions = (root: string, stream: string) =>
  readStream(root, stream).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]
const lastRun = (root: string, stream: string, gate: string) =>
  (readStream(root, stream).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]).filter((r) => r.gate === gate).at(-1)!
const F = { fresh: false, manual: false }

// The feature decompose: green evidence still stops for scope.
async function scoped() {
  const repo = await seededRepo(); autonomyOn(repo); await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario(); putVerdict(scenario, cover(['auth-refresh']))
  return { repo, scenario }
}

it('the scope stop goes to the arbiter, which approves the slicing (A2 · A3)', async () => {
  const { repo, scenario } = await scoped()
  putVerdict(scenario, { choice: 1, reason: 'one slice covers g1 and nothing the recap excludes' }, 'arbiter')
  const h = capture(repo.root, scenario)
  expect(await runGate(h.ctx, 'decompose', 'auth-hardening', F)).toBe(0)
  const d = decisions(repo.root, 'auth-hardening').at(-1)!
  expect(d).toMatchObject({ decision: 'approve', selected: 'arbiter', rule: 'reserved-stop-clean',
    reason: 'one slice covers g1 and nothing the recap excludes' })
  expect(d.arbiter!.model).toBe(lastRun(repo.root, 'auth-hardening', 'decompose').model)   // the gates.model chain, as the battery's
  expect(d.arbiter!.prompts_sha).toMatch(/^[0-9a-f]{64}$/)
  expect(findById(loadCanon(repo.root), 'auth-refresh')!.meta.status).toBe('approved')
  expect(h.out()).toContain('decided: decompose auth-hardening → approve · arbiter · reserved-stop-clean')
  const asked = readFileSync(join(callFor(scenario, 'arbiter')!, 'stdin'), 'utf8')
  expect(asked).toContain('Refresh tokens rotate before expiry')                     // the recap's goal
  expect(asked).toContain('1. witness decide decompose auth-hardening --approve')
})

it('the policy revises a blocking finding and asks nobody (A2)', async () => {
  const repo = await plannedRepo(); const scenario = fakeScenario(); putVerdict(scenario, PLAN_BLOCKING)
  const h = capture(repo.root, scenario)
  expect(await runGate(h.ctx, 'plan', 'auth-refresh-plan-1', F)).toBe(1)
  expect(decisions(repo.root, 'auth-refresh-plan-1').at(-1)).toMatchObject({ decision: 'revise', selected: 'policy', rule: 'blocking-here',
    note: '1 blocking finding: auth-refresh-plan-1 > ## Step: s1' })
  expect(h.out()).toContain('decided: plan auth-refresh-plan-1 → revise · policy · blocking-here')
  expect(h.out()).toContain('revise-context:')
  expect(h.out()).not.toMatch(/^run: witness decide/m)
  expect(callFor(scenario, 'arbiter')).toBeUndefined()
})

it('the design look stays the human\'s, clean or with nits (Review Focus 1)', async () => {
  const CLEAN = {
    coverage: [
      { anchor: 'design#save-bar', note: 'primary action visible' },
      { anchor: 'booking-form > ## Behavior', note: 'every behavior has a home' },
    ],
    findings: [] as unknown[],
  }
  for (const findings of [[], [{ blocking: false, anchor: 'design#save-bar', claim: 'hairline' }]]) {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    await writeDesign(repo, 'booking-form')
    await witnessDesign(repo, 'booking-form')
    autonomyOn(repo)
    const scenario = fakeScenario(); putVerdict(scenario, { ...CLEAN, findings })
    const h = capture(repo.root, scenario)
    expect(await runGate(h.ctx, 'design', 'booking-form', F)).toBe(1)
    expect(decisions(repo.root, 'booking-form')).toEqual([])
    expect(h.out()).toContain('kept-stop: design look — the human approves the screen or sends a note — witness decide design booking-form --show')
    expect(h.out()).toMatch(/^decide: \d+ options · 1 is recommended$/m)
  }
})

it('a command trust blocked is the human\'s to grant (kept stop)', async () => {
  const { repo, planId } = await shippableRepo(); autonomyOn(repo)
  const SHIP_CLEAN = {
    coverage: [
      { anchor: '.gitignore', note: 'read' }, { anchor: 'package.json', note: 'read' },
      { anchor: 'src/token.ts', note: 'read' }, { anchor: 'tests/token.test.ts', note: 'read' },
    ],
    findings: [],
  }
  const scenario = fakeScenario(); putVerdict(scenario, SHIP_CLEAN)
  expect(await runGate(capture(repo.root, scenario).ctx, 'implement', planId, F)).toBe(0)
  const h = capture(repo.root, scenario, { WITNESS_TRUST_CMDS: '' })
  expect(await runGate(h.ctx, 'ship', planId, F)).toBe(1)
  expect(decisions(repo.root, planId).filter((d) => d.gate === 'ship')).toEqual([])
  expect(callFor(scenario, 'arbiter')).toBeUndefined()
  expect(h.out()).toContain('kept-stop: trust grant — true · ')
  expect(h.out()).toContain('the human runs witness gate ship auth-refresh-plan-1 in a terminal and answers each prompt')
})

it('a --manual run keeps its stop for a human (Review Focus 4)', async () => {
  const repo = await plannedRepo(); const scenario = fakeScenario(); putVerdict(scenario, PLAN_BLOCKING)
  const h = capture(repo.root, scenario)
  expect(await runGate(h.ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: true })).toBe(1)
  expect(decisions(repo.root, 'auth-refresh-plan-1')).toEqual([])
  expect(h.out()).not.toContain('autonomy:')
  expect(h.out()).toContain('run: witness decide plan auth-refresh-plan-1')
})

it('at the bound the arbiter chooses from the endgame, never abandon', async () => {
  const repo = await plannedRepo()
  for (const round of [1, 2, 3]) {
    appendEntry(repo.root, 'auth-refresh-plan-1', {
      v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh-plan-1', round,
      run_id: `r-${round}`, reviewed_sha: `sha-${round}`, prompts_sha: 'p', witness: '0',
      model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
    })
  }
  const scenario = fakeScenario(); putVerdict(scenario, { choice: 1, reason: 'the plan is what is wrong' }, 'arbiter')
  const h = capture(repo.root, scenario)
  expect(await runGate(h.ctx, 'plan', 'auth-refresh-plan-1', F)).toBe(1)
  expect(callCount(scenario)).toBe(1)
  expect(decisions(repo.root, 'auth-refresh-plan-1').at(-1)).toMatchObject({ decision: 'revise-upstream', selected: 'arbiter', rule: 'bound-stale' })
  const asked = readFileSync(join(callFor(scenario, 'arbiter')!, 'stdin'), 'utf8')
  expect(asked).toContain('1. witness decide plan auth-refresh-plan-1 --revise --upstream auth-refresh')
  expect(asked).not.toContain('witness abandon')
})

it('an arbiter that answers malformed twice parks the flow once (Review Focus 5)', async () => {
  const { repo, scenario } = await scoped()
  putVerdict(scenario, 'no ruling here', 'arbiter')
  const h = capture(repo.root, scenario)
  expect(await runGate(h.ctx, 'decompose', 'auth-hardening', F)).toBe(1)
  const d = decisions(repo.root, 'auth-hardening').at(-1)!
  expect(d).toMatchObject({ decision: 'stop', selected: 'policy' })
  expect(d.note).toContain('the arbiter answered malformed twice')
  expect(callCount(scenario)).toBe(3)
  await repo.cli(['next'], { env: gateEnv(scenario) })
  expect(callCount(scenario)).toBe(3)
  expect((await repo.cli(['status'], { env: gateEnv(scenario) })).stdout).toContain('parked[1]{gate,target,round,anchor,reopen}:')
})

it('an arbiter that cannot be invoked leaves the stop for a human', async () => {
  const { repo, scenario } = await scoped()
  writeFileSync(join(scenario, 'claude-fail-arbiter'), '')
  const h = capture(repo.root, scenario)
  expect(await runGate(h.ctx, 'decompose', 'auth-hardening', F)).toBe(2)
  expect(lastRun(repo.root, 'auth-hardening', 'decompose').outcome).toBe('stopped')
  expect(decisions(repo.root, 'auth-hardening')).toEqual([])
  expect(h.err()).toContain('reviewer-invocation')
  expect(h.out()).toContain('autonomy: left for a human — the arbiter could not be invoked')
})
