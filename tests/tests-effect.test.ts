import { appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_TESTS, baseTestsKey } from '../src/base-tests.js'
import { witnessPaths } from '../src/change-set.js'
import { stateDirs } from '../src/gitio.js'
import { journalShard } from '../src/jobs.js'
import { appendEntry } from '../src/journal.js'
import { suiteKey } from '../src/runner.js'
import { codeTree } from '../src/snapshot.js'
import { baseCounts } from '../src/tests-effect.js'
import { fullSuite, patchConfig, seededRepo, unwrap, type TestRepo } from './helpers.js'

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
