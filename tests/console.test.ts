import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../src/cli.js'
import { detachDrive } from '../src/drive.js'
import { NO_CONSOLE_ENV, execFileSync, execSync, spawn, spawnSync, withoutConsole } from '../src/spawn.js'
import { seededRepo } from './helpers.js'

// Every child process witness starts, with the argv and options it was handed. Each call passes
// through, except the background drive: it is recorded, never started.
interface Call { fn: string; file: string; args: string[]; opts: Record<string, unknown> }
const calls = vi.hoisted(() => [] as Call[])
vi.mock('node:child_process', async (importOriginal) => {
  const cp = await importOriginal<typeof import('node:child_process')>()
  const record = (fn: string, real: (...a: unknown[]) => unknown) => (file: string, ...rest: unknown[]) => {
    const [args, opts] = Array.isArray(rest[0]) ? [rest[0] as string[], rest[1]] : [[], rest[0]]
    const o = (opts ?? {}) as Record<string, unknown>
    calls.push({ fn, file, args, opts: o })
    if ((o.env as Record<string, string | undefined> | undefined)?.WITNESS_DRIVE_LOG !== undefined) {
      return { pid: 4242, on() { return this }, unref() {} }
    }
    return real(file, ...rest)
  }
  const wrapped = {
    spawn: record('spawn', cp.spawn as never), spawnSync: record('spawnSync', cp.spawnSync as never),
    execFileSync: record('execFileSync', cp.execFileSync as never), execSync: record('execSync', cp.execSync as never),
  }
  return { ...cp, ...wrapped, default: { ...cp, ...wrapped } }
})

const SRC = join(import.meta.dirname, '..', 'src')
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
})
const sources = () => walk(SRC).filter((f) => f !== join(SRC, 'spawn.ts'))
const node = process.execPath

beforeEach(() => { calls.length = 0 })

describe('one module starts a child process (row 201)', () => {
  it('only src/spawn.ts imports child_process', () => {
    expect(walk(SRC)).toContain(join(SRC, 'spawn.ts'))
    const hits = sources().filter((f) => /['"](?:node:)?child_process['"]/.test(readFileSync(f, 'utf8')))
    expect(hits.map((f) => f.slice(SRC.length + 1))).toEqual([])
  })

  it('only the viewer decides its own window', () => {
    const hits = sources().filter((f) => /\bwindowsHide\s*:/.test(readFileSync(f, 'utf8')))
    expect(hits.map((f) => f.slice(SRC.length + 1))).toEqual(['opener.ts'])
  })
})

describe('a child starts hidden only where witness has no console (row 201)', () => {
  const everyForm = () => {
    spawnSync(node, ['-e', '0'], { encoding: 'utf8' })
    execFileSync(node, ['-e', '0'], { encoding: 'utf8' })
    execSync(`"${node}" -e 0`)
    spawn(node, ['-e', '0'], { stdio: 'ignore' }).unref()
  }

  it('leaves windowsHide off outside the scope and turns it on inside, in every form', () => {
    everyForm()
    expect(calls.map((c) => c.opts.windowsHide)).toEqual([false, false, false, false])
    calls.length = 0
    withoutConsole(everyForm)
    expect(calls.map((c) => c.opts.windowsHide)).toEqual([true, true, true, true])
  })

  it('keeps what the caller passed — argv, options, the return type', () => {
    const out = withoutConsole(() => execFileSync(node, ['-p', '"ok"'], { encoding: 'utf8', maxBuffer: 1024 }))
    expect(out.trim()).toBe('ok')
    expect(calls[0]).toMatchObject({ args: ['-p', '"ok"'], opts: { encoding: 'utf8', maxBuffer: 1024, windowsHide: true } })
  })

  it('reads the options of a call that passes no argv', () => {
    withoutConsole(() => execSync(`"${node}" -e 0`, { stdio: 'ignore' }))
    withoutConsole(() => spawnSync(node, { input: '', stdio: 'pipe' }))
    expect(calls.map((c) => [c.args, c.opts.windowsHide])).toEqual([[[], true], [[], true]])
  })

  it('lets an explicit windowsHide win — the viewer is never hidden', () => {
    withoutConsole(() => spawnSync(node, ['-e', '0'], { windowsHide: false }))
    expect(calls[0]!.opts.windowsHide).toBe(false)
  })
})

describe('the background drive has no console (row 201)', () => {
  it('drive --detach hands the background drive the marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'witness-console-'))
    const ctx: Ctx = { cwd: root, env: { ...process.env }, isTTY: false, out: () => {}, err: () => {}, ask: async () => '' }
    expect(detachDrive(root, ctx, ['--max-spawns', '1']).ok).toBe(true)
    const bg = calls.find((c) => c.fn === 'spawn' && c.opts.detached === true)
    expect((bg!.opts.env as Record<string, string | undefined>)[NO_CONSOLE_ENV]).toBe('1')
  })

  it('an invocation carrying the marker starts every child hidden, the floor gate\'s git calls included', async () => {
    const repo = await seededRepo()
    calls.length = 0
    expect((await repo.cli(['status'], { env: { [NO_CONSOLE_ENV]: '1' } })).code).toBe(0)
    expect(calls.some((c) => c.file === 'git' && c.args.includes('--show-toplevel'))).toBe(true)
    expect(calls.filter((c) => c.opts.windowsHide !== true)).toEqual([])
  })

  it('without the marker nothing is hidden — a foreground child shares the terminal, and its Ctrl+C', async () => {
    const repo = await seededRepo()
    calls.length = 0
    expect((await repo.cli(['status'])).code).toBe(0)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.opts.windowsHide !== false)).toEqual([])
  })

  it('an invocation run in process inside the scope stays hidden — drive\'s decisions', async () => {
    const repo = await seededRepo()
    calls.length = 0
    await withoutConsole(() => repo.cli(['status']))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.opts.windowsHide !== true)).toEqual([])
  })
})

// The contract itself, through the real CreateProcess: a process with no console (as the
// background drive is) asks Windows for a child's console window. GetConsoleWindow is 0 for a
// console made without one.
describe.runIf(process.platform === 'win32')('a child of a console-less witness has no window (win32 only)', () => {
  it('gets one outside the scope, and none inside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'witness-console-'))
    const helper = join(dir, 'helper.mts')
    const ps = ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -Namespace W -Name K -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetConsoleWindow();'; [W.K]::GetConsoleWindow().ToInt64()"]
    writeFileSync(helper, [
      `import { spawnSync, withoutConsole } from ${JSON.stringify(pathToFileURL(join(SRC, 'spawn.ts')).href)}`,
      `const ask = () => spawnSync('powershell.exe', ${JSON.stringify(ps)}, { encoding: 'utf8' }).stdout.trim()`,
      'process.stdout.write(JSON.stringify({ shown: ask(), hidden: withoutConsole(ask) }))',
    ].join('\n'))
    const { spawn: rawSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const child = rawSpawn(node, ['--import', 'tsx', helper], { cwd: join(SRC, '..'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout!.on('data', (c: Buffer) => { out += String(c) })
    await new Promise((resolve) => child.on('close', resolve))
    const seen = JSON.parse(out) as { shown: string; hidden: string }
    expect(seen.shown).not.toBe('0')
    expect(seen.hidden).toBe('0')
  }, 60_000)
})
