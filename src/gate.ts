import { join } from 'node:path'
import { EXIT, version, type Ctx } from './cli.js'
import { loadConfig, loadLocalConfig, type Config, type DocKey } from './config.js'
import { writeDoc } from './fm.js'
import { crashPoint, guardTxn, pendingTxn, withTxn } from './txn.js'
import { acquireLock } from './lock.js'
import { appendEntry, entryLine, journalRel, policyPins, readStream, type Entry, type ReviseReturnedEntry } from './journal.js'
import { untrustedCmdsFor } from './allowlist.js'
import { primaryRoot, stateCommit } from './gitio.js'
import { criteriaOwner, loadCanon, findById, type Canon } from './scan.js'
import { deferralsBlock, openDeferrals, type DeferralEntry } from './deferral.js'
import { newRunId } from './drift.js'
import { resolveJudge } from './harness.js'
import { ok, refuse, renderRefusal, v, type Result } from './refusal.js'
import { cliAct, exitsLine, reopenRows } from './act.js'
import { cmd, kv } from './toon.js'
import { stageModel, unansweredPin } from './model.js'
import {
  docKeysFor, docsBlock, loadLensDocs, pinsBlock, promptsSha, resolvePrompt,
  type ContentKind, type Lens, type LensDoc,
} from './reviewer.js'
import { runBattery, type BatteryLens } from './battery.js'
import { refuseClash } from './clash.js'
import { refuseHeld } from './held.js'
import { worktreePath } from './worktree.js'
import { gateRunLines, gateRunView } from './gate-run-view.js'
import { anchorFromKey, anchorKey, anchorMenu, type Reviewed } from './verdict.js'
import {
  basisSha, deltaBlock, demote, demotionsBlock, outstandingDemotions, planDelta, reportedBy, type OutstandingDemotion,
} from './delta.js'
import {
  actKey, appendKind, boundReached, disposedRun, fellBack, keyOf, lastGateRun, liveActs,
  roundsSinceApprove, runsSinceReset, sameKey, settledSinceViolation, settledToken, standingHandBack,
  type ActFacts, type AppendKind, type GateCheck, type GateKey, type GateRunEntry, type LiveActs, type ReviewerVerdict,
} from './rounds.js'
export { liveExits } from './rounds.js'
import { actFacts, openStepRow, settlerOwed, stepsOpenViolation } from './verbs/next.js'
import { prepareStamp, writeStamp, type PreparedStamp } from './stamp.js'
import { recommend, renderDecision } from './recommend.js'
import { autonomyLines } from './autonomy.js'
import { reportHandover, slicesLine } from './slice.js'

import type { ChangeClass, GateName } from './settings.js'
import type { JunitSummary } from './junit.js'
export type { ChangeClass, GateName } from './settings.js'

export interface Stamp { artifact: string; to: string }
export interface MetaStamp { artifact: string; patch: Record<string, unknown>; entryType: string }

export interface LensOverride {
  reviewed?: Reviewed
  promptBody?: string
  docs?: LensDoc[]
}

export interface GateInput {
  class: ChangeClass
  reviewedSha: string
  artifactSha?: string
  // The diff term of `reviewedSha` where that sha is composite, so a lapse can attribute
  // itself (row 135). Supplied by the implement gate alone — the only gate whose identity
  // has more than one term that can move independently.
  diffSha?: string
  reviewed: Reviewed
  promptBody: string
  checks: GateCheck[]
  standingStop?: string
  stamps: Stamp[]
  repin?: { rel: string; meta: Record<string, unknown>; body: string; sha: string }
  lensOverrides?: Record<string, LensOverride>   // per-lens reviewed/body/docs (design-reviewer)
  // Row 115: battery members to drop this run, journaled `skipped` WITH the cause. A bare
  // name cannot be read — "not applicable" and "could not run" look identical, and only one
  // of them is benign.
  skipLenses?: Array<{ lens: string; why: string }>
  // Row 186. The artifact as a git tree, and a digest of everything else the prompt carries.
  // Undefined when the tree could not be written; that run is then never a delta base.
  snapshot?: { tree: string; context: string }
  // Row 251. Ship's one suite run, counted (full-suite mode only), journaled on the gate-run.
  junit?: JunitSummary
}

export interface GateSpec {
  gate: GateName
  targetKind: 'effort' | 'plan' | 'spec'
  resolve(root: string, ctx: Ctx, canon: Canon, cfg: Config, target: string): Promise<Result<GateInput>>
  // The sha `resolve` would report for the CURRENT content, without doing resolve's work.
  // `decide --approve` needs it to refuse stamping bytes no gate read (D75: staleness at
  // consumption), and resolve() is not usable there — the ship and implement gates run
  // the test, lint and criteria lanes inside it. Returns undefined when the sha cannot be
  // computed (no worktree, missing parent); the caller then approves rather than
  // converting an unrelated condition into a misleading refusal.
  currentSha?(root: string, canon: Canon, cfg: Config, target: string): string | undefined
  // The id `--revise --upstream` names for this gate. Resolved from canon the caller has
  // already loaded — `liveExits` used to default this to the literal string `<id>`, and a
  // default that produces an unrunnable command is how the placeholder reached every
  // screen (D129). `undefined` means no upstream exists, which makes the option ILLEGAL
  // rather than unresolved: `decide` refuses it with `unknown-owner`, so `liveExits` omits
  // it instead of printing a command the CLI would decline.
  upstreamOf?(root: string, canon: Canon, target: string): string | undefined
  approveStamps?(root: string, canon: Canon, target: string): Stamp[]
  approveMeta?(root: string, canon: Canon, cfg: Config, target: string): MetaStamp[]
  // Row 187. Whether a delta round here demotes a new blocking finding in unchanged content.
  // Only the code gates set it: ship's first round is a later full review of their artifact.
  // The doc gates get the delta block, but nothing re-reads a plan or a slicing in full later.
  demotes?: boolean
  // Plan decision 16. The demoting gate this one is the full review for: every round here lists
  // that gate's outstanding demotions by name, and a re-reported one blocks here. Ship → implement.
  backstops?: GateName
  // Row 216. What this gate's lenses read — the kind of `reviewed` its `resolve` hands over —
  // and, per lens, the kind of an override that lens reads instead (implement's design-reviewer
  // reads screens). A debt is asked of, and cleared by, only a lens that reads one of its kinds.
  reads: ContentKind
  lensReads?: Record<string, ContentKind>
}

const GATES = new Map<string, GateSpec>()

export function registerGate(spec: GateSpec): void { GATES.set(spec.gate, spec) }
export function gateSpec(name: string): GateSpec | undefined { return GATES.get(name) }

