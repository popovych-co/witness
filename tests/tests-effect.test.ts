import { appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_TESTS, baseTestsKey } from '../src/base-tests.js'
import { witnessPaths } from '../src/change-set.js'
import { stateDirs } from '../src/gitio.js'
import { loadConfig } from '../src/config.js'
import { acquireDriveLock } from '../src/drive-presence.js'
import { journalShard } from '../src/jobs.js'
import { appendEntry } from '../src/journal.js'
import type { TestOutcome } from '../src/junit.js'
import { suiteKey } from '../src/runner.js'
import { findById, loadCanon } from '../src/scan.js'
import { codeTree } from '../src/snapshot.js'
import { baseCounts, droppedCases, droppedKey, licensedSpec, testsEffect } from '../src/tests-effect.js'
import { approve, fullSuite, patchConfig, seededRepo, unwrap, writePlan, writeSpec, type TestRepo } from './helpers.js'

const c = (passed: number, failed = 0, skipped = 0) => ({ passed, failed, skipped })
async function suiteConfigRepo() {
  const repo = await seededRepo()
  patchConfig(repo, { criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' }, ship: { test: 'npm test', lint: 'true' } })
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'full-suite')
  return { repo, rc: fullSuite(repo.root), base: repo.git('rev-parse', 'HEAD') }
}
// A ship round on another plan's stream, its summary as given.
const shipped = (repo: TestRepo, stream: string, junit: Record<string, unknown>) => appendEntry(repo.root, stream, {
  t: 'gate-run', gate: 'ship', artifact: stream, round: 1, run_id: 'r-1', reviewed_sha: 'c'.repeat(40), prompts_sha: 'p',
  witness: '0', model: 'm', outcome: 'stopped', checks: [], junit } as never)

describe("the base's passing counts (row 275, C29)", () => {
  it('come from a shipped summary whose code tree and suite match the base commit', async () => {
    const { repo, rc, base } = await suiteConfigRepo()
    const code = codeTree(repo.root, base)!
    shipped(repo, 'old-plan', { ...c(2), specs: { 'auth-refresh': c(2) }, code, suite: suiteKey(rc) })
    expect(baseCounts(repo.root, rc, base)).toEqual({ read: 'found', from: 'ship', code, specs: { 'auth-refresh': c(2) } })
  })
  it("main moved only by witness's own commits still finds it, for the old base and the new (Review Focus 4)", async () => {
    const { repo, rc, base } = await suiteConfigRepo()
    const code = codeTree(repo.root, base)!
    const found = { read: 'found', from: 'ship', code, specs: { 'auth-refresh': c(2) } }
    const stream = readdirSync(join(repo.root, '.witness', 'journal')).find((f) => f.endsWith('.jsonl'))!
    repo.git('cat-file', '-e', `${base}:.witness/journal/${stream}`)                  // a stream the base holds
    shipped(repo, 'old-plan', { ...c(2), specs: { 'auth-refresh': c(2) }, code, suite: suiteKey(rc) })
    appendFileSync(join(repo.root, '.witness', 'journal', stream), '{"v":1,"t":"status"}\n')
    repo.write(join(stateDirs(repo.root)[0]!, 'extra.md'), '# extra\n')
    repo.write(witnessPaths()[0]!, 'payload\n')
    repo.git('add', '-A', '-f'); repo.git('commit', '-q', '-m', 'journal lines, a canon doc and a payload file')
    const base2 = repo.git('rev-parse', 'HEAD')
    expect(repo.git('rev-parse', `${base2}^{tree}`)).not.toBe(repo.git('rev-parse', `${base}^{tree}`))
    expect(baseCounts(repo.root, rc, base2)).toEqual(found)
    expect(baseCounts(repo.root, rc, base)).toEqual(found)                              // read after main moved (slice 1 review I2)
  })
  it("a summary of another suite or other code is never the base: the base suite is owed under today's suite (Review Focus 3)", async () => {
    const { repo, rc, base } = await suiteConfigRepo()
    const code = codeTree(repo.root, base)!
    shipped(repo, 'old-plan', { ...c(2), specs: { 'auth-refresh': c(2) }, code, suite: 'a'.repeat(12) })
    shipped(repo, 'older-plan', { ...c(2), specs: { 'auth-refresh': c(2) }, code: 'd'.repeat(40), suite: suiteKey(rc) })
    expect(baseCounts(repo.root, rc, base)).toEqual({ read: 'missing', code, key: `${base}.${suiteKey(rc)}` })
  })
  it("a ship line on a stream it does not name, or with malformed counts, never serves (security review)", async () => {
    const { repo, rc, base } = await suiteConfigRepo()
    const code = codeTree(repo.root, base)!
    appendEntry(repo.root, 'stray', { t: 'gate-run', gate: 'ship', artifact: 'other-plan', round: 1, run_id: 'r-1', reviewed_sha: 'c'.repeat(40),
      prompts_sha: 'p', witness: '0', model: 'm', outcome: 'stopped', checks: [], junit: { ...c(2), specs: { 'auth-refresh': c(1) }, code, suite: suiteKey(rc) } } as never)
    shipped(repo, 'bad-counts', { ...c(2), specs: { 'auth-refresh': { passed: -1, failed: 0, skipped: 0 } }, code, suite: suiteKey(rc) })
    shipped(repo, 'bad-id', { ...c(2), specs: { 'Not An Id': c(1) }, code, suite: suiteKey(rc) })
    shipped(repo, 'bad-shape', { ...c(2), specs: 'all', code, suite: suiteKey(rc) })
    expect(baseCounts(repo.root, rc, base)).toEqual({ read: 'missing', code, key: `${base}.${suiteKey(rc)}` })
  })
  it("a base whose code tree cannot be read is unreadable", async () => {
    const { repo, rc } = await suiteConfigRepo()
    expect(baseCounts(repo.root, rc, 'f'.repeat(40))).toEqual({ read: 'unreadable', why: "the base's code tree could not be read" })
  })
  it('a done base-tests result serves every base commit of its code tree (C29)', async () => {
    const { repo, rc, base } = await suiteConfigRepo()
    const code = codeTree(repo.root, base)!
    const specs = { 'auth-refresh': c(2) }
    unwrap(journalShard(repo.root, { kind: BASE_TESTS, key: baseTestsKey(base, suiteKey(rc)), shard: 1, of: 1, outcome: 'done', ms: 1,
      result: { ...c(2), specs, commit: base, code, tree: repo.git('rev-parse', `${base}^{tree}`) } }))
    const later = repo.git('rev-parse', 'HEAD')                   // the shard's own journal commit
    expect(later).not.toBe(base)
    expect(baseCounts(repo.root, rc, later)).toEqual({ read: 'found', from: 'job', code, specs })
  })
  it('a base-tests result under another suite, of other code, or malformed never serves', async () => {
    const { repo, rc, base } = await suiteConfigRepo()
    const code = codeTree(repo.root, base)!
    const tree = repo.git('rev-parse', `${base}^{tree}`)
    const result = { ...c(2), specs: { 'auth-refresh': c(2) }, commit: base, code, tree }
    unwrap(journalShard(repo.root, { kind: BASE_TESTS, key: baseTestsKey(base, 'a'.repeat(12)), shard: 1, of: 1, outcome: 'done', ms: 1, result }))
    unwrap(journalShard(repo.root, { kind: BASE_TESTS, key: baseTestsKey('b'.repeat(40), suiteKey(rc)), shard: 1, of: 1, outcome: 'done', ms: 1,
      result: { ...result, code: 'd'.repeat(40) } }))
    unwrap(journalShard(repo.root, { kind: BASE_TESTS, key: baseTestsKey('e'.repeat(40), suiteKey(rc)), shard: 1, of: 1, outcome: 'done', ms: 1,
      result: { ...result, extra: 1 } }))
    expect(baseCounts(repo.root, rc, base)).toEqual({ read: 'missing', code, key: `${base}.${suiteKey(rc)}` })
  })
})

const outcome = (name: string, status: TestOutcome['status']): TestOutcome => ({ name, classname: 'tests/a.test.ts', status })
const cases = (spec: string, passed: number, failed = 0, skipped = 0): TestOutcome[] => [
  ...Array.from({ length: passed }, (_, i) => outcome(`p${i} @spec:${spec}`, 'passed')),
  ...Array.from({ length: failed }, (_, i) => outcome(`f${i} @spec:${spec}`, 'failed')),
  ...Array.from({ length: skipped }, (_, i) => outcome(`s${i} @spec:${spec}`, 'skipped')),
]
const live = new Set(['a', 'b'])
const lostCount = (plan: TestOutcome[], base: Record<string, ReturnType<typeof c>>, licensed?: string) =>
  droppedCases(plan, base, live, licensed).offs.reduce((n, o) => n + o.count, 0)

// A full-suite repo with the auth-refresh spec approved and plan p1 written on it; its base is HEAD.
async function planRepo() {
  const { repo, rc } = await suiteConfigRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'p1')
  repo.git('add', '-A'); repo.git('commit', '-q', '--allow-empty', '-m', 'canon')
  const canon = loadCanon(repo.root)
  const plan = findById(canon, 'p1')!
  const cfg = unwrap(loadConfig(repo.root))
  return { repo, rc, canon, plan, cfg, base: repo.git('rev-parse', 'HEAD') }
}

