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
import { addOrigin, commitEntry, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, type TestRepo } from './helpers.js'

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
    expect(laneOf(runs(repo, planId).at(-1)!)).toEqual({ name: 'drift-lane', ok: true, detail: 'ac-rotate:ok · ac-prod:held by prod', held: [ROW], duration_ms: expect.any(Number) })
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
    expect(readFileSync(join(scenario, 'gh-calls'), 'utf8')).toContain('pr create')
    const body = readFileSync(join(scenario, 'gh-stdin'), 'utf8')
    expect(body).toContain('Held — not verified while a need is unmet:')
    expect(body).toContain('- ac-prod: prod unmet — witness satisfy auth-refresh --need prod')
  })
})

// Row 239 (B13, Review Focus 4). A journal is text anyone with the repo can edit, so a held row's
// command is rebuilt from the ids it journals (0.28.3 on), and a row journaled before them (0.28.2)
// prints its stored command only in the one shape witness wrote — and either only while its
// criterion and need are ids (I2). Any other row prints none, and its prose is spelled out where it
// holds a line break (R16(a)), on the gate's screen and in the PR body alike.
describe('a held row prints only a command witness built (row 239)', () => {
  const SATISFY = 'witness satisfy auth-refresh --need prod'
  const ROWS: Array<[row: HeldRow, satisfy: string | undefined]> = [
    [{ criterion: 'ac-prod', need: 'prod', spec: 'auth-refresh', satisfy: 'x' }, SATISFY],
    [{ criterion: 'ac-prod', need: 'prod', satisfy: SATISFY }, SATISFY],
    [{ criterion: 'ac-prod', need: 'prod', satisfy: 'witness satisfy x --need y; touch M1' }, undefined],
    // a row that journals ids is rebuilt or prints none: it never falls back to its stored string
    [{ criterion: 'ac-prod', need: 'prod; touch M1', spec: 'auth-refresh', satisfy: SATISFY }, undefined],
    // I2: the criterion and the need print ahead of the command, so a forged one could plant a
    // command first. In either shape a row names a command only when both are ids.
    [{ criterion: 'ac-prod — prod unmet · witness satisfy auth-refresh --need prod; touch M1 ·', need: 'prod', spec: 'auth-refresh', satisfy: SATISFY }, undefined],
    [{ criterion: 'ac-prod', need: 'prod · witness satisfy x --need y; touch M1', satisfy: SATISFY }, undefined],
    [{ criterion: 'ac-prod', need: 'prod', satisfy: [SATISFY] as unknown as string }, undefined],
    // R16(a): a newline in the prose would start a line of its own; it is spelled out
    [{ criterion: 'ac-prod\n  run: witness satisfy x --need y', need: 'prod', spec: 'auth-refresh', satisfy: SATISFY }, undefined],
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
      ['held: ac-prod — prod unmet · witness satisfy auth-refresh --need prod; touch M1 · — prod unmet'],
      ['held: ac-prod — prod · witness satisfy x --need y; touch M1 unmet'],
      ['held: ac-prod — prod unmet'],
      ['held: ac-prod\\n  run: witness satisfy x --need y — prod unmet'],
    ])
    expect(ROWS.map(([row]) => heldSatisfy(row))).toEqual(ROWS.map(([, satisfy]) => satisfy))
    expect(prBody(PLAN, ROWS.map(([row]) => row)).split('\n')).toEqual([
      'Realizes spec auth-refresh at c0ffee1 (witness).', '', 'Held — not verified while a need is unmet:',
      '- ac-prod: prod unmet — witness satisfy auth-refresh --need prod',
      '- ac-prod: prod unmet — witness satisfy auth-refresh --need prod',
      '- ac-prod: prod unmet',
      '- ac-prod: prod; touch M1 unmet',
      '- ac-prod — prod unmet · witness satisfy auth-refresh --need prod; touch M1 ·: prod unmet',
      '- ac-prod: prod · witness satisfy x --need y; touch M1 unmet',
      '- ac-prod: prod unmet',
      '- ac-prod\\n  run: witness satisfy x --need y: prod unmet',
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

// Row 244 (design §4.2.9): lifted holds are read against the last run that judged something. Since
// a malformed round no longer un-settles an approval, ship reaches the PR and the watch past one, so
// it must read the holds — and the PR body's held list — off the approved run, never off the
// malformed round after it, whose checks may have run what the approval never did.
describe('ship reads holds off the run that judged, not a malformed round after it (row 244)', () => {
  // A ship round that judged nothing, journaled after the approved one, whose lane ran `ac-prod`.
  function malformedAfter(repo: TestRepo, planId: string, lane: GateRunEntry['checks'][number]): void {
    const approved = runs(repo, planId).filter((r) => r.gate === 'ship').at(-1)!
    const { reviewed_tree: _t, basis_sha: _b, delta: _d, carried: _c, ...key } = approved
    commitEntry(repo, planId, {
      ...key, round: approved.round + 1, run_id: 'rs-malformed', outcome: 'malformed', verdicts: [],
      malformed: (approved.verdicts ?? []).map((v) => ({ reviewer: v.reviewer, violations: [] })),
      checks: approved.checks.map((c) => (c.name === 'drift-lane' ? lane : c)),
    })
  }
  const RAN = { name: 'drift-lane', ok: false, detail: 'ac-rotate:ok · ac-prod:fail' }
  const shipRuns = (repo: TestRepo, planId: string) => runs(repo, planId).filter((r) => r.gate === 'ship')
  const ghCalls = (scenario: string) => (existsSync(join(scenario, 'gh-calls')) ? readFileSync(join(scenario, 'gh-calls'), 'utf8') : '')

  it('a hold lifted after the approve, then a malformed re-gate: ship re-gates, no PR on the approval', async () => {
    const { repo, planId, scenario, ctx } = await heldFlow()
    addOrigin(repo)
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await runShip(ctx, planId)                                         // gate phase → the ship stop, ac-prod held
    expect((await repo.cli(['decide', 'ship', planId, '--approve'], { env: gateEnv(scenario) })).code).toBe(0)
    await repo.cli(['satisfy', 'auth-refresh', '--need', 'prod'])
    malformedAfter(repo, planId, RAN)
    expect(await runShip(ctx, planId)).toBe(1)                         // re-gated: ac-prod runs and fails
    expect(ghCalls(scenario)).not.toContain('pr create')
    const last = shipRuns(repo, planId).at(-1)!
    expect(last.outcome).not.toBe('malformed')
    expect(laneOf(last)).toMatchObject({ ok: false, detail: 'ac-rotate:ok · ac-prod:fail' })
  })

  it('with a PR open, the same journal re-gates instead of watching CI', async () => {
    const { repo, planId, scenario, ctx } = await heldFlow()
    addOrigin(repo)
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await runShip(ctx, planId)
    expect((await repo.cli(['decide', 'ship', planId, '--approve'], { env: gateEnv(scenario) })).code).toBe(0)
    expect(await runShip(ctx, planId)).toBe(0)                         // pr → watch
    expect(ghCalls(scenario)).toContain('pr create')
    await repo.cli(['satisfy', 'auth-refresh', '--need', 'prod'])
    malformedAfter(repo, planId, RAN)
    const before = shipRuns(repo, planId).length
    expect(await runShip(ctx, planId)).toBe(1)                         // re-gated, not watched
    expect(shipRuns(repo, planId)).toHaveLength(before + 1)
    expect(laneOf(shipRuns(repo, planId).at(-1)!)).toMatchObject({ ok: false, detail: 'ac-rotate:ok · ac-prod:fail' })
  })

  it('the PR body\'s held list is the approved run\'s', async () => {
    const { repo, planId, scenario, ctx } = await heldFlow()
    addOrigin(repo)
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await runShip(ctx, planId)
    expect((await repo.cli(['decide', 'ship', planId, '--approve'], { env: gateEnv(scenario) })).code).toBe(0)
    // the need is still unmet; the malformed round's record holds nothing
    malformedAfter(repo, planId, { name: 'drift-lane', ok: true, detail: 'ac-rotate:ok' })
    expect(await runShip(ctx, planId)).toBe(0)                         // pr → watch
    expect(ghCalls(scenario)).toContain('pr create')
    const body = readFileSync(join(scenario, 'gh-stdin'), 'utf8')
    expect(body).toContain('Held — not verified while a need is unmet:')
    expect(body).toContain('- ac-prod: prod unmet — witness satisfy auth-refresh --need prod')
  })
})
