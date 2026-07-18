import { ID_RE, validateCriteria, validateNeeds } from './dsl.js'
import { v, type Violation } from './refusal.js'

export const SPEC_STATUS = ['draft', 'approved', 'live'] as const
export const PLAN_STATUS = ['draft', 'approved', 'in-progress', 'done', 'abandoned'] as const
export const PRINCIPLES_STATUS = ['draft', 'approved'] as const

export interface Step {
  id: string
  title: string
  criteria?: string[]
  scaffolding?: boolean
}

export function validateDoc(meta: Record<string, unknown>, body: string): Violation[] {
  const out: Violation[] = []
  const id = meta.id
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    out.push(v('id', 'id-charset', String(id ?? 'absent'), '[a-z0-9-]+'))
  }
  const type = meta.type
  if (type !== 'spec' && type !== 'plan' && type !== 'principles') {
    out.push(v('type', 'enum', String(type ?? 'absent'), 'spec | plan | principles'))
    return out
  }
  if (typeof id === 'string' && (type === 'principles' ? id !== 'principles' : id === 'principles')) {
    out.push(v('id', 'reserved', id, "'principles' is reserved for type: principles"))
  }
  if (meta.ui !== undefined && type !== 'spec') {
    out.push(v('ui', 'forbidden', String(meta.ui), 'ui is a spec-only flag'))
  }
  if (meta.design !== undefined && type !== 'spec') {
    out.push(v('design', 'forbidden', 'present', 'design is a spec-only, gate-written stamp'))
  }
  const depends = meta.depends ?? []
  if (!Array.isArray(depends) || depends.some((d) => typeof d !== 'string' || !ID_RE.test(d))) {
    out.push(v('depends', 'shape', JSON.stringify(meta.depends), 'list of ids matching [a-z0-9-]+'))
  }
  out.push(...validateNeeds(meta.needs))
  const statuses: readonly string[] =
    type === 'spec' ? SPEC_STATUS : type === 'plan' ? PLAN_STATUS : PRINCIPLES_STATUS
  if (!statuses.includes(String(meta.status))) {
    out.push(v('status', 'enum', String(meta.status ?? 'absent'), statuses.join(' | ')))
  }

  if (type === 'spec') {
    const s = meta.summary
    if (typeof s !== 'string' || s.length === 0) {
      out.push(v('summary', 'required', String(s ?? 'absent'), 'one-liner: what the slice is'))
    } else if (s.length > 120) {
      out.push(v('summary', 'max-length', `${s.length} chars`, '<=120 chars'))
    }
    if (meta.ui !== undefined && meta.ui !== true) {
      out.push(v('ui', 'shape', String(meta.ui), 'true or omitted (a ui spec earns a design stage)'))
    }
    if (meta.design !== undefined) {
      const d = meta.design as { sha?: unknown; spec?: unknown }
      const hex = (x: unknown): boolean => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)
      if (typeof meta.design !== 'object' || meta.design === null || !hex(d.sha) || !hex(d.spec)) {
        out.push(v('design', 'shape', JSON.stringify(meta.design), '{sha: <64hex>, spec: <64hex>} — the gate-written design stamp'))
      }
    }
    if (typeof id === 'string') out.push(...validateCriteria(meta.criteria, id))
    if (meta.supersedes !== undefined && (typeof meta.supersedes !== 'string' || !ID_RE.test(meta.supersedes))) {
      out.push(v('supersedes', 'shape', String(meta.supersedes), 'a spec id'))
    }
    for (const h of ['## Motivation', '## Behavior']) {
      if (!new RegExp(`^${h}$`, 'm').test(body)) {
        out.push(v('body', 'template', `missing ${h}`, 'spec body carries ## Motivation and ## Behavior'))
      }
    }
  }

  if (type === 'plan') {
    if (typeof meta.parent !== 'string' || !ID_RE.test(meta.parent)) {
      out.push(v('parent', 'required', String(meta.parent ?? 'absent'), 'parent spec id (or principles for chores)'))
    }
    const df = meta['derives-from']
    if (typeof df !== 'string' || !/^[0-9a-f]{64}$/.test(df)) {
      out.push(v('derives-from', 'shape', String(df ?? 'absent'), '64-hex canonical content sha'))
    }
    if (meta['design-from'] !== undefined && (typeof meta['design-from'] !== 'string' || !/^[0-9a-f]{64}$/.test(String(meta['design-from'])))) {
      out.push(v('design-from', 'shape', String(meta['design-from']), '64-hex design artifact sha'))
    }
    out.push(...validateSteps(meta.steps, body))
  }

  if (type === 'principles' && meta.criteria !== undefined) {
    out.push(v('criteria', 'forbidden', 'present', 'principles carry no criteria'))
  }
  return out
}

function validateSteps(raw: unknown, body: string): Violation[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [v('steps', 'required', raw === undefined ? 'absent' : 'empty', '>=1 step {id, title, criteria|scaffolding}')]
  }
  const out: Violation[] = []
  const ids = new Set<string>()
  raw.forEach((s, i) => {
    const at = `steps[${i}]`
    const e = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) {
      out.push(v(`${at}.id`, 'id-charset', String(e.id ?? 'absent'), '[a-z0-9-]+'))
    } else if (ids.has(e.id)) {
      out.push(v(`${at}.id`, 'id-unique', e.id, 'unique per plan'))
    } else {
      ids.add(e.id)
    }
    if (typeof e.title !== 'string' || e.title === '') {
      out.push(v(`${at}.title`, 'required', String(e.title ?? 'absent'), 'non-empty title'))
    }
    const hasCriteria = Array.isArray(e.criteria) && e.criteria.length > 0
    const isScaffolding = e.scaffolding === true
    if (hasCriteria === isScaffolding) {
      out.push(v(at, 'mapping', hasCriteria ? 'criteria and scaffolding' : 'neither criteria nor scaffolding', 'criteria: [ids] XOR scaffolding: true'))
    }
  })
  const found = new Set([...body.matchAll(/^## Step: (\S+)$/gm)].map((m) => m[1]!))
  for (const sid of ids) {
    if (!found.has(sid)) out.push(v('body', 'step-section-missing', `no '## Step: ${sid}' section`, 'one section per manifest step'))
  }
  for (const f of found) {
    if (!ids.has(f)) out.push(v('body', 'step-section-orphan', `'## Step: ${f}'`, 'every section names a manifest step'))
  }
  return out
}
