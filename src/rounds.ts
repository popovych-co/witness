import { createHash } from 'node:crypto'
import { cliAct, exitsLine, type Act } from './act.js'
import type { Entry, ReviseReturnedEntry } from './journal.js'
import type { HeldRow } from './needs.js'
import type { Violation } from './refusal.js'
import type { CoverageItem, Finding } from './verdict.js'

// `untrusted` (row 171): the commands the trust list kept this check from running, so the
// trust stop is read from the run's own record rather than inferred from a detail string.
// Present only when non-empty.
// held (row 179): the criteria an unmet need kept the drift lane from running.
export interface GateCheck { name: string; ok: boolean; detail?: string; untrusted?: string[]; held?: HeldRow[] }
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
  // Row 106: the model the round ASKED for. The verdict-cache key is built before anything is
  // invoked, when only this is knowable; `model` is what answered. Those were one field, so
  // every fallen-back round keyed against a model the key could not contain — permanently
  // `fresh`, which killed resume, changed-nothing and the malformed-streak brake at once.
  // Since row 212 a round asks its pin alone, so only a 0.25.x round can differ. Optional for
  // READS only: every journal written before 0.8.0 lacks it and `pin ?? model` is exact for them,
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
  cached?: boolean
  manual?: boolean
  // Row 212: written through 0.25.x only, when a lens that could not reach the pin fell back
  // to another model. Read for those journals (the `fallback:` line); `fellBack` reads
  // `pin`/`model`.
  fallback?: string[]
  rerolled?: string[]
  skipped?: string[]
  standing?: string
  artifact_sha?: string
  // The DIFF half of a code gate's composite reviewed identity (`diffReviewedSha`),
  // journaled beside the composite so a later lapse can name WHICH term moved. At implement
  // `reviewed_sha` is H(diff, planContent): with only the composite recorded, "the worktree
  // moved" and "the plan was re-authored" are indistinguishable, and the lapse note blamed
  // the worktree for both. Not derivable after the fact — the judged diff is gone.
  //
  // Optional because every entry written before row 135 lacks it; its reader
  // (`next.ts`'s `lapseNote`) falls back to naming both shas, which is the honest answer
  // for a record that cannot say.
  diff_sha?: string
  // Row 186. The artifact exactly as this battery read it, as a git tree object (src/snapshot.ts),
  // and what a delta may not span: the lens prompts and docs, the gate's context, the pin and
  // the harness. A later round diffs against the tree only while the basis is the same.
  // Optional because every entry before C3 lacks them — such a round is never a delta base.
  reviewed_tree?: string
  basis_sha?: string
  // Row 185. `prompts_sha` without the delta block, written only when the two differ — the
  // malformed-streak brake compares setups, and two delta rounds over changing content carry
  // different blocks under one setup. `delta` names the round this one was judged against.
  setup_sha?: string
  delta?: { round: number; run: string }
  // Row 209. The lenses whose verdicts this round re-served from run `run`, a malformed round
  // asked the same question about the same bytes.
  carried?: { run: string; lenses: string[] }
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
  // Row 241 (R11). A human's revise that lifted a park below the bound: the gate is sent back to
  // work without running. Restarts drive's cap window and its per-run use for the target.
  unpark?: true
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
  // D143. Where the selection came from. Absent means the human named the option;
  // 'affirmation' means they nodded at a CLI-rendered recommendation. Never read by a gate
  // predicate — it exists so closure-by-nod is countable, which is what makes D121's
  // widened residual a measured cost rather than an argued one.
  // Row 173 widens it: 'policy' is the CLI acting on its own recommendation under
  // `autonomy: on`, 'arbiter' the model the CLI launched choosing an option. Either is a
  // disposition exactly like a human's to every reader (A5); only the record says who.
  selected?: 'affirmation' | 'policy' | 'arbiter'
  // Row 172. The arbiter's reasoning and the identity it ran under — the audit trail for a
  // judgment no human made. Model-written text: data, never read by a gate predicate.
  reason?: string
  arbiter?: { model: string; prompts_sha: string }
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
// A revise of any kind: plain, repair, un-park, upstream, or another gate's reopen (`caused_by`).
const isRevise = (e: Entry | undefined, gate: string): boolean =>
  isDecision(e, gate) && ['revise', 'revise-upstream'].includes((e as unknown as DecisionEntry).decision)
