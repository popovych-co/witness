import { describe, expect, it } from 'vitest'
import { logSafe } from '../src/toon.js'
import { ACTION_MAX, actionLine, claudeStream, envelopeStream, lineSink, piStream, shellCommand } from '../src/worker-stream.js'

// One stdout record, as each harness writes it in its streaming mode (P1, P3, P8, P12).
const r = (event: object): string => JSON.stringify(event)

describe('logSafe (row 214)', () => {
  it('logSafe spells out control, format and separator characters (issue #64)', () => {
    expect(logSafe('a\x1b[2Jb\tc\u202ed\u2028e · → é')).toBe('a\\x1b[2Jb\\tc\\u{202e}d\\u{2028}e · → é')
  })
})

describe('lineSink (row 214)', () => {
  // Review Focus 3: pi's agent_end carries the whole conversation in one record.
  it('lineSink takes one long record in linear time (issue #64)', () => {
    const recs: string[] = []
    const sink = lineSink((r) => recs.push(r))
    const t0 = performance.now()
    for (let i = 0; i < 128; i++) sink.push('x'.repeat(65_536))
    sink.push('\r\nnext\n')
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(recs.map((r) => r.length)).toEqual([8_388_608, 4])
  })
})

describe('shellCommand (row 214)', () => {
  it.each([
    ['cd /r/.witness/worktrees/p1 && WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.26.1}"; $WITNESS start p1 2>&1; echo "exit: $?"',
      'witness start p1 2>&1; echo "exit: $?"'],
    ['cd /r/.witness/worktrees/p1 && WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.26.1}" && "$WITNESS" gate implement p1',
      'witness gate implement p1'],
    ['WITNESS=x\n$WITNESS next', 'witness next'],
    ['export FOO="a;b"; set -e; npm test', 'npm test'],
    ['set -euo pipefail; npm test', 'npm test'],
    ['cd /r &&\n  cargo test', 'cargo test'],                 // an empty segment counts as setup
    ['cd /r && cargo test discovery', 'cargo test discovery'],
    ['cd /r', 'cd /r'],
  ])('shellCommand %j (issue #64)', (raw, want) => expect(shellCommand(raw)).toBe(want))
})

describe('actionLine (row 214)', () => {
  it.each([
    ['bash', { command: 'cd /r && cargo test discovery\n--nocapture' }, '$ cargo test discovery …'],
    ['powershell', { command: 'Get-ChildItem' }, '$ Get-ChildItem'],
    ['Read', { file_path: '/r/src/a.rs' }, 'read src/a.rs'],
    ['Read', { file_path: 'C:\\R\\src\\a.rs' }, 'read src/a.rs'],          // home 'c:/r' below
    ['edit', { path: 'src/b.rs' }, 'edit src/b.rs'],
    ['Write', { file_path: '/elsewhere/c.md' }, 'write /elsewhere/c.md'],
    ['Grep', { pattern: 'fn main' }, 'grep fn main'],
    ['Glob', { pattern: '**/*.rs' }, 'find **/*.rs'],
    ['Task', { description: 'review the diff', prompt: 'x' }, 'Task review the diff'],
    ['TodoWrite', { todos: [] }, 'TodoWrite'],
    ['bash', { command: 'echo \x1b]0;pwned\x07' }, '$ echo \\x1b]0;pwned\\x07'],
  ])('actionLine %s %j (issue #64)', (tool, args, want) =>
    expect(actionLine(tool, args, String((args as { file_path?: string }).file_path).startsWith('C:') ? 'c:/r' : '/r')).toBe(want))

  it('an action line is at most ACTION_MAX code points (issue #64)', () => {
    const a = actionLine('bash', { command: '😀'.repeat(400) }, '/r')
    expect([...a]).toHaveLength(ACTION_MAX)
    expect(a.endsWith('…')).toBe(true)
  })
})

