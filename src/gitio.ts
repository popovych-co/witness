import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { canonPaths } from './config.js'
import { ok, refuse, v, type Result } from './refusal.js'

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\n$/, '')
}

export function tryGit(root: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(root, ...args) }
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string }
    // most git failures (like `pull --rebase` with no upstream) write to stderr with
    // an empty stdout — `??` only falls through on nullish, so it must prefer the
    // first NON-EMPTY stream, not just the first non-nullish one
    return { ok: false, out: String(err.stdout || err.stderr || e).trim() }
  }
}

export function primaryRoot(cwd: string): Result<string> {
  const top = tryGit(cwd, 'rev-parse', '--show-toplevel')
  if (!top.ok) {
    return refuse([v('repo', 'not-a-git-repo', cwd, 'run inside a git repository (git init first)')])
  }
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const gitDir = git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir')
  if (common === gitDir) return ok(top.out)
  return ok(dirname(common))
}

export function stateDirs(root: string): string[] {
  const p = canonPaths(root)
  return [p.specs, p.plans, p.designs, '.witness']
}

export function isStatePath(root: string, rel: string): boolean {
  return stateDirs(root).some((d) => rel === d || rel.startsWith(d + '/'))
}

const LOCAL_STATE_FILES = new Set([
  '.witness/lock',
  '.witness/txn.json',
  '.witness/allow.json',
  '.witness/calibration.local.yaml',
  // Row 90's machine-config file is this tier too, and the exemption is load-bearing
  // rather than belt-and-braces: init only gitignores it for repos scaffolded at
  // >=0.5.0, so on every pre-0.5.0 repo the file is untracked-but-visible under a
  // state dir — and an unrelated-dirty refusal there would brick the very gate the
  // declared extensions exist to unblock.
  '.witness/config.local.yaml',
])

export function dirtyStatePaths(root: string): string[] {
  const res = tryGit(root, 'status', '--porcelain', '--untracked-files=all', '--', ...stateDirs(root))
  if (!res.ok || res.out === '') return []
  return res.out
    .split('\n')
    // a rename (e.g. from `git mv`) porcelain-formats as "old -> new" on one line —
    // split it into its two paths so each is checked against the caller's planned set
    .flatMap((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> '))
    .filter((p) => !LOCAL_STATE_FILES.has(p))
}

export const TRAILER = 'Witness-State: 1'

// Row 87's rule: nothing to COMMIT is the same legal silent success as nothing to write.
// It lives here, at the one choke point every state commit passes through, because git
// rejects BOTH empty cases fatally and a caller cannot tell them apart in advance:
//   • no paths at all → `commit --only ... --` dies "No paths with --include/--only"
//     (a drift sweep with no live specs journals nothing and stamps nothing);
//   • paths with no diff → `commit --only` exits non-zero (a restamp that restores a
//     file to exactly its HEAD content, or a pathspec the repo gitignores).
// Either way there is no state to record, so HEAD is already the answer. Implementing
// this at init.ts's call site alone left every other caller throwing out of gitio and
// surfacing through bin.ts as `unexpected-error` — "report a bug" on a healthy repo.
function headSha(root: string): string {
  const head = tryGit(root, 'rev-parse', 'HEAD')
  return head.ok ? head.out : ''            // unborn HEAD: no commit exists to name
}

export function commitWithTrailer(root: string, files: string[], subject: string): Result<{ sha: string }> {
  if (files.length === 0) return ok({ sha: headSha(root) })
  // tryGit, not git: a path already fully processed by a prior `git mv` (both sides
  // of a rename staged atomically) is absent from working tree AND index, so `add`
  // reports it unmatched — even though the rename itself is already staged. `commit
  // --only` resolves its pathspecs against the index-vs-HEAD diff, where the rename
  // is visible, so it still succeeds and is the real validation here.
  tryGit(root, 'add', '--', ...files)
  // Ask git what actually changed rather than assuming every file we touched is dirty.
  // Runs AFTER the add, so a freshly staged untracked path reads as `A ` and commits;
  // a staged rename reads as `R ` on whichever side the pathspec names.
  if (tryGit(root, 'status', '--porcelain', '--', ...files).out === '') {
    return ok({ sha: headSha(root) })
  }
  // --no-verify: state commits are machine-authored and scope-restricted to non-source
  // paths (isStatePath), so a host lint/test hook has nothing to validate here — while
  // its stash/restore step can destroy the human's unrelated dirty work, and a
  // tree-mutating hook (formatters) can desync the index from the txn marker.
  // stateCommit's own `unrelated-dirty` refusal is the real gate on these commits.
  git(root, 'commit', '--no-verify', '--only', '-m', subject, '-m', TRAILER, '--', ...files)
  return ok({ sha: git(root, 'rev-parse', 'HEAD') })
}

export function stateCommit(root: string, files: string[], subject: string): Result<{ sha: string }> {
  const dirs = stateDirs(root)
  const bad = files.filter((f) => !isStatePath(root, f))
  if (bad.length) {
    return refuse(bad.map((f) => v(f, 'out-of-scope', f, `state commits touch only ${dirs.map((d) => `${d}/`).join(', ')}`)))
  }
  const planned = new Set(files)
  const unrelated = dirtyStatePaths(root).filter((p) => !planned.has(p))
  if (unrelated.length) {
    return refuse(unrelated.map((p) =>
      v(p, 'unrelated-dirty', 'uncommitted change on a state path', 'revert it or re-apply via witness write, then re-run'),
    ))
  }
  return commitWithTrailer(root, files, subject)
}

export interface CommitAudit {
  sha: string
  subject: string
  trailered: boolean
}

export function auditStateCommits(root: string): CommitAudit[] {
  const p = canonPaths(root)
  const res = tryGit(
    root, 'log', '--format=%H%x1f%s%x1f%(trailers:key=Witness-State,valueonly=true)',
    '--', p.specs, p.plans, p.designs, '.witness/journal',
  )
  if (!res.ok || res.out === '') return []
  return res.out.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, trailer] = line.split('\x1f')
    return { sha: sha ?? '', subject: subject ?? '', trailered: (trailer ?? '').trim() === '1' }
  })
}
