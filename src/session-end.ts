import type { WorkerStream } from './worker-stream.js'

// Row 245 (issue #80). A session ends when its turn ends, not when its process exits. A pi worker
// whose extension leaks a handle lives on after `agent_settled` (P5), and drive held its target
// until the timeout: in the issue two finished sessions sat idle for 1 h 20 min and 35 min.
//
// The end watch times what the stream says (src/worker-stream.ts). Once the harness's end signal
// stands, a grace of END_GRACE_MS runs, in awake time on the session's clock (row 210). Only a
// record that starts a run cancels it, by clearing the stream's end, and the next settle arms it
// again. Non-JSON stdout, stderr and records about the session never cancel it, or a leaky
// extension that logs would hold the session for good (P17). The watch only says what is due; the
// caller stops the session and records it. Its timeout keeps running throughout (P28).
//
// A watch given `neverStartedMs` also ends a session whose stream shows no run-starting record
// within that much awake time of its spawn: drive's pi sessions, whose missing key or expired
// login leaves only a header while a startup handle leaks (P31, P49). A pi record of a type the
// stream does not know counts as a start, so a pi release that renames its events never trips it
// (S4-C, row 214).
//
// The watch is read from a pipe listener and from the clock's timer, where a throw takes drive down
// and leaves the session running unwatched (P16). So it never throws: a stream that cannot answer
// reads as not ended and started, and the timeout alone holds.

// A constant, not a setting, on row 202's precedent (the issue asked for `drive.exitGraceMs`).
export const END_GRACE_MS = 60_000

export type EndCause = 'turn-ended' | 'never-started'

export interface EndWatch {
  heard(awakeMs: number): void                 // a stdout record was read: start or cancel the grace
  due(awakeMs: number): EndCause | undefined   // what ends the session now, if anything
  graceRunning(): boolean                      // the end signal stands and its grace runs
}

export function endWatch(stream: WorkerStream, o: { neverStartedMs?: number }): EndWatch {
  const ended = (): boolean => {
    try {
      return stream.ended() === true
    } catch {
      return false
    }
  }
  const started = (): boolean => {
    try {
      return stream.started() !== false
    } catch {
      return true
    }
  }
  let graceFrom: number | undefined            // awake time the standing end signal was heard at
  return {
    heard(awakeMs) {
      if (!ended()) graceFrom = undefined
      else graceFrom ??= awakeMs
    },
    // The end signal answers whether the run ended, so while a grace runs only it can fall due.
    due(awakeMs) {
      if (graceFrom !== undefined) return awakeMs - graceFrom >= END_GRACE_MS ? 'turn-ended' : undefined
      if (o.neverStartedMs !== undefined && awakeMs >= o.neverStartedMs && !started()) return 'never-started'
      return undefined
    },
    graceRunning: () => graceFrom !== undefined,
  }
}

// The stream's error flag as it stands now. Drive and the reviewer read it when they send the
// watch's stop and keep it, so what a harness writes in reaction to SIGTERM (an aborted answer, an
// error result, a second envelope) is no part of the turn it ended (S4-A). Read from the clock's
// timer, so it never throws either: a stream that cannot answer reads as no error.
export function failedNow(stream: WorkerStream): boolean {
  try {
    return stream.failed() === true
  } catch {
    return false
  }
}

// Row 245 (P46). The status a harness gives the ending of a session or a reviewer's attempt the
// watch stopped, never the stop's own (null, SIGTERM's 143, or exit 1 from a Windows job kill): 1
// for a run that never started; 1 when the harness is not pi and the turn's last answer was an
// error, as claude exits 1 after an error result or envelope; else 0, since pi's JSON mode exits
// 0 on an error answer too, which the error flag carries (row 214). `failed` is failedNow's, read
// at the stop.
export function endingStatus(harness: string, cause: EndCause, failed: boolean): number {
  return cause === 'never-started' || (harness !== 'pi' && failed) ? 1 : 0
}

// How a session the watch ended went, for the drive log's `ended` line (row 214's, amended): the
// grace's stop, or the deadline's when it fell inside the grace, keeping row 214's ` (error)`.
// The never-started window is drive's SESSION_QUIET_MS (5 min); tests/drive-turn-end.test.ts
// holds this copy to it.
export function endedHow(cause: EndCause, atDeadline: boolean, failed: boolean): string {
  if (cause === 'never-started') return 'never started · stopped after 5m'
  const stop = atDeadline ? 'at the deadline' : `after ${END_GRACE_MS / 1000}s`
  return `turn ended · the process did not exit — stopped ${stop}${failed ? ' (error)' : ''}`
}
