import { describe, expect, it } from 'vitest'
import { approve, seededRepo, writeDesign, writePlan, writeSpec } from './helpers.js'
import { worktreePath } from '../src/worktree.js'

const PLAN_REL = 'plans/auth-refresh-plan-1.md'

async function planRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  return repo
}

async function uiRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
  approve(repo, 'booking-form')
  await writeDesign(repo, 'booking-form')
  return repo
}

describe('witness read', () => {
  it('prints a plan whole from inside the worktree — current canon, not a copy', async () => {
    const repo = await planRepo()
    await repo.cli(['start', 'auth-refresh-plan-1'])
    const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
    // amend on main AFTER start — the read must see v2 though the wt carries no file
    repo.write(PLAN_REL, repo.read(PLAN_REL).replace('Implement rotation', 'Implement rotation AND REVOCATION'))
    repo.git('add', PLAN_REL)
    repo.git('commit', '-m', 'amend', '-m', 'Witness-State: 1')
    const r = await repo.cli(['read', 'auth-refresh-plan-1'], { cwd: wt })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('AND REVOCATION')
    expect(r.stdout).toContain('id: auth-refresh-plan-1')
  })

  it('reads a spec whole', async () => {
    const repo = await planRepo()
    const r = await repo.cli(['read', 'auth-refresh'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('## Behavior')
  })

  it('reads the design artifact for a ui spec', async () => {
    const repo = await uiRepo()
    const r = await repo.cli(['read', 'booking-form', '--design'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('id="save-bar"')
  })

  it('outlines a design by element id with line ranges', async () => {
    const repo = await uiRepo()
    const r = await repo.cli(['read', 'booking-form', '--design', '--outline'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('outline[3]{anchor,lines}:')
    expect(r.stdout).toContain('save-bar')
    expect(r.stdout).toMatch(/\d+-\d+/)
  })

  it('outlines a markdown artifact by heading, over the same lines --lines slices', async () => {
    const repo = await planRepo()
    const r = await repo.cli(['read', 'auth-refresh-plan-1', '--outline'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('## Step: s1')
    const range = /## Step: s1,(\d+)-(\d+)/.exec(r.stdout)
    expect(range).toBeTruthy()
    const slice = await repo.cli(['read', 'auth-refresh-plan-1', '--lines', `${range![1]}-${range![2]}`])
    expect(slice.code).toBe(0)
    expect(slice.stdout).toContain('## Step: s1')
    expect(slice.stdout).toContain('Implement rotation with TDD.')
  })

  it('slices by line range', async () => {
    const repo = await planRepo()
    const r = await repo.cli(['read', 'auth-refresh-plan-1', '--lines', '1-3'])
    expect(r.code).toBe(0)
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(3)
    expect(r.stdout.startsWith('---')).toBe(true)   // serialized doc opens with frontmatter
  })

  it('refuses an unknown id, a spec with no design, and a bad range', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const unknown = await repo.cli(['read', 'nope'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('unknown-id')
    const noDesign = await repo.cli(['read', 'auth-refresh', '--design'])
    expect(noDesign.code).toBe(2)
    expect(noDesign.stderr).toContain('no-design')
    const bad = await repo.cli(['read', 'auth-refresh', '--lines', '9-3'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('bad-range')
    const junk = await repo.cli(['read', 'auth-refresh', '--lines', 'top'])
    expect(junk.code).toBe(2)
    expect(junk.stderr).toContain('bad-range')
    // a start past the last line prints nothing at all — refuse instead of answering with
    // silence, and name the line count so the retry is computable
    const past = await repo.cli(['read', 'auth-refresh', '--lines', '9000-9001'])
    expect(past.code).toBe(2)
    expect(past.stderr).toContain('bad-range')
  })
})
