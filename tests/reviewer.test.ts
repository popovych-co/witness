import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHarness } from '../src/harness.js'
import { invokeReviewer, invokeReviewerAsync, parseVerdictText, PROMPT_NAMES, promptsSha, resolvePrompt } from '../src/reviewer.js'
import { fakeClock, fakeScenario, gateEnv, putVerdict, fakeCtx, tmpRepo } from './helpers.js'

describe('prompt resolution', () => {
  it('resolves every shipped lens and hashes contents order-insensitively', () => {
    const lenses = PROMPT_NAMES.map((n) => {
      const r = resolvePrompt(n)
      expect(r.ok).toBe(true)
      return r.ok ? r.value : { name: n, contents: '' }
    })
    expect(lenses.every((l) => l.contents.includes('blocking'))).toBe(true)
    const sha = promptsSha(lenses)
    expect(promptsSha([...lenses].reverse())).toBe(sha)
    expect(promptsSha([{ ...lenses[0], contents: lenses[0].contents + 'x' }, ...lenses.slice(1)])).not.toBe(sha)
  })

  it('refuses unknown reviewers', () => {
    const r = resolvePrompt('no-such-lens')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0].rule).toBe('unknown-reviewer')
  })
})

const claudeHarness = (() => { const r = loadHarness('claude-code'); if (!r.ok) throw new Error('registry'); return r.value })()

describe('invokeReviewer via claude-code', () => {
  it('pipes the prompt over stdin, passes the model flag, returns the result text', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, claudeHarness, { cwd: repo.root, prompt: 'LENS\n\n## Reviewed content\nBODY', model: 'test-model-1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.value.text)).toEqual({ coverage: [], findings: [] })
    expect(readFileSync(join(scenario, 'claude-calls/call-1/argv'), 'utf8'))
      .toContain('--model\ntest-model-1')
    expect(readFileSync(join(scenario, 'claude-calls/call-1/stdin'), 'utf8')).toContain('BODY')
  })

  it('reports invocation failure as a structured refusal', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'claude-fail'), '1')
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, claudeHarness, { cwd: repo.root, prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0].rule).toBe('reviewer-invocation')
  })
})

describe('parseVerdictText', () => {
  it('parses bare JSON and fenced JSON, refuses prose', () => {
    expect(parseVerdictText('{"coverage":[],"findings":[]}').ok).toBe(true)
    expect(parseVerdictText('Here you go:\n```json\n{"coverage":[],"findings":[]}\n```\n').ok).toBe(true)
    const bad = parseVerdictText('LGTM, no issues!')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.violations[0].rule).toBe('verdict-unparseable')
  })
})

describe('transient invocation failure', () => {
  it('retries a timed-out reviewer instead of failing the whole run', () => {
    const repo = tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: 'a.md > ## B', note: 'read' }], findings: [] })
    // hang the FIRST call past the timeout, answer normally after: a stalled call is
    // transient, and treating it as fatal loses every sample a battery already paid for.
    writeFileSync(join(scenario, 'claude-hang'), '1')

    // row 90: the timeout is an InvokeOpts field the verb boundary resolves from
    // gates.reviewerTimeoutMs, not an env knob a test can smuggle in through ctx
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, claudeHarness, { cwd: repo.root, prompt: 'review this', timeoutMs: 400 })

    expect(r.ok).toBe(true)
    expect(readFileSync(join(scenario, 'claude-calls', 'call-2', 'argv'), 'utf8')).toContain('-p')
  })

  it('does not retry a missing binary — that is not transient', () => {
    const repo = tmpRepo()
    const ctx = fakeCtx(repo.root, { env: { PATH: '/nonexistent' } })
    const r = invokeReviewer(ctx, claudeHarness, { cwd: repo.root, prompt: 'review this' })

    expect(r.ok).toBe(false)
    expect(!r.ok && r.violations[0]!.rule).toBe('reviewer-invocation')
  })
})

const piHarness = (() => { const r = loadHarness('pi'); if (!r.ok) throw new Error('registry'); return r.value })()

