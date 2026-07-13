import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { writeDoc } from '../fm.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v } from '../refusal.js'
import { findById, loadCanon } from '../scan.js'
import { kv } from '../toon.js'
import { guardTxn, withTxn } from '../txn.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { need: { type: 'string' } },
    allowPositionals: true,
  })
  const id = positionals[0]
  if (!id || !values.need) {
    renderRefusal([v('usage', 'required', 'missing id or --need', 'specflow satisfy <doc-id> --need <text | index>')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const doc = findById(loadCanon(root), id)
  if (!doc) {
    renderRefusal([v('id', 'unknown-doc', id, 'a doc id from specflow index')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const needs = Array.isArray(doc.meta.needs) ? (doc.meta.needs as Array<Record<string, unknown>>) : []
  const manuals = needs.filter((n) => typeof n.manual === 'string')
  const byIndex = /^[0-9]+$/.test(values.need) ? manuals[Number(values.need) - 1] : undefined
  const target = byIndex ?? manuals.find((n) => n.manual === values.need)
  if (!target) {
    renderRefusal([v('--need', 'unknown-manual-need', values.need, `one of: ${manuals.map((m, i) => `${i + 1}='${m.manual}'`).join(' · ') || '(no manual needs)'}`)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  if (target.satisfied === true) {
    ctx.out(kv('satisfy', `already satisfied: ${target.manual}`))
    return EXIT.OK
  }
  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    target.satisfied = true
    const res = withTxn(root, { op: `satisfy(${id})`, files: [doc.rel] }, () => {
      writeDoc(join(root, doc.rel), { meta: doc.meta, body: doc.body })
      return stateCommit(root, [doc.rel], `satisfy(${id}): ${target.manual}`)
    })
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
    ctx.out(kv('satisfied', String(target.manual)))
    return EXIT.OK
  } finally {
    lock.value()
  }
}
