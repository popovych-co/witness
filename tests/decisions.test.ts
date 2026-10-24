import { describe, expect, it } from 'vitest'
import { basisMoved, specBasis } from '../src/basis.js'
import { carriedDecisions } from '../src/decisions.js'
import { findById, loadCanon } from '../src/scan.js'
import { RECAP, SPEC_BODY, seededRepo, writeSpec, type TestRepo } from './helpers.js'

const D = [{ id: 'd1', text: 'Rotation is server-side' }, { id: 'd2', text: 'Rotate at 80% of the TTL' }]
const amend = (repo: TestRepo, ds: unknown) => repo.cli(['recap', '--amend', '--file', repo.writeRecap({ decisions: ds })])
const doc = (repo: TestRepo, id: string) => findById(loadCanon(repo.root), id)!

describe('what a doc carries (row 198)', () => {
  it('a spec carries the decisions of the write that made its content', async () => {
    const repo = await seededRepo()
    await amend(repo, D)
    expect((await writeSpec(repo, 'auth-refresh', { carries: ['d2'] })).code).toBe(0)
    expect(carriedDecisions(repo.root, doc(repo, 'auth-refresh'))).toEqual({ effort: 'auth-hardening', decisions: [D[1]] })
  })

  it('the later of two efforts that wrote the same content wins (D168)', async () => {
    const repo = await seededRepo()
    await amend(repo, [{ id: 'd1', text: 'first says A' }])
    expect((await writeSpec(repo, 'auth-refresh', { carries: ['d1'] })).code).toBe(0)
    repo.write('r2.json', JSON.stringify({ ...RECAP, effort: 'second', decisions: [{ id: 'd1', text: 'second says B' }] }))
    expect((await repo.cli(['recap', '--file', 'r2.json'])).code).toBe(0)
    const w = await writeSpec(repo, 'auth-refresh', { carries: ['d1'] }, SPEC_BODY, 'second')
    expect(w.code, w.stderr).toBe(0)
    expect(carriedDecisions(repo.root, doc(repo, 'auth-refresh')))
      .toEqual({ effort: 'second', decisions: [{ id: 'd1', text: 'second says B' }] })
  })

  it('an id the latest recap dropped is history, never carried', async () => {
    const repo = await seededRepo()
    await amend(repo, D)
    await writeSpec(repo, 'auth-refresh', { carries: ['d1', 'd2'] })
    await amend(repo, [D[0]])
    expect(carriedDecisions(repo.root, doc(repo, 'auth-refresh'))?.decisions.map((d) => d.id)).toEqual(['d1'])
  })

  it('a doc no journaled write made carries nothing', async () => {
    const repo = await seededRepo()
    await amend(repo, D)
    await writeSpec(repo, 'auth-refresh', { carries: ['d1'] })
    repo.setMeta('auth-refresh', { summary: 'hand edited' })
    expect(carriedDecisions(repo.root, doc(repo, 'auth-refresh'))).toBeUndefined()
  })

  it('a decision the doc does not carry leaves its basis alone', async () => {
    const repo = await seededRepo()
    await amend(repo, D)
    await writeSpec(repo, 'auth-refresh', { carries: ['d1'] })
    const before = specBasis(repo.root, doc(repo, 'auth-refresh'))
    expect(before.decisions).toMatch(/^[0-9a-f]{64}$/)
    await amend(repo, [...D, { id: 'd3', text: 'Audit every rotation' }])
    expect(specBasis(repo.root, doc(repo, 'auth-refresh'))).toEqual(before)
  })

  it('basisMoved compares term by term', () => {
    expect(basisMoved({ spec: 'a' }, { spec: 'a' })).toEqual([])
    expect(basisMoved({ spec: 'a' }, { spec: 'a', decisions: 'x' })).toEqual(['decisions'])
    expect(basisMoved({ spec: 'a', decisions: 'x' }, { spec: 'b' })).toEqual(['spec', 'decisions'])
  })
})
