import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliAct, type Act } from './act.js'
import { seeWork } from './carry.js'
import { git, gitWith, tryGit } from './gitio.js'
import { isAlive } from './lock.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import { kv, shellWord, shellLine } from './toon.js'

// Row 247 (#92). verify-red's held work: the ref a run sets its non-test work aside in, what that
// ref records, and how it goes back. Moved out of evidence.ts so every verb that reads a plan's tree
// can put a crashed run's work back first (or refuse) through the same rules verify-red uses.

export function heldRef(planId: string): string {
  return `refs/witness/verify-red/${planId}`
}

// A held ref standing for the plan, read from any checkout of the repo (refs are shared). `record`
// is undefined when its message records no files (an older witness's, or a hand's).
export interface StandingHeld { ref: string; sha: string; record?: HeldRecord }
export function standingHeld(cwd: string, planId: string): StandingHeld | undefined {
  const ref = heldRef(planId)
  const r = tryGit(cwd, 'rev-parse', '--verify', '-q', ref)
  if (!r.ok) return undefined
  const sha = r.out.trim()
  const record = heldRecord(cwd, sha)
  return { ref, sha, ...(record !== undefined ? { record } : {}) }
}

// The `held-work:` line a put-back prints: the ref and the paths back (at most 12, then `(+N more)`),
// naming the checkout when the put-back wrote into one other than the caller's.
export function heldWorkLine(ref: string, paths: readonly string[], where?: string): string {
  const shown = paths.slice(0, 12).map((p) => shellWord(p))
  const more = paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : ''
  return kv('held-work', `${ref} — the non-test work a crashed verify-red set aside is back in ${where === undefined ? 'the tree' : shellWord(where)}: `
    + `${shown.join(' · ')}${more} — re-read before editing`)
}

export const inCommit = (runRoot: string, ref: string, rel: string): boolean =>
  tryGit(runRoot, 'cat-file', '-e', `${ref}:${rel}`).ok

