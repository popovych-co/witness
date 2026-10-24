import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import {
  approve, autonomyOn, draftPath, draftSave, fakeScenario, fixtureEnv, gateEnv, nextLine, putVerdict, seededRepo, witnessDesign,
  writeDesign, writeSpec, type TestRepo,
} from './helpers.js'

// §4.8, rows 52 and 200. A design answer that changes what the screen does lands in the recap as a
// numbered decision; Part B's re-arm carries it into the spec, and the look comes back pending on
// the amended spec with its draft — direction, answers and page — intact.
const D1 = { id: 'd1', text: 'Groups collapse and reorder' }
const LOOK = { direction: 'grouped list', answers: ['groups first'], page: '<!doctype html><p>x</p>' }
const LOOK_LINE = 'draft: direction chosen · 1 answer settled · page saved · resume with witness draft design-auth-refresh'
const CLEAN = { coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'auth-refresh > ## Behavior', note: 'r' }], findings: [] }
const env = fixtureEnv()

// Steps 1–4: a look in progress, and a behavior answer amended into the recap.
async function amendedMidLook(autonomy = false): Promise<TestRepo> {
  const repo = await seededRepo()
  if (autonomy) autonomyOn(repo)
  await writeSpec(repo, 'auth-refresh', { ui: true })
  approve(repo, 'auth-refresh')
  expect((await draftSave(repo, 'design-auth-refresh', LOOK)).code).toBe(0)
  expect((await draftSave(repo, 'amend-auth-hardening', { decisions: [D1] })).code).toBe(0)
  const out = await nextLine(repo, { env })
  expect(out).toContain('next: witness recap --amend --file <recap.json>')
  expect(out).toContain('target: auth-hardening')
  expect((await repo.cli(['recap', '--amend', '--file', repo.writeRecap({ decisions: [D1] })])).code).toBe(0)
  expect(existsSync(draftPath(repo, 'amend-auth-hardening'))).toBe(false)
  expect(existsSync(draftPath(repo, 'design-auth-refresh'))).toBe(true)
  return repo
}

describe('a design answer that changes behavior (§4.8)', () => {
  it('a design answer that changes behavior lands in the recap, re-opens decompose, and keeps the look\'s draft', async () => {
    const repo = await amendedMidLook()
    expect(await nextLine(repo, { env })).toContain('next: witness gate decompose --effort auth-hardening')

    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
    const g = await repo.cli(['gate', 'decompose', '--effort', 'auth-hardening'], { env: gateEnv(scenario) })
    expect(g.code).toBe(1)
    const run = readStream(repo.root, 'auth-hardening').filter((e) => e.t === 'gate-run').at(-1) as { checks?: Array<{ name: string; detail?: string }> }
    expect(run.checks?.find((c) => c.name === 'decision-coverage')?.detail).toBe('uncarried decisions: d1')
    expect((await repo.cli(['decide', 'decompose', 'auth-hardening', '--revise', '--note', 'carry d1'])).code).toBe(0)

    const body = '## Motivation\nTokens leak.\n\n## Behavior\nRotate before expiry. Groups collapse and reorder.\n'
    expect((await writeSpec(repo, 'auth-refresh', { ui: true, carries: ['d1'] }, body)).code).toBe(0)
    await repo.cli(['gate', 'decompose', '--effort', 'auth-hardening'], { env: gateEnv(scenario) })
    expect((await repo.cli(['decide', 'decompose', 'auth-hardening', '--approve'])).code).toBe(0)

    const out = await nextLine(repo, { env })
    expect(out).toContain('next: witness design auth-refresh --file <html>')
    expect(out).toContain(LOOK_LINE)
  })

  it('approving the look ends its design draft', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    expect((await draftSave(repo, 'design-auth-refresh', LOOK)).code).toBe(0)
    expect((await writeDesign(repo, 'auth-refresh')).code).toBe(0)
    expect((await witnessDesign(repo, 'auth-refresh')).code).toBe(0)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    expect((await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })).code).toBe(1)   // the look is the human's
    expect(existsSync(draftPath(repo, 'design-auth-refresh'))).toBe(true)
    expect((await repo.cli(['decide', 'design', 'auth-refresh', '--approve'])).code).toBe(0)
    expect(existsSync(draftPath(repo, 'design-auth-refresh'))).toBe(false)
  })

  // Final review I2 (§7). A behavior note at the approval stop starts an amendment while the look's
  // decision is still pending: the drafted amendment is resumed first, so a relayed successor is not
  // shown the approval with the amendment it was in the middle of nowhere on screen.
  it('a behavior note at the approval stop resumes the amendment before the pending look', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    expect((await draftSave(repo, 'design-auth-refresh', LOOK)).code).toBe(0)
    expect((await writeDesign(repo, 'auth-refresh')).code).toBe(0)
    expect((await witnessDesign(repo, 'auth-refresh')).code).toBe(0)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    expect((await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })).code).toBe(1)
    expect(await nextLine(repo, { env })).toContain('next: witness decide design auth-refresh --show')
    expect((await draftSave(repo, 'amend-auth-hardening', { decisions: [D1] })).code).toBe(0)
    const out = await nextLine(repo, { env })
    expect(out).toContain('next: witness recap --amend --file <recap.json>')
    expect(out).toContain('target: auth-hardening')
    expect(out).toContain('draft: 1 item settled · resume with witness draft amend-auth-hardening')
    expect(out).not.toContain('witness decide design')
  })

  it('under autonomy the chat is not sent back into the look while decompose re-slices it', async () => {
    const repo = await amendedMidLook(true)
    const out = await nextLine(repo, { env })
    expect(out).not.toContain('stage: design')
    expect(out).not.toContain('witness design auth-refresh')
  })
})
