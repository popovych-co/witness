import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { designPending } from '../src/design.js'
import { readStream } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { canonicalSha } from '../src/sha.js'
import { DESIGN_HTML, approve, draftPath, draftSave, nextLine, seededRepo, witnessDesign, writeDesign, writeSpec } from './helpers.js'

describe('witness design', () => {
  it('persists a self-contained artifact for a ui feature spec', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    const res = await writeDesign(repo, 'booking-form')
    expect(res.code).toBe(0)
    expect(existsSync(join(repo.root, 'designs/booking-form.html'))).toBe(true)
    const entries = readStream(repo.root, 'booking-form')
    expect(entries.some((e) => e.t === 'design-write')).toBe(true)
  })

  it('refuses an artifact with external refs (structured, exit 2)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    const res = await writeDesign(repo, 'booking-form',
      '<!doctype html><body><section id="a"></section><section id="b"></section><script src="https://x/y.js"></script></body>')
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('external-ref')
    expect(existsSync(join(repo.root, 'designs/booking-form.html'))).toBe(false)
  })

  it('refuses a design for a non-ui spec', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')          // no ui flag
    approve(repo, 'auth-refresh')
    const res = await writeDesign(repo, 'auth-refresh')
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('not-ui')
  })

  it('--reconfirm re-stamps against the current spec sha without a session', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    await writeDesign(repo, 'booking-form')
    // simulate an approved stamp by hand (Task 7 does this via the gate): stamp against OLD sha,
    // then amend the spec so the stamp goes stale, then reconfirm.
    // For this unit test we drive reconfirm after a real gate in gate-design.test.ts;
    // here assert the guard: reconfirm with no prior stamp refuses.
    const res = await repo.cli(['design', 'booking-form', '--reconfirm'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('no-stamp')
  })

  it('a satisfy leaves an approved look approved (A10)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true, needs: [{ id: 'sbx', manual: 'Stripe sandbox account created', satisfied: false }] })
    approve(repo, 'auth-refresh')
    const doc = findById(loadCanon(repo.root), 'auth-refresh')!
    repo.setMeta('auth-refresh', { design: { sha: 'a'.repeat(64), spec: canonicalSha(doc.meta, doc.body) } })   // the approved look's stamp
    const spec = () => findById(loadCanon(repo.root), 'auth-refresh')!
    expect(designPending(repo.root, spec())).toBe(false)
    expect((await repo.cli(['satisfy', 'auth-refresh', '--need', 'sbx'])).code).toBe(0)
    expect(designPending(repo.root, spec())).toBe(false)
  })
})

describe('the design session has a draft (row 199)', () => {
  it("next names a look's design draft at every step", async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    expect((await draftSave(repo, 'design-auth-refresh', { direction: 'grouped list', answers: ['groups first'], page: '<!doctype html><p>x</p>' })).code).toBe(0)
    const D = 'draft: direction chosen · 1 answer settled · page saved · resume with witness draft design-auth-refresh'
    const file = await nextLine(repo)
    expect(file).toContain('next: witness design auth-refresh --file <html>')
    expect(file).toContain(D)
    expect((await writeDesign(repo, 'auth-refresh')).code).toBe(0)
    const open = await nextLine(repo)
    expect(open).toContain('next: witness design auth-refresh --open')
    expect(open).toContain(D)
    expect((await witnessDesign(repo, 'auth-refresh')).code).toBe(0)
    const gate = await nextLine(repo)
    expect(gate).toContain('next: witness gate design auth-refresh')
    expect(gate).toContain(D)
  })

  it('registering the look keeps its design draft', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    expect((await draftSave(repo, 'design-auth-refresh', { direction: 'grouped list', answers: ['groups first'] })).code).toBe(0)
    expect((await writeDesign(repo, 'auth-refresh')).code).toBe(0)
    expect(existsSync(draftPath(repo, 'design-auth-refresh'))).toBe(true)   // it ends when the look is stamped
  })

  it('reconfirming a look ends its design draft', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    await writeDesign(repo, 'booking-form')
    repo.setMeta('booking-form', { design: { sha: 'a'.repeat(64), spec: 'b'.repeat(64) } })   // a stale stamp, as an amended spec leaves it
    expect((await draftSave(repo, 'design-booking-form', { direction: 'grouped list' })).code).toBe(0)
    expect((await repo.cli(['design', 'booking-form', '--reconfirm'])).code).toBe(0)
    expect(existsSync(draftPath(repo, 'design-booking-form'))).toBe(false)
  })
})
