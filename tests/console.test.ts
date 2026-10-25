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
