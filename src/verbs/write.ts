import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { ID_RE } from '../dsl.js'
import { writeDoc } from '../fm.js'
import { dirtyStatePaths, primaryRoot, stateCommit } from '../gitio.js'
import { appendEntry, journalRel, latestRecap, streamExists, type RecapEntry } from '../journal.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { baseForSpec, contentAtSha } from '../history.js'
import { findById, findCycle, loadCanon, type Canon, type CanonDoc } from '../scan.js'
import { canonicalJson, canonicalSha, short } from '../sha.js'
import { kv } from '../toon.js'
import { crashPoint, guardTxn, withTxn } from '../txn.js'
import { validateDoc } from '../schemas.js'

export interface Manifest {
  type?: unknown
  summary?: unknown
  depends?: unknown
  needs?: unknown
  criteria?: unknown
  covers?: unknown
  supersedes?: unknown
  parent?: unknown
  'derives-from'?: unknown
  steps?: unknown
}

interface Built {
  meta: Record<string, unknown>
  covers: string[]
  violations: Violation[]
  warnings: string[]
}

function buildSpecMeta(root: string, id: string, manifest: Manifest, recap: RecapEntry, canon: Canon, existing: CanonDoc | undefined, body: string): Built {
  const violations: Violation[] = []
  const type = manifest.type as string
  if (recap.class === 'chore') {
    violations.push(v('type', 'class-tripwire', `chore effort writing ${type} content`, 'chores never change state — reclassify via recap --amend, or write a plan'))
  }
  const covers = Array.isArray(manifest.covers) ? (manifest.covers as string[]) : []
  const goalIds = new Set(recap.goals.map((g) => g.id))
  covers.forEach((g, i) => {
    if (!goalIds.has(g)) violations.push(v(`covers[${i}]`, 'unknown-goal', String(g), `a goal id from the latest recap: ${[...goalIds].join(' ')}`))
  })
  const meta: Record<string, unknown> = {
    id,
    type,
    status: 'draft',
    ...(type === 'spec' ? { summary: manifest.summary } : {}),
    depends: manifest.depends ?? [],
    needs: manifest.needs ?? [],
    ...(type === 'spec' ? { criteria: manifest.criteria } : {}),
    ...(manifest.supersedes !== undefined ? { supersedes: manifest.supersedes } : {}),
  }
  if (existing) {
    for (const volatile of ['drift', 'pr'] as const) {
      if (existing.meta[volatile] !== undefined) meta[volatile] = existing.meta[volatile]
    }
  }
  violations.push(...validateDoc(meta, body))
  const depends = Array.isArray(meta.depends) ? (meta.depends as string[]) : []
  depends.forEach((dep, i) => {
    if (dep !== id && !findById(canon, dep)) violations.push(v(`depends[${i}]`, 'unknown-dep', dep, 'an existing doc id'))
  })
  const cycle = findCycle(canon, { id, depends })
  if (cycle) violations.push(v('depends', 'cycle', cycle.join(' -> '), 'an acyclic depends graph'))
  if (typeof manifest.supersedes === 'string' && !findById(canon, manifest.supersedes) && !streamExists(root, manifest.supersedes)) {
    violations.push(v('supersedes', 'unknown-ref', manifest.supersedes, 'an existing spec id or frozen journal stream'))
  }
  return { meta, covers, violations, warnings: [] }
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { effort: { type: 'string' }, meta: { type: 'string' }, body: { type: 'string' } },
    allowPositionals: true,
  })
  const id = positionals[0]
  const missing: Violation[] = []
  if (!id || !ID_RE.test(id)) missing.push(v('id', 'id-charset', String(id ?? 'absent'), 'specflow write <id> with [a-z0-9-]+'))
  for (const flag of ['effort', 'meta', 'body'] as const) {
    if (!values[flag]) missing.push(v(`--${flag}`, 'required', 'absent', `--${flag} <value>`))
  }
  if (missing.length) { renderRefusal(missing).forEach(ctx.err); return EXIT.REFUSED }

  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked
  const cfg = loadConfig(root)
  if (!cfg.ok) { renderRefusal(cfg.violations).forEach(ctx.err); return EXIT.REFUSED }
  if (cfg.value.warning) ctx.err(`warn: ${cfg.value.warning}`)

  const effort = values.effort!
  if (!streamExists(root, effort)) {
    renderRefusal([v('--effort', 'unknown-effort', effort, 'an effort born by specflow recap')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const recap = latestRecap(root, effort)
  if (!recap) {
    renderRefusal([v('--effort', 'unknown-effort', `${effort} has no recap entry`, 'an effort born by specflow recap')]).forEach(ctx.err)
    return EXIT.REFUSED
  }

  let manifest: Manifest
  let body: string
  try {
    manifest = JSON.parse(readFileSync(join(ctx.cwd, values.meta!), 'utf8')) as Manifest
    body = readFileSync(join(ctx.cwd, values.body!), 'utf8')
  } catch (e) {
    renderRefusal([v('--meta/--body', 'input-unreadable', String((e as Error).message).slice(0, 120), 'readable manifest JSON and body file')]).forEach(ctx.err)
    return EXIT.REFUSED
  }

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach(ctx.err); return EXIT.BLOCKED }
  try {
    const canon = loadCanon(root)
    const existing = findById(canon, id!)
    const built =
      manifest.type === 'plan'
        ? buildPlanMeta(root, id!, manifest, recap, canon, existing, body)
        : buildSpecMeta(root, id!, manifest, recap, canon, existing, body)
    if (existing && existing.meta.type !== manifest.type) {
      built.violations.push(v('type', 'type-immutable', `${id} is a ${existing.meta.type}`, 'amendments keep the original type'))
    }
    if (built.violations.length) {
      journalRefusal(ctx, root, effort, id!, built.violations)
      renderRefusal(built.violations).forEach(ctx.err)
      return EXIT.REFUSED
    }
    built.warnings.forEach((w) => ctx.err(`warn: ${w}`))

    const rel = existing ? existing.rel : `${manifest.type === 'plan' ? 'plans' : 'specs'}/${id}.md`
    const stream = journalRel(effort)
    const unrelated = dirtyStatePaths(root).filter((p) => p !== rel && p !== stream)
    if (unrelated.length) {
      renderRefusal(unrelated.map((p) => v(p, 'unrelated-dirty', 'uncommitted change on a state path', 'revert or re-apply via specflow write, then re-run'))).forEach(ctx.err)
      return EXIT.REFUSED
    }
    const sha = canonicalSha(built.meta, body)
    const entry = {
      t: 'write' as const, effort, artifact: id!, sha,
      ...(manifest.type === 'plan' ? {} : { covers: built.covers }),
    }
    const line = JSON.stringify({ v: 1, ...entry })
    const res = withTxn(root, { op: `write(${id})`, files: [rel, stream], journal: { stream, line } }, () => {
      writeDoc(join(root, rel), { meta: built.meta, body })
      crashPoint(ctx.env, 'artifact-write')
      appendEntry(root, effort, entry)
      crashPoint(ctx.env, 'journal-append')
      return stateCommit(root, [rel, stream], `write(${id}): ${existing ? 'amend' : 'create'} ${manifest.type}`)
    })
    if (!res.ok) { renderRefusal(res.violations).forEach(ctx.err); return EXIT.REFUSED }
    ctx.out(kv('written', id))
    ctx.out(kv('path', rel))
    ctx.out(kv('sha', short(sha)))
    ctx.out(kv('status', 'draft'))
    ctx.out('next: specflow check · specflow index')
    return EXIT.OK
  } finally {
    lock.value()
  }
}

function journalRefusal(ctx: Ctx, root: string, effort: string, artifact: string, violations: Violation[]): void {
  const entry = {
    t: 'write-refused' as const, effort, artifact,
    rules: violations.map(({ field, rule }) => ({ field, rule })),
  }
  const line = JSON.stringify({ v: 1, ...entry })
  const stream = journalRel(effort)
  const res = withTxn(root, { op: `write-refused(${artifact})`, files: [stream], journal: { stream, line } }, () => {
    appendEntry(root, effort, entry)
    return stateCommit(root, [stream], `write-refused(${artifact})`)
  })
  if (!res.ok) ctx.err('warn: refusal could not be journaled (state paths dirty)')
}

function buildPlanMeta(root: string, id: string, manifest: Manifest, recap: RecapEntry, canon: Canon, existing: CanonDoc | undefined, body: string): Built {
  const violations: Violation[] = []
  const warnings: string[] = []
  const parentId = typeof manifest.parent === 'string' ? manifest.parent : ''
  const parent = parentId ? findById(canon, parentId) : undefined
  if (!parent) {
    violations.push(v('parent', 'unknown-parent', parentId || 'absent', 'an existing spec id (or principles for chores)'))
    return { meta: {}, covers: [], violations, warnings }
  }
  if (parent.meta.type === 'principles' && recap.class !== 'chore') {
    violations.push(v('parent', 'class-mismatch', `principles parent on a ${recap.class} effort`, 'feature and fix plans derive from a spec'))
  } else if (parent.meta.type !== 'spec' && parent.meta.type !== 'principles') {
    violations.push(v('parent', 'kind', String(parent.meta.type), 'a spec (or principles for chores)'))
  }
  if (parent.meta.status === 'draft') {
    warnings.push(`parent ${parentId} is draft — gates (later slice) will require approved`)
  }
  const computed = canonicalSha(parent.meta, parent.body)
  const supplied = manifest['derives-from']
  if (typeof supplied === 'string' && supplied !== computed) {
    violations.push(v('derives-from', 'stale-derivation', short(supplied), `current parent content is ${short(computed)} — re-derive from specflow diff ${parentId}`))
  }
  const meta: Record<string, unknown> = {
    id,
    type: 'plan',
    status: 'draft',
    parent: parentId,
    'derives-from': computed,
    depends: manifest.depends ?? [],
    needs: manifest.needs ?? [],
    steps: manifest.steps,
  }
  if (existing?.meta.pr !== undefined) meta.pr = existing.meta.pr
  violations.push(...validateDoc(meta, body))

  const parentCriteria = Array.isArray(parent.meta.criteria)
    ? (parent.meta.criteria as Array<Record<string, unknown>>)
    : []
  const currentIds = new Set(parentCriteria.map((c) => String(c.id)))
  const steps = Array.isArray(manifest.steps) ? (manifest.steps as Array<Record<string, unknown>>) : []
  const referenced = new Set<string>()
  steps.forEach((s, i) => {
    const refs = Array.isArray(s.criteria) ? (s.criteria as string[]) : []
    refs.forEach((ref, j) => {
      if (!currentIds.has(ref)) {
        violations.push(v(`steps[${i}].criteria[${j}]`, 'unknown-criterion', ref, `a criterion id on ${parentId}: ${[...currentIds].join(' ') || '(none)'}`))
      }
      referenced.add(ref)
    })
  })
  const delta = deltaCriteriaIds(root, canon, parent, id)
  const uncovered = [...delta].filter((c) => !referenced.has(c))
  if (uncovered.length) {
    violations.push(v('steps', 'criteria-uncovered', uncovered.join('+'), 'every delta criterion realized by >=1 step'))
  }

  const depends = Array.isArray(meta.depends) ? (meta.depends as string[]) : []
  depends.forEach((dep, i) => {
    if (dep !== id && !findById(canon, dep)) violations.push(v(`depends[${i}]`, 'unknown-dep', dep, 'an existing doc id'))
  })
  const cycle = findCycle(canon, { id, depends })
  if (cycle) violations.push(v('depends', 'cycle', cycle.join(' -> '), 'an acyclic depends graph'))
  return { meta, covers: [], violations, warnings }
}

function deltaCriteriaIds(root: string, canon: Canon, parent: CanonDoc, excludePlanId: string): Set<string> {
  const current = Array.isArray(parent.meta.criteria)
    ? (parent.meta.criteria as Array<Record<string, unknown>>)
    : []
  const all = new Set(current.map((c) => String(c.id)))
  const base = baseForSpec(root, canon, String(parent.meta.id), excludePlanId)
  if (base.kind === 'empty') return all
  const baseDoc = contentAtSha(root, parent.rel, base.sha!)
  if (!baseDoc) return all
  const baseById = new Map(
    (Array.isArray(baseDoc.meta.criteria) ? (baseDoc.meta.criteria as Array<Record<string, unknown>>) : [])
      .map((c) => [String(c.id), canonicalJson(c)]),
  )
  return new Set(
    current.filter((c) => baseById.get(String(c.id)) !== canonicalJson(c)).map((c) => String(c.id)),
  )
}
