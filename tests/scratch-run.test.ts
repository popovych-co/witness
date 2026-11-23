import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { runCriteria } from '../src/criteria.js'
import { loadFailures, mergeReports, reportFiles } from '../src/junit.js'
import { ok, type Result } from '../src/refusal.js'
import { execCommand, runnerConfig, type RunnerConfig } from '../src/runner.js'
import { withRunnerTurn } from '../src/runner-lock.js'
import { findById, loadCanon } from '../src/scan.js'
import { inScratch } from '../src/scratch.js'
import { SCRATCH_LOCK } from '../src/scratch-lock.js'
import { grantCommands } from '../src/allowlist.js'
import {
  SPEC_META, copyFixture, fakeCtx, fakeScenario, fixtureEnv, patchConfig, seededRepo, stampLive, workspaceConfig, writeSpec, type TestRepo,
} from './helpers.js'

const value = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.violations)); return r.value }
const rule = (r: Result<unknown>): string => (r.ok ? 'ok' : r.violations[0]!.rule)
const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }
const commitAll = (repo: TestRepo, m: string) => { repo.git('add', '-A'); repo.git('commit', '-q', '-m', m) }
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!

// A suite whose report is vitest-shaped: the case passes while the install is there, the file fails to load when it is not.
const SUITE = `mkdir -p reports
if [ -f node_modules/.ready ]; then
  printf '<testsuites><testsuite name="a.test.ts"><testcase classname="a.test.ts" name="works"></testcase></testsuite></testsuites>' > reports/junit.xml
else
  printf '<testsuites><testsuite name="a.test.ts"><testcase classname="a.test.ts" name="a.test.ts"><failure message="Cannot find module" type="Error"/></testcase></testsuite></testsuites>' > reports/junit.xml
fi
echo suite >> "$PREPARE_LOG"
`
async function suiteRepo(prepare: string) {
  const repo = await seededRepo()
  const log = join(fakeScenario(), 'log')
  repo.write('suite.sh', SUITE)
  repo.write('prepare.sh', prepare)
  patchConfig(repo, { scratch: { prepare: 'sh prepare.sh' } })
  commitAll(repo, 'suite')
  grantCommands(repo.root, ['sh prepare.sh'])
  const ctx = fakeCtx(repo.root, { env: fixtureEnv({ WITNESS_TRUST_CMDS: '0', PREPARE_LOG: log }) })
  const run = () => inScratch(repo.root, ctx, cfgOf(repo.root), { tree: repo.git('rev-parse', 'HEAD') }, (dir) => {
    execCommand(dir, ctx, 'sh suite.sh', { turn: false })
    const tests = mergeReports(dir, 'reports/junit.xml')
    return tests.ok ? ok({ value: tests.value, load: loadFailures(tests.value) }) : tests
  })
  return { repo, log, run }
}

