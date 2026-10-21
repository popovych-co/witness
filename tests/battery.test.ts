import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import type { GateRunEntry } from '../src/rounds.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { loadConfig } from '../src/config.js'
import { callCount, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, type TestRepo } from './helpers.js'

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
    appendFileSync(join(repo.root, 'witness.config.yaml'), 'gates:\n  model: test-model-1\n')
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
