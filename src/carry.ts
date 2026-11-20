import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { cliAct } from './act.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import { spawnSync } from './spawn.js'
import { logSafe, shellLine, shellWord, withheldOn, type Platform } from './toon.js'

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
  const pending = (step: string, out: string): Result<string> => refuse([carryPending(planId, `${step} failed: ${gitWords(out)}`)])
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

// git's own words in a refusal's cell: cut, and spelled out where they hold a control character.
function gitWords(out: string): string {
  return logSafe(out.trim().slice(0, 200)) || 'git printed nothing'
}

// `carry-pending` (exit 2): the move is unfinished and the carry ref holds the plan's work, kept. It
// shows the ref both ways — the worktree versions, and the staged ones beside them — and names
// `witness ship`, whose step 0 finishes the move.
export function carryPending(planId: string, got: string): Violation {
  const ref = carryRef(planId)
  return v(ref, 'carry-pending', got,
    `${ref} holds the plan's uncommitted work and is kept — see it with ${shellLine(['git', 'stash', 'show', '-p', ref])} beside `
      + `${shellLine(['git', 'diff', `${ref}^1`, `${ref}^2`])} (the staged versions); ${cliAct('ship', planId).line} finishes the move`)
}

// §4.1.5 (S1-3). A lock another git process holds, read first from git's own words (C locale), then
// from the lock files themselves: Apple's git words a held index lock at `stash create` and `stash
// apply` only as "could not write index". `locks` names them as `git rev-parse --git-path` resolves
// them, so a linked worktree's index lock and the shared carry ref's are each found where git keeps
// them. The path, or nothing.
const LOCK_WORDS = /Unable to create '([^'\n]+\.lock)': File exists/
export function heldLock(wt: string, out: string, locks: readonly string[] = ['index.lock']): string | undefined {
  const said = LOCK_WORDS.exec(out)
  if (said !== null) return said[1]!
  for (const name of locks) {
    const r = carryGit(wt, 'rev-parse', '--git-path', name)
    if (r.code !== 0) continue
    const path = resolve(wt, r.stdout.replace(/\n$/, ''))
    if (existsSync(path)) return path
  }
  return undefined
}

// `index-locked` (exit 3, transient): a held lock, the index's or the carry ref's. The lock's path is
// `got`. Its want says what removing it takes, and whether the work waits in the carry ref.
export function lockedRow(planId: string, lock: string, carried: boolean): Violation {
  const ship = cliAct('ship', planId).line
  return v('lock', 'index-locked', lock, carried
    ? `${shellWord(lock)} released — remove it if no git process is running; ${carryRef(planId)} keeps the plan's work meanwhile, and ${ship} finishes the move`
    : `${shellWord(lock)} released — remove it if no git process is running, then ${ship}; nothing moved`)
}

// Step 2 (P19). An operation a session started is its own to finish: witness never aborts it, nor
// applies into it. The row names its `--continue` and `--abort`. A `rebase-apply` holding `applying`
// is `git am`'s.
const OP_VERB: Record<OpInProgress, string> = {
  'rebase-merge': 'rebase', 'rebase-apply': 'rebase', MERGE_HEAD: 'merge', CHERRY_PICK_HEAD: 'cherry-pick', REVERT_HEAD: 'revert',
}
export function operationRefusal(wt: string, planId: string, op: OpInProgress): Violation {
  const applying = op === 'rebase-apply' && carryGit(wt, 'rev-parse', '--git-path', 'rebase-apply/applying')
  const verb = applying && applying.code === 0 && existsSync(resolve(wt, applying.stdout.replace(/\n$/, ''))) ? 'am' : OP_VERB[op]
  return v(op, 'operation-in-progress', `a git ${verb} is in progress in the worktree`,
    `it finished with ${shellLine(['git', verb, '--continue'])}, or ended with ${shellLine(['git', verb, '--abort'])} — `
      + `witness never ends an operation a session started — then ${cliAct('ship', planId).line}`)
}

