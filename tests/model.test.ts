import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { stageModel, stagePin, SESSION_DEFAULT } from '../src/model.js'
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
