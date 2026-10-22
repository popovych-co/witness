import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import { canonExit, prepareDeparture, prepareReturns, takeBack, type Departure, type Return, type TakenBack, type WriteAct } from './departure.js'
import { designRel } from './design.js'
import { splitDoc } from './fm.js'
import { canonicalSha } from './sha.js'
import { gitBlob, tryGit, stateCommit } from './gitio.js'
import { acquireLock } from './lock.js'
import { crashPoint, withTxn } from './txn.js'
import { appendEntry, effortAbandoned, effortStreams, entryLine, journalActs, journalRel, readStream, type Entry, type EntryType, type StatusEntry } from './journal.js'
import { findById, plansOn, type Canon, type CanonDoc } from './scan.js'
import { humanCall, ok, refuse, v, type Result, type Violation } from './refusal.js'
import { prepareStamp, writeStamp, type PreparedStamp } from './stamp.js'
import { kv } from './toon.js'
import { removeWorktree, worktreePath } from './worktree.js'

const isWrite = (e: Entry, id: string, sha?: string): boolean => {
  const w = e as unknown as { t: string; artifact?: string; sha?: string }
  return w.t === 'write' && w.artifact === id && (sha === undefined || w.sha === sha)
}
const isAncestor = (root: string, a: string, b: string): boolean => tryGit(root, 'merge-base', '--is-ancestor', a, b).ok

// D189. Of two commits, the later: by ancestry, and on parallel branches — where neither is an
// ancestor, as after a merge of two clones' journals — by commit time.
function later(root: string, a: string, b: string): string {
  if (isAncestor(root, a, b)) return b
  if (isAncestor(root, b, a)) return a
  const time = (c: string): number => Number(tryGit(root, 'log', '-1', '--format=%ct', c).out) || 0
  return time(b) > time(a) ? b : a
}

// D168. The act this content of a spec is, as history stood at `at`: the newest write of it, by
// whichever effort made it. Rows 29 and 84 resolved a pin by walking the spec's path for matching
// content, and content is not an act: a return or another abandon's restore brings the same content
// back under a later commit, whose parent was never the write's — so an amendment read as a create
// and was deleted, and a create restored another effort's abandoned amendment. And the same bytes
// written again later, by another effort, are that effort's: who may take them back is the
// caller's question, asked of this answer.
export function writeAct(root: string, id: string, sha: string, at = 'HEAD'): WriteAct | undefined {
  let found: WriteAct | undefined
  for (const effort of effortStreams(root)) {
    if (!readStream(root, effort).some((e) => isWrite(e, id, sha))) continue
    for (const { entry, commit } of journalActs(root, effort, at)) {
      if (!isWrite(entry, id, sha)) continue
      if (found === undefined || later(root, found.commit, commit) === commit) {
        found = { effort, commit, created: (entry as unknown as { created?: boolean }).created === true }
      }
    }
  }
  return found
}

const shaAt = (root: string, rev: string, rel: string): string | undefined => {
  const blob = gitBlob(root, rev, rel)
  const doc = blob === undefined ? undefined : splitDoc(blob.toString('utf8'))
  return doc?.ok ? canonicalSha(doc.value.meta, doc.value.body) : undefined
}

// D168 (review). Whether this effort's abandon left its write standing — kept, because a plan
// stood on it or on a sibling slice, or the walk stopped at it. That content is canon of record:
// no later walk goes past it, or an amendment on top of it took the keep with it.
function stoodAtAbandon(root: string, effort: string, rel: string, sha: string): boolean {
  const at = journalActs(root, effort, 'HEAD').find(({ entry }) =>
    entry.t === 'human-decision' && (entry as unknown as { decision?: string }).decision === 'abandon-effort')
  return at !== undefined && shaAt(root, at.commit, rel) === sha
}

// This effort's newest write of an artifact (of this content, when `sha` is given).
export const effortWrite = (root: string, effort: string, id: string, sha?: string): { commit: string } | undefined =>
  journalActs(root, effort, 'HEAD').filter(({ entry }) => isWrite(entry, id, sha)).at(-1)

