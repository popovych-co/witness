import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import type { GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec, writePlan, approve } from './helpers.js'

const PAIR_CLEAN = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [],
}
const runs = (repo: { root: string }) =>
  readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

async function planRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  const scenario = fakeScenario()
  putVerdict(scenario, PAIR_CLEAN)
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  return { repo, scenario, ctx }
}

describe('plan gate', () => {
  it('green path: pair-covering clean verdict auto-passes and stamps approved', async () => {
    const { repo, ctx } = await planRepo()
    expect(await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })).toBe(0)
    expect(runs(repo)[0]!.outcome).toBe('passed')
    expect(runs(repo)[0]!.artifact_sha).toMatch(/^[0-9a-f]{64}$/)
    expect(findById(loadCanon(repo.root), 'auth-refresh-plan-1')!.meta.status).toBe('approved')
  })

  it('a parent amendment fails pin-fresh AND re-keys the verdict cache', async () => {
    const { repo, ctx } = await planRepo()
    await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })   // passed
    await writeSpec(repo, 'auth-refresh', { summary: 'amended after the plan was written' })
    expect(await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: false, manual: false })).toBe(1)
    const all = runs(repo)
    expect(all.length).toBe(2)                                     // no stale resume — pair sha moved
    expect(all[1]!.reviewed_sha).not.toBe(all[0]!.reviewed_sha)
    const pin = all[1]!.checks.find((c) => c.name === 'pin-fresh')!
    expect(pin.ok).toBe(false)
    const parentCheck = all[1]!.checks.find((c) => c.name === 'parent-approved')!
    expect(parentCheck.ok).toBe(false)                             // amendment reset parent to draft
  })

  it('coverage must span both docs of the pair — plan-only coverage is malformed', async () => {
    const { repo, scenario, ctx } = await planRepo()
    putVerdict(scenario, {
      coverage: [{ anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' }],
      findings: [],
    })
    expect(await runGate(ctx, 'plan', 'auth-refresh-plan-1', { fresh: true, manual: false })).toBe(1)
    expect(runs(repo).at(-1)!.outcome).toBe('malformed')
  })

  it('refuses a plan no effort ever wrote', async () => {
    const { repo } = await planRepo()
    repo.write('plans/orphan-plan.md', '---\nid: orphan-plan\ntype: plan\nstatus: draft\nparent: auth-refresh\nderives-from: deadbeef\n---\n## Step: s1\nx\n')
    repo.git('add', '-A'); repo.git('commit', '-m', 'orphan')
    const r = await repo.cli(['gate', 'plan', 'orphan-plan'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('no-effort')
  })
})
