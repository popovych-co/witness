import { execFile, execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { callFor, fakeBinDir, fakeScenario, gateEnv, ghState, putVerdict } from './helpers.js'

function runFake(bin: string, args: string[], scenario: string, input?: string) {
  return execFileSync(join(fakeBinDir(), bin), args, {
    env: gateEnv(scenario), input, encoding: 'utf8',
  })
}

// pi resolves through PATH, as the existing pi tests drive it; claude by absolute path, as runFake does
const fakeFile = (bin: 'claude' | 'pi') => (bin === 'pi' ? 'pi' : join(fakeBinDir(), bin))

async function runFakeAsync(bin: 'claude' | 'pi', args: string[], scenario: string, input: string): Promise<string> {
  const p = promisify(execFile)(fakeFile(bin), args, { env: gateEnv(scenario) as NodeJS.ProcessEnv, encoding: 'utf8' })
  p.child.stdin!.end(input)
  return (await p).stdout
}

function runFakeLens(bin: 'claude' | 'pi', lens: string, scenario: string, input = 'x', args = ['-p']): string {
  return execFileSync(fakeFile(bin), args, {
    env: { ...gateEnv(scenario), WITNESS_LENS: lens } as NodeJS.ProcessEnv, input, encoding: 'utf8',
  })
}

// The verdict text each fake answered, out of its own envelope shape.
function answered(bin: 'claude' | 'pi', out: string): { coverage: Array<{ anchor: string }> } {
  if (bin === 'claude') return JSON.parse((JSON.parse(out) as { result: string }).result)
  const end = out.trim().split('\n').map((l) => JSON.parse(l) as { type: string; messages?: Array<{ content: Array<{ text: string }> }> })
    .find((l) => l.type === 'agent_end')!
  return JSON.parse(end.messages!.at(-1)!.content[0]!.text)
}

describe.each(['claude', 'pi'] as const)('fake %s under a concurrent battery', (bin) => {
  it('concurrent calls get distinct numbers', async () => {
    const dir = fakeScenario()
    putVerdict(dir, { coverage: [], findings: [] })
    await Promise.all(Array.from({ length: 6 }, (_, i) => runFakeAsync(bin, ['-p'], dir, `p${i}`)))
    // the fake's trail rides in the message: this lost a call on CI only (fixtures/fakebin/claude)
    expect(readdirSync(join(dir, `${bin}-calls`)).sort(), readFileSync(join(dir, `${bin}-trace`), 'utf8'))
      .toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5', 'call-6'])
  })

  it('records WITNESS_LENS and answers verdict-<lens>.json, a numbered verdict still winning', () => {
    const dir = fakeScenario()
    putVerdict(dir, { coverage: [], findings: [] })
    putVerdict(dir, { coverage: [{ anchor: 'L', note: 'lens' }], findings: [] }, 'code-reviewer')
    expect(answered(bin, runFakeLens(bin, 'code-reviewer', dir)).coverage[0]!.anchor).toBe('L')
    expect(readFileSync(join(dir, `${bin}-calls/call-1/lens`), 'utf8').trim()).toBe('code-reviewer')
    expect(callFor(dir, 'code-reviewer', bin)).toBe(join(dir, `${bin}-calls/call-1`))
    putVerdict(dir, { coverage: [{ anchor: 'N', note: 'numbered' }], findings: [] }, 2)
    expect(answered(bin, runFakeLens(bin, 'code-reviewer', dir)).coverage[0]!.anchor).toBe('N')
  })

  it('a barrier of 2 passes two concurrent calls and fails a lone call', async () => {
    const dir = fakeScenario()
    putVerdict(dir, { coverage: [], findings: [] })
    writeFileSync(join(dir, `${bin}-barrier`), '2')
    await Promise.all([runFakeAsync(bin, ['-p'], dir, 'a'), runFakeAsync(bin, ['-p'], dir, 'b')])
    const lone = fakeScenario()
    putVerdict(lone, { coverage: [], findings: [] })
    writeFileSync(join(lone, `${bin}-barrier`), '2')
    await expect(runFakeAsync(bin, ['-p'], lone, 'c')).rejects.toThrow(/barrier of 2 not reached/)
  }, 15_000)

  it(`${bin}-fail-<lens> fails that lens — on every call when empty, on a matching argv otherwise`, () => {
    const dir = fakeScenario()
    putVerdict(dir, { coverage: [], findings: [] })
    writeFileSync(join(dir, `${bin}-fail-type-design`), '')
    expect(() => runFakeLens(bin, 'type-design', dir)).toThrow()
    expect(answered(bin, runFakeLens(bin, 'pr-test', dir)).coverage).toEqual([])
    writeFileSync(join(dir, `${bin}-fail-code-reviewer`), 'test-model-1')
    expect(() => runFakeLens(bin, 'code-reviewer', dir, 'x', ['-p', '--model', 'test-model-1'])).toThrow()
    expect(answered(bin, runFakeLens(bin, 'code-reviewer', dir, 'x', ['-p', '--model', 'test-model-2'])).coverage).toEqual([])
  })
})

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
    expect(JSON.parse(runFake('gh', ['pr', 'view', '1', '--json', 'state'], dir))).toEqual({ state: 'OPEN', baseRefName: 'main' })
    ghState(dir, 1, 'MERGED')
    expect(JSON.parse(runFake('gh', ['pr', 'view', '1', '--json', 'state'], dir))).toEqual({ state: 'MERGED', baseRefName: 'main' })
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
