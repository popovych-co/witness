// Rows 283 and 285 (corrections C47–C49). The two files witness writes into a consumer's tree so a
// tool stays green on spots a tolerated set holds, and reads back so its reader sees them:
// ESLint's own bulk-suppressions file at the root (ESLint reads it by default; probe §1) and a
// witness-owned Biome config the repo's `biome.json` extends, one override per file setting each
// tolerated rule to `info` — the tool stays green and its SARIF reports each spot as a `note`
// (probe §3). Writers are witness code: no setting, no command.
import type { Diagnostic } from './diagnostics.js'
import { DEFAULT_JSON_STYLE, formatJson, type JsonStyle } from './json-format.js'
import { readBiomeConfig } from './lint-config.js'
import { RULE_RE } from './lint-readers.js'
import type { ReaderTool } from './settings.js'

export const ESLINT_LIST = 'eslint-suppressions.json'
export const BIOME_LIST = 'biome.witness.json'
export const BIOME_LEVEL = 'info'

// One (file, rule) pair, a key no path or rule id can collide in.
export const pairKey = (file: string, rule: string): string => `${file}\0${rule}`

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const GLOB = /[*?[\]{}!]/

// The (file, rule) pairs the witness file sets to `info`: an override of exactly
// `{ includes: [<one path, no glob>], linter: { rules: { <group>: { <name>: 'info' } } } }`. Any other
// shape is none of witness's writing and contributes nothing; text that does not parse reads empty.
export function biomePairs(text: string): Set<string> {
  const out = new Set<string>()
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return out
  }
  if (!isObj(doc) || !Array.isArray(doc.overrides)) return out
  for (const o of doc.overrides) {
    if (!isObj(o) || Object.keys(o).some((k) => k !== 'includes' && k !== 'linter')) continue
    const inc = o.includes
    if (!Array.isArray(inc) || inc.length !== 1 || typeof inc[0] !== 'string' || inc[0] === '' || GLOB.test(inc[0])) continue
    if (!isObj(o.linter) || Object.keys(o.linter).some((k) => k !== 'rules') || !isObj(o.linter.rules)) continue
    const pairs: string[] = []
    let shaped = true
    for (const [group, names] of Object.entries(o.linter.rules)) {
      if (!isObj(names)) { shaped = false; break }
      for (const [name, level] of Object.entries(names)) {
        if (level !== BIOME_LEVEL) { shaped = false; break }
        pairs.push(pairKey(inc[0], `lint/${group}/${name}`))
      }
      if (!shaped) break
    }
    if (shaped) for (const p of pairs) out.add(p)
  }
  return out
}

// Row 285 (C49). ESLint's bulk-suppressions layout: per repo-relative file, per rule, how many of its
// violations are suppressed (up to `count` all are; one more reports every one, probe Q4).
export type EslintList = Record<string, Record<string, { count: number }>>

const posInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 1

// A list's text read back: undefined unless it is that layout with every count a positive integer.
export function parseEslintList(text: string): EslintList | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObj(doc)) return undefined
  // Built with fromEntries: a path or rule named `__proto__` is an own key, never a prototype.
  const files: Array<[string, Record<string, { count: number }>]> = []
  for (const [file, rules] of Object.entries(doc)) {
    if (!isObj(rules)) return undefined
    const m: Array<[string, { count: number }]> = []
    for (const [rule, entry] of Object.entries(rules)) {
      if (!isObj(entry) || !posInt(entry.count)) return undefined
      m.push([rule, { count: entry.count }])
    }
    files.push([file, Object.fromEntries(m)])
  }
  return Object.fromEntries(files)
}

// A spot a list can name: a repo-relative file and a rule id.
const listable = (d: Diagnostic): boolean =>
  d.file !== '' && !d.file.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(d.file) && d.rule !== '' && d.rule !== '?'

const countBy = (spots: readonly Diagnostic[]): Map<string, { file: string; rule: string; n: number }> => {
  const out = new Map<string, { file: string; rule: string; n: number }>()
  for (const d of spots) {
    if (!listable(d)) continue
    const k = pairKey(d.file, d.rule)
    const c = out.get(k) ?? { file: d.file, rule: d.rule, n: 0 }
    c.n += 1
    out.set(k, c)
  }
  return out
}

