import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { loadConfig } from '../src/config.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { canonicalSha, planContentSha } from '../src/sha.js'
import {
  fakeCtx, fakeScenario, gateEnv, nextLine, putVerdict, shippableRepo, writePlan,
} from './helpers.js'

async function settleImplementGate(repo: { root: string }, wt: string, planId: string): Promise<void> {
  const cfg = loadConfig(repo.root)
  const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
  const files = changedFiles(wt, base.ok ? base.value : '')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] })
  const code = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })
  if (code !== 0) throw new Error(`implement gate did not settle: exit ${code}`)
}

describe('planContentSha', () => {
  it('moves on body and step changes but never on derives-from', () => {
    const meta = {
      id: 'p', type: 'plan', status: 'draft', parent: 's', 'derives-from': 'a'.repeat(64),
      depends: [], needs: [], steps: [],
    }
    const base = planContentSha(meta, '## Step: s1\nwork\n')
    expect(planContentSha({ ...meta, 'derives-from': 'b'.repeat(64) }, '## Step: s1\nwork\n')).toBe(base)
    expect(planContentSha({ ...meta, status: 'in-progress' }, '## Step: s1\nwork\n')).toBe(base)
    expect(planContentSha(meta, '## Step: s1\nwork harder\n')).not.toBe(base)
    // and it is NOT canonicalSha: that one still counts derives-from
    expect(canonicalSha(meta, '## Step: s1\nwork\n')).not.toBe(base)
  })
})

describe('the implement gate re-arms on plan content', () => {
  it('lapses a settled gate when the plan is re-authored', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    const rewritten = await writePlan(repo, planId, {
      steps: [{ id: 's1', title: 'rotate tokens on refresh, bounded to 15m', criteria: ['ac-rotate'] }],
    })
    expect(rewritten.code).toBe(0)

    const out = await nextLine(repo)
    expect(out).toContain(`witness gate implement ${planId}`)
    expect(out).toContain('approval lapsed')

    await repo.cli(['clean'])
  })

  it('does not lapse when only derives-from moves — ship repins inside the gate txn', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    repo.setMeta(planId, { 'derives-from': 'f'.repeat(64) })
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    await repo.cli(['clean'])
  })
})