const isHandBack = (e: Entry | undefined, gate: string): boolean =>
  e !== undefined && e.t === 'revise-returned' && (e as unknown as ReviseReturnedEntry).gate === gate

export function keyOf(run: GateRunEntry): GateKey {
  const { reviewed_sha, gate, witness } = run
  return {
    // Row 185: a run is identified by what it read and who read it — the SETUP — never by its
    // delta block, which is how a round reviewed. A pass or an approve resets the window the
    // delta base lives in, so a key carrying the block could not be rebuilt after one, and the
    // content a settled delta round read would have run a fresh battery and un-settled the gate.
    reviewed_sha, gate, prompts_sha: run.setup_sha ?? run.prompts_sha, witness,
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
// pinned? One definition for every reader — the cache/resume exclusion below, the budget
// exemption in roundsSinceApprove, the caps, the delta base and autonomy's re-run arm —
// because the inline form inverts silently, and a flipped exemption is a budget that never
// spends. False for every pre-0.8.0 entry by construction, and for every round since row 212,
// which asks the pin alone: only a 0.25.x journal holds a round it is true for.
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

// Row 244 (design §4.2.9). The gate's last run that judged something: a malformed round judged
// nothing, so staleness and lifted holds are read against the run before it, as `liveActs` anchors.
export function lastJudgedRun(entries: Entry[], gate: string): GateRunEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRun(entries[i], gate) && (entries[i] as unknown as GateRunEntry).outcome !== 'malformed') {
      return entries[i] as unknown as GateRunEntry
    }
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

// The window the round budget spans, and therefore the window the malformed-streak brake guards:
// an approve, a revise-upstream or a passed run settles everything before it, so runs on
// the far side of one can neither spend budget nor trip a brake. gate.ts took the last two
// runs in the WHOLE stream, so an approved pair of fallen-back rounds — the dismissal row
// 107 specifies — refused the next legitimate run over rounds already disposed of.
export function runsSinceReset(entries: Entry[], gate: string): GateRunEntry[] {
  return gateRuns(entries.slice(lastResetIndex(entries, gate) + 1), gate)
}

// Row 185. The round a delta review compares against: the last run in the budget window that
// judged something (not malformed, not fallen back, carrying verdicts) and read OTHER content.
// Skipping same-content rounds is what keeps the delta key stable: a re-gate of the content a
// delta round already read picks that round's own base again, renders the same block, and
// resumes it — a delta round is never its own re-run's base.
export function deltaBase(entries: Entry[], gate: string, reviewedSha: string): GateRunEntry | undefined {
  const runs = runsSinceReset(entries, gate)
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!
    if (r.outcome === 'malformed' || fellBack(r) || !(r.verdicts?.length) || r.reviewed_sha === reviewedSha) continue
    return r
  }
  return undefined
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

// Every blocking finding's anchor, a pin contradiction's included: the first is the run's primary
// anchor, the one `recommend` names and D123's ladder is spent for.
const blockingAnchorsOf = (r: GateRunEntry): string[] =>
  (r.verdicts ?? []).flatMap((rv) => rv.findings.filter((f) => f.blocking)
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

// Row 239. What `decide` journals as the note of a bare `--revise`. An index of the anchoring
// run, never a judgment: the author already receives the whole verdict in `decide`'s
// revise-context. It no longer rides a command. As `--note "…"` (D129) it carried a
// reviewer's anchor onto a line a human pastes, so the revise is offered bare and `decide`
// derives the note from the same journal. `<why>` means the run holds no facts — a clean
// standing stop, where the reason is the human's and the CLI has none — and there the revise
// keeps its `<why>` slot (`reviseAct`), and a bare one journals no note.
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

// Row 239. The revise an exits line or a block offers, carrying no text from a reviewer. Where
// the run holds facts it is a bare `--revise`, and `decide` journals the prefill itself; where
// it holds none it keeps the `<why>` slot the human fills, printed as it always was.
export function reviseAct(gate: string, target: string, entries: Entry[]): Act {
  return notePrefill(entries, gate) !== '<why>'
    ? cliAct('decide', gate, target, '--revise')
    : cliAct('decide', gate, target, '--revise', '--note', '<why>')
}

// D67's endgame set: the acts left at the round bound, where the gate short-circuits and will
// not run again (gate.ts), so "re-gate" is the D67 lie whatever the sha says. Stale content only
// removes APPROVE from it — a human cannot honestly stamp bytes no battery read — which is the
// same set decide's stale-verdict refusal names.
function endgameActs(
  gate: string, target: string, entries: Entry[], stale: boolean, upstream: string | undefined,
): Act[] {
  const d = (...rest: string[]) => cliAct('decide', gate, target, ...rest)
  const up = upstream === undefined ? [] : [d('--revise', '--upstream', upstream)]
  // Row 109: the repair grant is an exit exactly while it is unspent, and it is the one
  // the human standing at the bound with a fixed finding actually wants — naming it
  // beside `--upstream` is what stops "fix it and re-gate" from being a move the tool
  // advertises nowhere and refuses twice.
  // `witness abandon` joins the set here because the hardcoded branch this replaces
  // printed it (`help: or discard the plan`) and nothing else offers it — and under D124
  // `--stop` becomes *park*, which would otherwise leave the bound screen with no
  // discarding act at all.
  const repair = repairGranted(entries, gate) ? [] : [d('--revise', '--repair')]
  const approve = stale ? [] : [d('--approve', '--override')]
  return [...approve, ...up, ...repair, d('--stop'), cliAct('abandon', target)]
}

// Below the bound, a stopped run awaiting its decision. Stale removes --approve and nothing
// else: `decide` refuses that one with `stale-verdict` because a stamp asserts about current
// content, while a stop or a revise judges the work. Both halves are measured (2026-08-12).
function pendingActs(
  gate: string, target: string, entries: Entry[], stale: boolean, upstream: string | undefined,
): Act[] {
  const d = (...rest: string[]) => cliAct('decide', gate, target, ...rest)
  const up = upstream === undefined ? [] : [d('--revise', '--upstream', upstream)]
  const note = reviseAct(gate, target, entries)
  return [stale ? cliAct('gate', gate, target) : d('--approve'), note, ...up, d('--stop')]
}

// What un-parks a gate stopped under D124. At the bound the gate short-circuits before invoking
// anything, so `--fresh` is the D67 lie: the only live acts there are the endgame set, and on
// moved content it offers no approve (S2-5). Below it, row 241 (R11): a human's revise sends the
// gate back to work — alone while work is `owed` (an open step, a plan reopen, an evidence row, or
// work the gate's last act sent upstream), since a fresh run would only judge the work as it
// stands; otherwise beside a fresh run, which re-reviews it (the content is unchanged, so a plain
// re-gate would answer `changed-nothing`).
function parkedActs(
  gate: string, target: string, entries: Entry[], upstream: string | undefined, owed: boolean, stale: boolean,
): Act[] {
  if (boundReached(entries, gate)) return endgameActs(gate, target, entries, stale, upstream)
  const revise = cliAct('decide', gate, target, '--revise', '--note', '<why>')
  return owed ? [revise] : [revise, cliAct('gate', gate, target, '--fresh')]
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
// upstream exists, so the option has no id to print and the exits line omits it rather than
// print a placeholder; one the human fills is still accepted (`LiveActs.slots`, row 244).
// Row 244 (design §4.2.1): a view over `liveActs`, so the exits line offers exactly what `decide`
// accepts in every state, the revised and settled ones included. `stale` stands for moved content
// and lifted holds alike; the parked state's owed work is `reopenActs`' to say.
export function exitActs(
  gate: string, target: string, entries: Entry[], stale: boolean, upstream: string | undefined,
): Act[] {
  return liveActs(gate, target, entries, { upstream, stale, holdLifted: false, owed: false, upstreamOwed: false }).acts
}

// Rows 139/203. The exits line: `exitActs` rendered in one line.
export function liveExits(
  gate: string, target: string, entries: Entry[], stale: boolean, upstream: string | undefined,
): string {
  return exitsLine(exitActs(gate, target, entries, stale, upstream))
}

// Row 241 (R11). The human revise that lifted a park (`decide` journals it marked).
export function isUnpark(e: Entry, gate?: string): boolean {
  return e.t === 'human-decision' && (e as unknown as DecisionEntry).unpark === true &&
    (gate === undefined || (e as unknown as DecisionEntry).gate === gate)
}

// Row 241. An un-park as `decide` journals it: a human's (no `selected`), lifting a park — the
// gate's previous decision is a stop. What restarts drive's caps reads this, never the marker
// alone, so a line that merely claims `unpark` and follows no park restarts nothing.
export function unparkAt(entries: Entry[], i: number): boolean {
  const e = entries[i]
  if (e === undefined || !isUnpark(e) || (e as unknown as DecisionEntry).selected !== undefined) return false
  const gate = (e as unknown as DecisionEntry).gate
  const before = entries.slice(0, i).filter((x) => x.t === 'human-decision' && (x as unknown as DecisionEntry).gate === gate).at(-1)
  return (before as unknown as DecisionEntry | undefined)?.decision === 'stop'
}

// A parked gate's way back, as every parked row offers it: a view over `liveActs` (row 244). A
// caller with no content sha passes no staleness, so at the bound it may list an approve that
// `decide` would refuse `stale-verdict` (a screen that has the sha reads `liveActs` itself).
export function reopenActs(
  gate: string, target: string, entries: Entry[], upstream: string | undefined, owed: boolean,
): Act[] {
  return liveActs(gate, target, entries, { upstream, stale: false, holdLifted: false, owed, upstreamOwed: false }).acts
}

// Rows 139/203. The reopen as one line: `reopenActs` rendered.
export function reopenCommand(
  gate: string, target: string, entries: Entry[], upstream: string | undefined, owed = false,
): string {
  return exitsLine(reopenActs(gate, target, entries, upstream, owed))
}

// Row 244 (#87, design §4.2.1). The facts beside the journal that decide which acts are legal. The
// caller computes them, since some need canon, config or the worktree.
export interface ActFacts {
  upstream: string | undefined   // the parent a send-upstream names; undefined = none
  stale: boolean                 // content moved since the anchor run
  holdLifted: boolean            // a hold lifted since the anchor run (row 179)
  owed: boolean                  // row 241's owed work: open step, plan reopen, evidence row, upstream work
  upstreamOwed: boolean          // the gate's own latest revise is upstream and its work is still owed there (P48)
}

// Row 244 (design §4.2.2). Where a gate stands, for every reader alike.
export type GateStateKind = 'none' | 'pending' | 'revised' | 'handed-back' | 'handed-back-moved' | 'at-bound' | 'settled' | 'retracted' | 'parked'

// Row 244. A gate's state and its legal acts, in the order the screens offer them. `anchor` is the
// run a decision now disposes of. `malformedRerun`: a malformed round is the gate's last word, so
// its free re-run leads the acts (design §4.2.2). `slots` are acts `decide` accepts that no exits
// line lists: below the bound, the other spelling of the listed approve (D122); and where no parent
// resolves, the send-upstream the state would offer, as `--upstream <effort>` for the human to fill
// (design §4.2.9) — a block may show it, never runnable, and an exits line leaves it out.
export interface LiveActs {
  state: GateStateKind
  anchor?: GateRunEntry
  acts: Act[]
  malformedRerun: boolean
  // Design §4.2.2's session line, where a state has one: the changed-nothing screen prints it.
  session?: string
  slots?: Act[]
}

// Design §4.2.2's session lines, by state, on unchanged content. The retracted line ends as the
// design's table cell does: `--fresh` is the human's re-review (§4.2.8), and a retraction is where a
// session may run it.
export const SESSION_LINE = {
  revised: 'change the work and re-run the gate, or hand it back with `--unchanged`',
  'handed-back-moved': 'change nothing more; the re-gate judges what moved',
  retracted: 're-review with `gate --fresh` (it spends a round), or change the work and re-run the gate; a session may run that `--fresh`',
} as const

// Row 244 (design §4.2.3, "one pairing"). The run the gate's latest revise disposed of: the latest
// run before it that judged something. A malformed round judged nothing, so a revise after one
// disposes of the run before it (P45), and one after the revise leaves the pairing alone (P50).
// Every staleness read and every changed-nothing check pairs through it. `at` is its index.
export function disposedRun(entries: Entry[], gate: string): { run: GateRunEntry; at: number } | undefined {
  let i = entries.length - 1
  while (i >= 0 && !isRevise(entries[i], gate)) i--
  for (i--; i >= 0; i--) {
    const e = entries[i]
    if (isRun(e, gate) && (e as unknown as GateRunEntry).outcome !== 'malformed') return { run: e as unknown as GateRunEntry, at: i }
  }
  return undefined
}

// Row 244 (design §4.2.5). A revise the author handed back, still waiting for its decision: the
// gate's latest disposition is a revise, a `revise-returned` naming the run it disposed of follows
// it, and no run that judged something has come since (P33). A malformed run judged nothing, so it
// leaves the hand-back standing. Any later disposition ends it, since then the latest is no longer
// that revise.
export function standingHandBack(entries: Entry[], gate: string): ReviseReturnedEntry | undefined {
  const disposed = disposedRun(entries, gate)
  if (disposed === undefined) return undefined
  let revise = entries.length - 1
  while (revise >= 0 && !isDecision(entries[revise], gate)) revise--
  if (!isRevise(entries[revise], gate)) return undefined
  let standing: ReviseReturnedEntry | undefined
  for (const e of entries.slice(revise + 1)) {
    if (isRun(e, gate) && (e as unknown as GateRunEntry).outcome !== 'malformed') return undefined
    if (isHandBack(e, gate) && (e as unknown as ReviseReturnedEntry).run_id === disposed.run.run_id) {
      standing = e as unknown as ReviseReturnedEntry
    }
  }
  return standing
}

// Row 244 (design §4.2.4). Was the gate settled when the revise at `reviseAt` was journaled: the
// gate's decision before it, since the run at `runAt`, is an approve, or there is none and that run
// passed. Such a revise, with no `caused_by`, retracts the settlement.
function settledBefore(entries: Entry[], gate: string, runAt: number, reviseAt: number): boolean {
  for (let i = reviseAt - 1; i > runAt; i--) {
    if (isDecision(entries[i], gate)) return (entries[i] as unknown as DecisionEntry).decision === 'approve'
  }
  return (entries[runAt] as unknown as GateRunEntry).outcome === 'passed'
}

// Design §4.2.2: the free re-run leads in these states, and never at the bound, settled or parked.
const LEADS: ReadonlySet<GateStateKind> = new Set<GateStateKind>(['pending', 'revised', 'handed-back', 'handed-back-moved', 'retracted'])

// Row 244 (#87, design §4.2.1–§4.2.3, §4.2.9). A gate's state and the acts that are legal in it,
// from one pure derivation, so a screen never offers an act `decide` refuses. The states, first
// match wins:
//   none        no run, or the effort abandoned;
//   parked      the latest disposition since the last run that judged something is a stop;
//   at-bound    the round budget is spent: the endgame set;
//   settled     an approve, or a pass with no disposition since;
//   retracted   a revise un-settled an approve or a pass (no `caused_by`);
//   handed-back the author handed the revise back (-moved: content or a hold moved since);
//   revised     any other revise;
//   pending     a stopped run awaiting its decision, or only malformed rounds.
// Moved content and a lifted hold read alike: a stamp asserts about bytes a battery read (D75).
export function liveActs(gate: string, target: string, entries: Entry[], facts: ActFacts): LiveActs {
  let lastRun = -1
  let judged = -1
  let lastDecision = -1
  let abandoned = false
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (isRun(e, gate)) {
      lastRun = i
      if ((e as unknown as GateRunEntry).outcome !== 'malformed') judged = i
    } else if (e.t === 'human-decision' && (e as unknown as DecisionEntry).decision === 'abandon-effort') {
      // D190 journals the effort's end under its own gate (`effort`): it ends every gate of the stream.
      abandoned = true
      if (isDecision(e, gate)) lastDecision = i
    } else if (isDecision(e, gate)) {
      lastDecision = i
      abandoned = false
    }
  }
  if (lastRun < 0 || abandoned) return { state: 'none', acts: [], malformedRerun: false }

  const regate = cliAct('gate', gate, target)
  // D126, row 209: a malformed round with no decision since is the gate's last word.
  const malformedLast = (entries[lastRun] as unknown as GateRunEntry).outcome === 'malformed' && lastRun > lastDecision
  if (judged < 0) return { state: 'pending', acts: [regate], malformedRerun: malformedLast }

  const anchor = entries[judged] as unknown as GateRunEntry
  const disposition = lastDecision > judged ? (entries[lastDecision] as unknown as DecisionEntry) : undefined
  const decision = disposition?.decision
  const revised = decision === 'revise' || decision === 'revise-upstream'
  const moved = facts.stale || facts.holdLifted
  const atBound = boundReached(entries, gate)
  // Where no parent resolves, the send-upstream a state offers carries `<effort>` for the human to
  // fill, and is held in `slots` below, never listed (design §4.2.9).
  const upstream = facts.upstream ?? '<effort>'
  const d = (...rest: string[]) => cliAct('decide', gate, target, ...rest)
  const noted = d('--revise', '--note', '<why>')
  const fresh = cliAct('gate', gate, target, '--fresh')

  let state: GateStateKind
  let acts: Act[]
  if (decision === 'stop') {
    state = 'parked'
    acts = parkedActs(gate, target, entries, upstream, facts.owed, moved)
  } else if (atBound) {
    state = 'at-bound'
    acts = endgameActs(gate, target, entries, moved, upstream)
  } else if (decision === 'approve' || (!revised && anchor.outcome === 'passed')) {
    // The retraction alone, after which `gate --fresh` re-judges; on moved content the approval
    // lapsed and the re-gate judges what moved.
    state = 'settled'
    acts = [moved ? regate : noted]
  } else if (revised) {
    // D122: below the bound the screens name the accounted approve while a blocking finding stands.
    const blocking = blockingAnchorsOf(anchor)
    const approve = blocking.length > 0 ? d('--approve', '--override') : d('--approve')
    if (disposition?.caused_by === undefined && settledBefore(entries, gate, judged, lastDecision)) {
      // A retraction asks for a re-review, not an edit: no hand-back, no upstream.
      state = 'retracted'
      acts = moved ? [regate, d('--stop'), noted] : [fresh, approve, d('--stop'), noted]
    } else {
      // Send upstream where a parent exists, the latest revise was not upstream, and D123's ladder
      // is unspent for the run's primary anchor (an upstream taken here spends it, P47).
      const primary = blocking[0]
      const up = decision !== 'revise-upstream' && !(primary !== undefined && ladderSpent(entries, gate, primary))
        ? [d('--revise', '--upstream', upstream)] : []
      const handedBack = standingHandBack(entries, gate) !== undefined
      state = handedBack ? (moved ? 'handed-back-moved' : 'handed-back') : 'revised'
      // Moved content after a revise is the author's edit, and the re-gate judges it; after a
      // hand-back it moved under a verdict nobody re-read, so no approve, and the re-gate leads.
      acts = state === 'handed-back-moved' ? [regate, d('--stop'), ...up, noted]
        : moved ? [regate]
        : [approve, d('--stop'), ...up, fresh, noted]
    }
  } else {
    state = 'pending'
    acts = pendingActs(gate, target, entries, moved, upstream)
  }

  // A malformed round after the revise (or the pending run) keeps the state's acts and leads with
  // its free re-run, which repairs the round (design §4.2.2, P50).
  const malformedRerun = malformedLast && LEADS.has(state)
  if (malformedRerun && (acts[0] === undefined || actKey(acts[0]) !== actKey(regate))) acts = [regate, ...acts]
  // A send-upstream with `<effort>` to fill is a slot: no parent resolved, so no exits line lists it.
  const unnamed = (a: Act) => a.inputs.some((i) => i.name === 'effort')
  const listed = acts.filter((a) => !unnamed(a))
  const slots = [...(atBound ? [] : approveTwin(gate, target, listed)), ...acts.filter(unnamed)]
  const session = sessionLine(state, moved)
  return {
    state, anchor, acts: listed, malformedRerun,
    ...(session !== undefined ? { session } : {}), ...(slots.length > 0 ? { slots } : {}),
  }
}

// Design §4.2.2: the session's line in the revised, handed-back-moved and retracted states. On
// moved content a revised or retracted gate's one way on is the re-gate its acts name, so neither
// line, which offers a hand-back or a re-review of unchanged content, is said there.
function sessionLine(state: GateStateKind, moved: boolean): string | undefined {
  if (state === 'handed-back-moved') return SESSION_LINE['handed-back-moved']
  if (moved) return undefined
  return state === 'revised' ? SESSION_LINE.revised : state === 'retracted' ? SESSION_LINE.retracted : undefined
}

// D122. Below the bound `--approve` and `--approve --override` are one act: a screen lists one
// spelling, and the other is accepted beside it. At the bound only the accounted one is.
function approveTwin(gate: string, target: string, acts: readonly Act[]): Act[] {
  const plain = cliAct('decide', gate, target, '--approve')
  const accounted = cliAct('decide', gate, target, '--approve', '--override')
  const listed = (a: Act) => acts.some((x) => actKey(x) === actKey(a))
  return listed(accounted) ? [plain] : listed(plain) ? [accounted] : []
}

// `decide`'s valued flags: the word after one is its value, never a flag, whatever it spells. One set
// for `decide`'s parser (`decideWords`) and for `actKey`, so the two never disagree on which word is a
// value.
export const VALUED_FLAGS: ReadonlySet<string> = new Set(['--note', '--upstream', '--pin', '--via'])
// The flags that make an act another act (design §4.2.1). Notes, `--pin`, `--via`, `--trust-cmds`,
// `--manual` and the upstream's value never do.
const COUNTED_FLAGS: Record<string, readonly string[]> = {
  decide: ['--approve', '--revise', '--stop', '--override', '--repair', '--upstream'],
  gate: ['--fresh', '--unchanged'],
}
// `decide` and `gate` read their gate and target and ignore any positional word after them
// (`decisionAct`, verbs/gate.ts), so a stray word never makes another act.
const READ_POSITIONALS: Record<string, number> = { decide: 2, gate: 2 }

// Row 244. An act's identity, for membership: its verb, its positionals (gate and target, or the
// targets abandoned) and the flags that count, in one order. Read the way `decide` reads argv: a
// valued flag takes the next word whatever it spells, and counts only with a value, since `decide`
// reads an upstream only through its value.
export function actKey(act: Act | readonly string[]): string {
  const argv = 'argv' in act ? act.argv : act
  const [verb = '', ...rest] = argv
  const positional: string[] = []
  const flags = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!
    if (!w.startsWith('--')) { positional.push(w); continue }
    if (!VALUED_FLAGS.has(w)) flags.add(w)
    else if (rest[i + 1] !== undefined) { flags.add(w); i++ }
  }
  const read = positional.slice(0, READ_POSITIONALS[verb] ?? positional.length)
  return JSON.stringify([verb, ...read, ...(COUNTED_FLAGS[verb] ?? []).filter((f) => flags.has(f))])
}

// Row 244. Is the act with this key legal now: one the state lists, or one of its slots.
export function actLive(live: LiveActs, key: string): boolean {
  return [...live.acts, ...(live.slots ?? [])].some((a) => actKey(a) === key)
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
  | { kind: 'repair'; from: GateRunEntry }
  | { kind: 'fresh' }

const revisedAfter = (entries: Entry[], runIdx: number, gate: string): boolean =>
  entries.slice(runIdx + 1).some((e) =>
    isDecision(e, gate) && ['revise', 'revise-upstream'].includes((e as unknown as DecisionEntry).decision))

// Row 209: does a re-gate on unchanged content and setup repair the last run — re-ask only its
// lenses with no verdict — rather than re-run, resume or refuse? appendKind's own rule, minus the
// key only the gate can build, so the recommender's promise of a repair reads the same rule.
export function repairsOnRegate(entries: Entry[], gate: string): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isRun(entries[i], gate)) continue
    const last = entries[i] as unknown as GateRunEntry
    return last.outcome === 'malformed' && !fellBack(last) && !revisedAfter(entries, i, gate)
  }
  return false
}

