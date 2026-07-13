import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
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
    return { ok: false, out: String(err.stdout ?? err.stderr ?? e).trim() }
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

export const STATE_DIRS = ['specs', 'plans', '.specflow'] as const

export function isStatePath(rel: string): boolean {
  return STATE_DIRS.some((d) => rel === d || rel.startsWith(d + '/'))
}

const LOCAL_STATE_FILES = new Set([
  '.specflow/lock',
  '.specflow/txn.json',
  '.specflow/allow.json',
  '.specflow/calibration.local.yaml',
])

export function dirtyStatePaths(root: string): string[] {
  const res = tryGit(root, 'status', '--porcelain', '--untracked-files=all', '--', ...STATE_DIRS)
  if (!res.ok || res.out === '') return []
  return res.out
    .split('\n')
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .filter((p) => !LOCAL_STATE_FILES.has(p))
}

export const TRAILER = 'Specflow-State: 1'

export function commitWithTrailer(root: string, files: string[], subject: string): Result<{ sha: string }> {
  git(root, 'add', '--', ...files)
  git(root, 'commit', '--only', '-m', subject, '-m', TRAILER, '--', ...files)
  return ok({ sha: git(root, 'rev-parse', 'HEAD') })
}

export function stateCommit(root: string, files: string[], subject: string): Result<{ sha: string }> {
  const bad = files.filter((f) => !isStatePath(f))
  if (bad.length) {
    return refuse(bad.map((f) => v(f, 'out-of-scope', f, 'state commits touch only specs/, plans/, .specflow/')))
  }
  const planned = new Set(files)
  const unrelated = dirtyStatePaths(root).filter((p) => !planned.has(p))
  if (unrelated.length) {
    return refuse(unrelated.map((p) =>
      v(p, 'unrelated-dirty', 'uncommitted change on a state path', 'revert it or re-apply via specflow write, then re-run'),
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
  const res = tryGit(
    root, 'log', '--format=%H%x1f%s%x1f%(trailers:key=Specflow-State,valueonly=true)',
    '--', 'specs', 'plans', '.specflow/journal',
  )
  if (!res.ok || res.out === '') return []
  return res.out.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, trailer] = line.split('\x1f')
    return { sha: sha ?? '', subject: subject ?? '', trailered: (trailer ?? '').trim() === '1' }
  })
}
