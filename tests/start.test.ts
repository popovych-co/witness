import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addOrigin, approve, seededRepo, writePlan, writeSpec } from './helpers.js'
import { worktreePath } from '../src/worktree.js'

// Every D137 case needs the same approved plan; the difference is what remote exists.
async function planReady(): Promise<Awaited<ReturnType<typeof seededRepo>>> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  approve(repo, 'auth-refresh-plan-1')
  return repo
}

// D148. Re-attach re-runs createWorktree, which re-applies the canon exclusion and
// checks the tree back out — files move under a session that already read them, and
// witness caused it. The 8× "modified since read" cluster is half this arm.
describe('witness start re-attach (D148)', () => {
  it('says the re-attach refreshed the tree, and says it only on re-attach', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    approve(repo, 'auth-refresh-plan-1')

    const first = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(first.code).toBe(0)
    expect(first.stdout).not.toContain('re-read files you read before this run')

    const again = await repo.cli(['start', 'auth-refresh-plan-1'])

    expect(again.code).toBe(0)
    expect(again.stdout).toContain('worktree present')
    expect(again.stdout).toContain('re-read files you read before this run')

    await repo.cli(['clean'])
  })
})

// D137. The create path cuts from the FETCHED remote tip, so a plan branch can never
// inherit unpushed state commits — the shape that made squash-merge unrecoverable.
describe('start cuts from the fetched remote tip (D137)', () => {
  it('bases a new plan branch on origin/<branch>, not stale local main', async () => {
    const repo = await planReady()
    addOrigin(repo)
    // origin advances beyond local main
    const clone = mkdtempSync(join(tmpdir(), 'd137-'))
    execFileSync('git', ['clone', `${repo.root}-origin.git`, clone], { stdio: 'ignore' })
    for (const [k, v] of [['user.name', 'test'], ['user.email', 't@e.c'], ['commit.gpgsign', 'false']]) {
      execFileSync('git', ['-C', clone, 'config', k!, v!])
    }
    execFileSync('git', ['-C', clone, 'commit', '--allow-empty', '-m', 'remote-ahead'], { stdio: 'ignore' })
    execFileSync('git', ['-C', clone, 'push', 'origin', 'main'], { stdio: 'ignore' })

    const res = await repo.cli(['start', 'auth-refresh-plan-1'])

    expect(res.code).toBe(0)
    const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
    const tip = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(tip).toBe(repo.git('rev-parse', 'origin/main'))     // the REMOTE tip
    expect(tip).not.toBe(repo.git('rev-parse', 'main'))
    await repo.cli(['clean'])
  })

  it('refuses when a remote exists and the fetch fails — never a silent local fallback', async () => {
    const repo = await planReady()
    repo.git('remote', 'add', 'origin', '/nonexistent/origin.git')

    const res = await repo.cli(['start', 'auth-refresh-plan-1'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('fetch-failed')
    // An unreachable host has no runnable remedy — promising `git push` would fix nothing,
    // which is the D129 violation D147's placeholder test exists to prevent.
    expect(res.stderr).not.toMatch(/^run: /m)
  })

  it('names the push remedy only when the remote simply lacks the branch', async () => {
    const repo = await planReady()
    const bare = `${repo.root}-empty.git`
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })   // never pushed to
    repo.git('remote', 'add', 'origin', bare)

    const res = await repo.cli(['start', 'auth-refresh-plan-1'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('fetch-failed')
    expect(res.stderr).toContain('run: git push -u origin main')
  })

  it('keeps the local cut when no remote is configured — divergence needs a remote to exist', async () => {
    const repo = await planReady()
    // Read the tip BEFORE start: start's own status flip is a state commit, so local main
    // is one ahead of the cut point by the time the verb returns.
    const cutPoint = repo.git('rev-parse', 'main')

    const res = await repo.cli(['start', 'auth-refresh-plan-1'])

    expect(res.code).toBe(0)
    const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
    expect(execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(cutPoint)
    await repo.cli(['clean'])
  })
})
