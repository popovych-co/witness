import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { worktreePath } from '../src/worktree.js'
import {
  SPEC_META, TOKEN_BROKEN, TOKEN_FIXED, approve, autonomyOn, commitEntry, evidenceCycle, fakeScenario, fixtureEnv, fixturePath,
  gateEnv, nextLine, putVerdict, seededRepo, shippableRepo, singleConfig, stampLive, startedThreeStepPlan, untaggedRed,
  witnessDesign, writeDesign, writeSpec, writePlan, type TestRepo, patchConfig, trustConfig,
} from './helpers.js'

describe('witness next — the ladder', () => {
  it('walks recap → write → gate decompose → decide → plan-stage', async () => {
    const repo = await seededRepo({ noRecap: true })
    expect(await nextLine(repo)).toContain('witness recap')

    await repo.cli(['recap', '--file', repo.writeRecap({})])
    expect(await nextLine(repo)).toContain('--effort auth-hardening')

    await writeSpec(repo, 'auth-refresh')
    expect(await nextLine(repo)).toContain('gate decompose --effort auth-hardening')

    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
    await repo.cli(['gate', 'decompose', 'auth-hardening'], { env: gateEnv(scenario) })  // feature → stop
    expect(await nextLine(repo)).toContain('decide decompose auth-hardening --show')

    await repo.cli(['decide', 'decompose', 'auth-hardening', '--approve'])
    const out = await nextLine(repo)
    expect(out).toContain('stage: plan')
    expect(out).toContain('auth-refresh')
  })

  it('walks plan gate → start → implement stage → implement gate → ship', async () => {
    const repo = await seededRepo()
    trustConfig(repo)
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    expect(await nextLine(repo)).toContain('gate plan auth-refresh-plan-1')

    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect(await nextLine(repo)).toContain('start auth-refresh-plan-1')

    await repo.cli(['start', 'auth-refresh-plan-1'])
    const out = await nextLine(repo)                       // no evidence yet
    expect(out).toContain('stage: implement')
    expect(out).toContain(`home: ${repo.root}/.witness/worktrees/auth-refresh-plan-1`)
  })

  it('implement and ship rows carry home: and run: for the session handoff', async () => {
    const { repo, planId } = await shippableRepo()
    // implement-gate row: belongs in the worktree
    const out = await nextLine(repo)
    expect(out).toContain(`gate implement ${planId}`)
    expect(out).toContain(`home: ${repo.root}/.witness/worktrees/${planId}`)
    // row 193: the implement gate states its model, and that pin drives the worker it hands off to
    expect(out).toContain(`run: cd '${repo.root}/.witness/worktrees/${planId}' && claude --model claude-opus-5-5 '/witness'`)
  })

  it('renders the handoff and relay for the resolved harness', async () => {
    const { repo, planId } = await shippableRepo()
    const wt = `${repo.root}/.witness/worktrees/${planId}`

    const cc = await nextLine(repo, { env: { CLAUDECODE: '1' } })
    expect(cc).toContain(`run: cd '${wt}' && claude --model claude-opus-5-5 '/witness'`)
    expect(cc).toContain('relay: /clear then /witness')

    const pi = await nextLine(repo, { env: { PI_CODING_AGENT: 'true' } })
    expect(pi).toContain(`run: cd '${wt}' && pi --model anthropic/claude-opus-5-5 '/witness'`)
    expect(pi).toContain('relay: /new then /witness')
  })

  it('carries the implement-stage pin into the Pi handoff, provider-qualified', async () => {
    const { repo, planId } = await shippableRepo()
    patchConfig(repo, { gates: { implement: { model: 'claude-opus-5' } } })
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'pin implement model')
    const wt = `${repo.root}/.witness/worktrees/${planId}`

    const pi = await nextLine(repo, { env: { PI_CODING_AGENT: 'true' } })
    expect(pi).toContain(`run: cd '${wt}' && pi --model anthropic/claude-opus-5 '/witness'`)

    const cc = await nextLine(repo, { env: { CLAUDECODE: '1' } })
    expect(cc).toContain(`run: cd '${wt}' && claude --model claude-opus-5 '/witness'`)
  })

  it('refuses an unknown harness rather than printing an unrunnable handoff', async () => {
    const { repo } = await shippableRepo()
    patchConfig(repo, { harness: 'pikachu' })
    const r = await repo.cli(['next'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown-harness')
    expect(r.stderr).toContain('claude-code | pi')
  })

  it('gates every draft plan before any approved plan starts (plans-first)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-mfa')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-mfa-plan-1', {
      parent: 'auth-mfa',
      steps: [{ id: 's1', title: 'mfa step', criteria: ['ac-mfa'] }],
    })
    await writePlan(repo, 'auth-refresh-plan-1')
    // the alphabetically-first plan is already approved; its sibling is still draft —
    // stage-major order gates the draft before anything starts
    repo.flipStatus('auth-mfa-plan-1', 'approved')
    const out = await nextLine(repo)
    expect(out).toContain('gate plan auth-refresh-plan-1')
    expect(out).not.toContain('start')
  })

  it('after evidence: implement gate; after implement passes: ship', async () => {
    const { repo, planId } = await shippableRepo()
    expect(await nextLine(repo)).toContain(`gate implement ${planId}`)
    const scenario = fakeScenario()
    // vitest-single fixture lands 4 changed files — coverage-minimum needs an anchor per each
    putVerdict(scenario, {
      coverage: [
        { anchor: '.gitignore', note: 'read' },
        { anchor: 'package.json', note: 'read' },
        { anchor: 'src/token.ts', note: 'read' },
        { anchor: 'tests/token.test.ts', note: 'read' },
      ],
      findings: [],
    })
    await repo.cli(['gate', 'implement', planId], { env: gateEnv(scenario) })
    expect(await nextLine(repo)).toContain(`ship ${planId}`)
  })

  it('a bound-stuck gate with no pending decision surfaces as the next action', async () => {
    const { repo, planId } = await shippableRepo()
    for (const round of [1, 2, 3]) {
      appendEntry(repo.root, planId, {
        v: 1, t: 'gate-run', gate: 'implement', artifact: planId, round,
        run_id: `r-${round}`, reviewed_sha: `sha-${round}`, prompts_sha: 'p', witness: '0',
        model: 'm', checks: [], verdicts: [], outcome: 'stopped',
      })
      // Every round revises: under D124 a `stop` SETTLES its gate, so a stopped gate is
      // parked and no longer surfaces as a bound endgame at all. This test is about the
      // bound row, so the setup must leave the gate live — the stop here was a no-op that
      // happened to work only while `--stop` was inert.
      appendEntry(repo.root, planId, {
        v: 1, t: 'human-decision', gate: 'implement', artifact: planId, round,
        decision: 'revise',
      })
    }
    const out = await nextLine(repo)
    expect(out).toContain(`decide implement ${planId}`)
    expect(out).toContain('bound')
    expect(out).not.toContain('test-evidence')
  })
})

