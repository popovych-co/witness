import { describe, expect, it } from 'vitest'
import {
  approve, fakeScenario, gateEnv, putVerdict, seededRepo, witnessDesign, writeDesign, writeSpec, DESIGN_HTML,
} from './helpers.js'
import { readStream } from '../src/journal.js'

const CLEAN = {
  coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'auth-refresh > ## Behavior', note: 'r' }],
  findings: [],
}

async function uiRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh', { ui: true })
  approve(repo, 'auth-refresh')
  await writeDesign(repo, 'auth-refresh')
  return repo
}

describe('design gate sight precondition', () => {
  it('refuses before invoking any reviewer when the artifact has not been shown', async () => {
    const repo = await uiRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)

    const res = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('design-unseen')
    expect(res.stderr).toContain('--open')
    // the refusal is free: no gate-run entry, so no round was spent
    expect(readStream(repo.root, 'auth-refresh').some((e) => e.t === 'gate-run')).toBe(false)
  })

  it('runs the gate once the artifact has been shown', async () => {
    const repo = await uiRepo()
    await witnessDesign(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)

    const res = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })

    expect(res.code).toBe(1)                       // EXIT.FINDINGS — design always stops
    expect(res.stdout).toContain('standing-stop')
  })

  it('re-refuses after the artifact is re-authored — sight does not survive new bytes', async () => {
    const repo = await uiRepo()
    await witnessDesign(repo, 'auth-refresh')
    await writeDesign(repo, 'auth-refresh', DESIGN_HTML.replace('save-bar', 'save-bar-v2'))
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)

    const res = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('design-unseen')
  })

  it('does not demand sight when there is no artifact — the artifact check reports that', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)

    const res = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })

    expect(res.code).toBe(1)                       // stopped with a verdict, not refused
    expect(res.stdout).toContain('missing')
  })
})
