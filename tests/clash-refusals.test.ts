import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../src/gates/index.js'
import { cliAct } from '../src/act.js'
import { carryRef, keepCarry, remedyLine, unmergedPaths } from '../src/carry.js'
import { clashGuard, clashLeft } from '../src/clash.js'
import { loadConfig, type Config } from '../src/config.js'
import { diffBase } from '../src/evidence.js'
import { readStream } from '../src/journal.js'
import { diffReviewedSha } from '../src/reviewed.js'
import { shellWord } from '../src/toon.js'
import { worktreePath } from '../src/worktree.js'
import {
  addOrigin, callCount, commitEntry, fakeScenario, fixtureEnv, gateEnv, patchConfig, putVerdict, shippableRepo, writePlan, type TestRepo,
} from './helpers.js'

// Row 243 (design §4.1.2 "Who reads it", "The refusal"). An unresolved clash in a plan's worktree
// is refused, exit 2, by every gate on that worktree (implement and ship), by test-evidence and
// verify-red, by `witness turn` there, and by ship — first, again before its commit, and again
// before pushApproved's `git add -A` — so a clash never reaches a reviewer, an evidence entry or a
// commit. Ship records nothing for it (§4.1.3's table).

// The guard as ship and the gate call it, with a hook a test may hang on its nth call: what a hook
// does to the tree happens after every earlier ask and before this one, as a clash arriving
// between two of ship's checks would.
const guard = vi.hoisted(() => ({ calls: 0, before: [] as Array<(() => void) | undefined> }))
vi.mock('../src/clash.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/clash.js')>()
  return {
    ...real,
    clashGuard: (...args: Parameters<typeof real.clashGuard>) => {
      const n = guard.calls++
      guard.before[n]?.()
      return real.clashGuard(...args)
    },
  }
})
// Counted from here: the fixture's own evidence runs ask the guard too.
const armGuard = (before: Array<(() => void) | undefined> = []): void => {
  guard.calls = 0
  guard.before = before
}
beforeEach(() => armGuard())

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const porcelain = (wt: string): string =>
  execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' })
