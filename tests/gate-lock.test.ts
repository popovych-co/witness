import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { approve, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec } from './helpers.js'

function lockProbes(scenario: string): string[] {
  return readdirSync(join(scenario, 'claude-calls'))
    .filter((d) => d.startsWith('call-'))
    .map((d) => readFileSync(join(scenario, 'claude-calls', d, 'lock'), 'utf8').trim())
}

describe('gate lock window', () => {
  it('does not hold the global lock while reviewers run', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')

    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
    const res = await repo.cli(['gate', 'decompose', 'auth-hardening'], { env: gateEnv(scenario) })

    expect(res.code).not.toBe(3)
    // EXACT count, not > 0: five paths reach the gate and invoke zero reviewers —
    // resume (gate.ts:166), changed-nothing (170), boundReached (176), the
    // malformed-streak refusal (189), and cached (210-213, holds the lock but skips
    // the lens loop). `> 0` passes vacuously on all five. decompose runs exactly one
    // lens, slicing-critic (gate.ts:61-71).
    expect(lockProbes(scenario)).toEqual(['free'])
  })
})
