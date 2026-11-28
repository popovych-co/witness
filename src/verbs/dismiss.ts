import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { DISMISS_CAUSES, openDeferrals, type DismissCause } from '../deferral.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, entryLine, journalRel, readStream, streamExists } from '../journal.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v } from '../refusal.js'
import { kv, logSafe, shellWord, visible } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'
import { sessionMarker } from '../drive-presence.js'
import { LEDGER_CAUSES, bookedWhere, ledgerItems, ledgerTaken, type LedgerCause, type LedgerDismissed, type LedgerItem } from '../ledger.js'
import { LEDGER_STREAM } from '../streams.js'


// D122. A SEPARATE verb, not a `decide` flag: an obligation outlives its gate — it is
// re-booked onto the parent spec when the flow completes — and `decide <gate> <target>`
// cannot address a debt whose gate is finished and whose target is `done`. Shaped on
// `witness satisfy`: id, ordinal-or-name, a required reason, one transaction.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { deferral: { type: 'string' }, item: { type: 'string' }, cause: { type: 'string' }, note: { type: 'string' } },
    allowPositionals: true,
  })
  const artifact = positionals[0]
  // Row 269 (C22). The repo ledger's form: row 122's verb with the reserved stream as its artifact.
  if (artifact === LEDGER_STREAM && values.item !== undefined && values.deferral === undefined) {
    return dismissLedger(ctx, values.item, values.cause, values.note)
  }
  if (!artifact || !values.deferral) {
    ctx.err('usage: witness dismiss <artifact> --deferral <id|index> --cause <superseded|lens-retired|judged-wrong> --note "<why>" | witness dismiss ledger --item <id|index> --cause <rule-retired|declined|judged-wrong> --note "<why>"')
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

// Row 269 (§3.3 "a human, at a terminal"; the map's C22). A ledger item a human ends: never inside a
// session (any marker), only at a terminal, after a y naming the item. The ledger is read again under
// the lock, so an item a merge closed meanwhile is refused `already-closed` — the good outcome, named
// apart. A dismissed item waives nothing from the next lint run on.
async function dismissLedger(ctx: Ctx, which: string, cause: string | undefined, note: string | undefined): Promise<number> {
  const refuse = (field: string, rule: string, got: string, want: string): number => {
    renderRefusal([v(field, rule, got, want)]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  // The act to paste, the item through the quoter; the cause slot is witness's own list (LEDGER_CAUSES).
  const typed = `witness dismiss ledger --item ${shellWord(which)} --cause <rule-retired|declined|judged-wrong> --note "<why>"`
  const marker = sessionMarker(ctx.env)
  if (marker !== undefined) return refuse('dismiss', 'dismiss-in-session', `${marker} is set`, `the human, at their own terminal — ${typed}`)
  if (!ctx.isTTY) return refuse('dismiss', 'dismiss-needs-terminal', 'no terminal', `the human, at their own terminal — ${typed}`)
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const taken = ledgerTaken(root)
  if (taken !== undefined) { renderRefusal([taken]).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const pick = (items: LedgerItem[]): LedgerItem | undefined => {
    const open = items.filter((i) => i.state === 'open')
    return /^[0-9]+$/.test(which) ? open[Number(which) - 1] : items.find((i) => i.id === which)
  }
  const ended = (item: LedgerItem | undefined): number | undefined => {
    if (item === undefined) {
      const open = ledgerItems(root).filter((i) => i.state === 'open')
      return refuse('--item', 'unknown-item', visible(which), `one of: ${open.map((i, n) => `${n + 1}=${visible(i.id)}`).join(' · ') || '(none open)'} — witness status lists them`)
    }
    if (item.state === 'closed') return refuse('--item', 'already-closed', visible(item.id), 'nothing — main no longer holds what it booked, and witness closed it')
    if (item.state === 'dismissed') return refuse('--item', 'already-dismissed', visible(item.id), 'nothing — a human ended it already')
    return undefined
  }
  const target = pick(ledgerItems(root))
  const stop = ended(target)
  if (stop !== undefined) return stop
  if (cause === undefined || !LEDGER_CAUSES.includes(cause as LedgerCause)) {
    return refuse('--cause', 'cause-required', cause === undefined ? '(none)' : visible(cause), LEDGER_CAUSES.join(' | '))
  }
  if (note === undefined || note.trim() === '') {
    return refuse('--note', 'note-required', '(empty)', 'why the item ends without the observation that closes it — the cause names the class, the note names the case')
  }
  const item = target!
  // Row 274: a switch-off item is named by its token in its file; it stops waiving at the next gate run.
  // Row 276: a booked loss is named by its spec's tests, and stops waiving from the next gate run too.
  // Row 278: a loosened item is named by its hidden rule or its part. Row 284: a tolerated set by its tool and rule.
  const question = item.kind === 'booked-switch-off' || item.kind === 'booked-dropped' || item.kind === 'booked-loosened' || item.kind === 'tolerated-set'
    ? `dismiss ${visible(item.id)} — ${visible(item.check)} · ${bookedWhere(item)} · ${visible(item.plan)}: ${cause}\ndismiss? the booking stops waiving from the next gate run [y/N]`
    : `dismiss ${visible(item.id)} — ${visible(item.check)} · ${visible(item.part)} · ${visible(item.plan)} · ${
      'whole' in item.subject ? 'the whole part' : `${Object.values(item.subject.diagnostics).reduce((a, n) => a + n, 0)} diagnostics`}: ${cause}\ndismiss? the booking stops waiving from the next lint run [y/N]`
  const answer = (await ctx.ask(question)).trim()
  if (answer.toLowerCase() !== 'y') return refuse('dismiss', 'dismiss-declined', `answered ${answer === '' ? '(nothing)' : visible(answer)}`, `y — nothing was dismissed; ${typed} asks again`)
  const entry: LedgerDismissed = { v: 1, t: 'ledger-dismissed', id: item.id, cause: cause as LedgerCause, note: note.trim() }
  const asLine = entry as unknown as { t: 'ledger-dismissed'; [k: string]: unknown }
  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    // Under the lock: a merge or another dismissal may have ended the item since it was read.
    const again = ended(ledgerItems(root).find((i) => i.id === item.id))
    if (again !== undefined) return again
    const rel = journalRel(LEDGER_STREAM)
    const txn = withTxn(root, { op: 'dismiss(ledger)', files: [rel], journalMulti: [{ stream: LEDGER_STREAM, line: entryLine(asLine) }] }, () => {
      appendEntry(root, LEDGER_STREAM, asLine)
      crashPoint(ctx.env, 'dismiss-journal')
      return stateCommit(root, [rel], `dismiss(ledger): ${item.id} ${cause}`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  } finally {
    lockR.value()
  }
  ctx.out(kv('dismissed', `${visible(item.id)} — ${cause}`))
  ctx.out(kv('note', logSafe(note.trim())))
  return EXIT.OK
}
