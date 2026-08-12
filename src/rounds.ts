import type { Entry } from './journal.js'
import type { Violation } from './refusal.js'
import type { CoverageItem, Finding } from './verdict.js'

export interface GateCheck { name: string; ok: boolean; detail?: string }
export interface ReviewerVerdict { reviewer: string; coverage: CoverageItem[]; findings: Finding[] }

export interface GateRunEntry {
  v: 1
  t: 'gate-run'
  gate: string
  artifact: string
  round: number
  run_id: string
  reviewed_sha: string
  prompts_sha: string
  witness: string
  model: string
  // Row 106: the chain head actually REQUESTED. The verdict-cache key is built before
  // anything is invoked, when only this is knowable; `model` is written afterwards, when
  // the answering rung is. Those were one field, so every fallen-back round keyed against
  // a model the key could not contain — permanently `fresh`, which killed resume,
  // changed-nothing and the malformed-streak brake at once. Optional for READS only:
  // every journal written before 0.8.0 lacks it and `pin ?? model` is exact for them,
  // since a round that did not fall back has pin === model. gate.ts writes it always.
  pin?: string
  // Optional: every pre-88 journal on disk lacks it, and keyOf reads absent as
  // claude-code — the only harness that could have written one.
  harness?: string
  // Optional: machine extensions declared for the reviewer spawn (row 89). Journaled
  // for auditability; deliberately NOT part of the verdict-cache key — auth transport
  // is not reviewer identity, and keying on it would fragment verdicts across
  // teammates' auth setups.
  reviewer_extensions?: string[]
  calibration: 'shipped' | 'local' | 'none'
  cached?: boolean
  manual?: boolean
  fallback?: string[]
  rerolled?: string[]
  skipped?: string[]
  standing?: string
  artifact_sha?: string
  checks: GateCheck[]
  verdicts?: ReviewerVerdict[]
  malformed?: Array<{ reviewer: string; violations: Violation[] }>
  outcome: 'passed' | 'stopped' | 'malformed'
}

export interface DecisionEntry {
  v: 1
  t: 'human-decision'
  gate: string
  artifact: string
  round: number
  decision: 'approve' | 'revise' | 'revise-upstream' | 'stop' | 'abandon-effort'
  override?: boolean
  // Row 109. A revise that buys the one extra round the bound otherwise forbids. Only ever
  // set on a `revise`, only ever at the bound, and only once per budget window — the whole
  // grant is this flag plus the window it sits in, so nothing can drift out of sync with it.
  repair?: true
  note?: string
  upstream?: { artifact: string; gate: string }
  caused_by?: { artifact: string; gate: string; round: number }
  // D121/D123. The anchor the decision was PRESENTED against — what the block showed, not
  // what the human was thinking about, consistent with `recommended` sitting beside
  // `decision`. Read by ladderSpent; the only one of the three new fields with a consumer.
  anchor?: string
  // D121. What the block recommended and which rule produced it. Never read by any gate
  // predicate — `status` aggregates them (D130) and nothing else touches them.
  recommended?: string
  rule?: string
}

export interface GateKey {
  reviewed_sha: string
  gate: string
  prompts_sha: string
  // Named for what it is. A key can only ever hold the model that was ASKED for — it is
  // constructed before invoking — and calling it `model` is what let the streak brake
  // compare it against the answering rung for three releases without anyone noticing.
  pin: string
  witness: string
  // Required — keys are always constructed fresh from a resolved harness. A pi verdict
  // must never cache-hit a claude one: same model id, different reviewer.
  harness: string
}

const isRun = (e: Entry | undefined, gate: string): e is GateRunEntry & Entry =>
  e !== undefined && e.t === 'gate-run' && (e as unknown as GateRunEntry).gate === gate
const isDecision = (e: Entry | undefined, gate: string): e is DecisionEntry & Entry =>
  e !== undefined && e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate

export function keyOf(run: GateRunEntry): GateKey {
  const { reviewed_sha, gate, prompts_sha, witness } = run
  return {
    reviewed_sha, gate, prompts_sha, witness,
    pin: run.pin ?? run.model,
    harness: run.harness ?? 'claude-code',
  }
}

export function sameKey(a: GateKey, b: GateKey): boolean {
  return a.reviewed_sha === b.reviewed_sha && a.gate === b.gate &&
    a.prompts_sha === b.prompts_sha && a.pin === b.pin && a.witness === b.witness &&
    a.harness === b.harness
}

