import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig, type Config } from '../config.js'
import { pendingTxn } from '../txn.js'
import { primaryRoot } from '../gitio.js'
import { findById, loadCanon, type Canon, type CanonDoc } from '../scan.js'
import { designArtifactCurrent, designPending, designUnseen } from '../design.js'
import { effortAbandoned, effortStreams, latestRecap, readStream, type Entry } from '../journal.js'
import { effortOf, effortReviewedSha, effortSpecs, effortWrites, implementReviewedSha, planPairSha } from '../reviewed.js'
import { changedFiles, diffBase, evidenceForDiff, isTestPath, type EvidenceReport } from '../evidence.js'
import { SESSION_DEFAULT, stagePin } from '../model.js'
import { handoffLine, relayLine, resolveDriver, resolveJudge } from '../harness.js'
import { atHome, worktreeFlow, worktreePath } from '../worktree.js'
import { lazyStamp } from '../stamp.js'
import { ok, refuse, renderRefusal, v, type Result } from '../refusal.js'
import { kv, rows } from '../toon.js'
import { openDeferrals } from '../deferral.js'
import { renderDecision, type Decision } from '../recommend.js'
import { recoverChoice } from './recover.js'
import { ROUND_BOUND, boundReached, lastGateRun, liveExits, openReopen, pendingDecision, reopenCommand, type DecisionEntry } from '../rounds.js'

// A gate is settled only if the verdict that settled it still describes the CURRENT
// content. `reviewed_sha` is the tree we actually judged; when the caller can compute
// what that sha is now and the two differ, the approval has lapsed and the gate re-arms.
// Same doctrine as designPending (design.ts:74) — approval is a fact about a sha, not a
// permanent fact. Callers that cannot cheaply compute a current sha omit it and get
// today's behavior.
export function gateSettled(entries: Entry[], gate: string, currentSha?: string): boolean {
  const last = lastGateRun(entries, gate)
  if (!last) return false
  // above BOTH settling branches deliberately: a human --approve --override is granted
  // against a specific tree too, and lapses with it
  if (currentSha !== undefined && last.reviewed_sha !== currentSha) return false
  // an explicit reopen from another gate's --revise --upstream un-settles this one until
  // it is discharged, exactly as a moved sha does — one predicate, both staleness terms
  if (openReopen(entries, gate) !== undefined) return false
  if (last.outcome === 'passed') return true
  // Read by position, not by presence — the last disposition is the state (D94).
  const after = lastDisposition(entries, gate, entries.lastIndexOf(last as unknown as Entry))
  return after !== undefined && after.decision === 'approve'
}

// D124, corrected while building it. The plan folded `stop` into `gateSettled` to stop
// `next` re-offering a stopped flow, but that predicate answers a DIFFERENT question for
// three other callers — `--fresh`'s refusal (gate.ts:249), ship's `implement-gate` check
// (gates/ship.ts:68) and ship's watch/gate branch (ship.ts:31) all ask *may this flow
// advance*. Teaching it `stop` made a human's park read as a green light: the ship gate
// reported `implement-gate,true,last implement round 1: stopped`, and it also refused the
// `--fresh` that `status` advertises as the way back, so parking became a one-way door.
//
// So the two questions get two predicates. Settled = judgment stands, the flow may
// advance. Parked = a human took it off the board; `next` stops offering it, `status`
// reports it, and a fresh run brings it back. No sha term on purpose: an approval is of
// BYTES and lapses when they move (gateSettled above), while a park is a decision about
// the flow — moving the tree underneath it does not cancel it.
export function gateParked(entries: Entry[], gate: string): boolean {
  const last = lastGateRun(entries, gate)
  if (!last) return false
  // a reopen from another gate's `--revise --upstream` un-parks exactly as it un-settles:
  // the upstream instruction is live work, and it outranks the park it lands on
  if (openReopen(entries, gate) !== undefined) return false
  return lastDisposition(entries, gate, entries.lastIndexOf(last as unknown as Entry))?.decision === 'stop'
}

// `runGate` short-circuits `changed-nothing` without appending an entry (gate.ts:170)
// whenever the last run's reviewed sha still matches current content and a revise or
// reopen sits after it. Routing there asks the human to invoke a verb the CLI will
// immediately decline, and — since nothing is appended — `next` says it again next turn.
// The work owed is AUTHORING, so route to the stage. The design stage already does this
// via designArtifactCurrent; this is the same rule for decompose and plan.
export function authoringOwed(entries: Entry[], gate: string, currentSha: string | undefined): boolean {
  const last = lastGateRun(entries, gate)
  if (!last) return false
  if (currentSha === undefined || last.reviewed_sha !== currentSha) return false
  if (openReopen(entries, gate) !== undefined) return true
  // The LAST decision is the state (D94). `.some()` read by presence, so an approve
  // answering a revise left this still claiming authoring — the same read-by-position
  // defect as decide --show's disposition.
  const recent = lastDisposition(entries, gate, entries.lastIndexOf(last as unknown as Entry))
  return recent !== undefined && ['revise', 'revise-upstream'].includes(recent.decision)
}

