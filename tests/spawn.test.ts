import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { spawnSession } from '../src/drive.js'
import { loadHarness, type Harness } from '../src/harness.js'
import { CLAUDE_THINKING_BUDGET } from '../src/pin.js'
import { probe } from '../src/probe.js'
import type { Result } from '../src/refusal.js'
import { invokeReviewer } from '../src/reviewer.js'
import { resolveSpawn, system32, treeStop } from '../src/spawn.js'
import { fakeCtx, seededRepo } from './helpers.js'

// A PATH directory holding the named files. Real files, not a predicate: resolution IS
// a filesystem walk, and a fake predicate would test the walk against itself. These
// tests pass `win32` explicitly, so the Windows algorithm runs on the Linux CI runner.
function binDir(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'witness-spawn-'))
  for (const f of files) writeFileSync(join(dir, f), '')
  return dir
}

const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe'
const winEnv = (path: string, extra: Record<string, string> = {}): Record<string, string> =>
  ({ PATH: path, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', SystemRoot: 'C:\\Windows', ...extra })
// What cmd.exe gets on top of the caller's env: its own lookup of the shim's bare `node`
// must skip the current directory too.
const viaCmd = (env: Record<string, string>): Record<string, string> =>
  ({ ...env, NoDefaultCurrentDirectoryInExePath: '1' })
const rules = (r: Result<unknown>): unknown => (r.ok ? r.value : r.violations.map((x) => x.rule))

describe('resolveSpawn — the win32 algorithm, on any host', () => {
  it('runs an npm .cmd shim through cmd.exe, which a bare-name spawn cannot start', () => {
    // npm's global bin holds all three; only the .cmd is runnable without a shell.
    const dir = binDir('pi', 'pi.cmd', 'pi.ps1')
    const env = winEnv(dir)
    expect(resolveSpawn('pi', ['--version'], env, 'win32')).toEqual({
      ok: true,
      value: {
        file: CMD_EXE,
        args: ['/d', '/v:off', '/s', '/c', `""${join(dir, 'pi.cmd')}" ${String.raw`^^^"--version^^^"`}"`],
        env: viaCmd(env),
        windowsVerbatimArguments: true,
      },
    })
  })

  it('runs cmd.exe itself from System32, whatever ComSpec names — the line is cmd.exe syntax', () => {
    const dir = binDir('pi.cmd')
    const r = resolveSpawn('pi', [], winEnv(dir, { ComSpec: 'D:\\tcc\\tcc.exe', SystemRoot: 'D:\\WINNT' }), 'win32')
    expect(r.ok && r.value.file).toBe('D:\\WINNT\\System32\\cmd.exe')
  })

  it('starts an .exe directly by its absolute path, argv and env untouched', () => {
    const dir = binDir('claude.exe')
    const env = winEnv(dir)
    expect(resolveSpawn('claude', ['-p', 'a "b"\nc'], env, 'win32')).toEqual({
      ok: true,
      value: { file: join(dir, 'claude.exe'), args: ['-p', 'a "b"\nc'], env, windowsVerbatimArguments: false },
    })
  })

  it('walks PATH in order, and PATHEXT order within one directory', () => {
    const first = binDir('pi.cmd')
    const second = binDir('pi.exe')
    const r = resolveSpawn('pi', [], winEnv(`${first};${second}`), 'win32')
    expect(r.ok && r.value.args.at(-1)).toBe(`""${join(first, 'pi.cmd')}""`)

    const both = binDir('pi.cmd', 'pi.exe')
    const r2 = resolveSpawn('pi', [], winEnv(both), 'win32')
    expect(r2.ok && r2.value.file).toBe(join(both, 'pi.exe'))
  })

  it('never hands cmd.exe a script-host file, whatever PATHEXT lists first', () => {
    // cmd.exe would open pi.js with Windows Script Host, not node.
    const dir = binDir('pi.js', 'pi.cmd')
    const r = resolveSpawn('pi', [], winEnv(dir, { PATHEXT: '.JS;.CMD' }), 'win32')
    expect(r.ok && r.value.args.at(-1)).toBe(`""${join(dir, 'pi.cmd')}""`)
  })

  it('reads PATH as the child receives it: case-insensitive, first key in sort order', () => {
    // A spread process.env on Windows carries `Path`; a test or a caller that then sets
    // `PATH` yields both, and Node hands the child the one that sorts first.
    const shim = binDir('pi.cmd')
    const empty = binDir()
    const r = resolveSpawn('pi', [], { Path: shim, SystemRoot: 'C:\\Windows' }, 'win32')
    expect(r.ok && r.value.args.at(-1)).toBe(`""${join(shim, 'pi.cmd')}""`)
    expect(rules(resolveSpawn('pi', [], { Path: shim, PATH: empty, SystemRoot: 'C:\\Windows' }, 'win32')))
      .toEqual(['not-on-path'])
  })

  it('strips the quotes Windows allows around a PATH entry', () => {
    const dir = binDir('pi.cmd')
    const r = resolveSpawn('pi', [], winEnv(`"${dir}"`), 'win32')
    expect(r.ok && r.value.file).toBe(CMD_EXE)
  })

  it('resolves a path the same way, without searching PATH', () => {
    // drive's test seam hands a path, not a name
    const dir = binDir('agent.cmd')
    const r = resolveSpawn(join(dir, 'agent'), ['x'], winEnv(''), 'win32')
    expect(r.ok && r.value.args.at(-1)).toBe(`""${join(dir, 'agent.cmd')}" ${String.raw`^^^"x^^^"`}"`)
  })

  it('never searches the current directory, which cmd.exe and libuv both search first', () => {
    // A reviewer runs inside the reviewed repo: a pi.cmd committed there must not judge it.
    // `.` and the empty entry a trailing `;` leaves are both "here", so neither counts.
    const planted = binDir('pi.cmd')
    const back = process.cwd()
    process.chdir(planted)
    try {
      expect(rules(resolveSpawn('pi', [], winEnv(`${binDir()};.;`), 'win32'))).toEqual(['not-on-path'])
    } finally {
      process.chdir(back)
    }
  })

  it('refuses a name nothing on PATH answers to — a bare name would send libuv to the cwd', () => {
    // Git Bash's extensionless sh shim is on PATH too; Windows cannot execute it.
    const dir = binDir('pi')
    expect(rules(resolveSpawn('pi', ['--version'], winEnv(dir), 'win32'))).toEqual(['not-on-path'])
  })

  it('escapes every argument for both cmd.exe parses a batch shim puts it through', () => {
    // Expected values derived by hand: CRT quoting (backslashes doubled only before a
    // quote or the closing quote), then a caret before each cmd metacharacter and before
    // whatever follows a `%`, twice — once for the `cmd /c` line, once for the shim's `%*`.
    // cmd.exe expands `%NAME:a=b%` BEFORE it reads a single caret, so only a name that
    // starts with `^` stays unexpanded.
    const dir = binDir('pi.cmd')
    const args = ['a"b', 'x & y', '%PATH%', '%OS:W=X%', '!x!', 'C:\\dir\\', 'a\\"b', '']
    const tail = String.raw`^^^"a\^^^"b^^^" ^^^"x^^^ ^^^&^^^ y^^^" ^^^"^^^%^^PATH^^^%^^^" ^^^"^^^%^^OS:W=X^^^%^^^" ^^^"^^^!x^^^!^^^" ^^^"C:\dir\\^^^" ^^^"a\\\^^^"b^^^" ^^^"^^^"`
    const r = resolveSpawn('pi', args, winEnv(dir), 'win32')
    expect(r.ok && r.value.args).toEqual(['/d', '/v:off', '/s', '/c', `""${join(dir, 'pi.cmd')}" ${tail}"`])
  })

  it('quotes the shim path itself, which caret escaping cannot protect from `=`', () => {
    // Measured on Windows 11: a caret-escaped command path (cross-spawn's form) breaks on
    // an install directory containing `=`; a quoted one carries `=`, `&`, `(`, `)` and spaces.
    const dir = join(binDir(), 'eq=ual & (x)')
    mkdirSync(dir)
    writeFileSync(join(dir, 'pi.cmd'), '')
    const r = resolveSpawn('pi', ['-p'], winEnv(dir), 'win32')
    expect(r.ok && r.value.args.at(-1)).toBe(`""${join(dir, 'pi.cmd')}" ${String.raw`^^^"-p^^^"`}"`)
  })

  it('refuses a line break bound for a batch file rather than let cmd.exe cut the command', () => {
    // Measured: cmd.exe ends the command at LF — `-p "a\nb" --no-session` arrives as
    // `-p a`, exit 0, every later flag gone — and deletes CR outright.
    const dir = binDir('pi.cmd')
    for (const arg of ['line one\nline two', 'a\rb']) {
      expect(rules(resolveSpawn('pi', ['-p', arg, '--no-session'], winEnv(dir), 'win32')))
        .toEqual(['batch-argv-line-break'])
    }
  })

  it('is the identity off win32, whatever PATH holds', () => {
    const dir = binDir('pi.cmd')
    const env = winEnv(dir)
    expect(resolveSpawn('pi', ['-p', 'a\nb'], env, 'linux'))
      .toEqual({ ok: true, value: { file: 'pi', args: ['-p', 'a\nb'], env, windowsVerbatimArguments: false } })
  })

  it('an empty argument survives the win32 batch shim (issue #73)', () => {
    const dir = binDir('claude.cmd')
    const r = resolveSpawn('claude', ['--tools', ''], winEnv(dir), 'win32')
    expect(r.ok && r.value.args[4]).toContain(String.raw`^^^"--tools^^^" ^^^"^^^"`)
  })
})

describe('treeStop (row 201)', () => {
  it("stops a Windows process tree with System32's taskkill, whatever PATH holds", () => {
    expect(treeStop(4242, { SystemRoot: 'D:\\WINNT', PATH: 'C:\\planted' })).toEqual({
      file: 'D:\\WINNT\\System32\\taskkill.exe', args: ['/PID', '4242', '/T', '/F'],
    })
    expect(treeStop(7, {}).file).toBe('C:\\Windows\\System32\\taskkill.exe')
  })
})

describe('probe', () => {
  it('answers yes only for a CLI that starts and exits 0', () => {
    // `gh auth status` exiting 1 is how check tells unauthenticated from missing.
    expect(probe(process.execPath, ['-e', ''], process.env)).toBe(true)
    expect(probe(process.execPath, ['-e', 'process.exit(3)'], process.env)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------
// Windows only: the same contract against the real cmd.exe and a real batch shim.

const onWindows = process.platform === 'win32'

// The shape of every package-manager shim on Windows (npm's cmd-shim, pnpm's, scoop's
// .cmd shims): locate the script beside the shim through %~dp0, run it with node, and
// forward the arguments with %* — which cmd.exe expands and then PARSES AGAIN. That
// second parse is why a batch target needs its arguments escaped twice.
function shimmed(name: string, script: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'witness-shim-')), 'Jane Doe (x) 100% a=b')
  mkdirSync(dir)
  writeFileSync(join(dir, `${name}.js`), script)
  writeFileSync(join(dir, `${name}.cmd`), [
    '@ECHO off',
    'SETLOCAL',
    'SET "_prog=node"',
    'IF EXIST "%~dp0\\node.exe" SET "_prog=%~dp0\\node.exe"',
    `"%_prog%" "%~dp0\\${name}.js" %*`,
    '',
  ].join('\r\n'))
  return dir
}

// The shimmed dir first, the machine's PATH after it for node itself. `PATH` sorts before
// the `Path` a spread process.env carries, so it is the one the child receives.
const envWith = (dir: string): Record<string, string | undefined> =>
  ({ ...process.env, PI_CODING_AGENT: undefined, CLAUDECODE: undefined, PATH: `${dir};${process.env.PATH ?? ''}` })

const ECHO_ARGV = 'process.stdout.write(JSON.stringify(process.argv.slice(2)))'
const RECORD_ARGV = "require('fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)))"
// pi's --mode json contract: an agent_end event carrying the assistant's text.
const PI_ECHO = `let s = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { s += c })
process.stdin.on('end', () => {
  const text = JSON.stringify({ argv: process.argv.slice(2), stdin: s })
  const assistant = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }
  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [assistant] }) + '\\n')
})`

const ADVERSARIAL = [
  '', 'a b', '"', 'a"b', '""', '\\', 'a\\', 'a\\"b', '\\\\"', '&', '|', '<>', '^', '^^', '%PATH%', '%', '%%',
  '%OS:W=X%', '%PATH:a=b%', '100%OS:W=X%', 'x %OS:~0,3% y',
  '!PATH!', '!', '()', ')', 'a,b;c=d', '*?', 'C:\\Program Files\\x', "'single'", '`tick`', 'é ü 中文 🙂',
  'trail ', ' lead', '\t', '--model', 'anthropic/claude-opus-5:high', '" & echo pwned & "', '\\"&whoami',
  '%~dp0', '%*', '%1', '%_prog%', 'x^', '[x]', '@echo', '=', ';', ',',
]

const piHarness = (): Harness => {
  const r = loadHarness('pi')
  if (!r.ok) throw new Error('registry')
  return r.value
}

describe.runIf(onWindows)('resolveSpawn against the real cmd.exe (win32 only)', () => {
  it('delivers every argument to a batch shim byte for byte', () => {
    const dir = shimmed('echoargs', ECHO_ARGV)
    const run = resolveSpawn('echoargs', ADVERSARIAL, envWith(dir))
    expect(run.ok).toBe(true)
    if (!run.ok) return
    const r = spawnSync(run.value.file, run.value.args, {
      env: run.value.env, encoding: 'utf8', windowsVerbatimArguments: run.value.windowsVerbatimArguments,
    })
    expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout)).toEqual(ADVERSARIAL)
  })
})

describe.runIf(onWindows)('the harness spawn sites reach a .cmd CLI (win32 only)', () => {
  it('probe finds a CLI npm installed as a .cmd shim — check stops reporting it missing', () => {
    const dir = shimmed('fakecli', 'process.exit(0)')
    expect(probe('fakecli', ['--version'], envWith(dir))).toBe(true)
  })

  it('a gate reviewer reaches pi.cmd with the hermetic flags, prompt on stdin', () => {
    const dir = shimmed('pi', PI_ECHO)
    const prompt = 'LENS\n\n## Reviewed content\nsay "hi" & 100% ^ !x! (ok)\n'
    const r = invokeReviewer(fakeCtx(dir, { env: envWith(dir) as Record<string, string> }), piHarness(), { cwd: dir, prompt })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.value.text)).toEqual({
        argv: ['-p', '--mode', 'json', '--no-session', '--no-extensions', '--no-skills', '--no-context-files', '--no-tools', '--thinking', 'off'],
        stdin: prompt,
      })
    }
  })

  it('a node.cmd planted in the reviewed repo is not the judge, even where cmd.exe searches the cwd', () => {
    // With no node.exe beside it (every standard install), the shim runs a bare `node`, and
    // cmd.exe looks for that name in the current directory first — the reviewed repo.
    const dir = shimmed('pi', PI_ECHO)
    const repo = mkdtempSync(join(tmpdir(), 'witness-repo-'))
    writeFileSync(join(repo, 'node.cmd'),
      '@echo {"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"PLANTED"}],"stopReason":"stop"}]}\r\n')
    // The opt-out may be set in this machine's own shell; the planted judge must lose without it.
    const env = Object.fromEntries(Object.entries(envWith(dir))
      .filter(([k]) => k.toUpperCase() !== 'NODEFAULTCURRENTDIRECTORYINEXEPATH'))
    const r = invokeReviewer(fakeCtx(repo, { env: env as Record<string, string> }), piHarness(), { cwd: repo, prompt: 'x' })
    expect(r.ok && r.value.text).not.toBe('PLANTED')
    expect(r.ok && (JSON.parse(r.value.text) as { stdin: string }).stdin).toBe('x')
  })

  it('a gate reviewer reaches claude.cmd with its pin, thinking budget in the env, prompt on stdin', () => {
    // claude's --output-format json envelope: one object whose `result` is the text.
    const dir = shimmed('claude', `let s = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { s += c })
process.stdin.on('end', () => {
  const result = JSON.stringify({ argv: process.argv.slice(2), budget: process.env.MAX_THINKING_TOKENS, stdin: s })
  process.stdout.write(JSON.stringify({ result }))
})`)
    const harness = loadHarness('claude-code')
    if (!harness.ok) throw new Error('registry')
    const prompt = 'LENS\n\nquote " caret ^ amp & pct %PATH%'
    const r = invokeReviewer(fakeCtx(dir, { env: envWith(dir) as Record<string, string> }), harness.value,
      { cwd: dir, prompt, model: 'claude-opus-4-6:high' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.value.text)).toEqual({
        argv: ['-p', '--output-format', 'json', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--tools', '', '--model', 'claude-opus-4-6'],
        budget: String(CLAUDE_THINKING_BUDGET.high),
        stdin: prompt,
      })
    }
  })

  it('drive starts a .cmd agent session and streams it, prefixed, from the action home', async () => {
    const repo = await seededRepo()
    const cfg = loadConfig(repo.root)
    if (!cfg.ok) throw new Error(`config refused: ${JSON.stringify(cfg.violations)}`)
    const dir = shimmed('agent', 'console.log(JSON.stringify(process.argv.slice(2))); console.log(process.cwd())')
    const lines: string[] = []
    const env = { ...envWith(dir), WITNESS_DRIVE_AGENT_BIN: join(dir, 'agent.cmd') } as Record<string, string>
    const res = await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfg.value,
      fakeCtx(repo.root, { tty: true, env, out: (l) => lines.push(l) }), 1)
    expect(res.outcome).toBe('exited')
    expect(lines).toContain(`[1 implement/p1] ${repo.root}`)
    expect(lines.join('\n')).toContain('[1 implement/p1] ["-p","/witness"')
  }, 20000)

  it('a stopped .cmd session takes the agent under the shim with it (F11, row 201)', async () => {
    const repo = await seededRepo()
    const cfg = loadConfig(repo.root)
    if (!cfg.ok) throw new Error(`config refused: ${JSON.stringify(cfg.violations)}`)
    const late = join(mkdtempSync(join(tmpdir(), 'witness-late-')), 'late')
    const dir = shimmed('agent', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(late)}, 'acted'), 2000); setTimeout(() => {}, 30000)`)
    const env = { ...envWith(dir), WITNESS_DRIVE_AGENT_BIN: join(dir, 'agent.cmd') } as Record<string, string>
    const quick = { ...cfg.value, drive: { ...cfg.value.drive, sessionTimeoutMs: 300 } }
    expect((await spawnSession({ kind: 'spawn', home: repo.root }, quick, fakeCtx(repo.root, { env }), 1)).outcome).toBe('timeout')
    await new Promise((r) => setTimeout(r, 3_000))
    expect(existsSync(late)).toBe(false)
  }, 20000)
})

describe('system32 (row 211)', () => {
  it('builds a System32 path from SYSTEMROOT, whatever its case, else C:\\Windows', () => {
    expect(system32({ SYSTEMROOT: 'D:\\Win' }, 'cmd.exe')).toBe('D:\\Win\\System32\\cmd.exe')
    expect(system32({ SystemRoot: 'D:\\Win' }, 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
      .toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(system32({}, 'taskkill.exe')).toBe('C:\\Windows\\System32\\taskkill.exe')
  })
})
