import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planChangeSet } from '../src/change-set.js'
import { loadConfig } from '../src/config.js'
import { contentSha } from '../src/content-sha.js'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { cliAct } from '../src/act.js'
import { checkoutRoot, diffBase } from '../src/evidence.js'
import { putBackHeld, standingHeld } from '../src/held.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import type { TestRepo } from './helpers.js'
import {
  TOKEN_FIXED, callCount, crashVerifyRed, escapeRe, fakeCtx, fakeScenario, fixtureEnv, gateEnv, heldWorktree, putVerdict,
  replantHeld, shippableRepo, unwrap, worktreeState,
} from './helpers.js'

function treeClean(files: string[]) {
  return {
    coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })),
    findings: [],
  }
}

describe('the held-work guard (row 247, #92)', () => {
  it('test-evidence puts the held work back before its run, so no red is recorded against the base', async () => {
    const { repo, wt, planId, ref, before } = await heldWorktree('stepped')
    const res = await repo.cli(['test-evidence', planId, '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(res.stdout).toMatch(new RegExp(`^held-work: ${escapeRe(ref)} — .*src/token\\.ts`, 'm'))
    expect(worktreeState(repo, wt, ['src/token.ts', 'src/extra.ts'])).toEqual(before)
    expect(standingHeld(repo.root, planId)).toBeUndefined()
    const reds = readStream(repo.root, planId).filter((e) => e.t === 'test-evidence')
    expect(reds).toHaveLength(1)
    expect(reds[0]!.vacuous).toBe(true)          // the fix was back: the run saw it pass, never the base's red
    expect(res.code).toBe(1)
  })

  it('test-evidence refuses verify-red-pending when a held file changed since, and journals nothing', async () => {
    const { repo, wt, planId, ref } = await heldWorktree('stepped')
    writeFileSync(join(wt, 'src/token.ts'), 'a session edit after the crash\n')
    const res = await repo.cli(['test-evidence', planId, '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('verify-red-pending')
    expect(res.stderr).toContain(ref)
    expect(res.stderr).toMatch(/Then witness next/)
    expect(standingHeld(repo.root, planId)?.sha).toBeDefined()
    expect(readStream(repo.root, planId).filter((e) => e.t === 'test-evidence')).toEqual([])
  })

  const SEE = ['turn', '--', process.execPath, '-e', "require('fs').writeFileSync('seen.txt', require('fs').readFileSync('src/token.ts'))"]

  it('witness turn puts the held work back before the command runs', async () => {
    const { repo, wt, before } = await heldWorktree('stepped')
    const res = await repo.cli(SEE, { cwd: wt, env: fixtureEnv() })
    expect(res.code).toBe(0)
    expect(res.stdout).toMatch(/^held-work: /m)
    expect(readFileSync(join(wt, 'seen.txt'), 'utf8')).toBe(before['src/token.ts'])
  })

  it.each([
    ['a held file edited since', (_repo: TestRepo, wt: string, _planId: string) => writeFileSync(join(wt, 'src/token.ts'), 'a session edit\n'), 'neither put back nor overwritten'],
    ['a holder still running', (repo: TestRepo, _wt: string, planId: string) => replantHeld(repo, planId, (m) => m.replace(/^pid: \d+$/m, `pid: ${process.ppid}`)), `pid ${process.ppid}`],
  ])('witness turn refuses, and never runs the command, with %s', async (_what, arrange, says) => {
    const { repo, wt, planId } = await heldWorktree('stepped')
    arrange(repo, wt, planId)
    const res = await repo.cli(SEE, { cwd: wt, env: fixtureEnv() })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('verify-red-pending')
    expect(res.stderr).toContain(says)
    expect(existsSync(join(wt, 'seen.txt'))).toBe(false)
  })

  // shippableRepo's plan, its work tweaked uncommitted, then a verify-red that dies with it set aside.
  // `files` and `judged` are read before the crash: afterwards the tree holds base versions.
  async function crashedShippable() {
    const { repo, wt, planId } = await shippableRepo()
    const tweaked = `${TOKEN_FIXED}// uncommitted tweak\n`
    writeFileSync(join(wt, 'src/token.ts'), tweaked)
    const cfg = unwrap(loadConfig(repo.root))
    const judged = contentSha(repo.root, loadCanon(repo.root), cfg, 'implement', planId)
    const files = planChangeSet(wt, unwrap(diffBase(wt, cfg)))
    expect(await crashVerifyRed(wt, planId, ['--step', 's1'])).toBe(9)
    return { repo, wt, planId, cfg, judged, files, tweaked }
  }
  const gateRuns = (repo: TestRepo, planId: string) =>
    readStream(repo.root, planId).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]

  it('gate implement puts the held work back before it judges, and judges the plan\'s own tree', async () => {
    const { repo, planId, cfg, judged, files } = await crashedShippable()
    expect(contentSha(repo.root, loadCanon(repo.root), cfg, 'implement', planId)).toBeUndefined()
    const scenario = fakeScenario()
    putVerdict(scenario, treeClean(files))
    const out: string[] = []
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario), out: (l) => out.push(l) })
    expect(await runGate(ctx, 'implement', planId, { fresh: false, manual: false })).toBe(0)
    expect(out.join('\n')).toMatch(/^held-work: /m)
    expect(gateRuns(repo, planId).at(-1)!.reviewed_sha).toBe(judged)
  })

  it('gate implement refuses verify-red-pending when the work cannot go back: no battery, no run journaled', async () => {
    const { repo, wt, planId } = await crashedShippable()
    writeFileSync(join(wt, 'src/token.ts'), 'a session edit\n')
    const runsBefore = gateRuns(repo, planId).length
    const scenario = fakeScenario()
    const err: string[] = []
    expect(await runGate(fakeCtx(repo.root, { env: gateEnv(scenario), err: (l) => err.push(l) }), 'implement', planId,
      { fresh: false, manual: false })).toBe(2)
    expect(err.join('\n')).toContain('verify-red-pending')
    expect(callCount(scenario)).toBe(0)
    expect(gateRuns(repo, planId)).toHaveLength(runsBefore)
  })

  it('ship refuses verify-red-pending at its top and records nothing', async () => {
    const { repo, wt, planId } = await crashedShippable()
    writeFileSync(join(wt, 'src/token.ts'), 'a session edit\n')
    const sha = standingHeld(repo.root, planId)!.sha
    const res = await repo.cli(['ship', planId], { env: fixtureEnv() })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('verify-red-pending')
    expect(readStream(repo.root, planId).filter((e) => e.t === 'ship-outcome')).toEqual([])
    expect(standingHeld(repo.root, planId)!.sha).toBe(sha)
  })

  it('ship puts held work back at its top before anything else reads the tree', async () => {
    const { repo, wt, planId, tweaked } = await crashedShippable()
    const scenario = fakeScenario()
    putVerdict(scenario, treeClean(['src/token.ts']))
    const res = await repo.cli(['ship', planId, '--manual'], { env: gateEnv(scenario) })
    expect(res.stdout).toMatch(/^held-work: /m)                 // ship's own exit depends on the phase it reaches; not asserted
    expect(standingHeld(repo.root, planId)).toBeUndefined()
    expect(readFileSync(join(wt, 'src/token.ts'), 'utf8')).toBe(tweaked)
  })

  // Slice 2 review I1: a put-back reads the held ref, then waits on the repo lock; meanwhile another run
  // put it back and set its own work aside under the same ref. The stale read must write nothing.
  it('a put-back whose held ref moved since it was read writes nothing and refuses', async () => {
    const { repo, wt, planId } = await heldWorktree('stepped')
    const stale = standingHeld(repo.root, planId)!
    const moved = replantHeld(repo, planId, (m) => `${m}note: another run's hold\n`)
    expect(moved).not.toBe(stale.sha)
    const laidOut = worktreeState(repo, wt, ['src/token.ts', 'src/extra.ts'])      // the red's tree, as the crash left it
    const r = putBackHeld(unwrap(checkoutRoot(wt)), planId, stale, undefined, cliAct('next'))
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('verify-red-pending')
    expect(worktreeState(repo, wt, ['src/token.ts', 'src/extra.ts'])).toEqual(laidOut)
    expect(standingHeld(repo.root, planId)!.sha).toBe(moved)
  })
})
