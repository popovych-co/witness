// Row 262. A part's diagnostics on a tree: a reader's report placed in the tree it ran in and
// keyed by (tool, rule, file, normalized snippet), so the same diagnostic on the base and on the
// plan's tree is one key wherever each tree sits (the scratch, the plan's worktree, /var against
// /private/var). Compared on every file the reader reports, minus witness's own paths (correction
// C12): a change can raise a diagnostic in a file it never touched.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parentsInTree, witnessPaths } from './change-set.js'
import type { Ctx } from './cli.js'
import { parseReport, type RawDiagnostic } from './lint-readers.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { captureCommand } from './runner.js'
import type { ReaderTool } from './settings.js'

export interface Diagnostic { tool: ReaderTool; rule: string; file: string; line?: number; snippet: string }

// §3.7: whitespace runs collapsed, the ends trimmed — a re-indented line keeps its key.
export function normalizeSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300)
}

const slashes = (p: string): string => p.replaceAll('\\', '/')
const isAbs = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(p)
const trimEnd = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

// `p` relative to folder `d` when it lies under it; on win32 the prefix compares case-insensitively.
function under(d: string, p: string): string | undefined {
  const win = process.platform === 'win32'
  const [dd, pp] = win ? [d.toLowerCase(), p.toLowerCase()] : [d, p]
  if (pp === dd) return ''
  return pp.startsWith(`${dd}/`) ? p.slice(d.length + 1) : undefined
}

function roots(dir: string): string[] {
  const out = [trimEnd(slashes(dir))]
  try {
    const real = trimEnd(slashes(realpathSync(dir)))
    if (real !== out[0]) out.push(real)
  } catch { /* a folder that is gone places nothing by its real path */ }
  return out
}

const relIn = (dirs: readonly string[], p: string): string | undefined => {
  for (const d of dirs) {
    const r = under(d, p)
    if (r !== undefined && r !== '') return r
  }
  return undefined
}

// Settled point 5. A path witness cannot place stays as printed, never dropped: both trees print it alike.
export function placeFile(dir: string, file: string, base?: string): string {
  let f = file
  if (f.startsWith('file://')) {
    try {
      f = fileURLToPath(f)
    } catch {
      f = decodeURIComponent(f.slice('file://'.length))
    }
  }
  f = slashes(f)
  const dirs = roots(dir)
  if (!isAbs(f) && base !== undefined) {
    // a cargo span: relative to its manifest's folder or a folder above it, up to the run folder
    let at = trimEnd(slashes(base))
    for (;;) {
      const top = relIn(dirs, at) ?? (dirs.some((d) => under(d, at) === '') ? '' : undefined)
      if (top === undefined) break
      const rel = top === '' ? f : `${top}/${f}`
      if (existsSync(join(dirs[0]!, rel))) return rel.replace(/^(\.\/)+/, '')
      if (top === '') break
      at = at.slice(0, at.lastIndexOf('/'))
    }
  }
  if (isAbs(f)) return relIn(dirs, f) ?? f
  return f.replace(/^(\.\/)+/, '')
}

// The placed file's line from disk: a relative path with no `..` segment, reached through no
// linked parent, that is a regular file. Anything else reads ''.
function lineOnDisk(dir: string, file: string, line: number | undefined, cache: Map<string, string[] | undefined>): string {
  if (line === undefined || file === '' || isAbs(file) || file.split('/').includes('..')) return ''
  if (!cache.has(file)) {
    let lines: string[] | undefined
    try {
      if (parentsInTree(dir, file) && lstatSync(join(dir, file)).isFile()) lines = readFileSync(join(dir, file), 'utf8').split(/\r?\n/)
    } catch { /* unreadable: no snippet */ }
    cache.set(file, lines)
  }
  return cache.get(file)?.[line - 1] ?? ''
}

export function toDiagnostics(tool: ReaderTool, raw: readonly RawDiagnostic[], dir: string): Diagnostic[] {
  const own = new Set(witnessPaths())
  const cache = new Map<string, string[] | undefined>()
  const out: Diagnostic[] = []
  for (const r of raw) {
    const file = placeFile(dir, r.file, r.base)
    if (own.has(file)) continue
    const snippet = normalizeSnippet(r.text ?? lineOnDisk(dir, file, r.line, cache))
    out.push({ tool, rule: r.rule, file, ...(r.line !== undefined ? { line: r.line } : {}), snippet })
  }
  return out
}

// A reader's reading: its diagnostics, and how many errors it reported before witness's own paths
// were dropped (slice 3 review: a part red only on witness's payload reported errors all the same).
export interface PartReading { diagnostics: Diagnostic[]; reported: number }

// The reader run in `dir`, its whole stdout parsed; a signal saw no report (row 247).
export function readPart(dir: string, ctx: Ctx, tool: ReaderTool, cmd: string): Result<PartReading> {
  const c = captureCommand(dir, ctx, cmd)
  if (c.signal !== undefined) {
    return refuse([v(`readers.${tool}`, 'run-interrupted', `the reader was ended by ${c.signal} before it finished`,
      're-run it where nothing stops it before it ends — no report was read')])
  }
  const parsed = parseReport(tool, c.stdout, c.status)
  return parsed.ok ? ok({ diagnostics: toDiagnostics(tool, parsed.value, dir), reported: parsed.value.length }) : parsed
}

export function diagnosticKey(d: Diagnostic): string {
  return createHash('sha256').update(JSON.stringify([d.tool, d.rule, d.file, d.snippet])).digest('hex').slice(0, 16)
}

// Row 277. A hidden diagnostic's key (the lint effect, src/lint-effect.ts): a key space of its own,
// over the normalized line the effect tree holds, so the merge stamp finds it again in a merged tree.
export function loosenedKey(d: Pick<Diagnostic, 'tool' | 'rule' | 'file' | 'snippet'>): string {
  return createHash('sha256').update(JSON.stringify(['loosened', d.tool, d.rule, d.file, d.snippet])).digest('hex').slice(0, 16)
}

export function keyCounts(ds: readonly Diagnostic[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const d of ds) {
    const k = diagnosticKey(d)
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
}

// Per key, the plan's diagnostics beyond the base's count — the last ones of that key — in the
// plan's order. A multiset difference: one old spot swapped for one new spot of another key is new.
export function newDiagnostics(plan: readonly Diagnostic[], base: ReadonlyMap<string, number>): Diagnostic[] {
  const seen = new Map<string, number>()
  const out: Diagnostic[] = []
  for (const d of plan) {
    const k = diagnosticKey(d)
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    if (n > (base.get(k) ?? 0)) out.push(d)
  }
  return out
}
