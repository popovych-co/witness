import { existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitBlob, tryGit } from './gitio.js'
import { execFileSync } from './spawn.js'

// Row 186. What a gate's battery read, kept as a git tree so a later round can diff against
// it. Nothing reviewed is in the object database today: `blobOf` hashes without `-w` and
// `reviewed_sha` is a sha256 over (path, blob) pairs, not an object. The trees are
// unreachable — no ref pins them — so `git gc` prunes one after gc.pruneExpire, and the
// round that wanted it falls back to a full review.

const MAX_BUFFER = 256 * 1024 * 1024

function run(cwd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync('git', args, {
    cwd, input: opts.input ?? '', env: opts.env ?? process.env, encoding: 'utf8', maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).replace(/\n$/, '')
}

// One `--index-info` record per changed path, in `blobOf`'s branch order (src/reviewed.ts) —
// the one table to keep in step with it. The porcelain `update-index --add` cannot do this:
// an empty directory over a staged gitlink is fatal, and the trailing-slash form
// `ls-files --others` prints for a nested repo is silently ignored. `undefined` is a removal.
function indexRecord(runRoot: string, path: string): { mode: string; sha: string } | undefined {
  const abs = join(runRoot, path)
  const st = lstatSync(abs, { throwIfNoEntry: false })
  if (!st) return undefined
  if (st.isSymbolicLink()) return { mode: '120000', sha: run(runRoot, ['hash-object', '-w', '--stdin'], { input: readlinkSync(abs) }) }
  if (st.isFile()) return { mode: st.mode & 0o100 ? '100755' : '100644', sha: run(runRoot, ['hash-object', '-w', '--', path]) }
  if (existsSync(join(abs, '.git'))) {
    const inner = tryGit(abs, 'rev-parse', 'HEAD')
    if (inner.ok) return { mode: '160000', sha: inner.out }
  }
  const staged = tryGit(runRoot, 'ls-files', '--stage', '--', path)
  if (staged.ok && staged.out.startsWith('160000 ')) return { mode: '160000', sha: staged.out.split(/\s+/)[1]! }
  return undefined   // `blobOf`'s (non-file) marker: presence no diff can render
}

// base overlaid with the worktree's copy of each listed path · undefined on any git failure
export function snapshotTree(runRoot: string, base: string, files: readonly string[]): string | undefined {
  let dir: string | undefined
  try {
    const baseTree = run(runRoot, ['rev-parse', '--verify', `${base}^{tree}`])
    const zeros = '0'.repeat(baseTree.length)
    // Read against the REAL index before the throwaway one exists: a staged gitlink lives there.
    const records = [...new Set(files.map((f) => f.replace(/\/+$/, '')))].map((path) => ({ path, rec: indexRecord(runRoot, path) }))
    // Removals first, so a path that turned from a directory into a file (or back) never meets
    // its old self in the index.
    const lines = [
      ...records.filter((r) => r.rec === undefined).map((r) => `0 ${zeros}\t${r.path}\0`),
      ...records.flatMap((r) => (r.rec ? [`${r.rec.mode} ${r.rec.sha}\t${r.path}\0`] : [])),
    ]
    dir = mkdtempSync(join(tmpdir(), 'witness-snap-'))
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
    run(runRoot, ['read-tree', baseTree], { env })
    if (lines.length > 0) run(runRoot, ['update-index', '-z', '--index-info'], { env, input: lines.join('') })
    return run(runRoot, ['write-tree'], { env })
  } catch {
    return undefined
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

// a flat tree of named blobs (no '/' in a name) · undefined on any git failure
export function snapshotFiles(root: string, files: ReadonlyArray<{ name: string; content: string }>): string | undefined {
  try {
    const lines = files.map((f) => `100644 blob ${run(root, ['hash-object', '-w', '--stdin'], { input: f.content })}\t${f.name}\0`)
    return run(root, ['mktree', '-z'], { input: lines.join('') })
  } catch {
    return undefined
  }
}

export function treeReadable(root: string, tree: string): boolean {
  return tryGit(root, 'cat-file', '-e', `${tree}^{tree}`).ok
}

// Every path a tree holds, directories included, by its exact spelling.
export function treePaths(root: string, tree: string): string[] {
  return run(root, ['ls-tree', '-r', '-t', '--name-only', '-z', tree]).split('\0').filter((p) => p !== '')
}

export function changedPaths(root: string, from: string, to: string): string[] {
  return run(root, ['diff', '--name-only', '-z', '--no-renames', from, to]).split('\0').filter((p) => p !== '')
}

// The unified diff from → to. Its text joins a delta round's `prompts_sha`, so every knob a
// user's config or the repo's size can turn is pinned: prefixes against diff.noprefix and
// diff.mnemonicPrefix, full index shas against the auto-abbrev length that grows with the
// object count (a resume after it grew would miss its own key), and the hunk shape.
export function treeDiff(root: string, from: string, to: string): string {
  return run(root, [
    '-c', 'diff.suppressBlankEmpty=false', '-c', 'core.quotePath=true',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', '--full-index',
    '--diff-algorithm=myers', '--indent-heuristic', '-U3', '--inter-hunk-context=0',
    '--src-prefix=a/', '--dst-prefix=b/', from, to,
  ])
}

// exact bytes, utf8
export function blobText(root: string, tree: string, name: string): string | undefined {
  return gitBlob(root, tree, name)?.toString('utf8')
}
