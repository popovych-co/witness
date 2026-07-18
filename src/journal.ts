import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type EntryType =
  | 'recap' | 'write' | 'write-refused' | 'gate-run'
  | 'human-decision' | 'drift-check' | 'test-evidence' | 'adopt' | 'status'
  | 'design-write' | 'design-reconfirm' | 'design-stamp'

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

const dir = (root: string) => join(root, '.specflow', 'journal')

export const journalRel = (id: string) => `.specflow/journal/${id}.jsonl`

export function streamExists(root: string, id: string): boolean {
  return existsSync(join(root, journalRel(id)))
}

export const entryLine = (entry: { t: EntryType; [k: string]: unknown }): string =>
  JSON.stringify({ v: 1, ...entry })

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
