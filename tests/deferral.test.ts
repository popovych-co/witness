import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deferralsBlock, newDeferralId, openDeferrals, type DeferralEntry } from '../src/deferral.js'
import { readStream, type Entry } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import {
  approve, fakeScenario, gateEnv, ghState, putVerdict, seededRepo, writePlan, writeSpec,
} from './helpers.js'

const mint = (id: string, over: Partial<DeferralEntry> = {}): Entry => ({
  v: 1, t: 'deferral', id, artifact: 'p1', gate: 'implement', round: 3,
  anchor: 'src/token.ts#rotate', kind: 'artifact-debt', caused_by_run: 'r-1', ...over,
} as unknown as Entry)

describe('newDeferralId', () => {
  it('mints the d-<8hex> shape and does not repeat', () => {
    const a = newDeferralId()
    expect(a).toMatch(/^d-[0-9a-f]{8}$/)
    expect(a).not.toBe(newDeferralId())
  })
})

describe('openDeferrals folds the entry family', () => {
  it('returns a minted obligation', () => {
    expect(openDeferrals([mint('d-1')]).map((d) => d.id)).toEqual(['d-1'])
  })

  it('drops one discharged by evidence', () => {
    const e = [mint('d-1'), { v: 1, t: 'deferral-discharged', id: 'd-1' } as unknown as Entry]
    expect(openDeferrals(e)).toEqual([])
  })

  it('drops one dismissed', () => {
    const e = [mint('d-1'), { v: 1, t: 'deferral-dismissed', id: 'd-1', cause: 'lens-retired', note: 'x' } as unknown as Entry]
    expect(openDeferrals(e)).toEqual([])
  })

  it('drops one that moved away from this stream', () => {
    const e = [mint('d-1'), { v: 1, t: 'deferral-moved', id: 'd-1', to: 'auth-refresh' } as unknown as Entry]
    expect(openDeferrals(e)).toEqual([])
  })

  it('honors a retype', () => {
    const e = [mint('d-1', { kind: 'lens-suspicion' }),
      { v: 1, t: 'deferral-retyped', id: 'd-1', kind: 'artifact-debt' } as unknown as Entry]
    expect(openDeferrals(e)[0]!.kind).toBe('artifact-debt')
  })

  it('keeps two obligations on the same anchor distinct', () => {
    expect(openDeferrals([mint('d-1'), mint('d-2')]).length).toBe(2)
  })
})

describe('deferralsBlock is the inverse of a pin', () => {
  it('solicits findings rather than suppressing them', () => {
    const text = deferralsBlock([mint('d-1') as unknown as DeferralEntry])
    expect(text).toContain('src/token.ts#rotate')
    expect(text).toMatch(/report/i)
    expect(text).toMatch(/silence/i)
    expect(text).not.toMatch(/do not re-litigate/i)
  })

  it('is empty for no obligations', () => {
    expect(deferralsBlock([])).toBe('')
  })

  it('says silence is read as fixed — the rule the gate applies', () => {
    const text = deferralsBlock([mint('d-1') as unknown as DeferralEntry])
    expect(text).toContain('Silence is read as fixed')
    expect(text).not.toContain('still present"')
  })

  it('renders an omission obligation as the anchor object a verdict can carry', () => {
    const text = deferralsBlock([mint('d-2', { anchor: 'omission:tests/' }) as unknown as DeferralEntry])
    expect(text).toContain('omission · scope tests/')
    expect(text).toContain('"anchor": { "kind": "omission", "scope": "tests/" }')
    expect(text).not.toContain('omission:tests/')
  })
})

const BLOCKING = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [{ blocking: true, anchor: 'auth-refresh-plan-1 > ## Step: s1', claim: 'untestable' }],
}
const STEPS = { steps: [{ id: 's1', title: 'rotate', criteria: ['ac-rotate'] }] }

async function atBound() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, BLOCKING)
  for (let i = 1; i <= 3; i++) {
    await writePlan(repo, 'auth-refresh-plan-1', STEPS, `## Step: s1\nAttempt ${i}.\n`)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
  }
  return repo
}

