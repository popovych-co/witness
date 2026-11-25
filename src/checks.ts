// Row 264 (§3.2 CR). The check registry: every machine check a code gate runs, with its tier, in
// run order. The withholding tier runs first, and its first red ends the round before any lens: the
// gate journals a checks-only round (src/gate.ts). Every judged check runs whenever any does — the
// cut is at a withholding red only — so a judged red still reaches the battery.
//
// Ordered by tier, then by this list, never by a measured cost (C14): cost could only reorder within
// a tier, and across tiers it would harm — ship's criteria lane reads the tests lane's suite run (row
// 252), so a measured order could run the suite twice. Two tiers now (C15): `precondition` and
// `advisory` land with their first checks. The doc gates register nothing: none of their checks
// withholds.
//
// Row 270 (§3.2's waiver). `waiver` names who may book a check's red: lint's is the human's alone
// (row 172: the AI judge never books lint). A check with none is never booked. Row 273: a switch-off's
// is the judge's — the AI judge or the human (§3.2); T4a adds a guard's.
import { offUnbooked, timedCheck, type GateCheck } from './rounds.js'

export type CheckTier = 'withholding' | 'judged'

export type CheckWaiver = 'human' | 'judge'

export const CHECKS: ReadonlyArray<{ name: string; tier: CheckTier; waiver?: CheckWaiver }> = [
  // Row 265. A file scan before the repo's tools: an unresolved conflict is read before it is linted.
  { name: 'markers', tier: 'withholding' },
  { name: 'lint', tier: 'withholding', waiver: 'human' },
  { name: 'implement-gate', tier: 'judged' },
  { name: 'diff', tier: 'judged' },
  // Row 273. A switch-off a plan adds: judged, so the battery runs and the reviewers are told.
  { name: 'switch-offs', tier: 'judged', waiver: 'judge' },
  { name: 'evidence', tier: 'judged' },
  { name: 'regression', tier: 'judged' },
  { name: 'tests', tier: 'judged' },
  { name: 'drift-lane', tier: 'judged' },
]

export function checkTier(name: string): CheckTier | undefined {
  return CHECKS.find((c) => c.name === name)?.tier
}

export function checkWaiver(name: string): CheckWaiver | undefined {
  return CHECKS.find((c) => c.name === name)?.waiver
}

// A check a gate runs: its registered name, and the body that produces it.
export interface CheckStep { name: string; run: () => GateCheck | Promise<GateCheck> }

// What a gate's checks came to. `withheld` names the withholding check that is red — the last of
// `checks`, none after it having run.
export interface CheckRun { checks: GateCheck[]; withheld?: string }

const order = (name: string): number => {
  const i = CHECKS.findIndex((c) => c.name === name)
  if (i < 0) throw new Error(`check ${name} is not in the check registry (src/checks.ts) — a witness bug`)
  return i
}

// The steps in registry order (stable), each timed (row 251), stopping after the first red step whose
// tier withholds. A step the registry lacks, or one whose check names another check, is a witness bug.
export async function runChecks(steps: readonly CheckStep[]): Promise<CheckRun> {
  const sorted = steps.map((s, i) => ({ s, i, at: order(s.name) }))
    .sort((a, b) => a.at - b.at || a.i - b.i).map((x) => x.s)
  const checks: GateCheck[] = []
  for (const step of sorted) {
    const check = await timedCheck(step.run)
    if (check.name !== step.name) {
      throw new Error(`check step ${step.name} produced a check named ${check.name} — a witness bug`)
    }
    checks.push(check)
    if (!check.ok && checkTier(step.name) === 'withholding') return { checks, withheld: step.name }
  }
  return { checks }
}

// Row 112's resume signature, owned here since checks register (T2c's hand-off). Compared on what a
// judgment is, never on `detail` (run output on some gates) or `duration_ms`: each check's name and
// `ok`; trust keeping it from running (F3, `:blocked`); the criteria a hold kept from running (row
// 179); and each lint part's state with the key it read the base by (row 263). A part's key joins so
// that a part command edited while a round stands moves the signature, and the round never resumes
// over a key no job owes. `pending` and `not-measured` are one term, `missing`: they differ only by
// whether a drive runs, not by the tree or the base, so starting or stopping drive spends no round.
// Row 273: each switch-off line with copies no booking covers, with that count — a booking or a
// dismissal since a round moves it.
export function checksSignature(checks: readonly GateCheck[]): string {
  const partTerm = (s: string) => (s === 'pending' || s === 'not-measured' ? 'missing' : s)
  return checks.map((c) => `${c.name}:${c.ok}${(c.untrusted?.length ?? 0) > 0 ? ':blocked' : ''}:${
    (c.held ?? []).map((h) => h.criterion).sort().join('+')}${
    c.parts !== undefined
      ? `:${c.parts.map((p) => `${p.part}=${partTerm(p.state)}${p.key !== undefined ? `@${p.key}` : ''}`).join(',')}`
      : ''}${
    c.offs !== undefined
      ? `:offs=${c.offs.filter((o) => offUnbooked(o) > 0).map((o) => `${o.key}x${offUnbooked(o)}`).sort().join('+')}`
      : ''}`).sort().join('|')
}
