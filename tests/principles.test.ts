import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import { findById, loadCanon } from '../src/scan.js'
import { fakeCtx, fakeScenario, gateEnv, putVerdict, seededRepo, type TestRepo, writePlan, writeSpec } from './helpers.js'

const PRINCIPLES = 'specs/principles.md'
const statusOf = (repo: TestRepo, id: string): string => String(findById(loadCanon(repo.root), id)!.meta.status)
const AMENDED = '# Principles\n\n## Rules\nPrefer boring technology.\n'
const AMENDED_AGAIN = '# Principles\n\n## Rules\nPrefer boring technology. Measure before tuning.\n'
const PRINCIPLES_META = { type: 'principles', summary: undefined, criteria: undefined, covers: ['g1'] }
const CHORE_PLAN = { type: 'plan', parent: 'principles', depends: [], needs: [], steps: [{ id: 's1', title: 'bump deps', scaffolding: true }] }

// The old init's principles: the template, born draft (before row 219).
function legacyDraft(repo: TestRepo, body?: string): void {
  let text = repo.read(PRINCIPLES).replace('status: approved', 'status: draft')
  if (body !== undefined) text = text.replace(/\n---\n[\s\S]*$/, `\n---\n${body}`)
  repo.write(PRINCIPLES, text)
  repo.git('add', PRINCIPLES)
  repo.git('commit', '-q', '-m', 'principles as an older init wrote them', '-m', 'Witness-State: 1')
}

async function decomposeApproved(repo: TestRepo): Promise<void> {
  const scenario = fakeScenario()
  putVerdict(scenario, {
    coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }, { anchor: 'principles > ## Rules', note: 'read' }],
    findings: [],
  })
  await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'decompose', repo.effort, { fresh: false, manual: false })
  const d = await repo.cli(['decide', 'decompose', repo.effort, '--approve'])
  expect(d.code, d.stderr).toBe(0)
}

// Row 219 (#66). Principles are canon like a spec: the effort that changes them has them
// reviewed by its decompose gate, which stamps them approved. Init's empty template is born
// approved, and migrate stamps an older repo's untouched draft template.
describe('principles are reviewed like specs (#66)', () => {
  it('a chore on a fresh repo writes its plan under the principles init made', async () => {
    const repo = await seededRepo({ class: 'chore', slug: 'c1' })
    expect(statusOf(repo, 'principles')).toBe('approved')
    expect((await repo.cli(['next'])).stdout).toContain('witness write <plan-id> --effort c1')
    const w = await writePlan(repo, 'p1', CHORE_PLAN, '## Step: s1\nbump\n', 'c1')
    expect(w.code, w.stderr).toBe(0)
  })

  it('the decompose gate of the effort that amended principles reviews and stamps them', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    expect((await writeSpec(repo, 'principles', PRINCIPLES_META, AMENDED)).code).toBe(0)
    expect(statusOf(repo, 'principles')).toBe('draft')
    await decomposeApproved(repo)
    expect(statusOf(repo, 'principles')).toBe('approved')
    expect(readStream(repo.root, 'principles').filter((e) => e.t === 'status').at(-1))
      .toMatchObject({ from: 'draft', to: 'approved', cause: 'gate-approve' })
  })

  // Review Focus 3. Amended again after its decompose passed: back to draft, and the
  // effort's decompose is owed again — never a silent loop.
  it('an amendment after the effort\'s decompose passed owes that decompose again', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'principles', PRINCIPLES_META, AMENDED)
    await decomposeApproved(repo)
    expect((await writeSpec(repo, 'principles', PRINCIPLES_META, AMENDED_AGAIN)).code).toBe(0)
    expect(statusOf(repo, 'principles')).toBe('draft')
    expect((await repo.cli(['next'])).stdout).toContain('witness gate decompose --effort auth-hardening')
  })

  it('a chore under draft principles is told which effort\'s gate approves them', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    await writeSpec(repo, 'principles', PRINCIPLES_META, AMENDED)
    const chore = { effort: 'c1', class: 'chore', goals: [{ id: 'g1', text: 'bump deps' }], non_goals: [], constraints: [], slices: [] }
    repo.write('c1.json', JSON.stringify(chore))
    expect((await repo.cli(['recap', '--file', 'c1.json'])).code).toBe(0)
    const w = await writePlan(repo, 'p1', CHORE_PLAN, '## Step: s1\nbump\n', 'c1')
    expect(w.code).toBe(2)
    expect(w.stderr).toContain('parent-not-approved')
    expect(w.stderr).toContain('witness gate decompose --effort auth-hardening')
  })

  it('a chore under draft principles no effort owns is told so, and never routed to the refused write', async () => {
    const repo = await seededRepo({ class: 'chore', slug: 'c1' })
    legacyDraft(repo, AMENDED)
    for (let i = 0; i < 2; i++) {
      const n = await repo.cli(['next'])
      expect(n.stdout).toContain('note: principles.md is draft and no effort owns it')
      expect(n.stdout).toContain('next: witness check')
      expect(n.stdout).not.toContain('witness write <plan-id>')
    }
    const w = await writePlan(repo, 'p1', CHORE_PLAN, '## Step: s1\nbump\n', 'c1')
    expect(w.stderr).toContain('amend principles through a feature or fix effort')
  })
})

describe('migrate stamps the untouched draft template (#66)', () => {
  it('stamps it approved in one trailer commit, journaled as the template; --dry-run names it', async () => {
    const repo = await seededRepo({ class: 'chore', slug: 'c1' })
    legacyDraft(repo)
    const head = repo.git('rev-parse', 'HEAD')
    const dry = await repo.cli(['migrate', '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain('principles')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
    expect(statusOf(repo, 'principles')).toBe('draft')

    const m = await repo.cli(['migrate'])
    expect(m.code, m.stderr).toBe(0)
    expect(statusOf(repo, 'principles')).toBe('approved')
    expect(readStream(repo.root, 'principles').filter((e) => e.t === 'status').at(-1))
      .toMatchObject({ from: 'draft', to: 'approved', cause: 'template' })
    expect(repo.git('status', '--porcelain')).toBe('')
    expect(repo.git('log', '-1', '--format=%B')).toContain('Witness-State: 1')
    expect((await repo.cli(['check'])).stdout).not.toContain('untrailered')
  })

  it('never stamps a draft whose body was changed', async () => {
    const repo = await seededRepo({ class: 'chore', slug: 'c1' })
    legacyDraft(repo, AMENDED)
    const head = repo.git('rev-parse', 'HEAD')
    const m = await repo.cli(['migrate'])
    expect(m.code).toBe(0)
    expect(statusOf(repo, 'principles')).toBe('draft')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
  })
})
