import { describe, expect, it } from 'vitest'
import { cliAct, type Act } from '../src/act.js'
import type { Entry } from '../src/journal.js'
import {
  VALUED_FLAGS, actKey, actLive, boundReached, disposedRun, exitActs, liveActs, reopenActs, roundsSinceApprove, standingHandBack,
  type ActFacts, type GateStateKind, type LiveActs,
} from '../src/rounds.js'
import { decisionAct } from '../src/verbs/decide.js'

// Row 244 (#87, design §4.2.1–§4.2.3, §4.2.5, §4.2.9). One pure derivation gives a gate's state and
// the exact acts that are legal in it, so every screen and `decide` itself read the same list.

const G = 'implement'
const T = 'p1'
const ANCHOR = 'p1 > ## Step: s1'

type Outcome = 'passed' | 'stopped' | 'malformed'
// A round as `gate` journals it. A stopped round carries a blocking finding (the anchor stands); a
// malformed one judged nothing.
const run = (n: number, outcome: Outcome = 'stopped', blocking = outcome === 'stopped'): Entry => ({
  v: 1, t: 'gate-run', gate: G, artifact: T, round: n, run_id: `r${n}`,
  reviewed_sha: `s${n}`, prompts_sha: 'ps', witness: '0', model: 'm',
  checks: outcome === 'passed' ? [{ name: 'c', ok: true }] : [],
  ...(outcome === 'malformed'
    ? { verdicts: [], malformed: [{ reviewer: 'impl-critic', violations: [] }] }
    : { verdicts: [{ reviewer: 'impl-critic', coverage: [], findings: blocking ? [{ blocking: true, anchor: ANCHOR, claim: 'x' }] : [] }] }),
  outcome,
} as unknown as Entry)
const dec = (decision: string, extra: Record<string, unknown> = {}): Entry =>
  ({ v: 1, t: 'human-decision', gate: G, artifact: T, round: 1, decision, ...extra } as unknown as Entry)
const back = (runId: string, gate = G): Entry =>
  ({ v: 1, t: 'revise-returned', gate, artifact: T, run_id: runId, sha: 's1' } as unknown as Entry)
const reopen = { caused_by: { artifact: T, gate: 'ship', round: 1 } }
// A round on the content the revise asked about, the disposed run r1's (every `run` reads its own
// sha): a malformed one there is repaired by the re-gate, so its free re-run leads (P50).
const onR1 = (e: Entry): Entry => ({ ...e, reviewed_sha: 's1' } as unknown as Entry)

// Each state's journal. Upstream `e1` exists, and a blocking finding stands on the anchor.
const j = {
  pending: [run(1)],
  revised: [run(1), dec('revise')],
  revisedUp: [run(1), dec('revise-upstream', { upstream: { artifact: 'e1', gate: 'plan' } })],
  back: [run(1), dec('revise'), back('r1')],
  revisedAtBound: [run(1), dec('revise'), run(2), dec('revise'), run(3), dec('revise', reopen)],
  approved: [run(1), dec('approve', { override: true })],
  passed: [run(1, 'passed')],
  retracted: [run(1), dec('approve', { override: true }), dec('revise', { note: 'the stamp was wrong' })],
  parked: [run(1), dec('stop')],
  revisedThenMalformed: [run(1), dec('revise'), onR1(run(2, 'malformed'))],
}
const BOUND = [run(1), dec('revise'), run(2), dec('revise'), run(3)]

const facts: ActFacts = { upstream: 'e1', stale: false, holdLifted: false, owed: false, upstreamOwed: false, checksMoved: false }
const live = (entries: Entry[], f: Partial<ActFacts> = {}) => liveActs(G, T, entries, { ...facts, ...f })
// argv holds no `witness`, so the whole argv is the command after it.
const shown = (acts: readonly Act[]) => acts.map((a) => a.argv.join(' '))
const key = (...rest: string[]) => actKey(['decide', G, T, ...rest])

const A = (...xs: string[]) => xs
const REVISED = A('decide implement p1 --approve --override', 'decide implement p1 --stop', 'decide implement p1 --revise --upstream e1',
  'gate implement p1 --fresh', 'decide implement p1 --revise --note <why>')

