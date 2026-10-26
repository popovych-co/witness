import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig, type Config } from '../config.js'
import { PAUSE_IDLE_MAX_MS } from '../drive.js'
import { driveHolder, sessionMarker } from '../drive-presence.js'
import { primaryRoot } from '../gitio.js'
import { lastEnd, liveDrive, takeWaiter, waiterIs, type EndReason } from '../live.js'
import { needsYou, needsYouToken, type NeedYou } from '../needs-you.js'
import { renderRefusal, v } from '../refusal.js'
import { findById, loadCanon } from '../scan.js'
import { prState } from '../stamp.js'
import { duration, realClock, type Clock } from '../usage.js'
import { computeNext, driveHasWork } from './next.js'

// Row 204. The chat sleeps until something new needs the human, and is woken: on Claude Code
// this runs in the background and its exit re-invokes the chat; on Pi witness's add-on runs it
// and posts what it printed. It returns when something joins the needs-you list (an item the
// human settled never wakes the chat), when the drive it waits beside is gone with work left —
// the chat never restarts drive itself — when a merge left to the human landed on GitHub, or
// when a newer chat took over. It journals nothing, and every line it prints is rendered here:
// from the live folder only validated ids and kinds are used.
export const WAIT_POLL_MS = 5_000
export const WAIT_PR_POLL_MS = 120_000

const WHY: Record<EndReason, string> = {
  'idle-limit': `waited ${duration(PAUSE_IDLE_MAX_MS)} on you`,
  ceiling: 'spawn ceiling',
  usage: 'usage limit',
  'autonomy-off': 'autonomy is off',
  'spawn-failed': 'this machine could not start a session',
  signal: 'stopped by a signal',
  done: 'its run ended',
}

export async function waitLoop(root: string, ctx: Ctx, cfg: Config, opts: { since?: string }, clock: Clock): Promise<number> {
  const me = process.pid
  takeWaiter(root, me)                                     // one waiter per repo: the newest
  const read = () => {
    const canon = loadCanon(root)
    return { canon, items: needsYou(root, ctx, cfg, canon, liveDrive(root, canon)?.asides ?? []).filter((i) => i.notice !== true) }
  }
  let { canon, items } = read()
  const say = (head: string, rows: readonly string[]): number => {
    ctx.out(head)
    rows.forEach((l) => ctx.out(l))
    ctx.out(`token: ${needsYouToken(items)}`)
    return EXIT.OK
  }
  // The token names the list the chat last saw: anything else is news, said at once.
  if (opts.since !== undefined && needsYouToken(items) !== opts.since) {
    return say(`wait: needs you — ${items.length} item(s)`, items.flatMap((i) => i.rows))
  }
  const seen = new Set(items.map((i) => i.key))
  let prAt = clock.now()
  for (;;) {
    // Superseded for good: the engine row tells that chat never to wait again, so two chats
    // never trade the lock.
    if (!waiterIs(root, me)) { ctx.out('wait: taken over by another chat'); return EXIT.OK }
    // A 0.24.x drive writes no live file but holds the lock: running, its waits unknown.
    if (driveHolder(root) === undefined) {
      if (driveHasWork(root, ctx, canon, cfg, computeNext(root, ctx, canon, cfg))) {
        const end = lastEnd(root, canon)
        return say(`wait: drive stopped — ${end !== undefined ? WHY[end] : 'ended unexpectedly'}`, [])
      }
      if (items.length === 0) { ctx.out('wait: nothing owed'); return EXIT.OK }
    }
    const fresh: NeedYou[] = items.filter((i) => !seen.has(i.key))
    if (fresh.length > 0) return say(`wait: needs you — ${fresh.length} item(s)`, fresh.flatMap((i) => i.rows))
    for (const k of [...seen]) if (!items.some((i) => i.key === k)) seen.delete(k)    // settled: silent
    // A merge left to the human: drive stamps nothing, so the chat is told and its `next`
    // stamps it. Read-only and slow.
    if (clock.now() - prAt >= WAIT_PR_POLL_MS) {
      prAt = clock.now()
      for (const i of items.filter((x) => x.kind === 'merge')) {
        const pr = findById(canon, i.target)?.meta.pr
        if (pr !== undefined && prState(ctx, root, Number(pr)) === 'MERGED') {
          return say(`wait: merged on GitHub — ${i.target} · PR #${Number(pr)}`, [])
        }
      }
    }
    await clock.sleep(WAIT_POLL_MS)
    ;({ canon, items } = read())
  }
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  let since: string | undefined
  try {
    since = parseArgs({ args: argv, options: { since: { type: 'string' } } }).values.since
  } catch (e) {
    renderRefusal([v('usage', 'bad-flag', (e as Error).message, 'witness wait [--since <token>]')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (since !== undefined && !/^[0-9a-f]{12}$/.test(since)) {
    renderRefusal([v('--since', 'bad-token', since, 'the 12-hex token a wait: line printed')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const marker = sessionMarker(ctx.env)
  if (marker !== undefined) {
    renderRefusal([v('wait', 'wait-in-session', marker, "the human's chat")]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const cfgR = loadConfig(rootR.value)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  if (!cfgR.value.autonomy) {
    renderRefusal([v('wait', 'needs-autonomy', 'autonomy off', 'autonomy: on in witness.config.yaml')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  return waitLoop(rootR.value, ctx, cfgR.value, since !== undefined ? { since } : {}, realClock)
}