describe('invokeReviewer via pi', () => {
  it('spawns hermetic pi print mode and parses the agent_end envelope', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, piHarness, { cwd: repo.root, prompt: 'LENS\nBODY', model: 'google/gemini-3.6-pro:low' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.value.text)).toEqual({ coverage: [], findings: [] })
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('--no-session')
    expect(argv).toContain('--no-extensions')
    expect(argv).toContain('--thinking\nlow')
    expect(argv).toContain('--model\ngoogle/gemini-3.6-pro')
    expect(readFileSync(join(scenario, 'pi-calls/call-1/stdin'), 'utf8')).toContain('BODY')
  })

  it('threads declared extensions into the pi argv', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, piHarness, {
      cwd: repo.root, prompt: 'LENS\nBODY', model: 'google/gemini-3.6-pro:low',
      extensions: ['/opt/pi/oauth-adapter'],
    })
    expect(r.ok).toBe(true)
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('-e\n/opt/pi/oauth-adapter')
    expect(argv).toContain('--no-extensions')
  })

  it('surfaces the in-stream provider error as a refusal', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'pi-error'), '400 third-party billing blocked')
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, piHarness, { cwd: repo.root, prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]!.rule).toBe('reviewer-invocation')
  })

  it('refuses a provider-qualified pin on claude-code before spawning anything', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    const claudeH = loadHarness('claude-code')
    if (!claudeH.ok) throw new Error('registry')
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, claudeH.value, { cwd: repo.root, prompt: 'x', model: 'google/gemini-3.6-pro' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]!.rule).toBe('provider-unrunnable')
    expect(existsSync(join(scenario, 'claude-calls'))).toBe(false)
  })
})

describe('invokeReviewer exports the lens', () => {
  it('a lens in the options reaches the reviewer as WITNESS_LENS', () => {
    const repo = tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, claudeHarness, { cwd: repo.root, prompt: 'x', lens: 'x' })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(scenario, 'claude-calls/call-1/lens'), 'utf8').trim()).toBe('x')
  })
})

// Row 191 §4.6. A reviewer is a harness session of its own, and on Claude Code the context
// adapter loads in it like in any other; the mark is what keeps the adapter's warning out.
describe('invokeReviewer marks its spawn as a reviewer', () => {
  for (const [harness, calls] of [[claudeHarness, 'claude-calls'], [piHarness, 'pi-calls']] as const) {
    it(`a ${harness.name} reviewer runs with WITNESS_REVIEWER=1`, () => {
      const repo = tmpRepo()
      const scenario = fakeScenario()
      putVerdict(scenario, { coverage: [], findings: [] })
      const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
      expect(invokeReviewer(ctx, harness, { cwd: repo.root, prompt: 'x' }).ok).toBe(true)
      expect(readFileSync(join(scenario, calls, 'call-1', 'reviewer'), 'utf8')).toBe('1\n')
    })
  }
})

// The async twin the battery fans out on. Same cases, same rows: the two invokers share
// their preparation and their result mapping, so a drift between them is a bug.
describe('invokeReviewerAsync', () => {
  it('pipes the prompt over stdin, passes the model flag, returns the result text', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = await invokeReviewerAsync(ctx, claudeHarness, { cwd: repo.root, prompt: 'LENS\n\n## Reviewed content\nBODY', model: 'test-model-1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.value.text)).toEqual({ coverage: [], findings: [] })
    expect(readFileSync(join(scenario, 'claude-calls/call-1/argv'), 'utf8'))
      .toContain('--model\ntest-model-1')
    expect(readFileSync(join(scenario, 'claude-calls/call-1/stdin'), 'utf8')).toContain('BODY')
  })

  it('reports invocation failure as a structured refusal', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'claude-fail'), '1')
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = await invokeReviewerAsync(ctx, claudeHarness, { cwd: repo.root, prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0].rule).toBe('reviewer-invocation')
  })

  it('does not retry a missing binary — that is not transient', async () => {
    const repo = tmpRepo()
    const ctx = fakeCtx(repo.root, { env: { PATH: '/nonexistent' } })
    const r = await invokeReviewerAsync(ctx, claudeHarness, { cwd: repo.root, prompt: 'review this' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.violations[0]!.rule).toBe('reviewer-invocation')
  })

  it('pi: spawns hermetic pi print mode and parses the agent_end envelope', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'LENS\nBODY', model: 'google/gemini-3.6-pro:low' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.value.text)).toEqual({ coverage: [], findings: [] })
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('--no-session')
    expect(argv).toContain('--no-extensions')
    expect(argv).toContain('--thinking\nlow')
    expect(argv).toContain('--model\ngoogle/gemini-3.6-pro')
    expect(readFileSync(join(scenario, 'pi-calls/call-1/stdin'), 'utf8')).toContain('BODY')
  })

  it('pi: threads declared extensions into the pi argv', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = await invokeReviewerAsync(ctx, piHarness, {
      cwd: repo.root, prompt: 'LENS\nBODY', model: 'google/gemini-3.6-pro:low',
      extensions: ['/opt/pi/oauth-adapter'],
    })
    expect(r.ok).toBe(true)
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('-e\n/opt/pi/oauth-adapter')
    expect(argv).toContain('--no-extensions')
  })

  it('pi: surfaces the in-stream provider error as a refusal', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'pi-error'), '400 third-party billing blocked')
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]!.rule).toBe('reviewer-invocation')
  })

  it('claude: prompt on stdin, model on argv, lens exported', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = await invokeReviewerAsync(ctx, claudeHarness, {
      cwd: repo.root, prompt: 'LENS\n\n## Reviewed content\nBODY', model: 'test-model-1', lens: 'code-reviewer',
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(scenario, 'claude-calls/call-1/lens'), 'utf8').trim()).toBe('code-reviewer')
  })

  it('retries a hung call and settles without waiting on the hung call\'s grandchild', async () => {
    const repo = tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'claude-hang'), '1')         // the fake sleeps 30 s in a child
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const t0 = Date.now()
    const r = await invokeReviewerAsync(ctx, claudeHarness, { cwd: repo.root, prompt: 'x', timeoutMs: 400 })
    expect(r.ok).toBe(true)
    expect(existsSync(join(scenario, 'claude-calls/call-2'))).toBe(true)
    expect(Date.now() - t0).toBeLessThan(10_000)
  }, 20_000)

  it('a nonzero exit is reviewer-invocation naming the exit code', async () => {
    const repo = tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'claude-fail'), '1')
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = await invokeReviewerAsync(ctx, claudeHarness, { cwd: repo.root, prompt: 'x' })
    expect(!r.ok && r.violations[0]!.rule).toBe('reviewer-invocation')
    expect(!r.ok && r.violations[0]!.got).toContain('exit 1')
  })
})

