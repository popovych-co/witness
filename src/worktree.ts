import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { git, tryGit } from './gitio.js'
import { ok, refuse, v, type Result } from './refusal.js'

export function worktreesDir(root: string): string {
  return join(root, '.specflow', 'worktrees')
}

export function worktreePath(root: string, planId: string): string {
  return join(worktreesDir(root), planId)
}

// primaryRoot resolves a worktree cwd up to the primary root and drops WHICH worktree it
// was. That identity is the flow, so recover it here rather than re-deriving from git.
// (Lives here, not in gitio.ts, because gitio.ts is what this module imports — the other
// direction would close an import cycle.)
export function worktreeFlow(cwd: string, root: string): string | undefined {
  const top = tryGit(cwd, 'rev-parse', '--show-toplevel')
  if (!top.ok) return undefined
  const dir = worktreesDir(root)
  if (!top.out.startsWith(dir + sep)) return undefined
  const rest = top.out.slice(dir.length + 1)
  // Round-tripping the last path segment back to a plan id is safe: worktreePath is a
  // bare join with no slugification, and doc ids are /^[a-z0-9-]+$/ (dsl.ts).
  return rest.length > 0 && !rest.includes(sep) ? rest : undefined
}

export function branchName(planId: string): string {
  return `specflow/${planId}`
}

export function ensureExcluded(root: string): void {
  const commonDir = git(root, 'rev-parse', '--git-common-dir').trim()
  const gitDir = isAbsolute(commonDir) ? commonDir : join(root, commonDir)
  const infoDir = join(gitDir, 'info')
  mkdirSync(infoDir, { recursive: true })
  const excludePath = join(infoDir, 'exclude')
  const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  const lines = current.split('\n')
  // screens are witnessed evidence, regenerable, never committed — ignored in every
  // worktree so they stay out of changedFiles() and the reviewed tree-sha
  for (const line of ['.specflow/worktrees/', '.specflow/screens/']) {
    if (!lines.includes(line)) appendFileSync(excludePath, `${line}\n`)
  }
}

export function createWorktree(
  root: string, planId: string, baseBranch: string,
): Result<{ path: string; branch: string }> {
  const path = worktreePath(root, planId)
  const branch = branchName(planId)
  ensureExcluded(root)
  mkdirSync(worktreesDir(root), { recursive: true })
  if (existsSync(path)) return ok({ path, branch })
  tryGit(root, 'worktree', 'prune')
  const branchExists = tryGit(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).ok
  const r = branchExists
    ? tryGit(root, 'worktree', 'add', path, branch)
    : tryGit(root, 'worktree', 'add', '-b', branch, path, baseBranch)
  if (!r.ok) {
    return refuse([v('worktree', 'worktree-create-failed', r.out.slice(0, 200), 'git worktree add to succeed')])
  }
  return ok({ path, branch })
}

export function removeWorktree(root: string, planId: string): void {
  const path = worktreePath(root, planId)
  if (existsSync(path)) tryGit(root, 'worktree', 'remove', '--force', path)
  tryGit(root, 'worktree', 'prune')
}

export function listWorktrees(root: string): string[] {
  const dir = worktreesDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
}
