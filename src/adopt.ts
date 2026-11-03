import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { splitDoc } from './fm.js'
import { TRAILER, git, tryGit } from './gitio.js'
import { readStream } from './journal.js'
import { canonicalSha, VOLATILE_FIELDS } from './sha.js'

export type Position = Record<(typeof VOLATILE_FIELDS)[number], unknown>

// `commit`: the git commit that holds the witnessed state. `position` (row 218): its volatile
// fields — the doc's position, which the content sha leaves out and only the CLI writes.
export interface Witnessed {
  sha: string
  criteria: unknown
  id: string
  commit: string
  position: Position
}

export const positionOf = (meta: Record<string, unknown>): Position =>
  Object.fromEntries(VOLATILE_FIELDS.map((f) => [f, meta[f]])) as Position

const hasTrailer = (root: string, sha: string): boolean =>
  git(root, 'show', '-s', '--format=%B', sha).split('\n').some((l) => l.trim() === TRAILER)

const commitsTouching = (root: string, rel: string): string[] =>
  git(root, 'log', '--format=%H', '--', rel).split('\n').filter(Boolean)

// Row 218. The same walk through a move: each commit with the path the file had in it, so a
// doc moved by hand (`git mv`, D167) is measured against the state it was witnessed in before.
function commitsFollowing(root: string, rel: string): Array<{ sha: string; path: string }> {
  return git(root, 'log', '--follow', '--format=%x00%H', '--name-only', '--', rel).split('\0').flatMap((chunk) => {
    const [sha, ...paths] = chunk.split('\n').filter(Boolean)
    return sha === undefined ? [] : [{ sha, path: paths[0] ?? rel }]
  })
}

// `absolved`: commits an `adopt` entry took in (`adoptedCommits`), which count as witnessed too —
// a hand commit that `adopt` absolved is the doc's witnessed state from then on. `follow` walks
// the file's history through a move (row 218's position baseline).
export function lastWitnessed(
  root: string, rel: string, absolved: Set<string> = new Set(), opts: { follow?: boolean } = {},
): Witnessed | undefined {
  const walk = opts.follow === true ? commitsFollowing(root, rel) : commitsTouching(root, rel).map((sha) => ({ sha, path: rel }))
  for (const { sha, path } of walk) {
    if (!hasTrailer(root, sha) && !absolved.has(sha)) continue
    const raw = tryGit(root, 'show', `${sha}:${path}`)
    if (!raw.ok) continue
    const doc = splitDoc(raw.out)
    if (!doc.ok) continue
    return {
      sha: canonicalSha(doc.value.meta, doc.value.body), criteria: doc.value.meta.criteria ?? null, id: String(doc.value.meta.id),
      commit: sha, position: positionOf(doc.value.meta),
    }
  }
  return undefined
}

export function untrailedCommitsFor(root: string, rel: string): string[] {
  return commitsTouching(root, rel).filter((sha) => !hasTrailer(root, sha))
}

export function adoptedCommits(root: string): Set<string> {
  const out = new Set<string>()
  const dir = join(root, '.witness', 'journal')
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
