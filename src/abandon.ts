import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './cli.js'
import { splitDoc } from './fm.js'
import { canonicalSha } from './sha.js'
import { tryGit, stateCommit } from './gitio.js'
import { acquireLock } from './lock.js'
import { crashPoint, withTxn } from './txn.js'
import { appendEntry, entryLine, journalRel, type StatusEntry } from './journal.js'
import { findById, type Canon, type CanonDoc } from './scan.js'
import { effortOf, effortWrites } from './reviewed.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { prepareStamp, writeStamp, type PreparedStamp } from './stamp.js'
import { removeWorktree } from './worktree.js'

export function pinCommit(root: string, rel: string, pin: string): string | undefined {
  const log = tryGit(root, 'log', '--format=%H', '--', rel)
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
  | { doc: CanonDoc; action: 'restore'; content: string; toStatus: string }
  | { doc: CanonDoc; action: 'delete' }

export function specRevertFor(
  root: string, canon: Canon, spec: CanonDoc, pin: string, abandonSet: Set<string>,
): Result<SpecRevert | undefined> {
  const current = canonicalSha(spec.meta, spec.body)
  if (current !== pin) {
    return refuse([v('spec', 'stacked-amendment', `${String(spec.meta.id)} is at ${current.slice(0, 7)}, pin is ${pin.slice(0, 7)}`,
      'abandon newest-first: a later amendment touched this spec')])
  }
  const commit = pinCommit(root, spec.rel, pin)
  if (!commit) {
    return refuse([v('spec', 'pin-unresolvable', pin.slice(0, 7), 'a committed version matching the pin')])
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
    return ok({ doc: spec, action: 'delete' })
  }
  const parsed = splitDoc(prior.out)
  const toStatus = parsed.ok ? String(parsed.value.meta.status) : 'draft'
  return ok({ doc: spec, action: 'restore', content: prior.out, toStatus })
}

export interface AbandonItem {
  planStamp?: PreparedStamp
  planId?: string
  revert?: SpecRevert
}

export function executeAbandon(
  root: string, ctx: Ctx, items: AbandonItem[], effortEntry: { effort: string } | undefined, subject: string,
): Result<{ sha: string }> {
  const files = new Set<string>()
  const journalMulti: Array<{ stream: string; line: string }> = []
  const stamps: PreparedStamp[] = []
  const specEntries: Array<{ stream: string; entry: StatusEntry }> = []

  for (const item of items) {
    if (item.planStamp) {
      stamps.push(item.planStamp)
      files.add(item.planStamp.rel); files.add(journalRel(item.planStamp.stream))
      journalMulti.push({ stream: item.planStamp.stream, line: item.planStamp.line })
    }
    if (item.revert) {
      const spec = item.revert.doc
      const id = String(spec.meta.id)
      const entry: StatusEntry = {
        v: 1, t: 'status', artifact: id, from: String(spec.meta.status),
        to: item.revert.action === 'restore' ? item.revert.toStatus : 'removed',
        cause: 'abandon',
      }
      specEntries.push({ stream: id, entry })
      files.add(spec.rel); files.add(journalRel(id))
      journalMulti.push({ stream: id, line: entryLine(entry as unknown as { t: 'status'; [k: string]: unknown }) })
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
          const abs = join(root, item.revert.doc.rel)
          if (item.revert.action === 'restore') writeFileSync(abs, item.revert.content)
          else unlinkSync(abs) // stateCommit's `git add` below correctly stages a tracked-but-missing file as a deletion
        }
      }
      for (const s of stamps) writeStamp(root, s)
      for (const se of specEntries) appendEntry(root, se.stream, se.entry as unknown as { t: 'status'; [k: string]: unknown })
      if (effortLine) {
        appendEntry(root, effortLine.stream, JSON.parse(effortLine.line))
      }
      crashPoint(ctx.env, 'abandon-commit')
      const r = stateCommit(root, [...files], subject)
      if (r.ok) for (const item of items) if (item.planId) removeWorktree(root, item.planId)
      return r
    })
  } finally {
    lockR.value()
  }
}

export function planItems(
  root: string, canon: Canon, plan: CanonDoc, abandonSet: Set<string>,
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
  const effort = effortOf(root, planId)
  const parentId = String(plan.meta.parent)
  const paired = effort !== undefined && effortWrites(root, effort).has(parentId)
  if (paired) {
    const parent = findById(canon, parentId)
    if (parent) {
      const revertR = specRevertFor(root, canon, parent, String(plan.meta['derives-from']), abandonSet)
      if (!revertR.ok) return revertR
      item.revert = revertR.value
    }
  }
  return ok(item)
}
