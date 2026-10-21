import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { approve, autonomyOn, fakeScenario, gateEnv, nextLine, putVerdict, seededRepo, witnessDesign, writeDesign, writeSpec } from './helpers.js'

const CLEAN = { coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'auth-refresh > ## Behavior', note: 'r' }], findings: [] }
async function registered() {
  const repo = await seededRepo()
  autonomyOn(repo)
  await writeSpec(repo, 'auth-refresh', { ui: true })
  approve(repo, 'auth-refresh')
  await writeDesign(repo, 'auth-refresh')                       // registered · never opened
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  return { repo, env: gateEnv(scenario) }
}

describe('design under autonomy (A6)', () => {
  it('next routes an unopened look to its gate', async () => {
    const { repo } = await registered()
    const out = await nextLine(repo)
    expect(out).toContain('next: witness gate design auth-refresh')
    expect(out).not.toContain('--open')
  })
  it('the critic runs on a look nobody opened · --manual keeps the precondition', async () => {
    const { repo, env } = await registered()
    const manual = await repo.cli(['gate', 'design', 'auth-refresh', '--manual'], { env })
    expect(manual.code).toBe(2)
    expect(manual.stderr).toContain('design-unseen')
    const gate = await repo.cli(['gate', 'design', 'auth-refresh'], { env })
    expect(gate.stderr).not.toContain('design-unseen')
    expect(readStream(repo.root, 'auth-refresh').some((e) => e.t === 'gate-run')).toBe(true)
  })
  it('the human opens the look before approving it', async () => {
    const { repo, env } = await registered()
    await repo.cli(['gate', 'design', 'auth-refresh'], { env })  // clean → the kept stop
    const out = await nextLine(repo)
    expect(out).toContain('witness decide design auth-refresh --show')
    expect(out).toContain('kept-stop: design look — the human opens the look with witness design auth-refresh --open · then approves it or sends a note — witness decide design auth-refresh --show')
    const blind = await repo.cli(['decide', 'design', 'auth-refresh', '--approve'])
    expect(blind.code).toBe(2)
    expect(blind.stderr).toContain('design-unseen')
    await witnessDesign(repo, 'auth-refresh')
    expect((await repo.cli(['decide', 'design', 'auth-refresh', '--approve'])).code).toBe(0)
  })
})
