import { relative } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { acquireLock } from '../lock.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'
import { appendEntry, journalRel, readStream } from '../journal.js'
import { primaryRoot, resolveStartBase, stateCommit } from '../gitio.js'
import { autoSync } from './sync.js'
import { findById, loadCanon } from '../scan.js'
import { stepProgress, stepsLine } from '../steps.js'
import { evaluateNeeds, unmetNeeds } from '../needs.js'
import { humanCall, renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'
import { autonomyLines, keptStopLine, policyFor } from '../autonomy.js'
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
  autonomyLines(cfgR.value).forEach((l) => ctx.out(l))
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
  // Row 191 §4.3. Where the plan stands, so a session opening mid-plan reads it from the CLI
  // instead of reconstructing it from the journal.
  const position = stepsLine(stepProgress(plan, readStream(root, planId)))

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
    ctx.out(kv('steps', position))
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
  const needs = await evaluateNeeds(root, ctx, (plan.meta.needs ?? []) as Need[], plan)
  const unmet = needs.filter((n) => n.status !== 'ok')
  if (unmet.length) {
    // Row 179. Satisfying a manual need is the human's act, so its commands are named in `want`
    // and the row is a human's decision — never a `remedy`, whose `run:` line reads as mechanical.
    const satisfy = unmetNeeds(canon).filter((u) => u.doc === planId).map((u) => u.satisfy)
    const machine = unmet.some((n) => n.kind !== 'manual')
    const want = [...satisfy.map((c) => `a human runs ${c}`), ...(machine ? ['witness check shows env and cmd needs'] : [])].join(' · ')
    const row = v('needs', 'needs-unmet', unmet.map((n) => n.label).join(' · '), want)
    renderRefusal([unmet.some((n) => n.kind === 'manual') ? humanCall(row) : row]).forEach((l) => ctx.err(l))
    // Row 171. Under autonomy an unmet plan need is a kept stop: only this plan waits, and
    // the line names the act that unblocks it.
    if (cfgR.value.autonomy) {
      const p = policyFor({ at: 'start', target: planId, unmet: unmet.map((n) => n.label) })
      if (p.kind === 'human') {
        ctx.out(keptStopLine(p.stop, `${unmet.map((n) => n.label).join(' · ')}${satisfy.map((c) => ` · ${c}`).join('')}`))
      }
    }
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
  ctx.out(kv('steps', position))
  ctx.out(`help: implement inside the worktree; witness test-evidence ${planId} --phase red|green as you go`)
  return EXIT.OK
}