const CLEAN = {
  coverage: ['.gitignore', 'package.json', 'src/token.ts', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' })),
  findings: [],
}
const shipRecords = (repo: TestRepo, planId: string) => readStream(repo.root, planId).filter((e) => e.t === 'ship-outcome')
const ghCalls = (scenario: string): string => {
  try { return readFileSync(join(scenario, 'gh-calls'), 'utf8') } catch { return '' }
}

// shippableRepo with an origin, `names` committed on the plan's branch, and the plan's uncommitted
// work captured as a carry. The base then moves under it, the carry is kept as step 7 keeps a
// clash's backup (`refs/witness/kept/<plan>/1`, listing the names), and putting the carry back
// clashes on every name — git's own stash-apply conflict: UU <name>. `apply: false` leaves the tree
// clean and hands the put-back to the test (`clash`).
async function clashedShippable(names: string[] = ['f.txt'], opts: { apply?: boolean } = {}) {
  const seed = await shippableRepo()
  addOrigin(seed.repo)
  const { wt, planId } = seed
  const put = (body: string) => { for (const n of names) writeFileSync(join(wt, n), body) }
  put('a\nb\nc\n')
  g(wt, '--literal-pathspecs', 'add', '--', ...names)
  g(wt, 'commit', '-qm', 'the files')
  put('a\nPLAN\nc\n')
  const carry = g(wt, 'stash', 'create')
  g(wt, '--literal-pathspecs', 'checkout', '--', ...names)
  put('a\nBASE\nc\n')
  g(wt, '--literal-pathspecs', 'add', '--', ...names)
  g(wt, 'commit', '-qm', 'the base moves')
  g(wt, 'update-ref', carryRef(planId), carry)
  const kept = keepCarry(wt, planId, carry, names)
  if (!kept.ok) throw new Error(`keepCarry: ${JSON.stringify(kept.violations)}`)
  const clash = (): void => {
    const r = spawnSync('git', ['stash', 'apply', carry], { cwd: wt, encoding: 'utf8' })
    if (!/CONFLICT/.test(r.stdout)) throw new Error(`no clash: ${r.stdout}${r.stderr}`)
  }
  if (opts.apply !== false) clash()
  return { ...seed, carry, clash }
}

// A ship gate run on the plan, journaled as state: `stopped` with a human's approve after it routes
// ship to its pr phase; `passed` on the tree as it stands settles the gate for the watch.
function shipGated(repo: TestRepo, wt: string, planId: string, outcome: 'stopped' | 'passed'): void {
  const cfg = loadConfig(repo.root)
  if (!cfg.ok) throw new Error('cfg')
  const base = diffBase(wt, cfg.value)
  if (!base.ok) throw new Error('base')
  commitEntry(repo, planId, {
    t: 'gate-run', gate: 'ship', artifact: planId, round: 1, run_id: 'rs-1', reviewed_sha: diffReviewedSha(wt, base.value),
    prompts_sha: 'p', witness: '0', model: 'm', checks: [], verdicts: [], outcome,
  })
  if (outcome === 'stopped') commitEntry(repo, planId, { t: 'human-decision', gate: 'ship', artifact: planId, round: 1, decision: 'approve' })
}

describe('clashGuard asks the plan\'s worktree (row 243)', () => {
  // A primary checkout whose own index holds a stash-apply clash on p.md, as a human's own work there
  // might leave it, over a base commit holding f.md; plan p1's worktree is asked, never the primary.
  function clashedPrimary(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'witness-guard-')))
    g(root, 'init', '-q', '-b', 'main')
    g(root, 'config', 'user.name', 'test')
    g(root, 'config', 'user.email', 'test@example.com')
    g(root, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(root, '.gitignore'), '.witness/\n')
    writeFileSync(join(root, 'f.md'), 'a\nb\nc\n')
    writeFileSync(join(root, 'p.md'), 'a\nb\nc\n')
    g(root, 'add', '.')
    g(root, 'commit', '-qm', 'base')
    writeFileSync(join(root, 'p.md'), 'a\nMINE\nc\n')
    const sha = g(root, 'stash', 'create')
    g(root, 'checkout', '--', 'p.md')
    writeFileSync(join(root, 'p.md'), 'a\nTHEIRS\nc\n')
    g(root, 'commit', '-qam', 'moved')
    expect(spawnSync('git', ['stash', 'apply', sha], { cwd: root, encoding: 'utf8' }).stdout).toMatch(/CONFLICT/)
    return root
  }
  const cfg = { ship: { branch: 'main' } } as Config

  it('answers nothing with no worktree, nor for a leftover directory, where git would answer from the primary repository', () => {
    const root = clashedPrimary()
    expect(clashGuard(root, cfg, 'p1')).toBeUndefined()
    // a carry ref left standing, and a directory at the worktree's path that is no worktree
    g(root, 'update-ref', carryRef('p1'), g(root, 'rev-parse', 'HEAD'))
    const dir = worktreePath(root, 'p1')
    mkdirSync(dir, { recursive: true })
    expect(clashLeft(dir, 'p1', 'main')).toEqual({ kind: 'carry', ref: carryRef('p1') })
    expect(clashGuard(root, cfg, 'p1')).toBeUndefined()
  })

  it('answers the rows of the plan\'s own worktree, never the primary checkout\'s', () => {
    const root = clashedPrimary()
    const wt = worktreePath(root, 'p1')
    g(root, 'worktree', 'add', '-q', '-b', 'witness/p1', wt, 'HEAD~1')
    expect(clashGuard(root, cfg, 'p1')).toBeUndefined()
    writeFileSync(join(wt, 'f.md'), 'a\nPLAN\nc\n')
    const sha = g(wt, 'stash', 'create')
    g(wt, 'checkout', '--', 'f.md')
    writeFileSync(join(wt, 'f.md'), 'a\nBASE\nc\n')
    g(wt, 'commit', '-qam', 'base')
    expect(spawnSync('git', ['stash', 'apply', sha], { cwd: wt, encoding: 'utf8' }).stdout).toMatch(/CONFLICT/)
    const rows = clashGuard(root, cfg, 'p1')
    expect(rows?.map((x) => [x.field, x.rule, x.got])).toEqual([[shellWord('f.md'), 'clash-unresolved', 'unmerged (UU)']])
  })
})

