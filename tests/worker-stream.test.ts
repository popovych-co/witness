import { describe, expect, it } from 'vitest'
import { logSafe } from '../src/toon.js'
import { ACTION_MAX, actionLine, claudeStream, piStream, shellCommand } from '../src/worker-stream.js'

// One stdout record, as each harness writes it in its streaming mode (P1, P3, P8, P12).
const r = (event: object): string => JSON.stringify(event)

describe('logSafe (row 214)', () => {
  it('logSafe spells out control, format and separator characters (issue #64)', () => {
    expect(logSafe('a\x1b[2Jb\tc\u202ed\u2028e · → é')).toBe('a\\x1b[2Jb\\tc\\u{202e}d\\u{2028}e · → é')
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
