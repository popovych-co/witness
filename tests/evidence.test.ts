import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/cli.js'
import { isTestPath, screensDir } from '../src/evidence.js'
import { readStream } from '../src/journal.js'
import { worktreePath } from '../src/worktree.js'
import type { TestRepo } from './helpers.js'
import {
  TOKEN_BROKEN, TOKEN_TESTS_TAGGED, TOKEN_TESTS_UNTAGGED,
  approve, breakSingleFixture, commitEntry, copyFixture, evidenceCycle, fakeCtx, fakeScenario, fixSingleFixture, fixtureEnv,
  seededRepo, singleConfig, stampLive, startedThreeStepPlan, untaggedRed, vitestBin, writePlan, writeSpec,
} from './helpers.js'

async function planRepo(): Promise<TestRepo> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('witness.config.yaml', singleConfig('filtered'))
  await writeSpec(repo, 'auth-refresh')
  stampLive(repo, 'auth-refresh')
  const res = await writePlan(repo, 'auth-refresh-plan-1')
  if (res.code !== 0) throw new Error(`plan write failed: ${res.stderr}`)
  return repo
}

describe('isTestPath', () => {
  it('classifies by .test./.spec. and test-dir segments', () => {
    expect(isTestPath('src/token.test.ts')).toBe(true)
    expect(isTestPath('src/token.spec.js')).toBe(true)
    expect(isTestPath('tests/token.ts')).toBe(true)
    expect(isTestPath('pkg/__tests__/x.py')).toBe(true)
    expect(isTestPath('src/token.ts')).toBe(false)
    expect(isTestPath('contest/entry.ts')).toBe(false)
  })
})

const reportedConfig = () => {
  const vb = vitestBin()
  return `schema: 1\ncriteria:\n  runner: 'node "${vb}" run -t "@spec:{id}" --passWithNoTests --reporter=junit --outputFile=reports/junit.xml'\n  report: junit:**/reports/junit.xml\n`
}

describe('witness test-evidence', () => {
  it('records a red/green pair across the TDD loop', async () => {
    const repo = await planRepo()
    breakSingleFixture(repo)
    const red = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red', '--step', 's1'], { env: fixtureEnv() })
    expect(red.code).toBe(0)
    fixSingleFixture(repo)
    const green = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green', '--step', 's1'], { env: fixtureEnv() })
    expect(green.code).toBe(0)
    const entries = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'test-evidence')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ phase: 'red', runner: 'filtered' })
    expect((entries[0]?.tests as Array<{ ok: boolean }>)[0]?.ok).toBe(false)
    expect((entries[1]?.tests as Array<{ ok: boolean }>)[0]?.ok).toBe(true)
  })

  it('flags a passing red phase as vacuous and exits 1', async () => {
    const repo = await planRepo()
    const res = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red', '--step', 's1'], { env: fixtureEnv() })
    expect(res.code).toBe(1)
    const entry = readStream(repo.root, 'auth-refresh-plan-1').at(-1)
    expect(entry).toMatchObject({ phase: 'red', vacuous: true })
  })

  it('exits 1 when the green phase is not green — evidence still recorded', async () => {
    const repo = await planRepo()
    breakSingleFixture(repo)
    const res = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green', '--step', 's1'], { env: fixtureEnv() })
    expect(res.code).toBe(1)
    expect(readStream(repo.root, 'auth-refresh-plan-1').at(-1)?.phase).toBe('green')
  })

  it('refuses an unknown plan or a bad phase', async () => {
    const repo = await planRepo()
    expect((await repo.cli(['test-evidence', 'nope', '--phase', 'red', '--step', 's1'], { env: fixtureEnv() })).code).toBe(2)
    expect((await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'purple', '--step', 's1'], { env: fixtureEnv() })).code).toBe(2)
  })

  it('records real per-test outcomes from the junit report (filtered + report)', async () => {
    const repo = await planRepo()
    repo.write('witness.config.yaml', reportedConfig())
    repo.write('src/token.ts', TOKEN_BROKEN)
    repo.write('tests/token.test.ts', TOKEN_TESTS_TAGGED)
    repo.git('add', '-A')
    repo.git('commit', '-m', 'red state')
    const r = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red', '--step', 's1'], { env: fixtureEnv() })
    expect(r.code).toBe(0)
    const entries = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'test-evidence')
    const tests = entries.at(-1)!.tests as Array<{ name: string; ok: boolean }>
    expect(tests.length).toBeGreaterThanOrEqual(2)
    expect(tests.every((t) => t.name.includes('@spec:auth-refresh'))).toBe(true)
    expect(tests.some((t) => !t.ok)).toBe(true)
  })

  it('refuses filter-matched-nothing before journaling when zero tests match', async () => {
    const repo = await planRepo()
    repo.write('witness.config.yaml', reportedConfig())
    repo.write('tests/token.test.ts', TOKEN_TESTS_UNTAGGED)   // no tagged tests anywhere
    repo.git('add', '-A')
    repo.git('commit', '-m', 'untagged only')
    const r = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red', '--step', 's1'], { env: fixtureEnv() })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('filter-matched-nothing')
    const entries = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'test-evidence')
    expect(entries).toEqual([])
  })

  it('routes the journal append main-side when run from a linked worktree', async () => {
    const repo = await planRepo()
    breakSingleFixture(repo)
    const wt = `${repo.root}-wt`
    repo.git('worktree', 'add', wt, '-b', 'wt-evidence')
    const code = await main(fakeCtx(wt, { env: fixtureEnv() }), ['test-evidence', 'auth-refresh-plan-1', '--phase', 'red', '--step', 's1'])
    expect(code).toBe(0)
    const entries = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'test-evidence')
    expect(entries).toHaveLength(1)
    repo.git('worktree', 'remove', '--force', wt)
  })
})

