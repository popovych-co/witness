import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_TESTS, baseTestsKey } from '../src/base-tests.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { journalShard } from '../src/jobs.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { suiteKey } from '../src/runner.js'
import { codeTree } from '../src/snapshot.js'
import { droppedKey } from '../src/tests-effect.js'
import {
  SKIP_SECOND, TOKEN_TESTS_TAGGED, callFor, fullSuite, fullSuiteShip, offRed, unwrap, writeSpec, type TestRepo,
} from './helpers.js'

// Row 275 (§4 T3's tests half; C30–C33). The switch-offs check reads the round's suite run against the
// base's counts at implement and ship: a lost passing case is a judged red beside the token lines.

const c = (passed: number, failed = 0, skipped = 0) => ({ passed, failed, skipped })
const PLAIN = { fresh: false, manual: false }
// The base-tests result drive would have journaled for this plan's base, with the counts given.
function measuredBase(s: { repo: TestRepo; wt: string }, specs: Record<string, ReturnType<typeof c>>) {
  const cfg = unwrap(loadConfig(s.repo.root))
  const base = unwrap(diffBase(s.wt, cfg))
  const rc = fullSuite(s.repo.root)
  const total = Object.values(specs).reduce((a, x) => c(a.passed + x.passed, a.failed + x.failed, a.skipped + x.skipped), c(0))
  unwrap(journalShard(s.repo.root, { kind: BASE_TESTS, key: baseTestsKey(base, suiteKey(rc)), shard: 1, of: 1, outcome: 'done', ms: 1,
    result: { ...total, specs, commit: base, code: codeTree(s.repo.root, base)!, tree: s.repo.git('rev-parse', `${base}^{tree}`) } }))
  return { base, rc }
}
const runs = (repo: TestRepo, planId: string) =>
  readStream(repo.root, planId).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
const offsCheck = (repo: TestRepo, planId: string, gate: string) =>
  runs(repo, planId).filter((r) => r.gate === gate).at(-1)!.checks.find((x) => x.name === 'switch-offs')!
const BRACKET_SECOND = TOKEN_TESTS_TAGGED.replace("it('issues", "it['skip']('issues")
const TWO_MORE = "\nit('keeps the old token valid briefly @spec:auth-refresh', () => {\n  expect(1).toBe(1)\n})\n\n" +
  "it('rotates at most once per window @spec:auth-refresh', () => {\n  expect(2).toBe(2)\n})\n"

