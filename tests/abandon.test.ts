import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream, type StatusEntry } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { worktreePath } from '../src/worktree.js'
import { approve, DESIGN_HTML, recapEffort, seededRepo, stampLive, writeDesign, writeSpec, writePlan, PLAN_BODY } from './helpers.js'

describe('witness abandon <plan>', () => {
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
    expect(existsSync(`${repo.root}/.witness/journal/auth-refresh.jsonl`)).toBe(true)   // journal remembers
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

  it('leaves a spec the abandoned effort never wrote alone, even when a sibling effort wrote both', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })   // bootstrap: auth-refresh live
    // effort A — sorts first alphabetically — amends the spec AND writes the plan
    await writeSpec(repo, 'auth-refresh', { summary: 'amended by effort A' })
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'approved')

    // effort B rewrites the SAME plan and writes no spec at all
    repo.write('recap-b.json', JSON.stringify({
      effort: 'ratchet-scope', class: 'chore',
      goals: [{ id: 'g1', text: 'narrow the ratchet scope' }], non_goals: [], constraints: [], slices: [],
    }))
    expect((await repo.cli(['recap', '--file', 'recap-b.json'])).code).toBe(0)
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'ratchet-scope')).code).toBe(0)

    const r = await repo.cli(['abandon', 'ratchet-scope'])
    expect(r.code).toBe(0)
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'auth-refresh-plan-1')!.meta.status).toBe('abandoned')
    // the reported count is the docs actually walked: it read one fewer than it touched,
    // so the extra spec revert never showed up in the line a human reads
    expect(r.stdout).toContain('1 artifacts walked')
    const touched = repo.git('show', '--name-only', '--format=', 'HEAD').split('\n')
      .filter((f) => f.startsWith('specs/') || f.startsWith('plans/'))
    expect(touched).toEqual(['plans/auth-refresh-plan-1.md'])
    const spec = findById(canon, 'auth-refresh')!
    expect(String(spec.meta.summary)).toBe('amended by effort A')     // effort A's amendment survives
    expect(spec.meta.status).toBe('approved')
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

// D166. The unwind departs a spec through the same door the re-slice uses, and a restore takes
// the look back with the content it was drawn for.
describe('one departure, both verbs (D166)', () => {
  it('an unwound ui spec takes its design out of canon with it', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    expect((await writeDesign(repo, 'auth-refresh')).code).toBe(0)
    expect(existsSync(join(repo.root, 'designs/auth-refresh.html'))).toBe(true)
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)   // unwinds the spec it created
    expect(existsSync(join(repo.root, 'designs/auth-refresh.html'))).toBe(false)
    expect(repo.git('show', '--name-only', '--format=', 'HEAD').split('\n')).toContain('designs/auth-refresh.html')
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('an unwound amendment puts its spec\'s design back, byte for byte', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking', { ui: true, criteria: [{ id: 'ac-b', test: '@spec:booking' }] })
    const v1 = DESIGN_HTML.replace('New service', 'Look one')
    expect((await writeDesign(repo, 'booking', v1)).code).toBe(0)
    approve(repo, 'booking')
    stampLive(repo, 'booking')
    await recapEffort(repo, 'redesign')
    expect((await writeSpec(repo, 'booking', { ui: true, summary: 'Bookings · amended', criteria: [{ id: 'ac-b', test: '@spec:booking' }] }, undefined, 'redesign')).code).toBe(0)
    expect((await writeDesign(repo, 'booking', DESIGN_HTML.replace('New service', 'Look two'))).code).toBe(0)
    expect((await repo.cli(['abandon', 'redesign'])).code).toBe(0)
    expect(repo.read('designs/booking.html')).toBe(v1)
  })
})

