import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { addOrigin, fakeScenario, tmpRepo } from '../../tests/helpers.js'

it('makes a repo, its origin and a fake scenario', () => {
  const repo = tmpRepo()
  repo.write('seed.md', 'seed\n')
  repo.git('add', 'seed.md')
  repo.git('commit', '-m', 'seed')
  addOrigin(repo)
  writeFileSync(join(fakeScenario(), 'claude-trace'), 'start 1\nclaim 1 1\n')
  if (process.env.SCRATCH_LIFE === 'fail') expect.fail('deliberate')
})
