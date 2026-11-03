import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { loadConfig, type Config } from '../src/config.js'
import { gateSpec } from '../src/gate.js'
import '../src/gates/index.js'
import { appendEntry } from '../src/journal.js'
import type { AsideFacts } from '../src/needs-you.js'
import { effortReviewedSha } from '../src/reviewed.js'
import type { GateRunEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import type { GateName } from '../src/settings.js'
import {
  approve, autonomyOn, hermeticEnv, patchConfig, seededRepo, writePlan, writeSpec,
  type CliResult, type TestRepo,
} from './helpers.js'

// Roadmap 1a.1. The repo states the text goldens (tests/text-golden.test.ts) are recorded on, and
// the model tests that follow read the same states: one builder per surface, so a model and the
// text it renders are always judged on the same repo.

// A setup write the fixture depends on: a refusal here is silent unless asserted, and the
// surface built on top of it would be some other state's.
function must(r: CliResult, what: string): void {
  if (r.code !== 0) throw new Error(`${what}: exit ${r.code}\n${r.stdout}\n${r.stderr}`)
}

export function cfgOf(root: string): Config {
  const r = loadConfig(root)
  if (!r.ok) throw new Error('config')
  return r.value
}

// The repo's root as `<root>`, then each sha's first 7 hex as `<sha>`: the root first, so a sha
// prefix can never match inside the temp path.
export function norm(s: string, repo: TestRepo, shas: readonly string[]): string {
  return shas.reduce((out, sha) => out.replaceAll(sha.slice(0, 7), '<sha>'), s.replaceAll(repo.root, '<root>'))
}

// A spec need that holds a criterion, beside one that holds nothing and has no id: `--need` takes
// the first by its id and the second by its index.
const HELD_SPEC = {
  needs: [
    { id: 'prod', manual: 'production access granted', satisfied: false, holds: ['ac-prod'] },
    { manual: 'docs reviewed', satisfied: false },
  ],
  criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }, { id: 'ac-prod', cmd: 'true' }],
}
// `write` refuses a plan that leaves one of its spec's criteria unrealized.
const HELD_PLAN = { steps: [{ id: 's1', title: 't', criteria: ['ac-rotate', 'ac-prod'] }] }

const planRun = (artifact: string, round: number, sha: string) => ({
  v: 1, t: 'gate-run', gate: 'plan', artifact, round, run_id: `r${round}`,
  reviewed_sha: sha, prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
}) as never

