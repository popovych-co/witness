import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { changedFiles } from '../src/evidence.js'
import { diffReviewedSha, effortReviewedSha, effortSpecs, planPairSha } from '../src/reviewed.js'
import { loadCanon } from '../src/scan.js'
import { SPEC_META, approve, seededRepo, writeSpec, writePlan } from './helpers.js'
import type { TestRepo } from './helpers.js'

async function diffRepo(): Promise<{ repo: TestRepo; base: string }> {
  const repo = await seededRepo()
  repo.write('src/token.ts', 'export const ttl = 1\n')
  repo.git('add', '-A')
  repo.git('commit', '-m', 'base')
  return { repo, base: repo.git('rev-parse', 'HEAD') }
}

describe('diffReviewedSha', () => {
  it('moves when a changed path content moves', async () => {
    const { repo, base } = await diffRepo()
    repo.write('src/token.ts', 'export const ttl = 2\n')
    const before = diffReviewedSha(repo.root, base)
    expect(before).toMatch(/^[0-9a-f]{64}$/)
    repo.write('src/token.ts', 'export const ttl = 3\n')
    expect(diffReviewedSha(repo.root, base)).not.toBe(before)
  })

  // The base term is load-bearing, not decorative: a rebase changes the diff TEXT while
  // every blob stays byte-identical, and without it a cached verdict replays against a
  // diff no reviewer read.
  it('moves when the base moves even though every blob is identical', async () => {
    const { repo, base } = await diffRepo()
    repo.write('src/token.ts', 'export const ttl = 2\n')
    repo.git('commit', '--allow-empty', '-m', 'an advance that changes no file')
    const moved = repo.git('rev-parse', 'HEAD')
    expect(moved).not.toBe(base)
    expect(changedFiles(repo.root, moved)).toEqual(changedFiles(repo.root, base))
    expect(diffReviewedSha(repo.root, moved)).not.toBe(diffReviewedSha(repo.root, base))
  })

  it('marks a deleted path instead of throwing on it', async () => {
    const { repo, base } = await diffRepo()
    const present = diffReviewedSha(repo.root, base)
    rmSync(join(repo.root, 'src', 'token.ts'))
    expect(diffReviewedSha(repo.root, base)).not.toBe(present)
  })

  // D161 (#27). A changed path can be a gitlink — a directory on disk that hash-object
  // fatals on. A submodule bump is reviewable change, so it must MOVE the identity, not
  // crash it and not vanish from it.
  it('proxies a changed gitlink through the inner HEAD instead of throwing', async () => {
    const { repo, base } = await diffRepo()
    const vendor = join(repo.root, 'vendor')
    mkdirSync(vendor)
    const gitIn = (...args: string[]) => execFileSync('git', args, { cwd: vendor, encoding: 'utf8' }).trim()
    gitIn('init', '-b', 'main')
    gitIn('config', 'user.name', 'test')
    gitIn('config', 'user.email', 'test@example.com')
    gitIn('config', 'commit.gpgsign', 'false')
    gitIn('commit', '--allow-empty', '-m', 'inner v1')
    repo.git('update-index', '--add', '--cacheinfo', `160000,${gitIn('rev-parse', 'HEAD')},vendor`)
    const one = diffReviewedSha(repo.root, base)         // crashed `fatal: Unable to hash vendor`
    expect(one).toMatch(/^[0-9a-f]{64}$/)
    gitIn('commit', '--allow-empty', '-m', 'inner v2')   // the pointer bump under review
    repo.git('update-index', '--add', '--cacheinfo', `160000,${gitIn('rev-parse', 'HEAD')},vendor`)
    expect(diffReviewedSha(repo.root, base)).not.toBe(one)
  })

  it('marks a symlink to a directory instead of throwing on it', async () => {
    const { repo, base } = await diffRepo()
    mkdirSync(join(repo.root, '.agents', 'skills', 'witness-plan'), { recursive: true })
    symlinkSync('.agents/skills/witness-plan', join(repo.root, 'skills-link'))
    expect(diffReviewedSha(repo.root, base)).toMatch(/^[0-9a-f]{64}$/)
  })

  // Audit F1. A plain directory (or symlinked dir) has no repo of its own — resolving it
  // through a cwd-based rev-parse answers with the OUTER head, so the identity moved on
  // every commit and a settled gate re-armed over a byte-identical diff (row 96a's hole).
  it('keeps the identity stable across an outer commit when a non-repo dir is listed', async () => {
    const { repo, base } = await diffRepo()
    mkdirSync(join(repo.root, '.agents', 'skills', 'witness-plan'), { recursive: true })
    symlinkSync('.agents/skills/witness-plan', join(repo.root, 'skills-link'))
    repo.write('src/token.ts', 'export const ttl = 2\n')
    const settled = diffReviewedSha(repo.root, base)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'feat: the reviewed work, committed')   // same files, same blobs
    expect(diffReviewedSha(repo.root, base)).toBe(settled)
  })

  // Audit F4. git stores a symlink as a blob of its target STRING; hash-object follows it
  // and hashes the target's bytes, so a retarget between byte-identical targets would
  // vanish from the identity — a reviewable change the completeness contract must count.
  it('moves the identity when a symlink is retargeted between byte-identical targets', async () => {
    const { repo, base } = await diffRepo()
    repo.write('conf/prod.env', 'PORT=3000\n')
    repo.write('conf/dev.env', 'PORT=3000\n')                        // byte-identical
    symlinkSync('conf/prod.env', join(repo.root, 'active.env'))
    const before = diffReviewedSha(repo.root, base)
    rmSync(join(repo.root, 'active.env'))
    symlinkSync('conf/dev.env', join(repo.root, 'active.env'))
    expect(diffReviewedSha(repo.root, base)).not.toBe(before)
  })

  it('counts a staged gitlink whose submodule dir is uninitialized', async () => {
    const { repo, base } = await diffRepo()
    mkdirSync(join(repo.root, 'vendor'))                             // no inner .git
    repo.git('update-index', '--add', '--cacheinfo',
      `160000,${repo.git('rev-parse', 'HEAD')},vendor`)
    const one = diffReviewedSha(repo.root, base)
    expect(one).toMatch(/^[0-9a-f]{64}$/)
    repo.git('commit', '--allow-empty', '-m', 'outer advance')       // stability half
    expect(diffReviewedSha(repo.root, base)).toBe(one)
  })

  it('counts an untracked file — it is part of what the reviewers were shown', async () => {
    const { repo, base } = await diffRepo()
    const before = diffReviewedSha(repo.root, base)
    repo.write('src/new-test.ts', 'export const x = 1\n')
    expect(diffReviewedSha(repo.root, base)).not.toBe(before)
  })

  it('ignores gitignored files', async () => {
    const { repo, base } = await diffRepo()
    repo.write('.gitignore', 'scratch/\n')
    repo.git('add', '.gitignore')
    repo.git('commit', '-m', 'ignore scratch')
    const before = diffReviewedSha(repo.root, base)
    repo.write('scratch/tmp.txt', 'noise')
    expect(diffReviewedSha(repo.root, base)).toBe(before)
  })

  // Row 96's stated consequence: under the diff identity a `pr` stamp can never enter the
  // reviewed set, because the worktree never edits `plans/<id>.md` — the stamp arrives
  // with the base and is therefore equal to it. This is the fact `gates/ship.ts` cites.
  it('leaves a stamp that arrives with the base outside the identity', async () => {
    const { repo } = await diffRepo()
    repo.write('plans/p.md', 'status: in-progress\n')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'plan doc')
    const forked = repo.git('rev-parse', 'HEAD')
    repo.write('plans/p.md', 'status: in-progress\npr: 7\n')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'ship(p): pr #7', '-m', 'Witness-State: 1')
    const stamped = repo.git('rev-parse', 'HEAD')
    repo.write('src/token.ts', 'export const ttl = 2\n')      // the branch's own work: code only
    expect(changedFiles(repo.root, stamped)).toEqual(['src/token.ts'])
    expect(diffReviewedSha(repo.root, stamped)).not.toBe(diffReviewedSha(repo.root, forked))
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
