import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { carryGit, carryRef, keepCarry, keptRefs, unmergedPaths } from '../src/carry.js'
import { clashLeft, clashViolations, fileRemedies } from '../src/clash.js'
import { renderRefusal } from '../src/refusal.js'
import { shellLine, shellWord } from '../src/toon.js'
import { worktreePath } from '../src/worktree.js'

// Row 243 (design §4.1.2, §4.1.3, §4.1.5). The one predicate every gate, evidence run, turn and
// ship asks, and the per-file rows its refusal prints. A tmp repo with a linked worktree `wt` on
// branch witness/p1, as witness makes them.

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const ntfs = process.platform === 'win32'

let root: string
let wt: string
const put = (rel: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(wt, rel)), { recursive: true })
  writeFileSync(join(wt, rel), content)
}

const LABELS = 'a\n<<<<<<< Updated upstream\nMAIN\n=======\nPLAN\n>>>>>>> Stashed changes\nc\n'

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'witness-clash-')))
  g(root, 'init', '-q', '-b', 'main')
  g(root, 'config', 'user.name', 'test')
  g(root, 'config', 'user.email', 'test@example.com')
  g(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), '.witness/\n')
  writeFileSync(join(root, 'f.md'), 'a\nb\nc\n')
  g(root, 'add', '.')
  g(root, 'commit', '-qm', 'base')
  wt = worktreePath(root, 'p1')
  g(root, 'worktree', 'add', '-q', '-b', 'witness/p1', wt)
})

// Each name committed with three lines; the plan's uncommitted work and a moved base both rewrite
// the middle one, and the carry put back clashes on every name — stash apply's own conflict.
function stashClash(names: string[], opts: { plan?: (n: string) => string | Buffer | null; base?: (n: string) => string | Buffer | null } = {}): string {
  for (const n of names) put(n, 'a\nb\nc\n')
  g(wt, '--literal-pathspecs', 'add', '--', ...names)
  g(wt, 'commit', '-q', '--allow-empty', '-m', 'add')
  for (const n of names) write(n, opts.plan ? opts.plan(n) : 'a\nPLAN\nc\n')
  const carry = carryGit(wt, 'stash', 'create').stdout.trim()
  g(wt, 'reset', '-q', '--hard')
  for (const n of names) write(n, opts.base ? opts.base(n) : 'a\nMAIN\nc\n')
  g(wt, '--literal-pathspecs', 'add', '-A', '--', ...names)
  g(wt, 'commit', '-qm', 'main moved')
  expect(carryGit(wt, 'stash', 'apply', carry).stdout).toMatch(/CONFLICT/)
  return carry
}
const write = (n: string, content: string | Buffer | null): void => {
  if (content === null) g(wt, '--literal-pathspecs', 'rm', '-q', '--', n)
  else put(n, content)
}

// A kept ref listing `files`, made the way the carry makes one.
function kept(files: string[]): string {
  put('carried.txt', 'work\n')
  g(wt, 'add', 'carried.txt')
  const carry = carryGit(wt, 'stash', 'create').stdout.trim()
  g(wt, 'reset', '-q', '--hard')
  carryGit(wt, 'update-ref', carryRef('p1'), carry)
  const k = keepCarry(wt, 'p1', carry, files)
  expect(k.ok).toBe(true)
  return k.ok ? k.value : ''
}

// `clashed(placement)` builds a kept ref listing f.md and writes the stash-apply label lines into
// f.md unstaged, staged, or committed.
function clashed(placement: string): void {
  kept(['f.md'])
  put('f.md', LABELS)
  if (placement !== 'unstaged') g(wt, 'add', 'f.md')
  if (placement === 'committed') g(wt, 'commit', '-qm', 'markers committed')
}

