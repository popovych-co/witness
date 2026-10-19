import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream, streamExists } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { approve, seededRepo, writePlan, writeSpec } from './helpers.js'

const TOKENS_CRITERIA = { criteria: [{ id: 'ac-tokens', test: '@spec:auth-tokens' }] }
const ROTATION_CRITERIA = { criteria: [{ id: 'ac-rotation', test: '@spec:token-rotation' }] }
const MFA_CRITERIA = { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] }

describe('re-slice via supersedes', () => {
  it('deletes the superseded file in the same commit, freezes its journal as lineage', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-tokens', TOKENS_CRITERIA)     // the fat spec being split
    approve(repo, 'auth-tokens')
    await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', ...ROTATION_CRITERIA })
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'auth-tokens')).toBeUndefined()
    expect(existsSync(join(repo.root, 'specs/auth-tokens.md'))).toBe(false)
    expect(findById(canon, 'token-rotation')).toBeDefined()
    // one state commit carried write + delete + both journal appends — --no-renames because
    // auth-tokens.md and token-rotation.md are similar enough that git's default rename
    // detection collapses them into one R-record, and --name-only then hides the old path
    const files = repo.git('show', '--no-renames', '--name-only', '--format=', 'HEAD').trim().split('\n')
    expect(files).toContain('specs/token-rotation.md')
    expect(files).toContain('specs/auth-tokens.md')
    const terminal = readStream(repo.root, 'auth-tokens').at(-1)
    expect(terminal).toMatchObject({ t: 'status', to: 'superseded', cause: 'supersede', by: 'token-rotation' })
    expect(streamExists(repo.root, 'auth-tokens')).toBe(true)  // frozen, never deleted
  })

  it('refuses while dependents still reference the superseded spec', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-tokens', TOKENS_CRITERIA)
    await writeSpec(repo, 'auth-mfa', { depends: ['auth-tokens'], ...MFA_CRITERIA })
    const r = await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', ...ROTATION_CRITERIA, expectCode: 2 })
    expect(r.stdout + r.stderr).toContain('dangling-depends')
    expect(findById(loadCanon(repo.root), 'auth-tokens')).toBeDefined()   // nothing happened
  })
})

describe('log --lineage and --all', () => {
  it('walks the supersedes chain and merges streams by commit order', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-tokens', TOKENS_CRITERIA)
    approve(repo, 'auth-tokens')
    await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', ...ROTATION_CRITERIA })

    const lineage = await repo.cli(['log', 'token-rotation', '--lineage'])
    expect(lineage.code).toBe(0)
    const idxTokens = lineage.stdout.indexOf('auth-tokens')
    const idxRotation = lineage.stdout.indexOf('token-rotation')
    expect(idxTokens).toBeGreaterThanOrEqual(0)
    expect(idxTokens).toBeLessThan(idxRotation)              // ancestors render first

    const all = await repo.cli(['log', '--all'])
    expect(all.code).toBe(0)
    const recapAt = all.stdout.indexOf('recap')
    const supersededAt = all.stdout.indexOf('superseded')
    expect(recapAt).toBeGreaterThanOrEqual(0)
    expect(recapAt).toBeLessThan(supersededAt)               // commit order, oldest first
  })
})

const SETUP_CARD = { criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] }

// D166. A re-slice names its predecessor; any departure of that predecessor is terminal here,
// because there is nothing left to delete either way.
describe('reading a departure (D166)', () => {
  it('a re-slice may name a spec its own abandon already unwound', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')                  // created by this effort
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)   // unwinds the spec: removed
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
  })
})
