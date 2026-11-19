import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../src/gates/index.js'
import { runGate } from '../src/gate.js'
import { pushedRef, rebaseIfMoved, recordPushed, runShip } from '../src/ship.js'
import { branchName } from '../src/worktree.js'
import { addOrigin, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo } from './helpers.js'

// Row 242 (design §4.3.1, last bullet; P27 inverted). Every forced push to a PR branch leases
// on the commit witness itself last pushed there, never on the tracking ref a fetch can move.

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, encoding: 'utf8' }).trim()
const tryG = (cwd: string, ...args: string[]): boolean => {
  try { g(cwd, ...args); return true } catch { return false }
}

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
  const remoteTip = () => g(seed.repo.root, 'ls-remote', `${seed.repo.root}-origin.git`, `refs/heads/${branch}`).split(/\s/)[0]!
  const moveMain = (name: string) => {
    const other = `${seed.repo.root}-${name}`
    execFileSync('git', ['clone', '-q', `${seed.repo.root}-origin.git`, other])
    writeFileSync(join(other, `${name}.md`), 'merged\n')
    g(other, 'add', `${name}.md`)
    g(other, 'commit', '-qm', `Merge ${name}`)
    g(other, 'push', '-q', 'origin', 'main')
  }
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
    const { wt, repo, branch, moveMain, collaborate, onRemote } = await pushedPlan()
    const c = collaborate()
    // pushApproved's fetch moves the tracking ref onto the collaborator's commit; its plain push is refused
    g(wt, 'fetch', '-q', 'origin', branch)
    expect(tryG(wt, 'push', 'origin', `HEAD:${branch}`)).toBe(false)
    moveMain('other')
    const r = rebaseIfMoved(wt, repo.root, 'main')
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
    const r = rebaseIfMoved(wt, repo.root, 'main')
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
    expect(rebaseIfMoved(wt, repo.root, 'main')).toEqual({ ok: true, value: 'rebased' })
    const head = g(wt, 'rev-parse', 'HEAD')
    expect(remoteTip()).toBe(head)
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(head)
  }, 180_000)

  it('a normal rebase still force-pushes when the remote is witness\'s own last push, and records the new one', async () => {
    const { wt, repo, planId, remoteTip, moveMain } = await pushedPlan()
    moveMain('other')
    expect(rebaseIfMoved(wt, repo.root, 'main')).toEqual({ ok: true, value: 'rebased' })
    const head = g(wt, 'rev-parse', 'HEAD')
    expect(remoteTip()).toBe(head)
    expect(g(wt, 'rev-parse', pushedRef(planId))).toBe(head)
  }, 180_000)

  it('a rebase whose earlier push failed still leases on witness\'s own last push, not on HEAD', async () => {
    const { wt, repo, remoteTip, moveMain } = await pushedPlan()
    // a rebase that landed locally while its push never did: the remote is witness's push, not an ancestor of HEAD
    moveMain('first')
    g(wt, 'fetch', '-q', 'origin', 'main')
    g(wt, 'rebase', '-q', '--autostash', 'origin/main')
    moveMain('second')
    expect(rebaseIfMoved(wt, repo.root, 'main')).toEqual({ ok: true, value: 'rebased' })
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
