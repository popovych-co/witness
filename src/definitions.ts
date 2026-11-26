import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { entryAt, foldOverlay } from './cf-tree.js'
import { globToRegExp } from './glob.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { execFileSync } from './spawn.js'
import { visible } from './toon.js'

// Row 277. The files a repo uses to define its checks (spec §3.7): `checks.definitions` lists them,
// and the implement and ship gates fold the base's copy of each one a plan modified or deleted back
// into the plan's tree, to see what the plan's own definitions hide (the lint effect, §4 T3).

// One entry: a repo path or glob, and optionally one top-level member of a JSON object
// (`package.json#scripts`), restored on its own so the plan's other edits to the file stand.
export interface DefinitionEntry { glob: string; member?: string }

// Row 277 (settled point 3). Lint and format configs, `tsconfig*`, package.json scripts, `.gitignore`
// and its kin, test-runner and mutation configs, and the Rust, Python and Go linters' own files.
// TOML sections (`Cargo.toml [lints]`) wait for a consumer to probe; setup files are code.
export const DEFAULT_DEFINITIONS: readonly string[] = [
  '.gitignore', '.eslintignore', '.prettierignore', '.editorconfig', 'biome.json', 'biome.jsonc',
  'eslint.config.*', '.eslintrc*', 'prettier.config.*', '.prettierrc*', 'tsconfig*.json', 'jsconfig*.json',
  'package.json#scripts', 'vitest.config.*', 'vitest.workspace.*', 'jest.config.*', 'playwright.config.*',
  'stryker.config.*', 'stryker.conf.*', 'clippy.toml', '.clippy.toml', 'rustfmt.toml', '.rustfmt.toml',
  'ruff.toml', '.ruff.toml', '.golangci.*',
]

const GLOB_RE = /^[A-Za-z0-9._*@+/-]{1,200}$/
const MEMBER_RE = /^[A-Za-z0-9_.@-]{1,100}$/

// An entry as the setting holds it, or undefined outside its rules: the glob's characters and
// length, never a leading `/`, no empty, `.` or `..` segment, and at most one `#member`.
export function definitionEntry(raw: string): DefinitionEntry | undefined {
  const at = raw.indexOf('#')
  const glob = at < 0 ? raw : raw.slice(0, at)
  const member = at < 0 ? undefined : raw.slice(at + 1)
  if (!GLOB_RE.test(glob) || glob.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return undefined
  if (member === undefined) return { glob }
  return MEMBER_RE.test(member) ? { glob, member } : undefined
}

const matcher = new Map<string, RegExp>()
const regexOf = (glob: string): RegExp => {
  let re = matcher.get(glob)
  if (re === undefined) matcher.set(glob, (re = globToRegExp(glob)))
  return re
}

// The first entry naming `path`: one without a `/` reads the basename at any depth, one with a `/`
// the whole path from the root.
export function definitionFor(entries: readonly DefinitionEntry[], path: string): DefinitionEntry | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return entries.find((e) => regexOf(e.glob).test(e.glob.includes('/') ? path : base))
}

// An ignore file (`.gitignore`, `.prettierignore`, …) can only hide: an added one is removed from
// the tree the base's definitions see.
export const isIgnoreFile = (path: string): boolean => /^\.[a-z]+ignore$/.test(path.slice(path.lastIndexOf('/') + 1))

// ── The member splice ────────────────────────────────────────────────────────────────────────

