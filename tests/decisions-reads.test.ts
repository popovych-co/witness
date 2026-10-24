import { describe, expect, it, vi } from 'vitest'
import { specBasis } from '../src/basis.js'
import { carriedDecisions } from '../src/decisions.js'
import { streamIds } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { seededRepo, writeSpec } from './helpers.js'

// Counts journal reads, passing every call through: `next` asks what a doc carries once per
// queued spec, so a reading that re-scans the journal per ask costs a turn reads per spec × stream.
const reads = vi.hoisted(() => ({ n: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    if (String(p).includes('/.witness/journal/')) reads.n++
    return (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof fs.readFileSync
  return { ...fs, readFileSync, default: { ...fs, readFileSync } }
})

const D = [{ id: 'd1', text: 'Rotation is server-side' }, { id: 'd2', text: 'Rotate at 80% of the TTL' }]
const IDS = ['auth-refresh', 'auth-mfa', 'auth-revoke']

describe('what a doc carries, read in bulk (row 198)', () => {
  it('reads each journal stream once across a run of specs, and sees a write appended since', async () => {
    const repo = await seededRepo()
    await repo.cli(['recap', '--amend', '--file', repo.writeRecap({ decisions: D })])
    for (const id of IDS) await writeSpec(repo, id, { carries: ['d1', 'd2'], criteria: [{ id: `ac-${id}`, test: `@spec:${id}` }] })
    const canon = loadCanon(repo.root)
    reads.n = 0
    for (const id of IDS) specBasis(repo.root, findById(canon, id)!)
    expect(reads.n).toBeLessThanOrEqual(streamIds(repo.root).length)

    await writeSpec(repo, 'auth-mfa', { carries: ['d1'], criteria: [{ id: 'ac-auth-mfa', test: '@spec:auth-mfa' }] })   // same content
    expect(carriedDecisions(repo.root, findById(loadCanon(repo.root), 'auth-mfa')!)?.decisions.map((d) => d.id)).toEqual(['d1'])
  })
})
