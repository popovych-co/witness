import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliAct } from '../src/act.js'
import { gateSpec } from '../src/gate.js'
import '../src/gates/index.js'
import { appendEntry } from '../src/journal.js'
import { evaluateNeeds, needMet, unmetNeeds } from '../src/needs.js'
import { loadCanon, type CanonDoc } from '../src/scan.js'
import { owedDecisions, parkedGates } from '../src/verbs/next.js'
import { approve, seededRepo, tmpRepo, writePlan, writeSpec } from './helpers.js'
import type { Ctx } from '../src/cli.js'

function ctxFor(root: string, opts: { tty?: boolean; answers?: string[]; env?: Record<string, string> } = {}): Ctx {
  const answers = [...(opts.answers ?? [])]
  return {
    cwd: root,
    env: { ...opts.env },
    isTTY: opts.tty ?? answers.length > 0,
    out: () => {},
    err: () => {},
    ask: async () => answers.shift() ?? '',
  }
}

const DOC: CanonDoc = { rel: 'specs/x.md', meta: {}, body: '', violations: [], satisfiedNeeds: [] }

describe('needMet (A10)', () => {
  it('a legacy satisfied: true in frontmatter still reads met', () => {
    expect(needMet({ ...DOC, satisfiedNeeds: [] }, { manual: 'x', satisfied: true })).toBe(true)
  })
  it('a journaled satisfaction is keyed by the need id and else its manual text', () => {
    expect(needMet({ ...DOC, satisfiedNeeds: ['sbx'] }, { id: 'sbx', manual: 'x', satisfied: false })).toBe(true)
    expect(needMet({ ...DOC, satisfiedNeeds: ['x'] }, { manual: 'x', satisfied: false })).toBe(true)
    expect(needMet({ ...DOC, satisfiedNeeds: ['x'] }, { id: 'sbx', manual: 'x', satisfied: false })).toBe(false)
  })
})

describe('evaluateNeeds', () => {
  it('checks env and manual needs without touching the shell', async () => {
    const repo = tmpRepo()
    const results = await evaluateNeeds(repo.root, ctxFor(repo.root, { env: { STRIPE_API_KEY: 'sk' } }), [
      { env: 'STRIPE_API_KEY' },
      { env: 'MISSING_VAR' },
      { manual: 'sandbox created', satisfied: true },
      { manual: 'dns cut over', satisfied: false },
    ], DOC)
    expect(results.map((r) => r.status)).toEqual(['ok', 'unmet', 'ok', 'unmet'])
  })

  it('prompts once for a cmd, persists consent, and runs it', async () => {
    const repo = tmpRepo()
    const first = await evaluateNeeds(repo.root, ctxFor(repo.root, { answers: ['y'] }), [{ cmd: 'true' }], DOC)
    expect(first[0]?.status).toBe('ok')
    expect(readFileSync(join(repo.root, '.witness/allow.json'), 'utf8')).toContain('"true"')
    const second = await evaluateNeeds(repo.root, ctxFor(repo.root, { tty: false, env: {} }), [{ cmd: 'true' }], DOC)
    expect(second[0]?.status).toBe('ok')
  })

  it('reports unmet for a failing trusted command', async () => {
    const repo = tmpRepo()
    const res = await evaluateNeeds(repo.root, ctxFor(repo.root, { answers: ['y'] }), [{ cmd: 'false' }], DOC)
    expect(res[0]?.status).toBe('unmet')
  })

  it('blocks untrusted commands without a TTY and never executes them', async () => {
    const repo = tmpRepo()
    const marker = join(repo.root, 'executed.marker')
    const res = await evaluateNeeds(repo.root, ctxFor(repo.root, { tty: false }), [{ cmd: `touch ${marker}` }], DOC)
    expect(res[0]?.status).toBe('blocked')
    expect(existsSync(marker)).toBe(false)
  })

  it('declines when the user says no, and trusts everything under WITNESS_TRUST_CMDS=1', async () => {
    const repo = tmpRepo()
    const declined = await evaluateNeeds(repo.root, ctxFor(repo.root, { answers: ['n'] }), [{ cmd: 'true' }], DOC)
    expect(declined[0]?.status).toBe('declined')
    const ci = await evaluateNeeds(repo.root, ctxFor(repo.root, { tty: false, env: { WITNESS_TRUST_CMDS: '1' } }), [{ cmd: 'true' }], DOC)
    expect(ci[0]?.status).toBe('ok')
  })
})

