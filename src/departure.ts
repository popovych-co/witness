import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readStream, type Entry, type StatusEntry } from './journal.js'
import { findById, type Canon } from './scan.js'

// D166. A spec leaves canon through exactly two verbs — the re-slice (row 62), which
// journals `superseded` and names the successor, and abandon's unwind of a spec its own
// effort created (row 29), which journals `removed`. This module is the one home for that
// act: how a departure is read, what it takes out of canon, how it is taken back, and which
// ids it retires. What may still point INTO a departing spec is settled by the two verbs
// that depart one.

// The status entry with which an artifact LEFT canon, if a witness verb took it out: the
// stream's LATEST status entry, when it is a departure. Latest, not any — a departure taken
// back, or a removed spec written again, is followed by a later status and reads as present.
// Callers consult canon first: this answers only for an id that canon no longer holds.
export function canonExit(entries: Entry[]): StatusEntry | undefined {
  const last = entries.filter((e) => e.t === 'status').at(-1) as unknown as StatusEntry | undefined
  return last !== undefined && (last.to === 'superseded' || last.to === 'removed') ? last : undefined
}

// Every stream whose artifact left canon. An obligation recorded there is still open until it
// is dismissed (D122), so the ledger reads these streams too.
export function departedStreams(root: string, canon: Canon): string[] {
  const dir = join(root, '.witness', 'journal')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length))
    .filter((id) => !findById(canon, id) && canonExit(readStream(root, id)) !== undefined)
}
