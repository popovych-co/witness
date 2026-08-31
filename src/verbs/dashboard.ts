import { existsSync } from 'node:fs'
import { EXIT, version, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { designArtifactCurrent, designPending } from '../design.js'
import { reconcileRows } from '../drift.js'
import { divergence, primaryRoot } from '../gitio.js'
import { DEFAULT_HARNESS, judgeLine, resolveJudge } from '../harness.js'
import { effortAbandoned, effortStreams, latestRecap, readStream } from '../journal.js'
import { modelFloorLines } from '../model.js'
import { computeNext, flowAction, parkedGates } from './next.js'
import { renderRefusal } from '../refusal.js'
import { openDeferrals } from '../deferral.js'
import { pendingDecision, type DecisionEntry, type GateRunEntry } from '../rounds.js'
import { findById, loadCanon, type Canon, type CanonDoc } from '../scan.js'
import { lazyStamp } from '../stamp.js'
import { kv, rows } from '../toon.js'
import { pendingTxn } from '../txn.js'
import { worktreePath } from '../worktree.js'

function tally(docs: CanonDoc[]): string {
  const counts = new Map<string, number>()
  docs.forEach((d) => counts.set(String(d.meta.status), (counts.get(String(d.meta.status)) ?? 0) + 1))
  return [...counts.entries()].sort().map(([s, n]) => `${s} ${n}`).join(' · ') || 'none'
}

function blockedRows(canon: Canon, ctx: Ctx): Array<{ doc: string; why: string }> {
  const out: Array<{ doc: string; why: string }> = []
  for (const doc of canon.docs) {
    if (doc.meta.type === 'principles') continue
    if (doc.meta.status === 'live' || doc.meta.status === 'done' || doc.meta.status === 'abandoned') continue
    const id = String(doc.meta.id)
    const depends = Array.isArray(doc.meta.depends) ? (doc.meta.depends as string[]) : []
    for (const dep of depends) {
      const target = findById(canon, dep)
      if (!target) out.push({ doc: id, why: `depends: ${dep} (missing)` })
      else if (target.meta.status !== 'live') out.push({ doc: id, why: `depends: ${dep} (${String(target.meta.status)})` })
    }
    const needs = Array.isArray(doc.meta.needs) ? (doc.meta.needs as Array<Record<string, unknown>>) : []
    for (const n of needs) {
      if (typeof n.env === 'string' && !ctx.env[n.env]) out.push({ doc: id, why: `needs: ${n.env} unset` })
      if (typeof n.manual === 'string' && n.satisfied !== true) out.push({ doc: id, why: `needs: ${n.manual} unsatisfied` })
    }
  }
  return out
}

// D122. Aged in ROUNDS, never in wall-clock: this CLI has no timestamps anywhere — the
// gate-run entry carries none — so "61 rounds" is derivable and "3 weeks" is not.
export function deferralRows(
  root: string, canon: Canon,
): Array<{ id: string; artifact: string; gate: string; anchor: string; kind: string; age: string }> {
  const streams = new Set([...effortStreams(root), ...canon.docs.map((d) => String(d.meta.id))])
  const out: Array<{ id: string; artifact: string; gate: string; anchor: string; kind: string; age: string }> = []
  for (const id of streams) {
    const entries = readStream(root, id)
    for (const d of openDeferrals(entries)) {
      // Rounds on THIS stream since the one that minted it. A re-booked debt starts over on
      // the spec stream, which is honest: the parent has had no rounds of its own yet, and
      // `moved from` is what carries the history a human needs.
      const since = entries.filter((e) => e.t === 'gate-run' &&
        (e as unknown as GateRunEntry).artifact === d.artifact).length - d.round
      out.push({
        id: d.id, artifact: d.artifact, gate: d.gate, anchor: d.anchor, kind: d.kind,
        age: `${Math.max(0, since)} round(s)${d.moved_from ? ` · moved from ${d.moved_from}` : ''}`,
      })
    }
  }
  return out
}

const RECOMMENDER_MIN_SAMPLE = 5

// D130. The subject is THE RULE, never the human: `reserved-stop-clean · fired 9 ·
// overridden 7` says *this rule is wrong*. A per-human compliance figure would be the same
// data with the opposite effect — conformity pressure at exactly the three stops where
// independent judgment is the point. Suppressed below a minimum sample: a percentage over
// three decisions measures nothing and reads as authority.
//
// Split from the stream walk so the tally is testable without seeding five real decisions.
export function recommenderRowsFrom(
  decisions: Array<{ rule?: string; recommended?: string; decision: string; selected?: string }>,
): Array<{ rule: string; fired: number; overridden: number; nodded: number }> {
  const tally = new Map<string, { fired: number; overridden: number; nodded: number }>()
  for (const d of decisions) {
    if (!d.rule || !d.recommended) continue
    const row = tally.get(d.rule) ?? { fired: 0, overridden: 0, nodded: 0 }
    row.fired += 1
    // D143. What a nod closed, per rule — the reader that makes closure-by-nod a measured
    // cost rather than an argued one, on the same subject D130 set: the RULE, never the
    // human. A rule that is almost always nodded through is a rule nobody is looking at.
    if (d.selected === 'affirmation') row.nodded += 1
    // `startsWith` so `revise-upstream` counts as following a `revise` recommendation. If
    // that proves too loose in the field, tighten it to full verbs and record the change.
    if (!d.decision.startsWith(d.recommended)) row.overridden += 1
    tally.set(d.rule, row)
  }
  return [...tally.entries()]
    .filter(([, r]) => r.fired >= RECOMMENDER_MIN_SAMPLE)
    .map(([rule, r]) => ({ rule, ...r }))
    .sort((a, b) => b.overridden - a.overridden || a.rule.localeCompare(b.rule))
}

export function recommenderRows(
  root: string, canon: Canon,
): Array<{ rule: string; fired: number; overridden: number; nodded: number }> {
  const streams = new Set([...effortStreams(root), ...canon.docs.map((d) => String(d.meta.id))])
  const decisions: Array<{ rule?: string; recommended?: string; decision: string; selected?: string }> = []
  for (const id of streams) {
    for (const e of readStream(root, id)) {
      if (e.t !== 'human-decision') continue
      const d = e as unknown as DecisionEntry
      decisions.push({ rule: d.rule, recommended: d.recommended, decision: d.decision, selected: d.selected })
    }
  }
  return recommenderRowsFrom(decisions)
}

// D150. Row 64 promised this trend and never built it — the 2026-08-29 field report had to
// count refusals by hand. Subject is the WRITE PATH, not the author (D130's framing): a low
// first-try rate means the manifest contract is hard to hit, not that anyone erred. Per
// artifact, "first-try" means its FIRST write-path entry is a `write`, so a refusal followed
// by a successful write still counts against the path that refused it.
export function writePathStats(root: string): { firstTry: number; artifacts: number; refused: number } {
  const first = new Map<string, 'write' | 'write-refused'>()
  let refused = 0
  for (const slug of effortStreams(root)) {
    for (const e of readStream(root, slug)) {
      if (e.t !== 'write' && e.t !== 'write-refused') continue
      if (e.t === 'write-refused') refused += 1
      const artifact = String(e.artifact ?? '')
      if (artifact !== '' && !first.has(artifact)) first.set(artifact, e.t)
    }
  }
  const seen = [...first.values()]
  return { artifacts: seen.length, firstTry: seen.filter((t) => t === 'write').length, refused }
}

export async function run(ctx: Ctx, _argv: string[]): Promise<number> {
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const cfg = loadConfig(root)
  ctx.out(kv('witness', `${version()} · schema: ${cfg.ok ? cfg.value.schema : '?'}`))
  // Row 105's judgment lane, not its session lane: this feeds modelFloorLines, the one
  // renderer shared with `check`, and a floor computed on a different ladder from the
  // judge line above it would have `status` and `check` disagreeing about which
  // reviewers the same repo spawns. `status` renders no handoff, so it has no driver.
  // A broken harness config must not brick the dashboard — `check` reports that as a
  // finding, so both lines degrade to claude-code and say so.
  //
  // Resolved ABOVE the config guard because the flows table below needs it too, and
  // resolving it twice is how one screen's two answers drift apart.
  const judgeR = resolveJudge(ctx.env, cfg.ok ? cfg.value.raw : {})
  if (cfg.ok) {
    ctx.out(kv('judge', judgeLine(judgeR)))
    // One line per distinct warning, labelled with the gates it applies to — per-gate
    // model pins can put each gate in a different calibration state. Shared with
    // `check` (D98a): the calibration fact must read the same on both surfaces.
    for (const line of modelFloorLines(root, cfg.value, judgeR.ok ? judgeR.value.harness.name : DEFAULT_HARNESS)) {
      ctx.out(kv('model-floor', line))
    }
  }

  const txn = pendingTxn(root)
  if (txn) ctx.out(kv('pending-txn', txn.op))

  // D139. `check`'s finding and this line are ONE computation (`divergence`) with two
  // renderers — the D101 boundary. Re-deriving it here is how the two surfaces drift apart.
  if (cfg.ok) {
    const shipBranch = String(((cfg.value.raw.ship ?? {}) as Record<string, unknown>).branch ?? 'main')
    const div = divergence(root, shipBranch)
    if (div && (div.ahead > 0 || div.behind > 0)) {
      ctx.out(kv('sync', `local ${shipBranch} ${div.ahead} ahead · ${div.behind} behind origin/${shipBranch} — witness sync`))
    }
  }

  const canon0 = loadCanon(root)
  const lazy = lazyStamp(root, ctx, canon0)
  const canon = lazy.stamped.length > 0 ? loadCanon(root) : canon0
  const efforts = effortStreams(root).filter((slug) => !effortAbandoned(readStream(root, slug)))
  const effortRows = efforts.map((slug) => {
    const recap = latestRecap(root, slug)
    const artifacts = new Set(
      readStream(root, slug).filter((e) => e.t === 'write').map((e) => String(e.artifact)),
    )
    const kinds = [...artifacts].map((a) => findById(canon, a)?.meta.type)
    return {
      slug,
      class: recap?.class ?? '?',
      specs: kinds.filter((k) => k === 'spec' || k === 'principles').length,
      plans: kinds.filter((k) => k === 'plan').length,
      writes: artifacts,
    }
  })
  if (effortRows.length) {
    rows('efforts', ['slug', 'class', 'specs', 'plans'], effortRows as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  // D124. `next` stops offering a gate a human stopped; this is the surface that keeps it
  // from disappearing instead. High on the screen on purpose — a parked flow is orientation,
  // not a footnote, and `reopen` is the act that brings it back.
  const parked = parkedGates(root, canon)
  if (parked.length > 0) {
    rows('parked', ['gate', 'target', 'round', 'anchor', 'reopen'],
      parked as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  const debts = deferralRows(root, canon)
  if (debts.length > 0) {
    rows('deferrals', ['id', 'artifact', 'gate', 'anchor', 'kind', 'age'],
      debts as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  const rec = recommenderRows(root, canon)
  if (rec.length > 0) {
    rows('recommender', ['rule', 'fired', 'overridden', 'nodded'], rec as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  const wp = writePathStats(root)
  if (wp.artifacts > 0 || wp.refused > 0) {
    ctx.out(kv('write-path', `${wp.firstTry}/${wp.artifacts} artifacts first-try · ${wp.refused} refusal(s)`))
  }
  ctx.out(kv('canon', tally(canon.docs.filter((d) => d.rel.startsWith(`${canon.paths.specs}/`)))))
  ctx.out(kv('plans', tally(canon.docs.filter((d) => d.rel.startsWith(`${canon.paths.plans}/`)))))
  // In-flight flows: the orientation surface between sessions, and the one `next` no
  // longer enumerates. Membership is the same predicate as next's tier 1 — a plan with
  // status `in-progress` — and `stage`/`next` come from the SAME flowAction next uses,
  // never re-derived. A shorthand like `pr ? 'ship' : 'implement'` is wrong in three of
  // the five states a flow occupies (missing worktree, unsatisfied evidence, unsettled
  // implement gate), which is unacceptable on the screen whose job is orientation.
  const flowRows = cfg.ok
    ? canon.docs
      .filter((d) => d.meta.type === 'plan')
      .sort((a, b) => String(a.meta.id).localeCompare(String(b.meta.id)))
      .flatMap((d) => {
        // `--flow` and this table must answer with the SAME derivation next uses, never a
        // re-derived shorthand (flowAction's own contract) — so the judge is passed here
        // too, even though the flows table has no note column and nothing changes on
        // screen. Diverging the arguments is how the shorthand creeps back in.
        const action = flowAction(root, cfg.value, d, judgeR.ok ? judgeR.value.harness.name : undefined)
        if (!action) return []
        const id = String(d.meta.id)
        return [{
          id,
          stage: action.stage ?? 'gate',
          next: action.line,
          worktree: existsSync(worktreePath(root, id)) ? 'present' : 'missing',
          pr: d.meta.pr ?? '—',
        }]
      })
    : []
  if (flowRows.length) {
    rows('flows', ['id', 'stage', 'next', 'worktree', 'pr'], flowRows as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  const blocked = blockedRows(canon, ctx)
  if (blocked.length) rows('blocked', ['doc', 'why'], blocked as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  const reconcile = reconcileRows(root, canon)
  if (reconcile.length) {
    rows('reconcile', ['spec', 'why', 'detail'], reconcile as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  const designPend = canon.docs.filter((d) => d.meta.type === 'spec' && designPending(root, d))
    .map((d) => ({ spec: String(d.meta.id), why: designArtifactCurrent(root, d) ? 'design gate pending' : 'design owed' }))
  if (designPend.length) {
    rows('design', ['spec', 'why'], designPend as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  if (lazy.stale.length) {
    rows('stale', ['plan', 'why'], lazy.stale as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  // D141. A worktree the sweep declined to remove because this session stands in it.
  // Printed with the stale rows, above the routing block, for the same reason.
  for (const path of lazy.kept) {
    ctx.out(kv('note', `worktree ${path} kept — this session stands in it; leave the directory and re-run`))
  }
  const pendingGates: Array<{ gate: string; target: string; round: number; outcome: string }> = []
  for (const plan of canon.docs.filter((d) => d.meta.type === 'plan')) {
    const id = String(plan.meta.id)
    for (const gate of ['plan', 'implement', 'ship']) {
      const p = pendingDecision(readStream(root, id), gate)
      if (p) pendingGates.push({ gate, target: id, round: p.round, outcome: p.outcome })
    }
  }
  for (const spec of canon.docs.filter((d) => d.meta.type === 'spec')) {
    const p = pendingDecision(readStream(root, String(spec.meta.id)), 'design')
    if (p) pendingGates.push({ gate: 'design', target: String(spec.meta.id), round: p.round, outcome: p.outcome })
  }
  for (const slug of efforts) {
    const p = pendingDecision(readStream(root, slug), 'decompose')
    if (p) pendingGates.push({ gate: 'decompose', target: slug, round: p.round, outcome: p.outcome })
  }
  if (pendingGates.length) {
    rows('gates', ['gate', 'target', 'round', 'outcome'], pendingGates as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  }
  if (canon.docs.some((d) => (Array.isArray(d.meta.needs) ? (d.meta.needs as Array<Record<string, unknown>>) : []).some((n) => typeof n.cmd === 'string'))) {
    ctx.out('note: cmd needs are not executed at scan — run witness check')
  }

  const next = cfg.ok ? computeNext(root, ctx, canon, cfg.value).line : 'witness check'
  ctx.out(`next: ${next}`)
  ctx.out('help: witness check · index · diff <id> · log <id>')
  return EXIT.OK
}
