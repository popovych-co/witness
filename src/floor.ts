import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { journalRel } from './journal.js'
import { compareTriple } from './version.js'

// Row 116. The state's own answer to "what is the oldest CLI allowed to touch this
// repository", derived from the `w` stamps entryLine writes and stored nowhere. Derived
// because a stored floor is a second source of truth that drifts from the entries it
// summarises — the shape rows 93, 95 and 96 all name — and because a derived one cannot
// be lowered by editing a file, only by a journaled decision (verbs/floor.ts).
//
// MAXIMUM, not most-recent: a downgraded CLI writing a lower stamp after a higher one is
// exactly the event this guards against, and a floor that fell to the last writer would
// ratify the regression it exists to refuse.
//
// `undefined` means the state carries no readable stamp at all — every repository written
// before this row shipped. It is silence, not zero: a floor of 0.0.0 would be a claim the
// state never made, and it would refuse nothing anyway.
export function stateFloor(root: string): { pin: string; stream: string } | undefined {
  const dir = join(root, '.witness', 'journal')
  if (!existsSync(dir)) return undefined

  // An explicit decision outranks the derived maximum — including downward, which is the
  // only reason the verb exists. Latest wins, so a second rollback supersedes the first:
  // the last decision is the state, the same doctrine D94 applies to gate decisions.
  const pinned = entries(root, FLOOR_STREAM)
    .filter((e) => e.t === 'policy-pin' && e.key === FLOOR_KEY && typeof e.pin === 'string')
    .at(-1)
  if (pinned !== undefined) return { pin: pinned.pin as string, stream: 'a human decision' }

  let best: { pin: string; stream: string } | undefined
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const stream = file.slice(0, -'.jsonl'.length)
    for (const e of entries(root, stream)) {
      if (typeof e.w !== 'string') continue
      const pin = e.w
      // `compareTriple(pin, pin)` is the parse check: undefined means CANNOT COMPARE, the
      // same contract install.ts's two guards read it under. A stamp we cannot read must
      // never raise a bound — that would refuse a legal CLI over a typo.
      if (compareTriple(pin, pin) === undefined) continue
      if (best === undefined || (compareTriple(pin, best.pin) ?? 0) > 0) best = { pin, stream }
    }
  }
  return best
}

// The journal stream a floor decision lives in. Its first entry is a policy-pin, never a
// recap, so `effortStreams` does not mistake it for an effort.
export const FLOOR_STREAM = 'floor'
export const FLOOR_KEY = 'floor'

// Deliberately NOT journal.ts's readStream, whose bare JSON.parse throws. This runs on
// EVERY verb now, so one unreadable line would brick the whole CLI — including `floor`
// itself, the one verb that could unstick it. readStream's strict parse stays right for
// callers that need the entry; a bound derived from stamps needs only the lines it can
// actually read, and skipping the rest is the honest reading of a damaged file.
function entries(root: string, stream: string): Array<Record<string, unknown>> {
  const path = join(root, journalRel(stream))
  if (!existsSync(path)) return []
  const out: Array<Record<string, unknown>> = []
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw === '') continue
    try {
      out.push(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      // a line we cannot parse carries no decision and no stamp we can trust — the same
      // answer as a line that never had one
    }
  }
  return out
}
