import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { ok, refuse, v, type Result } from './refusal.js'

export interface RawDoc {
  meta: Record<string, unknown>
  body: string
}

const FIELD_ORDER = [
  'id', 'type', 'status', 'summary', 'ui', 'parent', 'derives-from', 'design-from',
  'supersedes', 'depends', 'needs', 'criteria', 'steps', 'pr', 'drift', 'design',
] as const

export function splitDoc(raw: string): Result<RawDoc> {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) {
    return refuse([v('frontmatter', 'missing', 'no leading --- block', 'doc starts with ---\\n<yaml>\\n---')])
  }
  let meta: unknown
  try {
    meta = parseYaml(m[1]!)
  } catch (e) {
    return refuse([v('frontmatter', 'yaml-parse', String((e as Error).message).slice(0, 120), 'valid YAML')])
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return refuse([v('frontmatter', 'shape', Array.isArray(meta) ? 'sequence' : String(meta), 'YAML mapping')])
  }
  return ok({ meta: meta as Record<string, unknown>, body: m[2]! })
}

export function serializeDoc(doc: RawDoc): string {
  const ordered: Record<string, unknown> = {}
  for (const k of FIELD_ORDER) if (doc.meta[k] !== undefined) ordered[k] = doc.meta[k]
  for (const k of Object.keys(doc.meta)) if (!(k in ordered)) ordered[k] = doc.meta[k]
  const yaml = stringifyYaml(ordered, { lineWidth: 0 })
  const body = doc.body.replace(/^\n+/, '').replace(/\s+$/, '') + '\n'
  return `---\n${yaml}---\n\n${body}`
}

export function readDoc(path: string): Result<RawDoc> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return refuse([v(path, 'unreadable', 'missing or unreadable file', 'existing utf8 file')])
  }
  return splitDoc(raw)
}

export function writeDoc(path: string, doc: RawDoc): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeDoc(doc))
}
