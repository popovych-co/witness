import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ID_RE } from './dsl.js'
import { idTextList } from './idlists.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import { ensureExcluded } from './worktree.js'

// Row 199. A conversation's local draft: the grill's settled answers, or the design session's
// direction, answers and page, saved after every settled answer so a session that dies, hits its
// limit or relays loses nothing. Local, never committed and never journaled: the recap or the
// stamped look is the record, and a draft is only the memory of the conversation that reaches it.
// Keyed by what the conversation is about. This module reaches no ask.ts, scan.ts or verb, so
// each of those may import it.
export const DRAFTS_DIR = '.witness/drafts'

export type DraftKey = { kind: 'ask'; id: string } | { kind: 'amend'; effort: string } | { kind: 'design'; spec: string }

// `session` is the last saver's; `read` the other sessions that read that content back since, each
// of which has seen every answer in it (Builder's call 11).
export interface StoredDraft { v: 1; key: string; session?: string; read?: string[]; draft: Record<string, unknown> }

export function parseKey(key: string): DraftKey | undefined {
  const ask = /^ask-(a[0-9]+)$/.exec(key)
  if (ask) return { kind: 'ask', id: ask[1]! }
  for (const kind of ['amend', 'design'] as const) {
    const rest = key.startsWith(`${kind}-`) ? key.slice(kind.length + 1) : undefined
    if (rest === undefined || !ID_RE.test(rest)) continue
    return kind === 'amend' ? { kind, effort: rest } : { kind, spec: rest }
  }
  return undefined
}

export function keyName(k: DraftKey): string {
  return k.kind === 'ask' ? `ask-${k.id}` : k.kind === 'amend' ? `amend-${k.effort}` : `design-${k.spec}`
}

export const draftRel = (k: DraftKey): string => `${DRAFTS_DIR}/${keyName(k)}.json`

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

const unreadable = (k: DraftKey): Result<never> =>
  refuse([v('key', 'draft-unreadable', draftRel(k), 'a draft witness wrote — save over it with --file')])

// ok(undefined) is "none saved". A file that does not parse as a stored draft is refused, never
// read as empty: the draft is a resumed session's only memory.
export function readDraft(root: string, k: DraftKey): Result<StoredDraft | undefined> {
  const path = join(root, draftRel(k))
  if (!existsSync(path)) return ok(undefined)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return unreadable(k) }
  if (!isObject(raw) || raw.v !== 1 || !isObject(raw.draft)) return unreadable(k)
  const read = Array.isArray(raw.read) ? raw.read.filter((x): x is string => typeof x === 'string') : []
  return ok({
    v: 1, key: keyName(k), draft: raw.draft,
    ...(typeof raw.session === 'string' ? { session: raw.session } : {}),
    ...(read.length ? { read } : {}),
  })
}

