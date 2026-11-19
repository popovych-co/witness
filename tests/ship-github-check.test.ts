import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { readStream } from '../src/journal.js'
import { takeWaiter } from '../src/live.js'
import { needsYou } from '../src/needs-you.js'
import { loadCanon } from '../src/scan.js'
import { waitLoop } from '../src/verbs/wait.js'
import { worktreePath } from '../src/worktree.js'
import {
  addOrigin, approve, autonomyOn, closedStep, commitEntry, fakeClock, fakeCtx, fakeScenario, gateEnv, hermeticEnv, noopOpener,
  seededRepo, writeLocalConfig, writePlan, writeSpec, type TestRepo,
} from './helpers.js'

// Row 242 (design §4.3.2, GitHub moves on; `wait`). While a merge record stands, `next` follows its
// PR on GitHub — the view its lazy stamp already reads gives the state and the base, and one fetch of
// ship.branch shows a base that moved — and journals the record that follows. Offline, nothing.

const PLAN = 'a-plan-1'
const cfgOf = (repo: TestRepo) => { const r = loadConfig(repo.root); if (!r.ok) throw new Error('cfg'); return r.value }
async function mergeStop(outcome: 'merge' | 'fix' = 'merge', reason = 'no CI checks reported') {
  const repo = await seededRepo()
  await writeSpec(repo, 'a', { criteria: [{ id: 'ac-a', test: '@spec:a' }] })
  approve(repo, 'a')
  await writePlan(repo, PLAN, { parent: 'a', steps: [{ id: 's1', title: 'a', criteria: ['ac-a'] }] })
  approve(repo, PLAN)
  await repo.cli(['start', PLAN])
  closedStep(repo, PLAN, 's1', 'a')
  repo.setMeta(PLAN, { pr: 7 })
  autonomyOn(repo)
  writeLocalConfig(repo.root, { notify: noopOpener() })
  addOrigin(repo)
  const wt = worktreePath(repo.root, PLAN)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim()
  commitEntry(repo, PLAN, { t: 'ship-outcome', artifact: PLAN, pr: 7, head, outcome, reason })
  const scenario = fakeScenario()
  writeFileSync(join(scenario, 'pr-7-state'), 'OPEN\n')
  return { repo, scenario, head, env: { ...gateEnv(scenario), WITNESS_TRUST_CMDS: '1' } }
}
const records = (repo: TestRepo) =>
  readStream(repo.root, PLAN).filter((e) => e.t === 'ship-outcome').map((e) => ({ outcome: e.outcome, reason: e.reason }))
const moveMain = (repo: TestRepo) => {
  const other = `${repo.root}-other`
  execFileSync('git', ['clone', '-q', `${repo.root}-origin.git`, other])
  writeFileSync(join(other, 'OTHER.md'), 'merged\n')
  execFileSync('git', ['add', 'OTHER.md'], { cwd: other })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'another flow'], { cwd: other })
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other })
}

