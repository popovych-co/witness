import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream, type StatusEntry } from '../src/journal.js'
import '../src/gates/index.js'
import { runGate } from '../src/gate.js'
import { runShip } from '../src/ship.js'
import { findById, loadCanon } from '../src/scan.js'
import { addOrigin, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo } from './helpers.js'

// Deliberately distinct from both TOKEN_BROKEN and TOKEN_FIXED: rebasing the worktree's
// BROKEN→FIXED commit onto either of those would apply cleanly (identical end content),
// so this needs different body lines to force a genuine rebase conflict.
const TOKEN_CONFLICTING = 'export function rotateDue(elapsed: number, ttl: number): boolean {\n  throw new Error(\'not implemented\')\n}\n\nexport function nextToken(prev: string): string {\n  throw new Error(\'not implemented\')\n}\n'

const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}

async function approvedShip(opts: { commit?: boolean } = {}) {
  const seed = await shippableRepo(opts)
  addOrigin(seed.repo)
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario) })
  await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })
  await runShip(ctx, seed.planId)                                  // gate phase → stop
  await seed.repo.cli(['decide', 'ship', seed.planId, '--approve'], { env: gateEnv(scenario) })
  return { ...seed, scenario, ctx }
}

describe('specflow ship', () => {
  it('phases: gate stop → approve → push + PR + pr-stamp → CI watch', async () => {
    const { repo, planId, scenario, ctx } = await approvedShip()
    const code = await runShip(ctx, planId)                        // pr → watch
    expect(code).toBe(0)
    const plan = findById(loadCanon(repo.root), planId)!
    expect(plan.meta.pr).toBe(1)
    const status = readStream(repo.root, planId).filter((e) => e.t === 'status')
      .find((e) => (e as StatusEntry).cause === 'ship') as StatusEntry
    expect(status.pr).toBe(1)
    const calls = readFileSync(join(scenario, 'gh-calls'), 'utf8')
    expect(calls).toContain('pr create')
    expect(calls).toContain('pr checks 1 --watch')
    expect(repo.git('log', '-1', '--format=%B')).toContain('ship(auth-refresh-plan-1): pr #1')
  })

  it('uncommitted worktree: pr phase makes the sole code commit before push', async () => {
    const { repo, wt, planId, ctx } = await approvedShip({ commit: false })
    // nothing ahead of main before ship — implement left the worktree uncommitted
    expect(execFileSync('git', ['log', '--oneline', 'main..HEAD'], { cwd: wt, encoding: 'utf8' })).toBe('')
    expect(await runShip(ctx, planId)).toBe(0)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' })).toBe('')
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: wt, encoding: 'utf8' }).trim()
    expect(subject).toBe('auth-refresh-plan-1: Refresh tokens rotate before expiry')
    expect(findById(loadCanon(repo.root), planId)!.meta.pr).toBe(1)
  })

  it('re-entry never mints a second PR and resumes at the watch', async () => {
    const { planId, scenario, ctx } = await approvedShip()
    await runShip(ctx, planId)
    await runShip(ctx, planId)                                     // killed-after-merge? just re-run
    const calls = readFileSync(join(scenario, 'gh-calls'), 'utf8')
    expect(calls.match(/pr create/g)!.length).toBe(1)
    expect(calls.match(/pr checks/g)!.length).toBe(2)
  })

  it('red CI reports findings', async () => {
    const { planId, scenario, ctx } = await approvedShip()
    writeFileSync(join(scenario, 'pr-1-checks'), 'fail')
    expect(await runShip(ctx, planId)).toBe(1)
  })

  it('rebases when main moved; a semantic conflict hands back', async () => {
    const { repo, wt, planId, ctx } = await approvedShip()
    // main moves with an unrelated file → mechanical rebase
    writeFileSync(join(repo.root, 'docs.md'), 'unrelated\n')
    repo.git('add', 'docs.md'); repo.git('commit', '-m', 'main moved')
    expect(await runShip(ctx, planId)).toBe(0)
    expect(execFileSync('git', ['log', '--oneline'], { cwd: wt, encoding: 'utf8' })).toContain('main moved')
    // main now rewrites a file the branch touched → conflict
    repo.write('src/token.ts', TOKEN_CONFLICTING)
    repo.git('add', 'src/token.ts'); repo.git('commit', '-m', 'conflicting main change')
    const r = await runShip(ctx, planId)
    expect(r).toBe(1)
    // rebase aborted — worktree left clean for the skill to resolve deliberately
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' })).toBe('')
  })

  it('refuses without an origin remote', async () => {
    const seed = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })
    await runShip(ctx, seed.planId)
    await seed.repo.cli(['decide', 'ship', seed.planId, '--approve'], { env: gateEnv(scenario) })
    const r = await seed.repo.cli(['ship', seed.planId], { env: gateEnv(scenario) })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('no-remote')
  })
})
