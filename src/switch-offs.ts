// Row 273 (§4 T3, C25, C27). Switch-offs: the lines that turn a check off — a suppression comment, a
// skipped or focused test, a loosened option. witness's own table holds each token where its tool reads
// it: a directive only where it opens a comment (ESLint, TypeScript, Biome, Stryker, Python's linters,
// Go's nolint); a code token never on a line that opens as a comment (Rust's attributes); the test API
// only in test files, and its options only with their turning-on literal (`retry: false` and
// `{ fails: "unreachable" }` never match). The repo's own tokens (`checks.switchOffs`) are literals,
// never regexes, matched on any line of any text file where they are not glued to an identifier.
//
// A switch-off is a line: keyed over (token, file, normalized line), so a moved, re-indented or CRLF
// line keeps its key. The plan adds the copies of a key beyond the base's count — base-red's per-key
// multiset (row 263) — so a duplicated line is new and a new file counts whole. An unreadable base
// reads empty: every copy is new (fail closed).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lstatListed } from './change-set.js'
import { normalizeSnippet } from './diagnostics.js'
import { gitBlob } from './gitio.js'

export type SwitchOffLang = 'ts' | 'rust' | 'python' | 'go'

export function langOf(file: string): SwitchOffLang | undefined {
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) return 'ts'
  if (/\.rs$/.test(file)) return 'rust'
  if (/\.pyi?$/.test(file)) return 'python'
  if (/\.go$/.test(file)) return 'go'
  return undefined
}

// A test file: named `.test.` or `.spec.` before its extension, or under a test folder.
export function isTestPath(file: string): boolean {
  return /\.(test|spec)\.[^./]+$/.test(file) || /(^|\/)(__tests__|tests?|spec|e2e)\//.test(file)
}

export interface LineHit { token: string; rules: string[] }
export interface SwitchOff { token: string; file: string; line: number; snippet: string; rules: string[]; test: boolean }

const RULE = /^[@A-Za-z0-9_./:-]{1,100}$/
const MAX_RULES = 20

// Rule ids: each `[@A-Za-z0-9_./:-]{1,100}`, deduplicated, sorted, at most 20.
const ruleIds = (raw: readonly string[]): string[] =>
  [...new Set(raw.map((r) => r.trim()).filter((r) => RULE.test(r)))].sort().slice(0, MAX_RULES)

// The text after a match, up to a block comment's close.
const after = (line: string, m: RegExpExecArray): string => line.slice(m.index + m[0].length).split('*/')[0]!

const eslintRules = (line: string, m: RegExpExecArray): string[] => after(line, m).split(/\s--/)[0]!.split(',')
const eslintConfigRules = (line: string, m: RegExpExecArray): string[] =>
  [...line.slice(m.index + m[0].length - 1).split('*/')[0]!.matchAll(/([@\w/.-]+)\s*:/g)].map((k) => k[1]!)
const biomeRules = (line: string, m: RegExpExecArray): string[] => after(line, m).split(':')[0]!.trim().split(/\s+/)
const rustListRules = (line: string, m: RegExpExecArray): string[] => after(line, m).split(')')[0]!.split(',')
const cfgAttrRules = (line: string): string[] => (/\b(?:allow|expect)\s*\(([^)]*)\)/.exec(line)?.[1] ?? '').split(',')
const noqaRules = (line: string, m: RegExpExecArray): string[] =>
  (/^\s*:\s*([A-Z]+[0-9]+(?:[\s,]+[A-Z]+[0-9]+)*)/.exec(after(line, m))?.[1] ?? '').split(/[\s,]+/)
