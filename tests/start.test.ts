import { describe, expect, it } from 'vitest'
import { approve, seededRepo, writePlan, writeSpec } from './helpers.js'

// D148. Re-attach re-runs createWorktree, which re-applies the canon exclusion and
// checks the tree back out — files move under a session that already read them, and
// witness caused it. The 8× "modified since read" cluster is half this arm.
describe('witness start re-attach (D148)', () => {
  it('says the re-attach refreshed the tree, and says it only on re-attach', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    approve(repo, 'auth-refresh-plan-1')

    const first = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(first.code).toBe(0)
    expect(first.stdout).not.toContain('re-read files you read before this run')

    const again = await repo.cli(['start', 'auth-refresh-plan-1'])

    expect(again.code).toBe(0)
    expect(again.stdout).toContain('worktree present')
    expect(again.stdout).toContain('re-read files you read before this run')

    await repo.cli(['clean'])
  })
})
