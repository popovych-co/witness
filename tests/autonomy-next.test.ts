import { expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import type { DecisionEntry } from '../src/rounds.js'
import {
  PLAN_BLOCKING, approve, autonomyOn, callCount, fakeScenario, gateEnv, plannedRepo, putVerdict, readyTrio,
  seededRepo, writePlan, writeSpec,
} from './helpers.js'

const PLAN = 'auth-refresh-plan-1'
const decisions = (root: string, stream: string) =>
  readStream(root, stream).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]

// A plan stop gated while autonomy was still off, so its decision waits; then the repo opts in.
async function pendingPlanStop() {
  const repo = await plannedRepo({ autonomy: false })
  const scenario = fakeScenario(); putVerdict(scenario, PLAN_BLOCKING)
  expect((await repo.cli(['gate', 'plan', PLAN], { env: gateEnv(scenario) })).code).toBe(1)
  autonomyOn(repo)
  return { repo, scenario }
}

it('settles a decision that was waiting when autonomy was turned on', async () => {
  const { repo, scenario } = await pendingPlanStop()
  const out = (await repo.cli(['next'], { env: gateEnv(scenario) })).stdout
  expect(out).toContain(`decided: plan ${PLAN} → revise · policy · blocking-here`)
  expect(out).toMatch(new RegExp(`^next: witness write ${PLAN} --effort auth-hardening`, 'm'))
  expect(decisions(repo.root, PLAN).at(-1)).toMatchObject({ decision: 'revise', selected: 'policy' })
})
it('leaves a --manual run\'s stop with the human (Review Focus 4)', async () => {
  const repo = await plannedRepo(); const scenario = fakeScenario(); putVerdict(scenario, PLAN_BLOCKING)
  expect((await repo.cli(['gate', 'plan', PLAN, '--manual'], { env: gateEnv(scenario) })).code).toBe(1)
  const out = (await repo.cli(['next'], { env: gateEnv(scenario) })).stdout
  expect(out).toMatch(new RegExp(`^next: witness decide plan ${PLAN} --show$`, 'm'))
  expect(decisions(repo.root, PLAN)).toEqual([])
})
it('settles nothing under CI or from status (Review Focus 5)', async () => {
  const { repo, scenario } = await pendingPlanStop()
  await repo.cli(['next'], { env: { ...gateEnv(scenario), CI: '1' } })
  expect(decisions(repo.root, PLAN)).toEqual([])
  await repo.cli(['status'], { env: gateEnv(scenario) })
  expect(decisions(repo.root, PLAN)).toEqual([])
  expect(callCount(scenario)).toBe(1)
})
it('a re-run owed outranks a stop left for a human', async () => {
  const { repo, scenario } = await pendingPlanStop()
  expect((await writePlan(repo, PLAN, {}, '## Step: s1\nRewritten.\n')).code).toBe(0)
  const out = (await repo.cli(['next'], { env: gateEnv(scenario) })).stdout
  expect(out).toMatch(new RegExp(`^next: witness gate plan ${PLAN}$`, 'm'))
  expect(decisions(repo.root, PLAN)).toEqual([])
})
it('takes the top-ranked spec of choose: and prints no block', async () => {
  const repo = await seededRepo()
  await readyTrio(repo)
  autonomyOn(repo)
  const out = (await repo.cli(['next'], { env: gateEnv(fakeScenario()) })).stdout
  expect(out).not.toContain('choose:')
  expect(out).toContain('next: witness write token-store-plan-1 --effort auth-hardening --meta m.json --body b.md')
  expect(out).toContain('note: 3 ready — policy took token-store (multiple-ready)')
})
it('takes option 1 of the recovery fork and prints no block', async () => {
  const repo = await seededRepo(); autonomyOn(repo)
  const a = '{"v":1,"t":"status","artifact":"p","to":"done"}'
  repo.write('.witness/journal/p.jsonl', `{"seed":1}\n${a}\n`)
  repo.write('.witness/txn.json', JSON.stringify({ op: 'merge-stamp', files: ['.witness/journal/p.jsonl'], journalMulti: [{ stream: 'p', line: a }] }))
  const out = (await repo.cli(['next'], { env: gateEnv(fakeScenario()) })).stdout
  expect(out).toMatch(/^next: witness recover --complete$/m)
  expect(out).toContain('note: policy took 1 of 2 — txn-write-landed')
  expect(out).not.toContain('recover: 2 options')
})
it('start names an unmet plan need as a kept stop', async () => {
  const repo = await seededRepo(); autonomyOn(repo)
  await writeSpec(repo, 'auth-refresh'); approve(repo, 'auth-refresh')
  expect((await writePlan(repo, PLAN, { needs: [{ manual: 'ses-prod', satisfied: false }] })).code).toBe(0)
  repo.flipStatus(PLAN, 'approved')
  const r = await repo.cli(['start', PLAN], { env: gateEnv(fakeScenario()) })
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('needs-unmet')
  expect(r.stdout).toContain(`kept-stop: unmet need — ses-prod · witness satisfy ${PLAN} --need 1`)
})
