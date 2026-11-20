import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { cliAct } from './act.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { spawnSync } from './spawn.js'
import { logSafe, shellLine, withheldOn, type Platform } from './toon.js'

// Row 243 (design §4.1.1). The carry: when the base moves, witness moves the plan's uncommitted
// work itself, where `git rebase --autostash` used to, so a clash re-applying it stays in the files
// and never lands on git's shared stash list. This module holds the git primitives the move is made
// of. Nothing here touches `refs/stash`: the work is captured with `git stash create` and put back
// with `git stash apply <sha>`, and it is kept between the two under witness's own refs.

// Witness's own rebase writes this as its reflog action, so step 0 tells it from a session's.
export const CARRY_ACTION = 'witness-carry'

// Sized like gitio.ts's runner: a diff or a stash apply's report can be large.
const GIT_MAX_BUFFER = 256 * 1024 * 1024

// git as the carry runs it: under the C locale, so the words read below (`CONFLICT`, "conflicts in
// index", a held lock) are git's untranslated ones, and with witness's reflog action. Both streams
// are kept: a clash's `CONFLICT` goes to stdout, "conflicts in index" to stderr. A git that could
// not start reads as `code: null`, with the reason on stderr.
export function carryGit(wt: string, ...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, {
    cwd: wt,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, LC_ALL: 'C', GIT_REFLOG_ACTION: CARRY_ACTION },
  })
  const failed = r.error !== undefined ? r.error.message : ''
  return { code: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${failed}` }
}

// The carry ref holds the captured work while the move is under way (step 4 to step 7): present
// means a move was interrupted and the work may not be in the tree.
export function carryRef(planId: string): string {
  return `refs/witness/carry/${planId}`
}

// A clash's backup: the carry moved here, numbered and never overwritten (step 7).
export function keptPrefix(planId: string): string {
  return `refs/witness/kept/${planId}/`
}

// Step 2 (P19). Every operation a session can leave half done, found where git keeps it for THIS
// worktree: `--git-path` answers a linked worktree's own git dir, never the primary checkout's.
export type OpInProgress = 'rebase-merge' | 'rebase-apply' | 'MERGE_HEAD' | 'CHERRY_PICK_HEAD' | 'REVERT_HEAD'
const OPERATIONS: readonly OpInProgress[] = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']

export function operationInProgress(wt: string): OpInProgress | undefined {
  return OPERATIONS.find((op) => {
    const r = carryGit(wt, 'rev-parse', '--git-path', op)
    return r.code === 0 && existsSync(resolve(wt, r.stdout.replace(/\n$/, '')))
  })
}

// One unmerged path and the blob each stage holds there: 1 the common base, 2 ours, 3 theirs. A
// side that deleted the file has no stage.
export interface UnmergedPath { path: string; stages: Partial<Record<1 | 2 | 3, string>> }

// Signal (a) of the guard (§4.1.2). Read NUL-separated, so a name is exactly the file's and never
// git's C-quoted spelling of it (P51).
export function unmergedPaths(wt: string): UnmergedPath[] {
  const r = carryGit(wt, 'ls-files', '-u', '-z')
  if (r.code !== 0) return []
  const byPath = new Map<string, UnmergedPath>()
  for (const record of r.stdout.split('\0')) {
    const m = /^\d+ ([0-9a-f]+) ([123])\t([^]*)$/.exec(record)
    if (m === null) continue
    const path = m[3]!
    const entry = byPath.get(path) ?? { path, stages: {} }
    entry.stages[Number(m[2]) as 1 | 2 | 3] = m[1]!
    byPath.set(path, entry)
  }
  return [...byPath.values()]
}

export interface KeptRef { ref: string; sha: string; files: string[] }

// The plan's kept refs, numbered ones in numeric order. A ref a human renamed inside the prefix is
// still the plan's backup and still listed, after them: only moving it out of `refs/witness/kept/`
// releases its files (§4.1.2 "The escape").
function keptNames(wt: string, planId: string): Array<{ ref: string; sha: string; n?: number }> {
  const prefix = keptPrefix(planId)
  const r = carryGit(wt, 'for-each-ref', '--format=%(objectname) %(refname)', prefix)
  if (r.code !== 0) return []
  const refs = r.stdout.split('\n').flatMap((line) => {
    const m = /^([0-9a-f]+) (.+)$/.exec(line)
    if (m === null || !m[2]!.startsWith(prefix)) return []
    const rest = m[2]!.slice(prefix.length)
    return [{ ref: m[2]!, sha: m[1]!, ...(/^\d+$/.test(rest) ? { n: Number(rest) } : {}) }]
  })
  return refs.sort((a, b) =>
    a.n !== undefined && b.n !== undefined ? a.n - b.n : a.n !== undefined ? -1 : b.n !== undefined ? 1 : a.ref < b.ref ? -1 : 1)
}

// The files a kept ref's message lists (`keepCarry`), read from the raw commit so no configured
// output encoding re-spells a name. A ref witness did not write lists none.
function keptFiles(wt: string, sha: string): string[] {
  const r = carryGit(wt, 'cat-file', 'commit', sha)
  if (r.code !== 0) return []
  const start = r.stdout.indexOf('\n\n')
  if (start < 0) return []
  const line = r.stdout.slice(start + 2).split('\n').find((l) => l.startsWith('files: '))
  if (line === undefined) return []
  try {
    const files: unknown = JSON.parse(line.slice('files: '.length))
    return Array.isArray(files) && files.every((f) => typeof f === 'string') ? files : []
  } catch {
    return []
  }
}

export function keptRefs(wt: string, planId: string): KeptRef[] {
  return keptNames(wt, planId).map(({ ref, sha }) => ({ ref, sha, files: keptFiles(wt, sha) }))
}

// Step 7's clash backup. The carry moves to the plan's next kept ref as a stash-shaped commit with
// the carry's own tree and parents, so `git stash apply --index <kept>` and `git stash show -p
// <kept>` read it as they read the carry. Its message lists the clashing files as JSON, each name as
// `ls-files -u -z` gave it. The ref is made create-only (`''` as the old value), so a backup is never
// overwritten. Only then is the carry ref deleted, and only while it still names this carry: a
// carry ref that moved is never dropped. Any failed step refuses `carry-pending`, naming the carry
// ref, which is kept.
export function keepCarry(wt: string, planId: string, carry: string, files: string[]): Result<string> {
  const ref = carryRef(planId)
  const pending = (step: string, out: string): Result<string> => refuse([v(ref, 'carry-pending',
    `${step} failed: ${logSafe(out.trim().slice(0, 200)) || 'git printed nothing'}`,
    `${ref} holds the plan's uncommitted work and is kept — see it with ${shellLine(['git', 'stash', 'show', '-p', ref])} beside `
      + `${shellLine(['git', 'diff', `${ref}^1`, `${ref}^2`])} (the staged versions); ${cliAct('ship', planId).line} finishes the move`)])
  const resolved = carryGit(wt, 'rev-parse', '--verify', '--quiet', `${carry}^{commit}`)
  const sha = resolved.stdout.trim()
  if (resolved.code !== 0 || sha === '') return pending(`reading the carry ${carry}`, resolved.stderr)
  const message = `witness kept ${planId}\n\nfiles: ${JSON.stringify(files)}`
  const made = carryGit(wt, 'commit-tree', `${sha}^{tree}`, '-p', `${sha}^1`, '-p', `${sha}^2`, '-m', message)
  const keptSha = made.stdout.trim()
  if (made.code !== 0 || keptSha === '') return pending('writing the kept commit', made.stderr)
  const n = Math.max(0, ...keptNames(wt, planId).flatMap((k) => (k.n !== undefined ? [k.n] : []))) + 1
  const kept = `${keptPrefix(planId)}${n}`
  const created = carryGit(wt, 'update-ref', kept, keptSha, '')
  if (created.code !== 0) return pending(`creating ${kept}`, created.stderr)
  const dropped = carryGit(wt, 'update-ref', '-d', ref, sha)
  if (dropped.code !== 0) return pending(`deleting ${ref} after ${kept} was made`, dropped.stderr)
  return ok(kept)
}

// S1-1, S1-2. The untracked files that sit where a move would write one of `paths`: at the path
// itself, under it (the path is a file and they need its directory), or above it (one of them is a
// file where the path needs a directory). In a witness worktree's sparse checkout `git rebase` and
// `git stash apply` silently replace such a file, where a plain checkout refuses, so the carry asks
// first: Task 3's rebase and every apply. Ignored files are git's own to replace, as everywhere. On
// a filesystem git was told is case-insensitive (`core.ignorecase`), `NOTES.md` is in the way of
// `notes.md`, so names are compared without case there. `undefined`: git could not list them, and
// the caller refuses rather than guess.
export function untrackedInTheWay(wt: string, paths: readonly string[]): string[] | undefined {
  if (paths.length === 0) return []
  const listed = carryGit(wt, 'ls-files', '-z', '--others', '--exclude-standard')
  if (listed.code !== 0) return undefined
  const ignoreCase = carryGit(wt, 'config', '--type=bool', '--get', 'core.ignorecase').stdout.trim() === 'true'
  const fold = (p: string): string => (ignoreCase ? p.normalize('NFC').toLowerCase() : p)
  const wanted = paths.map(fold)
  return listed.stdout.split('\0').filter((u) => u !== '').filter((u) => {
    const f = fold(u)
    return wanted.some((p) => f === p || f.startsWith(`${p}/`) || p.startsWith(`${f}/`))
  })
}

// §4.1.5 (S1-4, S1-7). Every git command a clash, carry or guard row names, as one line. A file name
// git would read as pathspec magic (`:x.md`) or a glob (`[x].md`, `*`, `?`, a backslash) runs with
// `--literal-pathspecs`, so the line names that file and no other: `git add -- :x.md` stages x.md.
// A line holding a name a terminal cannot show, or one Windows' shells read as more than text, is
// shown with why and never offered (`withheldOn`): pasted, its spelled-out name names another file.
const PATHSPEC_SPECIAL = /^:|[*?[\\]/
export function remedyLine(argv: readonly string[], platform: Platform = process.platform): string {
  const dash = argv.indexOf('--')
  const names = dash < 0 ? [] : argv.slice(dash + 1)
  const words = argv[0] === 'git' && names.some((n) => PATHSPEC_SPECIAL.test(n))
    ? ['git', '--literal-pathspecs', ...argv.slice(1)]
    : [...argv]
  const withheld = withheldOn(words, platform)
  const line = shellLine(words, platform)
  return withheld === undefined ? line : `${line} (${withheld})`
}
