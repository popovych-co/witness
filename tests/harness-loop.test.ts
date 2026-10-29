import { expect, it } from 'vitest'
import { fakeClock, tmpRepo } from './helpers.js'

// The suite's harness never holds its vitest worker's event loop: an in-process CLI run and a
// fake sleep each yield it, as a real process and a real sleep do. Without that, a test that
// chains them never lets the worker read vitest's RPC replies, and a reply unread for 60 s
// fails the whole run with `Timeout calling "onTaskUpdate"` while every test is green —
// measured: 100–130 s single stretches, and one such error per stretch past 60 s.
it('an in-process CLI run gives the event loop a turn', async () => {
  const repo = tmpRepo()
  let turned = false
  setImmediate(() => { turned = true })
  await repo.cli(['--version'])
  expect(turned).toBe(true)
})

it('a fake sleep gives the event loop a turn', async () => {
  let turned = false
  setImmediate(() => { turned = true })
  await fakeClock(0).sleep(1)
  expect(turned).toBe(true)
})