// The table of design §4.2.2.
const CASES: Array<[string, Entry[], Partial<ActFacts>, GateStateKind, string[]]> = [
  ['pending', j.pending, {}, 'pending',
    A('decide implement p1 --approve', 'decide implement p1 --revise', 'decide implement p1 --revise --upstream e1', 'decide implement p1 --stop')],
  ['pending, stale', j.pending, { stale: true }, 'pending',
    A('gate implement p1', 'decide implement p1 --revise', 'decide implement p1 --revise --upstream e1', 'decide implement p1 --stop')],
  ['revised (after a stop, after a malformed round, repair, un-park, reopen by caused_by)', j.revised, {}, 'revised', REVISED],
  ['revised, the author edited', j.revised, { stale: true }, 'revised', A('gate implement p1')],
  ['revised, the latest revise upstream', j.revisedUp, {}, 'revised',
    A('decide implement p1 --approve --override', 'decide implement p1 --stop', 'gate implement p1 --fresh', 'decide implement p1 --revise --note <why>')],
  ['handed back', j.back, {}, 'handed-back', REVISED],
  ['handed back, content moved', j.back, { stale: true }, 'handed-back-moved',
    A('gate implement p1', 'decide implement p1 --stop', 'decide implement p1 --revise --upstream e1', 'decide implement p1 --revise --note <why>')],
  ['handed back, a hold lifted', j.back, { holdLifted: true }, 'handed-back-moved',
    A('gate implement p1', 'decide implement p1 --stop', 'decide implement p1 --revise --upstream e1', 'decide implement p1 --revise --note <why>')],
  ['revised at the bound', j.revisedAtBound, {}, 'at-bound',
    A('decide implement p1 --approve --override', 'decide implement p1 --revise --upstream e1', 'decide implement p1 --revise --repair',
      'decide implement p1 --stop', 'abandon p1')],
  ['settled by an approve', j.approved, {}, 'settled', A('decide implement p1 --revise --note <why>')],
  ['settled by a pass', j.passed, {}, 'settled', A('decide implement p1 --revise --note <why>')],
  ['retracted', j.retracted, {}, 'retracted',
    A('gate implement p1 --fresh', 'decide implement p1 --approve --override', 'decide implement p1 --stop', 'decide implement p1 --revise --note <why>')],
  ['parked, nothing owed', j.parked, {}, 'parked', A('decide implement p1 --revise --note <why>', 'gate implement p1 --fresh')],
  ['parked, work owed', j.parked, { owed: true }, 'parked', A('decide implement p1 --revise --note <why>')],
]

describe('liveActs: what each state offers (design §4.2.2)', () => {
  it.each(CASES)('%s', (_n, entries, f, state, acts) => {
    const l = live(entries, f)
    expect(l.state).toBe(state)
    expect(shown(l.acts)).toEqual(acts)
  })

  it('a malformed round after the revise keeps the offers and leads with the free re-run', () => {
    const l = live(j.revisedThenMalformed)
    expect(l.state).toBe('revised')
    expect(l.malformedRerun).toBe(true)
    expect(l.acts[0]!.argv.join(' ')).toBe('gate implement p1')
    expect(shown(l.acts.slice(1))).toEqual(REVISED)
  })

  // Row 239: every act a row offers is one the act renderers built, so its line pastes as its argv.
  it('every act is the act renderer\'s own', () => {
    for (const [, entries, f] of CASES) {
      for (const a of live(entries, f).acts) expect(a).toEqual(cliAct(...a.argv))
    }
  })
})

describe('the revised state, however the revise came (design §4.2.3, P24)', () => {
  const VARIANTS: Array<[string, Entry[], string]> = [
    ['after a stop', [run(1), dec('stop', { selected: 'arbiter' }), dec('revise', { note: 'try again' })], 'r1'],
    ['after a malformed round', [run(1), run(2, 'malformed'), dec('revise')], 'r1'],
    // #87's journal: the bound, the arbiter's stop, a human's repair, the content unchanged.
    ['a repair', [...BOUND, dec('stop', { selected: 'arbiter', rule: 'bound' }), dec('revise', { repair: true, selected: 'affirmation', rule: 'bound' })], 'r3'],
    ['an un-park', [run(1), dec('stop'), dec('revise', { unpark: true, note: 'go on' })], 'r1'],
    ['a reopen by caused_by, after an approve', [run(1), dec('approve', { override: true }), dec('revise', reopen)], 'r1'],
  ]
  it.each(VARIANTS)('%s', (_n, entries, anchor) => {
    const l = live(entries)
    expect(l.state).toBe('revised')
    expect(l.anchor?.run_id).toBe(anchor)
    expect(l.malformedRerun).toBe(false)
    expect(shown(l.acts)).toEqual(REVISED)
  })
})