describe('design stage routing', () => {
  it('routes an approved ui spec to the design stage before planning', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    const res = await repo.cli(['next'])
    expect(res.stdout).toContain('witness design booking-form')
    expect(res.stdout).toContain('stage: design')
  })

  it('routes to the design gate once an artifact exists', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form')
    await writeDesign(repo, 'booking-form')
    await witnessDesign(repo, 'booking-form')          // registered AND shown → the gate is next
    const res = await repo.cli(['next'])
    expect(res.stdout).toContain('witness gate design booking-form')
  })

  it('a non-ui approved spec still routes straight to plan', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    const res = await repo.cli(['next'])
    expect(res.stdout).toContain('write auth-refresh-plan-1')
  })
})

// D100: the owed phase is a DERIVATION, not a human choice — row 85's rule (a
// placeholder is honest only where the CLI cannot know the answer). `--phase red|green`
// was not runnable, and an agent following `next` faithfully never learned that `ship`
// had been available all along.
//
// Row 191: a plan whose progress is known routes by step until every step is closed (the block
// below), so these tests pin the evidence row on a legacy plan, whose rows are today's. Its flow
// carries a red an older CLI journaled: untagged, and vacuous, as a red recorded after the
// implementation is.
describe('the evidence row names the phase it wants', () => {
  async function startedFlow(): Promise<{ repo: TestRepo; wt: string }> {
    const repo = await seededRepo()
    writeFileSync(join(repo.root, 'witness.config.yaml'), singleConfig('filtered'))
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'runner config')
    trustConfig(repo)
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    await repo.cli(['start', 'auth-refresh-plan-1'])
    commitEntry(repo, 'auth-refresh-plan-1', untaggedRed('auth-refresh-plan-1', true))
    return { repo, wt: worktreePath(repo.root, 'auth-refresh-plan-1') }
  }

  it('asks for the red phase by name on an empty worktree', async () => {
    const { repo } = await startedFlow()
    const out = await nextLine(repo)
    expect(out).toContain('--phase red')
    expect(out).not.toContain('red|green')
    expect(out).toContain('note: nothing changed yet — write the failing test first')
  })

  it('prefers verify-red when the implementation is already written', async () => {
    const { repo, wt } = await startedFlow()
    cpSync(fixturePath('vitest-single'), wt, { recursive: true, filter: (s) => !s.includes('node_modules') })
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
    const out = await nextLine(repo)
    expect(out).toContain('witness verify-red auth-refresh-plan-1')
  })

  it('names the tags whose evidence is owed', async () => {
    const { repo, wt } = await startedFlow()
    cpSync(fixturePath('vitest-single'), wt, { recursive: true, filter: (s) => !s.includes('node_modules') })
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
    expect(await nextLine(repo)).toContain('evidence owed: auth-refresh')
  })
})

