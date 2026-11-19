import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import { withValues } from '../src/settings.js'
import { classifyGh, classifyGit } from '../src/ship-outcome.js'
import { runShip } from '../src/ship.js'
import { addOrigin, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, singleConfig, type TestRepo } from './helpers.js'

// Row 242 (design §4.3.1, R13). Every outcome `witness ship` ends on is classified and journaled:
// merge and fix are the human's stops, transient and pending are drive's to re-check, red is the
// session's to fix, re-gate is machine work, merged ends the plan. Git's and GitHub's words are read
// for it, git's in the C locale.

describe('the classifiers (row 242)', () => {
  it('reads a rejected push, a refused login and a network failure from git', () => {
    expect(classifyGit('To o.git\n! [rejected]        HEAD -> witness/p (non-fast-forward)\nerror: failed to push')).toBe('diverged')
    expect(classifyGit('!\trefs/heads/witness/p:refs/heads/witness/p\t[rejected] (fetch first)')).toBe('diverged')
    expect(classifyGit('!\tHEAD:refs/heads/witness/p\t[rejected] (stale info)')).toBe('lease')
    expect(classifyGit("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'")).toBe('login')
    expect(classifyGit('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.')).toBe('login')
    expect(classifyGit("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com")).toBe('network')
    expect(classifyGit('error: something else entirely')).toBe('other')
  })

  it('reads a refused login, a rate limit and a network failure from gh (P24 inverted)', () => {
    expect(classifyGh(1, 'HTTP 401: Bad credentials (https://api.github.com/graphql)')).toBe('login')
    expect(classifyGh(4, 'To get started with GitHub CLI, please run:  gh auth login')).toBe('login')
    expect(classifyGh(1, 'HTTP 403: Resource not accessible by personal access token')).toBe('login')
    expect(classifyGh(1, 'HTTP 403: API rate limit exceeded for user ID 1.')).toBe('rate')
    expect(classifyGh(1, 'HTTP 429: secondary rate limit')).toBe('rate')
    expect(classifyGh(1, 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com')).toBe('network')
    expect(classifyGh(null, '')).toBe('network')
    expect(classifyGh(1, 'HTTP 403: Must have admin rights to Repository.')).toBe('other')
  })
})

const CLEAN = {
  coverage: ['.gitignore', 'package.json', 'src/token.ts', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' })),
  findings: [],
}
const shipConfig = (autonomy: boolean, ciSettleMs = 0) => stringify(withValues(parse(singleConfig('filtered')) as Record<string, unknown>, {
  ship: { test: 'true', lint: 'true', ciSettleMs }, ...(autonomy ? { autonomy: 'on' } : {}),
}))
// An approved ship gate on a plan with an origin: the next `witness ship` opens PR #1 and watches CI.
async function readyToShip(opts: { autonomy?: boolean; ciSettleMs?: number } = {}) {
  const autonomy = opts.autonomy ?? true
  const seed = await shippableRepo()
  seed.repo.write('witness.config.yaml', shipConfig(autonomy, opts.ciSettleMs ?? 0))
  seed.repo.git('add', 'witness.config.yaml'); seed.repo.git('commit', '-m', 'config')
  addOrigin(seed.repo)
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  putVerdict(scenario, { choice: 1, reason: 'the change serves g1' }, 'arbiter')
  const outs: string[] = []
  const errs: string[] = []
  const ctx = fakeCtx(seed.repo.root, {
    env: { ...gateEnv(scenario), WITNESS_SHIP_WATCH_MS: '2000' }, out: (l) => outs.push(l), err: (l) => errs.push(l),
  })
  await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })
  if (!autonomy) {
    await runShip(ctx, seed.planId)
    await seed.repo.cli(['decide', 'ship', seed.planId, '--approve'], { env: gateEnv(scenario) })
  }
  const calls = () => (existsSync(join(scenario, 'gh-calls')) ? readFileSync(join(scenario, 'gh-calls'), 'utf8') : '')
  return { ...seed, scenario, ctx, out: () => outs.join('\n'), err: () => errs.join('\n'), calls }
}
const records = (repo: TestRepo, plan: string) =>
  readStream(repo.root, plan).filter((e) => e.t === 'ship-outcome').map((e) => ({ outcome: e.outcome, reason: e.reason, pr: e.pr }))
const gh = (scenario: string, file: string, text: string) => writeFileSync(join(scenario, file), text)

describe('every ship outcome is classified and recorded (row 242)', () => {
  it('no CI checks → a merge record, and no merge', async () => {
    const s = await readyToShip()
    gh(s.scenario, 'pr-1-checks', 'none')
    expect(await runShip(s.ctx, s.planId)).toBe(1)
    expect(records(s.repo, s.planId).at(-1)).toEqual({ outcome: 'merge', reason: 'no CI checks reported', pr: 1 })
    expect(s.calls()).not.toContain('pr merge')
  }, 180_000)

  it('autonomy off, green CI → a merge record', async () => {
    const s = await readyToShip({ autonomy: false })
    expect(await runShip(s.ctx, s.planId)).toBe(0)
    expect(records(s.repo, s.planId).at(-1)).toMatchObject({ outcome: 'merge', pr: 1 })
    expect(s.calls()).not.toContain('pr merge')
  }, 180_000)

  it('an HTTP 401 while CI is read → a fix record, never ci: red (P24 inverted)', async () => {
    const s = await readyToShip()
    gh(s.scenario, 'gh-fail-pr-checks', 'HTTP 401: Bad credentials (https://api.github.com/graphql)\n')
    expect(await runShip(s.ctx, s.planId)).toBe(1)
    expect(records(s.repo, s.planId).at(-1)).toMatchObject({ outcome: 'fix', pr: 1 })
    expect(s.out()).not.toContain('ci: red')
  }, 180_000)

  it('a rate limit while CI is read → transient', async () => {
    const s = await readyToShip()
    gh(s.scenario, 'gh-fail-pr-checks', 'HTTP 403: API rate limit exceeded for user ID 1.\n')
    expect(await runShip(s.ctx, s.planId)).toBe(1)
    expect(records(s.repo, s.planId).at(-1)).toMatchObject({ outcome: 'transient', pr: 1 })
  }, 180_000)

  it('checks still pending when the watch closes → pending, no longer ci: red', async () => {
    const s = await readyToShip()
    gh(s.scenario, 'pr-1-rollups', 'ci:pending\nci:pending\n')
    expect(await runShip(s.ctx, s.planId)).toBe(1)
    expect(records(s.repo, s.planId).at(-1)).toMatchObject({ outcome: 'pending', pr: 1 })
    expect(s.out()).not.toContain('ci: red')
  }, 180_000)

  it('a failed check read from the check set → red, its reason built from the check names', async () => {
    const s = await readyToShip()
    gh(s.scenario, 'pr-1-rollups', 'test:fail,lint:cancel,build:pass\n')
    expect(await runShip(s.ctx, s.planId)).toBe(1)
    expect(records(s.repo, s.planId).at(-1)).toEqual({ outcome: 'red', reason: 'fail: test · cancel: lint', pr: 1 })
  }, 180_000)

  // F7 kept (security review): a watch that failed or timed out says nothing about a check that has
  // yet to register, so a green read after it settles and reads the set again before any merge.
  it('a green read after a failed watch settles and reads the set again before it merges', async () => {
    const s = await readyToShip({ ciSettleMs: 300 })
    gh(s.scenario, 'gh-fail-watch', 'error: the watch timed out\n')
    expect(await runShip(s.ctx, s.planId)).toBe(0)
    expect(s.calls().match(/pr checks 1 --json name,bucket/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  }, 180_000)

  it('a merge → merged', async () => {
    const s = await readyToShip()
    expect(await runShip(s.ctx, s.planId)).toBe(0)
    expect(records(s.repo, s.planId).at(-1)).toMatchObject({ outcome: 'merged', pr: 1 })
  }, 180_000)

  it('a base that moved while CI ran → re-gate', async () => {
    const s = await readyToShip()
    const other = `${s.repo.root}-other`
    gh(s.scenario, 'gh-checks-hook', `[ -d "${other}" ] || { git clone -q "${s.repo.root}-origin.git" "${other}" && cd "${other}" && echo x > OTHER.md && git add OTHER.md && git -c user.name=t -c user.email=t@e commit -qm moved && git push -q origin main; }\n`)
    expect(await runShip(s.ctx, s.planId)).toBe(1)
    expect(records(s.repo, s.planId).at(-1)).toMatchObject({ outcome: 're-gate', pr: 1 })
  }, 180_000)

  it('a merge GitHub refuses → fix', async () => {
    const s = await readyToShip()
    gh(s.scenario, 'pr-1-merge-refuse', 'GraphQL: Pull request is not mergeable: required reviews\n')
    expect(await runShip(s.ctx, s.planId)).toBe(2)
    expect(records(s.repo, s.planId).at(-1)).toMatchObject({ outcome: 'fix', pr: 1 })
  }, 180_000)

  it('a PR whose base is not ship.branch → fix', async () => {
    const s = await readyToShip()
    gh(s.scenario, 'pr-1-base', 'release\n')
    expect(await runShip(s.ctx, s.planId)).toBe(1)
    expect(records(s.repo, s.planId).at(-1)).toMatchObject({ outcome: 'fix', pr: 1 })
    expect(String(records(s.repo, s.planId).at(-1)?.reason)).toContain('release')
  }, 180_000)

  it('a PR branch holding a commit the worktree lacks → fix (push-diverged)', async () => {
    const s = await readyToShip()
    gh(s.scenario, 'pr-1-checks', 'none')
    await runShip(s.ctx, s.planId)                                       // opens PR #1, a merge stop
    const collab = `${s.repo.root}-collab`
    execFileSync('git', ['clone', '-q', `${s.repo.root}-origin.git`, collab])
    execFileSync('git', ['checkout', '-q', `witness/${s.planId}`], { cwd: collab })
    writeFileSync(join(collab, 'COLLAB.md'), 'x\n')
    execFileSync('git', ['add', 'COLLAB.md'], { cwd: collab })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'collab'], { cwd: collab })
    execFileSync('git', ['push', '-q', 'origin', `witness/${s.planId}`], { cwd: collab })
    const code = await runShip(s.ctx, s.planId)
    expect(code).toBe(2)
    expect(records(s.repo, s.planId).at(-1)).toMatchObject({ outcome: 'fix', pr: 1 })
  }, 180_000)

  it('a localized git (LANG=de_DE) still classifies a rejected push', async () => {
    const before = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL }
    process.env.LANG = 'de_DE.UTF-8'
    delete process.env.LC_ALL
    try {
      const s = await readyToShip()
      gh(s.scenario, 'pr-1-checks', 'none')
      await runShip(s.ctx, s.planId)
      const collab = `${s.repo.root}-collab`
      execFileSync('git', ['clone', '-q', `${s.repo.root}-origin.git`, collab])
      execFileSync('git', ['checkout', '-q', `witness/${s.planId}`], { cwd: collab })
      writeFileSync(join(collab, 'COLLAB.md'), 'x\n')
      execFileSync('git', ['add', 'COLLAB.md'], { cwd: collab })
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'collab'], { cwd: collab })
      execFileSync('git', ['push', '-q', 'origin', `witness/${s.planId}`], { cwd: collab })
      await runShip(s.ctx, s.planId)
      expect(records(s.repo, s.planId).at(-1)).toMatchObject({ outcome: 'fix' })
    } finally {
      if (before.LANG === undefined) delete process.env.LANG; else process.env.LANG = before.LANG
      if (before.LC_ALL !== undefined) process.env.LC_ALL = before.LC_ALL
    }
  }, 180_000)
})
