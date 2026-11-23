import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { git, inPayloadHome, PAYLOAD_HOME, stateDirs, tryGit } from './gitio.js'
import { ok, refuse, v, type Result } from './refusal.js'

export function worktreesDir(root: string): string {
  return join(root, '.witness', 'worktrees')
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
  // bare join with no slugification, and doc ids are /^[a-z0-9][a-z0-9-]*$/ (dsl.ts).
  return rest.length > 0 && !rest.includes(sep) ? rest : undefined
}

// Whether the session asking is already in `home`. A PATH comparison, not a string one:
// `primaryRoot` answers with git's physical path (`rev-parse --show-toplevel` resolves
// symlinks) while `ctx.cwd` is whatever the human typed, and on macOS every `/tmp` and
// `/var` path is a symlink — so a raw `===` reports a session sitting in its own home as a
// session that must be relocated, which is the handoff loop this predicate exists to close.
//
// realpathSync throws on a path that does not exist; `resolve` is the fallback because a
// home that is not on disk is not one you are standing in, and the comparison must still
// answer rather than throw inside `next`'s print block.
export function atHome(cwd: string, home: string): boolean {
  const real = (p: string): string => {
    try { return realpathSync(p) } catch { return resolve(p) }
  }
  return real(cwd) === real(home)
}

export function branchName(planId: string): string {
  return `witness/${planId}`
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
  // worktree so they stay out of planChangeSet() and the reviewed tree-sha. Drafts (row 199)
  // are a conversation's local memory, never committed: a repo whose .gitignore predates
  // them would otherwise show each one to `git status` and to a human's `git add -A`; drive's
  // live folder (row 203) is the same kind, and so is the scratch checkout (row 258)
  const missing = ['.witness/worktrees/', '.witness/screens/', '.witness/drafts/', '.witness/live/', '.witness/scratch/']
    .filter((l) => !lines.includes(l))
  // A file a human left without a final newline keeps its last line whole.
  const sep = current !== '' && !current.endsWith('\n') ? '\n' : ''
  if (missing.length) appendFileSync(excludePath, `${sep}${missing.map((l) => `${l}\n`).join('')}`)
}

// Row 132. Canon has ONE home, and it is the primary root. The exclusion set is
// `stateDirs(root)` — the same predicate `isStatePath` and `stateCommit` already use, never
// a second list: a divergence between "what the CLI refuses to let you edit" and "what the
// worktree hides" is the split-brain this row exists to close.
//
// Non-cone patterns, and `/*` first: cone mode cannot express "keep docs/, drop
// docs/plans/", which is exactly what a repo with relocated `paths:` needs.
//
// Row 250 (#95): the payload's home under .witness/ is re-included last, so every worktree checks
// out witness's hooks while the journal stays hidden.
export function canonPatterns(root: string): string[] {
  return ['/*', ...stateDirs(root).map((d) => `!/${d}/`), `/${PAYLOAD_HOME}/`]
}

// The sparse-checkout file's bytes: `excludeCanon` writes them and `refreshSparse` compares them.
function sparseText(root: string): string {
  return `${canonPatterns(root).join('\n')}\n`
}

// Row 250 (#95). A worktree cut before the hooks moved holds the old patterns, which drop all of
// .witness/: there `git add` refuses a new .witness/hooks file, and a rebase brings the hooks in
// skip-worktree, missing on disk (probe t0b-sparse.sh). So a worktree whose patterns differ from
// today's gets today's and re-applies them. Never a refusal: what the apply declines is residue,
// and `start` and `check` judge residue. Whether it rewrote anything.
export function refreshSparse(root: string, wtPath: string): boolean {
  // Only a worktree of its own (slice 2 review): a stale plain directory under .witness/worktrees
  // resolves to the root's git dir, whose patterns are not this function's to rewrite.
  const top = tryGit(wtPath, 'rev-parse', '--show-toplevel')
  if (!top.ok || realpathSync(top.out) !== realpathSync(wtPath)) return false
  const gitDir = tryGit(wtPath, 'rev-parse', '--path-format=absolute', '--git-dir')
  if (!gitDir.ok) return false
  const file = join(gitDir.out, 'info', 'sparse-checkout')
  if (!existsSync(file) || readFileSync(file, 'utf8') === sparseText(root)) return false
  writeFileSync(file, sparseText(root))
  applySparse(wtPath)
  return true
}

