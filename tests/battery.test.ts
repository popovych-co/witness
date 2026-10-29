import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import type { GateRunEntry } from '../src/rounds.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { loadConfig } from '../src/config.js'
import { callCount, callFor, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, type TestRepo, patchConfig } from './helpers.js'

// Row 169: the battery launches every lens at once, and the journal must not be able to tell.
// A feature plan on a non-ui spec: the battery is code-reviewer · silent-failure-hunter ·
// type-design · pr-test (design-reviewer drops with its cause).

function treeClean(files: string[]) {
  return {
    coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })),
    findings: [] as unknown[],
  }
}
const gateRuns = (repo: TestRepo, id: string) =>
  readStream(repo.root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
const lastRun = (repo: TestRepo, id: string) => gateRuns(repo, id).at(-1)!

async function batteryRepo() {
  const { repo, wt, planId } = await shippableRepo()
  const cfg = loadConfig(repo.root)
  const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
  const files = changedFiles(wt, base.ok ? base.value : '')
  const scenario = fakeScenario()
  putVerdict(scenario, treeClean(files))
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  const BLOCKING_AT = (file: string) => ({
    coverage: treeClean(files).coverage, findings: [{ blocking: true, anchor: file, claim: 'x' }],
  })
  return { repo, planId, files, scenario, ctx, BLOCKING_AT }
}

describe('the battery runs its lenses at once', () => {
  it('launches every lens at once', async () => {
    const { repo, planId, scenario, ctx } = await batteryRepo()
    writeFileSync(join(scenario, 'claude-barrier'), '4')
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(0)
    expect(lastRun(repo, planId).verdicts!.map((v) => v.reviewer))
      .toEqual(['code-reviewer', 'silent-failure-hunter', 'type-design', 'pr-test'])
  }, 30_000)

  it('keeps battery order when the first lens answers last', async () => {
    const { repo, planId, files, scenario, ctx, BLOCKING_AT } = await batteryRepo()
    writeFileSync(join(scenario, 'claude-delay-code-reviewer'), '1')
    putVerdict(scenario, BLOCKING_AT(files[0]!), 'code-reviewer')
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(1)
    const run = lastRun(repo, planId)
    expect(run.verdicts![0]!.reviewer).toBe('code-reviewer')
    expect(run.verdicts![0]!.findings[0]!.blocking).toBe(true)
    expect(run.verdicts!.slice(1).every((v) => v.findings.length === 0)).toBe(true)
  })

  it('one lens failing on the pin makes a fallback round', async () => {
    const { repo, planId, scenario, ctx } = await batteryRepo()
    // two-rung chain · code-reviewer fails on the pin only
    patchConfig(repo, { gates: { implement: { model: 'test-model-1' } } })
    writeFileSync(join(repo.root, '.witness/calibration.local.yaml'), 'models:\n  - test-model-2\n')
    writeFileSync(join(scenario, 'claude-fail-code-reviewer'), 'test-model-1')
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(1)
    const run = lastRun(repo, planId)
    expect(run.model).toBe('test-model-2'); expect(run.pin).toBe('test-model-1')
    expect(run.fallback).toEqual(['test-model-1'])
    expect(run.standing).toContain('fallback — reviewers ran on test-model-2')
    expect(run.verdicts).toHaveLength(4)
  })

  it('one lens exhausting the chain refuses the gate and journals nothing', async () => {
    const { repo, planId, scenario } = await batteryRepo()
    writeFileSync(join(scenario, 'claude-fail-type-design'), '')   // fails on every rung
    const errs: string[] = []
    const c = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => errs.push(l) })
    expect(await runGate(c, 'implement', planId, { fresh: false, manual: false })).toBe(2)
    expect(gateRuns(repo, planId)).toHaveLength(0)
    expect(errs.join('\n')).toContain('reviewer-invocation')
    expect(callCount(scenario)).toBeGreaterThanOrEqual(4)          // the other lenses still ran
  })
})

describe('a re-gate after a malformed round (row 209)', () => {
  const F = { fresh: false, manual: false }
  it('re-asks only the lens that failed and carries the rest, in battery order', async () => {
    const { repo, planId, files, scenario, ctx } = await batteryRepo()
    putVerdict(scenario, { coverage: [], findings: [] }, 'pr-test')        // under the floor on both attempts
    expect(await runGate(ctx, 'implement', planId, F)).toBe(1)
    const r1 = lastRun(repo, planId)
    expect(r1.outcome).toBe('malformed')
    putVerdict(scenario, treeClean(files), 'pr-test')
    const before = callCount(scenario)
    const out: string[] = []
    expect(await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => out.push(l) }), 'implement', planId, F)).toBe(0)
    const r2 = lastRun(repo, planId)
    expect(callCount(scenario) - before).toBe(1)
    expect(callFor(scenario, 'pr-test')).toMatch(new RegExp(`call-${before + 1}$`))
    expect(r2.carried).toEqual({ run: r1.run_id, lenses: ['code-reviewer', 'silent-failure-hunter', 'type-design'] })
    expect(r2.verdicts!.map((v) => v.reviewer)).toEqual(['code-reviewer', 'silent-failure-hunter', 'type-design', 'pr-test'])
    expect([r2.round, r2.outcome]).toEqual([r1.round, 'passed'])
    expect(out.join('\n')).toContain(`carried: code-reviewer · silent-failure-hunter · type-design — answered in run ${r1.run_id} on this content and prompts`)
  })
  it('a repair malformed again trips malformed-streak on the next run, without --fresh', async () => {
    const { repo, planId, scenario, ctx } = await batteryRepo()
    putVerdict(scenario, { coverage: [], findings: [] }, 'pr-test')
    await runGate(ctx, 'implement', planId, F)
    await runGate(ctx, 'implement', planId, F)
    expect(gateRuns(repo, planId).map((r) => r.outcome)).toEqual(['malformed', 'malformed'])
    const errs: string[] = []
    expect(await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => errs.push(l) }), 'implement', planId, F)).toBe(2)
    expect(errs.join('\n')).toContain('malformed-streak')
  })
  // Review Focus 5
  it('a repair whose re-asked lens falls back is a fallback round, and keeps what it carried', async () => {
    const { repo, planId, files, scenario, ctx } = await batteryRepo()
    patchConfig(repo, { gates: { implement: { model: 'test-model-1' } } })
    putVerdict(scenario, { coverage: [], findings: [] }, 'pr-test')
    expect(await runGate(ctx, 'implement', planId, F)).toBe(1)
    const r1 = lastRun(repo, planId)
    putVerdict(scenario, treeClean(files), 'pr-test')
    writeFileSync(join(scenario, 'claude-fail-pr-test'), 'test-model-1')    // the pin stops answering pr-test
    expect(await runGate(ctx, 'implement', planId, F)).toBe(1)
    const r2 = lastRun(repo, planId)
    expect(r2.carried).toEqual({ run: r1.run_id, lenses: ['code-reviewer', 'silent-failure-hunter', 'type-design'] })
    expect([r2.model, r2.pin, r2.fallback]).toEqual(['session-default', 'test-model-1', ['test-model-1']])
    expect(r2.standing).toContain('fallback — reviewers ran on session-default')
  })
})
