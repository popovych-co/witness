import { EXIT, type Ctx } from '../cli.js'
import { refuseClash } from '../clash.js'
import { refuseHeld } from '../held.js'
import { checkoutRoot, diffBase, recordEvidence, verifyRed } from '../evidence.js'
import { loadConfig } from '../config.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, entryLine, journalRel, readStream } from '../journal.js'
import { acquireLock } from '../lock.js'
import { ok, refuse, renderRefusal, v, type Result } from '../refusal.js'
import { findById, loadCanon, type CanonDoc } from '../scan.js'
import { reportStepClose } from '../slice.js'
import { checkStep, closedAt, stepProgress } from '../steps.js'
import { kv } from '../toon.js'
import { guardTxn, withTxn } from '../txn.js'
import type { Violation } from '../refusal.js'

// The lock is taken inside, for the journal write alone (row 181). Its refusal is still
// the one a caller may retry: exit 3, as when it wrapped the whole run.
const exitOf = (violations: Violation[]) => (violations.some((x) => x.rule === 'locked') ? EXIT.BLOCKED : EXIT.REFUSED)

const EVIDENCE_USAGE = 'witness test-evidence <plan-id> --phase red|green [--step <id>]'
const VERIFY_USAGE = 'witness verify-red <plan-id> [--base <ref>] [--step <id>]'

// The plan id is the first token that is neither a flag nor a flag's value, so `--step s1`
// written before the id never reads as the plan. `step-close` reads its id here too (D192).
const VALUED = new Set(['--phase', '--step', '--base'])
export const planIdOf = (argv: string[]): string | undefined =>
  argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1] ?? ''))

// Row 191 §4.3. The step `--step` names, if it names one: a flag where the value belongs is no
// value. Each verb says what no step means, so `step-close` reads it here too (D192).
export function stepOf(argv: string[]): string | undefined {
  const at = argv.indexOf('--step')
  const value = at === -1 ? undefined : argv[at + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

// `--step` named with no value is refused rather than read as no step: an untagged cycle is
// another claim (a fix round), not a typo's default.
function stepArg(argv: string[], usage: string): Result<string | undefined> {
  const step = stepOf(argv)
  return argv.includes('--step') && step === undefined ? refuse([v('--step', 'required', 'absent', usage)]) : ok(step)
}

// Row 191 §4.4. The green just journaled is the stream's last line, and whether it closed a step
// is the plan's progress to say: a step's first passing green after its red does, a re-record or
// a fix round does not. The report reads the same entries (D192): one read names the step closed
// and decides the slice.
function reportGreen(ctx: Ctx, stateRoot: string, plan: CanonDoc, passingGreen: boolean): void {
  const entries = readStream(stateRoot, String(plan.meta.id))
  reportStepClose(ctx, stateRoot, plan, { closed: closedAt(stepProgress(plan, entries), entries.length - 1), passingGreen, entries })
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
  // Row 243 (design §4.1.2). No evidence run starts while a clash in the plan's worktree is
  // unresolved — a suite run over conflict markers journals an outcome of a tree nobody means:
  // refused before the step is checked and before any run, the run's own config read for the branch.
  const clashed = refuseClash(ctx, stateRoot, planId, runRootRes.value)
  if (clashed !== undefined) return clashed
  // Row 247. Nor over a crashed verify-red's set-aside state: its held work goes back first, or the run
  // refuses — a red recorded on the base's tree is the plan's code read as missing.
  const held = refuseHeld(ctx, stateRoot, planId, runRootRes.value)
  if (held !== undefined) return held
  // Row 191 §4.3. Checked before the suite runs: a mistyped step costs no run and journals no
  // entry that no step can claim.
  const stepRefused = checkStep(plan, readStream(stateRoot, planId), step, 'evidence')
  if (stepRefused.length) { renderRefusal(stepRefused).forEach(ctx.err); return EXIT.REFUSED }
  const parentId = String(plan.meta.parent)

  // Row 251. The tree the run reads is evidence about the run, not a precondition: a base that does
  // not resolve journals no tree and refuses nothing.
  const cfgR = loadConfig(runRootRes.value)
  const baseR = cfgR.ok ? diffBase(runRootRes.value, cfgR.value) : undefined
  const probe = await recordEvidence(runRootRes.value, stateRoot, ctx, planId, parentId, phase,
    step !== undefined ? { step } : {}, baseR?.ok ? baseR.value : undefined)
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

// Row 241 (design §4.2.4, R10). The test passed with the plan's change set aside: the step's
// behavior is already on the base. While the step is still open on a plan whose progress is known,
// the step closes "already present" — a `step-close` marked present, an act, journaled once — and
// its green comes next. Read under the lock, so two racing runs journal one close.
function closePresent(ctx: Ctx, root: string, plan: CanonDoc, step: string): void {
  const planId = String(plan.meta.id)
  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return }
  try {
    const p = stepProgress(plan, readStream(root, planId))
    const s = p.known ? p.steps.find((x) => x.id === step && x.kind === 'criteria') : undefined
    if (s === undefined || s.closedAt !== undefined) return
    const entry = { t: 'step-close' as const, artifact: planId, step, present: true }
    const marker = { op: `step-close(${planId})`, files: [journalRel(planId)], journalMulti: [{ stream: planId, line: entryLine(entry) }] }
    const txn = withTxn(root, marker, () => {
      appendEntry(root, planId, entry)
      return stateCommit(root, marker.files, marker.op)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach(ctx.err); return }
    ctx.out(kv('step-close', `${planId} · ${step} closed — already present: its test passed before any change`))
  } finally {
    lock.value()
  }
  // A step close decides the slice, as `step-close` does; its green is the next row.
  reportStepClose(ctx, root, plan, { closed: step, passingGreen: false })
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
  // Row 243: verify-red too, before the set-aside/checkout cycle sets aside a tree that holds a clash.
  const clashed = refuseClash(ctx, stateRoot, planId, runRootRes.value)
  if (clashed !== undefined) return clashed
  // Before the set-aside/checkout cycle, which rewrites the tree: a mistyped step churns nothing.
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
  if (vacuous && step !== undefined) closePresent(ctx, stateRoot, plan, step)
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
