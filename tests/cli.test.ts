import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpRepo } from './helpers.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('cli entry', () => {
  it('prints the package version', async () => {
    const repo = tmpRepo()
    const res = await repo.cli(['--version'])
    expect(res.code).toBe(0)
    expect(res.stdout).toBe(pkg.version)
  })

  it('refuses unknown verbs with exit 2', async () => {
    const repo = tmpRepo()
    const res = await repo.cli(['frobnicate'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown verb: frobnicate')
  })

  it('prints usage when called with no verb outside an initialized repo', async () => {
    const repo = tmpRepo()
    const res = await repo.cli([])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('usage: witness')
  })

  it('every verb answers --help with a usage line instead of crashing', async () => {
    const repo = tmpRepo()
    for (const verb of ['recover', 'init', 'recap', 'write', 'diff', 'check', 'index', 'satisfy', 'log',
      'test-evidence', 'verify-red', 'adopt', 'gate', 'decide', 'start', 'clean', 'ship', 'next',
      'abandon', 'rename', 'sync', 'calibrate']) {
      const r = await repo.cli([verb, '--help'])
      expect(r.code, `${verb} --help`).toBe(0)
      expect(r.stdout, `${verb} --help`).toContain('usage: witness')
    }
  })
})
