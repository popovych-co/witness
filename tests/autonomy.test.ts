import { expect, it } from 'vitest'
import { autonomyLines, keptStopLine } from '../src/autonomy.js'
import { autonomyOn, fakeScenario, gateEnv, putVerdict, seededRepo, writePlan, writeSpec } from './helpers.js'

const cover = (ids: string[]) => ({
  coverage: ids.map((id) => ({ anchor: `${id} > ## Behavior`, note: 'read' })),
  findings: [],
})

// The passing fix-class decompose of gate-decompose.test.ts: an amendment of a pre-effort spec.
async function fixAmend() {
  const repo = await seededRepo({ class: 'fix', slug: 'quick-amend', preexisting: ['auth-refresh'] })
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, cover(['auth-refresh']))
  return { repo, scenario }
}

const LINES = ['autonomy: on', 'kept-stops: design look · unmet need · trust grant']
it('renders the setting and the kept-stop set', () => {
  expect(autonomyLines({ autonomy: false })).toEqual([])
  expect(autonomyLines({ autonomy: true })).toEqual(LINES)
  expect(keptStopLine('trust-grant', 'node "x" run · y')).toBe('kept-stop: trust grant — node "x" run · y')
})
it('next prints it first, above the routing block', async () => {
  const repo = await seededRepo(); autonomyOn(repo)
  const out = (await repo.cli(['next'])).stdout
  expect(out.split('\n').slice(0, 2)).toEqual(LINES)
  expect(out).toMatch(/^next: /m)
})
it('a gate run, decide --show and start print it', async () => {
  const { repo, scenario } = await fixAmend(); autonomyOn(repo)
  const gated = await repo.cli(['gate', 'decompose', 'quick-amend'], { env: gateEnv(scenario) })     // passes: nothing to settle
  expect(gated.stdout.split('\n').slice(0, 2)).toEqual(LINES)
  expect((await repo.cli(['decide', 'decompose', 'quick-amend', '--show'])).stdout.split('\n').slice(0, 2)).toEqual(LINES)
  expect((await writePlan(repo, 'auth-refresh-plan-1')).code).toBe(0)
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  expect((await repo.cli(['start', 'auth-refresh-plan-1'])).stdout.split('\n').slice(0, 2)).toEqual(LINES)
})
it('a --manual gate run says nothing: for that run autonomy is off', async () => {
  const { repo, scenario } = await fixAmend(); autonomyOn(repo)
  const manual = await repo.cli(['gate', 'decompose', 'quick-amend', '--manual'], { env: gateEnv(scenario) })
  expect(manual.code).toBe(1)
  expect(manual.stdout).not.toContain('autonomy:')
})
it('says nothing when the repo has not opted in', async () => {
  const repo = await seededRepo()
  expect((await repo.cli(['next'])).stdout).not.toContain('autonomy:')
})
