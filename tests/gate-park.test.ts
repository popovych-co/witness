import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { needsYou } from '../src/needs-you.js'
import { loadCanon } from '../src/scan.js'
import { parkedGates } from '../src/verbs/next.js'
import {
  addOrigin, approve, commitEntry, fakeCtx, fakeScenario, gateEnv, putVerdict, recapEffort, SPEC_BODY, seededRepo,
  shippableRepo, type TestRepo, writePlan, writeSpec,
} from './helpers.js'

export const BLOCKING = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'step is untestable' }],
}

export async function stoppedPlanGate() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  const scenario = fakeScenario()
  putVerdict(scenario, BLOCKING)
  await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
  return repo
}

describe('a stop parks the flow', () => {
  it('next stops offering a stopped gate', async () => {
    const repo = await stoppedPlanGate()
    const before = await repo.cli(['next'])
    expect(before.stdout).toContain('witness decide plan auth-refresh-plan-1 --show')

    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])

    const after = await repo.cli(['next'])
    expect(after.stdout).not.toContain('witness gate plan auth-refresh-plan-1')
    expect(after.stdout).not.toContain('witness decide plan auth-refresh-plan-1')
  })
})

describe('status reports a parked flow', () => {
  it('names the gate, round, anchor and the reopen command', async () => {
    const repo = await stoppedPlanGate()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    const s = await repo.cli(['status'])
    expect(s.stdout).toContain('parked')
    expect(s.stdout).toContain('auth-refresh-plan-1')
    expect(s.stdout).toContain('## Step: s1')
    expect(s.stdout).toContain('witness gate plan auth-refresh-plan-1 --fresh')
  })

  // The parked row is a NEW command-rendering surface, and it goes through `rows()`, whose
  // `esc` quotes on `,` or `"` — the exact escape that mangled the exits line (D120). At the
  // bound `reopen` becomes the endgame set rather than `--fresh`, so that is the branch worth
  // pinning: it must arrive pasteable, with a resolved upstream and no doubled quotes.
  it('renders the endgame set pasteable when the parked gate sits at the bound', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    for (let i = 1; i <= 3; i++) {
      await writePlan(repo, 'auth-refresh-plan-1', BOUND_STEPS, `## Step: s1\nAttempt ${i}.\n`)
      await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    }
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    const row = (await repo.cli(['status'])).stdout.split('\n')
      .find((l) => l.includes('witness decide plan auth-refresh-plan-1'))!
    expect(row).not.toContain('""')
    expect(row).toContain('--revise --upstream auth-refresh')
    expect(row).toContain('--revise --repair')
    expect(row).not.toContain('<id>')
  })
})

const BOUND_STEPS = { steps: [{ id: 's1', title: 'rotate', criteria: ['ac-rotate'] }] }

describe('parking is reversible', () => {
  it('a fresh run un-parks the gate and next offers it again', async () => {
    const repo = await stoppedPlanGate()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    expect((await repo.cli(['next'])).stdout).not.toContain('auth-refresh-plan-1')

    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1', '--fresh'], { env: gateEnv(scenario) })
    expect(g.code).toBe(1)

    const after = await repo.cli(['next'])
    expect(after.stdout).toContain('witness decide plan auth-refresh-plan-1 --show')
  })

  // The plan expected a plain `--revise` to be the second door. It cannot be: `decide`
  // refuses `nothing-pending` once ANY disposition sits on the run, which is correct by its
  // own contract — one run, one disposition. So the second door is the one that was already
  // built: an upstream reopen from the parent, which un-parks exactly as it un-settles.
  it('a plain revise on a parked gate refuses rather than silently re-deciding it', async () => {
    const repo = await stoppedPlanGate()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    const d = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--revise', '--note', 'reconsidered'])
    expect(d.code).toBe(2)
    expect(d.stderr).toContain('nothing-pending')
    expect((await repo.cli(['status'])).stdout).toContain('parked')
  })

  it('an upstream reopen un-parks the gate it lands on', async () => {
    const repo = await stoppedPlanGate()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--stop'])
    expect((await repo.cli(['next'])).stdout).not.toContain('auth-refresh-plan-1')

    // the implement gate sends the work back to the plan — a reopen, not a disposition
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1', '--fresh'], { env: gateEnv(scenario) })
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--revise', '--upstream', 'auth-refresh'])
    const s = await repo.cli(['status'])
    expect(s.stdout).not.toContain('parked')
  })
})