// D166. Abandoning a plan takes back the spec content it was paired with (row 29) — but a
// sibling derived from the same version either shipped it or is still building it. The
// content stays while any other plan stands on it. An effort's own abandon is its last act,
// so it keeps only what nothing will ever need to take back.
describe('abandon keeps content another plan stands on (D166)', () => {
  it('abandoning the second plan of a shipped spec keeps the spec', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')                  // created by this effort
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')           // same pin: the spec was never amended
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    const r = await repo.cli(['abandon', 'auth-refresh-plan-2'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('kept: auth-refresh — not unwound · still standing on it: auth-refresh-plan-1')
    const canon = loadCanon(repo.root)
    expect(findById(canon, 'auth-refresh')!.meta.status).toBe('live')   // canon still describes what shipped
    expect(findById(canon, 'auth-refresh-plan-2')!.meta.status).toBe('abandoned')
    expect(readStream(repo.root, 'auth-refresh').some((e) =>
      e.t === 'status' && (e as unknown as StatusEntry).to === 'removed')).toBe(false)
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('keeps it for a sibling still moving, and the last plan off takes it back', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect((await repo.cli(['abandon', 'auth-refresh-plan-2'])).code).toBe(0)
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeDefined()
    expect((await repo.cli(['check'])).code).toBe(0)
    const last = await repo.cli(['abandon', 'auth-refresh-plan-1'])
    expect(last.code).toBe(0)
    expect(last.stdout).toContain('reverted: auth-refresh (delete)')
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeUndefined()
    expect((await repo.cli(['check'])).code).toBe(0)       // both plans finished: their parent lives in the journal
  })

  it('a kept spec dangles no depends edge, so dependents do not refuse the abandon', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }], depends: ['auth-refresh'] })
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    const r = await repo.cli(['abandon', 'auth-refresh-plan-2'])
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).not.toContain('waiting-dependents')
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeDefined()
  })

  it('abandon <effort> refuses while another effort\'s plan still builds on its spec, then takes it back', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')                  // created by auth-hardening
    approve(repo, 'auth-refresh')
    await recapEffort(repo, 'auth-followup')
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'auth-followup')).code).toBe(0)
    const held = await repo.cli(['abandon', 'auth-hardening'])
    expect(held.code).toBe(2)
    expect(held.stdout + held.stderr).toContain('still-standing')
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeDefined()
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)   // its effort never wrote the spec: nothing unwinds
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)
    expect(findById(loadCanon(repo.root), 'auth-refresh')).toBeUndefined()      // nothing stands now: the unwind runs
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('abandon <effort> keeps for good a spec another effort\'s plan shipped', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await recapEffort(repo, 'auth-followup')
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'auth-followup')).code).toBe(0)
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('kept: auth-refresh — not unwound · still standing on it: auth-refresh-plan-1')
    expect(findById(loadCanon(repo.root), 'auth-refresh')!.meta.status).toBe('live')
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('the restore keeps an amendment a sibling already shipped', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })   // live v1, shipped before this effort
    await writeSpec(repo, 'auth-refresh', { summary: 'amended by this effort' })   // v2
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')           // both derived from v2
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')                        // v2 shipped by plan-1
    const r = await repo.cli(['abandon', 'auth-refresh-plan-2'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('kept: auth-refresh — not unwound · still standing on it: auth-refresh-plan-1')
    expect(String(findById(loadCanon(repo.root), 'auth-refresh')!.meta.summary)).toBe('amended by this effort')
  })
})

