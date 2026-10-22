import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import {
  TOKEN_BROKEN, TOKEN_FIXED, TOKEN_TESTS_TAGGED, TOKEN_TESTS_UNTAGGED, commitEntry, evidenceCycle, fixtureEnv, measuredEnv,
  startedThreeStepPlan, untaggedRed, type CliResult,
} from './helpers.js'

const at = (tokens: number) => measuredEnv('S1', tokens, 1_000_000)
const lines = (r: CliResult) => r.stdout.split('\n')
// The report closes the verb's output, in the order the spec shows it (§4.6).
const report = (r: CliResult) => lines(r).slice(-3)

// `verify-red --step s1` at 170k on a branch whose base commit holds the untagged suite and
// `baseToken`, and whose next commit adds the tagged tests and the fixed implementation.
async function verifyRed(baseToken: string): Promise<CliResult> {
  const { repo, wt, planId } = await startedThreeStepPlan()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, encoding: 'utf8' }).trim()
  writeFileSync(join(wt, 'src/token.ts'), baseToken)
  writeFileSync(join(wt, 'tests/token.test.ts'), TOKEN_TESTS_UNTAGGED)
  git('add', '-A'); git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
  writeFileSync(join(wt, 'tests/token.test.ts'), TOKEN_TESTS_TAGGED)
  git('add', '-A'); git('commit', '-m', 'tagged tests')
  return repo.cli(['verify-red', planId, '--base', base, '--step', 's1'], { cwd: wt, env: { ...fixtureEnv(), ...at(170_000) } })
}

