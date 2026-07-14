import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { invokeClaude, parseVerdictText, PROMPT_NAMES, promptsSha, resolvePrompt } from '../src/reviewer.js'
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

describe('invokeClaude', () => {
  it('pipes the prompt over stdin, passes the model flag, returns the result text', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeClaude(ctx, { cwd: repo.root, prompt: 'LENS\n\n## Reviewed content\nBODY', model: 'test-model-1' })
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
    const r = invokeClaude(ctx, { cwd: repo.root, prompt: 'x' })
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
