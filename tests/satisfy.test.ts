import { describe, expect, it } from 'vitest'
import { splitDoc } from '../src/fm.js'
import { SPEC_META, seededRepo, writeSpec } from './helpers.js'

const WITH_MANUAL = {
  ...SPEC_META,
  needs: [{ env: 'SOME_VAR' }, { manual: 'Stripe sandbox account created', satisfied: false }],
}

describe('specflow satisfy', () => {
  it('flips a manual need by text and commits with the trailer', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', WITH_MANUAL)
    const res = await repo.cli(['satisfy', 'auth-refresh', '--need', 'Stripe sandbox account created'])
    expect(res.code).toBe(0)
    const doc = splitDoc(repo.read('specs/auth-refresh.md'))
    const needs = (doc.ok ? doc.value.meta.needs : []) as Array<Record<string, unknown>>
    expect(needs[1]?.satisfied).toBe(true)
    expect(repo.git('log', '-1', '--format=%s')).toBe('satisfy(auth-refresh): Stripe sandbox account created')
    expect(repo.git('log', '-1', '--format=%(trailers:key=Specflow-State,valueonly=true)')).toBe('1')
  })

  it('flips by 1-based index among manual needs and is idempotent', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', WITH_MANUAL)
    const byIndex = await repo.cli(['satisfy', 'auth-refresh', '--need', '1'])
    expect(byIndex.code).toBe(0)
    const head = repo.git('rev-parse', 'HEAD')
    const again = await repo.cli(['satisfy', 'auth-refresh', '--need', '1'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('already satisfied')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
  })

  it('refuses unknown docs and unknown needs', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', WITH_MANUAL)
    expect((await repo.cli(['satisfy', 'ghost', '--need', '1'])).code).toBe(2)
    const bad = await repo.cli(['satisfy', 'auth-refresh', '--need', 'no such need'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('unknown-manual-need')
  })
})
