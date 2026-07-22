import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEntry, policyPins, readStream, type Entry } from '../src/journal.js'
import { parseVerdict } from '../src/verdict.js'
import { pinsBlock, promptsSha, type Lens } from '../src/reviewer.js'
import { registerGate, type GateInput } from '../src/gate.js'
import { canonicalSha } from '../src/sha.js'
import { findById } from '../src/scan.js'
import { ok } from '../src/refusal.js'
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec, type TestRepo } from './helpers.js'

describe('policyPins', () => {
  it('extracts ordinal+text from policy-pin entries in stream order', () => {
    const entries = [
      { v: 1, t: 'recap' },
      { v: 1, t: 'policy-pin', artifact: 'p1', gate: 'implement', round: 2, ordinal: 1, text: 'unavailable /book renders the service in full' },
      { v: 1, t: 'gate-run' },
      { v: 1, t: 'policy-pin', artifact: 'p1', gate: 'implement', round: 3, ordinal: 2, text: 'price format is $total · $rate/hr' },
    ] as unknown as Entry[]
    expect(policyPins(entries)).toEqual([
      { ordinal: 1, text: 'unavailable /book renders the service in full' },
      { ordinal: 2, text: 'price format is $total · $rate/hr' },
    ])
  })

  it('returns [] on a pin-free stream', () => {
    expect(policyPins([{ v: 1, t: 'recap' } as unknown as Entry])).toEqual([])
  })
})

describe('contradicts_pin verdict field', () => {
  const base = { coverage: [{ anchor: 'src/a.ts', note: 'read' }] }
  it('accepts an integer ordinal and preserves it', () => {
    const r = parseVerdict({ ...base, findings: [{ blocking: false, anchor: 'src/a.ts', claim: 'x', contradicts_pin: 2 }] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.findings[0]!.contradicts_pin).toBe(2)
  })
  it('refuses a non-integer contradicts_pin', () => {
    const r = parseVerdict({ ...base, findings: [{ blocking: false, anchor: 'src/a.ts', claim: 'x', contradicts_pin: 'two' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations.some((x) => x.rule === 'contradicts-pin-shape')).toBe(true)
  })
})

describe('pinsBlock + cache key', () => {
  const lens: Lens = { name: 'code-reviewer', contents: 'judge.' }
  it('empty pins → empty block and an unchanged prompts_sha', () => {
    expect(pinsBlock([])).toBe('')
    expect(promptsSha([lens], undefined)).toBe(promptsSha([lens]))
  })
  it('pins join the cache key', () => {
    const block = pinsBlock([{ ordinal: 1, text: 'render the service in full' }])
    expect(block).toContain('1. render the service in full')
    expect(block).toContain('contradicts_pin')
    expect(promptsSha([lens], block)).not.toBe(promptsSha([lens]))
  })
})

const PLAN_ID = 'auth-refresh-plan-1'
const CLEAN = { coverage: [{ anchor: PLAN_ID, note: 'read' }], findings: [] }

// Synthetic implement gate over the plan doc — chore class keeps the battery at one
// code-reviewer call per round. Registered AFTER the fixture's decide call: repo.cli
// dynamically imports gates/index.js, which would clobber this with the real gate
// (same hazard decide.test.ts documents).
function syntheticImplement() {
  registerGate({
    gate: 'implement',
    targetKind: 'plan',
    async resolve(_root, _ctx, canon, _cfg, target) {
      const doc = findById(canon, target)!
      return ok<GateInput>({
        class: 'chore',
        reviewedSha: canonicalSha(doc.meta, doc.body),
        reviewed: { kind: 'docs', docs: [{ id: target, body: doc.body }] },
        promptBody: doc.body,
        checks: [{ name: 'synthetic', ok: true }],
        stamps: [],
      })
    },
  })
}

// A plan with one pin journaled the real way: stopped round 1 → decide --revise --pin.
async function pinnedRepo(): Promise<{ repo: TestRepo; scenario: string }> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, PLAN_ID)
  appendEntry(repo.root, PLAN_ID, {
    v: 1, t: 'gate-run', gate: 'implement', artifact: PLAN_ID, round: 1,
    run_id: 'r-1', reviewed_sha: 'sha-1', prompts_sha: 'p', specflow: '0',
    model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'stopped',
  })
  const d = await repo.cli(['decide', 'implement', PLAN_ID, '--revise', '--note', 'fix',
    '--pin', 'render the service in full'])
  if (d.code !== 0) throw new Error(`decide --pin failed: ${d.stdout}\n${d.stderr}`)
  syntheticImplement()
  return { repo, scenario: fakeScenario() }
}

const runs = (repo: TestRepo) =>
  readStream(repo.root, PLAN_ID).filter((e) => e.t === 'gate-run')

describe('runGate with pins', () => {
  it('injects the pins block into every reviewer prompt', async () => {
    const { repo, scenario } = await pinnedRepo()
    putVerdict(scenario, CLEAN)
    const r = await repo.cli(['gate', 'implement', PLAN_ID], { env: gateEnv(scenario) })
    expect(r.code).toBe(0)
    const stdin = readFileSync(join(scenario, 'claude-calls/call-1/stdin'), 'utf8')
    expect(stdin).toContain('## Settled policy pins')
    expect(stdin).toContain('1. render the service in full')
  })

  it('a non-blocking finding with contradicts_pin stops the gate as a standing stop', async () => {
    const { repo, scenario } = await pinnedRepo()
    putVerdict(scenario, {
      coverage: CLEAN.coverage,
      findings: [{ blocking: false, anchor: PLAN_ID, claim: 'field must go', contradicts_pin: 1 }],
    })
    const r = await repo.cli(['gate', 'implement', PLAN_ID], { env: gateEnv(scenario) })
    expect(r.code).toBe(1)                       // EXIT.FINDINGS — stopped, not passed
    expect(r.stdout).toContain('standing-stop: contradicts-pin')
    expect(r.stdout).toContain('outcome: stopped')
  })

  it('adding a pin re-arms an already-settled verdict (cache key moved)', async () => {
    const { repo, scenario } = await pinnedRepo()
    putVerdict(scenario, CLEAN)
    // --manual stops the round, leaving the pending decision the second pin rides on
    const first = await repo.cli(['gate', 'implement', PLAN_ID, '--manual'], { env: gateEnv(scenario) })
    expect(first.code).toBe(1)
    const d = await repo.cli(['decide', 'implement', PLAN_ID, '--revise', '--note', 'more',
      '--pin', 'price format is one line'])
    expect(d.code).toBe(0)
    // identical reviewed content — without the new pin this would be changed-nothing
    const r = await repo.cli(['gate', 'implement', PLAN_ID], { env: gateEnv(scenario) })
    expect(r.stdout).not.toContain('cached')     // live re-roll, not a cache resume
    expect(r.stdout).not.toContain('changed nothing')
    expect(runs(repo)).toHaveLength(3)           // synthetic r1 + manual r2 + live r3
    const stdin = readFileSync(join(scenario, 'claude-calls/call-2/stdin'), 'utf8')
    expect(stdin).toContain('2. price format is one line')
  })
})