// Row 216. What a lens at a gate reads: its override's kind, else the gate's. Undefined for a
// gate nobody registered.
export function readsOf(gate: string, lens?: string): ContentKind | undefined {
  const spec = GATES.get(gate)
  if (!spec) return undefined
  return (lens !== undefined ? spec.lensReads?.[lens] : undefined) ?? spec.reads
}

// Row 216. The declaration is checked against what `resolve` actually handed over: a gate whose
// content and declaration disagree would ask the wrong lenses about debts, so it is a witness
// bug and fails loudly, before any lens runs.
export function assertReads(spec: GateSpec, reviewed: Reviewed, overrides?: Record<string, LensOverride>): void {
  if (reviewed.kind !== spec.reads) {
    throw new Error(`gate ${spec.gate} declares it reads ${spec.reads}, but resolve handed over ${reviewed.kind}`)
  }
  for (const [lens, ov] of Object.entries(overrides ?? {})) {
    if (ov.reviewed !== undefined && ov.reviewed.kind !== spec.lensReads?.[lens]) {
      throw new Error(`gate ${spec.gate} declares ${lens} reads ${String(spec.lensReads?.[lens])}, but its override hands over ${ov.reviewed.kind}`)
    }
  }
}

// Row 216 (K2). A debt is of the kinds its raising lenses read, which neither a move nor a rename
// changes: find the stream that minted it, the round there that raised it, and what each lens
// with a blocking finding at its anchor read. `home` is the stream being judged — an unmoved
// debt's minting stream, read from the entries in hand because `rename` leaves `artifact` stale.
// A moved debt is walked back through each stream's FIRST entry for it, which names where it
// arrived from: a take-back hands a debt home to a stream it already visited. Anything that will
// not read, repeats or is missing falls back to the minting gate's kind.
export function debtKinds(root: string, d: DeferralEntry, home: Entry[]): ContentKind[] {
  const fallback = (): ContentKind[] => { const k = readsOf(d.gate); return k === undefined ? [] : [k] }
  try {
    let minting = home
    if (d.moved_from !== undefined) {
      const seen = new Set<string>()
      let stream = d.moved_from
      for (;;) {
        if (seen.has(stream)) return fallback()
        seen.add(stream)
        const entries = readStream(root, stream)
        const first = entries.find((e) => e.t === 'deferral' && e.id === d.id) as DeferralEntry | undefined
        if (first === undefined) return fallback()
        if (first.moved_from === undefined) { minting = entries; break }
        stream = first.moved_from
      }
    }
    const round = minting.find((e) => e.t === 'gate-run' && e.run_id === d.caused_by_run) as GateRunEntry | undefined
    if (round === undefined) return fallback()
    const kinds = new Set<ContentKind>()
    for (const rv of round.verdicts ?? []) {
      if (!rv.findings.some((f) => f.blocking && anchorKey(f.anchor) === d.anchor)) continue
      const k = readsOf(round.gate, rv.reviewer)
      if (k !== undefined) kinds.add(k)
    }
    return kinds.size > 0 ? [...kinds] : fallback()
  } catch {
    return fallback()
  }
}

// Row 216 (K3). Some lens in this battery reads one of the debt's kinds, so its silence is evidence.
export function judgeable(root: string, d: DeferralEntry, home: Entry[], gate: GateName, lenses: readonly string[]): boolean {
  const kinds = debtKinds(root, d, home)
  return lenses.some((l) => { const k = readsOf(gate, l); return k !== undefined && kinds.includes(k) })
}

// The gate's lenses for these battery names: each prompt, with the docs configured for it at this
// gate and an override's living docs (which join prompts_sha). One home for the gate and a review.
export function gateLenses(
  root: string, cfg: Config, gate: GateName, names: string[], overrides?: Record<string, LensOverride>,
): Result<Lens[]> {
  const lenses: Lens[] = []
  for (const name of names) {
    const lensR = resolvePrompt(name)
    if (!lensR.ok) return lensR
    const lens = lensR.value
    const docPaths = docKeysFor(gate, name).flatMap((k) => cfg.docs[k as DocKey] ?? [])
    let docs: LensDoc[] = []
    if (docPaths.length > 0) {
      const docsR = loadLensDocs(root, docPaths)
      if (!docsR.ok) return refuse(docsR.violations)
      docs = docsR.value
    }
    const ov = overrides?.[name]
    if (ov?.docs?.length) docs = [...docs, ...ov.docs]     // living design joins prompts_sha
    if (docs.length) lens.docs = docs
    lenses.push(lens)
  }
  return ok(lenses)
}

// Row 216 (K3). Each lens's own setup: the pins, then the open debts it can read, then the
// backstop. D122: what a lens is asked joins `prompts_sha` — `text` is every lens's setup under
// its name, sorted by name so the sha, like `promptsSha`, does not depend on battery order — so a
// debt minted for a lens re-invokes the battery.
export function gateSetup(
  root: string, spec: GateSpec, entries: Entry[], lenses: readonly string[],
): { forLens(name: string): string; text: string; backstopped: OutstandingDemotion[] } {
  const pins = pinsBlock(policyPins(entries))
  const debts = openDeferrals(entries).map((d) => ({ d, kinds: debtKinds(root, d, entries) }))
  const backstopped = spec.backstops ? outstandingDemotions(entries, spec.backstops) : []
  const backstop = spec.backstops ? demotionsBlock(spec.backstops, backstopped) : ''
  const forLens = (name: string): string => {
    const reads = spec.lensReads?.[name] ?? spec.reads
    return pins + deferralsBlock(debts.filter((x) => x.kinds.includes(reads)).map((x) => x.d)) + backstop
  }
  const each = [...lenses].sort().map((n) => ({ n, s: forLens(n) }))
  const text = each.every((x) => x.s === '') ? '' : each.map((x) => `### Lens ${x.n}\n\n${x.s}`).join('')
  return { forLens, text, backstopped }
}

// One prompt assembly for the gate and a review (row 215): the lens, its docs, its setup, the
// anchor menu, the content.
export function lensPrompt(lens: Lens, setup: string, menu: string, body: string): string {
  return `${lens.contents}\n\n${docsBlock(lens.docs ?? [])}${setup}${menu ? `${menu}\n\n` : ''}## Reviewed content\n\n${body}\n`
}

// The gate's own reviewers for this class. Their shape — a non-empty list, or a map naming
// every class — is refused when the file loads (row 13, amended by 193), so nothing is left
// to refuse here.
export function batteryFor(cfg: Config, gate: GateName, cls: ChangeClass): Result<string[]> {
  const battery = cfg.gates[gate].reviewers
  return ok(Array.isArray(battery) ? battery : battery[cls])
}

