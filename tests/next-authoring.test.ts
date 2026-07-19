import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import { fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec } from './helpers.js'

const REOPEN = { artifact: 'auth-refresh', gate: 'design', round: 1 }

// A decompose gate that PASSED at a sha, so nothing is pending and nothing is at bound.
async function approvedEffort() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  appendEntry(repo.root, repo.effort, {
    v: 1, t: 'gate-run', gate: 'decompose', artifact: repo.effort, round: 1,
    run_id: 'r1', reviewed_sha: 'stale-sha', prompts_sha: 'p', specflow: '0',
    model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'passed',
  })
  return repo
}

// A real decompose gate-run against a fake reviewer — the run's reviewed_sha is the
// effort's ACTUAL sha, which is what the changed-nothing short-circuit keys on.
async function gatedEffort() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
  // a feature decompose carries a standing stop, so EXIT.FINDINGS (1) is the healthy
  // outcome here — only a refusal (2) or a block (3) means the fixture failed to gate
  const g = await repo.cli(['gate', 'decompose', '--effort', repo.effort], { env: gateEnv(scenario) })
  if (g.code > 1) throw new Error(`gate failed: ${g.stdout}\n${g.stderr}`)
  return repo
}

describe('next — doc-gate lapse', () => {
  it('routes back to the decompose gate when the effort sha no longer matches the verdict', async () => {
    const repo = await approvedEffort()
    const r = await repo.cli(['next'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`gate decompose --effort ${repo.effort}`)
  })
})

describe('next — authoring owed, never the gate', () => {
  it('after a decompose revise with no edit, routes to write, not the gate', async () => {
    const repo = await gatedEffort()
    appendEntry(repo.root, repo.effort, {
      v: 1, t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'revise',
    })
    const r = await repo.cli(['next'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('specflow write')
    expect(r.stdout).not.toContain('gate decompose')
  })

  it('an undischarged reopen routes to write, not the gate', async () => {
    const repo = await gatedEffort()
    appendEntry(repo.root, repo.effort, {
      v: 1, t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1,
      decision: 'revise', caused_by: REOPEN, note: 'cancel-window is wrong at the spec level',
    })
    const r = await repo.cli(['next'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('specflow write')
  })

  it('once content moves, routing returns to the gate', async () => {
    const repo = await gatedEffort()
    appendEntry(repo.root, repo.effort, {
      v: 1, t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'revise',
    })
    await writeSpec(repo, 'auth-refresh', { summary: 'Rotates the refresh token before it expires' })
    const r = await repo.cli(['next'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`gate decompose --effort ${repo.effort}`)
  })
})
