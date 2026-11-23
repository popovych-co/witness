import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { askQueue, reservedId } from '../ask.js'
import { loadConfig } from '../config.js'
import { dropDraft } from '../drafts.js'
import { ID_RE } from '../dsl.js'
import { idTextList } from '../idlists.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { sessionMarker } from '../drive-presence.js'
import { appendEntry, effortAbandoned, effortCause, entryLine, isFixCause, journalRel, latestRecap, readStream, streamExists, type FixCause } from '../journal.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { cmd, kv, shellWord } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'

export interface RecapInput {
  effort: string
  class: 'feature' | 'fix' | 'chore'
  goals: Array<{ id: string; text: string }>
  non_goals: Array<{ id: string; text: string }>
  constraints: Array<{ id: string; text: string }>
  decisions?: Array<{ id: string; text: string }>
  slices: string[]
  // Row 176. Set from --ask only, never from the file: the ask a recap answers is the CLI's
  // record of what the human asked, so a recap cannot name its own.
  ask?: string
  // Row 253. A fix's cause. The file carries it; the verb journals it as a `cause` line beside the
  // recap line, never inside it.
  cause?: FixCause
}

// Row 253. The refusals a fix's cause can meet, one wording each for the file and the flag.
const CAUSES_WANT = 'escape | decision'
const causeEnum = (got: unknown) => v('cause', 'enum', String(got), CAUSES_WANT)
const CAUSE_REQUIRED = v('cause', 'required', 'absent',
  "the human's answer, added as \"cause\" — escape: it slipped past what should have caught it | decision: they chose to change how it works")

export function validateRecap(raw: unknown): Violation[] {
  if (typeof raw !== 'object' || raw === null) return [v('recap', 'shape', String(raw), 'JSON object')]
  const e = raw as Record<string, unknown>
  const out: Violation[] = []
  if (typeof e.effort !== 'string' || !ID_RE.test(e.effort)) {
    out.push(v('effort', 'id-charset', String(e.effort ?? 'absent'), '[a-z0-9][a-z0-9-]*'))
  }
  if (e.class !== 'feature' && e.class !== 'fix' && e.class !== 'chore') {
    out.push(v('class', 'enum', String(e.class ?? 'absent'), 'feature | fix | chore'))
  }
  out.push(...idTextList(e.goals, 'goals', 'g', true))
  out.push(...idTextList(e.non_goals, 'non_goals', 'n', false))
  out.push(...idTextList(e.constraints, 'constraints', 'c', false))
  out.push(...idTextList(e.decisions, 'decisions', 'd', false))
  if (e.slices !== undefined && (!Array.isArray(e.slices) || e.slices.some((s) => typeof s !== 'string' || s === ''))) {
    out.push(v('slices', 'shape', JSON.stringify(e.slices), 'list of non-empty strings (non-binding)'))
  }
  // Row 253. Only a fix carries a cause; whether a fix lacks one depends on what is recorded (`run`).
  if (e.cause !== undefined) {
    if (!isFixCause(e.cause)) out.push(causeEnum(e.cause))
    else if (e.class === 'feature' || e.class === 'chore') {
      out.push(v('cause', 'fix-only', e.class, 'no cause — only a fix carries one'))
    }
  }
  return out
}

// Whether this slug may take this recap: a new effort needs a fresh stream, an amend a live
// one. Row 176: a reserved stream is refused before slug-reuse and for --amend too, whether
// or not it exists yet — an amend would append a recap to witness's own history.
// Exported, with askRefusal below, for `draft` (row 199), whose key names the ask or effort a
// recap will land on: a second copy would be a second answer to "may this recap land", and the
// two would part company on the first change.
export function effortRefusal(root: string, effort: string, amend: boolean): Violation | undefined {
  const reserved = reservedId(effort)
  if (reserved !== undefined) return v('effort', 'id-taken', effort, `a new id — ${effort} is ${reserved}`)
  const exists = streamExists(root, effort)
  if (!amend && exists) return v('effort', 'slug-reuse', `journal stream '${effort}' exists (active or terminal)`, 'a new slug — histories never merge')
  if (amend && !exists) return v('effort', 'unknown-effort', effort, 'an existing effort stream to amend')
  if (amend && effortAbandoned(readStream(root, effort))) return v('effort', 'terminal', 'effort was abandoned', 'amend only live efforts')
  return undefined
}

