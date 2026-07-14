import { EXIT, type Ctx } from '../cli.js'
import { guardTxn } from '../txn.js'
import { primaryRoot } from '../gitio.js'
import { findById, loadCanon } from '../scan.js'
import { effortAbandoned, latestRecap, readStream, streamExists } from '../journal.js'
import { effortWrites } from '../reviewed.js'
import { canonicalSha } from '../sha.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { kv } from '../toon.js'
import { executeAbandon, planItems, specRevertFor, type AbandonItem } from '../abandon.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const target = argv.find((a) => !a.startsWith('--'))
  if (!target) { ctx.err('usage: specflow abandon <plan-id | effort-slug>'); return EXIT.REFUSED }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const canon = loadCanon(root)
  const doc = findById(canon, target)

  if (doc && doc.meta.type === 'plan') {
    if (String(doc.meta.status) === 'abandoned') { ctx.out(kv('abandon', `${target} already abandoned`)); return EXIT.OK }
    const itemR = planItems(root, canon, doc, new Set([target]))
    if (!itemR.ok) { renderRefusal(itemR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const done = executeAbandon(root, ctx, [itemR.value], undefined, `abandon(${target})`)
    if (!done.ok) { renderRefusal(done.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('abandoned', target))
    if (itemR.value.revert) {
      ctx.out(kv('reverted', `${String(itemR.value.revert.doc.meta.id)} (${itemR.value.revert.action}) — journal untouched`))
    }
    return EXIT.OK
  }

  if (streamExists(root, target) && latestRecap(root, target)) {
    const entries = readStream(root, target)
    if (effortAbandoned(entries)) { ctx.out(kv('abandon', `${target} already abandoned`)); return EXIT.OK }
    const writes = effortWrites(root, target)
    const abandonSet = new Set(writes.keys())
    const items: AbandonItem[] = []
    const problems: Violation[] = []
    const revertedSpecs = new Set<string>()
    for (const id of writes.keys()) {
      const artifact = findById(canon, id)
      if (!artifact) continue                               // already gone (re-slice, earlier abandon)
      if (artifact.meta.type !== 'plan') continue
      const itemR = planItems(root, canon, artifact, abandonSet)
      if (!itemR.ok) { problems.push(...itemR.violations); continue }
      if (itemR.value.revert) revertedSpecs.add(String(itemR.value.revert.doc.meta.id))
      items.push(itemR.value)
    }
    for (const [id, w] of writes) {
      const artifact = findById(canon, id)
      if (!artifact || artifact.meta.type !== 'spec' || revertedSpecs.has(id)) continue
      if (canonicalSha(artifact.meta, artifact.body) !== w.sha) {
        problems.push(v('spec', 'stacked-amendment', id, 'the effort\'s write is no longer the newest'))
        continue
      }
      const revertR = specRevertFor(root, canon, artifact, w.sha, abandonSet)
      if (!revertR.ok) { problems.push(...revertR.violations); continue }
      if (revertR.value) items.push({ revert: revertR.value })
    }
    if (problems.length > 0) { renderRefusal(problems).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const done = executeAbandon(root, ctx, items, { effort: target }, `abandon(${target})`)
    if (!done.ok) { renderRefusal(done.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('abandoned', `effort ${target} — ${items.length} artifacts walked, journal remembers the attempt`))
    return EXIT.OK
  }

  renderRefusal([v('target', 'unknown-target', target, 'a plan id or an effort slug')]).forEach((l) => ctx.err(l))
  return EXIT.REFUSED
}
