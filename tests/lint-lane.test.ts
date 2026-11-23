import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grantCommands } from '../src/allowlist.js'
import { loadConfig, type Config } from '../src/config.js'
import { lintCheck } from '../src/lint-lane.js'
import { fakeCtx, fakeScenario, fixtureEnv, patchConfig, seededRepo } from './helpers.js'

const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }

describe('lint parts (row 261)', () => {
  it("every part runs whatever an earlier one did — the && chain stopped at biome on fewhats' red main (map acceptance)", async () => {
    const repo = await seededRepo()
    const log = join(fakeScenario(), 'parts')
    const part = (name: string, exit: number) => `echo ${name} >> "${log}"; exit ${exit}`
    patchConfig(repo, { ship: { lint: { biome: part('biome', 1), eslint: part('eslint', 0), ui: part('ui', 0), types: part('types', 2) } } })
    const check = await lintCheck(repo.root, repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), cfgOf(repo.root), repo.git('rev-parse', 'HEAD'))
    expect(readFileSync(log, 'utf8')).toBe('biome\neslint\nui\ntypes\n')
    expect(check).toMatchObject({ name: 'lint', ok: false })
    expect(check.detail).toMatch(/^biome: red — [^]* · eslint: ok · ui: ok · types: red — /)
  })

  it('a part trust has not granted is named and skipped; the others run (row 261)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { ship: { lint: { a: 'true', b: 'echo b' } } })
    grantCommands(repo.root, ['true'])
    const check = await lintCheck(repo.root, repo.root, fakeCtx(repo.root, { env: fixtureEnv({ WITNESS_TRUST_CMDS: '' }) }), cfgOf(repo.root), repo.git('rev-parse', 'HEAD'))
    expect(check).toMatchObject({ ok: false, untrusted: ['echo b'] })
    expect(check.detail).toBe('a: ok · b: echo b: blocked')
  })

  it("one command keeps 0.30's lane: its command when green, its tail when red (row 261)", async () => {
    const repo = await seededRepo()
    const base = repo.git('rev-parse', 'HEAD')
    patchConfig(repo, { ship: { lint: 'true' } })
    expect(await lintCheck(repo.root, repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), cfgOf(repo.root), base))
      .toMatchObject({ name: 'lint', ok: true, detail: 'true' })
  })
})
