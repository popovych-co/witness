import { describe, expect, it } from 'vitest'
import { seededRepo } from './helpers.js'

describe('witness drive skeleton (D145)', () => {
  it('refuses without a TTY', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['drive'])            // repo.cli runs non-TTY
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('drive-needs-tty')
  })

  it('config accepts drive.sessionTimeoutMs and defaults it', async () => {
    const { loadConfig } = await import('../src/config.js')
    const repo = await seededRepo()
    const cfg = loadConfig(repo.root)
    expect(cfg.ok && cfg.value.drive.sessionTimeoutMs).toBe(3600000)
  })

  it('refuses a non-integer drive.sessionTimeoutMs', async () => {
    const { loadConfig } = await import('../src/config.js')
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}drive:\n  sessionTimeoutMs: 0\n`)
    const cfg = loadConfig(repo.root)
    expect(cfg.ok).toBe(false)
    expect(!cfg.ok && cfg.violations[0]?.field).toBe('drive.sessionTimeoutMs')
  })
})