describe('a scratch run (row 258)', () => {
  it('an unchanged tree gives the same criteria result in the scratch as in the checkout (§3.4 acceptance)', async () => {
    const repo = await seededRepo()
    copyFixture(repo, 'workspace')
    await writeSpec(repo, 'rate-limit', { ...SPEC_META, summary: 'rate limiting', criteria: [{ id: 'ac-rate', test: '@spec:rate-limit' }] })
    stampLive(repo, 'rate-limit')
    repo.write('witness.config.yaml', workspaceConfig('full-suite'))
    commitAll(repo, 'full-suite')
    const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
    const doc = findById(loadCanon(repo.root), 'rate-limit')!
    const here = value(await runCriteria(repo.root, ctx, doc))
    const cfg = cfgOf(repo.root)
    const rc = value(runnerConfig(cfg)) as Extract<RunnerConfig, { mode: 'full-suite' }>
    const run = value(withRunnerTurn(repo.root, ctx, 'scratch run', (env) =>
      inScratch(repo.root, { ...ctx, env }, cfg, { tree: repo.git('rev-parse', 'HEAD') }, (dir) => {
        for (const f of reportFiles(dir, rc.reportGlob)) rmSync(join(dir, f))
        execCommand(dir, { ...ctx, env }, rc.suiteCmd, { turn: false })
        const tests = mergeReports(dir, rc.reportGlob)
        return tests.ok ? ok({ value: tests.value, load: loadFailures(tests.value) }) : tests
      })))
    const there = value(await runCriteria(repo.root, ctx, doc, { suite: run.value }))
    expect(here.ok).toBe(true)
    expect(there.criteria).toEqual(here.criteria)
    expect(there.outcomes).toEqual(here.outcomes)
    expect(run.record).toMatchObject({
      base: repo.git('rev-parse', 'HEAD^{tree}'), tree: repo.git('rev-parse', 'HEAD^{tree}'), commit: repo.git('rev-parse', 'HEAD'),
      prepared: false, reprepared: false,
    })
  }, 120_000)

  it('a load failure prepares again once and runs again', async () => {
    const { repo, log, run } = await suiteRepo('mkdir -p node_modules && touch node_modules/.ready\necho prepare >> "$PREPARE_LOG"\n')
    expect(value(run()).record).toMatchObject({ prepared: true, reprepared: false })
    rmSync(join(repo.root, '.witness', 'scratch', 'node_modules', '.ready'))
    const second = value(run())
    expect(second.value.map((t) => t.name)).toEqual(['works'])
    expect(second.record).toMatchObject({ prepared: false, reprepared: true })
    expect(readFileSync(log, 'utf8')).toBe('prepare\nsuite\nsuite\nprepare\nsuite\n')
  })

  it('a load failure the second prepare does not cure is the environment, never a red (§3.4 acceptance)', async () => {
    const { log, run } = await suiteRepo('echo prepare >> "$PREPARE_LOG"\n')
    const r = run()
    expect(rule(r)).toBe('load-failure')
    expect(r.ok ? '' : r.violations[0]!.got).toBe('a.test.ts')
    expect(readFileSync(log, 'utf8')).toBe('prepare\nsuite\nprepare\nsuite\n')
  })

  it('a bare tree runs pinned under its plan, a commit runs as itself, and an overlay is folded first — every sha recorded', async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
    const cfg = cfgOf(repo.root)
    const base = repo.git('rev-parse', 'HEAD')
    repo.write('src/new.ts', 'export const n = 1\n'); commitAll(repo, 'next')
    const listing = (dir: string) => ok({ value: existsSync(join(dir, 'src', 'new.ts')), load: [] })
    expect(value(inScratch(repo.root, ctx, cfg, { tree: base }, listing))).toMatchObject({ value: false, record: { commit: base } })
    const folded = value(inScratch(repo.root, ctx, cfg, { tree: base, overlay: { from: repo.git('rev-parse', 'HEAD'), paths: ['src/new.ts'] }, plan: 'p1' }, listing))
    expect(folded.value).toBe(true)
    expect(folded.record.base).toBe(repo.git('rev-parse', `${base}^{tree}`))
    expect(folded.record.overlay).toEqual({ from: repo.git('rev-parse', 'HEAD^{tree}'), paths: ['src/new.ts'] })
    expect(repo.git('rev-parse', `refs/witness/cf/p1/${folded.record.tree}`)).toBe(folded.record.commit)
    expect(rule(inScratch(repo.root, ctx, cfg, { tree: repo.git('rev-parse', 'HEAD^{tree}') }, listing))).toBe('cf-unpinned')
  })

  it('refuses while scratch runs are off, and on a tree the repo does not hold', async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
    const step = () => ok({ value: 1, load: [] })
    expect(rule(inScratch(repo.root, ctx, { ...cfgOf(repo.root), scratch: {} }, { tree: repo.git('rev-parse', 'HEAD') }, step))).toBe('scratch-off')
    expect(rule(inScratch(repo.root, ctx, cfgOf(repo.root), { tree: 'e'.repeat(40) }, step))).toBe('tree-unknown')
  })

  it('a run killed mid-way leaves nothing the next run sees (Review Focus 2)', async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
    const cfg = cfgOf(repo.root)
    const at = { tree: repo.git('rev-parse', 'HEAD') }
    const status = (dir: string) => ok({ value: execCommand(dir, ctx, 'git status --porcelain', { turn: false }).output.trim(), load: [] })
    value(inScratch(repo.root, ctx, cfg, at, status))
    const dir = join(repo.root, '.witness', 'scratch')
    writeFileSync(join(dir, 'junk.tmp'), 'junk')
    writeFileSync(join(dir, 'witness.config.yaml'), 'half-written')
    writeFileSync(join(repo.root, SCRATCH_LOCK), JSON.stringify({ pid: deadPid(), since: Date.now(), until: Date.now() + 60_000 }))
    expect(value(inScratch(repo.root, ctx, cfg, at, status)).value).toBe('')
  })
})
