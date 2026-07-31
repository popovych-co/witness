import { existsSync } from 'node:fs'
import { EXIT, version, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { designArtifactCurrent, designPending } from '../design.js'
import { reconcileRows } from '../drift.js'
import { DEFAULT_BATTERIES } from '../gate.js'
import { primaryRoot } from '../gitio.js'
import { resolveHarness } from '../harness.js'
import { effortAbandoned, effortStreams, latestRecap, readStream } from '../journal.js'
import { loadMatrix, resolveModel } from '../model.js'
import { computeNext, flowAction } from './next.js'
import { renderRefusal } from '../refusal.js'
import { pendingDecision } from '../rounds.js'
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

export async function run(ctx: Ctx, _argv: string[]): Promise<number> {
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const cfg = loadConfig(root)
  ctx.out(kv('witness', `${version()} · schema: ${cfg.ok ? cfg.value.schema : '?'}`))
  if (cfg.ok) {
    // Diagnostic surface: a broken harness config must not brick the dashboard —
    // `check` reports that as a finding, so the floor lines fall back to claude-code.
    const hxR = resolveHarness(ctx.env, cfg.value.raw)
    const matrix = loadMatrix(root, hxR.ok ? hxR.value.harness.name : 'claude-code')
    // one line per distinct warning, labeled with the gates it applies to —
    // per-gate model pins can put each gate in a different calibration state
    const byWarning = new Map<string, string[]>()
    for (const gate of Object.keys(DEFAULT_BATTERIES)) {
      const modelR = resolveModel(cfg.value, matrix, gate)
      if (modelR.ok && modelR.value.warning) {
        byWarning.set(modelR.value.warning, [...(byWarning.get(modelR.value.warning) ?? []), gate])
      }
    }
    for (const [warning, gates] of byWarning) {
      ctx.out(kv('model-floor', `${gates.join(' · ')}: ${warning}`))
    }
  }

  const txn = pendingTxn(root)
  if (txn) ctx.out(kv('pending-txn', txn.op))

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
        const action = flowAction(root, cfg.value, d)
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
