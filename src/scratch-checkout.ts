import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { foldOverlay, objectType, pinTree, type CfOverlay } from './cf-tree.js'
import type { Ctx } from './cli.js'
import type { Config } from './config.js'
import { tryGit } from './gitio.js'
import { prepareScratch } from './prepare.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { withScratchLock } from './scratch-lock.js'
import { visible } from './toon.js'
import { ensureExcluded, excludeCanon, materializedCanon } from './worktree.js'

// Row 258. One persistent scratch checkout per repo, where machine work runs on trees other than a
// plan's worktree (T2c's base lint first). It sits at `.witness/scratch`, inside the primary root:
// short, fixed, and gone with the repo. It is a git worktree detached at whatever it last ran, with
// a plan worktree's sparse patterns (row 132: canon hidden, the payload home kept), excluded from
// the root's `git status` and exempt from the state-path audit. Its HEAD reflog is off: a reflog
// entry would keep a wrapped commit alive after its ref went (probe t2b-cf-git.sh).

export const SCRATCH_DIR = '.witness/scratch'
export const scratchPath = (root: string): string => join(root, SCRATCH_DIR)

const REMOVE = 'remove .witness/scratch — witness makes it again'
const unusable = (got: string) => refuse<never>([v(SCRATCH_DIR, 'scratch-unusable', got, REMOVE)])

// git's reason: its last `fatal:` or `error:` line, else its last line — a trailing hint ("remove
// the file manually to continue.") never names what failed (slice 1 review).
const lastLine = (text: string): string => {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  return visible(lines.filter((l) => /^(fatal|error):/.test(l)).at(-1) ?? lines.at(-1) ?? 'git failed').slice(0, 200)
}

const real = (p: string): string | undefined => {
  try { return realpathSync(p) } catch { return undefined }
}

// An existing folder is the scratch only when it is a worktree of this repository at exactly this
// path: its top level is the folder itself, and it shares the root's object store.
function isOurWorktree(root: string, path: string): boolean {
  const top = tryGit(path, 'rev-parse', '--show-toplevel')
  const common = tryGit(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const rootCommon = tryGit(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!top.ok || !common.ok || !rootCommon.ok) return false
  const here = real(path)
  return here !== undefined && real(top.out) === here && real(common.out) !== undefined && real(common.out) === real(rootCommon.out)
}

// The scratch's path, made when missing. A link or anything but its own worktree in its place
// refuses with the remedy, so witness never runs in a folder that is not the scratch. Both arms set
// the scratch up (row 132's "applied and verified on both arms"): an existing scratch may have been
// made half-way (a run killed after `worktree add`), left registered by a refusal, or made before
// the canon patterns changed (slice 1 review).
export function openScratch(root: string): Result<string> {
  const path = scratchPath(root)
  let exists = true
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return unusable('a link')
    if (!st.isDirectory()) return unusable('not a folder')
    if (!isOurWorktree(root, path)) return unusable("a folder that is not witness's scratch worktree")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return unusable((e as NodeJS.ErrnoException).code ?? String(e))
    exists = false
  }
  ensureExcluded(root)
  // Slice 2 review I-A. Nothing in the scratch is anyone's work: whatever a run left in a canon
  // folder — a file a step wrote, one planted over a hidden path, one checked out — goes before the
  // patterns are applied and verified, or the residue check would refuse every run until a human
  // removed the scratch (plan worktrees' remedy, "adopt or revert", means nothing here).
  if (exists) {
    // A kill's leftover lock first (final review): with it, excludeCanon's reapply fails silently
    // and its residue check would refuse every run before the reset that clears it.
    dropStaleLocks(path)
    for (const r of materializedCanon(root, path)) rmSync(join(path, r.rel), { recursive: true, force: true })
  }
  if (!exists) {
    // A scratch removed by hand leaves its registration behind, which `worktree add` refuses.
    tryGit(root, 'worktree', 'prune')
    mkdirSync(dirname(path), { recursive: true })
    const add = tryGit(root, 'worktree', 'add', '--no-checkout', '--detach', path, 'HEAD')
    if (!add.ok) return refuse([v(SCRATCH_DIR, 'scratch-create-failed', lastLine(add.out), 'git worktree add to succeed')])
  }
  // Row 279: hooks go off before excludeCanon's reapply, which runs `post-index-change` (slice 1
  // review M3: a scratch 0.31 left, opened first by this version, ran its last tree's hook).
  const ex = excludeCanon(root, path, { beforeApply: () => hooksOff(path) })
  if (!ex.ok) return refuse(ex.violations)
  // excludeCanon turned extensions.worktreeConfig on, so this setting is the scratch's alone.
  const logs = tryGit(path, 'config', '--worktree', 'core.logAllRefUpdates', 'false')
  const gitDir = tryGit(path, 'rev-parse', '--path-format=absolute', '--git-dir')
  if (!logs.ok || !gitDir.ok) return refuse([v(SCRATCH_DIR, 'scratch-create-failed', lastLine(logs.ok ? gitDir.out : logs.out), 'git config to succeed')])
  rmSync(join(gitDir.out, 'logs', 'HEAD'), { force: true })
  return ok(path)
}

