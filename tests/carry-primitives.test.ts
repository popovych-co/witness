import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CARRY_ACTION, carryGit, carryRef, keepCarry, keptPrefix, keptRefs, operationInProgress, remedyLine,
  unmergedPaths, untrackedInTheWay,
} from '../src/carry.js'
import { shellLine } from '../src/toon.js'
import { worktreePath } from '../src/worktree.js'

// Row 243 (design §4.1.1 steps 2, 4, 7). The carry's git primitives, each against a real repo: a
// primary checkout on main and a linked worktree `wt` on branch witness/p1, as witness makes them.

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const fails = (cwd: string, ...args: string[]): boolean => {
  try { g(cwd, ...args); return false } catch { return true }
}

let root: string
let wt: string
const put = (rel: string, content: string | Buffer, at = wt): void => {
  mkdirSync(dirname(join(at, rel)), { recursive: true })
  writeFileSync(join(at, rel), content)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'witness-carry-')))
  g(root, 'init', '-q', '-b', 'main')
  g(root, 'config', 'user.name', 'test')
  g(root, 'config', 'user.email', 'test@example.com')
  g(root, 'config', 'commit.gpgsign', 'false')
  put('.gitignore', '.witness/\n', root)
  put('f.md', 'a\nb\nc\n', root)
  g(root, 'add', '.')
  g(root, 'commit', '-qm', 'base')
  wt = worktreePath(root, 'p1')
  g(root, 'worktree', 'add', '-q', '-b', 'witness/p1', wt)
})

// A branch `other` off the base that rewrites f.md's middle line, and witness/p1 rewriting it too.
function divergent(): void {
  g(wt, 'branch', 'other')
  g(wt, 'switch', '-q', 'other')
  put('f.md', 'a\nOTHER\nc\n')
  g(wt, 'commit', '-qam', 'other')
  g(wt, 'switch', '-q', 'witness/p1')
  put('f.md', 'a\nPLAN\nc\n')
  g(wt, 'commit', '-qam', 'plan')
}

describe('operationInProgress (design §4.1.1 step 2, P19)', () => {
  it('names every operation in progress through git-path, worktree-aware (P19)', () => {
    divergent()
    expect(operationInProgress(wt)).toBeUndefined()
    // start a conflicting `git merge` inside wt
    expect(carryGit(wt, 'merge', 'other').code).not.toBe(0)
    expect(operationInProgress(wt)).toBe('MERGE_HEAD')
    // the primary checkout has no operation of its own: the marker lives in wt's own git dir
    expect(operationInProgress(root)).toBeUndefined()
    carryGit(wt, 'merge', '--abort')
    expect(operationInProgress(wt)).toBeUndefined()
  })

  it('names a rebase of either backend, a cherry-pick and a revert', () => {
    divergent()
    expect(carryGit(wt, 'rebase', 'other').code).not.toBe(0)
    expect(operationInProgress(wt)).toBe('rebase-merge')
    carryGit(wt, 'rebase', '--abort')
    expect(carryGit(wt, 'rebase', '--apply', 'other').code).not.toBe(0)
    expect(operationInProgress(wt)).toBe('rebase-apply')
    carryGit(wt, 'rebase', '--abort')
    expect(carryGit(wt, 'cherry-pick', 'other').code).not.toBe(0)
    expect(operationInProgress(wt)).toBe('CHERRY_PICK_HEAD')
    carryGit(wt, 'cherry-pick', '--abort')
    // reverting `plan` under a later rewrite of the same line conflicts
    put('f.md', 'a\nPLAN2\nc\n')
    g(wt, 'commit', '-qam', 'plan2')
    expect(carryGit(wt, 'revert', '--no-edit', 'HEAD~1').code).not.toBe(0)
    expect(operationInProgress(wt)).toBe('REVERT_HEAD')
    carryGit(wt, 'revert', '--abort')
    expect(operationInProgress(wt)).toBeUndefined()
  })
})

describe('carryGit', () => {
  it('runs git under LC_ALL=C with witness\'s reflog action, keeping both streams', () => {
    put('f.md', 'a\nPLAN\nc\n')
    g(wt, 'commit', '-qam', 'plan')
    const reflog = g(wt, 'reflog', '-1', '--format=%gs')
    expect(reflog).not.toMatch(CARRY_ACTION)
    expect(carryGit(wt, 'reset', '-q', '--hard', 'HEAD~1').code).toBe(0)
    expect(g(wt, 'reflog', '-1', '--format=%gs')).toMatch(new RegExp(`^${CARRY_ACTION}`))
    const missing = carryGit(wt, 'rev-parse', '--verify', 'no-such-ref')
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toMatch(/fatal: Needed a single revision/)
    expect(carryGit(wt, 'rev-parse', 'HEAD').stdout).toMatch(/^[0-9a-f]{40}\n$/)
  })

  it('names the carry ref and the kept refs\' prefix per plan', () => {
    expect(carryRef('p1')).toBe('refs/witness/carry/p1')
    expect(keptPrefix('p1')).toBe('refs/witness/kept/p1/')
  })
})

