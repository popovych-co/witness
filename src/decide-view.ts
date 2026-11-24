import { cliAct, exitsLine, reopenRows, type Act } from './act.js'
import { untrustedCmdsFor } from './allowlist.js'
import { autonomyLines, decidedBy } from './autonomy.js'
import type { Config } from './config.js'
import { gateSpec } from './gate.js'
import { gateRunLines, gateRunView, type GateRunView } from './gate-run-view.js'
// The gate specs `decideView` reads (`currentSha`, `upstreamOf`): registered by loading this
// module, so a reader with no CLI around it (the UI) gets them as the decide verb does.
import './gates/index.js'
import { policyPins, readStream, type Entry, type PolicyPin } from './journal.js'
import { recommend, renderDecision, type Decision } from './recommend.js'
import { lastGateRun, liveActs, openReopen, type DecisionEntry } from './rounds.js'
import { actFacts, parkedBy } from './verbs/next.js'
import { criteriaOwner, type Canon } from './scan.js'
import type { GateName } from './settings.js'
import { short } from './sha.js'
import { cmd, kv, rows, logSafe } from './toon.js'

// Rows 139/203. `decide --show` as a model: one gate's state on one target — its last run, what
// disposed of it, whether the content moved since, a reopen — derived once, so the verb prints
// the view's lines and a reader of the view is handed the facts and acts the text offers.
// `decideViewLines` lays it out.

export interface LastRun { round: number; sha: string; outcome: string }          // sha: short(reviewed_sha)
export type Disposition = Pick<DecisionEntry, 'decision' | 'selected' | 'arbiter' | 'reason' | 'note'>

