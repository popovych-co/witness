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
import { gitBlob, tryGitC } from './gitio.js'
import type { Ctx } from './cli.js'
import { parseReport, type RawDiagnostic } from './lint-readers.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { captureCommand } from './runner.js'
import type { ReaderTool } from './settings.js'
import { BIOME_LIST, biomePairs, pairKey } from './tolerated-lists.js'

// `tolerated`: a spot the tool's list holds (row 283) — never an error, read by the tolerated check,
// the guard and the lint effect only.
export interface Diagnostic { tool: ReaderTool; rule: string; file: string; line?: number; snippet: string; tolerated?: true }

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

// Row 283. A Biome `note` is a tolerated spot only at a (placed file, rule) pair the witness file
// lists (`pairs`); any other note is dropped. An ESLint raw its list holds is kept, flagged.
export function toDiagnostics(tool: ReaderTool, raw: readonly RawDiagnostic[], dir: string, pairs?: ReadonlySet<string>): Diagnostic[] {
  const own = new Set(witnessPaths())
  const cache = new Map<string, string[] | undefined>()
  const out: Diagnostic[] = []
  for (const r of raw) {
    const file = placeFile(dir, r.file, r.base)
    if (own.has(file)) continue
    if (r.note === true && !pairs?.has(pairKey(file, r.rule))) continue
    const snippet = normalizeSnippet(r.text ?? lineOnDisk(dir, file, r.line, cache))
    out.push({
      tool, rule: r.rule, file, ...(r.line !== undefined ? { line: r.line } : {}), snippet,
      ...(r.tolerated === true || r.note === true ? { tolerated: true as const } : {}),
    })
  }
  return out
}

// A reader's reading: its error diagnostics, the spots its tool's list tolerates (row 283), and how
// many errors it reported before witness's own paths were dropped (slice 3 review: a part red only
// on witness's payload reported errors all the same).
export interface PartReading { diagnostics: Diagnostic[]; tolerated: Diagnostic[]; reported: number }

// The run folder's witness file's pairs; missing or unreadable reads none.
function biomeFilePairs(dir: string): Set<string> {
  try {
    const p = join(dir, BIOME_LIST)
    return lstatSync(p).isFile() ? biomePairs(readFileSync(p, 'utf8')) : new Set()
  } catch {
    return new Set()
  }
}

// The reader run in `dir`, its whole stdout parsed; a signal saw no report (row 247).
export function readPart(dir: string, ctx: Ctx, tool: ReaderTool, cmd: string): Result<PartReading> {
  const c = captureCommand(dir, ctx, cmd)
  if (c.signal !== undefined) {
    return refuse([v(`readers.${tool}`, 'run-interrupted', `the reader was ended by ${c.signal} before it finished`,
      're-run it where nothing stops it before it ends — no report was read')])
  }
  const parsed = parseReport(tool, c.stdout, c.status)
  if (!parsed.ok) return parsed
  const all = toDiagnostics(tool, parsed.value, dir, tool === 'biome' ? biomeFilePairs(dir) : undefined)
  return ok({
    diagnostics: all.filter((d) => d.tolerated !== true),
    tolerated: all.filter((d) => d.tolerated === true),
    reported: parsed.value.filter((r) => r.tolerated !== true && r.note !== true).length,
  })
}

export function diagnosticKey(d: Diagnostic): string {
  return createHash('sha256').update(JSON.stringify([d.tool, d.rule, d.file, d.snippet])).digest('hex').slice(0, 16)
}

// Row 277. A hidden diagnostic's key (the lint effect, src/lint-effect.ts): a key space of its own,
// over the normalized line the effect tree holds, so the merge stamp finds it again in a merged tree.
export function loosenedKey(d: Pick<Diagnostic, 'tool' | 'rule' | 'file' | 'snippet'>): string {
  return createHash('sha256').update(JSON.stringify(['loosened', d.tool, d.rule, d.file, d.snippet])).digest('hex').slice(0, 16)
}

// Row 278 (§3.3). How many of `tree`'s lines of `file` (a tree or a commit) a booked hidden rule still
// finds: those whose `loosenedKey` — the item's tool and rule, the file, the line normalized — it books;
// a lineless (whole-file) key reads 1 while the tree holds the file. A file the tree lacks holds none —
// confirmed by `ls-tree` — and a read git fails reads undefined: observed nothing.
export function hiddenInTree(
  root: string, tree: string, file: string, tool: ReaderTool, rule: string, keys: ReadonlySet<string>, lineless: boolean,
): number | undefined {
  const listed = tryGitC(root, '--literal-pathspecs', 'ls-tree', '-z', tree, '--', file)
  if (!listed.ok) return undefined
  if (listed.out.trim() === '') return 0
  if (lineless) return 1
  const blob = gitBlob(root, tree, file)
  if (blob === undefined) return undefined
  return blob.toString('utf8').split(/\r?\n/)
    .filter((line) => keys.has(loosenedKey({ tool, rule, file, snippet: normalizeSnippet(line) }))).length
}

// Row 283. Per `diagnosticKey` of (tool, rule, file, a line normalized), how many of `tree`'s lines
// of `file` (a tree or a commit) give it — what a tolerated spot's key can still find there. A file
// the tree lacks holds none — confirmed by `ls-tree` — and a read git fails reads undefined.
export function lineKeys(root: string, tree: string, file: string, tool: ReaderTool, rule: string): Map<string, number> | undefined {
  const listed = tryGitC(root, '--literal-pathspecs', 'ls-tree', '-z', tree, '--', file)
  if (!listed.ok) return undefined
  const out = new Map<string, number>()
  if (listed.out.trim() === '') return out
  const blob = gitBlob(root, tree, file)
  if (blob === undefined) return undefined
  const lines = blob.toString('utf8').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop() // the final newline ends the last line, it starts none
  for (const line of lines) {
    const k = diagnosticKey({ tool, rule, file, snippet: normalizeSnippet(line) })
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
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
