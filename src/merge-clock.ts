import { TRAILER, tryGit } from './gitio.js'

// Row 254. The merge clock: where each plan's merge and each effort's birth sit in the order of
// witness's own state commits — the journal carries no timestamps, and blaming every stream costs
// seconds where one `git log` costs milliseconds. Read only by the track record (decision 8: never
// by a gate). `merged`: plan id → the position of its first merge stamp; `born`: effort slug → the
// position of its first recap commit; `merges`: every merge position, ascending.
export interface MergeClock {
  merged: ReadonlyMap<string, number>
  born: ReadonlyMap<string, number>
  merges: readonly number[]
}

// The subjects are witness's own (src/stamp.ts, src/verbs/recap.ts), and the trailer tells them from
// a human's look-alike. A transaction completed by `recover` commits its subject with ` (recovered)`
// after it. An amendment (`recap(<slug>) --amend: …`) or a cause (`cause(<slug>): …`) never matches.
const MERGE = /^merge\(([a-z0-9][a-z0-9-]*)\): pr #\d+(?: \(recovered\))?$/
const BIRTH = /^recap\(([a-z0-9][a-z0-9-]*)\): (?:feature|fix|chore)\b/

// Undefined when `git log` fails. Lines split on CRLF too: a history written on Windows.
export function mergeClock(root: string): MergeClock | undefined {
  const log = tryGit(root, 'log', '--reverse', '--date-order', `--grep=^${TRAILER}$`, '--format=%s')
  if (!log.ok) return undefined
  const merged = new Map<string, number>()
  const born = new Map<string, number>()
  log.out.split(/\r?\n/).forEach((subject, at) => {
    const m = MERGE.exec(subject)
    if (m && !merged.has(m[1]!)) merged.set(m[1]!, at)
    const b = BIRTH.exec(subject)
    if (b && !born.has(b[1]!)) born.set(b[1]!, at)
  })
  return { merged, born, merges: [...merged.values()].sort((a, b) => a - b) }
}

// The merges strictly between two positions — an escape's age, counted in merges.
export function mergesBetween(clock: MergeClock, after: number, before: number): number {
  return clock.merges.filter((at) => at > after && at < before).length
}
