import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stateCommit } from '../src/gitio.js'
import { appendEntry, journalRel, type FixCause } from '../src/journal.js'
import { mergeClock, mergesBetween } from '../src/merge-clock.js'
import { lazyStamp } from '../src/stamp.js'
import { loadCanon } from '../src/scan.js'
import { RECAP, fakeCtx, fakeScenario, gateEnv, ghState, hermeticEnv, seededRepo, shippableRepo, type TestRepo } from './helpers.js'

// Row 254. The merge clock orders merges and fix births by witness's own state commits — the
// trailered `merge(<plan>): pr #N` and `recap(<slug>): <class>` subjects — in one git call. A
// transaction completed by `recover` keeps its subject, with ` (recovered)` after it.

const stamp = (repo: TestRepo, plan: string, pr: number, suffix = '') => {
  appendEntry(repo.root, plan, { t: 'status', artifact: plan, from: 'in-progress', to: 'done', cause: 'merge', pr })
  const r = stateCommit(repo.root, [journalRel(plan)], `merge(${plan}): pr #${pr}${suffix}`); if (!r.ok) throw new Error('commit')
}
const recapFix = async (repo: TestRepo, slug: string, cause: FixCause = 'escape') => {
  repo.write('r.json', JSON.stringify({ ...RECAP, effort: slug, class: 'fix', cause }))
  const r = await repo.cli(['recap', '--file', 'r.json'])
  if (r.code !== 0) throw new Error(`recap: ${r.stderr}`)
}
const seedOldFix = (repo: TestRepo, slug: string) => {
  appendEntry(repo.root, slug, { t: 'recap', effort: slug, class: 'fix', goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [] })
  const r = stateCommit(repo.root, [journalRel(slug)], `recap(${slug}): fix`); if (!r.ok) throw new Error('seed')
}
const here = resolve(import.meta.dirname, '..')
const crashed = (cwd: string, argv: string[], env: Record<string, string>) =>
  spawnSync(join(here, 'node_modules', '.bin', 'tsx'), [join(here, 'src', 'bin.ts'), ...argv], { cwd, env: hermeticEnv(env), encoding: 'utf8' })

describe('the merge clock (row 254)', () => {
  it('orders births and merges by the state commits that wrote them', async () => {
    const repo = await seededRepo()                         // recap(auth-hardening): feature
    stamp(repo, 'p1', 1); stamp(repo, 'p2', 2)
    await recapFix(repo, 'late-fix')                        // a real recap birth, with its cause
    const c = mergeClock(repo.root)!
    expect(c.born.get('auth-hardening')! < c.merged.get('p1')!).toBe(true)
    expect(c.merged.get('p1')! < c.merged.get('p2')!).toBe(true)
    expect(c.merged.get('p2')! < c.born.get('late-fix')!).toBe(true)
    expect(c.merges).toEqual([c.merged.get('p1'), c.merged.get('p2')])
  })

  it('the first of two identical merge subjects wins', async () => {
    const repo = await seededRepo()
    stamp(repo, 'p1', 1); stamp(repo, 'p2', 2); stamp(repo, 'p1', 1)
    const c = mergeClock(repo.root)!
    expect(c.merged.get('p1')! < c.merged.get('p2')!).toBe(true)
    expect(c.merges).toHaveLength(2)
  })

  it('a look-alike commit without the trailer is no state commit', async () => {
    const repo = await seededRepo()
    repo.git('commit', '--allow-empty', '-m', 'merge(p9): pr #9')
    repo.git('commit', '--allow-empty', '-m', 'recap(ghost): fix')
    const c = mergeClock(repo.root)!
    expect(c.merged.has('p9')).toBe(false)
    expect(c.born.has('ghost')).toBe(false)
  })

  it('an amendment, a cause and other state commits are never births', async () => {
    const repo = await seededRepo()
    seedOldFix(repo, 'old-fix')
    const at = mergeClock(repo.root)!.born.get('old-fix')
    expect(at).toBeDefined()
    stamp(repo, 'p1', 1)
    repo.write('r.json', JSON.stringify({ ...RECAP, effort: 'old-fix', class: 'fix', cause: 'escape' }))
    expect((await repo.cli(['recap', '--amend', '--file', 'r.json'])).code).toBe(0)
    expect((await repo.cli(['recap', '--effort', 'old-fix', '--cause', 'decision'])).code).toBe(0)
    const c = mergeClock(repo.root)!
    expect(c.born.get('old-fix')).toBe(at)
    expect(c.merged.get('p1')! > at!).toBe(true)
  })

  it('mergesBetween counts the merges strictly between two positions', () => {
    expect(mergesBetween({ merged: new Map(), born: new Map(), merges: [2, 5, 7, 9] }, 2, 9)).toBe(2)
    expect(mergesBetween({ merged: new Map(), born: new Map(), merges: [2, 5, 7, 9] }, 1, 3)).toBe(1)
    expect(mergesBetween({ merged: new Map(), born: new Map(), merges: [] }, 0, 9)).toBe(0)
  })

  it('a repo whose git log fails has no clock', () => {
    expect(mergeClock(join(here, 'no-such-dir-for-the-clock'))).toBeUndefined()
  })

  it('reads a real merge stamp and a real recap', async () => {
    const seed = await shippableRepo()
    seed.repo.setMeta(seed.planId, { pr: 1 })
    const scenario = fakeScenario()
    ghState(scenario, 1, 'MERGED')
    lazyStamp(seed.repo.root, fakeCtx(seed.repo.root, { env: gateEnv(scenario) }), loadCanon(seed.repo.root))
    const c = mergeClock(seed.repo.root)!
    expect(c.merged.has(seed.planId)).toBe(true)
    expect(c.born.get('auth-hardening')! < c.merged.get(seed.planId)!).toBe(true)
  }, 180_000)

  // Slice 2 review F1/F2. A crashed birth or merge stamp completed by `recover` commits its own subject
  // with ` (recovered)`, so the clock still places it.
  it('a recovered birth and a recovered merge stamp keep their place', async () => {
    const repo = await seededRepo({ noRecap: true })
    repo.write('r.json', JSON.stringify({ ...RECAP, effort: 'quick-fix', class: 'fix', cause: 'escape' }))
    expect(crashed(repo.root, ['recap', '--file', 'r.json'], { WITNESS_CRASH_AFTER: 'journal-append' }).status).toBe(9)
    expect((await repo.cli(['recover', '--complete'])).code).toBe(0)
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('recap(quick-fix): fix (recovered)')
    expect(mergeClock(repo.root)!.born.has('quick-fix')).toBe(true)

    const seed = await shippableRepo()
    seed.repo.setMeta(seed.planId, { pr: 1 })
    const scenario = fakeScenario()
    ghState(scenario, 1, 'MERGED')
    expect(crashed(seed.repo.root, ['next'], { ...gateEnv(scenario), WITNESS_CRASH_AFTER: 'merge-stamp' }).status).toBe(9)
    expect((await seed.repo.cli(['recover', '--complete'])).code).toBe(0)
    expect(seed.repo.git('log', '-1', '--format=%s').trim()).toBe(`merge(${seed.planId}): pr #1 (recovered)`)
    expect(mergeClock(seed.repo.root)!.merged.has(seed.planId)).toBe(true)
  }, 180_000)
})
