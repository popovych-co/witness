import { join } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { unsafeLeft, untrustedCmdsFor } from '../allowlist.js'
import { autonomyAt, loadConfig, type Config } from '../config.js'
import { designUnseen } from '../design.js'
import { dropDraft } from '../drafts.js'
import '../gates/index.js'
import { gateSpec, renderGateRun } from '../gate.js'
import { decideView, decideViewLines, type DecideView } from '../decide-view.js'
import { newDeferralId, type DeferralKind } from '../deferral.js'
import { recommend, renderDecision } from '../recommend.js'
import { writeDoc } from '../fm.js'
import { acquireLock } from '../lock.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'
import { appendEntry, entryLine, journalRel, policyPins, readStream, streamExists, type Entry } from '../journal.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { effortOf } from '../reviewed.js'
import { liftedHolds } from '../needs.js'
import { criteriaOwner, findById, loadCanon, type Canon } from '../scan.js'
import { actFacts, openStepRow } from './next.js'
import { driveChild, sessionMarker } from '../drive-presence.js'
import { newRunId } from '../drift.js'
import { grantTrust } from './trust.js'
import { ok, refuse, renderRefusal, v, type Result } from '../refusal.js'
import { short } from '../sha.js'
import { cmd, hasControl, kv, rows, shellWord, visible } from '../toon.js'
import { cliAct, exitsLine, type Act } from '../act.js'
import {
  REVISE_HUMAN, ROUND_BOUND, VALUED_FLAGS, actKey, actLive, anchorRecurrence, boundReached, lastGateRun, liveActs, notePrefill, pendingDecision,
  repairGranted, roundsSinceApprove, settledSinceViolation, settledToken, type DecisionEntry, type GateRunEntry, type GateStateKind, type DroppedOff, type LineOff, type LiveActs,
} from '../rounds.js'
import { prepareStamp, writeStamp } from '../stamp.js'
import { handOverIfDue } from '../slice.js'
import { parseBaseKey } from '../base-lint.js'
import { CHECKS, checkTier, checkWaiver } from '../checks.js'
import { bookLines, bookedWhere, bookingsOf, ledgerTaken, offWhere, type Booking, type LedgerOpen } from '../ledger.js'
import { boundReader } from '../lint-parts.js'
import { LEDGER_STREAM } from '../streams.js'
import type { Violation } from '../refusal.js'


// D154. The untrusted `cmd:` list for a block, resolved from the ctx alone — `renderBound`
// renders without a `root` in scope, and gate.ts's renderChoices took the same route for the
// same reason (`--show`'s view is handed its root, src/decide-view.ts). Best-effort: a root
// that will not resolve costs the trust variants, never the block.
function trustFor(ctx: Ctx, target: string): string[] {
  const r = primaryRoot(ctx.cwd)
  return r.ok ? untrustedCmdsFor(r.value, criteriaOwner(loadCanon(r.value), target)) : []
}

const asEntry = (e: DecisionEntry) => e as unknown as { t: 'human-decision'; [k: string]: unknown }
const asLedger = (e: LedgerOpen) => e as unknown as { t: 'ledger-open'; [k: string]: unknown }

// Row 239. argv read left to right, the one way `decide` reads it: each word is a flag, the value
// of the valued flag before it, or a positional. A flag is read only where a flag stands, so a
// value is never one, whatever it spells: a note a human or the arbiter wrote may read
// `--override`, and it is the note. `values` keeps each valued flag's values in order.
interface DecideWords { positional: string[]; flags: Set<string>; values: Map<string, string[]> }
function decideWords(argv: readonly string[]): DecideWords {
  const out: DecideWords = { positional: [], flags: new Set(), values: new Map() }
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i]!
    if (!w.startsWith('--')) { out.positional.push(w); continue }
    out.flags.add(w)
    const value = argv[i + 1]
    if (VALUED_FLAGS.has(w) && value !== undefined) {
      out.values.set(w, [...(out.values.get(w) ?? []), value])
      i++
    }
  }
  return out
}

// Row 108. The bound is the designed terminus, not a malfunction, and renderRefusal
// appends `help: fix each row and re-run — rows are structured for self-repair`, which is
// false here twice over: there is no row to fix, and re-running is exactly what the bound
// forbids (gate.ts short-circuits before invoking). The old code knew — it packed the
// exits list into a violation row's `want` column — so the human at the terminus was
// handed a violations table instructing them to self-repair. This prints `--show`'s
// surface instead: state, then the exits that actually work. The exit code is unchanged;
// the decision the human asked for still did not happen.
// Row 244: `acts` are the endgame's live acts (`liveActs`), the exits line when no block ranks them.
function renderBound(
  ctx: Ctx, gate: string, target: string, entries: Entry[], stale: boolean,
  upstream: string | undefined, acts: readonly Act[], note?: string,
): number {
  ctx.err(kv('gate', gate))
  ctx.err(kv('target', target))
  ctx.err(kv('state', `bound reached — ${roundsSinceApprove(entries, gate)} rounds; the gate will not run again`))
  if (note !== undefined) ctx.err(kv('note', note))
  // D121. The endgame is exactly where a bare list of legal flags is least useful: every
  // remaining act carries a cost, and which cost is worth paying is the whole question.
  const d = recommend({ gate, target, entries, upstream, stale, untrustedCmds: trustFor(ctx, target) })
  if (d) renderDecision(d).forEach((l) => ctx.err(l))
  else ctx.err(cmd('exits', exitsLine(acts)))
  return EXIT.REFUSED
}

// Row 240 (R2). The settler lost the stop: a decision landed after the read its act was built on.
function settledSince(ctx: Ctx, gate: string, target: string): number {
  renderRefusal([settledSinceViolation(gate, target)]).forEach((l) => ctx.err(l))
  return EXIT.REFUSED
}

// Design §4.2.9. The states where an approve the screens withhold still anchors, so the blocker that
// withholds it is named. In the settled, parked and none states nothing is pending a verdict.
const WITHHOLDS: ReadonlySet<GateStateKind> = new Set<GateStateKind>(['pending', 'revised', 'handed-back', 'handed-back-moved', 'retracted', 'at-bound'])

// Row 244 (design §4.2.1). An act the gate's state does not offer: the refusal names what is live. Row
// 241 (R9): while a plan step is open no implement review runs, so the refusal names the step's
// command, never `gate implement`. With no run at all the gate is the act; an abandoned effort has none.
function nothingPending(
  ctx: Ctx, root: string, cfg: Config, canon: Canon, gate: string, target: string, live: LiveActs, ran: boolean,
): number {
  const plan = gate === 'implement' ? findById(canon, target) : undefined
  const open = plan !== undefined && plan.meta.type === 'plan' ? openStepRow(root, cfg, plan) : undefined
  // Row 239. The command a want names is an act's line, so the target the human typed prints quoted.
  renderRefusal([v('gate', 'nothing-pending', `${gate} ${target}`,
    open !== undefined ? `${open.row.line} — ${open.step} is not built yet, and no implement review runs while it is open`
    : live.acts.length > 0 ? exitsLine(live.acts)
    : !ran ? `a stopped gate-run awaiting a decision — run: ${cliAct('gate', gate, target).line}`
    : 'no act — the effort is abandoned')])
    .forEach((l) => ctx.err(l))
  return EXIT.REFUSED
}

