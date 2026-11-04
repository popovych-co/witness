import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Row 239. The paste harness: a line witness offers, pasted into each shell a human or an agent
// pastes into, with stubs on PATH that record the argv they receive. A line passes when it made
// no marker file and its stubs received exactly the argv witness composed.

export type Mode = 'bash' | 'zsh' | 'dash' | 'bash-i' | 'zsh-i'

// How each mode runs a line: `-c`, as an agent's tool runs it, or on an interactive shell's
// stdin, as a human's paste arrives, with history expansion on. No rc file is read.
const RUN: Record<Mode, { shell: string; args: (line: string) => string[]; stdin: boolean }> = {
  bash: { shell: '/bin/bash', args: (line) => ['--norc', '--noprofile', '-c', line], stdin: false },
  zsh: { shell: '/bin/zsh', args: (line) => ['-f', '-c', line], stdin: false },
  dash: { shell: '/bin/dash', args: (line) => ['-c', line], stdin: false },
  'bash-i': { shell: '/bin/bash', args: () => ['--norc', '--noprofile', '-i'], stdin: true },
  'zsh-i': { shell: '/bin/zsh', args: () => ['-f', '-i'], stdin: true },
}

// A mode whose shell is absent is skipped: CI's Ubuntu has no zsh, and win32 has none of them.
export const MODES: readonly Mode[] = process.platform === 'win32' ? []
  : (Object.keys(RUN) as Mode[]).filter((m) => existsSync(RUN[m].shell))

// The design's seven payloads (§5), each making a file `M<n>` when it runs, then zsh's form of
// the seventh: zsh does not split `${IFS}`, so M7 never fires there, and `${=IFS}` is the form
// that does (the inventory's B7). bash and dash refuse `${=IFS}` as a bad substitution, so M8 is
// a zsh payload.
export const PAYLOADS: readonly string[] = [
  '$(touch M1)', '`touch M2`', '"; touch M3; "', "'; touch M4; '", ';touch M5;', '!#;touch M6;#',
  'main$(touch${IFS}M7)', 'main$(touch${=IFS}M8)',
]

// The space-free forms a git ref name can hold (the inventory's B1, B2, B5 and B7): git calls a
// ref holding a space an `invalid refspec`, so only these reach a push remedy. Probed 2026-11-04.
export const REF_PAYLOADS: readonly string[] = [
  'main$(touch${IFS}M1)', 'main`touch${IFS}M2`', 'main;touch${IFS}M5;', 'main$(touch${=IFS}M7)',
]

// One line to paste, and the calls its stubs must receive, one argv each with the stub's name
// first. With no `calls` the line is checked for inertness only, as for a form that is lossy in
// the shell it lands in. A line that `cd`s makes its directory under a directory of its own and
// passes that as `cwd`, so a marker made after the `cd` is found too.
export interface Pasteable { line: string; calls?: string[][]; cwd?: string }
export interface Pasted { markers: string[]; calls: string[][] }

// Every program a witness line names. A stub appends its name and its arguments to $ARGVLOG,
// each ended by a NUL, which no argument can hold, then a newline that ends the call.
const STUBS = ['witness', 'git', 'gh', 'claude', 'pi', 'tail']
const STUB = `#!/bin/sh\nprintf '%s\\0' "\${0##*/}" "$@" >> "$ARGVLOG"; printf '\\n' >> "$ARGVLOG"\n`
const MARKER = /^M\d$/

// Row 239. The stub, written on the first paste: each paste's stubs are links to it, one per
// program, so `$0` still names the program. Measured 2026-11-04 on this Mac: a newly written
// script's first run took 140–190 ms, and eight first runs at once took 1037 ms, so a fresh script
// per paste serialized a row's pastes however many ran at once; a fresh link to one script ran in
// 13 ms, and eight at once in 21 ms. A file that pastes calls `dropStub` once its tests are done:
// vitest stops its worker with no `exit` event to clean up on.
let script: { dir: string; path: string } | undefined
function stubScript(): string {
  if (script === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'witness-paste-stub-'))
    script = { dir, path: join(dir, 'stub') }
    writeFileSync(script.path, STUB)
    chmodSync(script.path, 0o755)
  }
  return script.path
}
export function dropStub(): void {
  if (script !== undefined) rmSync(script.dir, { recursive: true, force: true })
  script = undefined
}

