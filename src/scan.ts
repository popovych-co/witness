import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { canonPaths, type CanonPaths } from './config.js'
import { reservedId } from './ask.js'
import { readDoc } from './fm.js'
import { readStream } from './journal.js'
import { v, type Violation } from './refusal.js'
import { validateDoc } from './schemas.js'

export interface CanonDoc {
  rel: string
  meta: Record<string, unknown>
  body: string
  violations: Violation[]
  // Row 179. The manual needs the journal records as satisfied, by needKey: read here, once per
  // load, so every judge of a need (needMet) sees the same answer without a journal read of
  // its own. Empty for a doc that carries no manual need.
  satisfiedNeeds: readonly string[]
}

export interface Canon {
  docs: CanonDoc[]
  errors: Violation[]
  paths: CanonPaths
}

// Keyed by the doc's own stream, not by the entry's `artifact`: a rename moves the stream and
// keeps every satisfaction it recorded.
function satisfiedNeeds(root: string, meta: Record<string, unknown>): string[] {
  const needs = Array.isArray(meta.needs) ? (meta.needs as unknown[]) : []
  if (!needs.some((n) => typeof n === 'object' && n !== null && typeof (n as Record<string, unknown>).manual === 'string')) return []
  if (typeof meta.id !== 'string') return []
  return readStream(root, meta.id).filter((e) => e.t === 'need-satisfied').map((e) => String(e.need))
}

// Final review F7. `write`, `rename` and `recap` refuse a reserved id for a new artifact; a doc
// that already holds one — hand-added, or older than the reservation — would share witness's
// own stream, so canon itself calls it an error.
function reservedDoc(meta: Record<string, unknown>): Violation[] {
  const reserved = typeof meta.id === 'string' ? reservedId(meta.id) : undefined
  return reserved === undefined ? []
    : [v('id', 'reserved', String(meta.id), `a new id — ${String(meta.id)} is ${reserved} · edit the doc's id by hand then witness adopt it`)]
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
        violations: [...validateDoc(parsed.value.meta, parsed.value.body), ...reservedDoc(parsed.value.meta)],
        satisfiedNeeds: satisfiedNeeds(root, parsed.value.meta),
      })
    }
  }
  return { docs, errors, paths }
}

// D154. Which doc owns the `cmd:` criteria a gate is about to leave blocked. A plan gate
// judges a PLAN, but criteria live on the spec it derives from — so a trust surface keyed
// on the gate's target alone would list nothing at exactly the gates that need it.
export function criteriaOwner(canon: Canon, id: string): CanonDoc | undefined {
  const doc = findById(canon, id)
  if (!doc) return undefined
  if (doc.meta.type !== 'plan') return doc
  const parent = typeof doc.meta.parent === 'string' ? findById(canon, doc.meta.parent) : undefined
  return parent ?? doc
}

export function findById(canon: Canon, id: string): CanonDoc | undefined {
  return canon.docs.find((d) => d.meta.id === id)
}

// D157. The one derivation of "this doc can parent a plan today". `verbs/next.ts`'s
// queue and `gates/plan.ts`'s parent check both consume it; a second derivation is the
// drift that left `next` refusing to emit the exact command the gate accepts (issue #21).
export function plannableParent(doc: CanonDoc): boolean {
  const s = String(doc.meta.status)
  return doc.meta.type === 'principles' ? s === 'approved' : s === 'approved' || s === 'live'
}

// D166. The one derivation of "this plan no longer moves": `done` merged and `abandoned` was
// withdrawn. check's stray-worktree rule, next's plan queue and the re-slice's guard all ask
// exactly this.
export function planFinished(doc: CanonDoc): boolean {
  const s = String(doc.meta.status)
  return s === 'done' || s === 'abandoned'
}

// D166. The plans that stand on a spec: its children that have not been withdrawn, outside
// the set of plans the asking operation is itself retiring. A `done` plan stands — it shipped
// this spec — and so does one still moving; only `abandoned` has stepped off. `pin` narrows to
// the children derived from one version of the spec, which is what an unwind would take away.
export function plansOn(canon: Canon, specId: string, opts: { exclude?: Set<string>; pin?: string } = {}): CanonDoc[] {
  return canon.docs.filter((d) =>
    d.meta.type === 'plan' && d.meta.parent === specId &&
    String(d.meta.status) !== 'abandoned' &&
    !(opts.exclude?.has(String(d.meta.id)) ?? false) &&
    (opts.pin === undefined || d.meta['derives-from'] === opts.pin))
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
