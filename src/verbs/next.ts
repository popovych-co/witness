import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig, type Config } from '../config.js'
import { pendingTxn } from '../txn.js'
import { primaryRoot } from '../gitio.js'
import { findById, loadCanon, type Canon, type CanonDoc } from '../scan.js'
import { designArtifactCurrent, designPending, designUnseen } from '../design.js'
import { effortAbandoned, effortStreams, latestRecap, readStream, type Entry } from '../journal.js'
import { effortOf, effortReviewedSha, effortSpecs, effortWrites, planPairSha, worktreeTreeSha } from '../reviewed.js'
import { changedFiles, diffBase, evidenceForDiff } from '../evidence.js'
import { SESSION_DEFAULT, stagePin } from '../model.js'
import { worktreeFlow, worktreePath } from '../worktree.js'
import { lazyStamp } from '../stamp.js'
import { ok, refuse, renderRefusal, v, type Result } from '../refusal.js'
import { kv } from '../toon.js'
import { boundReached, lastGateRun, openReopen, pendingDecision, type DecisionEntry } from '../rounds.js'

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
  const after = entries.slice(entries.lastIndexOf(last as unknown as Entry) + 1)
  return after.some((e) => e.t === 'human-decision' &&
    (e as unknown as DecisionEntry).gate === gate &&
    (e as unknown as DecisionEntry).decision === 'approve')
}

// `runGate` short-circuits `changed-nothing` without appending an entry (gate.ts:170)
// whenever the last run's reviewed sha still matches current content and a revise or
// reopen sits after it. Routing there asks the human to invoke a verb the CLI will
// immediately decline, and — since nothing is appended — `next` says it again next turn.
// The work owed is AUTHORING, so route to the stage. The design stage already does this
// via designArtifactCurrent; this is the same rule for decompose and plan.
function authoringOwed(entries: Entry[], gate: string, currentSha: string | undefined): boolean {
  const last = lastGateRun(entries, gate)
  if (!last) return false
  if (currentSha === undefined || last.reviewed_sha !== currentSha) return false
  if (openReopen(entries, gate) !== undefined) return true
  const after = entries.slice(entries.lastIndexOf(last as unknown as Entry) + 1)
  return after.some((e) => e.t === 'human-decision' &&
    (e as unknown as DecisionEntry).gate === gate &&
    ['revise', 'revise-upstream'].includes((e as unknown as DecisionEntry).decision))
}

export interface NextAction {
  line: string
  stage?: 'brainstorm' | 'decompose' | 'design' | 'plan' | 'implement' | 'ship'
  target?: string
  note?: string
  home?: string   // absolute dir this action's session belongs in (implement → worktree, ship → primary root)
  run?: string    // paste-ready handoff command for a fresh session in `home`
}

// Row 82: the handoff command a human pastes into a fresh terminal. The model pin rides
// `claude --model` literally; SESSION_DEFAULT (or an unloadable pin — config errors
// surface at start/gate, not here) omits the flag. Single quotes: a double-quoted form
// trips toon esc() quoting and emits an unpasteable line.
function handoffLine(home: string, model?: string): string {
  const modelArg = model && model !== SESSION_DEFAULT ? ` --model ${model}` : ''
  return `cd '${home}' && claude${modelArg} '/specflow'`
}

