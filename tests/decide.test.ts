import { describe, expect, it } from 'vitest'
import { ok } from '../src/refusal.js'
import { appendEntry, readStream } from '../src/journal.js'
import { registerGate, runGate, type GateInput } from '../src/gate.js'
import type { DecisionEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { findById, loadCanon } from '../src/scan.js'
import { approve, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'

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

// three stopped rounds → bound reached, third round pending
async function boundRepo() {
  const { repo } = await stoppedGate()
  for (const round of [1, 2]) {
    appendEntry(repo.root, 'auth-refresh', {
      v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh', round, decision: 'revise',
    })
    appendEntry(repo.root, 'auth-refresh', {
      v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh', round: round + 1,
      run_id: `r-${round}`, reviewed_sha: `sha-${round}`, prompts_sha: 'p', witness: '0',
      model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
    })
  }
  return repo
}

// A stopped implement gate-run on a real plan: pins are implement-gate decisions, and
// the appended entry alone creates the pending decision (same mechanism as boundRepo).
async function stoppedImplement() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  appendEntry(repo.root, 'auth-refresh-plan-1', {
    v: 1, t: 'gate-run', gate: 'implement', artifact: 'auth-refresh-plan-1', round: 1,
    run_id: 'r-1', reviewed_sha: 'sha-1', prompts_sha: 'p', witness: '0',
    model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
  })
  return { repo, planId: 'auth-refresh-plan-1' }
}

describe('witness decide', () => {
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
    expect(repo.git('log', '-1', '--format=%B')).toContain('Witness-State: 1')
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
        run_id: `r-${round}`, reviewed_sha: `sha-${round}`, prompts_sha: 'p', witness: '0',
        model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
      })
    }
    expect((await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'x'])).code).toBe(2)
    expect((await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])).code).toBe(2)
    const forced = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve', '--override'])
    expect(forced.code).toBe(0)
    expect(decisions(repo).at(-1)).toMatchObject({ decision: 'approve', override: true })
  })

  it('at the bound, revise --upstream is exempt and resets the budget', async () => {
    const repo = await boundRepo()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--upstream', 'auth-refresh', '--note', 'plan is wrong'])
    expect(r.code).toBe(0)
    expect(decisions(repo).some((d) => d.decision === 'revise-upstream' && d.round === 3)).toBe(true)
  })

  it('livelock regression: after a stop at the bound, every exit still works', async () => {
    // exit 1: reopen the parent — used to refuse nothing-pending forever
    const a = await boundRepo()
    expect((await a.cli(['decide', 'plan', 'auth-refresh', '--stop'])).code).toBe(0)
    const upstream = await a.cli(['decide', 'plan', 'auth-refresh', '--revise', '--upstream', 'auth-refresh'])
    expect(upstream.code).toBe(0)
    expect(decisions(a, a.effort).at(-1)!.caused_by).toBeDefined()   // row 95: booked on the effort
    // exit 2: force-approve as-is
    const b = await boundRepo()
    await b.cli(['decide', 'plan', 'auth-refresh', '--stop'])
    expect((await b.cli(['decide', 'plan', 'auth-refresh', '--approve', '--override'])).code).toBe(0)
    // plain revise stays refused at the bound, and the refusal names the live exits
    const c = await boundRepo()
    await c.cli(['decide', 'plan', 'auth-refresh', '--stop'])
    const plain = await c.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'x'])
    expect(plain.code).toBe(2)
    expect(plain.stdout + plain.stderr).toContain('--revise --upstream')
  })

  it('off the bound, nothing-pending still refuses decisions', async () => {
    const { repo } = await stoppedGate()
    await repo.cli(['decide', 'plan', 'auth-refresh', '--stop'])
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('nothing-pending')
  })

  it('--pin journals policy-pin entries alongside the decision', async () => {
    const { repo, planId } = await stoppedImplement()
    const r = await repo.cli(['decide', 'implement', planId, '--revise', '--note', 'fix it',
      '--pin', 'unavailable /book renders the service in full',
      '--pin', 'price format is $total · $rate/hr'])
    expect(r.code).toBe(0)
    const entries = readStream(repo.root, planId)
    const pins = entries.filter((e) => e.t === 'policy-pin')
    expect(pins).toHaveLength(2)
    expect(pins[0]).toMatchObject({ artifact: planId, gate: 'implement', ordinal: 1, text: 'unavailable /book renders the service in full' })
    expect(pins[1]).toMatchObject({ ordinal: 2 })
  })

  it('--pin refuses on non-implement gates and on empty text', async () => {
    // pin-scope is a usage error — it fires before any pending-decision lookup
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const r1 = await repo.cli(['decide', 'decompose', repo.effort, '--revise', '--pin', 'x'])
    expect(r1.code).toBe(2)
    expect(r1.stderr).toContain('pin-scope')
    const { repo: repo2, planId } = await stoppedImplement()
    const r2 = await repo2.cli(['decide', 'implement', planId, '--revise', '--pin', ''])
    expect(r2.code).toBe(2)
    expect(r2.stderr).toContain('pin-empty')
  })

  it('revise-upstream writes linked entries in both journals', async () => {
    const { repo } = await stoppedGate()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--upstream', 'auth-refresh', '--note', 'plan faithful, spec wrong'])
    expect(r.code).toBe(0)
    const child = decisions(repo).find((d) => d.decision === 'revise-upstream')!
    expect(child.decision).toBe('revise-upstream')
    // row 95: a SPEC named upstream resolves to the effort that owns it — decompose gates
    // are keyed on efforts, so the reopen is booked on the effort's stream
    expect(child.upstream).toEqual({ artifact: repo.effort, gate: 'decompose' })
    const reopen = decisions(repo, repo.effort).find((d) => d.caused_by !== undefined)!
    expect(reopen.caused_by).toMatchObject({ artifact: 'auth-refresh', gate: 'plan' })
  })

  it('books a spec-named upstream on the owning effort decompose stream', async () => {
    const { repo, planId } = await stoppedImplement()
    const r = await repo.cli(['decide', 'implement', planId, '--revise', '--upstream', 'auth-refresh',
      '--note', 'the slicing is wrong'])
    expect(r.code).toBe(0)

    const child = decisions(repo, planId).find((d) => d.decision === 'revise-upstream')!
    expect(child.upstream).toEqual({ artifact: repo.effort, gate: 'decompose' })
    const reopen = decisions(repo, repo.effort).find((d) => d.caused_by !== undefined)!
    expect(reopen).toMatchObject({ gate: 'decompose', artifact: repo.effort })
    expect(reopen.caused_by).toMatchObject({ artifact: planId, gate: 'implement' })
    // nothing lands on the spec stream, where no reader would ever look
    expect(decisions(repo, 'auth-refresh')).toEqual([])
    expect(r.stdout).toContain(repo.effort)
  })

  it('refuses a spec no effort ever wrote', async () => {
    const { repo, planId } = await stoppedImplement()
    repo.write('specs/orphan.md', [
      '---',
      'id: orphan',
      'type: spec',
      'status: draft',
      'summary: hand-made, never written by an effort',
      'depends: []',
      'needs: []',
      'criteria:',
      '  - id: ac-orphan',
      "    test: '@spec:orphan'",
      '---',
      '',
      '## Motivation',
      'Hand-made.',
      '',
      '## Behavior',
      'Never written by an effort.',
      '',
    ].join('\n'))
    repo.git('add', 'specs/orphan.md')
    repo.git('commit', '-m', 'hand-made spec', '-m', 'Witness-State: 1')

    const r = await repo.cli(['decide', 'implement', planId, '--revise', '--upstream', 'orphan'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown-owner')
  })
})

// D94: revise → (think better of it) → approve, with nothing edited in between. Before
// this, `gate` answered `changed-nothing` and `decide` answered `nothing-pending`, each
// naming the other, and the only escape found in the field was a pointless edit.
describe('a revised gate still has exits', () => {
  it('lets a human approve after their own revise when the content has not moved', async () => {
    const { repo } = await stoppedGate()
    const revised = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'tighten scope'])
    expect(revised.code).toBe(0)

    const approved = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
    expect(approved.code).toBe(0)
    expect(approved.stdout).toContain('auth-refresh → approve')
    expect(decisions(repo).map((d) => d.decision)).toEqual(['revise', 'approve'])
  })

  it('still refuses when there is no gate-run to anchor on', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('nothing-pending')
  })
})
