import { describe, expect, it } from 'vitest'
import { splitDoc } from '../src/fm.js'
import { readStream } from '../src/journal.js'
import { needMet } from '../src/needs.js'
import { findById, loadCanon } from '../src/scan.js'
import { SPEC_META, seededRepo, writeSpec } from './helpers.js'

const WITH_MANUAL = {
  ...SPEC_META,
  needs: [{ env: 'SOME_VAR' }, { manual: 'Stripe sandbox account created', satisfied: false }],
}

describe('witness satisfy', () => {
  // Row 179: satisfaction is journaled, so the frontmatter flag stays as written.
  it('satisfies a manual need by text and commits with the trailer', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', WITH_MANUAL)
    const res = await repo.cli(['satisfy', 'auth-refresh', '--need', 'Stripe sandbox account created'])
    expect(res.code).toBe(0)
    const doc = splitDoc(repo.read('specs/auth-refresh.md'))
    const needs = (doc.ok ? doc.value.meta.needs : []) as Array<Record<string, unknown>>
    expect(needs[1]?.satisfied).toBe(false)
    expect(needMet(findById(loadCanon(repo.root), 'auth-refresh')!, needs[1] as { manual: string })).toBe(true)
    expect(repo.git('log', '-1', '--format=%s')).toBe('satisfy(auth-refresh): Stripe sandbox account created')
    expect(repo.git('log', '-1', '--format=%(trailers:key=Witness-State,valueonly=true)')).toBe('1')
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

  it('flips a need by its id and lists ids when nothing matches (A10)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, needs: [{ id: 'sbx', manual: 'Stripe sandbox account created', satisfied: false }] })
    const bad = await repo.cli(['satisfy', 'auth-refresh', '--need', 'nope'])
    expect(bad.stderr).toContain('1=sbx')
    expect((await repo.cli(['satisfy', 'auth-refresh', '--need', 'sbx'])).code).toBe(0)
    // where the satisfaction is recorded is Task 6b's: the journal, never the frontmatter
  })

  it('records the satisfaction in the journal and leaves the spec file byte-identical (A10)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, needs: [{ id: 'sbx', manual: 'Stripe sandbox account created', satisfied: false }] })
    const before = repo.read('specs/auth-refresh.md')
    expect((await repo.cli(['satisfy', 'auth-refresh', '--need', 'sbx'])).code).toBe(0)
    expect(repo.read('specs/auth-refresh.md')).toBe(before)
    expect(readStream(repo.root, 'auth-refresh').some((e) => e.t === 'need-satisfied' && (e as { need?: string }).need === 'sbx')).toBe(true)
    expect(repo.git('log', '-1', '--format=%s')).toBe('satisfy(auth-refresh): sbx')
    expect(repo.git('show', '--name-only', '--format=', 'HEAD')).toBe('.witness/journal/auth-refresh.jsonl')
    const doc = findById(loadCanon(repo.root), 'auth-refresh')!
    expect(needMet(doc, { id: 'sbx', manual: 'Stripe sandbox account created', satisfied: false })).toBe(true)
    const again = await repo.cli(['satisfy', 'auth-refresh', '--need', 'sbx'])
    expect(again.stdout).toContain('satisfy: already satisfied: Stripe sandbox account created')
    expect(readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'need-satisfied')).toHaveLength(1)
  })
})