// The byte span of the value of the LAST top-level `member` of the JSON object `text` (JSON.parse
// keeps the last of a duplicated key), or undefined where the scanner cannot walk the text. A
// minimal scanner: strings with their escapes, and nesting depth inside a value.
function memberSpan(text: string, member: string): [number, number] | undefined {
  const n = text.length
  let i = 0
  const ws = () => { while (i < n && /\s/.test(text[i]!)) i++ }
  const str = (): string | undefined => {
    const from = i++
    while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (i >= n) return undefined
    return text.slice(from, ++i)
  }
  const value = (): [number, number] | undefined => {
    ws()
    const from = i
    if (text[i] === '"') return str() === undefined ? undefined : [from, i]
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0
      while (i < n) {
        const c = text[i]!
        if (c === '"') { if (str() === undefined) return undefined; continue }
        if (c === '{' || c === '[') depth++
        else if (c === '}' || c === ']') { depth--; if (depth === 0) return [from, ++i] }
        i++
      }
      return undefined
    }
    while (i < n && !/[,}\]\s]/.test(text[i]!)) i++
    return i > from ? [from, i] : undefined
  }
  ws()
  if (text[i] !== '{') return undefined
  i++
  let found: [number, number] | undefined
  for (;;) {
    ws()
    if (text[i] === '}') return found
    if (text[i] !== '"') return undefined
    const raw = str()
    if (raw === undefined) return undefined
    let key: unknown
    try { key = JSON.parse(raw) } catch { return undefined }
    ws()
    if (text[i] !== ':') return undefined
    i++
    const span = value()
    if (span === undefined) return undefined
    if (key === member) found = span
    ws()
    if (text[i] === ',') { i++; continue }
    return text[i] === '}' ? found : undefined
  }
}

const jsonObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const val: unknown = JSON.parse(text)
    return val !== null && typeof val === 'object' && !Array.isArray(val) ? val as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

// The plan's file with the base's text of `member` in place of its own, or inserted first in the
// plan's own spacing where the plan's object lacks it (slice 1 review I3: a script removed with its
// member is as hidden as one rewritten); every other byte stays the plan's. Undefined unless both
// parse as JSON objects and the base holds the member.
export function spliceMember(plan: string, base: string, member: string): string | undefined {
  const p = jsonObject(plan)
  const b = jsonObject(base)
  if (p === undefined || b === undefined || !hasOwn(b, member)) return undefined
  const bs = memberSpan(base, member)
  if (bs === undefined) return undefined
  const value = base.slice(bs[0], bs[1])
  if (!hasOwn(p, member)) {
    const open = plan.indexOf('{')
    const ws = /^\s*/.exec(plan.slice(open + 1))![0]
    const rest = plan.slice(open + 1 + ws.length)
    const entry = `${JSON.stringify(member)}: ${value}`
    return rest.startsWith('}') ? `${plan.slice(0, open + 1)}${entry}${plan.slice(open + 1)}` : `${plan.slice(0, open + 1)}${ws}${entry},${ws || ' '}${rest}`
  }
  const ps = memberSpan(plan, member)
  if (ps === undefined) return undefined
  return plan.slice(0, ps[0]) + value + plan.slice(ps[1])
}

// A member value's identity: what a part's booking remembers of the base's definition.
const memberId = (val: unknown): string => `json:${createHash('sha256').update(JSON.stringify(val)).digest('hex').slice(0, 16)}`

// ── What a plan restores ─────────────────────────────────────────────────────────────────────

// One definition the effect tree takes from the base. `held` is the base side's identity: its blob
// sha, `json:<16 hex>` of the base member's value, or null for an added ignore file removed.
export interface Restored { path: string; how: 'base' | 'removed' | 'member'; member?: string; held: string | null }

export const restoredName = (r: Restored): string => (r.member === undefined ? r.path : `${r.path}#${r.member}`)

const REGULAR = /^100(?:644|755)$/

// `lstatListed`'s rule (src/change-set.ts), kept here off that module's import graph: a path under
// what is now a file is as absent as a missing one.
function lstatAt(abs: string): Stats | undefined {
  try {
    return lstatSync(abs, { throwIfNoEntry: false })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
    throw e
  }
}

function gitOut(root: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: root, input: input ?? '', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' },
  })
}

const blobText = (root: string, sha: string): string => gitOut(root, ['cat-file', 'blob', sha])
const regularAt = (root: string, tree: string, path: string) => {
  const e = entryAt(root, tree, path)
  return e !== undefined && e.type === 'blob' && REGULAR.test(e.mode) ? e : undefined
}