describe('invokeReviewerAsync fails closed', () => {
  it('a timeout past setTimeout\'s 2^31-1 ms ceiling is a long timeout, not an instant one', async () => {
    const repo = tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = await invokeReviewerAsync(ctx, claudeHarness, { cwd: repo.root, prompt: 'x', timeoutMs: 3_000_000_000 })
    expect(r.ok).toBe(true)
  })

  it('a reviewer that exits 0 without reading the whole prompt is refused', async () => {
    const repo = tmpRepo()
    // a claude that reads 64 KiB of its prompt, then answers clean and exits 0
    const bin = mkdtempSync(join(tmpdir(), 'witness-partial-'))
    writeFileSync(join(bin, 'claude'),
      '#!/bin/sh\nhead -c 65536 > /dev/null\nprintf \'%s\' \'{"type":"result","subtype":"success","result":"{\\"coverage\\":[],\\"findings\\":[]}"}\'\n')
    chmodSync(join(bin, 'claude'), 0o755)
    const ctx = fakeCtx(repo.root, { env: { ...gateEnv(fakeScenario()), PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
    const prompt = `${'x'.repeat(4 * 1024 * 1024)}\nTAIL-THE-REVIEWER-NEVER-SAW\n`
    const r = await invokeReviewerAsync(ctx, claudeHarness, { cwd: repo.root, prompt })
    expect(!r.ok && r.violations[0]!.rule).toBe('reviewer-invocation')
    expect(!r.ok && r.violations[0]!.got).toContain('before reading the whole prompt')
  })
})

describe('usage limits at the reviewer (B4)', () => {
  const LIMIT = "You've hit your session limit · resets 2pm (America/Los_Angeles)"
  const START = Date.parse('2026-10-19T19:30:00Z')
  const setup = async (limit = LIMIT, env: Record<string, string> = {}) => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'pi-error'), limit)
    writeFileSync(join(scenario, 'pi-error-calls'), '1')
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: { ...gateEnv(scenario), ...env }, err: (l) => errs.push(l) })
    return { repo, scenario, ctx, errs, clock: fakeClock(START) }
  }

  it('inside drive a limited call waits for the reset and retries', async () => {
    const { repo, scenario, ctx, errs, clock } = await setup(LIMIT, { WITNESS_DRIVE: 'p1' })
    const r = await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x', clock })
    expect(r.ok).toBe(true)
    expect(clock.slept).toEqual([5_460_000])
    expect(errs).toContain(`reviewer: usage limit — waiting 1h31m · ${LIMIT}`)
    expect(existsSync(join(scenario, 'pi-calls/call-2'))).toBe(true)
  })

  it('outside drive it refuses at once and names the reset', async () => {
    const { repo, scenario, ctx, clock } = await setup()
    const r = await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x', clock })
    expect(!r.ok && [r.violations[0]!.rule, r.violations[0]!.got]).toEqual(['usage-limit', LIMIT])
    expect(clock.slept).toEqual([])
    expect(existsSync(join(scenario, 'pi-calls/call-2'))).toBe(false)
  })

  it('a reset past the 6h reviewer wait refuses inside drive too', async () => {
    const late = "You've hit your session limit · resets 9pm (America/Los_Angeles)"   // 8h31m away
    const { repo, ctx, clock } = await setup(late, { WITNESS_DRIVE: 'p1' })
    const r = await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x', clock })
    expect(!r.ok && r.violations[0]!.rule).toBe('usage-limit')
    expect(clock.slept).toEqual([])
  })

  it('the sync invoker (calibration) never waits · it refuses as outside drive', async () => {
    const { repo, scenario, ctx } = await setup(LIMIT, { WITNESS_DRIVE: 'p1' })
    const r = invokeReviewer(ctx, piHarness, { cwd: repo.root, prompt: 'x' })
    expect(!r.ok && [r.violations[0]!.rule, r.violations[0]!.got]).toEqual(['usage-limit', LIMIT])
    expect(existsSync(join(scenario, 'pi-calls/call-2'))).toBe(false)
  })

  it('a verdict that quotes the limit line is a verdict', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [{ blocking: false, anchor: 'src/usage.ts', claim: LIMIT }] })
    const clock = fakeClock(START)
    const ctx = fakeCtx(repo.root, { env: { ...gateEnv(scenario), WITNESS_DRIVE: 'p1' } })
    expect((await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x', clock })).ok).toBe(true)
    expect(clock.slept).toEqual([])
  })
})

