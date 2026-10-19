import { existsSync } from 'node:fs'
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
