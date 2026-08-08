import { describe, expect, it } from 'vitest'
import type { Entry } from '../src/journal.js'
import {
  ROUND_BOUND, appendKind, boundReached, fellBack, keyOf, pendingDecision, roundsSinceApprove,
  runsSinceReset, sameKey, type GateRunEntry,
} from '../src/rounds.js'

const MODEL = 'm1'
const KEY = { gate: 'plan', prompts_sha: 'p1', pin: MODEL, witness: '0.1.0', harness: 'claude-code' }

// No `pin` by default: this is the shape of every journal written before 0.8.0, which
// is what the `pin ?? model` migration has to read identically. Fallen-back rounds pass
// `{ pin, model }` explicitly.
function run(sha: string, outcome: 'passed' | 'stopped' | 'malformed', round: number, extra: Partial<GateRunEntry> = {}): GateRunEntry {
  return {
    v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh-plan-1', round,
    run_id: `r-${round}`, reviewed_sha: sha, prompts_sha: KEY.prompts_sha,
    witness: KEY.witness, model: MODEL, calibration: 'none',
    checks: [], verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [] }],
    outcome, ...extra,
  }
}
const revise = (round: number): Entry => ({
  v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-1', round, decision: 'revise',
} as Entry)
const approve = (round: number): Entry => ({
  v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-1', round, decision: 'approve',
} as Entry)
const decide = (decision: 'revise-upstream' | 'stop', round = 1): Entry => ({
  v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-1', round, decision,
} as Entry)
const key = (sha: string) => ({ reviewed_sha: sha, ...KEY })

describe('roundsSinceApprove', () => {
  it('counts gate-run entries, resetting at approve decisions and passed outcomes', () => {
    expect(roundsSinceApprove([run('a', 'stopped', 1), run('b', 'stopped', 2)], 'plan')).toBe(2)
    expect(roundsSinceApprove([run('a', 'stopped', 1), approve(1), run('b', 'stopped', 1)], 'plan')).toBe(1)
    expect(roundsSinceApprove([run('a', 'passed', 1)], 'plan')).toBe(0)
    expect(roundsSinceApprove([run('a', 'stopped', 1)], 'ship')).toBe(0)
  })

  it('exports the bound as a constant', () => {
    expect(ROUND_BOUND).toBe(3)
  })

  it('malformed runs do not count toward the bound — the battery failed, not the artifact', () => {
    const entries = [run('a', 'stopped', 1), run('b', 'malformed', 2), run('c', 'stopped', 2)]
    expect(roundsSinceApprove(entries, 'plan')).toBe(2)
    expect(boundReached(entries, 'plan')).toBe(false)
    expect(boundReached([...entries, run('d', 'stopped', 3)], 'plan')).toBe(true)
  })

  it('revise-upstream resets the budget — a new plan version is a new game', () => {
    const three = [run('a', 'stopped', 1), revise(1), run('b', 'stopped', 2), revise(2), run('c', 'stopped', 3)]
    expect(boundReached(three, 'plan')).toBe(true)
    const reopened = [...three, decide('revise-upstream', 3)]
    expect(roundsSinceApprove(reopened, 'plan')).toBe(0)
    expect(boundReached(reopened, 'plan')).toBe(false)
  })

  it('stop and plain revise do not reset', () => {
    expect(roundsSinceApprove([run('a', 'stopped', 1), decide('stop'), run('b', 'stopped', 2)], 'plan')).toBe(2)
    expect(roundsSinceApprove([run('a', 'stopped', 1), revise(1), run('b', 'stopped', 2)], 'plan')).toBe(2)
  })
})

