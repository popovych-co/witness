import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../src/gates/index.js'
import { carryRef } from '../src/carry.js'
import { clashLeft } from '../src/clash.js'
import { loadConfig } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { readStream } from '../src/journal.js'
import { diffReviewedSha } from '../src/reviewed.js'
import { gateRuns } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { baseMoved, finishMove, rebaseIfMoved, shipPhase } from '../src/ship.js'
import type { ShipOutcomeEntry } from '../src/ship-outcome.js'
import { addOrigin, commitEntry, fakeScenario, gateEnv, hermeticEnv, putVerdict, shippableRepo, type TestRepo } from './helpers.js'

// Row 243 (design §4.1.1 step 9, §4.1.3's table; issue #86; amends row 77). Ship carries the plan's
// uncommitted work across a moved base itself, so two things follow. With no PR yet, an approved
// ship gate routes to `pr` only while that gate is settled for the tree as it now stands: the
// reviewed sha's base term moves with a carry, a clash resolved after it, or a refused apply finished
// later, and a state-only advance leaves it (P32). And each refusal of the carry exits and records
// as the table says: `textual-conflict` 1, `index-locked` 3 recorded `transient`, every other 2
// recording nothing.

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\n$/, '')
const tryG = (cwd: string, ...args: string[]): boolean => {
  try { g(cwd, ...args); return true } catch { return false }
}
const read = (wt: string, f: string): string => readFileSync(join(wt, f), 'utf8')
const put = (wt: string, f: string, body: string): void => writeFileSync(join(wt, f), body)
const head = (wt: string): string => g(wt, 'rev-parse', 'HEAD')
const staged = (wt: string, f: string): string => g(wt, 'show', `:${f}`)
const hasCarry = (wt: string, planId: string): boolean => tryG(wt, 'show-ref', '--verify', '--quiet', carryRef(planId))

// The plan stream's ship outcomes, and the last of them: what ship recorded for the run.
const shipOutcomes = (root: string, planId: string): ShipOutcomeEntry[] =>
  readStream(root, planId).filter((e) => e.t === 'ship-outcome') as unknown as ShipOutcomeEntry[]
const lastShipOutcome = (root: string, planId: string): ShipOutcomeEntry | undefined => shipOutcomes(root, planId).at(-1)

