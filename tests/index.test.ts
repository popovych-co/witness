import { describe, expect, it } from 'vitest'
import { SPEC_META, seededRepo, writeSpec } from './helpers.js'

describe('witness index', () => {
  it('lists specs with summary, status, depends, grouped by dir', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-login', {
      ...SPEC_META,
      summary: 'Users log in with email and password',
      criteria: [{ id: 'ac-login', test: '@spec:auth-login' }],
      depends: ['auth-refresh'],
    })
    repo.write('specs/billing/invoices.md', repo.read('specs/auth-refresh.md').replace(/^id: auth-refresh$/m, 'id: invoices').replace('@spec:auth-refresh', '@spec:invoices'))
    repo.git('add', 'specs/billing/invoices.md')
    repo.git('commit', '-m', 'seed subdir spec', '-m', 'Witness-State: 1')
    const res = await repo.cli(['index'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('specs[3]{id,summary,ui,status,depends}:')
    expect(res.stdout).toContain('auth-login,Users log in with email and password,,draft,auth-refresh')
    expect(res.stdout).toContain('specs/billing[1]{id,summary,ui,status,depends}:')
    expect(res.stdout).toContain('invoices,')
    expect(res.stdout).not.toContain('plan')
  })

  it('surfaces the ui flag as a column', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ...SPEC_META, ui: true, criteria: [{ id: 'ac-book', test: '@spec:booking-form' }] })
    const res = await repo.cli(['index'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('ui')
    expect(res.stdout).toContain('booking-form,Refresh tokens rotate before expiry,ui,draft,')
  })
})
