import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { runShip } from '../src/ship.js'
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
const ROW = { criterion: 'ac-prod', need: 'prod', satisfy: 'witness satisfy auth-refresh --need prod' }

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