// Row 279 (T2b final M-c): no git hook runs in the scratch. A reset checks out agent-authored trees,
// and a hook it carries (husky's `core.hooksPath=.husky` included) would run their code on checkout.
// Worktree config outranks the repo's (worktreeConfig is on: excludeCanon turned it on before calling
// this), and the folder is emptied on every open, so nothing a run left there is ever a hook. Written
// only when it differs (row 263: no config rewrite per open).
function hooksOff(path: string): Result<void> {
  const gitDir = tryGit(path, 'rev-parse', '--path-format=absolute', '--git-dir')
  if (!gitDir.ok) return refuse([v(SCRATCH_DIR, 'scratch-create-failed', lastLine(gitDir.out), 'git rev-parse to succeed')])
  const noHooks = join(gitDir.out, 'witness-no-hooks')
  try {
    rmSync(noHooks, { recursive: true, force: true })
    mkdirSync(noHooks)
  } catch (e) {
    return refuse([v(SCRATCH_DIR, 'scratch-create-failed', visible((e as NodeJS.ErrnoException).code ?? String(e)), 'an empty hooks folder in the scratch\'s git dir')])
  }
  const hooks = tryGit(path, 'config', '--worktree', '--get', 'core.hooksPath')
  if (!hooks.ok || hooks.out !== noHooks) {
    const set = tryGit(path, 'config', '--worktree', 'core.hooksPath', noHooks)
    if (!set.ok) return refuse([v(SCRATCH_DIR, 'scratch-create-failed', lastLine(set.out), 'git config to succeed')])
  }
  return ok(undefined)
}

// A killed git's leftover locks in the scratch's own git dir: index.lock, and HEAD.lock (a reset
// killed in its last moment, slice 2 review). Under the scratch lock no other witness process runs
// git here. One that cannot be removed is named by git's refusal.
function dropStaleLocks(dir: string): void {
  const gitDir = tryGit(dir, 'rev-parse', '--path-format=absolute', '--git-dir')
  if (!gitDir.ok) return
  for (const lock of ['index.lock', 'HEAD.lock']) {
    try { rmSync(join(gitDir.out, lock), { force: true }) } catch { /* git names it */ }
  }
}

// The scratch at `commit`, clean: everything untracked or ignored goes but `node_modules` and
// `target` at any depth (the prepared install and cargo's build cache survive a reset).
//
// A reset killed mid-checkout (drive stopping a job at its box) leaves the scratch's index.lock (or,
// in its last moment, HEAD.lock), and git refuses every later checkout until it goes. Under the scratch lock no other witness process
// runs git here, so a leftover is removed first; one that cannot be removed refuses with its path.
export function resetScratch(dir: string, commit: string): Result<void> {
  dropStaleLocks(dir)
  const co = tryGit(dir, 'checkout', '--quiet', '--force', '--detach', commit)
  if (!co.ok) return refuse([v(SCRATCH_DIR, 'scratch-reset', lastLine(co.out), `a clean checkout of ${visible(commit)}`)])
  const cl = tryGit(dir, 'clean', '-ffdxq', '-e', 'node_modules', '-e', 'target')
  if (!cl.ok) return refuse([v(SCRATCH_DIR, 'scratch-reset', lastLine(cl.out), 'git clean to succeed')])
  return ok(undefined)
}

// ── A scratch run (row 258) ──────────────────────────────────────────────────────────────────

