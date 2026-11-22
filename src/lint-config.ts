import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JsonStyle } from './json-format.js'

// Row 250 (#95). What a repo's Biome configuration says about witness's files, read without running
// Biome: the JSON style witness writes .claude/settings.json in, and (payloadLinted) whether Biome
// would check witness's payload.

// JSON with comments: `//` and `/* */` comments outside strings are dropped, and so is a comma that
// only whitespace separates from the `}` or `]` after it. Throws on anything JSON.parse refuses.
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(stripTrailingCommas(out))
}

// Comments are gone by now, so a string is the only place a `,` before `}` or `]` is not syntax.
function stripTrailingCommas(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') { i++; continue }
    }
    out += c
    i++
  }
  return out
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// The root's biome.json, then biome.jsonc. Missing, unparseable or not an object: none.
export function readBiomeConfig(root: string): { file: string; doc: Record<string, unknown> } | undefined {
  for (const file of ['biome.json', 'biome.jsonc']) {
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    try {
      const doc = parseJsonc(text)
      return isMap(doc) ? { file, doc } : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

// The JSON formatter's setting `key`: `json.formatter` over `formatter`, as Biome resolves it.
function formatterSetting(doc: Record<string, unknown> | undefined, key: string): unknown {
  const json = isMap(doc?.json) && isMap(doc.json.formatter) ? doc.json.formatter : undefined
  const general = isMap(doc?.formatter) ? doc.formatter : undefined
  return json?.[key] ?? general?.[key]
}

// The indentation `existing` already uses: its first indented line's leading whitespace.
function fileIndent(existing: string | undefined): string | undefined {
  const m = /\n([ \t]+)\S/.exec(existing ?? '')
  if (m === null) return undefined
  return m[1]!.includes('\t') ? '\t' : m[1]!
}

// The style witness writes JSON in at `root`, by precedence: the root Biome config's JSON indent and
// width; Biome's own default (a tab) when that config sets no indent style and extends nothing; then
// the file's own indent; then 2 spaces. The width is 80 unless the config sets one.
export function jsonStyle(root: string, existing: string | undefined): JsonStyle {
  const doc = readBiomeConfig(root)?.doc
  const style = formatterSetting(doc, 'indentStyle')
  const width = formatterSetting(doc, 'indentWidth')
  const count = typeof width === 'number' && Number.isInteger(width) && width > 0 ? width : undefined
  const lineSetting = formatterSetting(doc, 'lineWidth')
  const lineWidth = typeof lineSetting === 'number' && lineSetting > 0 ? lineSetting : 80
  let indent: string
  if (style === 'tab') indent = '\t'
  else if (style === 'space') indent = ' '.repeat(count ?? 2)
  else if (doc !== undefined && !hasExtends(doc)) indent = '\t'
  else indent = fileIndent(existing) ?? '  '
  return { indent, lineWidth, tabWidth: count ?? 2 }
}

function hasExtends(doc: Record<string, unknown>): boolean {
  const ext = doc.extends
  return typeof ext === 'string' ? ext !== '' : Array.isArray(ext) && ext.length > 0
}
