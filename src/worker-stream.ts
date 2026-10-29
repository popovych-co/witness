import { logSafe } from './toon.js'

// Row 214 (issue #64). What drive shows of a running session. Row 145 promised the child's own
// output as the progress report, but print mode writes only the session's last answer, after it
// ends: a two-hour session was one silent line. Each harness has an event-stream mode instead
// (pi `--mode json`, claude `--output-format stream-json`) that writes every event as it happens,
// and these renderers turn each event into a few short lines.
//
// A renderer also hands drive what it never prints: each tool's output, which is where the CLI's
// merge line lands when an agent runs `witness ship` (the merge sniff reads it), and whether the
// session's last answer was an error — pi's JSON mode exits 0 on one, so row 182's limit check
// could not see it from the exit code.
//
// The event shapes are the harnesses' own and change with their releases. A renderer never
// throws: every field is type-checked before it is used, an unknown event renders nothing, and a
// record that is not a JSON object passes through, capped. So a new shape makes the log quieter,
// never a crash: drive's own `started`, `still running`, `journal:` and `ended` lines are drive's,
// and stay.

export type WorkerLine =
  | { kind: 'show'; text: string }       // printed under the session's prefix, logSafe'd
  | { kind: 'heard'; text: string }      // a line of a tool's output, logSafe'd: drive reads it, never prints it
  | { kind: 'session'; id: string }      // emitted when the stream first names an id, or names a new one

export interface WorkerStream {
  line(record: string): WorkerLine[]     // one stdout record, LF and trailing CR gone; never throws
  inFlight(): string | undefined         // the oldest open tool call's action line, else 'the model' while it is awaited
  failed(): boolean                      // the session's last answer was an error
}

// One action line is one terminal line: a heredoc or a 40 KB `Write` must not flood the log.
export const ACTION_MAX = 160
// A record that is no event — a warning a harness printed, half a record — is shown as written,
// up to this many code points: one that runs to megabytes is still one line.
export const PASSTHROUGH_MAX = 400

// The verbs a human reads at a glance, by lower-cased tool name — claude's `Read` and pi's `read`
// are one action. `path` marks an argument shown relative to the session's home. A Map, so a tool
// named `constructor` or `__proto__` is any other tool, never one of Object's own keys.
const ACTIONS = new Map<string, { verb: string; keys: string[]; path?: true }>([
  ['bash', { verb: '$', keys: ['command'] }],
  ['powershell', { verb: '$', keys: ['command'] }],
  ['read', { verb: 'read', keys: ['path', 'file_path'], path: true }],
  ['edit', { verb: 'edit', keys: ['path', 'file_path'], path: true }],
  ['multiedit', { verb: 'edit', keys: ['path', 'file_path'], path: true }],
  ['notebookedit', { verb: 'edit', keys: ['notebook_path'], path: true }],
  ['write', { verb: 'write', keys: ['path', 'file_path'], path: true }],
  ['grep', { verb: 'grep', keys: ['pattern'] }],
  ['find', { verb: 'find', keys: ['pattern'] }],
  ['glob', { verb: 'find', keys: ['pattern'] }],
  ['ls', { verb: 'ls', keys: ['path'], path: true }],
])

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Json : undefined
const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined
// A count or a status as written; anything else is no value. `String()` of an object a record
// carries could throw (`{"toString": 1}`), so it is never called on one.
const scalar = (v: unknown): string | undefined => typeof v === 'string' || typeof v === 'number' ? String(v) : undefined
const lines = (text: string): string[] => text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '')