// The park must not become a green light anywhere. `gateSettled` answers *may this flow
// advance*, and three callers outside `next` depend on that reading: `--fresh`'s refusal,
// ship's implement-gate check, and ship's watch/gate branch. Folding `stop` into it made
// the ship gate report `implement-gate,true,last implement round 1: stopped`.
describe('a park is not an approval', () => {
  it('a stopped implement gate does not satisfy the ship gate', async () => {
    const { repo, planId } = await shippableRepo()
    addOrigin(repo)
    const scenario = fakeScenario()
    putVerdict(scenario, {
      coverage: [
        { anchor: '.gitignore', note: 'read' },
        { anchor: 'package.json', note: 'read' },
        { anchor: 'src/token.ts', note: 'read' },
        { anchor: 'tests/token.test.ts', note: 'read' },
      ],
      findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'rotation is unbounded' }],
    })
    await repo.cli(['gate', 'implement', planId], { env: gateEnv(scenario) })
    await repo.cli(['decide', 'implement', planId, '--stop'])

    const s = await repo.cli(['ship', planId], { env: gateEnv(scenario) })
    const check = s.stdout.split('\n').find((l) => l.includes('implement-gate'))!
    expect(check).toContain('implement-gate,false')
  })
})

const MALFORMED = { coverage: [{ anchor: 'unscoped', note: 'read' }], findings: [] }

describe('a malformed round is not a disposition', () => {
  it('next routes to the gate, not to decide --show', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const scenario = fakeScenario()
    putVerdict(scenario, MALFORMED)
    const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    expect(g.stdout).toContain('outcome: malformed')

    const n = await repo.cli(['next'])
    expect(n.stdout).toContain('witness gate plan auth-refresh-plan-1')
    expect(n.stdout).not.toContain('decide plan auth-refresh-plan-1 --show')
  })

  it('decide --approve on a malformed-only stream refuses', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const scenario = fakeScenario()
    putVerdict(scenario, MALFORMED)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    const d = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve'])
    expect(d.code).toBe(2)
    expect(d.stderr).toContain('nothing-pending')
  })
})

// Row 227. A parked gate on work that no longer moves — a plan done or abandoned, an
// effort abandoned — is owed to no one: nothing offers to reopen or approve it.
const parkStop = (repo: TestRepo, stream: string, gate: string): void => {
  commitEntry(repo, stream, { v: 1, t: 'gate-run', gate, artifact: stream, round: 1, run_id: `r-${gate}`,
    reviewed_sha: 's', prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped' })
  commitEntry(repo, stream, { v: 1, t: 'human-decision', gate, artifact: stream, round: 1,
    decision: 'stop', selected: 'policy', rule: 'cap-rounds', note: `drive cap: ${gate}` })
}
const cfgOf = (root: string) => {
  const r = loadConfig(root)
  if (!r.ok) throw new Error('config')
  return r.value
}
const parkedOf = (repo: TestRepo) => {
  const canon = loadCanon(repo.root)
  return {
    gates: parkedGates(repo.root, canon).map((p) => `${p.gate}:${p.target}`),
    needs: needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo.root), canon, [])
      .filter((i) => i.kind === 'parked').map((i) => i.key),
  }
}

