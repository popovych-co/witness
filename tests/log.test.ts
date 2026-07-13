import { describe, expect, it } from 'vitest'
import { SPEC_META, seededRepo, writeSpec } from './helpers.js'

describe('specflow log', () => {
  it('renders recap, write, and write-refused entries in order', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, summary: 'x'.repeat(121) })
    const res = await repo.cli(['log', 'auth-hardening'])
    expect(res.code).toBe(0)
    const [header, r1, r2, r3] = res.stdout.split('\n')
    expect(header).toBe('entries[3]{n,t,detail}:')
    expect(r1).toContain('recap')
    expect(r1).toContain('class=feature goals=1')
    expect(r2).toContain('write')
    expect(r2).toContain('artifact=auth-refresh')
    expect(r2).toContain('covers=g1')
    expect(r3).toContain('write-refused')
    expect(r3).toContain('summary:max-length')
  })

  it('refuses unknown streams', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['log', 'ghost'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown-stream')
  })
})
