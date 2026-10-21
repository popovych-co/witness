import { v, type Violation } from './refusal.js'

export const ID_RE = /^[a-z0-9-]+$/

export interface Criterion {
  id: string
  test?: string
  cmd?: string
}

// Row 179. Any need may carry an `id`. A spec's manual need may also name the `cmd:` criteria
// it `holds`: while it is unmet those criteria report held instead of failing.
export type Need =
  | { env: string; id?: string }
  | { cmd: string; id?: string }
  | { manual: string; satisfied: boolean; id?: string; holds?: string[] }

export function validateCriteria(raw: unknown, specId: string): Violation[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [v('criteria', 'required', Array.isArray(raw) ? 'empty list' : String(raw ?? 'absent'), '>=1 machine-checkable criterion')]
  }
  const out: Violation[] = []
  const seen = new Set<string>()
  raw.forEach((c, i) => {
    const at = `criteria[${i}]`
    if (typeof c !== 'object' || c === null) {
      out.push(v(at, 'shape', String(c), '{id, test|cmd}'))
      return
    }
    const e = c as Record<string, unknown>
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) {
      out.push(v(`${at}.id`, 'id-charset', String(e.id ?? 'absent'), '[a-z0-9-]+'))
    } else if (seen.has(e.id)) {
      out.push(v(`${at}.id`, 'id-unique', e.id, 'unique per spec'))
    } else {
      seen.add(e.id)
    }
    const hasTest = typeof e.test === 'string'
    const hasCmd = typeof e.cmd === 'string'
    if (hasTest === hasCmd) {
      out.push(v(at, 'kind', hasTest ? 'both test and cmd' : 'neither test nor cmd', 'exactly one of test | cmd'))
      return
    }
    if (hasTest && e.test !== `@spec:${specId}`) {
      out.push(v(`${at}.test`, 'tag-format', String(e.test), `@spec:${specId}`))
    }
    if (hasCmd && e.cmd === '') {
      out.push(v(`${at}.cmd`, 'shape', 'empty string', 'non-empty command'))
    }
  })
  return out
}

export function validateNeeds(raw: unknown): Violation[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    return [v('needs', 'shape', typeof raw, 'list of {env} | {cmd} | {manual, satisfied}')]
  }
  const out: Violation[] = []
  const ids = new Set<string>()
  raw.forEach((n, i) => {
    const at = `needs[${i}]`
    if (typeof n !== 'object' || n === null) {
      out.push(v(at, 'shape', String(n), '{env} | {cmd} | {manual, satisfied}'))
      return
    }
    const e = n as Record<string, unknown>
    const kinds = ['env', 'cmd', 'manual'].filter((k) => e[k] !== undefined)
    if (kinds.length !== 1) {
      out.push(v(at, 'kind', kinds.join('+') || 'none', 'exactly one of env | cmd | manual'))
      return
    }
    const kind = kinds[0]!
    if (typeof e[kind] !== 'string' || e[kind] === '') {
      out.push(v(`${at}.${kind}`, 'shape', String(e[kind]), 'non-empty string'))
    }
    if (kind === 'manual' && typeof e.satisfied !== 'boolean') {
      out.push(v(`${at}.satisfied`, 'required', String(e.satisfied ?? 'absent'), 'boolean'))
    }
    if (e.id !== undefined) {
      if (typeof e.id !== 'string' || !ID_RE.test(e.id)) out.push(v(`${at}.id`, 'id-charset', String(e.id), '[a-z0-9-]+'))
      else if (ids.has(e.id)) out.push(v(`${at}.id`, 'id-unique', e.id, 'unique per doc'))
      else ids.add(e.id)
    }
    if (e.holds === undefined) return
    if (kind !== 'manual') {
      out.push(v(`${at}.holds`, 'forbidden', JSON.stringify(e.holds), 'holds rides a manual need'))
      return
    }
    const holds = e.holds
    if (!Array.isArray(holds) || holds.length === 0 || new Set(holds).size !== holds.length ||
      holds.some((h) => typeof h !== 'string' || !ID_RE.test(h))) {
      out.push(v(`${at}.holds`, 'shape', JSON.stringify(holds), 'a non-empty list of criterion ids'))
    }
    if (e.id === undefined) out.push(v(`${at}.id`, 'required', 'absent', 'an id — a held criterion reports held by <id>'))
  })
  return out
}

// Row 179. What a need's `holds` may name, judged against the doc it sits in: a spec's own
// `cmd:` criteria only — test criteria share one @spec run, so holding one holds none — and
// never all of them, so the lane always runs something while every need is unmet. The
// shapes themselves are validateNeeds'; a list it refused is not judged twice here.
export function validateHolds(meta: Record<string, unknown>): Violation[] {
  const needs = Array.isArray(meta.needs) ? meta.needs : []
  const criteria = meta.type === 'spec' && Array.isArray(meta.criteria)
    ? (meta.criteria as unknown[]).filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    : []
  const ids = (pick: (c: Record<string, unknown>) => boolean) =>
    criteria.filter((c) => typeof c.id === 'string' && pick(c)).map((c) => c.id as string)
  const cmdIds = ids((c) => typeof c.cmd === 'string')
  const testIds = ids((c) => typeof c.test === 'string')
  const out: Violation[] = []
  const held = new Set<string>()
  needs.forEach((n, i) => {
    if (typeof n !== 'object' || n === null) return
    const e = n as Record<string, unknown>
    if (typeof e.manual !== 'string' || !Array.isArray(e.holds)) return
    if (meta.type !== 'spec') {
      out.push(v(`needs[${i}].holds`, 'forbidden', JSON.stringify(e.holds), 'holds is spec-only — a plan need blocks its start instead'))
      return
    }
    e.holds.forEach((h, j) => {
      if (typeof h !== 'string') return
      const at = `needs[${i}].holds[${j}]`
      if (testIds.includes(h)) {
        out.push(v(at, 'held-test-criterion', h, 'a cmd criterion — test criteria share one @spec run so holding one holds none'))
      } else if (!cmdIds.includes(h)) {
        out.push(v(at, 'unknown-criterion', h, `a cmd criterion id of this spec: ${cmdIds.join(' · ') || '(none)'}`))
      } else {
        held.add(h)
      }
    })
  })
  const all = ids(() => true)
  if (held.size > 0 && all.every((id) => held.has(id))) {
    out.push(v('needs', 'holds-every-criterion', [...held].join(' · '), 'at least one criterion the lane runs while every need is unmet'))
  }
  return out
}
