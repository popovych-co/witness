import { splitDoc, type RawDoc } from './fm.js'
import { tryGit } from './gitio.js'
import { canonicalSha } from './sha.js'
import type { Canon } from './scan.js'

export function contentAtSha(root: string, rel: string, sha: string): RawDoc | undefined {
  const log = tryGit(root, 'log', '--format=%H', '--', rel)
  if (!log.ok || log.out === '') return undefined
  for (const commit of log.out.split('\n')) {
    const shown = tryGit(root, 'show', `${commit}:${rel}`)
    if (!shown.ok) continue
    const parsed = splitDoc(shown.out + '\n')
    if (!parsed.ok) continue
    if (canonicalSha(parsed.value.meta, parsed.value.body) === sha) return parsed.value
  }
  return undefined
}

export interface BaseResolution {
  kind: 'plan-pin' | 'empty'
  sha?: string
  planId?: string
}

// D160 amendment. The plan queue resolves a base for every plannable spec on every
// `next`/`status`/drive turn, and a per-plan `git log -1` fan-out there is one spawn per
// shipped plan for the life of the repo. One `git log --name-only` over the plan rels
// builds the same last-commit map in a single spawn: output is newest-first, so the FIRST
// occurrence of each path carries its latest commit epoch. A path absent from the map was
// never committed, which the per-file shape also treats as "latest" (INFINITY).
export function planStamps(root: string, rels: string[]): Map<string, number> {
  const map = new Map<string, number>()
  if (rels.length === 0) return map
  const res = tryGit(root, 'log', '--format=%ct', '--name-only', '--', ...rels)
  if (!res.ok) return map
  let at = Number.POSITIVE_INFINITY
  for (const line of res.out.split('\n')) {
    if (/^\d+$/.test(line)) { at = Number(line); continue }
    if (line !== '' && !map.has(line)) map.set(line, at)
  }
  return map
}

export function baseForSpec(root: string, canon: Canon, specId: string, excludePlanId?: string, stamps?: Map<string, number>): BaseResolution {
  const candidates = canon.docs.filter(
    (d) =>
      d.meta.type === 'plan' &&
      d.meta.parent === specId &&
      typeof d.meta['derives-from'] === 'string' &&
      // D160. A withdrawn plan is not a realization: counting an abandoned plan's pin as
      // the base would report `delta: none` for content nothing ever implemented, and
      // would hide the spec from the plan queue that keys on this same derivation.
      String(d.meta.status) !== 'abandoned' &&
      d.meta.id !== excludePlanId,
  )
  if (candidates.length === 0) return { kind: 'empty' }
  const stamped = candidates.map((p) => {
    if (stamps) return { p, at: stamps.get(p.rel) ?? Number.POSITIVE_INFINITY }
    const res = tryGit(root, 'log', '-1', '--format=%ct', '--', p.rel)
    const at = res.ok && res.out !== '' ? Number(res.out) : Number.POSITIVE_INFINITY
    return { p, at }
  })
  stamped.sort((a, b) => b.at - a.at || String(b.p.meta.id).localeCompare(String(a.p.meta.id)))
  const latest = stamped[0]!.p
  return { kind: 'plan-pin', sha: String(latest.meta['derives-from']), planId: String(latest.meta.id) }
}
