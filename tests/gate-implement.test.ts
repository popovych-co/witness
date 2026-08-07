import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import type { GateRunEntry } from '../src/rounds.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { loadConfig } from '../src/config.js'
import { TOKEN_BROKEN, fakeCtx, fakeScenario, fixtureEnv, gateEnv, putVerdict, shippableRepo } from './helpers.js'

function treeClean(files: string[]) {
  return {
    coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })),
    findings: [],
  }
}
const runs = (repo: { root: string }, id: string) =>
  readStream(repo.root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

describe('implement gate', () => {
  it('green path: evidence satisfied + drift lane green + clean battery → passed', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const cfg = loadConfig(repo.root)
    const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    const files = changedFiles(wt, base.ok ? base.value : '')
    const scenario = fakeScenario()
    putVerdict(scenario, treeClean(files))
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(0)
    const [entry] = runs(repo, planId)
    expect(entry!.outcome).toBe('passed')
    expect(entry!.reviewed_sha).toMatch(/^[0-9a-f]{64}$/)          // row 96: sha256 over base + the diff's blobs
    expect(entry!.checks.find((c) => c.name === 'evidence')!.ok).toBe(true)
    expect(entry!.checks.find((c) => c.name === 'drift-lane')!.ok).toBe(true)
  })

  it('a code-only revise changes the reviewed sha — the stale-verdict bug stays dead', async () => {
    const { repo, wt, planId } = await shippableRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, {
      coverage: [{ anchor: 'src/token.ts', note: 'read' }, { anchor: 'tests/token.test.ts', note: 'read' }],
      findings: [{ blocking: true, anchor: 'src/token.ts#rotateDue', claim: 'no expiry bound' }],
    })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(1)
    const first = runs(repo, planId)[0]!
    // untracked-only change in the worktree — the plan doc is untouched
    writeFileSync(join(wt, 'src/expiry.ts'), 'export const EXPIRY_MS = 900_000\n')
    const cfg = loadConfig(repo.root)
    const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    putVerdict(scenario, treeClean(changedFiles(wt, base.ok ? base.value : '')), 2)
    await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
    const all = runs(repo, planId)
    expect(all.length).toBe(2)                                    // appended, not resumed
    expect(all[1]!.reviewed_sha).not.toBe(first.reviewed_sha)
    // both rounds end malformed here (the canned verdict under-covers the diff),
    // and malformed runs never spend the budget (D67) — the label stays 1
    expect(all[1]!.round).toBe(1)
  })

  it('missing red→green evidence fails the evidence check', async () => {
    const { repo, wt, planId } = await shippableRepo()
    // Row 97 narrowed `evidence` to the PARENT tag, so a foreign tag no longer lands here
    // (that is the `regression` check's job). The parent's own pair is broken the way the
    // field breaks it: a fresh red recorded after the last green, leaving the latest cycle
    // half-finished. `evidenceForDiff` reads latest-cycle per tag, so green no longer
    // post-dates the red.
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    execFileSync('git', ['add', '-A'], { cwd: wt })
    const red = await repo.cli(['test-evidence', planId, '--phase', 'red'], { cwd: wt, env: fixtureEnv() })
    expect(red.code).toBe(0)
    const scenario = fakeScenario()
    putVerdict(scenario, treeClean(['src/token.ts']))
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(1)
    const entry = runs(repo, planId).at(-1)!
    const evidence = entry.checks.find((c) => c.name === 'evidence')!
    expect(evidence.ok).toBe(false)
    expect(evidence.detail).toContain('auth-refresh')
    expect(evidence.detail).toContain('green=false')
  })

  it('refuses when the plan was never started', async () => {
    const { repo } = await shippableRepo()
    const r = await repo.cli(['gate', 'implement', 'no-such-plan'])
    expect(r.code).toBe(2)
  })
})
