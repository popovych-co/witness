import { exitsLine, type Act } from './act.js'
import { untrustedCmdsFor } from './allowlist.js'
import { autonomyLines, decidedBy } from './autonomy.js'
import type { Config } from './config.js'
import { gateSpec } from './gate.js'
import { gateRunLines, gateRunView, type GateRunView } from './gate-run-view.js'
// The gate specs `decideView` reads (`currentSha`, `upstreamOf`): registered by loading this
// module, so a reader with no CLI around it (the UI) gets them as the decide verb does.
import './gates/index.js'
import { policyPins, readStream, type Entry, type PolicyPin } from './journal.js'
import { liftedHolds } from './needs.js'
import { recommend, renderDecision, type Decision } from './recommend.js'
import { exitActs, lastGateRun, openReopen, type DecisionEntry } from './rounds.js'
import { criteriaOwner, type Canon } from './scan.js'
import type { GateName } from './settings.js'
import { short } from './sha.js'
import { cmd, kv, rows } from './toon.js'

// Rows 139/203. `decide --show` as a model: one gate's state on one target — its last run, what
// disposed of it, whether the content moved since, a reopen — derived once, so the verb prints
// the view's lines and a reader of the view is handed the facts and acts the text offers.
// `decideViewLines` lays it out.

export interface LastRun { round: number; sha: string; outcome: string }          // sha: short(reviewed_sha)
export type Disposition = Pick<DecisionEntry, 'decision' | 'selected' | 'arbiter' | 'reason' | 'note'>

// Rows 139/203. One member per screen. A reopened or settled gate prints no run, and a settled
// one no act: the gate is terminal there. An actionable run is pending a decision or revised by
// its author; `block` ranks its options, and with no block `exits` is the whole live set.
// The view holds what the text prints, as printed. Only `run.findings` spells a reviewer's anchor
// and claim out (logSafe); the same anchor reaches the model raw (R5/R17) in an option's `why`,
// `block.anchor` and a `run.demoted` anchor, and in no act: since row 239 the revise carries no
// note. A disposition's `note` and `reason` and a pin's `text` are kept as printed too. A renderer
// must spell them out (spec §4.2); the UI runs an act's `argv`, never its `line`.
export type DecideView = { gate: string; target: string; autonomy: boolean } & (
  | { state: 'no-runs' }
  | { state: 'reopened'; by: { gate: string; artifact: string; round: number }; note?: string; last: LastRun; disposition?: Disposition; exits: Act[] }
  | { state: 'settled'; disposition: Disposition; last: LastRun }
  | { state: 'actionable'; run: GateRunView; pins: PolicyPin[]; disposition?: Disposition; block?: Decision; exits: Act[] })

// The record's fields the screen reads, each present only when the record carries it.
function dispositionOf(d: DecisionEntry): Disposition {
  return {
    decision: d.decision,
    ...(d.selected !== undefined ? { selected: d.selected } : {}),
    ...(d.arbiter !== undefined ? { arbiter: d.arbiter } : {}),
    ...(d.reason !== undefined ? { reason: d.reason } : {}),
    ...(d.note !== undefined ? { note: d.note } : {}),
  }
}

