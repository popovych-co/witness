import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
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

  // D159 (#23). The listing is paths, not files: `--others` includes a symlink to a
  // directory (how `skills add` wires .pi/skills → .agents/skills), and `--cached`
  // includes a gitlink (submodule, mode 160000) that exists on disk as a directory.
  // statSync follows the link, a directory's size clears the cap, and readFileSync
  // threw EISDIR — surfacing as unexpected-error and taking check and the implement
  // gate with it.
  it('skips a symlink to a directory instead of crashing', () => {
    const repo = tmpRepo()
    repo.write('.agents/skills/witness-plan/SKILL.md', 'run @spec:auth-refresh\n')
    symlinkSync('.agents/skills/witness-plan', join(repo.root, 'skills-link'))
    const out = sourceTags(repo.root, [])
    expect(out.counts.get('auth-refresh')).toBe(1)   // counted once, via the real path
    expect(out.files.get('auth-refresh')).toEqual(['.agents/skills/witness-plan/SKILL.md'])
  })

  it('skips a gitlink (submodule directory) in the cached listing', () => {
    const repo = tmpRepo()
    repo.write('seed.ts', 'it("x @spec:quota")\n')
    repo.git('add', 'seed.ts')
    repo.git('commit', '-m', 'seed')
    repo.git('update-index', '--add', '--cacheinfo', `160000,${repo.git('rev-parse', 'HEAD')},vendor`)
    mkdirSync(join(repo.root, 'vendor'))
    const out = sourceTags(repo.root, [])
    expect(out.counts.get('quota')).toBe(1)
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