describe('taking a deferral mints an obligation', () => {
  it('an override at the bound mints one per blocking anchor', async () => {
    const repo = await atBound()
    const r = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    expect(r.code, r.stderr).toBe(0)
    const minted = readStream(repo.root, 'auth-refresh-plan-1')
      .filter((e) => e.t === 'deferral') as unknown as DeferralEntry[]
    expect(minted).toHaveLength(1)
    expect(minted[0]!.anchor).toBe('auth-refresh-plan-1 > ## Step: s1')
    expect(minted[0]!.kind).toBe('artifact-debt')
    expect(minted[0]!.id).toMatch(/^d-[0-9a-f]{8}$/)
    expect(r.stdout).toContain('obligation')
  })

  it('a plain approve mints nothing', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const scenario = fakeScenario()
    putVerdict(scenario, { ...BLOCKING, findings: [] })
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve'])
    expect(readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'deferral')).toHaveLength(0)
  })
})

describe('open obligations reach the battery', () => {
  it('a minted obligation changes prompts_sha, so the next round cannot be cached', async () => {
    const repo = await atBound()
    const shaOf = () => (readStream(repo.root, 'auth-refresh-plan-1')
      .filter((e) => e.t === 'gate-run').at(-1) as unknown as { prompts_sha: string }).prompts_sha
    const before = shaOf()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    // NOT `--fresh`: that flag is refused on a gate an approve just settled
    // (`settled-approve`, gate.ts), so it invokes nothing and would prove nothing. The real
    // path is an ordinary re-gate on edited content — the approve reset the budget window,
    // so the bound no longer short-circuits either.
    await writePlan(repo, 'auth-refresh-plan-1', STEPS, '## Step: s1\nAfter override.\n')
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    expect(g.stdout, g.stderr).toContain('round 1 of 3')
    expect(shaOf()).not.toBe(before)
  })

  it('the block reaches the reviewer prompt itself, worded as a solicitation', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    await writePlan(repo, 'auth-refresh-plan-1', STEPS, '## Step: s1\nAfter override.\n')
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    // the fake reviewer records each invocation's prompt as claude-calls/call-N/{argv,stdin}
    const calls = readdirSync(join(scenario, 'claude-calls')).sort((a, b) =>
      Number(a.replace('call-', '')) - Number(b.replace('call-', '')))
    const last = join(scenario, 'claude-calls', calls.at(-1)!)
    const prompt = ['argv', 'stdin'].map((f) => readFileSync(join(last, f), 'utf8')).join('\n')
    expect(prompt).toContain('Open deferrals')
    expect(prompt).toContain('auth-refresh-plan-1 > ## Step: s1')
    expect(prompt).toMatch(/Silence is read as fixed/)
  })
})

describe('an obligation outlives its flow', () => {
  it('re-books onto the parent spec when the plan reaches done', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const id = (readStream(repo.root, 'auth-refresh-plan-1')
      .find((e) => e.t === 'deferral') as unknown as DeferralEntry).id

    // the merge stamp is what ends a flow: the plan carries a PR that github reports MERGED
    repo.setMeta('auth-refresh-plan-1', { status: 'in-progress', pr: 7 })
    const scenario = fakeScenario()
    ghState(scenario, 7, 'MERGED')
    await repo.cli(['status'], { env: gateEnv(scenario) })

    const planStream = readStream(repo.root, 'auth-refresh-plan-1')
    const specStream = readStream(repo.root, 'auth-refresh')
    expect(planStream.some((e) => e.t === 'deferral-moved' && e.id === id)).toBe(true)
    const moved = specStream.find((e) => e.t === 'deferral' && e.id === id) as unknown as DeferralEntry
    expect(moved).toBeDefined()
    expect(moved.moved_from).toBe('auth-refresh-plan-1')
    expect(openDeferrals(planStream)).toHaveLength(0)
    expect(openDeferrals(specStream).map((d) => d.id)).toEqual([id])
  })

  // The id is what makes age answerable across the move: a renumbered debt cannot be aged,
  // and age is the only thing separating a fresh deferral from a chronic one.
  it('preserves the id rather than minting a new one', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const id = (readStream(repo.root, 'auth-refresh-plan-1')
      .find((e) => e.t === 'deferral') as unknown as DeferralEntry).id
    repo.setMeta('auth-refresh-plan-1', { status: 'in-progress', pr: 8 })
    const scenario = fakeScenario()
    ghState(scenario, 8, 'MERGED')
    await repo.cli(['status'], { env: gateEnv(scenario) })
    const minted = readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'deferral')
    expect(minted.map((e) => e.id)).toEqual([id])
  })
})

