import { join } from 'node:path'
import { EXIT, version, type Ctx } from './cli.js'
import { loadConfig, loadLocalConfig, type Config, type DocKey } from './config.js'
import { writeDoc } from './fm.js'
import { crashPoint, guardTxn, pendingTxn, withTxn } from './txn.js'
import { acquireLock } from './lock.js'
import { appendEntry, entryLine, journalRel, policyPins, readStream, type Entry } from './journal.js'
import { untrustedCmdsFor } from './allowlist.js'
import { primaryRoot, stateCommit } from './gitio.js'
import { criteriaOwner, loadCanon, findById, type Canon } from './scan.js'
import { deferralsBlock, openDeferrals } from './deferral.js'
import { newRunId } from './drift.js'
import { resolveJudge } from './harness.js'
import { ok, refuse, renderRefusal, v, type Result } from './refusal.js'
import { cmd, kv, rows } from './toon.js'
import { loadMatrix, resolveModel } from './model.js'
import { docKeysFor, docsBlock, loadLensDocs, pinsBlock, promptsSha, resolvePrompt, type Lens, type LensDoc } from './reviewer.js'
import { runBattery, type BatteryLens } from './battery.js'
import { anchorFromKey, anchorKey, anchorMenu, type Reviewed } from './verdict.js'
import { basisSha, deltaBlock, demote, demotionsBlock, outstandingDemotions, planDelta, reportedBy } from './delta.js'
import {
  ROUND_BOUND, appendKind, boundReached, fellBack, lastGateRun, liveExits, roundBudget,
  roundsSinceApprove, runsSinceReset,
  type GateCheck, type GateKey, type GateRunEntry, type ReviewerVerdict,
} from './rounds.js'
export { liveExits } from './rounds.js'
import { gateSettled, owedRun } from './verbs/next.js'
import { prepareStamp, writeStamp, type PreparedStamp } from './stamp.js'
import { recommend, renderDecision } from './recommend.js'
import { autonomyLines } from './autonomy.js'
import { reportHandover, slicesLine } from './slice.js'

import type { ChangeClass, GateName } from './settings.js'
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
}

// Row 178. What `resolve` may need to know about the run itself, not the target: whether the
// CLI settles this run's stop (autonomy on, not --manual). Only the design gate reads it.
export interface GateRun { autonomous: boolean }

export interface GateSpec {
  gate: GateName
  targetKind: 'effort' | 'plan' | 'spec'
  resolve(root: string, ctx: Ctx, canon: Canon, cfg: Config, target: string, run?: GateRun): Promise<Result<GateInput>>
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
}

const GATES = new Map<string, GateSpec>()

export function registerGate(spec: GateSpec): void { GATES.set(spec.gate, spec) }
export function gateSpec(name: string): GateSpec | undefined { return GATES.get(name) }

// The gate's own reviewers for this class. Their shape — a non-empty list, or a map naming
// every class — is refused when the file loads (row 13, amended by 193), so nothing is left
// to refuse here.
export function batteryFor(cfg: Config, gate: GateName, cls: ChangeClass): Result<string[]> {
  const battery = cfg.gates[gate].reviewers
  return ok(Array.isArray(battery) ? battery : battery[cls])
}

