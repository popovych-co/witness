import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fakeScenario } from './helpers.js'
import { scenariosMade, trailsSince } from './scenarios.js'

it('collects the trails of the scenarios made since a point, and only those', () => {
  const before = fakeScenario()
  writeFileSync(join(before, 'claude-trace'), 'start 1\nclaim 1 1\n')
  const from = scenariosMade.length
  const dir = fakeScenario()
  writeFileSync(join(dir, 'claude-trace'), 'start 7\nclaim 7 1\nend 7 1\n')
  writeFileSync(join(dir, 'pi-trace'), 'start 8\n')
  const text = trailsSince(from)
  expect(text).toContain(`fake claude trail · ${join(dir, 'claude-trace')}\nstart 7\nclaim 7 1\nend 7 1`)
  expect(text).toContain(`fake pi trail · ${join(dir, 'pi-trace')}\nstart 8`)
  expect(text).not.toContain('start 1')
  expect(trailsSince(scenariosMade.length)).toBe('')
})
