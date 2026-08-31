import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createWorktree, removeWorktree, worktreePath } from '../src/worktree.js'
import { approve, seededRepo, writePlan, writeSpec } from './helpers.js'

// D141. The lazy stamp fires from next/check/dashboard — including the SessionStart hook's
// bare `witness` — so removal used to delete the directory the invoking session stood in.
// That is the ×3 "Working directory does not exist" in the 2026-08-29 report.
describe('removeWorktree cwd guard (D141)', () => {
  it('keeps the worktree the caller stands in, and removes it from anywhere else', async () => {
    const repo = await seededRepo()
    const wt = createWorktree(repo.root, 'p1', 'main')
    if (!wt.ok) throw new Error('worktree not created')

    // standing inside it — including a subdirectory — is what makes removal unsafe
    expect(removeWorktree(repo.root, 'p1', join(wt.value.path, 'src'))).toBe(false)
    expect(existsSync(wt.value.path)).toBe(true)
    expect(removeWorktree(repo.root, 'p1', wt.value.path)).toBe(false)
    expect(existsSync(wt.value.path)).toBe(true)

    expect(removeWorktree(repo.root, 'p1', repo.root)).toBe(true)
    expect(existsSync(wt.value.path)).toBe(false)
  })

  it('a sibling worktree path is not "inside" — prefix look-alikes must not block', async () => {
    const repo = await seededRepo()
    const wt = createWorktree(repo.root, 'p1', 'main')
    if (!wt.ok) throw new Error('worktree not created')

    expect(removeWorktree(repo.root, 'p1', `${wt.value.path}-sibling`)).toBe(true)
    expect(existsSync(wt.value.path)).toBe(false)
  })

  it('an absent cwd argument keeps the old unconditional behavior', async () => {
    const repo = await seededRepo()
    const wt = createWorktree(repo.root, 'p1', 'main')
    if (!wt.ok) throw new Error('worktree not created')

    expect(removeWorktree(repo.root, 'p1')).toBe(true)
    expect(existsSync(wt.value.path)).toBe(false)
  })
})

describe('clean reports what it kept (D141)', () => {
  it('keeps the worktree the session stands in and names the way out', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    approve(repo, 'auth-refresh-plan-1')
    await repo.cli(['start', 'auth-refresh-plan-1'])
    repo.flipStatus('auth-refresh-plan-1', 'abandoned')      // clean's sweep predicate
    const wt = worktreePath(repo.root, 'auth-refresh-plan-1')

    const inside = await repo.cli(['clean'], { cwd: wt })

    expect(inside.stdout).toContain('this session stands in it')
    expect(existsSync(wt)).toBe(true)

    const outside = await repo.cli(['clean'])
    expect(existsSync(wt)).toBe(false)
    expect(outside.stdout).not.toContain('this session stands in it')
  })
})
