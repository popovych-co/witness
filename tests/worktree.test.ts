import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream, type StatusEntry } from '../src/journal.js'
import { worktreePath } from '../src/worktree.js'
import { findById, loadCanon } from '../src/scan.js'
import { approve, seededRepo, undoCanonExclusion, writeSpec, writePlan, stampLive } from './helpers.js'

async function approvedPlanRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  return repo
}

describe('witness start', () => {
  it('creates the worktree + branch, stamps in-progress, journals the path', async () => {
    const repo = await approvedPlanRepo()
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
    expect(existsSync(join(wt, '.git'))).toBe(true)
    expect(repo.git('branch', '--list', 'witness/auth-refresh-plan-1')).toContain('witness/')
    expect(findById(loadCanon(repo.root), 'auth-refresh-plan-1')!.meta.status).toBe('in-progress')
    const status = readStream(repo.root, 'auth-refresh-plan-1')
      .find((e) => e.t === 'status') as StatusEntry
    expect(status).toMatchObject({
      from: 'approved', to: 'in-progress', cause: 'start',
      worktree: '.witness/worktrees/auth-refresh-plan-1', branch: 'witness/auth-refresh-plan-1',
    })
    // per-clone exclusion: the worktree never dirties the primary status
    expect(repo.git('status', '--porcelain')).toBe('')
    expect(readFileSync(join(repo.root, '.git/info/exclude'), 'utf8')).toContain('.witness/worktrees/')
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

describe('witness start — agent-model', () => {
  it('prints the implement-stage pin on fresh and re-entrant start', async () => {
    const repo = await approvedPlanRepo()
    repo.write('witness.config.yaml', 'schema: 1\ngates:\n  implement: { model: claude-sonnet-5 }\n')
    repo.git('add', 'witness.config.yaml')
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
    bare.write('witness.config.yaml', 'schema: 1\n')      // no gates at all
    bare.git('add', 'witness.config.yaml')
    bare.git('commit', '-m', 'bare config')
    const r = await bare.cli(['start', 'auth-refresh-plan-1'])
    expect(r.stdout).toContain('agent-model: session-default')
  })

  it('refuses an alias pin before touching state', async () => {
    const repo = await approvedPlanRepo()
    repo.write('witness.config.yaml', 'schema: 1\ngates:\n  implement: { model: sonnet }\n')
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'alias pin')
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('alias-refused')
    expect(findById(loadCanon(repo.root), 'auth-refresh-plan-1')!.meta.status).toBe('approved')
  })
})

// TestRepo.git is root-bound; every assertion below asks a question of the WORKTREE
// (its index, its status, its disk), so this suite needs a wt-cwd git of its own.
const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

const PLAN_REL = 'plans/auth-refresh-plan-1.md'

async function excludedRepo() {
  const repo = await approvedPlanRepo()
  await repo.cli(['start', 'auth-refresh-plan-1'])
  return { repo, wt: worktreePath(repo.root, 'auth-refresh-plan-1') }
}

describe('witness start — canon has one home', () => {
  it('excludes canon from a fresh worktree and marks it skip-worktree', async () => {
    const { wt } = await excludedRepo()
    expect(existsSync(join(wt, 'specs'))).toBe(false)
    expect(existsSync(join(wt, 'plans'))).toBe(false)
    // the branch still CARRIES it — only the checkout hides it, so the PR stays code-only
    expect(gitIn(wt, 'ls-files', '-t', '--', 'plans')).toMatch(/^S /m)
    expect(gitIn(wt, 'status', '--porcelain')).toBe('')
  })

  it('keeps non-canon siblings of a relocated canon dir', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', 'schema: 1\npaths: { specs: docs/specs, plans: docs/plans }\n')
    repo.write('docs/RELEASING.md', '# how to release\n')
    repo.git('add', 'witness.config.yaml', 'docs/RELEASING.md')
    repo.git('commit', '-m', 'relocate canon under docs/')       // source paths — no trailer
    // approve/flipStatus resolve `specs/`+`plans/` by hand, so a relocated repo needs its
    // own flip — the CLI's own paths: resolution is what the write path below exercises.
    const flipAt = (rel: string, status: string) => {
      repo.write(rel, repo.read(rel).replace(/status: \S+/, `status: ${status}`))
      repo.git('add', rel)
      repo.git('commit', '-m', `flip ${rel} -> ${status}`, '-m', 'Witness-State: 1')
    }
    await writeSpec(repo, 'auth-refresh')
    flipAt('docs/specs/auth-refresh.md', 'approved')
    await writePlan(repo, 'auth-refresh-plan-1')
    flipAt('docs/plans/auth-refresh-plan-1.md', 'approved')
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
    expect(existsSync(join(wt, 'docs', 'RELEASING.md'))).toBe(true)   // sibling kept
    expect(existsSync(join(wt, 'docs', 'plans'))).toBe(false)         // canon gone
    expect(existsSync(join(wt, 'docs', 'specs'))).toBe(false)
  })

  it('an amended plan reaches the branch tree without materializing a file', async () => {
    const { repo, wt } = await excludedRepo()
    // amend canon on main the way stateCommit does — content + trailer
    repo.write(PLAN_REL, repo.read(PLAN_REL).replace('Implement rotation', 'Implement rotation AND REVOCATION'))
    repo.git('add', PLAN_REL)
    repo.git('commit', '-m', 'plan(auth-refresh-plan-1): amend', '-m', 'Witness-State: 1')
    gitIn(wt, 'rebase', 'main')
    expect(gitIn(wt, 'show', `HEAD:${PLAN_REL}`)).toContain('AND REVOCATION')  // tree is v2
    expect(existsSync(join(wt, PLAN_REL))).toBe(false)                         // disk still empty
  })

  it('re-attach applies the exclusion to a worktree created before the exclusion existed', async () => {
    const { repo, wt } = await excludedRepo()
    undoCanonExclusion(wt)
    expect(existsSync(join(wt, PLAN_REL))).toBe(true)   // the pre-upgrade state, reproduced
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    expect(existsSync(join(wt, PLAN_REL))).toBe(false)
  })

  it('re-attaches a dirty worktree without disturbing the work in it', async () => {
    const { repo, wt } = await excludedRepo()
    writeFileSync(join(wt, 'src.ts'), 'export const x = 1\n')     // untracked, mid-slice
    gitIn(wt, 'add', 'src.ts'); gitIn(wt, 'commit', '-m', 'wip')
    writeFileSync(join(wt, 'src.ts'), 'export const x = 2\n')     // now dirty
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    expect(readFileSync(join(wt, 'src.ts'), 'utf8')).toContain('x = 2')
    expect(existsSync(join(wt, PLAN_REL))).toBe(false)
  })

  it('refuses when a DIRTY canon file blocks the exclusion', async () => {
    const { repo, wt } = await excludedRepo()
    undoCanonExclusion(wt)
    writeFileSync(join(wt, PLAN_REL), `${repo.read(PLAN_REL)}\nhand edit\n`)
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('canon-in-worktree')
    expect(r.stderr).toContain(PLAN_REL)
  })

  it('refuses to enable extensions.worktreeConfig when core.worktree is set', async () => {
    const repo = await approvedPlanRepo()
    repo.git('config', 'core.worktree', repo.root)   // harmless value, shared-config scope
    const r = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('worktree-config-unsafe')
  })
})

describe('witness clean', () => {
  it('reaps stray worktrees of terminal plans, keeps live ones and branches', async () => {
    const repo = await approvedPlanRepo()
    await repo.cli(['start', 'auth-refresh-plan-1'])
    repo.flipStatus('auth-refresh-plan-1', 'done')        // terminal, worktree now stray
    const r = await repo.cli(['clean'])
    expect(r.code).toBe(0)
    expect(existsSync(worktreePath(repo.root, 'auth-refresh-plan-1'))).toBe(false)
    expect(repo.git('branch', '--list', 'witness/auth-refresh-plan-1')).toContain('witness/')
  })
})