// Each index of a command line that sits outside quotes, `$(…)` and `${…}`. Unbalanced text never
// returns to the top, so a stray quote keeps the rest of the line whole.
function* topLevel(s: string): Generator<number> {
  const open: string[] = []                  // the closer each open context waits for
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    const closer = open.at(-1)
    if (closer === "'") { if (c === "'") open.pop(); continue }
    if (c === '\\') { i += 1; continue }
    if (c === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) { open.push(s[i + 1] === '(' ? ')' : '}'); i += 1; continue }
    if (closer === '"') { if (c === '"') open.pop(); continue }
    if (c === "'" || c === '"') { open.push(c); continue }
    if (closer === ')' && c === '(') { open.push(')'); continue }
    if (closer !== undefined) { if (c === closer) open.pop(); continue }
    yield i
  }
}

// The leading segment of a command line and what follows its separator: an `&&`, `;` or newline
// at the top level.
function leading(s: string): { head: string; rest: string } {
  for (const i of topLevel(s)) {
    if (s[i] === '\n' || s[i] === ';') return { head: s.slice(0, i), rest: s.slice(i + 1) }
    if (s[i] === '&' && s[i + 1] === '&') return { head: s.slice(0, i), rest: s.slice(i + 2) }
  }
  return { head: s, rest: '' }
}

function words(s: string): string[] {
  const out: string[] = []
  let start = 0
  for (const i of topLevel(s)) {
    if (/\s/.test(s[i]!)) { if (i > start) out.push(s.slice(start, i)); start = i + 1 }
  }
  if (s.length > start) out.push(s.slice(start))
  return out
}

// What a command line sets up before the command it runs: `cd <dir>`, `[export ]NAME=<value>`,
// `set -<flags>[ <words>]` — and nothing, the empty segment an `&&` at a line's end leaves.
const ASSIGNMENT = /^[A-Za-z_]\w*=/
function preamble(segment: string): boolean {
  const w = words(segment)
  if (w.length === 0) return true
  if (w[0] === 'cd') return w.length === 2
  if (w[0] === 'set') return w.length >= 2 && /^[-+][A-Za-z]+$/.test(w[1]!)
  if (w[0] === 'export') return w.length === 2 && ASSIGNMENT.test(w[1]!)
  return w.length === 1 && ASSIGNMENT.test(w[0]!)
}

const WITNESS_VAR = /"\$\{WITNESS\}"|"\$WITNESS"|\$\{WITNESS\}|\$WITNESS(?!\w)/g

// P15: nine in ten of a real implement session's shell calls start `cd <worktree> && WITNESS=…;`,
// and cut at ACTION_MAX most witness calls lost their verb. The command a call runs is what is
// left once its leading setup is gone, with the stage skills' `$WITNESS` read as the `witness` it
// is. A line that is nothing but setup stays as written.
export function shellCommand(command: string): string {
  let rest = command
  for (;;) {
    const { head, rest: after } = leading(rest)
    if (!preamble(head)) break
    rest = after
    if (rest.trim() === '') return command
  }
  return rest.trimStart().replace(WITNESS_VAR, 'witness')
}

// A path under the session's home, from it. Compared on `/`, and without case under a drive
// letter, as Windows compares: `C:\R\src\a.rs` is `src/a.rs` in the home `c:/r`.
function relative(p: string, home: string): string {
  const h = home.replaceAll('\\', '/').replace(/\/+$/, '')
  const q = p.replaceAll('\\', '/')
  if (h === '') return p
  const fold = /^[A-Za-z]:/.test(h) ? (x: string) => x.toLowerCase() : (x: string) => x
  if (fold(q) === fold(h)) return '.'
  return q[h.length] === '/' && fold(q.slice(0, h.length)) === fold(h) ? q.slice(h.length + 1) : p
}

