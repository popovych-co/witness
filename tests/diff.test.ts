import { describe, expect, it } from 'vitest'
import { splitDoc } from '../src/fm.js'
import { canonicalSha } from '../src/sha.js'
import { seededRepo, writeSpec, type TestRepo } from './helpers.js'

function currentSha(repo: TestRepo, rel: string): string {
  const doc = splitDoc(repo.read(rel))
  if (!doc.ok) throw new Error('unparseable doc')
  return canonicalSha(doc.value.meta, doc.value.body)
}

function seedPlanPinnedAt(repo: TestRepo, pin: string): void {
  repo.write('plans/auth-refresh-plan-1.md', [
    '---', 'id: auth-refresh-plan-1', 'type: plan', 'status: draft',
    'parent: auth-refresh', `derives-from: ${pin}`, 'depends: []', 'needs: []',
    'steps:', '  - id: s1', '    title: rotate', '    criteria: [ac-rotate]',
    '---', '', '## Step: s1', 'do it', '',
  ].join('\n'))
  repo.git('add', 'plans/auth-refresh-plan-1.md')
  repo.git('commit', '-m', 'seed plan', '-m', 'Witness-State: 1')
}

describe('witness diff', () => {
  it('reports an empty base for a never-planned spec', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const res = await repo.cli(['diff', 'auth-refresh'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('base: empty')
    expect(res.stdout).toContain('full content is the delta')
  })

  it('diffs current content against the latest plan pin', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const v1 = currentSha(repo, 'specs/auth-refresh.md')
    seedPlanPinnedAt(repo, v1)
    await writeSpec(repo, 'auth-refresh', {
      type: 'spec',
      summary: 'Rotation plus revocation',
      depends: [], needs: [],
      criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }],
      covers: ['g1'],
    })
    const res = await repo.cli(['diff', 'auth-refresh'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('base: plan-pin auth-refresh-plan-1')
    expect(res.stdout).toContain('-summary: Refresh tokens rotate before expiry')
    expect(res.stdout).toContain('+summary: Rotation plus revocation')
  })

  it('reports no delta when the pin matches current content', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    seedPlanPinnedAt(repo, currentSha(repo, 'specs/auth-refresh.md'))
    const res = await repo.cli(['diff', 'auth-refresh'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('no delta')
  })

  it('fails loud on an unresolvable pin', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    seedPlanPinnedAt(repo, 'f'.repeat(64))
    const res = await repo.cli(['diff', 'auth-refresh'])
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('pin-unresolvable')
  })
})