// D168 (review). Whether an earlier abandon already took this effort's newest write of a spec
// back — `abandon <plan>` does, before the effort's own abandon: a status entry the abandon
// journaled on the spec after that write, which is not a return, made where the spec stood at
// the write's content. Then the effort's abandon has nothing of its own left there to take back.
export function takenBackAlready(root: string, effort: string, id: string, rel: string, sha: string): boolean {
  const write = effortWrite(root, effort, id, sha)
  if (write === undefined) return false
  return journalActs(root, id, 'HEAD').some(({ entry, commit }) => {
    const s = entry as unknown as { t: string; cause?: string; from?: string; to?: string }
    const takes = s.t === 'status' && s.cause === 'abandon' && !(s.from === 'superseded' && s.to !== 'removed')
    return takes && commit !== write.commit && isAncestor(root, write.commit, commit) && shaAt(root, `${commit}^`, rel) === sha
  })
}

export type SpecRevert =
  | { doc: CanonDoc; action: 'restore'; content: string; toStatus: string; design?: { rel: string; prior: Buffer | undefined }; returns: Return[]; unwound: StatusEntry[] }
  | { doc: CanonDoc; action: 'delete'; departure: Departure; returns: Return[]; unwound: StatusEntry[] }

// D166. The unwind that does not happen. Abandoning a plan takes back the spec content it was
// paired with — the whole spec when its effort created it (row 29), else the amendment. But a
// sibling derived from the same version either shipped it (taking it back makes canon forget
// built behavior) or is still building it (taking it back strands that plan — issue #34's
// shape). So the content stays while anything stands on it, and the caller says why.
// `shipped` is what makes a keep permanent; without it, the writing effort's next abandon is
// what takes the content back. A separate result rather than a third SpecRevert arm, so
// executeAbandon can never take a keep for a delete.
export interface SpecKeep { doc: CanonDoc; action: 'keep'; standing: string[]; shipped: boolean }

export const keptLine = (k: SpecKeep): string =>
  `${String(k.doc.meta.id)} — not unwound · still standing on it: ${k.standing.join(' ')}`

// D167. The abandon says everything it did to canon, on both paths, as `kept:` already did: what
// it reverted, what came back with it, and what the walk took back on the way.
export function abandonLines(items: AbandonItem[], kept: SpecKeep[]): string[] {
  return [
    ...items.flatMap((item) => [
      ...(item.revert ? [kv('reverted', `${String(item.revert.doc.meta.id)} (${item.revert.action}) — journal untouched`)] : []),
      ...(item.revert?.returns ?? []).map((r) =>
        kv('returned', `${r.entry.artifact} — back in canon as ${r.entry.to} · the re-slice into ${r.by} is taken back`)),
      ...(item.revert?.unwound ?? []).map((u) => kv('unwound', `${u.artifact} — stays out of canon · an abandoned effort created it`)),
      ...(item.kept ? [kv('kept', keptLine(item.kept))] : []),
      ...(item.note ? [kv('note', item.note)] : []),
    ]),
    ...kept.map((k) => kv('kept', keptLine(k))),
  ]
}

// D166 (review). The efforts whose writes the way back takes back besides this abandon's own
// targets: every effort already abandoned — whose abandon skipped a spec a later re-slice had
// departed — and the effort being abandoned now (`effort`, absent on the plan path).
const goneEfforts = (root: string, effort: string | undefined): string[] =>
  effortStreams(root).filter((e) => e === effort || effortAbandoned(readStream(root, e)))

// Content whose act is a write of one of `efforts` never comes back into canon on its own —
// unless a plan outside the abandon set stands on it (the keep rule, which never takes shipped
// content back), or that effort's own abandon left it standing.
function takenBackBy(root: string, canon: Canon, abandonSet: Set<string>, efforts: string[]): TakenBack {
  return (id, sha, rel, at) => {
    if (plansOn(canon, id, { exclude: abandonSet, pin: sha }).length > 0) return undefined
    const act = writeAct(root, id, sha, at)
    return act !== undefined && efforts.includes(act.effort) && !stoodAtAbandon(root, act.effort, rel, sha) ? act : undefined
  }
}

