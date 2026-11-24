import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fakeScenario, fakeTrails } from './helpers.js'

// What a failing test prints under a kept fake scenario's `scratch kept:` line (tests/scratch.ts).
it('a fake scenario\'s trails name each fake bin that ran, and only its own', () => {
  const other = fakeScenario()
  writeFileSync(join(other, 'claude-trace'), 'start 1\nclaim 1 1\n')
  const dir = fakeScenario()
  expect(fakeTrails(dir)).toBe('')
  writeFileSync(join(dir, 'claude-trace'), 'start 7\nclaim 7 1\nend 7 1\n')
  writeFileSync(join(dir, 'pi-trace'), 'start 8\n')
  expect(fakeTrails(dir)).toBe(
    `fake claude trail · ${join(dir, 'claude-trace')}\nstart 7\nclaim 7 1\nend 7 1\n`
    + `fake pi trail · ${join(dir, 'pi-trace')}\nstart 8`,
  )
})