// What to run on: `tree` a full commit or tree sha; `overlay` folds files over it; `plan` pins a
// run whose tree is no commit (refs/witness/cf/<plan>/<tree>, kept until the plan merges).
export interface CfAt { tree: string; overlay?: CfOverlay; plan?: string }
// Every sha the run touched. `base` the tree `at.tree` names; `overlay.from` the tree the overlay
// came from; `tree` the tree run; `commit` the commit checked out; `inputs` prepare's inputs at
// `tree`; `prepared` whether the run's first prepare ran (its inputs moved, or no record);
// `reprepared` whether the load rule ran a second one.
export interface CfRecord {
  base: string; overlay?: { from: string; paths: string[] }; tree: string; commit: string
  inputs: string; prepared: boolean; reprepared: boolean; ms: number
}
// What a step returns: its value, and the files its run failed to load (junit's `loadFailures`, or
// [] for a step that reads no junit).
export interface CfStep<T> { value: T; load: string[] }

// CF (spec §3.4). Runs `step` in the prepared scratch checked out at `at`, holding the scratch:
// resolve the tree, take the lock, reset, prepare when a lockfile moved, run the step. A step whose
// files fail to load prepares again once (forced), from a fresh reset, and runs again; a second load
// failure is the environment (`load-failure`), never a red. Synchronous: nothing in it may prompt —
// it is headless — and `withRunnerTurn` releases in a `finally` an async step would outrun.
//
// It journals nothing and keeps no cache (correction C10): a job child must never journal (row
// 257), so the record rides the caller's result, and each caller's journal is its cache.
//
// The step's contract: it runs its commands with `execCommand(dir, ctx, cmd, { turn: false })`; a
// run that needs the test turn takes it before `inScratch` (lock order turn → scratch: `takeTurn`
// throws inside the scratch); it returns its junit's `loadFailures`, or [] when it reads no junit.
export function inScratch<T>(
  root: string, ctx: Ctx, cfg: Config, at: CfAt, step: (dir: string) => Result<CfStep<T>>,
): Result<{ value: T; record: CfRecord }> {
  const t0 = Date.now()
  if (cfg.scratch.prepare === undefined) {
    return refuse([v('scratch.prepare', 'scratch-off', 'not set', 'a setup command, or none — witness migrate proposes one')])
  }
  const type = objectType(root, at.tree)
  if (type === undefined) return refuse([v('tree', 'tree-unknown', visible(at.tree), 'a full commit or tree sha this repo holds')])
  const base = tryGit(root, 'rev-parse', '--verify', `${at.tree}^{tree}`)
  if (!base.ok) return refuse([v('tree', 'tree-unknown', visible(at.tree), 'a full commit or tree sha this repo holds')])
  let tree = base.out
  let overlay: CfRecord['overlay']
  if (at.overlay !== undefined) {
    const folded = foldOverlay(root, base.out, at.overlay)
    if (!folded.ok) return folded
    tree = folded.value
    const from = tryGit(root, 'rev-parse', '--verify', `${at.overlay.from}^{tree}`)
    overlay = { from: from.ok ? from.out : at.overlay.from, paths: [...at.overlay.paths] }
  }
  let commit: string
  if (type === 'commit' && at.overlay === undefined) commit = at.tree
  else {
    if (at.plan === undefined) {
      return refuse([v('plan', 'cf-unpinned', visible(tree),
        `the plan whose run pins this tree — refs/witness/cf/<plan>/ keep it until the plan merges`)])
    }
    const pinned = pinTree(root, at.plan, tree)
    if (!pinned.ok) return pinned
    commit = pinned.value
  }
  return withScratchLock(root, ctx, () => {
    const dir = openScratch(root)
    if (!dir.ok) return dir
    const fresh = () => resetScratch(dir.value, commit)
    const reset = fresh()
    if (!reset.ok) return reset
    const prep = prepareScratch(root, ctx, cfg, dir.value, tree)
    if (!prep.ok) return prep
    let run = step(dir.value)
    if (!run.ok) return run
    let reprepared = false
    if (run.value.load.length > 0) {
      reprepared = true
      const again = fresh()
      if (!again.ok) return again
      const forced = prepareScratch(root, ctx, cfg, dir.value, tree, { force: true })
      if (!forced.ok) return forced
      run = step(dir.value)
      if (!run.ok) return run
      if (run.value.load.length > 0) {
        return refuse([v('scratch', 'load-failure', visible(run.value.load.join(' · ')),
          'a run whose files load — prepared again once; this is the environment, never a red')])
      }
    }
    return ok({
      value: run.value.value,
      record: {
        base: base.out, ...(overlay !== undefined ? { overlay } : {}), tree, commit, inputs: prep.value.inputs,
        prepared: prep.value.ran, reprepared, ms: Date.now() - t0,
      },
    })
  })
}
