import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { contained, containmentLine, JOB_PROBE_EXIT, JOB_SCRIPT, jobHost, type JobHost, winArg } from '../src/contain.js'
import { system32, type ResolvedSpawn } from '../src/spawn.js'
import { awaitGone, orphansIn, writeOrphanStarter } from './helpers.js'

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const host: JobHost = { ok: true, file: PS }
const batch: ResolvedSpawn = {
  file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', '""C:\\x\\pi.cmd" ^^^"-p^^^""'],
  env: { A: '1', PSModulePath: 'C:\\m' }, windowsVerbatimArguments: true,
}

describe('contained — the job host, built on any OS (row 218)', () => {
  it('a batch run goes through System32 PowerShell, its command line in the environment, verbatim', () => {
    expect(contained(batch, host)).toEqual({
      file: PS, args: ['-NoProfile', '-NonInteractive', '-Command', JOB_SCRIPT],
      env: { A: '1', PSModulePath: 'C:\\m', WITNESS_JOB_FILE: batch.file, WITNESS_JOB_ARGS: batch.args.join(' '), WITNESS_JOB_PSMODULEPATH: 'C:\\m' },
      windowsVerbatimArguments: false,
    })
  })
  it('an image run carries its arguments quoted the way libuv quotes them', () => {
    const run = { file: 'C:\\n\\node.exe', args: ['-e', 'a b', ''], env: {}, windowsVerbatimArguments: false }
    expect(contained(run, host).env).toMatchObject({ WITNESS_JOB_ARGS: '-e "a b" ""', WITNESS_JOB_PSMODULEPATH: '' })
  })
  it('with no host the run is the run', () => {
    expect(contained(batch, { ok: false, why: 'x' })).toBe(batch)
  })
  it('never passes -ExecutionPolicy, and never allows silent breakaway', () => {
    expect(contained(batch, host).args).not.toContain('-ExecutionPolicy')
    expect(JOB_SCRIPT).toContain('$b.LimitFlags = 0x2800')
  })
})

describe("winArg — libuv's quote_cmd_arg", () => {
  it.each([
    ['', '""'], ['hello', 'hello'], ['hello world', '"hello world"'], ['hello\\world', 'hello\\world'],
    ['hello"world', '"hello\\"world"'], ['hello""world', '"hello\\"\\"world"'],
    ['hello\\"world', '"hello\\\\\\"world"'], ['hello world\\', '"hello world\\\\"'], ['a\tb', '"a\tb"'],
  ])('%j → %j', (arg, want) => expect(winArg(arg)).toBe(want))
})

