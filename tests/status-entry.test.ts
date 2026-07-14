import { describe, expect, it } from 'vitest'
import { appendEntry, readStream, type StatusEntry } from '../src/journal.js'
import { seededRepo, writeSpec, PLAN_META, PLAN_BODY } from './helpers.js'

describe('status entries', () => {
  it('round-trips a status entry through a journal stream', async () => {
    const repo = await seededRepo()
    const entry: StatusEntry = {
      v: 1, t: 'status', artifact: 'auth-refresh-plan-1',
      from: 'approved', to: 'in-progress', cause: 'start',
      worktree: '.specflow/worktrees/auth-refresh-plan-1', branch: 'specflow/auth-refresh-plan-1',
    }
    appendEntry(repo.root, 'auth-refresh-plan-1', entry)
    const back = readStream(repo.root, 'auth-refresh-plan-1')
    expect(back[back.length - 1]).toEqual(entry)
  })
})

describe('write entries mark creation', () => {
  it('stamps created: true on a brand-new spec, not on an amendment', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')            // new
    await writeSpec(repo, 'auth-refresh')            // amendment (same id again)
    const writes = readStream(repo.root, 'auth-hardening')
      .filter((e) => e.t === 'write' && (e as { artifact?: string }).artifact === 'auth-refresh')
    expect((writes[0] as { created?: boolean }).created).toBe(true)
    expect('created' in (writes[1] as object)).toBe(false)
  })
})

describe('plan write legality (tightened)', () => {
  it('refuses a plan whose parent is still draft', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')            // spec lands as draft
    repo.write('m.json', JSON.stringify(PLAN_META))
    repo.write('b.md', PLAN_BODY)
    const r = await repo.cli(['write', 'auth-refresh-plan-1', '--effort', 'auth-hardening',
      '--meta', 'm.json', '--body', 'b.md'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('parent-not-approved')
    expect(r.stderr).toContain('gate decompose')
  })
})
