import { describe, expect, it } from 'vitest'
import { splitDoc } from '../src/fm.js'
import { readStream } from '../src/journal.js'
import { canonicalSha } from '../src/sha.js'
import { findById, loadCanon } from '../src/scan.js'
import { approve, PLAN_META, SPEC_META, seededRepo, stampLive, writePlan, writeSpec, type TestRepo } from './helpers.js'

function specSha(repo: TestRepo): string {
  const doc = splitDoc(repo.read('specs/auth-refresh.md'))
  if (!doc.ok) throw new Error('unparseable spec')
  return canonicalSha(doc.value.meta, doc.value.body)
}

describe('witness write (plan)', () => {
  it('stamps derives-from from the parent and journals the write', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    stampLive(repo, 'auth-refresh')
    const res = await writePlan(repo, 'auth-refresh-plan-1')
    expect(res.code).toBe(0)
    const doc = splitDoc(repo.read('plans/auth-refresh-plan-1.md'))
    expect(doc.ok && doc.value.meta['derives-from']).toBe(specSha(repo))
    expect(doc.ok && doc.value.meta.status).toBe('draft')
    const writes = readStream(repo.root, 'auth-hardening').filter((e) => e.t === 'write')
    expect(writes.at(-1)).toMatchObject({ artifact: 'auth-refresh-plan-1' })
    expect(writes.at(-1)?.covers).toBeUndefined()
  })

  it('accepts a matching supplied pin and refuses a stale one', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    stampLive(repo, 'auth-refresh')
    const good = await writePlan(repo, 'p-good', { ...PLAN_META, 'derives-from': specSha(repo) })
    expect(good.code).toBe(0)
    const stale = await writePlan(repo, 'p-stale', { ...PLAN_META, 'derives-from': 'f'.repeat(64) })
    expect(stale.code).toBe(2)
    expect(stale.stderr).toContain('stale-derivation')
  })

  it('refuses steps referencing unknown criteria', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    stampLive(repo, 'auth-refresh')
    const res = await writePlan(repo, 'p-bad', {
      ...PLAN_META,
      steps: [{ id: 's1', title: 'x', criteria: ['ac-ghost'] }],
    })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown-criterion')
  })

  it('enforces delta totality: new criteria must be realized, unchanged ones need not be', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    stampLive(repo, 'auth-refresh')
    expect((await writePlan(repo, 'plan-1')).code).toBe(0)
    await writeSpec(repo, 'auth-refresh', {
      ...SPEC_META,
      criteria: [
        { id: 'ac-rotate', test: '@spec:auth-refresh' },
        { id: 'ac-revoke', cmd: 'npm run smoke:revoke' },
      ],
    })
    stampLive(repo, 'auth-refresh')
    const missing = await writePlan(repo, 'plan-2', {
      ...PLAN_META,
      steps: [{ id: 's1', title: 'rehash old work', criteria: ['ac-rotate'] }],
    })
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('criteria-uncovered')
    expect(missing.stderr).toContain('ac-revoke')
    const delta = await writePlan(repo, 'plan-2', {
      ...PLAN_META,
      steps: [{ id: 's1', title: 'revoke on rotation', criteria: ['ac-revoke'] }],
    })
    expect(delta.code).toBe(0)
  })

  it('allows principles parents for chores only', async () => {
    const chore = await seededRepo({ slug: 'dep-bump', class: 'chore' })
    chore.write('specs/principles.md', chore.read('specs/principles.md').replace('status: draft', 'status: approved'))
    chore.git('add', 'specs/principles.md')
    chore.git('commit', '-m', 'stamp approved: principles', '-m', 'Witness-State: 1')
    const ok = await writePlan(chore, 'bump-plan', {
      type: 'plan', parent: 'principles', depends: [], needs: [],
      steps: [{ id: 's1', title: 'bump deps', scaffolding: true }],
    }, '## Step: s1\nbump\n', 'dep-bump')
    expect(ok.code).toBe(0)
    const feature = await seededRepo()
    const bad = await writePlan(feature, 'sneaky-plan', {
      type: 'plan', parent: 'principles', depends: [], needs: [],
      steps: [{ id: 's1', title: 'x', scaffolding: true }],
    }, '## Step: s1\nx\n')
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('class-mismatch')
  })
})

describe('design-from pin', () => {
  it('refuses a plan for a ui spec that has no approved design', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    const wr = await writePlan(repo, 'booking-form-plan-1', { parent: 'booking-form' })
    expect(wr.code).toBe(2)
    expect(wr.stderr).toMatch(/design-from|design-not-approved/)
  })

  it('refuses design-from on a non-ui parent', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    const wr = await writePlan(repo, 'auth-refresh-plan-1', { parent: 'auth-refresh', 'design-from': 'a'.repeat(64) })
    expect(wr.code).toBe(2)
    expect(wr.stderr).toContain('design-from')
  })
})

describe('re-authoring a plan does not end its flow', () => {
  // `flowAction` routes an in-flight plan's reopen to this verb (row 95). Hardcoding
  // `status: draft` here demoted a plan holding a `pr` and a live worktree out of
  // flow-hood, and `flowAction`, `flowBlocked`, `dashboard` and `--flow` all started
  // lying about it.
  it('preserves an in-progress status', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    await repo.cli(['start', 'auth-refresh-plan-1'])

    const again = await writePlan(repo, 'auth-refresh-plan-1', {
      steps: [{ id: 's1', title: 'rotate tokens on refresh, bounded', criteria: ['ac-rotate'] }],
    })
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('status: in-progress')
    expect(findById(loadCanon(repo.root), 'auth-refresh-plan-1')!.meta.status).toBe('in-progress')

    await repo.cli(['clean'])
  })

  it('leaves a draft plan a draft', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const again = await writePlan(repo, 'auth-refresh-plan-1')
    expect(again.stdout).toContain('status: draft')
  })

  it('refuses a done plan — that one merged, and re-authoring rewrites what shipped', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    const again = await writePlan(repo, 'auth-refresh-plan-1')
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('terminal-status')
  })

  // Row 85's recovery path: `abandon <effort>` stamps the effort's plans abandoned, and
  // `next` then routes the plan write to a LIVE effort. Refusing here would strand the very
  // loop row 85 unstranded — a revived plan is new work, so it re-enters at draft.
  it('revives an abandoned plan as a draft', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'abandoned')
    const again = await writePlan(repo, 'auth-refresh-plan-1')
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('status: draft')
    expect(findById(loadCanon(repo.root), 'auth-refresh-plan-1')!.meta.status).toBe('draft')
  })

  // The narrowness is the point: a spec's approval is a statement about content that just
  // changed, so re-authoring one still returns it to draft.
  it('does not extend the rule to specs', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-refresh')
    expect(findById(loadCanon(repo.root), 'auth-refresh')!.meta.status).toBe('draft')
  })
})
