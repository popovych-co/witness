import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'

export type AnchorInput = string | { kind: 'omission'; scope: string }
export interface Finding { blocking: boolean; anchor: AnchorInput; claim: string }
export interface CoverageItem { anchor: AnchorInput; note: string }
export interface Verdict { coverage: CoverageItem[]; findings: Finding[] }

export type Reviewed =
  | { kind: 'docs'; docs: Array<{ id: string; body: string }> }
  | { kind: 'tree'; root: string; files: string[] }
  | { kind: 'design'; artifact: { ids: string[] }; spec: { id: string; body: string } }
  | { kind: 'screens'; captures: Array<{ name: string; path: string }> }

const isOmission = (a: unknown): a is { kind: 'omission'; scope: string } =>
  typeof a === 'object' && a !== null &&
  (a as { kind?: unknown }).kind === 'omission' &&
  typeof (a as { scope?: unknown }).scope === 'string'

const isAnchor = (a: unknown): a is AnchorInput =>
  (typeof a === 'string' && a.trim() !== '') || isOmission(a)

export function parseVerdict(raw: unknown): Result<Verdict> {
  const violations: Violation[] = []
  const obj = raw as { coverage?: unknown; findings?: unknown }
  if (typeof raw !== 'object' || raw === null) {
    return refuse([v('verdict', 'not-object', typeof raw, 'a JSON object')])
  }
  if (!Array.isArray(obj.coverage)) {
    violations.push(v('coverage', 'coverage-missing', String(obj.coverage), 'required [{anchor, note}] — a clean verdict must prove reading'))
  } else {
    obj.coverage.forEach((c: unknown, i: number) => {
      const item = c as { anchor?: unknown; note?: unknown }
      if (!isAnchor(item?.anchor)) violations.push(v(`coverage[${i}].anchor`, 'anchor-shape', JSON.stringify(item?.anchor), 'a heading path, file[#symbol], or {kind: "omission", scope}'))
      if (typeof item?.note !== 'string') violations.push(v(`coverage[${i}].note`, 'note-missing', String(item?.note), 'a short note per coverage anchor'))
    })
  }
  if (!Array.isArray(obj.findings)) {
    violations.push(v('findings', 'findings-missing', String(obj.findings), 'an array (empty means clean)'))
  } else {
    obj.findings.forEach((f: unknown, i: number) => {
      const item = f as { blocking?: unknown; anchor?: unknown; claim?: unknown }
      if (typeof item?.blocking !== 'boolean') violations.push(v(`findings[${i}].blocking`, 'blocking-shape', String(item?.blocking), 'true | false — the one calibrated bit'))
      if (!isAnchor(item?.anchor)) violations.push(v(`findings[${i}].anchor`, 'anchor-shape', JSON.stringify(item?.anchor), 'a heading path, file[#symbol], or {kind: "omission", scope}'))
      if (typeof item?.claim !== 'string' || item.claim.trim() === '') violations.push(v(`findings[${i}].claim`, 'claim-missing', String(item?.claim), 'a one-sentence claim'))
    })
  }
  if (violations.length > 0) return refuse(violations)
  return ok({ coverage: obj.coverage as CoverageItem[], findings: obj.findings as Finding[] })
}

const HEADING_RE = /^#{1,6}\s+.*$/
const collapse = (s: string) => s.trim().replace(/\s+/g, ' ')

function headingLines(body: string): string[] {
  return body.split('\n').filter((l) => HEADING_RE.test(l)).map(collapse)
}

// every line is a verbatim-copyable anchor that resolveAnchor accepts — the menu
// exists because reviewers paraphrasing headings was the top malformed-verdict cause
export function anchorMenu(reviewed: Reviewed): string {
  if (reviewed.kind === 'design') {
    const lines = [
      ...reviewed.artifact.ids.map((id) => `design#${id}`),
      reviewed.spec.id,
      ...headingLines(reviewed.spec.body).map((h) => `${reviewed.spec.id} > ${h}`),
    ]
    return [
      '## Valid anchors',
      '',
      'Copy one line VERBATIM per coverage/finding item. `design#<id>` names an element in the design artifact; `' +
        reviewed.spec.id + ' > ## Heading` names a section of the parent spec. Anything else rejects the whole verdict.',
      '',
      ...lines.map((l) => `- ${l}`),
    ].join('\n')
  }
  if (reviewed.kind === 'screens') {
    return [
      '## Valid anchors',
      '',
      'Every capture below is a resolvable anchor — copy one VERBATIM (a bare filename) per coverage/finding item. Anything else rejects the whole verdict.',
      '',
      ...reviewed.captures.map((c) => `- ${c.name}`),
    ].join('\n')
  }
  if (reviewed.kind !== 'docs') return ''
  const lines = reviewed.docs.flatMap((d) => [d.id, ...headingLines(d.body).map((h) => `${d.id} > ${h}`)])
  return [
    '## Valid anchors',
    '',
    'Every line below is a resolvable anchor — copy one VERBATIM per coverage/finding item. Deeper ` > ` chains of one doc\'s headings in document order also resolve; anything else rejects the whole verdict.',
    '',
    ...lines.map((l) => `- ${l}`),
  ].join('\n')
}

