import { describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  auditStateCommits, dirtyStatePaths, primaryRoot, stateCommit, TRAILER,
} from '../src/gitio.js'
import { tmpRepo } from './helpers.js'

describe('primaryRoot', () => {
  it('resolves the repo root and refuses outside a repo', () => {
    const repo = tmpRepo()
    const res = primaryRoot(repo.root)
    expect(res.ok && res.value).toBe(repo.root)
    const outside = primaryRoot('/')
    expect(outside.ok).toBe(false)
  })

  it('routes a linked worktree to the primary checkout', () => {
    const repo = tmpRepo()
    repo.write('seed.txt', 'x')
    repo.git('add', 'seed.txt')
    repo.git('commit', '-m', 'seed')
    const wt = join(repo.root, '..', `${repo.root.split('/').pop()}-wt`)
    repo.git('worktree', 'add', wt, '-b', 'feature')
    const res = primaryRoot(wt)
    expect(res.ok && res.value).toBe(repo.root)
  })
})

describe('stateCommit', () => {
  it('commits exactly the given state paths with the trailer', () => {
    const repo = tmpRepo()
    repo.write('specs/a.md', 'content')
    const res = stateCommit(repo.root, ['specs/a.md'], 'write(a): create spec')
    expect(res.ok).toBe(true)
    expect(TRAILER).toBe('Specflow-State: 1')
    expect(repo.git('log', '-1', '--format=%(trailers:key=Specflow-State,valueonly=true)')).toBe('1')
    expect(repo.git('log', '-1', '--format=%s')).toBe('write(a): create spec')
  })

  it('refuses paths outside specs/, plans/, .specflow/', () => {
    const repo = tmpRepo()
    repo.write('src/x.ts', 'x')
    const res = stateCommit(repo.root, ['src/x.ts'], 'nope')
    expect(!res.ok && res.violations[0]?.rule).toBe('out-of-scope')
  })

  it('refuses when state paths carry unrelated dirt', () => {
    const repo = tmpRepo()
    repo.write('specs/a.md', 'a')
    repo.write('specs/b.md', 'unrelated hand edit')
    const res = stateCommit(repo.root, ['specs/a.md'], 'write(a)')
    expect(!res.ok && res.violations[0]?.rule).toBe('unrelated-dirty')
  })

  it('ignores specflow local files when checking dirt', () => {
    const repo = tmpRepo()
    mkdirSync(join(repo.root, '.specflow'), { recursive: true })
    repo.write('.specflow/lock', '{"pid":1}')
    repo.write('specs/a.md', 'a')
    expect(dirtyStatePaths(repo.root)).toEqual(['specs/a.md'])
  })
})

describe('auditStateCommits', () => {
  it('flags commits touching state paths without the trailer', () => {
    const repo = tmpRepo()
    repo.write('specs/a.md', 'a')
    stateCommit(repo.root, ['specs/a.md'], 'good')
    repo.write('specs/a.md', 'hand edit')
    repo.git('add', 'specs/a.md')
    repo.git('commit', '-m', 'sneaky hand edit')
    const audit = auditStateCommits(repo.root)
    expect(audit.find((c) => c.subject === 'sneaky hand edit')?.trailered).toBe(false)
    expect(audit.find((c) => c.subject === 'good')?.trailered).toBe(true)
  })
})
