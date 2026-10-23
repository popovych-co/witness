import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_REVIEWER_TIMEOUT_MS, loadConfig, loadLocalConfig, localConfigPath, resolveSession,
} from '../src/config.js'
import { seededRepo, tmpRepo, writeLocalConfig, patchConfig } from './helpers.js'

describe('loadConfig', () => {
  it('refuses when the config is missing', () => {
    const repo = tmpRepo()
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.rule).toBe('missing')
  })

  it('loads schema 1 and ignores unknown keys', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\nship: { test: "npm test", tset: 1 }\nbogus: true\n')
    const res = loadConfig(repo.root)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.schema).toBe(1)
    expect(res.value).not.toHaveProperty('raw')
    expect(res.value.ship.test).toBe('npm test')
    expect(res.value.warning).toMatch(/^schema 1 is older than this witness \(2\) — witness migrate adds/)
  })

  it('refuses a newer schema and warns on an older one', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 3\n')
    const newer = loadConfig(repo.root)
    expect(!newer.ok && newer.violations[0]?.rule).toBe('newer-than-cli')
    expect(!newer.ok && newer.violations[0]?.want).toContain('upgrade witness')
    repo.write('witness.config.yaml', 'schema: 1\n')
    const older = loadConfig(repo.root)
    expect(older.ok && older.value.warning).toContain('witness migrate')
  })

  it('refuses yaml errors and a missing schema key', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: [unclosed\n')
    expect(loadConfig(repo.root).ok).toBe(false)
    repo.write('witness.config.yaml', 'ship: {}\n')
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.rule).toBe('required')
  })
})

describe('resolveDocs (docs registry)', () => {
  it('absent docs key → empty registry', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.docs).toEqual({})
  })

  it('accepts enumerated keys and exposes them on Config', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\ndocs:\n  conventions: [docs/code/architecture.md, CLAUDE.md]\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.docs.conventions).toEqual(['docs/code/architecture.md', 'CLAUDE.md'])
  })

  it('refuses a key with no shipped consumer', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\ndocs:\n  security: [docs/threat-model.md]\n')
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.rule).toBe('unknown-doc-key')
    expect(!res.ok && res.violations[0]?.want).toContain('conventions')
  })

  it('accepts empty lists as none; refuses non-lists, traversal and .witness paths', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\ndocs:\n  conventions: []\n')
    const none = loadConfig(repo.root)
    expect(none.ok && none.value.docs).toEqual({})
    repo.write('witness.config.yaml', 'schema: 1\ndocs:\n  conventions: CLAUDE.md\n')
    expect(loadConfig(repo.root).ok).toBe(false)
    repo.write('witness.config.yaml', 'schema: 1\ndocs:\n  conventions: [../escape.md]\n')
    expect(loadConfig(repo.root).ok).toBe(false)
    repo.write('witness.config.yaml', 'schema: 1\ndocs:\n  conventions: [.witness/journal/x.md]\n')
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.rule).toBe('reserved')
  })
})

describe('paths.designs (design stage)', () => {
  it('defaults designs to "designs"', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.paths.designs).toBe('designs')
  })

  it('accepts a custom designs dir', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\npaths:\n  designs: docs/designs\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.paths.designs).toBe('docs/designs')
  })

  it('refuses designs overlapping or nested with specs/plans', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\npaths:\n  specs: designs\n  designs: designs\n')
    expect(loadConfig(repo.root).ok).toBe(false)
    repo.write('witness.config.yaml', 'schema: 1\npaths:\n  designs: specs/looks\n')
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.rule).toBe('nested')
  })

  it('refuses .witness and traversal for designs', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\npaths:\n  designs: .witness/looks\n')
    expect(!loadConfig(repo.root).ok).toBe(true)
  })
})

describe('DOC_KEYS (design consumer shipped)', () => {
  it('accepts the design key now that the design gate consumes it', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\ndocs:\n  design: [docs/ui/design-language.md]\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.docs.design).toEqual(['docs/ui/design-language.md'])
  })
})

