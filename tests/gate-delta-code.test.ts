import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { callFor, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo } from './helpers.js'

const F = { fresh: false, manual: false }
const of = (root: string, id: string, gate: string) =>
  readStream(root, id).filter((e) => e.t === 'gate-run' && e.gate === gate) as unknown as GateRunEntry[]
const all = (r: GateRunEntry) => (r.verdicts ?? []).flatMap((v) => v.findings)

// round 1: every lens blocks at src/token.ts#nextToken · src/token.ts is edited · round 2: every lens blocks at `second`
async function implementTwice(second: string, beforeRound2: (scenario: string) => void = () => {}) {
  const { repo, wt, planId } = await shippableRepo()
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
})
