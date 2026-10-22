import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { worktreePath } from '../src/worktree.js'
import { threeStepPlan, tmpRepo } from './helpers.js'

const P = 'auth-refresh-plan-1'
const closes = (root: string) => readStream(root, P).filter((e) => e.t === 'step-close')

// Row 191 §4.3 · Plan's call 6. A scaffolding step has no red→green, so its close is journaled
// on its own, once: a killed and re-run close converges on the one entry.
describe('witness step-close', () => {
  it('closes a scaffolding step once', async () => {
    const repo = await threeStepPlan()
    await repo.cli(['start', P])
    const wt = worktreePath(repo.root, P)

    const first = await repo.cli(['step-close', P, '--step', 's3'], { cwd: wt })
    expect(first.code).toBe(0)
    expect(first.stdout.split('\n')).toContain(`step-close: ${P} · s3 closed`)
    expect(closes(repo.root)).toMatchObject([{ t: 'step-close', artifact: P, step: 's3' }])
    expect(repo.git('log', '-1', '--format=%s')).toBe(`step-close(${P})`)
    expect(repo.git('log', '-1', '--format=%(trailers:key=Witness-State,valueonly=true)')).toBe('1')

    const again = await repo.cli(['step-close', P, '--step', 's3'], { cwd: wt })
    expect(again.code).toBe(0)
    expect(again.stdout.split('\n')).toContain(`step-close: ${P} · s3 already closed`)
    expect(closes(repo.root)).toHaveLength(1)
  })

  it('answers --help with its usage', async () => {
    const r = await tmpRepo().cli(['step-close', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('usage: witness step-close <plan-id> --step <id>')
  })

  it('refuses a criteria step, an unknown step, and a missing --step', async () => {
    const repo = await threeStepPlan()
    const criteria = await repo.cli(['step-close', P, '--step', 's1'])
    expect(criteria.code).toBe(2)
    expect(criteria.stderr).toContain('criteria-step')
    expect(criteria.stderr).toContain(`witness test-evidence ${P} --phase red --step s1`)
    const unknown = await repo.cli(['step-close', P, '--step', 'nope'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('unknown-step')
    const missing = await repo.cli(['step-close', P])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('required')
    expect(missing.stderr).toContain(`a scaffolding step of ${P}: s3`)
    const noValue = await repo.cli(['step-close', P, '--step'])
    expect(noValue.code).toBe(2)
    expect(noValue.stderr).toContain('required')
    expect(closes(repo.root)).toEqual([])
  })

  it('refuses an unknown plan', async () => {
    const repo = await threeStepPlan()
    const r = await repo.cli(['step-close', 'nope', '--step', 's3'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown-plan')
  })
})