// Row 239. Asynchronous, so a row's pastes run side by side while the worker's event loop stays
// free, and clean for the next paste: a fresh stub directory and a fresh ARGVLOG every time, so
// two pastes at once never share either, the markers found deleted, the stub directory and any
// default `cwd` removed. Two pastes into one `cwd` at once would see each other's markers: a
// caller pastes those in turn.
export async function pasteIn(mode: Mode, line: string, cwd?: string): Promise<Pasted> {
  const stubs = mkdtempSync(join(tmpdir(), 'witness-paste-'))
  const dir = cwd ?? mkdtempSync(join(tmpdir(), 'witness-paste-cwd-'))
  try {
    const bin = join(stubs, 'bin')
    mkdirSync(bin)
    for (const name of STUBS) symlinkSync(stubScript(), join(bin, name))
    const log = join(stubs, 'argv.log')
    // No history file: an interactive bash writes `$HOME/.bash_history` as it exits, and HOME
    // is the line's directory, so a later bash -i paste into a row's `cwd` would load it.
    await ran(mode, line, dir, { PATH: `${bin}:/usr/bin:/bin`, ARGVLOG: log, HOME: dir, ZDOTDIR: dir, HISTFILE: '/dev/null' })
    const markers = markersUnder(dir)
    for (const m of markers) rmSync(join(dir, m), { recursive: true, force: true })
    return { markers, calls: existsSync(log) ? callsIn(readFileSync(log, 'utf8')) : [] }
  } finally {
    rmSync(stubs, { recursive: true, force: true })
    if (cwd === undefined) rmSync(dir, { recursive: true, force: true })
  }
}

// One shell run of `line`, settled once its pipes close, not when the shell exits. Row 239: a
// process the line put in the background holds the shell's stdout and stderr until it ends, so
// waiting for them, as spawnSync did, finds what it made (probed 2026-11-04: settled on `exit`,
// `(sleep 0.3; touch M9) &` came back after 5 ms and its marker appeared 600 ms later; spawnSync
// saw it after 321 ms). Its stdin is the line for an interactive mode and empty otherwise, and its
// output is read and dropped, so a full pipe never stalls it. A run still open after 10 s is killed
// and fails: an interactive bash or zsh ignores SIGTERM, so it gets SIGKILL (probed 2026-11-04:
// `sleep 3` under a 500 ms limit came back after 3020 ms with SIGTERM, and after 504 ms with
// SIGKILL), and its pipes are destroyed, as spawnSync's kill closes them, since a background
// process the signal never reached may still hold them.
function ran(mode: Mode, line: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const run = RUN[mode]
  return new Promise((resolve, reject) => {
    const fail = (why: string) => reject(new Error(`${mode} did not run ${JSON.stringify(line)}: ${why}`))
    const child = spawn(run.shell, run.args(line), { cwd, env })
    let killed = false
    const limit = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
      for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.destroy()
    }, 10_000)
    child.on('error', (e) => { clearTimeout(limit); fail(e.message) })
    child.on('close', () => { clearTimeout(limit); if (killed) fail('killed after 10 s'); else resolve() })
    child.stdout.resume()
    child.stderr.resume()
    // A shell that exits before it reads its stdin breaks the pipe: nothing is lost.
    child.stdin.on('error', () => {})
    child.stdin.end(run.stdin ? `${line}\n` : '')
  })
}

// Every entry named `M<n>` under `dir`, at any depth (a line may `cd` before its payload runs),
// as a path relative to it. A symlink is not followed.
function markersUnder(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const at = join(rel, e.name)
    return [...(MARKER.test(e.name) ? [at] : []), ...(e.isDirectory() ? markersUnder(dir, at) : [])]
  })
}

// Each call ends with its last field's NUL and the newline after it. An argument that began with
// a newline would read as a new call, and fail the row; no line here carries one.
function callsIn(log: string): string[][] {
  const records = log.split('\0\n')
  if (records.pop() !== '') throw new Error(`a stub's call was cut short: ${JSON.stringify(log)}`)
  return records.map((r) => r.split('\0'))
}
