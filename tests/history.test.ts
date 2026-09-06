import { describe, expect, it } from 'vitest'
import { baseForSpec, planStamps } from '../src/history.js'
import { loadCanon } from '../src/scan.js'
import { approve, seededRepo, writePlan, writeSpec } from './helpers.js'

// D160 amendment: the plan queue resolves bases through one batched `git log` instead of
// one spawn per plan. The batch must be observationally identical to the per-file shape.
describe('planStamps', () => {
  it('maps each rel to its latest commit epoch and leaves uncommitted rels absent', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const stamps = planStamps(repo.root, ['plans/auth-refresh-plan-1.md', 'plans/never-written.md'])
    expect(stamps.get('plans/auth-refresh-plan-1.md')).toBeGreaterThan(0)
    expect(stamps.has('plans/never-written.md')).toBe(false)
  })

  it('resolves the same base with and without the batch map', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    await writePlan(repo, 'auth-refresh-plan-2')          // the later commit — the base
    const canon = loadCanon(repo.root)
    const rels = canon.docs.filter((d) => d.meta.type === 'plan').map((d) => d.rel)
    const direct = baseForSpec(repo.root, canon, 'auth-refresh')
    const batched = baseForSpec(repo.root, canon, 'auth-refresh', undefined, planStamps(repo.root, rels))
    expect(batched).toEqual(direct)
    expect(batched.planId).toBe('auth-refresh-plan-2')
  })
})
