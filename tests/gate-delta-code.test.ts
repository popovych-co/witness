import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { callCount, callFor, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo } from './helpers.js'

const F = { fresh: false, manual: false }
const of = (root: string, id: string, gate: string) =>
  readStream(root, id).filter((e) => e.t === 'gate-run' && e.gate === gate) as unknown as GateRunEntry[]
const all = (r: GateRunEntry) => (r.verdicts ?? []).flatMap((v) => v.findings)

// round 1: every lens blocks at src/token.ts#nextToken · src/token.ts is edited · round 2: every lens blocks at `second`
// `dirty`: an uncommitted edit before round 1, so round 1's tree is reachable from no commit and gc can prune it
async function implementTwice(second: string, beforeRound2: (scenario: string) => void = () => {}, opts: { dirty?: boolean } = {}) {
  const { repo, wt, planId } = await shippableRepo()
  if (opts.dirty) appendFileSync(join(wt, 'src/token.ts'), '// round 1 is uncommitted\n')
  const cfg = loadConfig(repo.root)
  const files = () => { const b = diffBase(wt, cfg.ok ? cfg.value : (undefined as never)); return changedFiles(wt, b.ok ? b.value : '') }
  const at = (anchor: string) => ({ coverage: files().slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [{ blocking: true, anchor, claim: 'x' }] })
  const scenario = fakeScenario()
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  putVerdict(scenario, at('src/token.ts#nextToken'))
  expect(await runGate(ctx, 'implement', planId, F)).toBe(1)
  appendFileSync(join(wt, 'src/token.ts'), '// rotation is covered by tests\n')
  putVerdict(scenario, at(second)); beforeRound2(scenario)
  const code = await runGate(ctx, 'implement', planId, F)
  return { repo, planId, scenario, ctx, at, code }
}

describe('delta review at the code gates (C3)', () => {
  // Review Focus 2
  it('implement demotes a new finding in an untouched file, and ship round 1 re-judges it in full', async () => {
    const { repo, planId, scenario, ctx, at, code } = await implementTwice('tests/token.test.ts')
    expect(code).toBe(0)
    const [r1, r2] = of(repo.root, planId, 'implement')
    expect(r2!.delta).toEqual({ round: 1, run: r1!.run_id })
    expect(all(r2!).every((f) => f.blocking === false && f.demoted === 1)).toBe(true)
    putVerdict(scenario, at('tests/token.test.ts'))
    expect(await runGate(ctx, 'ship', planId, F)).toBe(1)
    const [ship] = of(repo.root, planId, 'ship')
    expect(ship!.delta).toBeUndefined()
    expect(all(ship!).every((f) => f.blocking === true && f.demoted === undefined)).toBe(true)
    // decision 16: ship's lenses are named the demotions they must re-judge — anchor, lens and round
    const shipPrompt = readFileSync(join(callFor(scenario, 'code-reviewer')!, 'stdin'), 'utf8')
    expect(shipPrompt).toContain('## Demoted at implement')
    expect(shipPrompt).toContain('1. tests/token.test.ts — x — code-reviewer · implement round 2')
    expect(shipPrompt).toContain('pr-test · implement round 2')
  }, 120_000)

  it('a finding anchored in canon is context and never demoted', async () => {
    const { repo, planId, code } = await implementTwice('plans/auth-refresh-plan-1.md')
    expect(code).toBe(1)
    expect(all(of(repo.root, planId, 'implement')[1]!).every((f) => f.blocking)).toBe(true)
  }, 120_000)

  it('a malformed round demotes nothing', async () => {
    // pr-test answers under the coverage floor on both attempts, so round 2 is malformed
    const { repo, planId } = await implementTwice('tests/token.test.ts',
      (s) => putVerdict(s, { coverage: [], findings: [] }, 'pr-test'))
    const r2 = of(repo.root, planId, 'implement')[1]!
    expect(r2.outcome).toBe('malformed')
    expect(all(r2).length).toBeGreaterThan(0)
    expect(all(r2).every((f) => f.blocking === true && f.demoted === undefined)).toBe(true)
  }, 120_000)

  it('a delta lens covering every file the change touched passes the floor (issue #60)', async () => {
    const { repo, planId, code } = await implementTwice('src/token.ts',
      (s) => putVerdict(s, { coverage: [{ anchor: 'src/token.ts', note: 'read the change' }], findings: [] }))
    const r2 = of(repo.root, planId, 'implement')[1]!
    expect([r2.delta?.round, r2.outcome, code]).toEqual([1, 'passed', 0])
  }, 120_000)

  it('a delta lens covering only files the change left alone is malformed, and told which count', async () => {
    const { repo, planId } = await implementTwice('src/token.ts', (s) => putVerdict(s, {
      coverage: ['.gitignore', 'package.json', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' })), findings: [] }))
    const r2 = of(repo.root, planId, 'implement')[1]!
    expect(r2.outcome).toBe('malformed')
    expect(r2.malformed![0]!.violations[0]).toMatchObject({ rule: 'coverage-minimum',
      got: '0 distinct files the change touched covered',
      want: '≥ 1 coverage anchors naming distinct files listed under "Files changed since round 1"' })
  }, 120_000)

  it('the delta prompt lists the files the change touched and states the floor', async () => {
    const { scenario } = await implementTwice('src/token.ts')
    expect(readFileSync(join(callFor(scenario, 'code-reviewer')!, 'stdin'), 'utf8')).toContain(
      '### Files changed since round 1\n\n- src/token.ts\n\nCover at least 1 of these files, each with its own coverage anchor.\n\n')
  }, 120_000)

  // Review Focus 4
  it('a repair whose delta base gc pruned asks every lens again and carries nothing', async () => {
    const { repo, planId, scenario, ctx, at } = await implementTwice('tests/token.test.ts',
      (s) => putVerdict(s, { coverage: [], findings: [] }, 'pr-test'), { dirty: true })
    expect(of(repo.root, planId, 'implement')[1]!).toMatchObject({ outcome: 'malformed', delta: { round: 1 } })
    repo.git('gc', '-q', '--prune=now')
    putVerdict(scenario, at('tests/token.test.ts'), 'pr-test')
    const before = callCount(scenario)
    await runGate(ctx, 'implement', planId, F)
    const r3 = of(repo.root, planId, 'implement')[2]!
    expect(callCount(scenario) - before).toBe(4)
    expect([r3.carried, r3.delta]).toEqual([undefined, undefined])
  }, 120_000)

  // Review Focus 3
  it('a file the revise deleted is in the floor and anchors by bare path', async () => {
    const { repo, wt, planId } = await shippableRepo()
    writeFileSync(join(wt, 'src/extra.ts'), 'export const extra = 1\n')
    const cfg = loadConfig(repo.root)
    const b = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    const files = changedFiles(wt, b.ok ? b.value : '')
    const scenario = fakeScenario()
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    putVerdict(scenario, { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })),
      findings: [{ blocking: true, anchor: 'src/extra.ts', claim: 'x' }] })
    expect(await runGate(ctx, 'implement', planId, F)).toBe(1)
    rmSync(join(wt, 'src/extra.ts'))
    putVerdict(scenario, { coverage: [{ anchor: 'src/extra.ts', note: 'the revise removed it' }], findings: [] })
    expect(await runGate(ctx, 'implement', planId, F)).toBe(0)
    const r2 = of(repo.root, planId, 'implement')[1]!
    expect([r2.delta?.round, r2.outcome]).toEqual([1, 'passed'])
  }, 120_000)
})