// D75 re-arms a gate whose reviewed sha has moved — under row 96 that is the diff moving
// or the base moving, no longer any file in the worktree. Correct either way, but the row
// it produces is a bare `gate implement`, indistinguishable from a CLI stuck on a stale
// answer. A human who just watched that gate pass reads it as the latter, and
// with a second session in the worktree answering `ship` the pair looks like a deadlock
// with no error anywhere. The lapse is a fact the CLI already knows; say it.
function lapseNote(entries: Entry[], gate: string, currentSha: string | undefined): string | undefined {
  const last = lastGateRun(entries, gate)
  if (!last || currentSha === undefined || last.reviewed_sha === currentSha) return undefined
  // sha-free: asks "was it ever settled", which is the only thing that can lapse
  if (!gateSettled(entries, gate)) return undefined
  return `${gate} approval lapsed — judged @${last.reviewed_sha.slice(0, 7)}, worktree now @${currentSha.slice(0, 7)} — re-gate to judge the current tree`
}

// Row 105. `appendKind` keys on harness, so a cross-harness run is `fresh` and re-invokes
// the whole battery — while roundsSinceApprove counts every non-malformed run with no
// reference to the key, so each flip spends a round out of ROUND_BOUND on content nobody
// edited. The row refuses to exempt it (a repo could then flip judges forever and never
// reach the bound), so the cost is real and the CLI says why before it is paid.
//
// `undefined` judge means the declaration is unreadable: no note, never a refusal. A note
// explains a row; it does not decide whether the row prints — the same doctrine lapseNote
// applies to an uncomputable sha.
function judgeNote(entries: Entry[], gate: string, judge: string | undefined): string | undefined {
  if (judge === undefined) return undefined
  const last = lastGateRun(entries, gate)
  // `?? 'claude-code'` for the reason keyOf uses it: every pre-88 entry lacks the field,
  // and claude-code is the only harness that could have written one.
  if (!last || (last.harness ?? 'claude-code') === judge) return undefined
  return `judge changed — round ${last.round} ran on ${last.harness ?? 'claude-code'}, ${judge} judges now — the next round re-invokes the whole battery and spends one of ${ROUND_BOUND}`
}

// The owed evidence phase is a DERIVATION (row 85: a placeholder is honest only where
// the CLI genuinely cannot know the answer). `evidenceForDiff` already computes
// red/green/vacuous per tag on the way to the gate's own check — this reads that report
// instead of printing the menu and making the caller resolve it.
//
// `verify-red` is preferred where a plain red probe is guaranteed vacuous: with the
// implementation already written the suite passes as it stands, so the reconstructing
// verb is the only one that can witness a genuine red.
function evidenceRow(
  id: string, parentTag: string, files: string[], report: EvidenceReport | undefined,
  seat: { home: string; model?: string },
): NextAction {
  const base = { stage: 'implement' as const, target: id, ...seat }
  if (report === undefined) {
    return {
      line: `witness test-evidence ${id} --phase red`, ...base,
      note: 'nothing changed yet — write the failing test first',
    }
  }
  const owed = report.required
    .filter((r) => !(r.red && r.green && !r.vacuous))
    .map((r) => `${r.tag} ${!r.red || r.vacuous ? 'red' : 'green'}`)
    .join(' · ')
  const parent = report.required.find((r) => r.tag === parentTag)
  const liveRed = parent !== undefined && parent.red && !parent.vacuous
  const line = !liveRed && files.some((f) => !isTestPath(f))
    ? `witness verify-red ${id}`
    : `witness test-evidence ${id} --phase ${liveRed ? 'green' : 'red'}`
  return { line, ...base, ...noteOf(owed === '' ? undefined : `evidence owed: ${owed}`) }
}

export interface NextAction {
  line: string
  stage?: 'brainstorm' | 'decompose' | 'design' | 'plan' | 'implement' | 'ship'
  target?: string
  note?: string
  // D121. Ranked options for a choice the ROUTING row cannot express: `next` names one
  // action, and where several are equally routable the human is choosing, not being told.
  // Printed after the contiguous next:/stage:/target:/note: unit the stage skills read
  // verbatim, so it adds a screen rather than changing one.
  block?: string[]
  home?: string   // absolute dir this action's session belongs in (implement → worktree, ship → primary root)
  model?: string  // model pin the fresh session in `home` runs under; the handoff string
                  // itself is rendered at the print site, where the harness is known
}

