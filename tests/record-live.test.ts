import { describe, expect, it } from 'vitest'
import type { TestcaseOutcomes } from '../src/criteria.js'
import { appendEntry } from '../src/journal.js'
import { liveFold } from '../src/record.js'
import { loadCanon } from '../src/scan.js'
import { approve, seededRepo, stampLive, writeSpec, type TestRepo } from './helpers.js'

// Row 254. The live-specs fold: each live spec read by its latest drift run. A testcase counts as
// failing only when it failed in that run and the run before it (the debounce); a red that names no
// failing testcase could not verify, and is never failing and never passing. Runs written before
// row 251 carry no outcomes and are not measured.

const OUT = (o: Partial<TestcaseOutcomes>): TestcaseOutcomes => ({ passed: 0, skipped: 0, failed: 0, failing: [], ...o })
let runs = 0
const drift = (repo: TestRepo, spec: string, ok: boolean, outcomes?: TestcaseOutcomes) =>
  appendEntry(repo.root, spec, {
    t: 'drift-check', run_id: `r-${String(++runs).padStart(8, '0')}`, artifact: spec, artifact_sha: 'x', ok, tags: 0, criteria: [],
    ...(outcomes ? { outcomes } : {}),
  })
const red = (...failing: string[]) => OUT({ failed: failing.length, failing })
const green = OUT({ passed: 2 })

async function liveSpecs(...ids: string[]): Promise<TestRepo> {
  const repo = await seededRepo()
  for (const id of ids) {
    const r = await writeSpec(repo, id, { criteria: [{ id: 'ac-rotate', test: `@spec:${id}` }] })
    if (r.code !== 0) throw new Error(r.stderr)
    approve(repo, id)
    stampLive(repo, id)
  }
  return repo
}
const fold = (repo: TestRepo) => liveFold(repo.root, loadCanon(repo.root))

describe('the live-specs fold (row 254)', () => {
  it('drift runs without outcomes read not measured', async () => {
    const repo = await liveSpecs('auth-refresh')
    drift(repo, 'auth-refresh', false)
    drift(repo, 'auth-refresh', true)
    expect(fold(repo)).toEqual({ measured: false, specs: 0, failing: [], couldNotVerify: [], unconfirmed: [] })
  })

  it('a testcase failing in the last two runs is failing; failing once is unconfirmed', async () => {
    const repo = await liveSpecs('auth-refresh', 'billing')
    drift(repo, 'auth-refresh', false, red('b rotates', 'a issues'))
    drift(repo, 'auth-refresh', false, red('a issues', 'b rotates', 'c new'))
    drift(repo, 'billing', true, green)
    drift(repo, 'billing', false, red('x charges'))
    expect(fold(repo)).toEqual({ measured: true, specs: 2,
      failing: [{ spec: 'auth-refresh', tests: ['a issues', 'b rotates'] }], couldNotVerify: [], unconfirmed: ['billing'] })
  })

  it.each([
    ['0 tagged, or no suite', OUT({})],
    ['every tagged case skipped', OUT({ skipped: 14 })],
    ['the tests passed and a cmd failed', OUT({ passed: 84 })],
  ])('a red with no named failure could not verify (%s)', async (_case, outcomes) => {
    const repo = await liveSpecs('auth-refresh')
    drift(repo, 'auth-refresh', false, outcomes)
    drift(repo, 'auth-refresh', false, outcomes)
    expect(fold(repo)).toEqual({ measured: true, specs: 1, failing: [], couldNotVerify: ['auth-refresh'], unconfirmed: [] })
  })

  it('a newer run that could not verify hides an older failure', async () => {
    const repo = await liveSpecs('auth-refresh')
    drift(repo, 'auth-refresh', false, red('a issues'))
    drift(repo, 'auth-refresh', false, red('a issues'))
    drift(repo, 'auth-refresh', false, OUT({}))
    expect(fold(repo)).toMatchObject({ failing: [], couldNotVerify: ['auth-refresh'], unconfirmed: [] })
  })

  it('two reds that share no failing test are unconfirmed, and so is a red after an unmeasured run', async () => {
    const repo = await liveSpecs('auth-refresh', 'billing')
    drift(repo, 'auth-refresh', false, red('a issues'))
    drift(repo, 'auth-refresh', false, red('b rotates'))
    drift(repo, 'billing', false)
    drift(repo, 'billing', false, red('x charges'))
    expect(fold(repo)).toMatchObject({ failing: [], unconfirmed: ['auth-refresh', 'billing'] })
  })

  it('only live specs count, each by its latest run', async () => {
    const repo = await liveSpecs('auth-refresh')
    const r = await writeSpec(repo, 'drafted', { criteria: [{ id: 'ac-rotate', test: '@spec:drafted' }] })
    if (r.code !== 0) throw new Error(r.stderr)
    approve(repo, 'drafted')
    drift(repo, 'drafted', false, red('d one'))
    drift(repo, 'drafted', false, red('d one'))
    drift(repo, 'auth-refresh', false, red('a issues'))
    drift(repo, 'auth-refresh', true, green)
    expect(fold(repo)).toEqual({ measured: true, specs: 1, failing: [], couldNotVerify: [], unconfirmed: [] })
  })
})
