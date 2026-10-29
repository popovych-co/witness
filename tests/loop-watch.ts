import { afterEach, beforeEach } from 'vitest'

// vitest's worker RPC rejects any reply it has not READ in 60 s, and a test that holds its
// worker's event loop that long fails the run with an error that names no test
// (`Timeout calling "onTaskUpdate"`). The harness yields (tests/harness-loop.test.ts); this
// names a test that holds the loop anyway, so the next such error comes with its cause. It
// warns and never fails: a slow machine must not turn it into a flake of its own.
const TICK_MS = 1000
const WARN_MS = 30_000
const g = globalThis as { __loopWatch?: { last: number; worst: number } }
if (!g.__loopWatch) {
  const w = (g.__loopWatch = { last: Date.now(), worst: 0 })
  setInterval(() => {
    const now = Date.now()
    w.worst = Math.max(w.worst, now - w.last - TICK_MS)
    w.last = now
  }, TICK_MS).unref()
}
const w = g.__loopWatch

beforeEach(() => {
  w.last = Date.now()
  w.worst = 0
})

afterEach((ctx) => {
  const held = Math.max(w.worst, Date.now() - w.last - TICK_MS)
  if (held >= WARN_MS) {
    console.warn(`loop-watch: "${ctx.task.name}" held its worker's event loop ${Math.round(held / 1000)} s — vitest's worker RPC times out at 60 s; await child processes (helpers.ts spawnAsync) rather than chaining sync ones`)
  }
})
