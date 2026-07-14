import { describe, expect, it } from 'vitest'
import { effortReviewedSha, effortSpecs, planPairSha, worktreeTreeSha } from '../src/reviewed.js'
import { loadCanon } from '../src/scan.js'
import { SPEC_META, approve, seededRepo, writeSpec, writePlan } from './helpers.js'

describe('worktreeTreeSha', () => {
  it('changes when an untracked file appears — the Decision 58 protocol test', async () => {
    const repo = await seededRepo()
    const before = worktreeTreeSha(repo.root)
    repo.write('src/new-test.ts', 'export const x = 1\n')     // untracked, never staged
    const after = worktreeTreeSha(repo.root)
    expect(after).not.toBe(before)
    expect(after).toMatch(/^[0-9a-f]{40}$/)
  })

  it('ignores gitignored files and leaves the real index untouched', async () => {
    const repo = await seededRepo()
    repo.write('.gitignore', 'scratch/\n')
    repo.git('add', '.gitignore'); repo.git('commit', '-m', 'ignore scratch')
    const before = worktreeTreeSha(repo.root)
    repo.write('scratch/tmp.txt', 'noise')
    expect(worktreeTreeSha(repo.root)).toBe(before)
    expect(repo.git('status', '--porcelain')).not.toContain('new-file-staged')
  })
})

describe('effort reviewed set', () => {
  it('collects the effort specs and re-rolls the sha on member edit or recap amend', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-mfa', { ...SPEC_META, criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    const canon = loadCanon(repo.root)
    const docs = effortSpecs(repo.root, canon, 'auth-hardening')
    expect(docs.map((d) => d.meta.id)).toEqual(['auth-mfa', 'auth-refresh'])

    const one = effortReviewedSha(repo.root, canon, 'auth-hardening')
    await writeSpec(repo, 'auth-mfa', {
      ...SPEC_META, criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }],
      summary: 'MFA on every login, resend bounded',
    })
    const two = effortReviewedSha(repo.root, loadCanon(repo.root), 'auth-hardening')
    expect(two.sha).not.toBe(one.sha)

    await repo.cli(['recap', '--amend', '--file', repo.writeRecap({ goals: [{ id: 'g1', text: 'rotate' }, { id: 'g2', text: 'mfa' }] })])
    const three = effortReviewedSha(repo.root, loadCanon(repo.root), 'auth-hardening')
    expect(three.sha).not.toBe(two.sha)
  })
})

describe('planPairSha', () => {
  it('changes when either the plan or the parent changes', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')                       // seed helper: draft → approved + commit
    await writePlan(repo, 'auth-refresh-plan-1')
    const canon = loadCanon(repo.root)
    const plan = canon.docs.find((d) => d.meta.id === 'auth-refresh-plan-1')!
    const parent = canon.docs.find((d) => d.meta.id === 'auth-refresh')!
    const base = planPairSha(plan, parent)
    expect(planPairSha(plan, { ...parent, body: parent.body + '\nmore' })).not.toBe(base)
    expect(planPairSha({ ...plan, body: plan.body + '\nmore' }, parent)).not.toBe(base)
  })
})
