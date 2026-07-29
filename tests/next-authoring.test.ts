import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import {
  approve, fakeScenario, gateEnv, nextLine, putVerdict, seededRepo, writePlan, writeSpec,
  PLAN_BODY, PLAN_META, SPEC_BODY, type TestRepo,
} from './helpers.js'

const REOPEN = { artifact: 'auth-refresh', gate: 'design', round: 1 }

// A decompose gate that PASSED at a sha, so nothing is pending and nothing is at bound.
async function approvedEffort() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  appendEntry(repo.root, repo.effort, {
    v: 1, t: 'gate-run', gate: 'decompose', artifact: repo.effort, round: 1,
    run_id: 'r1', reviewed_sha: 'stale-sha', prompts_sha: 'p', specflow: '0',
    model: 'm', calibration: 'none', checks: [], verdicts: [], outcome: 'passed',
  })
  return repo
}

// A real decompose gate-run against a fake reviewer — the run's reviewed_sha is the
// effort's ACTUAL sha, which is what the changed-nothing short-circuit keys on.
async function gatedEffort() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
  // a feature decompose carries a standing stop, so EXIT.FINDINGS (1) is the healthy
  // outcome here — only a refusal (2) or a block (3) means the fixture failed to gate
  const g = await repo.cli(['gate', 'decompose', '--effort', repo.effort], { env: gateEnv(scenario) })
  if (g.code > 1) throw new Error(`gate failed: ${g.stdout}\n${g.stderr}`)
  return repo
}

