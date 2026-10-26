import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { appendEntry } from '../src/journal.js'
import { type NeedYou, needsYou, needsYouToken } from '../src/needs-you.js'
import { loadCanon } from '../src/scan.js'
import { approve, autonomyOn, fakeCtx, hermeticEnv, seededRepo, writePlan, writeSpec } from './helpers.js'

const cfgOf = (root: string) => {
  const r = loadConfig(root)
  if (!r.ok) throw new Error('config')
  return r.value
}

// Row 203. One derivation of what needs the human, read by drive's report, its notifier and
// `witness wait`. The key never depends on rendered text, so drive, `next` and `wait` compute
// the same token for the same state.
describe('needsYou (D203)', () => {
  it('stuck, capped and a policy park are items', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')
    await writePlan(repo, 'auth-refresh-plan-3')
    appendEntry(repo.root, 'auth-refresh-plan-3', { v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh-plan-3', round: 1,
      run_id: 'r', reviewed_sha: 's', prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none', checks: [], outcome: 'stopped' } as never)
    appendEntry(repo.root, 'auth-refresh-plan-3', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-3', round: 1,
      decision: 'stop', selected: 'policy', rule: 'cap-rounds', note: 'drive cap: plan ran 16 rounds' } as never)
    const items = needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo.root), loadCanon(repo.root), [
      { target: 'auth-refresh-plan-1', kind: 'stuck' },
      { target: 'auth-refresh-plan-2', kind: 'capped' },
    ])
    const byKind = (k: string) => items.filter((i) => i.kind === k)
    // final review: a stuck or capped target names its way back
    expect(byKind('stuck')[0]).toMatchObject({ target: 'auth-refresh-plan-1',
      rows: ['stuck: auth-refresh-plan-1 — witness log auth-refresh-plan-1', '  run: witness retry auth-refresh-plan-1'] })
    expect(byKind('capped')[0]).toMatchObject({ target: 'auth-refresh-plan-2',
      rows: ['stuck: auth-refresh-plan-2 — witness log auth-refresh-plan-2', '  run: witness retry auth-refresh-plan-2'] })
    expect(byKind('parked')[0]).toMatchObject({ target: 'auth-refresh-plan-3', key: 'parked:auth-refresh-plan-3:plan' })
    expect(byKind('parked')[0]!.rows[0]).toBe('parked: auth-refresh-plan-3 · plan round 1 — drive cap: plan ran 16 rounds')
  })

  it('a pending transaction is first', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { needs: [{ id: 'sbx', manual: 'Stripe sandbox', satisfied: false }] })
    // crashPoint exits the process, so the crashed write runs in a child of its own
    const here = resolve(import.meta.dirname, '..')
    const crashed = spawnSync(join(here, 'node_modules', '.bin', 'tsx'), [join(here, 'src', 'bin.ts'), 'ask', 'crashed'],
      { cwd: repo.root, env: hermeticEnv({ WITNESS_CRASH_AFTER: 'journal-append' }), encoding: 'utf8' })
    expect(crashed.status).toBe(9)
    const items = needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo.root), loadCanon(repo.root), [])
    expect(items[0]!.kind).toBe('pending-txn')
    expect(items[0]!.rows[0]).toMatch(/^wait: pending transaction · /)
    expect(items.some((i) => i.kind === 'need' && i.target === 'auth-refresh')).toBe(true)
  })

  it('a kept trust grant read from the live folder renders its grant without text', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const items = needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo.root), loadCanon(repo.root), [
      { target: 'auth-refresh', kind: 'kept', stop: 'trust-grant' },
    ])
    expect(items).toEqual([{ kind: 'trust-grant', target: 'auth-refresh', key: 'trust-grant:auth-refresh',
      rows: ['wait: trust grant · auth-refresh', '  run: witness trust auth-refresh'] }])
  })

  it('the token ignores order and changes when an item is added', () => {
    const a: NeedYou = { kind: 'stuck', target: 'a', rows: [], key: 'stuck:a' }
    const b: NeedYou = { kind: 'decision', target: 'b', rows: ['x'], key: 'decision:b:plan' }
    const c: NeedYou = { kind: 'merge', target: 'c', rows: [], key: 'merge:c' }
    expect(needsYouToken([a, b])).toBe(needsYouToken([b, a]))
    expect(needsYouToken([a, b, c])).not.toBe(needsYouToken([a, b]))
    expect(needsYouToken([a, { ...b, rows: ['other text'] }])).toBe(needsYouToken([a, b]))
    expect(needsYouToken([a, b])).toMatch(/^[0-9a-f]{12}$/)
  })
})
