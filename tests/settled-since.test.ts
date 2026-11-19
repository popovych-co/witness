import { describe, expect, it } from 'vitest'
import '../src/gates/index.js'
import { appendEntry, readStream } from '../src/journal.js'
import { applyDecision, type DecisionAct } from '../src/verbs/decide.js'
import { settledToken, type DecisionEntry } from '../src/rounds.js'
import { gateSpec } from '../src/gate.js'
import { loadCanon } from '../src/scan.js'
import { loadConfig } from '../src/config.js'
import { fakeCtx, plannedRepo } from './helpers.js'

// Row 240 (design §4.1.1, R2). A settler's act carries a token of every decision of its gate after
// the run it judged, taken from its own read before any model call. The door compares it first and
// again under the state lock, so a loser whose read predates the winner refuses `settled-since` —
// P3's seven lost races and P4's cap park read before a human's repair (A7), inverted.

const PLAN = 'auth-refresh-plan-1'
const ARB = { selected: 'arbiter' as const, reason: 'probe', arbiter: { model: 'm', prompts_sha: 'p' } }
type A = Omit<DecisionAct, 'gate' | 'target'>

async function stopped(rounds: number) {
  const repo = await plannedRepo()
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error('cfg')
  const now = gateSpec('plan')!.currentSha!(repo.root, loadCanon(repo.root), cfg.value, PLAN)!
  for (let round = 1; round <= rounds; round++) {
    appendEntry(repo.root, PLAN, {
      v: 1, t: 'gate-run', gate: 'plan', artifact: PLAN, round, run_id: `r-${round}`, reviewed_sha: now,
      prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
      verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: `${PLAN} > ## Step: s1`, claim: 'x' }] }],
    })
  }
  return repo
}

const decisions = (root: string) =>
  (readStream(root, PLAN).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[])
    .filter((d) => d.gate === 'plan')
    .map((d) => `r${d.round} ${d.decision}${d.repair ? ' repair' : ''} · ${d.selected ?? 'human'}`)

async function race(rounds: number, winner: A, loser: A, withToken = true) {
  const repo = await stopped(rounds)
  const runId = `r-${rounds}`
  const errs: string[] = []
  const ctx = fakeCtx(repo.root, { err: (l) => errs.push(l) })
  const token = settledToken(readStream(repo.root, PLAN), 'plan', runId)       // the loser's read, before the winner
  const w = await applyDecision(ctx, { gate: 'plan', target: PLAN, runId, ...winner } as DecisionAct)
  const winnerOnly = decisions(repo.root)
  const l = await applyDecision(ctx, { gate: 'plan', target: PLAN, runId, ...(withToken ? { token } : {}), ...loser } as DecisionAct)
  const rules = errs.filter((x) => /^\s+[^,]+,[a-z-]+,/.test(x)).map((x) => x.trim().split(',')[1])
  return { w, l, rules, winnerOnly, after: decisions(repo.root) }
}

const SHAPES: Array<[string, number, A, A]> = [
  ['A1 bound: upstream wins, loser approves --override', 3, { decision: 'revise', upstream: 'auth-refresh', ...ARB }, { decision: 'approve', override: true, ...ARB }],
  ['A2 bound: park wins, loser approves --override', 3, { decision: 'stop', ...ARB }, { decision: 'approve', override: true, ...ARB }],
  ['A3 bound: repair wins, loser repairs', 3, { decision: 'revise', repair: true, ...ARB }, { decision: 'revise', repair: true, ...ARB }],
  ['A3b bound: repair wins, parkRefused policy stop', 3, { decision: 'revise', repair: true, ...ARB }, { decision: 'stop', selected: 'policy', note: 'parked by the policy — refused' }],
  ['A4 below bound: revise wins, loser approves', 1, { decision: 'revise', note: 'fix', ...ARB }, { decision: 'approve', ...ARB }],
  ['A5 below bound: revise wins, loser stops', 1, { decision: 'revise', note: 'fix', ...ARB }, { decision: 'stop', ...ARB }],
  ['A6 bound: upstream wins, loser stops', 3, { decision: 'revise', upstream: 'auth-refresh', ...ARB }, { decision: 'stop', ...ARB }],
  ['A7 bound: a human repair wins, a cap park from a read before it', 3, { decision: 'revise', repair: true }, { decision: 'stop', selected: 'policy', park: true, rule: 'cap-rounds', note: 'cap' }],
]

describe('the settled-since token (row 240)', () => {
  for (const [label, rounds, winner, loser] of SHAPES) {
    it(`${label}: the loser refuses settled-since`, async () => {
      const r = await race(rounds, winner, loser)
      expect(r.w).toBe(0)
      expect(r.l).toBe(2)
      expect(r.rules).toContain('settled-since')
      expect(r.winnerOnly).toHaveLength(1)
      expect(r.after).toEqual(r.winnerOnly)                     // the winner's alone
    })
  }

  it('the token is compared before the repair check: repair-not-at-bound never fires for a loser', async () => {
    const r = await race(3, { decision: 'revise', repair: true, ...ARB }, { decision: 'revise', repair: true, ...ARB })
    expect(r.rules[0]).toBe('settled-since')
    expect(r.rules).not.toContain('repair-not-at-bound')
    expect(r.rules).not.toContain('repair-spent')
  })

  it('a settler whose read is current lands, token and all', async () => {
    const repo = await stopped(1)
    const token = settledToken(readStream(repo.root, PLAN), 'plan', 'r-1')
    const code = await applyDecision(fakeCtx(repo.root), { gate: 'plan', target: PLAN, runId: 'r-1', token, decision: 'revise', note: 'fix', ...ARB })
    expect(code).toBe(0)
    expect(decisions(repo.root)).toEqual(['r1 revise · arbiter'])
  })

  it('a human act carries no token and is unaffected: a stop after a revise still lands (D94)', async () => {
    const r = await race(1, { decision: 'revise', note: 'fix', ...ARB }, { decision: 'stop' }, false)
    expect(r.l).toBe(0)
    expect(r.after).toEqual(['r1 revise · arbiter', 'r1 stop · human'])
  })

  it('the token changes with every decision of its gate after the run, and with nothing else', async () => {
    const repo = await stopped(1)
    const t0 = settledToken(readStream(repo.root, PLAN), 'plan', 'r-1')
    expect(t0).toMatch(/^[0-9a-f]{12}$/)
    // a decision of another gate on the same stream leaves it unchanged
    appendEntry(repo.root, PLAN, { v: 1, t: 'human-decision', gate: 'implement', artifact: PLAN, round: 1, decision: 'revise' })
    expect(settledToken(readStream(repo.root, PLAN), 'plan', 'r-1')).toBe(t0)
    // a reopen of this gate (caused_by) changes it
    appendEntry(repo.root, PLAN, {
      v: 1, t: 'human-decision', gate: 'plan', artifact: PLAN, round: 1, decision: 'revise',
      caused_by: { artifact: PLAN, gate: 'ship', round: 1 },
    })
    expect(settledToken(readStream(repo.root, PLAN), 'plan', 'r-1')).not.toBe(t0)
  })
})