// Rows 106 and 107: did this round's reviewers run on something other than what was
// pinned? One definition for three consumers — the cache/resume exclusion below, the
// budget exemption in roundsSinceApprove, and gate.ts's streak brake — because the
// inline form inverts silently, and a flipped exemption is a budget that never spends.
// False for every pre-0.8.0 entry by construction.
export function fellBack(run: GateRunEntry): boolean {
  return (run.pin ?? run.model) !== run.model
}

export function gateRuns(entries: Entry[], gate: string): GateRunEntry[] {
  return entries.filter((e): e is GateRunEntry & Entry => isRun(e, gate))
}

export function lastGateRun(entries: Entry[], gate: string): GateRunEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRun(entries[i], gate)) return entries[i] as unknown as GateRunEntry
  }
  return undefined
}

export const ROUND_BOUND = 3

// a "reset" opens a fresh round budget: human approve, a passed run, or a
// revise-upstream (the plan itself changes — a new plan version is a new game;
// upstream churn is bounded by the upstream gate's own bound)
function lastResetIndex(entries: Entry[], gate: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (isDecision(e, gate)) {
      const d = (e as unknown as DecisionEntry).decision
      if (d === 'approve' || d === 'revise-upstream') return i
    }
    if (isRun(e, gate) && (e as unknown as GateRunEntry).outcome === 'passed') return i
  }
  return -1
}

// The window the round budget spans, and therefore the window the streak brakes guard:
// an approve, a revise-upstream or a passed run settles everything before it, so runs on
// the far side of one can neither spend budget nor trip a brake. gate.ts took the last two
// runs in the WHOLE stream, so an approved pair of fallen-back rounds — the dismissal row
// 107 specifies — refused the next legitimate run over rounds already disposed of.
export function runsSinceReset(entries: Entry[], gate: string): GateRunEntry[] {
  return gateRuns(entries.slice(lastResetIndex(entries, gate) + 1), gate)
}

export function roundsSinceApprove(entries: Entry[], gate: string): number {
  // Row 67's principle, stated once and applied twice: the battery failed to deliver the
  // judgment the human configured — witness's failure, not the artifact's — so it never
  // spends the human's budget. `malformed` is a verdict witness could not parse; a
  // fallback is a model witness could not reach. Row 105 deliberately does NOT join them:
  // a harness flip still spends its round, or a repo could flip judges forever and never
  // reach the bound.
  return runsSinceReset(entries, gate)
    .filter((r) => r.outcome !== 'malformed' && !fellBack(r)).length
}

// Row 109. The final round's blocking findings can only be VERIFIED by another round, so
// fixing one at the bound forfeits `--approve` (D75 puts staleness at consumption) and the
// only exits left are a full upstream re-cycle or a stop. A repair grant buys exactly one
// more round. It is read from the journal window rather than counted anywhere: the window
// closes on every reset `lastResetIndex` already knows about, so an approve, a
// revise-upstream or a passed run refreshes the grant for the next game and nothing else
// does. A second grant inside one window is therefore a no-op by construction, not by a
// rule someone has to remember to write.
export function repairGranted(entries: Entry[], gate: string): boolean {
  return entries.slice(lastResetIndex(entries, gate) + 1).some((e) =>
    isDecision(e, gate) && (e as unknown as DecisionEntry).repair === true)
}

export function roundBudget(entries: Entry[], gate: string): number {
  return ROUND_BOUND + (repairGranted(entries, gate) ? 1 : 0)
}

export function boundReached(entries: Entry[], gate: string): boolean {
  return roundsSinceApprove(entries, gate) >= roundBudget(entries, gate)
}