// D189. What each spec was cut from: its own `supersedes` while canon holds it, else the
// `supersedes` its write journaled — a departed spec is no longer in canon to say.
function cutFrom(root: string, canon: Canon): Map<string, string> {
  const from = new Map<string, string>()
  for (const e of effortStreams(root)) {
    for (const x of readStream(root, e)) {
      const w = x as unknown as { t: string; artifact?: string; supersedes?: string }
      if (w.t === 'write' && w.artifact !== undefined && w.supersedes !== undefined) from.set(w.artifact, w.supersedes)
    }
  }
  for (const d of canon.docs) if (d.meta.supersedes !== undefined) from.set(String(d.meta.id), String(d.meta.supersedes))
  return from
}

const descendsFrom = (from: Map<string, string>, id: string, cut: Set<string>): boolean => {
  const seen = new Set<string>([id])
  for (let up = from.get(id); up !== undefined && !seen.has(up); up = from.get(up)) {
    if (cut.has(up)) return true
    seen.add(up)
  }
  return false
}

// `act`: the write of `pin` this abandon takes back — the effort's own on the effort path, the
// write the plan is paired with on the plan path. `effort`: the effort being abandoned, if any.
export function specRevertFor(
  root: string, canon: Canon, spec: CanonDoc, pin: string, abandonSet: Set<string>, act: WriteAct, effort?: string,
): Result<SpecRevert | SpecKeep | undefined> {
  const current = canonicalSha(spec.meta, spec.body)
  if (current !== pin) {
    return refuse([v('spec', 'stacked-amendment', `${String(spec.meta.id)} is at ${current.slice(0, 7)}, pin is ${pin.slice(0, 7)}`,
      'abandon newest-first: a later amendment touched this spec')])
  }
  // D166. After "newest-first" (row 84 stands) and ahead of every precondition of the unwind
  // itself — a resolvable pin, no waiting dependents — because a kept spec unwinds nothing and
  // dangles nothing. Same pin in both branches: the siblings a delete would orphan were all
  // derived from the content it removes, and a restore moves toward older pins.
  const standing = plansOn(canon, String(spec.meta.id), { exclude: abandonSet, pin })
  if (standing.length > 0) {
    return ok({
      doc: spec, action: 'keep', standing: standing.map((p) => String(p.meta.id)),
      shipped: standing.some((p) => String(p.meta.status) === 'done'),
    })
  }
  const id = String(spec.meta.id)
  // D168. The write being taken back is one act of its effort, and so is every earlier write of
  // this spec it made: a revise round re-writes, and taking back only the last write left the
  // effort's own first draft in canon. The walk goes back past those and past every abandoned
  // effort's write, and stops at content a plan stands on.
  const gone = goneEfforts(root, effort)
  const walking = [...new Set([...gone, act.effort])]
  const back = takeBack(root, spec.rel, id, act, takenBackBy(root, canon, abandonSet, walking))
  if (back.end === 'lost') {
    return refuse([humanCall(v('spec', 'pin-unresolvable', `${id}: no content at ${spec.rel} before ${back.act.effort}'s write ${back.act.commit.slice(0, 7)}`,
      'that write to read as an amendment of what stood on this path — the spec was moved by hand or history was cut · a human\'s call'))])
  }
  // D168 (review). The walk stopping at an earlier round of the effort being abandoned, because
  // another plan still building stands on it, is a keep of that effort's content: the same keep
  // the first round alone would have been, and refused for the same reason — this abandon is the
  // last act that could take it back. Once a plan shipped it, it stands for good.
  if (effort !== undefined && back.end === 'content') {
    const sha = canonicalSha(back.doc.meta, back.doc.body)
    const on = plansOn(canon, id, { exclude: abandonSet, pin: sha })
    const owner = on.length > 0 ? writeAct(root, id, sha, back.src) : undefined
    if (owner !== undefined && walking.includes(owner.effort) && !on.some((p) => String(p.meta.status) === 'done')) {
      return ok({ doc: spec, action: 'keep', standing: on.map((p) => String(p.meta.id)), shipped: false })
    }
  }
  // D166. The way back: a write being taken back may have departed a predecessor (a re-slice),
  // which then returns with it. A re-slice can cut one spec into several slices, and taking
  // back one while another still stands would leave the predecessor half-described, so that
  // write is kept until its siblings go too — together, through the effort that made them.
  // D168: every write the walk takes back, not only the last — the create that re-sliced, or
  // an amendment that folded another spec in, may lie under a revision.
  const ways = back.passed.map((w) => prepareReturns(root, canon.paths, w.commit, id, takenBackBy(root, canon, abandonSet, gone)))
  const returns = ways.flatMap((w) => w.returns)
  const unwound = ways.flatMap((w) => w.unwound)
  // D166 (review). A sibling slice stands when this abandon leaves it in canon: it is outside the
  // abandon set, or inside it but kept because a plan outside the set stands on it. It stands for
  // good when a plan shipped it — and then so does this keep, since nothing can take the
  // sibling back. Every spec the walk passes through counts: each was a re-slice being taken back.
  // D188: on the plan path, also a slice whose own write departed nothing — another slice's
  // write took the predecessor out. Its effort is still live, and its own abandon is the act that
  // takes the split back together; deleting the slice now left the split half described. The
  // effort path is that last act, and there a slice another effort cut cannot go back together
  // with this one: holding it would leave two efforts' abandons each refusing for the other's.
  const own = spec.meta.supersedes === undefined ? undefined : String(spec.meta.supersedes)
  const slice = effort === undefined && back.end === 'create' && own !== undefined && canonExit(readStream(root, own))?.to === 'superseded' ? [own] : []
  const cut = new Set([...returns.map((r) => r.entry.artifact), ...unwound.map((u) => u.artifact), ...slice])
  // D189: a split is the whole tree of what was cut from the predecessor — a slice re-sliced
  // again stands through its own slices.
  const from = cutFrom(root, canon)
  const slices = canon.docs
    .filter((d) => d.meta.type === 'spec' && String(d.meta.id) !== id && descendsFrom(from, String(d.meta.id), cut))
    .flatMap((d) => {
      const id = String(d.meta.id)
      const leaving = abandonSet.has(id)
      const on = plansOn(canon, id, leaving ? { exclude: abandonSet, pin: canonicalSha(d.meta, d.body) } : { exclude: abandonSet })
      return leaving && on.length === 0 ? [] : [{ id, shipped: on.some((p) => String(p.meta.status) === 'done') }]
    })
  if (slices.length > 0) {
    return ok({ doc: spec, action: 'keep', standing: slices.map((s) => s.id), shipped: slices.some((s) => s.shipped) })
  }
  if (back.end === 'create') {
    const dependents = canon.docs
      .filter((d) => !abandonSet.has(String(d.meta.id)))
      .filter((d) => ((d.meta.depends ?? []) as string[]).includes(String(spec.meta.id)))
      .map((d) => String(d.meta.id))
    if (dependents.length > 0) {
      return refuse([v('spec', 'waiting-dependents', dependents.join(' '),
        'no docs outside the abandon set may depend on a spec being deleted')])
    }
    // D166. The unwind departs the spec through the same door the re-slice uses, so
    // everything that leaves canon with a spec — its design included — leaves here too.
    return ok({
      doc: spec, action: 'delete', returns, unwound,
      departure: prepareDeparture(root, canon.paths, spec, {
        v: 1, t: 'status', artifact: id, from: String(spec.meta.status), to: 'removed', cause: 'abandon',
      }),
    })
  }
  const toStatus = back.end === 'content' ? String(back.doc.meta.status) : 'draft'
  // D166. The look goes back with the content it was drawn for: the design as it stood where the
  // walk stopped, byte for byte — or none, if there was none then.
  const designR = designRel(canon.paths, id)
  const priorDesign = gitBlob(root, back.src, designR)
  const design = priorDesign !== undefined || existsSync(join(root, designR)) ? { rel: designR, prior: priorDesign } : undefined
  return ok({ doc: spec, action: 'restore', content: back.blob.toString('utf8'), toStatus, design, returns, unwound })
}

