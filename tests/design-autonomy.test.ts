import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { DESIGN_HTML, approve, autonomyOn, fakeScenario, gateEnv, nextLine, putVerdict, seededRepo, witnessDesign, writeDesign, writeSpec } from './helpers.js'

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

describe('design under autonomy (A6, row 194)', () => {
  it('under autonomy next routes an unopened look to --open', async () => {
    const { repo } = await registered()
    const out = await nextLine(repo)
    expect(out).toContain('next: witness design auth-refresh --open')
    expect(out).toContain('stage: design')
  })
  it('under autonomy the critic refuses a look nobody opened', async () => {
    const { repo, env } = await registered()
    const gate = await repo.cli(['gate', 'design', 'auth-refresh'], { env })
    expect(gate.code).toBe(2)
    expect(gate.stderr).toContain('design-unseen')
    expect(readStream(repo.root, 'auth-refresh').some((e) => e.t === 'gate-run' && e.gate === 'design')).toBe(false)
  })
  it('a clean opened look under autonomy waits as the design look stop', async () => {
    const { repo, env } = await registered()
    await witnessDesign(repo, 'auth-refresh')
    await repo.cli(['gate', 'design', 'auth-refresh'], { env })  // clean → the kept stop
    const out = await nextLine(repo, { env })                     // gateEnv clears CI: settling never runs under CI (A1)
    expect(out).toContain('kept-stop: design look — the human approves the screen or sends a note — witness decide design auth-refresh --show')
    expect(out).not.toContain('opens the look')
  })
  it('the human opens the look before approving it', async () => {
    const { repo, env } = await registered()
    await witnessDesign(repo, 'auth-refresh')
    await repo.cli(['gate', 'design', 'auth-refresh'], { env })  // clean → the kept stop
    await writeDesign(repo, 'auth-refresh', DESIGN_HTML.replace('New service', 'New booking'))   // re-authored · never opened
    const blind = await repo.cli(['decide', 'design', 'auth-refresh', '--approve'])
    expect(blind.code).toBe(2)
    expect(blind.stderr).toContain('design-unseen')
    await witnessDesign(repo, 'auth-refresh')
    await repo.cli(['gate', 'design', 'auth-refresh'], { env })
    expect((await repo.cli(['decide', 'design', 'auth-refresh', '--approve'])).code).toBe(0)
  })
})
