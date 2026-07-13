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

export function baseForSpec(root: string, canon: Canon, specId: string, excludePlanId?: string): BaseResolution {
  const candidates = canon.docs.filter(
    (d) =>
      d.meta.type === 'plan' &&
      d.meta.parent === specId &&
      typeof d.meta['derives-from'] === 'string' &&
      d.meta.id !== excludePlanId,
  )
  if (candidates.length === 0) return { kind: 'empty' }
  const stamped = candidates.map((p) => {
    const res = tryGit(root, 'log', '-1', '--format=%ct', '--', p.rel)
    const at = res.ok && res.out !== '' ? Number(res.out) : Number.POSITIVE_INFINITY
    return { p, at }
  })
  stamped.sort((a, b) => b.at - a.at || String(b.p.meta.id).localeCompare(String(a.p.meta.id)))
  const latest = stamped[0]!.p
  return { kind: 'plan-pin', sha: String(latest.meta['derives-from']), planId: String(latest.meta.id) }
}
