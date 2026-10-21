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
const shipConfig = (merge?: string, autonomy = true) =>
  `${singleConfig('filtered')}ship:\n  test: 'true'\n  lint: 'true'\n  ciSettleMs: 0\n${merge ? `  merge: ${merge}\n` : ''}${autonomy ? 'autonomy: on\n' : ''}`
async function autonomousShip(merge?: string) {
  const seed = await shippableRepo()
  seed.repo.write('witness.config.yaml', shipConfig(merge))
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
it('pins the merge to the commit it reviewed, so a PR head pushed since is never merged', async () => {
  const s = await autonomousShip()
  expect(await runShip(s.ctx, s.planId)).toBe(0)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.wt, encoding: 'utf8' }).trim()
  expect(s.calls()).toContain(`pr merge 1 --merge --match-head-commit ${head}`)
})
it('a PR head that moved after review is refused by GitHub and left for a human', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'pr-1-head-sha'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  expect(await runShip(s.ctx, s.planId)).toBe(2)
  expect(s.err()).toContain('merge-refused')
  expect(readFileSync(join(s.scenario, 'pr-1-state'), 'utf8').trim()).toBe('OPEN')
})

// ── final review fixes ──────────────────────────────────────────────────────────────────
it('a --manual ship stop met by ship under autonomy is shown to the human (F5)', async () => {
  const s = await autonomousShip()
  expect(await runGate(s.ctx, 'ship', s.planId, { fresh: false, manual: true })).toBe(1)
  expect(await runShip(s.ctx, s.planId)).toBe(1)
  expect(s.out()).toContain(`ship: ${s.planId} awaits the ship decision`)
  expect(s.out()).toMatch(/^decide: \d+ options · 1 is recommended$/m)
  expect(existsSync(join(s.scenario, 'claude-calls'))).toBe(true)
  expect(s.calls()).not.toContain('pr create')
})
it('ship --manual keeps the stop and the merge for a human (F6)', async () => {
  const s = await autonomousShip()
  expect(await runShip(s.ctx, s.planId, { manual: true })).toBe(1)
  expect(lastRun(s.repo, s.planId, 'ship').manual).toBe(true)
  expect((readStream(s.repo.root, s.planId).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]).filter((d) => d.gate === 'ship')).toEqual([])
  expect((await s.repo.cli(['decide', 'ship', s.planId, '--approve'], { env: gateEnv(s.scenario) })).code).toBe(0)
  expect(await runShip(s.ctx, s.planId, { manual: true })).toBe(0)
  expect(s.out()).toContain('merge PR #1 on GitHub when ready')
  expect(s.calls()).not.toContain('pr merge')
})
it('never merges on cancelled checks, which gh --watch exits 0 for (F7)', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'pr-1-checks'), 'cancel')
  expect(await runShip(s.ctx, s.planId)).toBe(1)
  expect(s.out()).toContain('ci: red — cancel: ci')
  expect(s.calls()).not.toContain('pr merge')
})
it('never merges when every check skipped — no passing evidence (F7)', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'pr-1-checks'), 'skipping')
  expect(await runShip(s.ctx, s.planId)).toBe(1)
  expect(s.out()).toContain('merge: held — no passing CI check · witness merges only on green CI')
  expect(s.calls()).not.toContain('pr merge')
})
it('a check that registers after the watch ended is watched too, and its failure blocks the merge (F7)', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'pr-1-rollups'), 'cla:pass\ncla:pass,tests:pending\ncla:pass,tests:fail\n')
  expect(await runShip(s.ctx, s.planId)).toBe(1)
  expect(s.out()).toContain('ci: red')
  expect(s.calls()).not.toContain('pr merge')
})
it('pushes the approved tree before it watches, so the merged commit is the one approved (F8)', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'pr-1-checks'), 'fail')
  expect(await runShip(s.ctx, s.planId)).toBe(1)                                   // PR opened, CI red
  writeFileSync(join(s.wt, 'src/token.ts'), `${readFileSync(join(s.wt, 'src/token.ts'), 'utf8')}// the reviewed fix\n`)
  writeFileSync(join(s.scenario, 'pr-1-checks'), 'pass')
  expect(await runShip(s.ctx, s.planId)).toBe(0)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.wt, encoding: 'utf8' }).trim()
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: s.wt, encoding: 'utf8' })).toBe('')
  expect(s.calls()).toContain(`--match-head-commit ${head}`)
  const pushed = execFileSync('git', ['--git-dir', `${s.repo.root}-origin.git`, 'show', `witness/${s.planId}:src/token.ts`], { encoding: 'utf8' })
  expect(pushed).toContain('// the reviewed fix')
})
it('holds the merge when the base cannot be fetched (F9)', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'gh-checks-hook'), `mv "${s.repo.root}-origin.git" "${s.repo.root}-origin.gone"\n`)
  expect(await runShip(s.ctx, s.planId)).toBe(1)
  expect(s.out()).toContain('merge: held — cannot verify main')
  expect(s.calls()).not.toContain('pr merge')
})
it('a human who turns autonomy off while CI runs gets the merge back (F10)', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'off.yaml'), shipConfig(undefined, false))
  writeFileSync(join(s.scenario, 'gh-checks-hook'),
    `cd "${s.repo.root}" && cp "${join(s.scenario, 'off.yaml')}" witness.config.yaml && git add witness.config.yaml && git -c user.name=t -c user.email=t@e commit -m off\n`)
  expect(await runShip(s.ctx, s.planId)).toBe(0)
  expect(s.out()).toContain('merge PR #1 on GitHub when ready')
  expect(s.calls()).not.toContain('pr merge')
})
it('merges only when the shipped branch itself says autonomy: on — a local commit grants no merge (security)', async () => {
  const seed = await shippableRepo()
  addOrigin(seed.repo)                                                          // origin/main: no autonomy
  seed.repo.write('witness.config.yaml', shipConfig())
  seed.repo.git('add', 'witness.config.yaml'); seed.repo.git('commit', '-m', 'autonomy: on — local only')
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  putVerdict(scenario, { choice: 1, reason: 'the change serves g1' }, 'arbiter')
  const outs: string[] = []
  const ctx = fakeCtx(seed.repo.root, { env: gateEnv(scenario), out: (l) => outs.push(l) })
  expect(await runGate(ctx, 'implement', seed.planId, { fresh: false, manual: false })).toBe(0)
  expect(await runShip(ctx, seed.planId)).toBe(0)
  expect(outs.join('\n')).toContain('merge PR #1 on GitHub when ready')
  expect(readFileSync(join(scenario, 'gh-calls'), 'utf8')).not.toContain('pr merge')
})
it('holds when the PR targets a branch other than ship.branch — authority is the base the merge lands on (security)', async () => {
  const s = await autonomousShip()
  writeFileSync(join(s.scenario, 'pr-1-base'), 'release')
  expect(await runShip(s.ctx, s.planId)).toBe(1)
  expect(s.out()).toContain('merge: held — the PR targets release but ship.branch is main')
  expect(s.calls()).not.toContain('pr merge')
})
it('reads the merge authority from what the remote holds, never a local tracking ref (security)', async () => {
  const s = await autonomousShip()
  const before = s.repo.git('rev-parse', `${s.repo.git('log', '-1', '--format=%H', '--', 'witness.config.yaml')}~1`)   // before autonomy: on
  expect(s.repo.git('show', `${before}:witness.config.yaml`)).not.toContain('autonomy')
  writeFileSync(join(s.scenario, 'gh-checks-hook'),
    `cd "${s.repo.root}" && git config remote.origin.fetch '+refs/heads/none:refs/remotes/origin/none' && git update-ref refs/remotes/origin/main ${before}\n`)
  expect(await runShip(s.ctx, s.planId)).toBe(0)
  expect(s.calls()).toContain('pr merge 1 --merge')
})