describe('resolveImplement (implement.stepsPerDispatch)', () => {
  it('defaults to 3 when the key or section is absent', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.implement.stepsPerDispatch).toBe(3)
  })

  it('accepts a valid integer override', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\nimplement:\n  stepsPerDispatch: 5\n')
    const res = loadConfig(repo.root)
    expect(res.ok && res.value.implement.stepsPerDispatch).toBe(5)
  })

  it('refuses zero, negatives, non-integers and strings', () => {
    for (const bad of ['0', '-2', '2.5', '"three"']) {
      const repo = tmpRepo()
      repo.write('witness.config.yaml', `schema: 1\nimplement:\n  stepsPerDispatch: ${bad}\n`)
      const res = loadConfig(repo.root)
      expect(res.ok, `expected refusal for ${bad}`).toBe(false)
      expect(!res.ok && res.violations[0]?.field).toBe('implement.stepsPerDispatch')
      expect(!res.ok && res.violations[0]?.want).toContain('integer >= 1')
    }
  })

  it('refuses a non-map implement section', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\nimplement: nope\n')
    const res = loadConfig(repo.root)
    expect(!res.ok && res.violations[0]?.field).toBe('implement')
  })
})

describe('session.contextLimit (row 191)', () => {
  it('defaults to 20 when session or the key is absent', () => {
    expect(resolveSession({})).toMatchObject({ ok: true, value: { contextLimit: 20 } })
    expect(resolveSession({ session: {} })).toMatchObject({ ok: true, value: { contextLimit: 20 } })
  })
  it('accepts the bounds', () => {
    expect(resolveSession({ session: { contextLimit: 1 } })).toMatchObject({ ok: true, value: { contextLimit: 1 } })
    expect(resolveSession({ session: { contextLimit: 100 } })).toMatchObject({ ok: true, value: { contextLimit: 100 } })
  })
  it.each([0, 101, 20.5, '20', null, -5])('refuses contextLimit %j', (bad) => {
    const r = resolveSession({ session: { contextLimit: bad } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.violations[0]).toMatchObject({
      field: 'session.contextLimit', rule: 'invalid',
      want: "an integer from 1 to 100 — % of the session's context window at which witness hands over to a fresh session",
    })
  })
  // A bare `session:` in YAML is null, so it refuses too.
  it.each([[20], [null], [[]], ['on']])('refuses a session value that is not a map: %j', (bad) => {
    const r = resolveSession({ session: bad })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.violations[0]).toMatchObject({ field: 'session', rule: 'invalid', want: 'a map of session settings' })
  })
  it('ignores a key it does not know under session', () => {
    expect(resolveSession({ session: { contextLimit: 15, bogus: 1 } })).toMatchObject({ ok: true, value: { contextLimit: 15 } })
    expect(resolveSession({ session: { bogus: 1 } })).toMatchObject({ ok: true, value: { contextLimit: 20 } })
  })
  it('loadConfig carries the value, and a bad one refuses the whole config', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\nsession:\n  contextLimit: 15\n')
    const good = loadConfig(repo.root)
    expect(good.ok && good.value.session.contextLimit).toBe(15)
    repo.write('witness.config.yaml', 'schema: 1\nsession:\n  contextLimit: 0\n')
    const bad = loadConfig(repo.root)
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.violations[0]?.field).toBe('session.contextLimit')
  })
})

