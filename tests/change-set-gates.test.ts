import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planChangeSet } from '../src/change-set.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { changedPaths, snapshotTree, treeDiff } from '../src/snapshot.js'
import { callFor, fakeCtx, fakeScenario, gateEnv, git, putVerdict, shippableRepo, unwrap } from './helpers.js'

describe('the code gates read the plan change set (row 246, #93)', () => {
  // The fewhats shape: init --agent after the plan started commits the payload into its worktree.
  async function payloadInDiff() {
    const { repo, wt, planId } = await shippableRepo()
    const init = await repo.cli(['init', '--agent', 'claude-code'])
    expect(init.stdout).toMatch(/^payload-synced: .*\.claude\/hooks\/guard-state\.mjs/m)
    return { repo, wt, planId }
  }

  // `files` is one variable in resolve: the prompt's list below, the coverage pool (`reviewed.files`)
  // and the snapshot all read it, so the list's exact text pins the pool too.
  it('the implement battery is shown no payload path: not in its file list, its diff or its snapshot', async () => {
    const { repo, wt, planId } = await payloadInDiff()
    const base = unwrap(diffBase(wt, unwrap(loadConfig(repo.root))))
    const files = planChangeSet(wt, base)
    expect(files.some((f) => f.startsWith('.claude/'))).toBe(false)
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] })
    expect(await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'implement', planId, { fresh: false, manual: false })).toBe(0)
    const prompt = readFileSync(join(callFor(scenario, 'code-reviewer')!, 'stdin'), 'utf8')
    expect(prompt).toContain(`### Changed files\n${files.join('\n')}\n\n### Diff vs base`)
    expect(prompt).not.toContain('.claude/hooks/guard-state.mjs')
    expect(prompt).not.toContain('.claude/commands/witness.md')
    const run = readStream(repo.root, planId).filter((e) => e.t === 'gate-run').at(-1) as unknown as GateRunEntry
    expect(git(wt, 'diff', '--name-only', base, run.reviewed_tree!)).not.toMatch(/\.claude\//)
  })

  it('a delta from a snapshot that still holds a payload change shows nothing for it', async () => {
    const { wt } = await payloadInDiff()
    const head = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: wt, encoding: 'utf8' }).trim()
    writeFileSync(join(wt, '.claude/hooks/guard-state.mjs'), '// a pre-row-246 snapshot held this\n')
    const old = snapshotTree(wt, 'HEAD', ['.claude/hooks/guard-state.mjs'])!
    expect(changedPaths(wt, old, head)).toEqual([])
    expect(treeDiff(wt, old, head)).toBe('')
  })
})
