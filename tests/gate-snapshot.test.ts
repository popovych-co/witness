import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { basisSha } from '../src/delta.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import {
  DESIGN_HTML, approve, fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, shippableRepo,
  witnessDesign, writeDesign, writePlan, writeSpec,
} from './helpers.js'

const PLAN = 'auth-refresh-plan-1'
const PAIR_CLEAN = { coverage: [{ anchor: `${PLAN} > ## Step: s1`, note: 'read' }, { anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] }
const runsOf = (root: string, id: string) => readStream(root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]
const F = { fresh: false, manual: false }

async function planGate() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh'); approve(repo, 'auth-refresh'); await writePlan(repo, PLAN)
  const scenario = fakeScenario(); putVerdict(scenario, PAIR_CLEAN)
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
  return { repo, gate: () => runGate(ctx, 'plan', PLAN, F) }
}

describe('every gate run journals what its battery read', () => {
  it('the plan gate snapshots the plan doc alone and journals its basis', async () => {
    const { repo, gate } = await planGate()
    await gate()
    const [r] = runsOf(repo.root, PLAN)
    expect(repo.git('ls-tree', '--name-only', r!.reviewed_tree!)).toBe(`${PLAN}.md`)
    const blob = repo.git('cat-file', 'blob', `${r!.reviewed_tree}:${PLAN}.md`)
    expect(blob).toContain('type: plan')
    expect(blob).toContain('## Step: s1')
    expect(r!.basis_sha).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the basis holds across a plan edit and moves with a parent amendment', async () => {
    const { repo, gate } = await planGate()
    await gate()
    await writePlan(repo, PLAN, {}, '## Step: s1\nRotate with a test first.\n')
    await gate()
    await writeSpec(repo, 'auth-refresh', { summary: 'amended under the plan' })
    await gate()
    const [r1, r2, r3] = runsOf(repo.root, PLAN)
    expect(r2!.basis_sha).toBe(r1!.basis_sha)
    expect(r3!.basis_sha).not.toBe(r2!.basis_sha)
  })

  it('decompose snapshots the effort specs and design snapshots the look', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const s = fakeScenario(); putVerdict(s, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
    await runGate(fakeCtx(repo.root, { env: gateEnv(s) }), 'decompose', 'auth-hardening', F)
    expect(repo.git('ls-tree', '--name-only', runsOf(repo.root, 'auth-hardening')[0]!.reviewed_tree!)).toBe('auth-refresh.md')

    await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
    approve(repo, 'booking-form'); await writeDesign(repo, 'booking-form'); await witnessDesign(repo, 'booking-form')
    const d = fakeScenario(); putVerdict(d, { coverage: [{ anchor: 'design#save-bar', note: 'x' }, { anchor: 'booking-form > ## Behavior', note: 'x' }], findings: [] })
    await runGate(fakeCtx(repo.root, { env: gateEnv(d) }), 'design', 'booking-form', F)
    const tree = runsOf(repo.root, 'booking-form')[0]!.reviewed_tree!
    expect(repo.git('ls-tree', '--name-only', tree)).toBe('design.html')
    expect(repo.git('cat-file', 'blob', `${tree}:design.html`)).toBe(DESIGN_HTML.trim())
  })

  it('implement snapshots the worktree, and the primary root reads it', async () => {
    const { repo, wt, planId } = await shippableRepo()
    writeFileSync(join(wt, 'src/expiry.ts'), 'export const EXPIRY_MS = 900_000\n')
    const cfg = loadConfig(repo.root)
    const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
    const files = changedFiles(wt, base.ok ? base.value : '')
    const s = fakeScenario(); putVerdict(s, { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] })
    await runGate(fakeCtx(repo.root, { env: gateEnv(s) }), 'implement', planId, F)
    const [r] = runsOf(repo.root, planId)
    expect(repo.git('cat-file', 'blob', `${r!.reviewed_tree}:src/expiry.ts`)).toBe('export const EXPIRY_MS = 900_000')
  }, 60_000)
})

describe('basisSha', () => {
  it('moves with lens prompts, lens docs, context, pin and harness, and with nothing else', () => {
    const lens = { name: 'plan-critic', contents: 'L' }
    const b = basisSha([lens], 'ctx', 'm', 'claude-code')
    expect(basisSha([{ ...lens }], 'ctx', 'm', 'claude-code')).toBe(b)
    for (const other of [
      basisSha([{ ...lens, contents: 'L2' }], 'ctx', 'm', 'claude-code'),
      basisSha([{ ...lens, docs: [{ path: 'd.md', contents: 'x' }] }], 'ctx', 'm', 'claude-code'),
      basisSha([lens], 'ctx2', 'm', 'claude-code'),
      basisSha([lens], 'ctx', 'm2', 'claude-code'),
      basisSha([lens], 'ctx', 'm', 'pi'),
    ]) expect(other).not.toBe(b)
  })
})
