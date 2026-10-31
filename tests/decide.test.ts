import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/refusal.js'
import { appendEntry, readStream } from '../src/journal.js'
import { registerGate, runGate, type GateInput } from '../src/gate.js'
import type { DecisionEntry, GateRunEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { findById, loadCanon } from '../src/scan.js'
import { actOfCommand, applyDecision, decisionAct } from '../src/verbs/decide.js'
import { SPEC_META, approve, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'

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
    reads: 'docs',
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
    // D129: `liveExits` no longer defaults the upstream to `<id>`, so a gate that cannot
    // name one legitimately omits the option. This fixture gates a SPEC through the plan
    // gate, where the real spec's parent lookup has nothing to return — so the stand-in
    // names the target, which is exactly the id these tests already pass to `--upstream`
    // (decide books it on the owning effort's decompose).
    upstreamOf(_root, _canon, target) {
      return target
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

// The round 0.25.x journaled when the pinned model was dead and another model answered.
// Row 212: no run falls back any more, so the round is journaled, not gated — its readers
// (decide's standing stop, `--show`) stay for the repos that still hold one.
async function fallenBackGate() {
  synthetic()
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  repo.write('witness.config.yaml', 'schema: 1\ngates:\n  model: test-model-1\n')
  repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'pin')
  const doc = findById(loadCanon(repo.root), 'auth-refresh')!
  appendEntry(repo.root, 'auth-refresh', {
    v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh', round: 1, run_id: 'r-0250',
    reviewed_sha: canonicalSha(doc.meta, doc.body), prompts_sha: 'p', witness: '0.25.0',
    model: 'test-model-2', pin: 'test-model-1', harness: 'claude-code', calibration: 'none', fallback: ['test-model-1'],
    standing: 'fallback — reviewers ran on test-model-2, not the pinned test-model-1; the human decides whether that verdict counts',
    checks: [{ name: 'synthetic', ok: true }], verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [] }], outcome: 'stopped',
  } as never)
  repo.git('add', '.witness/journal/auth-refresh.jsonl')
  repo.git('commit', '-m', 'gate(auth-refresh): a 0.25.x fallback round', '-m', 'Witness-State: 1')
  return { repo }
}

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
      model: 'm', checks: [], verdicts: [], outcome: 'stopped',
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
    model: 'm', checks: [], verdicts: [], outcome: 'stopped',
  })
  return { repo, planId: 'auth-refresh-plan-1' }
}

