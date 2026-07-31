import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { cpSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { fakeBinDir, fakeScenario, fixtureEnv, fixturePath, ghState, putVerdict, singleConfig, TOKEN_BROKEN, vitestBin } from '../helpers.js'

const BIN = resolve(import.meta.dirname, '../../dist/bin.js')
const RECAP = {
  effort: 'auth-hardening', class: 'feature',
  goals: [{ id: 'g1', text: 'Refresh tokens rotate before expiry' }],
  non_goals: [], constraints: [], slices: ['token rotation'],
}
const SPEC_META = {
  type: 'spec', summary: 'Refresh tokens rotate before expiry', depends: [], needs: [],
  criteria: [{ id: 'ac-rotate', test: '@spec:auth-refresh' }], covers: ['g1'],
}
const SPEC_BODY = '## Motivation\nTokens must rotate.\n\n## Behavior\nrotateToken() returns true before expiry.\n'
const PLAN_META = {
  type: 'plan', parent: 'auth-refresh', depends: [], needs: [],
  steps: [{ id: 's1', title: 'rotate tokens', criteria: ['ac-rotate'] }],
}
const PLAN_BODY = '## Step: s1\nImplement rotation against the tagged test.\n'
const DOC_CLEAN = {
  coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [],
}
const PAIR_CLEAN = {
  coverage: [
    { anchor: 'auth-refresh-plan-1 > ## Step: s1', note: 'read' },
    { anchor: 'auth-refresh > ## Behavior', note: 'read' },
  ],
  findings: [],
}
// tree verdicts must cover min(5, changed) DISTINCT changed files — compute, don't guess.
// Diff against merge-base, not literally 'main': specflow's own state commits (start,
// test-evidence) land on main in the PRIMARY checkout while this runs, so main's tip keeps
// moving ahead of the worktree's branch point — diffing against the moving tip would pull
// in unrelated files (.specflow/journal/…, plans/…) and, via the slice(0,5) cap, push out
// a real one (tests/token.test.ts). merge-base is exactly what the gate's own diffBase uses.
function treeClean(worktree: string) {
  const base = execFileSync('git', ['-C', worktree, 'merge-base', 'HEAD', 'main'], { encoding: 'utf8' }).trim()
  const tracked = execFileSync('git', ['-C', worktree, 'diff', '--name-only', base], { encoding: 'utf8' })
  const untracked = execFileSync('git', ['-C', worktree, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })
  const files = [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))]
  return { coverage: files.slice(0, 5).map((f) => ({ anchor: f, note: 'read' })), findings: [] }
}

let root: string
let wt: string
let scenario: string
let env: Record<string, string>

function cli(args: string[], opts: { cwd?: string; crashAfter?: string; expect?: number[] } = {}): SpawnSyncReturns<string> {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? root,
    env: { ...env, ...(opts.crashAfter ? { SPECFLOW_CRASH_AFTER: opts.crashAfter } : {}) },
    encoding: 'utf8',
  })
  const allowed = opts.expect ?? [0]
  if (!allowed.includes(r.status ?? -1)) {
    throw new Error(`specflow ${args.join(' ')} → ${r.status}\n${r.stdout}\n${r.stderr}`)
  }
  return r
}

// crash → verify exit 9 → recover → the step re-run must converge
function withCrash(point: string, args: string[], opts: { cwd?: string; expect?: number[] } = {}) {
  const crashed = cli(args, { ...opts, crashAfter: point, expect: [9] })
  expect(crashed.status).toBe(9)
  cli(['recover', '--complete'], { expect: [0] })
  return cli(args, opts)
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: resolve(import.meta.dirname, '../..') })
  root = fakeScenario()                                     // reuse the tmp-dir maker
  scenario = fakeScenario()
  env = {
    ...fixtureEnv({ VITEST_BIN: vitestBin() }),
    PATH: `${fakeBinDir()}:${process.env.PATH ?? ''}`,
    SPECFLOW_FAKE_DIR: scenario,
    SPECFLOW_TRUST_CMDS: '1',
  }
  execFileSync('git', ['init', '-b', 'main', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'p@t.dev'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'protocol'])
  cli(['init'])
  // ship gate's command lanes (tests/lint) need something configured — trivial always-green
  // commands, same choice as helpers.ts's shippableRepo, since the fixture's own suite isn't
  // what's under test here.
  writeFileSync(join(root, 'specflow.config.yaml'), `${singleConfig('filtered')}ship:\n  test: 'true'\n  lint: 'true'\n`)
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'runner config'])
  const bare = `${root}-origin.git`
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])   // see helpers.ts addOrigin
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', bare])
  execFileSync('git', ['-C', root, 'push', '-u', 'origin', 'main'])
}, 240_000)

