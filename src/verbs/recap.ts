import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { ASK_STREAM, RECAP_CHECK_BOUND, askQueue, checkReason, reservedId } from '../ask.js'
import { loadConfig } from '../config.js'
import { ID_RE } from '../dsl.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, effortAbandoned, entryLine, journalRel, latestRecap, readStream, streamExists } from '../journal.js'
import { acquireLock } from '../lock.js'
import { checkRecap, recapCheckEntry, type RecapVerdict } from '../recap-check.js'
import { humanCall, renderRefusal, v, type Violation } from '../refusal.js'
import { loadCanon } from '../scan.js'
import { kv } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'

export interface RecapInput {
  effort: string
  class: 'feature' | 'fix' | 'chore'
  goals: Array<{ id: string; text: string }>
  non_goals: Array<{ id: string; text: string }>
  constraints: Array<{ id: string; text: string }>
  slices: string[]
  // Row 176. Set from --ask only, never from the file: the ask a recap answers is the CLI's
  // record of what the human asked, so a recap cannot name its own.
  ask?: string
}

function idTextList(raw: unknown, field: string, prefix: string, required: boolean): Violation[] {
  if (raw === undefined) return required ? [v(field, 'required', 'absent', `>=1 {id, text} with ids ${prefix}1..`)] : []
  if (!Array.isArray(raw)) return [v(field, 'shape', typeof raw, 'list of {id, text}')]
  if (required && raw.length === 0) return [v(field, 'required', 'empty', `>=1 {id, text} with ids ${prefix}1..`)]
  const out: Violation[] = []
  const seen = new Set<string>()
  raw.forEach((item, i) => {
    const at = `${field}[${i}]`
    const e = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    if (typeof e.id !== 'string' || !new RegExp(`^${prefix}[0-9]+$`).test(e.id)) {
      out.push(v(`${at}.id`, 'id-prefix', String(e.id ?? 'absent'), `${prefix}<number>`))
    } else if (seen.has(e.id)) {
      out.push(v(`${at}.id`, 'id-unique', e.id, `unique within ${field}`))
    } else {
      seen.add(e.id)
    }
    if (typeof e.text !== 'string' || e.text.trim() === '') {
      out.push(v(`${at}.text`, 'required', String(e.text ?? 'absent'), 'non-empty text'))
    }
  })
  return out
}

export function validateRecap(raw: unknown): Violation[] {
  if (typeof raw !== 'object' || raw === null) return [v('recap', 'shape', String(raw), 'JSON object')]
  const e = raw as Record<string, unknown>
  const out: Violation[] = []
  if (typeof e.effort !== 'string' || !ID_RE.test(e.effort)) {
    out.push(v('effort', 'id-charset', String(e.effort ?? 'absent'), '[a-z0-9-]+'))
  }
  if (e.class !== 'feature' && e.class !== 'fix' && e.class !== 'chore') {
    out.push(v('class', 'enum', String(e.class ?? 'absent'), 'feature | fix | chore'))
  }
  out.push(...idTextList(e.goals, 'goals', 'g', true))
  out.push(...idTextList(e.non_goals, 'non_goals', 'n', false))
  out.push(...idTextList(e.constraints, 'constraints', 'c', false))
  if (e.slices !== undefined && (!Array.isArray(e.slices) || e.slices.some((s) => typeof s !== 'string' || s === ''))) {
    out.push(v('slices', 'shape', JSON.stringify(e.slices), 'list of non-empty strings (non-binding)'))
  }
  return out
}

