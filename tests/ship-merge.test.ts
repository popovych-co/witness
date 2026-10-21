import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { DecisionEntry, GateRunEntry } from '../src/rounds.js'
import { findById, loadCanon } from '../src/scan.js'
import { runShip } from '../src/ship.js'
import { addOrigin, fakeCtx, fakeScenario, gateEnv, putVerdict, shippableRepo, singleConfig, type TestRepo } from './helpers.js'

const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}
const lastDecision = (repo: TestRepo, stream: string) =>
  (readStream(repo.root, stream).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]).at(-1)!
const lastRun = (repo: TestRepo, stream: string, gate: string) =>
  (readStream(repo.root, stream).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[]).filter((r) => r.gate === gate).at(-1)!

// The config commit moves origin/main past the worktree's cut, so the gate phase rebases
// first — which is what exercises the re-derivation after the arbiter approves.
async function autonomousShip(merge?: string) {
  const seed = await shippableRepo()
  seed.repo.write('witness.config.yaml',
    `${singleConfig('filtered')}ship:\n  test: 'true'\n  lint: 'true'\n${merge ? `  merge: ${merge}\n` : ''}autonomy: on\n`)
  seed.repo.git('add', 'witness.config.yaml'); seed.repo.git('commit', '-m', 'autonomy: on')
  addOrigin(seed.repo)
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  putVerdict(scenario, { choice: 1, reason: 'the change serves g1' }, 'arbiter')
  const outs: string[] = []; const errs: string[] = []
  const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario), out: (l) => outs.push(l), err: (l) => errs.push(l) })
  expect(await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })).toBe(0)
  const calls = () => (existsSync(join(scenario, 'gh-calls')) ? readFileSync(join(scenario, 'gh-calls'), 'utf8') : '')
  return { ...seed, scenario, ctx, out: () => outs.join('\n'), err: () => errs.join('\n'), calls }
}

it('merges its own PR once the arbiter approved and CI is green (A7)', async () => {
  const s = await autonomousShip()
  expect(await runShip(s.ctx, s.planId)).toBe(0)
  for (const c of ['pr create', 'pr checks 1 --watch', 'pr merge 1 --merge']) expect(s.calls()).toContain(c)
  expect(s.out()).toContain('merged: #1 · merge — the lazy stamp finishes the lifecycle on the next scan')
  expect(s.out()).not.toContain('merge PR')
  expect(lastDecision(s.repo, s.planId)).toMatchObject({ gate: 'ship', decision: 'approve', selected: 'arbiter' })
  expect(lastRun(s.repo, s.planId, 'ship').standing).toContain('the arbiter judges every PR against the recap')
  await s.repo.cli(['next'], { env: gateEnv(s.scenario) })
  expect(findById(loadCanon(s.repo.root), s.planId)!.meta.status).toBe('done')
})
it('merges in the configured style', async () => {
  const s = await autonomousShip('squash')
  expect(await runShip(s.ctx, s.planId)).toBe(0)
  expect(s.calls()).toContain('pr merge 1 --squash')
})
it('never merges on red CI', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'pr-1-checks'), 'fail')
  expect(await runShip(s.ctx, s.planId)).toBe(1)
  expect(s.calls()).not.toContain('pr merge')
})
it('never merges a PR that reports no CI checks at all', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'pr-1-checks'), 'none')
  expect(await runShip(s.ctx, s.planId)).toBe(1)
  expect(s.out()).toContain('merge: held — no CI checks reported · witness merges only on green CI')
  expect(s.calls()).not.toContain('pr merge')
})
it('a merge GitHub refuses is the human\'s', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'pr-1-merge-refuse'), 'GraphQL: Base branch policy prohibits the merge')
  expect(await runShip(s.ctx, s.planId)).toBe(2)
  expect(s.err()).toContain('merge-refused')
  expect(readFileSync(join(s.scenario, 'pr-1-state'), 'utf8').trim()).toBe('OPEN')
})
it('holds the merge when the base moved while CI ran (Review Focus 3)', async () => {
  const s = await autonomousShip()
  const other = `${s.repo.root}-other`
  execFileSync('git', ['clone', `${s.repo.root}-origin.git`, other])
  writeFileSync(join(s.scenario, 'gh-checks-hook'),
    `cd "${other}" && echo moved > moved.txt && git add moved.txt && git -c user.name=t -c user.email=t@e commit -m moved && git push origin main\n`)
  expect(await runShip(s.ctx, s.planId)).toBe(1)
  expect(s.out()).toContain('merge: held — the ship approval lapsed (main moved)')
  expect(s.calls()).not.toContain('pr merge')
})
it('without autonomy the human merges, as before', async () => {
  const seed = await shippableRepo()
  addOrigin(seed.repo)
  const scenario = fakeScenario(); putVerdict(scenario, CLEAN)
  const outs: string[] = []
  const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario), out: (l) => outs.push(l) })
  await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })
  await runShip(ctx, seed.planId)
  await seed.repo.cli(['decide', 'ship', seed.planId, '--approve'], { env: gateEnv(scenario) })
  expect(await runShip(ctx, seed.planId)).toBe(0)
  expect(outs.join('\n')).toContain('merge PR #1 on GitHub when ready')
  expect(readFileSync(join(scenario, 'gh-calls'), 'utf8')).not.toContain('pr merge')
})
