import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// Synchronous, and clean for the next mode: fresh stubs every time, the markers found deleted,
// the stubs and any default `cwd` removed.
export function pasteIn(mode: Mode, line: string, cwd?: string): Pasted {
  const stubs = mkdtempSync(join(tmpdir(), 'witness-paste-'))
  const dir = cwd ?? mkdtempSync(join(tmpdir(), 'witness-paste-cwd-'))
  try {
    const bin = join(stubs, 'bin')
    mkdirSync(bin)
    for (const name of STUBS) {
      writeFileSync(join(bin, name), STUB)
      chmodSync(join(bin, name), 0o755)
    }
    const log = join(stubs, 'argv.log')
    const run = RUN[mode]
    const r = spawnSync(run.shell, run.args(line), {
      cwd: dir,
      env: { PATH: `${bin}:/usr/bin:/bin`, ARGVLOG: log, HOME: dir, ZDOTDIR: dir },
      input: run.stdin ? `${line}\n` : '',
      timeout: 10_000,
    })
    if (r.error !== undefined) throw new Error(`${mode} did not run ${JSON.stringify(line)}: ${r.error.message}`)
    const markers = markersUnder(dir)
    for (const m of markers) rmSync(join(dir, m), { recursive: true, force: true })
    return { markers, calls: existsSync(log) ? callsIn(readFileSync(log, 'utf8')) : [] }
  } finally {
    rmSync(stubs, { recursive: true, force: true })
    if (cwd === undefined) rmSync(dir, { recursive: true, force: true })
  }
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
