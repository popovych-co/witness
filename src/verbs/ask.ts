import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { queueAsk, withdrawAsk } from '../ask.js'
import { loadConfig } from '../config.js'
import { primaryRoot } from '../gitio.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { kv } from '../toon.js'
import { guardTxn } from '../txn.js'

// Row 176. The lock is the one refusal that clears by waiting, so it keeps the house's
// BLOCKED exit; everything else is the caller's input.
const exitOf = (violations: Violation[]) => (violations.some((x) => x.rule === 'locked') ? EXIT.BLOCKED : EXIT.REFUSED)

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { withdraw: { type: 'string' }, note: { type: 'string' } },
    allowPositionals: true,
  })
  const text = positionals.join(' ')
  if (values.withdraw !== undefined && positionals.length > 0) {
    renderRefusal([v('ask', 'usage', 'text and --withdraw together', 'witness ask <text> | witness ask --withdraw <id>')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const cfg = loadConfig(root)
  if (!cfg.ok) { renderRefusal(cfg.violations).forEach(ctx.err); return EXIT.REFUSED }
  if (cfg.value.warning) ctx.err(`warn: ${cfg.value.warning}`)

  if (values.withdraw !== undefined) {
    const res = withdrawAsk(ctx, root, values.withdraw, values.note)
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return exitOf(res.violations) }
    ctx.out(kv('ask', `${values.withdraw} — ${res.value.already ? 'already withdrawn' : 'withdrawn'}`))
    return EXIT.OK
  }
  const res = queueAsk(ctx, root, text)
  if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return exitOf(res.violations) }
  ctx.out(kv('ask', `${res.value.id} — ${res.value.already ? 'already queued' : 'queued'}`))
  ctx.out(kv('queue', `${res.value.unanswered} unanswered — next routes the oldest first`))
  return EXIT.OK
}