// Row 191 §4.4–§4.7. A step close is where the CLI decides whether the slice ends: the journal
// already carries the position, so a fresh session continues with nothing lost.
describe('the rule at a step close', () => {
  it('a green that closes a step prints context, steps and slice', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    const r = await evidenceCycle(repo, wt, planId, 's1', at(170_000))
    expect(r.code).toBe(0)
    expect(report(r)).toEqual(['context: 17% of 1M · limit 20%', 'steps: 1/3 done · next s2', 'slice: continue'])
  })

  it('the slice ends when the fill reached the limit', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    const r = await evidenceCycle(repo, wt, planId, 's1', at(210_000))
    expect(r.code).toBe(0)
    expect(lines(r)).toContain('slice: end — 21% reached the 20% limit')
  })

  it("the projection uses this session's growth", async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    await evidenceCycle(repo, wt, planId, 's1', at(100_000))
    const r = await evidenceCycle(repo, wt, planId, 's2', at(150_000))
    expect(r.code).toBe(0)
    expect(report(r)).toEqual([
      'context: 15% of 1M · limit 20% · next step ≈ +5%',
      'steps: 2/3 done · next s3',
      'slice: end — 15% + next step ≈ 20% passes the 20% limit',
    ])
  })

  // Rule 1: with no step left the session goes to the gate. A re-run close journals nothing
  // (Plan's call 6), so it decides nothing either.
  it('the last close says gate', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    await evidenceCycle(repo, wt, planId, 's1', at(100_000))
    await evidenceCycle(repo, wt, planId, 's2', at(100_000))
    const r = await repo.cli(['step-close', planId, '--step', 's3'], { cwd: wt, env: at(100_000) })
    expect(r.code).toBe(0)
    expect(report(r)).toEqual(['context: 10% of 1M · limit 20%', 'steps: 3/3 done', 'slice: gate — no steps remain'])
    const again = await repo.cli(['step-close', planId, '--step', 's3'], { cwd: wt, env: at(100_000) })
    expect(again.stdout).toBe(`step-close: ${planId} · s3 already closed`)
  })

  // The close is journaled before the report runs, so a config that will not load costs the
  // report and never the verb's exit.
  it('a config that will not load costs the report, not the close', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}session:\n  contextLimit: 0\n`)
    const r = await repo.cli(['step-close', planId, '--step', 's3'], { cwd: wt, env: at(250_000) })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`step-close: ${planId} · s3 closed`)
    expect(readStream(repo.root, planId).filter((e) => e.t === 'step-close')).toHaveLength(1)
  })

  // §4.4: a green that closes no step never ends a slice; a failing one reports nothing.
  it('a re-recorded green prints context alone', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    await evidenceCycle(repo, wt, planId, 's1', at(100_000))
    const green = () => repo.cli(['test-evidence', planId, '--phase', 'green', '--step', 's1'], { cwd: wt, env: { ...fixtureEnv(), ...at(120_000) } })
    const again = await green()
    expect(again.code).toBe(0)
    expect(lines(again)).toContain('context: 12% of 1M · limit 20%')
    expect(again.stdout).not.toContain('steps:')
    expect(again.stdout).not.toContain('slice:')
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    const failing = await green()
    expect(failing.code).toBe(1)
    expect(failing.stdout).not.toContain('context:')
  })

  // §4.7. s3 stays unfinished, so rule 1 does not fire.
  it('unmeasured counts steps per session against the budget', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan('implement:\n  stepsPerDispatch: 2\n')
    const s9 = { CLAUDE_CODE_SESSION_ID: 'S9' }
    const first = await evidenceCycle(repo, wt, planId, 's1', s9)
    expect(report(first)).toEqual(['context: unmeasured (no adapter) — step budget 2', 'steps: 1/3 done · next s2', 'slice: continue'])
    const second = await evidenceCycle(repo, wt, planId, 's2', s9)
    expect(lines(second)).toContain('slice: end — 2 step(s) closed this session · step budget 2 (context unmeasured)')
  })

  it('no session at all means own count', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    const r = await evidenceCycle(repo, wt, planId, 's1')
    expect(r.code).toBe(0)
    expect(report(r)).toEqual([
      'context: unmeasured (no adapter) — step budget 3',
      'steps: 1/3 done · next s2',
      "slice: own count — the CLI cannot count this session's steps · end after 3 step(s) by your own count",
    ])
  })

  // A reconstructed cycle closes a step as a witnessed one does: one report, after its green.
  it('verify-red reports once, after its green', async () => {
    const r = await verifyRed(TOKEN_BROKEN)
    expect(r.code).toBe(0)
    expect(lines(r).filter((l) => l.startsWith('context:'))).toHaveLength(1)
    expect(report(r)).toEqual(['context: 17% of 1M · limit 20%', 'steps: 1/3 done · next s2', 'slice: continue'])
  })

  // The behavior is already in the base, so the reconstructed red passes: a finding, not a cycle.
  it('a vacuous verify-red reports nothing', async () => {
    const r = await verifyRed(TOKEN_FIXED)
    expect(r.code).toBe(1)
    expect(r.stdout).not.toContain('context:')
  })

  // §4.3: a legacy plan's steps are not the CLI's to see, so until its implement gate every
  // passing green decides. After the gate an untagged green is a fix round.
  it('a legacy plan decides at each passing green until its implement gate', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    commitEntry(repo, planId, untaggedRed(planId))
    const green = () => repo.cli(['test-evidence', planId, '--phase', 'green'], { cwd: wt, env: { ...fixtureEnv(), ...at(250_000) } })
    const before = await green()
    expect(before.code).toBe(0)
    expect(report(before)).toEqual([
      'context: 25% of 1M · limit 20%',
      'steps: unknown (evidence predates step tags)',
      'slice: end — 25% reached the 20% limit',
    ])
    commitEntry(repo, planId, {
      t: 'gate-run', gate: 'implement', artifact: planId, round: 1, run_id: 'r-1', reviewed_sha: 'sha-before',
      prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'passed',
    })
    const after = await green()
    expect(after.code).toBe(0)
    expect(lines(after)).toContain('context: 25% of 1M · limit 20%')
    expect(after.stdout).not.toContain('slice:')
  })
})