describe('the pairing (design §4.2.3)', () => {
  it('the pairing skips malformed runs: a revise after a malformed round disposes of the run before it (P45, P50)', () => {
    const before = [run(1), run(2, 'malformed'), dec('revise')]
    expect(disposedRun(before, G)?.run.run_id).toBe('r1')
    expect(disposedRun(before, G)?.at).toBe(0)
    expect(live(before).anchor?.run_id).toBe('r1')
    expect(live(before).malformedRerun).toBe(false)
    // A malformed round after the revise judged nothing either: the revise still pairs with r1.
    expect(disposedRun(j.revisedThenMalformed, G)).toEqual({ run: j.revisedThenMalformed[0], at: 0 })
    expect(live(j.revisedThenMalformed).anchor?.run_id).toBe('r1')
  })

  it('pairs with the gate\'s latest revise, and with nothing where no revise or no judged run comes before it', () => {
    expect(disposedRun([run(1), dec('revise'), run(2), dec('revise')], G)).toMatchObject({ run: { run_id: 'r2' }, at: 2 })
    expect(disposedRun(j.pending, G)).toBeUndefined()
    expect(disposedRun(j.approved, G)).toBeUndefined()
    expect(disposedRun([run(1, 'malformed'), dec('revise', reopen)], G)).toBeUndefined()
    // another gate's revise is not this gate's
    expect(disposedRun([run(1), { ...dec('revise'), gate: 'plan' } as Entry], G)).toBeUndefined()
  })

  it('the revised family\'s anchor is the disposed run; the other states anchor on the last run that judged something', () => {
    expect(live(j.pending).anchor?.run_id).toBe('r1')
    expect(live([run(1), run(2, 'malformed')]).anchor?.run_id).toBe('r1')
    expect(live(j.back).anchor?.run_id).toBe('r1')
    expect(live(j.retracted).anchor?.run_id).toBe('r1')
    expect(live(j.parked).anchor?.run_id).toBe('r1')
    expect(live(j.approved).anchor?.run_id).toBe('r1')
    expect(live([...BOUND, run(4, 'malformed')]).anchor?.run_id).toBe('r3')
    expect(live([]).anchor).toBeUndefined()
    expect(live([run(1, 'malformed')]).anchor).toBeUndefined()
  })
})

describe('the standing hand-back (design §4.2.5)', () => {
  it('a hand-back ends at a later non-malformed run or any later disposition; a malformed run leaves it standing (P33)', () => {
    expect(standingHandBack(j.back, G)).toEqual(j.back[2])
    expect(live(j.back).state).toBe('handed-back')

    const malformed = [...j.back, onR1(run(2, 'malformed'))]
    expect(standingHandBack(malformed, G)).toEqual(j.back[2])
    expect(live(malformed).state).toBe('handed-back')
    expect(live(malformed).malformedRerun).toBe(true)
    expect(shown(live(malformed).acts)).toEqual(['gate implement p1', ...REVISED])

    const ran = [...j.back, run(2)]
    expect(standingHandBack(ran, G)).toBeUndefined()
    expect(live(ran).state).toBe('pending')

    const ends: Array<[Entry, GateStateKind]> = [
      [dec('approve', { override: true }), 'settled'],
      [dec('stop'), 'parked'],
      [dec('revise', { note: 'change the expiry' }), 'revised'],
      [dec('revise', reopen), 'revised'],
    ]
    for (const [later, state] of ends) {
      expect(standingHandBack([...j.back, later], G)).toBeUndefined()
      expect(live([...j.back, later]).state).toBe(state)
    }
  })

  it('stands only for the disposed run, for this gate, and after the revise', () => {
    expect(standingHandBack([run(1), dec('revise'), back('r9')], G)).toBeUndefined()
    expect(live([run(1), dec('revise'), back('r9')]).state).toBe('revised')
    expect(standingHandBack([run(1), dec('revise'), back('r1', 'plan')], G)).toBeUndefined()
    expect(standingHandBack([run(1), back('r1'), dec('revise')], G)).toBeUndefined()
    // a run that judged something between the revise and the hand-back answered the revise
    expect(standingHandBack([run(1), dec('revise'), run(2), back('r1')], G)).toBeUndefined()
    // after a malformed round the revise disposes of the run before it, and the hand-back names that one
    const pairedPast = [run(1), run(2, 'malformed'), dec('revise'), back('r1')]
    expect(standingHandBack(pairedPast, G)).toEqual(pairedPast[3])
    expect(live(pairedPast).state).toBe('handed-back')
    expect(live(pairedPast).malformedRerun).toBe(false)
  })
})