const anchorsOf = (r: GateRunEntry): string[] =>
  (r.verdicts ?? []).flatMap((rv) => rv.findings
    // D123: a pin contradiction is row 83's standing stop with its own handling. Counting
    // it as recurrence would read row 82's r1↔r2 reviewer contradiction as a bad fix by
    // the author, which is exactly backwards.
    .filter((f) => f.blocking && f.contradicts_pin === undefined)
    .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`)))

// D123, memory one: how many honest attempts have failed at this seam IN THE CURRENT GAME.
// Distinct shas only — a resumed or unchanged round is not an attempt. Malformed and
// fallen-back rounds are excluded for the same reason row 67 and row 107 exempt them from
// the budget: witness failed to deliver a judgment, which is not evidence about the seam.
export function anchorRecurrence(entries: Entry[], gate: string, anchor: string): number {
  const seen = new Set<string>()
  for (const r of runsSinceReset(entries, gate)) {
    if (r.outcome === 'malformed' || fellBack(r)) continue
    if (!anchorsOf(r).includes(anchor)) continue
    seen.add(r.reviewed_sha)
  }
  return seen.size
}

// D123, memory two: was the depth ladder ALREADY tried for this anchor. Cross-window by
// necessity — `revise-upstream` IS a window reset (lastResetIndex), so the window erases
// the very fact this answers. Without it the once-per-anchor cap is underivable and the
// recommender can point at upstream every window forever, resetting the budget each time:
// incident c2692b93's shape.
export function ladderSpent(entries: Entry[], gate: string, anchor: string): boolean {
  return entries.some((e) =>
    isDecision(e, gate) &&
    (e as unknown as DecisionEntry).decision === 'revise-upstream' &&
    (e as unknown as DecisionEntry).anchor === anchor)
}

const PREFILL_MAX = 120
const PREFILL_ANCHORS = 3

// What goes inside `--revise --note "…"`. An index of the anchoring run, never a judgment:
// the author already receives the whole verdict in `decide`'s revise-context, so this
// exists to make the command runnable (D129), not to tell them anything new. `<why>` is
// the honest fallback when the run holds no facts — a clean standing stop, where the
// reason is the human's and the CLI has none. That placeholder is removed in 0.11.0 by the
// flagged-option rendering, which needs the option-row block to express it.
export function notePrefill(entries: Entry[], gate: string): string {
  const last = lastGateRun(entries, gate)
  if (!last) return '<why>'
  const anchors = (last.verdicts ?? [])
    .flatMap((rv) => rv.findings.filter((f) => f.blocking))
    .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`))
  const unique = [...new Set(anchors)]
  if (unique.length === 0) {
    const failed = last.checks.filter((c) => !c.ok).map((c) => c.name)
    if (failed.length === 0) return '<why>'
    return `failed checks: ${failed.join(', ')}`.slice(0, PREFILL_MAX)
  }
  const shown = unique.slice(0, PREFILL_ANCHORS)
  const more = unique.length - shown.length
  const text = `${unique.length} blocking finding${unique.length === 1 ? '' : 's'}: ` +
    shown.join(', ') + (more > 0 ? ` +${more} more` : '')
  return text.slice(0, PREFILL_MAX)
}

// Which decisions are legal RIGHT NOW is a pure function of journal state, so it lives
// where the state is — it was in `gate.ts`, which `next.ts` cannot import back (gate.ts
// already imports next.ts), and that one-way edge is precisely why `next` grew three
// hand-copied bound triples that then went stale twice over: they miss the repair grant
// (109), and a fixed set is what this function was written to abolish. Skills used to
// recite the same triple, which is wrong at the bound (D67's endgame set) and now wrong
// in three more states.
// `upstream` is REQUIRED and has no default: it used to default to the literal `<id>`,
// which shipped an unrunnable command on every screen (D129). `undefined` means no
// upstream exists — `decide` refuses that with `unknown-owner`, so the option is not legal
// and is omitted rather than printed as a placeholder.
export function liveExits(
  gate: string, target: string, entries: Entry[], stale: boolean, upstream: string | undefined,
): string {
  const d = `witness decide ${gate} ${target}`
  const up = upstream === undefined ? [] : [`--revise --upstream ${upstream}`]
  const note = `--revise --note "${notePrefill(entries, gate)}"`
  // The bound outranks staleness: at the bound the gate short-circuits and will not run
  // again (gate.ts), so "re-gate" is the D67 lie whatever the sha says. Stale content only
  // removes APPROVE from the endgame — a human cannot honestly stamp bytes no battery
  // read — which is the same set decide's stale-verdict refusal names.
  if (boundReached(entries, gate)) {
    // Row 109: the repair grant is an exit exactly while it is unspent, and it is the one
    // the human standing at the bound with a fixed finding actually wants — naming it
    // beside `--upstream` is what stops "fix it and re-gate" from being a move the tool
    // advertises nowhere and refuses twice.
    // `witness abandon` joins the set here because the hardcoded branch this replaces
    // printed it (`help: or discard the plan`) and nothing else offers it — and under D124
    // `--stop` becomes *park*, which would otherwise leave the bound screen with no
    // discarding act at all.
    const repair = repairGranted(entries, gate) ? [] : ['--revise --repair']
    const approve = stale ? [] : ['--approve --override']
    return [`${d} ${[...approve, ...up, ...repair, '--stop'].join(' | ')}`,
      `witness abandon ${target}`].join(' | ')
  }
  // Stale removes --approve and nothing else: `decide` refuses that one with `stale-verdict`
  // because a stamp asserts about current content, while a stop or a revise judges the work.
  // Both halves are measured (2026-08-12). The pending check is what separates this from the
  // reopened and revised screens, where no anchor resolves and every decide verb refuses.
  if (stale) {
    if (pendingDecision(entries, gate) === undefined) return `witness gate ${gate} ${target}`
    return [`witness gate ${gate} ${target}`, `${d} ${[note, ...up, '--stop'].join(' | ')}`].join(' | ')
  }
  return `${d} ${['--approve', note, ...up, '--stop'].join(' | ')}`
}

