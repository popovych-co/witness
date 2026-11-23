import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import { junitSummary } from '../src/junit.js'
import type { GateRunEntry } from '../src/rounds.js'
import {
  TOKEN_BROKEN, fakeCtx, fakeScenario, gateEnv, patchConfig, putVerdict, shippableRepo, trustConfig, vitestBin,
  type TestRepo,
} from './helpers.js'

// Rows 251, 252. In full-suite mode the ship gate runs the suite once — the tests lane is the run
// the criteria lane reads — and journals that run's junit summary on the tree the gate reviewed.

// vitest-single fixture lands 4 files in the worktree diff — coverage-minimum needs an anchor per each.
const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}

const shipRuns = (repo: TestRepo, id: string) =>
  (readStream(repo.root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]).filter((r) => r.gate === 'ship')
const lastShipRun = (repo: TestRepo, id: string) => shipRuns(repo, id).at(-1)!
const check = (r: GateRunEntry, name: string) => r.checks.find((c) => c.name === name)!

// A full-suite ship whose suite counts its own runs in a file outside the repo (an untracked
// file in the worktree would join the plan change set). The fixture ignores only node_modules/,
// so the worktree ignores reports/ too, committed on the branch before any gate runs.
async function fullSuiteShip(suite?: (dir: string) => string) {
  const seed = await shippableRepo()
  appendFileSync(join(seed.wt, '.gitignore'), 'reports/\n')
  execFileSync('git', ['commit', '-am', 'ignore reports'], { cwd: seed.wt })
  const dir = mkdtempSync(join(tmpdir(), 'witness-runs-'))
  const counter = join(dir, 'count.cjs')
  writeFileSync(counter, `require('fs').appendFileSync(${JSON.stringify(join(dir, 'runs'))}, 'x')`)
  const suiteCmd = suite?.(dir) ?? `node "${counter}" && node "${vitestBin()}" run --reporter=junit --outputFile=reports/junit.xml`
  patchConfig(seed.repo, {
    criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' },
    ship: { test: suiteCmd, lint: 'true' },
  })
  seed.repo.git('add', 'witness.config.yaml'); seed.repo.git('commit', '-m', 'full-suite')
  trustConfig(seed.repo)
  const count = () => (existsSync(join(dir, 'runs')) ? readFileSync(join(dir, 'runs'), 'utf8').length : 0)
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario) })
  return { ...seed, count, scenario, ctx, suiteCmd }
}

describe('the ship suite (rows 251, 252)', () => {
  it('runs once, and the criteria lane reads that run', async () => {
    const { repo, planId, count, ctx } = await fullSuiteShip()
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    const before = count()
    await runGate(ctx, 'ship', planId, { fresh: false, manual: false })
    expect(count() - before).toBe(1)
    const ship = lastShipRun(repo, planId)
    expect(check(ship, 'tests').ok).toBe(true)
    expect(check(ship, 'drift-lane').ok).toBe(true)
  }, 240_000)

  it("journals that run's junit summary on the tree the gate reviewed", async () => {
    const { repo, planId, ctx } = await fullSuiteShip()
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await runGate(ctx, 'ship', planId, { fresh: false, manual: false })
    const ship = lastShipRun(repo, planId)
    expect(ship.reviewed_tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(ship.junit).toEqual({ passed: 3, failed: 0, skipped: 0,
      specs: { 'auth-refresh': { passed: 2, failed: 0, skipped: 0 } }, tree: ship.reviewed_tree })
  }, 240_000)

  it('a failing suite is a red tests check, and its summary counts the failures', async () => {
    const { repo, wt, planId, ctx } = await fullSuiteShip()
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    await runGate(ctx, 'ship', planId, { fresh: false, manual: false })
    const ship = lastShipRun(repo, planId)
    expect(check(ship, 'tests').ok).toBe(false)
    expect(ship.junit?.failed).toBe(2)
    expect(ship.junit?.specs['auth-refresh']).toEqual({ passed: 0, failed: 2, skipped: 0 })
  }, 240_000)

  it('an untrusted suite blocks the tests check as before and journals no summary', async () => {
    const { repo, planId, ctx, scenario, suiteCmd: cmd } = await fullSuiteShip()
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    rmSync(join(repo.root, '.witness/allow.json'))
    // no TTY and no automation grant: the trust prompt cannot be asked, so the command is blocked
    const blocked = fakeCtx(repo.root, { env: gateEnv(scenario, { WITNESS_TRUST_CMDS: '0' }) })
    await runGate(blocked, 'ship', planId, { fresh: false, manual: false })
    const ship = lastShipRun(repo, planId)
    expect(check(ship, 'tests')).toMatchObject({ ok: false, untrusted: [cmd], detail: `${cmd}: blocked` })
    // the criteria lane, handed no suite, asks trust again and names the same block, as before
    expect(check(ship, 'drift-lane')).toMatchObject({ ok: false, untrusted: [cmd], detail: 'ac-rotate:fail' })
    expect('junit' in ship).toBe(false)
  }, 240_000)

  // Review Focus 5 (slice 1 review M2). A suite a signal ended — exit 137 is how an OOM kill reads —
  // shows its output tail in the tests check, as 0.30's command lane did, and journals no summary.
  it('an interrupted suite keeps its output tail in the tests check, as before, and journals no summary', async () => {
    const { repo, planId, ctx } = await fullSuiteShip((dir) => {
      const killed = join(dir, 'killed.cjs')
      writeFileSync(killed, "process.stdout.write('FATAL ERROR: heap limit — killed tail\\n'); process.exit(137)")
      return `node "${killed}"`
    })
    await runGate(ctx, 'ship', planId, { fresh: false, manual: false })
    const ship = lastShipRun(repo, planId)
    expect(check(ship, 'tests').ok).toBe(false)
    expect(check(ship, 'tests').detail).toContain('FATAL ERROR: heap limit — killed tail')
    expect(check(ship, 'drift-lane').ok).toBe(false)
    expect('junit' in ship).toBe(false)
  }, 240_000)

  it('a filtered runner journals no summary', async () => {
    const { repo, planId } = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    await runGate(ctx, 'ship', planId, { fresh: false, manual: false })
    const ship = lastShipRun(repo, planId)
    expect(ship).toBeDefined()
    expect('junit' in ship).toBe(false)
  }, 180_000)

  it('junitSummary counts every case and each spec’s tagged ones, both tag forms', () => {
    const s = junitSummary([
      { name: 'a @spec:auth', classname: 'x', status: 'passed' },
      { name: 'b spec-auth', classname: 'x', status: 'failed' },
      { name: 'c @spec:billing', classname: 'x', status: 'skipped' },
      { name: 'd untagged', classname: 'x', status: 'passed' },
    ], ['billing', 'auth', 'unused'], 'abc123')
    expect(s).toEqual({ passed: 2, failed: 1, skipped: 1, tree: 'abc123',
      specs: { auth: { passed: 1, failed: 1, skipped: 0 }, billing: { passed: 0, failed: 0, skipped: 1 } } })
    expect(Object.keys(s.specs)).toEqual(['auth', 'billing'])
  })
})
