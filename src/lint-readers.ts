// Row 262. A reader's stdout turned into error-severity diagnostics, per tool. Each format was
// probed on fewhats (2026-11-23, the probes beside the trust impl map): Biome 2.4.9's SARIF 2.1.0
// (`--reporter=sarif`: every result, an absolute `uri`, no region for `format`, no snippet),
// ESLint 10.8.0's `-f json` (an absolute `filePath`, severity 2 an error, a parse error
// `{ruleId: null, fatal: true}`, `source` on a file with messages) and tsc 6.0.3's `--pretty false`
// lines (files relative to the cwd). cargo's `--message-format=json` lines are built from cargo's
// documented message format, NOT probed (no cargo on the probing machine): wot's clippy is a human
// check (Windows), as rows 201, 223 and 258.
//
// Fails closed: a stdout that does not parse whole as the tool's report, or a red exit that
// reports no error, refuses `reader-unread` in witness's own words — never parsed loosely, never
// green. A warn-level diagnostic is never one (§4 T4).
//
// Row 283 (correction C47). Readers read through the tolerated lists: ESLint's `-f json` puts each
// spot its bulk-suppressions file holds in `suppressedMessages` with a `kind: 'file'` suppression
// (an inline disable is kind `directive`, never one), and Biome's SARIF reports each spot the
// witness file sets to `info` as a `note` — a candidate the run folder's witness file decides
// (src/diagnostics.ts). Neither is an error: the fail-closed rule counts errors only, and ESLint's
// exit 2 with a whole report (a list entry no longer occurring, probe Q5) is read.
import { READER_FORMATS, type ReaderTool } from './settings.js'
import { refuse, ok, v, type Result } from './refusal.js'

export interface RawDiagnostic {
  rule: string     // the tool's id; '' for none, '?' for one outside RULE_RE
  file: string     // as the report names it; '' for none
  line?: number    // 1-based
  text?: string    // the flagged line, when the report carries it
  base?: string    // cargo only: the folder its manifest sits in
  tolerated?: true // ESLint only: a spot its bulk-suppressions file holds (row 283)
  note?: true      // Biome only: a result at level `note`, tolerated where the witness file lists it (row 283)
}

export const RULE_RE = /^[A-Za-z0-9@/_.:-]{1,100}$/

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const posInt = (x: unknown): number | undefined => (Number.isInteger(x) && (x as number) >= 1 ? (x as number) : undefined)
const ruleOf = (x: unknown): string => (typeof x !== 'string' || x === '' ? '' : RULE_RE.test(x) ? x : '?')
const str = (x: unknown): string => (typeof x === 'string' ? x : '')
const lines = (s: string): string[] => s.split(/\r?\n/)

function diag(rule: string, file: string, line?: number, text?: string, base?: string, flag?: 'tolerated' | 'note'): RawDiagnostic {
  return {
    rule, file, ...(line !== undefined ? { line } : {}), ...(text !== undefined ? { text } : {}), ...(base !== undefined ? { base } : {}),
    ...(flag === 'tolerated' ? { tolerated: true as const } : flag === 'note' ? { note: true as const } : {}),
  }
}

// One JSON document, the whole stdout; undefined when it is not.
function jsonWhole(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim())
  } catch {
    return undefined
  }
}

// undefined: not a SARIF report.
function biome(stdout: string): RawDiagnostic[] | undefined {
  const doc = jsonWhole(stdout)
  if (!isObj(doc) || !Array.isArray(doc.runs)) return undefined
  const out: RawDiagnostic[] = []
  for (const run of doc.runs) {
    if (!isObj(run)) return undefined
    if (run.results === undefined) continue
    if (!Array.isArray(run.results)) return undefined
    for (const r of run.results) {
      if (!isObj(r)) return undefined
      const level = r.level ?? 'warning'
      if (level !== 'error' && level !== 'note') continue
      const loc = Array.isArray(r.locations) && isObj(r.locations[0]) ? r.locations[0] : {}
      const phys = isObj(loc.physicalLocation) ? loc.physicalLocation : {}
      const art = isObj(phys.artifactLocation) ? phys.artifactLocation : {}
      const region = isObj(phys.region) ? phys.region : {}
      const snippet = isObj(region.snippet) && typeof region.snippet.text === 'string' ? region.snippet.text : undefined
      out.push(diag(ruleOf(r.ruleId), str(art.uri), posInt(region.startLine), snippet, undefined, level === 'note' ? 'note' : undefined))
    }
  }
  return out
}

