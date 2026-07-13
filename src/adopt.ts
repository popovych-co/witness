import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitDoc } from './fm.js'
import { TRAILER, git, tryGit } from './gitio.js'
import { readStream } from './journal.js'
import { canonicalSha } from './sha.js'

export interface Witnessed {
  sha: string
  criteria: unknown
}

const hasTrailer = (root: string, sha: string): boolean =>
  git(root, 'show', '-s', '--format=%B', sha).split('\n').some((l) => l.trim() === TRAILER)

const commitsTouching = (root: string, rel: string): string[] =>
  git(root, 'log', '--format=%H', '--', rel).split('\n').filter(Boolean)

export function lastWitnessed(root: string, rel: string): Witnessed | undefined {
  for (const sha of commitsTouching(root, rel)) {
    if (!hasTrailer(root, sha)) continue
    const raw = tryGit(root, 'show', `${sha}:${rel}`)
    if (!raw.ok) continue
    const doc = splitDoc(raw.out)
    if (!doc.ok) continue
    return { sha: canonicalSha(doc.value.meta, doc.value.body), criteria: doc.value.meta.criteria ?? null }
  }
  return undefined
}

export function untrailedCommitsFor(root: string, rel: string): string[] {
  return commitsTouching(root, rel).filter((sha) => !hasTrailer(root, sha))
}

export function adoptedCommits(root: string): Set<string> {
  const out = new Set<string>()
  const dir = join(root, '.specflow', 'journal')
  if (!existsSync(dir)) return out
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    for (const entry of readStream(root, file.slice(0, -'.jsonl'.length))) {
      if (entry.t !== 'adopt' || !Array.isArray(entry.commits)) continue
      for (const sha of entry.commits as string[]) out.add(sha)
    }
  }
  return out
}