export interface DecisionCore {
  gate: string
  target: string
  decision: 'approve' | 'revise' | 'stop' | 'book'
  // Row 270: the check a `book` decision books (`--book <check>`).
  book?: string
  override?: boolean
  repair?: boolean
  note?: string
  upstream?: string
  pins?: readonly string[]
  trustCmds?: boolean
  // Row 173: the run the decider judged. A settler sets it; `applyDecision` refuses
  // `anchor-moved` when the run it would dispose of is a different one.
  runId?: string
  // Row 183, policy-only (`decisionAct` never sets them, so the human verb never does). A
  // cap park is a decision about the FLOW: `park` lets a stop anchor on the gate's last run
  // when the anchor rule finds none — mid-revise, the author kept editing after the last
  // `--revise` — and `rule` journals the cap that decided in place of the recommender's
  // (D121: the rule that matched is the rule recorded).
  park?: true
  rule?: string
  // Row 240 (R2), settler-only (`decisionAct` never sets it, so a human act carries none): the
  // settled-since token of the settler's own read (`settledToken`). The door compares it first
  // and again under the state lock; a decision that landed since refuses `settled-since`.
  token?: string
}

// Who selected the option rides with the act, so the record is written by the same door
// whatever chose it (A5).
export type DecisionAct = DecisionCore & (
  | { selected?: 'affirmation' }
  | { selected: 'policy' }
  | { selected: 'arbiter'; reason: string; arbiter: { model: string; prompts_sha: string } })

