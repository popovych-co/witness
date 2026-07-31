import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, beforeAll } from 'vitest'
import {
  approve, fakeScenario, fixtureEnv, fixturePath, gateEnv, putVerdict,
  seededRepo, singleConfig, TOKEN_BROKEN, TOKEN_FIXED, witnessDesign, writeDesign, writePlan, writeSpec,
} from '../helpers.js'
import { splitDoc } from '../../src/fm.js'
import { readStream } from '../../src/journal.js'

const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))
const bin = join(pkgRoot, 'dist', 'bin.js')

// a genuine subprocess is required for crash-injection (WITNESS_CRASH_AFTER + exit 9) —
// repo.cli() below calls main() in-process and can't be killed mid-transaction.
function spawnCli(root: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr }
}

// the browser-e2e stand-in: writes a screen capture when WITNESS_SCREENS_DIR is set,
// tagged onto the same spec as the fixture's own red/green tests. Always passes — the
// fixture's TOKEN_BROKEN/TOKEN_FIXED swap owns red/green, this test owns the screenshot.
const CAPTURE_TEST = `import { expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
it('renders the new-service screen @spec:auth-refresh', () => {
  const dir = process.env.WITNESS_SCREENS_DIR
  if (dir) writeFileSync(join(dir, 'initial.png'), Buffer.from('PNGBYTES-v1'))
  expect(1).toBe(1)
})
`

const PAIR_CLEAN = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [],
}
const DESIGN_GATE_CLEAN = {
  coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'auth-refresh > ## Behavior', note: 'r' }],
  findings: [],
}
const DESIGN_BLOCK = {
  coverage: [{ anchor: 'initial.png', note: 'reviewed' }],
  findings: [{ blocking: true, anchor: 'initial.png', claim: 'primary action below the fold — violates sticky save bar canon' }],
}
const DESIGN_SCREEN_CLEAN = { coverage: [{ anchor: 'initial.png', note: 'reviewed' }], findings: [] }

// tree verdicts must cover min(5, changed) DISTINCT changed files — computed fresh each
// call, same merge-base discipline as pipeline.test.ts's treeClean (main keeps moving).
function treeClean(worktree: string) {
  const base = execFileSync('git', ['-C', worktree, 'merge-base', 'HEAD', 'main'], { encoding: 'utf8' }).trim()
  const tracked = execFileSync('git', ['-C', worktree, 'diff', '--name-only', base], { encoding: 'utf8' })
  const untracked = execFileSync('git', ['-C', worktree, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })
  const files = [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))]
  return { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] }
}

beforeAll(() => {
  spawnSync('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'ignore' })
}, 120_000)

describe('the design lens, end to end', () => {
  it('approved design → capture → design-reviewer blocks → revise → green, and converges through a crash', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', singleConfig('filtered'))
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'runner config')
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')

    // design: author → gate (always stops, same footing as ship) → approve
    const designScenario = fakeScenario()
    putVerdict(designScenario, DESIGN_GATE_CLEAN)
    await writeDesign(repo, 'auth-refresh')
    await witnessDesign(repo, 'auth-refresh')
    const designGate = await repo.cli(['gate', 'design', 'auth-refresh'], { env: gateEnv(designScenario) })
    expect(designGate.code).toBe(1)
    expect((await repo.cli(['decide', 'design', 'auth-refresh', '--approve'])).code).toBe(0)

    // plan: pin design-from to the approved artifact's sha, gate green
    const stamp = splitDoc(repo.read('specs/auth-refresh.md'))
    const designSha = stamp.ok ? (stamp.value.meta.design as { sha: string }).sha : ''
    expect(designSha).toMatch(/^[0-9a-f]{64}$/)
    await writePlan(repo, 'auth-refresh-plan-1', { parent: 'auth-refresh', 'design-from': designSha })
    const planScenario = fakeScenario()
    putVerdict(planScenario, PAIR_CLEAN)
    expect((await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(planScenario) })).code).toBe(0)

    // start + red→green evidence, a screen capture riding the same cycle
    // (the plan gate's auto-pass above already stamped the plan to 'approved')
    await repo.cli(['start', 'auth-refresh-plan-1'])
    const wt = join(repo.root, '.witness/worktrees/auth-refresh-plan-1')
    cpSync(fixturePath('vitest-single'), wt, { recursive: true, filter: (s) => !s.includes('node_modules') })
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    writeFileSync(join(wt, 'tests/capture.test.ts'), CAPTURE_TEST)
    execFileSync('git', ['-C', wt, 'add', '-A'])
    execFileSync('git', ['-C', wt, 'commit', '-m', 'tests first'])
    let ev = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { cwd: wt, env: fixtureEnv() })
    expect(ev.code).toBe(0)
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_FIXED)
    execFileSync('git', ['-C', wt, 'add', '-A'])
    execFileSync('git', ['-C', wt, 'commit', '-m', 'green'])
    ev = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { cwd: wt, env: fixtureEnv() })
    expect(ev.code).toBe(0)

    // implement gate: 4 tree lenses clean, design-reviewer blocks a planted violation
    const blockScenario = fakeScenario()
    putVerdict(blockScenario, treeClean(wt))
    putVerdict(blockScenario, DESIGN_BLOCK, 5)
    const blocked = await repo.cli(['gate', 'implement', 'auth-refresh-plan-1'], { env: gateEnv(blockScenario) })
    expect(blocked.code).toBe(1)
    const blockedRuns = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'gate-run')
    const blockedFindings = (blockedRuns.at(-1) as { verdicts?: Array<{ reviewer: string; findings: Array<{ anchor: unknown }> }> }).verdicts ?? []
    const designFinding = blockedFindings.find((v) => v.reviewer === 'design-reviewer')
    expect(designFinding?.findings[0]?.anchor).toBe('initial.png')

    // human: revise with a note — reopens the round, doesn't itself change anything reviewed
    expect((await repo.cli(['decide', 'implement', 'auth-refresh-plan-1', '--revise', '--note', 'fix the save bar'])).code).toBe(0)

    // the fix: a real code change (bumps the reviewed tree-sha — revising must change
    // something, or the gate correctly refuses "changed nothing") + a fresh capture
    writeFileSync(join(wt, 'src/token.ts'), `${TOKEN_FIXED}\n// ui-fix: sticky save bar restored\n`)
    execFileSync('git', ['-C', wt, 'add', '-A'])
    execFileSync('git', ['-C', wt, 'commit', '-m', 'fix: sticky save bar'])
    ev = await repo.cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { cwd: wt, env: fixtureEnv() })
    expect(ev.code).toBe(0)

    // re-gate: design-reviewer clean this time — crash right at the journal commit,
    // recover, and confirm the re-run converges to the same green outcome (north star 6)
    const greenScenario = fakeScenario()
    putVerdict(greenScenario, treeClean(wt))
    putVerdict(greenScenario, DESIGN_SCREEN_CLEAN, 5)
    const greenEnv = gateEnv(greenScenario)
    const crashed = spawnCli(repo.root, ['gate', 'implement', 'auth-refresh-plan-1'], { ...greenEnv, WITNESS_CRASH_AFTER: 'gate-journal' })
    expect(crashed.code).toBe(9)
    expect(spawnCli(repo.root, ['recover', '--complete']).code).toBe(0)
    const resumed = spawnCli(repo.root, ['gate', 'implement', 'auth-refresh-plan-1'], greenEnv)
    expect(resumed.code).toBe(0)

    const runs = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'gate-run') as unknown as Array<{ outcome: string }>
    expect(runs.at(-1)?.outcome).toBe('passed')
  }, 300_000)
})
