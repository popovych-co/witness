import { describe, expect, it } from 'vitest'
import { foldOverlay, pinTree } from '../src/cf-tree.js'
import { loadConfig, type Config } from '../src/config.js'
import { loosenedKey } from '../src/diagnostics.js'
import { isJobKey, jobKinds } from '../src/jobs.js'
import { appendEntry } from '../src/journal.js'
import {
  EFFECT_RESULT_BYTES, LINT_EFFECT, LINT_EFFECT_BOX_MS, MAX_HIT_FILE, effectCommands, fitResult, lintEffectKey, lintEffectKind,
  lintEffectResult, parseLintEffectKey, type LintEffectResult,
} from '../src/lint-effect.js'
import type { Result } from '../src/refusal.js'
import { loadCanon } from '../src/scan.js'
import { approve, fakeCtx, fakeLint, fixtureEnv, patchConfig, seededRepo, writePlan, writeSpec, type TestRepo } from './helpers.js'

const cfgOf = (root: string): Config => { const r = loadConfig(root); if (!r.ok) throw new Error('config'); return r.value }
const value = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.violations)); return r.value }
const commitAll = (repo: TestRepo, m: string, force: string[] = []) => {
  repo.git('add', '-A')
  if (force.length) repo.git('add', '-f', '--', ...force)
  repo.git('commit', '-q', '-m', m)
  return repo.git('rev-parse', 'HEAD')
}
const HIDDEN = 'export const x = "BAD"\n'
// Writes `gen.mjs`: a build step that writes src/gen.ts (holding BAD, never tracked) only where the
// tree's .gitignore does not hide src/hidden.ts — the effect tree's side alone.
const GEN = `import { readFileSync, writeFileSync } from 'node:fs'
if (!readFileSync('.gitignore', 'utf8').includes('src/hidden.ts')) writeFileSync('src/gen.ts', 'BAD generated\\n')
`

interface Setup {
  lint?: (cmd: ReturnType<typeof fakeLint>) => Record<string, string>
  reader?: boolean
  base?: Record<string, string>
  plan: Record<string, string>
  force?: string[]
  restore: string[]
}
// A seeded repo with the fake lint as the part named biome and its SARIF reader; the base commit, then
// the plan's commit (P) and the effect tree (E: P with `restore` taken from the base), both pinned.
async function effectRepo(s: Setup) {
  const repo = await seededRepo()
  const cmd = fakeLint(repo)
  patchConfig(repo, {
    scratch: { prepare: 'none' }, ship: { lint: s.lint?.(cmd) ?? { biome: cmd.check } },
    ...(s.reader === false ? {} : { readers: { biome: cmd.sarif } }),
  })
  repo.write('src/a.ts', 'fine\n')
  for (const [f, text] of Object.entries(s.base ?? {})) repo.write(f, text)
  const base = commitAll(repo, 'base')
  for (const [f, text] of Object.entries(s.plan)) repo.write(f, text === '.gitignore+' ? `${repo.read('.gitignore')}src/hidden.ts\n` : text)
  const plan = commitAll(repo, 'plan', s.force ?? [])
  const effectTree = value(foldOverlay(repo.root, plan, { from: base, paths: s.restore }))
  const P = value(pinTree(repo.root, 'p1', repo.git('rev-parse', `${plan}^{tree}`)))
  const E = value(pinTree(repo.root, 'p1', effectTree))
  const cfg = cfgOf(repo.root)
  const key = lintEffectKey(cfg, P, E)
  const run = (k = key, env: Record<string, string> = fixtureEnv(), c: Config = cfg) =>
    lintEffectKind.run(repo.root, fakeCtx(repo.root, { env }), c, { kind: LINT_EFFECT, key: k, shards: 1 }, 1)
  const result = (k = key): LintEffectResult => {
    const r = run(k)
    if (r.outcome !== 'done') throw new Error(`job failed: ${r.why}`)
    const parsed = lintEffectResult(r.result)
    if (parsed === undefined) throw new Error(`malformed: ${JSON.stringify(r.result)}`)
    return parsed
  }
  return { repo, cfg, cmd, P, E, key, run, result }
}
// The gitignore-hiding plan: a tracked src/hidden.ts the plan's .gitignore lists.
const HIDING = { plan: { 'src/hidden.ts': HIDDEN, '.gitignore': '.gitignore+' }, force: ['src/hidden.ts'], restore: ['.gitignore'] }