// `entries` is the stream AS OF AFTER this entry: without it the renderer cannot tell the
// round that spends the budget from any other, and rows 109/110 are both about that round.
// `help: false` is for callers that render their own `exits:` line (`decide --show`).
export function renderGateRun(
  ctx: Ctx, entry: GateRunEntry, mode: 'ran' | 'resume',
  opts: { entries?: Entry[]; help?: boolean; upstream?: string } = {},
): void {
  const entries = opts.entries ?? []
  const budget = opts.entries ? roundBudget(entries, entry.gate) : ROUND_BOUND
  const atBound = opts.entries !== undefined && boundReached(entries, entry.gate)
  ctx.out(kv('gate', entry.gate))
  ctx.out(kv('target', entry.artifact))
  ctx.out(kv('round', `${entry.round} of ${budget}${mode === 'resume' ? ' (resume — content unchanged)' : ''}`))
  ctx.out(kv('reviewed', entry.reviewed_sha.slice(0, 7)))
  ctx.out(kv('model', `${entry.model} · calibration: ${entry.calibration}${entry.cached ? ' · cached' : ''}`))
  if (entry.delta) ctx.out(kv('review', `delta since round ${entry.delta.round}`))
  if (entry.skipped?.length) ctx.out(kv('skipped', entry.skipped.join(' · ')))
  if (entry.fallback?.length) ctx.out(kv('fallback', entry.fallback.join(' → ')))
  if (entry.rerolled?.length) ctx.out(kv('rerolled', entry.rerolled.join(' · ')))
  ctx.out(rows('checks', ['name', 'ok', 'detail'],
    entry.checks.map((c) => ({ name: c.name, ok: String(c.ok), detail: c.detail ?? '' }))).join('\n'))
  // Row 179: what the lane did not run, beside the row that passed without it.
  for (const h of entry.checks.flatMap((c) => c.held ?? [])) ctx.out(`held: ${h.criterion} — ${h.need} unmet · ${h.satisfy}`)
  const findings = (entry.verdicts ?? []).flatMap((rv) =>
    rv.findings.map((f) => ({
      reviewer: rv.reviewer, blocking: String(f.blocking),
      pin: f.contradicts_pin !== undefined ? `#${f.contradicts_pin}` : '',
      anchor: typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`, claim: f.claim,
    })))
  if (findings.length) ctx.out(rows('findings', ['reviewer', 'blocking', 'pin', 'anchor', 'claim'], findings).join('\n'))
  for (const f of (entry.verdicts ?? []).flatMap((rv) => rv.findings)) {
    if (f.demoted !== undefined) ctx.out(kv('demoted', `${anchorKey(f.anchor)} — unchanged since round ${f.demoted}`))
  }
  if (entry.malformed?.length) {
    ctx.out(rows('malformed', ['reviewer', 'field', 'rule'],
      entry.malformed.flatMap((m) => m.violations.map((x) => ({ reviewer: m.reviewer, field: x.field, rule: x.rule })))).join('\n'))
  }
  if (entry.standing) ctx.out(kv('standing-stop', entry.standing))
  ctx.out(kv('outcome', entry.outcome))
  if (entry.outcome !== 'passed') {
    // Row 110. The round that SPENDS the budget is the one that has to say so. It rendered
    // like any other, so the natural next act — fix the finding, re-gate — was advertised
    // by the help line below and then refused twice: the gate short-circuits, and the edit
    // that answered the finding forfeits `--approve` under D75. Nothing warned, and the
    // finding is itself an instruction to edit. Printed above the `help:` suppression, not
    // inside it: `decide --show` renders its own exits and is the surface a human reads
    // while deciding — the one place this warning is most owed.
    if (atBound) {
      ctx.out(kv('last-round', 'the round budget is spent — the gate will not run again, and an edit from here forfeits --approve (the verdict would describe an older tree)'))
    }
    // Without `entries` this stays a pure formatter over the entry it was handed, and the
    // off-bound triple is the right answer; with them it tells the truth at the bound too.
    if (opts.help !== false) renderChoices(ctx, entry.gate, entry.artifact, entries, opts.upstream)
  }
}

// D121: the exits line stated which commands would not refuse and never which to take, so
// --approve read as the default at stops with a live blocking finding. The block ranks them.
// One renderer for all four decision surfaces in this file — a per-site copy is how D119's
// nine hand-copied exits sets happened, and three of these four sites were among them.
// `undefined` from `recommend` means no anchor resolves at this state — stale with no
// decision pending (reopened, or already revised), where every decide verb refuses with
// nothing-pending and the exits line's single re-gate act is the whole live set (D131).
function renderChoices(
  ctx: Ctx, gate: string, target: string, entries: Entry[], upstream: string | undefined,
  stale = false,
): void {
  // D154. Resolved here rather than threaded through four call sites, on this file's own
  // precedent (`printSliceShape` loads canon itself so the entry-renderers stay
  // pure formatters). Best-effort: a root that will not resolve costs the trust variants,
  // never the block.
  const rootR = primaryRoot(ctx.cwd)
  const untrustedCmds = rootR.ok
    ? untrustedCmdsFor(rootR.value, criteriaOwner(loadCanon(rootR.value), target))
    : []
  const d = recommend({ gate, target, entries, upstream, stale, untrustedCmds })
  if (d) renderDecision(d).forEach((l) => ctx.out(l))
  else ctx.out(cmd('help', liveExits(gate, target, entries, stale, upstream)))
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
  ctx: Ctx, gateName: string, target: string, flags: { fresh: boolean; manual: boolean; handover?: boolean },
): Promise<number> {
  const code = await judge(ctx, gateName, target, flags)
  if (code !== EXIT.FINDINGS && code !== EXIT.BLOCKED) return code
  if (flags.manual) return code
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) return code
  const cfgR = loadConfig(rootR.value)
  if (!cfgR.ok || !cfgR.value.autonomy || pendingTxn(rootR.value) !== undefined) return code
  // A dynamic import: settle.ts reaches decide.ts, whose gates/index.js import would close a
  // static cycle through this module — each gate's registerGate would run before GATES exists.
  const { settleStop, settledCode } = await import('./settle.js')
  const settled = await settleStop(ctx, rootR.value, cfgR.value, gateName, target)
  // Row 191 §4.4. A revise settled here is handed to the session that ran the gate, so this is
  // where a session at its limit hands it to a fresh one. Ship passes `handover: false`: its run
  // hands over once, at its own exit (Plan's call 7).
  const revised = settled.kind === 'decided' && (settled.decision === 'revise' || settled.decision === 'revise-upstream')
  if (revised && flags.handover !== false) reportHandover(ctx, rootR.value, cfgR.value, { guard: false })
  return settledCode(code, settled)
}

async function judge(
  ctx: Ctx, gateName: string, target: string, flags: { fresh: boolean; manual: boolean },
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
  // the tail will not touch: a `--manual` run's, a parked or settled one, a malformed round.
  const autonomous = cfgR.value.autonomy && !flags.manual
  const leftToTail = (es: Entry[]): boolean => {
    if (!autonomous) return false
    const owed = owedRun(es, gateName)
    return owed !== undefined && !owed.manual
  }
  const canon = loadCanon(root)
  const inputR = await spec.resolve(root, ctx, canon, cfgR.value, target, { autonomous })
  if (!inputR.ok) { renderRefusal(inputR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const input = inputR.value
  // Resolved once for every render this run performs — the entry renderers stay pure
  // formatters (they take the id, they never look it up).
  const upstreamId = spec.upstreamOf?.(root, canon, target)

  const batteryR = batteryFor(cfgR.value, spec.gate, input.class)
  if (!batteryR.ok) { renderRefusal(batteryR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const skip = new Map((input.skipLenses ?? []).map((s) => [s.lens, s.why]))
  const active = batteryR.value.filter((n) => !skip.has(n))
  const dropped = batteryR.value.filter((n) => skip.has(n)).map((n) => `${n} — ${skip.get(n)!}`)
  const entries = readStream(root, target)
  const pins = policyPins(entries)
  const pinsText = pinsBlock(pins)
  // D122. Open obligations join the prompt exactly as pins do, and join `prompts_sha` for
  // the same reason: an obligation the battery did not see is an obligation nothing can
  // discharge. Minting one therefore guarantees the next round re-invokes the battery,
  // which is the intended cost of an override rather than an accident of the cache.
  const deferralsText = deferralsBlock(openDeferrals(entries))
  const lenses: Lens[] = []
  for (const name of active) {
    const lensR = resolvePrompt(name)
    if (!lensR.ok) { renderRefusal(lensR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const lens = lensR.value
    const docPaths = docKeysFor(spec.gate, name).flatMap((k) => cfgR.value.docs[k as DocKey] ?? [])
    let docs: LensDoc[] = []
    if (docPaths.length > 0) {
      const docsR = loadLensDocs(root, docPaths)
      if (!docsR.ok) { renderRefusal(docsR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
      docs = docsR.value
    }
    const ov = input.lensOverrides?.[name]
    if (ov?.docs?.length) docs = [...docs, ...ov.docs]     // living design joins prompts_sha
    if (docs.length) lens.docs = docs
    lenses.push(lens)
  }
  const hxR = resolveJudge(ctx.env, cfgR.value.harness)
  if (!hxR.ok) { renderRefusal(hxR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const harness = hxR.value.harness
  const localR = loadLocalConfig(root)
  if (!localR.ok) { renderRefusal(localR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const extras = {
    timeoutMs: cfgR.value.gates.reviewerTimeoutMs,
    extensions: localR.value.reviewerExtensions,
  }
  const modelR = resolveModel(cfgR.value, loadMatrix(root, harness.name), spec.gate)
  if (!modelR.ok) { renderRefusal(modelR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const { chain, calibrationOf, warning, warningKind } = modelR.value
  // matrix-empty is a fact about this witness build, reported once by `status`/`check`
  // (D98a). Only the caller's own pin being below the floor is news at run time.
  if (warning && warningKind === 'below-floor') ctx.err(`warning: ${warning}`)

  // Row 106: the key is built BEFORE invoking, so the only model knowable here is the one
  // being asked for. Naming it `pin` is what stops the entry's `model` — what actually
  // answered — from being compared against it by accident, which is how the streak brake
  // below spent three releases never firing.
  const pin = chain[0]!
  const basis = basisSha(lenses, input.snapshot?.context ?? '', pin, harness.name)
  const backstopped = spec.backstops ? outstandingDemotions(entries, spec.backstops) : []
  const backstopText = spec.backstops ? demotionsBlock(spec.backstops, backstopped) : ''
  const setupText = [pinsText, deferralsText, backstopText].filter((t) => t !== '').join('')
  const setupSha = promptsSha(lenses, setupText || undefined)          // the full-review prompts_sha
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
  // D99: `gateSettled` reads only the last run, so any new run un-settles the gate.
  // Content moving is a legitimate, self-explaining reason. A flag is not — `--fresh`
  // discarded a human decision with nothing printed and nothing journaled about it, and
  // row 94 removed its other job (escaping the changed-nothing deadlock), so it can
  // refuse and send the human through the verb that states a retraction and its reason.
  const settledBefore = gateSettled(entries, spec.gate)
  if (flags.fresh && settledBefore) {
    renderRefusal([v('gate', 'settled-approve', `${spec.gate} ${target} is settled`,
      `witness decide ${spec.gate} ${target} --revise --note "<why>" — retract the approval, then re-gate`)])
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
  const checkOk = (cs: GateCheck[]) =>
    cs.map((c) => `${c.name}:${c.ok}${(c.untrusted?.length ?? 0) > 0 ? ':blocked' : ''}:${
      (c.held ?? []).map((h) => h.criterion).sort().join('+')}`).sort().join('|')
  if ((kind.kind === 'resume' || kind.kind === 'changed-nothing') &&
      checkOk(kind.entry.checks) !== checkOk(input.checks) &&
      kind.entry.outcome !== 'malformed' && (kind.entry.verdicts?.length ?? 0) > 0) {
    kind = { kind: 'cached' as const, from: kind.entry }
  }
  // A key that moved for a NON-content reason — edited prompt, re-pinned model, new
  // witness version — un-settles just as quietly as --fresh did. Content moving explains
  // itself; this does not.
  const lastRun = lastGateRun(entries, spec.gate)
  if (settledBefore && kind.kind === 'fresh' && lastRun && lastRun.reviewed_sha === input.reviewedSha) {
    ctx.err(`warning: reviewer setup changed — this run discards the settled approve on ${spec.gate} ${target}`)
  }
  if (kind.kind === 'resume') {
    renderGateRun(ctx, kind.entry, 'resume', {
      entries, upstream: upstreamId,
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
    renderChoices(ctx, spec.gate, target, entries, upstreamId)
    return EXIT.FINDINGS
  }
  if (boundReached(entries, spec.gate)) {
    ctx.out(kv('gate', spec.gate))
    ctx.out(kv('outcome', `round bound reached (${roundsSinceApprove(entries, spec.gate)} rounds since last approve)`))
    if (!leftToTail(entries)) renderChoices(ctx, spec.gate, target, entries, upstreamId)
    return EXIT.BLOCKED
  }
  if (!flags.fresh) {
    // Both brakes guard the SAME window as the round budget (rounds.ts): exempt rounds
    // could otherwise repeat for free, and a run on the far side of an approve was
    // disposed of and can trip nothing.
    const tail = runsSinceReset(entries, spec.gate).slice(-2)
    const samePin = (r: GateRunEntry) =>
      (r.pin ?? r.model) === key.pin && (r.harness ?? 'claude-code') === key.harness
    // Row 107. A fallen-back round does not spend the budget, and an exempt round that
    // repeats forever is D67's livelock — the exemption and this trigger are one change.
    // `prompts_sha` is deliberately NOT compared: a lens edit has nothing to do with
    // whether a model answers, and comparing it would let an unrelated edit reset a brake
    // on a dead pin. Checked first because when both hold, "the pinned model is not
    // answering" is the true remedy and "your battery emits invalid verdicts" is not.
    // No --fresh in the want: --fresh bypasses the brake and would spend a battery
    // re-invoking the same dead pin. Fixing the pin moves key.pin, samePin goes false,
    // and the battery runs — which is only reachable BECAUSE these rounds were exempt.
    if (tail.length === 2 && tail.every((r) => fellBack(r) && samePin(r))) {
      renderRefusal([v(`gates.${spec.gate}.model`, 'fallback-streak',
        `${tail.length} consecutive rounds fell back from ${key.pin}`,
        'a reachable gates.<gate>.model — the pinned model is not answering')])
        .forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
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
  // Full review first: a delta is planned only for a round that will judge (the key is fresh).
  const delta = kind.kind === 'fresh'
    ? planDelta(root, entries, spec.gate, { reviewedSha: input.reviewedSha, snapshot: input.snapshot, basis, reviewed: input.reviewed, inDelta })
    : undefined
  const block = delta ? deltaBlock(delta) : ''
  // A replayed delta verdict re-serves a round that already discharged all its silence could.
  const replayedDelta = kind.kind === 'cached' && kind.from.delta !== undefined
  let verdicts: ReviewerVerdict[] = []
  let malformed: NonNullable<GateRunEntry['malformed']> = []
  let fallback: string[] = []
  let rerolled: string[] = []
  let model = pin
  let cached = false

  if (kind.kind === 'cached') {
    verdicts = kind.from.verdicts ?? []
    model = kind.from.model
    cached = true
  } else {
    // Row 169: every lens at once — a round's wall clock is its slowest lens, not their sum.
    const composed: BatteryLens[] = lenses.map((lens) => {
      const ov = input.lensOverrides?.[lens.name]
      const reviewed = ov?.reviewed ?? input.reviewed
      const body = ov?.promptBody ?? input.promptBody
      const menu = anchorMenu(reviewed)
      return {
        name: lens.name, reviewed,
        prompt: `${lens.contents}\n\n${docsBlock(lens.docs ?? [])}${pinsText}${deferralsText}${backstopText}${delta && inDelta(lens.name) ? block : ''}${menu ? `${menu}\n\n` : ''}## Reviewed content\n\n${body}\n`,
      }
    })
    const ranR = await runBattery(ctx, harness, chain, composed, { cwd: root, ...extras })
    if (!ranR.ok) { renderRefusal(ranR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ;({ verdicts, malformed, fallback, rerolled, model } = ranR.value)
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
    // Row 98c, specified by row 107. Composed HERE, after the battery, because whether a
    // fallback happened is not knowable at resolve() time. Dismissed by a plain
    // --approve: --override is reserved for the bound and this is a first-round event.
    // The remedy is deliberately absent — on round one the honest statement is that a
    // human decides whether the verdict counts; the remedy becomes true only once the pin
    // proves persistently dead, which is what fallback-streak above prints. It REPLACES
    // the stderr warning that fired on this same condition: unjournaled and non-blocking,
    // it let a substituted verdict pass behind a line that scrolls by.
    model !== pin
      ? `fallback — reviewers ran on ${model}, not the pinned ${pin}; the human decides whether that verdict counts`
      : undefined,
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
      if (!leftToTail(entriesNow)) renderChoices(ctx, spec.gate, target, entriesNow, upstreamId)
      return EXIT.BLOCKED
    }

    // A replayed round carries the mark of the round it replays; a judged one, the base it was judged against.
    const deltaMark = kind.kind === 'cached' ? kind.from.delta
      : delta ? { round: delta.baseRound, run: delta.base.run_id } : undefined
    const entry: GateRunEntry = {
      v: 1, t: 'gate-run', gate: spec.gate, artifact: target,
      round: roundsSinceApprove(entriesNow, spec.gate) + 1, run_id: newRunId(),
      reviewed_sha: input.reviewedSha, prompts_sha: delta ? promptsSha(lenses, setupText + block) : setupSha,
      witness: key.witness, model, pin, harness: harness.name, calibration: calibrationOf(model),
      ...(localR.value.reviewerExtensions.length ? { reviewer_extensions: localR.value.reviewerExtensions } : {}),
      ...(cached ? { cached: true } : {}),
      ...(flags.manual ? { manual: true } : {}),
      ...(fallback.length ? { fallback } : {}),
      ...(rerolled.length ? { rerolled } : {}),
      ...(dropped.length ? { skipped: dropped } : {}),
      ...(outcome === 'stopped' && standing ? { standing } : {}),
      ...(input.artifactSha ? { artifact_sha: input.artifactSha } : {}),
      ...(input.diffSha ? { diff_sha: input.diffSha } : {}),
      ...(input.snapshot ? { reviewed_tree: input.snapshot.tree, basis_sha: basis } : {}),
      ...(delta ? { setup_sha: setupSha } : {}),
      ...(deltaMark ? { delta: deltaMark } : {}),
      checks: input.checks,
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
    const discharged = entry.outcome === 'malformed' ? []
      : openDeferrals(entriesNow).filter((d) => !reported.has(d.anchor) && silenceCounts(d.anchor))
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
      entries: after, upstream: upstreamId,
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