// `$ cargo test discovery`, `read src/a.rs`: what a tool call does, in one line. Any other tool is
// its name and its first string argument (`Task review the diff`). In this order: a shell
// command loses its setup (shellCommand), only its first line is kept, a path is made relative to
// the home, the line is spelled out (logSafe), and then cut — so ACTION_MAX bounds what the
// terminal shows. An action line says what was attempted: a call a guard refused reads the same.
export function actionLine(tool: string, args: unknown, home: string): string {
  const a = obj(args) ?? {}
  const known = ACTIONS.get(tool.toLowerCase())
  const raw = known !== undefined ? known.keys.map((k) => str(a[k])).find((v) => v !== undefined) : Object.values(a).map(str).find((v) => v !== undefined)
  const arg = raw !== undefined && known?.verb === '$' ? shellCommand(raw) : raw
  const [first = '', ...rest] = (arg ?? '').split('\n')
  const more = rest.some((l) => l.trim() !== '') ? ' …' : ''
  const head = known?.verb ?? tool
  const said = first.replace(/\r$/, '')
  const shown = known?.path ? relative(said, home) : said
  const line = logSafe(shown === '' ? head : `${head} ${shown}${more}`)
  const chars = [...line]
  return chars.length <= ACTION_MAX ? line : `${chars.slice(0, ACTION_MAX - 1).join('')}…`
}

// A record shown as written, spelled out, and cut past PASSTHROUGH_MAX code points with how long
// it was. Drive shows a record this way too when a renderer it holds fails, and every stderr line.
export function passthrough(record: string): string {
  const safe = logSafe(record)
  let n = 0
  let end = 0
  for (const c of safe) {
    if (n < PASSTHROUGH_MAX) end += c.length
    n += 1
  }
  return n <= PASSTHROUGH_MAX ? safe : `${safe.slice(0, end)} … (${n} characters)`
}

function parse(record: string): Json | undefined {
  if (!record.startsWith('{')) return undefined
  try {
    return obj(JSON.parse(record))
  } catch {
    return undefined
  }
}

const show = (text: string): WorkerLine => ({ kind: 'show', text: logSafe(text) })
const shown = (text: string): WorkerLine[] => lines(text).map(show)
// Heard lines are spelled out too: the merge sniff keeps one, and drive prints what it kept.
// `strip` takes off what the harness put before each line (claude's Read numbers its lines).
const heard = (text: string, strip?: RegExp): WorkerLine[] =>
  lines(strip === undefined ? text : text.split('\n').map((l) => l.replace(strip, '')).join('\n'))
    .map((l) => ({ kind: 'heard', text: logSafe(l) }))

// A tool result's text, whichever shape carries it: a string, or `{type: 'text'}` blocks.
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(obj).filter((c) => c?.type === 'text').map((c) => str(c?.text) ?? '').join('\n') : ''

const oldest = (open: Map<string, string>): string | undefined => open.values().next().value
// The oldest open call that is not in the background, else the oldest one that is: a server an
// agent left running is not what a call it is waiting on now waits for.
const oldestForeground = (open: Map<string, string>, background: ReadonlySet<string>): string | undefined => {
  for (const [id, action] of open) if (!background.has(id)) return action
  return oldest(open)
}

