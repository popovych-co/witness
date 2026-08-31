import { relative } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { acquireLock } from '../lock.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'
import { appendEntry, journalRel } from '../journal.js'
import { primaryRoot, resolveStartBase, stateCommit } from '../gitio.js'
import { autoSync } from './sync.js'
import { findById, loadCanon } from '../scan.js'
import { evaluateNeeds } from '../needs.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'
import { prepareStamp, writeStamp } from '../stamp.js'
import { SESSION_DEFAULT, stagePin } from '../model.js'
import { branchName, createWorktree, worktreePath } from '../worktree.js'
import { existsSync } from 'node:fs'
import type { Need } from '../dsl.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const planId = argv.find((a) => !a.startsWith('--'))
  if (!planId) { ctx.err('usage: witness start <plan-id>'); return EXIT.REFUSED }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const canon = loadCanon(root)
  const plan = findById(canon, planId)
  if (!plan || plan.meta.type !== 'plan') {
    renderRefusal([v('plan', 'unknown-plan', planId, 'a plans/ doc id')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const status = String(plan.meta.status)
  const ship = (cfgR.value.raw.ship ?? {}) as { branch?: string }
  const base = ship.branch ?? 'main'
  // D138. The second natural moment: about to cut a branch, so local main had better be
  // level with origin first. Its failure NEVER blocks the cut — D137's decoupling clause
  // is what makes that row a root fix rather than one more discipline, so a dirty tree or
  // a conflict prints a finding here and the origin-based cut proceeds regardless.
  autoSync(root, ctx, planId, 'start')
  // D137. The cut point is the FETCHED remote tip, never the local ref: a plan branch cut
  // from a local main carrying unpushed state commits inherits them, the PR carries them,
  // and squash-merge collapses them onto origin/main — the shape that made the divergence
  // unrecoverable. Resolved once here and used by BOTH createWorktree call sites.
  const baseRefR = resolveStartBase(root, base)
  if (!baseRefR.ok) { renderRefusal(baseRefR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const baseRef = baseRefR.value

  // the implement-stage pin drives the worker agent too — surfaced so the
  // orchestrator dispatches the implementer on the configured model
  const pinR = stagePin(cfgR.value, 'implement')
  if (!pinR.ok) { renderRefusal(pinR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const agentModel = pinR.value ?? SESSION_DEFAULT

  // Row 79: surface the run's shape so the implement skill reads the dispatch
  // budget mechanically instead of guessing at relay boundaries.
  const budget = cfgR.value.implement.stepsPerDispatch
  const stepCount = ((plan.meta.steps ?? []) as unknown[]).length
  const dispatchLine = `${stepCount} step(s) ≈ ${Math.ceil(stepCount / budget)} dispatch(es) at budget ${budget}`

  if (status === 'in-progress') {
    const had = existsSync(worktreePath(root, planId))
    const wt = createWorktree(root, planId, baseRef)
    if (!wt.ok) { renderRefusal(wt.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('start', `${planId} already in-progress — worktree ${had ? 'present' : 'recreated'}`))
    ctx.out(kv('worktree', wt.value.path))
    // D148. Re-attach re-applies the canon exclusion and checks the tree back out, so a
    // session that already read files in here is holding stale copies — and witness is
    // what moved them. Only on re-attach: a fresh cut has nothing to invalidate.
    if (had) ctx.out(kv('note', 'worktree re-attach refreshed canon exclusions — re-read files you read before this run'))
    ctx.out(kv('agent-model', agentModel))
    ctx.out(kv('dispatch-budget', String(budget)))
    ctx.out(kv('dispatches', dispatchLine))
    return EXIT.OK
  }
  if (status !== 'approved') {
    const rule = status === 'done' || status === 'abandoned' ? 'terminal-status' : 'not-approved'
    renderRefusal([v('status', rule, status,
      'an approved plan — run: witness gate plan ' + planId)]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  const deps = (plan.meta.depends ?? []) as string[]
  const notReady = deps.filter((d) => {
    const doc = findById(canon, d)
    if (!doc) return true
    const s = String(doc.meta.status)
    return doc.meta.type === 'plan' ? s !== 'done' : s !== 'live'
  })
  if (notReady.length) {
    renderRefusal([v('depends', 'blocked-deps', notReady.join(' '),
      'spec deps live / plan deps done before implement starts')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const needs = await evaluateNeeds(root, ctx, (plan.meta.needs ?? []) as Need[])
  const unmet = needs.filter((n) => n.status !== 'ok')
  if (unmet.length) {
    renderRefusal([v('needs', 'needs-unmet', unmet.map((n) => n.label).join(' · '),
      'all needs ok (witness check shows details; witness satisfy flips manual ones)')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  const wt = createWorktree(root, planId, baseRef)
  if (!wt.ok) { renderRefusal(wt.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const stamp = prepareStamp(plan, 'in-progress', 'start', {
    worktree: relative(root, wt.value.path), branch: branchName(planId),
  })
  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    const txn = withTxn(root, {
      op: 'start', files: [stamp.rel, journalRel(stamp.stream)],
      journalMulti: [{ stream: stamp.stream, line: stamp.line }],
    }, () => {
      writeStamp(root, stamp)
      crashPoint(ctx.env, 'start-commit')
      return stateCommit(root, [stamp.rel, journalRel(stamp.stream)], `start(${planId}): worktree created`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  } finally {
    lockR.value()
  }
  ctx.out(kv('start', `${planId} approved → in-progress`))
  ctx.out(kv('worktree', wt.value.path))
  ctx.out(kv('branch', branchName(planId)))
  ctx.out(kv('agent-model', agentModel))
  ctx.out(kv('dispatch-budget', String(budget)))
  ctx.out(kv('dispatches', dispatchLine))
  ctx.out(`help: implement inside the worktree; witness test-evidence ${planId} --phase red|green as you go`)
  return EXIT.OK
}
