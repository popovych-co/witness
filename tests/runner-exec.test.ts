import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { execCommand, runFiltered } from '../src/runner.js'
import { releaseDeadTurn, runnerLockPath, withRunnerTurn } from '../src/runner-lock.js'
import { system32 } from '../src/spawn.js'
import { worktreePath } from '../src/worktree.js'
import {
  approve, awaitGone, breakSingleFixture, copyFixture, fakeCtx, fakeScenario, fixtureEnv, seededRepo, tmpRepo, vitestBin,
  writePlan, writeSpec, type TestRepo, patchConfig, orphansIn, writeOrphanStarter } from './helpers.js'

// D158 (#20). execSync at Node's 1 MiB default threw ENOBUFS into the catch, so a
// chatty-but-GREEN suite was reported as a failed lane and blocked ship with a false red.
describe('execCommand — output larger than Node default maxBuffer', () => {
  it('reports exitZero for a green command whose stdout exceeds 1 MiB', () => {
    const repo = tmpRepo()
    const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
    const out = execCommand(repo.root, ctx, `node -e "process.stdout.write('x'.repeat(2*1024*1024))"`)
    expect(out.exitZero).toBe(true)
    expect(out.output.length).toBeLessThanOrEqual(4000)
  })
})

const TEMPLATE = `node "${vitestBin()}" run -t "@spec:{id}" --passWithNoTests`

describe('runFiltered', () => {
  it('exits zero for a passing tagged spec and nonzero after the break', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'vitest-single')
    const ctx = fakeCtx(repo.root, { env: fixtureEnv() })
    const green = await runFiltered(repo.root, ctx, TEMPLATE, 'auth-refresh')
    expect(green.ok && green.value.exitZero).toBe(true)
    breakSingleFixture(repo)
    const red = await runFiltered(repo.root, ctx, TEMPLATE, 'auth-refresh')
    expect(red.ok && red.value.exitZero).toBe(false)
    expect(red.ok && red.value.output.length > 0).toBe(true)
  })

  it('passes with zero matching tests — the root-runnable contract', async () => {
    const repo = tmpRepo()
    copyFixture(repo, 'vitest-single')
    const res = await runFiltered(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }), TEMPLATE, 'no-such-spec')
    expect(res.ok && res.value.exitZero).toBe(true)
  })

  it('blocks untrusted templates in non-TTY and never executes them', async () => {
    const repo = tmpRepo()
    const marker = join(repo.root, 'ran-auth-refresh.txt')
    const res = await runFiltered(repo.root, fakeCtx(repo.root, { tty: false }), 'touch ran-{id}.txt', 'auth-refresh')
    expect(!res.ok && res.violations[0]?.rule).toBe('untrusted-blocked')
    expect(existsSync(marker)).toBe(false)
  })

  it('prompts once for the raw template — one consent covers every spec id', async () => {
    const repo = tmpRepo()
    const yes = await runFiltered(repo.root, fakeCtx(repo.root, { answers: ['y'] }), 'touch ran-{id}.txt', 'spec-a')
    expect(yes.ok).toBe(true)
    expect(repo.read('.witness/allow.json')).toContain('touch ran-{id}.txt')
    const again = await runFiltered(repo.root, fakeCtx(repo.root, { tty: false }), 'touch ran-{id}.txt', 'spec-b')
    expect(again.ok && existsSync(join(repo.root, 'ran-spec-b.txt'))).toBe(true)
  })

  it('refuses declined templates', async () => {
    const repo = tmpRepo()
    const res = await runFiltered(repo.root, fakeCtx(repo.root, { answers: ['n'] }), 'touch ran-{id}.txt', 'spec-a')
    expect(!res.ok && res.violations[0]?.rule).toBe('untrusted-declined')
  })
})

