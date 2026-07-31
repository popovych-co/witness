import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  auditStateCommits, dirtyStatePaths, primaryRoot, stateCommit, stateDirs, TRAILER,
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
    expect(TRAILER).toBe('Witness-State: 1')
    expect(repo.git('log', '-1', '--format=%(trailers:key=Witness-State,valueonly=true)')).toBe('1')
    expect(repo.git('log', '-1', '--format=%s')).toBe('write(a): create spec')
  })

  it('refuses paths outside specs/, plans/, .witness/', () => {
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

  it('ignores witness local files when checking dirt', () => {
    const repo = tmpRepo()
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    repo.write('.witness/lock', '{"pid":1}')
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

describe('designs/ is a state directory', () => {
  it('stateDirs includes the configured designs dir', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\n')
    expect(stateDirs(repo.root)).toContain('designs')
  })

  it('stateCommit accepts a designs/ path', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\n')
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'cfg')
    repo.write('designs/auth-refresh.html', '<!doctype html><body><section id="a"></section></body>')
    const res = stateCommit(repo.root, ['designs/auth-refresh.html'], 'design(auth-refresh)')
    expect(res.ok).toBe(true)
  })
})

describe('host commit hooks', () => {
  it('state commits bypass a failing host pre-commit hook', () => {
    const repo = tmpRepo()
    repo.write('specs/a.md', 'v1')
    repo.git('add', 'specs/a.md')
    repo.git('commit', '-m', 'seed')

    // core.hooksPath is inherited from the user's global config in some setups, which
    // would make .git/hooks/ inert and the test vacuous — pin it to this repo.
    repo.git('config', 'core.hooksPath', join(repo.root, '.git', 'hooks'))
    const hook = join(repo.root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "hook refuses" >&2\nexit 1\n')
    chmodSync(hook, 0o755)

    repo.write('specs/a.md', 'v2')
    const res = stateCommit(repo.root, ['specs/a.md'], 'update a')

    expect(res.ok).toBe(true)
    expect(repo.git('log', '-1', '--format=%s')).toBe('update a')
  })
})
