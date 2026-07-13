import { describe, expect, it } from 'vitest'
import { splitDoc } from '../src/fm.js'
import { readStream } from '../src/journal.js'
import { canonicalSha } from '../src/sha.js'
import { PLAN_META, RECAP, SPEC_META, seededRepo, writePlan, writeSpec, type TestRepo } from './helpers.js'

function specSha(repo: TestRepo): string {
  const doc = splitDoc(repo.read('specs/auth-refresh.md'))
  if (!doc.ok) throw new Error('unparseable spec')
  return canonicalSha(doc.value.meta, doc.value.body)
}

describe('specflow write (plan)', () => {
  it('stamps derives-from from the parent and journals the write', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const res = await writePlan(repo, 'auth-refresh-plan-1')
    expect(res.code).toBe(0)
    expect(res.stderr).toContain('parent auth-refresh is draft')
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
    const good = await writePlan(repo, 'p-good', { ...PLAN_META, 'derives-from': specSha(repo) })
    expect(good.code).toBe(0)
    const stale = await writePlan(repo, 'p-stale', { ...PLAN_META, 'derives-from': 'f'.repeat(64) })
    expect(stale.code).toBe(2)
    expect(stale.stderr).toContain('stale-derivation')
  })

  it('refuses steps referencing unknown criteria', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
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
    expect((await writePlan(repo, 'plan-1')).code).toBe(0)
    await writeSpec(repo, 'auth-refresh', {
      ...SPEC_META,
      criteria: [
        { id: 'ac-rotate', test: '@spec:auth-refresh' },
        { id: 'ac-revoke', cmd: 'npm run smoke:revoke' },
      ],
    })
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
    const chore = await seededRepo({ ...RECAP, effort: 'dep-bump', class: 'chore' })
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
