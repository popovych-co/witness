import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../src/gates/index.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { readStream } from '../src/journal.js'
import { diffReviewedSha, implementReviewedSha } from '../src/reviewed.js'
import type { GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { settleStop } from '../src/settle.js'
import { mergeOwnPr, runShip } from '../src/ship.js'
import { worktreePath } from '../src/worktree.js'
import {
  addOrigin, autonomyOn, callCount, commitEntry, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, writePlan, type TestRepo,
} from './helpers.js'

// Row 241 (design §4.2.3, §4.2.6; R9, R12; the user's decisions 6 and 9). No implement review starts
// while a step is open, whoever starts it: `gate implement` and `witness ship` refuse `steps-open`
// before the battery, journaling nothing; the ship gate's implement-gate check fails; the merge holds;
// and a settle's routed re-run is the flow's step row, never `gate implement`.

const TWO = {
  steps: [
    { id: 's1', title: 'rotate tokens on refresh', criteria: ['ac-rotate'] },
    { id: 's2', title: 'added by an amendment', criteria: ['ac-rotate'] },
  ],
}
const TWO_BODY = '## Step: s1\nImplement rotation with TDD.\n\n## Step: s2\nAdded after the gate.\n'
const CLEAN = {
  coverage: ['.gitignore', 'package.json', 'src/token.ts', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' })),
  findings: [],
}
const S2 = (planId: string) => `witness test-evidence ${planId} --phase red --step s2`
const cfgOf = (repo: TestRepo) => { const r = loadConfig(repo.root); if (!r.ok) throw new Error('cfg'); return r.value }

async function amended(): Promise<{ repo: TestRepo; wt: string; planId: string }> {
  const seed = await shippableRepo()
  expect((await writePlan(seed.repo, seed.planId, TWO, TWO_BODY)).code).toBe(0)
  return seed
}
// An implement run on the plan and tree as they stand, then a human's approve of it (row 93).
function humanApproved(repo: TestRepo, wt: string, planId: string): void {
  const base = diffBase(wt, cfgOf(repo))
  if (!base.ok) throw new Error('base')
  const plan = findById(loadCanon(repo.root), planId)!
  commitEntry(repo, planId, {
    t: 'gate-run', gate: 'implement', artifact: planId, round: 1, run_id: 'ri-1',
    reviewed_sha: implementReviewedSha(wt, base.value, plan), diff_sha: diffReviewedSha(wt, base.value),
    prompts_sha: 'p', witness: '0', model: 'm', checks: [], verdicts: [], outcome: 'stopped',
  })
  commitEntry(repo, planId, { t: 'human-decision', gate: 'implement', artifact: planId, round: 1, decision: 'approve', override: true })
}

describe('no implement review starts while a step is open (row 241)', () => {
  it('gate implement refuses steps-open before the battery, journaling nothing', async () => {
    const { repo, planId } = await amended()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const before = readStream(repo.root, planId).length
    const r = await repo.cli(['gate', 'implement', planId], { env: gateEnv(scenario) })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('steps-open')
    expect(r.stderr).toContain(`${S2(planId)} — s2 is not built yet`)
    expect(callCount(scenario)).toBe(0)
    expect(readStream(repo.root, planId).length).toBe(before)
  }, 180_000)

  it('witness ship refuses steps-open whoever runs it, a drive session included', async () => {
    for (const env of [{}, { WITNESS_DRIVE: 'auth-refresh-plan-1' }]) {
      const { repo, planId } = await amended()
      addOrigin(repo)
      const scenario = fakeScenario()
      putVerdict(scenario, CLEAN)
      const before = readStream(repo.root, planId).length
      const errs: string[] = []
      const code = await runShip(fakeCtx(repo.root, { env: { ...gateEnv(scenario), ...env }, err: (l) => errs.push(l) }), planId)
      expect(code).toBe(2)
      expect(errs.join('\n')).toContain('steps-open')
      expect(callCount(scenario)).toBe(0)
      expect(readStream(repo.root, planId).length).toBe(before)
    }
  }, 240_000)

  it('the ship gate\'s implement-gate check fails while a step is open', async () => {
    const { repo, planId } = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    await repo.cli(['gate', 'implement', planId], { env: gateEnv(scenario) })
    expect((await writePlan(repo, planId, TWO, TWO_BODY)).code).toBe(0)
    await repo.cli(['gate', 'ship', planId], { env: gateEnv(scenario) })
    const run = readStream(repo.root, planId).filter((e) => e.t === 'gate-run' && (e as unknown as GateRunEntry).gate === 'ship').at(-1) as unknown as GateRunEntry
    const check = run.checks.find((c) => c.name === 'implement-gate')!
    expect(check.ok).toBe(false)
    expect(check.detail).toContain(`s2 is open — ${S2(planId)}`)
  }, 180_000)

  it('the merge holds while a step is open, and merges nothing', async () => {
    const { repo, planId } = await amended()
    addOrigin(repo)
    autonomyOn(repo)
    const scenario = fakeScenario()
    const out: string[] = []
    const code = await mergeOwnPr(fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => out.push(l) }), repo.root, cfgOf(repo), planId, 7)
    expect(code).toBe(1)
    expect(out.join('\n')).toContain('merge: held — s2 is not built yet')
    let calls = ''
    try { calls = readFileSync(join(scenario, 'gh-calls'), 'utf8') } catch { /* none */ }
    expect(calls).not.toContain('pr merge')
  }, 180_000)

  it('a human-approved-past plan passes all three', async () => {
    const { repo, wt, planId } = await amended()
    addOrigin(repo)
    humanApproved(repo, wt, planId)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const g = await repo.cli(['gate', 'implement', planId], { env: gateEnv(scenario) })
    expect(g.stderr).not.toContain('steps-open')
    const errs: string[] = []
    await runShip(fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => errs.push(l) }), planId)
    expect(errs.join('\n')).not.toContain('steps-open')
    const ship = readStream(repo.root, planId).filter((e) => e.t === 'gate-run' && (e as unknown as GateRunEntry).gate === 'ship').at(-1) as unknown as GateRunEntry
    expect(ship.checks.find((c) => c.name === 'implement-gate')?.detail).not.toContain('is open')
  }, 240_000)

  it('decide names the step\'s command when nothing is pending on an implement gate with a step open (P29)', async () => {
    const { repo, planId } = await amended()
    const r = await repo.cli(['decide', 'implement', planId, '--approve', '--override', '--note', 'past s2'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('nothing-pending')
    expect(r.stderr).toContain(S2(planId))
    expect(r.stderr).not.toContain(`witness gate implement ${planId}`)
  }, 180_000)

  it('a stale implement stop with a step open routes the step row (stage implement, home, model), never gate implement', async () => {
    const { repo, wt, planId } = await amended()
    autonomyOn(repo)
    commitEntry(repo, planId, {
      t: 'gate-run', gate: 'implement', artifact: planId, round: 1, run_id: 'ri-1', reviewed_sha: 'old', diff_sha: 'old',
      prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
      verdicts: [{ reviewer: 'code-reviewer', coverage: [], findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'x' }] }],
    })
    const s = await settleStop(fakeCtx(repo.root), repo.root, cfgOf(repo), 'implement', planId)
    expect(s.kind).toBe('routed')
    if (s.kind !== 'routed') return
    expect(s.act.line).toBe(S2(planId))
    expect(s.row).toMatchObject({ line: S2(planId), stage: 'implement', home: worktreePath(repo.root, planId) })
    const out = (await repo.cli(['next'])).stdout.split('\n')
    expect(out).toContain(`next: ${S2(planId)}`)
    expect(out).toContain('stage: implement')
    expect(out.some((l) => l.startsWith('next: witness gate implement'))).toBe(false)
    void wt
  }, 180_000)
})
