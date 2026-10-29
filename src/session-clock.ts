// Row 210 (issue #58). A drive session's time is the time the host was awake.
//
// One `setTimeout(stop, sessionTimeoutMs)` measured the wrong thing wherever libuv's clock counts
// suspend: on Windows the issue's timer fired 10 s after a 9 h sleep, with about 24 s awake, and
// on macOS libuv reads `mach_continuous_time`, which counts sleep too (probed: `process.hrtime`
// equals the wall time since boot on a Mac that slept 28 h). Linux's `CLOCK_MONOTONIC` stands still
// in suspend, so there a sleep never reached the timer and leaves no late check (a reading). Nothing
// here depends on which: a check that fires more than SUSPEND_GAP_MS late slept through its
// lateness, on any platform. No check is armed for more than SESSION_TICK_MS, so a limit past
// 2^31 ms cannot overflow Node's timer and fire at once (P4), the bug `realClock.sleep` already
// slices around.
//
// Residual (C4): a drive event-loop stall longer than SUSPEND_GAP_MS also reads as sleep.

export const SESSION_TICK_MS = 1_000
export const SUSPEND_GAP_MS = 30_000

export interface Ticker { now(): number; after(ms: number, fn: () => void): () => void }

export const monotonicTicker: Ticker = {
  now: () => performance.now(),
  after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
}

export interface SessionClock { awakeMs(): number; stop(): void }

// Row 214: `tick` hears every check with the awake time, so what drive does once a second for a
// running session (its quiet line, its journal watch) runs on this one clock, in awake time.
export function sessionClock(
  limitMs: number, ticker: Ticker, on: { expire(): void; slept(ms: number): void; tick?(awakeMs: number): void },
): SessionClock {
  const t0 = ticker.now()
  let last = t0          // when the pending check was armed
  let wait = 0           // how far ahead of `last` it is due
  let asleep = 0
  let cancel: (() => void) | undefined
  let expired = false
  let frozen: number | undefined
  // The interval since the last check, accounted: lateness past the gap is sleep.
  const account = (now: number): number => {
    const late = now - last - wait
    if (late > SUSPEND_GAP_MS) { asleep += late; on.slept(late) }
    last = now
    return now - t0 - asleep
  }
  const arm = (awake: number) => {
    wait = Math.min(SESSION_TICK_MS, limitMs - awake)
    cancel = ticker.after(wait, check)
  }
  // The next check is armed before `tick` runs: a tick that threw would otherwise leave the
  // session with no limit at all, and one that stopped the clock cancels the check it armed.
  const check = () => {
    const awake = account(ticker.now())
    if (awake < limitMs) { arm(awake); on.tick?.(awake); return }
    expired = true
    cancel = undefined
    on.expire()
  }
  arm(0)
  return {
    awakeMs: () => frozen ?? ticker.now() - t0 - asleep,
    // Cancels the pending check and accounts its interval by the same rule, which catches a
    // sleep no check has seen yet (a session that ends right after the host wakes). After an
    // expiry nothing is pending, so it only freezes.
    stop() {
      if (frozen !== undefined) return
      cancel?.()
      frozen = expired ? ticker.now() - t0 - asleep : account(ticker.now())
    },
  }
}