function resolveDocPath(segments: string[], body: string): string | undefined {
  const heads = headingLines(body)
  let cursor = -1
  for (const seg of segments) {
    const want = collapse(seg)
    const idx = heads.findIndex((h, i) => i > cursor && h === want)
    if (idx === -1) return `no heading "${seg}" (in order) in the reviewed doc`
    cursor = idx
  }
  return undefined
}

function safeRel(rel: string): boolean {
  return !isAbsolute(rel) && !normalize(rel).split(/[\\/]/).includes('..')
}

function resolveCodeAnchor(anchor: string, root: string): string | undefined {
  if (/[:#]L?\d+$/.test(anchor)) return 'line numbers refused — they drift across revisions; use file#symbol'
  const [file = '', symbol] = anchor.split('#', 2)
  if (!safeRel(file)) return `path escapes the reviewed tree: ${file}`
  const abs = join(root, file)
  if (!existsSync(abs) || !statSync(abs).isFile()) return `no file ${file} in the reviewed tree`
  if (symbol !== undefined) {
    const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (!re.test(readFileSync(abs, 'utf8'))) return `symbol "${symbol}" not found in ${file}`
  }
  return undefined
}

function resolveDesignAnchor(
  anchor: AnchorInput,
  reviewed: { artifact: { ids: string[] }; spec: { id: string; body: string } },
): string | undefined {
  const asElement = (scope: string): boolean => scope.startsWith('design#') && reviewed.artifact.ids.includes(scope.slice('design#'.length))
  const asSpec = (scope: string): string | undefined => {
    const segments = scope.split(' > ')
    if (segments[0] === reviewed.spec.id) return resolveDocPath(segments.slice(1), reviewed.spec.body)
    if (segments[0]!.startsWith('#')) return resolveDocPath(segments, reviewed.spec.body)
    return `no reviewed anchor "${scope}" (want design#<id> or ${reviewed.spec.id} > ## Heading)`
  }
  if (isOmission(anchor)) {
    const scope = anchor.scope
    if (scope === '.' || asElement(scope) || asSpec(scope) === undefined) return undefined
    return `omission scope "${scope}" resolves to no element id or spec heading`
  }
  if (anchor.startsWith('design#')) {
    return reviewed.artifact.ids.includes(anchor.slice('design#'.length))
      ? undefined
      : `no element id "${anchor.slice('design#'.length)}" in the design artifact`
  }
  return asSpec(anchor)
}

export function resolveAnchor(anchor: AnchorInput, reviewed: Reviewed): string | undefined {
  if (reviewed.kind === 'design') return resolveDesignAnchor(anchor, reviewed)
  if (reviewed.kind === 'screens') {
    const target = isOmission(anchor) ? anchor.scope : anchor
    if (reviewed.captures.some((c) => c.name === target)) return undefined
    return `${isOmission(anchor) ? 'omission scope' : 'anchor'} "${target}" names no reviewed capture`
  }
  if (isOmission(anchor)) {
    const scope = anchor.scope
    if (reviewed.kind === 'docs') {
      if (reviewed.docs.some((d) => d.id === scope)) return undefined
      const seg = scope.split(' > ')
      const scoped = reviewed.docs.find((d) => d.id === seg[0])
      const target = scoped ? seg.slice(1) : seg
      const pool = scoped ? [scoped] : reviewed.docs
      return pool.some((d) => resolveDocPath(target, d.body) === undefined)
        ? undefined
        : `omission scope "${scope}" resolves to no reviewed doc or heading`
    }
    if (scope === '.') return undefined
    if (!safeRel(scope)) return `omission scope escapes the reviewed tree: ${scope}`
    return existsSync(join(reviewed.root, scope))
      ? undefined
      : `omission scope "${scope}" is no file or directory in the reviewed tree`
  }
  if (reviewed.kind === 'tree') return resolveCodeAnchor(anchor, reviewed.root)
  const segments = anchor.split(' > ')
  if (!segments[0]!.startsWith('#')) {
    const doc = reviewed.docs.find((d) => d.id === segments[0])
    if (!doc) return `no reviewed doc "${segments[0]}"`
    return resolveDocPath(segments.slice(1), doc.body)
  }
  return reviewed.docs.some((d) => resolveDocPath(segments, d.body) === undefined)
    ? undefined
    : `no heading path "${anchor}" in any reviewed doc`
}

export function verdictViolations(verdict: Verdict, reviewed: Reviewed): Violation[] {
  const violations: Violation[] = []
  const anchorText = (a: AnchorInput) => (typeof a === 'string' ? a : JSON.stringify(a))

  verdict.findings.forEach((f, i) => {
    const why = resolveAnchor(f.anchor, reviewed)
    if (why) {
      const rule = why.startsWith('line numbers') ? 'line-numbers-refused' : 'anchor-unresolvable'
      violations.push(v(`findings[${i}].anchor`, rule, anchorText(f.anchor), why))
    }
  })
  verdict.coverage.forEach((c, i) => {
    const why = resolveAnchor(c.anchor, reviewed)
    if (why) violations.push(v(`coverage[${i}].anchor`, 'anchor-unresolvable', anchorText(c.anchor), why))
  })

  if (reviewed.kind === 'design') {
    const strings = verdict.coverage.filter((c): c is CoverageItem & { anchor: string } => typeof c.anchor === 'string')
    const artifactRead = strings.some((c) => c.anchor.startsWith('design#') && reviewed.artifact.ids.includes(c.anchor.slice('design#'.length)))
    const specRead = strings.some((c) => resolveDesignAnchor(c.anchor, reviewed) === undefined && !c.anchor.startsWith('design#'))
    if (!artifactRead) violations.push(v('coverage', 'coverage-minimum', 'no design#<id> coverage anchor', '>=1 coverage anchor naming a design artifact element (proof the look was read)'))
    if (!specRead) violations.push(v('coverage', 'coverage-minimum', 'no parent-spec coverage anchor', '>=1 coverage anchor naming a parent-spec heading (proof the spec was read)'))
    return violations
  }
  if (reviewed.kind === 'docs') {
    const covered = new Set<string>()
    verdict.coverage.forEach((c, i) => {
      if (typeof c.anchor !== 'string') return
      const [first = ''] = c.anchor.split(' > ')
      if (!first.startsWith('#')) { covered.add(first); return }
      if (reviewed.docs.length > 1) {
        violations.push(v(`coverage[${i}].anchor`, 'coverage-unscoped', c.anchor,
          'multi-doc reviews need doc-scoped coverage anchors: "<doc-id> > ## Heading"'))
      } else if (reviewed.docs[0]) covered.add(reviewed.docs[0].id)
    })
    for (const d of reviewed.docs) {
      if (!covered.has(d.id)) {
        violations.push(v('coverage', 'coverage-minimum', `docs covered: ${[...covered].sort().join(' ') || '(none)'}`,
          `≥ 1 coverage anchor per reviewed doc — missing ${d.id}`))
      }
    }
  } else if (reviewed.kind === 'screens') {
    const covered = new Set(
      verdict.coverage
        .filter((c): c is CoverageItem & { anchor: string } => typeof c.anchor === 'string')
        .map((c) => c.anchor)
        .filter((a) => reviewed.captures.some((c) => c.name === a)),
    )
    for (const cap of reviewed.captures) {
      if (!covered.has(cap.name)) {
        violations.push(v('coverage', 'coverage-minimum',
          `captures covered: ${[...covered].sort().join(' ') || '(none)'}`,
          `≥ 1 coverage anchor per reviewed capture — missing ${cap.name}`))
      }
    }
  } else {
    const distinct = new Set(
      verdict.coverage
        .filter((c): c is CoverageItem & { anchor: string } => typeof c.anchor === 'string')
        .map((c) => c.anchor.split('#')[0] ?? '')
        .filter((f) => reviewed.files.includes(f)),
    )
    const want = Math.min(5, reviewed.files.length)
    if (distinct.size < want) {
      violations.push(v('coverage', 'coverage-minimum', `${distinct.size} distinct changed files covered`,
        `≥ ${want} coverage anchors naming distinct changed files`))
    }
  }
  return violations
}
