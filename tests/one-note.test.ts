import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { decideView } from '../src/decide-view.js'
import { driveLoop } from '../src/drive.js'
import { gateSpec } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import { notePrefill, type DecisionEntry } from '../src/rounds.js'
import { loadCanon } from '../src/scan.js'
import { settleStop } from '../src/settle.js'
import { autonomyOn, commitEntry, fakeCtx, fakeScenario, fixtureEnv, noopOpener, plannedRepo, type TestRepo } from './helpers.js'
import { dropStub, MODES, pasteIn } from './shells.js'

// Row 239. One block, one note: every surface that takes a decision runs the option's argv, and
// `decide` derives the note from the journal, so the note the UI, drive, settle and a pasted
// line journal is one note, whatever the reviewer's anchor holds. No surface reads a printed
// line back to learn what to run.

const PLAN = 'auth-refresh-plan-1'
// Text that runs code in a shell, and quotes of both kinds.
const ANCHOR = `p1 > ## Notes $(touch M1) "q" 'r'`

const cfgOf = (repo: TestRepo): Config => {
  const r = loadConfig(repo.root)
  if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
  return r.value
}

// One stopped plan gate on the current bytes, its one blocking finding at ANCHOR. Journaled as
// a run, since a reviewer's verdict must anchor where the plan has a heading: the gate refuses
// any other anchor before it journals.
async function stoppedPlan(): Promise<TestRepo> {
  const repo = await plannedRepo({ autonomy: false })
  const sha = gateSpec('plan')!.currentSha!(repo.root, loadCanon(repo.root), cfgOf(repo), PLAN)
  commitEntry(repo, PLAN, {
    t: 'gate-run', gate: 'plan', artifact: PLAN, round: 1, run_id: 'r-1', reviewed_sha: sha, prompts_sha: 'ps',
    witness: '0', model: 'm', pin: 'm', harness: 'claude-code', checks: [], outcome: 'stopped',
    verdicts: [{ reviewer: 'plan-critic', coverage: [], findings: [{ blocking: true, anchor: ANCHOR, claim: 'x' }] }],
  })
  return repo
}

// A session that does nothing, so the loop's spawn after the decision reaches no harness.
const idleAgent = (): string => {
  const bin = join(fakeScenario(), 'idle-agent')
  writeFileSync(bin, '#!/bin/sh\necho tick\nexit 0\n', { mode: 0o755 })
  return bin
}

// Each way a human, the policy or a paste takes the block's recommended revise, and who the
// journal says selected it. A pasted line needs a shell: none on win32.
type Surface = [name: string, selected: DecisionEntry['selected'], revise: (repo: TestRepo) => Promise<void>]
const SURFACES: Surface[] = [
  ['the UI', undefined, async (repo) => {
    const view = decideView(repo.root, cfgOf(repo), loadCanon(repo.root), 'plan', PLAN)
    if (view.state !== 'actionable' || view.block === undefined) throw new Error(`no block to act on: ${view.state}`)
    expect((await repo.cli(['decide', ...view.block.options[0]!.act!.argv.slice(1)])).code).toBe(0)
  }],
  ['drive', 'affirmation', async (repo) => {
    const ctx = fakeCtx(repo.root, {
      tty: true, answers: ['y'], env: fixtureEnv({ WITNESS_DRIVE_AGENT_BIN: idleAgent(), WITNESS_KEEP_AWAKE_BIN: noopOpener() }),
    })
    await driveLoop(repo.root, cfgOf(repo), ctx, { maxSpawns: 1 })
  }],
  ['settle', 'policy', async (repo) => {
    autonomyOn(repo)
    expect(await settleStop(fakeCtx(repo.root, { env: fixtureEnv() }), repo.root, cfgOf(repo), 'plan', PLAN))
      .toMatchObject({ kind: 'decided', by: 'policy', decision: 'revise' })
  }],
  ...(MODES.includes('bash') ? [['a pasted line', undefined, async (repo) => {
    const run = (await repo.cli(['decide', 'plan', PLAN, '--show'])).stdout.split('\n').find((l) => l.startsWith('run: '))
    if (run === undefined) throw new Error('decide --show printed no run: line')
    const pasted = await pasteIn('bash', run.slice('run: '.length))
    expect(pasted.markers).toEqual([])
    expect(pasted.calls).toHaveLength(1)
    expect((await repo.cli(pasted.calls[0]!.slice(1))).code).toBe(0)
  }] as Surface] : []),
]

afterAll(dropStub)

it('one block journals one note on every surface, and no line is reparsed (row 239)', async () => {
  for (const [surface, selected, revise] of SURFACES) {
    const repo = await stoppedPlan()
    const note = notePrefill(readStream(repo.root, PLAN), 'plan')
    expect(note).toBe(`1 blocking finding: ${ANCHOR}`)
    await revise(repo)
    const decided = readStream(repo.root, PLAN).filter((e) => e.t === 'human-decision') as unknown as DecisionEntry[]
    expect(decided, surface).toHaveLength(1)
    expect(decided[0], surface).toMatchObject({ decision: 'revise', note })
    expect(decided[0]!.selected, surface).toBe(selected)
  }
}, 60000)
