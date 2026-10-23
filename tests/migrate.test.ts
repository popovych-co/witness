import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextLimitOf } from '../plugin/hooks/context-core.mjs'
import { readComments } from '../src/config-file.js'
import { loadConfig, resolveSettings, type Resolved } from '../src/config.js'
import { migrateValues } from '../src/migration.js'
import { SETTINGS, defaultValues, getIn, withValues } from '../src/settings.js'
import { guardMigration } from '../src/verbs/migrate.js'
import { patchConfig, tmpRepo, type TestRepo } from './helpers.js'

// Row 193 §4.6. `witness migrate` brings witness.config.yaml to the current schema, complete,
// keeping every value that is a choice and every comment a human wrote, and names each change.
const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'configs', name), 'utf8')

function committed(text: string): TestRepo {
  const repo = tmpRepo()
  repo.write('witness.config.yaml', text)
  repo.git('add', '-A')
  repo.git('commit', '-m', 'config')
  return repo
}
const loaded = (repo: TestRepo) => {
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(JSON.stringify(r.violations))
  return r.value
}
const values = ({ schema: _s, warning: _w, ...rest }: ReturnType<typeof loaded>) => rest
const humanLines = (text: string) => {
  const { human } = readComments(text)
  return [...human.top, ...[...human.above.values()].flat(), ...human.end]
}
const strict = (raw: Record<string, unknown>): Resolved => {
  const r = resolveSettings(raw, 'strict')
  if (!r.ok) throw new Error(JSON.stringify(r.violations))
  return r.value
}