// `entries` is the stream AS OF AFTER this entry: without it the renderer cannot tell the
// round that spends the budget from any other, and rows 109/110 are both about that round.
// `help: false` is for callers that render their own `exits:` line (`decide --show`, which
// prints the run's view itself — `gateRunLines` — and never reaches this tail).
// Rows 139/203. The run's lines come from its view (src/gate-run-view.ts); only the help tail,
// which loads canon and the trust list, stays here.
// `sha`: the content's sha now, where the caller holds it (the gate that just resolved it); without
// it the choices compute it, as `decide` does.
export function renderGateRun(
  ctx: Ctx, entry: GateRunEntry, mode: 'ran' | 'resume',
  opts: { entries?: Entry[]; help?: boolean; upstream?: string; sha?: string } = {},
): void {
  gateRunLines(gateRunView(entry, mode, opts.entries)).forEach((l) => ctx.out(l))
  // Without `entries` this stays a pure formatter over the entry it was handed, and the
  // off-bound triple is the right answer; with them it tells the truth at the bound too.
  if (entry.outcome !== 'passed' && opts.help !== false) {
    renderChoices(ctx, entry.gate, entry.artifact, opts.entries ?? [], opts.upstream, { sha: opts.sha })
  }
}

// Row 244 (#87, design §4.2.1, §4.2.9). The facts `decide` reads beside the journal (`actFacts`):
// staleness and lifted holds against the last run that judged something, the upstream, and owed
// work. `sha` is the content's sha now when the caller holds it; otherwise the gate computes it.
function factsHere(
  root: string, cfg: Config | undefined, canon: Canon, gate: string, target: string, entries: Entry[],
  upstream: string | undefined, sha?: string,
): ActFacts {
  const now = sha ?? (cfg !== undefined ? gateSpec(gate)?.currentSha?.(root, canon, cfg, target) : undefined)
  return actFacts(root, cfg, canon, gate, target, entries, { sha: now, upstream })
}

// The gate's state and its live acts, as `decide` would read them now.
function liveHere(root: string, gate: string, target: string, entries: Entry[]): LiveActs {
  const cfgR = loadConfig(root)
  const cfg = cfgR.ok ? cfgR.value : undefined
  const canon = loadCanon(root)
  const upstream = gateSpec(gate)?.upstreamOf?.(root, canon, target)
  return liveActs(gate, target, entries, factsHere(root, cfg, canon, gate, target, entries, upstream))
}

// D121: the exits line stated which commands would not refuse and never which to take, so
// --approve read as the default at stops with a live blocking finding. The block ranks them.
// One renderer for all four decision surfaces in this file — a per-site copy is how D119's
// nine hand-copied exits sets happened, and three of these four sites were among them.
// Row 244 (#87): both read the gate's live acts, through the facts `decide` reads (S2-1), so a
// screen offers exactly what `decide` accepts. `undefined` from `recommend` is a state with no
// block — the revised state on moved content, where the re-gate is the one act (D131), a settled
// gate's retraction, a park's way back — and the exits line names its live acts. `session` prints
// the session's line (design §4.2.2) above them, on the changed-nothing screen.
function renderChoices(
  ctx: Ctx, gate: string, target: string, entries: Entry[], upstream: string | undefined,
  opts: { sha?: string; session?: boolean } = {},
): void {
  // D154. Resolved here rather than threaded through four call sites, on this file's own
  // precedent (`printSliceShape` loads canon itself so the entry-renderers stay
  // pure formatters). Best-effort: a root that will not resolve costs the trust variants and the
  // facts beside the journal, never the block.
  const rootR = primaryRoot(ctx.cwd)
  const canon = rootR.ok ? loadCanon(rootR.value) : undefined
  const cfgR = rootR.ok ? loadConfig(rootR.value) : undefined
  const untrustedCmds = rootR.ok && canon !== undefined ? untrustedCmdsFor(rootR.value, criteriaOwner(canon, target)) : []
  const facts: ActFacts = rootR.ok && canon !== undefined
    ? factsHere(rootR.value, cfgR?.ok ? cfgR.value : undefined, canon, gate, target, entries, upstream, opts.sha)
    : { upstream, stale: false, holdLifted: false, owed: false, upstreamOwed: false }
  const live = liveActs(gate, target, entries, facts)
  if (opts.session === true && live.session !== undefined) ctx.out(kv('session', live.session))
  const d = recommend({ gate, target, entries, upstream, stale: facts.stale || facts.holdLifted, untrustedCmds })
  if (d) renderDecision(d).forEach((l) => ctx.out(l))
  else if (live.acts.length > 0) ctx.out(cmd('help', exitsLine(live.acts)))
}

// Row 79: the human approving a plan sees the run's shape before it starts. Row 191 §4.10:
// under a measured harness that shape is the rule that will cut the run into slices, not a
// count of them. Display only — no lens, no threshold; loads config/canon itself so the
// entry-renderers stay pure formatters.
export function printSliceShape(ctx: Ctx, root: string, gateName: string, target: string): void {
  if (gateName !== 'plan') return
  const cfg = loadConfig(root)
  if (!cfg.ok) return
  const doc = findById(loadCanon(root), target)
  if (!doc || doc.meta.type !== 'plan') return
  ctx.out(kv('slices', slicesLine(cfg.value)))
}