describe('keepCarry and keptRefs (design §4.1.1 step 7)', () => {
  it('a kept ref is stash-shaped, numbered, never overwritten, and lists its files as written', () => {
    put('f.md', 'a\nPLAN\nc\n')
    const carry = carryGit(wt, 'stash', 'create').stdout.trim()
    expect(carry).toMatch(/^[0-9a-f]{40}$/)
    carryGit(wt, 'update-ref', carryRef('p1'), carry)
    const k1 = keepCarry(wt, 'p1', carry, ['-x [y].md', 'a\nb.md'])
    expect(k1.ok && k1.value).toBe('refs/witness/kept/p1/1')
    expect(carryGit(wt, 'rev-parse', '--verify', '--quiet', carryRef('p1')).code).not.toBe(0)
    expect(keptRefs(wt, 'p1')[0]!.files).toEqual(['-x [y].md', 'a\nb.md'])
    expect(carryGit(wt, 'stash', 'show', '-p', 'refs/witness/kept/p1/1').code).toBe(0)
    expect(carryGit(wt, 'stash', 'list').stdout).toBe('')            // the shared list untouched
    // the carry's own tree and parents, so `stash apply --index` reads it as the carry
    const k1sha = g(wt, 'rev-parse', 'refs/witness/kept/p1/1')
    expect(g(wt, 'rev-parse', `${k1sha}^{tree}`, `${k1sha}^1`, `${k1sha}^2`))
      .toBe(g(wt, 'rev-parse', `${carry}^{tree}`, `${carry}^1`, `${carry}^2`))
    expect(g(wt, 'show', '-s', '--format=%B', k1sha)).toBe(`witness kept p1\n\nfiles: ${JSON.stringify(['-x [y].md', 'a\nb.md'])}`)
    carryGit(wt, 'update-ref', carryRef('p1'), carry)
    expect(keepCarry(wt, 'p1', carry, ['f'])).toEqual({ ok: true, value: 'refs/witness/kept/p1/2' })
    // the first is never overwritten
    expect(g(wt, 'rev-parse', 'refs/witness/kept/p1/1')).toBe(k1sha)
    expect(keptRefs(wt, 'p1').map((k) => [k.ref, k.files])).toEqual([
      ['refs/witness/kept/p1/1', ['-x [y].md', 'a\nb.md']],
      ['refs/witness/kept/p1/2', ['f']],
    ])
    // the work comes back from a kept ref as from the carry
    g(wt, 'reset', '-q', '--hard')
    expect(carryGit(wt, 'stash', 'apply', '--index', 'refs/witness/kept/p1/1').code).toBe(0)
    expect(g(wt, 'diff', '--name-only')).toBe('f.md')
  })

  it('numbers after the highest kept ref, read in numeric order, and never reads another plan\'s', () => {
    put('f.md', 'a\nPLAN\nc\n')
    const carry = carryGit(wt, 'stash', 'create').stdout.trim()
    const head = g(wt, 'rev-parse', 'HEAD')
    for (const n of ['2', '9']) g(wt, 'update-ref', `refs/witness/kept/p1/${n}`, carry)
    g(wt, 'update-ref', 'refs/witness/kept/p10/1', head)
    g(wt, 'update-ref', carryRef('p1'), carry)
    expect(keepCarry(wt, 'p1', carry, ['f.md'])).toEqual({ ok: true, value: 'refs/witness/kept/p1/10' })
    expect(keptRefs(wt, 'p1').map((k) => k.ref)).toEqual(['refs/witness/kept/p1/2', 'refs/witness/kept/p1/9', 'refs/witness/kept/p1/10'])
    expect(keptRefs(wt, 'p1').at(-1)!.files).toEqual(['f.md'])
    // a ref with no files line lists none
    expect(keptRefs(wt, 'p1')[0]!.files).toEqual([])
    expect(keptRefs(wt, 'p10').map((k) => k.ref)).toEqual(['refs/witness/kept/p10/1'])
  })

  it('a carry ref that moved is never deleted: carry-pending, naming the carry ref, which is kept', () => {
    put('f.md', 'a\nPLAN\nc\n')
    const carry = carryGit(wt, 'stash', 'create').stdout.trim()
    const head = g(wt, 'rev-parse', 'HEAD')
    g(wt, 'update-ref', carryRef('p1'), head)
    const r = keepCarry(wt, 'p1', carry, ['f.md'])
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations[0]! : undefined
    expect(x?.rule).toBe('carry-pending')
    expect(x?.field).toBe(carryRef('p1'))
    expect(x?.want).toContain(shellLine(['git', 'stash', 'show', '-p', carryRef('p1')]))
    expect(x?.want).toContain('witness ship p1')
    expect(g(wt, 'rev-parse', carryRef('p1'))).toBe(head)
  })

  it('a carry that is no commit refuses carry-pending before any kept ref is made', () => {
    g(wt, 'update-ref', carryRef('p1'), g(wt, 'rev-parse', 'HEAD'))
    const r = keepCarry(wt, 'p1', '0'.repeat(40), ['f.md'])
    expect(!r.ok && r.violations[0]!.rule).toBe('carry-pending')
    expect(keptRefs(wt, 'p1')).toEqual([])
    expect(fails(wt, 'rev-parse', '--verify', carryRef('p1'))).toBe(false)
  })
})