describe('unmetNeeds (A10)', () => {
  it('lists every unmet manual need with what it holds or blocks and its satisfy command', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', {
      needs: [{ id: 'prod', manual: 'production access granted', satisfied: false, holds: ['ac-prod'] },
        { manual: 'docs reviewed', satisfied: false }, { env: 'X' }],
      criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }, { id: 'ac-prod', cmd: 'true' }],
    })
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1', {
      needs: [{ manual: 'device on the desk', satisfied: false }],
      steps: [{ id: 's1', title: 't', criteria: ['ac-rotate', 'ac-prod'] }],
    })
    // Row 239 (ruling R16(b)): each satisfy is also an act, which its `run:` row prints
    expect(unmetNeeds(loadCanon(repo.root))).toEqual([
      { doc: 'auth-refresh', type: 'spec', need: 'prod', text: 'production access granted', holds: ['ac-prod'], blocks: 'nothing', ref: 'prod', satisfy: 'witness satisfy auth-refresh --need prod',
        satisfyAct: cliAct('satisfy', 'auth-refresh', '--need', 'prod') },
      { doc: 'auth-refresh', type: 'spec', need: 'docs reviewed', text: 'docs reviewed', holds: [], blocks: 'nothing', ref: '2', satisfy: 'witness satisfy auth-refresh --need 2',
        satisfyAct: cliAct('satisfy', 'auth-refresh', '--need', '2') },
      { doc: 'auth-refresh-plan-1', type: 'plan', need: 'device on the desk', text: 'device on the desk', holds: [], blocks: 'start', ref: '1', satisfy: 'witness satisfy auth-refresh-plan-1 --need 1',
        satisfyAct: cliAct('satisfy', 'auth-refresh-plan-1', '--need', '1') },
    ])
  })
  it('a satisfied need and a started plan need are not listed', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { needs: [{ id: 'sbx', manual: 'sandbox', satisfied: true }] })
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1', { needs: [{ manual: 'device', satisfied: false }] })
    repo.flipStatus('auth-refresh-plan-1', 'in-progress')
    expect(unmetNeeds(loadCanon(repo.root))).toEqual([])
  })

  // Row 239 (the plan's B15). Canon is text a hand edit can change, and an id is printed into the
  // commands the inbox offers and on the line that heads them: a need or a doc named outside the id
  // set is never offered, and a plan whose parent is named outside it offers no `--upstream`.
  it('a need or doc named outside the id set is never offered (row 239)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2', { needs: [{ manual: 'device on the desk', satisfied: false }] })
    // the hand edits `write` refuses: a need's id with a space in it, a plan's id in capitals
    repo.setMeta('auth-refresh', { needs: [
      { id: 'n x', manual: 'production access granted', satisfied: false }, { manual: 'docs reviewed', satisfied: false },
    ] })
    repo.setMeta('auth-refresh-plan-2', { id: 'P1' })
    // the need with no id keeps its index among every manual need, which `satisfy` reads it by
    expect(unmetNeeds(loadCanon(repo.root)).map((u) => u.satisfyAct.argv))
      .toEqual([['satisfy', 'auth-refresh', '--need', '2']])

    // three stopped plan rounds on each plan, the third undisposed: a decision is owed at the bound
    const round = (artifact: string, n: number) => appendEntry(repo.root, artifact, {
      t: 'gate-run', gate: 'plan', artifact, round: n, run_id: `r${n}`, reviewed_sha: `s${n}`, prompts_sha: 'ps',
      witness: '0', model: 'm', checks: [], outcome: 'stopped',
      verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: `${artifact} > ## Step: s1`, claim: 'x' }] }],
    })
    for (const artifact of ['auth-refresh-plan-1', 'P1']) for (const n of [1, 2, 3]) round(artifact, n)
    expect(owedDecisions(repo.root, loadCanon(repo.root))).toEqual([{ gate: 'plan', target: 'auth-refresh-plan-1', bound: false }])

    // a parent outside the id set gives no upstream, in the block and in a parked plan's reopen
    repo.setMeta('auth-refresh-plan-1', { parent: 'p$(x)' })
    expect(gateSpec('plan')!.upstreamOf!(repo.root, loadCanon(repo.root), 'auth-refresh-plan-1')).toBeUndefined()
    const shown = await repo.cli(['decide', 'plan', 'auth-refresh-plan-1', '--show'])
    expect(shown.stdout).toContain('witness decide plan auth-refresh-plan-1 --approve --override')
    expect(shown.stdout).not.toContain('p$(x)')
    // what the block names is the shape a human fills in, an option it marks not runnable
    expect(shown.stdout.match(/--upstream \S+/g)).toEqual(['--upstream <effort>'])
    for (const artifact of ['auth-refresh-plan-1', 'P1']) {
      appendEntry(repo.root, artifact, { t: 'human-decision', gate: 'plan', artifact, round: 3, decision: 'stop' })
    }
    const parked = parkedGates(repo.root, loadCanon(repo.root))
    expect(parked.map((p) => [p.gate, p.target])).toEqual([['plan', 'auth-refresh-plan-1']])
    expect(parked[0]!.reopen.map((a) => a.argv.join(' '))).toEqual([
      'decide plan auth-refresh-plan-1 --approve --override', 'decide plan auth-refresh-plan-1 --revise --repair',
      'decide plan auth-refresh-plan-1 --stop', 'abandon auth-refresh-plan-1',
    ])
  })
})
