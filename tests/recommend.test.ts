import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { appendEntry, readStream, type Entry } from '../src/journal.js'
import { recommend, renderDecision, type Decision } from '../src/recommend.js'
import { anchorRecurrence, ladderSpent, liveExits, notePrefill } from '../src/rounds.js'
import { recommenderRowsFrom } from '../src/verbs/dashboard.js'
import { loadCanon } from '../src/scan.js'
import { readyChoice } from '../src/verbs/next.js'
import { PLAN_BLOCKING, approve, fakeScenario, readyTrio, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'

const D: Decision = {
  key: 'decide',
  rule: 'blocking-here',
  anchor: 'p1 > ## Step: s1',
  options: [
    {
      command: 'witness decide plan p1 --revise --note "1 blocking finding: p1 > ## Step: s1"',
      depth: 'root', runnable: true,
      why: '1 blocking finding anchored inside this plan; round 1 of 3',
    },
    {
      command: 'witness decide plan p1 --revise --upstream auth-refresh',
      depth: 'root', runnable: true,
      when: 'the criterion the step maps to is itself untestable',
      tradeoff: 'reopens decompose and resets this budget',
      note: 'auth-refresh is a spec, so the reopen is booked on its owning effort',
    },
    { command: 'witness decide plan p1 --stop', depth: 'terminal', runnable: true, when: 'this plan should not continue' },
  ],
}

describe('renderDecision', () => {
  it('numbers the options and marks the first as recommended', () => {
    const lines = renderDecision(D)
    expect(lines[0]).toBe('decide: 3 options · 1 is recommended')
    expect(lines[1]).toBe('1 · recommended · root')
    expect(lines[2]).toBe('   witness decide plan p1 --revise --note "1 blocking finding: p1 > ## Step: s1"')
    expect(lines[3]).toBe('   why: 1 blocking finding anchored inside this plan; round 1 of 3')
  })

  it('emits a run: line byte-identical to option 1', () => {
    const lines = renderDecision(D)
    expect(lines.at(-1)).toBe(`run: ${D.options[0]!.command}`)
  })

  it('renders when/tradeoff/note on alternatives and never quotes a command', () => {
    const out = renderDecision(D).join('\n')
    expect(out).toContain('   when: the criterion the step maps to is itself untestable')
    expect(out).toContain('   tradeoff: reopens decompose and resets this budget')
    expect(out).toContain('   note: auth-refresh is a spec')
    expect(out).not.toContain('""')
  })

  it('flags an unrunnable option and emits no run: line when option 1 is unrunnable', () => {
    const lines = renderDecision({
      ...D,
      options: [{ command: 'witness decide plan p1 --revise --upstream <effort>', depth: 'root', runnable: false, why: 'x' }],
    })
    expect(lines[1]).toBe('1 · recommended · root · not runnable')
    expect(lines.some((l) => l.startsWith('run: '))).toBe(false)
  })
})

const run = (round: number, sha: string, anchor: string, extra: Record<string, unknown> = {}): Entry => ({
  v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round, run_id: `r-${round}`,
  reviewed_sha: sha, prompts_sha: 'ps', witness: '0.11.0', model: 'm', pin: 'm',
  harness: 'claude-code', checks: [], outcome: 'stopped',
  verdicts: [{ reviewer: 'plan-critic', findings: [{ blocking: true, anchor, claim: 'x' }], coverage: [] }],
  ...extra,
} as unknown as Entry)

const decision = (d: string, extra: Record<string, unknown> = {}): Entry =>
  ({ v: 1, t: 'human-decision', gate: 'plan', artifact: 'p1', round: 1, decision: d, ...extra } as unknown as Entry)

describe('anchorRecurrence', () => {
  it('counts distinct reviewed shas only', () => {
    const e = [run(1, 'a', 'S'), run(2, 'a', 'S'), run(3, 'b', 'S')]
    expect(anchorRecurrence(e, 'plan', 'S')).toBe(2)
  })

  it('excludes malformed and fallen-back rounds', () => {
    const e = [run(1, 'a', 'S'), run(2, 'b', 'S', { outcome: 'malformed' }), run(3, 'c', 'S', { pin: 'other' })]
    expect(anchorRecurrence(e, 'plan', 'S')).toBe(1)
  })

  it('excludes findings that contradict a pin', () => {
    const e = [run(1, 'a', 'S'), run(2, 'b', 'S')]
    ;(e[1] as unknown as { verdicts: Array<{ findings: Array<Record<string, unknown>> }> })
      .verdicts[0]!.findings[0]!.contradicts_pin = 1
    expect(anchorRecurrence(e, 'plan', 'S')).toBe(1)
  })

  it('restarts at the window boundary', () => {
    const e = [run(1, 'a', 'S'), run(2, 'b', 'S'), decision('revise-upstream'), run(3, 'c', 'S')]
    expect(anchorRecurrence(e, 'plan', 'S')).toBe(1)
  })
})

describe('ladderSpent', () => {
  it('sees an upstream taken for this anchor in a closed window', () => {
    const e = [run(1, 'a', 'S'), decision('revise-upstream', { anchor: 'S' }), run(2, 'b', 'S')]
    expect(ladderSpent(e, 'plan', 'S')).toBe(true)
    expect(ladderSpent(e, 'plan', 'OTHER')).toBe(false)
  })

  it('is false when the upstream carried no anchor', () => {
    const e = [run(1, 'a', 'S'), decision('revise-upstream'), run(2, 'b', 'S')]
    expect(ladderSpent(e, 'plan', 'S')).toBe(false)
  })
})

// Row 170: a run whose deterministic check failed and whose battery blocked nothing.
const failedRun = (extra: Record<string, unknown> = {}) => {
  const r = run(1, 'a', 'S', { checks: [{ name: 'drift-lane', ok: false, detail: 'ac-baseline:fail' }], ...extra })
  ;(r as unknown as { verdicts: Array<{ findings: unknown[] }> }).verdicts[0]!.findings = []
  return r
}

const ctxFor = (entries: Entry[], over: Partial<{ upstream: string; stale: boolean }> = {}) => ({
  gate: 'plan', target: 'p1', entries, upstream: over.upstream ?? 'auth-refresh', stale: over.stale ?? false,
})

describe('malformed-rerun offers the re-run alone (row 212)', () => {
  it('renders no calibrate invocation, and the re-run says what it re-asks', () => {
    const d = recommend(ctxFor([run(1, 'a', 'S', {
      outcome: 'malformed', malformed: [{ reviewer: 'code-reviewer', violations: [] }],
    })]))!
    expect(d.rule).toBe('malformed-rerun')
    expect(d.options.map((o) => o.command)).toEqual(['witness gate plan p1'])
    expect(d.options[0]!.why).toContain('re-asks only code-reviewer')
  })
})

// The suffix promises what appendKind will do (row 209): a repair re-asks only the lenses with
// no verdict — on unchanged content, and never from a round that fell back. Moved content makes
// the re-gate a fresh round, the whole battery asked, so the suffix would be false there.
describe('the re-ask suffix promises only what the re-gate will do', () => {
  const malformed = (extra: Record<string, unknown> = {}) =>
    run(1, 'a', 'S', { outcome: 'malformed', malformed: [{ reviewer: 'code-reviewer', violations: [] }], ...extra })
  it('names the re-asked lens on unchanged content, conditioned on the setup', () => {
    const why = recommend(ctxFor([malformed()]))!.options[0]!.why!
    expect(why).toContain('and on unchanged content and setup it re-asks only code-reviewer')
  })
  it('says nothing of a re-ask once the content moved, or after a fallen-back round', () => {
    expect(recommend(ctxFor([malformed()], { stale: true }))!.options[0]!.why).not.toContain('re-asks')
    expect(recommend(ctxFor([malformed({ pin: 'm1', model: 'session-default' })]))!.options[0]!.why).not.toContain('re-asks')
  })
})

describe('the rule table is ordered and total', () => {
  it('blocking-here: one blocking finding anchored in this artifact', () => {
    const d = recommend(ctxFor([run(1, 'a', 'p1 > ## Step: s1')]))!
    expect(d.rule).toBe('blocking-here')
    expect(d.options[0]!.command).toContain('--revise --note')
    expect(d.options[0]!.depth).toBe('root')
    expect(d.anchor).toBe('p1 > ## Step: s1')
  })

  it('stale-below-bound: a pending decision on a verdict whose content moved', () => {
    const d = recommend(ctxFor([run(1, 'a', 'p1 > ## Step: s1')], { stale: true }))!
    expect(d.rule).toBe('stale-below-bound')
    expect(d.options[0]!.command).toBe('witness gate plan p1')
    expect(d.options[0]!.why).toContain('no battery')
    expect(d.options[0]!.tradeoff).toContain('round 2 of 3')
    expect(d.options.map((o) => o.command)).toEqual([
      'witness gate plan p1',
      'witness decide plan p1 --revise --note "1 blocking finding: p1 > ## Step: s1"',
      'witness decide plan p1 --revise --upstream auth-refresh',
      'witness decide plan p1 --stop',
    ])
  })

  it('stale-below-bound: never offers approve, which the stale-verdict refusal blocks', () => {
    const d = recommend(ctxFor([run(1, 'a', 'p1 > ## Step: s1')], { stale: true }))!
    expect(d.options.some((o) => o.command.includes('--approve'))).toBe(false)
  })

  it('stale-below-bound: a findings-free run still recommends a runnable command', () => {
    // The checks must be GREEN: notePrefill only falls back to "<why>" with no blocking
    // findings AND no failed checks (rounds.ts:236-239) — a failed check yields
    // "failed checks: graph", which is runnable and would defeat the point of this case.
    const d = recommend(ctxFor([{
      v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round: 1, run_id: 'r1',
      reviewed_sha: 'a', prompts_sha: 'ps', witness: '0', model: 'm', pin: 'm',
      harness: 'claude-code',
      checks: [{ name: 'graph', ok: true, detail: '' }], outcome: 'stopped', verdicts: [],
    } as unknown as Entry], { stale: true }))!
    expect(d.rule).toBe('stale-below-bound')
    expect(d.options[0]!.runnable).toBe(true)
    expect(d.options.find((o) => o.command.includes('--note'))!.runnable).toBe(false)
  })

  it('stale-below-bound: yields to the caller when no decision is pending', () => {
    // a disposition after the run means no anchor resolves — every decide verb refuses
    // with nothing-pending there, so the caller's single re-gate act is the honest answer
    const entries = [run(1, 'a', 'p1 > ## Step: s1'), decision('approve')]
    expect(recommend(ctxFor(entries, { stale: true }))).toBeUndefined()
  })

  it('stale-below-bound: the bound outranks it', () => {
    const entries = [run(1, 'a', 'S'), run(2, 'b', 'S2'), run(3, 'c', 'S3')]
    expect(recommend(ctxFor(entries, { stale: true }))!.rule).toBe('bound-stale')
  })

  it('blocking-parent: every blocking anchor names the parent', () => {
    const d = recommend(ctxFor([run(1, 'a', 'auth-refresh > ## Behavior')]))!
    expect(d.rule).toBe('blocking-parent')
    expect(d.options[0]!.command).toContain('--revise --upstream auth-refresh')
  })

  it('anchor-recurrence-2: escalates, and patch-again drops to alternative', () => {
    const d = recommend(ctxFor([run(1, 'a', 'p1 > ## Step: s1'), run(2, 'b', 'p1 > ## Step: s1')]))!
    expect(d.rule).toBe('anchor-recurrence-2')
    expect(d.options[0]!.command).toContain('--revise --upstream auth-refresh')
    expect(d.options[1]!.command).toContain('--revise --note')
  })

  it('ladder-spent: upstream already taken for this anchor', () => {
    const e = [run(1, 'a', 'S'), decision('revise-upstream', { anchor: 'S' }),
      run(2, 'b', 'S'), run(3, 'c', 'S'), run(4, 'd', 'S')]
    const d = recommend(ctxFor(e))!
    expect(d.rule).toBe('ladder-spent')
    expect(d.options[0]!.command).toContain('--stop')
    expect(d.options[0]!.depth).toBe('terminal')
    expect(d.options[1]!.depth).toBe('deferral')
    expect(d.options[1]!.tradeoff).toBeTruthy()
  })

  it('non-blocking-only: approve', () => {
    const r = run(1, 'a', 'S')
    ;(r as unknown as { verdicts: Array<{ findings: Array<Record<string, unknown>> }> })
      .verdicts[0]!.findings[0]!.blocking = false
    const d = recommend(ctxFor([r]))!
    expect(d.rule).toBe('non-blocking-only')
    expect(d.options[0]!.command).toBe('witness decide plan p1 --approve')
  })

  it('reserved-stop-clean: approve with judge-first', () => {
    // the ENTRY's gate has to be the ship gate too — `recommend` reads the last run FOR THE
    // GATE IT IS ASKED ABOUT, so a plan-gate run with a ship-gate context is no run at all
    const r = run(1, 'a', 'S', { gate: 'ship' })
    const raw = r as unknown as { verdicts: Array<{ findings: unknown[] }>; standing: string }
    raw.verdicts[0]!.findings = []
    raw.standing = 'ship always stops'
    const d = recommend({ ...ctxFor([r]), gate: 'ship' })!
    expect(d.rule).toBe('reserved-stop-clean')
    expect(d.options[0]!.judgeFirst).toContain('whether this change should exist')
  })

  it('checks-failed: a failed check with no blocking finding recommends revise', () => {
    const d = recommend(ctxFor([failedRun()]))!
    expect(d.rule).toBe('checks-failed')
    expect(d.options[0]!.command).toBe('witness decide plan p1 --revise --note "failed checks: drift-lane"')
    expect(d.options[0]!.why).toContain('drift-lane')
    expect(d.options[0]!.why).not.toContain('--manual')
    expect(d.options[0]!.why).not.toContain(',')
    expect(d.options.find((o) => o.command === 'witness decide plan p1 --approve')!.depth).toBe('deferral')
  })

  it('checks-failed outranks non-blocking-only', () => {
    const r = failedRun()
    ;(r as unknown as { verdicts: Array<{ findings: unknown[] }> }).verdicts[0]!.findings =
      [{ blocking: false, anchor: 'S', claim: 'nit' }]
    expect(recommend(ctxFor([r]))!.rule).toBe('checks-failed')
  })

  it('checks-failed at a ship standing stop', () => {
    const r = failedRun({ gate: 'ship', standing: 'ship always stops' })
    expect(recommend({ ...ctxFor([r]), gate: 'ship' })!.rule).toBe('checks-failed')
  })

  it('checks-failed: amendment-ack alone leads with approve — approving is the ack', () => {
    const r = failedRun({ gate: 'decompose', checks: [{ name: 'amendment-ack', ok: false,
      detail: 'amended under in-progress plans (approve = explicit ack): p9' }] })
    const d = recommend({ ...ctxFor([r]), gate: 'decompose' })!
    expect(d.rule).toBe('checks-failed')
    expect(d.options[0]!.command).toBe('witness decide decompose p1 --approve')
    expect(d.options[0]!.depth).toBe('root')
    expect(d.options[0]!.why).toContain('amendment-ack')
    expect(d.options[0]!.why).not.toContain(',')
    expect(d.options.some((o) => o.command.startsWith('witness decide decompose p1 --revise --note'))).toBe(true)
  })

  it('checks-failed: amendment-ack beside another failed check still leads with revise', () => {
    const r = failedRun({ gate: 'decompose', checks: [
      { name: 'amendment-ack', ok: false, detail: 'amended under in-progress plans (approve = explicit ack): p9' },
      { name: 'goal-coverage', ok: false, detail: 'g1 uncovered' }] })
    const d = recommend({ ...ctxFor([r]), gate: 'decompose' })!
    expect(d.options[0]!.command).toMatch(/--revise --note/)
  })

  it('the trust twin of a deferral approve is a deferral too', () => {
    const d = recommend({ ...ctxFor([failedRun()]), untrustedCmds: ['pnpm verify:baseline'] })!
    const twin = d.options.find((o) => o.command === 'witness decide plan p1 --approve --trust-cmds')!
    expect(twin.depth).toBe('deferral')
  })

  it('manual-stop: green, no standing stop, stopped anyway', () => {
    const r = run(1, 'a', 'S')
    const raw = r as unknown as { verdicts: Array<{ findings: unknown[] }>; manual: boolean }
    raw.verdicts[0]!.findings = []
    raw.manual = true
    const d = recommend(ctxFor([r]))!
    expect(d.rule).toBe('manual-stop')
    expect(d.options[0]!.command).toBe('witness decide plan p1 --approve')
    expect(d.options[0]!.judgeFirst).toBeUndefined()
    expect(d.options[0]!.why).toContain('--manual')
  })

  it('every option carrying deferral depth names a discharge', () => {
    const e = [run(1, 'a', 'S'), decision('revise-upstream', { anchor: 'S' }),
      run(2, 'b', 'S'), run(3, 'c', 'S'), run(4, 'd', 'S')]
    for (const o of recommend(ctxFor(e))!.options) {
      if (o.depth === 'deferral') expect(o.note ?? o.tradeoff).toMatch(/discharge|obligation|until/i)
    }
  })
})

const BLOCKING_VERDICT = PLAN_BLOCKING

async function stopped() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  const scenario = fakeScenario()
  putVerdict(scenario, BLOCKING_VERDICT)
  const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
  return { repo, gateOut: g.stdout }
}

