import { EXIT, type Ctx } from '../cli.js'
import { checkoutRoot, diffBase, recordEvidence, verifyRed } from '../evidence.js'
import { loadConfig } from '../config.js'
import { primaryRoot } from '../gitio.js'
import { renderRefusal, v } from '../refusal.js'
import { findById, loadCanon } from '../scan.js'
import { kv } from '../toon.js'
import { guardTxn } from '../txn.js'
import { acquireLock } from '../lock.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const [planId] = argv.filter((a) => !a.startsWith('--'))
  const phase = argv[argv.indexOf('--phase') + 1]
  if (!planId || (phase !== 'red' && phase !== 'green')) {
    renderRefusal([v('args', 'usage', argv.join(' '), 'witness test-evidence <plan-id> --phase red|green')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const runRootRes = checkoutRoot(ctx.cwd)
  const stateRootRes = primaryRoot(ctx.cwd)
  if (!runRootRes.ok || !stateRootRes.ok) {
    renderRefusal([...(runRootRes.ok ? [] : runRootRes.violations), ...(stateRootRes.ok ? [] : stateRootRes.violations)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const stateRoot = stateRootRes.value
  const blocked = guardTxn(ctx, stateRoot)
  if (blocked !== undefined) return blocked

  const plan = findById(loadCanon(stateRoot), planId)
  if (!plan || plan.meta.type !== 'plan') {
    renderRefusal([v('plan-id', 'unknown-plan', planId, 'an existing plan id')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const parentId = String(plan.meta.parent)

  const lock = acquireLock(stateRoot)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const probe = await recordEvidence(runRootRes.value, stateRoot, ctx, planId, parentId, phase)
    if (!probe.ok) { renderRefusal(probe.violations).forEach(ctx.err); return EXIT.REFUSED }
    const { allOk, tests } = probe.value
    ctx.out(kv('test-evidence', `${planId} · ${phase} · ${tests.length} outcome(s) · ${allOk ? 'all green' : 'red present'}`))
    if (phase === 'red' && allOk) {
      ctx.err('vacuous: tests pass before implementation — the test may assert nothing, or the behavior already exists')
      return EXIT.FINDINGS
    }
    if (phase === 'green' && !allOk) {
      ctx.err('not green — fix the implementation and re-run')
      return EXIT.FINDINGS
    }
    return EXIT.OK
  } finally {
    lock.ok && lock.value()
  }
}

export async function runVerifyRed(ctx: Ctx, argv: string[]): Promise<number> {
  const [planId] = argv.filter((a) => !a.startsWith('--'))
  const baseArg = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : undefined
  if (!planId) {
    renderRefusal([v('args', 'usage', argv.join(' '), 'witness verify-red <plan-id> [--base <ref>]')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const runRootRes = checkoutRoot(ctx.cwd)
  const stateRootRes = primaryRoot(ctx.cwd)
  if (!runRootRes.ok || !stateRootRes.ok) {
    renderRefusal([...(runRootRes.ok ? [] : runRootRes.violations), ...(stateRootRes.ok ? [] : stateRootRes.violations)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const stateRoot = stateRootRes.value
  const blocked = guardTxn(ctx, stateRoot)
  if (blocked !== undefined) return blocked
  const plan = findById(loadCanon(stateRoot), planId)
  if (!plan || plan.meta.type !== 'plan') {
    renderRefusal([v('plan-id', 'unknown-plan', planId, 'an existing plan id')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const cfg = loadConfig(runRootRes.value)
  if (!cfg.ok) { renderRefusal(cfg.violations).forEach(ctx.err); return EXIT.REFUSED }
  const base = diffBase(runRootRes.value, cfg.value, baseArg)
  if (!base.ok) { renderRefusal(base.violations).forEach(ctx.err); return EXIT.REFUSED }

  const lock = acquireLock(stateRoot)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const res = await verifyRed(runRootRes.value, stateRoot, ctx, planId, String(plan.meta.parent), base.value)
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
    const { redOk, greenOk, vacuous } = res.value
    ctx.out(kv('verify-red', `red ${redOk ? 'observed' : 'NOT observed'} · green ${greenOk ? 'confirmed' : 'NOT confirmed'}`))
    if (vacuous) {
      ctx.err('vacuous: tests pass against base — the test may assert nothing, or the behavior already existed')
      return EXIT.FINDINGS
    }
    if (!greenOk) {
      ctx.err('suite not green after restore — repository state was restored; investigate before trusting this diff')
      return EXIT.FINDINGS
    }
    return EXIT.OK
  } finally {
    lock.ok && lock.value()
  }
}
