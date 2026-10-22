import { EXIT, type Ctx } from '../cli.js'
import { guardTxn } from '../txn.js'
import { primaryRoot } from '../gitio.js'
import { findById, loadCanon } from '../scan.js'
import { effortAbandoned, latestRecap, readStream, streamExists } from '../journal.js'
import { effortWrites } from '../reviewed.js'
import { canonicalSha } from '../sha.js'
import { humanCall, renderRefusal, v, type Violation } from '../refusal.js'
import { kv } from '../toon.js'
import { abandonLines, executeAbandon, keepDependencies, landingEdges, planItems, returnCollisions, specRevertFor, takenBackAlready, writeAct, type AbandonItem, type SpecKeep } from '../abandon.js'

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

  // D190. Several efforts may be abandoned as one act: `abandon <effort> <effort>…`. A hold —
  // a slice kept while a sibling stands, a spec kept while another effort's plan builds on it —
  // ties one effort's abandon to another's, and abandoning them together is its way out.
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
    // The efforts a refusal names as the way out: these, and the ones whose work stands on them.
    const together = (others: string[]): string => `witness abandon ${[...new Set([...efforts, ...others])].join(' ')}`
    const writerOf = (id: string): string | undefined => {
      const d = findById(canon, id)
      return d === undefined ? undefined : writeAct(root, id, canonicalSha(d.meta, d.body))?.effort
    }
    for (const id of ids) {
      const artifact = findById(canon, id)
      if (!artifact) continue                               // already gone (re-slice, earlier abandon)
      if (artifact.meta.type !== 'plan') continue
      if (String(artifact.meta.status) === 'abandoned') continue   // D189: an earlier abandon withdrew it
      // 'stamp-only': the spec loop below is this path's sole spec revert, pinned on
      // THIS effort's write sha. A paired revert here would re-derive the owner and
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
      // D190: the act may be any effort of this one; the spec is taken back once, from it.
      const current = canonicalSha(artifact.meta, artifact.body)
      const act = writeAct(root, id, current)
      if (act === undefined || !efforts.includes(act.effort)) {
        for (const e of efforts.filter((x) => writesOf.get(x)!.has(id))) {
          const w = writesOf.get(e)!.get(id)!
          if (takenBackAlready(root, e, id, artifact.rel, w.sha)) continue
          problems.push(current === w.sha && act === undefined
            ? humanCall(v('spec', 'pin-unresolvable', id, `${e}'s journaled write of this content — the journal's history is unreadable here · a human's call`))
            : v('spec', 'stacked-amendment', id, act === undefined
              ? 'the effort\'s write is no longer the newest'
              : `the effort's write is no longer the newest — ${act.effort} wrote on top of it · abandon it first or with this one: ${together([act.effort])}`))
        }
        continue
      }
      const revertR = specRevertFor(root, canon, artifact, current, abandonSet, act, efforts)
      if (!revertR.ok) { problems.push(...revertR.violations); continue }
      const outcome = revertR.value
      if (outcome?.action === 'keep') {
        // D166. This abandon is the effort's last act, so a keep here must be one nothing has
        // to take back later: a shipped plan makes it so — canon describes built behavior. A
        // plan of another effort still building on the spec would leave it owned by no one and
        // removable by no verb, so that case refuses until the plan finishes or goes — or, D190,
        // until its effort is abandoned with this one.
        if (!outcome.shipped) {
          const others = outcome.standing.map(writerOf).filter((e): e is string => e !== undefined && !efforts.includes(e))
          problems.push(v('spec', 'still-standing', `${id}: ${outcome.standing.join(' ')}`,
            others.length > 0
              ? `those finished or withdrawn first — or abandoned with this one: ${together(others)} · this abandon is the last act that could take the spec back`
              : 'those finished or withdrawn first — this abandon is the last act that could take the spec back'))
          continue
        }
        kept.push(outcome)
      } else if (outcome) items.push({ revert: outcome })
    }
    const held = keepDependencies(items, kept)
    problems.push(...returnCollisions(root, canon, held.items), ...landingEdges(root, canon, held.items))
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
