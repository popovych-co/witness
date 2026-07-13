import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceTags } from '../src/matcher.js'
import { tmpRepo } from './helpers.js'

describe('sourceTags', () => {
  it('counts canonical tags across tracked and untracked files', () => {
    const repo = tmpRepo()
    repo.write('tests/a.test.ts', 'it("x @spec:auth-refresh")\nit("y @spec:auth-refresh")\n')
    repo.git('add', 'tests/a.test.ts')
    repo.git('commit', '-m', 'seed')
    repo.write('tests/b.test.ts', 'it("z @spec:quota")\n')
    const out = sourceTags(repo.root, [])
    expect(out.counts.get('auth-refresh')).toBe(2)
    expect(out.counts.get('quota')).toBe(1)
    expect(out.files.get('quota')).toEqual(['tests/b.test.ts'])
  })

  it('honors .gitignore', () => {
    const repo = tmpRepo()
    repo.write('.gitignore', 'dist/\n')
    repo.write('dist/gen.test.ts', 'it("x @spec:auth-refresh")\n')
    expect(sourceTags(repo.root, []).counts.get('auth-refresh')).toBeUndefined()
  })

  it('honors exclude globs — state dirs above all (a spec must not self-verify)', () => {
    const repo = tmpRepo()
    repo.write('specs/auth-refresh.md', 'criteria:\n  - test: "@spec:auth-refresh"\n')
    repo.write('fixtures/deep/x.test.ts', 'it("x @spec:auth-refresh")\n')
    const out = sourceTags(repo.root, ['specs/**', 'fixtures/**'])
    expect(out.counts.get('auth-refresh')).toBeUndefined()
  })

  it('skips binary files and files deleted from disk but still tracked', () => {
    const repo = tmpRepo()
    repo.write('bin.dat', 'x\0y @spec:auth-refresh')
    repo.write('gone.ts', 'it("x @spec:quota")\n')
    repo.git('add', 'bin.dat', 'gone.ts')
    repo.git('commit', '-m', 'seed')
    rmSync(join(repo.root, 'gone.ts'))
    const out = sourceTags(repo.root, [])
    expect(out.counts.get('auth-refresh')).toBeUndefined()
    expect(out.counts.get('quota')).toBeUndefined()
  })
})
