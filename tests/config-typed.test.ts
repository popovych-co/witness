import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { stageModel } from '../src/model.js'
import { DEFAULT_BATTERIES, GATE_NAMES } from '../src/settings.js'
import { tmpRepo } from './helpers.js'

// Row 193 §4.8, Task 3. A schema-1 file is read through the in-memory upgrade and the list's
// resolver. The expected values are written out, not computed: they are what today's resolvers
// plus the `cfg.raw` reads gave each consumer shape, and a difference is a behavior change.
const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'configs', name), 'utf8')

function load(text: string): Config {
  const repo = tmpRepo()
  repo.write('witness.config.yaml', text)
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(JSON.stringify(r.violations))
  return r.value
}

const DRIVE_DEFAULTS = {
  sessionTimeoutMs: 3_600_000, parallel: 2, parallelSuites: false,
  caps: { rounds: 16, upstream: 6, spawns: 24, wallClockMs: 57_600_000 },
}

function expectConsumer(cfg: Config, pin: string, lint: string) {
  for (const g of GATE_NAMES) {
    expect(cfg.gates[g].model, g).toBe(pin)
    expect(cfg.gates[g].reviewers, g).toEqual(DEFAULT_BATTERIES[g])
  }
  expect(cfg.arbiter.model).toBe(pin)
  expect(cfg.gates.reviewerTimeoutMs).toBe(600_000)
  expect(cfg.ship).toEqual({ test: 'pnpm test', lint, branch: 'main', merge: 'merge', ciSettleMs: 60_000 })
  expect(cfg.criteria).toEqual({ runner: 'full-suite', report: 'junit:reports/junit.xml', exclude: ['docs/superpowers/**'] })
  expect(cfg.paths).toEqual({ specs: 'docs/specs', plans: 'docs/plans', designs: 'docs/designs' })
  expect(cfg.docs.design).toEqual(['docs/ui/design-language.md', 'docs/ui/primitives.md'])
  expect(cfg.docs.conventions).toHaveLength(7)
  expect(cfg.harness).toBe('pi')
  expect(cfg.session.contextLimit).toBe(20)
  expect(cfg.implement.stepsPerDispatch).toBe(3)
  expect(cfg.drive).toEqual(DRIVE_DEFAULTS)
  expect(cfg.schema).toBe(1)
  expect(cfg).not.toHaveProperty('raw')
}

describe('typed config from the list (row 193, schema 1 read in memory)', () => {
  it('resolves consumer-a to today\'s values', () => {
    const cfg = load(fixture('consumer-a.yaml'))
    expectConsumer(cfg, 'claude-opus-5-5', 'pnpm lint && pnpm typecheck')
    expect(cfg.autonomy).toBe(false)   // `on`, but the fixture repo never committed it
  })

  it('resolves consumer-b and consumer-c to today\'s values', () => {
    const b = load(fixture('consumer-b.yaml'))
    expectConsumer(b, 'claude-opus-5', 'pnpm lint')
    expect(b.autonomy).toBe(false)
    const c = load(fixture('consumer-c.yaml'))
    expectConsumer(c, 'claude-opus-5', 'pnpm lint && pnpm typecheck')
    expect(c.autonomy).toBe(false)
  })

  it('keeps a per-gate pin and gives the rest gates.model', () => {
    const cfg = load('schema: 1\ngates:\n  model: model-x\n  plan: { model: model-y }\n  design: { model: model-z }\n')
    expect(cfg.gates.plan.model).toBe('model-y')
    expect(cfg.gates.design.model).toBe('model-z')
    for (const g of ['decompose', 'implement', 'ship'] as const) expect(cfg.gates[g].model, g).toBe('model-x')
    expect(cfg.arbiter.model).toBe('model-x')
  })

  it('leaves pins, harness, runner and ship commands absent when the file never set them', () => {
    const cfg = load('schema: 1\n')
    expect(cfg.harness).toBeUndefined()
    for (const g of GATE_NAMES) {
      expect(cfg.gates[g].model, g).toBeUndefined()
      expect(cfg.gates[g].reviewers, g).toEqual(DEFAULT_BATTERIES[g])
    }
    expect(cfg.arbiter.model).toBeUndefined()
    expect(cfg.criteria).toEqual({ runner: undefined, report: undefined, exclude: [] })
    expect(cfg.ship.test).toBeUndefined()
    expect(cfg.ship.lint).toBeUndefined()
    expect(cfg.ship.branch).toBe('main')
  })

  it('refuses an alias gates.model under its own name', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\ngates:\n  model: opus\n')
    const r = loadConfig(repo.root)
    expect(!r.ok && r.violations[0]).toMatchObject({ field: 'gates.model', rule: 'alias-refused' })
  })

  it('accepts empty docs lists as none', () => {
    expect(load('schema: 1\ndocs: { conventions: [] }\n').docs).toEqual({})
  })

  // Final review I1. 0.20.0 read an empty value (YAML null) where it read loosely — a section
  // whose every line is commented out, an empty gate block, `model:` — as unset; an upgrade
  // must not refuse those files.
  it('reads empty values in an older file as unset, as 0.20.0 did', () => {
    const cfg = load([
      'schema: 1', 'harness:', 'paths:', 'ship:', '  # test: npm test', 'criteria:',
      'gates:', '  model: claude-opus-5-5', '  design:', '  plan: { model: }', '',
    ].join('\n'))
    expect(cfg.harness).toBeUndefined()
    expect(cfg.paths).toEqual({ specs: 'specs', plans: 'plans', designs: 'designs' })
    expect(cfg.ship).toMatchObject({ test: undefined, lint: undefined, branch: 'main' })
    expect(cfg.criteria.runner).toBeUndefined()
    expect(cfg.gates.design.model).toBe('claude-opus-5-5')
    expect(cfg.gates.plan.model).toBe('claude-opus-5-5')
    expect(cfg.arbiter.model).toBe('claude-opus-5-5')
  })

  it('still refuses an empty session value, which the context adapter reads as no limit', () => {
    for (const text of ['schema: 1\nsession:\n', 'schema: 1\nsession:\n  contextLimit:\n']) {
      const repo = tmpRepo()
      repo.write('witness.config.yaml', text)
      expect(loadConfig(repo.root).ok, text).toBe(false)
    }
  })

  it('arbiter resolves the pin it used before', () => {
    const cfg = load(fixture('consumer-a.yaml'))
    expect(stageModel(cfg, 'arbiter')).toEqual({ ok: true, value: 'claude-opus-5-5' })
  })

  it('reads the 0.20.0 template as today: every gate and the arbiter on its one pin', () => {
    const cfg = load(fixture('init-0.20.0.yaml'))
    for (const g of GATE_NAMES) expect(cfg.gates[g].model, g).toBe('claude-fable-5')
    expect(cfg.arbiter.model).toBe('claude-fable-5')
    expect(cfg.criteria.runner).toBe('npm test -- -t "@spec:{id}"')
    expect(cfg.ship).toMatchObject({ test: 'npm test', lint: 'npm run lint', branch: 'main' })
    expect(cfg.harness).toBeUndefined()
  })
})