describe('the tests effect in the switch-offs check (row 275)', () => {
  it('`{ skip: true }` drops the passing count and is caught (§4 T3)', async () => {
    const s = await fullSuiteShip(); measuredBase(s, { 'auth-refresh': c(2) })
    writeFileSync(join(s.wt, 'tests/token.test.ts'), SKIP_SECOND)
    await runGate(s.ctx, 'implement', s.planId, PLAIN)
    const check = offsCheck(s.repo, s.planId, 'implement')
    expect(check.ok).toBe(false)
    expect(check.offs).toContainEqual({ kind: 'dropped', key: droppedKey('auth-refresh'), spec: 'auth-refresh', count: 1, base: c(2), plan: c(1, 0, 1) })
    expect(check.detail).toContain('tests: auth-refresh lost 1 (passed 2→1, skipped 0→1)')
    expect(check.tests_effect).toEqual({ read: 'compared', specs: 1 })
    expect(check).not.toHaveProperty('owes')
    await runGate(s.ctx, 'ship', s.planId, PLAIN)
    expect(offsCheck(s.repo, s.planId, 'ship').offs).toContainEqual(expect.objectContaining({ kind: 'dropped', spec: 'auth-refresh', count: 1 }))
  }, 300_000)

  it("bracket access the line scan misses is caught by the count (T3a's Open entry)", async () => {
    const s = await fullSuiteShip(); measuredBase(s, { 'auth-refresh': c(2) })
    writeFileSync(join(s.wt, 'tests/token.test.ts'), BRACKET_SECOND)
    await runGate(s.ctx, 'implement', s.planId, PLAIN)
    const check = offsCheck(s.repo, s.planId, 'implement')
    expect(check.ok).toBe(false)
    expect(check.offs).toEqual([{ kind: 'dropped', key: droppedKey('auth-refresh'), spec: 'auth-refresh', count: 1, base: c(2), plan: c(1, 0, 1) }])
  }, 240_000)

  it('a plan that adds a passing case and skips an old one is caught by its new skip (Review Focus 1)', async () => {
    const s = await fullSuiteShip(); measuredBase(s, { 'auth-refresh': c(2) })
    writeFileSync(join(s.wt, 'tests/token.test.ts'), SKIP_SECOND + TWO_MORE)
    await runGate(s.ctx, 'implement', s.planId, PLAIN)
    const check = offsCheck(s.repo, s.planId, 'implement')
    expect(check.ok).toBe(false)
    expect(check.offs!.filter((o) => o.kind === 'dropped')).toEqual([expect.objectContaining({ spec: 'auth-refresh', count: 1, plan: c(3, 0, 1) })])
  }, 240_000)

  it("the parent spec's removal is licensed — named, never red; another spec's loss is red", async () => {
    const s = await fullSuiteShip()
    expect((await writeSpec(s.repo, 'other-spec', { criteria: [{ id: 'ac-other', test: '@spec:other-spec' }] })).code).toBe(0)
    measuredBase(s, { 'auth-refresh': c(3), 'other-spec': c(1) })
    await runGate(s.ctx, 'implement', s.planId, PLAIN)
    const check = offsCheck(s.repo, s.planId, 'implement')
    expect(check.ok).toBe(false)
    expect(check.offs).toEqual([expect.objectContaining({ kind: 'dropped', spec: 'other-spec', count: 1 })])
    expect(check.detail).toContain('tests: auth-refresh lost 1 — licensed: its spec was amended since its last plan')
    expect(check.detail).toContain('tests: other-spec lost 1 (passed 1→0, skipped 0→0)')
  }, 240_000)

  it('with no base measured the check reads not checked, stays green, and owes the base suite', async () => {
    const s = await fullSuiteShip()
    await runGate(s.ctx, 'implement', s.planId, PLAIN)
    const check = offsCheck(s.repo, s.planId, 'implement')
    const cfg = unwrap(loadConfig(s.repo.root))
    expect(check).toMatchObject({ ok: true,
      tests_effect: { read: 'not-checked', why: 'the base suite is not measured — no drive runs jobs in this repo' },
      owes: [{ kind: 'base-tests', key: baseTestsKey(unwrap(diffBase(s.wt, cfg)), suiteKey(fullSuite(s.repo.root))) }] })
    expect(check.detail).toContain('tests not checked — the base suite is not measured')
    expect(check).not.toHaveProperty('offs')
  }, 240_000)

  it('a filtered runner never compares', async () => {
    const b = await offRed()
    await b.gate('implement')
    const check = b.offsCheck()!
    expect(check.tests_effect).toEqual({ read: 'not-checked', why: 'the runner is filtered — the tests effect reads a full-suite junit report' })
    expect(check).not.toHaveProperty('owes')
    expect(check.offs).toEqual([expect.not.objectContaining({ kind: 'dropped' })])
  }, 240_000)

  it('the reviewers are told each loss, and each licensed one', async () => {
    const s = await fullSuiteShip(); measuredBase(s, { 'auth-refresh': c(2) })
    writeFileSync(join(s.wt, 'tests/token.test.ts'), SKIP_SECOND)
    await runGate(s.ctx, 'implement', s.planId, PLAIN)
    const asked = readFileSync(join(callFor(s.scenario, 'code-reviewer')!, 'stdin'), 'utf8')
    expect(asked).toContain('### Switch-offs this plan adds')
    expect(asked).toContain('- tests of auth-refresh — 2 passing on the base, 1 here; skipped 0 → 1')
    const l = await fullSuiteShip(); measuredBase(l, { 'auth-refresh': c(3) })
    await runGate(l.ctx, 'implement', l.planId, PLAIN)
    const told = readFileSync(join(callFor(l.scenario, 'code-reviewer')!, 'stdin'), 'utf8')
    expect(told).toContain('- tests of auth-refresh — 1 passing case gone: licensed — its spec was amended since its last plan')
  }, 300_000)

  it('ship journals the base counts it compared against', async () => {
    const s = await fullSuiteShip(); measuredBase(s, { 'auth-refresh': c(2) })
    await runGate(s.ctx, 'implement', s.planId, PLAIN)
    await runGate(s.ctx, 'ship', s.planId, PLAIN)
    const ship = runs(s.repo, s.planId).filter((r) => r.gate === 'ship').at(-1)!
    expect(ship.junit?.base).toEqual({ 'auth-refresh': { passed: 2, skipped: 0 } })
  }, 300_000)
})
