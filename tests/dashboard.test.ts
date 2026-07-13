import { describe, expect, it } from 'vitest'
import { SPEC_META, seededRepo, tmpRepo, writeSpec } from './helpers.js'

describe('specflow dashboard (no-arg)', () => {
  it('points a fresh repo at recap, then at write', async () => {
    const repo = tmpRepo()
    await repo.cli(['init'])
    const fresh = await repo.cli([])
    expect(fresh.code).toBe(0)
    expect(fresh.stdout).toContain('next: specflow recap --file')
    repo.write('recap.json', JSON.stringify({
      effort: 'auth-hardening', class: 'feature',
      goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [],
    }))
    await repo.cli(['recap', '--file', 'recap.json'])
    const afterRecap = await repo.cli([])
    expect(afterRecap.stdout).toContain('efforts[1]{slug,class,specs,plans}:')
    expect(afterRecap.stdout).toContain('auth-hardening,feature,0,0')
    expect(afterRecap.stdout).toContain('next: specflow write --effort auth-hardening')
  })

  it('computes blockedness live from depends and needs', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-login', {
      ...SPEC_META,
      criteria: [{ id: 'ac-login', test: '@spec:auth-login' }],
      depends: ['auth-refresh'],
      needs: [{ env: 'NOT_SET_VAR' }, { manual: 'dns cut over', satisfied: false }],
    })
    const res = await repo.cli([])
    expect(res.stdout).toContain('blocked[')
    expect(res.stdout).toContain('auth-refresh (draft)')
    expect(res.stdout).toContain('NOT_SET_VAR unset')
    expect(res.stdout).toContain('dns cut over')
    expect(res.stdout).toContain('auth-hardening,feature,2,0')
  })

  it('banners a pending transaction above everything', async () => {
    const repo = await seededRepo()
    repo.write('.specflow/txn.json', JSON.stringify({ op: 'write(x)', files: ['specs/x.md'] }))
    const res = await repo.cli([])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('pending-txn: write(x)')
    expect(res.stdout).toContain('next: specflow recover')
  })
})
