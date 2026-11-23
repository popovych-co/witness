import { describe, expect, it } from 'vitest'
import { baseLintKey, baseLintKind, BASE_LINT, MAX_BASE_KEYS } from '../src/base-lint.js'
import { loadConfig, type Config } from '../src/config.js'
import { boundReader } from '../src/lint-parts.js'
import { appendEntry } from '../src/journal.js'
import { loadCanon } from '../src/scan.js'
import { approve, fakeCtx, fakeLint, fixtureEnv, patchConfig, seededRepo, writePlan, writeSpec, type TestRepo } from './helpers.js'

const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }
const commitAll = (repo: TestRepo, m: string) => { repo.git('add', '-A'); repo.git('commit', '-q', '-m', m) }
const gateRun = (gate: string, parts: unknown[]) => ({
  v: 1, t: 'gate-run' as const, gate, round: 1, checks: [{ name: 'lint', ok: false, parts }],
})
async function lintRepo(reader: 'sarif' | 'garbage' | 'many' | undefined, bad: Record<string, string>) {
  const repo = await seededRepo()
  const cmd = fakeLint(repo)
  patchConfig(repo, { ship: { lint: { biome: cmd.check, ui: cmd.check } }, ...(reader ? { readers: { biome: cmd[reader] } } : {}) })
  for (const [f, text] of Object.entries(bad)) repo.write(f, text)
  commitAll(repo, 'base')
  const cfg = cfgOf(repo.root)
  const key = (name: string) => {
    const part = cfg.ship.lint!.find((p) => p.name === name)!
    return baseLintKey(part, boundReader(cfg, part)?.cmd, repo.git('rev-parse', 'HEAD'))
  }
  const run = (k: string) => baseLintKind.run(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), cfg, { kind: BASE_LINT, key: k, shards: 1 }, 1)
  return { repo, cfg, key, run }
}

describe('the base-lint job (row 263)', () => {
  it("owes exactly the keys a plan's last implement and ship gate-runs left pending", async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'p1')                     // PLAN_META's parent is auth-refresh
    repo.flipStatus('p1', 'in-progress')
    patchConfig(repo, { ship: { lint: { biome: 'b', types: 't' } } })
    const cfg = cfgOf(repo.root)
    // keys the config as it stands gives (slice 3 review I3: one it no longer gives is never owed)
    const k1 = baseLintKey(cfg.ship.lint![0]!, undefined, 'a'.repeat(40))
    const k2 = baseLintKey(cfg.ship.lint![1]!, undefined, 'c'.repeat(40))
    appendEntry(repo.root, 'p1', gateRun('ship', [{ part: 'biome', state: 'pending', key: k2 }]))
    appendEntry(repo.root, 'p1', gateRun('ship', [{ part: 'biome', state: 'pending', key: k1 }, { part: 'ui', state: 'red', key: k2 }]))
    appendEntry(repo.root, 'p1', gateRun('implement', [{ part: 'biome', state: 'pending', key: k1 }, { part: 'x', state: 'pending', key: 'not a key' }]))
    expect(baseLintKind.owed(repo.root, cfgOf(repo.root), loadCanon(repo.root))).toEqual([{ kind: BASE_LINT, key: k1, shards: 1 }])
    repo.flipStatus('p1', 'done')
    expect(baseLintKind.owed(repo.root, cfgOf(repo.root), loadCanon(repo.root))).toEqual([])
  })

  it("a chat-mode round's not-measured key is owed too, so a drive started later lints it (final review I2)", async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'p1')
    repo.flipStatus('p1', 'in-progress')
    patchConfig(repo, { ship: { lint: { biome: 'b' } } })
    const key = baseLintKey(cfgOf(repo.root).ship.lint![0]!, undefined, 'a'.repeat(40))
    appendEntry(repo.root, 'p1', gateRun('ship', [{ part: 'biome', state: 'not-measured', key, why: 'no drive runs jobs in this repo' }]))
    expect(baseLintKind.owed(repo.root, cfgOf(repo.root), loadCanon(repo.root))).toEqual([{ kind: BASE_LINT, key, shards: 1 }])
  })

  it('a pending key the config no longer gives is never owed, so it is never struck (slice 3 review I3)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'p1')
    repo.flipStatus('p1', 'in-progress')
    patchConfig(repo, { ship: { lint: { biome: 'b' } } })
    const old = baseLintKey(cfgOf(repo.root).ship.lint![0]!, undefined, 'a'.repeat(40))
    appendEntry(repo.root, 'p1', gateRun('ship', [{ part: 'biome', state: 'pending', key: old }]))
    expect(baseLintKind.owed(repo.root, cfgOf(repo.root), loadCanon(repo.root))).toEqual([{ kind: BASE_LINT, key: old, shards: 1 }])
    patchConfig(repo, { ship: { lint: { biome: 'b2' } } })
    expect(baseLintKind.owed(repo.root, cfgOf(repo.root), loadCanon(repo.root))).toEqual([])
    patchConfig(repo, { ship: { lint: { other: 'b' } } })
    expect(baseLintKind.owed(repo.root, cfgOf(repo.root), loadCanon(repo.root))).toEqual([])
  })

  it("lints the base commit in the scratch and keys its diagnostics; an opaque part says only red", async () => {
    const { key, run } = await lintRepo('sarif', { 'src/old.ts': 'BAD one\nfine\nBAD two\n' })
    const r = run(key('biome'))
    expect(r).toMatchObject({ outcome: 'done', result: { exit: 1, read: { total: 2 } } })
    expect(Object.values((r as { result: { read: { keys: Record<string, number> } } }).result.read.keys)).toEqual([1, 1])
    const ui = run(key('ui'))
    expect(ui).toMatchObject({ outcome: 'done', result: { exit: 1 } })
    expect((ui as { result: object }).result).not.toHaveProperty('read')
  }, 60_000)

  it('a green base is exit 0', async () => {
    const { key, run } = await lintRepo('sarif', { 'src/ok.ts': 'fine\n' })
    expect(run(key('biome'))).toMatchObject({ outcome: 'done', result: { exit: 0 } })
  }, 60_000)

  it('a key whose part changed since its gate asked refuses (Review Focus 4)', async () => {
    const { key, run } = await lintRepo('sarif', { 'src/old.ts': 'BAD\n' })
    const stale = key('biome').replace(/\.[0-9a-f]{12}$/, '.000000000000')
    expect(run(stale)).toEqual({ outcome: 'failed', why: 'the part changed since its gate asked — the next gate asks again' })
  }, 60_000)

  it('more diagnostics than one result holds read unread, never a truncated multiset (Review Focus 3)', async () => {
    const { key, run } = await lintRepo('many', { 'src/many.ts': 'BAD\n' })   // the part is red, so its reader runs
    const r = run(key('biome')) as { outcome: string; result: Record<string, unknown> }
    expect(r).toMatchObject({ outcome: 'done', result: { exit: 1, unread: `${MAX_BASE_KEYS + 1} distinct diagnostics on the base — more than one result holds` } })
    expect(r.result).not.toHaveProperty('read')
  }, 60_000)

  it('a report it cannot read is unread, never a red (settled point 7)', async () => {
    const { key, run } = await lintRepo('garbage', { 'src/old.ts': 'BAD\n' })
    expect(run(key('biome'))).toMatchObject({ outcome: 'done', result: { exit: 1, unread: expect.stringMatching(/^reader-unread: /) } })
  }, 60_000)
})