// The definitions a plan's change set takes back from the base, sorted by name. Per changed path,
// the first entry naming it decides, and only a base path holding a regular file is ever restored
// (a base symlink or submodule never is):
// - a whole-file entry restores the base's file where the plan modified it, replaced it with a
//   symlink, or deleted it while its tree still tracks a path in the file's folder (a package removed
//   whole hides nothing);
// - a member entry restores the base's member where the plan's value differs or the plan's object
//   lacks it; a member file either side cannot read as a JSON object (a BOM, comments, a plan's
//   broken copy) falls back to the whole-file rule, so it never voids the other restores (slice 1
//   review I1); a member only the plan holds is the plan's own;
// - an ignore file the base lacks is removed (it can only hide); any other added definition stays
//   as the plan wrote it. A directory at a definition path is never folded.
// Refuses only when git itself cannot read the base or a file.
export function restorable(
  root: string, wt: string, base: string, files: readonly string[], entries: readonly DefinitionEntry[],
): Result<Restored[]> {
  if (entries.length === 0) return ok([])
  const out: Restored[] = []
  try {
    const changed = new Set(files)
    for (const path of [...changed].sort()) {
      const entry = definitionFor(entries, path)
      if (entry === undefined) continue
      const st = lstatAt(join(wt, path))
      if (st?.isDirectory() === true) continue
      const theirs = entryAt(root, base, path)
      if (theirs === undefined) {
        if (st !== undefined && entry.member === undefined && isIgnoreFile(path)) out.push({ path, how: 'removed', held: null })
        continue
      }
      if (theirs.type !== 'blob' || !REGULAR.test(theirs.mode)) continue
      const whole: Restored = { path, how: 'base', held: theirs.sha }
      if (st === undefined) { if (folderTracked(root, wt, base, path, changed)) out.push(whole); continue }
      if (!st.isFile()) { out.push(whole); continue }
      const modified = () => gitOut(wt, ['hash-object', '--', path]).trim() !== theirs.sha
      if (entry.member === undefined) { if (modified()) out.push(whole); continue }
      const planText = readFileSync(join(wt, path), 'utf8')
      const baseText = blobText(root, theirs.sha)
      const p = jsonObject(planText)
      const b = jsonObject(baseText)
      if (p === undefined || b === undefined) { if (modified()) out.push(whole); continue }
      if (!hasOwn(b, entry.member)) continue
      if (hasOwn(p, entry.member) && JSON.stringify(p[entry.member]) === JSON.stringify(b[entry.member])) continue
      if (spliceMember(planText, baseText, entry.member) === undefined) { out.push(whole); continue }
      out.push({ path, how: 'member', member: entry.member, held: memberId(b[entry.member]) })
    }
  } catch (e) {
    return refuse([v('definitions', 'definition-unreadable', visible(String((e as Error).message ?? e)).slice(0, 200), 'definition files git can read')])
  }
  return ok(out.sort((a, b) => (restoredName(a) < restoredName(b) ? -1 : restoredName(a) > restoredName(b) ? 1 : 0)))
}

// Whether the plan's tree still tracks a path in the folder of the deleted `path`: the base's paths
// there, minus changed paths gone from the worktree, plus changed paths present in it.
function folderTracked(root: string, wt: string, base: string, path: string, changed: ReadonlySet<string>): boolean {
  const at = path.lastIndexOf('/')
  const folder = at < 0 ? '' : path.slice(0, at + 1)
  const under = (p: string) => p !== path && p.startsWith(folder)
  const present = (p: string) => lstatAt(join(wt, p)) !== undefined
  const baseHeld = gitOut(root, ['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', base, '--', ...(folder ? [folder] : [])])
    .split('\0').filter((p) => p !== '' && under(p))
  if (baseHeld.some((p) => !changed.has(p) || present(p))) return true
  return [...changed].some((p) => under(p) && present(p))
}

