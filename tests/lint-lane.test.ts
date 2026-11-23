import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { grantCommands } from '../src/allowlist.js'
import { BASE_LINT, baseLintKey, baseLintKind } from '../src/base-lint.js'
import { loadConfig, type Config } from '../src/config.js'
import { acquireDriveLock } from '../src/drive-presence.js'
import { journalShard } from '../src/jobs.js'
import { lintCheck } from '../src/lint-lane.js'
import { boundReader } from '../src/lint-parts.js'
import { fakeCtx, fakeLint, fakeScenario, fixtureEnv, patchConfig, seededRepo } from './helpers.js'

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

// The base holds src/old.ts with one BAD line; the plan's tree is the root's working tree.
async function baseRed(reader: 'sarif' | 'garbage' = 'sarif') {
  const repo = await seededRepo()
  const cmd = fakeLint(repo)
  patchConfig(repo, { ship: { lint: { biome: cmd.check, ui: cmd.check } }, readers: { biome: cmd[reader] } })
  repo.write('src/old.ts', 'BAD\n')
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'base')
  const base = repo.git('rev-parse', 'HEAD')
  const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
  const keyOf = (name: string) => {
    const cfg = cfgOf(repo.root)
    const part = cfg.ship.lint!.find((p) => p.name === name)!
    return baseLintKey(part, boundReader(cfg, part)?.cmd, base)
  }
  // drive's job, run here in-process, and its shard journaled as drive journals it
  const lintBase = (name: string) => {
    const key = keyOf(name)
    const r = baseLintKind.run(repo.root, ctx, cfgOf(repo.root), { kind: BASE_LINT, key, shards: 1 }, 1)
    if (r.outcome !== 'done') throw new Error(r.why)
    journalShard(repo.root, { kind: BASE_LINT, key, shard: 1, of: 1, outcome: 'done', ms: 1, result: r.result })
    return key
  }
  const check = () => lintCheck(repo.root, repo.root, ctx, cfgOf(repo.root), base)
  return { repo, base, keyOf, lintBase, check }
}

describe('a part red on the base too is judged per diagnostic (row 263)', () => {
  it("reports only the plan's new diagnostics (map acceptance)", async () => {
    const { repo, lintBase, check } = await baseRed()
    const key = lintBase('biome')
    repo.write('src/new.ts', 'BAD\n')
    const c = await check()
    expect(c.parts![0]).toEqual({ part: 'biome', state: 'new', key, new: 1, base: 1, rules: ['lint/test/noBad'] })
    expect(c.detail).toContain("biome: red — 1 new beside the base's 1: src/new.ts:1 lint/test/noBad")
    expect(c.detail).not.toContain('src/old.ts')
    expect(c.ok).toBe(false)
  }, 60_000)

  it('nothing new on a red base passes that part (row 263)', async () => {
    const { repo, lintBase, check } = await baseRed()
    lintBase('biome')
    repo.write('src/fine.ts', 'fine\n')
    const c = await check()
    expect(c.parts![0]).toMatchObject({ part: 'biome', state: 'base-only', base: 1 })
    expect(c.detail).toContain('biome: ok — red on the base too, nothing new (1 there)')
  }, 60_000)

  it('an opaque part red on the base too never reads green (map acceptance)', async () => {
    const { lintBase, check } = await baseRed()
    lintBase('ui')
    const c = await check()
    expect(c.parts![1]).toMatchObject({ part: 'ui', state: 'not-judged', why: 'red on the base too — no reader for this part' })
    expect(c.ok).toBe(false)
  }, 60_000)

  it("a malformed Biome report fails closed, the base's or this tree's (map acceptance)", async () => {
    const unreadBase = await baseRed('garbage')
    unreadBase.lintBase('biome')
    const a = await unreadBase.check()
    expect(a.parts![0]).toMatchObject({ state: 'not-judged', why: expect.stringMatching(/^red on the base too — its diagnostics could not be read: reader-unread: /) })
    expect(a.ok).toBe(false)
    const unreadHere = await baseRed()
    unreadHere.lintBase('biome')
    // this tree only: the base ran the committed tool, so the key and the base's result stand
    unreadHere.repo.write('fake-lint.mjs', "process.stdout.write('not a report'); process.exit(1)\n")
    const b = await unreadHere.check()
    expect(b.parts![0]).toMatchObject({ state: 'not-judged', why: expect.stringMatching(/^red on the base too — this tree's diagnostics could not be read: reader-unread: /) })
    expect(b.ok).toBe(false)
  }, 120_000)

  it("a green base makes the red the plan's (row 263)", async () => {
    const { repo, base, keyOf, check } = await baseRed()
    const key = keyOf('biome')
    journalShard(repo.root, { kind: BASE_LINT, key, shard: 1, of: 1, outcome: 'done', ms: 1, result: { exit: 0, tree: repo.git('rev-parse', 'HEAD^{tree}'), commit: base } })
    expect((await check()).parts![0]).toEqual({ part: 'biome', state: 'red', key })
  }, 60_000)

  it('a missing base result is not measured with no drive and pending under one, its key on the verdict (row 263)', async () => {
    const { repo, keyOf, check } = await baseRed()
    expect((await check()).parts![0]).toEqual({ part: 'biome', state: 'not-measured', key: keyOf('biome'), why: 'no drive runs jobs in this repo' })
    const held = acquireDriveLock(repo.root, {})
    expect(held.ok).toBe(true)
    try {
      const c = await check()
      expect(c.parts![0]).toEqual({ part: 'biome', state: 'pending', key: keyOf('biome') })
      expect(c.detail).toContain("biome: red — the base's result is pending: drive lints the base, then run the gate again")
    } finally {
      if (held.ok) held.value()
    }
  }, 60_000)

  it("a red part whose reader reports no error on this tree is not judged, never base-only (slice 2 review M8)", async () => {
    const { repo, lintBase, check } = await baseRed()
    lintBase('biome')
    // this tree: the part still red, its reader now finds nothing
    repo.write('fake-lint.mjs', "process.stdout.write(process.argv[2] === 'sarif' ? JSON.stringify({ runs: [{ results: [] }] }) : ''); process.exitCode = process.argv[2] === 'sarif' ? 0 : 1\n")
    const c = await check()
    expect(c.parts![0]).toMatchObject({ part: 'biome', state: 'not-judged', why: "red on the base too — this tree's reader reported no error while the part is red" })
    expect(c.ok).toBe(false)
  }, 60_000)

  it("a red part that waits on the base still shows its own output (row 263)", async () => {
    const { repo, check } = await baseRed()
    repo.write('src/new.ts', 'BAD\n')
    const c = await check()
    expect(c.detail).toMatch(/^biome: red — the base is not measured: no drive runs jobs in this repo — /)
  }, 60_000)
})

describe('a part red on the base too — slice 3 review (row 263)', () => {
  it("a part red only from witness's own paths reads base-only, never not-judged (I2)", async () => {
    const { repo, lintBase, check } = await baseRed()
    lintBase('biome')
    // this tree: the part red, its reader's only error on witness's own payload
    repo.write('fake-lint.mjs', "const r = { ruleId: 'lint/x', level: 'error', locations: [{ physicalLocation: { artifactLocation: { uri: process.cwd() + '/.witness/hooks/canon-guard.mjs' }, region: { startLine: 1 } } }] }\n"
      + "if (process.argv[2] === 'sarif') process.stdout.write(JSON.stringify({ runs: [{ results: [r] }] }))\nprocess.exitCode = 1\n")
    const c = await check()
    expect(c.parts![0]).toMatchObject({ part: 'biome', state: 'base-only', base: 1 })
  }, 60_000)
})
