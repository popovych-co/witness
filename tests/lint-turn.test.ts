import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGate } from '../src/gate.js'
import '../src/gates/index.js'
import { readStream } from '../src/journal.js'
import type { GateRunEntry } from '../src/rounds.js'
import { execCommand } from '../src/runner.js'
import { runnerLockPath } from '../src/runner-lock.js'
import { fakeCtx, fakeScenario, gateEnv, patchConfig, putVerdict, shippableRepo, tmpRepo, trustConfig } from './helpers.js'

// The four files the vitest-single fixture lands in the worktree diff (tests/ship-junit.test.ts).
const CLEAN = {
  coverage: ['.gitignore', 'package.json', 'src/token.ts', 'tests/token.test.ts'].map((anchor) => ({ anchor, note: 'read' })),
  findings: [],
}

describe('lint takes no turn (row 255)', () => {
  it('ship runs its lint outside the test turn and its tests inside it', async () => {
    const { repo, planId } = await shippableRepo()
    patchConfig(repo, { ship: { test: 'test -n "$WITNESS_RUNNER_TURN"', lint: 'test -z "$WITNESS_RUNNER_TURN"' } })
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'lanes that say where they ran')
    trustConfig(repo)
    const scenario = fakeScenario()
    putVerdict(scenario, CLEAN)
    await runGate(fakeCtx(repo.root, { env: gateEnv(scenario) }), 'ship', planId, { fresh: false, manual: false })
    const ship = (readStream(repo.root, planId).filter((e) => e.t === 'gate-run') as unknown as GateRunEntry[])
      .filter((r) => r.gate === 'ship').at(-1)!
    expect(ship.checks.find((c) => c.name === 'tests')!.ok).toBe(true)
    expect(ship.checks.find((c) => c.name === 'lint')!.ok).toBe(true)
  }, 240_000)

  it('execCommand with turn: false never waits on a live holder', () => {
    const repo = tmpRepo()
    // The holder dies in 3 s, so a RED run ends. It is an orphan, not this worker's child: a child
    // that exits stays a zombie until its parent's event loop reaps it, and a turn wait blocks that
    // loop, so a child holder would read alive forever.
    const holder = Number(spawnSync('sh', ['-c', 'sleep 3 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim())
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    writeFileSync(runnerLockPath(repo.root), JSON.stringify({ pid: holder }))
    const t0 = Date.now()
    expect(execCommand(repo.root, fakeCtx(repo.root), 'true', { turn: false }).exitZero).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
})
