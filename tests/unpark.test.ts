import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../src/gates/index.js'
import { capHit } from '../src/caps.js'
import { loadConfig } from '../src/config.js'
import { driveLoop } from '../src/drive.js'
import { journalRel, readStream, type Entry } from '../src/journal.js'
import { needsYou, needYouRows } from '../src/needs-you.js'
import { openReopen, type DecisionEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { diffBase } from '../src/evidence.js'
import { diffReviewedSha, implementReviewedSha } from '../src/reviewed.js'
import { applyDecision } from '../src/verbs/decide.js'
import { gateParked } from '../src/verbs/next.js'
import {
  approve, autonomyOn, commitEntry, fakeClock, fakeCtx, fakeScenario, fixtureEnv, noopOpener, patchConfig, seededRepo,
  shippableRepo, writeLocalConfig, writePlan, writeSpec, type TestRepo,
} from './helpers.js'

// Row 241 (design §4.2.5, R11; the user's decision Q3). A human's revise sends a parked gate back to
// work below the bound: it lifts the park without running the gate, `next` then routes the owed work,
// and the parked rows offer it — alone while work is owed, else beside `--fresh`, never as `exits:`.

const TWO = {
  steps: [
    { id: 's1', title: 'rotate tokens on refresh', criteria: ['ac-rotate'] },
    { id: 's2', title: 'added by an amendment', criteria: ['ac-rotate'] },
  ],
}
const TWO_BODY = '## Step: s1\nImplement rotation with TDD.\n\n## Step: s2\nAdded after the gate.\n'
const cfgOf = (repo: TestRepo) => { const r = loadConfig(repo.root); if (!r.ok) throw new Error('cfg'); return r.value }
const REVISE = (gate: string, t: string) => `witness decide ${gate} ${t} --revise --note "<why>"`

// An implement gate the arbiter parked at round 1, on a plan whose s2 is still open, or not.
async function arbiterParked(opts: { stepOpen: boolean }): Promise<{ repo: TestRepo; wt: string; planId: string }> {
  const seed = await shippableRepo()
  if (opts.stepOpen) expect((await writePlan(seed.repo, seed.planId, TWO, TWO_BODY)).code).toBe(0)
  const base = diffBase(seed.wt, cfgOf(seed.repo))
  if (!base.ok) throw new Error('base')
  const plan = findById(loadCanon(seed.repo.root), seed.planId)!
  commitEntry(seed.repo, seed.planId, {
    t: 'gate-run', gate: 'implement', artifact: seed.planId, round: 1, run_id: 'ri-1',
    reviewed_sha: implementReviewedSha(seed.wt, base.value, plan), diff_sha: diffReviewedSha(seed.wt, base.value),
    prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
    verdicts: [{ reviewer: 'code-reviewer', coverage: [], findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'x' }] }],
  })
  commitEntry(seed.repo, seed.planId, {
    t: 'human-decision', gate: 'implement', artifact: seed.planId, round: 1, decision: 'stop',
    selected: 'arbiter', reason: 'the steps were never built', arbiter: { model: 'm', prompts_sha: 'p' },
  })
  return seed
}
const parkedRows = (repo: TestRepo, target: string) => {
  const items = needsYou(repo.root, { env: {} }, cfgOf(repo), loadCanon(repo.root), [])
  return needYouRows(items.find((i) => i.kind === 'parked' && i.target === target)!)
}

