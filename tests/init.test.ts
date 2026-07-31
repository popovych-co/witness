import { describe, expect, it } from 'vitest'
import { tmpRepo } from './helpers.js'

describe('witness init', () => {
  it('scaffolds config, principles, journal dir, gitignore in one trailer commit', async () => {
    const repo = tmpRepo()
    const res = await repo.cli(['init'])
    expect(res.code).toBe(0)
    expect(repo.read('witness.config.yaml')).toContain('schema: 1')
    expect(repo.read('witness.config.yaml')).toContain('gates:')
    expect(repo.read('specs/principles.md')).toContain('type: principles')
    expect(repo.read('specs/principles.md')).toContain('status: draft')
    expect(repo.read('.gitignore')).toContain('.witness/lock')
    expect(repo.read('.gitignore')).toContain('.witness/txn.json')
    expect(repo.git('log', '-1', '--format=%(trailers:key=Witness-State,valueonly=true)')).toBe('1')
    expect(repo.git('status', '--porcelain')).toBe('')
    expect(res.stdout).toContain('next: witness recap')
  })

  it('appends to an existing .gitignore without clobbering it', async () => {
    const repo = tmpRepo()
    repo.write('.gitignore', 'node_modules\n')
    await repo.cli(['init'])
    expect(repo.read('.gitignore')).toContain('node_modules')
    expect(repo.read('.gitignore')).toContain('.witness/allow.json')
  })

  it('refuses a second init', async () => {
    const repo = tmpRepo()
    await repo.cli(['init'])
    const again = await repo.cli(['init'])
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('already-initialized')
  })
})