export function decideView(root: string, cfg: Config, canon: Canon, gate: GateName, target: string): DecideView {
  const spec = gateSpec(gate)
  if (spec === undefined) throw new Error(`gate ${gate} is not registered`)
  const entries = readStream(root, target)
  const last = lastGateRun(entries, gate)
  const upstream = spec.upstreamOf?.(root, canon, target)
  const head = { gate, target, autonomy: cfg.autonomy }
  if (!last) return { ...head, state: 'no-runs' }
  const reopen = openReopen(entries, gate)
  const decisionsAfter = entries
    .slice(entries.lastIndexOf(last as unknown as Entry) + 1)
    .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate)
    .map((e) => e as unknown as DecisionEntry)
  // A caused_by decision is a REOPEN, not a disposition — it can never settle the run
  // above it, and pairing the two is what presented 15 settled findings as current.
  // The LAST disposition is the state (D94): `find` returned the first, so a
  // revise→approve reported `decision: revise` on a gate that is settled.
  const decided = decisionsAfter.filter((d) => d.caused_by === undefined).at(-1)
  const disposition = decided === undefined ? undefined : dispositionOf(decided)
  // Staleness is a fact about content, not about being reopened. Hardcoding it printed
  // `witness gate …` in the one state where the gate answers changed-nothing. An
  // uncomputable sha is NOT staleness — same doctrine as the approve-time check.
  const shownSha = spec.currentSha?.(root, canon, cfg, target)
  const stale = (shownSha !== undefined && shownSha !== last.reviewed_sha) ||
    liftedHolds(criteriaOwner(canon, target), last).length > 0
  const lastRun: LastRun = { round: last.round, sha: short(last.reviewed_sha), outcome: last.outcome }

  if (reopen) {
    const by = reopen.caused_by!
    return {
      ...head, state: 'reopened', by: { gate: by.gate, artifact: by.artifact, round: by.round },
      ...(reopen.note !== undefined ? { note: reopen.note } : {}),
      last: lastRun, ...(disposition ? { disposition } : {}),
      exits: exitActs(gate, target, entries, stale, upstream),
    }
  }
  if (disposition && disposition.decision !== 'revise' && disposition.decision !== 'revise-upstream') {
    return { ...head, state: 'settled', disposition, last: lastRun }
  }
  // pending (no disposition) or revise (the author's input): the verdict is actionable
  // The surface a human actually reads while deciding, so it is the one that most owes a
  // ranking rather than a menu. `undefined` is stale with no decision pending, where no
  // act but the re-gate is legal and the exits line already says exactly that (D131).
  // D154: the block's trusting twins name the artifact's `cmd:` criteria this repo does not
  // trust yet.
  const block = recommend({
    gate, target, entries, upstream, stale, untrustedCmds: untrustedCmdsFor(root, criteriaOwner(canon, target)),
  })
  return {
    ...head, state: 'actionable', run: gateRunView(last, 'ran', entries), pins: policyPins(entries),
    ...(disposition ? { disposition } : {}), ...(block ? { block } : {}),
    exits: exitActs(gate, target, entries, stale, upstream),
  }
}

// Rows 139/203. The screen `decide --show` prints, from its view, in the verb's order: the
// autonomy setting, then the state. A table is one element, its rows joined, as the verb has
// always printed it (`gateRunLines`).
export function decideViewLines(view: DecideView): string[] {
  const out = [...autonomyLines(view)]
  const { gate, target } = view
  if (view.state === 'no-runs') {
    out.push(kv('decide', `no gate-runs for ${gate} ${target}`))
    return out
  }
  if (view.state === 'reopened') {
    out.push(kv('gate', gate))
    out.push(kv('target', target))
    out.push(kv('state', 'reopened — the gate must run again'))
    out.push(kv('reopened-by', `${view.by.gate} ${view.by.artifact} (round ${view.by.round})`))
    if (view.note) out.push(kv('note', view.note))
    out.push(kv('last-run', `round ${view.last.round} @${view.last.sha} — ${view.last.outcome}${view.disposition ? `, ${view.disposition.decision}` : ''} · witness log ${target}`))
    out.push(cmd('exits', exitsLine(view.exits)))
    return out
  }
  if (view.state === 'settled') {
    const d = view.disposition
    out.push(kv('gate', gate))
    out.push(kv('target', target))
    out.push(kv('state', `settled — ${d.decision}`))
    out.push(kv('decided-by', decidedBy(d)))
    if (d.reason) out.push(kv('reason', d.reason))
    if (d.note) out.push(kv('note', d.note))
    out.push(kv('last-run', `round ${view.last.round} @${view.last.sha} — ${view.last.outcome} · witness log ${target}`))
    // no exits: the gate is genuinely terminal here. Point at the one verb that owns
    // what comes next rather than re-deriving routing in a second place (D101).
    out.push('help: witness next')
    return out
  }
  out.push(...gateRunLines(view.run))
  if (view.pins.length > 0) {
    out.push(rows('pins', ['ordinal', 'text'], view.pins.map((p) => ({ ordinal: p.ordinal, text: p.text }))).join('\n'))
  }
  if (view.disposition) {
    const d = view.disposition
    out.push(kv('decision', d.decision))
    out.push(kv('decided-by', decidedBy(d)))
    if (d.reason) out.push(kv('reason', d.reason))
    if (d.note) out.push(kv('note', d.note))
  }
  if (view.block) out.push(...renderDecision(view.block))
  else out.push(cmd('exits', exitsLine(view.exits)))
  return out
}