// argv exactly as `decide` receives it. Parses the flags and refuses only what is about the
// SHAPE of the request; every refusal about the state it acts on is `applyDecision`'s. A
// flag absent from argv is absent from the act — no field carries `false`.
export function decisionAct(argv: string[]): Result<DecisionAct> {
  const { positional, flags, values } = decideWords(argv)
  const [gate, target] = positional
  if (!gate || !target) {
    return refuse([v('decide', 'usage', argv.join(' ') || '(none)', 'witness decide <gate> <target> --approve|--revise|--stop|--book <check>')])
  }
  const picked = (['--approve', '--revise', '--stop', '--book'] as const).filter((f) => flags.has(f))
  if (picked.length !== 1) {
    return refuse([v('decision', 'one-of-required', picked.join(' ') || '(none)', '--approve | --revise | --stop | --book <check>')])
  }
  // Row 270. A booking names the check it books, and is nothing else: no override, repair, upstream,
  // pin or trust grant rides it.
  const book = values.get('--book')?.[0]
  if (picked[0] === '--book') {
    if (book === undefined) return refuse([v('--book', 'value-required', '(none)', 'the check to book — witness decide <gate> <target> --book lint')])
    const extra = (['--override', '--repair', '--upstream', '--pin', '--trust-cmds'] as const).filter((f) => flags.has(f))
    if (extra.length > 0) {
      return refuse([v('--book', 'book-scope', `--book with ${extra.join(' ')}`, 'witness decide <gate> <target> --book <check> [--note <t>] — a booking carries a note and nothing else')])
    }
  }
  const via = values.get('--via')?.[0]
  if (via !== undefined && via !== 'affirmation') {
    return refuse([v('--via', 'unknown-via', via, 'affirmation — the only selection source the CLI defines')])
  }
  const note = values.get('--note')?.[0]
  const upstream = values.get('--upstream')?.[0]
  const pins = values.get('--pin') ?? []
  // Row 239. The CLI's own placeholders are slots a human fills, never a value: the printed
  // `--note "<why>"` or `--upstream <effort>`, run as it stands, decides nothing.
  const unfilled = [
    ...(note === '<why>' ? [v('--note', 'slot-unfilled', '<why>', 'the note itself — <why> is a slot the human fills')] : []),
    ...(upstream === '<effort>' ? [v('--upstream', 'slot-unfilled', '<effort>', 'the upstream itself — <effort> is a slot the human fills')] : []),
  ]
  if (unfilled.length > 0) return refuse(unfilled)
  return ok({
    gate, target, decision: picked[0]!.slice(2) as DecisionCore['decision'],
    ...(picked[0] === '--book' && book !== undefined ? { book } : {}),
    ...(flags.has('--override') ? { override: true } : {}),
    ...(flags.has('--repair') ? { repair: true } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(upstream !== undefined ? { upstream } : {}),
    ...(pins.length > 0 ? { pins } : {}),
    ...(flags.has('--trust-cmds') ? { trustCmds: true } : {}),
    ...(via === 'affirmation' ? { selected: 'affirmation' as const } : {}),
  })
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  // Row 239. The same reading as `decisionAct`'s, so the two never disagree about which word is
  // the gate, the target or `--show`.
  const { positional, flags } = decideWords(argv)
  const [gate, target] = positional
  const spec = gate ? gateSpec(gate) : undefined
  if (!gate || !target || !spec) {
    ctx.err('usage: witness decide <gate> <target> --approve|--revise|--stop|--book <check> [--override] [--repair] [--note <t>] [--upstream <artifact|effort>] [--pin <policy>]… [--via affirmation] [--show]')
    return EXIT.REFUSED
  }
  if (flags.has('--show')) return show(ctx, spec.gate, target)
  const act = decisionAct(argv)
  if (!act.ok) { renderRefusal(act.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const code = await applyDecision(ctx, act.value)
  // Row 191 §4.4. A revise typed in chat is handed to this session, so this is where a session
  // at its limit hands it to a fresh one. Here and not in `applyDecision`: the gate's tail and
  // `next` settle through that door too, and each hands over at its own point.
  if (code !== EXIT.OK || act.value.decision !== 'revise') return code
  handOverIfDue(ctx, { guard: false })
  return code
}

// Rows 139/203. The screen is the decide view's lines (src/decide-view.ts).
function show(ctx: Ctx, gate: string, target: string): number {
  const view = shownView(ctx, gate, target)
  if (view === undefined) return EXIT.REFUSED
  decideViewLines(view).forEach((l) => ctx.out(l))
  return EXIT.OK
}

// Row 239 (the plan's B10). The view `--show` prints, after the refusals that come before any
// state can be read, each rendered to `ctx.err`: `undefined` once one refused. The verb prints
// its lines, and drive's `decide>` prints the same lines and runs the options' acts it holds,
// so the block a human answers there is the one they would read in a chat (D143).
export function shownView(ctx: Ctx, gate: string, target: string): DecideView | undefined {
  const spec = gateSpec(gate)
  if (!spec) {
    renderRefusal([v('gate', 'unknown-gate', gate, 'decompose | plan | implement | ship | design')]).forEach((l) => ctx.err(l))
    return undefined
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return undefined }
  const root = rootR.value

  // Hoisted above `--show` (D94): both the anchor rule below and `--show`'s staleness
  // line need `spec.currentSha`, which takes canon and config. A decision verb that
  // cannot read the config cannot honestly report state either, so refusing here — and
  // for `--show` too — is the correct order rather than a regression.
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return undefined }
  return decideView(root, cfgR.value, loadCanon(root), spec.gate, target)
}

// Row 173. The ONE writer of a disposition. The verb parses argv into an act; every
// autonomous path (the gate's tail, `next`, drive) builds one from an option's act, run as
// its argv (row 239). One door means one set of refusals: a policy cannot reach a stamp the
// verb would refuse, and a human cannot reach one the policy would.
export async function applyDecision(ctx: Ctx, act: DecisionAct): Promise<number> {
  const { gate, target, decision } = act
  const spec = gateSpec(gate)
  if (!spec) {
    renderRefusal([v('gate', 'unknown-gate', gate, 'decompose | plan | implement | ship | design')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const entries = readStream(root, target)
  const last = lastGateRun(entries, gate)

  // Hoisted above `--show` (D94): both the anchor rule below and `--show`'s staleness
  // line need `spec.currentSha`, which takes canon and config. A decision verb that
  // cannot read the config cannot honestly report state either, so refusing here — and
  // for `--show` too — is the correct order rather than a regression.
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const canon = loadCanon(root)
  const upstreamId = spec.upstreamOf?.(root, canon, target)

  // Row 239. The block's revise carries no reviewer text, so a bare `--revise` journals the
  // prefill it used to carry, derived from the same journal. A revise sent upstream or bought
  // with a repair grant journals none, as before, and a run with no facts (`<why>`) leaves none.
  const prefill = notePrefill(entries, gate)
  const note = act.note ?? (decision === 'revise' && act.upstream === undefined && act.repair !== true && prefill !== '<why>' ? prefill : undefined)
  const override = act.override === true
  const repair = act.repair === true
  const upstream = act.upstream
  const pinTexts = [...(act.pins ?? [])]
  const trustCmds = act.trustCmds === true
  const nodded = act.selected === 'affirmation'
  if (pinTexts.length > 0 && gate !== 'implement') {
    renderRefusal([v('pin', 'pin-scope', gate, 'policy pins are implement-gate decisions on a plan')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const badPin = pinTexts.find((t) => t.trim() === '' || t.length > 500)
  if (badPin !== undefined) {
    renderRefusal([v('pin', 'pin-empty', badPin === '' ? '(empty)' : `${badPin.length} chars`,
      'non-empty policy text ≤500 chars')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  // D154. The trusting approve form. Executed after the decision lands, so a refused
  // decision never leaves a grant behind.
  if (trustCmds && decision !== 'approve') {
    renderRefusal([v('--trust-cmds', 'trust-scope', `--${decision}`,
      'witness decide … --approve --trust-cmds — a grant rides an approval, nothing else')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  // D143 (amends D127). A bare affirmation selects the RECOMMENDED option of a CLI-rendered
  // block, and `--via affirmation` is how the agent reports that the selection came from a
  // nod rather than from a named option. Journaled, so closure-by-nod stays measurable
  // rather than arguable — D121's residual widens here and the ledger is what prices it.
  // The exclusions, spec D143: an obligation-minting override (D122's ledger must not open
  // on an "ok"), and terminal acts. `witness abandon` is excluded at its own verb; a trust
  // grant joins this condition when D154 builds `--trust-cmds`.
  if (nodded && (override || decision === 'stop' || trustCmds)) {
    const which = override ? 'override' : decision === 'stop' ? 'stop' : 'trust-cmds'
    renderRefusal([v('--via', 'nod-cannot', `affirmation with --${which}`,
      'a named option — overrides, stops and trust grants are never taken on a nod (D143)')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  // Rows 172-173. Trust stays a human's (D154): no autonomous decision grants it. And the
  // obligation D122 mints is a judgment that the finding is wrong, which the rule cannot
  // make about its own recommendation — only the arbiter may take an override.
  // And the look of a screen is the human's (§3 G2): no autonomous decision approves a design.
  const lookApproved = gate === 'design' && decision === 'approve'
  if ((act.selected === 'policy' || act.selected === 'arbiter') &&
      (trustCmds || lookApproved || (act.selected === 'policy' && override))) {
    const what = trustCmds ? '--trust-cmds' : lookApproved ? 'a design approve' : '--override'
    renderRefusal([v('selected', 'autonomy-cannot', `${act.selected} with ${what}`,
      'a named human selection — no autonomous decision grants trust (D154) or approves a look · only the arbiter mints an obligation')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  if ((act.park !== undefined || act.rule !== undefined) && act.selected !== 'policy') {
    const what = act.park !== undefined ? 'park' : `rule ${act.rule}`
    renderRefusal([v('selected', 'autonomy-cannot', `${act.selected ?? 'a human'} with ${what}`,
      'the policy alone — a cap park and its own rule are the drive policy\'s acts (row 183)')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  // Row 270 (§3.2's waiver, §3.3, §3.9). A booking's refusals that read no gate state: a registered
  // check carrying a waiver; never on a nod, never the policy's or the arbiter's (row 172: lint's
  // waiver is the human's), never inside a session drive started; and nothing lands on a ledger
  // stream another history holds.
  const booking = decision === 'book'
  const bookCheck = act.book ?? ''
  if (booking) {
    const refusal = bookRefusal(ctx, root, gate, target, bookCheck, act)
    if (refusal !== undefined) { renderRefusal([refusal]).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  }

  const atBound = boundReached(entries, gate)

  // Row 240 (R2). Before the repair, bound and anchor checks: a settler whose read predates a
  // decision that landed meanwhile has lost the stop, and any rule below would only refuse it
  // for the wrong reason (`repair-not-at-bound`) — or, through the revised state's anchor or the
  // bound's endgame anchor, let its act land on a disposition it never read.
  if (act.token !== undefined && settledToken(entries, gate, act.runId ?? '') !== act.token) {
    return settledSince(ctx, gate, target)
  }

  // Row 244 (#87, design §4.2.1). `decide` accepts exactly the acts that are live now, from the one
  // derivation every screen reads (`liveActs`): an act a screen offers lands, and no other does. The
  // act is keyed the way the screens' acts are (`actKey`): its verb plus `--override`, `--repair` and
  // `--upstream`; a note, a pin, `--via` and `--trust-cmds` never make another act.
  //
  // `undefined` means the sha CANNOT be computed (no worktree, missing parent) and must never read as
  // "moved" — the same doctrine the approve-time staleness check states below.
  const nowSha = last !== undefined ? spec.currentSha?.(root, canon, cfgR.value, target) : undefined
  const factsOf = (es: Entry[]) => actFacts(root, cfgR.value, canon, gate, target, es, { sha: nowSha, upstream: upstreamId })
  const liveOf = (es: Entry[]): LiveActs => liveActs(gate, target, es, factsOf(es))
  const facts = factsOf(entries)
  const live = liveActs(gate, target, entries, facts)
  const key = actKey(['decide', gate, target, ...(booking ? ['--book', bookCheck] : [`--${decision}`]), ...(override ? ['--override'] : []),
    ...(repair ? ['--repair'] : []), ...(upstream !== undefined ? ['--upstream', upstream] : [])])
  // A revise that neither sends the work upstream nor buys a round: the un-park, the revise again,
  // the retraction, or the pending stop's revise.
  const plainRevise = decision === 'revise' && upstream === undefined && !repair
  const notHuman = act.selected === 'policy' || act.selected === 'arbiter' || driveChild(ctx.env) !== undefined

  // Row 241 (R11; the user's decision Q3). Below the bound a human's plain revise on a parked gate
  // sends it back to work: the park is lifted without running the gate. A human's act only — not
  // inside a session drive started (rows 205, 207, 225), and never the policy's or the arbiter's,
  // since a settler that parked a gate must not be the one to un-park it.
  const unparking = plainRevise && live.state === 'parked' && !atBound
  // Row 274: a booking of a parked gate un-parks it as well, so it stays the human's (row 241).
  if (booking && live.state === 'parked' && (act.selected === 'policy' || act.selected === 'arbiter')) {
    renderRefusal([v('decide', 'unpark-human', `${act.selected} booking on a parked gate`,
      `the human, in their own chat or terminal — ${cliAct('decide', gate, target, '--book', bookCheck).line} books a parked gate's red`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (unparking && notHuman) {
    renderRefusal([v('decide', 'unpark-human',
      act.selected === 'policy' || act.selected === 'arbiter' ? `${act.selected} revise on a parked gate` : 'a session drive started',
      `the human, in their own chat or terminal — ${cliAct('decide', gate, target, '--revise', '--note', '<why>').line} sends a parked gate back to work`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  // Row 244 (design §4.2.7, the user's decision 9). Revising a revised gate again, handed back or
  // not, and retracting a settled one are a human's acts, as the un-park is: refused for the policy
  // and the arbiter and inside a session drive started, on the pattern of rows 205, 207 and 225 —
  // before the anchor rule, since no state makes them a settler's. Each carries the human's words: a
  // revise again says what to change, and a retraction why (D99), so a bare revise refuses where the
  // noted one would land.
  const again = plainRevise && REVISE_HUMAN.has(live.state)
  const retraction = live.state === 'settled'
  if (again && notHuman) {
    renderRefusal([v('decide', 'revise-human',
      `${act.selected === 'policy' || act.selected === 'arbiter' ? act.selected : 'a session drive started'} — ${retraction ? 'a retraction' : 'a revise again'}`,
      `the human, in their own chat or terminal — ${cliAct('decide', gate, target, '--revise', '--note', '<why>').line} ${retraction ? 'retracts the settlement, saying why' : 'sends the work back, saying what to change'}`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (again && (act.note === undefined || act.note.trim() === '') && actLive(live, key)) {
    renderRefusal([v('--note', 'note-required', act.note === undefined ? 'absent' : '(empty)',
      `${retraction ? 'why the settlement is retracted' : 'what to change'}, in the human's words — ${cliAct('decide', gate, target, '--revise', '--note', '<why>').line}`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  // Row 109. The grant is a REVISE — the human is sending the artifact back, they are just
  // paying for the round that verifies the fix. Refusing the other spellings is not
  // pedantry: `--approve --repair` reads as "approve and let it re-run", which is not a
  // state this machine has, and silently ignoring the flag would journal an approve the
  // human believed was something else.
  if (repair && decision !== 'revise') {
    renderRefusal([v('repair', 'repair-scope', `--${decision}`,
      'witness decide … --revise --repair — a repair grant sends the artifact back for one verified round')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (repair && !atBound) {
    // Row 239. A shape: the target the human typed is quoted, and the slot is theirs to fill.
    renderRefusal([v('repair', 'repair-not-at-bound',
      `${roundsSinceApprove(entries, gate)} of ${ROUND_BOUND} rounds spent`,
      `the round bound — below it a plain revise already re-gates: witness decide ${shellWord(gate)} ${shellWord(target)} --revise --note "<why>"`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (repair && repairGranted(entries, gate)) {
    renderRefusal([v('repair', 'repair-spent', 'one repair round was already granted in this budget window',
      exitsLine(live.acts))]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  // The run this decision disposes of, and how many decisions already sit after it. A function of
  // the stream so the lock can ask it again (row 173): read twice, answered by one derivation. A
  // live act anchors where `liveActs` does — in the revised and handed-back states the run the
  // revise disposed of, malformed runs skipped (design §4.2.2). Row 183: a cap park, the policy's
  // alone, disposes of the flow, not of bytes — `gateParked` has no sha term — so it keeps its own
  // anchor, the pending run or else the gate's last run, whatever is live (the author kept editing
  // after the last revise); drive names that run (`caps.ts`).
  const capPark = act.park === true && decision === 'stop'
  const anchorOf = (es: Entry[], l: LiveActs): { anchor: GateRunEntry | undefined; after: number } => {
    const anchor = capPark ? (pendingDecision(es, gate) ?? lastGateRun(es, gate)) : actLive(l, key) ? l.anchor : undefined
    const at = anchor === undefined ? -1 : es.lastIndexOf(anchor as unknown as Entry)
    const after = at < 0 ? 0 : es.slice(at + 1)
      .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate).length
    return { anchor, after }
  }
  const first = anchorOf(entries, live)
  let anchor = first.anchor
  // Settled while building (design §4.2.9): an approve the screens withhold still anchors where a
  // blocker names why — moved content (`stale-verdict`), a lifted hold (`hold-lifted`), the bound
  // without `--override` (`override-required`) — so the refusal below is the true one.
  const withheld = anchor === undefined && decision === 'approve' && live.anchor !== undefined && WITHHOLDS.has(live.state)
  if (withheld) anchor = live.anchor
  if (!anchor) {
    if (atBound && live.anchor !== undefined) {
      // Row 108: at the bound nothing malfunctioned, so the refusal is the terminus and its live
      // exits, never a self-repair table. A plain revise is told what it can be instead.
      const up = live.acts.some((a) => actKey(a) === actKey(['decide', gate, target, '--revise', '--upstream', '_']))
      const fix = live.acts.some((a) => actKey(a) === actKey(['decide', gate, target, '--revise', '--repair']))
      const instead = [...(up ? ['upstream reopens the parent and resets the budget'] : []), ...(fix ? ['--repair buys one more round here'] : [])]
      return renderBound(ctx, gate, target, entries, facts.stale || facts.holdLifted || facts.checksMoved, upstreamId,
        live.acts, plainRevise && instead.length > 0 ? instead.join('; ') : undefined)
    }
    return nothingPending(ctx, root, cfgR.value, canon, gate, target, live, last !== undefined)
  }
  // Row 173. A settler judged ONE run. If the run it would dispose of is no longer that one
  // — a newer round landed while it was judging — the decision is about a verdict nobody
  // weighed, so it refuses rather than stamping it.
  if (act.runId !== undefined && anchor.run_id !== act.runId) {
    renderRefusal([v('gate', 'anchor-moved', `run ${anchor.run_id}`,
      `the run the decider judged (${act.runId}) — settle again against the current run`)]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const blockedCode = guardTxn(ctx, root)
  if (blockedCode !== undefined) return blockedCode

  // Row 270. What the booking books: the anchor's bookable parts of the check it names — none when the
  // anchor withheld another check. Under committed autonomy a typed booking is a terminal act: the
  // env marker proves nothing, so a terminal and the human's y are asked for, outside the lock.
  const bookings = booking ? withTools(cfgR.value, bookingsOf(anchor, bookCheck)) : []
  if (booking && bookings.length === 0) return nothingPending(ctx, root, cfgR.value, canon, gate, target, live, last !== undefined)
  // Slice 2 review I3 (row 171): committed autonomy is HEAD's config — a working-copy `autonomy: off`
  // edit grants nothing, so it never lifts the terminal either. Row 274: a typed booking only — the
  // arbiter decides in-process inside the gate and needs neither a terminal nor a y (§3.9).
  if (booking && act.selected === undefined && autonomyAt(root, 'HEAD')) {
    const typed = cliAct('decide', gate, target, '--book', bookCheck).line
    if (!ctx.isTTY) {
      renderRefusal([v('decide', 'book-needs-terminal', 'no terminal — autonomy is on',
        `the human, at their own terminal — ${typed} asks before it books`)]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    const answer = (await ctx.ask(bookQuestion(gate, target, bookCheck, anchor, bookings))).trim()
    if (answer.toLowerCase() !== 'y') {
      renderRefusal([v('decide', 'book-declined', `answered ${answer === '' ? '(nothing)' : visible(answer)}`,
        `y — nothing was booked; ${typed} asks again`)]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
  }

  // Row 111. Every reason an approve cannot happen, in ONE refusal. These used to fire
  // sequentially: `--approve` reported `override-required`, and only the re-run carrying
  // `--override` reported the `stale-verdict` that was the actual blocker — the operator
  // learned the real state one refusal later than the tool knew it, and at the bound that
  // costs a round of thinking on an exit that was never available.
  if (decision === 'approve') {
    const blockers = []
    // Row 264 (§3.2, row 172). No lens judged a checks-only round, so nothing approves over it: the
    // withholding check names the fix, and a round the lenses judge comes after it.
    if (anchor.checks_only === true) {
      const name = anchor.checks.at(-1)?.name ?? 'a check'
      blockers.push(v('gate', 'checks-only', `round ${anchor.round} ran checks only — ${name} is red, so no lens ran`,
        `a round the lenses judged — fix what ${name} names, then run: ${cliAct('gate', gate, target).line}`))
    }
    if (atBound && !override) {
      blockers.push(v('decision', 'override-required', 'approve at the round bound',
        'witness decide … --approve --override'))
    }
    // A standing stop is only human judgment if the human was shown the thing. The gate
    // refuses the same way, but the gate does not run at the round bound (gate.ts:176) —
    // and approve is the act that stamps, so the line has to hold here too. Sha-keyed:
    // re-authoring invalidates prior sight, as re-capturing invalidates a witnessed
    // screenshot (D71). Only approve — revise and stop need no sight to be honest.
    if (gate === 'design') {
      const unseen = designUnseen(root, cfgR.value.paths, target)
      if (unseen !== undefined) {
        blockers.push(v('design', 'design-unseen', `no sight witnessed for ${short(unseen)}`,
          `a human shown this artifact — run: ${cliAct('design', target, '--open').line}`))
      }
    }
    // A `human-decision` entry is a RECORD — honest about the sha it judged whatever the
    // tree does afterward, which is why D76 declined a write-time staleness check. A stamp
    // is an ASSERTION about current content (`status: approved`, `design: {sha}`), and D75
    // puts staleness checks at consumption. approveMeta reads the artifact from disk and
    // never consults the run, so approving after a re-author blessed unreviewed bytes.
    // `currentSha` is undefined when it cannot be computed (no worktree, missing parent):
    // approve then proceeds, and the entry still honestly records what it judged — this
    // check must never convert an unrelated condition into a misleading refusal.
    const now = nowSha
    if (now !== undefined && now !== anchor.reviewed_sha) {
      // At the bound the gate will not re-run (gate.ts:176), so "go re-gate" would be
      // the lie D67 was written about. The live acts name the ones that actually work —
      // including the repair grant while it is unspent, which is the exit an operator who
      // just fixed the finding is looking for.
      blockers.push(v('gate', 'stale-verdict',
        `verdict @${short(anchor.reviewed_sha)}, content @${short(now)}`,
        atBound
          ? `${exitsLine(live.acts)} (bound reached — the gate will not re-run as it stands)`
          : `a verdict describing current content — run: ${cliAct('gate', gate, target).line}`))
    }
    // Final review F1: a criterion the run held is no longer held, so the verdict never ran
    // what approving it now asserts. Re-gating appends a cached round with fresh checks.
    const lifted = liftedHolds(criteriaOwner(canon, target), anchor)
    if (lifted.length > 0 && !(now !== undefined && now !== anchor.reviewed_sha)) {
      blockers.push(v('gate', 'hold-lifted',
        `${lifted.join(' · ')} held at round ${anchor.round} · its need is met now`,
        atBound
          ? `${exitsLine(live.acts)} (bound reached — the gate will not re-run as it stands)`
          : `a verdict that ran it — run: ${cliAct('gate', gate, target).line}`))
    }
    if (blockers.length > 0) {
      renderRefusal(blockers).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
  }
  // A withheld approve no blocker named is still not live.
  if (withheld) return nothingPending(ctx, root, cfgR.value, canon, gate, target, live, last !== undefined)

  // D121. Recorded, never consumed: divergence between what the block recommended and what
  // the human chose is the only feedback loop the recommender has, and without the record it
  // is transcript archaeology. `recommended` is the VERB of option 1 — the shape of
  // `decision` — so the two are directly comparable in a log query. The full command once
  // carried a prefilled note that changed with the findings, which made two identical
  // recommendations look different.
  const rec = recommend({
    gate, target, entries, upstream: upstreamId,
    // The truth, not `false`. The hardcode existed because a stale state produced no rule at
    // all and the entry's fields would have been empty; with the stale rule in place it only
    // misattributes — D130's audit was reporting rules that were never rendered.
    stale: (nowSha !== undefined && nowSha !== anchor.reviewed_sha) || liftedHolds(criteriaOwner(canon, target), anchor).length > 0 ||
      facts.checksMoved,
  })
  // Row 239. Read off the act's words, never its printed line.
  const recommendedVerb = rec?.options[0]?.act?.argv.find((w) => w === '--approve' || w === '--revise' || w === '--stop' || w === '--book')?.slice(2)
  const entry: DecisionEntry = {
    v: 1, t: 'human-decision', gate, artifact: target, round: anchor.round,
    decision: decision === 'revise' && upstream ? 'revise-upstream' : decision,
    ...(override ? { override: true } : {}),
    ...(repair ? { repair: true as const } : {}),
    ...(note ? { note } : {}),
    ...(recommendedVerb ? { recommended: recommendedVerb } : {}),
    ...(act.rule ?? rec?.rule ? { rule: act.rule ?? rec?.rule } : {}),
    ...(rec?.anchor ? { anchor: rec.anchor } : {}),
    ...(act.selected !== undefined ? { selected: act.selected } : {}),
    ...(act.selected === 'arbiter' ? { reason: act.reason, arbiter: act.arbiter } : {}),
    // Row 270: a booking of a parked gate lifts the park — a human's act, as row 241's revise is.
    ...(unparking || (booking && live.state === 'parked') ? { unpark: true as const } : {}),
    ...(booking ? { book: { check: bookCheck, items: [] } } : {}),
  }
  // D122. A deferral is `--approve --override` (ships with the cause alive) or
  // `--revise --repair` (buys a round without answering anything). One obligation per
  // blocking anchor on the run being disposed of, pointing at the run rather than copying
  // its findings — those already have a home. Kind is `lens-suspicion` when every
  // occurrence of the anchor came from ONE lens across genuinely changed content: that
  // pattern is a tool problem, and filing it as an artifact debt sends the human to fix
  // code that was never wrong.
  const deferring = (decision === 'approve' && override) || repair
  const deferralEntries = deferring
    ? [...new Set((anchor.verdicts ?? []).flatMap((rv) => rv.findings.filter((f) => f.blocking)
        .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`))))]
        .map((a) => {
          const lenses = new Set((anchor.verdicts ?? [])
            .filter((rv) => rv.findings.some((f) => f.blocking &&
              (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`) === a))
            .map((rv) => rv.reviewer))
          // The battery SIZE is part of the discriminator, not just the reporting count:
          // plan, decompose and design each run exactly one lens, so `lenses.size === 1`
          // is trivially true there and every recurring finding at those gates would be
          // filed as a tool problem. The signal is one lens out of SEVERAL disagreeing.
          const battery = (anchor.verdicts ?? []).length
          return {
            v: 1 as const, t: 'deferral' as const, id: newDeferralId(), artifact: target,
            gate, round: anchor.round, anchor: a,
            kind: (lenses.size === 1 && battery > 1 && anchorRecurrence(entries, gate, a) >= 2
              ? 'lens-suspicion' : 'artifact-debt') as DeferralKind,
            caused_by_run: anchor.run_id,
          }
        })
    : []
  const priorPins = entries.filter((e) => e.t === 'policy-pin').length
  const pinEntries = pinTexts.map((text, i) => ({
    v: 1 as const, t: 'policy-pin' as const, artifact: target, gate, round: anchor.round,
    ordinal: priorPins + i + 1, text: text.trim(),
  }))
  const journalMulti = [{ stream: target, line: '' }]
  const files = [journalRel(target)]
  const stamps = decision === 'approve' ? (spec.approveStamps?.(root, canon, target) ?? []) : []
  const metaStamps = decision === 'approve' ? (spec.approveMeta?.(root, canon, cfgR.value, target) ?? []) : []
  const prepared = stamps.flatMap((s) => {
    const doc = findById(canon, s.artifact)
    return doc && String(doc.meta.status) !== s.to
      ? [prepareStamp(doc, s.to, 'gate-approve', { run_id: newRunId() })] : []
  })
  const metaWrites = metaStamps.map((m) => {
    const doc = findById(canon, m.artifact)!
    const mEntry = { v: 1 as const, t: m.entryType as 'design-stamp', artifact: m.artifact, ...m.patch, run_id: newRunId() }
    return {
      rel: doc.rel, meta: { ...doc.meta, ...m.patch }, body: doc.body, stream: m.artifact,
      entry: mEntry as unknown as { t: 'design-stamp'; [k: string]: unknown },
      line: entryLine(mEntry as unknown as { t: 'design-stamp'; [k: string]: unknown }),
    }
  })
  let reopen: { stream: string; entry: DecisionEntry } | undefined
  if (entry.decision === 'revise-upstream' && upstream) {
    const upDoc = findById(canon, upstream)
    if (gate === 'design') {
      // upstream from the design gate is the spec's SLICING — reopen the effort's
      // decompose (scope-level changes chain decompose → recap --amend, Decision 52)
      if (!streamExists(root, upstream)) {
        renderRefusal([v('upstream', 'unknown-effort', upstream, 'the effort slug whose decompose to reopen')]).forEach((l) => ctx.err(l))
        return EXIT.REFUSED
      }
      entry.upstream = { artifact: upstream, gate: 'decompose' }
      reopen = {
        stream: upstream,
        entry: {
          v: 1, t: 'human-decision', gate: 'decompose', artifact: upstream, round: anchor.round,
          decision: 'revise', caused_by: { artifact: target, gate, round: anchor.round },
          ...(note ? { note } : {}),
        },
      }
    } else if (gate === 'decompose') {
      // upstream from decompose is the scope itself — no second stream, hand off to recap --amend
      entry.upstream = { artifact: target, gate: 'recap' }
    } else if (!upDoc) {
      renderRefusal([v('upstream', 'unknown-artifact', upstream, 'a canon doc id')]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    } else if (upDoc.meta.type === 'plan') {
      entry.upstream = { artifact: upstream, gate: 'plan' }
      reopen = {
        stream: upstream,
        entry: {
          v: 1, t: 'human-decision', gate: 'plan', artifact: upstream, round: anchor.round,
          decision: 'revise', caused_by: { artifact: target, gate, round: anchor.round },
          ...(note ? { note } : {}),
        },
      }
    } else {
      // Row 95: decompose gates are keyed on EFFORTS — `computeNext` asks
      // `openReopen(effortEntries, 'decompose')` and nothing anywhere reads a spec's stream
      // for one — so a decompose reopen written on the spec was unreachable by construction.
      // Resolve the owner, exactly as the design gate's branch above already does.
      const owner = effortOf(root, upstream)
      if (owner === undefined) {
        renderRefusal([v('upstream', 'unknown-owner', upstream,
          'a spec some effort wrote — the decompose reopen is booked on the effort stream')])
          .forEach((l) => ctx.err(l))
        return EXIT.REFUSED
      }
      entry.upstream = { artifact: owner, gate: 'decompose' }
      reopen = {
        stream: owner,
        entry: {
          v: 1, t: 'human-decision', gate: 'decompose', artifact: owner, round: anchor.round,
          decision: 'revise', caused_by: { artifact: target, gate, round: anchor.round },
          ...(note ? { note } : {}),
        },
      }
    }
  }

  journalMulti[0]!.line = entryLine(asEntry(entry))
  for (const p of pinEntries) journalMulti.push({ stream: target, line: entryLine(p) })
  for (const d of deferralEntries) journalMulti.push({ stream: target, line: entryLine(d) })
  if (reopen) { journalMulti.push({ stream: reopen.stream, line: entryLine(asEntry(reopen.entry)) }); files.push(journalRel(reopen.stream)) }
  for (const s of prepared) { files.push(s.rel, journalRel(s.stream)); journalMulti.push({ stream: s.stream, line: s.line }) }
  for (const m of metaWrites) { files.push(m.rel, journalRel(m.stream)); journalMulti.push({ stream: m.stream, line: m.line }) }

  let bookedLines: Array<{ id: string; booking: Booking }> = []
  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    // Row 173 — D76's re-read, applied to decisions. Everything above read the stream
    // unlocked, and two settlers racing one stop (two `next` sessions, drive beside a chat)
    // both judged the same pending run. Asked again under the lock, the loser finds the run
    // decided or superseded and refuses, so the race journals exactly one decision.
    const lockedEntries = readStream(root, target)
    // Row 240 (R2): the token again, from the read under the lock. Two reads both taken after
    // the loser's arbiter answered cannot see a decision that landed during that call; the
    // token, taken before it, can.
    if (act.token !== undefined && settledToken(lockedEntries, gate, act.runId ?? '') !== act.token) {
      return settledSince(ctx, gate, target)
    }
    const now = anchorOf(lockedEntries, liveOf(lockedEntries))
    if (now.anchor === undefined || (now.anchor.run_id === anchor.run_id && now.after !== first.after)) {
      renderRefusal([v('gate', 'nothing-pending', `${gate} ${target} — decided since it was read`,
        `a stopped gate-run awaiting a decision — run: ${cliAct('decide', gate, target, '--show').line}`)])
        .forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    if (now.anchor.run_id !== anchor.run_id) {
      renderRefusal([v('gate', 'anchor-moved', `run ${now.anchor.run_id}`,
        `the run the decider judged (${anchor.run_id}) — settle again against the current run`)]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    // Row 270 (§3.3, §3.9's two-stream act). The ledger read again under the lock: an open item with
    // the booking's key is reused, so a booking killed after its lines landed and run again opens
    // nothing twice; the decision names every item, and both streams land in one transaction.
    let ledgerLines: LedgerOpen[] = []
    if (booking) {
      const taken = ledgerTaken(root)
      if (taken !== undefined) { renderRefusal([taken]).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
      const lines = bookLines(root, target, gate, anchor, bookings, note)
      entry.book = { check: bookCheck, items: lines.map((l) => l.id) }
      journalMulti[0]!.line = entryLine(asEntry(entry))
      ledgerLines = lines.flatMap((l) => (l.entry !== undefined ? [l.entry] : []))
      for (const e of ledgerLines) journalMulti.push({ stream: LEDGER_STREAM, line: entryLine(asLedger(e)) })
      if (ledgerLines.length > 0) files.push(journalRel(LEDGER_STREAM))
      bookedLines = lines.map((l) => ({ id: l.id, booking: bookings[lines.indexOf(l)]! }))
    }
    const txn = withTxn(root, { op: `decide-${gate}`, files: [...new Set(files)], journalMulti }, () => {
      appendEntry(root, target, asEntry(entry))
      for (const e of ledgerLines) appendEntry(root, LEDGER_STREAM, asLedger(e))
      for (const p of pinEntries) appendEntry(root, target, p)
      for (const d of deferralEntries) appendEntry(root, target, d)
      if (reopen) appendEntry(root, reopen.stream, asEntry(reopen.entry))
      for (const s of prepared) writeStamp(root, s)
      for (const m of metaWrites) {
        writeDoc(join(root, m.rel), { meta: m.meta, body: m.body })
        appendEntry(root, m.stream, m.entry)
      }
      crashPoint(ctx.env, 'decide-journal')
      return stateCommit(root, [...new Set(files)], `decide(${gate}): ${target} ${entry.decision}`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  } finally {
    lockR.value()
  }

  // Row 200 (Builder's call 5). The look is stamped, so the design session that chose it is over:
  // its draft goes now and not when the look registered, because a behavior note at the approval
  // stop re-opens the look and must find the direction and answers still there. D154's rule below:
  // after the decision is durable, never before.
  if (gate === 'design' && entry.decision === 'approve') dropDraft(root, { kind: 'design', spec: target })

  // D154. After the decision is durable, never before: a refused or crashed decide must
  // not leave a grant behind that nobody chose.
  // Row 222. Through the one locked grant, after decide's own lock is released above (the
  // lock is not re-entrant across a release): the decision stands whatever the grant meets,
  // and a grant it could not land is refused with its rows and the exit says so.
  let grantExit: number = EXIT.OK
  if (trustCmds) {
    // Row 205. The grant takes what `witness trust` would and nothing else: a command holding a
    // character outside printable ASCII is never granted, so it stays blocked and is counted, and
    // "nothing to grant" claims every criterion trusted only when none is left that way.
    const untrusted = untrustedCmdsFor(root, criteriaOwner(canon, target))
    const granted = untrusted.filter((c) => !hasControl(c))
    const unsafe = untrusted.length - granted.length
    if (granted.length > 0) {
      const res = grantTrust(ctx, root, target, granted, 'decide')
      if (res.ok) ctx.out(kv('trusted', granted.join(' · ')))
      else {
        renderRefusal(res.violations).forEach((l) => ctx.err(l))
        ctx.err(`help: the decision landed; grant again once the repo is free — ${cliAct('trust', target).line}`)
        grantExit = res.violations.some((x) => x.rule === 'locked') ? EXIT.BLOCKED : EXIT.REFUSED
      }
    } else {
      ctx.out(kv('trusted', unsafe === 0 ? 'nothing to grant — every cmd: criterion was already trusted' : 'nothing to grant'))
    }
    if (unsafe > 0) ctx.out(kv('trust', unsafeLeft(unsafe)))
  }
  // Row 173: a decision nobody typed says so, with the rule it acted on.
  const by = act.selected === 'policy' || act.selected === 'arbiter'
    ? ` · ${act.selected}${entry.rule ? ` · ${entry.rule}` : ''}` : ''
  ctx.out(kv('decided', `${gate} ${target} → ${entry.decision}${override ? ' (override)' : ''}${by}`))
  if (act.selected === 'arbiter') ctx.out(kv('reason', act.reason))
  // Row 270: each item the booking holds, and the act that reads it. Printed whole (a value holding a
  // comma would be quoted by kv), its part name spelled out. Row 274: a switch-off item by its check,
  // then its token in its file.
  for (const b of bookedLines) ctx.out(`booked: ${b.id} — ${bookName(bookCheck, b.booking)}`)
  if (booking) ctx.out(`help: the re-gate reads it — ${cliAct('gate', gate, target).line}`)
  for (const p of pinEntries) ctx.out(kv('pinned', `#${p.ordinal} ${p.text}`))
  // Row 239. A shape: each foreign word is quoted, and the cause and the note are the human's.
  for (const d of deferralEntries) {
    ctx.out(kv('obligation', `${d.id} — ${d.anchor} · ${d.kind} · open until a later ${gate} run no longer reports it, or witness dismiss ${shellWord(target)} --deferral ${shellWord(d.id)} --cause <superseded|lens-retired|judged-wrong> --note "<why>"`))
  }
  if (repair) {
    // What was bought, and that it does not come again — a grant the human forgets is
    // spent is a second walk into the same wall.
    ctx.out(kv('repair', `one extra round granted — round ${ROUND_BOUND + 1} of ${ROUND_BOUND + 1} is the last, and the grant does not refresh until an approve, a revise-upstream or a passed run`))
    ctx.out(`help: fix the finding, then re-run: ${cliAct('gate', gate, target).line}`)
  }
  if (entry.decision === 'revise' || entry.decision === 'revise-upstream') {
    printReviseContext(ctx, root, {
      gate, target, run: anchor, entries, upstreamId, asked: upstream,
      decision: { note, upstream: entry.upstream, ...(act.selected === 'arbiter' ? { selected: 'arbiter', reason: act.reason } : {}) },
    })
  }
  return grantExit
}

// The revise-context a revise prints, rebuilt from the journal. Row 240: printed by `decide` after
// its own revise, and by a settle that lost the stop to a revise (`superseded`), since the stage
// skills fix "from the revise-context it printed". `asked` is the upstream the act named, when known.
export function printReviseContext(ctx: Ctx, root: string, r: {
  gate: string; target: string; run: GateRunEntry; entries: Entry[]; upstreamId?: string; asked?: string
  decision: Pick<DecisionEntry, 'note' | 'upstream' | 'selected' | 'reason'>
}): void {
  ctx.out('revise-context: (reconstructed from the journal — survives session death)')
  renderGateRun(ctx, r.run, 'ran', { entries: r.entries, help: false, upstream: r.upstreamId })
  const pins = policyPins(readStream(root, r.target))
  if (pins.length > 0) ctx.out(rows('pins', ['ordinal', 'text'], pins as unknown as Array<Record<string, unknown>>).join('\n'))
  if (r.decision.note) ctx.out(kv('note', r.decision.note))
  if (r.decision.selected === 'arbiter' && r.decision.reason !== undefined) ctx.out(kv('reason', r.decision.reason))
  const booked = r.decision.upstream
  if (r.asked !== undefined && booked && r.asked !== booked.artifact) {
    ctx.out(kv('upstream', `${r.asked} is owned by effort ${booked.artifact} — the decompose reopen is booked there`))
  }
  // Row 239. The draft key is one word through the quoter; the recap's file is the human's.
  if (r.gate === 'decompose') ctx.out(`help: scope itself implicated → witness draft ${shellWord(`amend-${r.target}`)} seeds the amendment from the latest recap · witness recap --amend --file <recap.json> lands it`)
  else if (booked) ctx.out(`help: reopened ${booked.artifact} (${booked.gate} stage) — linked via caused_by`)
}

// Row 270. The refusals `--book` meets before any state is read, in order; undefined when none does.
function bookRefusal(ctx: Ctx, root: string, gate: string, target: string, check: string, act: DecisionAct): Violation | undefined {
  if (checkTier(check) === undefined) {
    return v('--book', 'unknown-check', visible(check), `a registered check — ${CHECKS.map((c) => c.name).join(' | ')}`)
  }
  if (checkWaiver(check) === undefined) {
    return v('--book', 'no-waiver', `${check} has no waiver — nobody books its red`,
      `the revise: fix what ${check} names — ${cliAct('decide', gate, target, '--revise').line}`)
  }
  if (act.selected === 'affirmation') {
    return v('--via', 'nod-cannot', 'affirmation with --book', 'a named option — a booking opens a ledger item, and is never taken on a nod (D143)')
  }
  // Row 274 (§3.2's waiver, §3.9). The policy takes rules, never judgments, so it books nothing; the
  // arbiter books a check whose waiver is the judge's, in-process inside the gate a drive session ran.
  const judge = checkWaiver(check) === 'judge'
  if (act.selected === 'policy' || (act.selected === 'arbiter' && !judge)) {
    return v('selected', 'autonomy-cannot', `${act.selected} with --book ${check}`,
      `a named ${judge ? 'selection' : 'human selection'} — ${judge ? `the arbiter or the human books ${check}` : `only the human books ${check} (row 172)`}`)
  }
  if (act.selected === 'arbiter') return ledgerTaken(root)
  // A typed booking: any process witness marked as its own — a drive session, a job — is no human
  // (security review).
  const marker = sessionMarker(ctx.env)
  if (marker !== undefined) {
    return v('decide', 'book-human', `${marker} is set — a session witness started`,
      `the human, in their own chat or terminal — ${cliAct('decide', gate, target, '--book', check).line}`)
  }
  return ledgerTaken(root)
}

// A reader-bound booking names its reader's tool, so the item says whose keys it holds. Lint's alone.
function withTools(cfg: Config, bookings: readonly Booking[]): Booking[] {
  return bookings.map((b) => {
    if (b.kind !== 'booked-check' || !('diagnostics' in b.subject)) return b
    const part = cfg.ship.lint?.find((p) => p.name === b.part)
    const tool = part === undefined ? undefined : boundReader(cfg, part)?.tool
    return tool === undefined ? b : { ...b, tool }
  })
}

// One booking, named: a lint part and what it holds, or a switch-off's check and its token in its file.
// Row 276: a loss's check and its spec's tests.
function bookName(check: string, b: Booking): string {
  return b.kind === 'booked-check' ? `${visible(b.part)} · ${bookWhat(b)}` : `${visible(check)} · ${bookedWhere(b)}`
}

// What one lint booking holds, in words: the count it covers, or the whole part at its base.
function bookWhat(b: Extract<Booking, { kind: 'booked-check' }>): string {
  if ('diagnostics' in b.subject) {
    const n = Object.values(b.subject.diagnostics).reduce((a, x) => a + x, 0)
    return `${n} diagnostic${n === 1 ? '' : 's'}`
  }
  const commit = parseBaseKey(b.part_key)?.commit
  return `the whole part, red against ${commit === undefined ? 'its base' : short(commit)}, until main moves`
}

// The terminal's question under committed autonomy: each part and what booking it takes. Row 274: each
// switch-off line, its token in its file and the rules it names.
function bookQuestion(gate: string, target: string, check: string, anchor: GateRunEntry, bookings: readonly Booking[]): string {
  const parts = anchor.checks.at(-1)?.parts ?? []
  const offs = anchor.checks.find((c) => c.name === check)?.offs ?? []
  const lines = bookings.map((b) => {
    if (b.kind === 'booked-switch-off') {
      const rules = offs.find((o): o is LineOff => o.kind !== 'dropped' && Object.hasOwn(b.subject.lines, o.key))?.rules ?? []
      return `  ${offWhere(b.token, b.file)}${rules.length > 0 ? `: ${rules.map(visible).join(', ')}` : ''}`
    }
    // Row 276: a loss — its spec's tests, the cases it books, and the skips either side.
    if (b.kind === 'booked-dropped') {
      const hit = offs.find((o): o is DroppedOff => o.kind === 'dropped' && o.spec === b.spec)
      const n = b.subject.cases
      return `  ${bookedWhere(b)}: ${n} case${n === 1 ? '' : 's'}, skipped ${b.base.skipped} → ${hit?.plan.skipped ?? '?'}`
    }
    const rules = 'diagnostics' in b.subject ? (parts.find((p) => p.part === b.part)?.rules ?? []) : []
    return `  ${visible(b.part)} — ${bookWhat(b)}${rules.length > 0 ? `: ${rules.map(visible).join(', ')}` : ''}`
  })
  return [`book ${check} for ${gate} ${visible(target)}:`, ...lines, 'book? an item stays open until main no longer holds it [y/N]'].join('\n')
}
