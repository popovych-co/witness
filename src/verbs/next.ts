import { existsSync } from 'node:fs'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig, type Config } from '../config.js'
import { pendingTxn } from '../txn.js'
import { primaryRoot } from '../gitio.js'
import { findById, loadCanon, type Canon } from '../scan.js'
import { designArtifactCurrent, designPending, designUnseen } from '../design.js'
import { effortAbandoned, effortStreams, latestRecap, readStream, type Entry } from '../journal.js'
import { effortOf, effortSpecs, effortWrites } from '../reviewed.js'
import { changedFiles, diffBase, evidenceForDiff } from '../evidence.js'
import { worktreePath } from '../worktree.js'
import { lazyStamp } from '../stamp.js'
import { renderRefusal } from '../refusal.js'
import { kv } from '../toon.js'
import { boundReached, lastGateRun, pendingDecision, type DecisionEntry } from '../rounds.js'

export function gateSettled(entries: Entry[], gate: string): boolean {
  const last = lastGateRun(entries, gate)
  if (!last) return false
  if (last.outcome === 'passed') return true
  const after = entries.slice(entries.lastIndexOf(last as unknown as Entry) + 1)
  return after.some((e) => e.t === 'human-decision' &&
    (e as unknown as DecisionEntry).gate === gate &&
    (e as unknown as DecisionEntry).decision === 'approve')
}

export interface NextAction {
  line: string
  stage?: 'brainstorm' | 'decompose' | 'design' | 'plan' | 'implement' | 'ship'
  target?: string
  note?: string
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

  // 3: pending decisions anywhere
  for (const e of efforts) {
    const p = pendingDecision(e.entries, 'decompose')
    if (p) return { line: `specflow decide decompose ${e.slug} --show`, target: e.slug }
  }
  const plans = canon.docs.filter((d) => d.meta.type === 'plan')
    .sort((a, b) => String(a.meta.id).localeCompare(String(b.meta.id)))
  for (const plan of plans) {
    const entries = readStream(root, String(plan.meta.id))
    for (const gate of ['plan', 'implement', 'ship']) {
      const p = pendingDecision(entries, gate)
      if (p) return { line: `specflow decide ${gate} ${String(plan.meta.id)} --show`, target: String(plan.meta.id) }
    }
  }
  const specs = canon.docs.filter((d) => d.meta.type === 'spec')
    .sort((a, b) => String(a.meta.id).localeCompare(String(b.meta.id)))
  for (const spec of specs) {
    const p = pendingDecision(readStream(root, String(spec.meta.id)), 'design')
    if (p) return { line: `specflow decide design ${String(spec.meta.id)} --show`, target: String(spec.meta.id) }
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
    if (writes.size === 0) {
      return {
        line: `specflow write <spec-id> --effort ${e.slug} --meta m.json --body b.md`,
        stage: 'decompose', target: e.slug,
      }
    }
    // Settled either by a real gate-run+approve, or (fixture/seed shortcuts) by every
    // effort spec already being past draft — a plan can't legally target a draft parent,
    // so non-draft specs are proof decompose's outcome was reached one way or another.
    const specs = effortSpecs(root, canon, e.slug)
    const specsApproved = specs.length > 0 && specs.every((d) => String(d.meta.status) !== 'draft')
    if (!specsApproved && !gateSettled(e.entries, 'decompose')) {
      return { line: `specflow gate decompose --effort ${e.slug}`, target: e.slug }
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
    return {
      line: `specflow write ${planless[0]}-plan-1 --effort <slug> --meta m.json --body b.md`,
      stage: 'plan', target: planless[0],
      ...(planless.length > 1 ? { note: `multiple ready — choose: ${planless.join(' ')}` } : {}),
    }
  }

  // plans-first: every written plan gates before any plan starts or advances —
  // an approved sibling must not short-circuit a draft out of review (stage-major order)
  for (const plan of plans) {
    const id = String(plan.meta.id)
    if (String(plan.meta.status) === 'draft') return { line: `specflow gate plan ${id}`, target: id }
  }

  for (const plan of plans) {
    const id = String(plan.meta.id)
    const status = String(plan.meta.status)
    const entries = readStream(root, id)
    if (status === 'approved') return { line: `specflow start ${id}`, target: id }
    if (status !== 'in-progress') continue
    const wt = worktreePath(root, id)
    if (!existsSync(wt)) return { line: `specflow start ${id}`, target: id, note: 'worktree missing — start recreates it' }
    if (plan.meta.pr !== undefined) return { line: `specflow ship ${id}`, stage: 'ship', target: id }
    const baseR = diffBase(wt, cfg)
    const files = baseR.ok ? changedFiles(wt, baseR.value) : []
    // evidenceForDiff is vacuously "satisfied" when nothing has changed yet (an empty
    // required-tags list trivially passes .every()) — a fresh worktree needs the
    // implement-stage hint too, not a premature jump to "gate implement".
    const satisfied = files.length > 0 && baseR.ok && evidenceForDiff(wt, root, plan, baseR.value).satisfied
    if (!satisfied) return { line: `specflow test-evidence ${id} --phase red|green`, stage: 'implement', target: id }
    if (!gateSettled(entries, 'implement')) return { line: `specflow gate implement ${id}`, target: id }
    return { line: `specflow ship ${id}`, stage: 'ship', target: id }
  }
  return { line: 'specflow check' }
}

export async function run(ctx: Ctx, _argv: string[]): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  let canon = loadCanon(root)
  const lazy = lazyStamp(root, ctx, canon)
  if (lazy.stamped.length > 0) canon = loadCanon(root)
  const action = computeNext(root, ctx, canon, cfgR.value)
  ctx.out(kv('next', action.line))
  if (action.stage) ctx.out(kv('stage', action.stage))
  if (action.target) ctx.out(kv('target', action.target))
  if (action.note) ctx.out(kv('note', action.note))
  return EXIT.OK
}