describe('membership (design §4.2.1)', () => {
  it('notes, --pin, --via and --trust-cmds never count; a note that reads like a flag is a note', () => {
    expect(key('--revise', '--note', 'change it')).toBe(key('--revise'))
    expect(key('--revise', '--note', '<why>')).toBe(key('--revise'))
    expect(key('--revise', '--note', '--override')).toBe(key('--revise'))
    expect(key('--approve', '--trust-cmds')).toBe(key('--approve'))
    expect(key('--approve', '--via', 'affirmation')).toBe(key('--approve'))
    expect(key('--approve', '--pin', 'always --override')).toBe(key('--approve'))
    expect(actKey(['gate', G, T, '--manual'])).toBe(actKey(['gate', G, T]))
  })

  it('--override, --repair and --upstream count for decide, and --fresh and --unchanged for gate', () => {
    expect(key('--approve', '--override')).not.toBe(key('--approve'))
    expect(key('--revise', '--repair')).not.toBe(key('--revise'))
    expect(key('--revise', '--upstream', 'e1')).not.toBe(key('--revise'))
    // the upstream's value is not part of the act
    expect(key('--revise', '--upstream', 'e1')).toBe(key('--revise', '--upstream', '<effort>'))
    // `decide` reads an upstream only through its value: a trailing `--upstream` with none is a plain revise
    expect(key('--revise', '--upstream')).toBe(key('--revise'))
    expect(actLive(live(j.revisedAtBound), key('--revise', '--upstream'))).toBe(false)
    expect(actKey(['gate', G, T, '--fresh'])).not.toBe(actKey(['gate', G, T]))
    expect(actKey(['gate', G, T, '--unchanged'])).not.toBe(actKey(['gate', G, T]))
    expect(actKey(['gate', G, T, '--unchanged'])).not.toBe(actKey(['gate', G, T, '--fresh']))
    expect(key('--override', '--approve')).toBe(key('--approve', '--override'))
  })

  // `decisionAct` and verbs/gate.ts read their gate and target and ignore a positional word after them,
  // so a stray word makes no other act: accepted as it always was, never a new refusal.
  it('reads only the gate and the target of decide and gate, as their parsers do', () => {
    expect(actKey(['decide', G, T, 'stray', '--approve'])).toBe(key('--approve'))
    expect(actKey(['decide', G, T, '--approve', 'stray'])).toBe(key('--approve'))
    expect(actKey(['gate', G, T, 'stray', '--fresh'])).toBe(actKey(['gate', G, T, '--fresh']))
    expect(actLive(live(j.pending), actKey(['decide', G, T, 'stray', '--approve']))).toBe(true)
    expect(decisionAct([G, T, 'stray', '--approve'])).toEqual({ ok: true, value: { gate: G, target: T, decision: 'approve' } })
    // abandon reads every target it names (D190)
    expect(actKey(['abandon', 'e1', 'e2'])).not.toBe(actKey(['abandon', 'e1']))
  })

  // One valued-flags set for decide's parser and for actKey: a word after any of them is its value.
  it.each([...VALUED_FLAGS])('decide\'s parser and actKey both read the word after %s as its value', (flag) => {
    const counted = flag === '--upstream' || flag === '--book'
    expect(actKey(['decide', G, T, '--revise', flag, '--approve'])).toBe(actKey(['decide', G, T, '--revise', ...(counted ? [flag, 'x'] : [])]))
    const parsed = decisionAct([G, T, '--revise', flag, '--approve'])
    // Row 270: `--book` is a decision of its own, so beside `--revise` it makes two — never a third
    // from the word after it.
    if (flag === '--book') expect(parsed.ok ? '' : parsed.violations[0]!.got).toBe('--revise --book')
    else expect(parsed.ok ? parsed.value.decision : parsed.violations[0]!.rule).not.toBe('one-of-required')
  })

  it('names the verb, the gate and the target, and reads an act as its argv', () => {
    expect(key('--approve')).not.toBe(key('--stop'))
    expect(key('--approve')).not.toBe(actKey(['decide', 'plan', T, '--approve']))
    expect(key('--approve')).not.toBe(actKey(['decide', G, 'p2', '--approve']))
    expect(actKey(['abandon', T])).not.toBe(actKey(['abandon', 'p2']))
    expect(actKey(cliAct('decide', G, T, '--revise', '--note', '<why>'))).toBe(key('--revise'))
    expect(actKey(cliAct('abandon', T))).toBe(actKey(['abandon', T]))
  })

  it('actLive accepts every listed act and refuses the rest', () => {
    const l = live(j.revised)
    for (const a of l.acts) expect(actLive(l, actKey(a))).toBe(true)
    expect(actLive(l, key('--revise'))).toBe(true)          // the bare revise is the noted one's act; decide asks for the note
    expect(actLive(l, actKey(['gate', G, T]))).toBe(false)   // changed-nothing: not offered on unchanged content
    expect(actLive(l, key('--revise', '--repair'))).toBe(false)
    expect(actLive(l, actKey(['abandon', T]))).toBe(false)
    expect(actLive(live(j.approved), key('--approve'))).toBe(false)
    expect(actLive(live([]), key('--approve'))).toBe(false)
  })

  it('below the bound, plain --approve is live wherever --approve --override is offered (D122)', () => {
    for (const entries of [j.revised, j.back, j.retracted, j.revisedThenMalformed]) {
      const l = live(entries)
      expect(shown(l.acts)).toContain('decide implement p1 --approve --override')
      expect(shown(l.acts)).not.toContain('decide implement p1 --approve')
      expect(actLive(l, key('--approve'))).toBe(true)
      expect(actLive(l, key('--approve', '--override'))).toBe(true)
    }
    // and the other way round: the pending screen lists the plain spelling, and the accounted one is the same act
    expect(actLive(live(j.pending), key('--approve', '--override'))).toBe(true)
    // at the bound only the accounted spelling is live
    const bound = live(j.revisedAtBound)
    expect(actLive(bound, key('--approve', '--override'))).toBe(true)
    expect(actLive(bound, key('--approve'))).toBe(false)
    // on moved content neither spelling is
    expect(actLive(live(j.pending, { stale: true }), key('--approve'))).toBe(false)
    expect(actLive(live(j.pending, { stale: true }), key('--approve', '--override'))).toBe(false)
    expect(actLive(live(j.back, { stale: true }), key('--approve', '--override'))).toBe(false)
  })

  it('approves with the plain spelling where no blocking finding stands', () => {
    const fromPass = [run(1, 'passed'), dec('revise', { note: 'the pass missed the expiry' })]
    expect(live(fromPass).state).toBe('retracted')
    expect(shown(live(fromPass).acts)).toEqual(A('gate implement p1 --fresh', 'decide implement p1 --approve',
      'decide implement p1 --stop', 'decide implement p1 --revise --note <why>'))
    expect(actLive(live(fromPass), key('--approve', '--override'))).toBe(true)
  })
})

