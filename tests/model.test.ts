import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { stageModel, stagePin, unansweredPin, SESSION_DEFAULT } from '../src/model.js'
import { v } from '../src/refusal.js'
import { seededRepo } from './helpers.js'

async function refusalOf(gatesYaml: string) {
  const repo = await seededRepo()
  writeFileSync(join(repo.root, 'witness.config.yaml'), `schema: 1\n${gatesYaml}`)
  const cfg = loadConfig(repo.root)
  if (cfg.ok) throw new Error('config must refuse')
  return cfg.violations[0]!
}

async function cfgWith(gatesYaml: string) {
  const repo = await seededRepo()
  const cfgPath = join(repo.root, 'witness.config.yaml')
  writeFileSync(cfgPath, `schema: 1\n${gatesYaml}`)
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error('config must load')
  return { repo, cfg: cfg.value }
}

describe('stageModel (row 212)', () => {
  // Row 193: a pin is checked when the file loads, and again where it is used.
  it('refuses alias pins, at load under their own name and at use', async () => {
    expect(await refusalOf('gates:\n  model: opus\n')).toMatchObject({ field: 'gates.model', rule: 'alias-refused' })
    const { cfg } = await cfgWith('')
    const r = stageModel({ ...cfg, arbiter: { model: 'opus' } }, 'arbiter')
    expect(!r.ok && r.violations[0]).toMatchObject({ field: 'arbiter.model', rule: 'alias-refused' })
  })

  it('refuses an alias in a per-gate pin, naming the gate field', async () => {
    expect(await refusalOf('gates:\n  ship: { model: opus }\n')).toMatchObject({ field: 'gates.ship.model', rule: 'alias-refused' })
    const { cfg } = await cfgWith('')
    const r = stageModel({ ...cfg, gates: { ...cfg.gates, ship: { ...cfg.gates.ship, model: 'opus' } } }, 'ship')
    expect(!r.ok && r.violations[0]).toMatchObject({ field: 'gates.ship.model', rule: 'alias-refused' })
  })

  it('asks the stage pin — a per-gate pin wins, other gates keep theirs', async () => {
    const { cfg } = await cfgWith('gates:\n  model: test-model-1\n  decompose: { model: test-model-2 }\n')
    expect(stageModel(cfg, 'decompose')).toEqual({ ok: true, value: 'test-model-2' })
    expect(stageModel(cfg, 'plan')).toEqual({ ok: true, value: 'test-model-1' })
  })
  it('asks the session default for a file that never pinned one', async () => {
    const { cfg } = await cfgWith('')
    expect(stageModel(cfg, 'arbiter')).toEqual({ ok: true, value: SESSION_DEFAULT })
  })
})

describe('stagePin grammar', () => {
  it('refuses aliases in the model segment and unknown thinking levels', async () => {
    expect((await refusalOf('gates:\n  model: anthropic/opus:low\n')).rule).toBe('alias-refused')
    expect((await refusalOf('gates:\n  model: claude-fable-5:turbo\n')).rule).toBe('unknown-thinking-level')
    const { cfg } = await cfgWith('')
    const lvlR = stagePin({ ...cfg, arbiter: { model: 'claude-fable-5:turbo' } }, 'arbiter')
    expect(!lvlR.ok && lvlR.violations[0]).toMatchObject({ field: 'arbiter.model', rule: 'unknown-thinking-level' })

    const good = await cfgWith('gates:\n  model: google/gemini-3.6-pro:low\n')
    const goodR = stagePin(good.cfg, 'arbiter')
    expect(goodR.ok).toBe(true)
    if (goodR.ok) expect(goodR.value).toBe('google/gemini-3.6-pro:low')
  })
})

// Final review. The pin row is a human's call only when the harness's own error names the pinned
// model as one it cannot run; a provider blip, a missing binary or an auth failure is named, not
// blamed — re-running clears those, and the human trailer would say it cannot.
describe('unansweredPin (row 212)', () => {
  const inv = (got: string) => v('claude', 'reviewer-invocation', got, 'w')
  it('adds nothing for the session default, or for a failure that is no invocation', () => {
    expect(unansweredPin([inv('x')], 'gates.plan.model', SESSION_DEFAULT, 'claude-code')).toEqual([inv('x')])
    const limit = v('claude', 'usage-limit', "You've hit your session limit", 'w')
    expect(unansweredPin([limit], 'gates.plan.model', 'test-model-1', 'claude-code')).toEqual([limit])
  })
  it("is a human's call when the error names the pinned model as one it cannot run", () => {
    for (const [pin, got] of [
      ['test-model-1', "There's an issue with the selected model (test-model-1). It may not exist or you may not have access to it."],
      ['test-model-1:high', 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: test-model-1"}}'],
      ['anthropic/test-model-1', 'exit 1: Model not found: anthropic/test-model-1'],
    ] as const) {
      const rows = unansweredPin([inv(got)], 'gates.plan.model', pin, 'pi')
      expect(rows.at(-1), got).toMatchObject({ field: 'gates.plan.model', rule: 'pin-unanswered', got: pin, human: true })
    }
  })
  it('names the pin without blaming it when the error is about something else', () => {
    for (const got of [
      'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      'spawn pi ENOENT', 'Invalid API key · Please run /login', 'Third-party apps now draw from your extra usage',
    ]) {
      const row = unansweredPin([inv(got)], 'gates.plan.model', 'test-model-1', 'claude-code').at(-1)!
      expect(row.rule, got).toBe('pin-unanswered')
      expect(row.human, got).toBeUndefined()
    }
  })
})
