import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import { loadCanon } from '../src/scan.js'
import { effortReviewedSha } from '../src/reviewed.js'
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec, type TestRepo } from './helpers.js'

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
    reviewed_sha: 'ba2f352', prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none',
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
    // The CURRENT sha, not a placeholder: "the normal exits" is a claim about unchanged
    // content, and a fake sha makes the state stale, where the only honest exit is a
    // re-gate. This passed on a placeholder because renderGateRun printed a second,
    // hardcoded help line that ignored the journal — the row 110 defect, asserted.
    const current = effortReviewedSha(repo.root, loadCanon(repo.root), s).sha
    appendEntry(repo.root, s, {
      v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round: 1, run_id: 'r1',
      reviewed_sha: current, prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none',
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
      reviewed_sha: 'sha-1', prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none',
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

  it('renders journaled pins with the actionable verdict', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    appendEntry(repo.root, 'auth-refresh-plan-1', {
      v: 1, t: 'gate-run', gate: 'implement', artifact: 'auth-refresh-plan-1', round: 1,
      run_id: 'r1', reviewed_sha: 'sha-1', prompts_sha: 'p', witness: '0', model: 'm',
      calibration: 'none', checks: [], outcome: 'stopped',
      verdicts: [{
        reviewer: 'code-reviewer',
        coverage: [{ anchor: 'src/a.ts', note: 'read' }],
        findings: [{ blocking: false, anchor: 'src/a.ts', claim: 'hairline missing' }],
      }],
    })
    await repo.cli(['decide', 'implement', 'auth-refresh-plan-1', '--revise', '--note', 'fix',
      '--pin', 'render the service in full'])
    const r = await repo.cli(['decide', 'implement', 'auth-refresh-plan-1', '--show'])
    expect(r.stdout).toContain('pins[1]{ordinal,text}:')
    expect(r.stdout).toContain('render the service in full')
  })

  it('emits the bound endgame exits, not the normal triple, at the bound', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const s = repo.effort
    // The LAST round must have judged the content as it stands: `--override` is an
    // approve, and approving bytes no battery read is the one thing D75 forbids. With a
    // fake sha here the honest answer is the endgame MINUS approve — pinned separately
    // by the moved-content test below.
    const current = effortReviewedSha(repo.root, loadCanon(repo.root), s).sha
    for (const round of [1, 2, 3]) {
      appendEntry(repo.root, s, {
        v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round, run_id: `r${round}`,
        reviewed_sha: round === 3 ? current : `sha-${round}`, prompts_sha: 'p', witness: '0',
        model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
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
    expect(r.stdout + r.stderr).toContain('witness gate decompose')
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
        reviewed_sha: `sha-${round}`, prompts_sha: 'p', witness: '0', model: 'm',
        calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
      })
    }
    const r = await repo.cli(['decide', 'decompose', s, '--approve', '--override'])
    expect(r.code).toBe(2)
    const all = r.stdout + r.stderr
    expect(all).toContain('stale-verdict')
    expect(all).toContain('--upstream')
    expect(all).toContain('--stop')
    expect(all).not.toContain('run: witness gate')   // the gate will not re-run at the bound
  })
})

// D94: --show read state by POSITION (first disposition) and asserted staleness rather
// than computing it, so it reported a revised gate as revised after the human had
// approved, and advertised a re-gate in the one state where the gate declines.
describe('--show tells the truth about a revised or reopened gate', () => {
  async function stoppedOnCurrentContent() {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const s = repo.effort
    const sha = effortReviewedSha(repo.root, loadCanon(repo.root), s).sha
    appendEntry(repo.root, s, {
      v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round: 1, run_id: 'r1',
      reviewed_sha: sha, prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none',
      checks: [], outcome: 'stopped',
      verdicts: [{
        reviewer: 'slicing-critic',
        coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [],
      }],
    })
    return { repo, effort: s }
  }

  it('reports the last disposition, not the first', async () => {
    const { repo, effort } = await stoppedOnCurrentContent()
    appendEntry(repo.root, effort, { v: 1, t: 'human-decision', gate: 'decompose', artifact: effort, round: 1, decision: 'revise', note: 'tighten scope' })
    appendEntry(repo.root, effort, { v: 1, t: 'human-decision', gate: 'decompose', artifact: effort, round: 1, decision: 'approve' })

    const shown = await repo.cli(['decide', 'decompose', effort, '--show'])
    expect(shown.stdout).toContain('state: settled — approve')
    expect(shown.stdout).not.toContain('decision: revise')
  })

  it('points a settled gate at the verb that knows what comes next', async () => {
    const { repo, effort } = await stoppedOnCurrentContent()
    appendEntry(repo.root, effort, { v: 1, t: 'human-decision', gate: 'decompose', artifact: effort, round: 1, decision: 'approve' })
    const shown = await repo.cli(['decide', 'decompose', effort, '--show'])
    expect(shown.stdout).toContain('help: witness next')
  })

  it('offers decisions, not a re-gate, when a reopen sits on unchanged content', async () => {
    const { repo, effort } = await stoppedOnCurrentContent()
    appendEntry(repo.root, effort, {
      v: 1, t: 'human-decision', gate: 'decompose', artifact: effort, round: 1, decision: 'revise',
      caused_by: { artifact: 'auth-refresh', gate: 'design', round: 1 },
    })
    const shown = await repo.cli(['decide', 'decompose', effort, '--show'])
    expect(shown.stdout).toContain('--approve')
    expect(shown.stdout).toContain('--stop')
  })
})

// D67 + D94 together: at the bound the gate will not run again, so a moved sha must not
// route to `witness gate` — it only removes approve from the endgame set.
it('at the bound with moved content, --show names the endgame minus approve', async () => {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const s = repo.effort
  for (const round of [1, 2, 3]) {
    appendEntry(repo.root, s, {
      v: 1, t: 'gate-run', gate: 'decompose', artifact: s, round, run_id: `r-${round}`,
      reviewed_sha: `sha-${round}`, prompts_sha: 'p', witness: '0', model: 'm',
      calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
    })
  }
  const r = await repo.cli(['decide', 'decompose', s, '--show'])
  expect(r.stdout).toContain('--stop')
  expect(r.stdout).toContain('--upstream')
  expect(r.stdout).not.toContain('witness gate decompose')
})
