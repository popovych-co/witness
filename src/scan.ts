import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { canonPaths, type CanonPaths } from './config.js'
import { readDoc } from './fm.js'
import { type Violation } from './refusal.js'
import { validateDoc } from './schemas.js'

export interface CanonDoc {
  rel: string
  meta: Record<string, unknown>
  body: string
  violations: Violation[]
}

export interface Canon {
  docs: CanonDoc[]
  errors: Violation[]
  paths: CanonPaths
}

export function loadCanon(root: string): Canon {
  const docs: CanonDoc[] = []
  const errors: Violation[] = []
  const paths = canonPaths(root)
  for (const dir of [paths.specs, paths.plans]) {
    const base = join(root, dir)
    if (!existsSync(base)) continue
    for (const f of readdirSync(base, { recursive: true, encoding: 'utf8' })) {
      if (!f.endsWith('.md')) continue
      const rel = `${dir}/${f}`
      const parsed = readDoc(join(root, rel))
      if (!parsed.ok) {
        errors.push(...parsed.violations.map((x) => ({ ...x, field: `${rel}: ${x.field}` })))
        continue
      }
      docs.push({
        rel,
        meta: parsed.value.meta,
        body: parsed.value.body,
        violations: validateDoc(parsed.value.meta, parsed.value.body),
      })
    }
  }
  return { docs, errors, paths }
}

export function findById(canon: Canon, id: string): CanonDoc | undefined {
  return canon.docs.find((d) => d.meta.id === id)
}

export function findCycle(canon: Canon, extra?: { id: string; depends: string[] }): string[] | undefined {
  const deps = new Map<string, string[]>()
  for (const d of canon.docs) {
    deps.set(String(d.meta.id), Array.isArray(d.meta.depends) ? (d.meta.depends as string[]) : [])
  }
  if (extra) deps.set(extra.id, extra.depends)
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (n: string): string[] | undefined => {
    if (state.get(n) === 2) return undefined
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n]
    state.set(n, 1)
    stack.push(n)
    for (const d of deps.get(n) ?? []) {
      const cycle = visit(d)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(n, 2)
    return undefined
  }
  for (const n of deps.keys()) {
    const cycle = visit(n)
    if (cycle) return cycle
  }
  return undefined
}