// Task 3b. The turn is per pid, so the two runs are separate processes: two in-process
// `repo.cli` calls share one pid and would re-enter each other's turn.
const REPO = resolve(import.meta.dirname, '..')
function evidenceChild(cwd: string, plan: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(join(REPO, 'node_modules', '.bin', 'tsx'), [join(REPO, 'src', 'bin.ts'), 'test-evidence', plan, '--phase', 'red', '--step', 's1'],
      { cwd, env: fixtureEnv() as NodeJS.ProcessEnv, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr!.on('data', (d) => { stderr += String(d) })
    child.on('close', (code) => done({ code, stderr }))
  })
}

// Two started plans, one worktree each. Each worktree's runner appends "start <id>" to one
// shared log, sleeps a second and appends "end <id>".
async function twoWorktrees(primary: Record<string, unknown> = {}): Promise<{ repo: TestRepo; log: string; wts: [string, string] }> {
  const repo = await seededRepo()
  for (const s of ['a', 'b']) {
    await writeSpec(repo, s, { criteria: [{ id: `ac-${s}`, test: `@spec:${s}` }] })
    approve(repo, s)
    await writePlan(repo, `${s}-plan-1`, { parent: s, steps: [{ id: 's1', title: s, criteria: [`ac-${s}`] }] })
    approve(repo, `${s}-plan-1`)
    await repo.cli(['start', `${s}-plan-1`])
  }
  patchConfig(repo, primary)
  const log = join(fakeScenario(), 'log')
  const wts = ['a', 'b'].map((s) => worktreePath(repo.root, `${s}-plan-1`)) as [string, string]
  for (const wt of wts) {
    writeFileSync(join(wt, 'turn.sh'), `echo "start $1" >> "${log}"\nsleep 1\necho "end $1" >> "${log}"\nexit 1\n`)
    writeFileSync(join(wt, 'witness.config.yaml'), "schema: 1\ncriteria:\n  runner: 'sh turn.sh {id}'\n")
  }
  return { repo, log, wts }
}

describe('test runs take turns across worktrees (B3)', () => {
  it('test runs in two worktrees take turns and neither refuses (B3)', async () => {
    const { log, wts } = await twoWorktrees()
    const [a, b] = await Promise.all([evidenceChild(wts[0], 'a-plan-1'), evidenceChild(wts[1], 'b-plan-1')])
    expect([a.code, b.code]).toEqual([0, 0])
    const marks = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0])
    expect(marks).toEqual(['start', 'end', 'start', 'end'])
    expect(`${a.stderr}${b.stderr}`).not.toContain('locked')
    expect(`${a.stderr}${b.stderr}`).toContain('runner: waiting for pid')
  }, 60_000)

  it('drive.parallelSuites: true lets them overlap', async () => {
    const { log, wts } = await twoWorktrees({ drive: { parallelSuites: true } })
    const [a, b] = await Promise.all([evidenceChild(wts[0], 'a-plan-1'), evidenceChild(wts[1], 'b-plan-1')])
    expect([a.code, b.code]).toEqual([0, 0])
    const marks = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0])
    expect(marks.slice(0, 2)).toEqual(['start', 'start'])
  }, 60_000)

  it('a dead holder loses its turn', () => {
    const repo = tmpRepo()
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    writeFileSync(join(repo.root, '.witness', 'runner.lock'), JSON.stringify({ pid: 999_999 }))
    expect(withRunnerTurn(repo.root, fakeCtx(repo.root), 'x', () => 42)).toBe(42)
    expect(existsSync(join(repo.root, '.witness', 'runner.lock'))).toBe(false)
  })

  it("releaseDeadTurn removes a dead holder's turn and nothing else (row 218)", () => {
    const repo = tmpRepo()
    const p = runnerLockPath(repo.root)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ pid: 999_999 })); expect(releaseDeadTurn(repo.root)).toBe(true); expect(existsSync(p)).toBe(false)
    writeFileSync(p, JSON.stringify({ pid: process.pid })); expect(releaseDeadTurn(repo.root)).toBe(false); expect(existsSync(p)).toBe(true)
    writeFileSync(p, ''); expect(releaseDeadTurn(repo.root)).toBe(false); expect(existsSync(p)).toBe(true)
  })

  it('a witness run inside a turn re-enters it instead of waiting on its own parent', () => {
    const repo = tmpRepo()
    const loader = join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
    const inner = `import { withRunnerTurn } from '${join(REPO, 'src', 'runner-lock.ts')}'; ` +
      `console.log(withRunnerTurn('${repo.root}', { err: () => {}, env: process.env }, 'inner', () => 'inner-ran'))`
    // perl's alarm bounds a deadlock: node itself (no tsx wrapper to outlive it) is killed,
    // and the outer run reads that as a failure instead of hanging the worker
    const run = execCommand(repo.root, fakeCtx(repo.root, { env: fixtureEnv() }),
      `perl -e 'alarm 15; exec @ARGV' node --import ${loader} -e "${inner}"`)
    expect(run.output).toContain('inner-ran')
    expect(run.exitZero).toBe(true)
  }, 60_000)

  it('a dangling symlink at the turn is taken over after a grace — never a spin', () => {
    const repo = tmpRepo()
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    symlinkSync(join(repo.root, 'nowhere'), join(repo.root, '.witness', 'runner.lock'))
    const t0 = Date.now()
    expect(withRunnerTurn(repo.root, fakeCtx(repo.root), 'x', () => 42)).toBe(42)
    expect(Date.now() - t0).toBeLessThan(4_000)
    expect(() => lstatSync(join(repo.root, '.witness', 'runner.lock'))).toThrow()
  })
})