describe('the upstream ladder (D123)', () => {
  const spent = [run(1), dec('revise-upstream', { upstream: { artifact: 'e1', gate: 'plan' }, anchor: ANCHOR }), run(2), dec('revise')]

  it('no send-upstream once ladderSpent(primary)', () => {
    const states: Array<[Entry[], Partial<ActFacts>, GateStateKind]> = [
      [spent, {}, 'revised'],
      [[...spent, back('r2')], {}, 'handed-back'],
      [[...spent, back('r2')], { stale: true }, 'handed-back-moved'],
    ]
    for (const [entries, f, state] of states) {
      const l = live(entries, f)
      expect(l.state).toBe(state)
      expect(shown(l.acts).some((a) => a.includes('--upstream'))).toBe(false)
      expect(actLive(l, key('--revise', '--upstream', 'e1'))).toBe(false)
    }
  })

  it('a spent ladder for another anchor leaves this one\'s upstream', () => {
    const other = [run(1), dec('revise-upstream', { upstream: { artifact: 'e1', gate: 'plan' }, anchor: 'p1 > ## Other' }), run(2), dec('revise')]
    expect(shown(live(other).acts)).toContain('decide implement p1 --revise --upstream e1')
  })

  it('no send-upstream where no parent resolves', () => {
    expect(shown(live(j.revised, { upstream: undefined }).acts).some((a) => a.includes('--upstream'))).toBe(false)
    expect(shown(live(j.back, { upstream: undefined, stale: true }).acts)).toEqual(
      A('gate implement p1', 'decide implement p1 --stop', 'decide implement p1 --revise --note <why>'))
  })
})