const writeStored = (root: string, k: DraftKey, stored: StoredDraft): void => {
  const path = join(root, draftRel(k))
  writeFileSync(`${path}.tmp`, `${JSON.stringify(stored, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

// Written aside and renamed into place, so a crash never leaves half a draft. The exclusion
// first: a repo whose .gitignore predates drafts must never show one to `git status`.
export function saveDraft(root: string, k: DraftKey, draft: Record<string, unknown>, session: string | undefined): void {
  ensureExcluded(root)
  mkdirSync(join(root, DRAFTS_DIR), { recursive: true })
  writeStored(root, k, { v: 1, key: keyName(k), ...(session !== undefined ? { session } : {}), draft })
}

// A read-back by a session other than the saver records it: that session has now seen every answer
// in this content, so its next save may drop or reword one. Not an act (row 191 reads `session`
// only), and a new save clears the list, because its content is unseen again.
export function markRead(root: string, k: DraftKey, stored: StoredDraft, session: string): void {
  if (stored.session === undefined || stored.session === session || stored.read?.includes(session)) return
  writeStored(root, k, { ...stored, read: [...(stored.read ?? []), session] })
}

export function dropDraft(root: string, k: DraftKey): void {
  rmSync(join(root, draftRel(k)), { force: true })
}

// Row 191 reads these beside the journal: a settled answer saved is the session's stage work.
export function draftSessions(root: string): string[] {
  const dir = join(root, DRAFTS_DIR)
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const k = parseKey(f.slice(0, -'.json'.length))
    if (k === undefined) continue
    const d = readDraft(root, k)
    if (d.ok && d.value?.session !== undefined) out.push(d.value.session)
  }
  return out
}

const GRILL_FIELDS = ['effort', 'class', 'goals', 'non_goals', 'constraints', 'decisions', 'slices', 'open']
const DESIGN_FIELDS = ['direction', 'answers', 'open', 'page']
const ID_LISTS = [['goals', 'g'], ['non_goals', 'n'], ['constraints', 'c'], ['decisions', 'd']] as const

const stringList = (raw: unknown, field: string): Violation[] =>
  raw === undefined || (Array.isArray(raw) && raw.every((s) => typeof s === 'string' && s.trim() !== ''))
    ? []
    : [v(field, 'shape', JSON.stringify(raw), 'list of non-empty strings')]

// The shape, never completeness: a draft is the recap so far. An unknown field is refused, because
// a field dropped without a word would be a lost answer.
export function validateDraft(k: DraftKey, raw: unknown): Violation[] {
  if (!isObject(raw)) {
    return [v('draft', 'shape', Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw, 'JSON object')]
  }
  const allowed = k.kind === 'design' ? DESIGN_FIELDS : GRILL_FIELDS
  const out: Violation[] = Object.keys(raw).filter((f) => !allowed.includes(f))
    .map((f) => v(f, 'unknown-field', f, `one of ${allowed.join(' ')}`))
  if (k.kind === 'design') {
    if (raw.direction !== undefined && (typeof raw.direction !== 'string' || raw.direction.trim() === '')) {
      out.push(v('direction', 'shape', JSON.stringify(raw.direction), 'non-empty string'))
    }
    out.push(...stringList(raw.answers, 'answers'), ...stringList(raw.open, 'open'))
    if (raw.page !== undefined && typeof raw.page !== 'string') out.push(v('page', 'shape', typeof raw.page, 'string'))
    return out
  }
  if (raw.effort !== undefined) {
    if (typeof raw.effort !== 'string' || !ID_RE.test(raw.effort)) {
      out.push(v('effort', 'id-charset', String(raw.effort), '[a-z0-9-]+'))
    } else if (k.kind === 'amend' && raw.effort !== k.effort) {
      out.push(v('effort', 'effort-mismatch', raw.effort, `${k.effort} — the effort this draft amends`))
    }
  }
  if (raw.class !== undefined && raw.class !== 'feature' && raw.class !== 'fix' && raw.class !== 'chore') {
    out.push(v('class', 'enum', String(raw.class), 'feature | fix | chore'))
  }
  for (const [field, prefix] of ID_LISTS) out.push(...idTextList(raw[field], field, prefix, false))
  out.push(...stringList(raw.slices, 'slices'), ...stringList(raw.open, 'open'))
  return out
}

const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])

// What a save by a session that has not seen this draft must keep of it (Builder's call 11), by
// content: two chats both number their first answer g1, so an id alone cannot tell their answers
// apart. A grill's items are its four lists' `id: text`; a look's are its chosen direction, each
// settled answer, and whether a page is saved (the page itself changes with every save).
export function settledItems(k: DraftKey, draft: Record<string, unknown>): string[] {
  if (k.kind === 'design') {
    return [
      ...(typeof draft.direction === 'string' && draft.direction !== '' ? [`direction: ${draft.direction}`] : []),
      ...list(draft.answers).filter((a): a is string => typeof a === 'string').map((a) => `answer: ${a}`),
      ...(typeof draft.page === 'string' && draft.page !== '' ? ['page'] : []),
    ]
  }
  return ID_LISTS.flatMap(([field]) => list(draft[field]))
    .map((e) => (isObject(e) && typeof e.id === 'string' ? `${e.id}: ${String(e.text)}` : undefined))
    .filter((item): item is string => item !== undefined)
}

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function draftSummary(k: DraftKey, draft: Record<string, unknown>): string {
  if (k.kind === 'design') {
    const chosen = typeof draft.direction === 'string' && draft.direction !== ''
    const page = typeof draft.page === 'string' && draft.page !== ''
    return `direction ${chosen ? 'chosen' : 'open'} · ${count(list(draft.answers).length, 'answer')} settled · page ${page ? 'saved' : 'none'}`
  }
  const items = ID_LISTS.reduce((n, [field]) => n + list(draft[field]).length, 0)
  const open = list(draft.open).length
  return `${count(items, 'item')} settled${open > 0 ? ` · ${open} open` : ''}`
}

// `next`'s line for a conversation that has a draft. None, or one that does not read, prints
// nothing: an unreadable draft is refused by name where it is read back, never here.
export function draftLine(root: string, k: DraftKey): string | undefined {
  const d = readDraft(root, k)
  if (!d.ok || d.value === undefined) return undefined
  return `${draftSummary(k, d.value.draft)} · resume with witness draft ${keyName(k)}`
}