// Row 191 · Plan's call 5. With no step input, `next` routed a three-step plan to `gate implement`
// once the parent tag had one red→green pair, so every mid-plan relay's fresh session gated
// early. While the plan's progress is known and no implement gate has run, the work is the next
// unfinished step.
describe('next routes the next unfinished plan step', () => {
  const lines = async (repo: TestRepo, wt: string): Promise<string[]> => (await nextLine(repo, { cwd: wt })).split('\n')

  it('routes a fresh known plan to its first step', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    const out = await lines(repo, wt)
    expect(out).toContain(`next: witness test-evidence ${planId} --phase red --step s1`)
    expect(out).toContain('stage: implement')
    expect(out).toContain('note: steps 0/3 done · next s1')
  })

  it('routes the green of an open red', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    const red = await repo.cli(['test-evidence', planId, '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(red.code).toBe(0)
    expect(await lines(repo, wt)).toContain(`next: witness test-evidence ${planId} --phase green --step s1`)
  })

  // The implementation written first, a plain red only comes back vacuous again, and `next`
  // would answer with the same line twice. A genuine red then opens the cycle, and the green row
  // stands even if a later red comes back vacuous.
  it('routes a step whose red came back vacuous to verify-red until a genuine red opens its cycle', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    const red = (s: string) => repo.cli(['test-evidence', planId, '--phase', 'red', '--step', s], { cwd: wt, env: fixtureEnv() })
    expect((await evidenceCycle(repo, wt, planId, 's1')).code).toBe(0)
    expect((await red('s2')).code).toBe(1)                       // TOKEN_FIXED still in place
    const out = await lines(repo, wt)
    expect(out).toContain(`next: witness verify-red ${planId} --step s2`)
    expect(out).toContain('stage: implement')
    expect(out).toContain('note: steps 1/3 done · next s2 · its red was vacuous — verify-red reconstructs it against the base')

    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    expect((await red('s2')).code).toBe(0)
    expect(await lines(repo, wt)).toContain(`next: witness test-evidence ${planId} --phase green --step s2`)
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
    expect((await red('s2')).code).toBe(1)
    expect(await lines(repo, wt)).toContain(`next: witness test-evidence ${planId} --phase green --step s2`)
  })

  it('routes a scaffolding step to step-close', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    expect((await evidenceCycle(repo, wt, planId, 's1')).code).toBe(0)
    expect((await evidenceCycle(repo, wt, planId, 's2')).code).toBe(0)
    const out = await lines(repo, wt)
    expect(out).toContain(`next: witness step-close ${planId} --step s3`)
    expect(out).toContain('note: steps 2/3 done · next s3')
  })

  it('routes to the implement gate once every step is closed', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    expect((await evidenceCycle(repo, wt, planId, 's1')).code).toBe(0)
    expect((await evidenceCycle(repo, wt, planId, 's2')).code).toBe(0)
    expect((await repo.cli(['step-close', planId, '--step', 's3'], { cwd: wt })).code).toBe(0)
    expect(await lines(repo, wt)).toContain(`next: witness gate implement ${planId}`)
  })

  // Every step closed, then a red re-recorded for s1: the evidence owed before the first implement
  // gate is still a step's, so the row names the latest tagged red's step, not the last step's.
  it("names the latest tagged red's step on the evidence row once every step is closed", async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    expect((await evidenceCycle(repo, wt, planId, 's1')).code).toBe(0)
    expect((await evidenceCycle(repo, wt, planId, 's2')).code).toBe(0)
    expect((await repo.cli(['step-close', planId, '--step', 's3'], { cwd: wt })).code).toBe(0)
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    const red = await repo.cli(['test-evidence', planId, '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(red.code).toBe(0)
    const out = await lines(repo, wt)
    expect(out).toContain(`next: witness test-evidence ${planId} --phase green --step s1`)
    expect(out).toContain('note: evidence owed: auth-refresh green')
  })

  // A plan whose spec's criteria an earlier plan already realized carries no criteria step: one
  // scaffolding step, started.
  async function noCriteriaStep(): Promise<{ repo: TestRepo; wt: string; P: string }> {
    const repo = await seededRepo()
    writeFileSync(join(repo.root, 'witness.config.yaml'), singleConfig('filtered'))
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'runner config')
    trustConfig(repo)
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    const P = 'auth-refresh-plan-2'
    const w = await writePlan(repo, P, { steps: [{ id: 's1', title: 'tidy', scaffolding: true }] }, '## Step: s1\nTidy.\n')
    expect(w.code, w.stderr).toBe(0)
    repo.flipStatus(P, 'approved')
    expect((await repo.cli(['start', P])).code).toBe(0)
    return { repo, wt: worktreePath(repo.root, P), P }
  }

  // No cycle of such a plan is a step's: the evidence its diff owes runs untagged, and the CLI
  // takes it.
  it('takes a plan with no criteria step through untagged evidence to the implement gate', async () => {
    const { repo, wt, P } = await noCriteriaStep()
    cpSync(fixturePath('vitest-single'), wt, { recursive: true, filter: (s) => !s.includes('node_modules') })

    expect(await lines(repo, wt)).toContain(`next: witness step-close ${P} --step s1`)
    expect((await repo.cli(['step-close', P, '--step', 's1'], { cwd: wt })).code).toBe(0)
    const routed = (await lines(repo, wt)).find((l) => l.startsWith('next: '))
    expect(routed).toBe(`next: witness verify-red ${P}`)
    const run = await repo.cli(['verify-red', P], { cwd: wt, env: fixtureEnv() })   // the routed line
    expect(run.code, run.stderr).toBe(0)
    expect(await lines(repo, wt)).toContain(`next: witness gate implement ${P}`)
  })

  // D192. Every step of such a plan is scaffolding, so with nothing changed yet its work is the
  // change. The note says nothing of a red: this plan is no chore, and once tagged tests land it can
  // still owe one (the test above).
  it('tells a plan with no criteria step and nothing changed to make its change', async () => {
    const { repo, wt, P } = await noCriteriaStep()
    expect((await repo.cli(['step-close', P, '--step', 's1'], { cwd: wt })).code).toBe(0)
    expect(await lines(repo, wt)).toContain('note: nothing changed yet — make the change · every step of this plan is scaffolding')
  })

  // Step routing holds until the first implement gate: after it an untagged cycle is a fix round
  // and the plan's steps are behind it, so a known plan with a step left unclosed gets the rows below
  // step routing, here the gate's, as before row 191.
  it('keeps the rows below step routing once an implement gate has run', async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    expect((await evidenceCycle(repo, wt, planId, 's1')).code).toBe(0)
    commitEntry(repo, planId, {
      t: 'gate-run', gate: 'implement', artifact: planId, round: 1, run_id: 'r-1', reviewed_sha: 'sha-before',
      prompts_sha: 'p', witness: '0', model: 'm', checks: [], verdicts: [], outcome: 'passed',
    })
    const out = await lines(repo, wt)
    expect(out.find((l) => l.startsWith('next: '))).toBe(`next: witness gate implement ${planId}`)
    expect(out).not.toContain('stage: implement')
    expect(out.filter((l) => l.startsWith('note: steps'))).toEqual([])
  })

  it("keeps today's rows for a legacy plan", async () => {
    const { repo, wt, planId } = await startedThreeStepPlan()
    commitEntry(repo, planId, untaggedRed(planId))
    const out = await lines(repo, wt)
    expect(out).toContain(`next: witness test-evidence ${planId} --phase green`)
    expect(out).toContain('note: evidence owed: auth-refresh green')
  })
})

