import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { DESIGN_HTML, approve, seededRepo, writeDesign, writeSpec } from './helpers.js'

describe('specflow design', () => {
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
})