// S1-C (row 243, #86; was final review F1). verify-red sets the plan's non-test work aside while the
// red runs, and nothing of it lands on git's shared stash list: `refs/stash` is ONE list for every
// worktree of the repo, and witness's repo lock serializes only witness, so a session's own `git
// stash push` or `pop` between witness's push and drop made witness drop that session's entry or
// hand one plan's work to another checkout. The work is held instead in a stash-shaped commit built
// through scratch indexes — the real index and `refs/stash` are never written — and kept at
// `refs/witness/verify-red/<plan>` until it is back:
//   - its index commit (second parent) is HEAD with each path as the index holds it, or without it;
//   - its tree is that with each path the index tracks as the worktree holds it, or without it;
//   - its third parent, when there is one, holds the untracked paths' bytes.
// `git stash show -p` and `git stash apply` read it as a stash entry, so a human finds the work there
// too. Its message records the run (`heldRecord`): its process, the checkout, the base its red ran
// against, and every non-test path it set aside, so a later run that finds the ref left by a crash
// knows what to put back, where, and against what.
//
// Row 247 (decision 4). A commit is written whenever there are paths, even when nothing differs from
// HEAD (its tree is then HEAD's): the run still checks out base versions over committed work, and a
// crash there left no ref for anything to read — the plan's code was at the base with no trace.
export function holdWork(runRoot: string, planId: string, paths: readonly string[], untracked: ReadonlySet<string>, base: string): string {
  const head = git(runRoot, 'rev-parse', '--verify', 'HEAD^{commit}')
  const want = new Set(paths)
  // the index's own entries for the paths, read NUL-separated and matched exactly: a name is the
  // file's, never git's quoting of it nor a directory a pathspec would also match
  const staged = new Map<string, string>()
  for (const record of git(runRoot, '--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths).split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) 0\t([^]*)$/.exec(record)
    if (m !== null && want.has(m[3]!)) staged.set(m[3]!, `${m[1]},${m[2]},${m[3]}`)
  }
  const tracked = paths.filter((p) => staged.has(p))
  const others = paths.filter((p) => !staged.has(p) && untracked.has(p))
  // git stash names a fallback identity for its commits; so does this one, where none is set
  const ident: Record<string, string> = tryGit(runRoot, 'var', 'GIT_AUTHOR_IDENT').ok && tryGit(runRoot, 'var', 'GIT_COMMITTER_IDENT').ok ? {}
    : { GIT_AUTHOR_NAME: 'witness', GIT_AUTHOR_EMAIL: 'witness@verify-red', GIT_COMMITTER_NAME: 'witness', GIT_COMMITTER_EMAIL: 'witness@verify-red' }
  const commit = (tree: string, parents: string[], message: string): string =>
    gitWith(runRoot, ident, 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message)
  const dir = mkdtempSync(join(tmpdir(), 'witness-verify-red-'))
  try {
    const scratch = (name: string): Record<string, string> => ({ GIT_INDEX_FILE: join(dir, name) })
    gitWith(runRoot, scratch('index'), 'read-tree', head)
    const entries = paths.flatMap((p) => (staged.has(p) ? ['--cacheinfo', staged.get(p)!] : []))
    if (entries.length) gitWith(runRoot, scratch('index'), 'update-index', '--add', ...entries)
    const unstaged = paths.filter((p) => !staged.has(p))
    if (unstaged.length) gitWith(runRoot, scratch('index'), 'update-index', '--force-remove', '--', ...unstaged)
    const indexTree = gitWith(runRoot, scratch('index'), 'write-tree')
    gitWith(runRoot, scratch('work'), 'read-tree', indexTree)
    if (tracked.length) gitWith(runRoot, scratch('work'), 'update-index', '--add', '--remove', '--', ...tracked)
    const workTree = gitWith(runRoot, scratch('work'), 'write-tree')
    const on = `verify-red ${planId}: the plan's non-test work, held while the red runs`
    const parents = [head, commit(indexTree, [head], `index on ${on}`)]
    if (others.length) {
      gitWith(runRoot, scratch('others'), 'update-index', '--add', '--', ...others)
      parents.push(commit(gitWith(runRoot, scratch('others'), 'write-tree'), [], `untracked files on ${on}`))
    }
    return commit(workTree, parents,
      `WIP on ${on}\n\npid: ${process.pid}\ncheckout: ${JSON.stringify(runRoot)}\nbase: ${JSON.stringify(base)}\nfiles: ${JSON.stringify(paths)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// What a held commit's message records, read from the raw commit so no configured encoding
// re-spells a name: the holding run's process, the checkout it set the work aside in (its
// `--show-toplevel`, as JSON), the base its red ran against (row 247; a 0.30.0 record has none), and
// the paths it set aside. A ref that records no paths — written by an older witness's `git stash
// push`, or by a hand — reads as nothing.
export interface HeldRecord { pid?: number; checkout?: string; base?: string; files: string[] }
function heldRecord(runRoot: string, held: string): HeldRecord | undefined {
  const raw = tryGit(runRoot, 'cat-file', 'commit', held)
  const start = raw.ok ? raw.out.indexOf('\n\n') : -1
  if (start < 0) return undefined
  const lines = raw.out.slice(start + 2).split('\n')
  const json = (key: string): unknown => {
    const line = lines.find((l) => l.startsWith(`${key}: `))
    if (line === undefined) return undefined
    try { return JSON.parse(line.slice(key.length + 2)) } catch { return undefined }
  }
  const files = json('files')
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) return undefined
  const pid = json('pid')
  const checkout = json('checkout')
  const base = json('base')
  return {
    files,
    ...(typeof pid === 'number' && Number.isInteger(pid) ? { pid } : {}),
    ...(typeof checkout === 'string' ? { checkout } : {}),
    ...(typeof base === 'string' ? { base } : {}),
  }
}

// The listed paths where the tree now holds something a crashed run did not leave. That run wrote
// only these: the held state itself (before its clear, or part way back), HEAD's version from its
// clear (the held commit's first parent), the base's from the red's tree, and a path taken away. A
// worktree file whose bytes, or an index entry whose mode and blob, are none of those is a
// session's since the crash, and putting the held work back over it would lose it. A directory where
// a listed file was, an unmerged entry, or anything git cannot read counts too. `undefined`: git
// could not read the tree at all.
function touchedSinceHeld(runRoot: string, held: string, files: readonly string[], base: string): string[] | undefined {
  const want = new Set(files)
  const untracked = tryGit(runRoot, 'rev-parse', '--verify', '-q', `${held}^3`).ok ? [`${held}^3`] : []
  const read = (rev: string): Map<string, TreeEntry> | undefined => {
    try { return treeEntries(runRoot, rev, want) } catch { return undefined }
  }
  const sides = (revs: string[]): Array<Map<string, TreeEntry>> | undefined => {
    const maps = revs.map(read)
    return maps.every((m) => m !== undefined) ? maps as Array<Map<string, TreeEntry>> : undefined
  }
  const indexSides = sides([`${held}^2`, `${held}^1`, base])
  const workSides = sides([held, ...untracked, `${held}^2`, `${held}^1`, base])
  if (indexSides === undefined || workSides === undefined) return undefined
  const listed = tryGit(runRoot, '--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...files)
  if (!listed.ok) return undefined
  const index = new Map<string, string>()
  for (const record of listed.out.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) ([0-3])\t([^]*)$/.exec(record)
    if (m !== null && want.has(m[4]!)) index.set(m[4]!, m[3] === '0' ? `${m[1]} ${m[2]}` : 'unmerged')
  }
  const kinds = new Map(files.map((p) => {
    try {
      const s = lstatSync(join(runRoot, p))
      return [p, s.isFile() || s.isSymbolicLink() ? 'file' : 'other'] as const
    } catch {
      return [p, 'absent'] as const
    }
  }))
  const present = files.filter((p) => kinds.get(p) === 'file')
  const hashed = present.length ? tryGit(runRoot, 'hash-object', '--', ...present) : { ok: true, out: '' }
  if (!hashed.ok) return undefined
  const blobs = new Map(present.map((p, i) => [p, hashed.out.split('\n')[i]]))
  return files.filter((p) => {
    const staged = index.get(p)
    const stagedKnown = staged === undefined
      || indexSides.some((side) => { const e = side.get(p); return e !== undefined && `${e.mode} ${e.sha}` === staged })
    const kind = kinds.get(p)
    const fileKnown = kind === 'absent' || (kind === 'file' && workSides.some((side) => side.get(p)?.sha === blobs.get(p)))
    return !stagedKnown || !fileKnown
  })
}

// `verify-red-pending` (exit 2; nothing is journaled): a held ref witness may neither put back nor
// overwrite. The row names the ref and how to see and restore it by hand; deleting it is a human's
// act, said in prose, never a runnable line (D168). `then` is the act to run once the work is back
// (row 247: the verb that met the ref). `where`: the checkout that set the work aside, when the holder
// is alive or the caller is in another checkout — `witness recover` puts it back there.
export function heldPending(planId: string, ref: string, why: string, then: Act, where?: string): Violation {
  const hand = `${seeWork(ref)}. To put it back by hand${where === undefined ? '' : ` in ${shellWord(where)}`}, `
    + `${shellLine(['git', 'stash', 'apply', ref])} brings back its worktree versions, and with --index its staged ones too, on a tree with `
    + `nothing else staged. Once the work is back, or a human decides it is not wanted, a human deletes ${ref} by hand (git update-ref -d); `
    + 'witness never does'
  return v(ref, 'verify-red-pending', `${ref} holds ${shellWord(planId)}'s non-test work a verify-red set aside — ${why} — so it was neither put back nor overwritten`,
    where === undefined ? `${hand}. Then ${then.line}`
      : `${cliAct('recover').line} puts it back into ${shellWord(where)} once nothing there changed since and the run that set it aside has ended — ${hand}`)
}

// A held ref is a run's that never put its work back. Witness never overwrites it. It puts the work
// back through the same path-by-path restore a run ends with, only into the checkout that set it
// aside (refs are every checkout's: from another one the put-back would write the plan's work into the
// wrong tree), only when the holding process is gone, and only when that tree holds nothing but what
// the run left (`touchedSinceHeld`, against the base the record names, else the caller's); the ref is
// then dropped against its own sha. Anything else refuses `verify-red-pending`, the tree and the ref
// untouched. It never takes the repo lock: its callers hold it. The paths put back, or the refusal.
export function putBackHeld(runRoot: string, planId: string, held: StandingHeld, base: string | undefined, then: Act): Result<string[]> {
  const { ref, sha, record } = held
  if (record === undefined) {
    return refuse([heldPending(planId, ref,
      'it lists no files (an older witness or a hand wrote it), so witness cannot tell what in the tree is the run\'s', then)])
  }
  if (record.checkout === undefined) {
    return refuse([heldPending(planId, ref, 'it does not record the checkout that set it aside, so witness cannot tell where it goes back', then)])
  }
  if (record.pid !== undefined && record.pid !== process.pid && isAlive(record.pid)) {
    return refuse([heldPending(planId, ref, `the verify-red that set it aside (pid ${record.pid}) is still running`, then, record.checkout)])
  }
  if (record.checkout !== runRoot) {
    return refuse([heldPending(planId, ref,
      `it was set aside in ${shellWord(record.checkout)}, and this run is in ${shellWord(runRoot)}`, then, record.checkout)])
  }
  const against = record.base ?? base
  if (against === undefined) return refuse([heldPending(planId, ref, 'it records no base and none could be resolved', then)])
  const touched = touchedSinceHeld(runRoot, sha, record.files, against)
  if (touched === undefined) return refuse([heldPending(planId, ref, 'git could not read the tree against it', then)])
  if (touched.length) {
    return refuse([heldPending(planId, ref,
      `the tree changed since that run stopped: ${touched.map((p) => shellWord(p)).join(', ')} hold versions it neither held nor wrote`, then)])
  }
  restoreHeld(runRoot, sha, record.files)
  git(runRoot, 'update-ref', '-d', ref, sha)
  return ok(record.files)
}

// The paths as HEAD holds them, in the index and in the worktree — what `git stash push --
// <paths>` left: HEAD's version checked out, and a path HEAD lacks taken out of the index and off
// the disk. It clears the work once it is held, and, when nothing was held, the red run's tree.
export function toHead(runRoot: string, paths: readonly string[]): void {
  const inHead = new Set(paths.filter((p) => inCommit(runRoot, 'HEAD', p)))
  const absent = paths.filter((p) => !inHead.has(p))
  if (inHead.size) git(runRoot, '--literal-pathspecs', 'checkout', 'HEAD', '--', ...inHead)
  if (absent.length) git(runRoot, 'update-index', '--force-remove', '--', ...absent)
  for (const p of absent) rmSync(join(runRoot, p), { force: true })
}

// The entries a tree holds at `paths`, matched exactly.
interface TreeEntry { mode: string; sha: string }
function treeEntries(runRoot: string, rev: string, paths: ReadonlySet<string>): Map<string, TreeEntry> {
  const found = new Map<string, TreeEntry>()
  for (const record of git(runRoot, 'ls-tree', '-r', '-z', '--full-tree', rev).split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([^]*)$/.exec(record)
    if (m !== null && paths.has(m[3]!)) found.set(m[3]!, { mode: m[1]!, sha: m[2]! })
  }
  return found
}

// The held work back exactly, path by path, over whatever the red run left there: each path's
// worktree bytes from the held tree (an untracked one's from its third parent) written through a
// scratch index, a path held in neither taken off the disk, and each index entry set as the held
// index commit has it, or removed. No merge runs, so nothing else the index stages or the worktree
// holds is touched — `git stash apply --index` resets the whole index to HEAD part way, and refuses
// whenever another path is staged.
export function restoreHeld(runRoot: string, held: string, paths: readonly string[]): void {
  const want = new Set(paths)
  const index = treeEntries(runRoot, `${held}^2`, want)
  const work = treeEntries(runRoot, held, want)
  const untracked = tryGit(runRoot, 'rev-parse', '--verify', '-q', `${held}^3`).ok
    ? treeEntries(runRoot, `${held}^3`, want) : new Map<string, TreeEntry>()
  const dir = mkdtempSync(join(tmpdir(), 'witness-verify-red-'))
  try {
    for (const [name, rev, entries] of [['work', held, work], ['untracked', `${held}^3`, untracked]] as const) {
      if (entries.size === 0) continue
      const scratch = { GIT_INDEX_FILE: join(dir, name) }
      gitWith(runRoot, scratch, 'read-tree', rev)
      gitWith(runRoot, scratch, 'checkout-index', '-f', '--', ...entries.keys())
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const p of paths) if (!work.has(p) && !untracked.has(p)) rmSync(join(runRoot, p), { force: true })
  const entries = paths.flatMap((p) => {
    const e = index.get(p)
    return e !== undefined ? ['--cacheinfo', `${e.mode},${e.sha},${p}`] : []
  })
  if (entries.length) git(runRoot, 'update-index', '--add', ...entries)
  const unstaged = paths.filter((p) => !index.has(p))
  if (unstaged.length) git(runRoot, 'update-index', '--force-remove', '--', ...unstaged)
  // the entries just set carry no stat data: refreshed, plumbing reads them as unchanged
  tryGit(runRoot, 'update-index', '-q', '--refresh')
}