describe('every gate, evidence run, turn and ship refuses an unresolved clash (row 243)', () => {
  it('gate implement and gate ship refuse clash-unresolved, exit 2, before judging; nothing journaled', async () => {
    const { repo, planId } = await clashedShippable()
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const before = readStream(repo.root, planId).length
    for (const gate of ['implement', 'ship']) {
      const r = await repo.cli(['gate', gate, planId], { env: gateEnv(scenario) })
      expect(r.code).toBe(2)
      expect(r.stderr).toMatch(/clash-unresolved/)
      expect(r.stderr).toContain(`${shellWord('f.txt')},clash-unresolved,unmerged (UU),`)
      expect(r.stderr).toContain(remedyLine(['git', 'add', '--', 'f.txt']))
      // refused before judge: no autonomy line, no battery
      expect(r.stdout).toBe('')
    }
    expect(callCount(scenario)).toBe(0)
    expect(readStream(repo.root, planId).length).toBe(before)
  }, 240_000)

  it('a carry ref present refuses the gate with `witness ship <plan>` first and no file of its own', async () => {
    const { repo, wt, planId } = await shippableRepo()
    writeFileSync(join(wt, 'src/token.ts'), '// the plan\'s work, mid-move\n')
    const carry = g(wt, 'stash', 'create')
    g(wt, 'update-ref', carryRef(planId), carry)
    g(wt, 'checkout', '--', 'src/token.ts')
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const before = readStream(repo.root, planId).length
    const r = await repo.cli(['gate', 'implement', planId], { env: gateEnv(scenario) })
    expect(r.code).toBe(2)
    const rows = r.stderr.split('\n').filter((l) => l.includes(',clash-unresolved,'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.startsWith(`  ${carryRef(planId)},clash-unresolved,`)).toBe(true)
    expect(rows[0]).toContain(`${cliAct('ship', planId).line} — it finishes the move first`)
    expect(r.stderr).toContain(`run: ${cliAct('ship', planId).line}`)
    expect(r.stderr).not.toContain('unmerged')
    expect(callCount(scenario)).toBe(0)
    expect(readStream(repo.root, planId).length).toBe(before)
  }, 180_000)

  it('test-evidence and verify-red refuse with exit 2 and write no evidence entry', async () => {
    const { repo, wt, planId } = await clashedShippable()
    const before = readStream(repo.root, planId)
    const evidence = (es: typeof before) => es.filter((e) => e.t === 'test-evidence').length
    for (const argv of [
      ['test-evidence', planId, '--phase', 'green', '--step', 's1'],
      ['test-evidence', planId, '--phase', 'red', '--step', 's1'],
      ['verify-red', planId, '--step', 's1'],
    ]) {
      const r = await repo.cli(argv, { cwd: wt, env: fixtureEnv() })
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(`${shellWord('f.txt')},clash-unresolved,unmerged (UU),`)
      // refused before any run: no outcome line, and the tree verify-red would set aside is untouched
      expect(r.stdout).not.toMatch(/^(test-evidence|verify-red):/m)
      expect(porcelain(wt)).toMatch(/^UU f\.txt$/m)
    }
    const after = readStream(repo.root, planId)
    expect(evidence(after)).toBe(evidence(before))
    expect(after.length).toBe(before.length)
  }, 240_000)

  it('the clash is asked first: before steps-open in the gate and in ship, before the step check in test-evidence', async () => {
    const { repo, wt, planId } = await clashedShippable()
    // an amendment opens s2, which the gate and ship would otherwise refuse as steps-open
    const amended = await writePlan(repo, planId, {
      steps: [
        { id: 's1', title: 'rotate tokens on refresh', criteria: ['ac-rotate'] },
        { id: 's2', title: 'added by an amendment', criteria: ['ac-rotate'] },
      ],
    }, '## Step: s1\nImplement rotation with TDD.\n\n## Step: s2\nAdded after the gate.\n')
    expect(amended.code).toBe(0)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    for (const [argv, env, not] of [
      [['gate', 'implement', planId], gateEnv(scenario), 'steps-open'],
      [['ship', planId], gateEnv(scenario), 'steps-open'],
      [['test-evidence', planId, '--phase', 'red', '--step', 's9'], fixtureEnv(), 'unknown-step'],
      [['verify-red', planId, '--step', 's9'], fixtureEnv(), 'unknown-step'],
    ] as const) {
      const r = await repo.cli([...argv], { cwd: argv[0] === 'test-evidence' || argv[0] === 'verify-red' ? wt : repo.root, env })
      expect(r.code, argv.join(' ')).toBe(2)
      expect(r.stderr).toContain(`${shellWord('f.txt')},clash-unresolved,unmerged (UU),`)
      expect(r.stderr).not.toContain(not)
    }
    expect(callCount(scenario)).toBe(0)
  }, 240_000)

  it('witness turn in the plan worktree refuses with exit 2 and never runs the command; at the primary root it runs', async () => {
    const { repo, wt } = await clashedShippable()
    const dir = fakeScenario()
    const script = join(dir, 'mark.cjs')
    writeFileSync(script, "require('node:fs').appendFileSync(process.argv[2], process.cwd() + '\\n')")
    const marker = join(dir, 'ran')
    for (const cwd of [wt, join(wt, 'src')]) {
      const r = await repo.cli(['turn', '--', process.execPath, script, marker], { cwd })
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(`${shellWord('f.txt')},clash-unresolved,unmerged (UU),`)
      expect(existsSync(marker)).toBe(false)
    }
    // at the primary root no plan's kept refs apply: the command runs
    const r = await repo.cli(['turn', '--', process.execPath, script, marker], { cwd: repo.root })
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain('clash-unresolved')
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1)
  }, 180_000)

  it('a primary root config that will not load still asks the guard, from the run\'s own copy (D192)', async () => {
    const { repo, wt, planId } = await clashedShippable()
    patchConfig(repo, { session: { contextLimit: 0 } })
    const dir = fakeScenario()
    const script = join(dir, 'mark.cjs')
    writeFileSync(script, "require('node:fs').appendFileSync(process.argv[2], 'ran\\n')")
    const marker = join(dir, 'ran')
    for (const argv of [['test-evidence', planId, '--phase', 'green', '--step', 's1'], ['turn', '--', process.execPath, script, marker]]) {
      const r = await repo.cli(argv, { cwd: wt, env: fixtureEnv() })
      expect(r.code, argv[0]).toBe(2)
      expect(r.stderr).toContain(`${shellWord('f.txt')},clash-unresolved,unmerged (UU),`)
      expect(r.stderr).not.toContain('session.contextLimit')
    }
    expect(existsSync(marker)).toBe(false)
    // a worktree whose own config will not load: the guard cannot be asked, so the turn is refused
    // with the config's rows, and the command never runs
    writeFileSync(join(wt, 'witness.config.yaml'), 'schema: [\n')
    const r = await repo.cli(['turn', '--', process.execPath, script, marker], { cwd: wt })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('refused[')
    expect(r.stderr).not.toContain('clash-unresolved')
    expect(existsSync(marker)).toBe(false)
  }, 180_000)

  it('ship refuses before its commit and before pushApproved\'s add; f.txt stays UU', async () => {
    const { repo, wt, planId } = await clashedShippable()
    // an approved ship gate: without the guard, the pr phase would `git add -A` the markers and commit them
    shipGated(repo, wt, planId, 'stopped')
    const scenario = fakeScenario()
    const head = g(wt, 'rev-parse', 'HEAD')
    const before = readStream(repo.root, planId).length
    armGuard()
    const r = await repo.cli(['ship', planId], { env: gateEnv(scenario, { WITNESS_SHIP_WATCH_MS: '1' }) })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(`${shellWord('f.txt')},clash-unresolved,unmerged (UU),`)
    expect(porcelain(wt)).toMatch(/^UU f\.txt$/m)
    expect(g(wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(ghCalls(scenario)).toBe('')
    // ship records nothing for a clash (§4.1.3)
    expect(readStream(repo.root, planId).length).toBe(before)
    expect(guard.calls).toBe(1)
  }, 240_000)

  it('a clash that arrives after ship\'s first check is refused before the pr phase\'s commit', async () => {
    const { repo, wt, planId, clash } = await clashedShippable(['f.txt'], { apply: false })
    shipGated(repo, wt, planId, 'stopped')
    const scenario = fakeScenario()
    const head = g(wt, 'rev-parse', 'HEAD')
    armGuard([undefined, clash])
    const r = await repo.cli(['ship', planId], { env: gateEnv(scenario, { WITNESS_SHIP_WATCH_MS: '1' }) })
    expect(guard.calls).toBe(2)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(`${shellWord('f.txt')},clash-unresolved,unmerged (UU),`)
    expect(porcelain(wt)).toMatch(/^UU f\.txt$/m)
    expect(g(wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(ghCalls(scenario)).not.toContain('pr create')
    expect(shipRecords(repo, planId)).toEqual([])
  }, 240_000)

  it('a clash that arrives after ship\'s first check is refused before pushApproved\'s add, and nothing is recorded', async () => {
    const { repo, wt, planId, clash } = await clashedShippable(['f.txt'], { apply: false })
    repo.setMeta(planId, { pr: 7 })
    shipGated(repo, wt, planId, 'passed')
    const scenario = fakeScenario()
    const head = g(wt, 'rev-parse', 'HEAD')
    armGuard([undefined, clash])
    const r = await repo.cli(['ship', planId], { env: gateEnv(scenario, { WITNESS_SHIP_WATCH_MS: '1' }) })
    expect(guard.calls).toBe(2)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(`${shellWord('f.txt')},clash-unresolved,unmerged (UU),`)
    expect(porcelain(wt)).toMatch(/^UU f\.txt$/m)
    expect(g(wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(ghCalls(scenario)).not.toContain('pr checks')
    expect(shipRecords(repo, planId)).toEqual([])
  }, 240_000)

  // NTFS refuses `:x.md`, so the names are made only where a file can bear them.
  it.skipIf(process.platform === 'win32')('a file named -x.md gets its own row, and its remedy runs `git add -- -x.md` (Review Focus)', async () => {
    const names = ['-x.md', '[x].md', ':x.md', 'a b.md']
    const { repo, wt, planId } = await clashedShippable(names)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    const r = await repo.cli(['gate', 'implement', planId], { env: gateEnv(scenario) })
    expect(r.code).toBe(2)
    const rows = r.stderr.split('\n').filter((l) => l.includes(',clash-unresolved,'))
    expect(rows).toHaveLength(names.length)
    for (const n of names) {
      const row = rows.find((l) => l.startsWith(`  ${shellWord(n)},clash-unresolved,unmerged (UU),`))
      expect(row, n).toBeDefined()
      expect(row).toContain(remedyLine(['git', 'add', '--', n]))
      expect(r.stderr).toContain(remedyLine(['git', 'add', '--', n]))
    }
    // a name git reads as pathspec magic or a glob is staged literally (S1-4, S1-7)
    for (const n of ['[x].md', ':x.md']) expect(remedyLine(['git', 'add', '--', n])).toContain('git --literal-pathspecs add -- ')
    for (const n of ['-x.md', 'a b.md']) expect(remedyLine(['git', 'add', '--', n])).not.toContain('--literal-pathspecs')
    expect(callCount(scenario)).toBe(0)
    // the printed line, run as printed once the markers are resolved, stages -x.md and only it
    writeFileSync(join(wt, '-x.md'), 'a\nPLAN\nBASE\nc\n')
    execFileSync('/bin/sh', ['-c', remedyLine(['git', 'add', '--', '-x.md'])], { cwd: wt })
    expect(unmergedPaths(wt).map((u) => u.path).sort()).toEqual(['[x].md', ':x.md', 'a b.md'].sort())
  }, 180_000)
})