describe('appendKind', () => {
  it('same sha, no intervening revise → resume', () => {
    const entries = [run('a', 'stopped', 1)]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('resume')
  })

  it('same sha after a revise → changed-nothing (the explicit stop)', () => {
    const entries = [run('a', 'stopped', 1), revise(1)]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('changed-nothing')
  })

  it('previously seen sha → cached append; A↔B oscillation therefore counts', () => {
    const entries = [run('a', 'stopped', 1), revise(1), run('b', 'stopped', 2), revise(2)]
    const k = appendKind(entries, 'plan', key('a'))
    expect(k.kind).toBe('cached')
    if (k.kind === 'cached') expect(k.from.reviewed_sha).toBe('a')
  })

  it('malformed runs never serve the cache', () => {
    const entries = [run('a', 'malformed', 1, { verdicts: undefined }), revise(1), run('b', 'stopped', 2), revise(2)]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('fresh')
  })

  it('any key component differing → fresh (edited lens, new model, new version)', () => {
    const entries = [run('a', 'stopped', 1), revise(1)]
    expect(appendKind(entries, 'plan', { ...key('a'), prompts_sha: 'p2' }).kind).toBe('fresh')
    expect(appendKind(entries, 'plan', { ...key('a'), pin: 'm2' }).kind).toBe('fresh')
  })
})

describe('pendingDecision + bound', () => {
  it('a stop without a later decision is pending; three rounds reach the bound', () => {
    const stopped = [run('a', 'stopped', 1)]
    expect(pendingDecision(stopped, 'plan')?.reviewed_sha).toBe('a')
    expect(pendingDecision([...stopped, revise(1)], 'plan')).toBeUndefined()
    const three = [run('a', 'stopped', 1), revise(1), run('b', 'stopped', 2), revise(2), run('c', 'stopped', 3)]
    expect(boundReached(three, 'plan')).toBe(true)
    expect(boundReached(three.slice(0, 3), 'plan')).toBe(false)
  })
})

describe('keyOf', () => {
  it('extracts exactly the six key components', () => {
    expect(keyOf(run('a', 'stopped', 1))).toEqual({
      reviewed_sha: 'a', gate: 'plan', prompts_sha: 'p1', pin: 'm1', witness: '0.1.0',
      harness: 'claude-code',
    })
  })
})

describe('pin identifies the round (row 106)', () => {
  // The defect: the key was built from chain[0] (the pin — the only model knowable
  // before invoking) and the entry journaled the answering rung, under one name.
  it('a fallen-back round keys on its pin, not on what answered', () => {
    const fell = run('a', 'stopped', 1, { pin: 'm1', model: 'm2' })
    expect(keyOf(fell).pin).toBe('m1')
    expect(sameKey(keyOf(fell), key('a'))).toBe(true)
  })

  // Exact migration, the same shape row 88 used for `harness ?? 'claude-code'`: a round
  // that did not fall back has pin === model, so every existing journal reads identically.
  it('a legacy entry with no pin keys on its model', () => {
    const legacy = run('a', 'stopped', 1)
    expect(legacy.pin).toBeUndefined()
    expect(keyOf(legacy).pin).toBe('m1')
    expect(fellBack(legacy)).toBe(false)
  })

  it('fellBack is true only when what answered is not what was asked for', () => {
    expect(fellBack(run('a', 'stopped', 1, { pin: 'm1', model: 'm1' }))).toBe(false)
    expect(fellBack(run('a', 'stopped', 1, { pin: 'm1', model: 'm2' }))).toBe(true)
  })

  // A substituted round is not evidence for another one — and `resume` is a decision
  // about THIS run taken from THAT one without invoking anything. Excluding it is what
  // makes a re-gate retry the pin: a recovered pin yields a real verdict on the spot.
  it('a fallen-back last round is not a resume source — the re-gate retries the pin', () => {
    const entries = [run('a', 'stopped', 1, { pin: 'm1', model: 'm2' })]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('fresh')
  })

  // The same exclusion at the same branch, revise side: `changed-nothing` would tell the
  // human to edit an artifact that was never the problem — row 108's defect, relocated.
  it('a fallen-back last round is not a changed-nothing source either', () => {
    const entries = [run('a', 'stopped', 1, { pin: 'm1', model: 'm2' }), revise(1)]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('fresh')
  })

  // Second reason for the same exclusion: with `pin` in the key, a fallen-back round and
  // a clean one over the same content share a key, so edit-then-revert would replay an
  // unpinned verdict into a passing run.
  it('an earlier fallen-back round never serves the cache', () => {
    const entries = [
      run('a', 'stopped', 1, { pin: 'm1', model: 'm2' }), revise(1),
      run('b', 'stopped', 2), revise(2),
    ]
    expect(appendKind(entries, 'plan', key('a')).kind).toBe('fresh')
  })

  // A clean earlier round IS still a cache source when the last round fell back — the
  // exclusion is about the substituted entry, not about everything behind it.
  it('a clean earlier round still serves the cache past a fallen-back last round', () => {
    const entries = [
      run('a', 'stopped', 1), revise(1),
      run('b', 'stopped', 2, { pin: 'm1', model: 'm2' }), revise(2),
    ]
    const k = appendKind(entries, 'plan', key('a'))
    expect(k.kind).toBe('cached')
    if (k.kind === 'cached') expect(k.from.reviewed_sha).toBe('a')
  })
})

