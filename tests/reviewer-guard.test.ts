import { beforeAll, describe, expect, it } from 'vitest'
import { approve, seededRepo, writeDesign, writeSpec, type TestRepo } from './helpers.js'

// Row 217. A reviewer reads; it never acts — whichever markers it carries.
let repo: TestRepo
beforeAll(async () => {
  repo = await seededRepo()
  await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
  approve(repo, 'booking-form')
  await writeDesign(repo, 'booking-form')
})

const MARKS = [{ WITNESS_REVIEWER: '1' }, { WITNESS_DRIVE: 'booking-form-plan-1', WITNESS_REVIEWER: '1' }, { WITNESS_DRIVE: '-', WITNESS_REVIEWER: '1' }]
const ACTS = [['decide', 'design', 'booking-form', '--approve'], ['gate', 'design', 'booking-form'], ['abandon', 'x'],
  ['review', 'design', 'booking-form'], ['status'], []]

describe('the reviewer guard (row 217)', () => {
  it.each(MARKS.flatMap((env) => ACTS.map((args) => [env, args] as const)))
    ('under %j a reviewer cannot run witness %j (issue #73)', async (env, args) => {
      const r = await repo.cli([...args], { env })
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('reviewer-cannot')
      expect(r.stdout).toBe('')
    })

  it.each([[['read', 'booking-form']], [['index']], [['log', 'booking-form']], [['--version']], [['decide', '--help']]])
    ('a reviewer may still read: witness %j (issue #73)', async (args) => {
      expect((await repo.cli(args, { env: MARKS[1]! })).code).toBe(0)
    })
})