// Row 105: the flip is not exempted — it spends a round out of three on content nobody
// edited — so the CLI names it.
describe('a judge that changes mid-flow is named', () => {
  // A round that already ran, journaled under claude-code. Fabricated the way this
  // file's bound-stuck test fabricates rounds, because every REAL route to a
  // `gate implement` row that has a prior round behind it disposes of that round first
  // (approve → the ship row, revise → the authoring row). A passed round whose sha has
  // since moved is exactly the state D75 re-arms — the one this note annotates.
  function ranUnder(repo: TestRepo, planId: string, harness?: string): void {
    appendEntry(repo.root, planId, {
      v: 1, t: 'gate-run', gate: 'implement', artifact: planId, round: 1,
      run_id: 'r-1', reviewed_sha: 'sha-before', prompts_sha: 'p', witness: '0',
      model: 'm', checks: [], verdicts: [], outcome: 'passed',
      ...(harness !== undefined ? { harness } : {}),
    })
  }

  it('names a judge that changed since the last round', async () => {
    const { repo, planId } = await shippableRepo()
    ranUnder(repo, planId)
    patchConfig(repo, { harness: 'pi' })   // row 193: the judge moves only by its declaration
    const out = await nextLine(repo, { env: { PI_CODING_AGENT: 'true' } })
    expect(out).toContain('judge changed — round')
    expect(out).toContain('claude-code')
    expect(out).toContain('pi judges now')
  })

  it('says nothing when the judge is the one that ran the last round', async () => {
    const { repo, planId } = await shippableRepo()
    ranUnder(repo, planId)
    const out = await nextLine(repo, { env: { CLAUDECODE: '1' } })
    expect(out).not.toContain('judge changed')
  })

  // A note explains a row; it never decides whether the row prints. The driver refusal
  // below already covers this config with the accurate message.
  it('an unresolvable judge costs the note, not the verb', async () => {
    const { repo, planId } = await shippableRepo()
    ranUnder(repo, planId)
    patchConfig(repo, { harness: 'pikachu' })
    const r = await repo.cli(['next'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown-harness')
    expect(r.stdout).not.toContain('judge changed')
  })
})

describe('next — a satisfy is no content change (A10)', () => {
  it('a satisfy on a live spec with a done plan queues no new plan', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, needs: [{ id: 'sbx', manual: 'Stripe sandbox account created', satisfied: false }] })
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    expect(await nextLine(repo)).not.toContain('witness write auth-refresh-plan-2')
    expect((await repo.cli(['satisfy', 'auth-refresh', '--need', 'sbx'])).code).toBe(0)
    expect(await nextLine(repo)).not.toContain('witness write auth-refresh-plan-2')
  })
})

