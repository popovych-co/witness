import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { witnessPaths } from '../src/change-set.js'
import { loadConfig } from '../src/config.js'
import { stateDirs } from '../src/gitio.js'
import { appendEntry } from '../src/journal.js'
import { runnerConfig, suiteKey } from '../src/runner.js'
import { codeTree } from '../src/snapshot.js'
import { baseCounts, type FullSuite } from '../src/tests-effect.js'
import { patchConfig, seededRepo, unwrap, type TestRepo } from './helpers.js'

const c = (passed: number, failed = 0, skipped = 0) => ({ passed, failed, skipped })
const fullSuite = (root: string): FullSuite => { const rc = unwrap(runnerConfig(unwrap(loadConfig(root)))); if (rc.mode !== 'full-suite') throw new Error('rc'); return rc }
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
  it("main moved only by witness's own commits still finds it (Review Focus 4)", async () => {
    const { repo, rc, base } = await suiteConfigRepo()
    const code = codeTree(repo.root, base)!
    shipped(repo, 'old-plan', { ...c(2), specs: { 'auth-refresh': c(2) }, code, suite: suiteKey(rc) })
    repo.write(join(stateDirs(repo.root)[0]!, 'extra.md'), '# extra\n')
    repo.write(witnessPaths()[0]!, 'payload\n')
    repo.git('add', '-A', '-f'); repo.git('commit', '-q', '-m', 'a journal line, a canon doc and a payload file')
    const base2 = repo.git('rev-parse', 'HEAD')
    expect(base2).not.toBe(base)
    expect(repo.git('rev-parse', `${base2}^{tree}`)).not.toBe(repo.git('rev-parse', `${base}^{tree}`))
    expect(baseCounts(repo.root, rc, base2)).toEqual({ read: 'found', from: 'ship', code, specs: { 'auth-refresh': c(2) } })
  })
  it("a summary of another suite or other code is never the base: the base suite is owed under today's suite (Review Focus 3)", async () => {
    const { repo, rc, base } = await suiteConfigRepo()
    const code = codeTree(repo.root, base)!
    shipped(repo, 'old-plan', { ...c(2), specs: { 'auth-refresh': c(2) }, code, suite: 'a'.repeat(12) })
    shipped(repo, 'older-plan', { ...c(2), specs: { 'auth-refresh': c(2) }, code: 'd'.repeat(40), suite: suiteKey(rc) })
    expect(baseCounts(repo.root, rc, base)).toEqual({ read: 'missing', code, key: `${base}.${suiteKey(rc)}` })
  })
  it("a base whose code tree cannot be read is unreadable", async () => {
    const { repo, rc } = await suiteConfigRepo()
    expect(baseCounts(repo.root, rc, 'f'.repeat(40))).toEqual({ read: 'unreadable', why: "the base's code tree could not be read" })
  })
})