export interface AbandonItem {
  planStamp?: PreparedStamp
  planId?: string
  revert?: SpecRevert
  kept?: SpecKeep
  note?: string
}

// D167. A return lands on the path its spec left from, and `rename` moves an id but leaves its
// file, so another doc may hold that path — or another spec this abandon brings back may have
// left from it too. Written over, either left canon with nothing to say so. Only a doc this same
// abandon departs may stand there; any other holder, or a second return, is a human's call.
export function returnCollisions(root: string, canon: Canon, items: AbandonItem[]): Violation[] {
  const departing = new Set(items.flatMap((i) => (i.revert?.action === 'delete' ? [i.revert.doc.rel] : [])))
  const returns = items.flatMap((i) => (i.revert?.returns ?? []).map((r) => ({ r, going: String(i.revert!.doc.meta.id) })))
  const landing = new Map<string, string[]>()
  for (const { r } of returns) {
    const ids = landing.get(r.rel) ?? []
    if (!ids.includes(r.entry.artifact)) landing.set(r.rel, [...ids, r.entry.artifact])
  }
  return [
    ...returns.filter(({ r }) => !departing.has(r.rel) && existsSync(join(root, r.rel))).map(({ r, going }) => {
      const held = canon.docs.find((d) => d.rel === r.rel)
      const holder = held ? String(held.meta.id) : 'a doc canon cannot read'
      return humanCall(v('spec', 'path-taken', `${r.rel} holds ${holder}`,
        `that path free first — ${r.entry.artifact} comes back to it when ${going} goes · what becomes of ${holder} is a human's call`))
    }),
    ...[...landing].filter(([, ids]) => ids.length > 1).map(([rel, ids]) => humanCall(v('spec', 'path-taken',
      `${rel} takes ${ids.join(' and ')}`, `one return per path — each left from it · which one comes back is a human's call`))),
  ]
}

