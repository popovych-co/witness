import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { loadConfig } from '../src/config.js'
import { changedFiles, diffBase } from '../src/evidence.js'
import { canonicalSha, planContentSha } from '../src/sha.js'
import {
  fakeCtx, fakeScenario, gateEnv, nextLine, putVerdict, shippableRepo, writePlan,
} from './helpers.js'

async function settleImplementGate(repo: { root: string }, wt: string, planId: string): Promise<void> {
  const cfg = loadConfig(repo.root)
  const base = diffBase(wt, cfg.ok ? cfg.value : (undefined as never))
  const files = changedFiles(wt, base.ok ? base.value : '')
  const scenario = fakeScenario()
  putVerdict(scenario, { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] })
  const code = await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })
  if (code !== 0) throw new Error(`implement gate did not settle: exit ${code}`)
}

describe('planContentSha', () => {
  it('moves on body and step changes but never on derives-from', () => {
    const meta = {
      id: 'p', type: 'plan', status: 'draft', parent: 's', 'derives-from': 'a'.repeat(64),
      depends: [], needs: [], steps: [],
    }
    const base = planContentSha(meta, '## Step: s1\nwork\n')
    expect(planContentSha({ ...meta, 'derives-from': 'b'.repeat(64) }, '## Step: s1\nwork\n')).toBe(base)
    expect(planContentSha({ ...meta, status: 'in-progress' }, '## Step: s1\nwork\n')).toBe(base)
    expect(planContentSha(meta, '## Step: s1\nwork harder\n')).not.toBe(base)
    // and it is NOT canonicalSha: that one still counts derives-from
    expect(canonicalSha(meta, '## Step: s1\nwork\n')).not.toBe(base)
  })
})

describe('the implement gate re-arms on plan content', () => {
  it('lapses a settled gate when the plan is re-authored', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    const rewritten = await writePlan(repo, planId, {
      steps: [{ id: 's1', title: 'rotate tokens on refresh, bounded to 15m', criteria: ['ac-rotate'] }],
    })
    expect(rewritten.code).toBe(0)

    const out = await nextLine(repo)
    expect(out).toContain(`witness gate implement ${planId}`)
    expect(out).toContain('approval lapsed')

    await repo.cli(['clean'])
  })

  it('does not lapse when only derives-from moves — ship repins inside the gate txn', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    repo.setMeta(planId, { 'derives-from': 'f'.repeat(64) })
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    await repo.cli(['clean'])
  })

  it('names the plan, not the worktree, when the plan is what moved', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    const rewritten = await writePlan(repo, planId, {
      steps: [{ id: 's1', title: 'rotate tokens on refresh, bounded to 15m', criteria: ['ac-rotate'] }],
    })
    expect(rewritten.code).toBe(0)

    const out = await nextLine(repo)

    expect(out).toContain('approval lapsed')
    expect(out).toContain('the plan was re-authored')
    // the worktree is untouched, and the note must not say otherwise
    expect(out).not.toContain('the worktree moved')

    await repo.cli(['clean'])
  })

  it('names the worktree when the tree is what moved', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    writeFileSync(join(wt, 'src', 'sneaked-in.ts'), 'export const x = 1\n')

    const out = await nextLine(repo)

    expect(out).toContain('approval lapsed')
    expect(out).toContain('the worktree moved')
    expect(out).not.toContain('the plan was re-authored')

    await repo.cli(['clean'])
  })

  // The reported loop's ignition was a file entering the diff that the human never edited
  // — a formatter, twenty-seven seconds after the gate passed. Re-arming is correct (row
  // 96a: the identity IS the diff the battery read); leaving the human to guess WHICH file
  // is not, when `flowAction` is already holding the list.
  it('names the changed paths when the worktree moved', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    writeFileSync(join(wt, 'src', 'sneaked-in.ts'), 'export const x = 1\n')

    const out = await nextLine(repo)

    expect(out).toContain('the worktree moved')
    expect(out).toContain('changed vs base:')
    expect(out).toContain('src/sneaked-in.ts')

    await repo.cli(['clean'])
  })

  // No silent truncation: a note that lists six of many and says nothing about the rest
  // reads as a complete answer, which is the one thing it must never do.
  it('counts the paths it did not list', async () => {
    const { repo, wt, planId } = await shippableRepo()
    await settleImplementGate(repo, wt, planId)
    expect(await nextLine(repo)).toContain(`witness ship ${planId}`)

    for (let i = 0; i < 9; i++) {
      writeFileSync(join(wt, 'src', `extra-${i}.ts`), `export const v${i} = ${i}\n`)
    }

    const out = await nextLine(repo)
    const note = out.split('\n').find((l) => l.startsWith('note:')) ?? ''

    // exactly six named, the remainder counted rather than dropped. The list is
    // `changedFiles` sorted, so it interleaves the fixture's own paths with the nine added
    // here — assert the CAP, not which paths won the sort.
    const listed = /changed vs base: (.+?)(?: \(\+(\d+) more\))? — re-gate/.exec(note)
    expect(listed, `no changed-paths clause in: ${note}`).not.toBeNull()
    expect(listed![1]!.split(' ')).toHaveLength(6)
    expect(Number(listed![2])).toBeGreaterThan(0)

    await repo.cli(['clean'])
  })
})
