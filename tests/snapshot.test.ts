import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changedFiles } from '../src/evidence.js'
import { diffReviewedSha } from '../src/reviewed.js'
import { blobText, changedPaths, snapshotFiles, snapshotTree, treeDiff, treeReadable } from '../src/snapshot.js'
import { tmpRepo, type TestRepo } from './helpers.js'

function based() {
  const repo = tmpRepo()
  repo.write('src/a.ts', 'a\n'); repo.write('src/b.ts', 'b\n'); repo.write('specs/s.md', 'spec\n')
  repo.git('add', '-A'); repo.git('commit', '-m', 'base')
  return { repo, base: repo.git('rev-parse', 'HEAD') }
}
const entry = (repo: TestRepo, tree: string, path: string) =>
  repo.git('ls-tree', '-r', tree).split('\n').find((l) => l.endsWith(`\t${path}`))

describe('snapshotTree', () => {
  it('overlays the worktree copy of every changed path on the base tree', () => {
    const { repo, base } = based()
    repo.write('src/a.ts', 'a2\n'); repo.write('src/new.ts', 'new\n'); rmSync(join(repo.root, 'src/b.ts'))
    symlinkSync('a.ts', join(repo.root, 'src/link.ts'))
    repo.write('bin/run.sh', '#!/bin/sh\n'); chmodSync(join(repo.root, 'bin/run.sh'), 0o755)
    const tree = snapshotTree(repo.root, base, changedFiles(repo.root, base))!
    expect(repo.git('cat-file', 'blob', `${tree}:src/a.ts`)).toBe('a2')
    expect(repo.git('cat-file', 'blob', `${tree}:src/new.ts`)).toBe('new')
    expect(entry(repo, tree, 'src/b.ts')).toBeUndefined()
    expect(entry(repo, tree, 'src/link.ts')).toMatch(/^120000 blob /)
    expect(repo.git('cat-file', 'blob', `${tree}:src/link.ts`)).toBe('a.ts')
    expect(entry(repo, tree, 'bin/run.sh')).toMatch(/^100755 blob /)
    expect(repo.git('cat-file', 'blob', `${tree}:specs/s.md`)).toBe('spec')     // base content outside the diff
  })

  it('stores a nested repo and a staged gitlink as the reviewed identity does (D161)', () => {
    const { repo, base } = based()
    const inner = join(repo.root, 'vendor/lib'); mkdirSync(inner, { recursive: true })
    const gitIn = (...a: string[]) => execFileSync('git', a, { cwd: inner, encoding: 'utf8' }).trim()
    gitIn('init', '-q', '-b', 'main'); gitIn('config', 'user.name', 't'); gitIn('config', 'user.email', 't@e')
    gitIn('config', 'commit.gpgsign', 'false'); writeFileSync(join(inner, 'f'), 'x\n'); gitIn('add', 'f'); gitIn('commit', '-qm', 'inner')
    const head = gitIn('rev-parse', 'HEAD')
    mkdirSync(join(repo.root, 'vendor/pinned'))
    repo.git('update-index', '--add', '--cacheinfo', `160000,${head},vendor/pinned`)
    const files = changedFiles(repo.root, base)
    expect(files).toContain('vendor/lib/')                          // the trailing-slash form
    const tree = snapshotTree(repo.root, base, files)!
    expect(entry(repo, tree, 'vendor/lib')).toBe(`160000 commit ${head}\tvendor/lib`)
    expect(entry(repo, tree, 'vendor/pinned')).toBe(`160000 commit ${head}\tvendor/pinned`)
  })

  // Final review #3: with core.quotePath on, git quotes a non-ASCII path, and a quoted name is no
  // path — lstat found nothing, so the edit was invisible to the snapshot and to reviewed_sha.
  it('sees an edit to a non-ASCII path, in the snapshot and in the reviewed identity', () => {
    const { repo } = based()
    repo.write('src/café.ts', 'v1\n'); repo.git('add', '-A'); repo.git('commit', '-m', 'accent')
    const base = repo.git('rev-parse', 'HEAD~1')
    const before = diffReviewedSha(repo.root, base)
    repo.write('src/café.ts', 'v2\n')
    expect(changedFiles(repo.root, base)).toContain('src/café.ts')
    expect(diffReviewedSha(repo.root, base)).not.toBe(before)
    const tree = snapshotTree(repo.root, base, changedFiles(repo.root, base))!
    expect(repo.git('cat-file', 'blob', `${tree}:src/café.ts`)).toBe('v2')
  })

  it('leaves the real index alone, and the same content always makes the same tree', () => {
    const { repo, base } = based()
    repo.write('src/a.ts', 'a2\n')
    const status = repo.git('status', '--porcelain')
    const one = snapshotTree(repo.root, base, ['src/a.ts'])
    expect(repo.git('status', '--porcelain')).toBe(status)
    expect(snapshotTree(repo.root, base, ['src/a.ts'])).toBe(one)
  })

  it('shows a path reverted to base as a revert, never as a deletion', () => {
    const { repo, base } = based()
    repo.write('src/a.ts', 'a2\n')
    const r1 = snapshotTree(repo.root, base, ['src/a.ts'])!
    repo.write('src/a.ts', 'a\n')
    const r2 = snapshotTree(repo.root, base, changedFiles(repo.root, base))!
    expect(changedPaths(repo.root, r1, r2)).toEqual(['src/a.ts'])
    const diff = treeDiff(repo.root, r1, r2)
    expect(diff).toContain('-a2'); expect(diff).toContain('+a'); expect(diff).not.toContain('deleted file')
  })

  it('works from a sparse worktree and is readable at the primary root', () => {
    const { repo } = based()
    const wt = `${repo.root}-wt`
    repo.git('worktree', 'add', '-q', '-b', 'plan-1', wt, 'main')
    const gitWt = (...a: string[]) => execFileSync('git', a, { cwd: wt, encoding: 'utf8' }).trim()
    const gd = gitWt('rev-parse', '--path-format=absolute', '--git-dir')
    mkdirSync(join(gd, 'info'), { recursive: true }); writeFileSync(join(gd, 'info', 'sparse-checkout'), '/*\n!specs/\n')
    repo.git('config', 'extensions.worktreeConfig', 'true')
    gitWt('config', '--worktree', 'core.sparseCheckout', 'true'); gitWt('config', '--worktree', 'core.sparseCheckoutCone', 'false')
    gitWt('read-tree', '-mu', 'HEAD')
    writeFileSync(join(wt, 'src/c.ts'), 'c\n')
    const base = gitWt('rev-parse', 'HEAD')
    const tree = snapshotTree(wt, base, changedFiles(wt, base))!
    expect(repo.git('cat-file', 'blob', `${tree}:src/c.ts`)).toBe('c')
    expect(gitWt('ls-files', '-t', '--', 'specs/s.md')).toBe('S specs/s.md')   // skip-worktree untouched
  })
})

