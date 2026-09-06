import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, canonicalSha, planContentSha } from './sha.js'
import { changedFiles } from './evidence.js'
import { git, tryGit } from './gitio.js'
import { effortAbandoned, effortStreams, latestRecap, readStream } from './journal.js'
import type { Canon, CanonDoc } from './scan.js'
import { findById } from './scan.js'

// Row 96a. The reviewed identity is the DIFF the battery read: the base commit plus the
// content of every path `changedFiles` reports — exactly what `codePromptBody` renders as
// `### Changed files`, `### Diff vs base <sha>` and the untracked blocks. `worktreeTreeSha`
// hashed the WHOLE worktree via `add -A`, so witness's own journal entries and stamps —
// pulled in by ship's pre-battery rebase — moved the identity the verdict was keyed to, and
// the entry DESCRIBING a verdict invalidated it one hop later.
//
// The base term is required, not optional. A rebase can change the diff TEXT while every
// blob stays byte-identical; drop the base and a cached verdict replays against a diff no
// reviewer ever read, and implement loses the rebase re-arming it has today.
//
// Deleted paths carry an explicit marker: `hash-object` throws on a missing file, and
// dropping the path silently would make "this file is gone" invisible to the identity.
const DELETED_BLOB = '(deleted)'

// D161 (#27, corrected by the audit's F1/F4). A changed path can be a symlink, a gitlink
// (submodule) or another non-file — entries `hash-object` fatals on or mis-hashes. Each
// gets the value git itself would store, so every reviewable change moves the identity
// and nothing else does:
//  - symlink: the target STRING is git's blob — hash-object would FOLLOW the link and a
//    retarget between byte-identical (or dangling) targets would vanish (F4);
//  - inner repo: its HEAD — but only when the path IS its own repo. A cwd-based rev-parse
//    walks upward and answers with the OUTER head for a plain directory, moving the
//    identity on every commit and re-arming settled gates over identical diffs (F1);
//  - staged gitlink with an uninitialized dir: the staged pointer itself;
//  - anything else: a constant marker, like DELETED_BLOB, so presence still counts.
function blobOf(runRoot: string, rel: string): string {
  const abs = join(runRoot, rel)
  const st = lstatSync(abs, { throwIfNoEntry: false })
  if (!st) return DELETED_BLOB
  if (st.isSymbolicLink()) return `(link)${readlinkSync(abs)}`
  if (st.isFile()) return git(runRoot, 'hash-object', '--', rel)
  if (existsSync(join(abs, '.git'))) {
    const inner = tryGit(abs, 'rev-parse', 'HEAD')
    if (inner.ok) return `(gitlink)${inner.out}`
  }
  const staged = tryGit(runRoot, 'ls-files', '--stage', '--', rel)
  if (staged.ok && staged.out.startsWith('160000 ')) {
    return `(gitlink)${staged.out.split(/\s+/)[1]}`
  }
  return '(non-file)'
}

export function diffReviewedSha(runRoot: string, base: string): string {
  const pairs = changedFiles(runRoot, base).map((rel) => `${rel}\0${blobOf(runRoot, rel)}`)
  return sha256([base, '\n', pairs.sort().join('\n')])
}

// Row 95: implement's identity is the diff AND the plan, because the battery reads both —
// `codePromptBody` serializes the plan into the prompt — so a re-authored plan re-arms the
// gate. It lives here rather than in `gates/implement.ts` because there are THREE readers,
// not two: the gate's `resolve`, the gate's `currentSha`, and `flowAction`, which derives
// the sha itself instead of calling `currentSha`. Two of the three agreeing is the same
// split-brain rows 93 and 95 are about — the gate keyed on one sha while `next` checked
// another, and every settled gate read as lapsed one turn later.
export function implementReviewedSha(runRoot: string, base: string, plan: CanonDoc): string {
  return createHash('sha256')
    .update(diffReviewedSha(runRoot, base))
    .update('\0')
    .update(planContentSha(plan.meta, plan.body))
    .digest('hex')
}

export interface WriteInfo { sha: string; covers?: string[]; created?: boolean }

export function effortWrites(root: string, effort: string): Map<string, WriteInfo> {
  const out = new Map<string, WriteInfo>()
  for (const e of readStream(root, effort)) {
    if (e.t !== 'write') continue
    const w = e as unknown as { artifact: string; sha: string; covers?: string[]; created?: boolean }
    out.set(w.artifact, { sha: w.sha, covers: w.covers, created: w.created })
  }
  return out
}

export function effortSpecs(root: string, canon: Canon, effort: string): CanonDoc[] {
  const docs: CanonDoc[] = []
  for (const id of effortWrites(root, effort).keys()) {
    const doc = findById(canon, id)
    if (doc && doc.meta.type === 'spec') docs.push(doc)
  }
  return docs.sort((a, b) => String(a.meta.id).localeCompare(String(b.meta.id)))
}

export function effortOf(root: string, artifactId: string): string | undefined {
  const hits: Array<{ effort: string; abandoned: boolean }> = []
  for (const effort of effortStreams(root)) {
    const entries = readStream(root, effort)
    if (entries.some((e) => e.t === 'write' && (e as { artifact?: string }).artifact === artifactId)) {
      hits.push({ effort, abandoned: effortAbandoned(entries) })
    }
  }
  hits.sort((a, b) =>
    a.abandoned === b.abandoned ? a.effort.localeCompare(b.effort) : a.abandoned ? 1 : -1)
  return hits[0]?.effort
}

function sha256(parts: string[]): string {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest('hex')
}

export function effortReviewedSha(
  root: string, canon: Canon, effort: string,
): { sha: string; docs: CanonDoc[] } {
  const recap = latestRecap(root, effort)
  const docs = effortSpecs(root, canon, effort)
  const lines = docs
    .map((d) => `${String(d.meta.id)}:${canonicalSha(d.meta, d.body)}`)
    .sort()
  return { sha: sha256([canonicalJson(recap ?? {}), '\n', lines.join('\n')]), docs }
}

export function planPairSha(plan: CanonDoc, parent: CanonDoc): string {
  return sha256([
    `${String(plan.meta.id)}:${canonicalSha(plan.meta, plan.body)}\n`,
    `${String(parent.meta.id)}:${canonicalSha(parent.meta, parent.body)}`,
  ])
}