const CLEAN = {
  coverage: ['.gitignore', 'package.json', 'src/token.ts', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' })),
  findings: [],
}
// Every ship run here sees the fake harness first on PATH (claude, gh), with a clean verdict and a
// short CI watch: a run that reaches the gate never starts a real reviewer, nor the PR a real gh.
function harness(): { scenario: string; env: Record<string, string> } {
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  return { scenario, env: gateEnv(scenario, { WITNESS_SHIP_WATCH_MS: '1' }) }
}
const ghCalls = (scenario: string): string => {
  try { return readFileSync(join(scenario, 'gh-calls'), 'utf8') } catch { return '' }
}

// A hook in the test repo's own hooks dir (shared by its worktrees), so a step of the move meets a
// state the test sets at exactly that moment: `git rebase` runs pre-rebase after the carry is
// captured and the tree cleaned, before it moves anything. core.hooksPath is pinned in the repo's own
// config first, so a global one never receives it (tests/ship-carry.test.ts does the same).
function hook(wt: string, name: string, body: string): void {
  const hooks = join(resolve(wt, g(wt, 'rev-parse', '--git-common-dir')), 'hooks')
  g(wt, 'config', 'core.hooksPath', hooks)
  const path = join(hooks, name)
  expect(resolve(wt, g(wt, 'rev-parse', '--git-path', `hooks/${name}`))).toBe(path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}
// The hook's body runs at the first rebase only: the marker beside the worktree says it ran.
const once = (wt: string, planId: string, body: string): string => {
  const marker = join(wt, '..', `${planId}-hooked`)
  return `[ -e '${marker}' ] && exit 0\n: > '${marker}'\n${body}`
}

// shippableRepo with an origin and two plain files in the plan's base: f.txt and g.txt are committed
// on main and the plan's branch rebased onto it (its tree is clean then). `moveMain` commits on main
// and pushes, as another flow's merge lands; the plan's worktree is not told.
async function movedPlan() {
  const seed = await shippableRepo()
  const { repo, wt } = seed
  addOrigin(repo)
  // the markers the tests read are git's default style, whatever a global merge.conflictStyle says
  repo.git('config', 'merge.conflictStyle', 'merge')
  repo.write('f.txt', 'a\nb\nc\n')
  repo.write('g.txt', '1\n2\n3\n')
  repo.git('add', 'f.txt', 'g.txt')
  repo.git('commit', '-m', 'f and g')
  repo.git('push', 'origin', 'main')
  g(wt, 'fetch', '-q', 'origin', 'main')
  g(wt, 'rebase', '-q', 'origin/main')
  expect(g(wt, 'status', '--porcelain')).toBe('')
  const moveMain = (files: Record<string, string>, message = 'another flow merged'): void => {
    for (const [f, body] of Object.entries(files)) repo.write(f, body)
    repo.git('add', ...Object.keys(files))
    repo.git('commit', '-m', message)
    repo.git('push', 'origin', 'main')
  }
  const run = { planId: seed.planId, hasPr: false, env: {} }
  return { ...seed, moveMain, run }
}

// The reviewed sha ship computes for the tree as it stands (shipMarked's own: the diff over diffBase).
function reviewedNow(repo: TestRepo, wt: string): string {
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error('config')
  const base = diffBase(wt, cfg.value)
  if (!base.ok) throw new Error('no base')
  return diffReviewedSha(wt, base.value)
}

// A ship gate run on the tree as it stands — `stopped`, as ship always stops — and a human's approve
// after it, journaled as state commits on the primary checkout's main. Returns the sha it judged.
function approvedShip(repo: TestRepo, wt: string, planId: string): string {
  const sha = reviewedNow(repo, wt)
  commitEntry(repo, planId, {
    t: 'gate-run', gate: 'ship', artifact: planId, round: 1, run_id: 'rs-1', reviewed_sha: sha,
    prompts_sha: 'p', witness: '0', model: 'm', checks: [], verdicts: [], outcome: 'stopped', standing: 'ship always stops',
  })
  commitEntry(repo, planId, { t: 'human-decision', gate: 'ship', artifact: planId, round: 1, decision: 'approve' })
  return sha
}
const planOf = (repo: TestRepo, planId: string) => findById(loadCanon(repo.root), planId)!

// `witness ship` as a process of its own: crashPoint exits it (9), as a real crash ends one.
const HERE = resolve(import.meta.dirname, '..')
function shipChild(repo: TestRepo, planId: string, env: Record<string, string>): { status: number | null; out: string } {
  const childEnv: NodeJS.ProcessEnv = { ...hermeticEnv({ WITNESS_REGISTRY: 'off', ...env }) }
  delete childEnv.WITNESS_DRIVE
  delete childEnv.WITNESS_RUNNER_TURN
  const r = spawnSync(join(HERE, 'node_modules', '.bin', 'tsx'), [join(HERE, 'src', 'bin.ts'), 'ship', planId],
    { cwd: repo.root, env: childEnv, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

// Each way a move ends with no battery having judged the moved tree, as the next ship run meets it.
// `work` is the plan's uncommitted work, in place before the approval; `move` ends the move.
type Moved = Awaited<ReturnType<typeof movedPlan>>
const MOVES: Record<string, { work: (p: Moved) => void; move: (p: Moved, env: Record<string, string>) => Promise<void> }> = {
  // a clean carry: the rebase moved the plan onto the new base, the uncommitted work carried across
  // (the gate phase's move, ended before its battery ran)
  'carry-only rebase': {
    work: () => {},
    move: async (p) => {
      p.moveMain({ 'm.txt': 'main\n' })
      expect(rebaseIfMoved(p.wt, p.repo.root, 'main', p.run)).toEqual({ ok: true, value: 'rebased' })
      expect(read(p.wt, 'g.txt')).toBe('1\n2\nWORK\n')
      expect(read(p.wt, 'm.txt')).toBe('main\n')
    },
  },
  // the carry clashed (exit 1, row 77); the session resolves the file and stages it
  'resolved clash': {
    work: (p) => put(p.wt, 'f.txt', 'a\nPLAN\nc\n'),
    move: async (p, env) => {
      p.moveMain({ 'f.txt': 'a\nMAIN\nc\n' })
      const r = await p.repo.cli(['ship', p.planId], { env })
      expect(r.code, r.stderr).toBe(1)
      expect(r.stderr).toMatch(/,textual-conflict,/)
      put(p.wt, 'f.txt', 'a\nMAIN\nPLAN\nc\n')
      g(p.wt, 'add', 'f.txt')
      expect(clashLeft(p.wt, p.planId, 'main')).toBeUndefined()
    },
  },
  // putting the carry back was refused (an untracked file where it writes one): carry-pending, the
  // work kept in the carry ref; the session moves its file aside, and step 0 finishes the move
  'refused apply': {
    work: (p) => {
      put(p.wt, 'n.txt', 'the plan\'s new file\n')
      g(p.wt, 'add', 'n.txt')
    },
    move: async (p, env) => {
      hook(p.wt, 'pre-rebase', once(p.wt, p.planId, 'echo "the session\'s own" > n.txt'))
      p.moveMain({ 'm.txt': 'main\n' })
      const r = await p.repo.cli(['ship', p.planId], { env })
      expect(r.code, r.stderr).toBe(2)
      expect(r.stderr).toMatch(/,carry-pending,/)
      expect(hasCarry(p.wt, p.planId)).toBe(true)
      rmSync(join(p.wt, 'n.txt'))
      expect(finishMove(p.repo.root, p.wt, p.planId)).toEqual({ ok: true, value: 'finished' })
      expect(staged(p.wt, 'n.txt')).toBe('the plan\'s new file')
      expect(read(p.wt, 'g.txt')).toBe('1\n2\nWORK\n')
      expect(hasCarry(p.wt, p.planId)).toBe(false)
    },
  },
}

// Each refusal of the carry, forced through `witness ship` as the design's table names it. `setup`
// leaves the state; `forced` is the one ship run that refuses with the rule.
type Forced = { p: Moved; forced: () => ReturnType<TestRepo['cli']> }
const REFUSALS: Record<string, (env: Record<string, string>) => Promise<Forced>> = {
  // the carry re-applied onto the moved base clashes (step 7)
  'textual-conflict': async (env) => {
    const p = await movedPlan()
    put(p.wt, 'f.txt', 'a\nPLAN\nc\n')
    p.moveMain({ 'f.txt': 'a\nMAIN\nc\n' })
    return { p, forced: () => p.repo.cli(['ship', p.planId], { env }) }
  },
  // the clash left unresolved, met by ship's first check at the next run (§4.1.2)
  'clash-unresolved': async (env) => {
    const p = await movedPlan()
    put(p.wt, 'f.txt', 'a\nPLAN\nc\n')
    p.moveMain({ 'f.txt': 'a\nMAIN\nc\n' })
    const first = await p.repo.cli(['ship', p.planId], { env })
    expect(first.code, first.stderr).toBe(1)
    expect(g(p.wt, 'status', '--porcelain')).toMatch(/^UU f\.txt$/m)
    return { p, forced: () => p.repo.cli(['ship', p.planId], { env }) }
  },
  // a session's own merge, not yet committed, when the base moved (step 2)
  'operation-in-progress': async (env) => {
    const p = await movedPlan()
    g(p.wt, 'branch', 'side')
    g(p.wt, 'checkout', '-q', 'side')
    put(p.wt, 's.txt', 'side\n')
    g(p.wt, 'add', 's.txt')
    g(p.wt, 'commit', '-qm', 'side')
    g(p.wt, 'checkout', '-q', '-')
    g(p.wt, 'merge', '--no-ff', '--no-commit', 'side')
    p.moveMain({ 'm.txt': 'main\n' })
    return { p, forced: () => p.repo.cli(['ship', p.planId], { env }) }
  },
  // an intent-to-add entry, which git stash create cannot capture (step 4, P14)
  'carry-refused': async (env) => {
    const p = await movedPlan()
    put(p.wt, 'ita.txt', 'intent\n')
    g(p.wt, 'add', '-N', 'ita.txt')
    p.moveMain({ 'm.txt': 'main\n' })
    return { p, forced: () => p.repo.cli(['ship', p.planId], { env }) }
  },
  // the put-back refused: an untracked file where the carry writes one appears after the capture
  'carry-pending': async (env) => {
    const p = await movedPlan()
    put(p.wt, 'n.txt', 'the plan\'s new file\n')
    g(p.wt, 'add', 'n.txt')
    hook(p.wt, 'pre-rebase', once(p.wt, p.planId, 'echo "the session\'s own" > n.txt'))
    p.moveMain({ 'm.txt': 'main\n' })
    return { p, forced: () => p.repo.cli(['ship', p.planId], { env }) }
  },
  // the moved base adds a file the worktree holds untracked (§4.1.5): refused before anything moves
  'rebase-refused': async (env) => {
    const p = await movedPlan()
    put(p.wt, 'n.txt', 'the session\'s own\n')
    p.moveMain({ 'n.txt': 'main\n' })
    return { p, forced: () => p.repo.cli(['ship', p.planId], { env }) }
  },
  // the index's lock, held as the rebase starts, after the carry is captured (steps 5–7)
  'index-locked': async (env) => {
    const p = await movedPlan()
    put(p.wt, 'g.txt', '1\n2\nWORK\n')
    hook(p.wt, 'pre-rebase', once(p.wt, p.planId, ': > "$(git rev-parse --git-path index.lock)"'))
    p.moveMain({ 'm.txt': 'main\n' })
    return { p, forced: () => p.repo.cli(['ship', p.planId], { env }) }
  },
}
const TABLE_RULES = Object.keys(REFUSALS)

describe('ship re-gates a tree no battery judged since the move (row 243, §4.1.1 step 9)', () => {
  it.each(Object.keys(MOVES))('an approved ship gate with no PR re-gates after a %s (P32)', async (move) => {
    const p = await movedPlan()
    const { repo, wt, planId } = p
    const { scenario, env } = harness()
    put(wt, 'g.txt', '1\n2\nWORK\n')
    MOVES[move]!.work(p)
    const before = approvedShip(repo, wt, planId)
    // the approval stands for the tree it judged: with nothing moved, it routes to the PR
    expect(shipPhase(planOf(repo, planId), readStream(repo.root, planId), before, false)).toBe('pr')
    await MOVES[move]!.move(p, env)
    // the move is done: the base no longer reads as moved, but the reviewed sha's base term moved
    // with it, so the approval no longer describes this tree
    expect(baseMoved(wt, repo.root, 'main')).toBe(false)
    const reviewedShaAfterMove = reviewedNow(repo, wt)
    expect(reviewedShaAfterMove).not.toBe(before)
    expect(shipPhase(planOf(repo, planId), readStream(repo.root, planId), reviewedShaAfterMove, false)).toBe('gate')
    // and `witness ship` re-gates: a second battery judges the moved tree; nothing is committed,
    // pushed or opened as a PR on the old approval
    const at = head(wt)
    const r = await repo.cli(['ship', planId], { env })
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1)
    const runs = gateRuns(readStream(repo.root, planId), 'ship')
    expect(runs).toHaveLength(2)
    expect(runs[1]!.reviewed_sha).toBe(reviewedShaAfterMove)
    expect(ghCalls(scenario)).not.toContain('pr create')
    expect(planOf(repo, planId).meta.pr).toBeUndefined()
    expect(head(wt)).toBe(at)
  }, 300_000)

  it('a state-only advance keeps the approval: shipPhase pr', async () => {
    const { repo, wt, planId } = await movedPlan()
    const { scenario, env } = harness()
    put(wt, 'g.txt', '1\n2\nWORK\n')
    const before = approvedShip(repo, wt, planId)
    // the approval's own state commits reach origin/main, as `witness sync` pushes them
    repo.git('push', 'origin', 'main')
    g(wt, 'fetch', '-q', 'origin', 'main')
    expect(tryG(wt, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')).toBe(false)
    // bookkeeping, not base movement: the base reads as unmoved, and the reviewed sha is the approved one
    expect(baseMoved(wt, repo.root, 'main')).toBe(false)
    expect(reviewedNow(repo, wt)).toBe(before)
    expect(shipPhase(planOf(repo, planId), readStream(repo.root, planId), before, false)).toBe('pr')
    // `witness ship` opens the PR on that approval, with no second battery: no re-gate loop
    const r = await repo.cli(['ship', planId], { env })
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(ghCalls(scenario)).toContain('pr create')
    expect(gateRuns(readStream(repo.root, planId), 'ship')).toHaveLength(1)
    expect(planOf(repo, planId).meta.pr).toBe(1)
  }, 300_000)
})

describe('every refusal of the carry exits and records per §4.1.3\'s table (row 243)', () => {
  it.each([
    ['textual-conflict', 1, undefined], ['clash-unresolved', 2, undefined], ['operation-in-progress', 2, undefined],
    ['carry-refused', 2, undefined], ['carry-pending', 2, undefined], ['rebase-refused', 2, undefined],
    ['index-locked', 3, 'transient'],
  ] as const)('%s exits %i and records %s', async (rule, code, outcome) => {
    const { env } = harness()
    const { p, forced } = await REFUSALS[rule]!(env)
    const { repo, wt, planId } = p
    const recorded = shipOutcomes(repo.root, planId).length
    const r = await forced()
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(code)
    // the refusal is this rule's and no other of the table's
    expect(r.stderr).toContain(`,${rule},`)
    for (const other of TABLE_RULES.filter((x) => x !== rule)) expect(r.stderr).not.toContain(`,${other},`)
    // read the plan stream's last ship-outcome: a new one only where the table records one
    expect(lastShipOutcome(repo.root, planId)?.outcome).toBe(outcome)
    expect(shipOutcomes(repo.root, planId)).toHaveLength(recorded + (outcome === undefined ? 0 : 1))
    if (outcome !== undefined) {
      expect(lastShipOutcome(repo.root, planId)).toMatchObject({ head: head(wt), reason: expect.stringMatching(/git lock/) })
      // the carry ref keeps the work across the lock (§4.1.3: after step 4 it is kept)
      expect(hasCarry(wt, planId)).toBe(true)
    }
    // no battery ran over any of them
    expect(gateRuns(readStream(repo.root, planId), 'ship')).toHaveLength(0)
  }, 300_000)

  it('a held lock met at step 0 exits 3 and records transient too, the carry ref kept', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    const { env } = harness()
    put(wt, 'g.txt', '1\n2\nWORK\n')
    moveMain({ 'm.txt': 'main\n' })
    // a ship run crashes after the reset: the plan's work is only in the carry ref
    const crashed = shipChild(repo, planId, { ...env, WITNESS_CRASH_AFTER: 'carry-after-reset' })
    expect(crashed.status, crashed.out).toBe(9)
    expect(hasCarry(wt, planId)).toBe(true)
    expect(read(wt, 'g.txt')).toBe('1\n2\n3\n')
    // and the index's lock is held when the next ship run finishes the move
    writeFileSync(resolve(wt, g(wt, 'rev-parse', '--git-path', 'index.lock')), '')
    const recorded = shipOutcomes(repo.root, planId).length
    const r = await repo.cli(['ship', planId], { env })
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(3)
    expect(r.stderr).toContain(',index-locked,')
    expect(shipOutcomes(repo.root, planId)).toHaveLength(recorded + 1)
    expect(lastShipOutcome(repo.root, planId)).toMatchObject({ outcome: 'transient', head: head(wt), reason: expect.stringMatching(/git lock/) })
    expect(hasCarry(wt, planId)).toBe(true)
    expect(gateRuns(readStream(repo.root, planId), 'ship')).toHaveLength(0)
  }, 300_000)
})
