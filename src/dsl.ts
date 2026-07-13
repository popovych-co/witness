import { v, type Violation } from './refusal.js'

export const ID_RE = /^[a-z0-9-]+$/

export interface Criterion {
  id: string
  test?: string
  cmd?: string
}

export type Need =
  | { env: string }
  | { cmd: string }
  | { manual: string; satisfied: boolean }

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
  })
  return out
}
