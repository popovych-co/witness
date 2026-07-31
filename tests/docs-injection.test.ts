import { describe, expect, it } from 'vitest'
import { docKeysFor, docsBlock, loadLensDocs, promptsSha, type Lens } from '../src/reviewer.js'
import { tmpRepo } from './helpers.js'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ok } from '../src/refusal.js'
import { readStream } from '../src/journal.js'
import { registerGate, runGate, type GateInput } from '../src/gate.js'
import type { GateRunEntry } from '../src/rounds.js'
import { canonicalSha } from '../src/sha.js'
import { findById } from '../src/scan.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, writeSpec } from './helpers.js'

describe('lens docs (pure)', () => {
  it('promptsSha diverges when injected doc contents change', () => {
    const base: Lens = { name: 'code-reviewer', contents: 'LENS' }
    const a = promptsSha([{ ...base, docs: [{ path: 'docs/c.md', contents: 'v1' }] }])
    const b = promptsSha([{ ...base, docs: [{ path: 'docs/c.md', contents: 'v2' }] }])
    const none = promptsSha([base])
    expect(a).not.toBe(b)
    expect(a).not.toBe(none)
    expect(none).toBe(promptsSha([{ ...base }]))
  })

  it('docKeysFor maps conventions → code-reviewer at implement and ship only', () => {
    expect(docKeysFor('implement', 'code-reviewer')).toEqual(['conventions'])
    expect(docKeysFor('ship', 'code-reviewer')).toEqual(['conventions'])
    expect(docKeysFor('plan', 'code-reviewer')).toEqual([])
    expect(docKeysFor('ship', 'drift-reviewer')).toEqual([])
  })

  it('docsBlock renders one section per doc; empty for none', () => {
    expect(docsBlock([])).toBe('')
    const block = docsBlock([{ path: 'docs/c.md', contents: 'RULES' }])
    expect(block).toContain('## Repo conventions')
    expect(block).toContain('### docs/c.md')
    expect(block).toContain('RULES')
  })

  it('loadLensDocs refuses a missing file fail-closed', () => {
    const repo = tmpRepo()
    repo.write('docs/present.md', 'ok')
    const good = loadLensDocs(repo.root, ['docs/present.md'])
    expect(good.ok && good.value[0]).toEqual({ path: 'docs/present.md', contents: 'ok' })
    const bad = loadLensDocs(repo.root, ['docs/absent.md'])
    expect(!bad.ok && bad.violations[0]?.rule).toBe('doc-missing')
  })
})

const CLEAN = {
  coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [],
}

// Synthetic ship-gate spec: real resolve logic is irrelevant here — the ship
// gate is the cheapest carrier for code-reviewer, whose injection we're testing.
// vitest isolates files per worker, so this never collides with gates/index.
let synthetic = false
function registerSyntheticShip() {
  if (synthetic) return
  synthetic = true
  registerGate({
    gate: 'ship',
    targetKind: 'plan',
    async resolve(root, _ctx, canon, _cfg, target) {
      const doc = findById(canon, target)!
      return ok<GateInput>({
        class: 'feature',
        reviewedSha: canonicalSha(doc.meta, doc.body),
        reviewed: { kind: 'docs', docs: [{ id: target, body: doc.body }] },
        promptBody: doc.body,
        checks: [{ name: 'synthetic', ok: true }],
        stamps: [],
      })
    },
  })
}

async function shipRepo() {
  registerSyntheticShip()
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  repo.write('docs/conventions.md', 'Every module exposes one public entry.')
  const cfgPath = join(repo.root, 'witness.config.yaml')
  writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8') + 'docs:\n  conventions: [docs/conventions.md]\n')
  repo.git('add', 'docs/conventions.md', 'witness.config.yaml')
  repo.git('commit', '-m', 'conventions doc + registry')
  const scenario = fakeScenario()
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  return { repo, scenario, ctx }
}

const runs = (repo: { root: string }) =>
  readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

describe('conventions injection at the gate', () => {
  it('injects into code-reviewer at ship — and only there', async () => {
    const { scenario, ctx } = await shipRepo()
    putVerdict(scenario, CLEAN)
    expect(await runGate(ctx, 'ship', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    // default ship battery order: drift-reviewer (call-1), code-reviewer (call-2)
    const drift = readFileSync(join(scenario, 'claude-calls/call-1/stdin'), 'utf8')
    const code = readFileSync(join(scenario, 'claude-calls/call-2/stdin'), 'utf8')
    expect(code).toContain('## Repo conventions')
    expect(code).toContain('### docs/conventions.md')
    expect(code).toContain('Every module exposes one public entry.')
    expect(code.indexOf('## Repo conventions')).toBeLessThan(code.indexOf('## Reviewed content'))
    expect(drift).not.toContain('## Repo conventions')
  })

  it('an edited conventions doc breaks the verdict cache; unedited resumes', async () => {
    const { repo, scenario, ctx } = await shipRepo()
    putVerdict(scenario, CLEAN)
    await runGate(ctx, 'ship', 'auth-refresh', { fresh: false, manual: false })
    // unchanged docs + unchanged content → resume: nothing appends, claude idle
    await runGate(ctx, 'ship', 'auth-refresh', { fresh: false, manual: false })
    expect(runs(repo).length).toBe(1)
    expect(() => readFileSync(join(scenario, 'claude-calls/call-3/stdin'), 'utf8')).toThrow()
    // edited doc → new prompts_sha → live re-roll on identical reviewed content
    repo.write('docs/conventions.md', 'Every module exposes one public entry. No barrels.')
    repo.git('add', 'docs/conventions.md')
    repo.git('commit', '-m', 'tighten conventions')
    expect(await runGate(ctx, 'ship', 'auth-refresh', { fresh: false, manual: false })).toBe(0)
    expect(runs(repo).length).toBe(2)
    // battery order per round is [drift-reviewer, code-reviewer]; round 3's
    // fresh re-roll re-invokes both, so call-3 = drift, call-4 = code (docs)
    const rerolled = readFileSync(join(scenario, 'claude-calls/call-4/stdin'), 'utf8')
    expect(rerolled).toContain('No barrels.')
  })

  it('a configured doc missing on disk refuses the gate fail-closed', async () => {
    const { repo, scenario } = await shipRepo()
    putVerdict(scenario, CLEAN)
    rmSync(join(repo.root, 'docs/conventions.md'))
    const errs: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), err: (l: string) => errs.push(l) })
    expect(await runGate(ctx, 'ship', 'auth-refresh', { fresh: false, manual: false })).toBe(2)
    expect(errs.join('\n')).toContain('doc-missing')
    expect(runs(repo).length).toBe(0)
  })
})
