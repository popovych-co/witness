import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { ID_RE } from '../dsl.js'
import { primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, effortAbandoned, journalRel, readStream, streamExists } from '../journal.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { kv } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'

interface RecapInput {
  effort: string
  class: 'feature' | 'fix' | 'chore'
  goals: Array<{ id: string; text: string }>
  non_goals: Array<{ id: string; text: string }>
  constraints: Array<{ id: string; text: string }>
  slices: string[]
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

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { file: { type: 'string' }, amend: { type: 'boolean' } } })
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

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const entry = {
      t: 'recap' as const, effort: recap.effort, class: recap.class,
      goals: recap.goals, non_goals: recap.non_goals, constraints: recap.constraints, slices: recap.slices,
    }
    const line = JSON.stringify({ v: 1, ...entry })
    const stream = journalRel(recap.effort)
    const res = withTxn(root, { op: `recap(${recap.effort})`, files: [stream], journal: { stream: recap.effort, line } }, () => {
      appendEntry(root, recap.effort, entry)
      crashPoint(ctx.env, 'journal-append')
      return stateCommit(root, [stream], `recap(${recap.effort})${values.amend ? ' --amend' : ''}: ${recap.class}`)
    })
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
    ctx.out(kv('effort', recap.effort))
    ctx.out(kv('class', recap.class))
    ctx.out(kv('goals', recap.goals.length))
    if (values.amend) ctx.out(kv('amended', 'latest recap wins; coverage re-validates against it'))
    ctx.out(`next: specflow write --effort ${recap.effort} --meta <m.json> --body <b.md> <spec-id>`)
    return EXIT.OK
  } finally {
    lock.value()
  }
}