// Whether this ask may be answered by a new effort, read from one queue derivation.
export function askRefusal(root: string, id: string): Violation | undefined {
  const ask = askQueue(root).find((a) => a.id === id)
  if (!ask) return v('--ask', 'unknown-ask', id, 'an ask id — witness status lists the queue')
  if (ask.state === 'answered') return v('--ask', 'ask-answered', `${id} is answered by ${ask.effort}`, 'an unanswered ask — one ask births one effort')
  if (ask.state === 'withdrawn') return v('--ask', 'ask-withdrawn', id, 'an unanswered ask — this one was withdrawn')
  return undefined
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    file: { type: 'string' }, amend: { type: 'boolean' }, ask: { type: 'string' },
    effort: { type: 'string' }, cause: { type: 'string' },
  } })
  // Row 253. `--effort <slug> --cause <c>` classifies an existing fix; it reads no recap file.
  if (values.cause !== undefined) return classify(ctx, values)
  if (values.effort !== undefined) {
    renderRefusal([v('--cause', 'required', 'absent', `${CAUSES_WANT} — --effort names the fix to classify`)]).forEach(ctx.err)
    return EXIT.REFUSED
  }
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

  const slug = effortRefusal(root, recap.effort, values.amend === true)
  if (slug) { renderRefusal([slug]).forEach(ctx.err); return EXIT.REFUSED }
  // Row 253. A fix names its cause unless an amend's effort already recorded one, and a cause line is
  // the human's word: no witness-spawned session journals one (security review; the classify act's rule).
  const causeRefused = (): Violation | undefined =>
    causeOwed(root, recap, values.amend === true) ? CAUSE_REQUIRED
    : causeLine(root, recap, values.amend === true) !== undefined ? causeInSession(ctx.env) : undefined
  const owed = causeRefused()
  if (owed) { renderRefusal([owed]).forEach(ctx.err); return EXIT.REFUSED }
  // Row 176. One ask births one effort: an amend re-scopes an effort an ask already birthed.
  if (recap.ask !== undefined) {
    if (values.amend) {
      renderRefusal([v('--ask', 'ask-amend', 'with --amend', 'an ask births its own effort — drop --amend')]).forEach(ctx.err)
      return EXIT.REFUSED
    }
    const refusal = askRefusal(root, recap.ask)
    if (refusal) { renderRefusal([refusal]).forEach(ctx.err); return EXIT.REFUSED }
  }

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    // Read again under the lock: another writer may have crashed mid-transaction, born this
    // slug, or answered the ask since the reads above.
    const crashed = guardTxn(ctx, root)
    if (crashed !== undefined) return crashed
    const raced = effortRefusal(root, recap.effort, values.amend === true)
      ?? (recap.ask !== undefined ? askRefusal(root, recap.ask) : undefined)
      ?? causeRefused()
    if (raced) { renderRefusal([raced]).forEach(ctx.err); return EXIT.REFUSED }
    const recorded = values.amend ? effortCause(readStream(root, recap.effort)) : undefined
    const causeEntry = causeLine(root, recap, values.amend === true)

    const entry = {
      t: 'recap' as const, effort: recap.effort, class: recap.class,
      goals: recap.goals, non_goals: recap.non_goals, constraints: recap.constraints,
      // Row 198: no key when there are none, so a decision-free recap journals today's bytes (c2).
      ...(recap.decisions?.length ? { decisions: recap.decisions } : {}),
      slices: recap.slices,
      ...(recap.ask !== undefined ? { ask: recap.ask } : {}),
    }
    // entryLine, never a second inline JSON.stringify — completeTxn re-appends when this
    // marker line differs from what appendEntry wrote, so the two must be one derivation.
    const line = entryLine(entry)
    const stream = journalRel(recap.effort)
    const marker = {
      op: `recap(${recap.effort})`, files: [stream], journal: { stream: recap.effort, line },
      ...(causeEntry ? { journalMulti: [{ stream: recap.effort, line: entryLine(causeEntry) }] } : {}),
    }
    const res = withTxn(root, marker, () => {
      appendEntry(root, recap.effort, entry)
      if (causeEntry) appendEntry(root, recap.effort, causeEntry)
      crashPoint(ctx.env, 'journal-append')
      return stateCommit(root, marker.files, `recap(${recap.effort})${values.amend ? ' --amend' : ''}: ${recap.class}${recap.ask !== undefined ? ` · ask ${recap.ask}` : ''}`)
    })
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
    // Row 199. The recap is the record now, so the grill's draft is done — only once the commit
    // landed: a refused recap leaves the conversation where it was.
    if (recap.ask !== undefined) dropDraft(root, { kind: 'ask', id: recap.ask })
    if (values.amend) dropDraft(root, { kind: 'amend', effort: recap.effort })
    ctx.out(kv('effort', recap.effort))
    ctx.out(kv('class', recap.class))
    if (recap.class === 'fix') ctx.out(kv('cause', recap.cause ?? recorded ?? 'none'))
    ctx.out(kv('goals', recap.goals.length))
    if (recap.decisions?.length) ctx.out(kv('decisions', recap.decisions.length))
    if (recap.ask !== undefined) ctx.out(kv('ask', `${recap.ask} — answered`))
    if (values.amend) ctx.out(kv('amended', 'latest recap wins; coverage and decisions re-validate against it'))
    ctx.out(cmd('next', `witness write --effort ${shellWord(recap.effort)} --meta <m.json> --body <b.md> <spec-id>`))
    return EXIT.OK
  } finally {
    lock.value()
  }
}