// D168. An abandon takes back what an effort did, found by its own write entries — never by
// matching content, which a return or another abandon's restore can bring back later.
describe('abandon takes back the act, not the content (D168)', () => {
  const SETUP_CARD = { criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] }
  const specs = (repo: Awaited<ReturnType<typeof seededRepo>>): string =>
    loadCanon(repo.root).docs.filter((d) => d.meta.type === 'spec').map((d) => String(d.meta.id)).sort().join(' ')

  it('an amendment that came back with a return is restored to what shipped, never deleted', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    const shipped = repo.read('specs/auth-refresh.md')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'amended by auth-hardening' })).code).toBe(0)
    await recapEffort(repo, 'second')
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD }, undefined, 'second')).code).toBe(0)
    expect((await repo.cli(['abandon', 'second'])).code).toBe(0)        // auth-refresh returns, amended
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reverted: auth-refresh (restore) — journal untouched')
    expect(repo.read('specs/auth-refresh.md')).toBe(shipped)
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('a create a restore brought back is deleted, never left as another effort\'s abandoned amendment', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'setup-card', SETUP_CARD)).code).toBe(0)
    await recapEffort(repo, 'second')
    expect((await writeSpec(repo, 'setup-card', { summary: 'amended by second', ...SETUP_CARD }, undefined, 'second')).code).toBe(0)
    expect((await repo.cli(['abandon', 'second'])).code).toBe(0)        // back to auth-hardening's create
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reverted: setup-card (delete) — journal untouched')
    expect(specs(repo)).toBe('')
  })

  it('an effort that created a spec and revised it takes the whole spec back', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'setup-card', SETUP_CARD)).code).toBe(0)
    expect((await writeSpec(repo, 'setup-card', { summary: 'revised in round 2', ...SETUP_CARD })).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reverted: setup-card (delete) — journal untouched')
    expect(specs(repo)).toBe('')
  })

  it('an effort that amended a shipped spec twice gives back what shipped', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    const shipped = repo.read('specs/auth-refresh.md')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'amendment round 1' })).code).toBe(0)
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'amendment round 2' })).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)
    expect(repo.read('specs/auth-refresh.md')).toBe(shipped)
  })

  it('a re-slice its own effort revised still gives the spec it departed back', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    const shipped = repo.read('specs/auth-refresh.md')
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', summary: 'revised', ...SETUP_CARD })).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('returned: auth-refresh — back in canon as live · the re-slice into setup-card is taken back')
    expect(specs(repo)).toBe('auth-refresh')
    expect(repo.read('specs/auth-refresh.md')).toBe(shipped)
  })

  it('an amendment that folded another spec in, then revised, gives both back as they shipped', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    await recapEffort(repo, 'mfa')
    expect((await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] }, undefined, 'mfa')).code).toBe(0)
    approve(repo, 'auth-mfa')
    stampLive(repo, 'auth-mfa')                                                  // shipped by its own effort
    const shipped = repo.read('specs/auth-refresh.md')
    const folded = repo.read('specs/auth-mfa.md')
    expect((await writeSpec(repo, 'auth-refresh', { supersedes: 'auth-mfa', summary: 'auth-mfa folded in' })).code).toBe(0)
    expect(existsSync(join(repo.root, 'specs/auth-mfa.md'))).toBe(false)          // the fold departed it
    expect((await writeSpec(repo, 'auth-refresh', { supersedes: 'auth-mfa', summary: 'fold revised' })).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('returned: auth-mfa — back in canon as live · the re-slice into auth-refresh is taken back')
    expect(repo.read('specs/auth-refresh.md')).toBe(shipped)
    expect(repo.read('specs/auth-mfa.md')).toBe(folded)
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('abandoning a plan derived from another effort\'s amendment leaves that amendment alone', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'amended by auth-hardening' })).code).toBe(0)
    await recapEffort(repo, 'second')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'amended by second' }, undefined, 'second')).code).toBe(0)
    approve(repo, 'auth-refresh')
    expect((await writePlan(repo, 'auth-refresh-plan-1')).code).toBe(0)      // auth-hardening's plan, on second's content
    const r = await repo.cli(['abandon', 'auth-refresh-plan-1'])
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain('reverted:')
    expect(String(findById(loadCanon(repo.root), 'auth-refresh')!.meta.summary)).toBe('amended by second')
  })

  // D168 review. The newest write of a content is the act it is: a live effort that wrote the
  // same bytes after an abandoned one owns them.
  it('a live effort\'s write of the same content an abandoned effort once wrote stays', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'K amendment' })).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)          // back to shipped
    await recapEffort(repo, 'redo')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'K amendment' }, undefined, 'redo')).code).toBe(0)
    const redo = repo.read('specs/auth-refresh.md')
    await recapEffort(repo, 'third')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'L amendment' }, undefined, 'third')).code).toBe(0)
    expect((await repo.cli(['abandon', 'third'])).code).toBe(0)
    expect(repo.read('specs/auth-refresh.md')).toBe(redo)
    expect((await repo.cli(['abandon', 'redo'])).code).toBe(0)                    // and redo's own abandon still works
  })

  it('abandoning an effort leaves a spec another effort wrote again after an abandon took it back', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'setup-card', SETUP_CARD)).code).toBe(0)
    approve(repo, 'setup-card')
    expect((await writePlan(repo, 'setup-card-plan-1', {
      parent: 'setup-card', steps: [{ id: 's1', title: 'card', criteria: ['ac-setup'] }],
    })).code).toBe(0)
    expect((await repo.cli(['abandon', 'setup-card-plan-1'])).code).toBe(0)       // setup-card unwound
    await recapEffort(repo, 'redo')
    expect((await writeSpec(repo, 'setup-card', SETUP_CARD, undefined, 'redo')).code).toBe(0)   // same manifest
    const redo = repo.read('specs/setup-card.md')
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain('reverted:')
    expect(repo.read('specs/setup-card.md')).toBe(redo)
  })

  it('an effort whose amendment a plan abandon already took back can still be abandoned', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    const shipped = repo.read('specs/auth-refresh.md')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'a1' })).code).toBe(0)
    approve(repo, 'auth-refresh')
    expect((await writePlan(repo, 'auth-refresh-plan-1')).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)     // a1 taken back
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain('reverted:')
    expect(repo.read('specs/auth-refresh.md')).toBe(shipped)
  })

  it('content an earlier abandon kept for good is canon of record — the walk stops at it', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    const ONE = { criteria: [{ id: 'ac-one', test: '@spec:slice-one' }] }
    const TWO = { criteria: [{ id: 'ac-two', test: '@spec:slice-two' }] }
    expect((await writeSpec(repo, 'slice-one', { supersedes: 'auth-refresh', ...ONE })).code).toBe(0)
    expect((await writeSpec(repo, 'slice-two', { supersedes: 'auth-refresh', ...TWO })).code).toBe(0)
    approve(repo, 'slice-two')
    await recapEffort(repo, 'ship')
    expect((await writePlan(repo, 'slice-two-plan-1', {
      parent: 'slice-two', steps: [{ id: 's1', title: 'two', criteria: ['ac-two'] }],
    }, PLAN_BODY, 'ship')).code).toBe(0)
    repo.flipStatus('slice-two-plan-1', 'done')
    stampLive(repo, 'slice-two')
    const r1 = await repo.cli(['abandon', 'auth-hardening'])
    expect(r1.stdout).toContain('kept: slice-one — not unwound · still standing on it: slice-two')
    const kept = repo.read('specs/slice-one.md')
    await recapEffort(repo, 'later')
    expect((await writeSpec(repo, 'slice-one', { summary: 'amended by later', ...ONE }, undefined, 'later')).code).toBe(0)
    const r = await repo.cli(['abandon', 'later'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reverted: slice-one (restore) — journal untouched')
    expect(repo.read('specs/slice-one.md')).toBe(kept)
  })

  it('a revise round over another effort\'s moving plan refuses still-standing, as without the round', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'round 1' })).code).toBe(0)
    approve(repo, 'auth-refresh')
    await recapEffort(repo, 'build')
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'build')).code).toBe(0)
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'round 2' })).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('still-standing')
    expect(String(findById(loadCanon(repo.root), 'auth-refresh')!.meta.summary)).toBe('round 2')   // nothing walked
  })

  it('a write whose prior content left the path refuses — never reads the amendment as a create', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'round 1' })).code).toBe(0)
    mkdirSync(join(repo.root, 'specs', 'auth'))
    repo.git('mv', 'specs/auth-refresh.md', 'specs/auth/auth-refresh.md')
    repo.git('commit', '-q', '-m', 'move the spec by hand', '-m', 'Witness-State: 1')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'round 2' })).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('pin-unresolvable')
    expect(String(findById(loadCanon(repo.root), 'auth-refresh')!.meta.summary)).toBe('round 2')
  })

  it('a blame config the repo cannot satisfy does not hide a write', async () => {
    const repo = await seededRepo()
    repo.git('config', 'blame.ignoreRevsFile', '.git-blame-ignore-revs')           // a common dotfile; absent here
    expect((await writeSpec(repo, 'setup-card', SETUP_CARD)).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reverted: setup-card (delete) — journal untouched')
  })

  it('a blank journal line does not stop an abandon', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'setup-card', SETUP_CARD)).code).toBe(0)
    appendFileSync(join(repo.root, '.witness/journal/auth-hardening.jsonl'), '\n')
    repo.git('add', '.witness/journal/auth-hardening.jsonl')
    repo.git('commit', '-q', '-m', 'a blank line', '-m', 'Witness-State: 1')
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reverted: setup-card (delete) — journal untouched')
  })

  it('a plan on content no journaled write made says it unwound nothing', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'setup-card', SETUP_CARD)).code).toBe(0)
    approve(repo, 'setup-card')
    repo.write('specs/setup-card.md', repo.read('specs/setup-card.md').replace(/^summary: .*$/m, 'summary: edited by hand'))
    repo.git('add', 'specs/setup-card.md')
    repo.git('commit', '-q', '-m', 'a hand edit', '-m', 'Witness-State: 1')
    expect((await writePlan(repo, 'setup-card-plan-1', {
      parent: 'setup-card', steps: [{ id: 's1', title: 'card', criteria: ['ac-setup'] }],
    })).code).toBe(0)
    const r = await repo.cli(['abandon', 'setup-card-plan-1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('note: setup-card — not unwound · no journaled write made the content setup-card-plan-1 derives from')
    expect(findById(loadCanon(repo.root), 'setup-card')).toBeDefined()
  })

  it('abandoning a plan takes back its effort\'s whole authorship of the spec, revisions included', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'setup-card', SETUP_CARD)).code).toBe(0)
    expect((await writeSpec(repo, 'setup-card', { summary: 'revised in round 2', ...SETUP_CARD })).code).toBe(0)
    approve(repo, 'setup-card')
    expect((await writePlan(repo, 'setup-card-plan-1', {
      parent: 'setup-card', steps: [{ id: 's1', title: 'card', criteria: ['ac-setup'] }],
    })).code).toBe(0)
    const r = await repo.cli(['abandon', 'setup-card-plan-1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reverted: setup-card (delete) — journal untouched')
    expect(specs(repo)).toBe('')
  })
})

