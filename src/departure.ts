import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonPaths } from './config.js'
import { deferralMoves } from './deferral.js'
import { designRel } from './design.js'
import { splitDoc } from './fm.js'
import { gitBlob, tryGit } from './gitio.js'
import { journalRel, readStream, type Entry, type EntryType, type StatusEntry } from './journal.js'
import { findById, type Canon, type CanonDoc } from './scan.js'

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

export interface Departure {
  entry: StatusEntry      // journaled on the spec's own stream; it stays the stream's last status entry
  files: string[]         // every state path the departure touches: the spec, its design, its stream
  remove: () => void      // unlinks what leaves canon with the spec
}

// What leaves canon WITH a spec. Its design is spec-scoped (row 69) and goes with it: the
// re-slice always deleted it, while the unwind left a ui spec's look behind in canon after the
// spec it described was gone. A design is listed only when present, because a state commit
// cannot stage a path that never existed.
export function prepareDeparture(root: string, paths: CanonPaths, spec: CanonDoc, entry: StatusEntry): Departure {
  const design = designRel(paths, String(spec.meta.id))
  const leaving = [spec.rel, ...(existsSync(join(root, design)) ? [design] : [])]
  return {
    entry,
    files: [...leaving, journalRel(String(spec.meta.id))],
    remove: () => { for (const rel of leaving) unlinkSync(join(root, rel)) },
  }
}

export interface Return {
  entry: StatusEntry      // superseded → the status it left with, cause abandon: the departure ends
  files: string[]         // its spec file, its design when it had one, its stream
  restore: () => void     // writes the departed bytes back
  moves: Array<{ stream: string; entry: { t: EntryType; [k: string]: unknown } }>   // its debts, home again
}

// The way back. Row 29 unwinds a write by selectively reverting its state commit, and a
// re-slice's commit did two things: it wrote the successor and departed its predecessor.
// Taking that write back therefore brings the predecessor back — its file and design as they
// stood before the commit, byte for byte, a status entry that ends the departure, and the
// obligations that had followed it to the successor. Without this, abandoning the effort that
// re-sliced a shipped spec left canon describing none of what had shipped, under an id no
// verb could use again.
export function prepareReturns(root: string, paths: CanonPaths, commit: string, successor: string): Return[] {
  const shown = tryGit(root, 'show', '--no-renames', '--name-status', '--format=', commit)
  if (!shown.ok) return []
  const deleted = shown.out.split('\n').filter((l) => l.startsWith('D\t')).map((l) => l.slice(2))
  return deleted.flatMap((rel): Return[] => {
    if (!rel.startsWith(`${paths.specs}/`) || !rel.endsWith('.md')) return []
    const blob = gitBlob(root, `${commit}^`, rel)
    if (blob === undefined) return []
    const parsed = splitDoc(blob.toString('utf8'))
    if (!parsed.ok) return []
    const id = String(parsed.value.meta.id)
    const exit = canonExit(readStream(root, id))
    if (exit?.to !== 'superseded' || exit.by !== successor) return []
    const design = designRel(paths, id)
    const designBlob = deleted.includes(design) ? gitBlob(root, `${commit}^`, design) : undefined
    return [{
      entry: { v: 1, t: 'status', artifact: id, from: 'superseded', to: exit.from, cause: 'abandon' },
      files: [rel, ...(designBlob === undefined ? [] : [design]), journalRel(id)],
      restore: () => {
        writeFileSync(join(root, rel), blob)
        if (designBlob !== undefined) writeFileSync(join(root, design), designBlob)
      },
      moves: deferralMoves(readStream(root, successor), successor, id, (d) => d.moved_from === id),
    }]
  })
}
