import { AsyncLocalStorage } from 'node:async_hooks'
import * as cp from 'node:child_process'
import { statSync } from 'node:fs'
import { extname, join, win32 } from 'node:path'
import { ok, refuse, v, type Result } from './refusal.js'

// What child_process is handed to start `cmd args`, environment included. One answer for
// every site that runs a harness CLI by name — probe, the gate reviewer, the calibrate and
// drive workers — so the binary `check` vouches for is the binary a gate spawns.
export interface ResolvedSpawn {
  file: string
  args: string[]
  env: Record<string, string | undefined>
  windowsVerbatimArguments: boolean
}

// The two ways Windows starts a program: an image CreateProcess runs itself, or a batch
// file only cmd.exe can run. PATHEXT also lists script-host types (.js, .vbs, .wsf) that
// cmd.exe would open with Windows Script Host — never what a CLI's `.js` means — so
// those are not candidates at all.
const IMAGES = ['.com', '.exe']
const BATCH = ['.bat', '.cmd']

// Every cmd.exe metacharacter, `"` included, and whatever follows a `%`. Escaped, a quote
// never opens cmd's quote mode, and no `%NAME%` or `%NAME:a=b%` names a variable: cmd.exe
// expands those before it reads a single caret, so the name itself must start with one.
// Nothing in an argument is then special to cmd.exe, and each caret is one escape.
const CMD_META = /[()[\]%!^"`<>&|;, *?]|(?<=%)[^]/gu

// Windows env names are case-insensitive, and a spread process.env carries `Path` beside
// any `PATH` a caller adds. Node gives the child the key that sorts first, so resolution
// reads that one — any other answer names a binary the child never sees.
function envGet(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).sort().find((k) => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false   // absent, or under a PATH entry that is not a directory: no candidate
  }
}

// PATH order, then PATHEXT order inside each directory — cmd.exe's walk minus its first
// step: the current directory is never searched, and neither is a relative entry (`.`, or
// the empty one a trailing `;` leaves), so a `pi.cmd` committed to a reviewed repo cannot
// make itself the judge. A name that carries a path is checked where it points.
function whichWin32(cmd: string, env: Record<string, string | undefined>): string | undefined {
  const runnable = [...IMAGES, ...BATCH]
  const listed = (envGet(env, 'PATHEXT') ?? '').split(';').map((e) => e.toLowerCase())
    .filter((e) => runnable.includes(e))
  const exts = runnable.includes(extname(cmd).toLowerCase()) ? [''] : listed.length > 0 ? listed : runnable
  const bases = /[\\/]/.test(cmd) ? [cmd] : (envGet(env, 'PATH') ?? '').split(';')
    .map((d) => d.replace(/^"(.*)"$/, '$1')).filter((d) => win32.isAbsolute(d)).map((d) => join(d, cmd))
  for (const base of bases) {
    for (const ext of exts) if (isFile(`${base}${ext}`)) return `${base}${ext}`
  }
  return undefined
}

// The C runtime's rules (CommandLineToArgvW; node's own argv parser follows them): inside
// quotes a backslash is literal unless a quote follows it, where the run doubles and the
// quote takes one more.
function crtQuote(arg: string): string {
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') { slashes += 1; continue }
    out += ch === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${ch}`
    slashes = 0
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`
}

const caret = (s: string): string => s.replace(CMD_META, '^$&')