describe('every decision surface renders the block', () => {
  it('the gate stop and decide --show both carry ranked options and a run: line', async () => {
    const { repo, gateOut } = await stopped()
    const show = (await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--show'])).stdout
    for (const out of [gateOut, show]) {
      expect(out).toMatch(/decide: \d+ options · 1 is recommended/)
      expect(out).toContain('1 · recommended · root')
      expect(out).toContain('   why: ')
      expect(out).toMatch(/^run: witness decide plan auth-refresh-plan-1 /m)
      expect(out).not.toContain('<id>')
    }
  })
})

describe('next and recover rank their own choices', () => {
  // Each spec carries a criterion tagged with its OWN id: SPEC_META's default is
  // `@spec:auth-refresh`, which `write` refuses for any other id — and the write refusal is
  // silent unless asserted, which is how this setup first appeared to work and then failed
  // three lines later inside `approve`.
  const spec = (repo: Awaited<ReturnType<typeof seededRepo>>, id: string, extra: Record<string, unknown> = {}) =>
    writeSpec(repo, id, { criteria: [{ id: `ac-${id}`, test: `@spec:${id}` }], covers: ['g1'], ...extra })

  it('multiple ready ranks by direct dependents and says what it cannot see', async () => {
    const repo = await seededRepo()
    await readyTrio(repo)

    const n = await repo.cli(['next'])
    expect(n.stdout).toContain('choose: 3 options · 1 is recommended')
    const ranked = n.stdout.split('\n').filter((l) => /^\d+ · /.test(l))
    expect(ranked).toHaveLength(3)
    // token-store is the one two others derive from, so planning it later re-plans them
    expect(n.stdout).toMatch(/1 · recommended · root\n {3}token-store/)
    expect(n.stdout).toContain('2 canon doc(s) depend on it directly')
    expect(n.stdout).toContain('judge-first: which slice matters this week')
  })

  // The ui tie-break is asserted directly: an approved ui spec routes to the DESIGN stage
  // before any planning, so it can never reach the multiple-ready branch through the CLI.
  it('ranks a ui-flagged spec first when the graph cannot distinguish them', async () => {
    const repo = await seededRepo()
    for (const [id, extra] of [['plain-one', {}], ['looks-first', { ui: true }]] as Array<[string, Record<string, unknown>]>) {
      expect((await spec(repo, id, extra)).code).toBe(0)
    }
    const choice = readyChoice(loadCanon(repo.root), ['plain-one', 'looks-first'])
    expect(choice.options[0]!.command).toBe('looks-first')
    expect(choice.options[0]!.why).toContain('the dependency graph does not distinguish these')
    expect(choice.options[1]!.tradeoff).toBe('none material')
  })
})

describe('the decision records what was recommended', () => {
  it('journals recommended, rule and anchor', async () => {
    const { repo } = await stopped()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--revise', '--note', 'ok'])
    const d = readStream(repo.root, 'auth-refresh-plan-1')
      .filter((e) => e.t === 'human-decision').at(-1)! as unknown as Record<string, unknown>
    expect(d.recommended).toBe('revise')
    expect(d.rule).toBe('blocking-here')
    expect(d.anchor).toBe('auth-refresh-plan-1 > ## Step: s1')
  })

  it('records the rule the human was actually shown when the verdict was stale', async () => {
    const { repo } = await stopped()
    // A second run whose reviewed sha nothing can reproduce: stale, and with no disposition
    // after it, still pending. Round 2 of 3 keeps it below the bound.
    appendEntry(repo.root, 'auth-refresh-plan-1', {
      v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh-plan-1', round: 2, run_id: 'r-stale',
      reviewed_sha: 'deadbee', prompts_sha: 'ps', witness: '0.11.0', model: 'm', pin: 'm',
      harness: 'claude-code', checks: [], outcome: 'stopped',
      verdicts: [{
        reviewer: 'plan-critic', coverage: [],
        findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'x' }],
      }],
    } as never)
    const r = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    expect(r.code).toBe(0)
    const d = readStream(repo.root, 'auth-refresh-plan-1')
      .filter((e) => e.t === 'human-decision').at(-1)! as unknown as Record<string, unknown>
    expect(d.rule).toBe('stale-below-bound')
    // Option 1 is a gate verb, so `recommendedVerb` finds nothing. Deliberate: journaling
    // `recommended: 'gate'` would count every such decision as overridden (dashboard.ts:90),
    // reporting a working rule as 100% wrong. The cost is that dashboard.ts:85 drops the
    // row — this rule is unauditable under D130, and the spec records that.
    expect(d.recommended).toBeUndefined()
  })

  it('records divergence when the human takes another option', async () => {
    const { repo } = await stopped()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    const d = readStream(repo.root, 'auth-refresh-plan-1')
      .filter((e) => e.t === 'human-decision').at(-1)! as unknown as Record<string, unknown>
    expect(d.decision).toBe('stop')
    expect(d.recommended).toBe('revise')
  })
})