// Row 191 §4.3. A cycle names the plan step it closes, checked against the manifest before
// anything runs.
describe('test-evidence --step', () => {
  const P = 'auth-refresh-plan-1'
  const evidence = (repo: TestRepo) => readStream(repo.root, P).filter((e) => e.t === 'test-evidence')

  it('refuses an unknown step before running the suite', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    const r = await repo.cli(['test-evidence', P, '--phase', 'red', '--step', 'nope'], { cwd: wt, env: fixtureEnv() })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown-step')
    expect(r.stderr).toContain(`a step of ${P}: s1 · s2 · s3`)
    expect(existsSync(screensDir(wt, P))).toBe(false)
    expect(evidence(repo)).toEqual([])
  })

  it('refuses a scaffolding step', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    const r = await repo.cli(['test-evidence', P, '--phase', 'red', '--step', 's3'], { cwd: wt, env: fixtureEnv() })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('scaffolding-step')
    expect(r.stderr).toContain(`witness step-close ${P} --step s3`)
    expect(evidence(repo)).toEqual([])
  })

  it('refuses --step with no value rather than running untagged', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    const r = await repo.cli(['test-evidence', P, '--phase', 'red', '--step'], { cwd: wt, env: fixtureEnv() })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('required')
    expect(r.stderr).toContain('witness test-evidence <plan-id> --phase red|green [--step <id>]')
    expect(evidence(repo)).toEqual([])
  })

  it('never reads a flag value as the plan id', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    const r = await repo.cli(['test-evidence', '--step', 'nope', P, '--phase', 'red'], { cwd: wt, env: fixtureEnv() })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown-step')
    expect(r.stderr).not.toContain('unknown-plan')
  })

  it('journals the step on the entry', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    const green = await evidenceCycle(repo, wt, P, 's1')
    expect(green.code).toBe(0)
    expect(evidence(repo)).toMatchObject([{ phase: 'red', step: 's1' }, { phase: 'green', step: 's1' }])
  })

  // Plan's call 4. On a plan whose progress is known, one forgotten flag would silently turn the
  // plan's step awareness off, so the cycle is refused before anything runs.
  it('requires --step on a known plan before its first implement gate', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    const r = await repo.cli(['test-evidence', P, '--phase', 'red'], { cwd: wt, env: fixtureEnv() })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('step-required')
    expect(r.stderr).toContain("--step <id> — every cycle before the first implement gate is a plan step's · steps 0/3 done · next s1")
    expect(evidence(repo)).toEqual([])
    expect(existsSync(screensDir(wt, P))).toBe(false)
  })

  // After that gate an untagged cycle is a fix round, which closes no step.
  it('accepts an untagged cycle after an implement gate run', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    commitEntry(repo, P, {
      t: 'gate-run', gate: 'implement', artifact: P, round: 1, run_id: 'r-1', reviewed_sha: 'sha-before',
      prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'passed',
    })
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    const r = await repo.cli(['test-evidence', P, '--phase', 'red'], { cwd: wt, env: fixtureEnv() })
    expect(r.code).toBe(0)
    expect(evidence(repo)).toHaveLength(1)
    expect(evidence(repo)[0]).not.toHaveProperty('step')
  })

  // A legacy plan's evidence predates step tags, so its cycles were never a step's to name.
  it('accepts an untagged cycle on a legacy plan', async () => {
    const { repo, wt } = await startedThreeStepPlan()
    commitEntry(repo, P, untaggedRed(P))
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    const r = await repo.cli(['test-evidence', P, '--phase', 'red'], { cwd: wt, env: fixtureEnv() })
    expect(r.code).toBe(0)
    expect(evidence(repo)).toHaveLength(2)
    expect(evidence(repo)[1]).not.toHaveProperty('step')
  })
})

it('test-evidence runs the suite outside the repo lock and journals inside it (D76 · B3)', async () => {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  approve(repo, 'auth-refresh-plan-1')
  await repo.cli(['start', 'auth-refresh-plan-1'])
  const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
  const probe = join(fakeScenario(), 'probe')
  writeFileSync(join(wt, 'probe.sh'),
    `if [ -e "${repo.root}/.witness/lock" ]; then echo held; else echo free; fi > "${probe}"\nexit 1\n`)
  writeFileSync(join(wt, 'witness.config.yaml'), "schema: 1\ncriteria:\n  runner: 'sh probe.sh {id}'\n")
  const r = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
  expect(r.code).toBe(0)
  expect(readFileSync(probe, 'utf8').trim()).toBe('free')
  expect(readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'test-evidence')).toHaveLength(1)
  expect(existsSync(join(repo.root, '.witness', 'lock'))).toBe(false)
})