describe('the lint-effect job (row 277)', () => {
  it('.gitignore hiding a tracked file: its diagnostic is a hit, and the part reads green then red (row 277)', async () => {
    const { result } = await effectRepo(HIDING)
    const r = result()
    expect(r.hits).toEqual([{
      tool: 'biome', rule: 'lint/test/noBad', file: 'src/hidden.ts', line: 1, count: 1,
      key: loosenedKey({ tool: 'biome', rule: 'lint/test/noBad', file: 'src/hidden.ts', snippet: 'export const x = "BAD"' }),
    }])
    expect(r.parts).toEqual([{ part: 'biome', plan: 0, effect: 1 }])
    expect(r.readers).toEqual([{ tool: 'biome' }])
    expect(r.over).toBeUndefined()
  }, 60_000)

  it("a diagnostic both trees report is never a hit: the effect's count beyond the plan's, per key (slice 2 review I1)", async () => {
    const { result } = await effectRepo({ ...HIDING, base: { 'src/old.ts': 'const BAD = 1\n' }, plan: { ...HIDING.plan, 'src/hidden.ts': 'const BAD = 1\n' } })
    expect(result().hits.map((h) => [h.file, h.line, h.count])).toEqual([['src/hidden.ts', 1, 1]])
  }, 60_000)

  it('a diagnostic on a definition file the effect restored is never a hit (row 277)', async () => {
    const { result } = await effectRepo({ base: { 'src/conf.ts': 'BAD conf\n' }, plan: { 'src/conf.ts': 'fine conf\n' }, restore: ['src/conf.ts'] })
    const r = result()
    expect(r.hits).toEqual([])
    expect(r.parts).toEqual([{ part: 'biome', plan: 0, effect: 1 }])
  }, 60_000)

  it('a file a part writes that the tree does not track is never a hit (Review Focus 4)', async () => {
    const { result } = await effectRepo({ ...HIDING, base: { 'gen.mjs': GEN }, lint: (cmd) => ({ biome: `node gen.mjs && ${cmd.check}` }) })
    expect(result().hits.map((h) => h.file)).toEqual(['src/hidden.ts'])
  }, 60_000)

  it('a reader unread on the effect tree gives no hit and says why (Review Focus 5)', async () => {
    const { result } = await effectRepo({
      base: { 'fake-lint.json': '{"report": "garbage"}\n' }, plan: { ...HIDING.plan, 'fake-lint.json': '{}\n' }, force: HIDING.force,
      restore: ['.gitignore', 'fake-lint.json'],
    })
    const r = result()
    expect(r.readers).toEqual([{ tool: 'biome', unread: expect.stringContaining('reader-unread') }])
    expect(r.hits).toEqual([])
    expect(r.parts).toEqual([{ part: 'biome', plan: 0, effect: 1 }])
  }, 60_000)

  it('every set reader is an instrument, bound or not (C34)', async () => {
    const { result, cfg } = await effectRepo({ ...HIDING, lint: (cmd) => ({ lint: cmd.check }) })
    const r = result()
    expect(r.hits.map((h) => [h.tool, h.file])).toEqual([['biome', 'src/hidden.ts']])
    expect(r.parts).toEqual([{ part: 'lint', plan: 0, effect: 1 }])
    expect(effectCommands(cfg).map((c) => c.source)).toEqual(['ship.lint.lint', 'readers.biome'])
  }, 60_000)

  it('past the result size the hits stop, and over counts the rest (row 277)', async () => {
    const many = Array.from({ length: 400 }, (_, i) => `export const x${i} = "BAD ${i}"`).join('\n')
    const { run } = await effectRepo({ ...HIDING, plan: { ...HIDING.plan, 'src/hidden.ts': `${many}\n` } })
    const r = run()
    expect(r.outcome).toBe('done')
    const res = lintEffectResult((r as { result: unknown }).result)!
    expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThanOrEqual(EFFECT_RESULT_BYTES)
    expect(res.hits.length).toBeGreaterThan(100)
    expect(res.over).toBeGreaterThan(0)
    expect(res.hits.length + res.over!).toBe(400)
    expect(res.hits.map((h) => h.line)).toEqual(Array.from({ length: res.hits.length }, (_, i) => i + 1))
  }, 60_000)

  it('a key whose commands changed, a commit that is gone, or an untrusted reader fails the shard, never a hit (row 277)', async () => {
    const { run, cfg, P, E } = await effectRepo(HIDING)
    const stale = lintEffectKey({ ...cfg, readers: { ...cfg.readers, biome: 'node other.mjs' } }, P, E)
    expect(run(stale)).toEqual({ outcome: 'failed', why: 'the lint commands changed since its gate asked — the next gate asks again' })
    expect(run(lintEffectKey(cfg, 'f'.repeat(40), E))).toEqual({ outcome: 'failed', why: 'a tree its gate pinned is gone' })
    expect(run(undefined, { ...fixtureEnv(), WITNESS_TRUST_CMDS: '' })).toEqual({ outcome: 'failed', why: expect.stringMatching(/^untrusted: /) })
  }, 60_000)

  it("owes exactly the keys a plan's last implement and ship runs left on their definitions check, under today's commands (row 277)", async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'p1')
    repo.flipStatus('p1', 'in-progress')
    patchConfig(repo, { ship: { lint: { biome: 'b' } }, readers: { biome: 'r' } })
    const cfg = cfgOf(repo.root)
    const k1 = lintEffectKey(cfg, 'a'.repeat(40), 'b'.repeat(40))
    const k2 = lintEffectKey(cfg, 'c'.repeat(40), 'd'.repeat(40))
    const stale = lintEffectKey({ ...cfg, readers: { biome: 'r2' } }, 'a'.repeat(40), 'b'.repeat(40))
    const gateRun = (gate: string, checks: unknown[]) => ({ v: 1, t: 'gate-run' as const, gate, round: 1, checks })
    appendEntry(repo.root, 'p1', gateRun('ship', [{ name: 'definitions', ok: false, owes: [{ kind: LINT_EFFECT, key: k2 }] }]))
    appendEntry(repo.root, 'p1', gateRun('ship', [
      { name: 'definitions', ok: false, owes: [{ kind: LINT_EFFECT, key: k1 }, { kind: LINT_EFFECT, key: stale }, { kind: 'base-tests', key: k1 }] },
      { name: 'switch-offs', ok: false, owes: [{ kind: LINT_EFFECT, key: k2 }] },
    ]))
    appendEntry(repo.root, 'p1', gateRun('implement', [{ name: 'definitions', ok: true, owes: [{ kind: LINT_EFFECT, key: k1 }] }]))
    expect(lintEffectKind.owed(repo.root, cfg, loadCanon(repo.root))).toEqual([{ kind: LINT_EFFECT, key: k1, shards: 1 }])
    repo.flipStatus('p1', 'done')
    expect(lintEffectKind.owed(repo.root, cfg, loadCanon(repo.root))).toEqual([])
  })

  it('the key: commits and 12 hex over the commands, within isJobKey for sha-256 commits (row 277)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { ship: { lint: { biome: 'b', lint: 'l' } }, readers: { biome: 'r', eslint: 'e' } })
    const cfg = cfgOf(repo.root)
    const P = 'a'.repeat(40)
    const E = 'b'.repeat(40)
    expect(lintEffectKey(cfg, P, E)).toMatch(/^a{40}\.b{40}\.[0-9a-f]{12}$/)
    expect(parseLintEffectKey(lintEffectKey(cfg, P, E))).toMatchObject({ plan: P, effect: E })
    expect(isJobKey(lintEffectKey(cfg, 'a'.repeat(64), 'b'.repeat(64)))).toBe(true)
    expect(lintEffectKey(cfg, P, E)).not.toBe(lintEffectKey({ ...cfg, readers: { ...cfg.readers, biome: 'other' } }, P, E))
    expect(lintEffectKey(cfg, P, E)).not.toBe(lintEffectKey({ ...cfg, ship: { ...cfg.ship, lint: [cfg.ship.lint![0]!] } }, P, E))
    expect(parseLintEffectKey(`${P}.${E}`)).toBeUndefined()
  })

  it('the kind is gated, takes no turn, runs in the scratch and is registered after base-lint (row 277)', () => {
    expect(lintEffectKind).toMatchObject({ kind: LINT_EFFECT, turn: false, gated: true, scratch: true })
    expect(lintEffectKind.boxMs({} as Config)).toBe(LINT_EFFECT_BOX_MS)
    const kinds = jobKinds({}).map((k) => k.kind)
    expect(kinds.indexOf(LINT_EFFECT)).toBe(kinds.indexOf('base-lint') + 1)
  })

  it('a hit on a path past MAX_HIT_FILE counts into over, so the result still validates and nothing is bookable (push security review)', () => {
    const head = { plan: 'a'.repeat(40), effect: 'b'.repeat(40), parts: [], readers: [{ tool: 'biome' as const }] }
    const hit = (file: string) => ({ tool: 'biome' as const, rule: 'lint/test/noBad', file, line: 1, key: 'c'.repeat(16), count: 1 })
    const r = fitResult(head, [hit('src/a.ts'), hit(`src/${'d/'.repeat(MAX_HIT_FILE)}x.ts`)])
    expect(r.hits.map((h) => h.file)).toEqual(['src/a.ts'])
    expect(r.over).toBe(1)
    expect(lintEffectResult(r)).toEqual(r)
    expect(lintEffectResult({ ...r, hits: [hit('x'.repeat(MAX_HIT_FILE + 1))] })).toBeUndefined()
  })

  it('the result validator takes only its own shape (row 277)', () => {
    const hit = { tool: 'biome', rule: 'lint/test/noBad', file: 'src/a.ts', line: 1, key: 'a'.repeat(16), count: 1 }
    const good = { plan: 'a'.repeat(40), effect: 'b'.repeat(64), parts: [{ part: 'biome', plan: 0, effect: 1 }], readers: [{ tool: 'biome' }], hits: [hit] }
    expect(lintEffectResult(good)).toEqual(good)
    expect(lintEffectResult({ ...good, over: 3, hits: [{ ...hit, rule: '', line: undefined, lineless: true }] })).toMatchObject({ over: 3 })
    expect(lintEffectResult({ ...good, hits: [{ ...hit, rule: '?' }] })).toBeDefined()
    for (const bad of [
      { ...good, extra: 1 }, { ...good, plan: 'abc' }, { ...good, over: -1 }, { ...good, over: 0 },
      { ...good, hits: [{ ...hit, count: 0 }] }, { ...good, hits: [{ ...hit, tool: 'pylint' }] }, { ...good, hits: [{ ...hit, rule: 'has space' }] },
      { ...good, hits: [{ ...hit, file: '' }] }, { ...good, hits: [{ ...hit, key: 'xyz' }] }, { ...good, hits: [{ ...hit, lineless: true }] },
      { ...good, parts: [{ part: 'biome', plan: 2, effect: 1 }] }, { ...good, readers: [{ tool: 'biome', unread: 'x'.repeat(201) }] },
      { ...good, hits: [{ ...hit, snippet: 'BAD' }] },
    ]) expect(lintEffectResult(bad), JSON.stringify(bad)).toBeUndefined()
  })
})
