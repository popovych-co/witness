import { describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../src/gates/index.js'
import { runGate } from '../src/gate.js'
import { runShip } from '../src/ship.js'
import { addOrigin, fakeCtx, fakeScenario, gateEnv, git, putVerdict, shippableRepo, writeOldSparsePatterns } from './helpers.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OLD = '.claude/hooks/guard-state.mjs'
const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}

// `shippableRepo` with an origin, the implement gate settled on a clean verdict, and a ctx whose
// stdout `out()` returns joined.
async function shipReady() {
  const seed = await shippableRepo()
  addOrigin(seed.repo)
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  const lines: string[] = []
  const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario), out: (l) => lines.push(l) })
  await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })
  return { ...seed, scenario, ctx, out: () => lines.join('\n') }
}

describe('the ship gate drops witness payload its base no longer carries (row 250, #95)', () => {
  it('drops an old hook the plan branch added, in its own commit, before the lanes run', async () => {
    const { wt, planId, ctx, out } = await shipReady()
    mkdirSync(join(wt, '.claude/hooks'), { recursive: true })
    copyFileSync(join(REPO, 'plugin/hooks/guard-state.mjs'), join(wt, OLD))
    git(wt, 'add', OLD)
    git(wt, 'commit', '-m', 'init(claude-code): agent payloads')
    await runShip(ctx, planId)                                       // gate phase → the ship stop
    expect(out()).toContain(`payload-retired: ${OLD} — dropped from ${planId}: its base no longer carries them`)
    expect(existsSync(join(wt, OLD))).toBe(false)
    expect(git(wt, 'ls-files', '--', OLD)).toBe('')
    expect(git(wt, 'log', '-1', '--format=%s')).toBe(`ship(${planId}): witness's retired payload dropped — the base no longer carries it`)
    expect(git(wt, 'diff', '--name-only', 'origin/main', 'HEAD', '--', '.claude')).toBe('')
  })

  // Slice 2 review I1: the base is the cut point, so a branch whose own settings still run the old
  // hooks (no carry yet) would lose its guard.
  it("keeps an old hook while the branch's own settings still run it", async () => {
    const { wt, planId, ctx, out } = await shipReady()
    mkdirSync(join(wt, '.claude/hooks'), { recursive: true })
    copyFileSync(join(REPO, 'plugin/hooks/guard-state.mjs'), join(wt, OLD))
    writeFileSync(join(wt, '.claude/settings.json'), `${JSON.stringify({ hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-state.mjs"' }] }] } }, null, 2)}\n`)
    git(wt, 'add', OLD, '.claude/settings.json')
    git(wt, 'commit', '-m', 'init(claude-code): agent payloads')
    await runShip(ctx, planId)
    expect(out()).not.toContain('payload-retired')
    expect(existsSync(join(wt, OLD))).toBe(true)
  })

  it('keeps an old hook its base still carries', async () => {
    const { repo, wt, planId, ctx, out } = await shipReady()
    repo.write(OLD, readFileSync(join(REPO, 'plugin/hooks/guard-state.mjs'), 'utf8'))   // main still carries it
    repo.git('add', OLD)
    repo.git('commit', '-m', 'init(claude-code): agent payloads')
    repo.git('push', 'origin', 'main')
    await runShip(ctx, planId)                                       // the carry brings it in from the base
    expect(out()).toContain('rebased before the battery')
    expect(out()).not.toContain('payload-retired')
    expect(existsSync(join(wt, OLD))).toBe(true)
  })

  it('after the carry: drops what the rebase brought back, and checks out the moved hooks on an old worktree', async () => {
    const { repo, wt, planId, ctx, out } = await shipReady()
    // the branch added the old hook (fewhats' shape); main moved it to the new home and was pushed
    mkdirSync(join(wt, '.claude/hooks'), { recursive: true })
    copyFileSync(join(REPO, 'plugin/hooks/guard-state.mjs'), join(wt, OLD))
    git(wt, 'add', OLD)
    git(wt, 'commit', '-m', 'init(claude-code): agent payloads')
    repo.write('.witness/hooks/guard-state.mjs', readFileSync(join(REPO, 'plugin/hooks/guard-state.mjs'), 'utf8'))
    repo.git('add', '.witness/hooks/guard-state.mjs')
    repo.git('commit', '-m', 'init(claude-code): agent payloads')
    repo.git('push', 'origin', 'main')
    writeOldSparsePatterns(repo, wt)                                // the 0.30.0 patterns, then read-tree -mu HEAD
    await runShip(ctx, planId)
    expect(out()).toContain('rebased before the battery')
    expect(out()).toContain(`payload-retired: ${OLD}`)
    expect(existsSync(join(wt, OLD))).toBe(false)
    expect(existsSync(join(wt, '.witness/hooks/guard-state.mjs'))).toBe(true)
    expect(git(wt, 'ls-files', '-t', '--', '.witness/hooks/guard-state.mjs')).toBe('H .witness/hooks/guard-state.mjs')
  })
})
