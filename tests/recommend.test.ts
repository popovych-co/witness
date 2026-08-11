import { describe, expect, it } from 'vitest'
import type { Entry } from '../src/journal.js'
import { recommend, renderDecision, type Decision } from '../src/recommend.js'
import { anchorRecurrence, ladderSpent } from '../src/rounds.js'
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'

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
  harness: 'claude-code', calibration: 'none', checks: [], outcome: 'stopped',
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

const ctxFor = (entries: Entry[], over: Partial<{ upstream: string; stale: boolean }> = {}) => ({
  gate: 'plan', target: 'p1', entries, upstream: over.upstream ?? 'auth-refresh', stale: over.stale ?? false,
})

describe('the rule table is ordered and total', () => {
  it('blocking-here: one blocking finding anchored in this artifact', () => {
    const d = recommend(ctxFor([run(1, 'a', 'p1 > ## Step: s1')]))!
    expect(d.rule).toBe('blocking-here')
    expect(d.options[0]!.command).toContain('--revise --note')
    expect(d.options[0]!.depth).toBe('root')
    expect(d.anchor).toBe('p1 > ## Step: s1')
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

const BLOCKING_VERDICT = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'step is untestable' }],
}

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