// Rows 139/203. One member per screen. A reopened or settled gate prints no run. An actionable run
// is pending a decision or revised by its author; `block` ranks its options, and with no block
// `exits` is the whole live set. Row 244 (#87, design §4.2.1): every state's acts are its live acts
// (`liveActs`, through the facts `decide` reads), so the screen offers exactly what `decide`
// accepts — a settled gate its retraction (or, on moved content, the re-gate), a handed-back revise
// the set it is decided from again (§4.2.5).
// The view holds what the text prints, as printed. Only `run.findings` spells a reviewer's anchor
// and claim out (logSafe); the same anchor reaches the model raw (R5/R17) in an option's `why`,
// `block.anchor` and a `run.demoted` anchor, and in no act: since row 239 the revise carries no
// note. A disposition's `note` and `reason` and a pin's `text` are kept as printed too. A renderer
// must spell them out (spec §4.2); the UI runs an act's `argv`, never its `line`.
export type DecideView = { gate: string; target: string; autonomy: boolean } & (
  | { state: 'no-runs' }
  | { state: 'reopened'; by: { gate: string; artifact: string; round: number }; note?: string; last: LastRun; disposition?: Disposition; exits: Act[] }
  // A pass settles with no disposition.
  | { state: 'settled'; disposition?: Disposition; last: LastRun; exits: Act[] }
  // Row 241 (R11): a gate a stop took off the board, who parked it and why, and its way back.
  | { state: 'parked'; why: string; disposition: Disposition; last: LastRun; reopen: Act[] }
  | { state: 'actionable'; run: GateRunView; pins: PolicyPin[]; disposition?: Disposition; block?: Decision; exits: Act[] }
  // Row 244 (design §4.2.5): the author handed the revise back; `moved`, the content or a hold moved since.
  | { state: 'handed-back'; moved: boolean; run: GateRunView; pins: PolicyPin[]; disposition: Disposition; block?: Decision; exits: Act[] })

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
  const facts = actFacts(root, cfg, canon, gate, target, entries, { sha: spec.currentSha?.(root, canon, cfg, target), upstream })
  const live = liveActs(gate, target, entries, facts)
  // Row 244 (S2-2): the decisions on the run they dispose of, the last that judged something — a
  // malformed round after a park or a revise judged nothing, and leaves that disposition standing.
  const judged = live.anchor ?? last
  const decisionsAfter = entries
    .slice(entries.lastIndexOf(judged as unknown as Entry) + 1)
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
  // uncomputable sha is NOT staleness — same doctrine as the approve-time check. Row 244 (S2-1):
  // read as `decide` reads it (`actFacts`), against the last run that judged something.
  const stale = facts.stale || facts.holdLifted || facts.checksMoved
  const lastRun: LastRun = { round: last.round, sha: short(last.reviewed_sha), outcome: last.outcome }
  // D154: the block's trusting twins name the artifact's `cmd:` criteria this repo does not
  // trust yet.
  const blockOf = () => recommend({
    gate, target, entries, upstream, stale, untrustedCmds: untrustedCmdsFor(root, criteriaOwner(canon, target)),
  })

  // Row 244 (design §4.2.5). A handed-back revise is owed its decision again: its run and the set it
  // is decided from, before the reopen it may answer. The run is the one the revise disposed of
  // (`live.anchor`): a malformed round after the hand-back judged nothing and leaves it standing, so it
  // is never the run shown (Task 10's review).
  if (live.state === 'handed-back' || live.state === 'handed-back-moved') {
    const block = blockOf()
    return {
      ...head, state: 'handed-back', moved: live.state === 'handed-back-moved', run: gateRunView(judged, 'ran', entries),
      pins: policyPins(entries), disposition: disposition ?? { decision: 'revise' }, ...(block ? { block } : {}), exits: live.acts,
    }
  }
  if (reopen) {
    const by = reopen.caused_by!
    return {
      ...head, state: 'reopened', by: { gate: by.gate, artifact: by.artifact, round: by.round },
      ...(reopen.note !== undefined ? { note: reopen.note } : {}),
      last: lastRun, ...(disposition ? { disposition } : {}),
      exits: live.acts,
    }
  }
  // S2-2: a malformed re-review leaves the park standing, so the park reads from the run it disposed
  // of, the last that judged something (`live.anchor`).
  if (disposition && live.state === 'parked') {
    const anchor = (judged.verdicts ?? []).flatMap((rv) => rv.findings.filter((f) => f.blocking))
      .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`))[0] ?? judged.standing ?? judged.outcome
    return { ...head, state: 'parked', why: parkedBy(entries, gate, anchor), disposition, last: lastRun, reopen: live.acts }
  }
  if (live.state === 'settled') {
    return { ...head, state: 'settled', ...(disposition ? { disposition } : {}), last: lastRun, exits: live.acts }
  }
  // pending (no disposition) or revise (the author's input): the verdict is actionable
  // The surface a human actually reads while deciding, so it is the one that most owes a
  // ranking rather than a menu. `undefined` is stale with no decision pending, where no
  // act but the re-gate is legal and the exits line already says exactly that (D131).
  const block = blockOf()
  return {
    ...head, state: 'actionable', run: gateRunView(last, 'ran', entries), pins: policyPins(entries),
    ...(disposition ? { disposition } : {}), ...(block ? { block } : {}),
    exits: live.acts,
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
    // Row 239. The log it names is an act's line, here and on the settled screen below.
    out.push(kv('last-run', `round ${view.last.round} @${view.last.sha} — ${view.last.outcome}${view.disposition ? `, ${view.disposition.decision}` : ''} · ${cliAct('log', target).line}`))
    out.push(cmd('exits', exitsLine(view.exits)))
    return out
  }
  if (view.state === 'parked') {
    out.push(kv('gate', gate))
    out.push(kv('target', target))
    out.push(`state: parked — ${logSafe(view.why)}`)
    out.push(kv('decided-by', decidedBy(view.disposition)))
    out.push(kv('last-run', `round ${view.last.round} @${view.last.sha} — ${view.last.outcome} · ${cliAct('log', target).line}`))
    out.push(...reopenRows(view.reopen))
    return out
  }
  if (view.state === 'settled') {
    const d = view.disposition
    out.push(kv('gate', gate))
    out.push(kv('target', target))
    out.push(kv('state', `settled — ${d?.decision ?? view.last.outcome}`))
    if (d) out.push(kv('decided-by', decidedBy(d)))
    if (d?.reason) out.push(kv('reason', d.reason))
    if (d?.note) out.push(kv('note', d.note))
    out.push(kv('last-run', `round ${view.last.round} @${view.last.sha} — ${view.last.outcome} · ${cliAct('log', target).line}`))
    // Row 244 (design §4.2.2): the one act left is the retraction, after which `gate --fresh`
    // re-judges — or, on content that moved since, the re-gate. What comes next for the flow is
    // the one verb that owns it, rather than routing re-derived in a second place (D101).
    out.push(cmd('exits', exitsLine(view.exits)))
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
  if (view.state === 'handed-back') {
    out.push(kv('state', view.moved
      ? 'handed-back — the content or a hold moved since the author handed the revise back'
      : 'handed-back — the author handed the revise back with the content unchanged'))
  }
  if (view.block) out.push(...renderDecision(view.block))
  // An abandoned effort's gate has no act left (`liveActs`' none state).
  else if (view.exits.length === 0) out.push('help: no act — the effort is abandoned')
  else out.push(cmd('exits', exitsLine(view.exits)))
  return out
}