// D189. The minors rows 168 and 188 deferred: a SHA-256 repository, writes on parallel branches,
// and a plan an earlier abandon already withdrew.
describe('abandon, the remaining edges (D189)', () => {
  it('a SHA-256 repository resolves a write the same way', async () => {
    const prior = process.env.GIT_DEFAULT_HASH
    process.env.GIT_DEFAULT_HASH = 'sha256'
    try {
      const repo = await seededRepo({ preexisting: ['auth-refresh'] })
      expect(repo.git('rev-parse', 'HEAD')).toHaveLength(64)
      const shipped = repo.read('specs/auth-refresh.md')
      expect((await writeSpec(repo, 'auth-refresh', { summary: 'amended' })).code).toBe(0)
      const r = await repo.cli(['abandon', 'auth-hardening'])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('reverted: auth-refresh (restore) — journal untouched')
      expect(repo.read('specs/auth-refresh.md')).toBe(shipped)
    } finally {
      if (prior === undefined) delete process.env.GIT_DEFAULT_HASH
      else process.env.GIT_DEFAULT_HASH = prior
    }
  })

  it('of two writes of the same content on parallel branches, the later one is the act', async () => {
    const { writeAct } = await import('../src/abandon.js')
    const { canonicalSha } = await import('../src/sha.js')
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    await recapEffort(repo, 'second')
    repo.git('switch', '-q', '-c', 'side')
    repo.git('switch', '-q', 'main')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'same bytes' })).code).toBe(0)      // auth-hardening, earlier
    repo.git('switch', '-q', 'side')
    await new Promise((done) => setTimeout(done, 1100))                                       // commit times are seconds
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'same bytes' }, undefined, 'second')).code).toBe(0)
    repo.git('switch', '-q', 'main')
    repo.git('merge', '-q', '--no-edit', '-m', 'merge side', '-m', 'Witness-State: 1', 'side')
    const doc = findById(loadCanon(repo.root), 'auth-refresh')!
    expect(writeAct(repo.root, 'auth-refresh', canonicalSha(doc.meta, doc.body))?.effort).toBe('second')
  })

  it('an effort\'s abandon leaves a plan an earlier abandon withdrew as it was', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'setup-card', SETUP_CARD_D189)).code).toBe(0)
    approve(repo, 'setup-card')
    expect((await writePlan(repo, 'setup-card-plan-1', {
      parent: 'setup-card', steps: [{ id: 's1', title: 'card', criteria: ['ac-setup'] }],
    })).code).toBe(0)
    expect((await repo.cli(['abandon', 'setup-card-plan-1'])).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(readStream(repo.root, 'setup-card-plan-1').filter((e) => e.t === 'status' && (e as unknown as StatusEntry).to === 'abandoned')).toHaveLength(1)
    expect(repo.git('show', '--name-only', '--format=', 'HEAD')).not.toContain('plans/setup-card-plan-1.md')
  })
})

