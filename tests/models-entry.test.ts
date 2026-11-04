import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import * as models from '../src/models.js'
import { hermeticEnv, seededRepo, spawnAsync } from './helpers.js'
import { decideRepo } from './model-fixtures.js'

// Rows 139/203. `@popovych.co/witness/models` is the CLI's read surface for the UI: the three
// models and the reads that feed them, as plain data, and no writer. The package's `exports` map
// names it alone, so no deep import reaches past it.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports?: unknown }
const tsconfig = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8')) as {
  compilerOptions: { declaration?: boolean }
}

it('exports the read surface and nothing that writes', () => {
  expect(Object.keys(models).sort()).toEqual(['HELD_KINDS', 'WAIT_KINDS', 'WAIT_LABEL', 'decideView', 'liveDrive',
    'loadCanon', 'loadConfig', 'needsYou', 'needsYouToken', 'trustListing'])
})

it('package.json exports ./models alone, built with its declarations', () => {
  expect(pkg.exports).toEqual({ './models': { types: './dist/models.d.ts', default: './dist/models.js' } })
  expect(tsconfig.compilerOptions.declaration).toBe(true)
})

it('reads all three models of a repo through the entry, as plain data', async () => {
  const { repo, gate, target } = await decideRepo('implement-revised')
  const cfg = models.loadConfig(repo.root); if (!cfg.ok) throw new Error('config')
  const canon = models.loadCanon(repo.root)
  const items = models.needsYou(repo.root, { env: {} }, cfg.value, canon, models.liveDrive(repo.root, canon)?.asides ?? [])
  const view = models.decideView(repo.root, cfg.value, canon, gate, target)
  const trust = models.trustListing(repo.root, cfg.value, canon, target)
  expect(items.some((i) => i.kind === 'need')).toBe(true)
  expect(view.state).toBe('actionable')
  expect(trust.ok).toBe(true)
  for (const m of [items, view, trust]) expect(JSON.parse(JSON.stringify(m))).toEqual(m)
})

// Review Focus 5. The entry by package name in a fresh Node process, as the UI loads it: no test
// fixture registers the gates there, so `decideView` answering every gate is the entry's own
// registration (src/decide-view.ts imports gates/index.js), and the entry prints nothing itself.
// `dist/` is the build tests/global-setup.ts makes before any test file runs.
it('loads by package name in a fresh process, registers the gates decideView reads, and prints nothing', async () => {
  const repo = await seededRepo()
  const script = [
    "const m = await import('@popovych.co/witness/models')",
    "console.log(Object.keys(m).sort().join(' '))",
    'const root = process.argv[1]',
    'const cfg = m.loadConfig(root)',
    "if (!cfg.ok) throw new Error('config')",
    'const canon = m.loadCanon(root)',
    "for (const gate of ['decompose', 'plan', 'implement', 'ship', 'design']) {",
    "  console.log(gate, m.decideView(root, cfg.value, canon, gate, 'ghost').state)",
    '}',
  ].join('\n')
  const pkgRoot = resolve(import.meta.dirname, '..')
  const res = await spawnAsync(process.execPath, ['--input-type=module', '-e', script, repo.root], { cwd: pkgRoot, env: hermeticEnv() })
  expect(res).toEqual({
    code: 0,
    stdout: [
      'HELD_KINDS WAIT_KINDS WAIT_LABEL decideView liveDrive loadCanon loadConfig needsYou needsYouToken trustListing',
      'decompose no-runs', 'plan no-runs', 'implement no-runs', 'ship no-runs', 'design no-runs', '',
    ].join('\n'),
    stderr: '',
  })
  expect(existsSync(resolve(pkgRoot, 'dist', 'models.d.ts'))).toBe(true)
})