// The action for ONE flow. A flow is a plan with status `in-progress`: it begins at
// `specflow start` and ends at the merge stamp. Anything else returns undefined and is
// not a flow. Exported because `--flow` and the dashboard must answer with the SAME
// derivation next uses, never a re-derived shorthand.
export function flowAction(root: string, cfg: Config, plan: CanonDoc): NextAction | undefined {
  const id = String(plan.meta.id)
  if (String(plan.meta.status) !== 'in-progress') return undefined
  const entries = readStream(root, id)
  const wt = worktreePath(root, id)
  const pinR = stagePin(cfg, 'implement')
  const implementModel = pinR.ok ? pinR.value : undefined
  const inWorktree = { home: wt, run: handoffLine(wt, implementModel) }
  const atRoot = { home: root, run: handoffLine(root) }
  if (!existsSync(wt)) return { line: `specflow start ${id}`, target: id, note: 'worktree missing — start recreates it' }
  if (plan.meta.pr !== undefined) return { line: `specflow ship ${id}`, stage: 'ship', target: id, ...atRoot }
  const baseR = diffBase(wt, cfg)
  const files = baseR.ok ? changedFiles(wt, baseR.value) : []
  // evidenceForDiff is vacuously "satisfied" when nothing has changed yet (an empty
  // required-tags list trivially passes .every()) — a fresh worktree needs the
  // implement-stage hint too, not a premature jump to "gate implement".
  const satisfied = files.length > 0 && baseR.ok && evidenceForDiff(wt, root, plan, baseR.value).satisfied
  if (!satisfied) return { line: `specflow test-evidence ${id} --phase red|green`, stage: 'implement', target: id, ...inWorktree }
  if (!gateSettled(entries, 'implement', worktreeTreeSha(wt))) return { line: `specflow gate implement ${id}`, target: id, ...inWorktree }
  return { line: `specflow ship ${id}`, stage: 'ship', target: id, ...atRoot }
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
function flowBlocked(entries: Entry[]): boolean {
  return ['plan', 'implement', 'ship'].some((gate) =>
    pendingDecision(entries, gate) !== undefined ||
    (boundReached(entries, gate) && !gateSettled(entries, gate)))
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
        line: 'specflow recap --file <recap.json>', stage: 'brainstorm',
        note: `${planId} is owed, but no live effort can carry the write — open one`,
      }
    : {
        line: `specflow write ${planId} --effort ${owner} --meta m.json --body b.md`,
        stage: 'plan', target,
      }
}

