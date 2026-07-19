import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import { fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec, type TestRepo } from './helpers.js'

// A real decompose gate-run against a fake reviewer: reviewed_sha is the effort's ACTUAL
// sha, which is what a staleness check compares against. A feature decompose carries a
// standing stop, so EXIT.FINDINGS (1) is the healthy outcome — only 2/3 means it failed.
async function gatedEffort(): Promise<TestRepo> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
  const g = await repo.cli(['gate', 'decompose', '--effort', repo.effort], { env: gateEnv(scenario) })
  if (g.code > 1) throw new Error(`gate failed: ${g.stdout}\n${g.stderr}`)
  return repo
}

const REOPEN = { artifact: 'account-deletion', gate: 'design', round: 1 }

// gate-run(stopped) → approve → a revise injected by ANOTHER stage's --upstream.
// This is benoticed entries 51/52/53 verbatim: --show paired run 51's verdict with
// entry 53's note and presented 15 settled findings as current.
async function reopenedAfterApprove() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const s = repo.effort
  appendEntry(repo.root, s, {
    v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round: 1, run_id: 'r1',
    reviewed_sha: 'ba2f352', prompts_sha: 'p', specflow: '0', model: 'm', calibration: 'none',
    checks: [], outcome: 'stopped',
    verdicts: [{
      reviewer: 'slicing-critic',
      coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }],
      findings: [{ blocking: true, anchor: 'auth-refresh > ## Behavior', claim: 'carries no ui: true' }],
    }],
  })
  appendEntry(repo.root, s, {
    v: 1, t: 'human-decision', gate: 'decompose', artifact: s, round: 1, decision: 'approve',
  })
  appendEntry(repo.root, s, {
    v: 1, t: 'human-decision', gate: 'decompose', artifact: s, round: 1, decision: 'revise',
    caused_by: REOPEN, note: 'cancel-window diverges at the spec level',
  })
  return repo
}

describe('decide --show', () => {
  it('never presents a superseded verdict as current', async () => {
    const repo = await reopenedAfterApprove()
    const r = await repo.cli(['decide', 'decompose', repo.effort, '--show'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('reopened')
    expect(r.stdout).toContain('cancel-window diverges at the spec level')
    expect(r.stdout).not.toContain('carries no ui: true')       // the settled finding
    expect(r.stdout).toContain(`gate decompose ${repo.effort}`)
  })

  it('names the reopen source so the author knows which stage asked', async () => {
    const repo = await reopenedAfterApprove()
    const r = await repo.cli(['decide', 'decompose', repo.effort, '--show'])
    expect(r.stdout).toContain('design')
    expect(r.stdout).toContain('account-deletion')
  })

  it('renders full findings and the normal exits while a decision is pending', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const s = repo.effort
    appendEntry(repo.root, s, {
      v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round: 1, run_id: 'r1',
      reviewed_sha: 'sha-1', prompts_sha: 'p', specflow: '0', model: 'm', calibration: 'none',
      checks: [], outcome: 'stopped',
      verdicts: [{
        reviewer: 'slicing-critic',
        coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }],
        findings: [{ blocking: true, anchor: 'auth-refresh > ## Behavior', claim: 'expiry unbounded' }],
      }],
    })
    const r = await repo.cli(['decide', 'decompose', s, '--show'])
    expect(r.stdout).toContain('expiry unbounded')
    expect(r.stdout).toContain('--approve')
    expect(r.stdout).toContain('--stop')
  })

  it('renders full findings after a revise — this is the author revise input', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const s = repo.effort
    appendEntry(repo.root, s, {
      v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round: 1, run_id: 'r1',
      reviewed_sha: 'sha-1', prompts_sha: 'p', specflow: '0', model: 'm', calibration: 'none',
      checks: [], outcome: 'stopped',
      verdicts: [{
        reviewer: 'slicing-critic',
        coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }],
        findings: [{ blocking: false, anchor: 'auth-refresh > ## Behavior', claim: 'hairline missing' }],
      }],
    })
    appendEntry(repo.root, s, {
      v: 1, t: 'human-decision', gate: 'decompose', artifact: s, round: 1,
      decision: 'revise', note: 'fix the hairline',
    })
    const r = await repo.cli(['decide', 'decompose', s, '--show'])
    expect(r.stdout).toContain('hairline missing')
    expect(r.stdout).toContain('fix the hairline')
  })

  it('emits the bound endgame exits, not the normal triple, at the bound', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const s = repo.effort
    for (const round of [1, 2, 3]) {
      appendEntry(repo.root, s, {
        v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round, run_id: `r${round}`,
        reviewed_sha: `sha-${round}`, prompts_sha: 'p', specflow: '0', model: 'm',
        calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
      })
    }
    const r = await repo.cli(['decide', 'decompose', s, '--show'])
    expect(r.stdout).toContain('--override')
    expect(r.stdout).toContain('--upstream')
  })
})

describe('decide --approve staleness', () => {
  it('refuses to stamp when the artifact moved under the pending run', async () => {
    const repo = await gatedEffort()
    // amend the canon AFTER the verdict — the run now describes bytes that are gone
    await writeSpec(repo, 'auth-refresh', { summary: 'Rotates the refresh token before it expires' })
    const r = await repo.cli(['decide', 'decompose', repo.effort, '--approve'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('stale-verdict')
    expect(r.stdout + r.stderr).toContain('specflow gate decompose')
  })

  it('still approves when the artifact has not moved', async () => {
    const repo = await gatedEffort()
    const r = await repo.cli(['decide', 'decompose', repo.effort, '--approve'])
    expect(r.code).toBe(0)
  })

  it('revise and stop are unaffected — a record may lag content, a stamp may not', async () => {
    const repo = await gatedEffort()
    await writeSpec(repo, 'auth-refresh', { summary: 'Rotates the refresh token before it expires' })
    const r = await repo.cli(['decide', 'decompose', repo.effort, '--revise', '--note', 'still wrong'])
    expect(r.code).toBe(0)
  })

  it('at the bound with moved content, names the exits that still work', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const s = repo.effort
    for (const round of [1, 2, 3]) {
      appendEntry(repo.root, s, {
        v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round, run_id: `r${round}`,
        reviewed_sha: `sha-${round}`, prompts_sha: 'p', specflow: '0', model: 'm',
        calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
      })
    }
    const r = await repo.cli(['decide', 'decompose', s, '--approve', '--override'])
    expect(r.code).toBe(2)
    const all = r.stdout + r.stderr
    expect(all).toContain('stale-verdict')
    expect(all).toContain('--upstream')
    expect(all).toContain('--stop')
    expect(all).not.toContain('run: specflow gate')   // the gate will not re-run at the bound
  })
})
