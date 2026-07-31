import { join } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { ID_RE } from '../dsl.js'
import { writeDoc } from '../fm.js'
import { guardTxn, withTxn } from '../txn.js'
import { acquireLock } from '../lock.js'
import { journalRel, streamExists } from '../journal.js'
import { git, primaryRoot, stateCommit } from '../gitio.js'
import { findById, loadCanon, type CanonDoc } from '../scan.js'
import { criteriaExcludes } from '../runner.js'
import { sourceTags } from '../matcher.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'

function rewriteRefs(meta: Record<string, unknown>, oldId: string, newId: string): Record<string, unknown> {
  const out = { ...meta }
  if (Array.isArray(out.depends)) out.depends = out.depends.map((d) => (d === oldId ? newId : d))
  if (out.parent === oldId) out.parent = newId
  if (out.supersedes === oldId) out.supersedes = newId
  return out
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const [oldId, newId] = argv.filter((a) => !a.startsWith('--'))
  if (!oldId || !newId) { ctx.err('usage: witness rename <old-id> <new-id>'); return EXIT.REFUSED }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const canon = loadCanon(root)
  const doc = findById(canon, oldId)
  if (!doc) {
    renderRefusal([v('id', 'unknown-id', oldId, 'an existing canon doc')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (!ID_RE.test(newId)) {
    renderRefusal([v('id', 'id-charset', newId, 'ids match ^[a-z0-9-]+$')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (findById(canon, newId) || streamExists(root, newId)) {
    renderRefusal([v('id', 'id-taken', newId, 'an unused id (canon and journal)')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  const touched: CanonDoc[] = []
  const selfMeta = rewriteRefs({ ...doc.meta, id: newId }, oldId, newId)
  if (Array.isArray(selfMeta.criteria)) {
    selfMeta.criteria = (selfMeta.criteria as Array<Record<string, unknown>>).map((c) =>
      c.test === `@spec:${oldId}` ? { ...c, test: `@spec:${newId}` } : c)
  }
  const others = canon.docs.filter((d) => d !== doc).filter((d) => {
    const deps = (d.meta.depends ?? []) as string[]
    return deps.includes(oldId) || d.meta.parent === oldId || d.meta.supersedes === oldId
  })

  const files = [doc.rel, ...others.map((d) => d.rel)]
  const hadStream = streamExists(root, oldId)
  if (hadStream) files.push(journalRel(oldId), journalRel(newId))

  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    const txn = withTxn(root, { op: 'rename', files }, () => {
      writeDoc(join(root, doc.rel), { meta: selfMeta, body: doc.body })
      for (const d of others) {
        writeDoc(join(root, d.rel), { meta: rewriteRefs(d.meta, oldId, newId), body: d.body })
        touched.push(d)
      }
      if (hadStream) git(root, 'mv', journalRel(oldId), journalRel(newId))
      return stateCommit(root, files, `rename(${oldId} → ${newId})`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  } finally {
    lockR.value()
  }

  ctx.out(kv('renamed', `${oldId} → ${newId} (${touched.length} referencing docs rewritten, journal moved)`))
  const cfgR = loadConfig(root)
  const excludes = cfgR.ok ? criteriaExcludes(cfgR.value) : []
  const stale = sourceTags(root, excludes).counts.get(oldId) ?? 0
  if (stale > 0) {
    ctx.out(kv('warning', `${stale} source tag${stale === 1 ? '' : 's'} still reference @spec:${oldId} — update the tests (the CLI never edits code)`))
  }
  return EXIT.OK
}
