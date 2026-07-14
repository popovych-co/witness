import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readStream, type StatusEntry } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { worktreePath } from '../src/worktree.js'
import { approve, seededRepo, writeSpec, writePlan } from './helpers.js'

describe('specflow abandon <plan>', () => {
  it('reverts the paired amendment, restores the prior live stamp, keeps the journal', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })   // live spec before the effort
    await writeSpec(repo, 'auth-refresh', { summary: 'amended by this effort' })  // amendment → draft
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    await repo.cli(['start', 'auth-refresh-plan-1'])
    const journalBefore = readStream(repo.root, 'auth-refresh').length

    const r = await repo.cli(['abandon', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'auth-refresh-plan-1')!.meta.status).toBe('abandoned')
    const spec = findById(canon, 'auth-refresh')!
    expect(spec.meta.status).toBe('live')                              // prior stamp restored
    expect(String(spec.meta.summary)).not.toContain('amended by this effort')
    expect(readStream(repo.root, 'auth-refresh').length).toBeGreaterThan(journalBefore)  // append-only held
    expect(existsSync(worktreePath(repo.root, 'auth-refresh-plan-1'))).toBe(false)
    const entry = readStream(repo.root, 'auth-refresh').at(-1) as StatusEntry
    expect(entry).toMatchObject({ t: 'status', cause: 'abandon', to: 'live' })
  })

  it('deletes a spec the effort created — canon never describes unbuilt intent', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')                              // created by the effort
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const r = await repo.cli(['abandon', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeUndefined()
    expect(existsSync(`${repo.root}/.specflow/journal/auth-refresh.jsonl`)).toBe(true)   // journal remembers
  })

  it('refuses over a stacked amendment and over waiting dependents', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    await writeSpec(repo, 'auth-refresh', { summary: 'first amendment' })
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writeSpec(repo, 'auth-refresh', { summary: 'second amendment on top' })
    const stacked = await repo.cli(['abandon', 'auth-refresh-plan-1'])
    expect(stacked.code).toBe(2)
    expect(stacked.stdout + stacked.stderr).toContain('stacked-amendment')

    const repo2 = await seededRepo()
    await writeSpec(repo2, 'auth-refresh')
    approve(repo2, 'auth-refresh')
    await writeSpec(repo2, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }], depends: ['auth-refresh'] })  // dependent outside the plan
    approve(repo2, 'auth-mfa')
    await writePlan(repo2, 'auth-refresh-plan-1')
    const dependents = await repo2.cli(['abandon', 'auth-refresh-plan-1'])
    expect(dependents.code).toBe(2)
    expect(dependents.stdout + dependents.stderr).toContain('waiting-dependents')
  })

  it('abandons a whole effort: terminal entry + per-artifact walks, or wholesale refusal', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'auth-refresh')).toBeUndefined()
    expect(findById(canon, 'auth-mfa')).toBeUndefined()
    const terminal = readStream(repo.root, 'auth-hardening').at(-1)
    expect(terminal).toMatchObject({ t: 'human-decision', decision: 'abandon-effort' })
    // dashboard no longer lists it as active — effortAbandoned() flips
  })
})
