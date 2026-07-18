import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  approve, fakeScenario, gateEnv, putVerdict, seededRepo, witnessDesign, writeDesign, writeSpec, DESIGN_HTML,
} from './helpers.js'

const CLEAN = {
  coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'auth-refresh > ## Behavior', note: 'r' }],
  findings: [],
}

async function gatedRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh', { ui: true })
  approve(repo, 'auth-refresh')
  await writeDesign(repo, 'auth-refresh')
  await witnessDesign(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })
  return repo
}

const specText = (repo: { root: string }) =>
  readFileSync(join(repo.root, 'specs/auth-refresh.md'), 'utf8')

describe('design-unseen at decide', () => {
  it('approves when the gated artifact is the one that was shown', async () => {
    const repo = await gatedRepo()

    const res = await repo.cli(['decide', 'design', 'auth-refresh', '--approve'])

    expect(res.code).toBe(0)
    expect(specText(repo)).toContain('design:')
  })

  it('refuses approve when the artifact was re-authored after being shown', async () => {
    const repo = await gatedRepo()
    // re-register different bytes WITHOUT re-showing — sight is keyed to the old sha
    await writeDesign(repo, 'auth-refresh', DESIGN_HTML.replace('save-bar', 'save-bar-v2'))

    const res = await repo.cli(['decide', 'design', 'auth-refresh', '--approve'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('design-unseen')
    expect(res.stderr).toContain('--open')
    expect(specText(repo)).not.toContain('design:')          // no stamp was written
  })

  it('holds at the round bound, where the gate no longer runs', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)

    // ROUND_BOUND is 3 (rounds.ts:80) — spend all three without approving, so the gate
    // refuses to run again and only the endgame decisions remain reachable
    // vary the artifact's TEXT, never its ids — renaming an id makes the verdict's
    // `design#save-bar` anchor unresolvable, which malforms the round for reasons that
    // have nothing to do with sight (and two malformed rounds trip the streak guard)
    for (let i = 0; i < 3; i++) {
      await writeDesign(repo, 'auth-refresh', DESIGN_HTML.replace('Bookings', `Bookings r${i}`))
      await witnessDesign(repo, 'auth-refresh')
      const gate = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })
      expect(gate.code).toBe(1)
      await repo.cli(['decide', 'design', 'auth-refresh', '--revise', '--note', `round ${i}`])
    }
    // fresh bytes, shown — otherwise the gate short-circuits on resume/changed-nothing
    // (gate.ts:166,170) before it ever reaches the bound check at :176
    await writeDesign(repo, 'auth-refresh', DESIGN_HTML.replace('Bookings', 'Bookings bound'))
    await witnessDesign(repo, 'auth-refresh')
    const blocked = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(scenario) })
    expect(blocked.stdout).toContain('round bound reached')

    // re-author WITHOUT showing: the gate can no longer be the thing that catches it
    await writeDesign(repo, 'auth-refresh', DESIGN_HTML.replace('Bookings', 'Bookings final'))

    const res = await repo.cli(['decide', 'design', 'auth-refresh', '--approve', '--override'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('design-unseen')
  })

  it('does not block --stop or --revise — only approve stamps', async () => {
    const repo = await gatedRepo()
    await writeDesign(repo, 'auth-refresh', DESIGN_HTML.replace('save-bar', 'save-bar-v4'))

    const res = await repo.cli(['decide', 'design', 'auth-refresh', '--revise', '--note', 'fix the bar'])

    expect(res.code).toBe(0)
  })

  it('leaves non-design gates untouched', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'r' }], findings: [] })
    await repo.cli(['gate', 'decompose', repo.effort], { env: gateEnv(scenario) })

    const res = await repo.cli(['decide', 'decompose', repo.effort, '--approve'])

    expect(res.code).toBe(0)
  })
})
