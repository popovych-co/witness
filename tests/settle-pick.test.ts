import { expect, it, vi } from 'vitest'
import { EXIT } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { gateSpec } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import { loadCanon } from '../src/scan.js'
import { settleStop } from '../src/settle.js'
import { commitEntry, fakeCtx, fixtureEnv, plannedRepo, type TestRepo } from './helpers.js'

// Row 239 (the final review, Task 5's minor 1). A `pick` answers a choose block, whose options name
// specs, not commands: no gate stop yields one today, so the policy is stood in for here. Should one
// reach settle, it is no decision the CLI can take at a gate, and it fails closed — the stop is left
// for a human, never handed on to the arbiter, which would spend a model call to judge a stop the
// policy already claimed to have answered.
vi.mock('../src/autonomy.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/autonomy.js')>()
  return { ...real, policyFor: () => ({ kind: 'pick', id: 'auth-refresh' }) }
})
// The arbiter is never reached; were it, this answers at once rather than launching a model.
const arbiter = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../src/arbiter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/arbiter.js')>()
  return {
    ...real,
    arbitrate: async () => {
      arbiter.calls++
      return { ok: false, violations: [{ field: 'arbiter', rule: 'arbiter-stand-in', got: 'called', want: 'never called' }] }
    },
  }
})

const PLAN = 'auth-refresh-plan-1'
const cfgOf = (repo: TestRepo): Config => {
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
  return r.value
}

it('a pick policy on a gate stop leaves it for a human, never for the arbiter (row 239)', async () => {
  const repo = await plannedRepo()
  const sha = gateSpec('plan')!.currentSha!(repo.root, loadCanon(repo.root), cfgOf(repo), PLAN)
  commitEntry(repo, PLAN, {
    t: 'gate-run', gate: 'plan', artifact: PLAN, round: 1, run_id: 'r-1', reviewed_sha: sha, prompts_sha: 'ps',
    witness: '0', model: 'm', pin: 'm', harness: 'claude-code', checks: [], outcome: 'stopped',
    verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: `${PLAN} > ## Notes`, claim: 'x' }] }],
  })
  const out: string[] = []
  const settled = await settleStop(fakeCtx(repo.root, { env: fixtureEnv(), out: (l) => out.push(l) }), repo.root, cfgOf(repo), 'plan', PLAN)
  const why = 'the policy picked a spec, which a gate stop never takes'
  expect(arbiter.calls).toBe(0)
  expect(settled).toEqual({ kind: 'left', why, code: EXIT.REFUSED })
  expect(out).toEqual([`autonomy: left for a human — ${why} · witness decide plan ${PLAN} --show`])
  expect(readStream(repo.root, PLAN).some((e) => e.t === 'human-decision')).toBe(false)
})