// A tool's result is heard and never shown, error or not: both harnesses mark every non-zero exit
// as a tool error (pi throws "Command exited with code N", claude answers `Exit code 1`), so a
// `failed` line would fire on every red test run and every grep that found nothing. The action
// line says what ran, and `journal:` what landed.
//
// pi (`pi -p --mode json`): a `session` header, then `tool_execution_start` / `_end` around each
// call, `message_start` / `message_end` around each message, token deltas, `turn_start` /
// `turn_end`, `agent_end` carrying the whole conversation, and `auto_retry_start` /
// `compaction_start`. pi writes an answer's `message_start` only once the provider's stream has
// begun, so the model is awaited from its turn's start until that answer ends.
export function piStream(home: string): WorkerStream {
  const open = new Map<string, string>()       // toolCallId → action line, oldest first
  let named: string | undefined                // the session id last emitted
  let turn = false                             // the model is awaited: a turn started, its answer has not ended
  let stop: string | undefined                 // the last assistant message's stopReason
  return {
    line(record) {
      const e = parse(record)
      if (e === undefined) return [{ kind: 'show', text: passthrough(record) }]
      switch (e.type) {
        case 'session': {
          const id = str(e.id)
          if (id === undefined || id === named) return []
          named = id
          return [{ kind: 'session', id }]
        }
        case 'tool_execution_start': {
          const action = actionLine(str(e.toolName) ?? 'tool', e.args, home)
          const id = scalar(e.toolCallId)
          if (id !== undefined) open.set(id, action)
          return [{ kind: 'show', text: action }]
        }
        case 'tool_execution_end': {
          const id = scalar(e.toolCallId)
          if (id !== undefined) open.delete(id)
          return heard(textOf(obj(e.result)?.content))
        }
        case 'turn_start':
          turn = true
          return []
        case 'message_start':
          if (obj(e.message)?.role === 'assistant') turn = true
          return []
        case 'message_end': {
          const m = obj(e.message)
          if (m?.role !== 'assistant') return []
          turn = false
          // A later answer that succeeded clears an earlier error: a retry that worked is no failure.
          stop = str(m.stopReason)
          const said = shown(textOf(m.content))
          // What text mode prints on stderr for the same turn, and its exit 1.
          if (stop === 'error' || stop === 'aborted') said.push(...shown(str(m.errorMessage) || `Request ${stop}`))
          return said
        }
        case 'auto_retry_start':
          return [show(`retrying · attempt ${scalar(e.attempt) ?? '?'}/${scalar(e.maxAttempts) ?? '?'} · ${lines(str(e.errorMessage) ?? '')[0] ?? ''}`)]
        case 'compaction_start':
          return [show('compacting context')]
        default:
          return []
      }
    },
    inFlight: () => oldest(open) ?? (turn ? 'the model' : undefined),
    failed: () => stop === 'error' || stop === 'aborted',
  }
}

// claude Read's line numbers, `     1\t` (P12).
const READ_NUMBER = /^\s*\d+\t/
// The statuses a `task_updated` patch ends a task with.
const TASK_ENDED = new Set(['completed', 'failed', 'killed'])

