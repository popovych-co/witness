import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planChangeSet } from '../src/change-set.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import type { Finding } from '../src/verdict.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo } from './helpers.js'

const runs = (root: string, id: string) => readStream(root, id).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

// One implement round on a shippable plan, every lens answering with `finding`.
async function gateWith(finding: Finding & { guard?: unknown }) {
  const { repo, wt, planId } = await shippableRepo()
  const cfg = loadConfig(repo.root)
  const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
  const files = planChangeSet(wt, base.ok ? base.value : '')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [finding] })
  const out: string[] = []
  const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => out.push(l) })
  await runGate(ctx, 'implement', planId, { fresh: false, manual: false })
  const run = runs(repo.root, planId).at(-1)!
  const refs = repo.git('for-each-ref', '--format=%(refname)', `refs/witness/cf/${planId}/`).split('\n').filter((l) => l !== '')
  return { repo, planId, run, refs, out: out.join('\n') }
}

const prompt = (lens: string) => readFileSync(join(import.meta.dirname, '..', 'prompts', `${lens}.md`), 'utf8')

describe('the guard mark (row 280)', () => {
  it('a round that marks a blocking finding pins its reviewed tree (row 280)', async () => {
    const { run, refs, planId } = await gateWith({ anchor: 'src/token.ts', claim: 'rotates late', blocking: true, guard: 'test' })
    expect(run.outcome).toBe('stopped')
    expect(run.reviewed_tree).toMatch(/^[0-9a-f]{40}$/)
    expect(refs).toContain(`refs/witness/cf/${planId}/${run.reviewed_tree}`)
  })

  it('a non-blocking marked finding pins nothing', async () => {
    const { refs } = await gateWith({ anchor: 'src/token.ts', claim: 'rotates late', blocking: false, guard: 'lint' })
    expect(refs).toEqual([])
  })

  it("the gate's findings table shows the mark, and help names witness guard", async () => {
    const { out, planId } = await gateWith({ anchor: 'src/token.ts', claim: 'rotates late', blocking: true, guard: 'test' })
    expect(out).toMatch(/findings\[\d+\]\{reviewer,blocking,guard,pin,anchor,claim\}/)
    expect(out).toMatch(/,true,test,,src\/token\.ts,rotates late/)
    expect(out).toContain(`help: a guard-marked finding asks for a check that fails on the code it names — witness guard ${planId} --finding`)
  })

  it('the four code lenses state the mark; no other lens does', () => {
    const line = '`guard` (optional, blocking findings only)'
    for (const l of ['code-reviewer', 'silent-failure-hunter', 'type-design', 'pr-test']) expect(prompt(l)).toContain(line)
    for (const l of ['plan-critic', 'slicing-critic', 'design-critic', 'design-reviewer', 'drift-reviewer']) expect(prompt(l)).not.toContain(line)
  })
})