// Off win32 this is the identity: the spawn every site made before. On win32 the name
// is resolved here, not by libuv, which tries only `.com` and `.exe` — and looks in the
// child's cwd first — while npm installs `pi` and `claude` as `.cmd` shims: a bare-name
// spawn of either was ENOENT, and the resolved shim will not start without a shell
// (EINVAL). A name nothing on PATH answers to is refused rather than handed to libuv's
// cwd search. An image starts directly; a batch file runs as
// `cmd.exe /d /v:off /s /c ""<file>" <args>"`, built here verbatim:
//
// - the file is quoted, not caret-escaped: carets cannot keep a `=` in an install path
//   from splitting the command (measured);
// - each argument is CRT-quoted, then caret-escaped TWICE, because a shim forwards `%*`
//   and cmd.exe parses that line again — escaped once, `" & echo pwned & "` ran `echo`;
// - /v:off, because the registry can turn delayed expansion on, and then `!VAR!` in an
//   argument expands; /d skips AutoRun commands;
// - cmd.exe is System32's, never ComSpec, which may name a shell with other syntax; and
//   it runs with NoDefaultCurrentDirectoryInExePath, because the shim runs a bare `node`
//   when no node.exe sits beside it and cmd.exe would look in the cwd first — measured:
//   a `node.cmd` planted in the reviewed repo answered as the judge. The CLI inherits it.
//
// Nothing makes cmd.exe carry a line break: it ends the command at LF, silently dropping
// every later argument, and deletes CR. Such an argument is refused, never truncated.
export function resolveSpawn(
  cmd: string, args: readonly string[], env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Result<ResolvedSpawn> {
  if (platform !== 'win32') return ok({ file: cmd, args: [...args], env, windowsVerbatimArguments: false })
  const file = whichWin32(cmd, env)
  if (file === undefined) {
    return refuse([v(cmd, 'not-on-path', 'no .com, .exe, .bat or .cmd by that name on PATH',
      `the ${cmd} CLI installed on PATH — witness never looks for it in the current directory, where a repo could plant one`)])
  }
  if (IMAGES.includes(extname(file).toLowerCase())) return ok({ file, args: [...args], env, windowsVerbatimArguments: false })
  for (const [i, arg] of args.entries()) {
    if (/[\r\n]/.test(arg)) {
      return refuse([v(cmd, 'batch-argv-line-break', `argument ${i + 1}: ${JSON.stringify(arg.slice(0, 60))}`,
        `an argument without CR or LF — ${file} is a batch file, and cmd.exe ends a command at a line feed and deletes carriage returns, so the CLI would run on a truncated command line`)])
    }
  }
  const line = [`"${file}"`, ...args.map((a) => caret(caret(crtQuote(a))))].join(' ')
  return ok({
    file: win32.join(envGet(env, 'SYSTEMROOT') ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', `"${line}"`],
    env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' },
    windowsVerbatimArguments: true,
  })
}

// Row 201. The one module that starts a child process. A console program started by a process
// with no console of its own gets a new console, and on Windows a new console is a window: the
// background drive `drive --detach` starts has none (libuv's DETACHED_PROCESS), so each git call
// and each session it ran opened one. `windowsHide` asks for CREATE_NO_WINDOW instead, which
// libuv grants only when no stdio slot inherits a handle — a hidden child pipes or ignores all
// three. It is asked for only where witness has no console to lend: a child given a hidden
// console of its own no longer shares the terminal's, and Ctrl+C typed there never reaches it —
// a foreground drive's sessions rely on exactly that. Async-local, like the journal stamp (row
// 191 §4.8), so an invocation run in process — drive's decisions, a test's CLI — keeps its own
// answer. The scope only ever turns hiding on: a nested `main` inherits it.
export const NO_CONSOLE_ENV = 'WITNESS_NO_CONSOLE'
const noConsole = new AsyncLocalStorage<true>()

export function withoutConsole<T>(fn: () => T): T {
  return noConsole.run(true, fn)
}

// child_process takes `(file, args?, options?)` or `(file, options?)`, and an argv left out
// (`undefined`, `null`) still has the options behind it; they are found whichever form a caller
// used, and an explicit `windowsHide` — the viewer's — wins.
function hidden(rest: unknown[]): unknown[] {
  const [a, b] = rest
  const opts = (o: unknown) => ({ windowsHide: noConsole.getStore() === true, ...(o as object | undefined) })
  return Array.isArray(a) || (a == null && rest.length > 1) ? [a, opts(b)] : [opts(a)]
}

export const spawn = ((file: string, ...rest: unknown[]) =>
  (cp.spawn as (...a: unknown[]) => unknown)(file, ...hidden(rest))) as typeof cp.spawn
export const spawnSync = ((file: string, ...rest: unknown[]) =>
  (cp.spawnSync as (...a: unknown[]) => unknown)(file, ...hidden(rest))) as typeof cp.spawnSync
export const execFileSync = ((file: string, ...rest: unknown[]) =>
  (cp.execFileSync as (...a: unknown[]) => unknown)(file, ...hidden(rest))) as typeof cp.execFileSync
export const execSync = ((command: string, ...rest: unknown[]) =>
  (cp.execSync as (...a: unknown[]) => unknown)(command, ...hidden(rest))) as typeof cp.execSync

// Row 201. A Windows session's stop: its whole tree, from the shim down, the twin of the POSIX
// group kill. System32's taskkill, never PATH's, where a repo could plant one — resolveSpawn's
// System32 `cmd.exe` precedent.
export function treeStop(pid: number, env: Record<string, string | undefined>): { file: string; args: string[] } {
  return {
    file: win32.join(envGet(env, 'SYSTEMROOT') ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
    args: ['/PID', String(pid), '/T', '/F'],
  }
}