// D188. What an abandon lands — a restore's older content, a return's departed bytes — comes
// back only beside what it depends on: a dependency in canon that this abandon does not take
// out, or one it brings back. `write` refuses a dangling `depends`, and an abandon landing one
// left `check` red after it exited 0. Bringing the dependency back first is a human's call.
export function landingEdges(root: string, canon: Canon, items: AbandonItem[]): Violation[] {
  const leaving = new Set(items.flatMap((i) => (i.revert?.action === 'delete' ? [String(i.revert.doc.meta.id)] : [])))
  const coming = new Set(items.flatMap((i) => (i.revert?.returns ?? []).map((r) => r.entry.artifact)))
  const lands = items.flatMap((i): Array<{ id: string; depends: string[] }> => {
    if (!i.revert) return []
    const restored = i.revert.action === 'restore' ? splitDoc(i.revert.content) : undefined
    return [
      ...(restored?.ok ? [{ id: String(i.revert.doc.meta.id), depends: ((restored.value.meta.depends ?? []) as unknown[]).map(String) }] : []),
      ...i.revert.returns.map((r) => ({ id: r.entry.artifact, depends: r.depends })),
    ]
  })
  return lands.flatMap(({ id, depends }) => depends
    .filter((dep) => !coming.has(dep) && (leaving.has(dep) || findById(canon, dep) === undefined))
    .map((dep) => {
      const exit = canonExit(readStream(root, dep))
      const why = leaving.has(dep) ? 'it leaves with this abandon'
        : exit?.to === 'superseded' ? `it left superseded by ${exit.by ?? 'a successor'}` : 'it left canon'
      return humanCall(v('spec', 'dangling-depends', `${id} depends on ${dep}`,
        `${dep} in canon when ${id} comes back — ${why} · a human's call`))
    }))
}