// Every kind of item `needsYou` derives, each in both aside forms where it has two: drive's, with
// its line, why or commands, and the live folder's, with none.
export async function needsYouRepo(): Promise<{ repo: TestRepo; asides: AsideFacts[] }> {
  const repo = await seededRepo()
  must(await writeSpec(repo, 'auth-refresh', HELD_SPEC), 'write auth-refresh')
  approve(repo, 'auth-refresh')
  for (const n of [1, 2, 3, 4]) must(await writePlan(repo, `auth-refresh-plan-${n}`, HELD_PLAN), `write auth-refresh-plan-${n}`)
  // plan-1: a stopped run and no decision, so a decision is owed
  appendEntry(repo.root, 'auth-refresh-plan-1', planRun('auth-refresh-plan-1', 1, 'sha-1'))
  // plan-2: parked below the bound by drive's cap
  appendEntry(repo.root, 'auth-refresh-plan-2', planRun('auth-refresh-plan-2', 1, 'sha-1'))
  appendEntry(repo.root, 'auth-refresh-plan-2', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-2', round: 1,
    decision: 'stop', selected: 'policy', note: 'drive cap: plan ran 16 rounds' } as never)
  // plan-3: parked at the bound, where the way back is the endgame set
  for (const round of [1, 2, 3]) appendEntry(repo.root, 'auth-refresh-plan-3', planRun('auth-refresh-plan-3', round, `sha-${round}`))
  appendEntry(repo.root, 'auth-refresh-plan-3', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-3', round: 3,
    decision: 'stop' } as never)
  // plan-4: a PR named in frontmatter, for the merge aside that carries no line
  repo.setMeta('auth-refresh-plan-4', { pr: 9 })
  // Last, because a pending transaction refuses every write after it. crashPoint exits the
  // process, so the crashed ask runs in a child of its own (tests/needs-you.test.ts).
  const here = resolve(import.meta.dirname, '..')
  const crashed = spawnSync(join(here, 'node_modules', '.bin', 'tsx'), [join(here, 'src', 'bin.ts'), 'ask', 'crashed'],
    { cwd: repo.root, env: hermeticEnv({ WITNESS_CRASH_AFTER: 'journal-append' }), encoding: 'utf8' })
  if (crashed.status !== 9) throw new Error(`the crashed ask exited ${String(crashed.status)}: ${crashed.stdout}\n${crashed.stderr}`)
  return {
    repo,
    asides: [
      { target: 'billing-page', kind: 'kept', stop: 'design-look' },
      { target: 'auth-refresh-plan-5', kind: 'kept', stop: 'trust-grant',
        trust: [{ cmd: "echo 'hi'", source: 'ship.test' }, { cmd: 'bad\u001bcmd', source: 'ship.lint' }] },
      { target: 'auth-refresh-plan-6', kind: 'kept', stop: 'trust-grant' },
      { target: 'auth-refresh-plan-7', kind: 'conversation' },
      { target: '-', kind: 'conversation', line: 'witness brainstorm --ask a-1' },
      { target: 'auth-refresh-plan-4', kind: 'merge' },
      { target: 'auth-refresh-plan-8', kind: 'merge', line: 'ship: merge PR #12 on GitHub when ready' },
      { target: 'x-plan-1', kind: 'stuck', why: 'no progress on witness ship x-plan-1' },
      { target: 'x-plan-2', kind: 'capped' },
      { target: '-', kind: 'stuck', why: 'spawn ceiling' },
    ],
  }
}

export type DecideState =
  | 'no-runs' | 'reopened' | 'settled-arbiter' | 'implement-revised' | 'plan-trust-twin' | 'moved-after-revise' | 'bound-moved'

interface DecideFixture { gate: GateName; target: string; shas: string[] }

const decomposeRun = (effort: string, round: number, sha: string, extra: Record<string, unknown> = {}) => ({
  v: 1, t: 'gate-run', gate: 'decompose', artifact: effort, round, run_id: `r${round}`,
  reviewed_sha: sha, prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped', ...extra,
}) as never

const slicing = (findings: Array<Record<string, unknown>>) => ({
  verdicts: [{ reviewer: 'slicing-critic', coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings }],
})

