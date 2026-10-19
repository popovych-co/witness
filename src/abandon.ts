import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import { prepareDeparture, prepareReturns, type Departure, type Return, type TakenBack } from './departure.js'
import { designRel } from './design.js'
import { splitDoc } from './fm.js'
import { canonicalSha } from './sha.js'
import { gitBlob, tryGit, stateCommit } from './gitio.js'
import { acquireLock } from './lock.js'
import { crashPoint, withTxn } from './txn.js'
import { appendEntry, effortAbandoned, effortStreams, entryLine, journalRel, readStream, type EntryType, type StatusEntry } from './journal.js'
import { findById, plansOn, type Canon, type CanonDoc } from './scan.js'
import { effortOf, effortWrites } from './reviewed.js'
import { humanCall, ok, refuse, v, type Result, type Violation } from './refusal.js'
import { prepareStamp, writeStamp, type PreparedStamp } from './stamp.js'
import { kv } from './toon.js'
import { removeWorktree, worktreePath } from './worktree.js'

export function pinCommit(root: string, rel: string, pin: string, from?: string): string | undefined {
  // `from`: walk history from that revision instead of HEAD — for a file a later commit deleted
  const log = tryGit(root, 'log', '--format=%H', ...(from === undefined ? [] : [from]), '--', rel)
  if (!log.ok) return undefined
  // Status-only touch-ups (approve, stampLive, a gate's writeStamp) commit the same
  // canonical sha under a new commit, since status is a volatile field excluded from
  // it. Walking newest-first and stopping at the first non-match — rather than
  // returning the first match — lands on the OLDEST commit that established this
  // content, so its parent is the true prior (different-content) version.
  let found: string | undefined
  for (const sha of log.out.split('\n').filter(Boolean)) {
    const show = tryGit(root, 'show', `${sha}:${rel}`)
    if (!show.ok) break
    const doc = splitDoc(show.out)
    if (!doc.ok || canonicalSha(doc.value.meta, doc.value.body) !== pin) break
    found = sha
  }
  return found
}

export type SpecRevert =
  | { doc: CanonDoc; action: 'restore'; content: string; toStatus: string; design?: { rel: string; prior: Buffer | undefined }; returns: Return[] }
  | { doc: CanonDoc; action: 'delete'; departure: Departure; returns: Return[] }

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

// D166 (review). The writes the way back takes back besides this abandon's own targets: every
// write of an effort already abandoned — whose abandon skipped a spec a later re-slice had
// departed — and every write of the effort being abandoned now (`effort`, absent on the plan
// path). Content one of them wrote never comes back into canon on its own — unless a plan
// outside the abandon set stands on it: the keep rule, which never takes shipped content back.
function takenBackBy(root: string, canon: Canon, abandonSet: Set<string>, effort: string | undefined): TakenBack {
  const gone = effortStreams(root).filter((e) => e === effort || effortAbandoned(readStream(root, e)))
  return (id, sha, rel, at) =>
    plansOn(canon, id, { exclude: abandonSet, pin: sha }).length === 0 &&
    gone.some((e) => readStream(root, e).some((x) => x.t === 'write' && x.artifact === id && x.sha === sha))
      ? pinCommit(root, rel, sha, at)
      : undefined
}