describe('corner states (design §4.2.9)', () => {
  it('only malformed rounds: pending, the re-run alone, led by the free re-run', () => {
    const l = live([run(1, 'malformed')])
    expect(l.state).toBe('pending')
    expect(shown(l.acts)).toEqual(['gate implement p1'])
    expect(l.malformedRerun).toBe(true)
  })

  it('abandon-effort as the last disposition, or no run at all: none, no acts', () => {
    const effortEnd = { v: 1, t: 'human-decision', gate: 'effort', artifact: T, round: 0, decision: 'abandon-effort' } as unknown as Entry
    for (const entries of [[run(1), effortEnd], [run(1), dec('abandon-effort')], [...j.revised, effortEnd], []]) {
      const l = live(entries)
      expect(l.state).toBe('none')
      expect(l.acts).toEqual([])
      expect(l.malformedRerun).toBe(false)
    }
  })

  it('retracted on moved content: the plain re-gate, park and revise again — the approve is a stale verdict', () => {
    expect(live(j.retracted, { stale: true }).state).toBe('retracted')
    expect(shown(live(j.retracted, { stale: true }).acts)).toEqual(
      A('gate implement p1', 'decide implement p1 --stop', 'decide implement p1 --revise --note <why>'))
    expect(shown(live(j.retracted, { holdLifted: true }).acts)).toEqual(
      A('gate implement p1', 'decide implement p1 --stop', 'decide implement p1 --revise --note <why>'))
  })

  it('revised with a lifted hold reads like moved content', () => {
    expect(live(j.revised, { holdLifted: true }).state).toBe('revised')
    expect(shown(live(j.revised, { holdLifted: true }).acts)).toEqual(['gate implement p1'])
  })

  it('settled, content moved since the approve or the pass: the re-gate (D75)', () => {
    expect(shown(live(j.approved, { stale: true }).acts)).toEqual(['gate implement p1'])
    expect(shown(live(j.passed, { stale: true }).acts)).toEqual(['gate implement p1'])
    expect(live(j.passed, { stale: true }).state).toBe('settled')
  })

  it('the malformed lead applies in pending, revised, handed back (both) and retracted', () => {
    const m = onR1(run(9, 'malformed'))
    // The pending revise is `reviseAct`'s, whose prefill reads the gate's last run: after a malformed
    // round it keeps the `<why>` slot, as `exitActs` and `decide`'s journaled note do (one act either way).
    const lead: Array<[Entry[], Partial<ActFacts>, GateStateKind, string[]]> = [
      [[...j.pending, m], {}, 'pending', ['gate implement p1', 'decide implement p1 --approve', 'decide implement p1 --revise --note <why>',
        'decide implement p1 --revise --upstream e1', 'decide implement p1 --stop']],
      [[...j.pending, m], { stale: true }, 'pending', ['gate implement p1', 'decide implement p1 --revise --note <why>',
        'decide implement p1 --revise --upstream e1', 'decide implement p1 --stop']],
      [[...j.revised, m], {}, 'revised', ['gate implement p1', ...REVISED]],
      [[...j.revised, m], { stale: true }, 'revised', ['gate implement p1']],
      [[...j.back, m], {}, 'handed-back', ['gate implement p1', ...REVISED]],
      [[...j.back, m], { stale: true }, 'handed-back-moved', ['gate implement p1', 'decide implement p1 --stop',
        'decide implement p1 --revise --upstream e1', 'decide implement p1 --revise --note <why>']],
      [[...j.retracted, m], {}, 'retracted', ['gate implement p1', 'gate implement p1 --fresh',
        'decide implement p1 --approve --override', 'decide implement p1 --stop', 'decide implement p1 --revise --note <why>']],
    ]
    for (const [entries, f, state, acts] of lead) {
      const l = live(entries, f)
      expect(l.state).toBe(state)
      expect(l.malformedRerun).toBe(true)
      expect(shown(l.acts)).toEqual(acts)
    }
  })

  // S3-3. A malformed round after the revise on other content judged nothing and leaves the pairing
  // with the disposed run: with the content back on that run's, the re-gate answers changed-nothing,
  // so no state leads with it, and each keeps its own acts. Moved content, or a disposed run that fell
  // back, pairs with nothing, and the re-gate runs: the lead stays.
  it('a malformed round on other content after the revise leads with nothing (S3-3)', () => {
    const m = run(9, 'malformed')
    const none: Array<[Entry[], GateStateKind, string[]]> = [
      [[...j.revised, m], 'revised', REVISED],
      [[...j.back, m], 'handed-back', REVISED],
      [[...j.retracted, m], 'retracted', A('gate implement p1 --fresh', 'decide implement p1 --approve --override',
        'decide implement p1 --stop', 'decide implement p1 --revise --note <why>')],
      [[run(1, 'passed'), dec('revise', { note: 'the pass was wrong' }), m], 'retracted', A('gate implement p1 --fresh',
        'decide implement p1 --approve', 'decide implement p1 --stop', 'decide implement p1 --revise --note <why>')],
    ]
    for (const [entries, state, acts] of none) {
      const l = live(entries)
      expect(l.state).toBe(state)
      expect(l.malformedRerun).toBe(false)
      expect(shown(l.acts)).toEqual(acts)
    }
    for (const entries of [[...j.revised, m], [...j.back, m], [...j.retracted, m]]) {
      expect(live(entries, { stale: true }).malformedRerun).toBe(true)
      expect(live(entries, { holdLifted: true }).malformedRerun).toBe(true)
    }
    const fellBack = [{ ...run(1), pin: 'another-model' } as unknown as Entry, dec('revise'), m]
    expect(live(fellBack).malformedRerun).toBe(true)
    expect(shown(live(fellBack).acts)[0]).toBe('gate implement p1')
  })

  it('the malformed lead never applies at the bound, settled or parked (S2-2)', () => {
    const m = run(9, 'malformed')
    const none: Array<[Entry[], GateStateKind]> = [
      [[...BOUND, m], 'at-bound'],
      [[...j.revisedAtBound, m], 'at-bound'],
      [[...j.approved, m], 'settled'],
      [[...j.passed, m], 'settled'],
      [[...j.parked, m], 'parked'],
    ]
    for (const [entries, state] of none) {
      const l = live(entries)
      expect(l.state).toBe(state)
      expect(l.malformedRerun).toBe(false)
      expect(shown(l.acts)).toEqual(shown(live(entries.slice(0, -1)).acts))
    }
  })

  it('a pending stop at the bound is the endgame (D67)', () => {
    const l = live(BOUND)
    expect(l.state).toBe('at-bound')
    expect(l.anchor?.run_id).toBe('r3')
    expect(shown(l.acts)).toEqual(A('decide implement p1 --approve --override', 'decide implement p1 --revise --upstream e1',
      'decide implement p1 --revise --repair', 'decide implement p1 --stop', 'abandon p1'))
    // the repair grant is an exit while it is unspent
    const repaired = [...BOUND, dec('revise', { repair: true }), run(4)]
    expect(live(repaired).state).toBe('at-bound')
    expect(shown(live(repaired).acts)).not.toContain('decide implement p1 --revise --repair')
  })

  it('a gate parked at the bound offers the endgame, and no approve on moved content (S2-5)', () => {
    const parkedAtBound = [...BOUND, dec('stop', { selected: 'arbiter', rule: 'bound' })]
    expect(live(parkedAtBound).state).toBe('parked')
    expect(shown(live(parkedAtBound).acts)).toEqual(shown(live(BOUND).acts))
    expect(shown(live(parkedAtBound, { stale: true }).acts)).toEqual(A('decide implement p1 --revise --upstream e1',
      'decide implement p1 --revise --repair', 'decide implement p1 --stop', 'abandon p1'))
    expect(actLive(live(parkedAtBound), key('--approve'))).toBe(false)
  })

  it('a stop after a pass reads parked', () => {
    expect(live([run(1, 'passed'), dec('stop')]).state).toBe('parked')
  })
})

