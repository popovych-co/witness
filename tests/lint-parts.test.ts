import { describe, expect, it } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { boundReader, detectReaders, lintCommands } from '../src/lint-parts.js'
import { configYaml, tmpRepo } from './helpers.js'

const cfgWith = (patch: Record<string, unknown>): Config => {
  const repo = tmpRepo()
  repo.write('witness.config.yaml', configYaml(patch))
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(JSON.stringify(r.violations))
  return r.value
}

describe('lint parts as repo commands (row 261)', () => {
  it('lintCommands lists every part under its own source, in order', () => {
    expect(lintCommands(cfgWith({ ship: { lint: { biome: 'b', types: 't' } } })))
      .toEqual([{ cmd: 'b', source: 'ship.lint.biome' }, { cmd: 't', source: 'ship.lint.types' }])
    expect(lintCommands(cfgWith({ ship: { lint: 'pnpm lint' } }))).toEqual([{ cmd: 'pnpm lint', source: 'ship.lint' }])
  })
})

describe('readers bound by name (row 262)', () => {
  it('a reader reads the part of its name and is listed after the parts; one with no such part is not (row 262)', () => {
    const cfg = cfgWith({ ship: { lint: { biome: 'b', ui: 'u' } }, readers: { biome: 'b-sarif', eslint: 'e-json' } })
    expect(boundReader(cfg, cfg.ship.lint![0]!)).toEqual({ tool: 'biome', cmd: 'b-sarif' })
    expect(boundReader(cfg, cfg.ship.lint![1]!)).toBeUndefined()
    expect(lintCommands(cfg)).toEqual([
      { cmd: 'b', source: 'ship.lint.biome' }, { cmd: 'u', source: 'ship.lint.ui' }, { cmd: 'b-sarif', source: 'readers.biome' },
    ])
  })

  it.each([
    [['pnpm-lock.yaml', 'biome.json'], { 'readers.biome': 'pnpm exec biome check --reporter=sarif .' }],
    [['pnpm-lock.yaml', 'eslint.config.mjs'], { 'readers.eslint': 'pnpm exec eslint -f json .' }],
    [['package-lock.json', 'biome.jsonc', '.eslintrc.json'], { 'readers.biome': 'npx --no biome check --reporter=sarif .', 'readers.eslint': 'npx --no eslint -f json .' }],
    [['yarn.lock', 'biome.json'], { 'readers.biome': 'yarn biome check --reporter=sarif .' }],
    [['bun.lock', 'eslint.config.ts'], { 'readers.eslint': 'bunx eslint -f json .' }],
    [['biome.json'], {}],
    [['pnpm-lock.yaml'], {}],
  ])('detectReaders with %j at the root is %j (row 262)', (files, want) => {
    const repo = tmpRepo()
    for (const f of files) repo.write(f, f.endsWith('.json') || f.endsWith('.jsonc') ? '{}\n' : '')
    expect(detectReaders(repo.root)).toEqual(want)
  })
})

describe('a reader that binds nothing is said where it is written (row 262, whole-branch review I2)', () => {
  it('init writes a detected reader beside one ship.lint part named lint, and says the part must be named for its tool', async () => {
    const repo = tmpRepo()
    repo.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
    repo.write('biome.json', '{}\n')
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'tools')
    const r = await repo.cli(['init'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('note: readers.biome is set, but no ship.lint part is named biome — name the part that runs biome "biome" and a red base is judged per diagnostic')
  }, 60_000)
})