const SETUP_CARD_D189 = { criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] }

// D190. Several efforts abandoned as one act: every hold that ties one effort's abandon to
// another's has this as its way out.
describe('abandon several efforts as one act (D190)', () => {
  it('two efforts that amended one spec go back together to what shipped', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    const shipped = repo.read('specs/auth-refresh.md')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'amended by auth-hardening' })).code).toBe(0)
    await recapEffort(repo, 'second')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'amended by second' }, undefined, 'second')).code).toBe(0)
    const alone = await repo.cli(['abandon', 'auth-hardening'])
    expect(alone.code).toBe(2)
    expect(alone.stderr).toContain('stacked-amendment')
    const r = await repo.cli(['abandon', 'auth-hardening', 'second'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reverted: auth-refresh (restore) — journal untouched')
    expect(repo.read('specs/auth-refresh.md')).toBe(shipped)
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('a spec another effort\'s moving plan stands on goes back with that effort', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'setup-card', { criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] })).code).toBe(0)
    approve(repo, 'setup-card')
    await recapEffort(repo, 'build')
    expect((await writePlan(repo, 'setup-card-plan-1', {
      parent: 'setup-card', steps: [{ id: 's1', title: 'card', criteria: ['ac-setup'] }],
    }, PLAN_BODY, 'build')).code).toBe(0)
    const alone = await repo.cli(['abandon', 'auth-hardening'])
    expect(alone.code).toBe(2)
    expect(alone.stderr).toContain('still-standing')
    const r = await repo.cli(['abandon', 'auth-hardening', 'build'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reverted: setup-card (delete) — journal untouched')
    expect(findById(loadCanon(repo.root), 'setup-card-plan-1')!.meta.status).toBe('abandoned')
    expect(loadCanon(repo.root).docs.filter((d) => d.meta.type === 'spec')).toHaveLength(0)
  })

  it('a listed effort\'s write under an unlisted effort\'s write refuses — never left in canon by the act', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    const shipped = repo.read('specs/auth-refresh.md')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'A amend' })).code).toBe(0)
    await recapEffort(repo, 'mid')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'mid amend' }, undefined, 'mid')).code).toBe(0)
    await recapEffort(repo, 'top')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'top amend' }, undefined, 'top')).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening', 'top'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('stacked-amendment')
    expect(r.stderr).toContain("auth-refresh — auth-hardening's write")
    expect(r.stderr).toContain('mid wrote on top of it')
    expect(readStream(repo.root, 'auth-hardening').at(-1)).not.toMatchObject({ decision: 'abandon-effort' })
    expect((await repo.cli(['abandon', 'auth-hardening', 'top', 'mid'])).code).toBe(0)
    expect(repo.read('specs/auth-refresh.md')).toBe(shipped)
  })

  it('a write under content that shipped has nothing left to take back — never refused for good', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'amended by A' })).code).toBe(0)
    await recapEffort(repo, 'x')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'amended by x' }, undefined, 'x')).code).toBe(0)
    approve(repo, 'auth-refresh')
    await recapEffort(repo, 'y')
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'y')).code).toBe(0)
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    expect((await repo.cli(['abandon', 'x'])).stdout).toContain('kept: auth-refresh')
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('kept: auth-refresh — not unwound · still standing on it: auth-refresh-plan-1')
    expect(String(findById(loadCanon(repo.root), 'auth-refresh')!.meta.summary)).toBe('amended by x')
  })

  it('a spec the act leaves standing keeps what it depends on — the act never deletes it from under', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'setup-card', { criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] })).code).toBe(0)
    await recapEffort(repo, 'mid')
    expect((await writeSpec(repo, 'auth-refresh', { depends: ['setup-card'] }, undefined, 'mid')).code).toBe(0)
    await recapEffort(repo, 'top')
    expect((await writeSpec(repo, 'auth-refresh', { depends: ['setup-card'], summary: 'top amend' }, undefined, 'top')).code).toBe(0)
    approve(repo, 'auth-refresh')
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'top')).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)   // top's amendment taken back
    const r = await repo.cli(['abandon', 'auth-hardening', 'top'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('waiting-dependents')
    expect(findById(loadCanon(repo.root), 'setup-card')).toBeDefined()
    expect((await repo.cli(['check'])).code).toBe(0)
  })

  it('a write over this one that an earlier act took back does not hold the act', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    const shipped = repo.read('specs/auth-refresh.md')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'L amend' })).code).toBe(0)
    await recapEffort(repo, 'u')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'u amend' }, undefined, 'u')).code).toBe(0)
    await recapEffort(repo, 'x')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'x amend' }, undefined, 'x')).code).toBe(0)
    expect((await repo.cli(['abandon', 'u', 'x'])).code).toBe(0)                 // back to L's amendment
    await recapEffort(repo, 'w')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'w amend' }, undefined, 'w')).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-hardening', 'w'])).code).toBe(0)
    expect(repo.read('specs/auth-refresh.md')).toBe(shipped)
  })

  it('a listed write a plan abandon already took back does not hold the act', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    const shipped = repo.read('specs/auth-refresh.md')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'L amend' })).code).toBe(0)
    approve(repo, 'auth-refresh')
    expect((await writePlan(repo, 'auth-refresh-plan-1')).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)    // L's amendment taken back
    await recapEffort(repo, 'u')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'u amend' }, undefined, 'u')).code).toBe(0)
    const u = repo.read('specs/auth-refresh.md')
    await recapEffort(repo, 'w')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'w amend' }, undefined, 'w')).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-hardening', 'w'])).code).toBe(0)
    expect(repo.read('specs/auth-refresh.md').replace(/^status: .*$/m, '')).toBe(u.replace(/^status: .*$/m, ''))
    expect(repo.read('specs/auth-refresh.md')).not.toBe(shipped)
  })

  it('a listed write under shipped content has nothing left to take back', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'L amend' })).code).toBe(0)
    await recapEffort(repo, 'u')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'u amend' }, undefined, 'u')).code).toBe(0)
    approve(repo, 'auth-refresh')
    await recapEffort(repo, 'v')
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'v')).code).toBe(0)
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    await recapEffort(repo, 'w')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'w amend' }, undefined, 'w')).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-hardening', 'w'])).code).toBe(0)
    expect(String(findById(loadCanon(repo.root), 'auth-refresh')!.meta.summary)).toBe('u amend')
  })

  it('an older round of a listed effort under another effort\'s write refuses, even when its newer round is on top', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'L1' })).code).toBe(0)
    await recapEffort(repo, 'u')
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'u amend' }, undefined, 'u')).code).toBe(0)
    expect((await writeSpec(repo, 'auth-refresh', { summary: 'L2' })).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('stacked-amendment')
    expect(r.stderr).toContain('u wrote on top of it')
    expect(String(findById(loadCanon(repo.root), 'auth-refresh')!.meta.summary)).toBe('L2')
  })

  it('a plan the act abandons may depend on a spec the act deletes', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'token-store', { criteria: [{ id: 'ac-store', test: '@spec:token-store' }] })).code).toBe(0)
    expect((await writeSpec(repo, 'auth-refresh')).code).toBe(0)
    approve(repo, 'auth-refresh')
    expect((await writePlan(repo, 'auth-refresh-plan-1', { depends: ['token-store'] })).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reverted: token-store (delete)')
  })

  it('an effort already abandoned is said so and the rest go', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'setup-card', { criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] })).code).toBe(0)
    await recapEffort(repo, 'other')
    expect((await repo.cli(['abandon', 'auth-hardening'])).code).toBe(0)
    const r = await repo.cli(['abandon', 'auth-hardening', 'other'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('abandon: auth-hardening already abandoned')
    expect(r.stdout).toContain('abandoned: effort other — 0 artifacts walked')
  })

  it('a plan is abandoned alone, and an unknown target among efforts is named', async () => {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'setup-card', { criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] })).code).toBe(0)
    approve(repo, 'setup-card')
    expect((await writePlan(repo, 'setup-card-plan-1', {
      parent: 'setup-card', steps: [{ id: 's1', title: 'card', criteria: ['ac-setup'] }],
    })).code).toBe(0)
    for (const args of [['setup-card-plan-1', 'auth-hardening'], ['auth-hardening', 'setup-card-plan-1']]) {
      const two = await repo.cli(['abandon', ...args])
      expect(two.code).toBe(2)
      expect(two.stderr).toContain('one-plan')
    }
    const unknown = await repo.cli(['abandon', 'auth-hardening', 'no-such-effort'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('no-such-effort')
    expect(findById(loadCanon(repo.root), 'setup-card')).toBeDefined()           // nothing walked
  })
})