describe('a merge stop follows its PR on GitHub (row 242)', () => {
  it('a merge stop whose PR was retargeted journals a fix record', async () => {
    const s = await mergeStop()
    writeFileSync(join(s.scenario, 'pr-7-base'), 'release\n')
    await s.repo.cli(['next'], { env: s.env })
    expect(records(s.repo).at(-1)).toEqual({ outcome: 'fix', reason: 'the PR targets release but ship.branch is main' })
  }, 120_000)

  it('a merge stop whose PR was closed journals fix: closed without merging — reopen it, or abandon the plan', async () => {
    const s = await mergeStop()
    writeFileSync(join(s.scenario, 'pr-7-state'), 'CLOSED\n')
    await s.repo.cli(['next'], { env: s.env })
    expect(records(s.repo).at(-1)).toEqual({ outcome: 'fix', reason: 'closed without merging — reopen it, or abandon the plan' })
  }, 120_000)

  it('a merge stop whose base moved beyond state commits journals re-gate', async () => {
    const s = await mergeStop()
    moveMain(s.repo)
    await s.repo.cli(['next'], { env: s.env })
    expect(records(s.repo).at(-1)).toMatchObject({ outcome: 're-gate' })
  }, 120_000)

  it('a fix record is never checked for a moved base', async () => {
    const s = await mergeStop('fix', 'the PR branch holds commits this worktree lacks — overwriting them is your call')
    moveMain(s.repo)
    await s.repo.cli(['next'], { env: s.env })
    expect(records(s.repo)).toHaveLength(1)
  }, 120_000)

  it('offline — the fetch fails — journals nothing, and the row stands (P32)', async () => {
    const s = await mergeStop()
    s.repo.git('remote', 'set-url', 'origin', join(s.repo.root, 'no-such-remote.git'))
    await s.repo.cli(['next'], { env: s.env })
    expect(records(s.repo)).toHaveLength(1)
    expect(needsYou(s.repo.root, { env: {} }, cfgOf(s.repo), loadCanon(s.repo.root), []).some((i) => i.kind === 'merge')).toBe(true)
  }, 120_000)

  // Review Focus 3
  it('a deleted PR, not-found or malformed gh JSON reads as offline: no record, no crash', async () => {
    for (const shape of ['deleted', 'notfound', 'malformed'] as const) {
      const s = await mergeStop()
      if (shape === 'deleted') writeFileSync(join(s.scenario, 'gh-fail-pr-view'), 'GraphQL: Could not resolve to a PullRequest with the number of 7.\n')
      if (shape === 'notfound') writeFileSync(join(s.scenario, 'pr-7-state'), '')
      if (shape === 'malformed') writeFileSync(join(s.scenario, 'pr-7-state'), 'OP"EN\n')
      const r = await s.repo.cli(['next'], { env: s.env })
      expect(r.code, shape).toBe(0)
      expect(records(s.repo), shape).toHaveLength(1)
    }
  }, 240_000)

  // Review Focus 4
  it('two next processes checking at once journal one record', async () => {
    const s = await mergeStop()
    writeFileSync(join(s.scenario, 'pr-7-state'), 'CLOSED\n')
    const here = resolve(import.meta.dirname, '..')
    const child = () => new Promise<number | null>((done) => {
      const c = spawn(join(here, 'node_modules', '.bin', 'tsx'), [join(here, 'src', 'bin.ts'), 'next'],
        { cwd: s.repo.root, env: hermeticEnv(s.env), stdio: 'ignore' })
      c.on('close', done)
    })
    await Promise.all([child(), child()])
    expect(records(s.repo).filter((r) => r.outcome === 'fix')).toHaveLength(1)
  }, 120_000)
})

describe('wait reads the PR against the record (row 242)', () => {
  it('wakes once when the PR state differs from the record, never again for the same state', async () => {
    const s = await mergeStop()
    writeFileSync(join(s.scenario, 'pr-7-state'), 'CLOSED\n')
    const out: string[] = []
    expect(await waitLoop(s.repo.root, fakeCtx(s.repo.root, { env: s.env, out: (l) => out.push(l) }), cfgOf(s.repo), {}, fakeClock(0))).toBe(0)
    expect(out[0]).toBe(`wait: needs you — ${PLAN} · PR #7 is closed on GitHub`)
    // the chat's `next` journals what wait saw; the record now names the closed PR
    await s.repo.cli(['next'], { env: s.env })
    expect(records(s.repo).at(-1)?.outcome).toBe('fix')
    const again: string[] = []
    const clock = fakeClock(0)
    const sleep = clock.sleep
    let n = 0
    clock.sleep = async (ms: number) => { if (++n === 5) takeWaiter(s.repo.root, 999_999); await sleep(ms) }
    await waitLoop(s.repo.root, fakeCtx(s.repo.root, { env: s.env, out: (l) => again.push(l) }), cfgOf(s.repo), {}, clock)
    expect(again.join('\n')).not.toContain('is closed on GitHub')
  }, 120_000)
})