// Row 173. The gate, then — under `autonomy: on` and not a `--manual` run — the settling of
// the stop it produced or re-showed, in the same invocation, so a chat session and drive
// meet one rule. Below that line nothing changes: with autonomy off this is `judge` alone.
export async function runGate(
  ctx: Ctx, gateName: string, target: string,
  flags: { fresh: boolean; manual: boolean; handover?: boolean; unchanged?: boolean },
): Promise<number> {
  // Row 244 (design §4.2.4; the first build's review S3-4). `--fresh` re-judges the same content and
  // spends a round; `--unchanged` hands the revise back unjudged. Together they ask for both, so the
  // gate refuses before anything is read or run.
  if (flags.fresh && flags.unchanged) {
    renderRefusal([v('--unchanged', 'fresh-unchanged', '--fresh with --unchanged',
      'one of them — `--unchanged` hands the revise back unjudged; `--fresh` re-judges the same content and spends a round')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  // Row 241 (R11). A `--fresh` refused on a parked gate is a human's call: the way back that can
  // succeed is the revise that sends the gate back to work, named on a row of its own. Row 244: the
  // park's live acts but the `--fresh` just refused — the revise below the bound, the endgame at it.
  const parked = flags.fresh ? parkedHere(ctx, gateName, target) : undefined
  const refusedFresh = (code: number): number => {
    if (parked !== undefined && code === EXIT.REFUSED) {
      const fresh = actKey(cliAct('gate', gateName, target, '--fresh'))
      ctx.err(`help: ${gateName} ${target} is parked — sending it back to work is a human's call`)
      reopenRows(parked.acts.filter((a) => actKey(a) !== fresh)).forEach((l) => ctx.err(l))
    }
    return code
  }
  if (gateName === 'implement' || gateName === 'ship') {
    const rootR = primaryRoot(ctx.cwd)
    const plan = rootR.ok ? findById(loadCanon(rootR.value), target) : undefined
    if (rootR.ok && plan?.meta.type === 'plan') {
      // Row 243 (design §4.1.2). No review starts on a plan's worktree while a clash is unresolved:
      // refused first, before the battery and whatever the config says, journaling nothing, each
      // file on a row with its remedy.
      const clashed = refuseClash(ctx, rootR.value, target)
      if (clashed !== undefined) return clashed
      // Row 247. Nor over a crashed verify-red's set-aside state: the plan's work goes back first, or
      // the gate refuses verify-red-pending — a battery over the base's tree judges code nobody wrote.
      const held = refuseHeld(ctx, rootR.value, target, worktreePath(rootR.value, target))
      if (held !== undefined) return held
      // Row 241 (R9; the user's decisions 6 and 9). No implement review starts while a plan step is
      // open, whoever starts it: refused before the battery, journaling nothing, naming the step's
      // command. To skip a step, amend the plan and drop it.
      const cfgR = gateName === 'implement' ? loadConfig(rootR.value) : undefined
      const open = cfgR?.ok ? openStepRow(rootR.value, cfgR.value, plan) : undefined
      if (open !== undefined) {
        renderRefusal([stepsOpenViolation(open)]).forEach((l) => ctx.err(l))
        return refusedFresh(EXIT.REFUSED)
      }
    }
  }
  const code = await judge(ctx, gateName, target, flags)
  if (code !== EXIT.FINDINGS && code !== EXIT.BLOCKED) return refusedFresh(code)
  if (flags.manual) return code
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) return code
  const cfgR = loadConfig(rootR.value)
  if (!cfgR.ok || !cfgR.value.autonomy || pendingTxn(rootR.value) !== undefined) return code
  // A dynamic import: settle.ts reaches decide.ts, whose gates/index.js import would close a
  // static cycle through this module — each gate's registerGate would run before GATES exists.
  const { busyLine, settleStop, settledCode } = await import('./settle.js')
  const settled = await settleStop(ctx, rootR.value, cfgR.value, gateName, target)
  // Row 240: another run holds this stop's settle lock — it is deciding it; nothing to do here.
  if (settled.kind === 'busy') ctx.out(busyLine(gateName, target, settled))
  // Row 191 §4.4. A revise settled here is handed to the session that ran the gate, so this is
  // where a session at its limit hands it to a fresh one. Ship passes `handover: false`: its run
  // hands over once, at its own exit (Plan's call 7).
  // Row 240: a revise another decider landed first is handed over just the same.
  const revised = (settled.kind === 'decided' || settled.kind === 'superseded') &&
    (settled.decision === 'revise' || settled.decision === 'revise-upstream')
  if (revised && flags.handover !== false) reportHandover(ctx, rootR.value, cfgR.value, { guard: false })
  return settledCode(code, settled)
}

// Row 244 (#87, design §4.2.4). What `--unchanged` read before anything ran: the run the revise
// disposed of, row 240's token over the decisions after it, and the gate's last run.
interface HandBackRead { run: GateRunEntry; token: string; lastRun: string }

// Design §4.2.9. `--unchanged`'s refusals come from liveActs' state, as `decide` reads it: at the bound
// the endgame decides; a hand-back already stands; a retraction asks for a re-review; the gate's own
// upstream revise is still owed there (P48); anything but a revise has nothing to hand back. Only the
// revised state is read on, and it names the run its revise disposed of.
function handBackRead(root: string, cfg: Config, canon: Canon, spec: GateSpec, target: string): Result<HandBackRead> {
  const gate = spec.gate
  const entries = readStream(root, target)
  const facts = factsHere(root, cfg, canon, gate, target, entries, spec.upstreamOf?.(root, canon, target))
  const live = liveActs(gate, target, entries, facts)
  const at = `${gate} ${target}`
  const no = (rule: string, got: string, want: string) => refuse<HandBackRead>([v('--unchanged', rule, got, want)])
  const show = cliAct('decide', gate, target, '--show').line
  const next = cliAct('next').line
  const disposed = disposedRun(entries, gate)
  if (live.state === 'at-bound') return no('hand-back-at-bound', `${at} — the round bound is spent`, `the endgame, which decides the gate at the bound — ${show}`)
  if (live.state === 'handed-back' || live.state === 'handed-back-moved') {
    return no('hand-back-standing', `${at} — round ${disposed?.run.round ?? '?'} is handed back already`, `its decision, owed again — ${show}`)
  }
  if (live.state === 'retracted') {
    return no('retraction-owed', `${at} — the revise retracted a settled verdict`, `a re-review, not a hand-back — ${live.acts[0]!.line}`)
  }
  if (live.state !== 'revised' || disposed === undefined) {
    return no('nothing-to-hand-back', live.state === 'none' ? `${at} has no live act` : `${at} is ${live.state}`,
      `a revise standing on the gate's last round — ${next} routes what is owed`)
  }
  if (facts.upstreamOwed) {
    return no('upstream-owed', `${at} — the revise sent the work upstream, and it is owed there still`, `that work landed first — ${next} routes it`)
  }
  return ok({ run: disposed.run, token: settledToken(entries, gate, disposed.run.run_id), lastRun: lastGateRun(entries, gate)!.run_id })
}

// S3-1. The read still stands: the same disposed run, the same token, no run since, no hand-back.
function handBackHolds(entries: Entry[], gate: string, read: HandBackRead): boolean {
  return disposedRun(entries, gate)?.run.run_id === read.run.run_id &&
    settledToken(entries, gate, read.run.run_id) === read.token &&
    lastGateRun(entries, gate)?.run_id === read.lastRun &&
    standingHandBack(entries, gate) === undefined
}

// Why `--unchanged` handed nothing back, from what the gate does instead (design §4.2.4, P11). Worded
// without a comma, so the `note:` line prints unquoted, and never as `witness <word>` before a value,
// which would read as a witness command printing a bare value (row 239's prose-quote lint).
function notHandedBack(kind: AppendKind, key: GateKey, disposed: GateRunEntry): string {
  const n = `round ${disposed.round}`
  if (kind.kind === 'cached' && kind.from.run_id === disposed.run_id) return `a check changed since ${n} — the gate replays its verdicts with the checks as they stand`
  if (kind.kind === 'repair') return 'the last round was malformed on this content — the gate repairs it'
  if (fellBack(disposed)) return `${n} fell back from its pin — its verdict answers nothing`
  if (key.reviewed_sha !== disposed.reviewed_sha) return `the content moved since ${n}`
  if (key.witness !== disposed.witness) return `witness's version moved from ${disposed.witness} to ${key.witness} since ${n} — its verdict no longer answers the content`
  if (!sameKey(keyOf(disposed), key)) return `the reviewer setup (prompts or pin or harness) moved since ${n}`
  return `the gate does not pair this content with ${n}`
}

// Design §4.2.4. The hand-back: journaled under the lock once the read is checked again (S3-1), then
// the screen — `outcome: handed back` and, with autonomy off or a stop left to the human, the decision
// block. It exits 1; under autonomy the gate's tail settles it.
function handBackRound(
  ctx: Ctx, root: string, gate: string, target: string, read: HandBackRead,
  opts: { sha: string; manual: boolean; upstream: string | undefined; leftToTail: (es: Entry[]) => boolean },
): number {
  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  const release = lockR.value
  try {
    const entriesNow = readStream(root, target)
    if (!handBackHolds(entriesNow, gate, read)) {
      renderRefusal([settledSinceViolation(gate, target)]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    const entry: ReviseReturnedEntry = {
      v: 1, t: 'revise-returned', gate, artifact: target, run_id: read.run.run_id, sha: opts.sha,
      ...(opts.manual ? { manual: true as const } : {}),
    }
    const line = entry as unknown as { t: 'revise-returned'; [k: string]: unknown }
    const files = [journalRel(target)]
    const txn = withTxn(root, { op: `gate-${gate}`, files, journal: { stream: target, line: entryLine(line) } }, () => {
      appendEntry(root, target, line)
      crashPoint(ctx.env, 'gate-journal')
      return stateCommit(root, files, `gate(${gate}): ${target} round ${read.run.round} handed back`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const after = [...entriesNow, line as unknown as Entry]
    ctx.out(kv('gate', gate))
    ctx.out(kv('outcome', `handed back — the content is as round ${read.run.round} read it; the revise is decided again`))
    if (!opts.leftToTail(after)) renderChoices(ctx, gate, target, after, opts.upstream, { sha: opts.sha })
    return EXIT.FINDINGS
  } finally {
    release()
  }
}

// The park's live acts, when the gate is parked.
function parkedHere(ctx: Ctx, gateName: string, target: string): LiveActs | undefined {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) return undefined
  const live = liveHere(rootR.value, gateName, target, readStream(rootR.value, target))
  return live.state === 'parked' ? live : undefined
}

async function judge(
  ctx: Ctx, gateName: string, target: string, flags: { fresh: boolean; manual: boolean; unchanged?: boolean },
): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked

  const spec = gateSpec(gateName)
  if (!spec) {
    renderRefusal([v('gate', 'unknown-gate', gateName, 'decompose | plan | implement | ship | design')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  // `--manual` keeps this run's stop for a human, so for this run autonomy is off and the
  // CLI does not claim otherwise.
  if (!flags.manual) autonomyLines(cfgR.value).forEach((l) => ctx.out(l))
  // Row 173. Under autonomy the tail settles the stop, so the block is ITS to print — the
  // human's when the stop is kept, nobody's when the CLI decides. Left in place for a stop
  // the tail will not touch: a `--manual` run's or a `--manual` hand-back's (row 244), a parked or
  // settled one, a malformed round — the settle's own reading (`settlerOwed`).
  const autonomous = cfgR.value.autonomy && !flags.manual
  const leftToTail = (es: Entry[]): boolean => autonomous && settlerOwed(es, gateName) !== undefined
  const canon = loadCanon(root)
  // Row 244 (#87, design §4.2.4, §4.2.9). `--unchanged` is read from the journal before `resolve`, so a
  // refusal spends no lane and no battery and journals nothing. The read keeps the run the revise
  // disposed of and row 240's token over the decisions after it, checked again below (S3-1).
  let handBack: HandBackRead | undefined
  if (flags.unchanged === true) {
    const readR = handBackRead(root, cfgR.value, canon, spec, target)
    if (!readR.ok) { renderRefusal(readR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    handBack = readR.value
  }
  const inputR = await spec.resolve(root, ctx, canon, cfgR.value, target)
  if (!inputR.ok) { renderRefusal(inputR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const input = inputR.value
  assertReads(spec, input.reviewed, input.lensOverrides)              // row 216, before any lens runs
  // Resolved once for every render this run performs — the entry renderers stay pure
  // formatters (they take the id, they never look it up).
  const upstreamId = spec.upstreamOf?.(root, canon, target)

  const batteryR = batteryFor(cfgR.value, spec.gate, input.class)
  if (!batteryR.ok) { renderRefusal(batteryR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const skip = new Map((input.skipLenses ?? []).map((s) => [s.lens, s.why]))
  const active = batteryR.value.filter((n) => !skip.has(n))
  const dropped = batteryR.value.filter((n) => skip.has(n)).map((n) => `${n} — ${skip.get(n)!}`)
  const entries = readStream(root, target)
  // S3-1. A decision, a run or a hand-back that landed while the gate resolved (ship's and implement's
  // lanes run there) is one the author never read: no hand-back stands on it, and nothing runs for it.
  if (handBack !== undefined && !handBackHolds(entries, spec.gate, handBack)) {
    renderRefusal([settledSinceViolation(spec.gate, target)]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const lensesR = gateLenses(root, cfgR.value, spec.gate, active, input.lensOverrides)
  if (!lensesR.ok) { renderRefusal(lensesR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const lenses = lensesR.value
  // D122. Open obligations join the prompt exactly as pins do, and join `prompts_sha` for
  // the same reason: an obligation the battery did not see is an obligation nothing can
  // discharge. Minting one therefore guarantees the next round re-invokes the battery,
  // which is the intended cost of an override rather than an accident of the cache.
  // Row 216: each lens is asked only about the debts it can read.
  const setup = gateSetup(root, spec, entries, active)
  const hxR = resolveJudge(ctx.env, cfgR.value.harness)
  if (!hxR.ok) { renderRefusal(hxR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const harness = hxR.value.harness
  const localR = loadLocalConfig(root)
  if (!localR.ok) { renderRefusal(localR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const extras = {
    timeoutMs: cfgR.value.gates.reviewerTimeoutMs,
    extensions: localR.value.reviewerExtensions,
  }
  const modelR = stageModel(cfgR.value, spec.gate)
  if (!modelR.ok) { renderRefusal(modelR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }

  // Row 106: the key is built BEFORE invoking, so the model it names is the one being asked
  // for. Since row 212 that is the only model a lens is asked on, but a 0.25.x round's
  // `model` may name a stand-in, so the brake below compares `pin`.
  const pin = modelR.value
  const basis = basisSha(lenses, input.snapshot?.context ?? '', pin, harness.name)
  const backstopped = setup.backstopped
  const setupSha = promptsSha(lenses, setup.text || undefined)         // the full-review prompts_sha
  const fullKey: GateKey = {
    reviewed_sha: input.reviewedSha, gate: spec.gate, prompts_sha: setupSha, pin, witness: version(),
    harness: harness.name,
  }
  // Row 185. A lens that reads an override (the design-reviewer's captures) always reviews in
  // full: its content has no tree, and the base's findings from it mean nothing to the others.
  const inDelta = (lens: string) => input.lensOverrides?.[lens]?.reviewed === undefined
  // The key is the content and the setup (row 185, `keyOf`): any run that read this content under
  // this setup resumes, meets changed-nothing or replays, whether it was a full or a delta round.
  // Only a fresh key plans a delta, further down.
  const key: GateKey = fullKey
  // D99: a new run that judges something un-settles the gate. Content moving is a legitimate,
  // self-explaining reason. A flag is not — `--fresh` discarded a human decision with nothing
  // printed and nothing journaled about it, and row 94 removed its other job (escaping the
  // changed-nothing deadlock), so it can refuse and send the human through the verb that states a
  // retraction and its reason.
  // Row 244 (P8, S2-3). Settled for the content the settlement judged, as `liveActs` reads it: on
  // moved content the approval lapsed (D75) and `--fresh` runs; after a retraction or a stop the
  // gate is no longer settled (design §4.2.3). One reading for the refusal and for the setup-change
  // warning below, so neither speaks of a settlement the other does not see. Read once, and only
  // where one of them asks: the facts can cost a flow read.
  let settledRead: { live: LiveActs; settled: boolean } | undefined
  const settledBefore = (): { live: LiveActs; settled: boolean } => settledRead ??= (() => {
    const facts = factsHere(root, cfgR.value, canon, spec.gate, target, entries, upstreamId, input.reviewedSha)
    const live = liveActs(spec.gate, target, entries, facts)
    return { live, settled: live.state === 'settled' && !facts.stale && !facts.holdLifted }
  })()
  // The want names the settled state's live act, the retraction, then the `--fresh` that re-judges
  // after it (design §4.2.3).
  if (flags.fresh && settledBefore().settled) {
    renderRefusal([v('gate', 'settled-approve', `${spec.gate} ${target} is settled`,
      `${exitsLine(settledBefore().live.acts)} — retract the settlement, then ${cliAct('gate', spec.gate, target, '--fresh').line} re-judges it`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  let kind = flags.fresh ? { kind: 'fresh' as const } : appendKind(entries, spec.gate, key)
  // Row 112. The cache key is the REVIEWED content digest, but the deterministic checks
  // read inputs it cannot see — decompose's `goal-coverage`/`spec-coverage` read journaled
  // `covers`, `amendment-ack` reads a sibling plan's pin, `graph` reads the whole canon. So
  // correcting a goal mapping left the doc bytes untouched, the key unmoved, and `resume`
  // served a blocking finding describing a state that no longer existed; `--fresh` was the
  // only escape, and an operator who did not think of it spent a human decision on it.
  // `resolve` has already recomputed the checks by this point — the fresh answer was in
  // hand and thrown away. A flip is a new judgment, so it appends a real round rather than
  // silently re-rendering; the verdicts are REPLAYED (`cached`), so no battery is spent.
  // Compared on `ok` alone: a detail carries run output on some gates (timings, paths), and
  // keying on it would append a round for every re-run of an unchanged tree.
  // A check trust kept from running and one that ran and failed are both `ok: false`, but they
  // are different judgments: granting the command flips the first into the second, and without
  // this term the gate resumed the blocked round forever while the policy re-ran it (F3).
  // A hold that lifts or lands is a new judgment too (row 179): the lane may stay green while
  // the set of criteria it did not run changes, and a resumed round would re-render a stale `held:`.
  // Row 263 (slice 3 review): so is a lint part's verdict. A part `pending` its base result reads
  // `red` (or `new`, `not-judged`) once drive has linted the base, with the same `ok: false`; a
  // resumed round would keep the pending one, and the judged verdict — what T2d and T2e read, and
  // a key drive must see journaled — would never be written. States are deterministic for one tree
  // and one base result, so this term never churns.
  const checkOk = (cs: GateCheck[]) =>
    cs.map((c) => `${c.name}:${c.ok}${(c.untrusted?.length ?? 0) > 0 ? ':blocked' : ''}:${
      (c.held ?? []).map((h) => h.criterion).sort().join('+')}${
      c.parts !== undefined ? `:${c.parts.map((p) => `${p.part}=${p.state}`).join(',')}` : ''}`).sort().join('|')
  if ((kind.kind === 'resume' || kind.kind === 'changed-nothing') &&
      checkOk(kind.entry.checks) !== checkOk(input.checks) &&
      kind.entry.outcome !== 'malformed' && (kind.entry.verdicts?.length ?? 0) > 0) {
    kind = { kind: 'cached' as const, from: kind.entry }
  }
  // Row 244 (design §4.2.4). Where the gate would answer changed-nothing about the run the revise
  // disposed of — content, setup and checks as that run read them — `--unchanged` journals the author's
  // hand-back instead. Anywhere else (a check flipped, the content or the key moved, an upgrade
  // included, a malformed round to repair) it runs as the plain gate and says why nothing was handed back.
  if (handBack !== undefined) {
    if (kind.kind === 'changed-nothing' && kind.entry.run_id === handBack.run.run_id) {
      return handBackRound(ctx, root, spec.gate, target, handBack, {
        sha: input.reviewedSha, manual: flags.manual, upstream: upstreamId, leftToTail,
      })
    }
    ctx.out(kv('note', `nothing was handed back — ${notHandedBack(kind, key, handBack.run)}`))
  }
  // A key that moved for a NON-content reason — edited prompt, re-pinned model, new
  // witness version — un-settles just as quietly as --fresh did. Content moving explains
  // itself; this does not. `settledBefore` is already for the content as it stands (row 244).
  if (kind.kind === 'fresh' && settledBefore().settled) {
    ctx.err(`warning: reviewer setup changed — this run discards the settled approve on ${spec.gate} ${target}`)
  }
  if (kind.kind === 'resume') {
    renderGateRun(ctx, kind.entry, 'resume', {
      entries, upstream: upstreamId, sha: input.reviewedSha,
      ...(kind.entry.outcome === 'stopped' && leftToTail(entries) ? { help: false } : {}),
    })
    printSliceShape(ctx, root, spec.gate, target)
    return kind.entry.outcome === 'passed' ? EXIT.OK : EXIT.FINDINGS
  }
  if (kind.kind === 'changed-nothing') {
    ctx.out(kv('gate', spec.gate))
    ctx.out(kv('outcome', 'revise changed nothing — reviewed content is identical to the last round'))
    // The owed work is an EDIT, so the exits are the decisions that remain legal without
    // one — the same set every other screen shows, rather than prose naming two of four.
    // Row 244: the state's live acts, under the session's line (design §4.2.2). A standing hand-back
    // is a decision owed, not an edit: under autonomy its block is the tail's, which settles it (row
    // 173, design §4.2.2), and a `--manual` one's stays here for the human.
    if (!leftToTail(entries)) renderChoices(ctx, spec.gate, target, entries, upstreamId, { sha: input.reviewedSha, session: true })
    return EXIT.FINDINGS
  }
  if (boundReached(entries, spec.gate)) {
    ctx.out(kv('gate', spec.gate))
    ctx.out(kv('outcome', `round bound reached (${roundsSinceApprove(entries, spec.gate)} rounds since last approve)`))
    if (!leftToTail(entries)) renderChoices(ctx, spec.gate, target, entries, upstreamId, { sha: input.reviewedSha })
    return EXIT.BLOCKED
  }
  if (!flags.fresh) {
    // Both brakes guard the SAME window as the round budget (rounds.ts): exempt rounds
    // could otherwise repeat for free, and a run on the far side of an approve was
    // disposed of and can trip nothing.
    const tail = runsSinceReset(entries, spec.gate).slice(-2)
    const samePin = (r: GateRunEntry) =>
      (r.pin ?? r.model) === key.pin && (r.harness ?? 'claude-code') === key.harness
    // malformed rounds don't spend the bound either — this brake is what stops an
    // unreliable battery from re-running for free forever instead. Row 106: "same setup"
    // always meant the same PIN, and comparing the answering rung meant two malformed
    // fallen-back rounds never matched, which is the one thing this exists to stop.
    // Row 185: the SETUP, not the prompt — two delta rounds over changing content carry
    // different blocks under one setup, and comparing prompts_sha would never fire on them.
    const sameSetup = (r: GateRunEntry) =>
      r.outcome === 'malformed' && samePin(r) && (r.setup_sha ?? r.prompts_sha) === setupSha
    if (tail.length === 2 && tail.every(sameSetup)) {
      renderRefusal([v('reviewers', 'malformed-streak',
        `${tail.length} consecutive malformed rounds on ${tail[1]!.model}`,
        `a changed gates.${spec.gate}.model pin or updated prompts — the battery is emitting invalid verdicts (or force with --fresh)`,
      )]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
  }

  // The reviewer battery runs UNLOCKED. It writes nothing — every symbol it produces is
  // an in-memory local, and reviewer caching is journal-derived (appendKind), not on-disk.
  // Holding the repo-global lock across a multi-minute LLM battery refuses every state
  // write in every other flow for its full duration, on a lock whose real job is a ~100ms
  // commit. The guarded window opens below, immediately before the journal append.
  // Full review first: a delta is planned only for a round that will judge (the key is fresh,
  // or a malformed round is being repaired).
  const delta = kind.kind === 'fresh' || kind.kind === 'repair'
    ? planDelta(root, entries, spec.gate, { reviewedSha: input.reviewedSha, snapshot: input.snapshot, basis, reviewed: input.reviewed, inDelta })
    : undefined
  const block = delta ? deltaBlock(delta) : ''
  const askedSha = delta ? promptsSha(lenses, setup.text + block) : setupSha
  // Row 209. A repair carries verdicts only when the question is the same: a moved delta base
  // (git gc pruned it, a judged round landed) asks every lens what the malformed round did not.
  if (kind.kind === 'repair' && kind.from.prompts_sha !== askedSha) kind = { kind: 'fresh' as const }
  const repairFrom = kind.kind === 'repair' ? kind.from : undefined
  // A replayed delta verdict re-serves a round that already discharged all its silence could.
  const replayedDelta = kind.kind === 'cached' && kind.from.delta !== undefined
  let verdicts: ReviewerVerdict[] = []
  let malformed: NonNullable<GateRunEntry['malformed']> = []
  let rerolled: string[] = []
  let model = pin
  let cached = false
  let carried: string[] = []

  if (kind.kind === 'cached') {
    verdicts = kind.from.verdicts ?? []
    model = kind.from.model
    cached = true
  } else {
    // Row 169: every lens at once — a round's wall clock is its slowest lens, not their sum.
    const composed: BatteryLens[] = lenses.map((lens) => {
      const ov = input.lensOverrides?.[lens.name]
      // Row 208. A delta-mode lens's floor counts the change; an override lens reviews in full.
      const reviewed = ov?.reviewed ?? (delta?.paths && input.reviewed.kind === 'tree'
        ? { ...input.reviewed, floor: { round: delta.baseRound, paths: delta.paths } } : input.reviewed)
      const body = ov?.promptBody ?? input.promptBody
      return {
        name: lens.name, reviewed,
        prompt: lensPrompt(lens, setup.forLens(lens.name) + (delta && inDelta(lens.name) ? block : ''), anchorMenu(reviewed), body),
      }
    })
    // Row 209. A repair asks only the lenses with no verdict in the malformed round. Both runs
    // asked the pin alone (row 212; appendKind never repairs a 0.25.x fallen-back round), so
    // the round's `model` stays the pin.
    const kept = new Map((repairFrom?.verdicts ?? []).map((rv) => [rv.reviewer, rv]))
    const pinField = `gates.${spec.gate}.model`
    const ranR = await runBattery(ctx, harness, pin, composed.filter((l) => !kept.has(l.name)), { cwd: root, pinField, ...extras })
    if (!ranR.ok) {
      renderRefusal(unansweredPin(ranR.violations, pinField, pin, harness.name)).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    ;({ malformed } = ranR.value)
    const answered = new Map(ranR.value.verdicts.map((rv) => [rv.reviewer, rv]))
    const names = lenses.map((l) => l.name)
    verdicts = names.flatMap((n) => { const rv = kept.get(n) ?? answered.get(n); return rv ? [rv] : [] })
    carried = names.filter((n) => kept.has(n))
    rerolled = names.filter((n) => (kept.has(n) ? repairFrom?.rerolled ?? [] : ranR.value.rerolled).includes(n))
    // A malformed round judged nothing, so it demotes nothing.
    // A backstopping gate never demotes what it backstops: it promised the listed finding blocks here.
    if (delta && spec.demotes && malformed.length === 0) {
      const listed = reportedBy(backstopped.map((d) => d.anchor), input.reviewed.kind === 'tree')
      verdicts = demote(verdicts, { ...delta, reported: (a) => delta.reported(a) || listed(a) }, inDelta)
    }
  }

  const blocking = verdicts.flatMap((x) => x.findings).filter((f) => f.blocking).length
  const pinConflicts = verdicts.flatMap((x) => x.findings).filter((f) => f.contradicts_pin !== undefined).length
  const standing = [
    input.standingStop,
    pinConflicts > 0 ? 'contradicts-pin — a finding disputes a settled policy pin; the human decides which one dies' : undefined,
  ].filter((s): s is string => s !== undefined).join(' · ') || undefined
  const checksGreen = input.checks.every((c) => c.ok)
  const outcome: GateRunEntry['outcome'] =
    malformed.length > 0 ? 'malformed'
    : !checksGreen || blocking > 0 ? 'stopped'
    : standing !== undefined || flags.manual ? 'stopped'
    : 'passed'

  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  const release = lockR.value
  try {
    // The battery ran unlocked, so the journal may have moved under us. `entries` (read
    // at :160) feeds appendKind, boundReached, and the round number — all three must be
    // recomputed against the stream as it stands NOW, or two concurrent gate runs on one
    // target both journal round N and both slip past the bound.
    // Content staleness is deliberately NOT checked here: the entry we write is honest
    // (it records the sha we judged), and a stale verdict stops settling its gate at
    // consumption time (gateSettled's reviewed_sha check).
    const entriesNow = readStream(root, target)
    if (boundReached(entriesNow, spec.gate)) {
      ctx.out(kv('gate', spec.gate))
      ctx.out(kv('outcome', `round bound reached (${roundsSinceApprove(entriesNow, spec.gate)} rounds since last approve)`))
      if (!leftToTail(entriesNow)) renderChoices(ctx, spec.gate, target, entriesNow, upstreamId, { sha: input.reviewedSha })
      return EXIT.BLOCKED
    }

    // A replayed round carries the mark of the round it replays; a judged one, the base it was judged against.
    const deltaMark = kind.kind === 'cached' ? kind.from.delta
      : delta ? { round: delta.baseRound, run: delta.base.run_id } : undefined
    const entry: GateRunEntry = {
      v: 1, t: 'gate-run', gate: spec.gate, artifact: target,
      round: roundsSinceApprove(entriesNow, spec.gate) + 1, run_id: newRunId(),
      reviewed_sha: input.reviewedSha, prompts_sha: askedSha,
      witness: key.witness, model, pin, harness: harness.name,
      ...(localR.value.reviewerExtensions.length ? { reviewer_extensions: localR.value.reviewerExtensions } : {}),
      ...(cached ? { cached: true } : {}),
      ...(flags.manual ? { manual: true } : {}),
      ...(rerolled.length ? { rerolled } : {}),
      ...(repairFrom && carried.length ? { carried: { run: repairFrom.run_id, lenses: carried } } : {}),
      ...(dropped.length ? { skipped: dropped } : {}),
      ...(outcome === 'stopped' && standing ? { standing } : {}),
      ...(input.artifactSha ? { artifact_sha: input.artifactSha } : {}),
      ...(input.diffSha ? { diff_sha: input.diffSha } : {}),
      ...(input.snapshot ? { reviewed_tree: input.snapshot.tree, basis_sha: basis } : {}),
      ...(delta ? { setup_sha: setupSha } : {}),
      ...(deltaMark ? { delta: deltaMark } : {}),
      checks: input.checks,
      ...(input.junit ? { junit: input.junit } : {}),
      ...(verdicts.length ? { verdicts } : {}),
      ...(malformed.length ? { malformed } : {}),
      outcome,
    }

    const stamps: PreparedStamp[] = outcome === 'passed'
      ? input.stamps.flatMap((s) => {
          const doc = findById(canon, s.artifact)
          return doc && String(doc.meta.status) !== s.to
            ? [prepareStamp(doc, s.to, 'gate-approve', { run_id: entry.run_id })] : []
        })
      : []

    // D122. The honest closure: a battery LOOKED and no longer found it. Only a run that
    // actually judged this anchor's artifact can discharge — a malformed round judged nothing
    // and must never close a debt, which is the same reason it does not spend the budget
    // (row 67). Silence in a real verdict is the evidence; that is exactly what the injected
    // block tells the reviewer, so the reviewer knows silence will be read that way.
    const reported = new Set((entry.verdicts ?? []).flatMap((rv) => rv.findings
      .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`))))
    // Row 187. A delta round was asked about the change, never to re-read what it left alone, so
    // its silence discharges only an obligation whose unit the change touched. Silence on an
    // unchanged unit, or on context, is not evidence that anything was fixed.
    const silenceCounts = (anchor: string) =>
      !replayedDelta && (delta === undefined || delta.view.state(anchorFromKey(anchor)) === 'changed')
    // Row 216. And only a debt some lens in this battery could read: silence on content no lens
    // was handed is not evidence either.
    const discharged = entry.outcome === 'malformed' ? []
      : openDeferrals(entriesNow).filter((d) => !reported.has(d.anchor) && silenceCounts(d.anchor)
        && judgeable(root, d, entriesNow, spec.gate, active))
        .map((d) => ({ v: 1 as const, t: 'deferral-discharged' as const, id: d.id, artifact: target, by_run: entry.run_id }))

    const files = [
      journalRel(target), ...stamps.flatMap((s) => [s.rel, journalRel(s.stream)]),
      ...(input.repin ? [input.repin.rel] : []),
    ]
    const marker = {
      op: `gate-${spec.gate}`,
      files: [...new Set(files)],
      // D167. Per stream, the marker lists lines in the order the body appends them, because
      // `landedJournal` reads a crash by that order — and the plan gate stamps its own target.
      journalMulti: [
        { stream: target, line: entryLine(entry as unknown as { t: 'gate-run'; [k: string]: unknown }) },
        ...discharged.map((d) => ({ stream: target, line: entryLine(d) })),
        ...stamps.map((s) => ({ stream: s.stream, line: s.line })),
      ],
    }
    const txn = withTxn(root, marker, () => {
      appendEntry(root, target, entry as unknown as { t: 'gate-run'; [k: string]: unknown })
      for (const d of discharged) appendEntry(root, target, d)
      for (const s of stamps) writeStamp(root, s)
      if (input.repin) {
        writeDoc(join(root, input.repin.rel),
          { meta: { ...input.repin.meta, 'derives-from': input.repin.sha }, body: input.repin.body })
      }
      crashPoint(ctx.env, 'gate-journal')
      return stateCommit(root, marker.files,
        `gate(${spec.gate}): ${target} round ${entry.round} ${outcome}`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }

    const after = [...entriesNow, entry as unknown as Entry]
    renderGateRun(ctx, entry, 'ran', {
      entries: after, upstream: upstreamId, sha: input.reviewedSha,
      ...(entry.outcome === 'stopped' && leftToTail(after) ? { help: false } : {}),
    })
    printSliceShape(ctx, root, spec.gate, target)
    for (const d of discharged) ctx.out(kv('discharged', `${d.id} — no longer reported by this round`))
    if (input.repin) ctx.out(kv('re-pinned', `derives-from → ${input.repin.sha.slice(0, 7)} (witnessed by the drift lane)`))
    return outcome === 'passed' ? EXIT.OK : EXIT.FINDINGS
  } finally {
    release()
  }
}