// Row 250 (slice 2 review C1). The patterns applied to a worktree, touching only its skip-worktree
// bits: `sparse-checkout reapply` (git 2.27; witness binds 2.31). `read-tree -mu HEAD` reset the
// index to HEAD, so a staged edit went back to HEAD's content and a staged new file left the disk —
// and the implement stage leaves worktrees dirty by design, ship's carry restores staged work. A
// dirty path it cannot update stays where it is with a warning; the residue check judges it.
function applySparse(wtPath: string): void {
  tryGit(wtPath, 'sparse-checkout', 'reapply')
}

// How a canon path came to be visible inside a worktree. An OBSERVATION, never a severity
// — `check` decides how bad each one is, because the causes are different events with
// different remedies, and only `materialized` is one `witness start` clears.
export type ResidueCause = 'materialized' | 'planted' | 'untracked'

export interface CanonResidue { rel: string; how: ResidueCause }

export const RESIDUE_GOT: Record<ResidueCause, string> = {
  materialized: 'canon checked out in a worktree',
  planted: 'canon planted on disk over the exclusion',
  untracked: 'an untracked canon file in a worktree',
}

// Everything under a state dir that a worktree can still SEE. Three shapes, because the
// exclusion can fail in three different ways and `git status` reports only one of them:
//   • `materialized` — tracked and not `S`-tagged: the sparse rule never took (a worktree
//     cut before row 132, or a dirty file read-tree declined to remove);
//   • `planted` — tracked, `S`-tagged, yet present on disk: put there by hand over the
//     rule, since sparse never leaves an `S` file on disk. Measured on git 2.50.1: an index
//     refresh CLEARS skip-worktree for any path it finds present, so the same forgery reads
//     as `planted` before something refreshes and as a modified `materialized` entry after.
//     Both shapes are listed here so the answer never depends on who ran `git status` first;
//   • `untracked` (`.witness/screens/` and `.witness/worktrees/` are already filtered by
//     `ensureExcluded`'s `info/exclude` entries).
export function materializedCanon(root: string, wtPath: string): CanonResidue[] {
  const dirs = stateDirs(root)
  const found = new Map<string, ResidueCause>()
  // --full-name: ls-files prints cwd-relative paths by default, and every consumer here
  // treats what comes back as worktree-relative
  const tracked = tryGit(wtPath, 'ls-files', '--full-name', '-t', '--', ...dirs)
  if (tracked.ok && tracked.out !== '') {
    for (const line of tracked.out.split('\n')) {
      const rel = line.slice(2)
      if (rel === '' || inPayloadHome(rel)) continue   // row 250: payload, not canon
      if (line[0] !== 'S') found.set(rel, 'materialized')
      else if (existsSync(join(wtPath, rel))) found.set(rel, 'planted')
    }
  }
  const others = tryGit(wtPath, 'ls-files', '--full-name', '--others', '--exclude-standard', '--', ...dirs)
  if (others.ok && others.out !== '') {
    for (const rel of others.out.split('\n')) if (rel !== '' && !inPayloadHome(rel)) found.set(rel, 'untracked')
  }
  return [...found].map(([rel, how]) => ({ rel, how }))
}

