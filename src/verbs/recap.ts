import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { askQueue, reservedId } from '../ask.js'
import { loadConfig } from '../config.js'
import { ID_RE } from '../dsl.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, effortAbandoned, entryLine, journalRel, readStream, streamExists } from '../journal.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { kv } from '../toon.js'
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
  out.push(...idTextList(e.decisions, 'decisions', 'd', false))
  if (e.slices !== undefined && (!Array.isArray(e.slices) || e.slices.some((s) => typeof s !== 'string' || s === ''))) {
    out.push(v('slices', 'shape', JSON.stringify(e.slices), 'list of non-empty strings (non-binding)'))
  }
  return out
}

// Whether this slug may take this recap: a new effort needs a fresh stream, an amend a live
// one. Row 176: a reserved stream is refused before slug-reuse and for --amend too, whether
// or not it exists yet — an amend would append a recap to witness's own history.
function effortRefusal(root: string, effort: string, amend: boolean): Violation | undefined {
  const reserved = reservedId(effort)
  if (reserved !== undefined) return v('effort', 'id-taken', effort, `a new id — ${effort} is ${reserved}`)
  const exists = streamExists(root, effort)
  if (!amend && exists) return v('effort', 'slug-reuse', `journal stream '${effort}' exists (active or terminal)`, 'a new slug — histories never merge')
  if (amend && !exists) return v('effort', 'unknown-effort', effort, 'an existing effort stream to amend')
  if (amend && effortAbandoned(readStream(root, effort))) return v('effort', 'terminal', 'effort was abandoned', 'amend only live efforts')
  return undefined
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
  const { values } = parseArgs({ args: argv, options: { file: { type: 'string' }, amend: { type: 'boolean' }, ask: { type: 'string' } } })
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
    if (raced) { renderRefusal([raced]).forEach(ctx.err); return EXIT.REFUSED }

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
    const marker = { op: `recap(${recap.effort})`, files: [stream], journal: { stream: recap.effort, line } }
    const res = withTxn(root, marker, () => {
      appendEntry(root, recap.effort, entry)
      crashPoint(ctx.env, 'journal-append')
      return stateCommit(root, marker.files, `recap(${recap.effort})${values.amend ? ' --amend' : ''}: ${recap.class}${recap.ask !== undefined ? ` · ask ${recap.ask}` : ''}`)
    })
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
    ctx.out(kv('effort', recap.effort))
    ctx.out(kv('class', recap.class))
    ctx.out(kv('goals', recap.goals.length))
    if (recap.decisions?.length) ctx.out(kv('decisions', recap.decisions.length))
    if (recap.ask !== undefined) ctx.out(kv('ask', `${recap.ask} — answered`))
    if (values.amend) ctx.out(kv('amended', 'latest recap wins; coverage and decisions re-validate against it'))
    ctx.out(`next: witness write --effort ${recap.effort} --meta <m.json> --body <b.md> <spec-id>`)
    return EXIT.OK
  } finally {
    lock.value()
  }
}