describe('what a round lost (row 275, C30)', () => {
  it.each([
    ['a skip, nothing added', { a: c(2) }, cases('a', 1, 0, 1), 1],
    ['a removal', { a: c(2) }, cases('a', 1), 1],
    ["a new failure is the tests lane's red, never a loss", { a: c(2) }, cases('a', 1, 1), 0],
    ['three added and one skipped (Review Focus 1)', { a: c(2) }, cases('a', 4, 0, 1), 1],
    ['one removed and one added nets out', { a: c(2) }, cases('a', 2), 0],
    ['the base failing, the plan passing', { a: c(1, 1) }, cases('a', 2), 0],
    ['untagged or excluded: every case gone', { a: c(2) }, [], 2],
  ])('%s', (_label, base, plan, want) => {
    expect(lostCount(plan, base)).toBe(want)
  })
  it("a loss names its spec, its key and both sides' counts", () => {
    expect(droppedCases(cases('a', 1, 0, 1), { a: c(2) }, live, undefined).offs).toEqual([
      { kind: 'dropped', key: droppedKey('a'), spec: 'a', count: 1, base: c(2), plan: c(1, 0, 1) }])
    expect(droppedKey('a')).toMatch(/^[0-9a-f]{16}$/)
    expect(droppedKey('a')).not.toBe(droppedKey('b'))
  })
  it('a spec gone from canon is not compared (Review Focus 2)', () => {
    expect(droppedCases([], { gone: c(5) }, live, undefined).offs).toEqual([])
  })
  it('losses come sorted by spec', () => {
    expect(droppedCases([], { b: c(1), a: c(1) }, live, undefined).offs.map((o) => o.spec)).toEqual(['a', 'b'])
  })
  it("the licensed spec's removals are listed, never counted; its skips always count (C31)", () => {
    expect(droppedCases(cases('a', 1), { a: c(3) }, live, 'a')).toEqual({ offs: [], licensed: [{ spec: 'a', lost: 2 }] })
    expect(droppedCases(cases('a', 1, 0, 1), { a: c(3) }, live, 'a')).toEqual({
      offs: [expect.objectContaining({ spec: 'a', count: 1 })], licensed: [{ spec: 'a', lost: 1 }] })
    expect(lostCount([], { b: c(1) }, 'a')).toBe(1)                       // another spec: no license
  })
  it("licenses the plan's parent only while its content has moved past its previous plan's pin (C31)", async () => {
    const { repo, plan } = await planRepo()
    expect(licensedSpec(repo.root, loadCanon(repo.root), plan)).toBe('auth-refresh')        // no other plan realizes it
    await writePlan(repo, 'p2')
    const p2 = () => findById(loadCanon(repo.root), 'p2')!
    expect(p2().meta['derives-from']).toBe(plan.meta['derives-from'])
    expect(licensedSpec(repo.root, loadCanon(repo.root), p2())).toBeUndefined()            // pinned like p1
    repo.setMeta('p2', { 'derives-from': 'e'.repeat(64) })                                 // written after an amendment
    expect(licensedSpec(repo.root, loadCanon(repo.root), p2())).toBe('auth-refresh')
  })
})

