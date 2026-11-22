import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { standingHeld } from '../src/held.js'
import { readStream } from '../src/journal.js'
import type { TestRepo } from './helpers.js'
import { escapeRe, fixtureEnv, heldWorktree, replantHeld, worktreeState } from './helpers.js'

describe('the held-work guard (row 247, #92)', () => {
  it('test-evidence puts the held work back before its run, so no red is recorded against the base', async () => {
    const { repo, wt, planId, ref, before } = await heldWorktree('stepped')
    const res = await repo.cli(['test-evidence', planId, '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(res.stdout).toMatch(new RegExp(`^held-work: ${escapeRe(ref)} — .*src/token\\.ts`, 'm'))
    expect(worktreeState(repo, wt, ['src/token.ts', 'src/extra.ts'])).toEqual(before)
    expect(standingHeld(repo.root, planId)).toBeUndefined()
    const reds = readStream(repo.root, planId).filter((e) => e.t === 'test-evidence')
    expect(reds).toHaveLength(1)
    expect(reds[0]!.vacuous).toBe(true)          // the fix was back: the run saw it pass, never the base's red
    expect(res.code).toBe(1)
  })

  it('test-evidence refuses verify-red-pending when a held file changed since, and journals nothing', async () => {
    const { repo, wt, planId, ref } = await heldWorktree('stepped')
    writeFileSync(join(wt, 'src/token.ts'), 'a session edit after the crash\n')
    const res = await repo.cli(['test-evidence', planId, '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('verify-red-pending')
    expect(res.stderr).toContain(ref)
    expect(res.stderr).toMatch(/Then witness next/)
    expect(standingHeld(repo.root, planId)?.sha).toBeDefined()
    expect(readStream(repo.root, planId).filter((e) => e.t === 'test-evidence')).toEqual([])
  })

  const SEE = ['turn', '--', process.execPath, '-e', "require('fs').writeFileSync('seen.txt', require('fs').readFileSync('src/token.ts'))"]

  it('witness turn puts the held work back before the command runs', async () => {
    const { repo, wt, before } = await heldWorktree('stepped')
    const res = await repo.cli(SEE, { cwd: wt, env: fixtureEnv() })
    expect(res.code).toBe(0)
    expect(res.stdout).toMatch(/^held-work: /m)
    expect(readFileSync(join(wt, 'seen.txt'), 'utf8')).toBe(before['src/token.ts'])
  })

  it.each([
    ['a held file edited since', (_repo: TestRepo, wt: string, _planId: string) => writeFileSync(join(wt, 'src/token.ts'), 'a session edit\n'), 'neither put back nor overwritten'],
    ['a holder still running', (repo: TestRepo, _wt: string, planId: string) => replantHeld(repo, planId, (m) => m.replace(/^pid: \d+$/m, `pid: ${process.ppid}`)), `pid ${process.ppid}`],
  ])('witness turn refuses, and never runs the command, with %s', async (_what, arrange, says) => {
    const { repo, wt, planId } = await heldWorktree('stepped')
    arrange(repo, wt, planId)
    const res = await repo.cli(SEE, { cwd: wt, env: fixtureEnv() })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('verify-red-pending')
    expect(res.stderr).toContain(says)
    expect(existsSync(join(wt, 'seen.txt'))).toBe(false)
  })
})
