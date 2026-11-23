import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { SCRATCH_LOCK } from '../src/scratch-lock.js'
import { fixtureEnv, patchConfig, seededRepo } from './helpers.js'

const REPO = resolve(import.meta.dirname, '..')
const TSX_LOADER = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href
function jobChild(cwd: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, join(REPO, 'src', 'bin.ts'), 'job', ...args],
      { cwd, env: fixtureEnv(env) as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout!.on('data', (d) => { stdout += String(d) })
    child.stderr!.on('data', (d) => { stderr += String(d) })
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}
const fixture = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ key: 'k1', shards: 2, turn: true, gated: true, boxMs: 30_000, cmd: 'true', ...o })
const lines = (s: string) => s.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

describe('witness job (row 257)', () => {
  it('runs one shard: says it began, then prints its result — and journals nothing', async () => {
    const repo = await seededRepo()
    const r = await jobChild(repo.root, ['fixture', 'k1', '2/2'], { WITNESS_JOB: '1', WITNESS_FIXTURE_JOB: fixture({ cmd: 'test {shard} = 2 && test {of} = 2' }) })
    expect(r.code).toBe(0)
    expect(lines(r.stdout)).toEqual([{ job: 'running' }, { job: 'result', outcome: 'done', result: { exit: 0 } }])
    expect(readStream(repo.root, 'jobs')).toEqual([])
  }, 60_000)

  it('holds the turn under its kind while it runs; a kind that takes no turn holds none (Review Focus 4)', async () => {
    const repo = await seededRepo()
    const turned = await jobChild(repo.root, ['fixture', 'k1', '1/2'], { WITNESS_JOB: '1', WITNESS_FIXTURE_JOB: fixture({ cmd: `grep -q '"job":"fixture"' .witness/runner.lock` }) })
    expect(lines(turned.stdout).at(-1)).toEqual({ job: 'result', outcome: 'done', result: { exit: 0 } })
    const free = await jobChild(repo.root, ['fixture', 'k1', '1/2'], { WITNESS_JOB: '1', WITNESS_FIXTURE_JOB: fixture({ turn: false, cmd: 'test ! -e .witness/runner.lock' }) })
    expect(lines(free.stdout)).toEqual([{ job: 'running' }, { job: 'result', outcome: 'done', result: { exit: 0 } }])
    patchConfig(repo, { drive: { parallelSuites: true } })   // a turn kind takes none, and still says it began
    const overlap = await jobChild(repo.root, ['fixture', 'k1', '1/2'], { WITNESS_JOB: '1', WITNESS_FIXTURE_JOB: fixture({ cmd: 'test ! -e .witness/runner.lock' }) })
    expect(lines(overlap.stdout)).toEqual([{ job: 'running' }, { job: 'result', outcome: 'done', result: { exit: 0 } }])
  }, 90_000)

  it('a kind that cannot produce a result says failed, with its reason', async () => {
    const repo = await seededRepo()
    const r = await jobChild(repo.root, ['fixture', 'k1', '1/2'], { WITNESS_JOB: '1', WITNESS_FIXTURE_JOB: fixture({ fail: 'no scratch' }) })
    expect(lines(r.stdout).at(-1)).toEqual({ job: 'result', outcome: 'failed', why: 'no scratch' })
  }, 60_000)

  it('refuses inside a session, outside drive, and on a bad kind, key or shard — printing nothing to stdout', async () => {
    const repo = await seededRepo()
    const env = { WITNESS_JOB: '1', WITNESS_FIXTURE_JOB: fixture() }
    const cases: Array<[string[], Record<string, string>, RegExp]> = [
      [['fixture', 'k1', '1/2'], { ...env, WITNESS_DRIVE: 'p1' }, /job-in-session/],
      [['fixture', 'k1', '1/2'], { WITNESS_FIXTURE_JOB: fixture() }, /job-outside-drive/],
      [['nope', 'k1', '1/2'], env, /unknown-job/],
      [['fixture', 'K!', '1/2'], env, /bad-key/],
      [['fixture', 'k1', '3/2'], env, /bad-shard/],
      [['fixture', 'k1', '0/2'], env, /bad-shard/],
      [['fixture', 'k1', 'x'], env, /bad-shard/],
    ]
    for (const [args, e, rule] of cases) {
      const r = await jobChild(repo.root, args, e)
      expect([r.code, r.stdout]).toEqual([2, ''])
      expect(r.stderr).toMatch(rule)
    }
  }, 120_000)
})

describe('witness job — the scratch (row 258)', () => {
  it('a scratch job runs its command in the scratch at HEAD and names every sha (row 258)', async () => {
    const repo = await seededRepo()
    const r = await jobChild(repo.root, ['fixture', 'k1', '1/1'], {
      WITNESS_JOB: '1', WITNESS_FIXTURE_JOB: fixture({ shards: 1, turn: false, scratch: true, cmd: 'test -f .git' }),
    })
    expect(lines(r.stdout)).toEqual([
      { job: 'running' },
      { job: 'result', outcome: 'done', result: { exit: 0, tree: repo.git('rev-parse', 'HEAD^{tree}'), commit: repo.git('rev-parse', 'HEAD') } },
    ])
    expect(existsSync(join(repo.root, SCRATCH_LOCK))).toBe(false)
  }, 60_000)
})