// Final review F12. claude exits 1 on an is_error envelope, so its limit text sits on stdout
// under a non-zero exit — the exit code alone read it as a bare invocation failure.
describe('usage limits on the claude harness (B4)', () => {
  const LIMIT = "You've hit your session limit · resets 2pm (America/Los_Angeles)"
  const START = Date.parse('2026-10-19T19:30:00Z')
  const claude = (() => { const r = loadHarness('claude-code'); if (!r.ok) throw new Error('registry'); return r.value })()
  const setup = async (env: Record<string, string> = {}) => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'claude-error'), LIMIT)
    writeFileSync(join(scenario, 'claude-error-calls'), '1')
    const ctx = fakeCtx(repo.root, { env: { ...gateEnv(scenario), ...env } })
    return { repo, scenario, ctx, clock: fakeClock(START) }
  }
  it('inside drive a limited claude call waits for the reset and retries', async () => {
    const { repo, scenario, ctx, clock } = await setup({ WITNESS_DRIVE: 'p1' })
    const r = await invokeReviewerAsync(ctx, claude, { cwd: repo.root, prompt: 'x', clock })
    expect(r.ok).toBe(true)
    expect(clock.slept).toEqual([5_460_000])
    expect(existsSync(join(scenario, 'claude-calls/call-2'))).toBe(true)
  })
  it('outside drive it refuses usage-limit naming the reset', async () => {
    const { repo, ctx, clock } = await setup()
    const r = await invokeReviewerAsync(ctx, claude, { cwd: repo.root, prompt: 'x', clock })
    expect(!r.ok && [r.violations[0]!.rule, r.violations[0]!.got]).toEqual(['usage-limit', LIMIT])
  })
})

// Final review F14. drive kills a session at drive.sessionTimeoutMs; a reviewer inside it
// that waits past that is killed mid-wait and leaves an orphaned gate. Drive hands each
// session its deadline, and a wait that cannot end before it refuses instead.
describe('a reviewer wait fits its session (B4)', () => {
  const LIMIT = "You've hit your session limit · resets 2pm (America/Los_Angeles)"   // 1h31m away
  const START = Date.parse('2026-10-19T19:30:00Z')
  const setup = async (deadline: number) => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'pi-error'), LIMIT)
    writeFileSync(join(scenario, 'pi-error-calls'), '1')
    const ctx = fakeCtx(repo.root, { env: { ...gateEnv(scenario), WITNESS_DRIVE: 'p1', WITNESS_DRIVE_DEADLINE: String(deadline) } })
    return { repo, ctx, clock: fakeClock(START) }
  }
  it('refuses a wait that outlives the session', async () => {
    const { repo, ctx, clock } = await setup(START + 30 * 60_000)
    const r = await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x', clock })
    expect(!r.ok && r.violations[0]!.rule).toBe('usage-limit')
    expect(clock.slept).toEqual([])
  })
  it('waits when the reset comes inside the session', async () => {
    const { repo, ctx, clock } = await setup(START + 3 * 3_600_000)
    expect((await invokeReviewerAsync(ctx, piHarness, { cwd: repo.root, prompt: 'x', clock })).ok).toBe(true)
    expect(clock.slept).toEqual([5_460_000])
  })
})
