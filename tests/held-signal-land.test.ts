import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scratchDir } from './scratch.js'

const REPO = resolve(import.meta.dirname, '..')
const LOADER = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const HELD = pathToFileURL(join(REPO, 'src', 'held.ts')).href

// Slice 3 review, finding 1: libuv delivers a caught signal in its poll phase, so code running from a
// poll-phase callback (an fs callback, stdin after a trust prompt) reaches its first setImmediate
// before the listener runs. The trap must still win before the caller journals or lets go.
// `extra`: another SIGTERM listener, so the trap's re-raise does not end the process.
function runScript(extra: boolean): Promise<{ code: number | null; signal: string | null; dir: string }> {
  const dir = scratchDir('witness-land-')
  const script = join(dir, 'land.mts')
  writeFileSync(script, `
import { readFile, writeFileSync } from 'node:fs'
import { letSignalsLand, trapTermination } from ${JSON.stringify(HELD)}
${extra ? "process.on('SIGTERM', () => {})" : ''}
const trap = trapTermination(() => writeFileSync(${JSON.stringify(join(dir, 'cleaned'))}, 'yes'))
readFile(${JSON.stringify(script)}, async () => {                 // a poll-phase continuation
  process.kill(process.pid, 'SIGTERM')
  const caught = await letSignalsLand()
  writeFileSync(${JSON.stringify(join(dir, 'went-on'))}, String(caught))
  trap.release()
})
`)
  return new Promise((done) => {
    const c = spawn(process.execPath, ['--import', LOADER, script], { stdio: 'ignore' })
    c.on('exit', (code, signal) => done({ code, signal, dir }))
  })
}

describe.skipIf(process.platform === 'win32')('a caught signal lands before the caller goes on (row 247)', () => {
  it('from a poll-phase continuation, the trap runs before the code after the yield: the process ends by the signal', async () => {
    const { signal, dir } = await runScript(false)
    expect(signal).toBe('SIGTERM')
    expect(existsSync(join(dir, 'cleaned'))).toBe(true)
    expect(existsSync(join(dir, 'went-on'))).toBe(false)
  }, 30_000)

  it('when the re-raise cannot end the process, the yield reports the signal the trap caught', async () => {
    const { dir } = await runScript(true)
    expect(existsSync(join(dir, 'cleaned'))).toBe(true)
    expect(readFileSync(join(dir, 'went-on'), 'utf8')).toBe('SIGTERM')
  }, 30_000)
})
