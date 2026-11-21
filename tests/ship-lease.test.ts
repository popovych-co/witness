import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../src/gates/index.js'
import { carryRef } from '../src/carry.js'
import { loadConfig } from '../src/config.js'
import { runGate } from '../src/gate.js'
import { readStream } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { createPr, leaseFor, pushApproved, pushedRef, rebaseIfMoved, recordPushed, refusalOutcome, runShip } from '../src/ship.js'
import { branchName } from '../src/worktree.js'
import { addOrigin, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, type TestRepo } from './helpers.js'

// Row 242 (design §4.3.1, last bullet; P27 inverted). Every forced push to a PR branch leases
// on the commit witness itself last pushed there, never on the tracking ref a fetch can move.

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, encoding: 'utf8' }).trim()
const tryG = (cwd: string, ...args: string[]): boolean => {
  try { g(cwd, ...args); return true } catch { return false }
}

const bareOf = (root: string): string => `${root}-origin.git`
const remoteTipOf = (root: string, branch: string): string =>
  g(root, 'ls-remote', bareOf(root), `refs/heads/${branch}`).split(/\s/)[0]!
const remoteHas = (root: string, branch: string): boolean => g(root, 'ls-remote', bareOf(root), `refs/heads/${branch}`) !== ''
// Another flow's merge lands on the remote's main, from a clone of its own (`name` names the clone);
// the plan's worktree is not told.
const moveMainOf = (root: string, name: string, files: Record<string, string> = { [`${name}.md`]: 'merged\n' }): void => {
  const other = `${root}-${name}`
  execFileSync('git', ['clone', '-q', bareOf(root), other])
  for (const [f, body] of Object.entries(files)) writeFileSync(join(other, f), body)
  g(other, 'add', ...Object.keys(files))
  g(other, 'commit', '-qm', `Merge ${name}`)
  g(other, 'push', '-q', 'origin', 'main')
}
// The branch deleted on the remote alone: this clone's tracking ref and upstream config stay behind,
// stale, so neither may be read for whether the branch exists (design §4.1.1 step 3).
const goneOnRemote = (root: string, branch: string): void => { g(bareOf(root), 'update-ref', '-d', `refs/heads/${branch}`) }
// A single-branch clone's shape: origin's fetch refspec maps main alone, so a fetch of the PR branch
// by name writes no tracking ref, and `@{upstream}` never resolves (P37, P42).
const singleBranch = (repo: TestRepo, branch: string): void => {
  repo.git('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main')
  repo.git('update-ref', '-d', `refs/remotes/origin/${branch}`)
}
const cfgOf = (root: string) => {
  const r = loadConfig(root)
  if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
  return r.value
}
const records = (root: string, planId: string) =>
  readStream(root, planId).filter((e) => e.t === 'ship-outcome').map((e) => ({ outcome: e.outcome, reason: e.reason, pr: e.pr }))
const BRANCH_GONE = 'the PR branch is gone from the remote — recreate or reopen it, or abandon the plan'

const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}

async function pushedPlan() {
  const seed = await shippableRepo()
  addOrigin(seed.repo)
  const branch = branchName(seed.planId)
  // witness's first push (createPr's), recorded as witness's own
  g(seed.wt, 'push', '-q', '-u', 'origin', branch)
  recordPushed(seed.wt, seed.planId, g(seed.wt, 'rev-parse', 'HEAD'))
  const remoteTip = () => remoteTipOf(seed.repo.root, branch)
  const moveMain = (name: string, files?: Record<string, string>) => moveMainOf(seed.repo.root, name, files)
  const collaborate = (): string => {
    const collab = `${seed.repo.root}-collab`
    execFileSync('git', ['clone', '-q', `${seed.repo.root}-origin.git`, collab])
    g(collab, 'checkout', '-q', branch)
    writeFileSync(join(collab, 'COLLAB.md'), 'a collaborator fix\n')
    g(collab, 'add', 'COLLAB.md')
    g(collab, 'commit', '-qm', 'collaborator: fix')
    g(collab, 'push', '-q', 'origin', branch)
    return g(collab, 'rev-parse', 'HEAD')
  }
  const onRemote = (sha: string) => {
    g(seed.repo.root, 'fetch', '-q', 'origin')
    return tryG(seed.repo.root, 'merge-base', '--is-ancestor', sha, remoteTip())
  }
  return { ...seed, branch, remoteTip, moveMain, collaborate, onRemote }
}

