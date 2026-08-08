import { EXIT, type Ctx } from '../cli.js'
import { acquireLock } from '../lock.js'
import { guardTxn, withTxn } from '../txn.js'
import { appendEntry, entryLine, journalRel, readStream } from '../journal.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { loadConfig } from '../config.js'
import { relayLine, resolveDriver } from '../harness.js'
import { findById, loadCanon } from '../scan.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { kv } from '../toon.js'

const FLAGS = ['--steps-assigned', '--steps-completed', '--tokens', '--tool-uses', '--duration-ms'] as const

function intFlag(argv: string[], flag: string, violations: Violation[], required: boolean): number | undefined {
  const at = argv.indexOf(flag)
  if (at === -1) {
    if (required) violations.push(v(flag.slice(2), 'required', 'absent', 'a non-negative integer'))
    return undefined
  }
  const n = Number(argv[at + 1])
  if (!Number.isInteger(n) || n < 0) {
    violations.push(v(flag.slice(2), 'invalid', String(argv[at + 1]), 'a non-negative integer'))
    return undefined
  }
  return n
}

// Row 81: telemetry, not evidence. The numbers are the orchestrator's report of the
// Agent-tool return block — labeled reported, and no gate may ever consume this entry.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const planId = argv.find((a) => !a.startsWith('--') && !FLAGS.includes(argv[argv.indexOf(a) - 1] as typeof FLAGS[number]))
  const violations: Violation[] = []
  const assigned = intFlag(argv, '--steps-assigned', violations, true)
  const completed = intFlag(argv, '--steps-completed', violations, true)
  const tokens = intFlag(argv, '--tokens', violations, false)
  const toolUses = intFlag(argv, '--tool-uses', violations, false)
  const durationMs = intFlag(argv, '--duration-ms', violations, false)
  if (!planId) violations.push(v('plan-id', 'required', 'absent', 'witness dispatch-report <plan-id> --steps-assigned <n> --steps-completed <n>'))
  if (violations.length) { renderRefusal(violations).forEach(ctx.err); return EXIT.REFUSED }

  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const plan = findById(loadCanon(root), planId!)
  if (!plan || plan.meta.type !== 'plan') {
    renderRefusal([v('plan-id', 'unknown-plan', planId!, 'an existing plan id')]).forEach(ctx.err)
    return EXIT.REFUSED
  }

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const ordinal = readStream(root, planId!).filter((e) => e.t === 'dispatch').length + 1
    const usage = tokens !== undefined || toolUses !== undefined || durationMs !== undefined
      ? {
          ...(tokens !== undefined ? { tokens } : {}),
          ...(toolUses !== undefined ? { tool_uses: toolUses } : {}),
          ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
        }
      : undefined
    const entry = {
      t: 'dispatch' as const, plan: planId!, ordinal,
      steps_assigned: assigned!, steps_completed: completed!,
      ...(usage ? { usage } : {}), reported: true,
    }
    const marker = {
      op: `dispatch-report(${planId})`,
      files: [journalRel(planId!)],
      journalMulti: [{ stream: planId!, line: entryLine(entry) }],
    }
    const txn = withTxn(root, marker, () => {
      appendEntry(root, planId!, entry)
      return stateCommit(root, marker.files, marker.op)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach(ctx.err); return EXIT.REFUSED }
    ctx.out(kv('dispatch', `${planId} · #${ordinal} · ${completed}/${assigned} step(s)`))
    // The relay is a session-boundary fact the skill must not hardcode: /clear on
    // Claude Code, /new on Pi. A broken config must not cost the telemetry entry that
    // was already journalled, so an unresolvable harness simply omits the line and the
    // skill stops for the human.
    const cfgR = loadConfig(root)
    const hxR = resolveDriver(ctx.env, cfgR.ok ? cfgR.value.raw : {})
    if (hxR.ok) ctx.out(kv('relay', relayLine(hxR.value.harness)))
    return EXIT.OK
  } finally {
    lock.ok && lock.value()
  }
}
