import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lazyStamp } from '../src/stamp.js'
import { readStream, type StatusEntry } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { worktreePath } from '../src/worktree.js'
import { fakeCtx, fakeScenario, gateEnv, ghState, putVerdict, shippableRepo, writeSpec } from './helpers.js'

async function mergedSeed() {
  const seed = await shippableRepo()
  // pretend the ship phase stamped pr: 1 (direct seed, tests may)
  seed.repo.setMeta(seed.planId, { pr: 1 })                        // helper: frontmatter patch + plain commit
  const scenario = fakeScenario()
  ghState(scenario, 1, 'MERGED')
  const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario) })
  return { ...seed, scenario, ctx }
}

describe('lazyStamp', () => {
  it('merged PR → plan done, spec live, worktree reaped, one commit each', async () => {
    const { repo, planId, specId, ctx } = await mergedSeed()
    const result = lazyStamp(repo.root, ctx, loadCanon(repo.root))
    expect(result.stamped).toEqual([{ plan: planId, spec: specId, pr: 1 }])
    const canon = loadCanon(repo.root)
    expect(findById(canon, planId)!.meta.status).toBe('done')
    expect(findById(canon, specId)!.meta.status).toBe('live')
    expect(existsSync(worktreePath(repo.root, planId))).toBe(false)
    const entry = readStream(repo.root, planId).filter((e) => e.t === 'status').at(-1) as StatusEntry
    expect(entry).toMatchObject({ to: 'done', cause: 'merge', pr: 1 })
  })

  it('stale pin: plan done, spec left un-live with a stale-merge note', async () => {
    const { repo, planId, specId, ctx } = await mergedSeed()
    await writeSpec(repo, specId, { summary: 'amended after the PR went up' })   // sha moves off the pin
    const result = lazyStamp(repo.root, ctx, loadCanon(repo.root))
    expect(result.stamped[0]!.spec).toBeUndefined()
    const canon = loadCanon(repo.root)
    expect(findById(canon, planId)!.meta.status).toBe('done')
    expect(findById(canon, specId)!.meta.status).not.toBe('live')
    const entry = readStream(repo.root, planId).filter((e) => e.t === 'status').at(-1) as StatusEntry
    expect(entry.note).toBe('stale-merge')
  })

  it('never stamps under CI; a dead gh degrades to "stale, could not check"', async () => {
    const { repo, ctx } = await mergedSeed()
    const ciCtx = { ...ctx, env: { ...ctx.env, CI: '1' } }
    expect(lazyStamp(repo.root, ciCtx, loadCanon(repo.root)).stamped).toEqual([])

    const deadGh = { ...ctx, env: { ...ctx.env, PATH: '/nonexistent' } }
    const r = lazyStamp(repo.root, deadGh, loadCanon(repo.root))
    expect(r.stamped).toEqual([])
    expect(r.stale[0]!.why).toContain('check')
  })
})

describe('check surfaces', () => {
  it('warns on mid-flight amendment, stray worktree, pending decision', async () => {
    const seed = await shippableRepo()
    // parent amendment while the plan is still in-progress → mid-flight-amendment
    await writeSpec(seed.repo, seed.specId, { summary: 'amended under the in-progress plan' })
    // an orphan worktree directory with no corresponding plan doc → stray-worktree
    // (flipping auth-refresh-plan-1 itself to done would also clear its in-progress
    // status, which is what mid-flight-amendment requires — so this needs a second,
    // independent worktree rather than reusing the same plan for both findings)
    mkdirSync(join(seed.repo.root, '.specflow/worktrees/ghost-plan'), { recursive: true })
    const r = await seed.repo.cli(['check'])
    expect(r.stdout).toContain('mid-flight-amendment')
    expect(r.stdout).toContain('stray-worktree')
  })
})

describe('check --drift --deep', () => {
  it('journals a deep entry with the verdict; blocking findings exit 1; CI refuses', async () => {
    const seed = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, {
      // '.' as a plain code anchor doesn't resolve (it's a directory, not a file) —
      // omission-shaped anchors are what the tree-kind grammar special-cases for '.'
      coverage: [{ anchor: { kind: 'omission', scope: '.' }, note: 'walked the tree' }],
      findings: [{ blocking: true, anchor: { kind: 'omission', scope: '.' }, claim: 'spec promises revocation, code never revokes' }],
    })
    const r = await seed.repo.cli(['check', '--drift', '--deep', seed.specId], { env: gateEnv(scenario) })
    expect(r.code).toBe(1)
    const deep = readStream(seed.repo.root, seed.specId).find(
      (e) => e.t === 'drift-check' && (e as { deep?: boolean }).deep)
    expect(deep).toBeDefined()
    expect((deep as { verdict?: unknown }).verdict).toBeDefined()
    const ci = await seed.repo.cli(['check', '--drift', '--deep', seed.specId], { env: { ...gateEnv(scenario), CI: '1' } })
    expect(ci.code).toBe(2)
    expect(ci.stdout + ci.stderr).toContain('deep-in-ci')
  })
})