describe('witness dismiss', () => {
  async function overridden() {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const id = (readStream(repo.root, 'auth-refresh-plan-1')
      .find((e) => e.t === 'deferral') as unknown as DeferralEntry).id
    return { repo, id }
  }

  it('closes an obligation by id with an enumerated cause', async () => {
    const { repo, id } = await overridden()
    const r = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', id,
      '--cause', 'lens-retired', '--note', 'plan-critic left the battery'])
    expect(r.code, r.stderr).toBe(0)
    expect(openDeferrals(readStream(repo.root, 'auth-refresh-plan-1'))).toHaveLength(0)
  })

  it('accepts the display index as well as the id', async () => {
    const { repo } = await overridden()
    const r = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', '1',
      '--cause', 'judged-wrong', '--note', 'the finding is wrong'])
    expect(r.code, r.stderr).toBe(0)
  })

  it('refuses without a cause, with the enum in want', async () => {
    const { repo } = await overridden()
    const r = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', '1', '--note', 'x'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('cause-required')
    expect(r.stderr).toContain('superseded')
  })

  it('refuses an unknown id and an already-closed one by name', async () => {
    const { repo, id } = await overridden()
    const bad = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', 'd-deadbeef',
      '--cause', 'superseded', '--note', 'x'])
    expect(bad.stderr).toContain('unknown-deferral')
    await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', id, '--cause', 'superseded', '--note', 'x'])
    const again = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', id, '--cause', 'superseded', '--note', 'x'])
    expect(again.stderr).toContain('already-dismissed')
  })

  it('refuses without a note', async () => {
    const { repo } = await overridden()
    const r = await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', '1', '--cause', 'superseded'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('note-required')
  })
})

describe('the ledger', () => {
  it('status lists open obligations aged in rounds, never in wall-clock', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const s = await repo.cli(['status'])
    expect(s.stdout).toContain('deferrals')
    expect(s.stdout).toContain('artifact-debt')
    expect(s.stdout).toContain('auth-refresh-plan-1 > ## Step: s1')
    expect(s.stdout).toMatch(/round\(s\)/)
    expect(s.stdout).not.toMatch(/days|weeks|ago/)
  })

  it('a dismissed obligation leaves the ledger', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    await repo.cli(['dismiss', 'auth-refresh-plan-1', '--deferral', '1',
      '--cause', 'judged-wrong', '--note', 'the lens was wrong'])
    expect((await repo.cli(['status'])).stdout).not.toContain('deferrals[')
  })

  it('next names an open obligation on the row that concerns it', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const n = await repo.cli(['next'])
    if (n.stdout.includes('auth-refresh-plan-1')) expect(n.stdout).toContain('deferral')
  })
})

describe('discharge by evidence', () => {
  it('a later run that no longer reports the anchor closes the obligation', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    expect(openDeferrals(readStream(repo.root, 'auth-refresh-plan-1'))).toHaveLength(1)

    await writePlan(repo, 'auth-refresh-plan-1', STEPS, '## Step: s1\nFixed.\n')
    const clean = fakeScenario()
    putVerdict(clean, {
      coverage: [
        { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
        { anchor: 'auth-refresh > ## Behavior', note: 'read' },
      ],
      findings: [],
    })
    const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(clean) })
    expect(g.stdout).toContain('discharged')
    expect(openDeferrals(readStream(repo.root, 'auth-refresh-plan-1'))).toHaveLength(0)
  })

  it('a run that still reports the anchor leaves it open', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    await writePlan(repo, 'auth-refresh-plan-1', STEPS, '## Step: s1\nStill broken.\n')
    const scenario = fakeScenario()
    putVerdict(scenario, BLOCKING)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    expect(openDeferrals(readStream(repo.root, 'auth-refresh-plan-1'))).toHaveLength(1)
  })

  // A malformed round judged NOTHING, so its silence is not evidence — the same reason it
  // does not spend the round budget (row 67).
  it('a malformed round discharges nothing', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    await writePlan(repo, 'auth-refresh-plan-1', STEPS, '## Step: s1\nUnjudged.\n')
    const bad = fakeScenario()
    putVerdict(bad, { coverage: [{ anchor: 'unscoped', note: 'read' }], findings: [] })
    const g = await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(bad) })
    expect(g.stdout).toContain('outcome: malformed')
    expect(openDeferrals(readStream(repo.root, 'auth-refresh-plan-1'))).toHaveLength(1)
  })
})