describe('a forced push leases on witness\'s own last push (row 242)', () => {
  it('a re-gate after a refused push never overwrites the collaborator commit (P27)', async () => {
    const { wt, repo, planId, branch, moveMain, collaborate, onRemote } = await pushedPlan()
    const c = collaborate()
    // pushApproved's fetch moves the tracking ref onto the collaborator's commit; its plain push is refused
    g(wt, 'fetch', '-q', 'origin', branch)
    expect(tryG(wt, 'push', 'origin', `HEAD:${branch}`)).toBe(false)
    moveMain('other')
    const r = rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.violations[0]!.rule).toBe('push-diverged')
    expect(onRemote(c)).toBe(true)
  }, 180_000)

  it('with no recorded push and a remote the worktree does not contain, ship does not force-push', async () => {
    const { wt, repo, planId, remoteTip, moveMain, collaborate } = await pushedPlan()
    g(wt, 'update-ref', '-d', pushedRef(planId))
    collaborate()
    const before = remoteTip()
    moveMain('other')
    const head = g(wt, 'rev-parse', 'HEAD')
    const r = rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.violations[0]!.rule).toBe('push-diverged')
    expect(remoteTip()).toBe(before)
    // refused before the rebase: the worktree is left as it was, for the human
    expect(g(wt, 'rev-parse', 'HEAD')).toBe(head)
  }, 180_000)

  it('with no recorded push, a remote the worktree already holds (a PR pushed before 0.29) still rebases', async () => {
    const { wt, repo, planId, remoteTip, moveMain } = await pushedPlan()
    g(wt, 'update-ref', '-d', pushedRef(planId))
    moveMain('other')
    expect(rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })).toEqual({ ok: true, value: 'rebased' })
    const head = g(wt, 'rev-parse', 'HEAD')
    expect(remoteTip()).toBe(head)
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(head)
  }, 180_000)

  it('a normal rebase still force-pushes when the remote is witness\'s own last push, and records the new one', async () => {
    const { wt, repo, planId, remoteTip, moveMain } = await pushedPlan()
    moveMain('other')
    expect(rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })).toEqual({ ok: true, value: 'rebased' })
    const head = g(wt, 'rev-parse', 'HEAD')
    expect(remoteTip()).toBe(head)
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(head)
  }, 180_000)

  it('a rebase whose earlier push failed still leases on witness\'s own last push, not on HEAD', async () => {
    const { wt, repo, planId, remoteTip, moveMain } = await pushedPlan()
    // a rebase that landed locally while its push never did: the remote is witness's push, not an ancestor of HEAD
    moveMain('first')
    g(wt, 'fetch', '-q', 'origin', 'main')
    g(wt, 'rebase', '-q', '--autostash', 'origin/main')
    moveMain('second')
    expect(rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })).toEqual({ ok: true, value: 'rebased' })
    expect(remoteTip()).toBe(g(wt, 'rev-parse', 'HEAD'))
  }, 180_000)

  it('witness ship records the commit createPr pushed', async () => {
    const seed = await shippableRepo()
    addOrigin(seed.repo)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })
    await runShip(ctx, seed.planId)
    await seed.repo.cli(['decide', 'ship', seed.planId, '--approve'], { env: gateEnv(scenario) })
    expect(await runShip(ctx, seed.planId)).toBe(0)
    const tip = g(seed.repo.root, 'ls-remote', `${seed.repo.root}-origin.git`, `refs/heads/${branchName(seed.planId)}`).split(/\s/)[0]
    expect(g(seed.wt, 'rev-parse', pushedRef(seed.planId))).toBe(tip)
  }, 180_000)
})