// D188 (review). A spec kept for good stays in canon with what it depends on: a dependency this
// abandon would delete is kept beside it, and for good with it. `waiting-dependents` reads only
// docs outside the abandon set, and a kept one is inside it, so the delete left `check` red after
// the abandon exited 0; refusing instead would hold the effort for good behind a shipped plan.
export function keepDependencies(items: AbandonItem[], kept: SpecKeep[]): { items: AbandonItem[]; kept: SpecKeep[] } {
  let walked = items
  const held = [...kept]
  for (let grew = true; grew;) {
    grew = false
    walked = walked.filter((item) => {
      if (item.revert?.action !== 'delete') return true
      const id = String(item.revert.doc.meta.id)
      const on = held.filter((k) => ((k.doc.meta.depends ?? []) as unknown[]).map(String).includes(id))
      if (on.length === 0) return true
      held.push({ doc: item.revert.doc, action: 'keep', standing: on.map((k) => String(k.doc.meta.id)), shipped: on.some((k) => k.shipped) })
      grew = true
      return false
    })
  }
  return { items: walked, kept: held }
}

export function executeAbandon(
  root: string, ctx: Ctx, items: AbandonItem[], effortEntry: { effort: string } | undefined, subject: string,
): Result<{ sha: string }> {
  const files = new Set<string>()
  const journalMulti: Array<{ stream: string; line: string }> = []
  const stamps: PreparedStamp[] = []
  const specEntries: Array<{ stream: string; entry: StatusEntry }> = []
  const returnEntries: Array<{ stream: string; entry: { t: EntryType; [k: string]: unknown } }> = []

  for (const item of items) {
    if (item.planStamp) {
      stamps.push(item.planStamp)
      files.add(item.planStamp.rel); files.add(journalRel(item.planStamp.stream))
      journalMulti.push({ stream: item.planStamp.stream, line: item.planStamp.line })
    }
    if (item.revert) {
      const spec = item.revert.doc
      const id = String(spec.meta.id)
      const entry: StatusEntry = item.revert.action === 'delete' ? item.revert.departure.entry : {
        v: 1, t: 'status', artifact: id, from: String(spec.meta.status), to: item.revert.toStatus, cause: 'abandon',
      }
      specEntries.push({ stream: id, entry })
      const touched = item.revert.action === 'delete'
        ? item.revert.departure.files
        : [spec.rel, journalRel(id), ...(item.revert.design ? [item.revert.design.rel] : [])]
      for (const f of touched) files.add(f)
      journalMulti.push({ stream: id, line: entryLine(entry as unknown as { t: 'status'; [k: string]: unknown }) })
      // D166. A spec this write had departed comes back in the same state commit — and, D168,
      // a spec the walk took back past its create leaves canon's record in it too.
      const asLine = (e: StatusEntry) => ({ stream: e.artifact, entry: e as unknown as { t: EntryType; [k: string]: unknown } })
      const lines = [
        ...item.revert.returns.flatMap((r) => [asLine(r.entry), ...r.moves]),
        ...item.revert.unwound.map(asLine),
      ]
      for (const r of item.revert.returns) for (const f of r.files) files.add(f)
      for (const l of lines) {
        files.add(journalRel(l.stream))
        journalMulti.push({ stream: l.stream, line: entryLine(l.entry) })
      }
      returnEntries.push(...lines)
    }
  }
  let effortLine: { stream: string; line: string } | undefined
  if (effortEntry) {
    const entry = {
      v: 1 as const, t: 'human-decision' as const, gate: 'effort', artifact: effortEntry.effort,
      round: 0, decision: 'abandon-effort' as const,
    }
    effortLine = { stream: effortEntry.effort, line: entryLine(entry as unknown as { t: 'human-decision'; [k: string]: unknown }) }
    files.add(journalRel(effortEntry.effort))
    journalMulti.push(effortLine)
  }

  const lockR = acquireLock(root)
  if (!lockR.ok) return lockR
  try {
    return withTxn(root, { op: 'abandon', files: [...files], journalMulti }, () => {
      for (const item of items) {
        if (item.revert) {
          // stateCommit's `git add` below stages a tracked-but-missing file as a deletion
          if (item.revert.action === 'delete') item.revert.departure.remove()
          else {
            writeFileSync(join(root, item.revert.doc.rel), item.revert.content)
            const d = item.revert.design
            if (d?.prior !== undefined) writeFileSync(join(root, d.rel), d.prior)
            else if (d !== undefined && existsSync(join(root, d.rel))) unlinkSync(join(root, d.rel))
          }
        }
      }
      // D167. Every departure lands before any return (P9b): restored per item, a later item's
      // departure unlinked the spec an earlier item's return had just brought back to its path.
      for (const item of items) for (const r of item.revert?.returns ?? []) r.restore()
      for (const s of stamps) writeStamp(root, s)
      for (const se of specEntries) appendEntry(root, se.stream, se.entry as unknown as { t: 'status'; [k: string]: unknown })
      for (const re of returnEntries) appendEntry(root, re.stream, re.entry)
      if (effortLine) {
        appendEntry(root, effortLine.stream, JSON.parse(effortLine.line))
      }
      crashPoint(ctx.env, 'abandon-commit')
      const r = stateCommit(root, [...files], subject)
      // D141. `abandon` runs from wherever the human typed it, which may be the very
      // worktree it is discarding; the removal re-runs harmlessly from anywhere else.
      if (r.ok) {
        for (const item of items) {
          if (item.planId && !removeWorktree(root, item.planId, ctx.cwd)) {
            ctx.out(kv('note', `worktree ${worktreePath(root, item.planId)} kept — this session stands in it; leave the directory and re-run witness clean`))
          }
        }
      }
      return r
    })
  } finally {
    lockR.value()
  }
}