// Each state `decide --show` prints, built on a fresh seededRepo. `shas` lists every real sha the
// state put in a printed line; the literal ones (`ba2f352`, `deadbee`, `sha-1`) print as written.
const DECIDE_STATES: Record<DecideState, (repo: TestRepo) => Promise<DecideFixture>> = {
  'no-runs': async (repo) => {
    autonomyOn(repo)
    must(await writeSpec(repo, 'auth-refresh'), 'write auth-refresh')
    return { gate: 'decompose', target: repo.effort, shas: [] }
  },
  // tests/decide-show.test.ts `reopenedAfterApprove`: a run, its approve, then a revise another
  // stage's --upstream injected.
  'reopened': async (repo) => {
    must(await writeSpec(repo, 'auth-refresh'), 'write auth-refresh')
    const s = repo.effort
    appendEntry(repo.root, s, decomposeRun(s, 1, 'ba2f352',
      slicing([{ blocking: true, anchor: 'auth-refresh > ## Behavior', claim: 'carries no ui: true' }])))
    appendEntry(repo.root, s, { v: 1, t: 'human-decision', gate: 'decompose', artifact: s, round: 1, decision: 'approve' } as never)
    appendEntry(repo.root, s, { v: 1, t: 'human-decision', gate: 'decompose', artifact: s, round: 1, decision: 'revise',
      caused_by: { artifact: 'account-deletion', gate: 'design', round: 1 }, note: 'cancel-window diverges at the spec level' } as never)
    return { gate: 'decompose', target: s, shas: [] }
  },
  'settled-arbiter': async (repo) => {
    must(await writeSpec(repo, 'auth-refresh'), 'write auth-refresh')
    const s = repo.effort
    const sha = effortReviewedSha(repo.root, loadCanon(repo.root), s).sha
    appendEntry(repo.root, s, decomposeRun(s, 1, sha, slicing([])))
    appendEntry(repo.root, s, { v: 1, t: 'human-decision', gate: 'decompose', artifact: s, round: 1, decision: 'approve',
      selected: 'arbiter', reason: 'the slice covers g1', arbiter: { model: 'test-model-1', prompts_sha: 'p' }, rule: 'reserved-stop-clean' } as never)
    return { gate: 'decompose', target: s, shas: [sha] }
  },
  // A reviewer's claim carrying an escape sequence and a bidi override, a held criterion, a pin,
  // and the author's revise: the actionable screen with every part it prints.
  'implement-revised': async (repo) => {
    must(await writeSpec(repo, 'auth-refresh', HELD_SPEC), 'write auth-refresh')
    approve(repo, 'auth-refresh')
    const id = 'auth-refresh-plan-1'
    must(await writePlan(repo, id, HELD_PLAN), `write ${id}`)
    appendEntry(repo.root, id, {
      v: 1, t: 'gate-run', gate: 'implement', artifact: id, round: 1, run_id: 'r1',
      reviewed_sha: 'sha-impl', prompts_sha: 'p', witness: '0', model: 'm', outcome: 'stopped',
      checks: [{ name: 'tests', ok: false, detail: 'ac-rotate:fail',
        held: [{ criterion: 'ac-prod', need: 'prod', satisfy: 'witness satisfy auth-refresh --need prod' }] }],
      verdicts: [{ reviewer: 'code-reviewer', coverage: [{ anchor: 'src/token.ts', note: 'read' }],
        findings: [{ blocking: true, anchor: 'src/token.ts', claim: 'expiry\u001b[2J\u202eunbounded' }] }],
    } as never)
    // decide's own order: the disposition, then the pins it carried
    appendEntry(repo.root, id, { v: 1, t: 'human-decision', gate: 'implement', artifact: id, round: 1,
      decision: 'revise', note: 'fix the expiry' } as never)
    appendEntry(repo.root, id, { v: 1, t: 'policy-pin', artifact: id, gate: 'implement', round: 1,
      ordinal: 1, text: 'render the service in full' } as never)
    return { gate: 'implement', target: id, shas: [] }
  },
  // A pending non-blocking finding on a plan whose spec runs an untrusted `cmd:` criterion: the
  // block offers the plain approve and its trusting twin.
  'plan-trust-twin': async (repo) => {
    must(await writeSpec(repo, 'auth-refresh', {
      criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }, { id: 'ac-e2e', cmd: 'npm run e2e' }],
    }), 'write auth-refresh')
    approve(repo, 'auth-refresh')
    const id = 'auth-refresh-plan-1'
    must(await writePlan(repo, id, { steps: [{ id: 's1', title: 'rotate tokens on refresh', criteria: ['ac-rotate', 'ac-e2e'] }] }), `write ${id}`)
    const current = gateSpec('plan')!.currentSha?.(repo.root, loadCanon(repo.root), cfgOf(repo.root), id)
    appendEntry(repo.root, id, {
      v: 1, t: 'gate-run', gate: 'plan', artifact: id, round: 1, run_id: 'r1',
      reviewed_sha: current ?? 'sha-plan', prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped',
      verdicts: [{ reviewer: 'plan-critic', coverage: [{ anchor: 'auth-refresh-plan-1 > ## Steps', note: 'read' }],
        findings: [{ blocking: false, anchor: 'auth-refresh-plan-1 > ## Steps', claim: 'hairline missing' }] }],
    } as never)
    return { gate: 'plan', target: id, shas: current === undefined ? [] : [current] }
  },
  // The content moved under a revised verdict: no decision is pending, so no block — the re-gate
  // is the one act left.
  'moved-after-revise': async (repo) => {
    must(await writeSpec(repo, 'auth-refresh'), 'write auth-refresh')
    const s = repo.effort
    appendEntry(repo.root, s, decomposeRun(s, 1, 'deadbee',
      slicing([{ blocking: true, anchor: 'auth-refresh > ## Behavior', claim: 'expiry unbounded' }])))
    appendEntry(repo.root, s, { v: 1, t: 'human-decision', gate: 'decompose', artifact: s, round: 1, decision: 'revise' } as never)
    return { gate: 'decompose', target: s, shas: [] }
  },
  // The bound reached with the content moved since its last round: the endgame minus approve.
  'bound-moved': async (repo) => {
    must(await writeSpec(repo, 'auth-refresh'), 'write auth-refresh')
    const s = repo.effort
    for (const round of [1, 2, 3]) appendEntry(repo.root, s, decomposeRun(s, round, `sha-${round}`, { verdicts: [] }))
    return { gate: 'decompose', target: s, shas: [] }
  },
}

