import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream, type StatusEntry } from '../src/journal.js'
import { worktreePath } from '../src/worktree.js'
import { findById, loadCanon } from '../src/scan.js'
import { approve, seededRepo, writeSpec, writePlan, stampLive } from './helpers.js'

async function approvedPlanRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  return repo
}

describe('specflow start', () => {
  it('creates the worktree + branch, stamps in-progress, journals the path', async () => {
    const repo = await approvedPlanRepo()
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
    expect(existsSync(join(wt, '.git'))).toBe(true)
    expect(repo.git('branch', '--list', 'specflow/auth-refresh-plan-1')).toContain('specflow/')
    expect(findById(loadCanon(repo.root), 'auth-refresh-plan-1')!.meta.status).toBe('in-progress')
    const status = readStream(repo.root, 'auth-refresh-plan-1')
      .find((e) => e.t === 'status') as StatusEntry
    expect(status).toMatchObject({
      from: 'approved', to: 'in-progress', cause: 'start',
      worktree: '.specflow/worktrees/auth-refresh-plan-1', branch: 'specflow/auth-refresh-plan-1',
    })
    // per-clone exclusion: the worktree never dirties the primary status
    expect(repo.git('status', '--porcelain')).toBe('')
    expect(readFileSync(join(repo.root, '.git/info/exclude'), 'utf8')).toContain('.specflow/worktrees/')
  })

  it('is re-entrant: second start reports ok; a deleted worktree is recreated', async () => {
    const repo = await approvedPlanRepo()
    await repo.cli(['start', 'auth-refresh-plan-1'])
    expect((await repo.cli(['start', 'auth-refresh-plan-1'])).code).toBe(0)
    rmSync(worktreePath(repo.root, 'auth-refresh-plan-1'), { recursive: true, force: true })
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    expect(existsSync(worktreePath(repo.root, 'auth-refresh-plan-1'))).toBe(true)
    // still exactly one status entry — re-entry stamps nothing new
    expect(readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'status').length).toBe(1)
  })

  it('refuses unapproved plans and blocked deps', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')          // still draft
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('not-approved')

    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-rotate', test: '@spec:auth-mfa' }], depends: ['auth-refresh'] })  // dep spec not live
    approve(repo, 'auth-mfa')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', depends: ['auth-refresh'] })
    repo.flipStatus('auth-mfa-plan-1', 'approved')
    const blocked = await repo.cli(['start', 'auth-mfa-plan-1'])
    expect(blocked.code).toBe(2)
    expect(blocked.stdout + blocked.stderr).toContain('blocked-deps')
    stampLive(repo, 'auth-refresh')
    expect((await repo.cli(['start', 'auth-mfa-plan-1'])).code).toBe(0)
  })
})

describe('specflow start — agent-model', () => {
  it('prints the implement-stage pin on fresh and re-entrant start', async () => {
    const repo = await approvedPlanRepo()
    repo.write('specflow.config.yaml', 'schema: 1\ngates:\n  implement: { model: claude-sonnet-5 }\n')
    repo.git('add', 'specflow.config.yaml')
    repo.git('commit', '-m', 'pin implement model')
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('agent-model: claude-sonnet-5')
    const again = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('agent-model: claude-sonnet-5')
  })

  it('falls back to the global gates.model pin, then session-default', async () => {
    const repo = await approvedPlanRepo()                  // init config: gates.model claude-fable-5
    const global = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(global.stdout).toContain('agent-model: claude-fable-5')

    const bare = await approvedPlanRepo()
    bare.write('specflow.config.yaml', 'schema: 1\n')      // no gates at all
    bare.git('add', 'specflow.config.yaml')
    bare.git('commit', '-m', 'bare config')
    const r = await bare.cli(['start', 'auth-refresh-plan-1'])
    expect(r.stdout).toContain('agent-model: session-default')
  })

  it('refuses an alias pin before touching state', async () => {
    const repo = await approvedPlanRepo()
    repo.write('specflow.config.yaml', 'schema: 1\ngates:\n  implement: { model: sonnet }\n')
    repo.git('add', 'specflow.config.yaml')
    repo.git('commit', '-m', 'alias pin')
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('alias-refused')
    expect(findById(loadCanon(repo.root), 'auth-refresh-plan-1')!.meta.status).toBe('approved')
  })
})

describe('specflow clean', () => {
  it('reaps stray worktrees of terminal plans, keeps live ones and branches', async () => {
    const repo = await approvedPlanRepo()
    await repo.cli(['start', 'auth-refresh-plan-1'])
    repo.flipStatus('auth-refresh-plan-1', 'done')        // terminal, worktree now stray
    const r = await repo.cli(['clean'])
    expect(r.code).toBe(0)
    expect(existsSync(worktreePath(repo.root, 'auth-refresh-plan-1'))).toBe(false)
    expect(repo.git('branch', '--list', 'specflow/auth-refresh-plan-1')).toContain('specflow/')
  })
})