// claude (`claude -p --output-format stream-json --verbose`): `system:init` naming the session,
// one `assistant` record per content block (thinking, text, tool_use), a `user` record carrying
// each tool_result, hooks and `rate_limit_event`, `system:api_retry` / `compact_boundary`, and a
// `result` whose `is_error` is the failure.
//
// P12: a command that outruns the Bash limit runs on in the background. Its `task_started` comes
// before its tool_result, which only says it went to the background; a first `result` follows and
// the process keeps running; `task_notification` says the command ended, a second `init` names the
// same session, the agent reads the output file, and a second `result` closes. So a backgrounded
// call stays open past its tool_result until its task notifies (or a `task_updated` ends it), and
// there may be several results. P17: claude registers a task for a foreground call too — a
// subagent, a Bash that has run a while — so only a task marked `is_backgrounded` keeps a call
// open; claude 2.1.312 moves a Bash that outruns its limit to the background with a
// `task_updated` whose patch says so (its SDK schema: "A later move to the background arrives as
// task_updated patch.is_backgrounded"), not with a second `task_started`.
export function claudeStream(home: string): WorkerStream {
  const open = new Map<string, string>()       // tool_use id → action line, oldest first
  const calls = new Map<string, string>()      // every tool_use id → its action line
  const background = new Set<string>()         // tool_use ids a task runs past their tool_result
  const tasks = new Map<string, string>()      // a running task's id → its tool_use id
  const reads = new Set<string>()              // tool_use ids of Read calls, whose result is numbered
  let named: string | undefined                // the session id last emitted
  // The model is awaited from `init` or a tool_result until a record carrying a tool_use, or a
  // result: its thinking and its text are the model still at work.
  let awaiting = false
  let said: string | undefined                 // the last text shown: a result often repeats it
  let failed = false
  const close = (id: string | undefined): void => {
    if (id === undefined) return
    background.delete(id)
    open.delete(id)
  }
  // A call its task runs in the background: open until the task ends, even when the move to the
  // background is told after the call's tool_result closed it.
  const toBackground = (id: string | undefined): void => {
    if (id === undefined) return
    background.add(id)
    const action = calls.get(id)
    if (!open.has(id) && action !== undefined) open.set(id, action)
  }
  return {
    line(record) {
      const e = parse(record)
      if (e === undefined) return [{ kind: 'show', text: passthrough(record) }]
      switch (e.type) {
        case 'system':
          switch (e.subtype) {
            case 'init': {
              awaiting = true
              const id = str(e.session_id)
              if (id === undefined || id === named) return []
              named = id
              return [{ kind: 'session', id }]
            }
            case 'api_retry': {
              const why = [scalar(e.error_status), scalar(e.error)].filter((x) => x !== undefined).join(' ')
              return [show(`retrying · attempt ${scalar(e.attempt) ?? '?'}/${scalar(e.max_retries) ?? '?'} · ${why}`)]
            }
            case 'compact_boundary':
              return [show('compacting context')]
            case 'task_started': {
              const id = str(e.tool_use_id)
              if (id === undefined) return []
              const task = str(e.task_id)
              if (task !== undefined) tasks.set(task, id)
              if (e.is_backgrounded === true) toBackground(id)
              return []
            }
            case 'task_notification': {
              const task = str(e.task_id)
              close(str(e.tool_use_id) ?? (task !== undefined ? tasks.get(task) : undefined))
              if (task !== undefined) tasks.delete(task)
              return []
            }
            case 'task_updated': {
              const task = str(e.task_id)
              const patch = obj(e.patch)
              if (task === undefined || patch === undefined) return []
              if (patch.is_backgrounded === true) toBackground(tasks.get(task))
              const status = str(patch.status)
              if (status !== undefined && TASK_ENDED.has(status)) {
                close(tasks.get(task))
                tasks.delete(task)
              }
              return []
            }
            default:
              return []
          }
        case 'assistant': {
          const content = obj(e.message)?.content
          if (!Array.isArray(content)) return []
          const out: WorkerLine[] = []
          for (const b of content) {
            const block = obj(b)
            if (block?.type === 'tool_use') {
              awaiting = false
              const tool = str(block.name) ?? 'tool'
              const action = actionLine(tool, block.input, home)
              const id = str(block.id)
              if (id !== undefined) {
                open.set(id, action)
                calls.set(id, action)
                if (tool.toLowerCase() === 'read') reads.add(id)
              }
              out.push({ kind: 'show', text: action })
            } else if (block?.type === 'text') {
              said = str(block.text) ?? ''
              out.push(...shown(said))
            }
          }
          return out
        }
        case 'user': {
          const content = obj(e.message)?.content
          // A string is a prompt, never a tool's result.
          if (!Array.isArray(content)) return []
          const out: WorkerLine[] = []
          for (const b of content) {
            const block = obj(b)
            if (block?.type !== 'tool_result') continue
            awaiting = true
            const id = str(block.tool_use_id)
            if (id !== undefined && !background.has(id)) open.delete(id)
            const numbered = id !== undefined && reads.delete(id)
            out.push(...heard(textOf(block.content), numbered ? READ_NUMBER : undefined))
          }
          return out
        }
        case 'result': {
          awaiting = false
          failed = e.is_error === true
          // Its text when it says something not just shown; P8's error subtypes carry no text,
          // only `errors[]`, and an error with neither is named by its subtype.
          const text = str(e.result)
          if (text !== undefined) {
            if (text.trim() === said?.trim()) return []
            said = text
            return shown(text)
          }
          if (!failed) return []
          const errors = Array.isArray(e.errors) ? e.errors.map(str).filter((x): x is string => x !== undefined) : []
          return errors.length > 0 ? errors.flatMap(shown) : shown(str(e.subtype) ?? '')
        }
        default:
          return []
      }
    },
    inFlight: () => oldestForeground(open, background) ?? (awaiting ? 'the model' : undefined),
    failed: () => failed,
  }
}