describe('piStream (row 214)', () => {
  const bashLs = r({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } })

  it('names the session its header carries (issue #64)', () => {
    expect(piStream('/r').line(r({ type: 'session', version: 3, id: 'S1', timestamp: '2026-10-29T08:48:09.000Z', cwd: '/r' })))
      .toEqual([{ kind: 'session', id: 'S1' }])
  })

  it('shows a tool call as its action line, in flight until it ends (issue #64)', () => {
    const s = piStream('/r')
    expect(s.line(bashLs)).toEqual([{ kind: 'show', text: '$ ls' }])
    expect(s.inFlight()).toBe('$ ls')
  })

  it("hears a tool's output and never shows it (issue #64)", () => {
    const s = piStream('/r')
    s.line(bashLs)
    expect(s.line(r({
      type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash',
      result: { content: [{ type: 'text', text: 'a\nship: "merge PR #7 on GitHub when ready — x"' }] }, isError: false,
    }))).toEqual([{ kind: 'heard', text: 'a' }, { kind: 'heard', text: 'ship: "merge PR #7 on GitHub when ready — x"' }])
    expect(s.inFlight()).toBeUndefined()
  })

  it('a tool that failed is only heard (P9, issue #64)', () => {
    const s = piStream('/r')
    s.line(bashLs)
    expect(s.line(r({
      type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash',
      result: { content: [{ type: 'text', text: 'boom\nCommand exited with code 1' }] }, isError: true,
    }))).toEqual([{ kind: 'heard', text: 'boom' }, { kind: 'heard', text: 'Command exited with code 1' }])
  })

  it("shows the assistant's text, one line per non-blank line, and the model is in flight mid-answer (issue #64)", () => {
    const s = piStream('/r')
    expect(s.line(r({ type: 'message_start', message: { role: 'assistant', content: [] } }))).toEqual([])
    expect(s.inFlight()).toBe('the model')
    expect(s.line(r({
      type: 'message_end',
      message: {
        role: 'assistant', stopReason: 'toolUse',
        content: [{ type: 'text', text: 'Done.\n\nNext.' }, { type: 'toolCall', id: 'c3', name: 'bash', arguments: { command: 'ls' } }],
      },
    }))).toEqual([{ kind: 'show', text: 'Done.' }, { kind: 'show', text: 'Next.' }])
  })

  // P17: pi writes an answer's message_start only once the provider's stream begins, so the wait
  // for the first token is the model's too.
  it("the model is awaited from its turn's start until its answer ends (issue #64)", () => {
    const s = piStream('/r')
    expect(s.line(r({ type: 'turn_start' }))).toEqual([])
    expect(s.inFlight()).toBe('the model')
    s.line(r({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'toolUse' } }))
    expect(s.inFlight()).toBeUndefined()
  })

  // Review Focus 4
  it('spells out what the assistant wrote (issue #64)', () => {
    expect(piStream('/r').line(r({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x\x1b[2Jy' }], stopReason: 'stop' } })))
      .toEqual([{ kind: 'show', text: 'x\\x1b[2Jy' }])
  })

  // D5 and Review Focus 4
  it('a turn that ended in an error shows its message spelled out and fails the session, until a later turn succeeds (issue #64)', () => {
    const s = piStream('/r')
    const body = '529 {"type":"error","error":{"type":"overloaded_error","message":"\x1b]52;c;x\x07"}}'
    expect(s.line(r({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: body } })))
      .toEqual([{ kind: 'show', text: '529 {"type":"error","error":{"type":"overloaded_error","message":"\\x1b]52;c;x\\x07"}}' }])
    expect(s.failed()).toBe(true)
    s.line(r({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } }))
    expect(s.failed()).toBe(false)
  })

  it('an aborted turn with no message says so as text mode does (issue #64)', () => {
    expect(piStream('/r').line(r({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } })))
      .toEqual([{ kind: 'show', text: 'Request aborted' }])
  })

  it('a retry names its attempt and reason (issue #64)', () => {
    expect(piStream('/r').line(r({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' })))
      .toEqual([{ kind: 'show', text: 'retrying · attempt 1/3 · 529 overloaded' }])
  })

  it('a compaction says so (issue #64)', () => {
    expect(piStream('/r').line(r({ type: 'compaction_start', reason: 'threshold' })))
      .toEqual([{ kind: 'show', text: 'compacting context' }])
  })

  it.each([
    ['message_update', { type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' } }],
    ['turn_end', { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, toolResults: [] }],
    ['agent_end', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }] }],
    ['agent_settled', { type: 'agent_settled' }],
    ['a user message', { type: 'message_end', message: { role: 'user', content: '/witness' } }],
    ['a tool result message', { type: 'message_end', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }], isError: false } }],
    ['an unknown event', { type: 'brand_new' }],
  ])('%s renders nothing (issue #64)', (_name, event) => {
    expect(piStream('/r').line(r(event))).toEqual([])
  })

  // Review Focus 1
  it.each([
    ['a null toolName and args', { type: 'tool_execution_start', toolName: null, args: null }],
    ['a null message', { type: 'message_end', message: null }],
    ['string content', { type: 'message_end', message: { role: 'assistant', content: 'x', stopReason: 'stop' } }],
  ])('a known event with %s never throws (issue #64)', (_name, event) => {
    expect(Array.isArray(piStream('/r').line(r(event)))).toBe(true)
  })

  // P17: a lookup in a plain object of verbs finds these on its prototype.
  it.each(['constructor', '__proto__'])('a tool named %s is any other tool (issue #64)', (tool) => {
    expect(piStream('/r').line(r({ type: 'tool_execution_start', toolCallId: 'c9', toolName: tool, args: { x: 'y' } })))
      .toEqual([{ kind: 'show', text: `${tool} y` }])
  })

  it('a record that is not a JSON object passes through, capped (issue #64)', () => {
    const s = piStream('/r')
    expect(s.line('Warning: x')).toEqual([{ kind: 'show', text: 'Warning: x' }])
    expect(s.line('x'.repeat(1000))).toEqual([{ kind: 'show', text: `${'x'.repeat(400)} … (1000 characters)` }])
    expect(s.line('[1,2]')).toEqual([{ kind: 'show', text: '[1,2]' }])
  })
})

