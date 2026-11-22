import { lstatSync, rmSync, type Stats } from 'node:fs'
import { git } from './gitio.js'
import { HARNESSES, loadHarness } from './harness.js'

// Row 246 (#93). The plan change set: what a plan changed, which is the diff against its base minus
// witness's own files. `init --agent` commits each harness's payload into every home, a started
// plan's worktree included, so a consumer's in-flight plan carried witness's hooks and commands in
// its diff — reviewers anchored findings and coverage on them, and the reviewed identity moved with
// every witness upgrade. Every reader of the diff asks here: the reviewed identity, the reviewer
// prompt's file list and diff, the coverage pool, the snapshot and the delta, evidence's tags and
// regression specs, verify-red's held set and `next`.
//
// Witness-owned is the union of every harness's payload targets, whichever harness is installed: a
// repo that ran pi's init once still carries pi's files after it moved to claude-code.
// `.claude/settings.json` is shared with the user's own settings, so it stays a plan change.
export function witnessPaths(): readonly string[] {
  const paths = new Set<string>()
  for (const name of HARNESSES) {
    const harness = loadHarness(name)
    if (!harness.ok) continue
    for (const { to } of harness.value.payload) paths.add(to)
  }
  return [...paths].sort()
}

// One exclude pathspec per witness path, for git commands that take pathspecs. `top` anchors it at
// the repository root from any cwd, and `literal` keeps a name's `*`, `?` or `[` from matching
// anything else.
export function witnessExcludes(): string[] {
  return witnessPaths().map((p) => `:(top,literal,exclude)${p}`)
}

// `-z` on both: with core.quotePath on (git's default), a non-ASCII or special path is printed
// quoted, and a quoted name is no path — the edit was invisible to the reviewed identity, the
// snapshot and the delta view alike.
function changedFiles(runRoot: string, base: string): string[] {
  // Row 248. git follows `diff.renames` by default, so a moved file listed only its new path: the
  // old one fell out of verify-red's red tree, the snapshot and the reviewed identity.
  const tracked = git(runRoot, 'diff', '--no-renames', '--name-only', '-z', base).split('\0').filter(Boolean)
  const untracked = git(runRoot, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)
  return [...new Set([...tracked, ...untracked])].sort()
}

export function planChangeSet(runRoot: string, base: string): string[] {
  const owned = new Set(witnessPaths())
  return changedFiles(runRoot, base).filter((rel) => !owned.has(rel))
}

// Row 248 (slice 1 review). A listed path's entry on disk, or undefined when there is none. With both
// paths of a rename listed, a rename between a file and a directory of one name lists a path under
// what is now a file: lstat says ENOTDIR there, which `throwIfNoEntry` does not cover, and the path
// is just as absent. Every reader that stats a listed path asks here.
export function lstatListed(abs: string): Stats | undefined {
  try {
    return lstatSync(abs, { throwIfNoEntry: false })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
    throw e
  }
}

// A listed path taken off the disk. One under what is now a file is already gone, and one that is
// now a directory holds the other path of the same rename: neither is a file to remove.
export function removeListed(abs: string): void {
  const st = lstatListed(abs)
  if (st !== undefined && !st.isDirectory()) rmSync(abs, { force: true })
}