describe('gates.reviewerTimeoutMs', () => {
  const load = (yaml: string) => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', `schema: 1\n${yaml}`)
    return loadConfig(repo.root)
  }

  it('defaults when absent', () => {
    const r = load('')
    expect(r.ok && r.value.gates.reviewerTimeoutMs).toBe(DEFAULT_REVIEWER_TIMEOUT_MS)
    const r2 = load('gates: { model: claude-fable-5 }\n')
    expect(r2.ok && r2.value.gates.reviewerTimeoutMs).toBe(DEFAULT_REVIEWER_TIMEOUT_MS)
  })

  it('accepts an integer >= 1', () => {
    const r = load('gates: { reviewerTimeoutMs: 120000 }\n')
    expect(r.ok && r.value.gates.reviewerTimeoutMs).toBe(120000)
  })

  it('refuses non-integer values', () => {
    for (const bad of ['"600000"', '0', '-1', '1.5']) {
      const r = load(`gates: { reviewerTimeoutMs: ${bad} }\n`)
      expect(!r.ok && r.violations[0]).toMatchObject({ field: 'gates.reviewerTimeoutMs', rule: 'invalid' })
    }
  })
})

describe('loadLocalConfig — .witness/config.local.yaml', () => {
  const scratch = () => mkdtempSync(join(tmpdir(), 'witness-local-'))
  const put = (root: string, yaml: string) => {
    mkdirSync(join(root, '.witness'), { recursive: true })
    writeFileSync(localConfigPath(root), yaml)
  }

  it('missing file is all defaults', () => {
    const r = loadLocalConfig(scratch())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ reviewerExtensions: [] })
  })

  it('loads reviewerExtensions and opener', () => {
    const root = scratch()
    put(root, "reviewerExtensions: ['/a/ext', '/b/ext']\nopener: my-open\n")
    const r = loadLocalConfig(root)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ reviewerExtensions: ['/a/ext', '/b/ext'], opener: 'my-open' })
  })

  it('refuses unknown keys — closed set', () => {
    const root = scratch()
    put(root, 'harness: pi\n')
    const r = loadLocalConfig(root)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]).toMatchObject({ rule: 'unknown-local-key', got: 'harness' })
  })

  it('refuses wrong types and unparseable yaml', () => {
    const root = scratch()
    put(root, 'reviewerExtensions: nope\n')
    const r = loadLocalConfig(root)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]).toMatchObject({ field: 'reviewerExtensions', rule: 'invalid' })
    put(root, 'opener: [1, 2\n')
    expect(loadLocalConfig(root).ok).toBe(false)
  })
})

describe('autonomy (A1)', () => {
  it('is off unless the repo says on', () => {
    const repo = tmpRepo()
    for (const [line, want] of [['', false], ['autonomy: on\n', true], ['autonomy: off\n', false]] as const) {
      repo.write('witness.config.yaml', `schema: 1\n${line}`)
      repo.git('add', 'witness.config.yaml'); repo.git('commit', '--allow-empty', '-m', `config ${line.trim() || 'none'}`)
      const r = loadConfig(repo.root)
      expect(r.ok && r.value.autonomy).toBe(want)
    }
  })
  it('is on only once committed — a working-copy edit grants nothing (F11)', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\n')
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'config')
    repo.write('witness.config.yaml', 'schema: 1\nautonomy: on\n')
    const r = loadConfig(repo.root)
    expect(r.ok && r.value.autonomy).toBe(false)
    expect(r.ok && r.value.warning).toContain('autonomy: on is not committed')
  })
  it('refuses anything but on or off', () => {
    const repo = tmpRepo()
    for (const bad of ['true', 'yes', '1', '""']) {
      repo.write('witness.config.yaml', `schema: 1\nautonomy: ${bad}\n`)
      const r = loadConfig(repo.root)
      expect(!r.ok && r.violations[0]).toMatchObject({ field: 'autonomy', rule: 'invalid', want: 'on | off' })
    }
    // An empty value is unset (final review I1) — off, as the hook-side autonomyAt reads it too.
    repo.write('witness.config.yaml', 'schema: 1\nautonomy: ~\n')
    const empty = loadConfig(repo.root)
    expect(empty.ok && empty.value.autonomy).toBe(false)
  })
})