export async function decideRepo(state: DecideState): Promise<{ repo: TestRepo; gate: GateName; target: string; shas: string[] }> {
  const repo = await seededRepo()
  return { repo, ...(await DECIDE_STATES[state](repo)) }
}

// Row 205 (issue #56). A plan whose spec runs a `cmd:` criterion and a `cmd:` need, in a repo whose
// runner is full-suite, so the config commands the flow runs are `ship.test` and `ship.lint`.
export async function trustRepo(shipTest = 'pnpm test'): Promise<TestRepo> {
  const repo = await seededRepo()
  patchConfig(repo, { criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' }, ship: { test: shipTest, lint: 'pnpm lint' } })
  repo.git('add', 'witness.config.yaml')
  repo.git('commit', '-m', 'full-suite')
  await writeSpec(repo, 'ingest', {
    criteria: [{ id: 'ac-i', test: '@spec:ingest' }, { id: 'ac-a', cmd: 'echo first' }],
    needs: [{ cmd: 'test -d .git' }],
  })
  approve(repo, 'ingest')
  await writePlan(repo, 'ingest-plan-1', { parent: 'ingest', steps: [{ id: 's1', title: 'ingest', criteria: ['ac-i', 'ac-a'] }] })
  return repo
}

// A gate run carrying every optional line `renderGateRun` prints, in one resumed round: the
// review mode, the lens bookkeeping, a check with its held criterion and one without a detail,
// a pin contradiction, a demoted finding, a malformed lens and a standing stop.
export const EVERY_LINE_RUN: GateRunEntry = {
  v: 1, t: 'gate-run', gate: 'implement', artifact: 'auth-refresh-plan-1', round: 2, run_id: 'r2',
  reviewed_sha: 'c0ffee1', prompts_sha: 'p', witness: '0', model: 'm', harness: 'claude-code',
  cached: true, delta: { round: 1, run: 'r1' }, skipped: ['a'], fallback: ['m1', 'm2'], rerolled: ['b'],
  carried: { run: 'r1', lenses: ['c'] },
  checks: [
    { name: 'tests', ok: false, detail: 'ac-rotate:fail',
      held: [{ criterion: 'ac-prod', need: 'prod', satisfy: 'witness satisfy auth-refresh --need prod' }] },
    { name: 'lint', ok: true },
  ],
  verdicts: [{
    reviewer: 'code-reviewer', coverage: [{ anchor: 'src/token.ts', note: 'read' }],
    findings: [
      { blocking: true, anchor: 'src/token.ts', claim: 'collapses the service the pin renders in full', contradicts_pin: 1 },
      { blocking: false, anchor: 'src/session.ts', claim: 'expiry unbounded', demoted: 1 },
    ],
  }],
  malformed: [{ reviewer: 'x', violations: [{ field: 'f', rule: 'r', got: 'g', want: 'w' }] }],
  standing: 'reserved',
  outcome: 'stopped',
}
