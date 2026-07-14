import { describe, expect, it } from 'vitest'
import { splitDoc } from '../src/fm.js'
import { readStream } from '../src/journal.js'
import { SPEC_BODY, SPEC_META, seededRepo, writeSpec } from './helpers.js'

describe('specflow write (spec)', () => {
  it('creates a draft spec, journals a write entry, commits with the trailer', async () => {
    const repo = await seededRepo()
    const res = await writeSpec(repo, 'auth-refresh')
    expect(res.code).toBe(0)
    const doc = splitDoc(repo.read('specs/auth-refresh.md'))
    expect(doc.ok && doc.value.meta.status).toBe('draft')
    expect(doc.ok && doc.value.meta.summary).toBe(SPEC_META.summary)
    const writes = readStream(repo.root, 'auth-hardening').filter((e) => e.t === 'write')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ artifact: 'auth-refresh', covers: ['g1'] })
    expect(String(writes[0]?.sha)).toMatch(/^[0-9a-f]{64}$/)
    expect(repo.git('log', '-1', '--format=%s')).toBe('write(auth-refresh): create spec')
    expect(repo.git('status', '--porcelain', '--', 'specs', 'plans', '.specflow')).toBe('')
  })

  it('amendment resets status to draft and preserves pr/drift stamps', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const stamped = repo.read('specs/auth-refresh.md')
      .replace('status: draft', 'status: live\npr: 7')
    repo.write('specs/auth-refresh.md', stamped)
    repo.git('add', 'specs/auth-refresh.md')
    repo.git('commit', '-m', 'stamp live', '-m', 'Specflow-State: 1')
    const res = await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: 'Rotation, now with revocation' })
    expect(res.code).toBe(0)
    const doc = splitDoc(repo.read('specs/auth-refresh.md'))
    expect(doc.ok && doc.value.meta.status).toBe('draft')
    expect(doc.ok && doc.value.meta.pr).toBe(7)
    expect(repo.git('log', '-1', '--format=%s')).toBe('write(auth-refresh): amend spec')
  })

  it('journals refusals as write-refused entries with rules only', async () => {
    const repo = await seededRepo()
    const res = await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: 'x'.repeat(121), covers: ['g9'] })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('max-length')
    expect(res.stderr).toContain('unknown-goal')
    const refused = readStream(repo.root, 'auth-hardening').filter((e) => e.t === 'write-refused')
    expect(refused).toHaveLength(1)
    const rules = refused[0]?.rules as Array<Record<string, string>>
    expect(rules.some((r) => r.rule === 'max-length' && r.field === 'summary')).toBe(true)
    expect(rules[0]?.got).toBeUndefined()
    expect(repo.git('log', '-1', '--format=%s')).toBe('write-refused(auth-refresh)')
  })

  it('refuses unknown efforts, unknown deps, and cycles', async () => {
    const repo = await seededRepo()
    const noEffort = await writeSpec(repo, 'auth-refresh', SPEC_META, SPEC_BODY, 'ghost')
    expect(noEffort.code).toBe(2)
    expect(noEffort.stderr).toContain('unknown-effort')
    const badDep = await writeSpec(repo, 'auth-refresh', { ...SPEC_META, depends: ['nope'] })
    expect(badDep.stderr).toContain('unknown-dep')
    await writeSpec(repo, 'auth-refresh')
    const cyc = await writeSpec(repo, 'auth-login', {
      ...SPEC_META, criteria: [{ id: 'ac-login', test: '@spec:auth-login' }], depends: ['auth-refresh'],
    })
    expect(cyc.code).toBe(0)
    const closing = await writeSpec(repo, 'auth-refresh', { ...SPEC_META, depends: ['auth-login'] })
    expect(closing.code).toBe(2)
    expect(closing.stderr).toContain('cycle')
  })

  it('trips the chore-writes-spec tripwire', async () => {
    const repo = await seededRepo({ slug: 'dep-bump', class: 'chore' })
    const res = await writeSpec(repo, 'auth-refresh', SPEC_META, SPEC_BODY, 'dep-bump')
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('class-tripwire')
  })

  it('refuses when state paths carry unrelated dirt, before writing anything', async () => {
    const repo = await seededRepo()
    repo.write('specs/stray.md', 'hand edit')
    const res = await writeSpec(repo, 'auth-refresh')
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unrelated-dirty')
    expect(() => repo.read('specs/auth-refresh.md')).toThrow()
  })
})