describe('witness decide', () => {
  // D143 (amends D127). A nod selects the recommended option of a CLI-rendered block, and
  // the journal keeps closure-by-nod distinguishable from a named selection. D127's actual
  // guard survives: the agent still types the printed string byte-for-byte — only the
  // SELECTION SOURCE changes, and it binds to a CLI-computed, journaled recommendation.
  it('records an affirmation selection distinguishably (D143)', async () => {
    const { repo } = await stoppedGate()

    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'x', '--via', 'affirmation'])

    expect(res.code).toBe(0)
    expect(decisions(repo).at(-1)!.selected).toBe('affirmation')
  })

  it('a named selection is still recorded as one — the default is unchanged (D143)', async () => {
    const { repo } = await stoppedGate()

    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'x'])

    expect(res.code).toBe(0)
    expect(decisions(repo).at(-1)!.selected).toBeUndefined()
  })

  it('a nod cannot take an obligation-minting override (D143)', async () => {
    const { repo } = await stoppedGate()

    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve', '--override', '--via', 'affirmation'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('nod-cannot')
  })

  it('a nod cannot take a terminal stop (D143)', async () => {
    const { repo } = await stoppedGate()

    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--stop', '--via', 'affirmation'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('nod-cannot')
  })

  it('refuses a --via word it does not define (D143)', async () => {
    const { repo } = await stoppedGate()

    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'x', '--via', 'vibes'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown-via')
  })

  // D154. Trust is granted where a human decides. The grant runs only after the decision
  // is durable — a refused decide must not leave one behind.
  it('--approve --trust-cmds grants and journals (D154)', async () => {
    const { repo } = await stoppedGate()
    await writeSpec(repo, 'auth-refresh', {
      ...SPEC_META, criteria: [{ id: 'ac-smoke', cmd: 'echo ok' }],
    })

    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve', '--trust-cmds'])

    expect(res.code).toBe(0)
    expect(res.stdout).toContain('trusted: echo ok')
    const allow = JSON.parse(repo.read('.witness/allow.json')) as { commands: string[] }
    expect(allow.commands).toContain('echo ok')
    const entry = readStream(repo.root, repo.effort).findLast((e) => e.t === 'trust')
    expect(entry?.via).toBe('decide')
  })

  it('a grant rides an approval and nothing else (D154)', async () => {
    const { repo } = await stoppedGate()

    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'x', '--trust-cmds'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('trust-scope')
  })

  it('a nod never grants trust (D143 exclusion, D154)', async () => {
    const { repo } = await stoppedGate()

    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve', '--trust-cmds', '--via', 'affirmation'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('nod-cannot')
  })

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
        model: 'm', checks: [], verdicts: [], outcome: 'stopped',
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

  // Row 108 / 98d. The bound is the DESIGNED terminus: nothing malfunctioned, there is
  // no row to fix, and re-running is the one thing the bound forbids — gate.ts
  // short-circuits before invoking. renderRefusal's trailer says the opposite.
  it('at the bound, prints the terminus rather than a self-repair refusal', async () => {
    const repo = await boundRepo()
    await repo.cli(['decide', 'plan', 'auth-refresh', '--stop'])
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
    expect(r.code).toBe(2)                                        // exit code unchanged
    const all = r.stdout + r.stderr
    expect(all).not.toContain('rows are structured for self-repair')
    expect(all).not.toContain('refused[')
    expect(all).toContain('bound reached')
    // D121: the terminus renders the ranked block rather than a flat exits line, and the
    // override is what it recommends there — the assertion is about the act being offered,
    // so it moves onto the option row instead of the line that used to carry it.
    expect(all).toMatch(/^decide: \d+ options · 1 is recommended$/m)
    expect(all).toContain('   witness decide plan auth-refresh --approve --override')
  })

  it('at the bound, a plain revise names the exits without the self-repair trailer', async () => {
    const repo = await boundRepo()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--revise', '--note', 'x'])
    expect(r.code).toBe(2)
    const all = r.stdout + r.stderr
    expect(all).not.toContain('rows are structured for self-repair')
    expect(all).toContain('--revise --upstream')
    expect(all).toContain('upstream reopens the parent and resets the budget')
  })

  // override-required is GENUINELY a refusal: the human asked for an approve they are
  // not entitled to, and "fix the row and re-run" is true and useful there.
  it('keeps override-required a refusal, trailer and all', async () => {
    const repo = await boundRepo()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
    // pending at the bound: the anchor exists, so this is the override-required path
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('override-required')
    expect(r.stdout + r.stderr).toContain('rows are structured for self-repair')
  })

  // Row 107: the round cannot pass on its own, and dismissing it costs a plain --approve.
  // --override is reserved for the bound, and the exemption means the bound is not reached.
  it('a plain --approve dismisses a fallen-back round', async () => {
    const { repo } = await fallenBackGate()
    const last = readStream(repo.root, 'auth-refresh')
      .filter((e) => e.t === 'gate-run').at(-1) as unknown as GateRunEntry
    expect(last.outcome).toBe('stopped')
    expect(last.standing).toContain('fallback — reviewers ran on test-model-2, not the pinned test-model-1')
    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--approve'])
    expect(res.code).toBe(0)
    expect(decisions(repo).at(-1)?.decision).toBe('approve')
    expect(decisions(repo).at(-1)?.override).toBeUndefined()
  })

  // Re-shown, never re-used. `decide --show` is the surface whose job is showing, which is
  // what lets appendKind exclude a substituted round from `resume` without losing anything.
  it('decide --show renders a fallen-back round with its standing stop', async () => {
    const { repo } = await fallenBackGate()
    const res = await repo.cli(['decide', 'plan', 'auth-refresh', '--show'])
    expect(res.code).toBe(0)
    // Quoted by kv: the standing stop carries a comma, so TOON encodes it as a string.
    expect(res.stdout).toContain('standing-stop: "fallback — reviewers ran on test-model-2')
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

// Row 52 (§4.8). The help line a decompose revise prints is a command that runs: `recap --amend`
// takes no value, and the recap names its effort.
describe("decide's scope help (row 52)", () => {
  it("decide's scope help line is a command that runs", async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    expect((await repo.cli(['gate', 'decompose', '--effort', 'auth-hardening'], { env: gateEnv(scenario) })).code).toBe(1)
    const res = await repo.cli(['decide', 'decompose', 'auth-hardening', '--revise', '--note', 'scope'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('help: scope itself implicated → witness draft amend-auth-hardening seeds the amendment from the latest recap · witness recap --amend --file <recap.json> lands it')
    expect(res.stdout).not.toMatch(/recap --amend auth-hardening/)
  })
})

describe('applyDecision — the one door (A4)', () => {
  const at = (repo: { root: string }) => {
    const outs: string[] = []; const errs: string[] = []
    return { ctx: fakeCtx(repo.root, { out: (l) => outs.push(l), err: (l) => errs.push(l) }), out: () => outs.join('\n'), err: () => errs.join('\n') }
  }
  it('journals a policy selection and says who decided', async () => {
    const { repo } = await stoppedGate(); const h = at(repo)
    expect(await applyDecision(h.ctx, { gate: 'plan', target: 'auth-refresh', decision: 'revise', note: 'n', selected: 'policy' })).toBe(0)
    expect(decisions(repo).at(-1)).toMatchObject({ decision: 'revise', selected: 'policy', rule: 'blocking-parent', recommended: 'revise' })
    expect(h.out()).toContain('decided: plan auth-refresh → revise · policy · blocking-parent')
  })
  it('journals the arbiter reason and identity', async () => {
    const { repo } = await stoppedGate(); const h = at(repo)
    expect(await applyDecision(h.ctx, { gate: 'plan', target: 'auth-refresh', decision: 'approve', selected: 'arbiter',
      reason: 'the finding misreads the spec', arbiter: { model: 'test-model-1', prompts_sha: 'abc' } })).toBe(0)
    expect(decisions(repo).at(-1)).toMatchObject({ selected: 'arbiter', reason: 'the finding misreads the spec', arbiter: { model: 'test-model-1', prompts_sha: 'abc' } })
    expect(h.out()).toContain('reason: the finding misreads the spec')
  })
  it('no autonomous selection grants trust, and the policy never overrides', async () => {
    const { repo } = await stoppedGate(); const h = at(repo)
    expect(await applyDecision(h.ctx, { gate: 'plan', target: 'auth-refresh', decision: 'approve', trustCmds: true, selected: 'policy' })).toBe(2)
    expect(await applyDecision(h.ctx, { gate: 'plan', target: 'auth-refresh', decision: 'approve', override: true, selected: 'policy' })).toBe(2)
    expect(h.err().match(/autonomy-cannot/g)).toHaveLength(2)
    expect(decisions(repo)).toEqual([])
  })
  it('refuses to decide a run the decider did not judge', async () => {
    const { repo } = await stoppedGate(); const h = at(repo)
    expect(await applyDecision(h.ctx, { gate: 'plan', target: 'auth-refresh', decision: 'stop', selected: 'policy', runId: 'r-other' })).toBe(2)
    expect(h.err()).toContain('anchor-moved')
    expect(decisions(repo)).toEqual([])
  })
  it('a second decision on a run already disposed of refuses and journals nothing', async () => {
    const { repo } = await stoppedGate(); const h = at(repo)
    const run = (readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'gate-run').at(-1) as unknown as { run_id: string }).run_id
    expect(await applyDecision(h.ctx, { gate: 'plan', target: 'auth-refresh', decision: 'revise', note: 'x', selected: 'policy', runId: run })).toBe(0)
    expect(await applyDecision(h.ctx, { gate: 'plan', target: 'auth-refresh', decision: 'revise', note: 'x', selected: 'policy', runId: run })).toBe(2)
    expect(h.err()).toMatch(/nothing-pending|anchor-moved/)
    expect(decisions(repo)).toHaveLength(1)
  })
  it('only a policy act may park past the anchor rule or name its own rule (B5)', async () => {
    const { repo } = await stoppedGate()
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { err: (l) => errs.push(l) })
    const arbiter = { reason: 'r', arbiter: { model: 'm', prompts_sha: 'p' } }
    expect(await applyDecision(ctx, { gate: 'plan', target: 'auth-refresh', decision: 'stop', selected: 'arbiter', ...arbiter, park: true })).toBe(2)
    expect(await applyDecision(ctx, { gate: 'plan', target: 'auth-refresh', decision: 'stop', rule: 'cap-rounds' })).toBe(2)
    expect(errs.join('\n').match(/autonomy-cannot/g)).toHaveLength(2)
    expect(decisions(repo)).toEqual([])
  })

  it('reads a rendered command into the same act the verb parses', () => {
    expect(actOfCommand('witness decide plan p1 --revise --note "1 blocking finding: p1 > ## Step: s1 "quoted""'))
      .toEqual(ok({ gate: 'plan', target: 'p1', decision: 'revise', note: '1 blocking finding: p1 > ## Step: s1 "quoted"' }))
    expect(actOfCommand('witness decide implement p1 --approve --override')).toEqual(ok({ gate: 'implement', target: 'p1', decision: 'approve', override: true }))
    expect(actOfCommand('witness gate plan p1').ok).toBe(false)
    expect(decisionAct(['plan', 'p1', '--revise', '--note', 'x', '--via', 'affirmation'])).toEqual(ok({ gate: 'plan', target: 'p1', decision: 'revise', note: 'x', selected: 'affirmation' }))
  })
})

describe('the look stays the human\'s at the one door (F1)', () => {
  it('refuses an autonomous approve of a design', async () => {
    const repo = await seededRepo()
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { err: (l) => errs.push(l) })
    for (const act of [
      { gate: 'design', target: 'auth-refresh', decision: 'approve' as const, selected: 'policy' as const },
      { gate: 'design', target: 'auth-refresh', decision: 'approve' as const, override: true, selected: 'arbiter' as const,
        reason: 'r', arbiter: { model: 'm', prompts_sha: 'p' } },
    ]) expect(await applyDecision(ctx, act)).toBe(2)
    expect(errs.join('\n').match(/autonomy-cannot/g)).toHaveLength(2)
  })
})
