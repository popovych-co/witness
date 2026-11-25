import { join } from 'node:path'
import { isId } from './dsl.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { withScratch } from './scratch.js'
import { execFileSync } from './spawn.js'
import { visible } from './toon.js'

// Row 258. The trees a scratch run checks out. A commit runs as itself. A bare tree (an overlay's
// fold now, a reviewed tree in T4a) is wrapped in a commit with a fixed identity and date, so one
// tree always wraps to one commit, and pinned at refs/witness/cf/<plan>/<tree> until the merge
// stamp drops the plan's refs. Refs are per (plan, tree), never per round: nothing finds, keeps or
// drops one by its round. Pinned, a tree outlives `gc --prune=now` (probe t2b-cf-git.sh).

export const CF_REF_PREFIX = 'refs/witness/cf/'

const MAX_BUFFER = 256 * 1024 * 1024
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

// The wrapper commit's identity: never the user's, never signed, never dated now.
const WRAP_ENV = {
  GIT_AUTHOR_NAME: 'witness', GIT_AUTHOR_EMAIL: 'witness@local', GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'witness', GIT_COMMITTER_EMAIL: 'witness@local', GIT_COMMITTER_DATE: '@0 +0000',
}

function git(root: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync('git', args, {
    cwd: root, input: opts.input ?? '', env: { ...(opts.env ?? process.env), LC_ALL: 'C' }, encoding: 'utf8',
    maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'],
  }).replace(/\n$/, '')
}

// git's last stderr line, printable, for a refusal's got.
function gitWhy(e: unknown): string {
  const err = e as { stderr?: Buffer | string; message?: string }
  const text = String(err.stderr || err.message || e).trim().split('\n').filter((l) => l.trim() !== '').at(-1) ?? 'git failed'
  return visible(text).slice(0, 200)
}

// A full sha the repo holds as a commit or a tree; anything else (a blob, a name, a short sha) is
// undefined, so a caller never runs a tree it did not name exactly.
export function objectType(root: string, sha: string): 'commit' | 'tree' | undefined {
  if (!SHA_RE.test(sha)) return undefined
  try {
    const t = git(root, ['cat-file', '-t', sha])
    return t === 'commit' || t === 'tree' ? t : undefined
  } catch {
    return undefined
  }
}

const treeOf = (root: string, sha: string): string | undefined =>
  objectType(root, sha) === undefined ? undefined : git(root, ['rev-parse', '--verify', `${sha}^{tree}`])

// Row 277. `blobs` are files no tree holds yet (a spliced package.json), folded after `paths`.
export interface CfOverlay { from: string; paths: string[]; blobs?: Array<{ path: string; mode: string; sha: string }> }

// A repo-relative file path: no empty, `.` or `..` segment, not absolute, no NUL.
const pathOk = (p: string): boolean =>
  p !== '' && !p.includes('\0') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p)
  && p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')

// One entry of `tree` at exactly `path`, read with literal pathspecs so `*` or `[` is a character.
export function entryAt(root: string, tree: string, path: string): { mode: string; type: string; sha: string } | undefined {
  const out = git(root, ['--literal-pathspecs', 'ls-tree', '-z', tree, '--', path])
  for (const rec of out.split('\0')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(rec)
    if (m && m[4] === path) return { mode: m[1]!, type: m[2]!, sha: m[3]! }
  }
  return undefined
}

