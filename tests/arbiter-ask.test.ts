import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RECAP, autonomyOn, callFor, fakeScenario, gateEnv, putVerdict, tmpRepo, writeSpec } from './helpers.js'

it('the decompose arbiter reads the ask its effort answers', async () => {
  const repo = tmpRepo()
  await repo.cli(['init'])
  autonomyOn(repo)
  const scenario = fakeScenario()
  const env = gateEnv(scenario)
  putVerdict(scenario, { choice: 1, reason: 'class feature — rotation is new behavior' }, 'arbiter')
  putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] }, 'slicing-critic')
  await repo.cli(['ask', 'Refresh tokens rotate before they expire'])
  repo.write('r.json', JSON.stringify(RECAP))
  expect((await repo.cli(['recap', '--file', 'r.json', '--ask', 'a1'], { env })).code).toBe(0)
  await writeSpec(repo, 'auth-refresh')
  await repo.cli(['gate', 'decompose', 'auth-hardening'], { env })   // feature scope: a standing stop → the arbiter
  const stdin = readFileSync(join(callFor(scenario, 'arbiter')!, 'stdin'), 'utf8')
  expect(stdin).not.toContain('# Recap check')                        // the decompose call, not the recap check
  expect(stdin).toContain('## The ask')
  expect(stdin).toContain('a1 — Refresh tokens rotate before they expire')
  expect(stdin.indexOf('## Scope')).toBeLessThan(stdin.indexOf('## The ask'))
})
