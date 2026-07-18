import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { loadConfig } from '../src/config.js'
import {
  approve, fakeCtx, fakeScenario, gateEnv, nextLine, putVerdict, seededRepo, shippableRepo, writePlan, writeSpec,
} from './helpers.js'
import { worktreePath } from '../src/worktree.js'
import type { TestRepo } from './helpers.js'

// Drive a plan's implement gate to `passed`. The battery is a fake whose verdict covers
// the diff, mirroring tests/gate-implement.test.ts's green path.
async function settleImplementGate(repo: { root: string }, wt: string, planId: string): Promise<void> {
  const cfg = loadConfig(repo.root)
  const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
  const files = changedFiles(wt, base.ok ? base.value : '')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] })
  const code = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })
  if (code !== 0) throw new Error(`implement gate did not settle: exit ${code}`)
}

// Drive a plan's ship gate to its standing stop, leaving a pending human decision.
async function stopShipGate(repo: TestRepo, wt: string, planId: string): Promise<void> {
  const cfg = loadConfig(repo.root)
  const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
  const files = changedFiles(wt, base.ok ? base.value : '')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] })
  await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'ship', planId, { fresh: false, manual: false })
}

// Two concurrent flows: the shippable one (evidence satisfied) plus a second plan that
// has only just started, so it sits at the test-evidence rung.
async function twoFlows(): Promise<{ repo: TestRepo; wt: string; planId: string }> {
  const { repo, wt, planId } = await shippableRepo()
  await writeSpec(repo, 'auth-logout', { criteria: [{ id: 'ac-logout', test: '@spec:auth-logout' }] })
  approve(repo, 'auth-logout')
  await writePlan(repo, 'auth-logout-plan-1', {
    parent: 'auth-logout', steps: [{ id: 's1', title: 'log out', criteria: ['ac-logout'] }],
  })
  repo.flipStatus('auth-logout-plan-1', 'approved')
  await repo.cli(['start', 'auth-logout-plan-1'])
  return { repo, wt, planId }
}

describe('gate approval lapses on tree change', () => {
  it('re-routes to the implement gate when the worktree moves after approval', async () => {
    const { repo, wt, planId } = await shippableRepo()

    await settleImplementGate(repo, wt, planId)
    expect(await nextLine(repo)).toContain(`specflow ship ${planId}`)

    // an unignored new file changes worktreeTreeSha — the verdict now describes a
    // tree that no longer exists
    writeFileSync(join(worktreePath(repo.root, planId), 'src', 'sneaked-in.ts'), 'export const x = 1\n')

    expect(await nextLine(repo)).toContain(`specflow gate implement ${planId}`)

    await repo.cli(['clean'])
  })
})

describe('three-tier ladder', () => {
  it('advances an in-flight flow rather than gating a freshly drafted plan', async () => {
    const { repo, planId } = await shippableRepo()
    // a second plan is drafted while the first is mid-implement (tier 3 vs tier 1)
    await writeSpec(repo, 'auth-logout', { criteria: [{ id: 'ac-logout', test: '@spec:auth-logout' }] })
    approve(repo, 'auth-logout')
    await writePlan(repo, 'auth-logout-plan-1', {
      parent: 'auth-logout', steps: [{ id: 's1', title: 'log out', criteria: ['ac-logout'] }],
    })

    const out = await nextLine(repo)
    expect(out).not.toContain('gate plan auth-logout-plan-1')
    expect(out).toContain(planId)

    await repo.cli(['clean'])
  })

  it('picks one flow, most-advanced first, and names the other nowhere', async () => {
    const { repo } = await twoFlows()
    const out = await nextLine(repo)

    // exactly one flow is named — next never returns a list
    const named = ['auth-refresh-plan-1', 'auth-logout-plan-1'].filter((id) => out.includes(id))
    expect(named).toHaveLength(1)
    expect(out).not.toContain('flows[')

    await repo.cli(['clean'])
  })

  it('advances a movable flow while another waits on a human, and says so', async () => {
    const { repo, wt, planId } = await twoFlows()
    await settleImplementGate(repo, wt, planId)
    await stopShipGate(repo, wt, planId)          // standing stop → pending decision

    const out = await nextLine(repo)
    // tier 1 wins: the other flow keeps moving
    expect(out).toContain('auth-logout-plan-1')
    expect(out).not.toContain('specflow decide')
    // but the waiting decision is on screen every turn
    expect(out).toContain('note:')
    expect(out).toContain(planId)

    await repo.cli(['clean'])
  })

  it('surfaces the decision when no flow can move', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    await stopShipGate(repo, wt, planId)

    // tier 1 empty → today's behavior, unchanged
    expect(await nextLine(repo)).toContain(`specflow decide ship ${planId} --show`)

    await repo.cli(['clean'])
  })
})

describe('addressing one flow', () => {
  it('answers for the named flow only', async () => {
    const { repo, planId } = await twoFlows()
    const res = await repo.cli(['next', '--flow', 'auth-logout-plan-1'])

    expect(res.code).toBe(0)
    expect(res.stdout).toContain('auth-logout-plan-1')
    expect(res.stdout).not.toContain(planId)
    expect(res.stdout).toContain('stage: implement')

    await repo.cli(['clean'])
  })

  it('refuses an unknown id, a draft, and a terminal plan distinctly', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')   // draft

    expect((await repo.cli(['next', '--flow', 'nope-plan-1'])).stderr).toContain('unknown-flow')
    expect((await repo.cli(['next', '--flow', 'auth-refresh-plan-1'])).stderr).toContain('not-started')

    repo.flipStatus('auth-refresh-plan-1', 'done')
    expect((await repo.cli(['next', '--flow', 'auth-refresh-plan-1'])).stderr).toContain('terminal-status')
  })

  it('infers the flow from the worktree cwd', async () => {
    const { repo, planId } = await twoFlows()
    const res = await repo.cli(['next'], { cwd: worktreePath(repo.root, 'auth-logout-plan-1') })

    expect(res.code).toBe(0)
    expect(res.stdout).toContain('auth-logout-plan-1')
    expect(res.stdout).not.toContain(planId)

    await repo.cli(['clean'])
  })

  it('falls through to the global ladder from a stale worktree', async () => {
    const { repo, planId } = await twoFlows()
    const wt = worktreePath(repo.root, 'auth-logout-plan-1')
    repo.flipStatus('auth-logout-plan-1', 'done')

    // ambient context is not a claim: bare `next` in a merged flow's leftover
    // directory answers the global question rather than refusing terminal-status
    const res = await repo.cli(['next'], { cwd: wt })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain(planId)

    await repo.cli(['clean'])
  })
})
