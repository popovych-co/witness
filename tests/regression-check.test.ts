import { describe, expect, it } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { changedTestSpecs, diffTags, runRegression } from '../src/evidence.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import {
  copyFixture, fakeCtx, fakeScenario, fixtureEnv, gateEnv, putVerdict, seededRepo,
  shippableRepo, singleConfig, stampLive, writePlan, writeSpec,
} from './helpers.js'
import type { TestRepo } from './helpers.js'

const REPORT_TEST = (n: number) =>
  `import { expect, it } from 'vitest'\n\nit('renders the report @spec:report-view', () => {\n  expect(${n}).toBe(${n})\n})\n`

const REPORT_TEST_BROKEN =
  "import { expect, it } from 'vitest'\n\nit('renders the report @spec:report-view', () => {\n  expect(1).toBe(2)\n})\n"

async function regressionRepo(): Promise<{ repo: TestRepo; base: string }> {
  const repo = await seededRepo()
  copyFixture(repo, 'vitest-single')
  repo.write('witness.config.yaml', singleConfig('filtered'))
  repo.git('add', 'witness.config.yaml')
  repo.git('commit', '-m', 'runner config')
  await writeSpec(repo, 'auth-refresh')
  await writeSpec(repo, 'report-view', { criteria: [{ id: 'ac-view', test: '@spec:report-view' }] })
  stampLive(repo, 'auth-refresh')
  stampLive(repo, 'report-view')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.write('tests/report.test.ts', REPORT_TEST(3))
  repo.git('add', '-A')
  repo.git('commit', '-m', 'base: a foreign tagged test')
  return { repo, base: repo.git('rev-parse', 'HEAD') }
}

const known = (repo: TestRepo) => (id: string) => findById(loadCanon(repo.root), id) !== undefined

describe('changedTestSpecs', () => {
  // THE case row 97 exists for: a shared fixture grown from 3 to 24 respondents broke a
  // `@spec:report-view` e2e that passed three implement rounds. The tag sits on an untouched
  // line, so added-line extraction sees nothing at all.
  it('reads whole file content, where diffTags reads added lines and misses it', async () => {
    const { repo, base } = await regressionRepo()
    repo.write('tests/report.test.ts', REPORT_TEST(24))
    expect(changedTestSpecs(repo.root, base, 'auth-refresh')).toEqual(['report-view'])
    expect(diffTags(repo.root, base)).toEqual([])
  })

  it('excludes the parent — its obligation is red→green, not regression', async () => {
    const { repo, base } = await regressionRepo()
    repo.write('tests/token.test.ts',
      "import { expect, it } from 'vitest'\n\nit('rotates @spec:auth-refresh', () => { expect(1).toBe(1) })\n")
    expect(changedTestSpecs(repo.root, base, 'auth-refresh')).toEqual([])
  })

  it('skips a deleted test file — there is no content left to owe anything', async () => {
    const { repo, base } = await regressionRepo()
    rmSync(join(repo.root, 'tests', 'report.test.ts'))
    expect(changedTestSpecs(repo.root, base, 'auth-refresh')).toEqual([])
  })
})

describe('runRegression', () => {
  it('reports green when the foreign spec tests still pass', async () => {
    const { repo, base } = await regressionRepo()
    repo.write('tests/report.test.ts', REPORT_TEST(24))
    const out = await runRegression(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), repo.root,
      changedTestSpecs(repo.root, base, 'auth-refresh'), known(repo))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ spec: 'report-view', state: 'green' })
  })

  it('reports red when the foreign spec tests now fail', async () => {
    const { repo, base } = await regressionRepo()
    repo.write('tests/report.test.ts', REPORT_TEST_BROKEN)
    const out = await runRegression(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), repo.root,
      changedTestSpecs(repo.root, base, 'auth-refresh'), known(repo))
    expect(out[0]).toMatchObject({ spec: 'report-view', state: 'red' })
  })

  // A tag witness has no spec for is not an obligation witness can judge. It is named, not
  // run, and not failed — failing it would re-create the unsatisfiable check row 97 deletes.
  it('reports a tag with no spec in canon as unknown, and never runs it', async () => {
    const { repo, base } = await regressionRepo()
    repo.write('tests/ghost.test.ts',
      "import { expect, it } from 'vitest'\n\nit('ghost @spec:nowhere', () => { expect(1).toBe(1) })\n")
    const specs = changedTestSpecs(repo.root, base, 'auth-refresh')
    expect(specs).toContain('nowhere')
    const out = await runRegression(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), repo.root,
      specs, known(repo))
    expect(out.find((r) => r.spec === 'nowhere')).toMatchObject({ state: 'unknown' })
  })
})

describe('the implement gate carries the regression check', () => {
  it('stops on a foreign spec the diff broke', async () => {
    const { repo, wt, planId } = await shippableRepo()
    // the spec is canon at the ROOT; the test that breaks it lives in the WORKTREE
    await writeSpec(repo, 'report-view', { criteria: [{ id: 'ac-view', test: '@spec:report-view' }] })
    stampLive(repo, 'report-view')
    writeFileSync(join(wt, 'tests', 'report.test.ts'), REPORT_TEST_BROKEN)

    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: 'src/token.ts', note: 'read' }], findings: [] })
    const code = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId,
      { fresh: false, manual: false })
    expect(code).toBe(1)
    const run = readStream(repo.root, planId).filter((e) => e.t === 'gate-run').at(-1) as unknown as GateRunEntry
    expect(run.checks.find((c) => c.name === 'regression')).toMatchObject({ ok: false })
    await repo.cli(['clean'])
  })
})
