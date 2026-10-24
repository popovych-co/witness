import { v, type Violation } from './refusal.js'

// A recap's `{id, text}` lists, checked one way wherever one is read: the recap itself and a
// conversation's draft (row 199). Its own module so drafts.ts never imports a verb — through
// recap.ts that would close drafts → recap → ask → drafts.
export function idTextList(raw: unknown, field: string, prefix: string, required: boolean): Violation[] {
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
