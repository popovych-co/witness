import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { DISMISS_CAUSES, openDeferrals, type DismissCause } from '../deferral.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, entryLine, journalRel, readStream, streamExists } from '../journal.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'
import { guardTxn, withTxn } from '../txn.js'

// D122. A SEPARATE verb, not a `decide` flag: an obligation outlives its gate — it is
// re-booked onto the parent spec when the flow completes — and `decide <gate> <target>`
// cannot address a debt whose gate is finished and whose target is `done`. Shaped on
// `witness satisfy`: id, ordinal-or-name, a required reason, one transaction.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { deferral: { type: 'string' }, cause: { type: 'string' }, note: { type: 'string' } },
    allowPositionals: true,
  })
  const artifact = positionals[0]
  if (!artifact || !values.deferral) {
    ctx.err('usage: witness dismiss <artifact> --deferral <id|index> --cause <superseded|lens-retired|judged-wrong> --note "<why>"')
    return EXIT.REFUSED
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  if (!streamExists(root, artifact)) {
    renderRefusal([v('artifact', 'unknown-stream', artifact, 'an id with a journal stream')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const entries = readStream(root, artifact)
  const open = openDeferrals(entries)
  const byIndex = /^[0-9]+$/.test(values.deferral) ? open[Number(values.deferral) - 1] : undefined
  const target = byIndex ?? open.find((d) => d.id === values.deferral)
  if (!target) {
    // `already-dismissed` is named separately from `unknown-deferral` and
    // `already-discharged` because they call for different next acts, and because a
    // discharge is the GOOD outcome — reporting it as "unknown" would hide a success.
    const everMinted = entries.some((e) => e.t === 'deferral' && e.id === values.deferral)
    const dismissed = entries.some((e) => e.t === 'deferral-dismissed' && e.id === values.deferral)
    const discharged = entries.some((e) => e.t === 'deferral-discharged' && e.id === values.deferral)
    const rule = dismissed ? 'already-dismissed' : discharged ? 'already-discharged' : 'unknown-deferral'
    renderRefusal([v('--deferral', rule, values.deferral,
      everMinted
        ? 'an obligation still open on this artifact — witness status lists them'
        : `one of: ${open.map((d, i) => `${i + 1}=${d.id}`).join(' · ') || '(none open)'}`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (!values.cause || !DISMISS_CAUSES.includes(values.cause as DismissCause)) {
    renderRefusal([v('--cause', 'cause-required', values.cause ?? '(none)', DISMISS_CAUSES.join(' | '))])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (!values.note || values.note.trim() === '') {
    renderRefusal([v('--note', 'note-required', '(empty)',
      'why no battery can close this one — the cause names the class, the note names the case')])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const entry = {
    v: 1 as const, t: 'deferral-dismissed' as const, id: target.id, artifact,
    cause: values.cause, note: values.note.trim(),
  }
  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    const txn = withTxn(root, {
      op: `dismiss(${artifact})`, files: [journalRel(artifact)],
      journalMulti: [{ stream: artifact, line: entryLine(entry) }],
    }, () => {
      appendEntry(root, artifact, entry)
      return stateCommit(root, [journalRel(artifact)], `dismiss(${artifact}): ${target.id} ${values.cause}`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  } finally {
    lockR.value()
  }
  ctx.out(kv('dismissed', `${artifact} ${target.id} — ${values.cause}`))
  ctx.out(kv('note', 'evidence never closed this one; the journal records that'))
  return EXIT.OK
}
