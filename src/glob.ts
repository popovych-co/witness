import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function globToRegExp(pattern: string): RegExp {
  const segs = pattern.split('/')
  const parts = segs.map((seg, i) => {
    const last = i === segs.length - 1
    if (seg === '**') return last ? '.*' : '(?:[^/]+/)*'
    const body = seg
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
    return last ? body : `${body}/`
  })
  return new RegExp(`^${parts.join('')}$`)
}

// Row 263 (T2b slice 1 M10). Never the root's scratch or plan worktrees: a root-level report glob
// would walk the scratch's kept target/, and `**` would match a worktree's report.
const OTHER_TREES = new Set(['scratch', 'worktrees'])

export function walkFiles(root: string): string[] {
  const skip = new Set(['.git', 'node_modules'])
  const out: string[] = []
  const rec = (rel: string): void => {
    for (const name of readdirSync(join(root, rel || '.'))) {
      if (skip.has(name)) continue
      if (rel === '.witness' && OTHER_TREES.has(name)) continue
      const r = rel ? `${rel}/${name}` : name
      if (statSync(join(root, r)).isDirectory()) rec(r)
      else out.push(r)
    }
  }
  rec('')
  return out.sort()
}
