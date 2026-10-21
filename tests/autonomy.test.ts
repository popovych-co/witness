import { expect, it } from 'vitest'
import { autonomyLines, keptStopLine, policyFor } from '../src/autonomy.js'
import type { Entry } from '../src/journal.js'
import { recommend } from '../src/recommend.js'
import { lastGateRun } from '../src/rounds.js'
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

const run = (round: number, sha: string, extra: Record<string, unknown> = {}, findings: unknown[] = []): Entry => ({
  v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round, run_id: `r-${round}`, reviewed_sha: sha,
  prompts_sha: 'ps', witness: '0.16.0', model: 'm', pin: 'm', harness: 'claude-code', calibration: 'none',
  checks: [], outcome: 'stopped', verdicts: [{ reviewer: 'lens', coverage: [], findings }], ...extra,
} as unknown as Entry)
const decision = (d: string, extra: Record<string, unknown> = {}): Entry =>
  ({ v: 1, t: 'human-decision', gate: 'plan', artifact: 'p1', round: 1, decision: d, ...extra } as unknown as Entry)
const blocking = (anchor: string) => [{ blocking: true, anchor, claim: 'x' }]
const NIT = [{ blocking: false, anchor: 'S', claim: 'nit' }]
const failed = (...names: string[]) => names.map((name) => ({ name, ok: false, detail: 'x' }))
const policy = (gate: string, entries: Entry[], o: { untrusted?: string[]; upstream?: string | null; stale?: boolean } = {}) => {
  const block = recommend({ gate, target: 'p1', entries, upstream: o.upstream === null ? undefined : (o.upstream ?? 'auth-refresh'), stale: o.stale ?? false })!
  return policyFor({ at: 'gate', gate, target: 'p1', entries, run: lastGateRun(entries, gate)!, block, untrusted: o.untrusted ?? [] })
}
const take = (command: string) => ({ kind: 'take', command })
const ARBITER = { kind: 'arbiter' }

it('takes the recommendation where the table says the CLI takes it', () => {
  expect(policy('plan', [run(1, 'a', {}, blocking('p1 > ## Step: s1'))])).toEqual(take('witness decide plan p1 --revise --note "1 blocking finding: p1 > ## Step: s1"'))
  expect(policy('plan', [run(1, 'a', {}, blocking('auth-refresh > ## Behavior'))])).toEqual(take('witness decide plan p1 --revise --upstream auth-refresh'))
  expect(policy('plan', [run(1, 'a', {}, blocking('S')), run(2, 'b', {}, blocking('S'))])).toEqual(take('witness decide plan p1 --revise --upstream auth-refresh'))
  expect(policy('plan', [run(1, 'a', {}, NIT)])).toEqual(take('witness decide plan p1 --approve'))
  expect(policy('plan', [run(1, 'a', { checks: failed('drift-lane') })])).toEqual(take('witness decide plan p1 --revise --note "failed checks: drift-lane"'))
  expect(policy('plan', [run(1, 'a', {}, blocking('S'))], { stale: true })).toEqual(take('witness gate plan p1'))
})
it('sends judgment to the arbiter', () => {
  expect(policy('plan', [run(1, 'a', {}, blocking('S1')), run(2, 'b', {}, blocking('S2')), run(3, 'c', {}, blocking('S3'))])).toEqual(ARBITER)
  expect(policy('plan', [run(1, 'a', {}, blocking('S')), decision('revise-upstream', { anchor: 'S' }),
    run(2, 'b', {}, blocking('S')), run(3, 'c', {}, blocking('S')), run(4, 'd', {}, blocking('S'))])).toEqual(ARBITER)
  expect(policy('plan', [run(1, 'a', {}, [{ blocking: true, anchor: 'S', claim: 'x', contradicts_pin: 1 }])])).toEqual(ARBITER)
  expect(policy('plan', [run(1, 'a', { pin: 'pinned-model' }, NIT)])).toEqual(ARBITER)
})
it('keys standing stops by gate before rule (E8)', () => {
  const at = (gate: string, findings: unknown[] = [], extra = {}) => [run(1, 'a', { gate, standing: `${gate} always stops`, ...extra }, findings)]
  expect(policy('ship', at('ship'))).toEqual(ARBITER)
  expect(policy('ship', at('ship', NIT))).toEqual(ARBITER)
  expect(policy('decompose', at('decompose'))).toEqual(ARBITER)
  expect(policy('design', at('design'))).toEqual({ kind: 'human', stop: 'design-look' })
  expect(policy('design', at('design', NIT))).toEqual({ kind: 'human', stop: 'design-look' })
  expect(policy('design', at('design', blocking('design#save-bar')))).toEqual(take('witness decide design p1 --revise --note "1 blocking finding: design#save-bar"'))
  expect(policy('design', at('design', [], { checks: failed('template') }))).toEqual(take('witness decide design p1 --revise --note "failed checks: template"'))
})
it('routes failed checks by kind', () => {
  expect(policy('decompose', [run(1, 'a', { gate: 'decompose', standing: 'feature scope', checks: failed('amendment-ack') })])).toEqual(ARBITER)
  expect(policy('decompose', [run(1, 'a', { gate: 'decompose', checks: failed('amendment-ack', 'goal-coverage') })]))
    .toEqual(take('witness decide decompose p1 --revise --note "failed checks: amendment-ack, goal-coverage"'))
  const blocked = (round: number, findings: unknown[] = []) => run(round, `s${round}`, {
    gate: 'implement', checks: [{ name: 'drift-lane', ok: false, detail: 'ac-smoke:fail', untrusted: ['pnpm verify'] }] }, findings)
  expect(policy('implement', [blocked(1, blocking('src/a.ts'))], { untrusted: ['pnpm verify'] })).toEqual({ kind: 'human', stop: 'trust-grant' })
  expect(policy('implement', [blocked(1)])).toEqual(take('witness gate implement p1'))
  expect(policy('implement', [blocked(1), blocked(2), blocked(3)])).toEqual(ARBITER)
})
it('never takes an option it cannot run', () => {
  expect(policy('plan', [run(1, 'a', {}, blocking('S')), run(2, 'b', {}, blocking('S'))], { upstream: null })).toEqual(ARBITER)
})
it('answers the stops that are not gates', () => {
  const opt = (command: string) => ({ command, depth: 'root' as const, runnable: true })
  expect(policyFor({ at: 'choose', block: { key: 'choose', rule: 'multiple-ready', options: [opt('token-store'), opt('audit-log')] } })).toEqual(take('token-store'))
  expect(policyFor({ at: 'recover', block: { key: 'recover', rule: 'txn-write-landed', options: [opt('witness recover --complete')] } })).toEqual(take('witness recover --complete'))
  expect(policyFor({ at: 'start', target: 'p1', unmet: ['ses-prod'] })).toEqual({ kind: 'human', stop: 'unmet-need' })
})
