import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../src/gates/index.js'
import { diffBase, evidenceForDiff } from '../src/evidence.js'
import { loadConfig } from '../src/config.js'
import { readStream, type Entry } from '../src/journal.js'
import { movesFlow } from '../src/progress.js'
import type { GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { stepProgress, stepsLine } from '../src/steps.js'
import {
  behaviorOnMain, commitEntry, fakeScenario, fixtureEnv, gateEnv, putVerdict, shippableRepo, writePlan,
  type TestRepo,
} from './helpers.js'

// Row 241 (design §4.2.4, R10). A verify-red that finds a step's behavior already on the base closes
// the step "already present" — a `step-close` marked present, an act, once, while the step is open —
// and its next row is the step's green. The evidence check passes such a tag once that green passes,
// and carries `already present: <step>` to the reviewers, who judge whether the test tells anything.

const CLEAN = {
  coverage: ['.gitignore', 'package.json', 'src/token.ts', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' })),
  findings: [],
}
const closes = (repo: TestRepo, planId: string) =>
  readStream(repo.root, planId).filter((e) => e.t === 'step-close').map((e) => ({ t: e.t, step: e.step, present: e.present }))
const nextLine = async (repo: TestRepo) => (await repo.cli(['next'])).stdout.split('\n').find((l) => l.startsWith('next: '))?.slice(6)
const report = (repo: TestRepo, wt: string, planId: string) => {
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error('cfg')
  const base = diffBase(wt, cfg.value)
  if (!base.ok) throw new Error('base')
  return evidenceForDiff(wt, repo.root, findById(loadCanon(repo.root), planId)!, base.value)
}
// What verifyRed journals for a red that passed with the plan's change set aside (P30's shape).
const presentRed = (planId: string, step = 's1') => ({
  t: 'test-evidence' as const, artifact: planId, phase: 'red', runner: 'filtered', reconstructed: true, vacuous: true, step,
  tests: [{ name: 'rotates token before expiry @spec:auth-refresh', ok: true }],
})

describe('a step already on the base (row 241)', () => {
  it('verify-red that finds the step on the base closes it present, as an act, once', async () => {
    const { repo, wt, planId } = await behaviorOnMain()
    await repo.cli(['verify-red', planId, '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(closes(repo, planId)).toEqual([{ t: 'step-close', step: 's1', present: true }])
    expect(movesFlow(readStream(repo.root, planId).at(-1) as Entry)).toBe(true)
    expect(stepsLine(stepProgress(findById(loadCanon(repo.root), planId)!, readStream(repo.root, planId)))).toBe('1/3 done · next s2')
    await repo.cli(['verify-red', planId, '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(closes(repo, planId)).toHaveLength(1)
    // with later steps open, the present step's green is still the next row
    expect(await nextLine(repo)).toBe(`witness test-evidence ${planId} --phase green --step s1`)
  }, 180_000)

  it('the next row after a present red is the step\'s green (P30 inverted)', async () => {
    const { repo, planId } = await shippableRepo()
    commitEntry(repo, planId, presentRed(planId))
    expect(await nextLine(repo)).toBe(`witness test-evidence ${planId} --phase green --step s1`)
  }, 180_000)

  it('the tag passes once that green passes; a tag with no red never passes', async () => {
    const { repo, wt, planId } = await shippableRepo()
    commitEntry(repo, planId, presentRed(planId))
    expect(report(repo, wt, planId)).toMatchObject({ satisfied: false, required: [{ red: true, green: false, vacuous: false, present: true }] })
    const g = await repo.cli(['test-evidence', planId, '--phase', 'green', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(g.code).toBe(0)
    expect(report(repo, wt, planId).satisfied).toBe(true)

    const fresh = await behaviorOnMain()
    await fresh.repo.cli(['test-evidence', fresh.planId, '--phase', 'green', '--step', 's1'], { cwd: fresh.wt, env: fixtureEnv() })
    expect(report(fresh.repo, fresh.wt, fresh.planId)).toMatchObject({ satisfied: false, required: [{ red: false }] })
  }, 240_000)

  // Final review: "already present" closes a step. A reconstructed red that names no step — a fix
  // round's after an implement gate — stands for no red, so the fix still owes a genuine one.
  it('a fix round\'s vacuous verify-red, naming no step, does not pass the evidence check', async () => {
    const { repo, wt, planId } = await shippableRepo()
    commitEntry(repo, planId, { ...presentRed(planId), step: undefined })
    await repo.cli(['test-evidence', planId, '--phase', 'green'], { cwd: wt, env: fixtureEnv() })
    const r = report(repo, wt, planId)
    expect(r.satisfied).toBe(false)
    expect(r.required[0]).not.toHaveProperty('present')
  }, 180_000)

  it('the gate\'s battery input and the stop\'s evidence carry already present: s1 — its test passed before any change', async () => {
    const { repo, wt, planId } = await shippableRepo()
    commitEntry(repo, planId, presentRed(planId))
    await repo.cli(['test-evidence', planId, '--phase', 'green', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    await repo.cli(['gate', 'implement', planId], { env: gateEnv(scenario) })
    const run = readStream(repo.root, planId).filter((e) => e.t === 'gate-run').at(-1) as unknown as GateRunEntry
    const evidence = run.checks.find((c) => c.name === 'evidence')!
    expect(evidence.ok).toBe(true)
    expect(evidence.detail).toContain('already present: s1 — its test passed before any change')
    const calls = join(scenario, 'claude-calls')
    const prompts = readdirSync(calls).filter((d) => /^call-\d+$/.test(d)).map((d) => readFileSync(join(calls, d, 'stdin'), 'utf8'))
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.every((p) => p.includes('already present: s1 — its test passed before any change'))).toBe(true)
  }, 180_000)

  // Review Focus 5
  it('a present close for a step the amendment renamed is ignored; the renamed step reads open', async () => {
    const { repo, wt, planId } = await behaviorOnMain()
    await repo.cli(['verify-red', planId, '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(closes(repo, planId)).toHaveLength(1)
    const w = await writePlan(repo, planId, {
      steps: [
        { id: 's1b', title: 'renamed', criteria: ['ac-rotate'] },
        { id: 's2', title: 'second', criteria: ['ac-rotate'] },
        { id: 's3', title: 'third', scaffolding: true },
      ],
    }, '## Step: s1b\nA.\n\n## Step: s2\nB.\n\n## Step: s3\nC.\n')
    expect(w.code).toBe(0)
    expect(stepsLine(stepProgress(findById(loadCanon(repo.root), planId)!, readStream(repo.root, planId)))).toBe('0/3 done · next s1b')
  }, 180_000)
})
