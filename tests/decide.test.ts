import { describe, expect, it } from 'vitest'
import { ok } from '../src/refusal.js'
import { appendEntry, readStream } from '../src/journal.js'
import { registerGate, runGate, type GateInput } from '../src/gate.js'
import type { DecisionEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { findById, loadCanon } from '../src/scan.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec } from './helpers.js'

const BLOCKING = {
  coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }],
  findings: [{ blocking: true, anchor: 'auth-refresh > ## Behavior', claim: 'expiry unbounded' }],
}

// Re-registers on every call (not once-guarded): repo.cli(['decide', ...]) dynamically
// imports gates/index.js, which registers the real 'plan' gate and would otherwise
// silently clobber this synthetic one for the rest of the file's shared module state.
function synthetic() {
  registerGate({
    gate: 'plan',
    targetKind: 'plan',
    async resolve(_root, _ctx, canon, _cfg, target) {
      const doc = findById(canon, target)!
      return ok<GateInput>({
        class: 'feature',
        reviewedSha: canonicalSha(doc.meta, doc.body),
        reviewed: { kind: 'docs', docs: [{ id: target, body: doc.body }] },
        promptBody: doc.body,
        checks: [{ name: 'synthetic', ok: true }],
        stamps: [{ artifact: target, to: 'approved' }],
      })
    },
    approveStamps(_root, canon, target) {
      const doc = findById(canon, target)
      return doc && doc.meta.status === 'draft' ? [{ artifact: target, to: 'approved' }] : []
    },
  })
}

async function stoppedGate() {
  synthetic()
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, BLOCKING)
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  await runGate(ctx, 'plan', 'auth-refresh', { fresh: false, manual: false })
  return { repo, scenario, ctx }
}
const decisions = (repo: { root: string }, id = 'auth-refresh') =>
  readStream(repo.root, id).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]

describe('specflow decide', () => {
  it('refuses when nothing is pending', async () => {
    synthetic()
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('nothing-pending')
  })

  it('approve journals the decision and applies the approve stamps in one commit', async () => {
    const { repo } = await stoppedGate()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve', '--note', 'accepting the risk'])
    expect(r.code).toBe(0)
    expect(decisions(repo)[0]).toMatchObject({ decision: 'approve', note: 'accepting the risk' })
    expect(findById(loadCanon(repo.root), 'auth-refresh')!.meta.status).toBe('approved')
    expect(repo.git('log', '-1', '--format=%B')).toContain('Specflow-State: 1')
  })

  it('revise journals and renders the reconstruction payload from the journal', async () => {
    const { repo } = await stoppedGate()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'bound the expiry to 15m'])
    expect(r.code).toBe(0)
    expect(decisions(repo)[0]!.decision).toBe('revise')
    expect(r.stdout).toContain('expiry unbounded')          // verdict, reconstructed
    expect(r.stdout).toContain('bound the expiry to 15m')   // the human note
    const show = await repo.cli(['decide', 'plan', 'auth-refresh', '--show'])
    expect(show.code).toBe(0)
    expect(show.stdout).toContain('expiry unbounded')
  })

  it('at the bound: revise refused, approve needs --override', async () => {
    const { repo } = await stoppedGate()
    for (const round of [1, 2]) {
      appendEntry(repo.root, 'auth-refresh', {
        v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh', round, decision: 'revise',
      })
      appendEntry(repo.root, 'auth-refresh', {
        v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh', round: round + 1,
        run_id: `r-${round}`, reviewed_sha: `sha-${round}`, prompts_sha: 'p', specflow: '0',
        model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
      })
    }
    expect((await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'x'])).code).toBe(2)
    expect((await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])).code).toBe(2)
    const forced = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve', '--override'])
    expect(forced.code).toBe(0)
    expect(decisions(repo).at(-1)).toMatchObject({ decision: 'approve', override: true })
  })

  it('revise-upstream writes linked entries in both journals', async () => {
    const { repo } = await stoppedGate()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--upstream', 'auth-refresh', '--note', 'plan faithful, spec wrong'])
    expect(r.code).toBe(0)
    const child = decisions(repo).find((d) => d.decision === 'revise-upstream')!
    expect(child.decision).toBe('revise-upstream')
    expect(child.upstream).toEqual({ artifact: 'auth-refresh', gate: 'decompose' })
    const reopen = decisions(repo).find((d) => d.caused_by !== undefined)!
    expect(reopen.caused_by).toMatchObject({ artifact: 'auth-refresh', gate: 'plan' })
  })
})
