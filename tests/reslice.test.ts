import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream, streamExists } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { approve, fakeScenario, gateEnv, ghState, seededRepo, shippableRepo, writeDesign, writePlan, writeSpec } from './helpers.js'

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

// D166. A spec leaves canon through one door, so the re-slice and the unwind take the same
// things out with it. This pins the re-slice's half, which predates the shared door.
describe('one departure, both verbs (D166)', () => {
  it('a re-slice takes the superseded spec\'s design out of canon with it', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-tokens', { ui: true, ...TOKENS_CRITERIA })
    expect((await writeDesign(repo, 'auth-tokens')).code).toBe(0)
    approve(repo, 'auth-tokens')
    expect((await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', ...ROTATION_CRITERIA })).code).toBe(0)
    expect(existsSync(join(repo.root, 'designs/auth-tokens.html'))).toBe(false)
    const files = repo.git('show', '--no-renames', '--name-only', '--format=', 'HEAD').trim().split('\n')
    expect(files).toContain('designs/auth-tokens.html')
  })
})

// D166 / issue #34. A plan's `parent` is the edge into the spec that row 62 never guarded. A
// plan still moving holds the re-slice; a finished one keeps its parent in the departed stream
// (check's half of D166) and holds nothing.
describe('re-slice over plans (D166)', () => {
  it('refuses dangling-parent while a plan of the superseded spec is still moving — a human\'s decision', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })   // live, shipped before this effort
    await writePlan(repo, 'auth-refresh-plan-1')                       // draft: still moving
    const r = await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('dangling-parent')
    expect(r.stdout + r.stderr).toContain('auth-refresh-plan-1')
    expect(r.stdout + r.stderr).toContain('a human\'s decision')
    expect(r.stdout + r.stderr).not.toContain('self-repair')
    expect(r.stdout + r.stderr).not.toContain('witness abandon')
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'auth-refresh')).toBeDefined()               // nothing deleted
    expect(findById(canon, 'setup-card')).toBeUndefined()               // nothing written
    const refused = readStream(repo.root, repo.effort).filter((e) => e.t === 'write-refused').at(-1)
    expect(refused).toMatchObject({ artifact: 'setup-card', rules: [{ field: 'supersedes', rule: 'dangling-parent' }] })
    // abandoning the plan finishes it, and a finished plan holds nothing
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeUndefined()
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('names both dangling edges in one refusal', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }], depends: ['auth-refresh'] })
    await writePlan(repo, 'auth-refresh-plan-1')
    const r = await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('dangling-depends')
    expect(r.stdout + r.stderr).toContain('dangling-parent')
  })

  it('a plan merged but not yet stamped holds the re-slice until one check stamps it done', async () => {
    const { repo, planId, specId } = await shippableRepo()
    repo.setMeta(planId, { pr: 1 })                        // ship stamped the PR (direct seed, as stamp.test.ts does)
    const scenario = fakeScenario()
    ghState(scenario, 1, 'MERGED')
    const held = await writeSpec(repo, 'setup-card', { supersedes: specId, ...SETUP_CARD })
    expect(held.code).toBe(2)
    expect(held.stdout + held.stderr).toContain('dangling-parent')
    // check runs the lazy merge stamp (gateEnv clears CI and puts the fake gh first on PATH)
    await repo.cli(['check'], { env: gateEnv(scenario) })
    expect(findById(loadCanon(repo.root), planId)!.meta.status).toBe('done')
    expect((await writeSpec(repo, 'setup-card', { supersedes: specId, ...SETUP_CARD })).code).toBe(0)
    const res = await repo.cli(['check'], { env: gateEnv(scenario) })
    expect(res.stdout).not.toContain('unknown-parent')
    expect(res.code).toBe(0)
  })

  it('re-slices specs only — principles are amended in place', async () => {
    const repo = await seededRepo()
    const r = await writeSpec(repo, 'setup-card', { supersedes: 'principles', ...SETUP_CARD })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('not-a-spec')
    expect(findById(loadCanon(repo.root), 'principles')).toBeDefined()
  })
})
