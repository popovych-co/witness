import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { loadMatrix, resolveModel, stagePin, SESSION_DEFAULT } from '../src/model.js'
import { seededRepo } from './helpers.js'

async function cfgWith(gatesYaml: string) {
  const repo = await seededRepo()
  const cfgPath = join(repo.root, 'specflow.config.yaml')
  writeFileSync(cfgPath, `schema: 1\n${gatesYaml}`)
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error('config must load')
  return { repo, cfg: cfg.value }
}

describe('resolveModel', () => {
  it('refuses alias pins', async () => {
    const { repo, cfg } = await cfgWith('gates:\n  model: opus\n')
    const r = resolveModel(cfg, loadMatrix(repo.root, 'claude-code'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0].rule).toBe('alias-refused')
  })

  it('pins first; an empty matrix warns as such (nothing is calibrated yet)', async () => {
    const { repo, cfg } = await cfgWith('gates:\n  model: test-model-1\n')
    const r = resolveModel(cfg, loadMatrix(repo.root, 'claude-code'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.chain[0]).toBe('test-model-1')
    expect(r.value.chain[r.value.chain.length - 1]).toBe(SESSION_DEFAULT)
    expect(r.value.calibrationOf('test-model-1')).toBe('none')
    expect(r.value.warning).toContain('calibration matrix is empty')
    expect(r.value.warning).toContain('test-model-1')
  })

  it('warns below-floor when the matrix is non-empty but the head is uncalibrated', async () => {
    const { repo, cfg } = await cfgWith('gates:\n  model: test-model-1\n')
    mkdirSync(join(repo.root, '.specflow'), { recursive: true })
    writeFileSync(join(repo.root, '.specflow/calibration.local.yaml'), 'models:\n  - test-model-2\n')
    const r = resolveModel(cfg, loadMatrix(repo.root, 'claude-code'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.warning).toContain('below the model floor')
  })

  it('reads the local overlay: calibrated ids join the chain and stamp local', async () => {
    const { repo, cfg } = await cfgWith('gates:\n  model: test-model-1\n')
    mkdirSync(join(repo.root, '.specflow'), { recursive: true })
    writeFileSync(join(repo.root, '.specflow/calibration.local.yaml'), 'models:\n  - test-model-2\n')
    const r = resolveModel(cfg, loadMatrix(repo.root, 'claude-code'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.chain).toEqual(['test-model-1', 'test-model-2', SESSION_DEFAULT])
    expect(r.value.calibrationOf('test-model-2')).toBe('local')
  })

  it('per-gate pin wins over the global pin; other gates keep the global', async () => {
    const { repo, cfg } = await cfgWith('gates:\n  model: test-model-1\n  decompose: { model: test-model-2 }\n')
    const d = resolveModel(cfg, loadMatrix(repo.root, 'claude-code'), 'decompose')
    expect(d.ok && d.value.chain[0]).toBe('test-model-2')
    const p = resolveModel(cfg, loadMatrix(repo.root, 'claude-code'), 'plan')
    expect(p.ok && p.value.chain[0]).toBe('test-model-1')
  })

  it('refuses an alias in a per-gate pin, naming the gate field', async () => {
    const { repo, cfg } = await cfgWith('gates:\n  ship: { model: opus }\n')
    const r = resolveModel(cfg, loadMatrix(repo.root, 'claude-code'), 'ship')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations[0].rule).toBe('alias-refused')
      expect(r.violations[0].field).toBe('gates.ship.model')
    }
  })

  it('unpinned: chain is calibrated ids then session default, no refusal', async () => {
    const { repo, cfg } = await cfgWith('')
    const r = resolveModel(cfg, loadMatrix(repo.root, 'claude-code'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.chain).toEqual([SESSION_DEFAULT])
    expect(r.value.warning).toContain('calibration matrix is empty')
  })
})

describe('per-harness matrix', () => {
  it('reads legacy top-level models as claude-code and matrices.<name> for pi', async () => {
    const repo = await seededRepo()
    mkdirSync(join(repo.root, '.specflow'), { recursive: true })
    writeFileSync(join(repo.root, '.specflow', 'calibration.local.yaml'),
      'models:\n  - claude-fable-5\nmatrices:\n  pi:\n    models:\n      - google/gemini-3.6-pro\n')
    expect(loadMatrix(repo.root, 'claude-code').local).toEqual(['claude-fable-5'])
    expect(loadMatrix(repo.root, 'pi').local).toEqual(['google/gemini-3.6-pro'])
  })
})

describe('stagePin grammar', () => {
  it('refuses aliases in the model segment and unknown thinking levels', async () => {
    const aliased = await cfgWith('gates:\n  model: anthropic/opus:low\n')
    const aliasedR = stagePin(aliased.cfg)
    expect(aliasedR.ok).toBe(false)
    if (!aliasedR.ok) expect(aliasedR.violations[0]!.rule).toBe('alias-refused')

    const lvl = await cfgWith('gates:\n  model: claude-fable-5:turbo\n')
    const lvlR = stagePin(lvl.cfg)
    expect(lvlR.ok).toBe(false)
    if (!lvlR.ok) expect(lvlR.violations[0]!.rule).toBe('unknown-thinking-level')

    const good = await cfgWith('gates:\n  model: google/gemini-3.6-pro:low\n')
    const goodR = stagePin(good.cfg)
    expect(goodR.ok).toBe(true)
    if (goodR.ok) expect(goodR.value).toBe('google/gemini-3.6-pro:low')
  })
})
