import type { Ctx } from './cli.js'
import { FLOOR_STREAM } from './floor.js'
import { stateCommit } from './gitio.js'
import { appendEntry, effortStreams, entryLine, journalRel, readStream } from './journal.js'
import { acquireLock } from './lock.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { crashPoint, pendingTxn, withTxn } from './txn.js'

// Row 176. The human's ask is journaled state, on a stream witness owns the way it owns
// `floor`. This module is its one home: the entries, the queue derived from them, and the
// one write path the verb, `/witness <text>` and `drive --ask` share — so a crashed session
// loses nothing, because the brainstorm that answers an ask reads it from here, never from
// its prompt.
export const ASK_STREAM = 'asks'

export interface AskEntry { v: 1; t: 'ask'; id: string; text: string }   // id: a1 · a2 · … in queue order

export interface AskStatus {
  id: string
  text: string
  state: 'unanswered' | 'answered' | 'withdrawn'
  effort?: string   // answered: the effort whose recap names it
}

// Display only: the stored text is the human's, trimmed and otherwise as given.
export function askText(text: string): string {
  return oneLine(text)
}

// Text a human or a model wrote, made safe to print where a reader parses lines: the
// skills read `next`'s unit line by line, and a prompt section must never open a heading of
// its own. Whitespace runs collapse to one space; the words stay as written.
export function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

export function askQueue(root: string): AskStatus[] {
  const out: AskStatus[] = []
  // Row 194. A `human-decision` entry on this stream is an old recap check (row 177): history
  // `log` still prints, and nothing a queue derives from.
  for (const e of readStream(root, ASK_STREAM)) {
    if (e.t === 'ask') out.push({ id: String(e.id), text: String(e.text), state: 'unanswered' })
    else if (e.t === 'ask-withdrawn') {
      const a = out.find((x) => x.id === e.ask)
      if (a) a.state = 'withdrawn'
    }
  }
  // An ask is answered once any recap names it, even one an abandon later ended: re-asking is
  // the human's act, so an abandoned effort never puts its ask back in the queue.
  const answeredBy = new Map<string, string>()
  for (const effort of effortStreams(root)) {
    for (const e of readStream(root, effort)) {
      if (e.t === 'recap' && typeof e.ask === 'string' && !answeredBy.has(e.ask)) answeredBy.set(e.ask, effort)
    }
  }
  for (const a of out) {
    const effort = answeredBy.get(a.id)
    if (effort !== undefined) { a.state = 'answered'; a.effort = effort }
  }
  return out
}

// The one list of stream ids witness owns. A stream id is an artifact's whole history, so an
// effort, spec, plan or rename that took one of these would merge two histories into one.
export function reservedId(id: string): string | undefined {
  if (id === ASK_STREAM) return "witness's own ask queue"
  if (id === FLOOR_STREAM) return "witness's own floor stream"
  return undefined
}

const TEXT_REQUIRED = v('text', 'required', 'absent', 'what to build in words — witness ask <text>')

export function queueAsk(ctx: Ctx, root: string, text: string): Result<{ id: string; unanswered: number; already: boolean }> {
  if (askText(text) === '') return refuse([TEXT_REQUIRED])
  const lock = acquireLock(root)
  if (!lock.ok) return lock
  try {
    // Under the lock: a writer that crashed before this one took it left its marker here.
    const pending = pendingTxn(root)
    if (pending) return refuse([v('.witness/txn.json', 'pending-txn', pending.op, 'witness recover --complete | --rollback')])
    // Final review F7: a stream an older witness wrote under this name is another artifact's
    // history, and asks appended to it would be read as part of that artifact.
    const first = readStream(root, ASK_STREAM)[0]
    if (first !== undefined && first.t !== 'ask') {
      return refuse([v(ASK_STREAM, 'stream-taken', `the stream starts with ${first.t}`, 'a stream for asks alone — witness check names the artifact that holds it')])
    }
    // Final review F10: the same words while that ask is still open are the same ask — a
    // crashed `/witness <words>` run again must not queue, and build, the work twice.
    const queue = askQueue(root)
    const unanswered = (): number => askQueue(root).filter((a) => a.state === 'unanswered').length
    const open = queue.find((a) => a.state === 'unanswered' && askText(a.text) === askText(text))
    if (open !== undefined) return ok({ id: open.id, unanswered: unanswered(), already: true })
    // numbered under the lock: two queuers racing must not both take the next id
    const id = `a${queue.length + 1}`
    const entry = { t: 'ask' as const, id, text: text.trim() }
    const stream = journalRel(ASK_STREAM)
    const res = withTxn(root, { op: `ask(${id})`, files: [stream], journal: { stream: ASK_STREAM, line: entryLine(entry) } }, () => {
      appendEntry(root, ASK_STREAM, entry)
      crashPoint(ctx.env, 'journal-append')
      return stateCommit(root, [stream], `ask(${id}): ${askText(text).slice(0, 60)}`)
    })
    if (!res.ok) return res
    return ok({ id, unanswered: unanswered(), already: false })
  } finally {
    lock.value()
  }
}

export function withdrawAsk(ctx: Ctx, root: string, id: string, note?: string): Result<{ already: boolean }> {
  const lock = acquireLock(root)
  if (!lock.ok) return lock
  try {
    const pending = pendingTxn(root)
    if (pending) return refuse([v('.witness/txn.json', 'pending-txn', pending.op, 'witness recover --complete | --rollback')])
    const ask = askQueue(root).find((a) => a.id === id)
    if (!ask) return refuse([v('--withdraw', 'unknown-ask', id, 'an ask id — witness status lists the queue')])
    if (ask.state === 'withdrawn') return ok({ already: true })
    if (ask.state === 'answered') {
      return refuse([v('--withdraw', 'ask-answered', `${id} is answered by ${ask.effort}`,
        `an unanswered ask — ${ask.effort} answers it now · witness abandon ${ask.effort} ends that effort`)])
    }
    const entry = { t: 'ask-withdrawn' as const, ask: id, ...(note !== undefined ? { note } : {}) }
    const stream = journalRel(ASK_STREAM)
    const res = withTxn(root, { op: `ask(${id})`, files: [stream], journal: { stream: ASK_STREAM, line: entryLine(entry) } }, () => {
      appendEntry(root, ASK_STREAM, entry)
      crashPoint(ctx.env, 'journal-append')
      return stateCommit(root, [stream], `ask(${id}): withdrawn`)
    })
    if (!res.ok) return res
    return ok({ already: false })
  } finally {
    lock.value()
  }
}

// The one derivation of which ask is routed next: the oldest still open.
export function nextAsk(root: string): AskStatus | undefined {
  return askQueue(root).find((a) => a.state === 'unanswered')
}

// The ask an effort answers: what the decompose arbiter judges a slicing against beside the
// recap itself (row 177). Named by the recap that birthed the effort — an amend carries no
// ask, and it is exactly a re-scoped slicing that must still be judged against the ask.
export function askOf(root: string, effort: string): AskEntry | undefined {
  const id = readStream(root, effort).find((e) => e.t === 'recap' && typeof e.ask === 'string')?.ask
  if (id === undefined) return undefined
  return (readStream(root, ASK_STREAM) as unknown as AskEntry[]).find((e) => e.t === 'ask' && e.id === id)
}