describe('witness migrate (row 193 §4.6)', () => {
  it.each(['a', 'b', 'c'])('migrates consumer-%s and keeps every value and human comment', async (x) => {
    const before = fixture(`consumer-${x}.yaml`)
    const repo = committed(before)
    const was = loaded(repo)
    expect(was.warning).toMatch(/^schema 1 is older/)
    const r = await repo.cli(['migrate'])
    expect(r.code, r.stderr).toBe(0)
    const after = repo.read('witness.config.yaml')
    await expect(after).toMatchFileSnapshot(`../fixtures/configs/consumer-${x}.migrated.yaml`)
    const now = loaded(repo)
    expect(now.warning).toBeUndefined()
    expect(now.schema).toBe(2)
    expect(values(now)).toEqual(values(was))       // the consumers declare everything ambient: nothing filled
    expect(r.stdout).not.toContain('filled:')
    for (const line of humanLines(before)) expect(after).toContain(line.trim())
    expect(r.stdout).toContain(`dropped ${x === 'a' ? 0 : 2} old template lines`)
    expect(r.stdout).toContain('config: schema 1 → 2')
    expect(repo.git('log', '-1', '--format=%s')).toBe('migrate: config schema 1 → 2')
    expect(repo.git('log', '-1', '--format=%b')).toContain('Witness-State: 1')
    expect(repo.git('status', '--porcelain', '--', 'witness.config.yaml')).toBe('')
  })

  it('names the gates.model expansion and what it adds', async () => {
    const repo = committed(fixture('consumer-a.yaml'))
    const r = await repo.cli(['migrate'])
    expect(r.stdout).toContain('expanded: gates.model claude-opus-5-5 → decompose · plan · design · arbiter.model')
    expect(r.stdout).toContain('added: session.contextLimit 20 — % of the context window at which a session hands over to a fresh one · 1–100')
    expect(r.stdout).toMatch(/comments: kept \d+ · moved 3 · dropped 0 old template lines/)
  })

  it('is idempotent', async () => {
    const repo = committed(fixture('consumer-b.yaml'))
    expect((await repo.cli(['migrate'])).code).toBe(0)
    const head = repo.git('rev-parse', 'HEAD')
    const text = repo.read('witness.config.yaml')
    const again = await repo.cli(['migrate'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('config: schema 2 · up to date')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
    expect(repo.read('witness.config.yaml')).toBe(text)
  })

  it('restores a deleted setting in a current file', async () => {
    const repo = tmpRepo()
    await repo.cli(['init'])
    patchConfig(repo, { drive: { caps: { spawns: undefined } } })
    repo.git('add', '-A'); repo.git('commit', '-m', 'lost a cap')
    expect(loadConfig(repo.root).ok).toBe(false)
    const r = await repo.cli(['migrate'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('added: drive.caps.spawns 24 —')
    expect(r.stdout).toContain('config: schema 2 → 2')
    expect(loaded(repo).drive.caps.spawns).toBe(24)
  })

  it('refuses unknown keys with a suggestion', async () => {
    const text = 'schema: 1\nsession:\n  contextLimt: 30\n'
    const repo = committed(text)
    const r = await repo.cli(['migrate'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown-key')
    expect(r.stderr).toContain('did you mean session.contextLimit?')
    expect(repo.read('witness.config.yaml')).toBe(text)
  })

  it('refuses an uncommitted config', async () => {
    const repo = committed('schema: 1\n')
    repo.write('witness.config.yaml', 'schema: 1\nautonomy: off\n')
    const r = await repo.cli(['migrate'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('dirty')
    expect(r.stderr).toContain('commit or clean witness.config.yaml first')
  })

  it('refuses a newer schema', async () => {
    const r = await committed('schema: 3\n').cli(['migrate'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('newer-than-cli')
  })

  it('guard refuses a changed value and a lost comment', () => {
    const before = strict(defaultValues())
    const after = strict(withValues(defaultValues(), { ship: { branch: 'trunk' } }))
    const human = { top: [], above: new Map([['ship.branch', ['# the team ships to main']]]), end: [] }
    const changed = guardMigration({ before, after, changes: [], human, newText: '# the team ships to main\n' })
    expect(changed.map((x) => [x.field, x.rule])).toEqual([['ship.branch', 'value-changed']])
    const lost = guardMigration({ before, after: before, changes: [], human, newText: 'schema: 2\n' })
    expect(lost.map((x) => x.rule)).toEqual(['comment-lost'])
    const named = guardMigration({
      before, after, changes: [{ kind: 'moved', path: 'ship.branch', from: 'main', to: 'trunk' }], human, newText: '# the team ships to main',
    })
    expect(named).toEqual([])
  })

  it('moves a value at the old default and keeps a choice', () => {
    const list = SETTINGS.map((s) => (s.path === 'drive.caps.spawns' ? { ...s, defaults: { 1: 24, 3: 30 } } : s))
    const at = (spawns: number) => migrateValues(withValues(defaultValues(), { drive: { caps: { spawns } } }), 2,
      { mode: 'write', to: 3, settings: list, harness: 'claude-code' })
    const moved = at(24)
    expect(moved.ok && getIn(moved.value.raw, 'drive.caps.spawns')).toBe(30)
    expect(moved.ok && moved.value.changes).toContainEqual({ kind: 'moved', path: 'drive.caps.spawns', from: 24, to: 30 })
    expect(moved.ok && moved.value.raw.schema).toBe(3)
    const kept = at(20)
    expect(kept.ok && getIn(kept.value.raw, 'drive.caps.spawns')).toBe(20)
    expect(kept.ok && kept.value.changes.filter((c) => c.kind === 'moved')).toEqual([])
  })

  it('--dry-run prints the changes and a diff and writes nothing', async () => {
    const text = fixture('consumer-c.yaml')
    const repo = committed(text)
    const head = repo.git('rev-parse', 'HEAD')
    const r = await repo.cli(['migrate', '--dry-run'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('expanded: gates.model claude-opus-5 →')
    expect(r.stdout).toContain('diff:')
    expect(r.stdout).toContain('+schema: 2')
    expect(r.stdout).toContain('-schema: 1')
    expect(repo.read('witness.config.yaml')).toBe(text)
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
  })

  it('an unknown flag renders the usage (row 113)', async () => {
    const r = await committed('schema: 1\n').cli(['migrate', '--dryrun'])
    expect(r.code).toBe(2)
    expect(r.stdout + r.stderr).toContain('bad-arguments')
    expect(r.stdout + r.stderr).toContain('witness migrate [--dry-run]')
    expect(r.stdout + r.stderr).not.toContain('unexpected-error')
  })

  it('fills what a bare schema-1 file never declared and names each', async () => {
    const repo = committed('schema: 1\n')
    const r = await repo.cli(['migrate'], { env: { PI_CODING_AGENT: '1' } })
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^filled: harness pi — was undeclared/m)
    for (const p of ['gates.decompose.model', 'gates.plan.model', 'gates.design.model', 'gates.implement.model', 'gates.ship.model', 'arbiter.model']) {
      expect(r.stdout).toMatch(new RegExp(`^filled: ${p.replace('.', '\\.')} claude-opus-5-5 — `, 'm'))
    }
    for (const p of ['criteria.runner', 'ship.test', 'ship.lint']) expect(r.stdout).toMatch(new RegExp(`^filled: ${p} `, 'm'))
    const cfg = loaded(repo)
    expect(cfg.harness).toBe('pi')
    expect(cfg.ship.test).toBe('npm test')
  })

  it('keeps anchored and all-flow values', async () => {
    const repo = committed('{schema: 1, gates: {model: &m claude-opus-5-5, ship: {model: *m}}}\n')
    const r = await repo.cli(['migrate'])
    expect(r.code, r.stderr).toBe(0)
    const cfg = loaded(repo)
    for (const g of ['decompose', 'plan', 'design', 'implement', 'ship'] as const) expect(cfg.gates[g].model, g).toBe('claude-opus-5-5')
    expect(cfg.arbiter.model).toBe('claude-opus-5-5')
    const text = repo.read('witness.config.yaml')
    expect(text).not.toMatch(/&m|\*m|: \{/)     // no anchor, no alias, no flow map
    expect(text).toMatch(/^gates:$/m)
  })

  it('reads CRLF and a BOM and writes LF', async () => {
    const source = fixture('consumer-a.yaml')
    const repo = committed(`﻿${source.replace(/\n/g, '\r\n')}`)
    const r = await repo.cli(['migrate'])
    expect(r.code, r.stderr).toBe(0)
    const out = repo.read('witness.config.yaml')
    expect(out).not.toContain('\r')
    expect(out.startsWith('﻿')).toBe(false)
    for (const line of humanLines(source)) expect(out).toContain(line.trim())
    expect(contextLimitOf(out)).toBe(20)
    expect(out).toBe(fixture('consumer-a.migrated.yaml'))
  })

  // Final review I1: an empty section or value read as unset is filled, not refused.
  it('migrates empty sections and values an older file left', async () => {
    const repo = committed('schema: 1\nship:\n  # test: npm test\ngates:\n  model: claude-opus-5-5\n  design:\n')
    const r = await repo.cli(['migrate'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^added: ship\.branch main — /m)
    expect(repo.read('witness.config.yaml')).toContain('# test: npm test')
    expect(loaded(repo).gates.design.model).toBe('claude-opus-5-5')
  })

  // Final review I4: a multi-line command holding a double quote crashed the rewrite.
  it('migrates a multi-line command that holds double quotes', async () => {
    const repo = committed('schema: 1\nship:\n  test: |\n    pnpm build\n    pnpm test --reporter "dot"\n')
    const r = await repo.cli(['migrate'])
    expect(r.code, r.stderr).toBe(0)
    expect(loaded(repo).ship.test).toBe('pnpm build\npnpm test --reporter "dot"\n')
  })

  // Final review (re-graded Important): a Windows checkout with core.autocrlf holds the migrated
  // file with CRLF line ends; a second run must still read it as up to date.
  it('is idempotent on a CRLF checkout', async () => {
    const repo = committed(fixture('consumer-a.yaml'))
    expect((await repo.cli(['migrate'])).code).toBe(0)
    repo.git('config', 'core.autocrlf', 'true')
    repo.git('rm', '-q', '--cached', 'witness.config.yaml')
    repo.git('reset', '-q', '--hard')
    expect(repo.read('witness.config.yaml')).toContain('\r\n')
    const head = repo.git('rev-parse', 'HEAD')
    const again = await repo.cli(['migrate'])
    expect(again.code, again.stderr).toBe(0)
    expect(again.stdout).toContain('config: schema 2 · up to date')
    expect(repo.read('witness.config.yaml')).toContain('\r\n')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
  })

  it('acts on the primary root from a worktree', async () => {
    const repo = committed(fixture('consumer-b.yaml'))
    const wt = join(repo.root, '.witness', 'worktrees', 'p1')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'p1', wt], { cwd: repo.root })
    const r = await repo.cli(['migrate'], { cwd: wt })
    expect(r.code, r.stderr).toBe(0)
    expect(repo.read('witness.config.yaml')).toBe(fixture('consumer-b.migrated.yaml'))
    expect(readFileSync(join(wt, 'witness.config.yaml'), 'utf8')).toBe(fixture('consumer-b.yaml'))
  })
})
