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

// Final review F1. An adopt absolves its commits for the doc it adopted — the stream it is
// journaled on — never for every doc those commits touched: one hand commit that forged one doc's
// position and edited another's body was laundered by adopting the innocent one.
export function adoptedCommitsFor(root: string, id: string): Set<string> {
  const out = new Set<string>()
  for (const entry of readStream(root, id)) {
    if (entry.t !== 'adopt' || !Array.isArray(entry.commits)) continue
    for (const sha of entry.commits as string[]) out.add(sha)
  }
  return out
}

// For the trailer audit: each absolved commit and the doc ids it was absolved for (the stream,
// and the entry's artifact, which a later rename may leave apart).
export function absolutions(root: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const dir = join(root, '.witness', 'journal')
  if (!existsSync(dir)) return out
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const stream = file.slice(0, -'.jsonl'.length)
    for (const entry of readStream(root, stream)) {
      if (entry.t !== 'adopt' || !Array.isArray(entry.commits)) continue
      for (const sha of entry.commits as string[]) {
        const ids = out.get(sha) ?? new Set<string>()
        ids.add(stream)
        if (typeof entry.artifact === 'string') ids.add(entry.artifact)
        out.set(sha, ids)
      }
    }
  }
  return out
}

// Security review. The state paths a commit changed that no adopt absolved it for: a spec or
// plan whose id (as it stood there, or in the parent for a deletion) is not among `ids`, and
// every other audited path — a journal line or a design file is never a hand edit adopt takes in.
// Empty means the commit is absolved whole.
export function unabsolvedPaths(
  root: string, sha: string, ids: Set<string>, dirs: { docs: string[]; other: string[] },
): string[] {
  const under = (p: string, ds: string[]): boolean => ds.some((d) => p.startsWith(`${d}/`))
  // NUL-separated status/path pairs: never quoted, whatever bytes a path carries. Anything that
  // does not parse is reported, never skipped. Against the first parent, so a merge's own changes
  // are read (diff-tree on a merge alone prints nothing); a root commit against the empty tree.
  const [, parent] = git(root, 'rev-list', '--parents', '-n', '1', sha).split(' ')
  const fields = (parent !== undefined
    ? git(root, 'diff-tree', '-z', '--no-renames', '--name-status', '-r', parent, sha)
    : git(root, 'diff-tree', '-z', '--no-commit-id', '--no-renames', '--name-status', '-r', '--root', sha))
    .split('\0').filter((x) => x !== '')
  const out: string[] = []
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i]!
    const p = fields[i + 1]
    if (p === undefined || !/^[ACDMTUX]$/.test(status)) { out.push(`(unparsed: ${status})`); continue }
    if (under(p, dirs.docs) && p.endsWith('.md')) {
      const raw = tryGit(root, 'show', `${status === 'D' ? `${sha}^` : sha}:${p}`)
      const doc = raw.ok ? splitDoc(raw.out) : undefined
      const id = doc?.ok && typeof doc.value.meta.id === 'string' ? doc.value.meta.id : undefined
      if (id === undefined || !ids.has(id)) out.push(p)
    } else if (under(p, [...dirs.docs, ...dirs.other])) out.push(p)
  }
  return out
}
