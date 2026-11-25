import { appendFileSync, cpSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_TESTS, baseTestsKey, baseTestsKind, baseTestsResult } from '../src/base-tests.js'
import { loadConfig } from '../src/config.js'
import { stateDirs } from '../src/gitio.js'
import { jobKinds } from '../src/jobs.js'
import { appendEntry } from '../src/journal.js'
import { suiteKey } from '../src/runner.js'
import { loadCanon } from '../src/scan.js'
import { codeTree } from '../src/snapshot.js'
import {
  SKIP_SECOND, TOKEN_FIXED, TOKEN_TESTS_TAGGED, approve, fakeCtx, fixtureEnv, fixturePath, fullSuite, patchConfig, seededRepo,
  trustConfig, unwrap, vitestBin, writePlan, writeSpec,
} from './helpers.js'

// Row 275 (C29, C32). The base suite job: drive runs the base commit's suite in the scratch when no
// shipped summary holds the base's code, and returns each spec's counts.

// A repo whose base commit holds the vitest-single fixture and the auth-refresh spec, in full-suite mode.
async function suiteRepo(tests = TOKEN_TESTS_TAGGED) {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  cpSync(fixturePath('vitest-single'), repo.root, { recursive: true, filter: (s) => !s.includes('node_modules') })
  repo.write('src/token.ts', TOKEN_FIXED); repo.write('tests/token.test.ts', tests)
  repo.write('.gitignore', 'node_modules/\nreports/\n')
  const suiteCmd = `node "${vitestBin()}" run --reporter=junit --outputFile=reports/junit.xml`
  patchConfig(repo, { criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' }, ship: { test: suiteCmd, lint: 'true' } })
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'base')
  trustConfig(repo)
  const cfg = () => unwrap(loadConfig(repo.root))
  const commit = repo.git('rev-parse', 'HEAD')
  const key = () => baseTestsKey(commit, suiteKey(fullSuite(repo.root)))
  const run = (k = key(), env = fixtureEnv()) =>
    baseTestsKind.run(repo.root, fakeCtx(repo.root, { env }), cfg(), { kind: BASE_TESTS, key: k, shards: 1 }, 1)
  return { repo, commit, key, run }
}

// A gate-run whose switch-offs check owes what it is given.
const owing = (gate: string, owes: unknown[]) => ({
  v: 1, t: 'gate-run' as const, gate, round: 1, checks: [{ name: 'switch-offs', ok: true, owes }],
})

describe('the base suite job (row 275)', () => {
  it("runs the base commit's suite in the scratch and counts each spec's cases", async () => {
    const { repo, commit, run } = await suiteRepo()
    // main moves on before drive runs it: an existing stream and the spec's doc (slice 1 review I2)
    const stream = readdirSync(join(repo.root, '.witness', 'journal')).find((f) => f.endsWith('.jsonl'))!
    appendFileSync(join(repo.root, '.witness', 'journal', stream), '{"v":1,"t":"status"}\n')
    appendFileSync(join(repo.root, stateDirs(repo.root)[0]!, 'auth-refresh.md'), '\nstamped\n')
    repo.git('add', '-A', '-f'); repo.git('commit', '-q', '-m', 'witness moves main')
    expect(run()).toEqual({ outcome: 'done', result: {
      passed: 2, failed: 0, skipped: 0, specs: { 'auth-refresh': { passed: 2, failed: 0, skipped: 0 } },
      commit, code: codeTree(repo.root, commit), tree: repo.git('rev-parse', `${commit}^{tree}`) } })
  }, 120_000)

  it('a skipped case counts as skipped', async () => {
    const { run } = await suiteRepo(SKIP_SECOND)
    expect(run()).toMatchObject({ outcome: 'done', result: { specs: { 'auth-refresh': { passed: 1, failed: 0, skipped: 1 } } } })
  }, 120_000)

  it('a suite that leaves no report fails the shard; a file that never loads fails it as load-failure, never a count', async () => {
    const quiet = await suiteRepo()
    patchConfig(quiet.repo, { ship: { test: 'true' } })
    trustConfig(quiet.repo)
    expect(quiet.run(quiet.key())).toMatchObject({ outcome: 'failed', why: expect.stringMatching(/no-reports/) })
    const broken = await suiteRepo(`import { gone } from '../src/missing'\n${TOKEN_TESTS_TAGGED}\nit('uses gone @spec:auth-refresh', () => { gone() })\n`)
    expect(broken.run()).toMatchObject({ outcome: 'failed', why: expect.stringMatching(/load-failure/) })
  }, 240_000)

  it('a key whose suite changed since its gate asked fails, and so does an untrusted suite (Review Focus 3)', async () => {
    const { repo, key, run } = await suiteRepo()
    const asked = key()
    patchConfig(repo, { ship: { test: `node "${vitestBin()}" run --reporter=junit --outputFile=reports/junit.xml --silent` } })
    trustConfig(repo)
    expect(run(asked)).toEqual({ outcome: 'failed', why: 'the suite changed since its gate asked — the next gate asks again' })
    rmSync(join(repo.root, '.witness', 'allow.json'), { force: true })
    expect(run(key(), fixtureEnv({ WITNESS_TRUST_CMDS: '0' }))).toMatchObject({ outcome: 'failed', why: expect.stringMatching(/^untrusted: /) })
  }, 120_000)

  it("owes exactly the keys a plan's last implement and ship rounds left on switch-offs, under today's suite", async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'p1')                     // PLAN_META's parent is auth-refresh
    repo.flipStatus('p1', 'in-progress')
    patchConfig(repo, { criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' }, ship: { test: 'npm test', lint: 'true' } })
    const cfg = () => unwrap(loadConfig(repo.root))
    const suite = suiteKey(fullSuite(repo.root))
    const k1 = baseTestsKey('a'.repeat(40), suite)
    const k2 = baseTestsKey('b'.repeat(40), suite)
    const older = baseTestsKey('c'.repeat(40), suite)
    const otherSuite = baseTestsKey('d'.repeat(40), 'e'.repeat(12))
    appendEntry(repo.root, 'p1', owing('ship', [{ kind: BASE_TESTS, key: older }]))
    appendEntry(repo.root, 'p1', owing('ship', [{ kind: BASE_TESTS, key: k2 }, { kind: BASE_TESTS, key: k1 }, { kind: 'base-lint', key: k1 }]))
    appendEntry(repo.root, 'p1', owing('implement', [{ kind: BASE_TESTS, key: k1 }, { kind: BASE_TESTS, key: otherSuite }, { kind: BASE_TESTS, key: 'not a key' }]))
    expect(baseTestsKind.owed(repo.root, cfg(), loadCanon(repo.root))).toEqual([
      { kind: BASE_TESTS, key: k1, shards: 1 }, { kind: BASE_TESTS, key: k2, shards: 1 }])
    patchConfig(repo, { criteria: { runner: `node "${vitestBin()}" run -t "@spec:{id}"` } })
    expect(baseTestsKind.owed(repo.root, cfg(), loadCanon(repo.root))).toEqual([])
  })

  it('reads only a result of its own shape', () => {
    const ok = { passed: 1, failed: 0, skipped: 0, specs: { a: { passed: 1, failed: 0, skipped: 0 } }, commit: 'a'.repeat(40), code: 'b'.repeat(40), tree: 'c'.repeat(40) }
    expect(baseTestsResult(ok)).toEqual(ok)
    for (const bad of [{ ...ok, extra: 1 }, { ...ok, passed: -1 }, { ...ok, code: 'x' }, { ...ok, specs: { 'Not An Id': ok.specs.a } },
      { ...ok, specs: { a: { passed: 1, failed: 0 } } }, { ...ok, passed: 1.5 }]) expect(baseTestsResult(bad)).toBeUndefined()
  })

  it('is registered after base-lint: it takes the turn, runs in the scratch, and yields the turn to plan work', () => {
    expect(jobKinds({}).map((k) => k.kind)).toEqual(['base-lint', 'lint-effect', 'base-tests'])
    expect(baseTestsKind).toMatchObject({ turn: true, gated: false, scratch: true })
  })
})
