import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHarness } from '../src/harness.js'
import { invokeReviewer, invokeReviewerAsync, parseVerdictText, PROMPT_NAMES, promptsSha, resolvePrompt } from '../src/reviewer.js'
import { fakeScenario, gateEnv, putVerdict, fakeCtx, tmpRepo } from './helpers.js'

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