// What un-parks a gate stopped under D124. Below the bound a fresh run is the act — the
// content is unchanged, so a plain re-gate would answer `changed-nothing`. At the bound
// the gate short-circuits before invoking anything, so `--fresh` is the D67 lie: the only
// live acts there are the endgame set, which liveExits already knows.
export function reopenCommand(
  gate: string, target: string, entries: Entry[], upstream: string | undefined,
): string {
  return boundReached(entries, gate)
    ? liveExits(gate, target, entries, false, upstream)
    : `witness gate ${gate} ${target} --fresh`
}

export function pendingDecision(entries: Entry[], gate: string): GateRunEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (isDecision(e, gate)) return undefined
    if (isRun(e, gate)) {
      const run = e as unknown as GateRunEntry
      // D126. A malformed round parsed NO verdict, so there is nothing to dispose of:
      // offering `--approve` there stamps the artifact on zero judgment and `--revise`
      // sends the author to fix something no reviewer read. The remedy is a re-run (free —
      // malformed rounds never spend the budget) or the config change `malformed-streak`
      // names. Keep scanning: an older real verdict below it is still owed a decision.
      if (run.outcome === 'malformed') continue
      return run.outcome === 'passed' ? undefined : run
    }
  }
  return undefined
}

// A decision carrying `caused_by` is a REOPEN — another gate's `--revise --upstream`
// instructing this stage to re-author. It is not a disposition of the run above it and
// can never settle it. Discharged by a later gate-run OR a later human-decision for the
// same gate: `--approve` is a legitimate answer to a reopen ("looked, the canon was
// right"), and requiring a run would strand the human at `changed-nothing`, which
// appends nothing and would loop forever (D67's livelock shape).
export function openReopen(entries: Entry[], gate: string): DecisionEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (isRun(e, gate)) return undefined
    if (isDecision(e, gate)) {
      const d = e as unknown as DecisionEntry
      if (d.caused_by !== undefined) return d
      return undefined
    }
  }
  return undefined
}

export type AppendKind =
  | { kind: 'resume'; entry: GateRunEntry }
  | { kind: 'changed-nothing'; entry: GateRunEntry }
  | { kind: 'cached'; from: GateRunEntry }
  | { kind: 'fresh' }

export function appendKind(entries: Entry[], gate: string, key: GateKey): AppendKind {
  let lastRunIdx = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRun(entries[i], gate)) { lastRunIdx = i; break }
  }
  if (lastRunIdx >= 0) {
    const last = entries[lastRunIdx] as unknown as GateRunEntry
    // Row 106: a substituted round is not evidence for another one, and `resume` and
    // `changed-nothing` are both decisions about THIS run taken from THAT one without
    // invoking anything. Excluding it is what makes a re-gate retry the pin — a
    // recovered pin yields a real verdict immediately, a dead one falls back again and
    // row 107's fallback-streak brake stops it with the remedy that is actually true.
    // Keeping it here traps the human exactly as row 107's own trap does: `resume`
    // never retries, and `changed-nothing` says `edit the artifact` about an artifact
    // that was never the problem. Re-SHOWING the entry is `decide --show`'s job.
    if (!fellBack(last) && sameKey(keyOf(last), key)) {
      const revised = entries.slice(lastRunIdx + 1).some((e) =>
        isDecision(e, gate) &&
        ['revise', 'revise-upstream'].includes((e as unknown as DecisionEntry).decision))
      return revised ? { kind: 'changed-nothing', entry: last } : { kind: 'resume', entry: last }
    }
  }
  for (let i = lastRunIdx - 1; i >= 0; i--) {
    const e = entries[i]
    if (!isRun(e, gate)) continue
    const run = e as unknown as GateRunEntry
    // The same exclusion, second reason: with `pin` in the key a fallen-back round and a
    // clean one over the same content share a key, so edit-then-revert would replay an
    // unpinned verdict into a passing run. Beside the malformed filter, which is here
    // for the identical reason — a round witness could not complete is not evidence.
    if (run.outcome !== 'malformed' && !fellBack(run) && run.verdicts && sameKey(keyOf(run), key)) {
      return { kind: 'cached', from: run }
    }
  }
  return { kind: 'fresh' }
}