// The tree of `base` with each listed path as `overlay.from` holds it, a path `from` lacks removed,
// every other path as `base` holds it — `snapshotTree`'s technique (src/snapshot.ts): a throwaway
// index, every removal before every add, one write-tree.
export function foldOverlay(root: string, base: string, overlay: CfOverlay): Result<string> {
  const bad = overlay.paths.find((p) => typeof p !== 'string' || !pathOk(p))
  if (bad !== undefined) {
    return refuse([v('overlay', 'invalid', visible(String(bad)), 'repo-relative file paths without empty, . or .. segments')])
  }
  const blobs = overlay.blobs ?? []
  const badBlob = blobs.find((b) => typeof b.path !== 'string' || !pathOk(b.path) || !/^100(?:644|755)$/.test(b.mode) || !SHA_RE.test(b.sha))
  if (badBlob !== undefined) {
    return refuse([v('overlay', 'invalid', visible(String(badBlob.path)), 'blobs at repo-relative file paths, each a regular mode and a full sha')])
  }
  const baseTree = treeOf(root, base)
  if (baseTree === undefined) return refuse([v('tree', 'tree-unknown', visible(base), 'a full commit or tree sha this repo holds')])
  const fromTree = treeOf(root, overlay.from)
  if (fromTree === undefined) {
    return refuse([v('overlay.from', 'tree-unknown', visible(overlay.from), 'a full commit or tree sha this repo holds')])
  }
  try {
    const removals: string[] = []
    const adds: string[] = []
    for (const path of [...new Set(overlay.paths)]) {
      const theirs = entryAt(root, fromTree, path)
      const ours = entryAt(root, baseTree, path)
      if (theirs?.type === 'tree' || ours?.type === 'tree') {
        return refuse([v('overlay', 'overlay-not-a-file', visible(path), 'file paths — a directory is overlaid by naming its files')])
      }
      removals.push(`0 ${'0'.repeat(baseTree.length)}\t${path}\0`)
      if (theirs !== undefined) adds.push(`${theirs.mode} ${theirs.sha}\t${path}\0`)
    }
    for (const b of blobs) {
      if (entryAt(root, baseTree, b.path)?.type === 'tree') {
        return refuse([v('overlay', 'overlay-not-a-file', visible(b.path), 'file paths — a directory is overlaid by naming its files')])
      }
      removals.push(`0 ${'0'.repeat(baseTree.length)}\t${b.path}\0`)
      adds.push(`${b.mode} ${b.sha}\t${b.path}\0`)
    }
    return withScratch('witness-cf-', (dir) => {
      const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
      git(root, ['read-tree', baseTree], { env })
      git(root, ['update-index', '-z', '--index-info'], { env, input: [...removals, ...adds].join('') })
      return ok(git(root, ['write-tree'], { env }))
    })
  } catch (e) {
    return refuse([v('overlay', 'overlay-fold', gitWhy(e), 'a tree git can build from the base and the overlay')])
  }
}

// The wrapper commit of `tree`, pinned at refs/witness/cf/<plan>/<tree>. Idempotent: one tree
// always wraps to the same commit, unsigned whatever the user's git config says.
export function pinTree(root: string, plan: string, tree: string): Result<string> {
  if (!isId(plan)) return refuse([v('plan', 'invalid', visible(String(plan)), 'a plan id — lowercase letters, digits and dashes')])
  if (objectType(root, tree) !== 'tree') return refuse([v('tree', 'tree-unknown', visible(tree), 'a full tree sha this repo holds')])
  try {
    const sha = git(root, ['commit-tree', '--no-gpg-sign', tree, '-m', 'witness scratch run'], { env: { ...process.env, ...WRAP_ENV } })
    git(root, ['update-ref', `${CF_REF_PREFIX}${plan}/${tree}`, sha])
    return ok(sha)
  } catch (e) {
    return refuse([v('tree', 'cf-pin-failed', gitWhy(e), 'a wrapper commit and its ref under refs/witness/cf/')])
  }
}

// Every ref under refs/witness/cf/<plan>/, each deleted against its old value. Best effort: a ref
// that moved or a git failure leaves it, and the next merge stamp of the plan never comes — a
// leftover ref only keeps its tree.
export function dropCfRefs(root: string, plan: string): void {
  if (!isId(plan)) return
  let listed: string
  try {
    listed = git(root, ['for-each-ref', '--format=%(refname) %(objectname)', `${CF_REF_PREFIX}${plan}/`])
  } catch {
    return
  }
  for (const line of listed.split('\n')) {
    const [ref, sha] = line.split(' ')
    if (!ref || !sha) continue
    try { git(root, ['update-ref', '-d', ref, sha]) } catch { /* best effort */ }
  }
}