export function specRevertFor(
  root: string, canon: Canon, spec: CanonDoc, pin: string, abandonSet: Set<string>, effort?: string,
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
  const commit = pinCommit(root, spec.rel, pin)
  if (!commit) {
    return refuse([v('spec', 'pin-unresolvable', pin.slice(0, 7), 'a committed version matching the pin')])
  }
  // D166. The way back: the write being taken back may have departed a predecessor (a
  // re-slice), which then returns with it. A re-slice can cut one spec into several slices, and
  // taking back one while another still stands would leave the predecessor half-described, so
  // that write is kept until its siblings go too — together, through the effort that made them.
  const returns = prepareReturns(root, canon.paths, commit, String(spec.meta.id), takenBackBy(root, canon, abandonSet, effort))
  // D166 (review). A sibling slice stands when this abandon leaves it in canon: it is outside the
  // abandon set, or inside it but kept because a plan outside the set stands on it. It stands for
  // good when a plan shipped it — and then so does this keep, since nothing can take the
  // sibling back. Every spec the walk passes through counts: each was a re-slice being taken back.
  const cut = new Set(returns.flatMap((r) => [r.entry.artifact, ...r.unwound.map((u) => u.artifact)]))
  const slices = canon.docs
    .filter((d) => d.meta.type === 'spec' && cut.has(String(d.meta.supersedes)) && String(d.meta.id) !== String(spec.meta.id))
    .flatMap((d) => {
      const id = String(d.meta.id)
      const leaving = abandonSet.has(id)
      const on = plansOn(canon, id, leaving ? { exclude: abandonSet, pin: canonicalSha(d.meta, d.body) } : { exclude: abandonSet })
      return leaving && on.length === 0 ? [] : [{ id, shipped: on.some((p) => String(p.meta.status) === 'done') }]
    })
  if (slices.length > 0) {
    return ok({ doc: spec, action: 'keep', standing: slices.map((s) => s.id), shipped: slices.some((s) => s.shipped) })
  }
  const prior = tryGit(root, 'show', `${commit}^:${spec.rel}`)
  if (!prior.ok) {
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
      doc: spec, action: 'delete', returns,
      departure: prepareDeparture(root, canon.paths, spec, {
        v: 1, t: 'status', artifact: String(spec.meta.id), from: String(spec.meta.status), to: 'removed', cause: 'abandon',
      }),
    })
  }
  const parsed = splitDoc(prior.out)
  const toStatus = parsed.ok ? String(parsed.value.meta.status) : 'draft'
  // D166. The look goes back with the content it was drawn for: the design as it stood before
  // the commit being taken back, byte for byte — or none, if there was none then.
  const designR = designRel(canon.paths, String(spec.meta.id))
  const priorDesign = gitBlob(root, `${commit}^`, designR)
  const design = priorDesign !== undefined || existsSync(join(root, designR)) ? { rel: designR, prior: priorDesign } : undefined
  return ok({ doc: spec, action: 'restore', content: prior.out, toStatus, design, returns })
}

export interface AbandonItem {
  planStamp?: PreparedStamp
  planId?: string
  revert?: SpecRevert
  kept?: SpecKeep
}

// D167. A return lands on the path its spec left from, and `rename` moves an id but leaves its
// file, so another doc may hold that path. Written over, that doc left canon with nothing to say
// so. Only a doc this same abandon departs may stand there; any other holder is a human's call.
export function returnCollisions(root: string, canon: Canon, items: AbandonItem[]): Violation[] {
  const departing = new Set(items.flatMap((i) => (i.revert?.action === 'delete' ? [i.revert.doc.rel] : [])))
  return items.flatMap((i) => i.revert?.returns ?? [])
    .filter((r) => !departing.has(r.rel) && existsSync(join(root, r.rel)))
    .map((r) => {
      const held = canon.docs.find((d) => d.rel === r.rel)
      const holder = held ? String(held.meta.id) : 'a doc canon cannot read'
      return humanCall(v('spec', 'path-taken', `${r.rel} holds ${holder}`,
        `that path free first — ${r.entry.artifact} comes back to it when ${r.by} goes · what becomes of ${holder} is a human's call`))
    })
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
      // D166. A spec this write had departed comes back in the same state commit.
      for (const r of item.revert.returns) {
        const lines = [
          ...[r.entry, ...r.unwound].map((e) => ({ stream: e.artifact, entry: e as unknown as { t: EntryType; [k: string]: unknown } })),
          ...r.moves,
        ]
        for (const f of r.files) files.add(f)
        for (const l of lines) {
          files.add(journalRel(l.stream))
          journalMulti.push({ stream: l.stream, line: entryLine(l.entry) })
        }
        returnEntries.push(...lines)
      }
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
// `pair-parent` — `abandon <plan-id>`. No effort was named, so the owner is derived,
// and the pin is the plan's own `derives-from`: unwind exactly the amendment this
// plan was paired with, refusing if the spec has moved since.
//
// `stamp-only` — `abandon <effort-slug>`. The caller reverts every spec the effort
// itself wrote, pinned on that effort's own write sha, so a second revert here would
// be duplicate mechanism — and a WRONG one: it must re-derive the owner via effortOf,
// which tie-breaks alphabetically across every effort that wrote the plan. A plan
// rewritten by a later effort therefore resolved to a SIBLING effort whose writes did
// include the parent, and abandon destroyed an approved amendment the abandoned effort
// never made, walking the spec back past its own write boundary.
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
  const effort = effortOf(root, planId)
  const parentId = String(plan.meta.parent)
  const paired = effort !== undefined && effortWrites(root, effort).has(parentId)
  if (paired) {
    const parent = findById(canon, parentId)
    if (parent) {
      const revertR = specRevertFor(root, canon, parent, String(plan.meta['derives-from']), abandonSet)
      if (!revertR.ok) return revertR
      const outcome = revertR.value
      if (outcome?.action === 'keep') item.kept = outcome
      else item.revert = outcome
    }
  }
  return ok(item)
}
