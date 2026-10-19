import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDeferrals } from '../src/deferral.js'
import { appendEntry, readStream, streamExists } from '../src/journal.js'
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

// D166. Row 29 unwinds a write by selectively reverting its state commit, and a re-slice's
// commit also deleted the predecessor. Taking that write back brings the predecessor back —
// whole, or not at all while another slice of the same re-slice still stands.
describe('the way back (D166)', () => {
  it('abandoning the effort that re-sliced a shipped spec brings the spec back, debts and all', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })   // live
    repo.effort = 'bootstrap'
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')                     // shipped
    repo.effort = 'auth-hardening'
    appendEntry(repo.root, 'auth-refresh', {
      t: 'deferral', id: 'd-0000cafe', artifact: 'auth-refresh', gate: 'ship', round: 1,
      anchor: 'auth-refresh > ## Behavior', kind: 'artifact-debt', caused_by_run: 'r-1',
    })
    repo.git('add', '.witness/journal/auth-refresh.jsonl')
    repo.git('commit', '-q', '-m', 'an open obligation on the shipped spec', '-m', 'Witness-State: 1')
    const before = repo.read('specs/auth-refresh.md')
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'setup-card')).toBeUndefined()
    expect(findById(canon, 'auth-refresh')!.meta.status).toBe('live')          // shipped content is described again
    expect(repo.read('specs/auth-refresh.md')).toBe(before)                    // byte for byte
    expect(openDeferrals(readStream(repo.root, 'auth-refresh')).map((d) => d.id)).toEqual(['d-0000cafe'])
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('abandoning the only plan of the only successor brings the spec back too', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    approve(repo, 'setup-card')
    expect((await writePlan(repo, 'setup-card-plan-1', {
      parent: 'setup-card', steps: [{ id: 's1', title: 'card', criteria: ['ac-setup'] }],
    })).code).toBe(0)
    expect((await repo.cli(['abandon', 'setup-card-plan-1'])).code).toBe(0)
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'setup-card')).toBeUndefined()
    expect(findById(canon, 'auth-refresh')!.meta.status).toBe('live')
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('taking back a split brings the spec back once, with every slice gone', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    expect((await writeSpec(repo, 'setup-email', {
      supersedes: 'auth-refresh', criteria: [{ id: 'ac-email', test: '@spec:setup-email' }],
    })).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'setup-card')).toBeUndefined()
    expect(findById(canon, 'setup-email')).toBeUndefined()
    expect(findById(canon, 'auth-refresh')!.meta.status).toBe('live')
    expect(readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'status' && e.from === 'superseded')).toHaveLength(1)
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('one slice of a split is kept while another still stands — the split goes back whole', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    expect((await writeSpec(repo, 'setup-email', {
      supersedes: 'auth-refresh', criteria: [{ id: 'ac-email', test: '@spec:setup-email' }],
    })).code).toBe(0)
    approve(repo, 'setup-card')
    expect((await writePlan(repo, 'setup-card-plan-1', {
      parent: 'setup-card', steps: [{ id: 's1', title: 'card', criteria: ['ac-setup'] }],
    })).code).toBe(0)
    const r = await repo.cli(['abandon', 'setup-card-plan-1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('kept: setup-card — not unwound · still standing on it: setup-email')
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeUndefined()      // half a split is not taken back
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)        // the effort takes it back whole
    expect(findById(loadCanon(repo.root), 'auth-refresh')!.meta.status).toBe('live')
  })
})

// D166. An id names one artifact for the life of the repo, because its stream IS that
// artifact's history; and a create never lands on a file another doc holds.
describe('identity (D166)', () => {
  it('a superseded id is never written again', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-tokens', TOKENS_CRITERIA)
    approve(repo, 'auth-tokens')
    await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', ...ROTATION_CRITERIA })
    const again = await writeSpec(repo, 'auth-tokens', TOKENS_CRITERIA)
    expect(again.code).toBe(2)
    expect(again.stdout + again.stderr).toContain('id-taken')
    expect(again.stdout + again.stderr).toContain('superseded by token-rotation')
    expect(findById(loadCanon(repo.root), 'auth-tokens')).toBeUndefined()
  })

  it('adopt cannot bring a superseded id back either', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-tokens', TOKENS_CRITERIA)
    approve(repo, 'auth-tokens')
    await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', ...ROTATION_CRITERIA })
    repo.write('specs/auth-tokens.md', repo.git('show', 'HEAD~1:specs/auth-tokens.md') + '\n')
    repo.git('add', 'specs/auth-tokens.md')
    repo.git('commit', '-q', '-m', 'hand re-create')
    const r = await repo.cli(['adopt', 'specs/auth-tokens.md'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('id-taken')
  })

  it('a spec its own abandon unwound may be written again as a spec', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)   // unwound: `removed`
    expect((await writeSpec(repo, 'auth-refresh')).code).toBe(0)
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeDefined()
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('an effort\'s slug is not a free artifact id, and the refusal says whose it is', async () => {
    const repo = await seededRepo()
    const r = await writeSpec(repo, repo.effort, { criteria: [{ id: 'ac-x', test: `@spec:${repo.effort}` }] })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('id-taken')
    expect(r.stdout + r.stderr).toContain('is an effort\'s slug')
  })

  it('witness\'s own floor stream is not a free artifact id', async () => {
    const repo = await seededRepo()
    const r = await writeSpec(repo, 'floor', { criteria: [{ id: 'ac-f', test: '@spec:floor' }] })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('id-taken')
  })

  it('a stray stream does not hold its id — next and write cannot disagree', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    appendEntry(repo.root, 'auth-refresh-plan-1', { t: 'status', artifact: 'auth-refresh-plan-1', from: 'draft', to: 'approved', cause: 'gate-approve' })
    repo.git('rm', '-q', 'plans/auth-refresh-plan-1.md')
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'hand delete', '-m', 'Witness-State: 1')
    expect((await writePlan(repo, 'auth-refresh-plan-1')).code).toBe(0)
  })

  it('a create never lands on another doc\'s file — rename leaves the old path to the renamed doc', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    expect((await repo.cli(['rename', 'auth-refresh', 'token-refresh'])).code).toBe(0)
    const r = await writeSpec(repo, 'auth-refresh', { summary: 'a different spec' })
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('path-taken')
    expect(r.stdout + r.stderr).toContain('holds token-refresh')
    expect(findById(loadCanon(repo.root), 'token-refresh')).toBeDefined()
  })
})