describe('clashLeft (design §4.1.2)', () => {
  it('signal (a): unmerged entries', () => {
    stashClash(['f.md'])
    expect(clashLeft(wt, 'p1', 'main')?.kind).toBe('unmerged')
    const s = clashLeft(wt, 'p1', 'main')
    expect(s?.kind === 'unmerged' && s.files.map((f) => f.path)).toEqual(['f.md'])
  })

  it('none in a clean worktree, and none for a plan with no kept ref', () => {
    expect(clashLeft(wt, 'p1', 'main')).toBeUndefined()
    put('f.md', LABELS)
    expect(clashLeft(wt, 'p1', 'main')).toBeUndefined()
  })

  it.each(['unstaged', 'staged', 'committed'])('signal (b): %s label lines in a kept ref\'s file (P36)', (p) => {
    clashed(p)
    expect(clashLeft(wt, 'p1', 'main')).toEqual({ kind: 'labels', files: ['f.md'] })
  })

  it('signal (b): a plain ======= line or a setext underline never counts (P22)', () => {
    kept(['f.md'])
    writeFileSync(join(wt, 'f.md'), 'Title\n=======\n')   // kept ref lists f.md
    expect(clashLeft(wt, 'p1', 'main')).toBeUndefined()
  })

  it('signal (b): a label line already on the ship branch is not the plan\'s', () => {
    kept(['f.md'])
    put('f.md', LABELS)
    g(wt, 'commit', '-qam', 'a doc that quotes the labels')
    g(wt, 'update-ref', 'refs/heads/main', 'HEAD')
    expect(clashLeft(wt, 'p1', 'main')).toBeUndefined()
  })

  it('signal (b): the remote ship branch is the base before the local one', () => {
    kept(['f.md'])
    put('f.md', LABELS)
    g(wt, 'commit', '-qam', 'a doc that quotes the labels, merged on origin')
    // the local main lags; origin's main already holds the doc
    g(wt, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    expect(clashLeft(wt, 'p1', 'main')).toBeUndefined()
    g(wt, 'update-ref', '-d', 'refs/remotes/origin/main')
    expect(clashLeft(wt, 'p1', 'main')).toEqual({ kind: 'labels', files: ['f.md'] })
  })

  it('signal (b): with no merge-base, the listed file itself is read, failing closed', () => {
    clashed('committed')
    expect(clashLeft(wt, 'p1', 'no-such-branch')).toEqual({ kind: 'labels', files: ['f.md'] })
    put('f.md', 'a\nresolved\nc\n')
    expect(clashLeft(wt, 'p1', 'no-such-branch')).toBeUndefined()
  })

  it('signal (b): labels with 9-char markers count (conflict-marker-size, P51)', () => {
    kept(['f.md'])
    const attributes = resolve(wt, g(wt, 'rev-parse', '--git-path', 'info/attributes'))
    mkdirSync(dirname(attributes), { recursive: true })
    writeFileSync(attributes, 'f.md conflict-marker-size=9\n')
    stashClash(['f.md'])
    // the old skills' path: the markers staged by hand, so no unmerged entry is left
    g(wt, 'add', 'f.md')
    expect(readFileSync(join(wt, 'f.md'), 'utf8')).toMatch(/^<{9} Updated upstream$/m)
    expect(clashLeft(wt, 'p1', 'main')).toEqual({ kind: 'labels', files: ['f.md'] })
  })

  it.each([['diff', '-diff attribute'], ['textconv', 'textconv driver'], ['color.ui', 'always'],
    ['diff.noprefix', 'true'], ['diff.relative', 'true']])('signal (b) holds under %s (P36, P44)', (what, value) => {
    clashed('staged')
    const attributes = resolve(wt, g(wt, 'rev-parse', '--git-path', 'info/attributes'))
    mkdirSync(dirname(attributes), { recursive: true })
    if (what === 'diff') writeFileSync(attributes, 'f.md -diff\n')
    else if (what === 'textconv') {
      writeFileSync(attributes, 'f.md diff=hide\n')
      g(wt, 'config', 'diff.hide.textconv', 'sed s/^/X/')
    } else g(wt, 'config', what, value)
    // the setting does what it says to a plain diff, so the guard's flags are what keep the labels
    if (what === 'diff') expect(g(wt, 'diff', 'HEAD', '--', 'f.md')).toMatch(/^Binary files/m)
    if (what === 'textconv') expect(g(wt, 'diff', 'HEAD', '--', 'f.md')).toMatch(/^\+X<<<<<<< Updated upstream/m)
    if (what === 'color.ui') expect(g(wt, 'diff', 'HEAD', '--', 'f.md')).toMatch(/\u001b\[/)
    expect(clashLeft(wt, 'p1', 'main')).toEqual({ kind: 'labels', files: ['f.md'] })
  })

  it.skipIf(ntfs)('signal (b) names :foo.md and [x].md literally; x.md beside [x].md is not read (P51)', () => {
    for (const n of [':foo.md', '[x].md', 'x.md', 'foo.md']) put(n, 'a\nb\nc\n')
    g(wt, 'add', '--', '.')
    g(wt, 'commit', '-qm', 'odd names')
    kept([':foo.md', '[x].md'])
    // labels only in names the kept ref does not list, which a pathspec would read in their stead
    put('x.md', LABELS)
    put('foo.md', LABELS)
    expect(clashLeft(wt, 'p1', 'main')).toBeUndefined()
    put(':foo.md', LABELS)
    expect(clashLeft(wt, 'p1', 'main')).toEqual({ kind: 'labels', files: [':foo.md'] })
    put('[x].md', LABELS)
    expect(clashLeft(wt, 'p1', 'main')).toEqual({ kind: 'labels', files: [':foo.md', '[x].md'] })
  })

  it('the order is the carry (c), then unmerged entries (a), then label lines (b) (§4.1.5)', () => {
    clashed('staged')
    stashClash(['g.md'])
    expect(clashLeft(wt, 'p1', 'main')?.kind).toBe('unmerged')
    g(wt, 'update-ref', carryRef('p1'), 'HEAD')
    expect(clashLeft(wt, 'p1', 'main')).toEqual({ kind: 'carry', ref: carryRef('p1') })
  })
})

describe('clashViolations (design §4.1.2 "The refusal")', () => {
  it('signal (c): a carry ref present → kind carry; its violation leads with witness ship p1 and names no file', () => {
    stashClash(['f.md'])
    g(wt, 'update-ref', carryRef('p1'), 'HEAD')
    expect(clashLeft(wt, 'p1', 'main')).toEqual({ kind: 'carry', ref: carryRef('p1') })
    const v = clashViolations('p1', { kind: 'carry', ref: carryRef('p1') }, wt)
    expect(v).toHaveLength(1)
    expect(v[0]!.rule).toBe('clash-unresolved')
    expect(v[0]!.want).toMatch(/^witness ship p1/)
    expect(v[0]!.remedy).toBe('witness ship p1')
    expect(JSON.stringify(v)).not.toMatch(/f\.md/)
  })

  it('signal (a): one row per file, each with its remedy, and no runnable remedy', () => {
    stashClash(['f.md', '-x.md', 'a b.md'])
    const s = clashLeft(wt, 'p1', 'main')!
    const v = clashViolations('p1', s, wt)
    expect(v.map((x) => x.field)).toEqual(['-x.md', 'a b.md', 'f.md'].map((n) => shellWord(n)))
    expect(v.every((x) => x.rule === 'clash-unresolved' && x.got === 'unmerged (UU)' && x.remedy === undefined)).toBe(true)
    expect(v[0]!.want).toBe(`content — resolve the conflict markers keeping both sides' intent, then ${shellLine(['git', 'add', '--', '-x.md'])}`)
    expect(v[1]!.want).toContain(shellLine(['git', 'add', '--', 'a b.md']))
    expect(renderRefusal(v).some((l) => l.startsWith('run:'))).toBe(false)
  })

  it('signal (b): one row per file, naming the kept ref and the escape as prose', () => {
    clashed('staged')
    const v = clashViolations('p1', clashLeft(wt, 'p1', 'main')!, wt)
    expect(v).toHaveLength(1)
    expect(v[0]!.field).toBe('f.md')
    expect(v[0]!.rule).toBe('clash-unresolved')
    expect(v[0]!.got).toContain('refs/witness/kept/p1/1')
    expect(v[0]!.want).toContain(`then ${shellLine(['git', 'add', '--', 'f.md'])}`)
    expect(v[0]!.want).toMatch(/moves refs\/witness\/kept\/p1\/1 out of refs\/witness\/kept\//)
    expect(v[0]!.want).toMatch(/the backup itself is kept/)
    expect(v[0]!.remedy).toBeUndefined()
    // the escape works as written: the ref moved out, the file is released and the backup stays
    g(wt, 'update-ref', 'refs/witness/released/p1/1', 'refs/witness/kept/p1/1')
    g(wt, 'update-ref', '-d', 'refs/witness/kept/p1/1')
    expect(clashLeft(wt, 'p1', 'main')).toBeUndefined()
    expect(keptRefs(wt, 'p1')).toEqual([])
    expect(g(wt, 'stash', 'show', '--name-only', 'refs/witness/released/p1/1')).toBe('carried.txt')
  })

  it('a session\'s rebase in progress names the rebase\'s sides', () => {
    put('b.bin', Buffer.from('bin\0base'))
    g(wt, 'add', 'b.bin')
    g(wt, 'commit', '-qm', 'bin')
    g(wt, 'branch', 'other')
    put('b.bin', Buffer.from('bin\0PLAN'))
    g(wt, 'commit', '-qam', 'plan')
    g(wt, 'switch', '-q', 'other')
    put('b.bin', Buffer.from('bin\0MAIN'))
    g(wt, 'commit', '-qam', 'main')
    g(wt, 'switch', '-q', 'witness/p1')
    expect(carryGit(wt, 'rebase', 'other').code).not.toBe(0)
    const v = clashViolations('p1', clashLeft(wt, 'p1', 'main')!, wt)
    expect(v[0]!.want).toContain(`${shellLine(['git', 'checkout', '--theirs', '--', 'b.bin'])} keeps the plan's commit`)
    carryGit(wt, 'rebase', '--abort')
  })
})

describe('fileRemedies (design §4.1.3, S1-4, S1-5, S1-7)', () => {
  it('content, binary, and modify/delete in a stash apply: theirs is the plan\'s side', () => {
    put('b.bin', Buffer.from('bin\0base'))
    put('gone.md', 'a\nb\nc\n')
    put('kept.md', 'a\nb\nc\n')
    g(wt, 'add', '.')
    g(wt, 'commit', '-qm', 'files')
    // the plan: rewrites f.md and b.bin, deletes gone.md, rewrites kept.md
    put('f.md', 'a\nPLAN\nc\n')
    put('b.bin', Buffer.from('bin\0PLAN'))
    g(wt, 'rm', '-q', 'gone.md')
    put('kept.md', 'a\nPLAN\nc\n')
    const carry = carryGit(wt, 'stash', 'create').stdout.trim()
    g(wt, 'reset', '-q', '--hard')
    // the moved base: rewrites f.md, b.bin and gone.md, deletes kept.md
    put('f.md', 'a\nMAIN\nc\n')
    put('b.bin', Buffer.from('bin\0MAIN'))
    put('gone.md', 'a\nMAIN\nc\n')
    g(wt, 'rm', '-q', 'kept.md')
    g(wt, 'add', '-A')
    g(wt, 'commit', '-qm', 'main moved')
    carryGit(wt, 'stash', 'apply', carry)
    const files = unmergedPaths(wt)
    expect(files.map((f) => f.path)).toEqual(['b.bin', 'f.md', 'gone.md', 'kept.md'])
    const rows = fileRemedies(wt, files, 'stash')
    expect(rows[0]).toBe(`binary — ${shellLine(['git', 'checkout', '--theirs', '--', 'b.bin'])} keeps the plan's version, ${shellLine(['git', 'checkout', '--ours', '--', 'b.bin'])} keeps the base's version; then ${shellLine(['git', 'add', '--', 'b.bin'])}`)
    expect(rows[1]).toBe(`content — resolve the conflict markers keeping both sides' intent, then ${shellLine(['git', 'add', '--', 'f.md'])}`)
    expect(rows[2]).toBe(`modify/delete — the plan's side deleted it and the base's side changed it: ${shellLine(['git', 'rm', '--', 'gone.md'])} keeps the deletion, ${shellLine(['git', 'add', '--', 'gone.md'])} keeps the change`)
    expect(rows[3]).toBe(`modify/delete — the base's side deleted it and the plan's side changed it: ${shellLine(['git', 'rm', '--', 'kept.md'])} keeps the deletion, ${shellLine(['git', 'add', '--', 'kept.md'])} keeps the change`)
    // each remedy does what its row says: --theirs is the plan's bytes, and add clears the entry
    g(wt, 'checkout', '--theirs', '--', 'b.bin')
    g(wt, 'add', '--', 'b.bin')
    expect(readFileSync(join(wt, 'b.bin'))).toEqual(Buffer.from('bin\0PLAN'))
    g(wt, 'add', '--', 'kept.md')
    expect(readFileSync(join(wt, 'kept.md'), 'utf8')).toBe('a\nPLAN\nc\n')
    expect(unmergedPaths(wt).map((f) => f.path)).toEqual(['f.md', 'gone.md'])
  })

  // S1-A. A side is offered only while the file still holds a version git left in a stage: then
  // checking either side out throws nothing away. A file the session resolved, or partly resolved,
  // and has not staged yet holds bytes only the worktree has.
  it('a text file still holding one side\'s version as git left it is both changed, no markers, with both checkouts', () => {
    stashClash(['f.md'])
    put('f.md', 'a\nPLAN\nc\n') // stage 3's bytes: the plan's version in a stash apply
    const [row] = fileRemedies(wt, unmergedPaths(wt), 'stash')
    expect(row).toBe(`both changed, no markers — ${shellLine(['git', 'checkout', '--theirs', '--', 'f.md'])} keeps the plan's version, `
      + `${shellLine(['git', 'checkout', '--ours', '--', 'f.md'])} keeps the base's version; then ${shellLine(['git', 'add', '--', 'f.md'])}`)
  })

  it('a text file resolved but not staged is told it has no markers left, and offered no checkout of a side (S1-A)', () => {
    stashClash(['f.md'])
    put('f.md', 'a\nMAIN+PLAN\nc\n')
    const [row] = fileRemedies(wt, unmergedPaths(wt), 'stash')
    expect(row).toBe(`no markers left — no conflict markers are left in it: if this is the resolution, ${shellLine(['git', 'add', '--', 'f.md'])} `
      + `records it; ${shellLine(['git', 'checkout', '-m', '--', 'f.md'])} puts the markers back`)
    expect(row).not.toMatch(/--theirs|--ours/)
    // the guard's row is prose, never a runnable line
    const v = clashViolations('p1', clashLeft(wt, 'p1', 'main')!, wt)
    expect(v[0]!.want).toBe(row)
    expect(v[0]!.remedy).toBeUndefined()
    // and what it names does what it says: checkout -m puts the markers back, still unmerged
    g(wt, 'checkout', '-m', '--', 'f.md')
    expect(readFileSync(join(wt, 'f.md'), 'utf8')).toMatch(/^<{7} /m)
    expect(unmergedPaths(wt).map((f) => f.path)).toEqual(['f.md'])
  })

  it('a text file with one marker left is still content to finish resolving (S1-A)', () => {
    stashClash(['f.md', 'g.md'])
    put('f.md', 'a\n<<<<<<< Updated upstream\nMAIN\n=======\nPLAN\nc\n') // the closing marker removed
    put('g.md', 'a\nMAIN and PLAN\n>>>>>>> Stashed changes\nc\n') // the opening marker removed
    const rows = fileRemedies(wt, unmergedPaths(wt), 'stash')
    expect(rows).toEqual(['f.md', 'g.md'].map((f) =>
      `content — resolve the conflict markers keeping both sides' intent, then ${shellLine(['git', 'add', '--', f])}`))
  })

  it('a binary file rewritten since git left it offers its staging first, and names what a side\'s checkout replaces (S1-A)', () => {
    put('b.bin', Buffer.from('bin\0base'))
    g(wt, 'add', 'b.bin')
    g(wt, 'commit', '-qm', 'bin')
    put('b.bin', Buffer.from('bin\0PLAN'))
    const carry = carryGit(wt, 'stash', 'create').stdout.trim()
    g(wt, 'reset', '-q', '--hard')
    put('b.bin', Buffer.from('bin\0MAIN'))
    g(wt, 'commit', '-qam', 'main moved')
    carryGit(wt, 'stash', 'apply', carry)
    put('b.bin', Buffer.from('bin\0REGENERATED'))
    const [row] = fileRemedies(wt, unmergedPaths(wt), 'stash')
    expect(row).toBe(`binary, neither side's version — if these bytes are the resolution, ${shellLine(['git', 'add', '--', 'b.bin'])} records them; `
      + `${shellLine(['git', 'checkout', '--theirs', '--', 'b.bin'])} would replace them with the plan's version, `
      + `${shellLine(['git', 'checkout', '--ours', '--', 'b.bin'])} with the base's version`)
  })

  it('a rebase\'s clash and a merge\'s clash name their sides for that operation (S1-5)', () => {
    put('b.bin', Buffer.from('bin\0base'))
    g(wt, 'add', 'b.bin')
    g(wt, 'commit', '-qm', 'bin')
    g(wt, 'branch', 'other')
    put('b.bin', Buffer.from('bin\0PLAN'))
    put('f.md', 'a\nPLAN\nc\n')
    g(wt, 'commit', '-qam', 'plan')
    g(wt, 'switch', '-q', 'other')
    put('b.bin', Buffer.from('bin\0MAIN'))
    put('f.md', 'a\nMAIN\nc\n')
    g(wt, 'commit', '-qam', 'main')
    g(wt, 'switch', '-q', 'witness/p1')
    const theirs = shellLine(['git', 'checkout', '--theirs', '--', 'b.bin'])
    const ours = shellLine(['git', 'checkout', '--ours', '--', 'b.bin'])

    // a rebase replays the plan's commit onto the base: theirs is the plan's
    expect(carryGit(wt, 'rebase', 'other').code).not.toBe(0)
    let rows = fileRemedies(wt, unmergedPaths(wt), 'rebase')
    expect(rows[0]).toContain(`${theirs} keeps the plan's commit, ${ours} keeps the base's version`)
    // a rebase's own markers (`<<<<<<< HEAD`) read as content (S1-5)
    expect(readFileSync(join(wt, 'f.md'), 'utf8')).toMatch(/^<<<<<<< /m)
    expect(rows[1]).toMatch(/^content — /)
    carryGit(wt, 'rebase', '--abort')

    // a merge into the plan's branch: ours is the plan's
    expect(carryGit(wt, 'merge', 'other').code).not.toBe(0)
    rows = fileRemedies(wt, unmergedPaths(wt), 'merge')
    expect(rows[0]).toContain(`${ours} keeps the plan's version (HEAD), ${theirs} keeps the merged-in version`)
    expect(rows[1]).toMatch(/^content — /)
    // and the guard reads the operation itself
    expect(clashViolations('p1', clashLeft(wt, 'p1', 'main')!, wt)[0]!.want).toBe(rows[0])
    carryGit(wt, 'merge', '--abort')
  })

  it.skipIf(ntfs)('the remedies for :x.md and [x].md, run as printed, stage exactly that file (S1-7)', () => {
    // x.md, which `:x.md` and `[x].md` name as pathspecs, holds work that must stay unstaged
    put('x.md', 'unrelated\n')
    g(wt, 'add', 'x.md')
    g(wt, 'commit', '-qm', 'x.md')
    stashClash([':x.md', '[x].md'])
    put('x.md', 'unstaged work\n')
    const files = unmergedPaths(wt)
    expect(files.map((f) => f.path)).toEqual([':x.md', '[x].md'])
    const rows = fileRemedies(wt, files, 'stash')
    for (const [i, n] of [':x.md', '[x].md'].entries()) {
      const line = shellLine(['git', '--literal-pathspecs', 'add', '--', n])
      expect(rows[i]).toBe(`content — resolve the conflict markers keeping both sides' intent, then ${line}`)
      put(n, 'a\nresolved\nc\n')
      execFileSync('/bin/sh', ['-c', line], { cwd: wt })
    }
    expect(unmergedPaths(wt)).toEqual([])
    expect(g(wt, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).sort()).toEqual([':x.md', '[x].md'])
    expect(g(wt, 'diff', '--name-only')).toBe('x.md')
  })

  it.skipIf(ntfs)('a name with a newline is shown with a note and offered as no runnable line (S1-4)', () => {
    stashClash(['a\nb.md'])
    const files = unmergedPaths(wt)
    expect(files.map((f) => f.path)).toEqual(['a\nb.md'])
    const [row] = fileRemedies(wt, files, 'stash')
    expect(row).toContain(shellLine(['git', 'add', '--', 'a\nb.md']))
    expect(row).toMatch(/not offered — it holds a control or line-break character/)
    expect(row).not.toMatch(/[\n\r]/)
    const v = clashViolations('p1', clashLeft(wt, 'p1', 'main')!, wt)
    expect(v[0]!.field).toBe(shellWord('a\nb.md'))
    expect(v[0]!.remedy).toBeUndefined()
    const printed = renderRefusal(v)
    expect(printed.some((l) => /^\s*run:/.test(l))).toBe(false)
    expect(printed.every((l) => !l.includes('\n'))).toBe(true)
  })
})
