import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { dropCfRefs, foldOverlay, objectType, pinTree } from '../src/cf-tree.js'
import type { Result } from '../src/refusal.js'
import { tmpRepo, type TestRepo } from './helpers.js'

const value = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.violations)); return r.value }
const rule = (r: Result<unknown>): string => (r.ok ? 'ok' : r.violations[0]!.rule)
const commitAll = (repo: TestRepo, m: string) => { repo.git('add', '-A'); repo.git('commit', '-q', '-m', m) }
const gitIn = (repo: TestRepo, args: string[], input: string) => execFileSync('git', args, { cwd: repo.root, input, encoding: 'utf8' }).trim()
const holds = (repo: TestRepo, sha: string) => { try { repo.git('cat-file', '-e', sha); return true } catch { return false } }
// A tree no commit or ref reaches.
const looseTree = (repo: TestRepo) => gitIn(repo, ['mktree'], `100644 blob ${gitIn(repo, ['hash-object', '-w', '--stdin'], 'only here\n')}\tonly.txt\n`)

describe('trees for scratch runs (row 258)', () => {
  it('folds an overlay: each listed path as the overlay holds it, one it lacks removed, the rest as the base holds it', () => {
    const repo = tmpRepo()
    repo.write('src/a.ts', 'a\n'); repo.write('src/b.ts', 'b\n'); repo.write('README.md', 'r\n')
    commitAll(repo, 'base')
    const base = repo.git('rev-parse', 'HEAD^{tree}')
    repo.write('src/a.ts', 'a2\n'); repo.git('rm', '-q', 'src/b.ts'); repo.write('src/c.ts', 'c\n'); repo.write('README.md', 'r2\n')
    commitAll(repo, 'next')
    const tree = value(foldOverlay(repo.root, base, { from: repo.git('rev-parse', 'HEAD'), paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }))
    expect(repo.git('ls-tree', '-r', '--name-only', tree).split('\n')).toEqual(['README.md', 'src/a.ts', 'src/c.ts'])
    expect(repo.git('show', `${tree}:src/a.ts`)).toBe('a2')
    expect(repo.git('show', `${tree}:README.md`)).toBe('r')
  })

  it('folds explicit blobs after the overlay paths, in their mode; a bad blob refuses (row 277)', () => {
    const repo = tmpRepo()
    repo.write('a.json', 'a\n'); repo.write('b.txt', 'b\n')
    commitAll(repo, 'base')
    const tree = repo.git('rev-parse', 'HEAD^{tree}')
    const sha = gitIn(repo, ['hash-object', '-w', '--stdin'], 'spliced\n')
    const folded = value(foldOverlay(repo.root, tree, { from: tree, paths: ['b.txt'], blobs: [{ path: 'a.json', mode: '100755', sha }] }))
    expect(repo.git('ls-tree', folded, '--', 'a.json')).toBe(`100755 blob ${sha}\ta.json`)
    expect(repo.git('show', `${folded}:b.txt`)).toBe('b')
    expect(rule(foldOverlay(repo.root, tree, { from: tree, paths: [], blobs: [{ path: '../x', mode: '100644', sha }] }))).toBe('invalid')
    expect(rule(foldOverlay(repo.root, tree, { from: tree, paths: [], blobs: [{ path: 'a.json', mode: '120000', sha }] }))).toBe('invalid')
    expect(rule(foldOverlay(repo.root, tree, { from: tree, paths: [], blobs: [{ path: 'a.json', mode: '100644', sha: 'abc' }] }))).toBe('invalid')
  })

  it('refuses a directory, an absolute path or a climb, and reads a glob character literally', () => {
    const repo = tmpRepo()
    repo.write('src/[ab].ts', 'odd\n'); repo.write('src/a.ts', 'a\n')
    commitAll(repo, 'one')
    const tree = repo.git('rev-parse', 'HEAD^{tree}')
    const fold = (paths: string[]) => foldOverlay(repo.root, tree, { from: tree, paths })
    expect(rule(fold(['src']))).toBe('overlay-not-a-file')
    expect(rule(fold(['/etc/passwd']))).toBe('invalid')
    expect(rule(fold(['src/../x']))).toBe('invalid')
    expect(value(fold(['src/[ab].ts']))).toBe(tree)
    expect(rule(foldOverlay(repo.root, tree, { from: 'f'.repeat(40), paths: ['src/a.ts'] }))).toBe('tree-unknown')
  })

  it('an overlay path a:b.txt folds; a drive-letter path refuses (T2b M3, row 279)', () => {
    const repo = tmpRepo()
    repo.write('a.txt', 'a\n')
    commitAll(repo, 'base')
    const base = repo.git('rev-parse', 'HEAD^{tree}')
    repo.write('a:b.txt', 'colon\n')
    commitAll(repo, 'next')
    const from = repo.git('rev-parse', 'HEAD')
    const folded = value(foldOverlay(repo.root, base, { from, paths: ['a:b.txt'] }))
    expect(repo.git('show', `${folded}:a:b.txt`)).toBe('colon')
    for (const p of ['C:/x', 'c:\\x']) expect(rule(foldOverlay(repo.root, base, { from, paths: [p] }))).toBe('invalid')
  })

  it('a folder the overlay turns into a file folds, its base entries gone (T2b M4, row 279)', () => {
    const repo = tmpRepo()
    repo.write('lib/x.ts', 'x\n'); repo.write('lib/deep/y.ts', 'y\n'); repo.write('keep.ts', 'k\n')
    commitAll(repo, 'base')
    const base = repo.git('rev-parse', 'HEAD^{tree}')
    repo.git('rm', '-rq', 'lib'); repo.write('lib', 'now a file\n')
    commitAll(repo, 'next')
    const folded = value(foldOverlay(repo.root, base, { from: repo.git('rev-parse', 'HEAD'), paths: ['lib'] }))
    expect(repo.git('ls-tree', '-r', '--name-only', folded).split('\n')).toEqual(['keep.ts', 'lib'])
    expect(repo.git('show', `${folded}:lib`)).toBe('now a file')
    // the overlay's own entry a folder still refuses
    expect(rule(foldOverlay(repo.root, repo.git('rev-parse', 'HEAD^{tree}'), { from: base, paths: ['lib'] }))).toBe('overlay-not-a-file')
  })

  it('wraps a tree in the same unsigned commit every time and pins it under its plan (Review Focus 5)', () => {
    const repo = tmpRepo()
    repo.git('config', 'commit.gpgsign', 'true')
    repo.write('a.txt', 'a\n'); repo.git('add', '-A'); repo.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one')
    const tree = looseTree(repo)
    const sha = value(pinTree(repo.root, 'p1', tree))
    expect(value(pinTree(repo.root, 'p1', tree))).toBe(sha)
    expect(repo.git('rev-parse', `refs/witness/cf/p1/${tree}`)).toBe(sha)
    expect(repo.git('rev-parse', `${sha}^{tree}`)).toBe(tree)
    const raw = repo.git('cat-file', 'commit', sha)
    expect(raw).toMatch(/^author witness <witness@local> 0 \+0000$/m)
    expect(raw).not.toMatch(/gpgsig/)
    expect(rule(pinTree(repo.root, 'Not An Id', tree))).not.toBe('ok')
    expect(rule(pinTree(repo.root, 'p1', repo.git('rev-parse', 'HEAD')))).toBe('tree-unknown')
  })

  it('a pinned tree outlives gc --prune=now, and goes once its plan\'s refs are dropped', () => {
    const repo = tmpRepo()
    repo.write('a.txt', 'a\n'); commitAll(repo, 'one')
    const tree = looseTree(repo)
    value(pinTree(repo.root, 'p1', tree))
    const gc = () => repo.git('-c', 'gc.reflogExpire=now', '-c', 'gc.reflogExpireUnreachable=now', 'gc', '-q', '--prune=now')
    gc()
    expect(holds(repo, tree)).toBe(true)
    dropCfRefs(repo.root, 'p1')
    expect(repo.git('for-each-ref', 'refs/witness/cf/')).toBe('')
    gc()
    expect(holds(repo, tree)).toBe(false)
  })

  it('objectType tells a commit from a tree and anything else from both', () => {
    const repo = tmpRepo()
    repo.write('a.txt', 'a\n'); commitAll(repo, 'one')
    expect(objectType(repo.root, repo.git('rev-parse', 'HEAD'))).toBe('commit')
    expect(objectType(repo.root, repo.git('rev-parse', 'HEAD^{tree}'))).toBe('tree')
    expect(objectType(repo.root, repo.git('rev-parse', 'HEAD:a.txt'))).toBeUndefined()
    expect(objectType(repo.root, 'HEAD')).toBeUndefined()
  })
})