// Row 244 (Task 10): both are views over liveActs.
describe('exitActs and reopenActs share liveActs\' own sets', () => {
  it('pending and at the bound, exitActs; parked, reopenActs', () => {
    expect(live(j.pending).acts).toEqual(exitActs(G, T, j.pending, false, 'e1'))
    expect(live(j.pending, { stale: true }).acts).toEqual(exitActs(G, T, j.pending, true, 'e1'))
    expect(live(BOUND).acts).toEqual(exitActs(G, T, BOUND, false, 'e1'))
    expect(live(BOUND, { stale: true }).acts).toEqual(exitActs(G, T, BOUND, true, 'e1'))
    expect(live(j.parked).acts).toEqual(reopenActs(G, T, j.parked, false, 'e1', false))
    expect(live(j.parked, { owed: true }).acts).toEqual(reopenActs(G, T, j.parked, false, 'e1', true))
    const parkedAtBound = [...BOUND, dec('stop')]
    expect(live(parkedAtBound).acts).toEqual(reopenActs(G, T, parkedAtBound, false, 'e1', false))
    expect(live(parkedAtBound, { stale: true }).acts).toEqual(reopenActs(G, T, parkedAtBound, true, 'e1', false))
  })
})

// Row 264 (§3.2). A checks-only round: a withholding check was red, so no lens ran.
const only = (n: number): Entry => ({ ...(run(n) as object), checks_only: true, verdicts: undefined, checks: [{ name: 'lint', ok: false }] } as unknown as Entry)

describe('a checks-only round (row 264)', () => {
  it('a checks-only round spends none of the human\'s budget, a repair grant included (row 264)', () => {
    expect(roundsSinceApprove([run(1), run(2), only(3), only(3)], G)).toBe(2)
    expect(boundReached([run(1), run(2), only(3), only(3)], G)).toBe(false)
    const granted = [run(1), run(2), run(3), dec('revise', { repair: true }), only(4)]
    expect(roundsSinceApprove(granted, G)).toBe(3)
    expect(boundReached(granted, G)).toBe(false)                 // the granted round is still the next judged one
  })
  it('no approve is live on a checks-only round, in any state (row 264)', () => {
    const approves = (l: LiveActs) => [...l.acts, ...(l.slots ?? [])].filter((a) => a.argv.includes('--approve'))
    expect(approves(liveActs(G, T, [only(1)], facts))).toEqual([])
    expect(approves(liveActs(G, T, [only(1), dec('revise')], facts))).toEqual([])
    expect(liveActs(G, T, [only(1)], { ...facts, stale: true }).acts[0]!.line).toBe('witness gate implement p1')
  })
})

