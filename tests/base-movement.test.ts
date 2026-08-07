import { describe, expect, it } from 'vitest'
import { stateOnlyAdvance } from '../src/gitio.js'
import { rebaseIfMoved } from '../src/ship.js'
import { addOrigin, seededRepo, writeSpec } from './helpers.js'
import type { TestRepo } from './helpers.js'

// A commit shaped exactly like the ones `stateCommit` writes: state paths only, trailered.
function stateCommit(repo: TestRepo, rel: string, line: string, subject: string): void {
  repo.write(rel, line)
  repo.git('add', rel)
  repo.git('commit', '-m', subject, '-m', 'Witness-State: 1')
}

describe('stateOnlyAdvance', () => {
  it('is true for an advance made only of trailered state-path commits', async () => {
    const repo = await seededRepo()
    const from = repo.git('rev-parse', 'HEAD')
    stateCommit(repo, '.witness/journal/auth-hardening.jsonl', '{"v":1,"t":"gate-run"}\n',
      'gate(implement): auth-refresh-plan-1 round 1 stopped')
    expect(stateOnlyAdvance(repo.root, repo.root, from, 'HEAD')).toBe(true)
  })

  it('is false when any commit in the range touches source', async () => {
    const repo = await seededRepo()
    const from = repo.git('rev-parse', 'HEAD')
    stateCommit(repo, '.witness/journal/auth-hardening.jsonl', '{"v":1}\n', 'state')
    repo.write('src/token.ts', 'export const ttl = 1\n')
    repo.git('add', 'src/token.ts')
    repo.git('commit', '-m', 'real work')
    expect(stateOnlyAdvance(repo.root, repo.root, from, 'HEAD')).toBe(false)
  })

  // The trailer buys nothing on its own: paths decide, so a forged trailer on a source
  // commit is still real movement.
  it('is false for a forged trailer on a source commit', async () => {
    const repo = await seededRepo()
    const from = repo.git('rev-parse', 'HEAD')
    repo.write('src/token.ts', 'export const ttl = 1\n')
    repo.git('add', 'src/token.ts')
    repo.git('commit', '-m', 'looks official', '-m', 'Witness-State: 1')
    expect(stateOnlyAdvance(repo.root, repo.root, from, 'HEAD')).toBe(false)
  })

  // And a missing trailer keeps a hand-made state edit on the conservative side.
  it('is false for an untrailered commit even on state paths only', async () => {
    const repo = await seededRepo()
    const from = repo.git('rev-parse', 'HEAD')
    repo.write('.witness/journal/auth-hardening.jsonl', '{"v":1,"t":"hand-made"}\n')
    repo.git('add', '.witness/journal/auth-hardening.jsonl')
    repo.git('commit', '-m', 'hand-made state edit')
    expect(stateOnlyAdvance(repo.root, repo.root, from, 'HEAD')).toBe(false)
  })

  it('is false when nothing is ahead at all — an empty range is not an advance', async () => {
    const repo = await seededRepo()
    expect(stateOnlyAdvance(repo.root, repo.root, 'HEAD', 'HEAD')).toBe(false)
  })

  // witness.config.yaml is NOT a state path, so a config change stays real movement and
  // still triggers the rebase the worktree's lanes depend on.
  it('is false for a witness.config.yaml change', async () => {
    const repo = await seededRepo()
    const from = repo.git('rev-parse', 'HEAD')
    repo.write('witness.config.yaml', 'schema: 1\n')
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'retune', '-m', 'Witness-State: 1')
    expect(stateOnlyAdvance(repo.root, repo.root, from, 'HEAD')).toBe(false)
  })
})

describe('rebaseIfMoved', () => {
  it('reports clean when the remote advanced only by witness state commits', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    addOrigin(repo)
    stateCommit(repo, '.witness/journal/auth-hardening.jsonl', '{"v":1,"t":"write"}\n', 'write(auth-refresh)')
    repo.git('push', 'origin', 'main')
    repo.git('reset', '--hard', 'HEAD~1')      // now behind origin/main by one state commit
    expect(rebaseIfMoved(repo.root, repo.root, 'main')).toMatchObject({ ok: true, value: 'clean' })
  })
})
