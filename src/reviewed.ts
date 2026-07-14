import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, canonicalSha } from './sha.js'
import { effortAbandoned, effortStreams, latestRecap, readStream } from './journal.js'
import type { Canon, CanonDoc } from './scan.js'
import { findById } from './scan.js'

export function worktreeTreeSha(root: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'specflow-idx-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') }
  try {
    execFileSync('git', ['add', '-A'], { cwd: root, env })
    return execFileSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
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