// The files an intent-to-add entry (`git add -N`) holds: the worktree side of `git diff` lists them as
// added, and nothing else is added on that side.
function intentToAdd(wt: string): string[] {
  const r = carryGit(wt, 'diff', '--name-only', '-z', '--no-renames', '--no-relative', '--diff-filter=A')
  return r.code === 0 ? r.stdout.split('\0').filter((f) => f !== '') : []
}

// Step 4. The plan's uncommitted work captured with `git stash create`, which writes a stash-shaped
// commit and never touches `refs/stash`, the list every worktree shares (P2). The commit goes to the
// carry ref, create-only. `undefined`: nothing to carry, only when git also lists no tracked change.
// Every refusal comes before anything moves.
export function captureCarry(wt: string, planId: string): Result<string | undefined> {
  const ship = cliAct('ship', planId).line
  const made = carryGit(wt, 'stash', 'create')
  if (made.code !== 0) {
    const out = `${made.stdout}${made.stderr}`
    const lock = heldLock(wt, out)
    if (lock !== undefined) return refuse([lockedRow(planId, lock, false)])
    const ita = intentToAdd(wt)
    // P14 (S1-7): git cannot capture an intent-to-add entry; each is named with both ways out.
    if (ita.length > 0) {
      return refuse(ita.map((f) => v(shellWord(f), 'carry-refused', 'an intent-to-add entry (git add -N), which git stash create cannot capture',
        `${remedyLine(['git', 'add', '--', f])} stages it whole, or ${remedyLine(['git', 'reset', '--', f])} drops the intent and leaves `
          + `the file untracked — nothing moved; then ${ship}`)))
    }
    return refuse([v('stash', 'carry-refused', `git stash create failed: ${gitWords(out)}`,
      `a worktree whose changes git stash create can capture — nothing moved; fix what git names, then ${ship}`)])
  }
  const sha = made.stdout.trim()
  if (sha === '') {
    const status = carryGit(wt, 'status', '--porcelain', '--untracked-files=no')
    if (status.code === 0 && status.stdout === '') return ok(undefined)
    return refuse([v('stash', 'carry-refused', status.code === 0
      ? `git stash create captured nothing, yet git status lists tracked changes: ${gitWords(status.stdout)}`
      : `git stash create captured nothing, and git status failed: ${gitWords(status.stderr)}`,
    `a worktree whose changes git stash create can capture — nothing moved; then ${ship}`)])
  }
  const ref = carryRef(planId)
  const written = carryGit(wt, 'update-ref', ref, sha, '')
  if (written.code !== 0) {
    const out = `${written.stdout}${written.stderr}`
    const lock = heldLock(wt, out, [`${ref}.lock`])
    if (lock !== undefined) return refuse([lockedRow(planId, lock, false)])
    return refuse([v(ref, 'carry-refused', `writing ${ref} failed: ${gitWords(out)}`,
      `a writable ${ref} — nothing moved; then ${ship}`)])
  }
  return ok(sha)
}

// Step 5. `git reset --hard`, then the tracked tree verified clean. `git checkout -- .` would leave
// staged work behind (P13), and with a user's `rebase.autoStash=true` that work brings #86 straight
// back (P15). A reset that fails or leaves the tree dirty (a file held open on Windows) refuses
// `carry-pending`: the carry ref is kept, and step 0 finishes the move.
export function cleanTree(wt: string, planId: string): Result<void> {
  const reset = carryGit(wt, 'reset', '--hard', '--quiet')
  if (reset.code !== 0) {
    const out = `${reset.stdout}${reset.stderr}`
    const lock = heldLock(wt, out)
    if (lock !== undefined) return refuse([lockedRow(planId, lock, true)])
    return refuse([carryPending(planId, `git reset --hard failed: ${gitWords(out)}`)])
  }
  const status = carryGit(wt, 'status', '--porcelain', '--untracked-files=no')
  if (status.code !== 0) return refuse([carryPending(planId, `git status failed after git reset --hard: ${gitWords(status.stderr)}`)])
  if (status.stdout !== '') return refuse([carryPending(planId, `the tracked tree is still not clean after git reset --hard: ${gitWords(status.stdout)}`)])
  return ok(undefined)
}