// The plan's tree with each restored definition taken from the base: a `base` path as the base holds
// it, a `removed` one gone, a `member` file the plan's own bytes with the base's member spliced in.
export function effectTree(root: string, base: string, planTree: string, restored: readonly Restored[]): Result<string> {
  const blobs: Array<{ path: string; mode: string; sha: string }> = []
  try {
    for (const r of restored) {
      if (r.how !== 'member') continue
      const mine = regularAt(root, planTree, r.path)
      const theirs = regularAt(root, base, r.path)
      const spliced = mine && theirs ? spliceMember(blobText(root, mine.sha), blobText(root, theirs.sha), r.member!) : undefined
      if (mine === undefined || spliced === undefined) {
        return refuse([v(r.path, 'definition-unreadable', 'its member could not be spliced', 'a JSON object on both sides')])
      }
      blobs.push({ path: r.path, mode: mine.mode, sha: gitOut(root, ['hash-object', '-w', '--stdin'], spliced).trim() })
    }
  } catch (e) {
    return refuse([v('definitions', 'definition-unreadable', visible(String((e as Error).message ?? e)).slice(0, 200), 'definition files git can read')])
  }
  const paths = restored.filter((r) => r.how !== 'member').map((r) => r.path)
  return foldOverlay(root, planTree, { from: base, paths, blobs })
}

// Row 280 (§4 T4). `tree` with the base's member in place for every member definition
// (`package.json#scripts`): each file a member entry names that differs between `base` and `tree`,
// a regular JSON object on both sides with the base holding the member, takes the base's member
// (`spliceMember`, inserted where the tree's object lacks it); every other byte stays the tree's.
// One the splice cannot read takes the base's whole file. A
// guard's command (`ship.test`, a reader) runs through the base's script indirection this way, never
// one the plan or the guard's overlay rewrote. An unchanged tree returns itself.
export function withBaseScripts(root: string, base: string, tree: string, entries: readonly DefinitionEntry[]): Result<string> {
  const members = entries.filter((e) => e.member !== undefined)
  if (members.length === 0) return ok(tree)
  const blobs: Array<{ path: string; mode: string; sha: string }> = []
  try {
    const changed = gitOut(root, ['diff-tree', '-r', '--no-renames', '--name-only', '-z', base, tree]).split('\0').filter((p) => p !== '')
    for (const path of changed) {
      const e = definitionFor(members, path)
      if (e === undefined) continue
      const theirs = regularAt(root, base, path)
      if (theirs === undefined) continue
      const mine = regularAt(root, tree, path)
      const spliced = mine !== undefined ? spliceMember(blobText(root, mine.sha), blobText(root, theirs.sha), e.member!) : undefined
      // Security review: a file the splice cannot read (a BOM, comments, a link or a deletion in
      // the tree) takes the base's whole file, as `restorable` falls back — a package manager may
      // read what JSON.parse refuses, so the tree's bytes would hand the command the plan's scripts.
      if (spliced === undefined) {
        if (mine?.sha !== theirs.sha) blobs.push({ path, mode: theirs.mode, sha: theirs.sha })
        continue
      }
      const sha = gitOut(root, ['hash-object', '-w', '--stdin'], spliced).trim()
      if (sha !== mine!.sha) blobs.push({ path, mode: mine!.mode, sha })
    }
  } catch (e) {
    return refuse([v('definitions', 'definition-unreadable', visible(String((e as Error).message ?? e)).slice(0, 200), 'definition files git can read')])
  }
  if (blobs.length === 0) return ok(tree)
  return foldOverlay(root, tree, { from: tree, paths: [], blobs })
}

// Whether `tree` holds every base-side identity in `defs` (restored names → `held`): the merge stamp
// reads a loosened part's booking closed once main holds the base's definitions again. Undefined
// when git cannot read the tree.
export function defsHeld(root: string, tree: string, defs: Readonly<Record<string, string | null>>): boolean | undefined {
  try {
    if (gitOut(root, ['cat-file', '-t', tree]).trim() === '') return undefined
  } catch {
    return undefined
  }
  try {
    for (const [name, held] of Object.entries(defs)) {
      const member = held?.startsWith('json:') ? name.slice(name.lastIndexOf('#') + 1) : undefined
      const path = member === undefined ? name : name.slice(0, name.lastIndexOf('#'))
      const e = entryAt(root, tree, path)
      if (held === null) { if (e !== undefined) return false; continue }
      if (e === undefined || e.type !== 'blob' || !REGULAR.test(e.mode)) return false
      if (member === undefined) { if (e.sha !== held) return false; continue }
      const o = jsonObject(blobText(root, e.sha))
      if (o === undefined || !hasOwn(o, member) || memberId(o[member]) !== held) return false
    }
    return true
  } catch {
    return undefined
  }
}
