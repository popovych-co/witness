import { EXIT, type Ctx } from '../cli.js'
import { sessionMarker } from '../drive-presence.js'
import { appendEntry, effortStreams, entryLine, journalRel } from '../journal.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v } from '../refusal.js'
import { findById, loadCanon } from '../scan.js'
import { kv } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'

// Row 207. Drive sets a target aside as stuck or capped when sessions stop moving it, and
// takes it back only when its record moves. A fix made outside witness — code, a tool, an
// account — leaves no record, so the human says so here: one entry on the target's own stream.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const id = argv[0]
  if (!id || id.startsWith('-') || argv.length > 1) {
    renderRefusal([v('usage', 'required', argv.join(' ') || 'missing target', 'witness retry <target>')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  // A session never un-sticks itself: the retry is the human's word that something changed.
  const marker = sessionMarker(ctx.env)
  if (marker !== undefined) {
    renderRefusal([v('retry', 'retry-in-session', marker, 'the human retries from their own chat or terminal')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  // A canon doc, or an effort: drive sets effort-level work aside too (a decompose owed).
  if (!findById(loadCanon(root), id) && !effortStreams(root).includes(id)) {
    renderRefusal([v('id', 'unknown-doc', id, 'a doc id from witness index, or an effort slug')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const entry = { t: 'retry' as const, artifact: id }
    const stream = journalRel(id)
    const res = withTxn(root, { op: `retry(${id})`, files: [stream], journal: { stream: id, line: entryLine(entry) } }, () => {
      appendEntry(root, id, entry)
      crashPoint(ctx.env, 'journal-append')
      return stateCommit(root, [stream], `retry(${id})`)
    })
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
    ctx.out(kv('retried', id))
    return EXIT.OK
  } finally {
    lock.value()
  }
}