describe('a booking (row 270)', () => {
  // A checks-only round whose lint part is not judged: bookable, its waiver the human's.
  const bk = (n: number): Entry => ({
    ...(only(n) as object),
    checks: [{ name: 'markers', ok: true }, { name: 'lint', ok: false, parts: [{ part: 'ui', state: 'not-judged', key: `ui@${'a'.repeat(40)}.000000000000` }] }],
  } as unknown as Entry)
  const book = 'witness decide implement p1 --book lint'
  const lines = (l: LiveActs) => l.acts.map((a) => a.line)
  it('--book is live on a checks-only anchor with a bookable lint part in pending, revised, handed-back and parked, never on moved content; a booking leaves state booked whose one act is the re-gate (row 270)', () => {
    for (const es of [[bk(1)], [bk(1), dec('revise')], [bk(1), dec('revise'), back('r1')], [bk(1), dec('stop')]]) {
      const l = liveActs(G, T, es, facts)
      expect([l.state, lines(l)]).toEqual([l.state, expect.arrayContaining([book])])
    }
    expect(liveActs(G, T, [bk(1)], facts).state).toBe('pending')
    expect(liveActs(G, T, [bk(1), dec('revise'), back('r1')], facts).state).toBe('handed-back')
    expect(liveActs(G, T, [bk(1), dec('stop')], facts).state).toBe('parked')
    expect(lines(liveActs(G, T, [bk(1)], { ...facts, stale: true }))).not.toContain(book)
    expect(lines(liveActs(G, T, [bk(1)], { ...facts, checksMoved: true }))).not.toContain(book)
    const markers = { ...(only(1) as object), checks: [{ name: 'markers', ok: false }] } as unknown as Entry
    expect(lines(liveActs(G, T, [markers], facts)).some((l) => l.includes('--book'))).toBe(false)
    expect(lines(liveActs(G, T, [only(1)], facts)).some((l) => l.includes('--book'))).toBe(false)   // a lint part-less run
    const booked = liveActs(G, T, [bk(1), dec('book', { book: { check: 'lint', items: ['l-00000001'] } })], facts)
    expect([booked.state, lines(booked)]).toEqual(['booked', ['witness gate implement p1']])
    expect(actLive(liveActs(G, T, [bk(1)], facts), actKey(['decide', G, T, '--book', 'lint']))).toBe(true)
  })
})

describe('a base result landed since a checks-only round (row 267)', () => {
  it('a base result landed since the round leads its stop with the re-gate (row 267)', () => {
    expect(liveActs(G, T, [only(1)], { ...facts, checksMoved: true }).acts[0]!.line).toBe('witness gate implement p1')
    expect(liveActs(G, T, [only(1)], facts).acts[0]!.line).toBe('witness decide implement p1 --revise')
  })
})

// Row 274 (C26). A round the lenses ran whose only reds are the judge's to book offers the booking.
describe('a switch-off booking is live (row 274)', () => {
  const OFF = { name: 'switch-offs', ok: false, offs: [{ key: 'k1', token: '@ts-ignore', file: 'src/a.ts', line: 1, count: 1 }] }
  const judgedRun = (n: number, checks: unknown[], blocking = false): Entry => ({
    ...(run(n, 'stopped', blocking) as object), checks,
  } as unknown as Entry)
  const book = key('--book', 'switch-offs')
  it('a judged anchor whose only red is switch-offs offers --book switch-offs; pending and revised alike', () => {
    expect(actLive(live([judgedRun(1, [{ name: 'diff', ok: true }, OFF])]), book)).toBe(true)
    expect(actLive(live([judgedRun(1, [OFF]), dec('revise')]), book)).toBe(true)
  })
  it('not beside a blocking finding, a second red check, on moved content, at the bound, or once all is booked', () => {
    expect(actLive(live([judgedRun(1, [OFF], true)]), book)).toBe(false)
    expect(actLive(live([judgedRun(1, [OFF, { name: 'evidence', ok: false }])]), book)).toBe(false)
    expect(actLive(live([judgedRun(1, [OFF])], { stale: true }), book)).toBe(false)
    expect(actLive(live([...BOUND.slice(0, -1), judgedRun(3, [OFF])]), book)).toBe(false)
    expect(actLive(live([judgedRun(1, [{ ...OFF, offs: [{ ...OFF.offs[0], booked: 1, items: ['l-00000001'] }] }])]), book)).toBe(false)
  })
})
