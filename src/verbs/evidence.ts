import { EXIT, type Ctx } from '../cli.js'
import { checkoutRoot, diffBase, recordEvidence, verifyRed } from '../evidence.js'
import { loadConfig } from '../config.js'
import { primaryRoot } from '../gitio.js'
import { readStream } from '../journal.js'
import { ok, refuse, renderRefusal, v, type Result } from '../refusal.js'
import { findById, loadCanon, type CanonDoc } from '../scan.js'
import { reportStepClose } from '../slice.js'
import { checkStep, closedAt, stepProgress } from '../steps.js'
import { kv } from '../toon.js'
import { guardTxn } from '../txn.js'
import type { Violation } from '../refusal.js'

// The lock is taken inside, for the journal write alone (row 181). Its refusal is still
// the one a caller may retry: exit 3, as when it wrapped the whole run.
const exitOf = (violations: Violation[]) => (violations.some((x) => x.rule === 'locked') ? EXIT.BLOCKED : EXIT.REFUSED)

const EVIDENCE_USAGE = 'witness test-evidence <plan-id> --phase red|green [--step <id>]'
const VERIFY_USAGE = 'witness verify-red <plan-id> [--base <ref>] [--step <id>]'

// The plan id is the first token that is neither a flag nor a flag's value, so `--step s1`
// written before the id never reads as the plan.
const VALUED = new Set(['--phase', '--step', '--base'])
const planIdOf = (argv: string[]): string | undefined =>
  argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1] ?? ''))

// Row 191 §4.3. `--step` named with no value is refused rather than read as no step: an
// untagged cycle is another claim (a fix round), not a typo's default. A flag where the value
// belongs is no value.
function stepArg(argv: string[], usage: string): Result<string | undefined> {
  const at = argv.indexOf('--step')
  if (at === -1) return ok(undefined)
  const value = argv[at + 1]
  return value === undefined || value.startsWith('--') ? refuse([v('--step', 'required', 'absent', usage)]) : ok(value)
}

// Row 191 §4.4. The green just journaled is the stream's last line, and whether it closed a step
// is the plan's progress to say: a step's first passing green after its red does, a re-record or
// a fix round does not.
function reportGreen(ctx: Ctx, stateRoot: string, plan: CanonDoc, passingGreen: boolean): void {
  const entries = readStream(stateRoot, String(plan.meta.id))
  reportStepClose(ctx, stateRoot, plan, { closed: closedAt(stepProgress(plan, entries), entries.length - 1), passingGreen })
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const planId = planIdOf(argv)
  const phase = argv[argv.indexOf('--phase') + 1]
  if (!planId || (phase !== 'red' && phase !== 'green')) {
    renderRefusal([v('args', 'usage', argv.join(' '), EVIDENCE_USAGE)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const stepR = stepArg(argv, EVIDENCE_USAGE)
  if (!stepR.ok) { renderRefusal(stepR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const step = stepR.value
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
  // Row 191 §4.3. Checked before the suite runs: a mistyped step costs no run and journals no
  // entry that no step can claim.
  const stepRefused = checkStep(plan, readStream(stateRoot, planId), step, 'evidence')
  if (stepRefused.length) { renderRefusal(stepRefused).forEach(ctx.err); return EXIT.REFUSED }
  const parentId = String(plan.meta.parent)

  const probe = await recordEvidence(runRootRes.value, stateRoot, ctx, planId, parentId, phase, step !== undefined ? { step } : {})
  if (!probe.ok) { renderRefusal(probe.violations).forEach(ctx.err); return exitOf(probe.violations) }
  const { allOk, tests } = probe.value
  ctx.out(kv('test-evidence', `${planId} · ${phase} · ${tests.length} outcome(s) · ${allOk ? 'all green' : 'red present'}`))
  if (phase === 'green') reportGreen(ctx, stateRoot, plan, allOk)
  if (phase === 'red' && allOk) {
    ctx.err('vacuous: tests pass before implementation — the test may assert nothing, or the behavior already exists')
    return EXIT.FINDINGS
  }
  if (phase === 'green' && !allOk) {
    ctx.err('not green — fix the implementation and re-run')
    return EXIT.FINDINGS
  }
  return EXIT.OK
}

export async function runVerifyRed(ctx: Ctx, argv: string[]): Promise<number> {
  const planId = planIdOf(argv)
  const baseArg = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : undefined
  if (!planId) {
    renderRefusal([v('args', 'usage', argv.join(' '), VERIFY_USAGE)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const stepR = stepArg(argv, VERIFY_USAGE)
  if (!stepR.ok) { renderRefusal(stepR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const step = stepR.value
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
  // Before the stash/checkout cycle, which rewrites the tree: a mistyped step churns nothing.
  const stepRefused = checkStep(plan, readStream(stateRoot, planId), step, 'evidence')
  if (stepRefused.length) { renderRefusal(stepRefused).forEach(ctx.err); return EXIT.REFUSED }
  const cfg = loadConfig(runRootRes.value)
  if (!cfg.ok) { renderRefusal(cfg.violations).forEach(ctx.err); return EXIT.REFUSED }
  const base = diffBase(runRootRes.value, cfg.value, baseArg)
  if (!base.ok) { renderRefusal(base.violations).forEach(ctx.err); return EXIT.REFUSED }

  const res = await verifyRed(runRootRes.value, stateRoot, ctx, planId, String(plan.meta.parent), base.value, step)
  if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return exitOf(res.violations) }
  const { redOk, greenOk, vacuous } = res.value
  ctx.out(kv('verify-red', `red ${redOk ? 'observed' : 'NOT observed'} · green ${greenOk ? 'confirmed' : 'NOT confirmed'}`))
  // Reported once, after the green. A vacuous reconstruction is a finding, not a cycle: its green
  // only confirmed the restore and journaled nothing (final review I3), so it closed no step and
  // decides no slice, not even on a legacy plan.
  if (!vacuous) reportGreen(ctx, stateRoot, plan, greenOk)
  if (vacuous) {
    ctx.err('vacuous: tests pass against base — the test may assert nothing, or the behavior already existed')
    return EXIT.FINDINGS
  }
  if (!greenOk) {
    ctx.err('suite not green after restore — repository state was restored; investigate before trusting this diff')
    return EXIT.FINDINGS
  }
  return EXIT.OK
}
