import { EXIT, type Ctx } from '../cli.js'
import { acquireLock } from '../lock.js'
import { guardTxn, withTxn } from '../txn.js'
import { appendEntry, entryLine, journalRel, readStream } from '../journal.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { findById, loadCanon } from '../scan.js'
import { reportStepClose } from '../slice.js'
import { checkStep, closingIndex } from '../steps.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'

// Row 191 §4.3. A scaffolding step has no red→green to witness, so its close is journaled on
// its own and the entry is the whole act. Like `test-evidence` it checks no plan status, and it
// runs from the primary root or the plan's worktree alike: the journal lives at the primary root.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  // A flag where the value belongs is no value; `checkStep` refuses the close that names none.
  const at = argv.indexOf('--step')
  const value = at === -1 ? undefined : argv[at + 1]
  const step = value === undefined || value.startsWith('--') ? undefined : value
  const planId = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--step')
  if (!planId) {
    renderRefusal([v('plan-id', 'required', 'absent', 'witness step-close <plan-id> --step <id>')]).forEach(ctx.err)
    return EXIT.REFUSED
  }

  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const plan = findById(loadCanon(root), planId)
  if (!plan || plan.meta.type !== 'plan') {
    renderRefusal([v('plan-id', 'unknown-plan', planId, 'an existing plan id')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  // `checkStep` refuses a close that names no step, which is what narrows `step` here.
  const refused = checkStep(plan, readStream(root, planId), step, 'close')
  if (refused.length > 0 || step === undefined) { renderRefusal(refused).forEach(ctx.err); return EXIT.REFUSED }

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    // Plan's call 6: a step closes once, so a killed close re-run journals nothing. Read under
    // the lock, so two racing closes journal one entry between them.
    if (closingIndex({ id: step, kind: 'scaffolding' }, readStream(root, planId)) !== undefined) {
      ctx.out(kv('step-close', `${planId} · ${step} already closed`))
      return EXIT.OK
    }
    const entry = { t: 'step-close' as const, artifact: planId, step }
    const marker = {
      op: `step-close(${planId})`,
      files: [journalRel(planId)],
      journalMulti: [{ stream: planId, line: entryLine(entry) }],
    }
    const txn = withTxn(root, marker, () => {
      appendEntry(root, planId, entry)
      return stateCommit(root, marker.files, marker.op)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach(ctx.err); return EXIT.REFUSED }
    ctx.out(kv('step-close', `${planId} · ${step} closed`))
  } finally {
    lock.value()
  }
  // Row 191 §4.4: a scaffolding close is a step close, so the slice is decided here too. It is
  // named, not read from progress: a legacy plan hides its criteria closes, never this one. Read
  // after the lock is released, since the report writes nothing.
  reportStepClose(ctx, root, plan, { closed: step, passingGreen: false })
  return EXIT.OK
}
