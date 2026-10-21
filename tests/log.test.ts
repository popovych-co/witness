import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import { SPEC_META, seededRepo, writeSpec } from './helpers.js'

describe('witness log', () => {
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

describe('witness log says who decided (A5)', () => {
  it('names the arbiter and its model on an autonomous decision', async () => {
    const repo = await seededRepo()
    appendEntry(repo.root, repo.effort, {
      v: 1, t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'approve',
      selected: 'arbiter', reason: 'the slice covers g1', arbiter: { model: 'test-model-1', prompts_sha: 'p' }, rule: 'reserved-stop-clean',
    })
    appendEntry(repo.root, repo.effort, { v: 1, t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'revise' })
    const out = (await repo.cli(['log', repo.effort])).stdout
    expect(out).toContain('decompose: approve · arbiter · test-model-1')
    expect(out).toMatch(/decompose: revise$/m)
  })
})