// Whether this plan's parent spec is this function's business.
//
// `pair-parent` — `abandon <plan-id>`. No effort was named, so the pairing is derived
// from the act: the write that made the plan's `derives-from` content, when an effort that
// wrote the plan made it (D168). That write is unwound — with that effort's earlier writes
// of the spec, its revise rounds — refusing if the spec has moved since.
//
// `stamp-only` — `abandon <effort-slug>`. The caller reverts every spec the effort
// itself wrote, from that effort's own write, so a second revert here would be duplicate
// mechanism — and, before D168, a WRONG one: it re-derived the owner via effortOf, which
// tie-breaks alphabetically across every effort that wrote the plan. A plan rewritten by a
// later effort therefore resolved to a SIBLING effort whose writes did include the parent,
// and abandon destroyed an approved amendment the abandoned effort never made, walking the
// spec back past its own write boundary.
export type Pairing = 'pair-parent' | 'stamp-only'

export function planItems(
  root: string, canon: Canon, plan: CanonDoc, abandonSet: Set<string>, pairing: Pairing,
): Result<AbandonItem> {
  const planId = String(plan.meta.id)
  const status = String(plan.meta.status)
  if (status === 'done') {
    return refuse([v('plan', 'already-done', planId, 'abandon targets unfinished plans — done plans are history')])
  }
  const item: AbandonItem = {
    planStamp: prepareStamp(plan, 'abandoned', 'abandon'),
    planId,
  }
  if (pairing === 'stamp-only') return ok(item)
  // D168. Paired by the act: an effort that wrote this plan also made the write of the parent the
  // plan derives from. Deriving the owner through effortOf tie-broke alphabetically across every
  // effort that wrote the plan, and pairing on "wrote the parent at all" reverted content another
  // effort wrote whenever the plan was derived from it.
  const parentId = String(plan.meta.parent)
  const parent = findById(canon, parentId)
  if (parent) {
    const pin = String(plan.meta['derives-from'])
    const writers = effortStreams(root).filter((e) => readStream(root, e).some((x) => isWrite(x, planId)))
    const act = writeAct(root, parentId, pin)
    if (act !== undefined && writers.includes(act.effort)) {
      const revertR = specRevertFor(root, canon, parent, pin, abandonSet, act)
      if (!revertR.ok) return revertR
      const outcome = revertR.value
      if (outcome?.action === 'keep') item.kept = outcome
      else item.revert = outcome
    } else if (act === undefined && writers.some((e) => readStream(root, e).some((x) => isWrite(x, parentId)))) {
      // The plan's effort wrote this spec, but no journaled write made the content the plan
      // derives from (a hand edit, an adopt): there is no act to pair with, and saying so is
      // what keeps a spec left standing from looking unwound.
      item.note = `${parentId} — not unwound · no journaled write made the content ${planId} derives from`
    }
  }
  return ok(item)
}