describe('status reports the recommender by rule', () => {
  it('counts firings and overrides, never per-human compliance', async () => {
    const { repo } = await stopped()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    const s = await repo.cli(['status'])
    // below the minimum sample the table is suppressed
    expect(s.stdout).not.toContain('recommender')
    expect(s.stdout).not.toMatch(/followed|compliance/i)
  })

  it('tallies by rule once the sample is reached, most-overridden first', async () => {
    const rows = recommenderRowsFrom([
      { rule: 'reserved-stop-clean', recommended: 'approve', decision: 'stop' },
      { rule: 'reserved-stop-clean', recommended: 'approve', decision: 'stop' },
      { rule: 'reserved-stop-clean', recommended: 'approve', decision: 'stop' },
      { rule: 'reserved-stop-clean', recommended: 'approve', decision: 'approve' },
      { rule: 'reserved-stop-clean', recommended: 'approve', decision: 'approve' },
      { rule: 'blocking-here', recommended: 'revise', decision: 'revise' },
    ])
    expect(rows).toEqual([{ rule: 'reserved-stop-clean', fired: 5, overridden: 3, nodded: 0 }])
  })

  // D143. `selected` exists so closure-by-nod is countable; this is the count.
  it('counts what a nod closed, per rule', () => {
    const rows = recommenderRowsFrom([
      { rule: 'blocking-here', recommended: 'revise', decision: 'revise', selected: 'affirmation' },
      { rule: 'blocking-here', recommended: 'revise', decision: 'revise', selected: 'affirmation' },
      { rule: 'blocking-here', recommended: 'revise', decision: 'revise' },
      { rule: 'blocking-here', recommended: 'revise', decision: 'stop' },
      { rule: 'blocking-here', recommended: 'revise', decision: 'revise' },
    ])
    expect(rows).toEqual([{ rule: 'blocking-here', fired: 5, overridden: 1, nodded: 2 }])
  })

  it('leaves policy decisions out of the audit — they are the rule, not a judgment of it (A5)', () => {
    const five = (selected: string) => Array.from({ length: 5 }, () => ({ rule: 'blocking-here', recommended: 'revise', decision: 'revise', selected }))
    expect(recommenderRowsFrom(five('policy'))).toEqual([])
    expect(recommenderRowsFrom(five('arbiter'))).toEqual([{ rule: 'blocking-here', fired: 5, overridden: 0, nodded: 0 }])
  })
})

