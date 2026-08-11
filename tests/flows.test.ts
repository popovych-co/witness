import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { loadConfig } from '../src/config.js'
import {
  approve, fakeCtx, fakeScenario, gateEnv, ghState, nextLine, putVerdict, seededRepo, shippableRepo,
  stampLive, writePlan, writeSpec,
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
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    // an unignored new file changes worktreeTreeSha — the verdict now describes a
    // tree that no longer exists
    writeFileSync(join(worktreePath(repo.root, planId), 'src', 'sneaked-in.ts'), 'export const x = 1\n')

    // ...and it names the lapse. A bare `gate implement` row is indistinguishable from a
    // CLI stuck on a stale answer — which is how a human who just watched that gate pass
    // reads it, and how the reported two-session deadlock looked from the outside.
    const out = await nextLine(repo)
    expect(out).toContain(`witness gate implement ${planId}`)
    expect(out).toContain('note:')
    expect(out).toContain('approval lapsed')

    await repo.cli(['clean'])
  })

  // Two checkouts, one derivation. The reported deadlock was two sessions each routing
  // to the other, so agreement between them is the invariant worth pinning: both must
  // name the same stage and the same home, whichever side asks.
  it('agrees on stage and home from the primary root and from the worktree', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)

    const fromRoot = await nextLine(repo)
    const fromWorktree = await nextLine(repo, { cwd: wt })

    const stageOf = (o: string) => o.split('\n').find((l) => l.startsWith('stage: '))
    const homeOf = (o: string) => o.split('\n').find((l) => l.startsWith('home: '))
    expect(stageOf(fromRoot)).toBe('stage: ship')
    expect(stageOf(fromWorktree)).toBe(stageOf(fromRoot))
    expect(homeOf(fromWorktree)).toBe(homeOf(fromRoot))
    expect(homeOf(fromRoot)).toBe(`home: ${repo.root}`)

    await repo.cli(['clean'])
  })
})

describe('next surfaces what the merge stamp could not do', () => {
  // `dashboard` renders lazyStamp's stale rows; `next` computed the same rows and threw
  // them away. A plan whose PR closed unmerged can never be stamped `done`, so the flow
  // sits at ship forever — and the one verb the driving loop calls every turn said
  // nothing about it.
  // Deliberately the light fixture: a plan carrying `pr:` routes to ship from
  // flowAction's second line, so neither test evidence nor a settled gate is on this
  // path. shippableRepo would buy nothing here and costs two vitest subprocesses.
  it('renders a stale row when the merge stamp cannot proceed', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    const planId = 'auth-refresh-plan-1'
    await writePlan(repo, planId)
    repo.flipStatus(planId, 'approved')
    await repo.cli(['start', planId])
    repo.setMeta(planId, { pr: 7 })
    const scenario = fakeScenario()
    ghState(scenario, 7, 'CLOSED')

    const res = await repo.cli(['next'], { env: gateEnv(scenario) })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('stale')
    expect(res.stdout).toContain(`witness abandon ${planId}`)

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
    expect(out).not.toContain('witness decide')
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
    expect(await nextLine(repo)).toContain(`witness decide ship ${planId} --show`)

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
    // row 82: the inferred implement row names the very worktree we asked from
    expect(res.stdout).toContain(`home: ${worktreePath(repo.root, 'auth-logout-plan-1')}`)

    await repo.cli(['clean'])
  })

  it('ship row hands off home: primary root with a model-free run line', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)   // flow advances to ship
    const out = await nextLine(repo)
    expect(out).toContain(`witness ship ${planId}`)
    expect(out).toContain(`home: ${repo.root}`)
    expect(out).toContain(`run: cd '${repo.root}' && claude '/witness'`)
    expect(out).not.toContain('--model')   // session-default ship model → no flag

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

// D93: the gate owns its deterministic checks; the router reads the verdict. This
// reproduces the 0.5.1 field report — an approve the journal recorded as settled and
// `next` refused to see, because it re-derived `evidence` in front of the settle check.
describe('a settled implement gate outranks the evidence hint', () => {
  it('routes to ship after a human approve even when a deterministic check is red', async () => {
    const { repo, wt, planId } = await shippableRepo()

    // a sibling spec this plan does not own, whose tagged test the diff breaks: the
    // `regression` check goes red and no `test-evidence` can ever answer it. (Before row 97
    // this test used a foreign tag to make `evidence` unsatisfiable — that case is now
    // correctly green, so the red input moves to the check that genuinely stays red.)
    await writeSpec(repo, 'report-view', { criteria: [{ id: 'ac-view', test: '@spec:report-view' }] })
    stampLive(repo, 'report-view')
    writeFileSync(join(wt, 'tests', 'report.test.ts'),
      "import { expect, it } from 'vitest'\n\nit('renders the report @spec:report-view', () => { expect(1).toBe(2) })\n")

    const scenario = fakeScenario()
    // D126: coverage must span the reviewed diff or every reviewer fails coverage-minimum
    // and the round is `malformed` — which is no longer decidable, because no verdict parsed.
    // The stop here comes from the red regression check, which is the point of the test.
    const cfg = loadConfig(repo.root)
    const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    const files = changedFiles(wt, base.ok ? base.value : '')
    putVerdict(scenario, { coverage: files.map((f) => ({ anchor: f, note: 'read' })), findings: [] })
    const gate = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })
    expect(gate).toBe(1)                                  // stopped: the regression check is red

    const decided = await repo.cli(['decide', 'implement', planId, '--approve'])
    expect(decided.code).toBe(0)

    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    await repo.cli(['clean'])
  })
})

// Drive a plan's implement gate to `stopped`, leaving a pending human decision to revise.
async function stopImplementGate(repo: TestRepo, wt: string, planId: string): Promise<void> {
  const cfg = loadConfig(repo.root)
  const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
  const files = changedFiles(wt, base.ok ? base.value : '')
  const scenario = fakeScenario()
  putVerdict(scenario, {
    coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })),
    findings: [{ blocking: true, anchor: files[0]!, claim: 'the rotation window is unbounded' }],
  })
  await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })
}

describe('a reopen on a started plan routes', () => {
  // The entry was correct and read by nobody: `flowAction` never consulted the plan gate,
  // `computeNext`'s plan loop filters `status === 'draft'`, and `flowBlocked` saw only
  // pending decisions — so an in-progress plan's reopen was invisible by construction.
  it('sends an in-flight plan whose plan gate was reopened to plan authoring', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await stopImplementGate(repo, wt, planId)
    const r = await repo.cli(['decide', 'implement', planId, '--revise', '--upstream', planId,
      '--note', 'step s1 prescribes the wrong seam'])
    expect(r.code).toBe(0)

    const out = await nextLine(repo)
    expect(out).toContain(`witness write ${planId} --effort ${repo.effort}`)
    expect(out).toContain('stage: plan')
    // and it is still TIER 1 — a blanket flowBlocked reopen term strands it here
    expect(out).not.toContain('witness check')

    await repo.cli(['clean'])
  })

  // The other half of the split: that work belongs to the effort, and tier 3 is where it
  // surfaces, so the flow must leave tier 1.
  it('takes the flow out of tier 1 when the parent decompose is reopened', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await stopImplementGate(repo, wt, planId)
    await repo.cli(['decide', 'implement', planId, '--revise', '--upstream', 'auth-refresh',
      '--note', 'the slicing is wrong'])

    const out = await nextLine(repo)
    expect(out).not.toContain(`witness gate implement ${planId}`)
    expect(out).toContain(`witness gate decompose --effort ${repo.effort}`)

    await repo.cli(['clean'])
  })
})
