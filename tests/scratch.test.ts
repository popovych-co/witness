import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ok, type Result } from '../src/refusal.js'
import { withRunnerTurn } from '../src/runner-lock.js'
import { openScratch, resetScratch, scratchPath } from '../src/scratch.js'
import { SCRATCH_LOCK, releaseDeadScratch, withScratch } from '../src/scratch-lock.js'
import { fakeCtx, seededRepo, tmpRepo } from './helpers.js'

const value = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.violations)); return r.value }
const rule = (r: Result<unknown>): string => (r.ok ? 'ok' : r.violations[0]!.rule)
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!
// An orphan living `s` seconds: its shell exits at once, so it is never this process's zombie (row 213).
const orphan = (s: number): number => Number(spawnSync('sh', ['-c', `sleep ${s} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout.trim())
const lockAt = (root: string, l: { pid: number; since: number; until: number }) => {
  mkdirSync(join(root, '.witness', 'live', 'scratch'), { recursive: true })
  writeFileSync(join(root, SCRATCH_LOCK), JSON.stringify(l))
}
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' })

describe('the scratch (row 258)', () => {
  it('is one detached worktree at .witness/scratch: canon hidden, its reflog off, nothing shown to git status', async () => {
    const repo = await seededRepo()
    const dir = value(openScratch(repo.root))
    expect(dir).toBe(scratchPath(repo.root))
    expect(repo.git('worktree', 'list', '--porcelain')).toContain(`worktree ${dir}`)
    expect(rule(resetScratch(dir, repo.git('rev-parse', 'HEAD')))).toBe('ok')
    expect(git(dir, 'symbolic-ref', '-q', 'HEAD').status).not.toBe(0)
    expect(existsSync(join(dir, 'specs'))).toBe(false)
    expect(existsSync(join(dir, '.witness', 'journal'))).toBe(false)
    expect(git(dir, 'config', '--worktree', 'core.logAllRefUpdates').stdout.trim()).toBe('false')
    expect(repo.git('status', '--porcelain', '--', '.witness')).toBe('')
    expect(value(openScratch(repo.root))).toBe(dir)
  })

  it('a reset checks out the commit and cleans everything but node_modules and target, at any depth', async () => {
    const repo = await seededRepo()
    const dir = value(openScratch(repo.root))
    const head = repo.git('rev-parse', 'HEAD')
    value(resetScratch(dir, head))
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(dir, 'node_modules', 'x', 'i'), 'keep')
    mkdirSync(join(dir, 'apps', 't', 'target'), { recursive: true }); writeFileSync(join(dir, 'apps', 't', 'target', 'o'), 'keep')
    writeFileSync(join(dir, 'junk.tmp'), 'junk')
    writeFileSync(join(dir, 'witness.config.yaml'), 'edited')
    value(resetScratch(dir, head))
    expect(existsSync(join(dir, 'node_modules', 'x', 'i'))).toBe(true)
    expect(existsSync(join(dir, 'apps', 't', 'target', 'o'))).toBe(true)
    expect(existsSync(join(dir, 'junk.tmp'))).toBe(false)
    expect(readFileSync(join(dir, 'witness.config.yaml'), 'utf8')).toBe(repo.read('witness.config.yaml'))
  })

  it('refuses a link or a folder that is not its worktree, and makes again one removed by hand (Review Focus 1)', async () => {
    const repo = await seededRepo()
    const path = scratchPath(repo.root)
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'x'), 'not a worktree')
    expect(rule(openScratch(repo.root))).toBe('scratch-unusable')
    rmSync(path, { recursive: true })
    symlinkSync(repo.root, path)
    expect(rule(openScratch(repo.root))).toBe('scratch-unusable')
    unlinkSync(path)   // rmSync refuses a link to a folder (ERR_FS_EISDIR, node 24)
    const dir = value(openScratch(repo.root))
    rmSync(dir, { recursive: true, force: true })
    expect(value(openScratch(repo.root))).toBe(dir)
    expect(rule(resetScratch(dir, repo.git('rev-parse', 'HEAD')))).toBe('ok')
  })

  it('holds the scratch: re-entry runs at once; a dead holder or a lapsed lease is taken; a live holder is waited for', () => {
    const repo = tmpRepo()
    const ctx = fakeCtx(repo.root)
    const run = () => withScratch(repo.root, ctx, 60_000, () => ok(process.pid))
    lockAt(repo.root, { pid: deadPid(), since: Date.now(), until: Date.now() + 60_000 })
    expect(value(run())).toBe(process.pid)
    expect(existsSync(join(repo.root, SCRATCH_LOCK))).toBe(false)
    const lapsed = orphan(30)
    try {
      lockAt(repo.root, { pid: lapsed, since: Date.now() - 2_000, until: Date.now() - 1_000 })
      expect(value(run())).toBe(process.pid)
    } finally { process.kill(lapsed) }
    expect(value(withScratch(repo.root, ctx, 60_000, () => run()))).toBe(process.pid)
    lockAt(repo.root, { pid: orphan(2), since: Date.now(), until: Date.now() + 60_000 })
    const t0 = Date.now()
    expect(value(run())).toBe(process.pid)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000)
  })

  it('releaseDeadScratch drops a dead or lapsed holder\'s lock and never a live one; a turn taken inside the scratch throws (lock order)', () => {
    const repo = tmpRepo()
    const ctx = fakeCtx(repo.root)
    lockAt(repo.root, { pid: deadPid(), since: Date.now(), until: Date.now() + 60_000 })
    expect(releaseDeadScratch(repo.root)).toBe(true)
    const live = orphan(30)
    try {
      lockAt(repo.root, { pid: live, since: Date.now(), until: Date.now() + 60_000 })
      expect(releaseDeadScratch(repo.root)).toBe(false)
    } finally { process.kill(live); rmSync(join(repo.root, SCRATCH_LOCK), { force: true }) }
    expect(() => withScratch(repo.root, ctx, 60_000, () => ok(withRunnerTurn(repo.root, ctx, 'x', () => 1)))).toThrow(/lock order/)
    expect(existsSync(join(repo.root, SCRATCH_LOCK))).toBe(false)
    expect(withRunnerTurn(repo.root, ctx, 'x', () => withScratch(repo.root, ctx, 60_000, () => ok(1)))).toEqual({ ok: true, value: 1 })
  })

  it('check never takes the scratch for a stray worktree, canon residue or a hand edit (Review Focus 3)', async () => {
    const repo = await seededRepo()
    value(resetScratch(value(openScratch(repo.root)), repo.git('rev-parse', 'HEAD')))
    expect((await repo.cli(['check'])).stdout).not.toMatch(/stray-worktree|canon-in-worktree|hand-edit-in-progress/)
  })
})