// D121's hard constraint: these three fields are recorded and never consumed. A gate
// predicate that read them would make a recommendation change an outcome, which is the one
// thing the recommender must never do.
describe('the new fields are inert', () => {
  it('no gate predicate reads recommended or rule', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url))
    const text = ['rounds.ts', 'gate.ts', 'verbs/next.ts', 'stamp.ts']
      .map((f) => readFileSync(join(src, f), 'utf8')).join('\n')
    const predicates = text.split('\n').filter((l) =>
      /keyOf|roundsSinceApprove|boundReached|repairGranted|appendKind|gateSettled/.test(l))
    expect(predicates.join('\n')).not.toMatch(/\.recommended|\.rule\b/)
  })
})

describe('block properties', () => {
  const states: Array<[string, Entry[], Partial<{ stale: boolean }>]> = [
    ['blocking-here', [run(1, 'a', 'p1 > ## Step: s1')], {}],
    ['blocking-parent', [run(1, 'a', 'auth-refresh > ## Behavior')], {}],
    ['recurrence', [run(1, 'a', 'p1 > ## Step: s1'), run(2, 'b', 'p1 > ## Step: s1')], {}],
    ['bound', [run(1, 'a', 'S'), run(2, 'b', 'S2'), run(3, 'c', 'S3')], {}],
    ['stale-below-bound', [run(1, 'a', 'p1 > ## Step: s1')], { stale: true }],
    ['checks-failed', [failedRun()], {}],
  ]

  it('exactly one rule matches, and every recommendation is runnable', () => {
    for (const [name, entries, over] of states) {
      const d = recommend(ctxFor(entries, over))
      expect(d, name).toBeDefined()
      expect(d!.rule, name).toBeTruthy()
      expect(d!.options[0]!.runnable, name).toBe(true)
      expect(d!.options[0]!.command, name).not.toMatch(/<[^>]+>/)
    }
  })

  it('every option appears once and every deferral names a discharge', () => {
    for (const [name, entries, over] of states) {
      const d = recommend(ctxFor(entries, over))!
      const commands = d.options.map((o) => o.command)
      expect(new Set(commands).size, name).toBe(commands.length)
      for (const o of d.options) {
        if (o.depth === 'deferral') expect(`${o.tradeoff ?? ''}${o.note ?? ''}`, `${name}/${o.command}`).toMatch(/discharge|obligation|until|grant/i)
      }
    }
  })

  it('the recommendation is always a member of the live set', () => {
    for (const [name, entries, over] of states) {
      const d = recommend(ctxFor(entries, over))!
      const live = liveExits('plan', 'p1', entries, over.stale ?? false, 'auth-refresh')
      const flag = d.options[0]!.command.replace('witness decide plan p1 ', '').split(' "')[0]!
      expect(live, name).toContain(flag.split(' ').slice(0, 2).join(' '))
    }
  })

  // The CONVERSE, which the plan did not state and which three shipped omissions lived in:
  // the block replaced the exits line on every surface, so an act liveExits offers and the
  // block does not is an act that became undiscoverable. One deliberate exception, asserted
  // as such rather than waived: below the bound liveExits offers a plain `--approve` and the
  // block offers `--approve --override`, the same act with the D122 ledger switched on.
  it('every act in the live set survives into the block', () => {
    for (const [name, entries, over] of states) {
      const d = recommend(ctxFor(entries, over))!
      const rendered = d.options.map((o) => o.command)
      // liveExits prefixes only its first option: `witness decide … --approve | --revise
      // --note "…" | --stop`, so every later element arrives as bare flags.
      for (const act of liveExits('plan', 'p1', entries, over.stale ?? false, 'auth-refresh').split(' | ')) {
        const full = act.startsWith('witness ') ? act : `witness decide plan p1 ${act}`
        const bare = full.replace(/ --note ".*"$/, ' --note')
        const found = rendered.some((c) => c.replace(/ --note ".*"$/, ' --note') === bare)
        const accounted = bare === 'witness decide plan p1 --approve' &&
          rendered.includes('witness decide plan p1 --approve --override')
        expect(found || accounted, `${name}: ${act}`).toBe(true)
      }
    }
  })
})

const demoted = (round: number, sha: string, anchor: string) => run(round, sha, anchor, {
  verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: false, anchor, claim: 'x', demoted: round - 1 }] }] })

describe('a demoted finding is non-blocking everywhere (C3)', () => {
  it('does not count toward anchor recurrence', () => {
    expect(anchorRecurrence([run(1, 'a', 'S'), demoted(2, 'b', 'S')], 'plan', 'S')).toBe(1)
  })
  it('stays out of the prefilled note', () => {
    expect(notePrefill([demoted(2, 'b', 'S')], 'plan')).toBe('<why>')
  })
  it('a round whose only findings were demoted reads non-blocking-only', () => {
    const d = recommend(ctxFor([run(1, 'a', 'T'), demoted(2, 'b', 'S')]))!
    expect(d.rule).toBe('non-blocking-only')
    expect(d.options[0]!.command).toBe('witness decide plan p1 --approve')
  })
})
