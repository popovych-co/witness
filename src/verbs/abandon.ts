import { EXIT, type Ctx } from '../cli.js'
import { guardTxn } from '../txn.js'
import { primaryRoot } from '../gitio.js'
import { findById, loadCanon, plansOn } from '../scan.js'
import { effortAbandoned, latestRecap, readStream, streamExists } from '../journal.js'
import { effortWrites } from '../reviewed.js'
import { canonicalSha } from '../sha.js'
import { humanCall, renderRefusal, v, type Violation } from '../refusal.js'
import { kv } from '../toon.js'
import { abandonLines, executeAbandon, keepDependencies, landingEdges, planItems, returnCollisions, specRevertFor, stoodAtAbandon, takenBackAlready, writeAct, writtenOver, type AbandonItem, type SpecKeep } from '../abandon.js'

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const targets = argv.filter((a) => !a.startsWith('--'))
  const target = targets[0]
  if (!target) { ctx.err('usage: witness abandon <plan-id | effort-slug…>'); return EXIT.REFUSED }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const canon = loadCanon(root)
  const doc = findById(canon, target)
  const plans = targets.filter((t) => findById(canon, t)?.meta.type === 'plan')

  if (plans.length > 0 && targets.length > 1) {
    renderRefusal([v('target', 'one-plan', targets.join(' '), 'one plan id — several effort slugs may be abandoned as one act')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (doc && doc.meta.type === 'plan') {
    if (targets.length > 1) {
      renderRefusal([v('target', 'one-plan', targets.join(' '), 'one plan id — several effort slugs may be abandoned as one act')]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    if (String(doc.meta.status) === 'abandoned') { ctx.out(kv('abandon', `${target} already abandoned`)); return EXIT.OK }
    const itemR = planItems(root, canon, doc, new Set([target]), 'pair-parent')
    if (!itemR.ok) { renderRefusal(itemR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const taken = [...returnCollisions(root, canon, [itemR.value]), ...landingEdges(root, canon, [itemR.value])]
    if (taken.length > 0) { renderRefusal(taken).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const done = executeAbandon(root, ctx, [itemR.value], [], `abandon(${target})`)
    if (!done.ok) { renderRefusal(done.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('abandoned', target))
    abandonLines([itemR.value], []).forEach((l) => ctx.out(l))
    return EXIT.OK
  }

  // D190. Several efforts may be abandoned as one act: `abandon <effort> <effort>…` — one
  // abandon set, one transaction, each spec taken back once. Efforts whose work is tangled — two
  // amendments of one spec, a spec and another effort's plan building on it — go back together
  // instead of one command each in the one order that works.
  const isEffort = (t: string): boolean => streamExists(root, t) && latestRecap(root, t) !== undefined
  if (targets.every(isEffort)) {
    const efforts: string[] = []
    for (const t of targets) {
      if (effortAbandoned(readStream(root, t))) ctx.out(kv('abandon', `${t} already abandoned`))
      else if (!efforts.includes(t)) efforts.push(t)
    }
    if (efforts.length === 0) return EXIT.OK
    const writesOf = new Map(efforts.map((e) => [e, effortWrites(root, e)] as const))
    const ids = [...new Set([...writesOf.values()].flatMap((w) => [...w.keys()]))]
    const abandonSet = new Set(ids)
    const items: AbandonItem[] = []
    const problems: Violation[] = []
    const kept: SpecKeep[] = []
    for (const id of ids) {
      const artifact = findById(canon, id)
      if (!artifact) continue                               // already gone (re-slice, earlier abandon)
      if (artifact.meta.type !== 'plan') continue
      if (String(artifact.meta.status) === 'abandoned') continue   // D189: an earlier abandon withdrew it
      // 'stamp-only': the spec loop below is this path's sole spec revert, from the write
      // that is the spec's content. A paired revert here would re-derive the owner and
      // could land on a sibling effort's amendment — see Pairing in abandon.ts.
      const itemR = planItems(root, canon, artifact, abandonSet, 'stamp-only')
      if (!itemR.ok) { problems.push(...itemR.violations); continue }
      items.push(itemR.value)
    }
    for (const id of ids) {
      const artifact = findById(canon, id)
      if (!artifact || artifact.meta.type !== 'spec') continue
      // D168. An effort's write is what this abandon takes back only while it is the act the
      // spec's content is — the same bytes written again later are the later effort's. A write
      // an earlier abandon already took back (`abandon <plan>`) leaves nothing here to take.
      // D190: the act may be any of the efforts being abandoned; the spec is taken back once,
      // from it — and only when every listed effort's write of it lies in that one take-back.
      const current = canonicalSha(artifact.meta, artifact.body)
      const act = writeAct(root, id, current)
      const writers = efforts.filter((x) => writesOf.get(x)!.has(id))
      if (act === undefined || !efforts.includes(act.effort)) {
        // D190 (review). Content that stands for good — shipped by a plan, or left standing by
        // its own effort's abandon — is canon of record: a write under it has nothing of its own
        // left to take back, where it refused a stacked amendment no abandon could clear.
        const shippedOn = plansOn(canon, id, { exclude: abandonSet, pin: current }).filter((p) => String(p.meta.status) === 'done')
        const recorded = act !== undefined && effortAbandoned(readStream(root, act.effort)) && stoodAtAbandon(root, act.effort, artifact.rel, current)
        if (shippedOn.length > 0 || recorded) {
          kept.push({ doc: artifact, action: 'keep', shipped: true, standing: shippedOn.length > 0 ? shippedOn.map((p) => String(p.meta.id)) : [act!.effort] })
          continue
        }
        for (const e of writers) {
          const w = writesOf.get(e)!.get(id)!
          if (takenBackAlready(root, e, id, artifact.rel, w.sha)) continue
          problems.push(current === w.sha && act === undefined
            ? humanCall(v('spec', 'pin-unresolvable', `${id} — ${e}'s write`, `${e}'s journaled write of this content — the journal's history is unreadable here · a human's call`))
            : v('spec', 'stacked-amendment', `${id} — ${e}'s write`,
              `abandon newest-first — the effort's write is no longer the newest${act === undefined ? '' : ` · ${act.effort} wrote on top of it`}`))
        }
        continue
      }
      // A listed effort's write under another effort's standing write is not in this take-back:
      // the walk stops at that other write, and the listed effort would end abandoned with its
      // write still in canon.
      const buried = writers.filter((e) => e !== act.effort).flatMap((e) => {
        const over = writtenOver(root, id, artifact.rel, e, efforts)
        return over === undefined ? [] : [v('spec', 'stacked-amendment', `${id} — ${e}'s write`,
          `abandon newest-first — the effort's write is no longer the newest · ${over} wrote on top of it`)]
      })
      if (buried.length > 0) { problems.push(...buried); continue }
      const revertR = specRevertFor(root, canon, artifact, current, abandonSet, act, efforts)
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
    const held = keepDependencies(items, kept)
    problems.push(...returnCollisions(root, canon, held.items), ...landingEdges(root, canon, held.items, abandonSet))
    if (problems.length > 0) { renderRefusal(problems).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const done = executeAbandon(root, ctx, held.items, efforts, `abandon(${efforts.join(' ')})`)
    if (!done.ok) { renderRefusal(done.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('abandoned', `${efforts.length === 1 ? 'effort' : 'efforts'} ${efforts.join(' · ')} — ${held.items.length} artifacts walked · journal remembers the attempt`))
    abandonLines(held.items, held.kept).forEach((l) => ctx.out(l))
    return EXIT.OK
  }

  const unknown = targets.length === 1 ? targets : targets.filter((t) => !isEffort(t))
  renderRefusal(unknown.map((t) => v('target', 'unknown-target', t, targets.length === 1 ? 'a plan id or an effort slug' : 'an effort slug — several are abandoned as one act'))).forEach((l) => ctx.err(l))
  return EXIT.REFUSED
}