describe('unmergedPaths (design §4.1.2 signal (a))', () => {
  it('unmergedPaths reads NUL-separated names unquoted, with each stage blob (P51)', () => {
    const name = 'é [x].md'
    put(name, 'a\nb\nc\n')
    g(wt, 'add', '--', name)
    g(wt, 'commit', '-qm', 'add')
    // clash a file named 'é [x].md' via a conflicting `git stash apply`
    put(name, 'a\nPLAN\nc\n')
    const carry = g(wt, 'stash', 'create')
    g(wt, 'reset', '-q', '--hard')
    put(name, 'a\nMAIN\nc\n')
    g(wt, 'commit', '-qam', 'main')
    expect(carryGit(wt, 'stash', 'apply', carry).stdout).toMatch(/CONFLICT/)
    expect(unmergedPaths(wt).map((u) => u.path)).toEqual([name])
    expect(Object.keys(unmergedPaths(wt)[0]!.stages).sort()).toEqual(['1', '2', '3'])
    const stages = unmergedPaths(wt)[0]!.stages
    expect(stages[1]).toBe(g(wt, 'rev-parse', `${carry}^1:${name}`))
    expect(stages[2]).toBe(g(wt, 'rev-parse', `HEAD:${name}`))
    expect(stages[3]).toBe(g(wt, 'rev-parse', `${carry}:${name}`))
  })

  it('a side that deleted the file has no stage', () => {
    put('f.md', 'a\nPLAN\nc\n')
    const carry = g(wt, 'stash', 'create')
    g(wt, 'reset', '-q', '--hard')
    g(wt, 'rm', '-q', 'f.md')
    g(wt, 'commit', '-qm', 'drop f.md')
    carryGit(wt, 'stash', 'apply', carry)
    expect(unmergedPaths(wt)).toEqual([{ path: 'f.md', stages: {
      1: g(wt, 'rev-parse', `${carry}^1:f.md`), 3: g(wt, 'rev-parse', `${carry}:f.md`),
    } }])
  })

  it('none when the index has no unmerged entry', () => {
    expect(unmergedPaths(wt)).toEqual([])
  })
})

describe('untrackedInTheWay (S1-1, S1-2)', () => {
  it('names an untracked file at a path, under a path, or where a path needs a directory', () => {
    put('n.txt', 'session\n')
    put('d/x.txt', 'session\n')
    put('e', 'session\n')
    expect(untrackedInTheWay(wt, ['n.txt', 'd', 'e/y.txt', 'f.md', 'other.txt'])?.sort()).toEqual(['d/x.txt', 'e', 'n.txt'])
    expect(untrackedInTheWay(wt, [])).toEqual([])
  })

  it('compares without case under core.ignorecase, and with it otherwise (S1-2)', () => {
    put('NOTES.md', 'session\n')
    g(wt, 'config', 'core.ignorecase', 'true')
    expect(untrackedInTheWay(wt, ['notes.md'])).toEqual(['NOTES.md'])
    g(wt, 'config', 'core.ignorecase', 'false')
    expect(untrackedInTheWay(wt, ['notes.md'])).toEqual([])
  })

  it('an ignored file is git\'s own to replace, and is not in the way', () => {
    put('.witness/x', 'local\n')
    expect(untrackedInTheWay(wt, ['.witness/x'])).toEqual([])
  })
})

describe('remedyLine (S1-4, S1-7)', () => {
  it('a name git reads as pathspec magic or a glob gets --literal-pathspecs; a plain one does not', () => {
    for (const n of [':x.md', '[x].md', '*.md', 'a?.md', 'a\\b.md']) {
      expect(remedyLine(['git', 'add', '--', n], 'linux')).toBe(shellLine(['git', '--literal-pathspecs', 'add', '--', n], 'linux'))
    }
    for (const n of ['-x.md', 'a b.md', 'x].md']) {
      expect(remedyLine(['git', 'add', '--', n], 'linux')).toBe(shellLine(['git', 'add', '--', n], 'linux'))
    }
  })

  it('a name a terminal cannot show, or one Windows refuses, is shown with a note and never offered', () => {
    const nl = remedyLine(['git', 'add', '--', 'a\nb.md'], 'linux')
    expect(nl).toContain(shellLine(['git', 'add', '--', 'a\nb.md'], 'linux'))
    expect(nl).toMatch(/not offered/)
    expect(nl).not.toMatch(/\n/)
    expect(remedyLine(['git', 'add', '--', 'café.md'], 'linux')).toMatch(/not offered/)
    expect(remedyLine(['git', 'add', '--', "it's.md"], 'win32')).toMatch(/not offered on Windows/)
    expect(remedyLine(['git', 'add', '--', "it's.md"], 'linux')).not.toMatch(/not offered/)
  })
})
