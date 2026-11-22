import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { standingHeld } from '../src/held.js'
import { heldWorktree, nextLine, worktreeState } from './helpers.js'

describe('recover and next (row 247, #92)', () => {
  it.each(['stepped', 'scaffolding'] as const)('after a crash on a %s plan, next routes witness recover — never test-evidence', async (shape) => {
    const { repo, wt, planId } = await heldWorktree(shape)
    for (const cwd of [wt, repo.root]) {
      const out = await nextLine(repo, { cwd })
      expect(out).toMatch(/^next: witness recover$/m)
      expect(out).not.toMatch(/test-evidence/)
    }
    const rec = await repo.cli(['recover'])
    expect(rec.code).toBe(0)
    expect(rec.stdout).toMatch(/^held-work: .* back in /m)
    expect(await nextLine(repo, { cwd: wt })).toMatch(shape === 'stepped'
      ? /^next: witness test-evidence auth-refresh-plan-1 --phase red --step s1$/m
      : new RegExp(`^next: witness verify-red ${planId}$`, 'm'))
  })

  it('recover puts the work back into the checkout that set it aside, run from anywhere', async () => {
    const { repo, wt, planId, before } = await heldWorktree('stepped')
    const rec = await repo.cli(['recover'], { cwd: repo.root })
    expect(rec.code).toBe(0)
    expect(worktreeState(repo, wt, ['src/token.ts', 'src/extra.ts'])).toEqual(before)
    expect(standingHeld(repo.root, planId)).toBeUndefined()
  })

  it('recover refuses verify-red-pending for a held file changed since, and keeps the ref', async () => {
    const { repo, wt, planId } = await heldWorktree('stepped')
    const sha = standingHeld(repo.root, planId)!.sha
    writeFileSync(join(wt, 'src/token.ts'), 'a session edit\n')
    const rec = await repo.cli(['recover'])
    expect(rec.code).toBe(2)
    expect(rec.stderr).toContain('verify-red-pending')
    expect(rec.stderr).toMatch(/Then witness next/)
    expect(standingHeld(repo.root, planId)!.sha).toBe(sha)
    expect(readFileSync(join(wt, 'src/token.ts'), 'utf8')).toBe('a session edit\n')
  })

  it('recover refuses when the checkout that set it aside is gone, and writes nowhere else', async () => {
    const { repo, wt, planId } = await heldWorktree('stepped')
    const sha = standingHeld(repo.root, planId)!.sha
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo.root })
    const status = repo.git('status', '--porcelain=v1', '--untracked-files=all')
    const rec = await repo.cli(['recover'])
    expect(rec.code).toBe(2)
    expect(rec.stderr).toContain('verify-red-pending')
    expect(rec.stderr).toContain('is gone')
    expect(standingHeld(repo.root, planId)!.sha).toBe(sha)
    expect(repo.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(status)
  })
})
