import { relative } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { acquireLock } from '../lock.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'
import { appendEntry, journalRel } from '../journal.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { findById, loadCanon } from '../scan.js'
import { evaluateNeeds } from '../needs.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'
import { prepareStamp, writeStamp } from '../stamp.js'
import { branchName, createWorktree, worktreePath } from '../worktree.js'
import { existsSync } from 'node:fs'
import type { Need } from '../dsl.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const planId = argv.find((a) => !a.startsWith('--'))
  if (!planId) { ctx.err('usage: specflow start <plan-id>'); return EXIT.REFUSED }
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

  if (status === 'in-progress') {
    const had = existsSync(worktreePath(root, planId))
    const wt = createWorktree(root, planId, base)
    if (!wt.ok) { renderRefusal(wt.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('start', `${planId} already in-progress — worktree ${had ? 'present' : 'recreated'}`))
    ctx.out(kv('worktree', wt.value.path))
    return EXIT.OK
  }
  if (status !== 'approved') {
    const rule = status === 'done' || status === 'abandoned' ? 'terminal-status' : 'not-approved'
    renderRefusal([v('status', rule, status,
      'an approved plan — run: specflow gate plan ' + planId)]).forEach((l) => ctx.err(l))
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
      'all needs ok (specflow check shows details; specflow satisfy flips manual ones)')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  const wt = createWorktree(root, planId, base)
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
  ctx.out(`help: implement inside the worktree; specflow test-evidence ${planId} --phase red|green as you go`)
  return EXIT.OK
}
