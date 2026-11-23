import { describe, expect, it } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { lintCommands } from '../src/lint-parts.js'
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