// One list for both readers. `flowAction` needs it to name an effort that can carry a plan
// write, and `computeNext` has always built exactly this — a second derivation here is the
// mistake rows 93 and 95 are both about.
function liveEfforts(root: string): Array<{ slug: string; entries: Entry[] }> {
  return effortStreams(root)
    .map((slug) => ({ slug, entries: readStream(root, slug) }))
    .filter((e) => latestRecap(root, e.slug) !== undefined && !effortAbandoned(e.entries))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

// The action for ONE flow. A flow is a plan with status `in-progress`: it begins at
// `witness start` and ends at the merge stamp. Anything else returns undefined and is
// not a flow. Exported because `--flow` and the dashboard must answer with the SAME
// derivation next uses, never a re-derived shorthand.
export function flowAction(root: string, cfg: Config, plan: CanonDoc, judge?: string): NextAction | undefined {
  const id = String(plan.meta.id)
  if (String(plan.meta.status) !== 'in-progress') return undefined
  const entries = readStream(root, id)
  const wt = worktreePath(root, id)
  const pinR = stagePin(cfg, 'implement')
  const pin = pinR.ok ? pinR.value : undefined
  const implementModel = pin !== undefined && pin !== SESSION_DEFAULT ? pin : undefined
  const inWorktree = { home: wt, model: implementModel }
  const atRoot = { home: root }
  if (!existsSync(wt)) return { line: `witness start ${id}`, target: id, note: 'worktree missing — start recreates it' }
  if (plan.meta.pr !== undefined) return { line: `witness ship ${id}`, stage: 'ship', target: id, ...atRoot }
  // Row 95: a reopen on this plan's OWN plan gate is routable motion — the plan is what
  // needs re-authoring — and every reader was blind to it. Above the implement settle check
  // on purpose: an implement gate settled against an earlier plan version must not carry
  // the flow past a reopen saying the plan itself is wrong. Below the `pr` row on purpose
  // too: a flow already at ship is answered by ship. No `home:` — plan authoring writes
  // canon at the root, and this matches what computeNext's plans-first loop prints.
  if (openReopen(entries, 'plan') !== undefined) {
    const act = planWriteAction(root, liveEfforts(root), id, String(plan.meta.parent), id)
    return { ...act, ...noteOf(act.note, 'plan gate reopened — re-author, then re-gate the plan') }
  }
  const baseR = diffBase(wt, cfg)
  const files = baseR.ok ? changedFiles(wt, baseR.value) : []
  // Rows 95 + 96: the identity is the diff plus the plan's content, never the worktree, and
  // it comes from the SAME derivation the implement gate keys on — deriving it here a second
  // way is what made every settled gate read as lapsed. undefined means the base cannot be
  // resolved — "cannot compute", never "moved", so a settled gate stays settled.
  const diffSha = baseR.ok ? implementReviewedSha(wt, baseR.value, plan) : undefined
  // D93: the gate owns its deterministic checks; the router reads the verdict and never
  // re-derives the predicate. Testing `evidence` in front of this is what made a human
  // `--approve` invisible to the one verb the driving loop calls every turn — the
  // journal said settled, `next` said test-evidence, and no error printed anywhere.
  // Sha-sensitivity is load-bearing here: emptying the worktree after an approval moves
  // the sha and re-arms the gate, which is why this keeps `diffSha` while
  // `gates/ship.ts` deliberately omits it (row 92).
  if (gateSettled(entries, 'implement', diffSha)) {
    return { line: `witness ship ${id}`, stage: 'ship', target: id, ...atRoot }
  }
  // evidenceForDiff is vacuously "satisfied" when nothing has changed yet (an empty
  // required-tags list trivially passes .every()) — a fresh worktree needs the
  // implement-stage hint too, not a premature jump to "gate implement".
  const report = baseR.ok && files.length > 0 ? evidenceForDiff(wt, root, plan, baseR.value) : undefined
  if (report === undefined || !report.satisfied) {
    return evidenceRow(id, String(plan.meta.parent), files, report, inWorktree)
  }
  // D94: with the content unchanged the gate answers `changed-nothing` and appends
  // nothing, so routing there returns this same line every turn. The revise asked for an
  // edit — say that, and seat the session where the edit happens.
  if (authoringOwed(entries, 'implement', diffSha)) {
    return {
      line: `witness test-evidence ${id} --phase green`, stage: 'implement', target: id, ...inWorktree,
      note: 'revise owed — edit the code in the worktree · re-run the evidence cycle · then re-gate',
    }
  }
  return {
    line: `witness gate implement ${id}`, target: id, ...inWorktree,
    ...noteOf(lapseNote(entries, 'implement', diffSha), judgeNote(entries, 'implement', judge)),
  }
}

// How far along a flow is — the drain order when several are actionable. Most-advanced
// first is WIP-limiting, not cosmetic: it pushes flows toward merge instead of fanning
// them out, which is what keeps concurrent rebases (and therefore lapsed ship gates) rare.
function flowRank(a: NextAction): number {
  if (a.stage === 'ship') return 3
  if (a.line.includes(' gate implement ')) return 2
  if (a.stage === 'implement') return 1
  return 0   // worktree missing — needs recreating before it can advance
}

// A flow can be in-progress and still unable to move: its own gate is awaiting a human
// decision, or it has hit the round bound (where no pending decision can even be
// created). Such a flow is NOT tier-1 motion — offering it would loop the driving loop
// on an action that only re-reports "awaiting decision", and would starve tier 2 of the
// very decision that unblocks it.
function flowBlocked(root: string, plan: CanonDoc, entries: Entry[]): boolean {
  // A parked gate blocks the flow the same way an owed decision does, and for the same
  // reason: offering it loops the driving loop on an act the human already declined. It
  // does not disappear — `status`'s parked table names it and the run that un-parks it.
  if (['plan', 'implement', 'ship'].some((gate) =>
    pendingDecision(entries, gate) !== undefined || gateParked(entries, gate) ||
    (boundReached(entries, gate) && !gateSettled(entries, gate)))) return true
  // Row 95's split: a reopen on the plan's own plan gate is NOT a block — flowAction routes
  // it — but a reopen on the PARENT's decompose is, because that work belongs to the effort
  // and tier 3 is where it surfaces. Keyed on the effort that owns the PARENT SPEC, which is
  // where `decide --revise --upstream <spec>` books it.
  const effort = effortOf(root, String(plan.meta.parent))
  return effort !== undefined && openReopen(readStream(root, effort), 'decompose') !== undefined
}

// The upstream artifact a gate's `--revise --upstream` books its reopen against. The gate
// registry answers this via `gateSpec().upstreamOf`, but `gate.ts` imports THIS module
// (gate.ts:24), so importing the registry back would close the cycle the codebase keeps
// one-way on purpose — the same edge that moved `liveExits` out of gate.ts into rounds.ts.
// Tier 2 hand-resolved it inline in three places; this is that derivation named once, and
// it agrees with the registry by test (exits-line.test.ts pins upstreamOf for all five).
function upstreamFor(root: string, gate: string, id: string, parent?: string): string | undefined {
  if (gate === 'decompose') return id
  if (gate === 'design') return effortOf(root, id)
  if (gate === 'plan') return parent
  return id   // implement and ship judge the plan they run under
}

// The LAST disposition of a gate's most recent run, read by position — the same rule
// gateSettled and authoringOwed both read by. `undefined` means the run is undisposed.
function lastDisposition(entries: Entry[], gate: string, from: number): DecisionEntry | undefined {
  return entries.slice(from + 1)
    .filter((e) => e.t === 'human-decision' && (e as unknown as DecisionEntry).gate === gate)
    .map((e) => e as unknown as DecisionEntry)
    .at(-1)
}

// D124's reporting half. A parked flow that `next` silently skips is a disappearance, so
// `status` names every one of them. The anchor comes from the run the stop disposed of —
// the human parked something specific, and "parked" without "on what" is not a report.
export function parkedGates(
  root: string, canon: Canon,
): Array<{ gate: string; target: string; round: number; anchor: string; reopen: string }> {
  const out: Array<{ gate: string; target: string; round: number; anchor: string; reopen: string }> = []
  const seen: Array<{ id: string; parent?: string; gates: readonly string[] }> = [
    ...effortStreams(root).map((slug) => ({ id: slug, gates: ['decompose'] as const })),
    ...canon.docs.filter((d) => d.meta.type === 'plan')
      .map((d) => ({ id: String(d.meta.id), parent: String(d.meta.parent), gates: ['plan', 'implement', 'ship'] as const })),
    ...canon.docs.filter((d) => d.meta.type === 'spec')
      .map((d) => ({ id: String(d.meta.id), gates: ['design'] as const })),
  ]
  for (const { id, parent, gates } of seen) {
    const entries = readStream(root, id)
    for (const gate of gates) {
      const last = lastGateRun(entries, gate)
      if (!last) continue
      if (!gateParked(entries, gate)) continue
      const anchors = (last.verdicts ?? [])
        .flatMap((rv) => rv.findings.filter((f) => f.blocking))
        .map((f) => (typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`))
      out.push({
        gate, target: id, round: last.round,
        anchor: anchors[0] ?? last.standing ?? last.outcome,
        reopen: reopenCommand(gate, id, entries, upstreamFor(root, gate, id, parent)),
      })
    }
  }
  return out
}

// D121. Ranked by DIRECT dependents descending — a count a human can check against the
// frontmatter by eye, where a transitive closure would be a number nobody can verify.
// `ui` first as tie-break: the design stage inserts a human-latency step ahead of its plan.
// Spec id last, for determinism.
export function readyChoice(canon: Canon, ready: string[]): Decision {
  const dependents = (id: string) =>
    canon.docs.filter((d) => (d.meta.depends as string[] | undefined)?.includes(id)).length
  const ranked = [...ready].sort((a, b) =>
    dependents(b) - dependents(a) ||
    Number(Boolean(findById(canon, b)?.meta.ui)) - Number(Boolean(findById(canon, a)?.meta.ui)) ||
    a.localeCompare(b))
  const flat = ranked.every((id) => dependents(id) === dependents(ranked[0]!))
  return {
    key: 'choose', rule: 'multiple-ready',
    options: ranked.map((id, i) => {
      const n = dependents(id)
      return {
        command: id, depth: 'root' as const, runnable: true,
        ...(i === 0
          ? {
              why: flat
                ? 'the dependency graph does not distinguish these — ranked by ui flag, then by id'
                : `${n} of the ${ready.length} ready specs depend on it directly; planning it later means re-planning them`,
              judgeFirst: 'which slice matters this week. This ranks the dependency graph, which is all the CLI can see — product priority outranks it',
            }
          : {
              when: findById(canon, id)?.meta.ui
                ? 'you want the ui-flagged slice moving early — the design stage adds a human-latency step ahead of its plan'
                : `it has ${n} direct dependent(s) and you would rather start there`,
              tradeoff: n < dependents(ranked[0]!) ? 'its plan may need revision once the more-depended-on slice lands' : 'none material',
            }),
      }
    }),
  }
}

// D122. Orientation, never a ladder tier: routing the human to the dismissal verb would
// teach closure-by-assertion at the one place the design means closure-by-evidence. The real
// bite is the battery injection, which no round can skip. Applied once where the action is
// finally produced rather than at each routing site — a per-branch copy would drift, and
// there are eleven branches.
export function withDeferralNote(root: string, canon: Canon, action: NextAction): NextAction {
  if (action.target === undefined) return action
  const doc = findById(canon, action.target)
  const parentId = doc?.meta.parent === undefined ? undefined : String(doc.meta.parent)
  const owed = [
    ...openDeferrals(readStream(root, action.target)),
    ...(parentId === undefined ? [] : openDeferrals(readStream(root, parentId))),
  ]
  if (owed.length === 0) return action
  return {
    ...action,
    ...noteOf(action.note,
      `${owed.length} open deferral(s) — ${owed.map((d) => d.id).join(' ')} · witness status`),
  }
}

interface PendingDecisionRef { gate: string; target: string }

// Every human-owed decision in the repo, in the order tier 2 would surface them. One
// source for both tiers: tier 2 takes the first, tier 1 rides them all in `note:`.
function pendingDecisionsAll(
  root: string, efforts: Array<{ slug: string; entries: Entry[] }>,
  specs: CanonDoc[], plans: CanonDoc[],
): PendingDecisionRef[] {
  const out: PendingDecisionRef[] = []
  for (const e of efforts) {
    if (pendingDecision(e.entries, 'decompose')) out.push({ gate: 'decompose', target: e.slug })
  }
  for (const plan of plans) {
    const id = String(plan.meta.id)
    const entries = readStream(root, id)
    for (const gate of ['plan', 'implement', 'ship']) {
      if (pendingDecision(entries, gate)) out.push({ gate, target: id })
    }
  }
  for (const spec of specs) {
    const id = String(spec.meta.id)
    if (pendingDecision(readStream(root, id), 'design')) out.push({ gate: 'design', target: id })
  }
  return out
}

// Both notes survive: a caller's own note must not silently drop the routing note that
// explains WHY the line is a recap rather than the write the caller asked for.
function noteOf(...parts: Array<string | undefined>): { note?: string } {
  const kept = parts.filter((p): p is string => p !== undefined)
  return kept.length > 0 ? { note: kept.join(' · ') } : {}
}

// Authoring a plan is booked under an effort, so `next` must name one a human can
// actually pass to `--effort`. It used to print the literal placeholder `<slug>`, which
// is unrunnable — and after `abandon <effort>` there was nothing to substitute either:
// the plan's authoring effort is terminal, so it is filtered out of the live list, while
// its parent spec stays approved with no live plan and therefore reads as planless on
// every subsequent turn. `next` repeated the same unrunnable line forever.
//
// Prefer a live effort that already wrote this plan, then one that wrote the parent spec
// — a plan is authored inside the effort that owns the spec it derives from. `effortOf`
// is deliberately not used: it answers with an ABANDONED effort whenever that is the only
// one that ever wrote the artifact, and writes must never be booked onto a terminal stream.
// With no live candidate the plan is not the next thing owed — an effort to carry it is.
function liveOwner(
  root: string, efforts: Array<{ slug: string }>, ...ids: string[]
): string | undefined {
  return ids
    .map((id) => efforts.find((e) => effortWrites(root, e.slug).has(id))?.slug)
    .find((slug) => slug !== undefined)
}

// The stage rides with the line: routing to a recap is BRAINSTORM work, and a caller that
// kept its own `stage: 'plan'` would hand the plan skill a recap command to run.
function planWriteAction(
  root: string, efforts: Array<{ slug: string }>, planId: string, parentId: string, target: string,
): NextAction {
  const owner = liveOwner(root, efforts, planId, parentId)
  return owner === undefined
    ? {
        line: 'witness recap --file <recap.json>', stage: 'brainstorm',
        note: `${planId} is owed, but no live effort can carry the write — open one`,
      }
    : {
        line: `witness write ${planId} --effort ${owner} --meta m.json --body b.md`,
        stage: 'plan', target,
      }
}

export function computeNext(root: string, ctx: Ctx, canon: Canon, cfg: Config): NextAction {
  // The recovery fork is a decision with a right answer the CLI can compute from the
  // marker (recover.ts's `recoverChoice`), and `--complete | --rollback` stated neither it
  // nor the cost of guessing wrong.
  const txn = pendingTxn(root)
  if (txn) {
    const choice = recoverChoice(root, txn)
    return { line: choice.options[0]!.command, block: renderDecision(choice) }
  }
  if (canon.errors.length > 0 || canon.docs.some((d) => d.violations.length > 0)) {
    return { line: 'witness check' }
  }

  // `next` is the one verb that legitimately holds BOTH lanes, and each feeds named
  // lines: the DRIVER resolved at the print site renders `run:`/`relay:` (the session
  // about to be typed at), and the JUDGE here feeds the judge-changed note (which binary
  // will spend the round). A reader who has internalised "one lane per verb" will
  // otherwise read this as a mistake.
  const judgeR = resolveJudge(ctx.env, cfg.raw)
  const judge = judgeR.ok ? judgeR.value.harness.name : undefined

  const efforts = liveEfforts(root)

  // Hoisted above tier 1: both doc lists are read by every tier below, and they used to
  // be declared interleaved between the pending-decision scans.
  const plans = canon.docs.filter((d) => d.meta.type === 'plan')
    .sort((a, b) => String(a.meta.id).localeCompare(String(b.meta.id)))
  const specs = canon.docs.filter((d) => d.meta.type === 'spec')
    .sort((a, b) => String(a.meta.id).localeCompare(String(b.meta.id)))

  // TIER 1 — advance something already in flight. A flow that can move must never wait
  // on a human decision belonging to a DIFFERENT flow: ship always stops (gates/ship.ts),
  // so a global decision-halt freezes every other flow at the first ship gate.
  const flows = plans
    .filter((plan) => !flowBlocked(root, plan, readStream(root, String(plan.meta.id))))
    .map((plan) => flowAction(root, cfg, plan, judge))
    .filter((a): a is NextAction => a !== undefined)
    .sort((a, b) => flowRank(b) - flowRank(a) || String(a.target).localeCompare(String(b.target)))
  if (flows.length > 0) {
    const waiting = pendingDecisionsAll(root, efforts, specs, plans)
    // noteOf, not an overwrite: a lapse note explains WHY this row is the gate rather
    // than the ship it was a moment ago, and must not be evicted by the waiting list.
    return waiting.length > 0
      ? {
          ...flows[0]!,
          ...noteOf(flows[0]!.note, `${waiting.length} waiting: ${waiting.map((w) => `${w.gate} ${w.target}`).join(' · ')}`),
        }
      : flows[0]!
  }

  // TIER 2 — human-owed decisions and bound endgames. Unchanged from today's rungs; they
  // simply no longer outrank in-flight motion.
  const pending = pendingDecisionsAll(root, efforts, specs, plans)
  if (pending.length > 0) {
    const first = pending[0]!
    return { line: `witness decide ${first.gate} ${first.target} --show`, target: first.target }
  }

  // bound-stuck gates: no pending decision can ever be created (the gate
  // short-circuits), so the endgame decision itself is the next action —
  // decisions outrank motion, jammed targets must not be silently skipped.
  // A parked gate is excluded from all three: the human already made the endgame decision.
  for (const e of efforts) {
    if (boundReached(e.entries, 'decompose') && !gateSettled(e.entries, 'decompose') &&
      !gateParked(e.entries, 'decompose')) {
      return {
        line: liveExits('decompose', e.slug, e.entries, false, upstreamFor(root, 'decompose', e.slug)),
        target: e.slug, note: 'round bound reached — human decision required',
      }
    }
  }
  for (const plan of plans) {
    const id = String(plan.meta.id)
    const entries = readStream(root, id)
    for (const gate of ['plan', 'implement', 'ship'] as const) {
      if (boundReached(entries, gate) && !gateSettled(entries, gate) && !gateParked(entries, gate)) {
        const up = upstreamFor(root, gate, id, String(plan.meta.parent))
        return {
          line: liveExits(gate, id, entries, false, up),
          target: id, note: 'round bound reached — human decision required',
        }
      }
    }
  }
  for (const spec of specs) {
    const id = String(spec.meta.id)
    const entries = readStream(root, id)
    if (boundReached(entries, 'design') && !gateSettled(entries, 'design') &&
      !gateParked(entries, 'design')) {
      return {
        line: liveExits('design', id, entries, false, upstreamFor(root, 'design', id)),
        target: id, note: 'round bound reached — human decision required',
      }
    }
  }

  if (efforts.length === 0) {
    return { line: 'witness recap --file <recap.json>', stage: 'brainstorm' }
  }
  for (const e of efforts) {
    const writes = effortWrites(root, e.slug)
    // A chore is plan-level motion by definition, so the decompose stage is unsatisfiable
    // in BOTH directions and must not be routed to at all: `write` refuses spec content
    // from a chore (class-tripwire, write.ts) while `gate decompose` refuses an effort
    // with no written specs (nothing-to-gate, gates/decompose.ts). A chore's plans are the
    // gateable work, and they carry its goals — decompose is simply not owed here.
    if (latestRecap(root, e.slug)?.class === 'chore') {
      if (writes.size === 0) {
        return {
          line: `witness write <plan-id> --effort ${e.slug} --meta m.json --body b.md`,
          stage: 'plan', target: e.slug,
          note: 'chore: plan-level motion — a chore never writes spec content',
        }
      }
      continue
    }
    if (writes.size === 0) {
      return {
        line: `witness write <spec-id> --effort ${e.slug} --meta m.json --body b.md`,
        stage: 'decompose', target: e.slug,
      }
    }
    // Settled either by a real gate-run+approve, or (fixture/seed shortcuts) by every
    // effort spec already being past draft — a plan can't legally target a draft parent,
    // so non-draft specs are proof decompose's outcome was reached one way or another.
    // The shortcut stands in for a gate-run, so an OPEN REOPEN un-discharges it too:
    // otherwise it short-circuits past gateSettled and the reopen is never routed.
    const specs = effortSpecs(root, canon, e.slug)
    const reopened = openReopen(e.entries, 'decompose') !== undefined
    const specsApproved = !reopened && specs.length > 0 && specs.every((d) => String(d.meta.status) !== 'draft')
    const effortSha = effortReviewedSha(root, canon, e.slug).sha
    if (!specsApproved && !gateSettled(e.entries, 'decompose', effortSha) &&
      !gateParked(e.entries, 'decompose')) {
      return authoringOwed(e.entries, 'decompose', effortSha)
        ? {
            line: `witness write <spec-id> --effort ${e.slug} --meta m.json --body b.md`,
            stage: 'decompose', target: e.slug,
            note: 'revise owed — re-author, then the gate has something new to judge',
          }
        : { line: `witness gate decompose --effort ${e.slug}`, target: e.slug,
            ...noteOf(judgeNote(e.entries, 'decompose', judge)) }
    }
  }

  for (const spec of specs) {
    if (String(spec.meta.status) !== 'approved') continue
    if (!designPending(root, spec)) continue
    const id = String(spec.meta.id)
    // A parked design gate is off the board too — routing to `witness design` or its gate
    // re-offers work the human stopped. `status`'s parked row is where it stays named.
    if (gateParked(readStream(root, id), 'design')) continue
    // An artifact authored for the CURRENT spec content is awaiting its gate → gate it.
    // Otherwise (no artifact, or one authored before a later amendment) → the design
    // skill authors fresh or, in amend mode, decides re-design vs --reconfirm.
    // A pending design DECISION was already caught by the top-of-function scan; a stale
    // prior approval never routes here because designPending re-arms on stamp.spec mismatch.
    if (!designArtifactCurrent(root, spec)) {
      return { line: `witness design ${id} --file <html>`, stage: 'design', target: id }
    }
    // Registered but unshown is the normal state right after --file. Ask for the show
    // step by name; routing to the gate here would refuse design-unseen every time.
    return designUnseen(root, cfg.paths, id) !== undefined
      ? { line: `witness design ${id} --open`, stage: 'design', target: id }
      : { line: `witness gate design ${id}`, target: id,
          ...noteOf(judgeNote(readStream(root, id), 'design', judge)) }
  }

  const ready = (dep: string): boolean => {
    const doc = findById(canon, dep)
    if (!doc) return false
    const s = String(doc.meta.status)
    return doc.meta.type === 'plan' ? s === 'done' : s === 'live' || doc.meta.type === 'principles'
  }
  const planless = canon.docs
    .filter((d) => d.meta.type === 'spec' && String(d.meta.status) === 'approved')
    .filter((d) => !plans.some((p) => String(p.meta.parent) === String(d.meta.id) &&
      !['done', 'abandoned'].includes(String(p.meta.status))))
    .filter((d) => ((d.meta.depends ?? []) as string[]).every(ready))
    .map((d) => String(d.meta.id)).sort()
  if (planless.length > 0) {
    // A spec whose plan write can actually be booked outranks one that needs a new effort
    // opened first — stalling the whole pipeline on a recap while runnable work sits behind
    // it is a worse answer, and alphabetical order alone does not know the difference.
    const spec = planless.find((s) => liveOwner(root, efforts, `${s}-plan-1`, s) !== undefined)
      ?? planless[0]!
    const act = planWriteAction(root, efforts, `${spec}-plan-1`, spec, spec)
    if (planless.length <= 1) return act
    // The note said `multiple ready — choose: a b c`, which is a list, not a ranking: it
    // named the alternatives without saying which one to take or what taking another costs.
    const choice = readyChoice(canon, planless)
    return { ...act, ...noteOf(act.note, `${planless.length} ready — ranked below`), block: renderDecision(choice) }
  }

  // plans-first: every written plan gates before any plan starts or advances —
  // an approved sibling must not short-circuit a draft out of review (stage-major order)
  for (const plan of plans) {
    const id = String(plan.meta.id)
    if (String(plan.meta.status) !== 'draft') continue
    const parent = findById(canon, String(plan.meta.parent))
    const planSha = parent ? planPairSha(plan, parent) : undefined
    const entries = readStream(root, id)
    // Parked skips for the same reason settled does — the gate is off the board until a
    // fresh run brings it back, and `status` is where it stays visible meanwhile.
    if (gateSettled(entries, 'plan', planSha) || gateParked(entries, 'plan')) continue
    if (!authoringOwed(entries, 'plan', planSha)) {
      return { line: `witness gate plan ${id}`, target: id, ...noteOf(judgeNote(entries, 'plan', judge)) }
    }
    const act = planWriteAction(root, efforts, id, String(plan.meta.parent), id)
    return { ...act, ...noteOf(act.note, 'revise owed — rewrite the plan, then re-gate') }
  }

  // Starting a flow is tier 3, not tier 1: an approved-but-unstarted plan is new work,
  // and every in-flight flow was already offered above.
  for (const plan of plans) {
    if (String(plan.meta.status) === 'approved') {
      return { line: `witness start ${String(plan.meta.id)}`, target: String(plan.meta.id) }
    }
  }
  return { line: 'witness check' }
}

function resolveFlow(canon: Canon, id: string): Result<CanonDoc> {
  const doc = findById(canon, id)
  if (!doc || doc.meta.type !== 'plan') {
    return refuse([v('--flow', 'unknown-flow', id, 'a plans/ doc id')])
  }
  const status = String(doc.meta.status)
  if (status === 'done' || status === 'abandoned') {
    return refuse([v('--flow', 'terminal-status', status, 'a flow that is still running')])
  }
  // deliberately NOT start.ts's `not-approved`: that refuses when status is not
  // `approved`, this refuses when it is not `in-progress` — an approved-but-unstarted
  // plan is not yet a flow, and reusing the name would misreport that case.
  if (status !== 'in-progress') {
    return refuse([v('--flow', 'not-started', status, `a started plan — run witness start ${id} first`)])
  }
  return ok(doc)
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const hxR = resolveDriver(ctx.env, cfgR.value.raw)
  if (!hxR.ok) { renderRefusal(hxR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const harness = hxR.value.harness
  // The judge for the two flowAction calls below, so `--flow` and a worktree cwd answer
  // with the SAME derivation computeNext does — flowAction's own contract. Diverging the
  // arguments is how a re-derived shorthand creeps back in.
  const judgeR = resolveJudge(ctx.env, cfgR.value.raw)
  const judge = judgeR.ok ? judgeR.value.harness.name : undefined
  let canon = loadCanon(root)
  const lazy = lazyStamp(root, ctx, canon)
  if (lazy.stamped.length > 0) canon = loadCanon(root)
  // `dashboard` renders these; `next` computed them and dropped them. A merge stamp that
  // cannot proceed (commit refused, PR closed unmerged, lock held) leaves the flow parked
  // at ship forever, and `next` — the one verb the driving loop calls every turn — said
  // nothing at all. Printed BEFORE the routing block so it cannot split the contiguous
  // next:/stage:/target:/note:/home:/run:/relay: unit the stage skills read verbatim.
  if (lazy.stale.length > 0) {
    rows('stale', ['plan', 'why'], lazy.stale as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  const { values } = parseArgs({ args: argv, options: { flow: { type: 'string' } }, allowPositionals: true })
  // Precedence: an explicit --flow is a CLAIM about a flow and refuses when false.
  // A worktree cwd is AMBIENT context — it may scope a read-only question, never select
  // a target for a mutation, and it degrades to the global ladder rather than refusing.
  // (This is why inference lives on `next` alone. Every mutating verb takes its id
  // explicitly, handed down from `target:` by the stage skills.)
  let action: NextAction
  if (values.flow !== undefined) {
    const flowR = resolveFlow(canon, values.flow)
    if (!flowR.ok) { renderRefusal(flowR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    action = flowAction(root, cfgR.value, flowR.value, judge) ?? { line: 'witness check', target: values.flow }
  } else {
    const inferred = worktreeFlow(ctx.cwd, root)
    const ambient = inferred !== undefined ? findById(canon, inferred) : undefined
    const scoped = ambient && ambient.meta.type === 'plan'
      ? flowAction(root, cfgR.value, ambient, judge)
      : undefined
    action = scoped ?? computeNext(root, ctx, canon, cfgR.value)
  }
  action = withDeferralNote(root, canon, action)
  ctx.out(kv('next', action.line))
  if (action.stage) ctx.out(kv('stage', action.stage))
  if (action.target) ctx.out(kv('target', action.target))
  if (action.note) ctx.out(kv('note', action.note))
  if (action.block) action.block.forEach((l) => ctx.out(l))
  // Whether this session is already in `home:` is a fact the CLI holds both halves of, so
  // it answers it here rather than printing the handoff and leaving the comparison to the
  // model. A `run:` line that cds to the directory it was printed in is row 129's defect —
  // a rendered command that does not run — and it is what let the engine bounce a human
  // between two checkouts with nothing changing in between.
  //
  // NOT rows 116-118's reverted band-aid. That fix made `next` REFUSE a handoff on a
  // version-skew diagnosis owned by `check`. This withholds no knowledge and changes no
  // routing answer: the stage, the target and the home are identical either way, and only
  // the instruction to a session that is already there stops being printed.
  if (action.home) {
    ctx.out(kv('home', action.home))
    if (!atHome(ctx.cwd, action.home)) {
      ctx.out(kv('run', handoffLine(harness, action.home, action.model)))
      ctx.out(kv('relay', relayLine(harness)))
    }
  }
  return EXIT.OK
}
