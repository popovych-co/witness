import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { driveReport, runStart } from '../src/drive-report.js'
import { appendEntry } from '../src/journal.js'
import { notifyArgv } from '../src/notify.js'
import { approve, autonomyOn, fakeCtx, seededRepo, writePlan, writeSpec } from './helpers.js'

describe('the run report (B6)', () => {
  it('names what merged · what waits with its command · what was parked · obligations · decisions', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    await writeSpec(repo, 'billing-page', { ui: true, criteria: [{ id: 'ac-bill', test: '@spec:billing-page' }] })
    approve(repo, 'billing-page')
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-2', { needs: [{ id: 'ses-prod', manual: 'SES production access', satisfied: false }] })
    approve(repo, 'auth-refresh-plan-2')
    await writePlan(repo, 'auth-refresh-plan-3')
    await writePlan(repo, 'auth-refresh-plan-4')
    const start = runStart(repo.root)
    const add = (stream: string, e: Record<string, unknown>) => appendEntry(repo.root, stream, { v: 1, ...e } as never)
    const planRun = (plan: string, round: number) => add(plan, { t: 'gate-run', gate: 'plan', artifact: plan, round, run_id: `r-${plan}`,
      reviewed_sha: 's', prompts_sha: 'p', witness: '0', model: 'm', calibration: 'none', checks: [], outcome: 'stopped' })
    add('auth-refresh-plan-1', { t: 'status', artifact: 'auth-refresh-plan-1', from: 'in-progress', to: 'done', cause: 'merge', pr: 7 })
    add('auth-refresh-plan-1', { t: 'deferral', id: 'd-1a2b3c4d', artifact: 'auth-refresh-plan-1', gate: 'ship', round: 1,
      anchor: 'src/token.ts#rotate', kind: 'artifact-debt', caused_by_run: 'r1' })
    for (const selected of ['policy', 'policy', 'arbiter', undefined]) {
      add(repo.effort, { t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'revise', ...(selected ? { selected } : {}) })
    }
    add(repo.effort, { t: 'human-decision', gate: 'decompose', artifact: repo.effort, round: 1, decision: 'revise', caused_by: { artifact: 'x', gate: 'plan', round: 1 } })
    planRun('auth-refresh-plan-3', 3)
    add('auth-refresh-plan-3', { t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-3', round: 3, decision: 'stop',
      selected: 'policy', rule: 'cap-rounds', note: 'drive cap: plan ran 16 rounds across budget resets · drive.caps.rounds 16' })
    planRun('auth-refresh-plan-4', 1)                    // owed · never settled: a --manual run's stop
    const cfg = loadConfig(repo.root)
    if (!cfg.ok) throw new Error('config')
    const r = driveReport(repo.root, fakeCtx(repo.root), cfg.value, start, [
      { target: 'billing-page', kind: 'kept', stop: 'design-look', gate: 'design', line: 'witness decide design billing-page --show', why: 'design look' },
      { target: 'x-plan-1', kind: 'stuck', line: 'witness ship x-plan-1', why: 'no progress on witness ship x-plan-1' },
    ], { autonomous: true })
    expect(r.lines[0]).toBe('drive: done — 1 merged · 3 wait on you · 1 parked · 1 stuck')
    for (const line of [
      'merged: auth-refresh-plan-1 · PR #7',
      'wait: design look · billing-page',
      '  run: witness design billing-page --open',
      '  then: witness decide design billing-page --show',
      'wait: unmet need · auth-refresh-plan-2 · SES production access',
      '  run: witness satisfy auth-refresh-plan-2 --need ses-prod',
      'wait: decision · plan auth-refresh-plan-4',
      '  run: witness decide plan auth-refresh-plan-4 --show',
      'parked: auth-refresh-plan-3 · plan round 3 — drive cap: plan ran 16 rounds across budget resets · drive.caps.rounds 16',
      'stuck: x-plan-1 — no progress on witness ship x-plan-1',
      'obligation: d-1a2b3c4d · auth-refresh-plan-1 · src/token.ts#rotate — artifact-debt',
      'decisions: policy 3 · arbiter 1 · affirmation 0 · named 1',      // the cap park is a policy decision too
    ]) expect(r.lines).toContain(line)
    expect(r.lines.every((l) => !l.includes(','))).toBe(true)
    expect(r.summary).toBe(`witness drive — ${basename(repo.root)} · 1 merged · 3 wait on you · 1 parked · 1 stuck`)
  })
})

describe('notify (B6)', () => {
  it('renders the platform notifier and a configured command', () => {
    expect(notifyArgv('darwin', undefined, 'witness drive', 'a "b" c'))
      .toEqual(['osascript', '-e', 'display notification "a \\"b\\" c" with title "witness drive"'])
    expect(notifyArgv('linux', undefined, 'witness drive', 'm')).toEqual(['notify-send', 'witness drive', 'm'])
    expect(notifyArgv('win32', undefined, 'witness drive', 'm')).toBeUndefined()
    expect(notifyArgv('win32', '/bin/ping-me', 'witness drive', 'm')).toEqual(['/bin/ping-me', 'm'])
  })
})