// Whether this ask may be answered by a new effort, read from one queue derivation.
function askRefusal(root: string, id: string): Violation | undefined {
  const ask = askQueue(root).find((a) => a.id === id)
  if (!ask) return v('--ask', 'unknown-ask', id, 'an ask id — witness status lists the queue')
  if (ask.state === 'answered') return v('--ask', 'ask-answered', `${id} is answered by ${ask.effort}`, 'an unanswered ask — one ask births one effort')
  if (ask.state === 'withdrawn') return v('--ask', 'ask-withdrawn', id, 'an unanswered ask — this one was withdrawn')
  return undefined
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { file: { type: 'string' }, amend: { type: 'boolean' }, ask: { type: 'string' }, manual: { type: 'boolean' } } })
  if (!values.file) {
    renderRefusal([v('--file', 'required', 'absent', 'path to a recap JSON file')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const cfg = loadConfig(root)
  if (!cfg.ok) { renderRefusal(cfg.violations).forEach(ctx.err); return EXIT.REFUSED }
  if (cfg.value.warning) ctx.err(`warn: ${cfg.value.warning}`)

  let parsed: unknown
  try {
    // resolve, not join: an absolute --file must be honored as-is (join would
    // glue it under cwd — /repo + /tmp/x → /repo/tmp/x)
    parsed = JSON.parse(readFileSync(resolve(ctx.cwd, values.file), 'utf8'))
  } catch (e) {
    renderRefusal([v('--file', 'input-json', String((e as Error).message).slice(0, 120), 'readable JSON file')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const violations = validateRecap(parsed)
  if (violations.length) { renderRefusal(violations).forEach(ctx.err); return EXIT.REFUSED }
  const recap = parsed as RecapInput
  recap.non_goals ??= []
  recap.constraints ??= []
  recap.slices ??= []
  delete recap.ask
  if (values.ask !== undefined) recap.ask = values.ask

  // Row 176. Before slug-reuse and for --amend too: a reserved stream is refused whether or not
  // it exists yet, and an amend would append a recap to witness's own history.
  const reserved = reservedId(recap.effort)
  if (reserved !== undefined) {
    renderRefusal([v('effort', 'id-taken', recap.effort, `a new id — ${recap.effort} is ${reserved}`)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const exists = streamExists(root, recap.effort)
  if (!values.amend && exists) {
    renderRefusal([v('effort', 'slug-reuse', `journal stream '${recap.effort}' exists (active or terminal)`, 'a new slug — histories never merge')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  if (values.amend && !exists) {
    renderRefusal([v('effort', 'unknown-effort', recap.effort, 'an existing effort stream to amend')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  if (values.amend && effortAbandoned(readStream(root, recap.effort))) {
    renderRefusal([v('effort', 'terminal', 'effort was abandoned', 'amend only live efforts')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  // Row 176. One ask births one effort: an amend re-scopes an effort an ask already birthed.
  if (recap.ask !== undefined) {
    if (values.amend) {
      renderRefusal([v('--ask', 'ask-amend', 'with --amend', 'an ask births its own effort — drop --amend')]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    const refusal = askRefusal(root, recap.ask)
    if (refusal) { renderRefusal([refusal]).forEach(ctx.err); return EXIT.REFUSED }
  }

  // Row 177. Under autonomy nobody confirms a recap, so the arbiter checks it against its ask
  // before the effort is born. `--manual` is the claim that a human confirmed it, so each of
  // these refusals is a human's decision: the skills never pass it on their own.
  const autonomous = cfg.value.autonomy && !values.manual
  if (autonomous) {
    const refusal = autonomyRefusal(root, recap, values.amend === true)
    if (refusal) { renderRefusal([refusal]).forEach(ctx.err); return EXIT.REFUSED }
  }
  // Judged BEFORE the lock, as gate reviewers are (D76): a model call must never hold every
  // other writer out. A refusal here journals nothing, so `next` routes the ask again.
  let verdict: RecapVerdict | undefined
  if (autonomous && recap.ask !== undefined) {
    const ask = askQueue(root).find((a) => a.id === recap.ask)!
    const r = await checkRecap(ctx, root, cfg.value, loadCanon(root), { ask, recap })
    if (!r.ok) { renderRefusal(r.violations).forEach(ctx.err); return EXIT.REFUSED }
    verdict = r.value
  }

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    // Read again under the lock: a concurrent recap may have answered (or checked) the ask
    // while this one was judged.
    if (recap.ask !== undefined) {
      const refusal = askRefusal(root, recap.ask) ?? (autonomous ? autonomyRefusal(root, recap, false) : undefined)
      if (refusal) { renderRefusal([refusal]).forEach(ctx.err); return EXIT.REFUSED }
    }
    const round = (askQueue(root).find((a) => a.id === recap.ask)?.checks ?? 0) + 1
    const check = verdict !== undefined ? recapCheckEntry(recap.ask!, round, recap, verdict) : undefined
    if (verdict !== undefined && !(verdict.kind === 'judged' && verdict.accepted)) {
      return sentBack(ctx, root, recap.ask!, round, check!, verdict)
    }

    const entry = {
      t: 'recap' as const, effort: recap.effort, class: recap.class,
      goals: recap.goals, non_goals: recap.non_goals, constraints: recap.constraints, slices: recap.slices,
      ...(recap.ask !== undefined ? { ask: recap.ask } : {}),
    }
    // entryLine, never a second inline JSON.stringify — completeTxn re-appends when this
    // marker line differs from what appendEntry wrote, so the two must be one derivation.
    const line = entryLine(entry)
    const stream = journalRel(recap.effort)
    // An accepted check and the recap it accepted land in one transaction, in append order:
    // an effort whose check is missing, or a check whose effort is, is never a state.
    const marker = check !== undefined
      ? { op: `recap(${recap.effort})`, files: [journalRel(ASK_STREAM), stream],
          journalMulti: [{ stream: ASK_STREAM, line: entryLine(check) }, { stream: recap.effort, line }] }
      : { op: `recap(${recap.effort})`, files: [stream], journal: { stream: recap.effort, line } }
    const res = withTxn(root, marker, () => {
      if (check !== undefined) appendEntry(root, ASK_STREAM, check)
      appendEntry(root, recap.effort, entry)
      crashPoint(ctx.env, 'journal-append')
      return stateCommit(root, marker.files, `recap(${recap.effort})${values.amend ? ' --amend' : ''}: ${recap.class}${recap.ask !== undefined ? ` · ask ${recap.ask}` : ''}`)
    })
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
    ctx.out(kv('effort', recap.effort))
    ctx.out(kv('class', recap.class))
    ctx.out(kv('goals', recap.goals.length))
    if (recap.ask !== undefined) ctx.out(kv('ask', `${recap.ask} — answered`))
    if (check !== undefined) {
      ctx.out(kv('recap-check', `accepted — check ${round} of ${RECAP_CHECK_BOUND}`))
      ctx.out(kv('reason', check.reason))
    }
    if (values.amend) ctx.out(kv('amended', 'latest recap wins; coverage re-validates against it'))
    ctx.out(`next: witness write --effort ${recap.effort} --meta <m.json> --body <b.md> <spec-id>`)
    return EXIT.OK
  } finally {
    lock.value()
  }
}

// The refusals only autonomy adds. A new effort answers a queued ask; a parked ask waits for
// the human; and an amendment keeps the class the effort carries, because an amendment is not
// re-checked — a class flipped to fix or chore would skip the design stage the check guards.
function autonomyRefusal(root: string, recap: RecapInput, amend: boolean): Violation | undefined {
  if (!amend && recap.ask === undefined) {
    return humanCall(v('--ask', 'ask-required', 'absent',
      'under autonomy a recap answers a queued ask — witness ask <text> · --manual when a human confirmed it'))
  }
  if (recap.ask !== undefined && askQueue(root).find((a) => a.id === recap.ask)?.state === 'parked') {
    return humanCall(v('--ask', 'ask-parked', `${recap.ask} is parked`,
      `a human answers it with --manual · or withdraws it with witness ask --withdraw ${recap.ask}`))
  }
  const current = amend ? latestRecap(root, recap.effort)?.class : undefined
  if (current !== undefined && current !== recap.class) {
    return humanCall(v('class', 'class-change', `${current} → ${recap.class}`,
      'the class the effort was born with — a human changes it with --manual'))
  }
  return undefined
}

// A check that sent the recap back journals itself alone: nothing is born, and the ask's
// derived state (askQueue) is what `next` and `status` read the rejection from.
function sentBack(ctx: Ctx, root: string, ask: string, round: number,
  check: ReturnType<typeof recapCheckEntry>, verdict: RecapVerdict): number {
  const parkedNow = verdict.kind === 'malformed' || round >= RECAP_CHECK_BOUND
  const stream = journalRel(ASK_STREAM)
  const res = withTxn(root, { op: `recap-check(${ask})`, files: [stream], journal: { stream: ASK_STREAM, line: entryLine(check) } }, () => {
    appendEntry(root, ASK_STREAM, check)
    crashPoint(ctx.env, 'journal-append')
    return stateCommit(root, [stream], verdict.kind === 'malformed'
      ? `recap-check(${ask}): parked`
      : `recap-check(${ask}): rejected ${round} of ${RECAP_CHECK_BOUND}`)
  })
  if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
  const help = `help: a human answers it with witness recap --file <recap.json> --ask ${ask} --manual · or withdraws it with witness ask --withdraw ${ask}`
  if (verdict.kind === 'malformed') {
    ctx.out(kv('recap-check', 'parked — the arbiter answered malformed twice'))
    ctx.out(help)
    return EXIT.FINDINGS
  }
  ctx.out(kv('recap-check', `rejected — check ${round} of ${RECAP_CHECK_BOUND}${parkedNow ? ' · the ask is parked' : ''}`))
  ctx.out(kv('reason', checkReason({ rule: verdict.rule, class: check.class, decided: verdict.decided, reason: verdict.reason })))
  if (verdict.note !== undefined) ctx.out(kv('note', verdict.note))
  ctx.out(parkedNow ? help : `next: witness recap --file <recap.json> --ask ${ask}`)
  return EXIT.FINDINGS
}