describe('the tests effect (row 275, C32)', () => {
  it('reads not checked, and owes the base suite, while no base is measured', async () => {
    const { repo, rc, canon, plan, cfg, base } = await planRepo()
    const owes = { kind: 'base-tests', key: `${base}.${suiteKey(rc)}` }
    expect(testsEffect(repo.root, canon, cfg, plan, base, cases('auth-refresh', 2))).toEqual({ read: 'not-checked',
      why: 'the base suite is not measured — no drive runs jobs in this repo', offs: [], licensed: [], owes })
    const release = unwrap(acquireDriveLock(repo.root, { manual: true }))
    try {
      expect(testsEffect(repo.root, canon, cfg, plan, base, cases('auth-refresh', 2))).toMatchObject({ read: 'not-checked',
        why: 'the base suite is not measured yet — drive runs it', owes })
    } finally { release() }
    expect(testsEffect(repo.root, canon, { ...cfg, scratch: { ...cfg.scratch, prepare: undefined } }, plan, base, [])).toMatchObject({
      read: 'not-checked', why: 'the base suite is not measured, and scratch runs are off — scratch.prepare is not set', owes })
  })
  it('a base suite struck twice reads its why; a done result that does not parse reads unreadable', async () => {
    const { repo, rc, canon, plan, cfg, base } = await planRepo()
    const key = baseTestsKey(base, suiteKey(rc))
    for (let i = 0; i < 2; i++) unwrap(journalShard(repo.root, { kind: BASE_TESTS, key, shard: 1, of: 1, outcome: 'failed', ms: 1, why: 'no-reports: x' }))
    expect(testsEffect(repo.root, canon, cfg, plan, base, [])).toMatchObject({ read: 'not-checked', why: 'the base suite is not measured — no-reports: x' })
    const { repo: r2, rc: rc2, canon: canon2, plan: plan2, cfg: cfg2, base: base2 } = await planRepo()
    unwrap(journalShard(r2.root, { kind: BASE_TESTS, key: baseTestsKey(base2, suiteKey(rc2)), shard: 1, of: 1, outcome: 'done', ms: 1, result: { bad: 1 } }))
    expect(testsEffect(r2.root, canon2, cfg2, plan2, base2, [])).toMatchObject({ read: 'not-checked', why: "the base suite's result could not be read" })
  })
  it('a filtered runner, or a round with no suite, never compares and owes nothing', async () => {
    const { repo, canon, plan, cfg, base } = await planRepo()
    const none = testsEffect(repo.root, canon, cfg, plan, base, undefined)
    expect(none).toEqual({ read: 'not-checked', why: 'no full-suite run this round', offs: [], licensed: [] })
    patchConfig(repo, { criteria: { runner: 'npx vitest run -t "@spec:{id}"' } })
    expect(testsEffect(repo.root, canon, unwrap(loadConfig(repo.root)), plan, base, [])).toEqual({ read: 'not-checked',
      why: 'the runner is filtered — the tests effect reads a full-suite junit report', offs: [], licensed: [] })
  })
  it('a round whose suite failed to load a file reads not checked, never a loss (slice 2 review I1)', async () => {
    const { repo, rc, canon, plan, cfg, base } = await planRepo()
    shipped(repo, 'old-plan', { ...c(3), specs: { 'auth-refresh': c(3) }, code: codeTree(repo.root, base)!, suite: suiteKey(rc) })
    const broken: TestOutcome = { name: 'tests/b.test.ts', classname: 'tests/b.test.ts', status: 'failed', load: true }
    expect(testsEffect(repo.root, canon, cfg, plan, base, [...cases('auth-refresh', 1), broken])).toEqual({ read: 'not-checked',
      why: 'a test file failed to load — tests/b.test.ts', offs: [], licensed: [] })
  })
  it('compares against a found base and reports the counts it compared against', async () => {
    const { repo, rc, canon, plan, cfg, base } = await planRepo()
    shipped(repo, 'old-plan', { ...c(2), specs: { 'auth-refresh': c(2), gone: c(4) }, code: codeTree(repo.root, base)!, suite: suiteKey(rc) })
    expect(testsEffect(repo.root, canon, cfg, plan, base, cases('auth-refresh', 1, 0, 1))).toEqual({ read: 'compared', specs: 1,
      base: { 'auth-refresh': c(2) }, licensed: [],                       // the compared specs alone
      offs: [{ kind: 'dropped', key: droppedKey('auth-refresh'), spec: 'auth-refresh', count: 1, base: c(2), plan: c(1, 0, 1) }] })
    // p1 is the parent's only plan: its removals are licensed, named, never counted
    expect(testsEffect(repo.root, canon, cfg, plan, base, cases('auth-refresh', 1))).toMatchObject({ read: 'compared', offs: [],
      licensed: [{ spec: 'auth-refresh', lost: 1 }] })
  })
})