describe('harness in the gate key', () => {
  it('a legacy entry without harness cache-matches a claude-code key and not a pi key', () => {
    // every pre-88 journal on disk lacks the field: run() builds that exact shape
    const legacy = run('s1', 'stopped', 1)
    expect(legacy.harness).toBeUndefined()
    const claudeKey = key('s1')
    expect(sameKey(keyOf(legacy), claudeKey)).toBe(true)
    expect(sameKey(keyOf(legacy), { ...claudeKey, harness: 'pi' })).toBe(false)
  })
})

describe('a fallback does not spend the budget (row 107)', () => {
  const fell = (sha: string, round: number) => run(sha, 'stopped', round, { pin: 'm1', model: 'm2' })

  // Row 67's principle, applied a second time: witness could not deliver the judgment
  // the human configured, and the artifact was never the problem.
  it('fallen-back rounds do not count toward the bound', () => {
    const entries = [run('a', 'stopped', 1), fell('b', 2), run('c', 'stopped', 2)]
    expect(roundsSinceApprove(entries, 'plan')).toBe(2)
    expect(boundReached(entries, 'plan')).toBe(false)
    expect(boundReached([...entries, run('d', 'stopped', 3)], 'plan')).toBe(true)
  })

  // Row 105 deliberately did NOT join them: exempting a harness-only difference would
  // let a repo flip judges indefinitely and never reach the bound. Pinned beside its
  // sibling so nobody assumes the two exemptions behave alike.
  it('a harness flip still spends its round', () => {
    const entries = [
      run('a', 'stopped', 1),
      run('a', 'stopped', 2, { harness: 'pi' }),
      run('a', 'stopped', 3),
    ]
    expect(roundsSinceApprove(entries, 'plan')).toBe(3)
    expect(boundReached(entries, 'plan')).toBe(true)
  })

  // Q17: the brakes guard the budget window, because that is what they exist to protect.
  // Runs on the far side of an approve were disposed of and can trip nothing.
  it('runsSinceReset stops at the last approve', () => {
    const entries = [fell('a', 1), fell('b', 2), approve(2), run('c', 'stopped', 1)]
    expect(runsSinceReset(entries, 'plan').map((r) => r.reviewed_sha)).toEqual(['c'])
    expect(runsSinceReset(entries.slice(0, 2), 'plan').map((r) => r.reviewed_sha)).toEqual(['a', 'b'])
  })

  // A plain revise is not a reset: the row's own scenario is revise → re-gate → fall
  // back again → brake, and that has to keep working.
  it('a plain revise does not close the window', () => {
    const entries = [fell('a', 1), revise(1), fell('b', 2)]
    expect(runsSinceReset(entries, 'plan').length).toBe(2)
  })
})
