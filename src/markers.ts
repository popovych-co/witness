// Row 265 (§4 T2, C16). The conflict-marker check: an opener — `clash.ts`'s `OPENS`, a line starting
// seven or more `<` followed by a space or the line's end — on a line the plan adds to a text file in
// its change set. Only added lines count: a marker the base already holds is not the plan's
// (base-red's per-diagnostic rule, §3.2). A tracked file's added lines come from its diff against the
// base; an untracked file counts whole. A binary file (a NUL in its first 8,000 bytes, git's own
// test) and a symlink are skipped. A bare `=======`, a closer alone and an opener inside a line never
// count (P22). A diff that fails reads the file whole: failing closed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lstatListed } from './change-set.js'
import { OPENS } from './clash.js'
import { tryGitC } from './gitio.js'
import type { GateCheck } from './rounds.js'
import { visible } from './toon.js'

const MAX_LISTED = 10
const BINARY_PROBE = 8_000

const read = (abs: string): Buffer | undefined => {
  try {
    return readFileSync(abs)
  } catch {
    return undefined
  }
}

// Every line of `text`, numbered from 1, that holds an opener.
const wholeFile = (text: string): number[] =>
  text.split('\n').flatMap((l, i) => (OPENS.test(l) ? [i + 1] : []))

// The numbers, in the worktree's file, of the added lines of a `-U0` diff that hold an opener. Only a
// hunk's body is read — the file header before the first `@@` is never a line of the file, so an added
// line that itself reads `++ x` (shown `+++ x`) still counts.
function addedLines(diff: string): number[] {
  const out: number[] = []
  let n: number | undefined
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk !== null) { n = Number(hunk[1]); continue }
    if (n === undefined || !line.startsWith('+')) continue
    if (OPENS.test(line.slice(1))) out.push(n)
    n += 1
  }
  return out
}

// One file's places, or none where it is no regular text file.
function placesIn(wt: string, base: string, file: string): number[] {
  const abs = join(wt, file)
  if (lstatListed(abs)?.isFile() !== true) return []
  const bytes = read(abs)
  if (bytes === undefined || bytes.subarray(0, BINARY_PROBE).includes(0)) return []
  // Slice 2 review M1: a file holding no seven `<` in a row holds no opener on any line — its added
  // lines are lines of it — so it costs no git call. Most of a plan's files end here.
  if (bytes.indexOf('<<<<<<<') === -1) return []
  const listed = tryGitC(wt, '--literal-pathspecs', 'ls-files', '--', file)
  if (listed.ok && listed.out.trim() === '') return wholeFile(bytes.toString('latin1'))
  // `labelled`'s settings (clash.ts): nothing hides a line or misnames the file.
  const d = tryGitC(wt, '--literal-pathspecs', 'diff', '--text', '--no-textconv', '--no-ext-diff', '--no-color',
    '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '-U0', base, '--', file)
  return d.ok ? addedLines(d.out) : wholeFile(bytes.toString('latin1'))
}

// `files` is the plan's change set (PC), `base` its base commit.
export function markersCheck(wt: string, base: string, files: readonly string[]): GateCheck {
  const places = [...files].sort().flatMap((f) => placesIn(wt, base, f).map((n) => `${visible(f)}:${n}`))
  if (places.length === 0) {
    return { name: 'markers', ok: true, detail: `no conflict markers in the lines the plan adds (${files.length} files)` }
  }
  const more = places.length > MAX_LISTED ? ` · and ${places.length - MAX_LISTED} more` : ''
  return { name: 'markers', ok: false, detail: `conflict markers in the lines the plan adds — ${places.slice(0, MAX_LISTED).join(' · ')}${more}` }
}
