import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tryGit } from './gitio.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { visible } from './toon.js'
import { ensureExcluded, excludeCanon } from './worktree.js'

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

const lastLine = (text: string): string =>
  visible(text.split('\n').map((l) => l.trim()).filter((l) => l !== '').at(-1) ?? 'git failed').slice(0, 200)

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
// refuses with the remedy, so witness never runs in a folder that is not the scratch.
export function openScratch(root: string): Result<string> {
  const path = scratchPath(root)
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return unusable('a link')
    if (!st.isDirectory()) return unusable('not a folder')
    return isOurWorktree(root, path) ? ok(path) : unusable("a folder that is not witness's scratch worktree")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return unusable((e as NodeJS.ErrnoException).code ?? String(e))
  }
  ensureExcluded(root)
  // A scratch removed by hand leaves its registration behind, which `worktree add` refuses.
  tryGit(root, 'worktree', 'prune')
  mkdirSync(dirname(path), { recursive: true })
  const add = tryGit(root, 'worktree', 'add', '--no-checkout', '--detach', path, 'HEAD')
  if (!add.ok) return refuse([v(SCRATCH_DIR, 'scratch-create-failed', lastLine(add.out), 'git worktree add to succeed')])
  const ex = excludeCanon(root, path)
  if (!ex.ok) return refuse(ex.violations)
  // excludeCanon turned extensions.worktreeConfig on, so this setting is the scratch's alone.
  const logs = tryGit(path, 'config', '--worktree', 'core.logAllRefUpdates', 'false')
  const gitDir = tryGit(path, 'rev-parse', '--path-format=absolute', '--git-dir')
  if (!logs.ok || !gitDir.ok) return refuse([v(SCRATCH_DIR, 'scratch-create-failed', lastLine(logs.ok ? gitDir.out : logs.out), 'git config to succeed')])
  rmSync(join(gitDir.out, 'logs', 'HEAD'), { force: true })
  return ok(path)
}

// The scratch at `commit`, clean: everything untracked or ignored goes but `node_modules` and
// `target` at any depth (the prepared install and cargo's build cache survive a reset).
export function resetScratch(dir: string, commit: string): Result<void> {
  const co = tryGit(dir, 'checkout', '--quiet', '--force', '--detach', commit)
  if (!co.ok) return refuse([v(SCRATCH_DIR, 'scratch-reset', lastLine(co.out), `a clean checkout of ${visible(commit)}`)])
  const cl = tryGit(dir, 'clean', '-ffdxq', '-e', 'node_modules', '-e', 'target')
  if (!cl.ok) return refuse([v(SCRATCH_DIR, 'scratch-reset', lastLine(cl.out), 'git clean to succeed')])
  return ok(undefined)
}