export function computeNext(root: string, ctx: Ctx, canon: Canon, cfg: Config): NextAction {
  if (pendingTxn(root)) return { line: 'specflow recover --complete | --rollback' }
  if (canon.errors.length > 0 || canon.docs.some((d) => d.violations.length > 0)) {
    return { line: 'specflow check' }
  }

  const efforts = effortStreams(root)
    .map((slug) => ({ slug, entries: readStream(root, slug) }))
    .filter((e) => latestRecap(root, e.slug) !== undefined && !effortAbandoned(e.entries))
    .sort((a, b) => a.slug.localeCompare(b.slug))

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
    .filter((plan) => !flowBlocked(readStream(root, String(plan.meta.id))))
    .map((plan) => flowAction(root, cfg, plan))
    .filter((a): a is NextAction => a !== undefined)
    .sort((a, b) => flowRank(b) - flowRank(a) || String(a.target).localeCompare(String(b.target)))
  if (flows.length > 0) {
    const waiting = pendingDecisionsAll(root, efforts, specs, plans)
    return waiting.length > 0
      ? { ...flows[0]!, note: `${waiting.length} waiting: ${waiting.map((w) => `${w.gate} ${w.target}`).join(' · ')}` }
      : flows[0]!
  }

  // TIER 2 — human-owed decisions and bound endgames. Unchanged from today's rungs; they
  // simply no longer outrank in-flight motion.
  const pending = pendingDecisionsAll(root, efforts, specs, plans)
  if (pending.length > 0) {
    const first = pending[0]!
    return { line: `specflow decide ${first.gate} ${first.target} --show`, target: first.target }
  }

  // bound-stuck gates: no pending decision can ever be created (the gate
  // short-circuits), so the endgame decision itself is the next action —
  // decisions outrank motion, jammed targets must not be silently skipped
  for (const e of efforts) {
    if (boundReached(e.entries, 'decompose') && !gateSettled(e.entries, 'decompose')) {
      return {
        line: `specflow decide decompose ${e.slug} --approve --override | --revise --upstream ${e.slug} | --stop`,
        target: e.slug, note: 'round bound reached — human decision required',
      }
    }
  }
  for (const plan of plans) {
    const id = String(plan.meta.id)
    const entries = readStream(root, id)
    for (const gate of ['plan', 'implement', 'ship'] as const) {
      if (boundReached(entries, gate) && !gateSettled(entries, gate)) {
        const up = gate === 'plan' ? String(plan.meta.parent) : id
        return {
          line: `specflow decide ${gate} ${id} --approve --override | --revise --upstream ${up} | --stop`,
          target: id, note: 'round bound reached — human decision required',
        }
      }
    }
  }
  for (const spec of specs) {
    const id = String(spec.meta.id)
    const entries = readStream(root, id)
    if (boundReached(entries, 'design') && !gateSettled(entries, 'design')) {
      const eff = effortOf(root, id)
      return {
        line: `specflow decide design ${id} --approve --override | --revise --upstream ${eff ?? '<effort>'} | --stop`,
        target: id, note: 'round bound reached — human decision required',
      }
    }
  }

  if (efforts.length === 0) {
    return { line: 'specflow recap --file <recap.json>', stage: 'brainstorm' }
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
          line: `specflow write <plan-id> --effort ${e.slug} --meta m.json --body b.md`,
          stage: 'plan', target: e.slug,
          note: 'chore: plan-level motion — a chore never writes spec content',
        }
      }
      continue
    }
    if (writes.size === 0) {
      return {
        line: `specflow write <spec-id> --effort ${e.slug} --meta m.json --body b.md`,
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
    if (!specsApproved && !gateSettled(e.entries, 'decompose', effortSha)) {
      return authoringOwed(e.entries, 'decompose', effortSha)
        ? {
            line: `specflow write <spec-id> --effort ${e.slug} --meta m.json --body b.md`,
            stage: 'decompose', target: e.slug,
            note: 'revise owed — re-author, then the gate has something new to judge',
          }
        : { line: `specflow gate decompose --effort ${e.slug}`, target: e.slug }
    }
  }

  for (const spec of specs) {
    if (String(spec.meta.status) !== 'approved') continue
    if (!designPending(root, spec)) continue
    const id = String(spec.meta.id)
    // An artifact authored for the CURRENT spec content is awaiting its gate → gate it.
    // Otherwise (no artifact, or one authored before a later amendment) → the design
    // skill authors fresh or, in amend mode, decides re-design vs --reconfirm.
    // A pending design DECISION was already caught by the top-of-function scan; a stale
    // prior approval never routes here because designPending re-arms on stamp.spec mismatch.
    if (!designArtifactCurrent(root, spec)) {
      return { line: `specflow design ${id} --file <html>`, stage: 'design', target: id }
    }
    // Registered but unshown is the normal state right after --file. Ask for the show
    // step by name; routing to the gate here would refuse design-unseen every time.
    return designUnseen(root, cfg.paths, id) !== undefined
      ? { line: `specflow design ${id} --open`, stage: 'design', target: id }
      : { line: `specflow gate design ${id}`, target: id }
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
    return {
      ...act,
      ...noteOf(act.note, planless.length > 1 ? `multiple ready — choose: ${planless.join(' ')}` : undefined),
    }
  }

  // plans-first: every written plan gates before any plan starts or advances —
  // an approved sibling must not short-circuit a draft out of review (stage-major order)
  for (const plan of plans) {
    const id = String(plan.meta.id)
    if (String(plan.meta.status) !== 'draft') continue
    const parent = findById(canon, String(plan.meta.parent))
    const planSha = parent ? planPairSha(plan, parent) : undefined
    const entries = readStream(root, id)
    if (gateSettled(entries, 'plan', planSha)) continue
    if (!authoringOwed(entries, 'plan', planSha)) return { line: `specflow gate plan ${id}`, target: id }
    const act = planWriteAction(root, efforts, id, String(plan.meta.parent), id)
    return { ...act, ...noteOf(act.note, 'revise owed — rewrite the plan, then re-gate') }
  }

  // Starting a flow is tier 3, not tier 1: an approved-but-unstarted plan is new work,
  // and every in-flight flow was already offered above.
  for (const plan of plans) {
    if (String(plan.meta.status) === 'approved') {
      return { line: `specflow start ${String(plan.meta.id)}`, target: String(plan.meta.id) }
    }
  }
  return { line: 'specflow check' }
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
    return refuse([v('--flow', 'not-started', status, `a started plan — run specflow start ${id} first`)])
  }
  return ok(doc)
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  let canon = loadCanon(root)
  const lazy = lazyStamp(root, ctx, canon)
  if (lazy.stamped.length > 0) canon = loadCanon(root)
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
    action = flowAction(root, cfgR.value, flowR.value) ?? { line: 'specflow check', target: values.flow }
  } else {
    const inferred = worktreeFlow(ctx.cwd, root)
    const ambient = inferred !== undefined ? findById(canon, inferred) : undefined
    const scoped = ambient && ambient.meta.type === 'plan'
      ? flowAction(root, cfgR.value, ambient)
      : undefined
    action = scoped ?? computeNext(root, ctx, canon, cfgR.value)
  }
  ctx.out(kv('next', action.line))
  if (action.stage) ctx.out(kv('stage', action.stage))
  if (action.target) ctx.out(kv('target', action.target))
  if (action.note) ctx.out(kv('note', action.note))
  if (action.home) ctx.out(kv('home', action.home))
  if (action.run) ctx.out(kv('run', action.run))
  return EXIT.OK
}
