import { describe, expect, it } from 'vitest'
import { cliAct } from '../src/act.js'
import { decideView, decideViewLines } from '../src/decide-view.js'
import { findingRows, findingViews, gateRunLines, gateRunView, type GateRunView } from '../src/gate-run-view.js'
import type { Entry } from '../src/journal.js'
import { ROUND_BOUND, type GateRunEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import {
  DECIDE_STATE_NAMES, EVERY_LINE_RUN, REVIEWER_ANCHOR, cfgOf, controlPaths, controlStrings, decideRepo, type DecideState,
} from './model-fixtures.js'

// Rows 139/203. `decide --show` is a model its text renders from, and so is the gate run it
// shows: the values every line prints, the acts every command is. The verb prints the view's
// lines, byte for byte the text tests/text-golden.test.ts pins.

async function viewOf(state: DecideState) {
  const fx = await decideRepo(state)
  return { ...fx, view: decideView(fx.repo.root, cfgOf(fx.repo.root), loadCanon(fx.repo.root), fx.gate, fx.target) }
}

describe('decide --show is a view (rows 139/203)', () => {
  it('an actionable decision is the run, its findings spelled out, and ranked options with acts (Review Focus 1)', async () => {
    const { view, target } = await viewOf('implement-revised')
    if (view.state !== 'actionable') throw new Error(view.state)
    expect(view.run.findings).toStrictEqual([{ reviewer: 'code-reviewer', blocking: true, anchor: 'src/token.ts',
      claim: 'expiry\\x1b[2J\\u{202e}unbounded' }])
    expect(view.run.checks).toStrictEqual([{ name: 'tests', ok: false, detail: 'ac-rotate:fail' }])
    expect(view.run.held).toStrictEqual([{ criterion: 'ac-prod', need: 'prod', satisfy: 'witness satisfy auth-refresh --need prod' }])
    expect(view.pins).toStrictEqual([{ ordinal: 1, text: 'render the service in full' }])
    expect(view.disposition).toStrictEqual({ decision: 'revise', note: 'fix the expiry' })
    expect(view.block?.rule).toBe('blocking-here')
    expect(view.block?.options.map((o) => o.act?.argv)).toEqual([
      ['decide', 'implement', target, '--revise'],
      ['decide', 'implement', target, '--revise', '--upstream', target],     // implement's upstream is the plan
      ['decide', 'implement', target, '--approve', '--override'],
      ['decide', 'implement', target, '--stop'],
    ])
    // R7: no string anywhere in the view holds a raw control or bidi character
    expect(controlStrings(view)).toEqual([])
    expect(JSON.parse(JSON.stringify(view))).toEqual(view)
  })

  // R5/R17, row 239. A reviewer's anchor is spelled out in the findings table, and carried as the
  // text prints it only in the block's anchor and the option's why. It is in no command: the
  // revise is bare, and `decide` journals the prefill itself. A renderer spells those out (spec
  // §4.2); the UI runs an act's argv, never its line.
  it("a reviewer's anchor is spelled out in the findings and is in no command (Review Focus 1)", async () => {
    const { view, target } = await viewOf('implement-anchor')
    if (view.state !== 'actionable') throw new Error(view.state)
    expect(view.run.findings.map((f) => f.anchor)).toEqual(['src/\\x1b[2Jtoken\\u{202e}.ts'])
    expect(view.block?.anchor).toBe(REVIEWER_ANCHOR)
    const note = view.block!.options[0]!
    expect(note.act!.argv).toEqual(['decide', 'implement', target, '--revise'])
    expect(note.command).toBe(`witness decide implement ${target} --revise`)
    expect(note.act!.line).toBe(note.command)
    expect(note.why).toBe(`1 blocking finding anchored inside this artifact (${REVIEWER_ANCHOR}); round 1 of 3`)
    expect(view.exits[1]).toEqual(note.act)
    // exactly these fields hold the raw characters, and no other
    expect(controlPaths(view).sort()).toEqual(['block.anchor', 'block.options.0.why'])
  })

  describe('each other state is its own shape', () => {
    it('no runs', async () => {
      const { view } = await viewOf('no-runs')
      expect(view).toStrictEqual({ gate: 'decompose', target: 'auth-hardening', autonomy: true, state: 'no-runs' })
    })

    it('reopened: who reopened it, the last run and its disposition, and the exits', async () => {
      const { view } = await viewOf('reopened')
      expect(view).toStrictEqual({
        gate: 'decompose', target: 'auth-hardening', autonomy: false, state: 'reopened',
        by: { gate: 'design', artifact: 'account-deletion', round: 1 }, note: 'cancel-window diverges at the spec level',
        last: { round: 1, sha: 'ba2f352', outcome: 'stopped' }, disposition: { decision: 'approve' },
        exits: [cliAct('gate', 'decompose', 'auth-hardening')],
      })
    })

    it('settled: the disposition with who selected it, and the last run — no exits', async () => {
      const { view, shas } = await viewOf('settled-arbiter')
      expect(view).toStrictEqual({
        gate: 'decompose', target: 'auth-hardening', autonomy: false, state: 'settled',
        disposition: { decision: 'approve', selected: 'arbiter', reason: 'the slice covers g1',
          arbiter: { model: 'test-model-1', prompts_sha: 'p' } },
        last: { round: 1, sha: shas[0]!.slice(0, 7), outcome: 'stopped' },
      })
    })

    it('moved after a revise: no block, and the re-gate is the one exit', async () => {
      const { view } = await viewOf('moved-after-revise')
      if (view.state !== 'actionable') throw new Error(view.state)
      expect(view).not.toHaveProperty('block')
      expect(view.disposition).toStrictEqual({ decision: 'revise' })
      expect(view.exits).toStrictEqual([cliAct('gate', 'decompose', 'auth-hardening')])
    })

    it('an untrusted cmd: criterion: the plain approve, then its trusting twin', async () => {
      const { view, target } = await viewOf('plan-trust-twin')
      if (view.state !== 'actionable') throw new Error(view.state)
      expect(view.block?.options.map((o) => o.act?.argv)).toEqual([
        ['decide', 'plan', target, '--approve'],
        ['decide', 'plan', target, '--approve', '--trust-cmds'],
        ['decide', 'plan', target, '--revise', '--note', '<why>'],
        ['decide', 'plan', target, '--revise', '--upstream', 'auth-refresh'],
        ['decide', 'plan', target, '--stop'],
      ])
    })
  })

  it.each(DECIDE_STATE_NAMES)("the verb prints exactly the view's lines: %s", async (state) => {
    const { repo, gate, target, view } = await viewOf(state)
    const r = await repo.cli(['decide', gate, target, '--show'])
    expect(r.code).toBe(0)
    expect(decideViewLines(view).join('\n')).toBe(r.stdout)
  })
})

describe('a gate run is a view (rows 139/203)', () => {
  it('a gate run view holds the value of every line', () => {
    expect(gateRunView(EVERY_LINE_RUN, 'resume', [EVERY_LINE_RUN as unknown as Entry])).toStrictEqual<GateRunView>({
      gate: 'implement', target: 'auth-refresh-plan-1', round: 2, budget: 3, resume: true,
      reviewed: 'c0ffee1', model: 'm', cached: true,
      delta: 1, skipped: ['a'], fallback: ['m1', 'm2'], rerolled: ['b'],
      carried: { lenses: ['c'], run: 'r1' },
      checks: [{ name: 'tests', ok: false, detail: 'ac-rotate:fail' }, { name: 'lint', ok: true }],
      held: [{ criterion: 'ac-prod', need: 'prod', satisfy: 'witness satisfy auth-refresh --need prod' }],
      findings: [
        { reviewer: 'code-reviewer', blocking: true, pin: 1, anchor: 'src/token.ts', claim: 'collapses the service the pin renders in full' },
        { reviewer: 'code-reviewer', blocking: true, anchor: 'omission:tests/', claim: 'no test covers rotation before expiry' },
        { reviewer: 'code-reviewer', blocking: false, anchor: 'omission:src/session.ts', claim: 'expiry unbounded' },
      ],
      demoted: [{ anchor: 'omission:src/session.ts', round: 1 }],
      malformed: [{ reviewer: 'x', violations: [{ field: 'f', rule: 'r' }] }],
      standing: 'reserved',
      outcome: 'stopped',
      lastRound: false,
    })
  })

  it('the round that spends the budget says so, and only with the stream in hand (rows 109/110)', () => {
    const run = (round: number): GateRunEntry => ({
      v: 1, t: 'gate-run', gate: 'implement', artifact: 'auth-refresh-plan-1', round, run_id: `r${round}`,
      reviewed_sha: `sha-${round}`, prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
    })
    const runs = [1, 2, 3].map(run)
    expect(gateRunView(runs[2]!, 'ran', runs as unknown as Entry[])).toMatchObject({ budget: 3, resume: false, lastRound: true })
    // without the stream the view is a pure read of the entry: the base budget, never the last round
    expect(gateRunView(runs[2]!, 'ran')).toMatchObject({ budget: ROUND_BOUND, lastRound: false })
    expect(gateRunView({ ...runs[2]!, outcome: 'passed' }, 'ran', runs as unknown as Entry[]).lastRound).toBe(false)
  })

  // The malformed table prints when any lens was malformed, one row per violation: a lens with no
  // violation (no witness writes one, a journal can hold one) still prints the table's header.
  it('a malformed lens is kept per lens, so the table prints exactly when it did', () => {
    const view = gateRunView({ ...EVERY_LINE_RUN, malformed: [{ reviewer: 'x', violations: [] }] }, 'ran')
    expect(view.malformed).toStrictEqual([{ reviewer: 'x', violations: [] }])
    expect(gateRunLines(view)).toContain('malformed[0]{reviewer,field,rule}:')
    expect(gateRunLines(gateRunView({ ...EVERY_LINE_RUN, malformed: [] }, 'ran')).some((l) => l.startsWith('malformed'))).toBe(false)
  })

  it("a finding's anchor and claim are spelled out, an omission's scope too (Review Focus 1)", () => {
    const verdicts = [{ reviewer: 'code-reviewer', coverage: [], findings: [
      { blocking: true, anchor: 'src/\u001b[2Jtoken.ts', claim: 'expiry\u202eunbounded', contradicts_pin: 2 },
      { blocking: false, anchor: { kind: 'omission' as const, scope: 'tests/\u2028' }, claim: 'no test' },
    ] }]
    expect(findingViews(verdicts)).toStrictEqual([
      { reviewer: 'code-reviewer', blocking: true, pin: 2, anchor: 'src/\\x1b[2Jtoken.ts', claim: 'expiry\\u{202e}unbounded' },
      { reviewer: 'code-reviewer', blocking: false, anchor: 'omission:tests/\\u{2028}', claim: 'no test' },
    ])
    expect(findingRows(verdicts)).toStrictEqual([
      { reviewer: 'code-reviewer', blocking: 'true', pin: '#2', anchor: 'src/\\x1b[2Jtoken.ts', claim: 'expiry\\u{202e}unbounded' },
      { reviewer: 'code-reviewer', blocking: 'false', pin: '', anchor: 'omission:tests/\\u{2028}', claim: 'no test' },
    ])
  })
})
