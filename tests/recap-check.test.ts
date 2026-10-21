import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ASK_STREAM, askQueue } from '../src/ask.js'
import { latestRecap, readStream, streamExists } from '../src/journal.js'
import { RECAP, autonomyOn, callCount, callFor, fakeScenario, gateEnv, nextLine, putVerdict, tmpRepo, type TestRepo } from './helpers.js'

const ASK = 'Guests can pay by card at checkout'
async function autonomous(on = true) {
  const repo = tmpRepo()
  await repo.cli(['init'])
  if (on) autonomyOn(repo)
  await repo.cli(['ask', ASK])
  const scenario = fakeScenario()
  return { repo, scenario, env: gateEnv(scenario) }
}
const recapFile = (repo: TestRepo, patch: Record<string, unknown> = {}) => {
  repo.write('r.json', JSON.stringify({ ...RECAP, ...patch }))
  return 'r.json'
}
const checks = (repo: TestRepo) => readStream(repo.root, ASK_STREAM).filter((e) => e.t === 'human-decision')

describe('the recap check (A9 · autonomy)', () => {
  it('accepts a recap whose class the arbiter decided and births its effort', async () => {
    const { repo, scenario, env } = await autonomous()
    putVerdict(scenario, { choice: 1, reason: 'class feature — card payment is new checkout behavior' }, 'arbiter')
    const r = await repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1'], { env })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('recap-check: accepted — check 1 of 3')
    expect(latestRecap(repo.root, 'auth-hardening')?.ask).toBe('a1')
    expect(checks(repo)).toMatchObject([{
      gate: 'recap', artifact: 'a1', round: 1, decision: 'approve', selected: 'arbiter', rule: 'recap-check',
      effort: 'auth-hardening', class: 'feature', decided: 'feature',
      reason: 'class feature — card payment is new checkout behavior',
      arbiter: { model: 'claude-fable-5', prompts_sha: expect.stringMatching(/^[0-9a-f]{64}$/) },   // init's gates.model pin
    }])
    const call = callFor(scenario, 'arbiter')!
    const stdin = readFileSync(join(call, 'stdin'), 'utf8')
    for (const s of ['# Recap check', '## The ask', `a1 — ${ASK}`, '"class": "feature"', '2. accept as fix', '## Canon index']) {
      expect(stdin).toContain(s)
    }
    expect(readFileSync(join(call, 'lock'), 'utf8').trim()).toBe('free')    // judged outside the lock (D76)
    expect((await repo.cli(['status'])).stdout).toContain('autonomous: policy 0 · arbiter 1')
  })

  it('an accept naming another class sends the recap back and births nothing', async () => {
    const { repo, scenario, env } = await autonomous()
    putVerdict(scenario, { choice: 1, reason: 'class feature — the ask adds a checkout screen' }, 'arbiter')
    const r = await repo.cli(['recap', '--file', recapFile(repo, { class: 'fix' }), '--ask', 'a1'], { env })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('recap-check: rejected — check 1 of 3')
    expect(r.stdout).toContain('class — the recap says fix and the check decided feature')
    expect(streamExists(repo.root, 'auth-hardening')).toBe(false)
    expect(checks(repo).at(-1)).toMatchObject({ decision: 'revise', rule: 'recap-class', class: 'fix', decided: 'feature' })
    const out = await nextLine(repo)
    expect(out).toContain('--ask a1')
    expect(out).toContain('recap check 1 of 3 rejected — class — the recap says fix and the check decided feature')
  })

  it('a reject carries the arbiter note to the next draft', async () => {
    const { repo, scenario, env } = await autonomous()
    putVerdict(scenario, { choice: 4, reason: 'class feature — misses refunds', note: 'add a goal for refunds' }, 'arbiter')
    const r = await repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1'], { env })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('note: add a goal for refunds')
    expect(r.stdout).toContain('next: witness recap --file <recap.json> --ask a1')
    expect(await nextLine(repo)).toContain('add a goal for refunds')
  })

  it('the third rejection parks the ask until a human answers it', async () => {
    const { repo, scenario, env } = await autonomous()
    putVerdict(scenario, { choice: 4, reason: 'class feature — misses refunds' }, 'arbiter')
    let r
    for (let i = 0; i < 3; i++) r = await repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1'], { env })
    expect(r!.stdout).toContain('recap-check: rejected — check 3 of 3 · the ask is parked')
    expect(r!.stdout).toContain('witness ask --withdraw a1')
    expect(askQueue(repo.root)[0]!.state).toBe('parked')
    expect(await nextLine(repo)).not.toContain('--ask a1')
    expect((await repo.cli(['status'])).stdout).toContain('a1,parked — 3 of 3 recap checks rejected')
    const again = await repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1'], { env })
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('ask-parked')
    expect((await repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1', '--manual'], { env })).code).toBe(0)
    expect(askQueue(repo.root)[0]!.state).toBe('answered')
    expect(callCount(scenario)).toBe(3)                         // --manual asked no arbiter
  })

  it('under autonomy a new effort needs an ask unless a human confirmed it', async () => {
    const { repo } = await autonomous()
    const r = await repo.cli(['recap', '--file', recapFile(repo)])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('ask-required')
    expect(r.stderr).toContain("help: a human's decision: ask-required")
    expect((await repo.cli(['recap', '--file', recapFile(repo), '--manual'])).code).toBe(0)
  })

  it('an amendment keeps the class its effort was born with', async () => {
    const { repo, scenario, env } = await autonomous()
    putVerdict(scenario, { choice: 1, reason: 'class feature — new checkout behavior' }, 'arbiter')
    await repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1'], { env })
    const flip = await repo.cli(['recap', '--amend', '--file', recapFile(repo, { class: 'fix' })], { env })
    expect(flip.code).toBe(2)
    expect(flip.stderr).toContain('class-change')
    expect(flip.stderr).toContain('feature → fix')
    const goals = [...RECAP.goals, { id: 'g2', text: 'Refunds reach the card' }]
    expect((await repo.cli(['recap', '--amend', '--file', recapFile(repo, { goals })], { env })).code).toBe(0)
    expect(callCount(scenario)).toBe(1)
  })

  it('with autonomy off no check runs', async () => {
    const { repo, scenario, env } = await autonomous(false)
    expect((await repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1'], { env })).code).toBe(0)
    expect(checks(repo)).toEqual([])
    expect(callCount(scenario)).toBe(0)
  })

  it('an arbiter that cannot be invoked refuses and journals nothing', async () => {
    const { repo, scenario, env } = await autonomous()
    writeFileSync(join(scenario, 'claude-fail-arbiter'), '')
    const r = await repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1'], { env })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('reviewer-invocation')
    expect(checks(repo)).toEqual([])
    expect(streamExists(repo.root, 'auth-hardening')).toBe(false)
  })

  it('an arbiter that answers malformed twice parks the ask once', async () => {
    const { repo, scenario, env } = await autonomous()
    putVerdict(scenario, 'no ruling here', 'arbiter')
    const r = await repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1'], { env })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('recap-check: parked — the arbiter answered malformed twice')
    expect(checks(repo)).toMatchObject([{ decision: 'stop', selected: 'policy', rule: 'arbiter-malformed' }])
    expect(askQueue(repo.root)[0]!.state).toBe('parked')
    expect(await nextLine(repo, { env })).not.toContain('--ask a1')
    expect(callCount(scenario)).toBe(2)                         // one ruling and its reroll · next asked nothing
  })
})

// Final review F2 · F3. The check is a model call outside the lock (D76), so everything the
// pre-lock checks read can change while it runs: the effort's stream, and a crashed writer's
// pending transaction. Both are read again under the lock.
describe('the recap check races (final review)', () => {
  it('two asks recapped onto one slug at once birth one effort (F2)', async () => {
    const { repo, scenario, env } = await autonomous()
    await repo.cli(['ask', 'Admins can export orders'])
    putVerdict(scenario, { choice: 1, reason: 'class feature — new behavior' }, 'arbiter')
    writeFileSync(join(scenario, 'claude-delay-arbiter'), '1')
    repo.write('r2.json', JSON.stringify(RECAP))
    const [a, b] = await Promise.all([
      repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1'], { env }),
      repo.cli(['recap', '--file', 'r2.json', '--ask', 'a2'], { env }),
    ])
    expect([a.code, b.code].sort()).toEqual([0, 2])
    expect([a.stderr, b.stderr].join('\n')).toContain('slug-reuse')
    expect(readStream(repo.root, 'auth-hardening').filter((e) => e.t === 'recap')).toHaveLength(1)
    expect(askQueue(repo.root).filter((x) => x.state === 'answered')).toHaveLength(1)
  })

  it('a transaction another writer left pending during the check refuses the write (F3)', async () => {
    const { repo, scenario, env } = await autonomous()
    putVerdict(scenario, { choice: 1, reason: 'class feature — new behavior' }, 'arbiter')
    writeFileSync(join(scenario, 'claude-delay-arbiter'), '1')
    const marker = join(repo.root, '.witness', 'txn.json')
    const crash = new Promise<void>((done) => setTimeout(() => {
      writeFileSync(marker, JSON.stringify({ op: 'ask(a2)', files: ['.witness/journal/asks.jsonl'] }))
      done()
    }, 300))
    const [r] = await Promise.all([repo.cli(['recap', '--file', recapFile(repo), '--ask', 'a1'], { env }), crash])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('pending transaction from a crashed invocation: ask(a2)')
    expect(existsSync(marker)).toBe(true)
    expect(streamExists(repo.root, 'auth-hardening')).toBe(false)
  })
})