describe('next — a plan that waits on a need (A10)', () => {
  const DEVICE = [{ id: 'device', manual: 'a test device on the desk', satisfied: false }]
  it('starts the approved plan no need blocks', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-mfa')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', needs: DEVICE, steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-mfa-plan-1', 'approved')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect(await nextLine(repo)).toContain('next: witness start auth-refresh-plan-1')
  })
  it('names the kept stop when every approved plan waits on a need', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1', { needs: DEVICE })
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    const out = await nextLine(repo)
    expect(out).toContain('next: witness start auth-refresh-plan-1')
    expect(out).toContain('auth-refresh-plan-1 waits on an unmet need — a human runs witness satisfy auth-refresh-plan-1 --need device')
    const start = await repo.cli(['start', 'auth-refresh-plan-1'])
    expect(start.code).toBe(2)
    expect(start.stderr).toContain('a human runs witness satisfy auth-refresh-plan-1 --need device')
    expect(start.stderr).toContain("help: a human's decision: needs-unmet")
    expect(start.stderr).not.toContain('run: witness satisfy')
    autonomyOn(repo)
    expect((await repo.cli(['start', 'auth-refresh-plan-1'])).stdout)
      .toContain('kept-stop: unmet need — a test device on the desk · witness satisfy auth-refresh-plan-1 --need device')
  })
})

describe('next — a plan that waits on an env need (final review F4)', () => {
  it('starts the approved plan whose env need is met', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-mfa')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', needs: [{ env: 'WITNESS_TEST_UNSET_VAR' }], steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-mfa-plan-1', 'approved')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect(await nextLine(repo)).toContain('next: witness start auth-refresh-plan-1')
  })
  it('names the unset variable when every approved plan waits', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1', { needs: [{ env: 'WITNESS_TEST_UNSET_VAR' }] })
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect(await nextLine(repo)).toContain('auth-refresh-plan-1 waits on an unmet need — WITNESS_TEST_UNSET_VAR unset')
  })
})