describe('the whole pipeline, killed and resumed at every boundary', () => {
  it('recap → decompose stop → approve → plan gate → start → evidence → implement → ship → merge', () => {
    writeFileSync(join(root, 'recap.json'), JSON.stringify(RECAP))
    cli(['recap', '--file', 'recap.json'])

    writeFileSync(join(root, 'm.json'), JSON.stringify(SPEC_META))
    writeFileSync(join(root, 'b.md'), SPEC_BODY)
    cli(['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm.json', '--body', 'b.md'])

    putVerdict(scenario, DOC_CLEAN)
    withCrash('gate-journal', ['gate', 'decompose', '--effort', 'auth-hardening'], { expect: [1] })
    expect(cli(['next']).stdout).toContain('decide decompose')
    // decide is a one-shot transition, not resumable like gate/start/ship/next — once
    // crash+recovery applies it, re-running the same decide would correctly refuse
    // nothing-pending. Verify convergence via the crash+recover pair itself (the plan
    // write below requires the parent approved, which implicitly proves it landed).
    const crashedDecide = cli(['decide', 'decompose', 'auth-hardening', '--approve'], { crashAfter: 'decide-journal', expect: [9] })
    expect(crashedDecide.status).toBe(9)
    cli(['recover', '--complete'], { expect: [0] })

    writeFileSync(join(root, 'pm.json'), JSON.stringify(PLAN_META))
    writeFileSync(join(root, 'pb.md'), PLAN_BODY)
    cli(['write', 'auth-refresh-plan-1', '--effort', 'auth-hardening', '--meta', 'pm.json', '--body', 'pb.md'])
    putVerdict(scenario, PAIR_CLEAN)
    cli(['gate', 'plan', 'auth-refresh-plan-1'])            // green path auto-pass
    // resume through a real process: unchanged content appends nothing
    const before = cli(['log', 'auth-refresh-plan-1']).stdout
    cli(['gate', 'plan', 'auth-refresh-plan-1'])
    expect(cli(['log', 'auth-refresh-plan-1']).stdout).toBe(before)

    withCrash('start-commit', ['start', 'auth-refresh-plan-1'])
    wt = join(root, '.specflow/worktrees/auth-refresh-plan-1')
    expect(existsSync(wt)).toBe(true)

    cpSync(fixturePath('vitest-single'), wt, { recursive: true, filter: (s) => !s.includes('node_modules') })
    // TOKEN_BROKEN/TOKEN_FIXED, not a hand-rolled stub — the fixture's own tagged tests
    // import rotateDue/nextToken from src/token, not a rotateToken() of our own invention.
    writeFileSync(join(wt, 'src/token.ts'), TOKEN_BROKEN)
    execFileSync('git', ['-C', wt, 'add', '-A'])
    execFileSync('git', ['-C', wt, 'commit', '-m', 'tests first'])
    cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'red'], { cwd: wt })
    cpSync(join(fixturePath('vitest-single'), 'src/token.ts'), join(wt, 'src/token.ts'))
    execFileSync('git', ['-C', wt, 'add', '-A'])
    execFileSync('git', ['-C', wt, 'commit', '-m', 'green'])
    cli(['test-evidence', 'auth-refresh-plan-1', '--phase', 'green'], { cwd: wt })

    putVerdict(scenario, treeClean(wt))
    cli(['gate', 'implement', 'auth-refresh-plan-1'])       // exit 0: green path

    cli(['ship', 'auth-refresh-plan-1'], { expect: [1] })   // ship always stops
    cli(['decide', 'ship', 'auth-refresh-plan-1', '--approve'])
    withCrash('pr-stamp', ['ship', 'auth-refresh-plan-1'])
    expect(cli(['log', 'auth-refresh-plan-1']).stdout).toContain('pr')

    ghState(scenario, 1, 'MERGED')
    withCrash('merge-stamp', ['next'])
    const dashboard = cli([]).stdout
    expect(dashboard).toContain('live')
    expect(cli(['log', 'auth-refresh-plan-1']).stdout).toContain('in-progress → done (merge)')
    expect(cli(['log', 'auth-refresh']).stdout).toContain('→ live (merge)')
    expect(existsSync(wt)).toBe(false)                      // reaped
  }, 600_000)
})
