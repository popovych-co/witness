import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import { gateRunLines, gateRunView } from '../src/gate-run-view.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import { heldSatisfy, type HeldRow } from '../src/needs.js'
import type { GateRunEntry } from '../src/rounds.js'
import type { CanonDoc } from '../src/scan.js'
import { prBody, runShip } from '../src/ship.js'
import { addOrigin, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, type TestRepo } from './helpers.js'

const HELD_META = (cmd = 'false') => ({
  criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }, { id: 'ac-prod', cmd }],
  needs: [{ id: 'prod', manual: 'production access granted', satisfied: false, holds: ['ac-prod'] }],
})
const CLEAN = { coverage: ['.gitignore', 'package.json', 'src/token.ts', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' })), findings: [] }
async function heldFlow(cmd?: string) {
  const seed = await shippableRepo()
  seed.repo.setMeta('auth-refresh', HELD_META(cmd))
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  const outs: string[] = []
  const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario), out: (l) => outs.push(l) })
  return { ...seed, scenario, ctx, outs }
}
const runs = (repo: TestRepo, id: string) => readStream(repo.root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
const laneOf = (run: GateRunEntry) => run.checks.find((c) => c.name === 'drift-lane')!
const ROW = { criterion: 'ac-prod', need: 'prod', satisfy: 'witness satisfy auth-refresh --need prod', spec: 'auth-refresh' }

describe('held criteria at the gates (A10)', () => {
  it('the implement gate passes a held criterion and names it on every surface', async () => {
    const { repo, planId, ctx, outs } = await heldFlow()
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(0)
    expect(laneOf(runs(repo, planId).at(-1)!)).toEqual({ name: 'drift-lane', ok: true, detail: 'ac-rotate:ok · ac-prod:held by prod', held: [ROW] })
    expect(outs.join('\n')).toContain('held: ac-prod — prod unmet · witness satisfy auth-refresh --need prod')
  })
  it('after the need is satisfied the criterion runs and its failure stops the gate', async () => {
    const { repo, planId, ctx } = await heldFlow()
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await repo.cli(['satisfy', 'auth-refresh', '--need', 'prod'])
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(1)
    const lane = laneOf(runs(repo, planId).at(-1)!)
    expect(lane).toMatchObject({ ok: false, detail: 'ac-rotate:ok · ac-prod:fail' })
    expect(lane.held).toBeUndefined()
  })
  it('a hold lifting appends a round even when the lane stays green', async () => {
    const { repo, planId, ctx } = await heldFlow('true')
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await repo.cli(['satisfy', 'auth-refresh', '--need', 'prod'])
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(0)
    expect(runs(repo, planId)).toHaveLength(2)
    expect(runs(repo, planId).at(-1)!.cached).toBe(true)
    expect(laneOf(runs(repo, planId).at(-1)!).held).toBeUndefined()
  })
  it('ship lists the held criteria in the PR body', async () => {
    const { repo, planId, scenario, ctx } = await heldFlow()
    addOrigin(repo)
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await runShip(ctx, planId)                                         // gate phase → the ship stop
    await repo.cli(['decide', 'ship', planId, '--approve'], { env: gateEnv(scenario) })
    expect(await runShip(ctx, planId)).toBe(0)                         // pr → watch
    const calls = readFileSync(join(scenario, 'gh-calls'), 'utf8')
    expect(calls).toContain('Held — not verified while a need is unmet:')
    expect(calls).toContain('- ac-prod: prod unmet — witness satisfy auth-refresh --need prod')
  })
})

// Row 239 (B13, Review Focus 4). A journal is text anyone with the repo can edit, so a held row's
// command is rebuilt from the ids it journals (0.28.3 on), and a row journaled before them (0.28.2)
// prints its stored command only in the one shape witness wrote. Any other row prints none, on the
// gate's screen and in the PR body alike.
describe('a held row prints only a command witness built (row 239)', () => {
  const SATISFY = 'witness satisfy auth-refresh --need prod'
  const ROWS: Array<[row: HeldRow, satisfy: string | undefined]> = [
    [{ criterion: 'ac-prod', need: 'prod', spec: 'auth-refresh', satisfy: 'x' }, SATISFY],
    [{ criterion: 'ac-prod', need: 'prod', satisfy: SATISFY }, SATISFY],
    [{ criterion: 'ac-prod', need: 'prod', satisfy: 'witness satisfy x --need y; touch M1' }, undefined],
    // a row that journals ids is rebuilt or prints none: it never falls back to its stored string
    [{ criterion: 'ac-prod', need: 'prod; touch M1', spec: 'auth-refresh', satisfy: SATISFY }, undefined],
  ]
  const entry = (row: HeldRow): GateRunEntry => ({
    v: 1, t: 'gate-run', gate: 'implement', artifact: 'auth-refresh-plan-1', round: 1, run_id: 'r1', reviewed_sha: 'c0ffee1',
    prompts_sha: 'p', witness: '0', model: 'm', outcome: 'passed',
    checks: [{ name: 'drift-lane', ok: true, detail: 'ac-rotate:ok · ac-prod:held by prod', held: [row] }],
  })
  const PLAN: CanonDoc = {
    rel: 'plans/auth-refresh-plan-1.md', body: '', violations: [], satisfiedNeeds: [],
    meta: { id: 'auth-refresh-plan-1', parent: 'auth-refresh', 'derives-from': 'c0ffee1234' },
  }

  it('a journaled satisfy is rebuilt from its fields, and a forged one prints none (Review Focus 4)', () => {
    expect(ROWS.map(([row]) => gateRunLines(gateRunView(entry(row), 'ran')).filter((l) => l.startsWith('held: ')))).toEqual([
      ['held: ac-prod — prod unmet · witness satisfy auth-refresh --need prod'],
      ['held: ac-prod — prod unmet · witness satisfy auth-refresh --need prod'],
      ['held: ac-prod — prod unmet'],
      ['held: ac-prod — prod; touch M1 unmet'],
    ])
    expect(ROWS.map(([row]) => heldSatisfy(row))).toEqual(ROWS.map(([, satisfy]) => satisfy))
    expect(prBody(PLAN, ROWS.map(([row]) => row)).split('\n')).toEqual([
      'Realizes spec auth-refresh at c0ffee1 (witness).', '', 'Held — not verified while a need is unmet:',
      '- ac-prod: prod unmet — witness satisfy auth-refresh --need prod',
      '- ac-prod: prod unmet — witness satisfy auth-refresh --need prod',
      '- ac-prod: prod unmet',
      '- ac-prod: prod; touch M1 unmet',
    ])
  })
})

// Final review F1. A hold that lifts after the gate ran is a new judgment, like moved content:
// the verdict never ran the criterion, so approving it — or shipping on an approval it
// predates — would merge a criterion no gate ever ran.
describe('a hold lifted after the gate ran (A10 · final review F1)', () => {
  it('approve refuses and the block recommends re-running the gate', async () => {
    const { repo, planId, scenario, ctx } = await heldFlow()
    addOrigin(repo)
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await runShip(ctx, planId)                                         // gate phase → the ship stop
    await repo.cli(['satisfy', 'auth-refresh', '--need', 'prod'])
    const show = await repo.cli(['decide', 'ship', planId, '--show'], { env: gateEnv(scenario) })
    expect(show.stdout).toContain(`witness gate ship ${planId}`)
    const approve = await repo.cli(['decide', 'ship', planId, '--approve'], { env: gateEnv(scenario) })
    expect(approve.code).toBe(2)
    expect(approve.stderr).toContain('hold-lifted')
    expect(approve.stderr).toContain('ac-prod')
  })
  it('an approval the hold lifted after re-gates instead of opening the PR', async () => {
    const { repo, planId, scenario, ctx } = await heldFlow()
    addOrigin(repo)
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await runShip(ctx, planId)
    expect((await repo.cli(['decide', 'ship', planId, '--approve'], { env: gateEnv(scenario) })).code).toBe(0)
    await repo.cli(['satisfy', 'auth-refresh', '--need', 'prod'])
    expect(await runShip(ctx, planId)).toBe(1)                         // re-gated: ac-prod now runs and fails
    const gh = join(scenario, 'gh-calls')
    expect(existsSync(gh) ? readFileSync(gh, 'utf8') : '').not.toContain('pr create')
    const lane = laneOf(runs(repo, planId).filter((r) => r.gate === 'ship').at(-1)!)
    expect(lane).toMatchObject({ ok: false, detail: 'ac-rotate:ok · ac-prod:fail' })
  })
})
