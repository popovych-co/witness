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

// Slice 2 review (row 285): witness's own tolerated file sets no style, so extending it alone keeps Biome's default.
const WITNESS_EXTENDS = new Set(['./biome.witness.json', 'biome.witness.json'])
function hasExtends(doc: Record<string, unknown>): boolean {
  const ext = doc.extends
  return typeof ext === 'string' ? ext !== '' && !WITNESS_EXTENDS.has(ext) : Array.isArray(ext) && ext.some((e) => !WITNESS_EXTENDS.has(e as string))
}

// Row 250 (#95). Whether Biome would check witness's payload, read from its config without running it,
// by the probed truth table (t0b-biome.sh, Biome 2.4.9):
//  - the local `files.includes` decides by its last matching pattern, and a pattern naming a
//    directory covers what is under it; with no `includes` at all, everything is checked;
//  - where no local pattern matches, an `extends` list decides, assumed to include everything
//    (presets such as ultracite start with `"**"`); with no `extends`, an unmatched path is not
//    checked — the extended file is never read (Open / deferred);
//  - a path is checked unless the formatter, the linter and the assist are all off for it, since
//    `biome check` runs all three.
// ESLint, Prettier and other tools are not read: their configs are code (Open / deferred).
const BIOME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.json', '.jsonc', '.css', '.graphql', '.gql'])

// One Biome glob as an anchored regex: `**/` any directories, a trailing `/**` anything under,
// `**` alone anything, `*` within one segment, `?` one character, the rest literal.
function globRegex(glob: string): RegExp {
  let src = ''
  let i = 0
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) { src += '(?:.*/)?'; i += 3; continue }
    if (glob.startsWith('/**', i) && i + 3 === glob.length) { src += '(?:/.*)?'; i += 3; continue }
    if (glob.startsWith('**', i)) { src += '.*'; i += 2; continue }
    const c = glob[i]!
    if (c === '*') src += '[^/]*'
    else if (c === '?') src += '[^/]'
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i++
  }
  return new RegExp(`^${src}$`)
}

interface Pattern { exclude: boolean; re: RegExp }

function patternOf(raw: string): Pattern {
  let text = raw
  let exclude = false
  if (text.startsWith('!!')) { exclude = true; text = text.slice(2) } else if (text.startsWith('!')) { exclude = true; text = text.slice(1) }
  if (text.startsWith('./')) text = text.slice(2)
  if (text.startsWith('/')) text = text.slice(1)
  return { exclude, re: globRegex(text) }
}

// The path and each of its parent directories: a pattern naming a directory covers what is under it.
function candidates(rel: string): string[] {
  const parts = rel.split('/')
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

// The last pattern matching `rel` decides: true kept, false excluded, undefined none matched.
function lastMatch(patterns: readonly Pattern[], rel: string): boolean | undefined {
  const forms = candidates(rel)
  let verdict: boolean | undefined
  for (const p of patterns) if (forms.some((f) => p.re.test(f))) verdict = !p.exclude
  return verdict
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function biomeChecks(doc: Record<string, unknown>, rel: string): boolean {
  const files = isMap(doc.files) ? doc.files : {}
  const local = Array.isArray(files.includes) ? strings(files.includes) : undefined
  const ignored = strings(files.ignore).map((g) => `!${g}`)   // Biome 1.x
  const patterns = (local === undefined ? ['**', ...ignored] : [...local, ...ignored]).map(patternOf)
  const kept = lastMatch(patterns, rel) ?? hasExtends(doc)
  if (!kept) return false
  const on = { formatter: true, linter: true, assist: true }
  const apply = (from: Record<string, unknown>): void => {
    for (const tool of ['formatter', 'linter', 'assist'] as const) {
      const t = from[tool]
      if (isMap(t) && typeof t.enabled === 'boolean') on[tool] = t.enabled
    }
  }
  apply(doc)
  for (const o of Array.isArray(doc.overrides) ? doc.overrides : []) {
    if (!isMap(o)) continue
    if (lastMatch(strings(o.includes).map(patternOf), rel) === true) apply(o)
  }
  return on.formatter || on.linter || on.assist
}

export function payloadLinted(root: string, paths: readonly string[]): { config: string; paths: string[]; dirs: string[] } | undefined {
  const cfg = readBiomeConfig(root)
  if (cfg === undefined) return undefined
  const checked = paths
    .filter((rel) => BIOME_EXTENSIONS.has(rel.slice(rel.lastIndexOf('.'))) && biomeChecks(cfg.doc, rel))
    .sort()
  if (checked.length === 0) return undefined
  const dirs = [...new Set(checked.map((rel) => rel.split('/')[0]!))].sort()
  return { config: cfg.file, paths: checked, dirs }
}

// The `payload-linted` detail `check` and `init` both print. It holds no `,` and no `"`, so TOON
// prints it raw (src/toon.ts `esc`).
export function payloadLintedDetail(found: { config: string; paths: string[]; dirs: string[] }): string {
  return `${found.paths.join(' · ')} — ${found.config} checks them so the repo's own lint can fail on witness's files; ` +
    `add the pattern ${found.dirs.map((d) => `!${d}`).join(' and ')} to files.includes in ${found.config}`
}