// Applied AND verified: sparse-checkout is a checkout policy, so "we asked git to hide it"
// is not the same fact as "it is hidden", and the second one is the invariant. Applying
// declines a dirty path with a warning and exit 0 (measured), so the verification below is
// the only thing that can tell the two apart.
//
// The low-level mechanism (patterns file + `core.sparseCheckout` + an apply) rather than the
// `sparse-checkout` porcelain's set-up verbs: their flags moved across git 2.25–2.37
// (`init --no-cone`, `set --no-cone`), while this trio is stable across the whole range
// `primaryRoot` already binds (git >=2.31, via `rev-parse --path-format`). The apply is
// `sparse-checkout reapply` (2.27, flagless; row 250 — `read-tree -mu HEAD` reset staged work).
export function excludeCanon(root: string, wtPath: string): Result<void> {
  // git's own caveat: enabling worktreeConfig relocates these two to per-worktree scope.
  // Witness must not silently move a setting the user made, so it refuses instead.
  for (const key of ['core.bare', 'core.worktree']) {
    // --local: the shared .git/config is the scope worktreeConfig relocates FROM, and
    // merged scope would refuse over a harmless global/system setting. `git init` writes
    // `bare = false` locally on every repo, so the value test is load-bearing, not belt.
    const cur = tryGit(root, 'config', '--local', '--get', key)
    const val = cur.ok ? cur.out.trim() : ''
    if (val !== '' && val !== 'false') {
      return refuse([v('git', 'worktree-config-unsafe', `${key}=${val}`,
        `${key} unset — enabling extensions.worktreeConfig would move it to per-worktree scope`)])
    }
  }
  const gitDir = git(wtPath, 'rev-parse', '--path-format=absolute', '--git-dir')
  mkdirSync(join(gitDir, 'info'), { recursive: true })
  writeFileSync(join(gitDir, 'info', 'sparse-checkout'), sparseText(root))
  // Row 263 (T2b slice 2 M2). Each setting is written only where its scope reads another value:
  // the scratch is found again on every run, and a rewrite of the shared .git/config collides
  // (`config.lock`) with a session making a worktree at the same moment.
  const set = (at: string, scope: '--local' | '--worktree', key: string, val: string) => {
    if (tryGit(at, 'config', scope, '--get', key).out.trim() !== val) git(at, 'config', scope, key, val)
  }
  set(root, '--local', 'extensions.worktreeConfig', 'true')
  set(wtPath, '--worktree', 'core.sparseCheckout', 'true')
  set(wtPath, '--worktree', 'core.sparseCheckoutCone', 'false')
  // An edit elsewhere in the tree, staged or not, is the NORMAL mid-slice state (the implement
  // stage leaves the worktree dirty by design) and `applySparse` carries it through untouched
  // (row 250: read-tree used to reset staged work); a dirty canon path is what it declines, and
  // the residue check is the judge.
  applySparse(wtPath)
  const residue = materializedCanon(root, wtPath)
  if (residue.length) {
    return refuse(residue.map((r) => v(r.rel, 'canon-in-worktree', RESIDUE_GOT[r.how],
      'canon read at the primary root (witness read <id>) — revert or witness adopt the edit, then re-run')))
  }
  return ok(undefined)
}

export function createWorktree(
  root: string, planId: string, baseBranch: string,
): Result<{ path: string; branch: string }> {
  const path = worktreePath(root, planId)
  const branch = branchName(planId)
  ensureExcluded(root)
  mkdirSync(worktreesDir(root), { recursive: true })
  // BOTH arms exclude. The early return is the re-attach path, which is also the upgrade
  // path: every worktree cut before row 132 arrives here carrying a canon copy, and a
  // create-only exclusion would leave exactly those worktrees — the ones already in flight
  // — as the population the row was written for.
  if (existsSync(path)) {
    const ex = excludeCanon(root, path)
    if (!ex.ok) return refuse(ex.violations)
    return ok({ path, branch })
  }
  tryGit(root, 'worktree', 'prune')
  const branchExists = tryGit(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).ok
  const r = branchExists
    ? tryGit(root, 'worktree', 'add', path, branch)
    : tryGit(root, 'worktree', 'add', '-b', branch, path, baseBranch)
  if (!r.ok) {
    return refuse([v('worktree', 'worktree-create-failed', r.out.slice(0, 200), 'git worktree add to succeed')])
  }
  const ex = excludeCanon(root, path)
  if (!ex.ok) return refuse(ex.violations)
  return ok({ path, branch })
}

// D141. The lazy stamp fires from `next`, `check` and `dashboard` — including the
// SessionStart hook's bare `witness` — so removal used to delete the directory the invoking
// process was standing in (the ×3 `Working directory does not exist` in the 2026-08-29
// report). Returns false, and removes nothing, when `cwd` is inside the worktree; the
// skipped removal re-runs harmlessly from any other cwd, which the done-sweep already
// re-checks. A DIFFERENT session's cwd stays unknowable — no cross-session registry exists
// — and that residual is accepted in the spec; every reported case was a self-deletion.
export function removeWorktree(root: string, planId: string, cwd?: string): boolean {
  const path = worktreePath(root, planId)
  if (cwd !== undefined) {
    // Compared as PATHS, never as strings: realpath both sides (macOS /tmp and /var are
    // symlinks — the same trap D134 hit), and a `..` or absolute relative result means
    // outside. `${path}-sibling` must not read as inside, which a prefix test would.
    const here = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd)
    const there = existsSync(path) ? realpathSync(path) : resolve(path)
    const rel = relative(there, here)
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return false
  }
  if (existsSync(path)) tryGit(root, 'worktree', 'remove', '--force', path)
  tryGit(root, 'worktree', 'prune')
  return true
}

export function listWorktrees(root: string): string[] {
  const dir = worktreesDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
}