describe('snapshotFiles and the readers', () => {
  it('snapshots named blobs as a flat tree and reads them back exactly', () => {
    const { repo } = based()
    const one = snapshotFiles(repo.root, [{ name: 'p.md', content: '## A\nx\n' }])!
    const two = snapshotFiles(repo.root, [{ name: 'p.md', content: '## A\ny\n' }])!
    expect(repo.git('ls-tree', '--name-only', two)).toBe('p.md')
    expect(blobText(repo.root, two, 'p.md')).toBe('## A\ny\n')
    expect(blobText(repo.root, two, 'missing.md')).toBeUndefined()
    expect(changedPaths(repo.root, one, two)).toEqual(['p.md'])
    expect(changedPaths(repo.root, one, one)).toEqual([])
  })

  it('the diff text holds still against local diff config and the abbreviation length', () => {
    const { repo } = based()
    const one = snapshotFiles(repo.root, [{ name: 'p.md', content: 'a\n\nb\n' }])!
    const two = snapshotFiles(repo.root, [{ name: 'p.md', content: 'a\n\nc\n' }])!
    const plain = treeDiff(repo.root, one, two)
    expect(plain).toMatch(/^index [0-9a-f]{40}\.\.[0-9a-f]{40} 100644$/m)
    for (const [k, val] of [['core.abbrev', '12'], ['diff.noprefix', 'true'], ['diff.suppressBlankEmpty', 'true'], ['diff.context', '1']]) {
      repo.git('config', k!, val!)
    }
    expect(treeDiff(repo.root, one, two)).toBe(plain)
  })

  it('a tree survives a default gc and is gone after gc --prune=now', () => {
    const { repo } = based()
    const tree = snapshotFiles(repo.root, [{ name: 'p.md', content: 'x\n' }])!
    repo.git('gc', '-q')
    expect(treeReadable(repo.root, tree)).toBe(true)
    repo.git('gc', '-q', '--prune=now')
    expect(treeReadable(repo.root, tree)).toBe(false)
  })
})
