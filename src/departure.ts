import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CanonPaths } from './config.js'
import { deferralMoves } from './deferral.js'
import { designRel } from './design.js'
import { reservedId } from './ask.js'
import { splitDoc } from './fm.js'
import { adoptedCommits, lastWitnessed } from './adopt.js'
import { gitBlob, tryGit } from './gitio.js'
import { journalRel, readStream, type Entry, type EntryType, type StatusEntry } from './journal.js'
import { v, type Violation } from './refusal.js'
import { findById, type Canon, type CanonDoc } from './scan.js'
import { canonicalSha } from './sha.js'

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
  unwound: StatusEntry[]  // specs taken back on the way, because an abandoned effort created them
  rel: string             // the spec path it lands on: the path it left from
  by: string              // the successor its departure named: the re-slice this return takes back
}

// Whether an abandoned effort — or the one being abandoned — wrote this content of a spec (as it
// stands at revision `at`), and if so the commit that established it. The policy is the caller's
// (abandon.ts); the walk is here.
export type TakenBack = (id: string, sha: string, rel: string, at: string) => string | undefined

// The way back. Row 29 unwinds a write by selectively reverting its state commit, and a
// re-slice's commit did two things: it wrote the successor and departed its predecessor.
// Taking that write back therefore brings the predecessor back — its file and design as they
// stood before the commit, byte for byte, a status entry that ends the departure, and the
// obligations that had followed it to the successor. Without this, abandoning the effort that
// re-sliced a shipped spec left canon describing none of what had shipped, under an id no
// verb could use again.
//
// A return never lands content an abandoned effort wrote: that write is taken back too. An
// earlier abandon skips a spec a later re-slice had already departed, and one effort can
// re-slice its own re-slice, so the predecessor of the write being taken back may itself be
// work no live effort owns. The walk goes back past each such write — to the content before an
// amendment, or, past a create, to whatever that create had departed in its turn — so canon
// ends where it stood before every abandoned write, whatever order the efforts went in.
export function prepareReturns(root: string, paths: CanonPaths, commit: string, successor: string, takenBack: TakenBack = () => undefined): Return[] {
  return returnsThrough(root, paths, commit, [successor], [], takenBack, new Set([commit]))
}

function returnsThrough(
  root: string, paths: CanonPaths, commit: string, chain: string[], unwound: StatusEntry[], takenBack: TakenBack, seen: Set<string>,
): Return[] {
  const successor = chain.at(-1)!
  const shown = tryGit(root, 'show', '--no-renames', '--name-status', '--format=', commit)
  if (!shown.ok) return []
  const deleted = shown.out.split('\n').filter((l) => l.startsWith('D\t')).map((l) => l.slice(2))
  return deleted.flatMap((rel): Return[] => {
    if (!rel.startsWith(`${paths.specs}/`) || !rel.endsWith('.md')) return []
    let src = `${commit}^`
    let blob = gitBlob(root, src, rel)
    if (blob === undefined) return []
    let parsed = splitDoc(blob.toString('utf8'))
    if (!parsed.ok) return []
    const id = String(parsed.value.meta.id)
    const exit = canonExit(readStream(root, id))
    if (exit?.to !== 'superseded' || exit.by !== successor) return []
    let status = exit.from
    for (;;) {
      const back = takenBack(id, canonicalSha(parsed.value.meta, parsed.value.body), rel, src)
      if (back === undefined || seen.has(back)) break
      seen.add(back)
      const before = gitBlob(root, `${back}^`, rel)
      if (before === undefined) {
        // That write created it: it stays out, and what it had departed comes back instead.
        const gone: StatusEntry = { v: 1, t: 'status', artifact: id, from: 'superseded', to: 'removed', cause: 'abandon' }
        return returnsThrough(root, paths, back, [...chain, id], [...unwound, gone], takenBack, seen)
      }
      const prior = splitDoc(before.toString('utf8'))
      if (!prior.ok) break
      src = `${back}^`; blob = before; parsed = prior; status = String(prior.value.meta.status)
    }
    const bytes = blob
    const design = designRel(paths, id)
    const designBlob = deleted.includes(design) ? gitBlob(root, src, design) : undefined
    const put = (r: string, b: Buffer): void => {
      mkdirSync(dirname(join(root, r)), { recursive: true })   // git keeps no empty directory: a fresh clone may lack it
      writeFileSync(join(root, r), b)
    }
    return [{
      entry: { v: 1, t: 'status', artifact: id, from: 'superseded', to: status, cause: 'abandon' },
      files: [rel, ...(designBlob === undefined ? [] : [design]), journalRel(id)],
      restore: () => {
        put(rel, bytes)
        if (designBlob !== undefined) put(design, designBlob)
      },
      // Each link of the chain hands home the debts that came to it from the next one down.
      moves: chain.flatMap((s, k) => deferralMoves(readStream(root, s), s, id, (d) => d.moved_from === (chain[k + 1] ?? id))),
      unwound,
      rel,
      by: successor,
    }]
  })
}

// Whether a NEW artifact may take this id. An id names one artifact for the life of the repo,
// because its stream IS that artifact's history. Three streams already belong to something
// else: a superseded spec's (a successor owns its content, and its finished plans resolve their
// parent there), an effort's, and witness's own (`reservedId`: the floor pins and the ask queue). The one re-use is the same artifact
// again: a spec its own abandon unwound may be written again as a spec. A stream that records
// none of these — a stray, or a doc canon cannot parse — does not hold its id; the findings
// that already name it (`orphan-journal`, the parse error) are its remedy.
export function idRetired(root: string, id: string, type: string): Violation | undefined {
  const reserved = reservedId(id)
  if (reserved !== undefined) return v('id', 'id-taken', id, `a new id — ${id} is ${reserved}`)
  const entries = readStream(root, id)
  if (entries[0]?.t === 'recap') return v('id', 'id-taken', id, `a new id — ${id} is an effort's slug`)
  const exit = canonExit(entries)
  if (exit?.to === 'superseded') {
    return v('id', 'id-taken', id, `a new id — ${id} was superseded by ${exit.by ?? 'a successor'} and its stream is that spec's lineage`)
  }
  if (exit?.to === 'removed' && type !== 'spec') return v('id', 'id-taken', id, `a new id — ${id} was a spec its abandon unwound`)
  return undefined
}

// D167. Whether a doc under this id may land on this path, which was last witnessed (by a
// trailer, or by an `adopt` that absolved the commit) under `prior`. A superseded spec comes back
// to the path it left from, so its departure holds that path as it holds the id. Any other id
// left a path only by hand, since `rename` keeps the file: the path is held only while the doc
// on it is what `prior` became — an in-place id change, which is `rename` done by hand. A
// removal, a `prior` living at another path, or a path left empty holds nothing: nothing lands back.
export function pathRetired(root: string, canon: Canon, rel: string, id: string): Violation | undefined {
  const prior = lastWitnessed(root, rel, adoptedCommits(root))?.id
  if (prior === undefined || prior === id) return undefined
  const exit = canonExit(readStream(root, prior))
  if (exit?.to === 'superseded') {
    return v('id', 'path-taken', rel, `a new id — ${rel} is where ${prior} comes back if the re-slice that superseded it is taken back`)
  }
  const elsewhere = findById(canon, prior)
  if (exit !== undefined || (elsewhere !== undefined && elsewhere.rel !== rel) || !existsSync(join(root, rel))) return undefined
  return v('id', 'path-taken', rel, `the id it was witnessed under — ${rel} held ${prior} · witness rename is how an id changes`)
}
