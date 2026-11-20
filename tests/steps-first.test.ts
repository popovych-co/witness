import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../src/gates/index.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { readStream } from '../src/journal.js'
import { diffReviewedSha, implementReviewedSha } from '../src/reviewed.js'
import { findById, loadCanon } from '../src/scan.js'
import { rebaseIfMoved } from '../src/ship.js'
import { humanApprovedPastSteps } from '../src/verbs/next.js'
import { addOrigin, commitEntry, fixtureEnv, shippableRepo, writePlan, type TestRepo } from './helpers.js'

// Row 241 (design §4.2.1–§4.2.2, R7, R8). A plan's unbuilt steps are its next work before and after an
// implement gate, and above its PR; `--step` is owed after the gate while a criteria step is open. A
// human's approve on the plan content it judged stays final (row 93), and ship's rebase does not end it.

const TWO = {
  steps: [
    { id: 's1', title: 'rotate tokens on refresh', criteria: ['ac-rotate'] },
    { id: 's2', title: 'added by an amendment', criteria: ['ac-rotate'] },
  ],
}
const TWO_BODY = '## Step: s1\nImplement rotation with TDD.\n\n## Step: s2\nAdded after the gate.\n'
const nextLine = async (repo: TestRepo, cwd?: string) =>
  (await repo.cli(['next'], cwd ? { cwd } : {})).stdout.split('\n').find((l) => l.startsWith('next: '))?.slice(6)
const S2_RED = (planId: string) => `witness test-evidence ${planId} --phase red --step s2`

// An implement run journaled on the plan and the tree as they stand, with its diff half (row 135).
function implementRun(repo: TestRepo, wt: string, planId: string, outcome = 'stopped'): void {
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error('cfg')
  const base = diffBase(wt, cfg.value)
  if (!base.ok) throw new Error('base')
  const plan = findById(loadCanon(repo.root), planId)!
  commitEntry(repo, planId, {
    t: 'gate-run', gate: 'implement', artifact: planId, round: 1, run_id: 'ri-1',
    reviewed_sha: implementReviewedSha(wt, base.value, plan), diff_sha: diffReviewedSha(wt, base.value),
    prompts_sha: 'p', witness: '0', model: 'm', checks: [], verdicts: [], outcome,
  })
}
const approve = (planId: string, selected?: 'policy' | 'arbiter') => ({
  t: 'human-decision' as const, gate: 'implement', artifact: planId, round: 1, decision: 'approve', override: true,
  ...(selected !== undefined ? { selected } : {}),
})

describe('unbuilt steps come first (row 241)', () => {
  it('#89: an amendment after an implement gate routes the new step, not gate implement', async () => {
    const { repo, wt, planId } = await shippableRepo()
    implementRun(repo, wt, planId, 'passed')
    expect((await writePlan(repo, planId, TWO, TWO_BODY)).code).toBe(0)
    expect(await nextLine(repo)).toBe(S2_RED(planId))
  }, 180_000)

  it('a plan with a PR that gains a step routes the step above witness ship (P8, P21 inverted)', async () => {
    const { repo, planId } = await shippableRepo()
    expect((await writePlan(repo, planId, TWO, TWO_BODY)).code).toBe(0)
    repo.setMeta(planId, { pr: 7 })
    expect(await nextLine(repo)).toBe(S2_RED(planId))
  }, 180_000)

  it('--step is required after the gate while a criteria step is open, and not in a fix round', async () => {
    const { repo, wt, planId } = await shippableRepo()
    implementRun(repo, wt, planId)
    // every step closed: an untagged cycle is a fix round
    const fix = await repo.cli(['test-evidence', planId, '--phase', 'green'], { cwd: wt, env: fixtureEnv() })
    expect(fix.stdout + fix.stderr).not.toContain('step-required')
    expect((await writePlan(repo, planId, TWO, TWO_BODY)).code).toBe(0)
    const owed = await repo.cli(['test-evidence', planId, '--phase', 'red'], { cwd: wt, env: fixtureEnv() })
    expect(owed.code).toBe(2)
    expect(owed.stderr).toContain('step-required')
  }, 180_000)

  it('a human approve on the plan content it judged carries past an open step, and ship\'s rebase does not end it (P28 inverted)', async () => {
    const { repo, wt, planId } = await shippableRepo()
    addOrigin(repo)
    expect((await writePlan(repo, planId, TWO, TWO_BODY)).code).toBe(0)
    implementRun(repo, wt, planId)
    commitEntry(repo, planId, approve(planId))
    const plan = () => findById(loadCanon(repo.root), planId)!
    expect(humanApprovedPastSteps(readStream(repo.root, planId), plan())).toBe(true)
    expect(await nextLine(repo)).toBe(`witness ship ${planId}`)
    // another flow's merge lands on the remote, and ship's gate phase rebases onto it
    const other = `${repo.root}-other`
    execFileSync('git', ['clone', '-q', `${repo.root}-origin.git`, other])
    writeFileSync(join(other, 'OTHER.md'), 'another flow merged\n')
    execFileSync('git', ['add', 'OTHER.md'], { cwd: other })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'Merge PR #9'], { cwd: other })
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other })
    expect(rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: false, env: {} })).toMatchObject({ ok: true, value: 'rebased' })
    expect(humanApprovedPastSteps(readStream(repo.root, planId), plan())).toBe(true)
    expect(await nextLine(repo)).not.toBe(S2_RED(planId))
    // an amendment changes the plan's content: the pass ends, and the step routes
    expect((await writePlan(repo, planId, { steps: [...TWO.steps, { id: 's3', title: 'third', criteria: ['ac-rotate'] }] },
      `${TWO_BODY}\n## Step: s3\nThird.\n`)).code).toBe(0)
    expect(humanApprovedPastSteps(readStream(repo.root, planId), plan())).toBe(false)
    expect(await nextLine(repo)).toBe(S2_RED(planId))
  }, 180_000)

  it('a policy or arbiter approve gets no such pass', async () => {
    for (const by of ['policy', 'arbiter'] as const) {
      const { repo, wt, planId } = await shippableRepo()
      expect((await writePlan(repo, planId, TWO, TWO_BODY)).code).toBe(0)
      implementRun(repo, wt, planId)
      commitEntry(repo, planId, approve(planId, by))
      expect(humanApprovedPastSteps(readStream(repo.root, planId), findById(loadCanon(repo.root), planId)!), by).toBe(false)
      expect(await nextLine(repo), by).toBe(S2_RED(planId))
    }
  }, 240_000)

  it('a step built untagged after a gate under 0.28 is re-witnessed with no code change (P31 shape)', async () => {
    const { repo, wt, planId } = await shippableRepo()
    implementRun(repo, wt, planId, 'passed')
    // what 0.28 let a session journal after the gate: s2's cycle with no step tag
    commitEntry(repo, planId, { t: 'test-evidence', artifact: planId, phase: 'red', runner: 'filtered', w: '0.28.3',
      tests: [{ name: 'rotates token before expiry @spec:auth-refresh', ok: false }] })
    commitEntry(repo, planId, { t: 'test-evidence', artifact: planId, phase: 'green', runner: 'filtered', w: '0.28.3',
      tests: [{ name: 'rotates token before expiry @spec:auth-refresh', ok: true }] })
    expect((await writePlan(repo, planId, TWO, TWO_BODY)).code).toBe(0)
    expect(await nextLine(repo)).toBe(S2_RED(planId))
  }, 180_000)
})