// Row 243 (design §4.1.1 steps 3 and 8; P21, P37, P42 inverted). Whether a PR branch exists is read
// from leaseFor's own explicit fetch, in every caller, never from `@{upstream}` or a tracking ref,
// which a single-branch clone never has. Only createPr makes a first push, and only while the plan
// has no PR; with one, a branch the remote lacks is the PR branch gone. pushApproved leases too, so a
// push a clash held back is carried by the next ship run.
describe('every ship push leases from its own fetch (rows 242, 243)', () => {
  it('a single-branch clone: leaseFor reads the PR branch from its own fetch (P37)', async () => {
    const { wt, repo, branch, remoteTip, collaborate } = await pushedPlan()
    singleBranch(repo, branch)
    // the clone's own reads say nothing: a fetch by name writes no tracking ref, and there is no upstream
    expect(tryG(wt, 'fetch', '-q', 'origin', branch)).toBe(true)
    expect(tryG(wt, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)).toBe(false)
    expect(tryG(wt, 'rev-parse', '--verify', '--quiet', '@{upstream}')).toBe(false)
    expect(leaseFor(wt, branch)).toEqual({ ok: true, value: { tip: remoteTip() } })
    expect(g(wt, 'rev-parse', `refs/remotes/origin/${branch}`)).toBe(remoteTip())
    // a collaborator's commit, read the same way, is someone else's work
    collaborate()
    const r = leaseFor(wt, branch)
    expect(!r.ok && r.violations.map((x) => [x.rule, x.human])).toEqual([['push-diverged', true]])
    // and a branch the remote lacks is absent, never a failed fetch — whatever the stale tracking ref says
    goneOnRemote(repo.root, branch)
    expect(leaseFor(wt, branch)).toEqual({ ok: true, value: { absent: true } })
  }, 180_000)

  it('a single-branch clone: a PR\'s move overwrites witness\'s own last push, and a collaborator\'s commit refuses before anything moves (P37)', async () => {
    const { wt, repo, planId, branch, remoteTip, moveMain, collaborate } = await pushedPlan()
    singleBranch(repo, branch)
    moveMain('first')
    expect(rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })).toEqual({ ok: true, value: 'rebased' })
    const head = g(wt, 'rev-parse', 'HEAD')
    expect(remoteTip()).toBe(head)
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(head)
    const c = collaborate()
    moveMain('second')
    const r = rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })
    expect(!r.ok && r.violations.map((x) => x.rule)).toEqual(['push-diverged'])
    // refused before the move: the worktree as it was, and the collaborator's commit still the tip
    expect(g(wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(remoteTip()).toBe(c)
  }, 180_000)

  it('a first ship with no PR: rebaseIfMoved pushes nothing; createPr makes the first push (P42)', async () => {
    const { repo, wt, planId } = await shippableRepo()
    addOrigin(repo)
    const branch = branchName(planId)
    // pushed once by hand and deleted on the remote since: a stale tracking ref and an upstream remain
    g(wt, 'push', '-q', '-u', 'origin', branch)
    goneOnRemote(repo.root, branch)
    expect(tryG(wt, 'rev-parse', '--verify', '--quiet', '@{upstream}')).toBe(true)
    // no remote witness/<plan>; main moved
    moveMainOf(repo.root, 'other')
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => errs.push(l) })
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    // the gate phase: the move, then the ship gate's stop for the human
    expect(await runShip(ctx, planId), errs.join('\n')).toBe(1)
    g(wt, 'fetch', '-q', 'origin', 'main')
    expect(tryG(wt, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')).toBe(true)
    expect(remoteHas(repo.root, branch)).toBe(false)
    expect(await repo.cli(['decide', 'ship', planId, '--approve'], { env: gateEnv(scenario) })).toMatchObject({ code: 0 })
    // the pr phase
    const r = await repo.cli(['ship', planId], { env: gateEnv(scenario) })
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(remoteHas(repo.root, branch)).toBe(true)
    expect(remoteTipOf(repo.root, branch)).toBe(g(wt, 'rev-parse', 'HEAD'))
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(remoteTipOf(repo.root, branch))
  }, 180_000)

  it('with no PR a move pushes nothing, even to a branch witness pushed; createPr then pushes under its lease', async () => {
    const { wt, repo, planId, remoteTip, moveMain } = await pushedPlan()
    const before = remoteTip()
    moveMain('other')
    expect(rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: false, env: {} })).toEqual({ ok: true, value: 'rebased' })
    expect(remoteTip()).toBe(before)
    // the remote tip is witness's own last push, which the rebased HEAD no longer holds: a plain push is refused
    const head = g(wt, 'rev-parse', 'HEAD')
    expect(tryG(wt, 'merge-base', '--is-ancestor', before, head)).toBe(false)
    const plan = findById(loadCanon(repo.root), planId)!
    expect(createPr(fakeCtx(repo.root, { env: gateEnv(fakeScenario()) }), wt, repo.root, plan, 'summary')).toEqual({ ok: true, value: 1 })
    expect(remoteTip()).toBe(head)
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(head)
  }, 180_000)

  it('with a PR and no remote branch: rebaseIfMoved and pushApproved refuse pr-branch-gone, recorded fix', async () => {
    const { wt, repo, planId, branch, moveMain } = await pushedPlan()
    goneOnRemote(repo.root, branch)
    moveMain('other')
    const head = g(wt, 'rev-parse', 'HEAD')
    const r = rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })
    expect(!r.ok && r.violations.map((x) => [x.rule, x.human])).toEqual([['pr-branch-gone', true]])
    // refused before anything moved: HEAD as it was, nothing carried, nothing pushed
    expect(g(wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(tryG(wt, 'rev-parse', '--verify', '--quiet', carryRef(planId))).toBe(false)
    expect(remoteHas(repo.root, branch)).toBe(false)
    const p = pushApproved(fakeCtx(repo.root), repo.root, cfgOf(repo.root), planId, 'summary')
    expect(!p.ok && p.violations.map((x) => [x.rule, x.human])).toEqual([['pr-branch-gone', true]])
    expect(remoteHas(repo.root, branch)).toBe(false)
    expect(!p.ok && refusalOutcome(p.violations[0]!)).toEqual({ outcome: 'fix', reason: BRANCH_GONE })
    // createPr makes a first push only while the plan has no PR
    const plan = findById(loadCanon(repo.root), planId)!
    const c = createPr(fakeCtx(repo.root), wt, repo.root, { ...plan, meta: { ...plan.meta, pr: 7 } }, 'summary')
    expect(!c.ok && c.violations.map((x) => x.rule)).toEqual(['pr-branch-gone'])
    expect(remoteHas(repo.root, branch)).toBe(false)
  }, 180_000)

  it('a PR whose branch is gone: ship\'s watch and its move both refuse pr-branch-gone, exit 2, and record fix', async () => {
    const { repo, wt, planId } = await shippableRepo()
    addOrigin(repo)
    const branch = branchName(planId)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    let errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => errs.push(l) })
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await runShip(ctx, planId)
    await repo.cli(['decide', 'ship', planId, '--approve'], { env: gateEnv(scenario) })
    expect(await runShip(ctx, planId)).toBe(0)                          // PR #1 opened, its branch pushed
    expect(remoteHas(repo.root, branch)).toBe(true)
    goneOnRemote(repo.root, branch)
    // the watch: pushApproved's own fetch finds no branch, whatever the stale tracking ref says
    errs = []
    expect(await runShip(ctx, planId)).toBe(2)
    expect(errs.join('\n')).toContain('pr-branch-gone')
    expect(records(repo.root, planId).at(-1)).toEqual({ outcome: 'fix', reason: BRANCH_GONE, pr: 1 })
    expect(remoteHas(repo.root, branch)).toBe(false)
    // the move: main moved, so the gate phase rebases, and its lease finds no branch either
    moveMainOf(repo.root, 'other')
    const head = g(wt, 'rev-parse', 'HEAD')
    const before = records(repo.root, planId).length
    errs = []
    expect(await runShip(ctx, planId)).toBe(2)
    expect(errs.join('\n')).toContain('pr-branch-gone')
    expect(records(repo.root, planId)).toHaveLength(before + 1)
    expect(records(repo.root, planId).at(-1)).toEqual({ outcome: 'fix', reason: BRANCH_GONE, pr: 1 })
    expect(g(wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(remoteHas(repo.root, branch)).toBe(false)
  }, 180_000)

  it('a push held back by a clash is carried by the next ship under witness\'s lease, never push-diverged (P21)', async () => {
    const { wt, repo, planId, remoteTip, moveMain } = await pushedPlan()
    // main gains f.txt, and the PR's move carries the plan onto it, pushed under the lease
    moveMain('base', { 'f.txt': 'a\nb\nc\n' })
    expect(rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })).toEqual({ ok: true, value: 'rebased' })
    const pushed = remoteTip()
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(pushed)
    // a revise answered after the PR opened leaves its fix uncommitted (F8); main edits the same line
    writeFileSync(join(wt, 'f.txt'), 'a\nPLAN\nc\n')
    moveMain('clash', { 'f.txt': 'a\nMAIN\nc\n' })
    const r = rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })
    expect(!r.ok && r.violations.map((x) => x.rule)).toContain('textual-conflict')
    // the clash withheld the push: the PR branch still holds the pre-move commit
    expect(remoteTip()).toBe(pushed)
    // the session resolves it; the next ship's move finds nothing to move, and pushes nothing
    writeFileSync(join(wt, 'f.txt'), 'a\nMAIN\nPLAN\nc\n')
    g(wt, 'add', 'f.txt')
    expect(rebaseIfMoved(wt, repo.root, 'main', { planId, hasPr: true, env: {} })).toEqual({ ok: true, value: 'clean' })
    expect(remoteTip()).toBe(pushed)
    // pushApproved commits the resolution and carries it under witness's own lease
    const p = pushApproved(fakeCtx(repo.root), repo.root, cfgOf(repo.root), planId, 'summary')
    expect(p.ok, JSON.stringify(p)).toBe(true)
    const head = g(wt, 'rev-parse', 'HEAD')
    expect(remoteTip()).toBe(head)
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(head)
    expect(g(repo.root, 'show', `${head}:f.txt`)).toBe('a\nMAIN\nPLAN\nc')
  }, 180_000)

  it('pushApproved overwrites witness\'s own last push and refuses a collaborator\'s commit with push-diverged', async () => {
    const { wt, repo, planId, remoteTip, moveMain, collaborate } = await pushedPlan()
    // a session rebased by hand: the remote tip is witness's own last push, which HEAD no longer holds
    moveMain('first')
    g(wt, 'fetch', '-q', 'origin', 'main')
    g(wt, 'rebase', '-q', 'origin/main')
    const head = g(wt, 'rev-parse', 'HEAD')
    expect(pushApproved(fakeCtx(repo.root), repo.root, cfgOf(repo.root), planId, 'summary')).toEqual({ ok: true, value: head })
    expect(remoteTip()).toBe(head)
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(head)
    // a collaborator's commit lands on it, and the session rebases by hand again
    const c = collaborate()
    moveMain('second')
    g(wt, 'fetch', '-q', 'origin', 'main')
    g(wt, 'rebase', '-q', 'origin/main')
    const p = pushApproved(fakeCtx(repo.root), repo.root, cfgOf(repo.root), planId, 'summary')
    expect(!p.ok && p.violations.map((x) => [x.rule, x.human])).toEqual([['push-diverged', true]])
    expect(!p.ok && refusalOutcome(p.violations[0]!)?.outcome).toBe('fix')
    // the collaborator's commit stays the tip, and witness's record is still its own last push
    expect(remoteTip()).toBe(c)
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(head)
  }, 180_000)
})
