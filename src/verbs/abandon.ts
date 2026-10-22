import { EXIT, type Ctx } from '../cli.js'
import { guardTxn } from '../txn.js'
import { primaryRoot } from '../gitio.js'
import { findById, loadCanon } from '../scan.js'
import { effortAbandoned, latestRecap, readStream, streamExists } from '../journal.js'
import { effortWrites } from '../reviewed.js'
import { canonicalSha } from '../sha.js'
import { humanCall, renderRefusal, v, type Violation } from '../refusal.js'
import { kv } from '../toon.js'
import { abandonLines, effortWrite, executeAbandon, landingEdges, planItems, renamedSince, returnCollisions, specRevertFor, takenBackAlready, writeAct, type AbandonItem, type SpecKeep } from '../abandon.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const target = argv.find((a) => !a.startsWith('--'))
  if (!target) { ctx.err('usage: witness abandon <plan-id | effort-slug>'); return EXIT.REFUSED }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const canon = loadCanon(root)
  const doc = findById(canon, target)

  if (doc && doc.meta.type === 'plan') {
    if (String(doc.meta.status) === 'abandoned') { ctx.out(kv('abandon', `${target} already abandoned`)); return EXIT.OK }
    const itemR = planItems(root, canon, doc, new Set([target]), 'pair-parent')
    if (!itemR.ok) { renderRefusal(itemR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const taken = [...returnCollisions(root, canon, [itemR.value]), ...landingEdges(root, canon, [itemR.value])]
    if (taken.length > 0) { renderRefusal(taken).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const done = executeAbandon(root, ctx, [itemR.value], undefined, `abandon(${target})`)
    if (!done.ok) { renderRefusal(done.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('abandoned', target))
    abandonLines([itemR.value], []).forEach((l) => ctx.out(l))
    return EXIT.OK
  }

  if (streamExists(root, target) && latestRecap(root, target)) {
    const entries = readStream(root, target)
    if (effortAbandoned(entries)) { ctx.out(kv('abandon', `${target} already abandoned`)); return EXIT.OK }
    const writes = effortWrites(root, target)
    const abandonSet = new Set(writes.keys())
    const items: AbandonItem[] = []
    const problems: Violation[] = []
    const kept: SpecKeep[] = []
    // D188. A doc this effort wrote that canon no longer holds under that id either left (a
    // re-slice, an earlier abandon) or was renamed — and a rename is the one that would walk
    // nothing and say so as if done.
    for (const [id, w] of writes) {
      if (findById(canon, id)) continue
      const at = effortWrite(root, target, id, w.sha)
      const renamed = at === undefined ? undefined : renamedSince(root, at.commit, id, undefined, target)
      if (renamed) problems.push(renamed)
    }
    for (const id of writes.keys()) {
      const artifact = findById(canon, id)
      if (!artifact) continue                               // already gone (re-slice, earlier abandon)
      if (artifact.meta.type !== 'plan') continue
      // 'stamp-only': the spec loop below is this path's sole spec revert, pinned on
      // THIS effort's write sha. A paired revert here would re-derive the owner and
      // could land on a sibling effort's amendment — see Pairing in abandon.ts.
      const itemR = planItems(root, canon, artifact, abandonSet, 'stamp-only')
      if (!itemR.ok) { problems.push(...itemR.violations); continue }
      items.push(itemR.value)
    }
    for (const [id, w] of writes) {
      const artifact = findById(canon, id)
      if (!artifact || artifact.meta.type !== 'spec') continue
      // D168. The effort's write is what this abandon takes back only while it is the act the
      // spec's content is — the same bytes written again later are the later effort's. A write
      // an earlier abandon already took back (`abandon <plan>`) leaves nothing here to take.
      const current = canonicalSha(artifact.meta, artifact.body)
      const act = writeAct(root, id, current)
      if (current !== w.sha || act?.effort !== target) {
        if (takenBackAlready(root, target, id, artifact.rel, w.sha)) continue
        // D188. Content no write made, on a path a rename rewrote after this effort's write: the
        // rename made it. A later write on top is a real stacking, refused as one.
        const at = act === undefined ? effortWrite(root, target, id, w.sha) : undefined
        const renamed = at === undefined ? undefined : renamedSince(root, at.commit, id, artifact.rel, target)
        if (renamed) { problems.push(renamed); continue }
        problems.push(current === w.sha && act === undefined
          ? humanCall(v('spec', 'pin-unresolvable', id, `${target}'s journaled write of this content — the journal's history is unreadable here · a human's call`))
          : v('spec', 'stacked-amendment', id, 'the effort\'s write is no longer the newest'))
        continue
      }
      const revertR = specRevertFor(root, canon, artifact, w.sha, abandonSet, act, target)
      if (!revertR.ok) { problems.push(...revertR.violations); continue }
      const outcome = revertR.value
      if (outcome?.action === 'keep') {
        // D166. This abandon is the effort's last act, so a keep here must be one nothing has
        // to take back later: a shipped plan makes it so — canon describes built behavior. A
        // plan of another effort still building on the spec would leave it owned by no one and
        // removable by no verb, so that case refuses until the plan finishes or goes.
        if (!outcome.shipped) {
          problems.push(v('spec', 'still-standing', `${id}: ${outcome.standing.join(' ')}`,
            'those finished or withdrawn first — this abandon is the last act that could take the spec back'))
          continue
        }
        kept.push(outcome)
      } else if (outcome) items.push({ revert: outcome })
    }
    problems.push(...returnCollisions(root, canon, items), ...landingEdges(root, canon, items))
    if (problems.length > 0) { renderRefusal(problems).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const done = executeAbandon(root, ctx, items, { effort: target }, `abandon(${target})`)
    if (!done.ok) { renderRefusal(done.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('abandoned', `effort ${target} — ${items.length} artifacts walked · journal remembers the attempt`))
    abandonLines(items, kept).forEach((l) => ctx.out(l))
    return EXIT.OK
  }

  renderRefusal([v('target', 'unknown-target', target, 'a plan id or an effort slug')]).forEach((l) => ctx.err(l))
  return EXIT.REFUSED
}