describe('jobHost', () => {
  it('off win32 there is none, and nothing is probed', () => {
    expect(jobHost({}, 'linux')).toEqual({ ok: false, why: 'no job objects on linux' })
  })
  it("a parent's answer is taken as given", () => {
    expect(jobHost({ WITNESS_JOB_HOST: 'job', SystemRoot: 'D:\\W' }, 'win32'))
      .toEqual({ ok: true, file: 'D:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })
    expect(jobHost({ WITNESS_JOB_HOST: 'none' }, 'win32').ok).toBe(false)
  })
})

describe('containmentLine', () => {
  it('names what ends a session on each platform', () => {
    expect(containmentLine(host, 'win32')).toBe("containment: job objects — what drive's work starts ends with it")
    expect(containmentLine({ ok: false, why: 'Add-Type blocked' }, 'win32'))
      .toBe("containment: none — Add-Type blocked · a stopped session's tree is still stopped")
    expect(containmentLine({ ok: false, why: 'x' }, 'linux'))
      .toBe('containment: process groups — what a session starts ends with it, unless it leaves the group')
  })
})

// ---------------------------------------------------------------------------------------
// Windows only: the host against real job objects. The stand-in is writeOrphanStarter — a suite
// starting its app detached and moving on, so the app's parent is gone before anything stops it.

describe.runIf(process.platform === 'win32')('the job host on Windows (row 218)', () => {
  const nodeRun = (args: string[], env: Record<string, string | undefined> = process.env): ResolvedSpawn =>
    ({ file: process.execPath, args, env, windowsVerbatimArguments: false })
  const recorded: number[] = []
  let live: JobHost
  beforeAll(() => { live = jobHost(process.env) })
  afterEach(() => {
    for (const pid of recorded.splice(0)) {
      try { process.kill(pid) } catch { /* already gone */ }
    }
  })
  const scratch = (): { starter: string; pidFile: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'witness-contain-'))
    return { starter: writeOrphanStarter(dir), pidFile: join(dir, 'pids') }
  }
  const run = (r: ResolvedSpawn, extra: Record<string, string> = {}) =>
    spawnSync(r.file, r.args, { env: { ...r.env, ...extra }, encoding: 'utf8', windowsVerbatimArguments: r.windowsVerbatimArguments })

  it('the probe finds a host on this machine', () => {
    const env = { ...process.env }
    delete env.WITNESS_JOB_HOST
    expect(jobHost(env)).toMatchObject({ ok: true })
  })

  it('a run that ends leaves nothing it started — the orphan included', async () => {
    const { starter, pidFile } = scratch()
    const r = run(contained(nodeRun(['-e',
      "require('node:child_process').execFileSync(process.execPath, [process.argv[1], process.argv[2]]); process.exit(9)",
      starter, pidFile]), live))
    const pids = orphansIn(pidFile)
    recorded.push(...pids)
    expect(r.status).toBe(9)
    expect(pids).toHaveLength(2)
    for (const pid of pids) expect(await awaitGone(pid)).toBe(true)
  })

  it('a host killed alone takes the whole run with it', async () => {
    const { starter, pidFile } = scratch()
    const hosted = contained(nodeRun(['-e',
      "require('node:child_process').execFileSync(process.execPath, [process.argv[1], process.argv[2], 'stay'])",
      starter, pidFile]), live)
    const child = spawn(hosted.file, hosted.args, { env: hosted.env, stdio: 'ignore', windowsVerbatimArguments: hosted.windowsVerbatimArguments })
    if (child.pid !== undefined) recorded.push(child.pid)
    const until = Date.now() + 20_000
    while (orphansIn(pidFile).length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    const pids = orphansIn(pidFile)
    recorded.push(...pids)
    expect(pids).toHaveLength(2)
    spawnSync(system32(process.env, 'taskkill.exe'), ['/PID', String(child.pid), '/F'])
    for (const pid of pids) expect(await awaitGone(pid)).toBe(true)
  })

  it('exit codes cross the host unchanged', () => {
    for (const code of [0, 1, 3, 255, 0xC000013A]) {
      const direct = spawnSync(process.execPath, ['-e', `process.exit(${code})`])
      expect(run(contained(nodeRun(['-e', `process.exit(${code})`]), live)).status).toBe(direct.status)
    }
  })

  it("the command sees the caller's environment, not the host's", () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PSMODULEPATH'))
    const r = run(contained(nodeRun(['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { ...env, WitnessMixedCase: 'MiXeD', PSModulePath: 'C:\\caller' }), live))
    const seen = JSON.parse(r.stdout) as Record<string, string>
    expect(Object.keys(seen).filter((k) => k.toUpperCase().startsWith('WITNESS_JOB_'))).toEqual([])
    expect(Object.keys(seen).filter((k) => k.toUpperCase() === 'PSEXECUTIONPOLICYPREFERENCE')).toEqual([])
    expect(seen.PSModulePath).toBe('C:\\caller')
    expect(seen.WitnessMixedCase).toBe('MiXeD')
  })

  it('a job it cannot enter costs containment, never the run', () => {
    const broken = JOB_SCRIPT.replace('public static extern IntPtr CreateJobObject(', 'public static extern IntPtr CreateJobObjectX(')
    expect(broken).not.toBe(JOB_SCRIPT)
    const hosted = contained(nodeRun(['-e', 'process.exit(4)']), live)
    const r = run({ ...hosted, args: ['-NoProfile', '-NonInteractive', '-Command', broken] })
    expect(r.status).toBe(4)
    expect(r.stderr).toMatch(/^witness: no job \(/)
    expect(run({ ...hosted, args: ['-NoProfile', '-NonInteractive', '-Command', broken] }, { WITNESS_JOB_PROBE: '1' }).status)
      .toBe(JOB_PROBE_EXIT)
  })
})