describe('ship.merge (A7)', () => {
  it('defaults to merge and loads squash and rebase', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\n')
    const d = loadConfig(repo.root)
    expect(d.ok && d.value.ship.merge).toBe('merge')
    for (const style of ['squash', 'rebase']) {
      repo.write('witness.config.yaml', `schema: 1\nship:\n  merge: ${style}\n`)
      const r = loadConfig(repo.root)
      expect(r.ok && r.value.ship.merge).toBe(style)
    }
  })
  it('refuses any other style', () => {
    const repo = tmpRepo()
    repo.write('witness.config.yaml', 'schema: 1\nship:\n  merge: fast-forward\n')
    const r = loadConfig(repo.root)
    expect(!r.ok && r.violations[0]).toMatchObject({ field: 'ship.merge', rule: 'invalid', want: 'merge | squash | rebase' })
  })
})

describe('ship.ciSettleMs (row 174)', () => {
  it('refuses a settle window outside 0 and the 30-minute watch', () => {
    const repo = tmpRepo()
    for (const bad of ['-1', '1800001', '2147483648', '1.5']) {
      repo.write('witness.config.yaml', `schema: 1\nship:\n  ciSettleMs: ${bad}\n`)
      const r = loadConfig(repo.root)
      expect(!r.ok && r.violations[0]).toMatchObject({ field: 'ship.ciSettleMs', rule: 'invalid' })
    }
    repo.write('witness.config.yaml', 'schema: 1\nship:\n  ciSettleMs: 1800000\n')
    expect(loadConfig(repo.root).ok).toBe(true)
  })
})

describe('drive settings (B3 · B5)', () => {
  const withDrive = async (yaml: string) => {
    const repo = await seededRepo()
    patchConfig(repo, parse(`drive:\n${yaml}`) as Record<string, unknown>)
    return loadConfig(repo.root)
  }

  it('defaults parallel to 2 and the caps to the B5 calibration', async () => {
    const cfg = loadConfig((await seededRepo()).root)
    expect(cfg.ok && cfg.value.drive).toEqual({
      sessionTimeoutMs: 3_600_000, parallel: 2, parallelSuites: false,
      caps: { rounds: 16, upstream: 6, spawns: 24, wallClockMs: 57_600_000 },
    })
  })

  it('reads parallel and a partial caps map over the defaults', async () => {
    const cfg = await withDrive('  parallel: 3\n  caps:\n    rounds: 20\n')
    expect(cfg.ok && cfg.value.drive.parallel).toBe(3)
    expect(cfg.ok && cfg.value.drive.caps).toEqual({ rounds: 20, upstream: 6, spawns: 24, wallClockMs: 57_600_000 })
  })

  it.each([
    ['  parallel: 0\n', 'drive.parallel', 'invalid'],
    ['  caps:\n    spawns: 1.5\n', 'drive.caps.spawns', 'invalid'],
    ['  caps: 3\n', 'drive.caps', 'invalid'],
    ['  caps:\n    round: 9\n', 'drive.caps.round', 'unknown-drive-key'],
    ['  paralel: 2\n', 'drive.paralel', 'unknown-drive-key'],
    ['  parallelSuites: yes\n', 'drive.parallelSuites', 'invalid'],
  ])('refuses %j', async (yaml, field, rule) => {
    const cfg = await withDrive(yaml)
    expect(!cfg.ok && [cfg.violations[0]!.field, cfg.violations[0]!.rule]).toEqual([field, rule])
  })
})

describe('machine-local notify (B6)', () => {
  it('reads notify and refuses an empty one', async () => {
    const repo = await seededRepo()
    writeLocalConfig(repo.root, { notify: '/usr/local/bin/ping-me' })
    const ok = loadLocalConfig(repo.root)
    expect(ok.ok && ok.value.notify).toBe('/usr/local/bin/ping-me')
    repo.write('.witness/config.local.yaml', "notify: ''\n")
    const bad = loadLocalConfig(repo.root)
    expect(!bad.ok && [bad.violations[0]!.field, bad.violations[0]!.rule]).toEqual(['notify', 'invalid'])
  })
})