describe('un-parking (row 241)', () => {
  it('#89: a human revise lifts an arbiter park below the bound, and next routes the step', async () => {
    const { repo, planId } = await arbiterParked({ stepOpen: true })
    expect(gateParked(readStream(repo.root, planId), 'implement')).toBe(true)
    const r = await repo.cli(['decide', 'implement', planId, '--revise', '--note', 'build s2 first'])
    expect(r.code, r.stderr).toBe(0)
    const entries = readStream(repo.root, planId)
    expect(gateParked(entries, 'implement')).toBe(false)
    expect(entries.filter((e) => e.t === 'gate-run')).toHaveLength(1)                 // lifted without running the gate
    expect((entries.at(-1) as unknown as DecisionEntry)).toMatchObject({ decision: 'revise', unpark: true })
    const next = (await repo.cli(['next'])).stdout.split('\n').find((l) => l.startsWith('next: '))
    expect(next).toBe(`next: witness test-evidence ${planId} --phase red --step s2`)
  }, 180_000)

  it('the revise refuses inside a drive session and for policy or arbiter acts', async () => {
    const { repo, planId } = await arbiterParked({ stepOpen: true })
    const inDrive = await repo.cli(['decide', 'implement', planId, '--revise', '--note', 'x'], { env: { WITNESS_DRIVE: planId } })
    expect(inDrive.code).toBe(2)
    expect(inDrive.stderr).toContain('unpark-human')
    for (const selected of ['policy', 'arbiter'] as const) {
      const errs: string[] = []
      const code = await applyDecision(fakeCtx(repo.root, { err: (l) => errs.push(l) }), {
        gate: 'implement', target: planId, decision: 'revise', note: 'x', selected,
        ...(selected === 'arbiter' ? { reason: 'r', arbiter: { model: 'm', prompts_sha: 'p' } } : {}),
      } as never)
      expect(code, selected).toBe(2)
      expect(errs.join('\n'), selected).toContain('unpark-human')
    }
    expect(gateParked(readStream(repo.root, planId), 'implement')).toBe(true)
  }, 180_000)

  it('after an un-park, approve and stop stay reachable on unchanged content', async () => {
    const { repo, planId } = await arbiterParked({ stepOpen: false })
    expect((await repo.cli(['decide', 'implement', planId, '--revise', '--note', 'look again'])).code).toBe(0)
    const stop = await repo.cli(['decide', 'implement', planId, '--stop'])
    expect(stop.code, stop.stderr).toBe(0)
    expect(gateParked(readStream(repo.root, planId), 'implement')).toBe(true)
  }, 180_000)

  it('the parked row offers the revise alone while work is owed, else revise: and fresh: rows', async () => {
    const owed = await arbiterParked({ stepOpen: true })
    expect(parkedRows(owed.repo, owed.planId)).toEqual([
      `parked: ${owed.planId} · implement round 1 — parked by the arbiter — the steps were never built`,
      `  revise: ${REVISE('implement', owed.planId)}`,
    ])
    const free = await arbiterParked({ stepOpen: false })
    expect(parkedRows(free.repo, free.planId)).toEqual([
      `parked: ${free.planId} · implement round 1 — parked by the arbiter — the steps were never built`,
      `  revise: ${REVISE('implement', free.planId)}`,
      `  fresh: witness gate implement ${free.planId} --fresh`,
    ])
  }, 240_000)

  it('a cap park after a revise-upstream offers the revise alone, which lifts it with the reopen intact (P5)', async () => {
    const { repo, planId } = await shippableRepo()
    commitEntry(repo, planId, {
      t: 'gate-run', gate: 'ship', artifact: planId, round: 1, run_id: 'rs-1', reviewed_sha: 'r', prompts_sha: 'p',
      witness: '0', model: 'm', checks: [], outcome: 'stopped',
      verdicts: [{ reviewer: 'drift-reviewer', coverage: [], findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'x' }] }],
    })
    commitEntry(repo, planId, { t: 'human-decision', gate: 'ship', artifact: planId, round: 1, decision: 'revise-upstream',
      upstream: { artifact: planId, gate: 'plan' }, selected: 'policy' })
    commitEntry(repo, planId, { t: 'human-decision', gate: 'plan', artifact: planId, round: 1, decision: 'revise',
      caused_by: { artifact: planId, gate: 'ship', round: 1 } })
    commitEntry(repo, planId, { t: 'human-decision', gate: 'ship', artifact: planId, round: 1, decision: 'stop',
      selected: 'policy', rule: 'cap-rounds', note: 'drive cap: ship ran 4 rounds' })
    const rows = parkedRows(repo, planId)
    expect(rows.slice(1)).toEqual([`  revise: ${REVISE('ship', planId)}`])
    expect((await repo.cli(['decide', 'ship', planId, '--revise', '--note', 'the plan is being re-authored'])).code).toBe(0)
    const entries = readStream(repo.root, planId)
    expect(gateParked(entries, 'ship')).toBe(false)
    expect(openReopen(entries, 'plan')).toBeDefined()
  }, 180_000)

  it('a --fresh refused on a parked gate names the revise on a row of its own', async () => {
    const { repo, planId } = await arbiterParked({ stepOpen: true })
    const r = await repo.cli(['gate', 'implement', planId, '--fresh'])
    expect(r.code).toBe(2)
    expect(r.stderr.split('\n')).toContain(`  revise: ${REVISE('implement', planId)}`)
  }, 180_000)

  it('decide --show names a parked gate and who parked it', async () => {
    const { repo, planId } = await arbiterParked({ stepOpen: true })
    const r = await repo.cli(['decide', 'implement', planId, '--show'])
    expect(r.stdout).toContain('state: parked — parked by the arbiter — the steps were never built')
    expect(r.stdout.split('\n')).toContain(`  revise: ${REVISE('implement', planId)}`)
  }, 180_000)

  it('status prints each reopen act on a row of its own, never inside the table', async () => {
    const { repo, planId } = await arbiterParked({ stepOpen: false })
    const out = (await repo.cli(['status'])).stdout.split('\n')
    expect(out).toContain(`  revise: ${REVISE('implement', planId)}`)
    expect(out).toContain(`  fresh: witness gate implement ${planId} --fresh`)
    expect(out.filter((l) => l.includes('--fresh') && !l.startsWith('  fresh:'))).toEqual([])
  }, 180_000)
})

