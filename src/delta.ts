import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { splitDoc } from './fm.js'
import type { Entry } from './journal.js'
import { promptsSha, type Lens } from './reviewer.js'
import { deltaBase, fellBack, gateRuns, type GateRunEntry, type ReviewerVerdict } from './rounds.js'
import { canonicalSha } from './sha.js'
import { blobText, changedPaths, treeDiff, treePaths, treeReadable } from './snapshot.js'
import { anchorKey, headingLines, sectionText, type AnchorInput, type Reviewed } from './verdict.js'

// Row 186. Where an anchor sits relative to the change between two reviewed trees. Only
// `unchanged` lets the demotion rule fire, so every input this cannot place answers `changed`
// or `context` — the two states that keep a finding blocking.
export type UnitState = 'changed' | 'unchanged' | 'context'
export interface DeltaView { state(anchor: AnchorInput): UnitState }

const targetOf = (a: AnchorInput): string => (typeof a === 'string' ? a : a.scope)
const normPath = (p: string): string => posix.normalize(p).replace(/\/+$/, '') || '.'

export function deltaView(root: string, reviewed: Reviewed, from: string, to: string): DeltaView {
  const changed = changedPaths(root, from, to)
  switch (reviewed.kind) {
    case 'tree': {
      // A unit is a path: the file part of `file#symbol`, or an omission's scope.
      const canon = reviewed.canonDirs ?? []
      // A path neither tree holds by its exact spelling cannot be placed: a case alias of a changed
      // file on a case-insensitive disk, a path through a symlink, an ignored file.
      const known = new Set([...treePaths(root, from), ...treePaths(root, to)])
      return {
        state(a) {
          const path = normPath(targetOf(a).split('#')[0]!)
          if (canon.some((d) => path === d || path.startsWith(`${d}/`))) return 'context'
          if (path === '.') return changed.length > 0 ? 'changed' : 'unchanged'
          if (!known.has(path)) return 'context'
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

// Whether a finding is one the base already reported. Doc anchors compare exactly (D123). At the
// code gates a spelling is not a finding: the file part is normalized (`./src/a.ts#f` is
// `src/a.ts#f`), and a bare path matches any anchor in its file either way round — a lens that
// re-reports a standing blocker as `src/a.ts` has not found something new.
export function reportedBy(prior: readonly AnchorInput[], paths: boolean): (a: AnchorInput) => boolean {
  if (!paths) {
    const keys = new Set(prior.map(anchorKey))
    return (a) => keys.has(anchorKey(a))
  }
  const parse = (a: AnchorInput): { key: string; file?: string; bare: boolean } => {
    if (typeof a !== 'string') return { key: `omission:${normPath(a.scope)}`, bare: false }
    const i = a.indexOf('#')
    const file = normPath(i === -1 ? a : a.slice(0, i))
    return { key: i === -1 ? file : `${file}${a.slice(i)}`, file, bare: i === -1 }
  }
  const p = prior.map(parse)
  const keys = new Set(p.map((x) => x.key))
  const files = new Set(p.flatMap((x) => (x.file !== undefined ? [x.file] : [])))
  const bare = new Set(p.flatMap((x) => (x.bare ? [x.file!] : [])))
  return (a) => {
    const x = parse(a)
    if (keys.has(x.key)) return true
    if (x.file === undefined) return false
    return bare.has(x.file) || (x.bare && files.has(x.file))
  }
}
export interface DeltaPlan {
  base: GateRunEntry
  baseRound: number
  prior: PriorFinding[]       // the base's blocking findings from delta-mode lenses, battery order
  reported: (a: AnchorInput) => boolean   // did the base report it blocking, by any lens (reportedBy)
  view: DeltaView
  diff: string
  sections?: string[]         // doc gates only: the heading anchors whose section the change touched
  paths?: string[]            // code gates only (row 208): the paths the change touched, canon left out
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
  // Row 208. What a delta lens's coverage floor counts. Canon is context at the code gates (the
  // unit view says so too), so a canon edit is no file the change asks a lens to cover.
  const canon = cur.reviewed.kind === 'tree' ? cur.reviewed.canonDirs ?? [] : []
  const paths = cur.reviewed.kind === 'tree'
    ? changedPaths(root, base.reviewed_tree, cur.snapshot.tree).filter((p) => !canon.some((d) => p === d || p.startsWith(`${d}/`)))
    : undefined
  return {
    base, baseRound: base.round,
    prior: blocking.filter((f) => cur.inDelta(f.reviewer)),
    reported: reportedBy(blocking.map((f) => f.anchor), cur.reviewed.kind === 'tree'),
    view, diff,
    ...(sections ? { sections } : {}),
    ...(paths?.length ? { paths } : {}),
  }
}

// The one block every delta-mode lens receives, between the open deferrals and the anchor
// menu. It ends with a blank line so the menu starts on its own.
export function deltaBlock(d: {
  baseRound: number; prior: readonly PriorFinding[]; diff: string; sections?: readonly string[]; paths?: readonly string[]
}): string {
  const n = d.baseRound
  const anchor = (a: AnchorInput) => (typeof a === 'string' ? a : JSON.stringify(a))
  const prior = d.prior.length > 0
    ? d.prior.map((f, i) => `${i + 1}. ${anchor(f.anchor)} — ${f.claim} (${f.reviewer})`).join('\n')
    : `None — round ${n} reported no blocking finding.`
  const sections = d.sections?.length
    ? `### Sections changed since round ${n}\n\n${d.sections.map((s) => `- ${s}`).join('\n')}\n\n`
    : ''
  // Row 208. Without paths (the doc gates) the block is byte for byte row 185's.
  const files = d.paths?.length
    ? `### Files changed since round ${n}\n\n${d.paths.map((p) => `- ${p}`).join('\n')}\n\n` +
      `Cover at least ${Math.min(5, d.paths.length)} of these files, each with its own coverage anchor.\n\n`
    : ''
  const contract = d.paths?.length
    ? `the verdict contract applies to it unchanged — except the coverage floor, which counts only the files listed under "Files changed since round ${n}".`
    : 'the verdict contract applies to it unchanged.'
  return `## Delta review — round ${n} to now\n\n` +
    `Round ${n} reviewed this content in full. This round judges what changed since then. The reviewed content below is still the complete current content, and ${contract}\n\n` +
    `### Blocking findings from round ${n}\n\n${prior}\n\n` +
    'For each finding above, decide whether it still holds against the current content. If it does, report it again, copying its anchor exactly as listed while that anchor still resolves. If the change fixed it, leave it out of your findings.\n\n' +
    sections + files +
    `### Change since round ${n}\n\n${d.diff}\n\n` +
    'Judge whether the changed parts are sound. Report every defect the change introduced or exposed. When the change caused a defect, anchor it at the changed code or section that caused it, even when its symptom shows elsewhere.\n\n'
}

// A digest of everything a gate's prompt carries besides the artifact under review.
export function contextDigest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

// Row 185. What a delta may not span: the lens prompts and their injected docs, the gate's
// context, the pin and the harness. A round under another basis read with other eyes or
// against another frame, so its findings are no base for this one.
export function basisSha(lenses: readonly Lens[], context: string, pin: string, harness: string): string {
  return contextDigest(promptsSha([...lenses]), context, pin, harness)
}

// Row 187, the rule. At a demoting gate (the code gates — ship's first round re-reads their
// artifact), a blocking finding is recorded non-blocking when its lens reviewed the change, it
// disputes no pin, the base did not report its anchor as blocking, and its unit is unchanged
// since the base. Everything else is returned untouched, in battery order. Every reader that
// counts — recurrence, the ladder, the prefilled note, the recommender, obligation minting —
// reads `blocking`, so a demotion counts for none of them.
export function demote(
  verdicts: ReviewerVerdict[], d: { baseRound: number; reported: (a: AnchorInput) => boolean; view: DeltaView },
  inDelta: (lens: string) => boolean,
): ReviewerVerdict[] {
  return verdicts.map((rv) => !inDelta(rv.reviewer) ? rv : {
    ...rv,
    findings: rv.findings.map((f) =>
      f.blocking && f.contradicts_pin === undefined && !d.reported(f.anchor) &&
      d.view.state(f.anchor) === 'unchanged'
        ? { ...f, blocking: false, demoted: d.baseRound }
        : f),
  })
}

export interface OutstandingDemotion { reviewer: string; anchor: AnchorInput; claim: string; round: number; since: number }

// Plan decision 16. What a demotion let through at `gate` that no full review has judged since:
// the demoted findings on its runs after the last real full review (no delta mark, not
// malformed, not fallen back, not a cached replay, carrying verdicts), one per lens and anchor, the
// latest kept. The gate that backstops them never demotes one of them again (gate.ts).
export function outstandingDemotions(entries: Entry[], gate: string): OutstandingDemotion[] {
  const runs = gateRuns(entries, gate)
  let start = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!
    // A cached replay re-served an older verdict: it re-judged nothing.
    if (!r.delta && !r.cached && r.outcome !== 'malformed' && !fellBack(r) && (r.verdicts?.length ?? 0) > 0) { start = i + 1; break }
  }
  const out = new Map<string, OutstandingDemotion>()
  for (const r of runs.slice(start)) {
    if (r.outcome === 'malformed') continue
    for (const rv of r.verdicts ?? []) {
      for (const f of rv.findings) {
        if (f.demoted === undefined) continue
        out.set(`${rv.reviewer}\0${anchorKey(f.anchor)}`, { reviewer: rv.reviewer, anchor: f.anchor, claim: f.claim, round: r.round, since: f.demoted })
      }
    }
  }
  return [...out.values()]
}

// Spec §7 C3: ship's first round is the backstop for what a demotion let through, and ship runs
// fewer lenses than implement — so every ship review is told, by name, what implement demoted.
// Solicited the way open deferrals are (deferralsBlock), and joined to the setup the same way.
export function demotionsBlock(gate: string, list: readonly OutstandingDemotion[]): string {
  if (list.length === 0) return ''
  const line = (d: OutstandingDemotion, i: number): string => {
    const where = `${d.reviewer} · ${gate} round ${d.round}`
    if (typeof d.anchor === 'string') return `${i + 1}. ${d.anchor} — ${d.claim} — ${where}`
    const scope = d.anchor.scope
    return `${i + 1}. omission · scope ${scope} — ${d.claim} — ${where} — report it with "anchor": { "kind": "omission", "scope": ${JSON.stringify(scope)} }`
  }
  return `## Demoted at ${gate} (never re-judged in full — report these if they still hold)\n\n` +
    `The ${gate} gate recorded the findings below as non-blocking: they were new in a round that reviewed a change, and the content they name had not changed. No full review at the ${gate} gate has judged them since. ` +
    'Judge each against the current content. If a defect is still present, report it as a finding anchored exactly as listed: it then blocks here.\n\n' +
    list.map(line).join('\n') + '\n\n'
}
