import { describe, expect, it } from 'vitest'
import { approve, seededRepo, stampLive, writePlan, writeSpec } from './helpers.js'

// D157 — the reported shape (#21): an effort's decompose passed, its spec went back to
// `live` (abandon revert or lazy stamp), it owns zero plans. `next` must offer the plan
// write, not park on `witness check`.
describe('next — live specs re-enter the plan queue when an effort owes them', () => {
  it('offers a plan write for a live spec whose live effort owns zero plans', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    stampLive(repo, 'auth-refresh')            // live, effort wrote it, zero plans → owed
    const r = await repo.cli(['next'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`witness write auth-refresh-plan-1 --effort ${repo.effort}`)
    expect(r.stdout).not.toMatch(/^next: witness check$/m)
  })

  it('offers the next free suffix when plan-1 is done', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')   // shipped slice
    // spec approved again (re-amend passed decompose) — today's queue would offer plan-1
    const r = await repo.cli(['next'])
    expect(r.stdout).toContain('witness write auth-refresh-plan-2')
    expect(r.stdout).not.toContain('witness write auth-refresh-plan-1 ')
  })

  it('ranks multiple owed live specs in the choose block', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    stampLive(repo, 'auth-refresh')
    await writeSpec(repo, 'rate-limits', { criteria: [{ id: 'ac-limits', test: '@spec:rate-limits' }] })
    approve(repo, 'rate-limits')
    stampLive(repo, 'rate-limits')
    const r = await repo.cli(['next'])
    expect(r.stdout).toContain('2 ready — ranked below')
    expect(r.stdout).toContain('choose:')
  })

  it('does NOT re-queue a finished spec — live, all plans done, effort still live', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')            // the shipped end-state; nothing owed
    const r = await repo.cli(['next'])
    expect(r.stdout).not.toContain('witness write auth-refresh-plan-')
    expect(r.stdout).toMatch(/next: witness check/)
  })

  it('the terminal check line says the queue is empty — distinguishable from canon errors', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    const r = await repo.cli(['next'])
    expect(r.stdout).toContain('next: witness check')
    expect(r.stdout).toContain('nothing is owed')   // rule B carries a note; rule A stays bare
  })
})