describe('claudeStream (row 214)', () => {
  const init = r({ type: 'system', subtype: 'init', session_id: 'S2', cwd: '/r', tools: ['Bash'], model: 'claude-opus-4-6' })
  const use = (id: string, name: string, input: object): string =>
    r({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  const result = (id: string, content: unknown, extra: object = {}): string =>
    r({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } })

  it('names the session init carries, once, and the model is in flight (issue #64)', () => {
    const s = claudeStream('/r')
    expect(s.line(init)).toEqual([{ kind: 'session', id: 'S2' }])
    expect(s.inFlight()).toBe('the model')
    expect(s.line(init)).toEqual([])
  })

  it('shows a tool call as its action line (issue #64)', () => {
    expect(claudeStream('/r').line(use('t1', 'Bash', { command: 'ls' }))).toEqual([{ kind: 'show', text: '$ ls' }])
  })

  it("hears a tool's result and never shows it, then awaits the model (issue #64)", () => {
    const s = claudeStream('/r')
    s.line(use('t1', 'Bash', { command: 'ls' }))
    expect(s.line(result('t1', 'a\nb'))).toEqual([{ kind: 'heard', text: 'a' }, { kind: 'heard', text: 'b' }])
    expect(s.inFlight()).toBe('the model')
  })

  it('a tool that failed is only heard (P9, issue #64)', () => {
    const s = claudeStream('/r')
    s.line(use('t1', 'Bash', { command: 'ls' }))
    expect(s.line(result('t1', [{ type: 'text', text: 'Exit code 1\nerr' }], { is_error: true })))
      .toEqual([{ kind: 'heard', text: 'Exit code 1' }, { kind: 'heard', text: 'err' }])
  })

  // D8: from init or a tool_result until a record carrying tool_use, or a result.
  it('the model is awaited through its thinking and its text, until the result (issue #64)', () => {
    const s = claudeStream('/r')
    s.line(init)
    expect(s.line(r({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }))).toEqual([])
    expect(s.inFlight()).toBe('the model')
    expect(s.line(r({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }))).toEqual([{ kind: 'show', text: 'Done.' }])
    expect(s.inFlight()).toBe('the model')
    s.line(r({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }))
    expect(s.inFlight()).toBeUndefined()
  })

  // P12
  it('a backgrounded call stays in flight past its result, until its task notifies (issue #64)', () => {
    const s = claudeStream('/r')
    s.line(init)
    expect(s.line(use('t3', 'Bash', { command: '$WITNESS ship p1' }))).toEqual([{ kind: 'show', text: '$ witness ship p1' }])
    expect(s.line(r({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 't3', description: 'ship', task_type: 'local_bash', is_backgrounded: true }))).toEqual([])
    s.line(result('t3', 'Command running in background with ID: b1. Output is being written to: /tmp/b1.output'))
    expect(s.inFlight()).toBe('$ witness ship p1')
    expect(s.line(r({
      type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 't3', status: 'completed',
      output_file: '/tmp/b1.output', summary: 'Background command "ship" completed (exit code 0)',
    }))).toEqual([])
    expect(s.inFlight()).not.toBe('$ witness ship p1')
  })

  // P17: claude registers a task for a foreground subagent too; only a backgrounded one outlives
  // its tool_result, and a task_updated that ends it closes it.
  it('only a backgrounded task outlives its result, and an update that ends it closes it (issue #64)', () => {
    const s = claudeStream('/r')
    s.line(init)
    s.line(use('t5', 'Task', { description: 'review the diff', prompt: 'x' }))
    expect(s.line(r({ type: 'system', subtype: 'task_started', task_id: 'a5', tool_use_id: 't5', task_type: 'local_agent' }))).toEqual([])
    s.line(result('t5', 'reviewed'))
    expect(s.inFlight()).toBe('the model')
    s.line(use('t6', 'Bash', { command: 'cargo test' }))
    s.line(r({ type: 'system', subtype: 'task_started', task_id: 'b6', tool_use_id: 't6', task_type: 'local_bash', is_backgrounded: true }))
    s.line(result('t6', 'Command running in background with ID: b6.'))
    expect(s.inFlight()).toBe('$ cargo test')
    expect(s.line(r({ type: 'system', subtype: 'task_updated', task_id: 'b6', patch: { status: 'killed' } }))).toEqual([])
    expect(s.inFlight()).toBe('the model')
  })

  // Final review I1. claude 2.1.312 registers a foreground Bash as a task with is_backgrounded false
  // once it has run a while; moving it to the background at its timeout arrives only as a
  // task_updated patch ("A later move to the background arrives as task_updated
  // patch.is_backgrounded", the binary's own SDK schema). That call is what the session waits on.
  it('a call moved to the background at its timeout stays in flight until its task ends (issue #64)', () => {
    const s = claudeStream('/r')
    s.line(init)
    s.line(use('t7', 'Bash', { command: 'cd /r && $WITNESS ship p1' }))
    s.line(r({ type: 'system', subtype: 'task_started', task_id: 'b7', tool_use_id: 't7', task_type: 'local_bash', is_backgrounded: false }))
    expect(s.line(r({ type: 'system', subtype: 'task_updated', task_id: 'b7', patch: { is_backgrounded: true } }))).toEqual([])
    s.line(result('t7', 'Command did not complete within its 120s timeout and was moved to the background (ID: b7)'))
    expect(s.inFlight()).toBe('$ witness ship p1')
    s.line(r({ type: 'result', subtype: 'success', is_error: false, result: 'Waiting on CI.' }))
    expect(s.inFlight()).toBe('$ witness ship p1')
    s.line(r({ type: 'system', subtype: 'task_notification', task_id: 'b7', tool_use_id: 't7', status: 'completed' }))
    expect(s.inFlight()).toBeUndefined()
  })

  it('a move to the background that arrives after its result reopens the call (issue #64)', () => {
    const s = claudeStream('/r')
    s.line(init)
    s.line(use('t7', 'Bash', { command: 'cargo test' }))
    s.line(r({ type: 'system', subtype: 'task_started', task_id: 'b7', tool_use_id: 't7', is_backgrounded: false }))
    s.line(result('t7', 'Command did not complete within its 120s timeout and was moved to the background (ID: b7)'))
    s.line(r({ type: 'system', subtype: 'task_updated', task_id: 'b7', patch: { is_backgrounded: true } }))
    expect(s.inFlight()).toBe('$ cargo test')
  })

  // Final review I1: a dev server the agent backgrounded is not what a running foreground call
  // waits on.
  it('a foreground call is named before a backgrounded one (issue #64)', () => {
    const s = claudeStream('/r')
    s.line(init)
    s.line(use('t8', 'Bash', { command: 'pnpm dev' }))
    s.line(r({ type: 'system', subtype: 'task_started', task_id: 'b8', tool_use_id: 't8', is_backgrounded: true }))
    s.line(result('t8', 'Command running in background with ID: b8.'))
    s.line(use('t9', 'Bash', { command: 'cargo test' }))
    expect(s.inFlight()).toBe('$ cargo test')
    s.line(result('t9', 'ok'))
    expect(s.inFlight()).toBe('$ pnpm dev')
  })

  // P12: the agent reads a backgrounded call's output file, line-numbered.
  it('a Read result is heard without its line numbers (issue #64)', () => {
    const s = claudeStream('/r')
    s.line(use('t4', 'Read', { file_path: '/r/o.txt' }))
    expect(s.line(result('t4', '1\tship: "merge PR #7 on GitHub when ready — x"\n2\t')))
      .toEqual([{ kind: 'heard', text: 'ship: "merge PR #7 on GitHub when ready — x"' }])
  })

  it('a result shows its text only when it differs from the last text shown, and there may be several (P12, issue #64)', () => {
    const s = claudeStream('/r')
    s.line(r({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }))
    expect(s.line(r({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }))).toEqual([])
    expect(s.line(r({ type: 'result', subtype: 'success', is_error: false, result: 'Later.' }))).toEqual([{ kind: 'show', text: 'Later.' }])
  })

  it('an error result shows its text and fails the session (issue #64)', () => {
    const s = claudeStream('/r')
    expect(s.line(r({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1793313000' })))
      .toEqual([{ kind: 'show', text: 'Claude AI usage limit reached|1793313000' }])
    expect(s.failed()).toBe(true)
  })

  it('an error result that repeats the text just shown is not shown twice, nor its subtype (issue #64)', () => {
    const s = claudeStream('/r')
    const text = "There's an issue with the selected model…"
    expect(s.line(r({ type: 'assistant', message: { content: [{ type: 'text', text }] } }))).toEqual([{ kind: 'show', text }])
    expect(s.line(r({ type: 'result', subtype: 'success', is_error: true, result: text }))).toEqual([])
    expect(s.failed()).toBe(true)
  })

  // P8: these subtypes carry errors[] and no result.
  it('an error result with no text shows its errors, else its subtype (issue #64)', () => {
    expect(claudeStream('/r').line(r({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] })))
      .toEqual([{ kind: 'show', text: 'boom' }])
    expect(claudeStream('/r').line(r({ type: 'result', subtype: 'error_max_turns', is_error: true })))
      .toEqual([{ kind: 'show', text: 'error_max_turns' }])
  })

  it('a retry names its attempt and reason, a null status left out (issue #64)', () => {
    expect(claudeStream('/r').line(r({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'connection' })))
      .toEqual([{ kind: 'show', text: 'retrying · attempt 1/10 · connection' }])
    expect(claudeStream('/r').line(r({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded' })))
      .toEqual([{ kind: 'show', text: 'retrying · attempt 2/10 · 529 overloaded' }])
  })

  it('a compaction says so (issue #64)', () => {
    expect(claudeStream('/r').line(r({ type: 'system', subtype: 'compact_boundary' })))
      .toEqual([{ kind: 'show', text: 'compacting context' }])
  })

  it.each([
    ['rate_limit_event', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }],
    ['a hook', { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }],
    ['a task update', { type: 'system', subtype: 'task_updated', task_id: 'b1', patch: {} }],
    ['a user prompt', { type: 'user', message: { role: 'user', content: '/witness' } }],
  ])('%s renders nothing (issue #64)', (_name, event) => {
    expect(claudeStream('/r').line(r(event))).toEqual([])
  })

  // Review Focus 1. Content that is an object or a number is no array to iterate, either (P17).
  it.each([
    ['string content', { type: 'assistant', message: { content: 'x' } }],
    ['object content', { type: 'assistant', message: { content: {} } }],
    ['number content', { type: 'assistant', message: { content: 5 } }],
    ['a result with no result', { type: 'result' }],
  ])('a known event with %s renders nothing and never throws (issue #64)', (_name, event) => {
    expect(claudeStream('/r').line(r(event))).toEqual([])
  })
})

// Row 245 (issue #80). A session ends when its turn ends, not when its process exits: a pi worker
// whose extension leaks a handle lives on after its turn (P5). The streams say whether the turn's
// end signal stands and whether a run ever started; drive and the reviewers time the grace on it.
describe("the turn's end (row 245)", () => {
  const home = '/r'
  const header = r({ type: 'session', version: 3, id: 'S1', timestamp: '2026-11-19T10:36:00.000Z', cwd: home })
  const settled = r({ type: 'agent_settled' })
  // What pi writes for a message an extension posts while the agent is idle (sendCustomMessage).
  const note = { role: 'custom', customType: 'note', content: 'lint clean', display: true, timestamp: 1 }
  const custom = [
    r({ type: 'message_start', message: note }),
    r({ type: 'message_end', message: note }),
    r({ type: 'entry_appended', entry: { type: 'custom_message', id: 'e9', parentId: 'e8', timestamp: '2026-11-19T10:36:01.000Z', customType: 'note', content: 'lint clean', display: true } }),
  ]
  const init = r({ type: 'system', subtype: 'init', session_id: 'S2', cwd: home, tools: ['Bash'], model: 'claude-opus-4-6' })
  const said = (text: string): string => r({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  const use = (id: string, name: string, input: object): string =>
    r({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  const toolResult = (id: string, content: string): string =>
    r({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
  const done = (extra: object = {}): string => r({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', ...extra })

  it('pi: agent_end, agent_settled → ended(); a later turn_start clears it (P4, P18)', () => {
    const s = piStream(home)
    for (const rec of ['{"type":"agent_start"}', '{"type":"agent_end","messages":[]}', '{"type":"agent_settled"}']) s.line(rec)
    expect(s.ended()).toBe(true)
    s.line('{"type":"turn_start"}')
    expect(s.ended()).toBe(false)
    // Re-arming: the next settle is the turn's end again.
    s.line(settled)
    expect(s.ended()).toBe(true)
  })

  it('pi: nothing has ended before agent_settled, agent_end included: a retry may follow it (P4, P18)', () => {
    const s = piStream(home)
    for (const rec of [
      header,
      r({ type: 'agent_start' }),
      r({ type: 'turn_start' }),
      r({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] }),
      r({ type: 'agent_end', messages: [], willRetry: true }),
    ]) {
      s.line(rec)
      expect(s.ended(), rec).toBe(false)
    }
  })

  it('pi: queue_update, entry_appended, session_info_changed and non-JSON lines never clear it (P17, P49)', () => {
    const s = piStream(home)
    s.line(r({ type: 'agent_start' }))
    s.line(settled)
    for (const rec of [
      r({ type: 'queue_update', steering: [], followUp: ['and the docs'] }),
      r({ type: 'entry_appended', entry: { type: 'session_info', id: 'e2', parentId: 'e1', timestamp: '2026-11-19T10:36:02.000Z', name: 'p1' } }),
      r({ type: 'session_info_changed', name: 'p1' }),
      'chatty-stdout tick 1',                        // P17: a leaky extension that logs after the turn
      '',
      '{"type":"turn_start"',                        // half a record is no record
      '[{"type":"agent_start"}]',                    // nor is an array
      r({ type: 'message_start', message: null }),   // a message_start naming no message starts nothing
      r({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } }),
      r({ type: 'tool_execution_end', toolCallId: 'c1', result: { content: [] } }),
      r({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false }),
      r({ type: 'auto_retry_end', success: true, attempt: 1 }),
      r({ type: 'agent_end', messages: [] }),
      r({ type: 'brand_new' }),
    ]) {
      s.line(rec)
      expect(s.ended(), rec).toBe(true)
    }
  })

  it('pi: started() stays false through the header and extension records, and turns true at agent_start (P27, P49)', () => {
    const s = piStream(home)
    for (const rec of [
      header,
      'No API key found for anthropic.',             // P49: no login
      r({ type: 'session_info_changed', name: 'p1' }),  // P49: an extension that names the session
      r({ type: 'entry_appended', entry: { type: 'session_info', id: 'e1', parentId: null, timestamp: '2026-11-19T10:36:00.000Z', name: 'p1' } }),
      r({ type: 'queue_update', steering: [], followUp: [] }),
      '[addon] before_agent_start: waiting',          // P27: a handler that runs before agent_start
      r({ type: 'addon_status', text: 'ready' }),    // an extension's own JSON
    ]) {
      s.line(rec)
      expect(s.started(), rec).toBe(false)
    }
    expect(s.ended()).toBe(false)
    s.line(r({ type: 'agent_start' }))
    expect(s.started()).toBe(true)
  })

  it.each([
    ['agent_start', { type: 'agent_start' }],
    ['turn_start', { type: 'turn_start' }],
    ["a user message's message_start", { type: 'message_start', message: { role: 'user', content: 'and the docs' } }],
    ["an assistant message's message_start", { type: 'message_start', message: { role: 'assistant', content: [] } }],
    ["a tool result's message_start", { type: 'message_start', message: { role: 'toolResult', toolCallId: 'c1', content: [] } }],
    ['tool_execution_start', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }],
    ['compaction_start', { type: 'compaction_start', reason: 'threshold' }],
    ['auto_retry_start', { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' }],
  ])('pi: %s starts a run: it clears a standing end and counts as a start', (_name, event) => {
    const s = piStream(home)
    s.line(settled)
    expect([s.ended(), s.started()]).toEqual([true, false])
    s.line(r(event))
    expect([s.ended(), s.started()]).toEqual([false, true])
  })

  // S4-3: the leaky extension #80 is about may post a note after the turn, and a note that held
  // the session would hold it for good. A custom message that triggers a turn brings its own
  // agent_start.
  it("pi: an extension's custom message after agent_settled neither cancels the grace nor counts as a start (S4-3)", () => {
    const s = piStream(home)
    s.line(r({ type: 'agent_start' }))
    s.line(settled)
    for (const rec of custom) {
      s.line(rec)
      expect(s.ended(), rec).toBe(true)
    }
    const early = piStream(home)
    for (const rec of [header, ...custom]) early.line(rec)
    expect(early.started()).toBe(false)
  })

  it.each(['bashExecution', 'branchSummary', 'compactionSummary'])("pi: a %s message's message_start starts no run (S4-3)", (role) => {
    const s = piStream(home)
    s.line(settled)
    s.line(r({ type: 'message_start', message: { role, timestamp: 1 } }))
    expect([s.ended(), s.started()]).toEqual([true, false])
  })

  it('claude: a top-level result ends; one with parent_tool_use_id does not; an open backgrounded call holds the end until its task ends', () => {
    const s = claudeStream(home)
    s.line(init)
    s.line(said('Reviewing.'))
    expect(s.ended()).toBe(false)
    // A subagent's result names the call that ran it: the session's own turn goes on.
    s.line(done({ parent_tool_use_id: 't1' }))
    expect(s.ended()).toBe(false)
    s.line(done({ parent_tool_use_id: null }))
    expect(s.ended()).toBe(true)

    // P12: a command left running in the background. claude writes a result and carries on once
    // the task notifies: a second init names the same session, and a second result closes.
    const b = claudeStream(home)
    for (const rec of [
      init,
      use('t3', 'Bash', { command: '$WITNESS ship p1' }),
      r({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 't3', task_type: 'local_bash', is_backgrounded: true }),
      toolResult('t3', 'Command running in background with ID: b1.'),
      done({ result: 'Waiting on CI.' }),
    ]) b.line(rec)
    expect(b.ended()).toBe(false)
    b.line(r({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 't3', status: 'completed' }))
    expect(b.ended()).toBe(false)                     // a task's end is no result
    for (const rec of [init, use('t4', 'Read', { file_path: '/tmp/b1.output' }), toolResult('t4', '1\tmerged'), done({ result: 'Merged.' })]) b.line(rec)
    expect(b.ended()).toBe(true)
  })

  // Final review I1 (row 214): claude 2.1.312 moves a Bash that outran its limit to the background
  // with a task_updated patch.
  it('claude: a call moved to the background holds the end too, until a task_updated ends it', () => {
    const s = claudeStream(home)
    for (const rec of [
      init,
      use('t7', 'Bash', { command: 'cargo test' }),
      r({ type: 'system', subtype: 'task_started', task_id: 'b7', tool_use_id: 't7', is_backgrounded: false }),
      r({ type: 'system', subtype: 'task_updated', task_id: 'b7', patch: { is_backgrounded: true } }),
      toolResult('t7', 'Command did not complete within its 120s timeout and was moved to the background (ID: b7)'),
      done({ result: 'Waiting on the tests.' }),
    ]) s.line(rec)
    expect(s.ended()).toBe(false)
    s.line(r({ type: 'system', subtype: 'task_updated', task_id: 'b7', patch: { status: 'killed' } }))
    expect(s.ended()).toBe(false)
    s.line(done({ result: 'Stopped.' }))
    expect(s.ended()).toBe(true)
  })

  // Task 15's review: claude may background a task that names no call (no tool_use_id on its
  // task_started, or a task_updated moving a task the stream never tied to a call). It runs in the
  // background all the same, so it holds the end by its task id until that task ends; otherwise
  // drive would stop the session 60 s after its first result while the task still ran.
  it('claude: a backgrounded task with no call holds the end too, until that task ends', () => {
    const started = claudeStream(home)
    for (const rec of [
      init,
      r({ type: 'system', subtype: 'task_started', task_id: 'b9', task_type: 'local_bash', is_backgrounded: true }),
      done({ result: 'Waiting on it.' }),
    ]) started.line(rec)
    expect(started.ended()).toBe(false)
    started.line(r({ type: 'system', subtype: 'task_notification', task_id: 'b9', status: 'completed' }))
    expect(started.ended()).toBe(false)               // a task's end is no result
    started.line(done({ result: 'Done.' }))
    expect(started.ended()).toBe(true)

    // A task_updated moves a task the stream never tied to a call; a task_updated ends it.
    const moved = claudeStream(home)
    for (const rec of [init, r({ type: 'system', subtype: 'task_updated', task_id: 'b10', patch: { is_backgrounded: true } }), done()]) moved.line(rec)
    expect(moved.ended()).toBe(false)
    moved.line(r({ type: 'system', subtype: 'task_updated', task_id: 'b10', patch: { status: 'completed' } }))
    expect(moved.ended()).toBe(false)
    moved.line(done())
    expect(moved.ended()).toBe(true)

    // A foreground task with no call, moved to the background later; another task's end frees nothing.
    const later = claudeStream(home)
    for (const rec of [
      init,
      r({ type: 'system', subtype: 'task_started', task_id: 'b11', is_backgrounded: false }),
      r({ type: 'system', subtype: 'task_updated', task_id: 'b11', patch: { is_backgrounded: true } }),
      r({ type: 'system', subtype: 'task_notification', task_id: 'other', status: 'completed' }),
      done(),
    ]) later.line(rec)
    expect(later.ended()).toBe(false)
    later.line(r({ type: 'system', subtype: 'task_notification', task_id: 'b11', status: 'completed' }))
    later.line(done())
    expect(later.ended()).toBe(true)
  })

  it('claude: started() turns true at system:init, not before', () => {
    const s = claudeStream(home)
    for (const rec of [
      r({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }),
      r({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
      'Warning: x',
    ]) {
      s.line(rec)
      expect(s.started(), rec).toBe(false)
    }
    s.line(init)
    expect(s.started()).toBe(true)
  })

  it.each([
    ['system:init', init],
    ['an assistant record', said('More.')],
    ['a user record', toolResult('t1', 'ok')],
    ['a backgrounded task_started', r({ type: 'system', subtype: 'task_started', task_id: 'b2', tool_use_id: 't2', is_backgrounded: true })],
    ['a task_updated moving a call to the background', r({ type: 'system', subtype: 'task_updated', task_id: 'b2', patch: { is_backgrounded: true } })],
  ])('claude: %s starts a run: it clears a standing end and counts as a start', (_name, rec) => {
    const s = claudeStream(home)
    s.line(done())
    expect([s.ended(), s.started()]).toEqual([true, false])
    s.line(rec)
    expect([s.ended(), s.started()]).toEqual([false, true])
  })

  it('claude: records that start no run never clear it', () => {
    const s = claudeStream(home)
    s.line(init)
    s.line(done())
    for (const rec of [
      r({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
      r({ type: 'system', subtype: 'hook_started', hook_name: 'Stop' }),
      r({ type: 'system', subtype: 'task_started', task_id: 'a5', tool_use_id: 't5', task_type: 'local_agent', is_backgrounded: false }),
      r({ type: 'system', subtype: 'task_updated', task_id: 'a5', patch: { status: 'completed' } }),
      r({ type: 'system', subtype: 'task_notification', task_id: 'a5', tool_use_id: 't5', status: 'completed' }),
      done({ parent_tool_use_id: 't5' }),
      'Warning: x',
      '{"type":"assistant"',
    ]) {
      s.line(rec)
      expect(s.ended(), rec).toBe(true)
    }
  })

  // claude json mode, the reviewers' (row 217): one result envelope, at the end.
  it('envelopeStream: ended once a type:result object parses', () => {
    const s = envelopeStream()
    expect([s.ended(), s.started()]).toEqual([false, true])   // json mode writes nothing before it ends
    for (const rec of ['Warning: x', '{"type":"result","subtype":"succ', '[{"type":"result"}]', r({ type: 'system', subtype: 'init' })]) {
      expect(s.line(rec)).toEqual([])
      expect(s.ended(), rec).toBe(false)
    }
    expect(s.line(r({ type: 'result', subtype: 'success', is_error: false, result: '{"verdict":"approve"}' }))).toEqual([])
    expect([s.ended(), s.started(), s.failed()]).toEqual([true, true, false])
  })

  it("envelopeStream: the envelope's is_error is the failure (row 182)", () => {
    const s = envelopeStream()
    s.line(r({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1793313000' }))
    expect([s.ended(), s.failed()]).toEqual([true, true])
  })

  // Review Focus: a Windows pipe writes CRLF and splits wherever it likes. The sink drive and the
  // reviewer feed the stream through is what this reads through.
  it('an agent_settled record split across two chunks, with CRLF, ends the turn (Review Focus)', () => {
    const s = piStream(home); const sink = lineSink((rec) => s.line(rec))
    sink.push('{"type":"agent_start"}\r\n{"type":"agent_se')
    expect([s.started(), s.ended()]).toEqual([true, false])
    sink.push('ttled"}\r\n')
    expect(s.ended()).toBe(true)
    // Split between the CR and its LF.
    const t = piStream(home); const split = lineSink((rec) => t.line(rec))
    split.push('{"type":"agent_start"}\r\n{"type":"agent_settled"}\r')
    expect(t.ended()).toBe(false)
    split.push('\n')
    expect(t.ended()).toBe(true)
  })
})