describe('a human un-park restarts the caps (row 241)', () => {
  const run = (round: number) => ({ v: 1, t: 'gate-run', gate: 'implement', artifact: 'p1', round, run_id: `r${round}`,
    reviewed_sha: 's', prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', checks: [], outcome: 'stopped' })
  it('the cap window counts from the later of the last cap park and the last human un-park', () => {
    const caps = { rounds: 2, upstream: 9, spawns: 9, wallClockMs: 1e9 }
    const park = { v: 1, t: 'human-decision', gate: 'implement', artifact: 'p1', round: 2, decision: 'stop', selected: 'arbiter' }
    const before = [run(1), run(2), park]
    expect(capHit(before as unknown as Entry[], { spawns: 0, ms: 0 }, caps)?.cap).toBe('rounds')
    const unpark = { v: 1, t: 'human-decision', gate: 'implement', artifact: 'p1', round: 2, decision: 'revise', unpark: true }
    const unparked = [...before, unpark]
    expect(capHit(unparked as unknown as Entry[], { spawns: 0, ms: 0 }, caps)).toBeUndefined()
    // a line that only claims to un-park — following no park, or a settler's — restarts nothing
    expect(capHit([run(1), run(2), unpark] as unknown as Entry[], { spawns: 0, ms: 0 }, caps)?.cap).toBe('rounds')
    expect(capHit([...before, { ...unpark, selected: 'policy' }] as unknown as Entry[], { spawns: 0, ms: 0 }, caps)?.cap).toBe('rounds')
    expect(capHit([...unparked, run(3), run(4)] as unknown as Entry[], { spawns: 0, ms: 0 }, caps)?.cap).toBe('rounds')
  })

  for (const committed of [true, false]) it(committed
    ? 'drive resets a target\'s per-run use when its stream gains a human un-park'
    : 'an un-park line a session appended without a state commit restarts no cap', async () => {
    const repo = await seededRepo()
    for (const s of ['a', 'b']) {
      await writeSpec(repo, s, { criteria: [{ id: `ac-${s}`, test: `@spec:${s}` }] })
      approve(repo, s)
      await writePlan(repo, `${s}-plan-1`, { parent: s, steps: [{ id: 's1', title: s, criteria: [`ac-${s}`] }] })
      approve(repo, `${s}-plan-1`)
      await repo.cli(['start', `${s}-plan-1`])
    }
    autonomyOn(repo)
    patchConfig(repo, { drive: { caps: { spawns: 1 } } })
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-qm', 'caps')
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const log = join(fakeScenario(), 'spawned')
    const journalA = join(repo.root, journalRel('a-plan-1'))
    const line = (o: object) => JSON.stringify(o).replaceAll("'", "'\\''")
    const runA = line({ v: 1, t: 'gate-run', gate: 'implement', artifact: 'a-plan-1', round: 1, run_id: 'ra', reviewed_sha: 'r',
      prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped' })
    const park = line({ v: 1, t: 'human-decision', gate: 'implement', artifact: 'a-plan-1', round: 1, decision: 'stop',
      selected: 'arbiter', reason: 'x', arbiter: { model: 'm', prompts_sha: 'p' } })
    const unpark = line({ v: 1, t: 'human-decision', gate: 'implement', artifact: 'a-plan-1', round: 1, decision: 'revise',
      note: 'go on', unpark: true })
    // a's first session ends with its gate parked by the arbiter; b's waits for that park, then a
    // human un-parks a while b still runs
    const agent = join(fakeScenario(), 'agent')
    writeFileSync(agent, `#!/bin/sh
echo "$WITNESS_DRIVE" >> "${log}"
case "$WITNESS_DRIVE" in
  a-plan-1) if [ "$(grep -c a-plan-1 "${log}")" = 1 ]; then printf '%s\\n' '${runA}' '${park}' >> "${journalA}"; fi ;;
  b-plan-1) i=0; while ! grep -q '"selected":"arbiter"' "${journalA}" && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
            printf '%s\\n' '${unpark}' >> "${journalA}"
            ${committed ? `git -C "${repo.root}" add "${journalA}" && git -C "${repo.root}" -c user.name=w -c user.email=w@e commit -qm unpark -m 'Witness-State: 1'` : 'true'} ;;
esac
`, { mode: 0o755 })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), fakeCtx(repo.root, {
      env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), WITNESS_DRIVE_IDLE_MAX_MS: '0', WITNESS_DRIVE_AGENT_BIN: agent }),
      out: (l) => out.push(l),
    }), {}, fakeClock(0))
    expect(readFileSync(log, 'utf8').split('\n').filter((l) => l === 'a-plan-1')).toHaveLength(committed ? 2 : 1)
    if (committed) expect(out.join('\n')).not.toContain('drive: capped — a-plan-1 · drive cap: 1 session(s)')
  }, 120_000)
})
