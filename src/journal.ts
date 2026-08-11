import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { version } from './version.js'

export type EntryType =
  | 'recap' | 'write' | 'write-refused' | 'gate-run'
  | 'human-decision' | 'drift-check' | 'test-evidence' | 'adopt' | 'status'
  | 'design-write' | 'design-reconfirm' | 'design-stamp' | 'design-shown'
  | 'dispatch' | 'policy-pin'
  // D122. An obligation's whole lifecycle, append-only: minted by a deferral, moved when
  // its flow ends, retyped when the pattern turns out to be a lens problem, and closed by
  // evidence (discharged) or by an explicit human cause (dismissed).
  | 'deferral' | 'deferral-moved' | 'deferral-retyped' | 'deferral-discharged' | 'deferral-dismissed'

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

const dir = (root: string) => join(root, '.witness', 'journal')

export const journalRel = (id: string) => `.witness/journal/${id}.jsonl`

export function streamExists(root: string, id: string): boolean {
  return existsSync(join(root, journalRel(id)))
}

// Row 116. `w` is the CLI that wrote this line. Stamped HERE because entryLine is the
// single funnel every state write passes through, so one edit covers fourteen entry types
// and every verb without a widened signature to disagree over. It is what lets the state
// name its own floor (floor.ts) instead of a stored number that drifts from the entries it
// summarises — and it is why a repo can refuse a CLI older than its own history without
// consulting any payload file, which is the guard row 102 structurally could not be.
export const entryLine = (entry: { t: EntryType; [k: string]: unknown }): string =>
  JSON.stringify({ v: 1, w: version(), ...entry })

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