const typeIgnoreRules = (line: string, m: RegExpExecArray): string[] => (/^\[([^\]]*)\]/.exec(after(line, m))?.[1] ?? '').split(',')
const pylintRules = (line: string, m: RegExpExecArray): string[] =>
  (/^\s*=\s*([^#]*)/.exec(after(line, m))?.[1] ?? '').split(',').map((r) => r.trim().split(/\s+/)[0]!)
const nolintRules = (line: string, m: RegExpExecArray): string[] => (/^:([\w,-]+)/.exec(after(line, m))?.[1] ?? '').split(',')

interface TokenDef {
  lang: SwitchOffLang
  where: 'comment' | 'code'          // a code token never matches a line that opens as a comment
  tests: boolean                     // the test API: only in test files
  re: RegExp
  id: (m: RegExpExecArray) => string
  rules?: (line: string, m: RegExpExecArray) => string[]
  unless?: RegExp                    // a line this matches is another token's (the cfg_attr line)
}

const C = String.raw`(?:\/\/|\/\*)` // a comment opens here
const CFG_ATTR = /#!?\[\s*cfg_attr\s*\(.*\b(?:allow|expect)\s*\(/

// The table (C25; the plan's probe `t3a-tokens.mjs`), in the order a line's hits are listed.
export const TOKENS: readonly TokenDef[] = [
  { lang: 'ts', where: 'comment', tests: false, re: new RegExp(`${C}\\s*eslint-disable(-next-line|-line)?(?![\\w-])`),
    id: (m) => `eslint-disable${m[1] ?? ''}`, rules: eslintRules },
  { lang: 'ts', where: 'comment', tests: false, re: /\/\*\s*eslint\s+[@\w]/, id: () => 'eslint-config', rules: eslintConfigRules },
  { lang: 'ts', where: 'comment', tests: false, re: new RegExp(`${C}[/*]*\\s*@ts-(ignore|expect-error|nocheck)\\b`), id: (m) => `@ts-${m[1]!}` },
  { lang: 'ts', where: 'comment', tests: false, re: new RegExp(`${C}\\s*biome-ignore(-all|-start)?(?![\\w-])`),
    id: (m) => `biome-ignore${m[1] ?? ''}`, rules: biomeRules },
  { lang: 'ts', where: 'comment', tests: false, re: new RegExp(`${C}\\s*Stryker disable\\b`), id: () => 'Stryker disable' },
  { lang: 'ts', where: 'code', tests: true, re: /\.(skip|only|fails)\b(?=\s*[.(])/, id: (m) => `.${m[1]!}(` },
  { lang: 'ts', where: 'code', tests: true, re: /(?<![\w$.])x(it|test|describe)\s*\(/, id: (m) => `x${m[1]!}(` },
  { lang: 'ts', where: 'code', tests: true, re: /(?<![\w$])(skip|only|todo|fails)\s*:\s*true\b/, id: (m) => `${m[1]!}: true` },
  { lang: 'ts', where: 'code', tests: true, re: /(?<![\w$])retry\s*:\s*[1-9]\d*\b/, id: () => 'retry:' },
  { lang: 'rust', where: 'code', tests: false, re: /#(!?)\[\s*(allow|expect)\s*\(/, id: (m) => `#${m[1]!}[${m[2]!}(`,
    rules: rustListRules, unless: CFG_ATTR },
  { lang: 'rust', where: 'code', tests: false, re: CFG_ATTR, id: () => 'cfg_attr allow', rules: cfgAttrRules },
  { lang: 'rust', where: 'code', tests: false, re: /#\[\s*ignore\b/, id: () => '#[ignore]' },
  { lang: 'rust', where: 'code', tests: false, re: /\bmutants::skip\b/, id: () => 'mutants::skip' },
  { lang: 'python', where: 'comment', tests: false, re: /#\s*noqa\b/i, id: () => 'noqa', rules: noqaRules },
  { lang: 'python', where: 'comment', tests: false, re: /#\s*type:\s*ignore\b/, id: () => 'type: ignore', rules: typeIgnoreRules },
  { lang: 'python', where: 'comment', tests: false, re: /#\s*pylint:\s*disable\b/, id: () => 'pylint: disable', rules: pylintRules },
  { lang: 'go', where: 'comment', tests: false, re: /\/\/\s*nolint\b/, id: () => 'nolint', rules: nolintRules },
]

const commentLine = (line: string, lang: SwitchOffLang): boolean =>
  (lang === 'python' ? /^\s*#/ : /^\s*(?:\/\/|\/\*|\*)/).test(line)

// The table's tokens that apply to `file`: its language's, the test-only ones in test files.
const tokensFor = (file: string): TokenDef[] => {
  const lang = langOf(file)
  if (lang === undefined) return []
  const test = isTestPath(file)
  return TOKENS.filter((t) => t.lang === lang && (!t.tests || test))
}

const IDENT = /[A-Za-z0-9_$]/

// Whether `line` holds the literal `token` somewhere it is not glued to an identifier character on a
// side where the token itself has one (`skipTest` is not in `skipTests` or `preskipTest`).
function holdsLiteral(line: string, token: string): boolean {
  if (token.length === 0) return false
  const head = IDENT.test(token[0]!)
  const tail = IDENT.test(token.at(-1)!)
  for (let i = line.indexOf(token); i !== -1; i = line.indexOf(token, i + 1)) {
    const before = i > 0 ? line[i - 1]! : ''
    const next = line[i + token.length] ?? ''
    if ((head && IDENT.test(before)) || (tail && IDENT.test(next))) continue
    return true
  }
  return false
}

function lineHits(defs: readonly TokenDef[], lang: SwitchOffLang | undefined, line: string, extra: readonly string[]): LineHit[] {
  const out: LineHit[] = []
  const comment = lang !== undefined && commentLine(line, lang)
  for (const t of defs) {
    if (t.where === 'code' && comment) continue
    if (t.unless?.test(line) === true) continue
    const m = t.re.exec(line)
    if (m !== null) out.push({ token: t.id(m), rules: ruleIds(t.rules?.(line, m) ?? []) })
  }
  for (const x of extra) if (holdsLiteral(line, x)) out.push({ token: `extra:${x}`, rules: [] })
  return out
}

// One line's switch-offs: the file's language's tokens (the test-only ones in test files), then each of
// the repo's own tokens as `extra:<literal>`; each token once, in table order.
export function lineSwitchOffs(file: string, text: string, extra: readonly string[]): LineHit[] {
  return lineHits(tokensFor(file), langOf(file), text, extra)
}

export function switchOffKey(s: Pick<SwitchOff, 'token' | 'file' | 'snippet'>): string {
  return createHash('sha256').update(JSON.stringify(['switch-off', s.token, s.file, s.snippet])).digest('hex').slice(0, 16)
}

// Every switch-off on every line of `text`, read as `file`, in line order.
export function scanText(file: string, text: string, extra: readonly string[]): SwitchOff[] {
  const defs = tokensFor(file)
  const lang = langOf(file)
  const test = isTestPath(file)
  return text.split('\n').flatMap((line, i) => lineHits(defs, lang, line, extra).map((h) =>
    ({ token: h.token, file, line: i + 1, snippet: normalizeSnippet(line), rules: h.rules, test })))
}

const BINARY_PROBE = 8_000
const binary = (b: Buffer): boolean => b.subarray(0, BINARY_PROBE).includes(0)

const read = (abs: string): Buffer | undefined => {
  try {
    return readFileSync(abs)
  } catch {
    return undefined
  }
}

// Whether any token that applies to `file` appears anywhere in it. No pattern hangs on a line anchor, so
// a miss on the whole text is a miss on every line: such a file costs no git call.
const mayHold = (file: string, text: string, extra: readonly string[]): boolean =>
  tokensFor(file).some((t) => t.re.test(text)) || extra.some((x) => x.length > 0 && text.includes(x))

// One file's switch-offs beyond the base's, or none where it is no regular text file.
function fileOffs(wt: string, base: string, file: string, extra: readonly string[]): SwitchOff[] {
  const abs = join(wt, file)
  if (lstatListed(abs)?.isFile() !== true) return []
  const bytes = read(abs)
  if (bytes === undefined || binary(bytes)) return []
  const text = bytes.toString('utf8')
  if (!mayHold(file, text, extra)) return []
  const was = gitBlob(wt, base, file)
  const held = new Map<string, number>()
  for (const s of scanText(file, was === undefined || binary(was) ? '' : was.toString('utf8'), extra)) {
    const k = switchOffKey(s)
    held.set(k, (held.get(k) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return scanText(file, text, extra).filter((s) => {
    const k = switchOffKey(s)
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    return n > (held.get(k) ?? 0)
  })
}

// `files` is the plan's change set (PC), `base` its base commit: per key, the copies beyond the base's —
// the last ones, as `newDiagnostics` takes — files sorted, each in its line order.
export function planSwitchOffs(wt: string, base: string, files: readonly string[], extra: readonly string[]): SwitchOff[] {
  return [...files].sort().flatMap((f) => fileOffs(wt, base, f, extra))
}
