import { describe, expect, it } from 'vitest'
import { SESSION_TICK_MS, SUSPEND_GAP_MS, sessionClock, type Ticker } from '../src/session-clock.js'

// A host the test drives: `run` lets time pass awake, firing each check as it falls due; `sleep`
// moves the clock with nothing firing, as a suspended host does, so the next check fires late.
function host(): Ticker & { run(ms: number): void; sleep(ms: number): void; armed: number[] } {
  let now = 0
  const due: Array<{ at: number; fn: () => void; live: boolean }> = []
  const armed: number[] = []
  return {
    armed,
    now: () => now,
    after: (ms, fn) => { armed.push(ms); const t = { at: now + ms, fn, live: true }; due.push(t); return () => { t.live = false } },
    run(ms) {
      const end = now + ms
      for (;;) {
        const next = due.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        next.live = false
        now = Math.max(now, next.at)
        next.fn()
      }
      now = end
    },
    sleep(ms) { now += ms },
  }
}
const HOUR = 3_600_000
function clock(limit: number) {
  const h = host()
  const slept: number[] = []
  let expired = 0
  const c = sessionClock(limit, h, { expire: () => { expired += 1 }, slept: (ms) => slept.push(ms) })
  return { h, c, slept, expired: () => expired }
}

describe('sessionClock (row 210, issue #58)', () => {
  // Row 214: drive's quiet line and journal watch run on this clock's check, in awake time. The
  // next check is armed first, so a tick that throws never costs the session its limit.
  it('ticks with the awake time, after re-arming (issue #64)', () => {
    const h = host()
    const ticks: Array<[number, number]> = []
    sessionClock(10_000, h, { expire: () => {}, slept: () => {}, tick: (awake) => ticks.push([awake, h.armed.length]) })
    h.run(3_000)
    expect(ticks).toEqual([[1000, 2], [2000, 3], [3000, 4]])
  })

  it('a check later than SUSPEND_GAP_MS is sleep: the limit and awakeMs skip it', () => {
    const { h, c, slept, expired } = clock(60_000)
    h.run(5_000); h.sleep(9 * HOUR); h.run(1_000)
    expect(slept).toEqual([9 * HOUR - 1_000])
    expect(c.awakeMs()).toBe(7_000)
    h.run(52_000); expect(expired()).toBe(0)
    h.run(1_000); expect(expired()).toBe(1)
  })
  it('a hung session on an awake host stops at the limit', () => {
    const { h, slept, expired } = clock(HOUR)
    h.run(HOUR - 1); expect(expired()).toBe(0)
    h.run(1); expect(expired()).toBe(1)
    expect(slept).toEqual([])
  })
  it('lateness under SUSPEND_GAP_MS is awake time', () => {
    const { h, slept, expired } = clock(10_000)
    h.run(2_000); h.sleep(SUSPEND_GAP_MS - 5_000); h.run(0)
    expect([slept, expired()]).toEqual([[], 1])
  })
  it('a short limit stops on time, and once', () => {
    const { h, expired } = clock(100)
    h.run(99); expect(expired()).toBe(0)
    h.run(1); expect(expired()).toBe(1)
    h.run(10_000); expect(expired()).toBe(1)
  })
  // Review Focus 2
  it('stop() counts a sleep no check has seen yet, then freezes', () => {
    const { h, c, slept, expired } = clock(60_000)
    h.run(3_000); h.sleep(9 * HOUR); c.stop()
    expect([slept, c.awakeMs()]).toEqual([[9 * HOUR - 1_000], 4_000])
    h.run(HOUR)
    expect([expired(), c.awakeMs()]).toEqual([0, 4_000])
  })
  it('arms no timer past SESSION_TICK_MS, whatever the limit (P4)', () => {
    const { h } = clock(2 ** 31 + 1)
    h.run(5_000)
    expect(Math.max(...h.armed)).toBeLessThanOrEqual(SESSION_TICK_MS)
  })
})
