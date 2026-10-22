import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tryGit } from './gitio.js'
import { version } from './version.js'

export type EntryType =
  | 'recap' | 'write' | 'write-refused' | 'gate-run'
  | 'human-decision' | 'drift-check' | 'test-evidence' | 'adopt' | 'status'
  | 'design-write' | 'design-reconfirm' | 'design-stamp' | 'design-shown'
  | 'dispatch' | 'policy-pin'
  // D138. An automatic act needs a record: the sync the merge stamp and `start` run
  // on the human's behalf, with its trigger and outcome.
  | 'sync'
  // D154. A trust grant is a human act with consequences at headless gates, so it is
  // recorded like every other one: which commands, and through which surface.
  | 'trust'
  // D122. An obligation's whole lifecycle, append-only: minted by a deferral, moved when
  // its flow ends, retyped when the pattern turns out to be a lens problem, and closed by
  // evidence (discharged) or by an explicit human cause (dismissed).
  | 'deferral' | 'deferral-moved' | 'deferral-retyped' | 'deferral-discharged' | 'deferral-dismissed'
  // Row 176. The human's ask, queued on witness's own `asks` stream, and its withdrawal.
  | 'ask' | 'ask-withdrawn'
  // Row 179. A human's assertion that a manual need is met: journaled, never a frontmatter
  // rewrite, so no content sha moves when the world changes.
  | 'need-satisfied'
  // Row 191 §4.3. A scaffolding step's close. Such a step has no red→green to witness, and
  // until now it left no trace, so the CLI could not tell where a plan stood.
  | 'step-close'

export interface Entry {
  v: 1
  t: EntryType
  [k: string]: unknown
}

export interface RecapEntry extends Entry {
  t: 'recap'
  effort: string
  class: 'feature' | 'fix' | 'chore'
  goals: Array<{ id: string; text: string }>
  non_goals: Array<{ id: string; text: string }>
  constraints: Array<{ id: string; text: string }>
  slices: string[]
  ask?: string   // row 176: the ask this recap answers
}

export type StatusCause = 'gate-approve' | 'start' | 'ship' | 'merge' | 'abandon' | 'supersede'

export interface StatusEntry {
  v: 1
  t: 'status'
  artifact: string
  from: string
  to: string
  cause: StatusCause
  run_id?: string
  worktree?: string
  branch?: string
  pr?: number
  by?: string
  note?: string
}

// Row 191 §4.8. The session a line was written in, as a hash (the journal is committed, so
// never the raw id), and the harness's reading beside it when that reading was trusted.
export interface JournalCtx { session: string; tokens?: number; window?: number }

const dir = (root: string) => join(root, '.witness', 'journal')

export const journalRel = (id: string) => `.witness/journal/${id}.jsonl`

export function streamExists(root: string, id: string): boolean {
  return existsSync(join(root, journalRel(id)))
}

// Row 191 §4.8. The stamp of the invocation that is writing. `main` opens the scope once per
// command, and it is async-local rather than a module variable, so two invocations overlapping
// in one process (a test's racing CLIs, a decision drive runs in process) each write their own
// session, never the other's.
const journalCtx = new AsyncLocalStorage<JournalCtx | undefined>()

export function withJournalCtx<T>(c: JournalCtx | undefined, fn: () => T): T {
  return journalCtx.run(c, fn)
}

// Row 116. `w` is the CLI that wrote this line. Stamped HERE because entryLine is the
// single funnel every state write passes through, so one edit covers fourteen entry types
// and every verb without a widened signature to disagree over. It is what lets the state
// name its own floor (floor.ts) instead of a stored number that drifts from the entries it
// summarises — and it is why a repo can refuse a CLI older than its own history without
// consulting any payload file, which is the guard row 102 structurally could not be.
//
// Row 191 stamps `ctx` here for the same reason: every kind carries the session it was
// written in, and the reading when there was one, with no per-kind case to forget. The stamp
// is the writer's alone. A `ctx` the entry carries is dropped, since a line read back and
// journaled again (a deferral moving home, D122) is written by its mover; the writer's own
// goes last, after the content, and only when the writer runs in a session.
export const entryLine = (entry: { t: EntryType; [k: string]: unknown }): string => {
  const { ctx: _carried, ...content } = entry
  const ctx = journalCtx.getStore()
  return JSON.stringify({ v: 1, w: version(), ...content, ...(ctx !== undefined ? { ctx } : {}) })
}

export function appendEntry(root: string, id: string, entry: { t: EntryType; [k: string]: unknown }): string {
  mkdirSync(dir(root), { recursive: true })
  const line = entryLine(entry)
  appendFileSync(join(root, journalRel(id)), line + '\n')
  return line
}

export function readStream(root: string, id: string): Entry[] {
  if (!streamExists(root, id)) return []
  return readFileSync(join(root, journalRel(id)), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry)
}

// D168, D189. Each line of a stream with the commit that appended it — `git blame` names it,
// since the journal is append-only — as history stood at `at`, or as the file stands now when
// `at` is absent (a line not yet committed carries git's all-zero id). `--no-ignore-revs-file`: a
// dotfile's `blame.ignoreRevsFile` re-attributes lines, or fails blame outright in a repo that
// lacks the file. A blank line is skipped, as `readStream` skips it. SHA-1 or SHA-256 ids.
export function journalActs(root: string, stream: string, at?: string): Array<{ entry: Entry; commit: string }> {
  const blame = tryGit(root, 'blame', '--line-porcelain', '--no-ignore-revs-file', ...(at === undefined ? [] : [at]), '--', journalRel(stream))
  if (!blame.ok) return []
  const out: Array<{ entry: Entry; commit: string }> = []
  let commit = ''
  for (const line of blame.out.split('\n')) {
    const head = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) \d+ \d+/.exec(line)
    if (head) { commit = head[1]!; continue }
    if (line.startsWith('\t') && line.trim() !== '') out.push({ entry: JSON.parse(line.slice(1)) as Entry, commit })
  }
  return out
}

export function latestRecap(root: string, effort: string): RecapEntry | undefined {
  const recaps = readStream(root, effort).filter((e): e is RecapEntry => e.t === 'recap')
  return recaps.at(-1)
}

export function effortStreams(root: string): string[] {
  if (!existsSync(dir(root))) return []
  return readdirSync(dir(root))
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .filter((id) => readStream(root, id)[0]?.t === 'recap')
    .sort()
}

export function effortAbandoned(entries: Entry[]): boolean {
  return entries.some((e) => e.t === 'human-decision' && e.decision === 'abandon-effort')
}

// Row 83: human-authored content policies, plan-scoped and append-only. All pins are
// live — supersession is by prompt order (later pins win where they conflict), never
// by deletion; graduation to spec truth goes through --revise --upstream.
export interface PolicyPin { ordinal: number; text: string }

export function policyPins(entries: Entry[]): PolicyPin[] {
  return entries
    .filter((e) => e.t === 'policy-pin')
    .map((e, i) => ({ ordinal: Number(e.ordinal ?? i + 1), text: String(e.text ?? '') }))
}
