import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { appendEntry, entryLine, journalRel } from '../journal.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { acquireLock } from '../lock.js'
import { needKey, needMet } from '../needs.js'
import { renderRefusal, v } from '../refusal.js'
import { findById, loadCanon } from '../scan.js'
import { kv } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { need: { type: 'string' } },
    allowPositionals: true,
  })
  const id = positionals[0]
  if (!id || !values.need) {
    renderRefusal([v('usage', 'required', 'missing id or --need', 'witness satisfy <doc-id> --need <id | index | text>')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const doc = findById(loadCanon(root), id)
  if (!doc) {
    renderRefusal([v('id', 'unknown-doc', id, 'a doc id from witness index')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const needs = Array.isArray(doc.meta.needs) ? (doc.meta.needs as Array<Record<string, unknown>>) : []
  const manuals = needs.filter((n) => typeof n.manual === 'string')
  // Row 179. An id first — it is what a held criterion and `status` name the need by — then the
  // 1-based index among the doc's manual needs, then the manual text.
  const byId = manuals.find((n) => n.id === values.need)
  const byIndex = /^[0-9]+$/.test(values.need) ? manuals[Number(values.need) - 1] : undefined
  const target = byId ?? byIndex ?? manuals.find((n) => n.manual === values.need)
  if (!target) {
    const listed = manuals.map((m, i) => (typeof m.id === 'string' ? `${i + 1}=${m.id}` : `${i + 1}='${m.manual}'`))
    renderRefusal([v('--need', 'unknown-manual-need', values.need, `one of: ${listed.join(' · ') || '(no manual needs)'}`)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const need = target as { id?: string; manual: string; satisfied?: boolean }
  if (needMet(doc, need)) {
    ctx.out(kv('satisfy', `already satisfied: ${need.manual}`))
    return EXIT.OK
  }
  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    // Row 179. Journaled on the doc's own stream, never written into the spec: the content
    // sha does not move, so no plan re-queues and no approved look re-arms.
    const entry = { t: 'need-satisfied' as const, artifact: id, need: needKey(need) }
    const stream = journalRel(id)
    const res = withTxn(root, { op: `satisfy(${id})`, files: [stream], journal: { stream: id, line: entryLine(entry) } }, () => {
      appendEntry(root, id, entry)
      crashPoint(ctx.env, 'journal-append')
      return stateCommit(root, [stream], `satisfy(${id}): ${needKey(need)}`)
    })
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
    ctx.out(kv('satisfied', String(target.manual)))
    return EXIT.OK
  } finally {
    lock.value()
  }
}