// Row 285 (C51). The ESLint list for a tree: every spot of a `tolerated` rule counted per (file, rule),
// growth included — the tool never reports one, the tolerated check alone judges; a `witness` rule (one a
// set once named) none applies to now gets no entry; any other rule is the repo's own, kept from `prior`
// (the base's list) at most at its count there, never raised.
export function eslintList(spots: readonly Diagnostic[], tolerated: ReadonlySet<string>, witness: ReadonlySet<string>, prior: EslintList | undefined): EslintList {
  const out = new Map<string, Array<[string, { count: number }]>>()
  for (const { file, rule, n } of countBy(spots).values()) {
    let count: number | undefined
    if (tolerated.has(rule)) count = n
    else if (witness.has(rule)) count = undefined
    else {
      const was = prior !== undefined && Object.hasOwn(prior, file) && Object.hasOwn(prior[file]!, rule) ? prior[file]![rule]!.count : undefined
      count = was === undefined ? undefined : Math.min(was, n)
    }
    if (count !== undefined) out.set(file, [...(out.get(file) ?? []), [rule, { count }]])
  }
  return Object.fromEntries([...out].map(([f, rules]) => [f, Object.fromEntries(rules)]))
}

const sortedKeys = <T>(o: Record<string, T>): Array<[string, T]> => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

// The list's text — keys sorted at every level, as ESLint writes it, in the repo's JSON style with the final
// newline its formatter wants (probe §2); undefined when the list is empty (the file goes).
export function eslintListText(list: EslintList, style: JsonStyle = DEFAULT_JSON_STYLE): string | undefined {
  const files = sortedKeys(list).filter(([, rules]) => Object.keys(rules).length > 0)
  if (files.length === 0) return undefined
  return formatJson(Object.fromEntries(files.map(([f, rules]) => [f, Object.fromEntries(sortedKeys(rules).map(([r, e]) => [r, { count: e.count }]))])), style)
}

// Row 285 (C48). The witness-owned Biome config: one override per file, each tolerated rule of the file at `info`.
export interface BiomeList { overrides: Array<{ includes: [string]; linter: { rules: Record<string, Record<string, 'info'>> } }> }

const BIOME_RULE = /^lint\/([A-Za-z]+)\/([A-Za-z]+)$/

// Every spot of a `tolerated` rule of the form `lint/<group>/<name>` (never `plugin`, B6); files, groups and
// names sorted.
export function biomeList(spots: readonly Diagnostic[], tolerated: ReadonlySet<string>): BiomeList {
  const byFile = new Map<string, Map<string, Set<string>>>()
  for (const d of spots) {
    const m = BIOME_RULE.exec(d.rule)
    if (m === null || !tolerated.has(d.rule) || !listable(d)) continue
    const groups = byFile.get(d.file) ?? new Map<string, Set<string>>()
    groups.set(m[1]!, (groups.get(m[1]!) ?? new Set<string>()).add(m[2]!))
    byFile.set(d.file, groups)
  }
  const files = [...byFile.keys()].sort()
  return {
    overrides: files.map((file) => {
      const groups = byFile.get(file)!
      const rules = Object.fromEntries([...groups.keys()].sort().map((g) => [g, Object.fromEntries([...groups.get(g)!].sort().map((n) => [n, BIOME_LEVEL as 'info']))]))
      return { includes: [file] as [string], linter: { rules } }
    }),
  }
}

export function biomeListText(list: BiomeList, style: JsonStyle = DEFAULT_JSON_STYLE): string {
  return formatJson(list, style)
}

// Whether the root Biome config's `extends` lists the witness file; undefined with no Biome config.
export function extendsWitness(dir: string): boolean | undefined {
  const cfg = readBiomeConfig(dir)
  if (cfg === undefined) return undefined
  const ext = cfg.doc.extends
  return Array.isArray(ext) && ext.some((e) => e === `./${BIOME_LIST}` || e === BIOME_LIST)
}

// Row 285 (C49). Whether a rule's old spots can go on a list: any ESLint rule id; a Biome lint rule (never
// `plugin`, whose one shared id no override removes per file, nor `format`); clippy and tsc never.
export function writable(tool: ReaderTool, rule: string): boolean {
  if (tool === 'eslint') return rule !== '?' && RULE_RE.test(rule)
  if (tool === 'biome') return BIOME_RULE.test(rule)
  return false
}