function eslint(stdout: string): RawDiagnostic[] | undefined {
  const doc = jsonWhole(stdout)
  if (!Array.isArray(doc)) return undefined
  const out: RawDiagnostic[] = []
  for (const res of doc) {
    if (!isObj(res) || typeof res.filePath !== 'string' || !Array.isArray(res.messages)) return undefined
    if (res.suppressedMessages !== undefined && !Array.isArray(res.suppressedMessages)) return undefined
    const source = typeof res.source === 'string' ? lines(res.source) : undefined
    const read = (m: Obj, flag?: 'tolerated') => {
      const rule = typeof m.ruleId === 'string' && m.ruleId !== '' ? ruleOf(m.ruleId) : m.fatal === true ? 'fatal' : ''
      const line = posInt(m.line)
      out.push(diag(rule, res.filePath as string, line, line !== undefined ? source?.[line - 1] : undefined, undefined, flag))
    }
    for (const m of res.messages) {
      if (!isObj(m)) return undefined
      if (m.severity === 2) read(m)
    }
    for (const m of (res.suppressedMessages ?? []) as unknown[]) {
      if (!isObj(m)) return undefined
      const byList = Array.isArray(m.suppressions) && m.suppressions.some((x) => isObj(x) && x.kind === 'file')
      if (m.severity === 2 && byList) read(m, 'tolerated')
    }
  }
  return out
}

// The folder a manifest path sits in, on either separator.
const folderOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '')

function clippy(stdout: string): RawDiagnostic[] | undefined {
  const out: RawDiagnostic[] = []
  for (const l of lines(stdout)) {
    if (l.trim() === '') continue
    let doc: unknown
    try {
      doc = JSON.parse(l)
    } catch {
      return undefined
    }
    if (!isObj(doc)) return undefined
    if (doc.reason !== 'compiler-message' || !isObj(doc.message)) continue
    const m = doc.message
    if (typeof m.level !== 'string' || !m.level.startsWith('error')) continue
    const spans = Array.isArray(m.spans) ? m.spans.filter(isObj) : []
    const span = spans.find((s) => s.is_primary === true) ?? spans[0]
    const code = isObj(m.code) ? m.code.code : undefined
    const base = typeof doc.manifest_path === 'string' ? folderOf(doc.manifest_path) : undefined
    if (span === undefined) {
      out.push(diag(ruleOf(code), '', undefined, undefined, base))
      continue
    }
    const first = Array.isArray(span.text) && isObj(span.text[0]) && typeof span.text[0].text === 'string' ? span.text[0].text : undefined
    out.push(diag(ruleOf(code), str(span.file_name), posInt(span.line_start), first, base))
  }
  return out
}

const TSC_AT = /^(.+)\((\d+),(\d+)\): error (TS\d+): /
const TSC_GLOBAL = /^error (TS\d+): /

// Every line is read; a line of neither form (a script banner, a continuation, a warning) is none.
function tsc(stdout: string): RawDiagnostic[] {
  const out: RawDiagnostic[] = []
  for (const l of lines(stdout)) {
    const at = TSC_AT.exec(l)
    if (at) {
      out.push(diag(ruleOf(at[4]), at[1]!, posInt(Number(at[2]))))
      continue
    }
    const global = TSC_GLOBAL.exec(l)
    if (global) out.push(diag(ruleOf(global[1]), ''))
  }
  return out
}

const READ: Readonly<Record<ReaderTool, (stdout: string) => RawDiagnostic[] | undefined>> = { biome, eslint, clippy, tsc }
const WHAT: Readonly<Record<ReaderTool, string>> = {
  biome: 'one SARIF 2.1.0 document',
  eslint: "one ESLint JSON report (an array of results)",
  clippy: 'one JSON object per line',
  tsc: 'diagnostic lines',
}

export function parseReport(tool: ReaderTool, stdout: string, exit: number | null): Result<RawDiagnostic[]> {
  const unread = (got: string) => refuse<RawDiagnostic[]>([v(`readers.${tool}`, 'reader-unread', got,
    `a command whose stdout is only ${READER_FORMATS[tool]} — readers.${tool} in witness.config.yaml`)])
  const found = READ[tool](stdout)
  if (found === undefined) return unread(`its stdout is not ${WHAT[tool]}`)
  const errors = found.filter((r) => r.tolerated !== true && r.note !== true).length
  if (exit !== 0 && errors === 0 && !(tool === 'eslint' && exit === 2)) {
    return unread(`it ${exit === null ? 'ended with no exit code' : `exited ${exit}`} and reported no error`)
  }
  return ok(found)
}
