import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedScratchRepo } from '../src/calibrate.js'
import { SCHEMA_VERSION, loadConfig, resolveSettings } from '../src/config.js'
import { RETIRED, SCHEMA_FINGERPRINTS, defaultValues } from '../src/settings.js'
import { patchConfig, tmpRepo } from './helpers.js'

// Row 193 §4.2, §4.8. Schema 2: every setting in the file, nothing unknown, and an older file
// read through the in-memory upgrade with a warning that names what `migrate` would do.
const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'configs', name), 'utf8')

async function initRepo(env: Record<string, string> = {}) {
  const repo = tmpRepo()
  const r = await repo.cli(['init'], { env })
  expect(r.code, r.stderr).toBe(0)
  return { repo, r }
}

describe('schema 2 (row 193)', () => {
  it('loads the file init writes, with every default', async () => {
    const { repo, r } = await initRepo()
    expect(repo.read('witness.config.yaml')).toBe(fixture('default.yaml'))
    expect(r.stdout).toContain('harness: claude-code · the default')
    const cfg = loadConfig(repo.root)
    expect(cfg.ok).toBe(true)
    if (!cfg.ok) return
    expect(cfg.value.schema).toBe(2)
    expect(cfg.value.warning).toBeUndefined()
    const want = resolveSettings(defaultValues({ harness: 'claude-code' }), 'strict')
    expect(want.ok && { schema: 2, ...want.value }).toEqual(cfg.value)

    const pi = await initRepo({ PI_CODING_AGENT: '1' })
    expect(pi.repo.read('witness.config.yaml')).toBe(fixture('default.yaml').replace('harness: claude-code   ', 'harness: pi            '))
    expect(pi.r.stdout).toContain('harness: pi · detected from this session')
  })

  it('refuses a missing setting with the line to add', async () => {
    const { repo } = await initRepo()
    patchConfig(repo, { session: { contextLimit: undefined } })
    const r = loadConfig(repo.root)
    expect(!r.ok && r.violations).toEqual([{
      field: 'session.contextLimit', rule: 'missing-setting', got: 'absent',
      want: 'contextLimit: 20 under session: — or run witness migrate',
    }])
  })

  it('refuses a typo and names the setting', async () => {
    const { repo } = await initRepo()
    patchConfig(repo, { session: { contextLimt: 30 } })
    const r = loadConfig(repo.root)
    expect(!r.ok && r.violations[0]).toMatchObject({ field: 'session.contextLimt', rule: 'unknown-key' })
    expect(!r.ok && r.violations[0]!.want).toMatch(/did you mean session\.contextLimit\?$/)
  })

  it('refuses gates.model in a schema-2 file', async () => {
    const { repo } = await initRepo()
    patchConfig(repo, { gates: { model: 'claude-opus-5-5' } })
    const r = loadConfig(repo.root)
    expect(!r.ok && r.violations[0]).toMatchObject({ field: 'gates.model', rule: 'unknown-key', want: RETIRED[0]!.instead })
    // Final review I5: `migrate` refuses this same key in a schema-2 file, so the fix is the edit
    expect(RETIRED[0]!.instead).not.toContain('witness migrate')
    expect(RETIRED[0]!.instead).toContain('delete gates.model')
  })

  it('an empty value in a current file refuses with the line to add', async () => {
    const { repo } = await initRepo()
    patchConfig(repo, { ship: { lint: null } })
    const r = loadConfig(repo.root)
    expect(!r.ok && r.violations).toEqual([{
      field: 'ship.lint', rule: 'missing-setting', got: 'absent', want: 'lint: npm run lint under ship: — or run witness migrate',
    }])
  })

  it('reads a schema-1 file through the upgrade and warns', async () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', fixture('consumer-a.yaml'))
    repo.git('add', '-A')
    repo.git('commit', '-m', 'consumer config')
    const r = loadConfig(repo.root)
    expect(r.ok && r.value.warning).toBe('schema 1 is older than this witness (2) — witness migrate adds 12 settings '
      + '(ship.merge · ship.ciSettleMs · session.contextLimit · …) · expands gates.model · refreshes comments')
    const check = await repo.cli(['check'])
    expect(check.stdout).toContain('older-schema')
    expect(check.stdout).toContain('schema 1 is older than this witness (2)')
  })

  it('the CLI schema is the list\'s newest', () => {
    expect(SCHEMA_VERSION).toBe(Math.max(...Object.keys(SCHEMA_FINGERPRINTS).map(Number)))
  })

  it('init --agent on an older repo prints the migrate line', async () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\n')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'old config')
    const r = await repo.cli(['init', '--agent', 'claude-code'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stderr).toContain('warn: schema 1 is older than this witness (2)')
  })

  it('calibrate writes a schema-2 scratch config', () => {
    const { root } = seedScratchRepo('schema-2', 'pi')
    const r = loadConfig(root)
    expect(r.ok && r.value.warning).toBeUndefined()
    expect(r.ok && r.value.harness).toBe('pi')
    expect(r.ok && r.value.criteria.runner).toBe('node --test --test-name-pattern "@spec:{id}"')
  })
})