// Row 218. On Windows a suite starts its app detached, through a starter that exits; the run
// must take it with it anyway — when the run ends, and when its turn holder is killed alone.
const TSX_LOADER = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href

describe.runIf(process.platform === 'win32')('a test run ends with what it started (row 218, win32)', () => {
  const env = { ...process.env, ...fixtureEnv() } as Record<string, string>
  const recorded: number[] = []
  afterEach(() => {
    for (const pid of recorded.splice(0)) {
      try { process.kill(pid) } catch { /* already gone */ }
    }
  })
  const scratch = (): { starter: string; pidFile: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'witness-run-'))
    return { starter: writeOrphanStarter(dir), pidFile: join(dir, 'pids') }
  }

  it('an app the run started detached, through a starter that exited, is gone when execCommand returns', async () => {
    const repo = tmpRepo()
    const { starter, pidFile } = scratch()
    const run = execCommand(repo.root, fakeCtx(repo.root, { env }), `node "${starter}" "${pidFile}"`)
    const pids = orphansIn(pidFile)
    recorded.push(...pids)
    expect(run.exitZero).toBe(true)
    expect(pids).toHaveLength(2)
    for (const pid of pids) expect(await awaitGone(pid)).toBe(true)
  })

  it('a turn holder killed alone takes its run with it', async () => {
    const repo = tmpRepo()
    const { starter, pidFile } = scratch()
    const script = `import { execCommand } from ${JSON.stringify(pathToFileURL(join(REPO, 'src', 'runner.ts')).href)}; ` +
      `execCommand(${JSON.stringify(repo.root)}, { cwd: ${JSON.stringify(repo.root)}, isTTY: false, out: () => {}, err: () => {}, ` +
      `ask: async () => '', env: process.env }, ${JSON.stringify(`node "${starter}" "${pidFile}" stay`)})`
    const child = spawn(process.execPath, ['--import', TSX_LOADER, '-e', script], { env, stdio: 'ignore' })
    if (child.pid !== undefined) recorded.push(child.pid)
    const until = Date.now() + 30_000
    while (orphansIn(pidFile).length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    const pids = orphansIn(pidFile)
    recorded.push(...pids)
    expect(pids).toHaveLength(2)
    spawnSync(system32(process.env, 'taskkill.exe'), ['/PID', String(child.pid), '/F'])
    for (const pid of pids) expect(await awaitGone(pid)).toBe(true)
  })
})