// Row 253. The cause line a recap's transaction carries, only when it says something new: a fix
// birth's cause, or an amend naming another than the one recorded.
function causeLine(root: string, recap: RecapInput, amend: boolean): { t: 'cause'; effort: string; cause: FixCause } | undefined {
  if (recap.class !== 'fix' || recap.cause === undefined) return undefined
  if (amend && effortCause(readStream(root, recap.effort)) === recap.cause) return undefined
  return { t: 'cause', effort: recap.effort, cause: recap.cause }
}

// Row 253 (row 205's pattern). A fix's cause is named by the human in their own chat or terminal.
function causeInSession(env: Record<string, string | undefined>): Violation | undefined {
  const marker = sessionMarker(env)
  return marker === undefined ? undefined
    : v('cause', 'cause-in-session', marker, 'the human names a fix\'s cause in their own chat or terminal')
}

// Row 253. Whether this fix recap is refused for lacking a cause: it names none, and (for an amend)
// its effort has recorded none.
function causeOwed(root: string, recap: RecapInput, amend: boolean): boolean {
  if (recap.class !== 'fix' || recap.cause !== undefined) return false
  return !amend || effortCause(readStream(root, recap.effort)) === undefined
}

// Row 253. `witness recap --effort <slug> --cause escape|decision`: names the cause of a fix that
// predates causes, or changes one. The human's act, so a witness-spawned session is refused (row
// 205's pattern). One `cause` line under the lock, one state commit; the recorded cause again
// writes nothing.
async function classify(ctx: Ctx, values: { file?: string; amend?: boolean; ask?: string; effort?: string; cause?: string }): Promise<number> {
  const refused = (x: Violation): number => { renderRefusal([x]).forEach(ctx.err); return EXIT.REFUSED }
  if (values.file !== undefined) {
    return refused(v('--cause', 'cause-in-file', '--file',
      'the recap file carries a fix\'s cause — drop --cause, or drop --file to classify an existing fix'))
  }
  for (const flag of ['amend', 'ask'] as const) {
    if (values[flag] !== undefined) {
      return refused(v('--cause', 'classify-only', `--${flag}`, 'witness recap --effort <slug> --cause escape|decision — nothing else'))
    }
  }
  if (values.effort === undefined) return refused(v('--effort', 'required', 'absent', 'the fix effort to classify — witness status lists the fixes owing a cause'))
  // Slice 2 review C1. Checked before any path is built from it: a case alias of a live fix would
  // append through the alias on a case-insensitive file system, and `..` would climb out of the journal.
  if (!ID_RE.test(values.effort)) return refused(v('--effort', 'id-charset', values.effort, '[a-z0-9][a-z0-9-]*'))
  if (!isFixCause(values.cause)) return refused(causeEnum(values.cause))
  const inSession = causeInSession(ctx.env)
  if (inSession) return refused({ ...inSession, field: '--cause' })
  const slug = values.effort
  const cause: FixCause = values.cause

  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const notFix = (): Violation | undefined => {
    const cls = latestRecap(root, slug)?.class
    return cls === 'fix' ? undefined : v('cause', 'fix-only', String(cls ?? 'absent'), 'a fix effort — only a fix carries a cause')
  }
  const early = effortRefusal(root, slug, true) ?? notFix()
  if (early) return refused(early)

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const crashed = guardTxn(ctx, root)
    if (crashed !== undefined) return crashed
    const raced = effortRefusal(root, slug, true) ?? notFix()
    if (raced) return refused(raced)
    ctx.out(kv('effort', slug))
    if (effortCause(readStream(root, slug)) === cause) {
      ctx.out(kv('cause', `${cause} (unchanged)`))
      return EXIT.OK
    }
    const entry = { t: 'cause' as const, effort: slug, cause }
    const stream = journalRel(slug)
    const txn = { op: `cause(${slug})`, files: [stream], journal: { stream: slug, line: entryLine(entry) } }
    const res = withTxn(root, txn, () => {
      appendEntry(root, slug, entry)
      crashPoint(ctx.env, 'journal-append')
      return stateCommit(root, txn.files, `cause(${slug}): ${cause}`)
    })
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
    ctx.out(kv('cause', cause))
    return EXIT.OK
  } finally {
    lock.value()
  }
}