describe('next — doc-gate lapse', () => {
  it('routes back to the decompose gate when the effort sha no longer matches the verdict', async () => {
    const repo = await approvedEffort()
    const r = await repo.cli(['next'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`gate decompose --effort ${repo.effort}`)
  })
})

describe('next — authoring owed, never the gate', () => {
  it('after a decompose revise with no edit, routes to write, not the gate', async () => {
    const repo = await gatedEffort()
    appendEntry(repo.root, repo.effort, {
      v: 1, t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'revise',
    })
    const r = await repo.cli(['next'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('specflow write')
    expect(r.stdout).not.toContain('gate decompose')
  })

  it('an undischarged reopen routes to write, not the gate', async () => {
    const repo = await gatedEffort()
    appendEntry(repo.root, repo.effort, {
      v: 1, t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1,
      decision: 'revise', caused_by: REOPEN, note: 'cancel-window is wrong at the spec level',
    })
    const r = await repo.cli(['next'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('specflow write')
  })

  it('once content moves, routing returns to the gate', async () => {
    const repo = await gatedEffort()
    appendEntry(repo.root, repo.effort, {
      v: 1, t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'revise',
    })
    await writeSpec(repo, 'auth-refresh', { summary: 'Rotates the refresh token before it expires' })
    const r = await repo.cli(['next'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`gate decompose --effort ${repo.effort}`)
  })
})

// Abandoning the effort that authored a plan leaves the parent spec approved with no
// live plan, so the spec reads as planless forever. The route asked for a write under
// `--effort <slug>` — a literal placeholder — and the abandoned effort is filtered out
// of the live list, so no slug was nameable and `next` repeated itself indefinitely.
describe('next — a plan owed after its authoring effort was abandoned', () => {
  async function orphanedPlan(): Promise<TestRepo> {
    const repo = await seededRepo()                      // auth-hardening: live, owns the spec
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    repo.write('recap-b.json', JSON.stringify({
      effort: 'ratchet-scope', class: 'chore',
      goals: [{ id: 'g1', text: 'narrow the ratchet scope' }], non_goals: [], constraints: [], slices: [],
    }))
    expect((await repo.cli(['recap', '--file', 'recap-b.json'])).code).toBe(0)
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'ratchet-scope')).code).toBe(0)
    expect((await repo.cli(['abandon', 'ratchet-scope'])).code).toBe(0)
    return repo
  }

  it('names a live effort that owns the work rather than a <slug> placeholder', async () => {
    const repo = await orphanedPlan()
    const line = await nextLine(repo)
    expect(line).toContain('--effort auth-hardening')
    expect(line).not.toContain('<slug>')
  })

  it('emits a command that actually runs — the loop broke because nothing did', async () => {
    const repo = await orphanedPlan()
    const line = await nextLine(repo)
    const cmd = line.split('\n').find((l) => l.startsWith('next: specflow '))!
      .replace('next: specflow ', '').split(' ')
    repo.write('m.json', JSON.stringify(PLAN_META))
    repo.write('b.md', PLAN_BODY)
    const r = await repo.cli(cmd)
    expect(r.stdout + r.stderr).not.toContain('refus')
    expect(r.code).toBe(0)
    expect(await nextLine(repo)).not.toBe(line)          // the pipeline moved
  })
})

// The effort that owned a spec can go terminal without its content being reverted — the
// state a manual recovery leaves behind. The spec stays approved and planless, and no live
// effort can carry the plan write it needs.
describe('next — a planless spec no live effort owns', () => {
  // `zz-tokens` sorts AFTER the orphan deliberately: alphabetical order alone would then
  // pick the orphan, so only an ownership preference can route to the runnable work.
  async function orphanedSpec(opts: { ownerIdle?: boolean } = {}): Promise<TestRepo> {
    const repo = await seededRepo({ slug: 'aa-owner' })
    await writeSpec(repo, 'zz-tokens', { criteria: [{ id: 'ac-tokens', test: '@spec:zz-tokens' }] })
    approve(repo, 'zz-tokens')
    expect((await writePlan(repo, 'zz-tokens-plan-1', {
      parent: 'zz-tokens', steps: [{ id: 's1', title: 'rotate tokens on refresh', criteria: ['ac-tokens'] }],
    })).code).toBe(0)
    // a draft plan is live motion, so zz-tokens is not planless while it stands
    if (opts.ownerIdle) repo.flipStatus('zz-tokens-plan-1', 'abandoned')

    repo.write('recap-orphan.json', JSON.stringify({
      effort: 'bb-orphan', class: 'feature',
      goals: [{ id: 'g1', text: 'Refresh tokens rotate before expiry' }],
      non_goals: [], constraints: [], slices: [],
    }))
    expect((await repo.cli(['recap', '--file', 'recap-orphan.json'])).code).toBe(0)
    expect((await writeSpec(repo, 'auth-mfa',
      { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] }, SPEC_BODY, 'bb-orphan')).code).toBe(0)
    approve(repo, 'auth-mfa')
    appendEntry(repo.root, 'bb-orphan', {
      v: 1, t: 'human-decision', gate: 'effort', artifact: 'bb-orphan', round: 0, decision: 'abandon-effort',
    })
    return repo
  }

  it('asks for the effort that is actually owed, at brainstorm stage', async () => {
    const repo = await orphanedSpec()
    const line = await nextLine(repo)
    expect(line).toContain('specflow recap')
    expect(line).toContain('stage: brainstorm')
    expect(line).toContain('auth-mfa-plan-1 is owed')
    expect(line).not.toContain('<slug>')
  })

  it('prefers a planless spec a live effort can carry over stalling for a recap', async () => {
    const repo = await orphanedSpec({ ownerIdle: true })
    const line = await nextLine(repo)
    expect(line).toContain('specflow write zz-tokens-plan-1 --effort aa-owner')
    expect(line).not.toContain('specflow recap')
  })
})

// A chore never writes spec content — `write` refuses it as a class-tripwire — so the
// decompose gate has nothing to judge and refuses `nothing-to-gate`. Routing a chore to
// either side of that pair is unsatisfiable; a chore's plans are what gate instead.
describe('next — chore-class effort', () => {
  const choreEffort = (): Promise<TestRepo> =>
    seededRepo({ preexisting: ['auth-refresh'], class: 'chore', slug: 'ratchet-scope' })

  it('asks for a plan, never the spec a chore is forbidden to write', async () => {
    const repo = await choreEffort()
    const line = await nextLine(repo)
    expect(line).toContain('--effort ratchet-scope')
    expect(line).not.toContain('<spec-id>')
    const refused = await writeSpec(repo, 'auth-mfa',
      { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] }, SPEC_BODY, 'ratchet-scope')
    expect(refused.stderr).toContain('class-tripwire')          // why that route was dead
  })

  it('never routes to the decompose gate, which refuses nothing-to-gate for a chore', async () => {
    const repo = await choreEffort()
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, PLAN_BODY, 'ratchet-scope')).code).toBe(0)
    const gate = await repo.cli(['gate', 'decompose', '--effort', 'ratchet-scope'])
    expect(gate.stdout + gate.stderr).toContain('nothing-to-gate')
    const line = await nextLine(repo)
    expect(line).not.toContain('gate decompose')
    expect(line).toContain('gate plan auth-refresh-plan-1')     // the plans are the gateable work
  })
})
