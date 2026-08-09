import { describe, expect, it } from 'vitest'
import { appendEntry, readStream } from '../src/journal.js'
import type { DecisionEntry } from '../src/rounds.js'
import { approve, seededRepo, writePlan, writeSpec } from './helpers.js'

// No synthetic gate anywhere in this file, deliberately: the merged refusal only has
// something to merge when the gate can compute a `currentSha`, and the real plan gate can.
// Registering a stub named `plan` here would silently disable half of what is asserted.
const decisions = (repo: { root: string }, id: string) =>
  readStream(repo.root, id).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]


// Row 109/111. A plan reached the ship bound, the final round raised a blocking finding,
// the operator fixed it — and `--approve --override` then refused `stale-verdict` for the
// fix it had just asked for, with `--revise --upstream` (a whole re-cycle) as the only
// proportionate-looking exit. Witnessed on know-your-customer-mvp, 2026-08-08.
describe('the repair grant at the bound', () => {
  // a real plan doc, so the real plan gate's currentSha is computable and the fake
  // journaled sha reads as genuinely moved content
  async function boundPlan() {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    for (const round of [1, 2, 3]) {
      appendEntry(repo.root, 'auth-refresh-plan-1', {
        v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh-plan-1', round,
        run_id: `r-${round}`, reviewed_sha: `sha-${round}`, prompts_sha: 'p', witness: '0',
        model: 'm', calibration: 'none', checks: [],
        verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [] }], outcome: 'stopped',
      })
    }
    return repo
  }
  const plan = 'auth-refresh-plan-1'

  it('reports the bound AND the staleness in one refusal, not one per attempt', async () => {
    const repo = await boundPlan()
    const r = await repo.cli(['decide', 'plan', plan, '--approve'])
    expect(r.code).toBe(2)
    const text = r.stdout + r.stderr
    expect(text).toContain('refused[2]')
    expect(text).toContain('override-required')
    expect(text).toContain('stale-verdict')
  })

  it('names --revise --repair among the exits while the grant is unspent', async () => {
    const repo = await boundPlan()
    const r = await repo.cli(['decide', 'plan', plan, '--approve', '--override'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('--revise --repair')
  })

  it('grants exactly one extra round, journaled, and refuses a second in the same window', async () => {
    const repo = await boundPlan()
    const granted = await repo.cli(['decide', 'plan', plan, '--revise', '--repair', '--note', 'fixing the finding'])
    expect(granted.code).toBe(0)
    expect(decisions(repo, plan).at(-1)).toMatchObject({ decision: 'revise', repair: true })
    expect(granted.stdout).toContain('repair')

    // below the bound now — a second grant would buy nothing and says so
    const early = await repo.cli(['decide', 'plan', plan, '--revise', '--repair'])
    expect(early.code).toBe(2)
    expect(early.stdout + early.stderr).toContain('repair-not-at-bound')

    // the granted round is spent → back at the bound, and the grant does not refresh
    appendEntry(repo.root, plan, {
      v: 1, t: 'gate-run', gate: 'plan', artifact: plan, round: 4, run_id: 'r-4',
      reviewed_sha: 'sha-4', prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none',
      checks: [], verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [] }], outcome: 'stopped',
    })
    const spent = await repo.cli(['decide', 'plan', plan, '--revise', '--repair'])
    expect(spent.code).toBe(2)
    expect(spent.stdout + spent.stderr).toContain('repair-spent')
  })

  it('--repair is a revise decision — never an approve or a stop', async () => {
    const repo = await boundPlan()
    const r = await repo.cli(['decide', 'plan', plan, '--approve', '--override', '--repair'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('repair-scope')
  })
})