// Row 215 (D3). Does this journaled run answer `key` — the one evidence rule for the gate's
// cache and for a review's replay? A malformed round judged nothing; a fallen-back one was asked
// of another model; a run with no verdicts said nothing.
export function answersKey(run: GateRunEntry, key: GateKey): boolean {
  return run.outcome !== 'malformed' && !fellBack(run) && (run.verdicts?.length ?? 0) > 0 && sameKey(keyOf(run), key)
}

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
    // recovered pin yields a real verdict immediately, and since row 212 a dead one refuses
    // the gate naming the pin to fix.
    // Keeping it here traps the human exactly as row 107's own trap does: `resume`
    // never retries, and `changed-nothing` says `edit the artifact` about an artifact
    // that was never the problem. Re-SHOWING the entry is `decide --show`'s job.
    // Row 209. A malformed round judged nothing, so there is nothing to resume: re-showing it
    // re-ran nothing while its own block said re-running is free. A re-gate repairs it instead —
    // the lenses that answered are carried and the ones that did not are asked again.
    if (!fellBack(last) && sameKey(keyOf(last), key)) {
      if (revisedAfter(entries, lastRunIdx, gate)) return { kind: 'changed-nothing', entry: last }
      return last.outcome === 'malformed' ? { kind: 'repair', from: last } : { kind: 'resume', entry: last }
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
    if (answersKey(run, key)) return { kind: 'cached', from: run }
  }
  return { kind: 'fresh' }
}

// Row 240 (design §4.1.1, R2). What a settler read of its stop: every decision of that gate
// after the run it judged — a reopen of that gate (`caused_by`) included — hashed. A settler
// takes it from its own read, before any model call, and the one door compares it first and
// again under the state lock: an act whose read predates a decision that landed meanwhile
// refuses `settled-since`, so no settler's act lands on a disposition it did not read. A run
// the stream does not hold hashes every decision of the gate, the same on both reads.
export function settledToken(entries: Entry[], gate: string, runId: string): string {
  const at = entries.findIndex((e) => e.t === 'gate-run' &&
    (e as unknown as GateRunEntry).gate === gate && (e as unknown as GateRunEntry).run_id === runId)
  const after = entries.slice(at + 1).filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate)
  return createHash('sha1').update(JSON.stringify(after)).digest('hex').slice(0, 12)
}