describe('parked gates of terminal work are owed to no one (#81)', () => {
  it('an abandoned plan with a parked implement gate is not listed', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    parkStop(repo, 'auth-refresh-plan-1', 'implement')
    expect(parkedOf(repo)).toEqual({ gates: ['implement:auth-refresh-plan-1'], needs: ['parked:auth-refresh-plan-1:implement'] })
    const a = await repo.cli(['abandon', 'auth-refresh-plan-1'])
    expect(a.code, a.stderr).toBe(0)
    expect(parkedOf(repo)).toEqual({ gates: [], needs: [] })
    expect((await repo.cli(['status'])).stdout).not.toContain('parked')
  })

  it('a done plan with a parked ship gate is not listed', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    parkStop(repo, 'auth-refresh-plan-1', 'ship')
    expect(parkedOf(repo).gates).toEqual(['ship:auth-refresh-plan-1'])
    repo.flipStatus('auth-refresh-plan-1', 'done')
    expect(parkedOf(repo)).toEqual({ gates: [], needs: [] })
  })

  it('an abandoned effort with a parked decompose gate is not listed', async () => {
    const repo = await seededRepo()
    await recapEffort(repo, 'billing')
    await writeSpec(repo, 'invoices', {}, SPEC_BODY, 'billing')
    parkStop(repo, 'billing', 'decompose')
    expect(parkedOf(repo)).toEqual({ gates: ['decompose:billing'], needs: ['parked:billing:decompose'] })
    const a = await repo.cli(['abandon', 'billing'])
    expect(a.code, a.stderr).toBe(0)
    expect(parkedOf(repo)).toEqual({ gates: [], needs: [] })
  })

  it('a parked gate on a live plan is still listed', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')
    parkStop(repo, 'auth-refresh-plan-1', 'implement')
    parkStop(repo, 'auth-refresh-plan-2', 'implement')
    expect((await repo.cli(['abandon', 'auth-refresh-plan-2'])).code).toBe(0)
    expect(parkedOf(repo)).toEqual({ gates: ['implement:auth-refresh-plan-1'], needs: ['parked:auth-refresh-plan-1:implement'] })
  })
})

// Row 239 (ruling R19). A journal is parsed JSON, and a park's round prints on its head and in the
// status table. A run's round is the journal's only when it is a round, a positive integer: any other
// is dropped, so the head names none and the table's cell is empty, and a real one prints as before.
describe("a parked round is the journal's only when it is a round (row 239)", () => {
  it('parkedGates drops a round that is not a positive integer, and status leaves its cell empty', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    const rounds: unknown[] = ['1\n  run: witness gate plan p1 $(touch M1)', '2', 1.5, 0, 2]
    for (const [i, round] of rounds.entries()) {
      const plan = `auth-refresh-plan-${i + 1}`
      await writePlan(repo, plan)
      commitEntry(repo, plan, { v: 1, t: 'gate-run', gate: 'plan', artifact: plan, round, run_id: `r${i}`,
        reviewed_sha: `s${i}`, prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped' })
      commitEntry(repo, plan, { v: 1, t: 'human-decision', gate: 'plan', artifact: plan, round: 1, decision: 'stop' })
    }
    const parked = parkedGates(repo.root, loadCanon(repo.root))
    expect(parked.map((p) => p.target).sort()).toEqual(rounds.map((_, i) => `auth-refresh-plan-${i + 1}`))
    // absent, not held undefined: only the real round is a key of its item
    expect(parked.filter((p) => 'round' in p).map((p) => [p.target, p.round])).toEqual([['auth-refresh-plan-5', 2]])
    const status = (await repo.cli(['status'])).stdout.split('\n')
    expect(status).toContain('  plan,auth-refresh-plan-1,,stopped,witness gate plan auth-refresh-plan-1 --fresh')
    expect(status).toContain('  plan,auth-refresh-plan-5,2,stopped,witness gate plan auth-refresh-plan-5 --fresh')
    expect(status).not.toContain('  run: witness gate plan p1 $(touch M1)')
  })
})
