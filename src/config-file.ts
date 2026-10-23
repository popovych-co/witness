import { Lexer, isMap, isScalar, parseDocument, stringify, type Node } from 'yaml'
import { LEGACY_COMMENTS } from './legacy-comments.js'
import {
  CHANGE_CLASSES, FIRST_LINE, GROUP_HEADINGS, SCHEMA_COMMENT, SETTINGS, getIn, type Group,
} from './settings.js'
import { sectionsOf } from './migration.js'

// Row 193 §4.5. The one shape of witness.config.yaml: `init` writes it and `migrate` rewrites
// every file into it. Witness owns the comment at the end of each setting's line, the first
// line and the group headings; every other comment line is the human's and is carried over,
// placed above the setting it sat above (or ended the line of).

export interface HumanComments {
  top: string[]                      // human lines above the first setting, kept under FIRST_LINE
  above: Map<string, string[]>       // dotted setting or section path → human lines to print above it
  end: string[]                      // human lines after the last setting
}

const EMPTY: HumanComments = { top: [], above: new Map(), end: [] }

// Witness's comments start at this column, or two spaces past a longer line (§4.5's layout).
const COMMENT_COLUMN = 31
const withComment = (content: string, comment: string): string =>
  `${content.length < COMMENT_COLUMN ? content.padEnd(COMMENT_COLUMN) : `${content}  `}# ${comment}`

const classComment = (cls: string) => `for a ${cls}`

// A value as one line of the file. Quoted only where YAML needs it, except that a command
// holding double quotes is written in single ones, as §4.5 writes the runner: shell quoting
// reads plainly inside them. Collections are flow style (`[a, b]`, `{k: [a]}`).
export function inlineValue(val: unknown): string {
  if (typeof val === 'string' && val.includes('"') && !val.includes("'")) return `'${val}'`
  return stringify(val, { collectionStyle: 'flow', flowCollectionPadding: false, lineWidth: 0 }).trimEnd()
}

// Every map in block style, every list in flow style, sections in SECTION_ORDER (which the
// list's own order follows), witness's comment at the end of every setting line and never on a
// section line: a comment there made the canon guard's old reader fall back to the defaults (P3).
export function renderConfig(values: Record<string, unknown>, comments: HumanComments = EMPTY): string {
  const out: string[] = [FIRST_LINE, ...comments.top, withComment(`schema: ${String(values.schema)}`, SCHEMA_COMMENT)]
  const printed = new Set<string>()
  const above = (path: string, depth: number) => {
    printed.add(path)
    for (const line of comments.above.get(path) ?? []) out.push(`${'  '.repeat(depth)}${line}`)
  }
  let group: Group | undefined
  const opened = new Set<string>()
  for (const s of SETTINGS) {
    const val = getIn(values, s.path)
    if (val === undefined) continue
    if (s.group !== group) {
      group = s.group
      out.push('', GROUP_HEADINGS[group])
    }
    const parts = s.path.split('.')
    for (let i = 1; i < parts.length; i++) {
      const section = parts.slice(0, i).join('.')
      if (opened.has(section)) continue
      opened.add(section)
      above(section, i - 1)
      out.push(`${'  '.repeat(i - 1)}${parts[i - 1]}:`)
    }
    const depth = parts.length - 1
    const indent = '  '.repeat(depth)
    const key = parts[depth]!
    above(s.path, depth)
    if (s.shape.kind === 'battery' && !Array.isArray(val)) {
      out.push(`${indent}${key}:`)
      for (const cls of CHANGE_CLASSES) {
        above(`${s.path}.${cls}`, depth + 1)
        out.push(withComment(`${indent}  ${cls}: ${inlineValue((val as Record<string, unknown>)[cls])}`, classComment(cls)))
      }
    } else {
      // A per-class comment whose map became a plain list sits above the list's line.
      if (s.shape.kind === 'battery') for (const cls of CHANGE_CLASSES) above(`${s.path}.${cls}`, depth)
      out.push(withComment(`${indent}${key}: ${inlineValue(val)}`, s.comment))
    }
  }
  // Nothing a human wrote is dropped: a line filed under a path this file no longer prints
  // goes to the end rather than nowhere.
  for (const [path, lines] of comments.above) if (!printed.has(path)) out.push(...lines)
  out.push(...comments.end)
  return `${out.join('\n')}\n`
}

