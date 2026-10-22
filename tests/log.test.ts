import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
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

// D189. `log --all` orders every journal line by the commit that appended it, read by the same
// blame abandon reads (`journalActs`): a dotfile's blame config or a blank line must not reorder it.
describe('log --all reads each line\'s commit (D189)', () => {
  it('a blame config the repo cannot satisfy does not reorder the journal', async () => {
    const repo = await seededRepo({ slug: 'zeta' })                       // the effort's stream sorts last
    await writeSpec(repo, 'auth-tokens', { criteria: [{ id: 'ac-tokens', test: '@spec:auth-tokens' }] })
    await writeSpec(repo, 'token-rotation', { supersedes: 'auth-tokens', criteria: [{ id: 'ac-rotation', test: '@spec:token-rotation' }] })
    repo.git('config', 'blame.ignoreRevsFile', '.git-blame-ignore-revs')   // absent here
    const all = await repo.cli(['log', '--all'])
    expect(all.code).toBe(0)
    expect(all.stdout.indexOf('superseded')).toBeGreaterThanOrEqual(0)
    expect(all.stdout.indexOf('recap')).toBeLessThan(all.stdout.indexOf('superseded'))   // commit order, not stream name
  })

  it('a blank journal line does not shift the lines after it onto the wrong commit', async () => {
    const { journalActs } = await import('../src/journal.js')
    const repo = await seededRepo()
    appendFileSync(join(repo.root, '.witness/journal/auth-hardening.jsonl'), '\n')
    repo.git('add', '.witness/journal/auth-hardening.jsonl')
    repo.git('commit', '-q', '-m', 'a blank line', '-m', 'Witness-State: 1')
    await writeSpec(repo, 'auth-refresh')
    const write = journalActs(repo.root, 'auth-hardening').find(({ entry }) => entry.t === 'write')!
    expect(write.commit).toBe(repo.git('rev-parse', 'HEAD'))               // the write's own commit
  })
})