// Step 7's outcomes. `clash`: the carry moved to `kept`, the files unmerged in the tree. `refused`:
// the carry ref is kept and `out` says why, as `carry-pending`'s `got`. `locked`: a held lock, the
// carry ref kept.
export type Reapplied =
  | { kind: 'clean' }
  | { kind: 'clash'; kept: string; files: UnmergedPath[] }
  | { kind: 'refused'; out: string }
  | { kind: 'locked'; lock: string }

// Every path the carry writes: its worktree side and its index side, against its base.
function carryPaths(wt: string, carry: string): string[] | undefined {
  const paths = new Set<string>()
  for (const side of [carry, `${carry}^2`]) {
    const r = carryGit(wt, 'diff-tree', '-r', '--name-only', '-z', '--no-renames', `${carry}^1`, side)
    if (r.code !== 0) return undefined
    for (const p of r.stdout.split('\0')) if (p !== '') paths.add(p)
  }
  return [...paths]
}

const CONFLICT = /^CONFLICT \(/m

// Step 7. `git stash apply --index <carry>`, so the staged versions go back staged. Before anything
// is written, an untracked file where the carry or its index writes one refuses (S1-1): in a witness
// worktree's sparse checkout the apply would replace it silently. The outcomes:
//   - clean: the carry ref is dropped, checked (S1-6) — a failed drop is a held lock or a refusal,
//     never a carry ref left standing behind a reported success;
//   - clash: no unmerged entries before, git printed `CONFLICT`, unmerged entries after — the carry
//     moves to the plan's next kept ref, listing the files (`keepCarry`);
//   - "conflicts in index" (P25): a plain apply instead, and the carry is kept like a clash backup,
//     listing its staged files, since a staged-only version survives only there;
//   - anything else: refused, or a held lock — the carry ref kept either way.
// git's words are read only as the carry's runner gives them: in the C locale.
export function reapply(wt: string, planId: string, carry: string): Reapplied {
  const writes = carryPaths(wt, carry)
  if (writes === undefined) return { kind: 'refused', out: `git could not read which files the carry ${carry} writes` }
  const inTheWay = untrackedInTheWay(wt, writes)
  if (inTheWay === undefined) return { kind: 'refused', out: 'git could not list the untracked files, so the plan\'s work was not put back over them' }
  if (inTheWay.length > 0) {
    return { kind: 'refused', out: `untracked files sit where the plan's work goes back — ${inTheWay.map((f) => shellWord(f)).join(', ')} — `
      + 'moved aside, the work goes back; nothing was written over them' }
  }
  if (unmergedPaths(wt).length > 0) return { kind: 'refused', out: 'the index already holds unmerged entries, so the plan\'s work was not put back into it' }
  const applied = carryGit(wt, 'stash', 'apply', '--index', carry)
  if (applied.code === 0) return dropCarry(wt, planId, carry)
  const out = `${applied.stdout}${applied.stderr}`
  const clashed = settleApply(wt, planId, carry, out)
  if (clashed !== undefined) return clashed
  if (/conflicts in index/.test(out)) {
    const plain = carryGit(wt, 'stash', 'apply', carry)
    if (plain.code === 0) {
      const index = carryGit(wt, 'diff-tree', '-r', '--name-only', '-z', '--no-renames', `${carry}^1`, `${carry}^2`)
      const files = index.code === 0 ? index.stdout.split('\0').filter((f) => f !== '') : []
      const k = keep(wt, planId, carry, files, 'the plan\'s work went back without its staged versions')
      return k.kind === 'kept' ? { kind: 'clean' } : k
    }
    const plainOut = `${plain.stdout}${plain.stderr}`
    return settleApply(wt, planId, carry, plainOut) ?? unapplied(wt, plainOut)
  }
  return unapplied(wt, out)
}

// An apply that clashed, as step 7 reads one; anything else is no clash (`undefined`).
function settleApply(wt: string, planId: string, carry: string, out: string): Reapplied | undefined {
  if (!CONFLICT.test(out)) return undefined
  const files = unmergedPaths(wt)
  if (files.length === 0) return undefined
  const k = keep(wt, planId, carry, files.map((f) => f.path), `the plan's work clashed going back, in ${files.map((f) => shellWord(f.path)).join(', ')}`)
  return k.kind === 'kept' ? { kind: 'clash', kept: k.ref, files } : k
}

// The carry moved to a kept ref, or why it could not be (a held carry-ref lock, or `carry-pending`).
type Kept = { kind: 'kept'; ref: string } | Extract<Reapplied, { kind: 'refused' | 'locked' }>
function keep(wt: string, planId: string, carry: string, files: string[], what: string): Kept {
  const kept = keepCarry(wt, planId, carry, files)
  if (kept.ok) return { kind: 'kept', ref: kept.value }
  const lock = heldLock(wt, '', [`${carryRef(planId)}.lock`])
  if (lock !== undefined) return { kind: 'locked', lock }
  return { kind: 'refused', out: `${what}, and keeping the carry failed: ${kept.violations[0]?.got ?? ''}` }
}

function unapplied(wt: string, out: string): Reapplied {
  const lock = heldLock(wt, out)
  if (lock !== undefined) return { kind: 'locked', lock }
  return { kind: 'refused', out: `git stash apply refused the plan's work: ${gitWords(out)}` }
}

// After a clean apply the carry ref goes, checked against the carry itself (S1-6).
function dropCarry(wt: string, planId: string, carry: string): Reapplied {
  const ref = carryRef(planId)
  const dropped = carryGit(wt, 'update-ref', '-d', ref, carry)
  if (dropped.code === 0) return { kind: 'clean' }
  const out = `${dropped.stdout}${dropped.stderr}`
  const lock = heldLock(wt, out, [`${ref}.lock`])
  if (lock !== undefined) return { kind: 'locked', lock }
  return { kind: 'refused', out: `the plan's work is back in the tree, but deleting ${ref} failed: ${gitWords(out)}` }
}

// §4.1.5 (the first build's finding). In a witness worktree's sparse checkout, `git rebase` silently
// replaces an untracked file at a path the base holds with the base's bytes and exits 0, where a
// plain checkout refuses. So before anything moves, every non-ignored untracked file at a path the
// moved base holds — or in a directory/file clash with one — refuses `rebase-refused`, named.
export function baseInTheWay(wt: string, planId: string, base: string): Result<void> {
  const ship = cliAct('ship', planId).line
  const tree = carryGit(wt, 'ls-tree', '-r', '--full-tree', '--name-only', '-z', base)
  if (tree.code !== 0) {
    return refuse([v('rebase', 'rebase-refused', `git could not list ${base}'s files: ${gitWords(tree.stderr)}`,
      `a readable ${base} — nothing moved; then ${ship}`)])
  }
  const found = untrackedInTheWay(wt, tree.stdout.split('\0').filter((p) => p !== ''))
  if (found === undefined) {
    return refuse([v('rebase', 'rebase-refused', 'git could not list the untracked files the rebase would meet',
      `a worktree git can list — nothing moved; then ${ship}`)])
  }
  if (found.length === 0) return ok(undefined)
  return refuse(found.map((f) => v(shellWord(f), 'rebase-refused',
    `untracked here, where ${base} holds a file — the rebase would replace it with ${base}'s bytes`,
    `it moved aside, or staged as the plan's work with ${remedyLine(['git', 'add', '--', f])} — nothing moved; then ${ship}`)))
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
