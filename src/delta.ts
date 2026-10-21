import { posix } from 'node:path'
import { splitDoc } from './fm.js'
import { canonicalSha } from './sha.js'
import { blobText, changedPaths } from './snapshot.js'
import { sectionText, type AnchorInput, type Reviewed } from './verdict.js'

// Row 186. Where an anchor sits relative to the change between two reviewed trees. Only
// `unchanged` lets the demotion rule fire, so every input this cannot place answers `changed`
// or `context` — the two states that keep a finding blocking.
export type UnitState = 'changed' | 'unchanged' | 'context'
export interface DeltaView { state(anchor: AnchorInput): UnitState }

const targetOf = (a: AnchorInput): string => (typeof a === 'string' ? a : a.scope)

export function deltaView(root: string, reviewed: Reviewed, from: string, to: string): DeltaView {
  const changed = changedPaths(root, from, to)
  switch (reviewed.kind) {
    case 'tree': {
      // A unit is a path: the file part of `file#symbol`, or an omission's scope.
      const canon = reviewed.canonDirs ?? []
      return {
        state(a) {
          const path = posix.normalize(targetOf(a).split('#')[0]!).replace(/\/+$/, '') || '.'
          if (canon.some((d) => path === d || path.startsWith(`${d}/`))) return 'context'
          if (path === '.') return changed.length > 0 ? 'changed' : 'unchanged'
          return changed.some((p) => p === path || p.startsWith(`${path}/`)) ? 'changed' : 'unchanged'
        },
      }
    }
    case 'docs': {
      // A unit is a section. A frontmatter change moves every section of its doc.
      const metaOf = (text: string): { meta: string; body: string } => {
        const d = splitDoc(text)
        return d.ok ? { meta: canonicalSha(d.value.meta, ''), body: d.value.body } : { meta: canonicalSha({}, ''), body: text }
      }
      const docChanged = (id: string, segments: string[]): boolean => {
        const name = `${id}.md`
        if (!changed.includes(name)) return false
        const a = blobText(root, from, name)
        const b = blobText(root, to, name)
        if (a === undefined || b === undefined) return true
        const x = metaOf(a)
        const y = metaOf(b)
        if (x.meta !== y.meta) return true
        const sx = sectionText(x.body, segments)
        const sy = sectionText(y.body, segments)
        return sx === undefined || sy === undefined || sx !== sy
      }
      return {
        state(a) {
          const segments = targetOf(a).split(' > ')
          const scoped = !segments[0]!.startsWith('#')
          const named = scoped
            ? [{ id: segments[0]!, segments: segments.slice(1) }]
            : reviewed.docs.filter((d) => sectionText(d.body, segments) !== undefined).map((d) => ({ id: d.id, segments }))
          // Not in the snapshot: a doc the battery read as context (the parent spec), an id no
          // reviewed doc carries, or a heading path that resolves nowhere.
          if (named.length === 0 || named.some((n) => blobText(root, to, `${n.id}.md`) === undefined)) return 'context'
          return named.some((n) => docChanged(n.id, n.segments)) ? 'changed' : 'unchanged'
        },
      }
    }
    case 'design': {
      // The look is one unit, shared by every element anchor and by the whole artifact.
      const moved = changed.includes('design.html')
      return {
        state(a) {
          const t = targetOf(a)
          return t === '.' || t.startsWith('design#') ? (moved ? 'changed' : 'unchanged') : 'context'
        },
      }
    }
    case 'screens':
      return { state: () => 'context' }
  }
}