// D166. D122 moved a debt to the parent spec "which outlives it" — and a re-slice is the one
// event that ends the spec instead. The debt follows the content to the successor.
describe('an obligation follows its spec to the successor (D166)', () => {
  it('re-books onto the successor when its spec is re-sliced', async () => {
    const repo = await atBound()
    await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
    const id = (readStream(repo.root, 'auth-refresh-plan-1')
      .find((e) => e.t === 'deferral') as unknown as DeferralEntry).id
    repo.setMeta('auth-refresh-plan-1', { status: 'in-progress', pr: 9 })
    const scenario = fakeScenario()
    ghState(scenario, 9, 'MERGED')
    await repo.cli(['status'], { env: gateEnv(scenario) })            // merge: plan done, debt → auth-refresh
    expect((await writeSpec(repo, 'setup-card', {
      supersedes: 'auth-refresh', criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }],
    })).code).toBe(0)
    const old = readStream(repo.root, 'auth-refresh')
    expect(old.some((e) => e.t === 'deferral-moved' && e.id === id && e.to === 'setup-card')).toBe(true)
    expect(openDeferrals(old)).toHaveLength(0)
    const moved = readStream(repo.root, 'setup-card').find((e) => e.t === 'deferral' && e.id === id)
    expect(moved).toMatchObject({ artifact: 'setup-card', moved_from: 'auth-refresh' })
    const s = await repo.cli(['status'])
    expect(s.stdout).toContain(id)
    expect(s.stdout).toContain('moved from auth-refresh')
    expect((await repo.cli(['check'])).stdout).not.toContain('stranded-deferral')
  })
})

const S1 = 'auth-refresh-plan-1 > ## Step: s1'
const S2 = 'auth-refresh-plan-1 > ## Step: s2'
const STEPS2 = { steps: [{ id: 's1', title: 'rotate', criteria: ['ac-rotate'] }, { id: 's2', title: 'wire', scaffolding: true }] }
const two = (s1: string, s2 = 'Stable wiring.') => `## Step: s1\n${s1}\n\n## Step: s2\n${s2}\n`
const say = (...fs: Array<{ anchor: string; blocking: boolean }>) =>
  ({ coverage: BLOCKING.coverage, findings: fs.map((f) => ({ ...f, claim: 'x' })) })

// three blocking rounds at s1 → --approve --override: the obligation on s1 opens and the window resets
async function overriddenTwoSteps() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh'); approve(repo, 'auth-refresh')
  const scenario = fakeScenario(); putVerdict(scenario, BLOCKING)
  for (let i = 1; i <= 3; i++) {
    await writePlan(repo, 'auth-refresh-plan-1', STEPS2, two(`Attempt ${i}.`))
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
  }
  await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--approve', '--override'])
  const gate = async (planBody: string, verdict: unknown) => {
    await writePlan(repo, 'auth-refresh-plan-1', STEPS2, planBody)
    const s = fakeScenario(); putVerdict(s, verdict)
    return repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(s) })
  }
  return { repo, gate }
}
const open = (root: string) => openDeferrals(readStream(root, 'auth-refresh-plan-1'))

describe('a delta round discharges only what it was shown (C3)', () => {
  // Review Focus 3
  it('silence leaves an obligation in an unchanged section open', async () => {
    const { repo, gate } = await overriddenTwoSteps()
    await gate(two('After override.'), say({ anchor: S1, blocking: true }))           // round 1, full: still there
    const g = await gate(two('After override.', 'Rewired.'), say())                    // round 2, delta: s1 untouched
    expect(g.stdout).toContain('review: delta since round 1')
    expect(g.stdout).not.toContain('discharged')
    expect(open(repo.root)).toHaveLength(1)
  })

  it('guard: silence still discharges an obligation whose section changed', async () => {
    const { repo, gate } = await overriddenTwoSteps()
    await gate(two('After override.'), say({ anchor: S1, blocking: true }))
    const g = await gate(two('Fixed with a test first.'), say())
    expect(g.stdout).toContain('discharged')
    expect(open(repo.root)).toHaveLength(0)
  })

  it('guard: a reported non-blocking finding at the anchor keeps the obligation open in a delta round', async () => {
    const { repo, gate } = await overriddenTwoSteps()
    await gate(two('After override.'), say({ anchor: S1, blocking: false }, { anchor: S2, blocking: true }))
    await gate(two('Fixed.', 'Rewired.'), say({ anchor: S1, blocking: false }))
    const r2 = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'gate-run').at(-1) as unknown as GateRunEntry
    expect(r2.delta).toBeDefined()
    expect(open(repo.root)).toHaveLength(1)
  })
})
