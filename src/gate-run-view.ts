import type { Entry } from './journal.js'
import type { HeldRow } from './needs.js'
import { ROUND_BOUND, boundReached, roundBudget, type GateRunEntry, type ReviewerVerdict } from './rounds.js'
import { kv, logSafe, rows } from './toon.js'
import { anchorKey } from './verdict.js'

// Rows 139/203. A gate run as a model: the value of every line `renderGateRun` prints, read off
// the journaled entry once, so the gate's own screen and `decide --show` render one run from one
// derivation, and a reader of the view is handed what the text says. `gateRunLines` lays it out.

// Rows 139/203. One finding as its row prints it.
export interface FindingView { reviewer: string; blocking: boolean; pin?: number; anchor: string; claim: string } // anchor, claim: logSafe

// A finding's anchor and claim are a reviewer's free text, printed on a human's terminal: spelled
// out (`logSafe`) so an escape sequence or bidi override cannot paint over the row (row 215).
export function findingViews(verdicts: ReviewerVerdict[]): FindingView[] {
  return verdicts.flatMap((rv) =>
    rv.findings.map((f) => ({
      reviewer: rv.reviewer, blocking: f.blocking,
      ...(f.contradicts_pin !== undefined ? { pin: f.contradicts_pin } : {}),
      anchor: logSafe(typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`), claim: logSafe(f.claim),
    })))
}

const findingRow = (f: FindingView): Record<string, string> => ({
  reviewer: f.reviewer, blocking: String(f.blocking), pin: f.pin !== undefined ? `#${f.pin}` : '',
  anchor: f.anchor, claim: f.claim,
})

export function findingRows(verdicts: ReviewerVerdict[]): Array<Record<string, string>> {
  return findingViews(verdicts).map(findingRow)
}

// One row per violation, from a journaled round's malformed lenses or a view's.
export function malformedRows(malformed: GateRunView['malformed']): Array<Record<string, string>> {
  return malformed.flatMap((m) => m.violations.map((x) => ({ reviewer: m.reviewer, field: x.field, rule: x.rule })))
}

// Rows 139/203. Each optional line's value is present exactly when the line prints: an empty list
// prints nothing, as an absent one did. `demoted` keeps the line's value, which prints its anchor
// as written — only the finding rows spell an anchor out. `malformed` is kept per lens, as
// journaled: its table prints when any lens was malformed, one row per violation, so a lens with
// none still prints the header it always did.
export interface GateRunView {
  gate: string; target: string; round: number; budget: number; resume: boolean
  reviewed: string; model: string; cached: boolean                       // reviewed: the sha's first 7
  delta?: number; skipped: string[]; fallback: string[]; rerolled: string[]
  carried?: { lenses: string[]; run: string }
  checks: Array<{ name: string; ok: boolean; detail?: string }>
  held: HeldRow[]
  findings: FindingView[]
  demoted: Array<{ anchor: string; round: number }>
  malformed: Array<{ reviewer: string; violations: Array<{ field: string; rule: string }> }>
  standing?: string
  outcome: GateRunEntry['outcome']
  lastRound: boolean                                                     // not passed, and the budget is spent
}

// `entries` is the stream AS OF AFTER this entry: without it the view cannot tell the round that
// spends the budget from any other, and rows 109/110 are both about that round. Without it this
// stays a pure read of the entry it was handed: the base budget, and never the last round.
export function gateRunView(entry: GateRunEntry, mode: 'ran' | 'resume', entries?: Entry[]): GateRunView {
  return {
    gate: entry.gate, target: entry.artifact, round: entry.round,
    budget: entries ? roundBudget(entries, entry.gate) : ROUND_BOUND,
    resume: mode === 'resume',
    reviewed: entry.reviewed_sha.slice(0, 7), model: entry.model, cached: Boolean(entry.cached),
    ...(entry.delta ? { delta: entry.delta.round } : {}),
    skipped: [...(entry.skipped ?? [])], fallback: [...(entry.fallback ?? [])], rerolled: [...(entry.rerolled ?? [])],
    ...(entry.carried ? { carried: { lenses: [...entry.carried.lenses], run: entry.carried.run } } : {}),
    checks: entry.checks.map((c) => ({ name: c.name, ok: c.ok, ...(c.detail !== undefined ? { detail: c.detail } : {}) })),
    held: entry.checks.flatMap((c) => c.held ?? []).map((h) => ({ criterion: h.criterion, need: h.need, satisfy: h.satisfy })),
    findings: findingViews(entry.verdicts ?? []),
    demoted: (entry.verdicts ?? []).flatMap((rv) => rv.findings)
      .flatMap((f) => (f.demoted !== undefined ? [{ anchor: anchorKey(f.anchor), round: f.demoted }] : [])),
    malformed: (entry.malformed ?? [])
      .map((m) => ({ reviewer: m.reviewer, violations: m.violations.map((x) => ({ field: x.field, rule: x.rule })) })),
    ...(entry.standing ? { standing: entry.standing } : {}),
    outcome: entry.outcome,
    lastRound: entry.outcome !== 'passed' && entries !== undefined && boundReached(entries, entry.gate),
  }
}

// Rows 139/203. `renderGateRun`'s lines up to its help tail, read from the view. Each element is
// one line as the screen has always printed it, and a table one element, its rows joined: a
// caller printing these one `ctx.out` each is handed exactly what it was handed before the view.
export function gateRunLines(view: GateRunView): string[] {
  const out = [
    kv('gate', view.gate),
    kv('target', view.target),
    kv('round', `${view.round} of ${view.budget}${view.resume ? ' (resume — content unchanged)' : ''}`),
    kv('reviewed', view.reviewed),
    kv('model', `${view.model}${view.cached ? ' · cached' : ''}`),
  ]
  if (view.delta !== undefined) out.push(kv('review', `delta since round ${view.delta}`))
  if (view.skipped.length > 0) out.push(kv('skipped', view.skipped.join(' · ')))
  if (view.fallback.length > 0) out.push(kv('fallback', view.fallback.join(' → ')))
  if (view.rerolled.length > 0) out.push(kv('rerolled', view.rerolled.join(' · ')))
  if (view.carried) {
    out.push(kv('carried', `${view.carried.lenses.join(' · ')} — answered in run ${view.carried.run} on this content and prompts`))
  }
  out.push(rows('checks', ['name', 'ok', 'detail'],
    view.checks.map((c) => ({ name: c.name, ok: String(c.ok), detail: c.detail ?? '' }))).join('\n'))
  // Row 179: what the lane did not run, beside the row that passed without it.
  for (const h of view.held) out.push(`held: ${h.criterion} — ${h.need} unmet · ${h.satisfy}`)
  if (view.findings.length > 0) {
    out.push(rows('findings', ['reviewer', 'blocking', 'pin', 'anchor', 'claim'], view.findings.map(findingRow)).join('\n'))
  }
  for (const d of view.demoted) out.push(kv('demoted', `${d.anchor} — unchanged since round ${d.round}`))
  if (view.malformed.length > 0) out.push(rows('malformed', ['reviewer', 'field', 'rule'], malformedRows(view.malformed)).join('\n'))
  if (view.standing) out.push(kv('standing-stop', view.standing))
  out.push(kv('outcome', view.outcome))
  // Row 110. The round that SPENDS the budget is the one that has to say so. It rendered
  // like any other, so the natural next act — fix the finding, re-gate — was advertised
  // by the help line below and then refused twice: the gate short-circuits, and the edit
  // that answered the finding forfeits `--approve` under D75. Nothing warned, and the
  // finding is itself an instruction to edit. Printed above the `help:` suppression, not
  // inside it: `decide --show` renders its own exits and is the surface a human reads
  // while deciding — the one place this warning is most owed.
  if (view.lastRound) {
    out.push(kv('last-round', 'the round budget is spent — the gate will not run again, and an edit from here forfeits --approve (the verdict would describe an older tree)'))
  }
  return out
}
