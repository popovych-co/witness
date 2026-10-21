import { posix } from 'node:path'
import { splitDoc } from './fm.js'
import type { Entry } from './journal.js'
import { deltaBase, type GateRunEntry } from './rounds.js'
import { canonicalSha } from './sha.js'
import { blobText, changedPaths, treeDiff, treeReadable } from './snapshot.js'
import { anchorKey, headingLines, sectionText, type AnchorInput, type Reviewed } from './verdict.js'

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

export interface PriorFinding { reviewer: string; anchor: AnchorInput; claim: string }
export interface DeltaPlan {
  base: GateRunEntry
  baseRound: number
  prior: PriorFinding[]       // the base's blocking findings from delta-mode lenses, battery order
  reported: Set<string>       // anchorKey of EVERY base blocking finding, every lens
  view: DeltaView
  diff: string
  sections?: string[]         // doc gates only: the heading anchors whose section the change touched
}

// Row 185. Whether this round reviews the change, and against what. The order is the decision:
// a base must exist and share this round's basis, both trees must still be readable (git gc
// prunes an unreachable one), and the change must be non-empty. Anything else is a full review.
export function planDelta(root: string, entries: Entry[], gate: string, cur: {
  reviewedSha: string
  snapshot?: { tree: string; context: string }
  basis: string
  reviewed: Reviewed
  inDelta: (lens: string) => boolean
}): DeltaPlan | undefined {
  const base = deltaBase(entries, gate, cur.reviewedSha)
  if (!base || !cur.snapshot || !base.reviewed_tree || base.basis_sha !== cur.basis) return undefined
  if (!treeReadable(root, base.reviewed_tree) || !treeReadable(root, cur.snapshot.tree)) return undefined
  const diff = treeDiff(root, base.reviewed_tree, cur.snapshot.tree)
  if (diff === '') return undefined
  const blocking: PriorFinding[] = (base.verdicts ?? []).flatMap((rv) => rv.findings
    .filter((f) => f.blocking)
    .map((f) => ({ reviewer: rv.reviewer, anchor: f.anchor, claim: f.claim })))
  const view = deltaView(root, cur.reviewed, base.reviewed_tree, cur.snapshot.tree)
  const sections = cur.reviewed.kind === 'docs'
    ? cur.reviewed.docs.flatMap((d) => headingLines(d.body).map((h) => `${d.id} > ${h}`)).filter((a) => view.state(a) === 'changed')
    : undefined
  return {
    base, baseRound: base.round,
    prior: blocking.filter((f) => cur.inDelta(f.reviewer)),
    reported: new Set(blocking.map((f) => anchorKey(f.anchor))),
    view, diff,
    ...(sections ? { sections } : {}),
  }
}

// The one block every delta-mode lens receives, between the open deferrals and the anchor
// menu. It ends with a blank line so the menu starts on its own.
export function deltaBlock(d: { baseRound: number; prior: readonly PriorFinding[]; diff: string; sections?: readonly string[] }): string {
  const n = d.baseRound
  const anchor = (a: AnchorInput) => (typeof a === 'string' ? a : JSON.stringify(a))
  const prior = d.prior.length > 0
    ? d.prior.map((f, i) => `${i + 1}. ${anchor(f.anchor)} — ${f.claim} (${f.reviewer})`).join('\n')
    : `None — round ${n} reported no blocking finding.`
  const sections = d.sections?.length
    ? `### Sections changed since round ${n}\n\n${d.sections.map((s) => `- ${s}`).join('\n')}\n\n`
    : ''
  return `## Delta review — round ${n} to now\n\n` +
    `Round ${n} reviewed this content in full. This round judges what changed since then. The reviewed content below is still the complete current content, and the verdict contract applies to it unchanged.\n\n` +
    `### Blocking findings from round ${n}\n\n${prior}\n\n` +
    'For each finding above, decide whether it still holds against the current content. If it does, report it again, copying its anchor exactly as listed while that anchor still resolves. If the change fixed it, leave it out of your findings.\n\n' +
    sections +
    `### Change since round ${n}\n\n${d.diff}\n\n` +
    'Judge whether the changed parts are sound. Report every defect the change introduced or exposed. When the change caused a defect, anchor it at the changed code or section that caused it, even when its symptom shows elsewhere.\n\n'
}