// ── Who wrote which comment ──────────────────────────────────────────────────────────────────

const CURRENT_COMMENTS: ReadonlySet<string> = new Set([
  ...SETTINGS.map((s) => s.comment),
  ...CHANGE_CLASSES.map(classComment),
  SCHEMA_COMMENT,
  FIRST_LINE.slice(1).trim(),
  ...Object.values(GROUP_HEADINGS).map((h) => h.slice(1).trim()),
])

// Where a human line can be printed: every setting and section, and a per-class reviewer line.
const PRINTABLE: ReadonlySet<string> = new Set([
  ...SETTINGS.map((s) => s.path),
  ...sectionsOf(new Set(SETTINGS.map((s) => s.path))),
  ...SETTINGS.filter((s) => s.shape.kind === 'battery').flatMap((s) => CHANGE_CLASSES.map((c) => `${s.path}.${c}`)),
])

// A line above a key this file no longer prints (`gates.model`, retired at schema 2) moves to
// the head of that key's section, which is where the key sat in the old layout's terms.
function printableFor(path: string): string | undefined {
  for (let p = path; p.includes('.'); ) {
    if (PRINTABLE.has(p)) return p
    const section = p.slice(0, p.lastIndexOf('.'))
    const first = SETTINGS.find((s) => s.path.startsWith(`${section}.`))
    if (first) return first.path
    p = section
  }
  return PRINTABLE.has(path) ? path : undefined
}

// The lexer's own control tokens are not source text; every other token is, in order.
const CONTROL = /^[\x02\x18\x1f]$/

export function readComments(text: string): { human: HumanComments; legacy: number; moved: number } {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lineStarts = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1)
  const lineOf = (offset: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  // Every key the file holds, block or flow, with where it starts. Lists are values, not keys.
  const keys: Array<{ path: string; offset: number; line: number }> = []
  const walk = (node: unknown, prefix: string) => {
    if (!isMap(node)) return
    for (const pair of node.items) {
      if (!isScalar(pair.key) || !pair.key.range) continue
      const path = prefix ? `${prefix}.${String(pair.key.value)}` : String(pair.key.value)
      keys.push({ path, offset: pair.key.range[0], line: lineOf(pair.key.range[0]) })
      walk(pair.value as Node | null, path)
    }
  }
  walk(parseDocument(src).contents, '')
  keys.sort((a, b) => a.offset - b.offset)

  const human: HumanComments = { top: [], above: new Map(), end: [] }
  let legacy = 0
  let moved = 0
  const file = (path: string, line: string) => human.above.set(path, [...(human.above.get(path) ?? []), line])
  let offset = 0
  for (const token of new Lexer().lex(src)) {
    if (CONTROL.test(token)) continue
    const at = offset
    offset += token.length
    if (!token.startsWith('#')) continue
    const line = lineOf(at)
    const comment = token.trimEnd()
    const body = comment.slice(1).trim()
    const ownLine = src.slice(lineStarts[line]!, at).trim() === ''
    if (LEGACY_COMMENTS.has(body) || CURRENT_COMMENTS.has(body)) {
      // A line of its own vanishes; one on a setting's line, or the first line, is replaced.
      if (ownLine && line !== 0 && LEGACY_COMMENTS.has(body)) legacy++
      continue
    }
    let key: string | undefined
    if (ownLine) {
      key = keys.find((k) => k.offset > at)?.path
      if (key === undefined) { human.end.push(comment); continue }
      if (key === keys[0]?.path) { human.top.push(comment); continue }
    } else {
      // At the end of a line: the key that line opens, else the one whose value it sits inside.
      key = keys.find((k) => k.line === line)?.path ?? keys.filter((k) => k.offset < at).at(-1)?.path
      moved++
    }
    const target = key === undefined || key === 'schema' ? undefined : printableFor(key)
    if (target === undefined) human.top.push(comment)
    else {
      if (ownLine && target !== key) moved++
      file(target, comment)
    }
  }
  return { human, legacy, moved }
}
