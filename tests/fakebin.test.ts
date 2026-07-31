import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeBinDir, fakeScenario, gateEnv, ghState, putVerdict } from './helpers.js'

function runFake(bin: string, args: string[], scenario: string, input?: string) {
  return execFileSync(join(fakeBinDir(), bin), args, {
    env: gateEnv(scenario), input, encoding: 'utf8',
  })
}

describe('fake claude', () => {
  it('answers the envelope from verdict.json and records the call', () => {
    const dir = fakeScenario()
    putVerdict(dir, { coverage: [{ anchor: '## Behavior', note: 'read' }], findings: [] })
    const out = runFake('claude', ['-p', '--output-format', 'json', '--model', 'test-model-1'], dir, 'PROMPT BODY')
    const envelope = JSON.parse(out) as { result: string }
    expect(JSON.parse(envelope.result)).toEqual({ coverage: [{ anchor: '## Behavior', note: 'read' }], findings: [] })
    expect(readFileSync(join(dir, 'claude-calls/call-1/argv'), 'utf8')).toContain('test-model-1')
    expect(readFileSync(join(dir, 'claude-calls/call-1/stdin'), 'utf8')).toBe('PROMPT BODY')
  })

  it('per-call verdicts override the default; claude-fail injects failures', () => {
    const dir = fakeScenario()
    putVerdict(dir, { coverage: [], findings: [] })
    putVerdict(dir, { coverage: [{ anchor: '## X', note: 'n' }], findings: [] }, 2)
    runFake('claude', ['-p', '--output-format', 'json'], dir, 'one')
    const second = JSON.parse(runFake('claude', ['-p', '--output-format', 'json'], dir, 'two')) as { result: string }
    expect(JSON.parse(second.result).coverage.length).toBe(1)

    const failing = fakeScenario()
    putVerdict(failing, { coverage: [], findings: [] })
    writeFileSync(join(failing, 'claude-fail'), '1')
    expect(() => runFake('claude', ['-p', '--output-format', 'json'], failing, 'x')).toThrow()
    expect(runFake('claude', ['-p', '--output-format', 'json'], failing, 'y')).toContain('result')
  })
})

describe('fake gh', () => {
  it('mints PRs, reports state, gates checks', () => {
    const dir = fakeScenario()
    const url = runFake('gh', ['pr', 'create', '--title', 't', '--body', 'b', '--head', 'x'], dir).trim()
    expect(url).toBe('https://github.com/fake/fake/pull/1')
    expect(JSON.parse(runFake('gh', ['pr', 'view', '1', '--json', 'state'], dir))).toEqual({ state: 'OPEN' })
    ghState(dir, 1, 'MERGED')
    expect(JSON.parse(runFake('gh', ['pr', 'view', '1', '--json', 'state'], dir))).toEqual({ state: 'MERGED' })
    expect(runFake('gh', ['pr', 'checks', '1'], dir)).toContain('successful')
    expect(() => runFake('gh', ['pr', 'view', '9', '--json', 'state'], dir)).toThrow()
  })
})

describe('fake pi', () => {
  it('records argv+stdin and emits an agent_end NDJSON envelope carrying the verdict', () => {
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const out = execFileSync('pi', ['-p', '--mode', 'json', '--thinking', 'off'], {
      env: gateEnv(scenario) as NodeJS.ProcessEnv, input: 'PROMPT BODY', encoding: 'utf8',
    })
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as { type: string })
    expect(lines.at(-1)!.type).toBe('agent_settled')
    const end = lines.find((l) => l.type === 'agent_end') as unknown as {
      messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>
    }
    const text = end.messages.at(-1)!.content[0]!.text
    expect(JSON.parse(text)).toEqual({ coverage: [], findings: [] })
    expect(readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')).toContain('--thinking\noff')
    expect(readFileSync(join(scenario, 'pi-calls/call-1/stdin'), 'utf8')).toBe('PROMPT BODY')
  })

  it('pi-error emits stopReason error with exit 0', () => {
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'pi-error'), '400 third-party billing blocked')
    const out = execFileSync('pi', ['-p', '--mode', 'json'], {
      env: gateEnv(scenario) as NodeJS.ProcessEnv, input: 'x', encoding: 'utf8',
    })
    expect(out).toContain('"stopReason":"error"')
    expect(out).toContain('billing')
  })
})
