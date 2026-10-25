# Issue #54 — A Background Drive Opens No Windows (row 201) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, every program a background drive (`witness drive --detach`) starts runs without a console window — each git call, each session, each gate. A foreground drive keeps sharing its terminal, so Ctrl+C still reaches its sessions. On Windows, a session that drive stops takes its whole process tree with it, so a hidden session can't keep running unseen. This is row 201, closing issue #54.

**Architecture:**
- `src/spawn.ts` becomes the one module that imports `node:child_process`. Its `spawn`, `spawnSync`, `execFileSync` and `execSync` take Node's own arguments.
  - Inside an async-local `withoutConsole` scope they add `windowsHide: true`.
  - Outside it they add `windowsHide: false`, which is what every site gets today.
- `drive --detach` hands the background drive `WITNESS_NO_CONSOLE=1`. `main` reads it before anything else (the floor gate's git calls included), strips it from the env, and runs the invocation inside the scope.
- On win32, drive stops a session with System32's `taskkill /PID <pid> /T /F`, and `watchLine` prints that command as the stop line.

**Tech Stack:**
- TypeScript (ESM, NodeNext, `strict` + `noUncheckedIndexedAccess`).
- `node:async_hooks` `AsyncLocalStorage`, already used for the journal stamp (`src/journal.ts:83`).
- Tests: vitest 3.2.7, driving the real CLI in-process against throwaway git repos (`tests/helpers.ts`).
- No new dependencies.

**Spec:** [Issue #54](https://github.com/popovych-co/witness/issues/54) plus the verified evidence base below. The standing scope direction is "the most architecturally correct". This plan fixes how witness starts a child and what a hidden child costs, not only the reported symptom.

Every claim was read at `main` `0ad3c9d` (0.24.1) or in upstream source. The plan's code was dry-run in a throwaway worktree (E7). Nothing here could run on Windows from this machine: Task 5 Step 2 is that probe.

---

## Verified evidence base

### E1 — The reported windows, mapped to the spawns that made them (read)

The issue's process tree showed the detached drive (`node …/dist/bin.js drive`) as the parent of `git hash-object …` and `git merge-base HEAD main`, each with its own `conhost.exe`, plus a `pi` window per session.

| Window | Spawn | Reached from |
|---|---|---|
| `git hash-object -- <file>`, one per file hashed | `src/gitio.ts:13` | `blobOf`, `src/reviewed.ts:42` |
| `git merge-base HEAD main` | `src/gitio.ts:13` | `src/evidence.ts:162` |
| `git rev-parse` ×3, before any verb runs | `src/gitio.ts:13` | `main`'s floor gate, `src/cli.ts:152-155` |
| `git show HEAD:witness.config.yaml`, every round | `src/config.ts:396` | autonomy re-read (row 180) |
| the session, titled `pi`, open until it ends | `src/drive.ts:191` | `cmd.exe` → `pi.cmd` → node |
| gates drive runs between sessions | `src/reviewer.ts:211`, `:276`; `src/runner.ts:54`; `src/snapshot.ts:16` | settle passes |
| `where`, then the notifier, at the end | `src/opener.ts:16`; `src/notify.ts:29` | row 184 |
| `gh` | `src/ship.ts:59`; `src/stamp.ts:50` | merges, the lazy stamp |

pi's own subtree opens no windows. pi 0.85.1 runs its tool shells with `windowsHide: true` and does not detach them on win32 (`dist/core/tools/bash.js:52-55`). It also kills their tree itself with `taskkill /F /T` (`dist/utils/shell.js:188`). So every window in the report came from a spawn of witness's own.

### E2 — Root cause: the background drive has no console, and no spawn asks for a hidden one (read: libuv v1.x `src/win/process.c`, Node `lib/child_process.js`)

1. `detachDrive` starts the background drive with `detached: true` (`src/drive.ts:722-723`). libuv turns that into `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` (`process.c:1128`): the process has no console at all.
2. When a process with no console starts a console program, Windows creates a new console for it, and a new console is a window. With Windows Terminal as the default terminal, each one is a Terminal window.
3. The only request that avoids this is `CREATE_NO_WINDOW`: a console with no window, which every program under that child then inherits.
   - Node asks for it only under `windowsHide: true`, and libuv adds it only when no stdio slot inherits a handle (`process.c:1099-1107`).
   - `windowsHide` defaults to false (`child_process.js:817`).
   - `execFileSync` and `execSync` pipe all three streams by default (`:981`). Their "inherited" stderr is written after the fact (`:1050-1053`), not inherited at the OS level. So every witness site gets the real flag once it asks.
4. No spawn in `src/` passes `windowsHide`: `grep -rn windowsHide src` finds nothing at `0ad3c9d`.
5. A foreground drive never shows this, because its children share the terminal's console.

`--detach` shipped in `9e61514` (0.18.0), so every release since then has this bug on Windows.

### E3 — Why there was nowhere to put the rule (read)

Sixteen modules import `node:child_process` directly: 20 call sites in 15 files, plus a dead `execFileSync` import in `src/verbs/check.ts:1`.

Row 164 made `resolveSpawn` the one answer to *what* a harness CLI is started as — file, argv, environment — at four sites. It is not the answer to *how* anything is started. So a rule that depends on whether the process has a console had no single place to live, and every site took Node's default.

### E4 — Why not `windowsHide` on every spawn, as the issue suggests (upstream + code)

- **A hidden child no longer hears the terminal's Ctrl+C.** `CREATE_NO_WINDOW` gives the child its own hidden console even when witness has one, so Ctrl+C typed in the terminal never reaches it.
  - [nodejs/node#29837](https://github.com/nodejs/node/issues/29837): "windowsHide:true prevents SIGINT on child processes" (closed).
  - execa turns the flag on by default and documents the cost: without a shared console, SIGINT doesn't work and a shell's subprocesses aren't cleaned up ([docs/windows.md, "Console window"](https://github.com/sindresorhus/execa/blob/main/docs/windows.md#console-window)).
- **A foreground drive on Windows relies on that shared console.**
  - Drive's own stop reaches only the `cmd.exe` shim (`src/drive.ts:189-201`; measured, `DESIGN.md` Open / deferred, "Windows is not a CI platform" (a)).
  - The cause is libuv's job object, which lets grandchildren break away (`process.c:77-96`, `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`).
  - Ctrl+C reaches pi through the console, and pi stops its own tools (E1).
  - Hiding there would leave the agent running after Ctrl+C — the orphan row 180 exists to prevent.
- **So the rule is:** hide exactly where witness has no console to share — the background drive — and nowhere else.

### E5 — Design decisions, and what was rejected

**D1 — Hide only inside the background drive's invocation.**
- Why: E4.
- Rejected: the issue's blanket `windowsHide`.

**D2 — `src/spawn.ts` is the only importer of `node:child_process`.** Its wrappers keep Node's signatures, so every other site changes only its import line.
- Why: one owner, like 164's `resolveSpawn`, and enforced the way `tests/harness.test.ts:338` enforces the session-variable registry.
- Rejected: a per-site options helper, since review cannot see a site that forgets it.

**D3 — The scope is `AsyncLocalStorage`, and it only ever turns hiding on.**
- Why: row 191 §4.8's precedent (`src/journal.ts:79-87`). Each invocation run in process keeps its own answer — drive's decisions (`src/drive.ts:851`, `:869`) and the tests' CLIs (`tests/helpers.ts:90`).
- Probe P1 (E7): the store survives awaits, timers, a child's `exit` callback and a nested `main`, and it never leaks to a later invocation.
- Rejected: a module variable.

**D4 — `main` opens the scope, not the drive verb.**
- Why: `main` runs `primaryRoot` (3 git calls) and `stateFloor` before it dispatches (`src/cli.ts:152-155`). A verb-level scope would still open windows at startup.

**D5 — The marker is `WITNESS_NO_CONSOLE=1`.** `detachDrive` sets it; `main` reads it and strips it.
- Why: the launcher is the one that knows the child has no console. The marker is stripped so no session inherits it — a session has a console, the hidden one its spawn gave it.
- Rejected: reusing `WITNESS_DRIVE_LOG`. Sessions inherit it, and "a log exists" is not "no console".
- Rejected: detecting a console at runtime. Node has no API for it.

**D6 — Nothing on the `--detach` spawn itself (the issue's second bullet).**
- Why: `CREATE_NO_WINDOW` is ignored together with `DETACHED_PROCESS`. libuv skips it anyway, because the log is an inherited handle (`process.c:1103`).

**D7 — The viewer (`src/opener.ts:38`) passes `windowsHide: false`.**
- Why: it is the one window witness means to show. `windowsHide` also sets `SW_HIDE` (`process.c:1109-1112`), which hides a GUI program's first window.
- `where` in `resolves()` is hidden like any other probe.

**D8 — A configured `notify:` starts hidden in the background drive.**
- Why: same flag, same `SW_HIDE`. The notifiers witness names (`osascript`, `notify-send`) are CLIs that ask the OS to post a notification. Recorded in the row.

**D9 — On win32, drive stops a session with System32's `taskkill /PID <pid> /T /F`.**
- Why: hiding the session removes the window that showed an orphaned one (the issue: it "keeps its window open … until the session ends").
- It is the twin of the POSIX group kill, and pi's own tree stop (E1).
- System32's copy, never PATH's, like 164's `cmd.exe`.

**D10 — `watchLine` prints `taskkill /PID <pid> /T /F` on win32.**
- Why: `kill <pid>` doesn't exist in cmd.exe. PowerShell's `kill` (`Stop-Process`) ends drive alone: its sessions' shims go with libuv's job, but the agents under them don't.
- A force-killed drive's lock is already read as free (`src/drive-presence.ts:56`).

**Rejected outright: a two-hop launch that gives the background drive a hidden console of its own.** It needs a supervisor process and changes what the printed pid means. It covers nothing more inside witness's own tree.

### E6 — Found while reading: folded in, or recorded

- **Folded in:** the dead `execFileSync` import (Task 1; the scan would flag it).
- **Folded in:** `tests/spawn.test.ts:319`, a Windows-only test, still expects `spawnSession` to return `'exited'`. It has returned a `SessionEnd` object since `d23b846` (0.18.0), so the test fails on any Windows run today (Task 3).
- **Recorded under Open / deferred (Task 4):**
  - a console prompt from a background drive's child (an ssh passphrase or a host-key question on `git push` or `fetch`) waits on a console nobody can see, where POSIX fails it for want of a terminal;
  - `watchLine`'s watch half, `tail -f`, is POSIX only;
  - the reviewer's and calibrate's timeouts still stop only the shim, so (a) narrows to them;
  - `notify:` with a `.cmd` notifier has (e)'s shape and reports "not found";
  - a witness that another program starts with no console still opens a window per child.

### E7 — Dry-run (this plan's code, applied verbatim to a detached worktree of `0ad3c9d`)

- **Typecheck:** `tsc --noEmit` exits 0 after Tasks 1–3.
- **Targeted tests:**
  - `tests/console.test.ts`: 10 passed, 1 skipped (the win32-only block).
  - `tests/drive.test.ts -t detach`: 3 passed.
  - Task 3's tests: `tests/spawn.test.ts` 25 tests, 9 skipped (win32); `tests/drive.test.ts` 77 passed. M6 (`watchLine` ignores the platform) and M7 (`treeStop` trusts PATH) each fail only their own test. The win32 `signal()` branch can only be exercised on Windows (Task 5 Step 2).
- **Mutations.** Each fails exactly its intended test, and nothing else:
  - M1: no scope in `main`;
  - M2: no marker from `detachDrive`;
  - M3: the issue's blanket hide;
  - M4: a nested `main` resets the scope;
  - M5: the marker reaches sessions.
- **Full suite:**
  - after Tasks 1–2: 173 files, 2131 passed, 9 skipped;
  - after Task 3: 2133 passed, 10 skipped.
  - Both runs had 0 `AssertionError`. The exit code was 1 only from the 4 known `onTaskUpdate` errors. The 0.24.1 baseline is 2121.
- **P1, the `AsyncLocalStorage` probe:**
  - hiding is on at entry, after await and a timer, inside a child's `exit` callback, and in a nested `main` without the marker;
  - it is off after the invocation returns, and in a separate invocation.

### E8 — What only Windows can show

Task 5 Step 2 runs the Windows-only tests, then the issue's window watcher on the reporting machine. Expected:
- zero Terminal show/hide events while a background drive runs;
- a foreground drive's Ctrl+C still ends its sessions;
- a timed-out session leaves no node behind.

## Global Constraints

- Branch `console-windows`, from `main` at `0ad3c9d` (0.24.1). Release 0.24.2 (`pnpm release patch`).
- Row **201**, mark **⊜**, dated the day it is built (2026-10-24 if built today), "post-incident amendment, no grill". It amends row **180** and touches rows **164** and **184**.
- After every task, run the vitest files that task names. Task 5 runs the full `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `npx biome check .`.
- **Reading `pnpm test`:**
  - It exits 1 even with every test green, because of the known `[vitest-worker]: Timeout calling "onTaskUpdate"` noise. Judge it by `Tests N passed`, 0 failed, and `grep -c AssertionError` = 0.
  - vitest's globalSetup runs `npm run build` first, so a type error in `src/` fails the whole run before any test.
- House style: 2-space indent, single quotes, no semicolons, hand-wrapped lines. In `src/`, the `./spawn.js` import sits with the local imports, after the `node:` ones.
- The only new CLI output is the win32 stop line (Task 3). No journal shape, config key, skill or engine text changes.
- Commits are conventional, with the row in the subject (`(D201)`) and a body that says why. No trailer (house history 0.22–0.24).
- Pushing, the PR, the release and closing the issue are outward-facing. The human says go before each one.

## Review Focus

1. **A foreground drive must stay unhidden.** Ctrl+C reaches its sessions only through the shared console. → Task 2, "without the marker nothing is hidden".
2. **The floor gate runs before any verb.** Its `git rev-parse` calls must be hidden too. → Task 2, the floor gate's `--show-toplevel` call.
3. **drive runs decisions through `main` in process.** A nested invocation must not reset the scope. → Task 2, the nested test.
4. **The marker belongs to the background drive alone.** A session that inherited it would hand its own children separate consoles. → Task 2, the e2e assertion.
5. **A session that drive stops on Windows must leave nothing running**, now that no window would show it. → Task 3, the win32 twin of F11.

## File Structure

| File | Change |
|---|---|
| `src/spawn.ts` | the only `node:child_process` importer: `NO_CONSOLE_ENV`, `withoutConsole`, `spawn` / `spawnSync` / `execFileSync` / `execSync`, `treeStop` |
| `src/cli.ts` | `main` reads and strips the marker, then runs inside `withoutConsole` |
| `src/drive.ts` | `detachDrive` hands the marker; `signal()` stops a win32 session's tree; imports from `./spawn.js` |
| `src/drive-presence.ts` | `watchLine(h, platform)`: the win32 stop line |
| `src/opener.ts` | imports from `./spawn.js`; the viewer passes `windowsHide: false` |
| `src/awake.ts`, `calibrate.ts`, `config.ts`, `gitio.ts`, `needs.ts`, `notify.ts`, `probe.ts`, `reviewer.ts`, `runner.ts`, `ship.ts`, `snapshot.ts`, `stamp.ts`, `verbs/migrate.ts` | import line only |
| `src/verbs/check.ts` | dead `execFileSync` import removed |
| `tests/console.test.ts` | **new** |
| `tests/drive.test.ts` | detach e2e: the marker never reaches a session; `watchLine` per platform |
| `tests/spawn.test.ts` | `treeStop` on any host; win32: the F11 twin, and the stale `.outcome` fix |
| `DESIGN.md` | legend, row 201, notes on rows 164, 180 and 184, Open / deferred |

---

### Task 0: Branch, and commit this plan

- [ ] **Step 1:** `git switch -c console-windows` from `main` at `0ad3c9d`. Then `git add docs/superpowers/plans/2026-10-24-issue-54-console-windows.md && git commit -m "docs(plan): issue #54 — a background drive opens no windows (D201)"`.

---

### Task 1: One module starts every child process

**Files:**
- Modify: `src/spawn.ts` (imports at `:1-3`; append after `:122`)
- Modify, import line only: `src/awake.ts:1`, `src/config.ts:1`, `src/gitio.ts:1`, `src/needs.ts:1`, `src/notify.ts:1`, `src/runner.ts:1`, `src/ship.ts:1`, `src/snapshot.ts:1`, `src/stamp.ts:1`, `src/verbs/migrate.ts:1`, and the pairs `src/calibrate.ts:1,19`, `src/probe.ts:1-2`, `src/reviewer.ts:1,11`, `src/drive.ts:1,11`
- Modify: `src/opener.ts:1`, `:38`; delete `src/verbs/check.ts:1`
- Create: `tests/console.test.ts`

**Interfaces:**
- Produces, from `src/spawn.ts`:
  - `NO_CONSOLE_ENV = 'WITNESS_NO_CONSOLE'` (Task 2 reads it).
  - `withoutConsole<T>(fn: () => T): T` — runs `fn` with every child it starts hidden. Nesting keeps hiding on.
  - `spawn`, `spawnSync`, `execFileSync`, `execSync`, each typed `typeof import('node:child_process').<name>` and taking Node's own arguments. Each adds `windowsHide` (true in scope, false outside) unless the caller passed one.

- [ ] **Step 1: Write the failing tests.** Create `tests/console.test.ts` with the recording mock and the first two describes:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/console.test.ts`

Expected: FAIL.
- The scan lists the 16 modules that import child_process.
- The unit tests throw `TypeError: … is not a function`, because `src/spawn.ts` exports none of the wrappers yet.

- [ ] **Step 3: Make `src/spawn.ts` the owner.** Add `import { AsyncLocalStorage } from 'node:async_hooks'` and `import * as cp from 'node:child_process'` above `node:fs`, then append this block. The `hidden()` normalizer is the one algorithm here: child_process takes `(file, args?, options?)` or `(file, options?)`, and a wrapper that only handled the first form would type-check and then misread the second.

```ts
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

// child_process takes `(file, args?, options?)` or `(file, options?)`; the options are found
// whichever form a caller used, and an explicit `windowsHide` — the viewer's — wins.
function hidden(rest: unknown[]): unknown[] {
  const [a, b] = rest
  const opts = (o: unknown) => ({ windowsHide: noConsole.getStore() === true, ...(o as object | undefined) })
  return Array.isArray(a) ? [a, opts(b)] : [opts(a)]
}

export const spawn = ((file: string, ...rest: unknown[]) =>
  (cp.spawn as (...a: unknown[]) => unknown)(file, ...hidden(rest))) as typeof cp.spawn
export const spawnSync = ((file: string, ...rest: unknown[]) =>
  (cp.spawnSync as (...a: unknown[]) => unknown)(file, ...hidden(rest))) as typeof cp.spawnSync
export const execFileSync = ((file: string, ...rest: unknown[]) =>
  (cp.execFileSync as (...a: unknown[]) => unknown)(file, ...hidden(rest))) as typeof cp.execFileSync
export const execSync = ((command: string, ...rest: unknown[]) =>
  (cp.execSync as (...a: unknown[]) => unknown)(command, ...hidden(rest))) as typeof cp.execSync
```

- [ ] **Step 4: Route every other site through it.**
  - `import { … } from 'node:child_process'` becomes `import { … } from './spawn.js'` (or `'../spawn.js'` in `src/verbs/migrate.ts`), with the same names, moved down among the local imports. This applies to awake, config, gitio, needs, notify, opener, runner, ship, snapshot, stamp and `verbs/migrate`.
  - In calibrate, probe, reviewer and drive, delete line 1 and add its names to the existing `./spawn.js` import.
  - Delete `src/verbs/check.ts:1`.
  - At `src/opener.ts:38`, pass `windowsHide: false` and add one comment line: `// The one window witness means to show: never hidden, even from a background drive (row 201).`

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run tests/console.test.ts tests/spawn.test.ts tests/opener.test.ts tests/needs.test.ts tests/runner-exec.test.ts tests/drive-report.test.ts && pnpm run typecheck`

Expected: every test passes (the win32-only blocks are skipped) and the typecheck exits 0. Off win32, libuv ignores `windowsHide`, so nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add src tests/console.test.ts
git commit -m "refactor(spawn): one module starts every child process (D201)" -m "src/spawn.ts becomes the only importer of node:child_process. Its spawn, spawnSync, execFileSync and execSync keep Node's signatures and add windowsHide inside withoutConsole, an async-local scope that only turns hiding on. Every site changes its import line only; the viewer asks to be shown; check.ts drops a dead import. A scan test holds it, as harness.test.ts holds the session variables."
```

---

### Task 2: The background drive starts everything hidden

**Files:**
- Modify: `src/cli.ts:1-8` (import), `:125` (`main`)
- Modify: `src/drive.ts:724` (the detach env)
- Modify: `tests/console.test.ts` (append two describes)
- Modify: `tests/drive.test.ts:866`, `:872` (the detach e2e)

**Interfaces:**
- Consumes: `NO_CONSOLE_ENV` and `withoutConsole` (Task 1).
- Produces: `main(ctx, argv)` with `ctx.env[NO_CONSOLE_ENV]` set runs the whole invocation inside `withoutConsole`, with the marker removed from `ctx.env`.

- [ ] **Step 1: Write the tests.** Append to `tests/console.test.ts`:

```ts
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
```

In `tests/drive.test.ts`, in the test `--detach starts drive in the background · …` (`:862`):
- Make the fake agent `#!/bin/sh\nenv > "${dir}/env"\necho $$ > "${dir}/session"\nexec sleep 30\n`.
- After the `session` poll, add:

```ts
    // Row 201: the marker describes the background drive alone — a session has a console
    expect(readFileSync(join(dir, 'env'), 'utf8')).toContain('WITNESS_DRIVE=')
    expect(readFileSync(join(dir, 'env'), 'utf8')).not.toContain('WITNESS_NO_CONSOLE')
```

- [ ] **Step 2: Run them and watch the right ones fail**

Run: `npx vitest run tests/console.test.ts && npx vitest run tests/drive.test.ts -t detach`

Expected: two tests FAIL:
- the detach test, because the marker is `undefined`;
- "an invocation carrying the marker …", because `windowsHide: false` is recorded on its calls.

These tests pass already. They are guards, and E7's mutations M3, M4 and M5 prove each of them bites:
- "without the marker nothing is hidden";
- the nested test;
- the e2e assertion.

- [ ] **Step 3: Implement.**
  - In `detachDrive`, add `[NO_CONSOLE_ENV]: '1'` to the env beside `[DRIVE_LOG_ENV]: log`.
  - In `src/cli.ts`, import `NO_CONSOLE_ENV` and `withoutConsole` from `./spawn.js`, and open `main` with:

```ts
  // Row 201. The background drive has no console, so everything this invocation starts —
  // the floor gate's git calls below included — starts hidden. The marker describes this
  // process alone: a session it starts has a console, the hidden one its spawn gave it.
  if (ctx.env[NO_CONSOLE_ENV] !== undefined) {
    return withoutConsole(() => main({ ...ctx, env: { ...ctx.env, [NO_CONSOLE_ENV]: undefined } }, argv))
  }
```

- [ ] **Step 4: Run the tests again**

Run: `npx vitest run tests/console.test.ts && npx vitest run tests/drive.test.ts -t detach && pnpm run typecheck`

Expected: all pass (the win32 block is skipped), and the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/drive.ts tests/console.test.ts tests/drive.test.ts
git commit -m "fix(drive): a background drive starts everything hidden on Windows (D201)" -m "drive --detach starts drive with no console (libuv's DETACHED_PROCESS), so Windows gave every console program it started a window of its own: each git call, each session, each gate. detachDrive now hands it WITNESS_NO_CONSOLE=1, and main runs that invocation inside withoutConsole from its first line, the floor gate's git calls included, passing the marker to nothing it starts. Nowhere else is hidden: a child given a hidden console of its own never hears the terminal's Ctrl+C, which is how a foreground drive's sessions stop. Fixes #54."
```

---

### Task 3: On Windows a stopped session takes its whole tree

**Files:**
- Modify: `src/spawn.ts` (append `treeStop`)
- Modify: `src/drive.ts:187-203` (the comment and `signal`)
- Modify: `src/drive-presence.ts:101-105` (`watchLine`)
- Test: `tests/spawn.test.ts`: `treeStop` on any host; in the win32 block, the F11 twin and `:319` → `res.outcome`
- Test: `tests/drive.test.ts`: `watchLine` per platform

**Interfaces:**
- Consumes: `spawn` (Task 1). Inside the background drive's scope, the taskkill it starts is hidden too.
- Produces: `treeStop(pid: number, env: Record<string, string | undefined>): { file: string; args: string[] }` and `watchLine(h: DriveHolder, platform: NodeJS.Platform = process.platform): string`.

- [ ] **Step 1: Write the failing tests.**

In `tests/spawn.test.ts`, import `treeStop` beside `resolveSpawn`, and add after the any-host describe:

```ts
describe('treeStop (row 201)', () => {
  it("stops a Windows process tree with System32's taskkill, whatever PATH holds", () => {
    expect(treeStop(4242, { SystemRoot: 'D:\\WINNT', PATH: 'C:\\planted' })).toEqual({
      file: 'D:\\WINNT\\System32\\taskkill.exe', args: ['/PID', '4242', '/T', '/F'],
    })
    expect(treeStop(7, {}).file).toBe('C:\\Windows\\System32\\taskkill.exe')
  })
})
```

In the same file's `the harness spawn sites reach a .cmd CLI (win32 only)` block, change `:319` to `expect(res.outcome).toBe('exited')`, and add:

```ts
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
```

In `tests/drive.test.ts`, import `watchLine` from `../src/drive-presence.js`, and add to the `one command (B1)` describe:

```ts
  it('names the stop the platform has (row 201)', () => {
    const h = { pid: 7, log: '/r/.witness/drive.log' }
    expect(watchLine(h, 'linux')).toBe('tail -f /r/.witness/drive.log · stop it: kill 7')
    expect(watchLine(h, 'win32')).toBe('tail -f /r/.witness/drive.log · stop it: taskkill /PID 7 /T /F')
    expect(watchLine({ pid: 7 }, 'win32')).toBe('the terminal running witness drive · pid 7')
  })
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/spawn.test.ts tests/drive.test.ts -t "treeStop|names the stop"`

Expected: FAIL.
- `treeStop is not a function`.
- `watchLine(h, 'win32')` still says `kill 7`.

On Windows, the F11 twin fails too: `late` is written, because only `cmd.exe` died.

- [ ] **Step 3: Implement.**
  - **`treeStop` in `src/spawn.ts`:** `win32.join(envGet(env, 'SYSTEMROOT') ?? 'C:\\Windows', 'System32', 'taskkill.exe')` with `['/PID', String(pid), '/T', '/F']`. Comment it as the twin of `resolveSpawn`'s System32 `cmd.exe`: never PATH, where a repo could plant one.
  - **`src/drive.ts`:** import `treeStop`. Replace the last sentence of the comment at `:187-189` with: `Windows has no groups to signal: there the stop is a tree kill from the shim down, because libuv's job object lets the agent under the shim break away (row 201).` In `signal`, keep the grouped branch as it is. Off it, when `child.pid !== undefined`, run `spawn(stop.file, stop.args, { stdio: 'ignore' }).on('error', () => {})` with `stop = treeStop(child.pid, run.value.env)`, and fall back to `child.kill(sig)` only when there is no pid. The `SIGKILL` re-run finds nothing left and is ignored.
  - **`src/drive-presence.ts`:** `watchLine(h, platform = process.platform)` prints `stop it: taskkill /PID ${h.pid} /T /F` when `platform === 'win32'`, and `stop it: kill ${h.pid}` otherwise. The log-less form is unchanged. Above it, add: `// Row 201: \`kill\` is not a Windows command, and PowerShell's alias ends drive alone.`

- [ ] **Step 4: Run the tests again**

Run: `npx vitest run tests/spawn.test.ts tests/drive.test.ts tests/console.test.ts && pnpm run typecheck`

Expected: all pass (win32 blocks skipped), and the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/spawn.ts src/drive.ts src/drive-presence.ts tests/spawn.test.ts tests/drive.test.ts
git commit -m "fix(drive): on Windows a stopped session takes its whole tree (D201)" -m "Drive's stop reached only the cmd.exe shim on Windows: libuv's job object lets the agent under it break away, so a timed-out session kept acting on the repo. Until now its window at least showed it; hidden, nothing would. The stop is now System32's taskkill /PID <pid> /T /F, the twin of the POSIX group kill, and the background drive's stop line prints that command, since kill is not a Windows command and PowerShell's kill ends drive alone. Also fixes a Windows-only test that still expected spawnSession's old string return."
```

---

### Task 4: The decision record

**Files:** `DESIGN.md`. Use exact-string edits; the lines are long.

**Interfaces:** none (documentation). State what Tasks 1–3 built, citing their files. Fold in any correction made while executing.

- [ ] **Step 1: Legend.** At the end of the legend paragraph (`DESIGN.md:351`), after `…amended: 52, 125, 156, 191; touched: 72).`, append:

```markdown
 Row 201 (⊜) added 2026-10-24 — post-incident amendment, no grill: issue #54 found a background drive on Windows opening a console window for every program it started, because it runs with no console and no spawn asked for a hidden one; the fix hides only where witness has no console to share, since a hidden child never hears the terminal's Ctrl+C (amended: 180; touched: 164, 184).
```

- [ ] **Step 2: Row 201.** Insert directly after row 200 (`DESIGN.md:555`):

```markdown
| 201 ⊜ | A background drive opens no windows | Fixes issue #54; amends 180; touches 164 and 184. `src/spawn.ts` is the one module that imports `node:child_process` (a scan test holds it, as `tests/harness.test.ts` holds the session variables): its `spawn`, `spawnSync`, `execFileSync` and `execSync` take child_process's own arguments and, inside `withoutConsole`, start the child with `windowsHide` — on Windows `CREATE_NO_WINDOW`, a console without a window that everything under the child inherits. The scope is async-local, like row 191 §4.8's stamp, and only ever turns hiding on, so a decision drive runs through `main` in process keeps it. `drive --detach` hands the background drive `WITNESS_NO_CONSOLE=1`; `main` reads it before the floor gate's git calls, runs the invocation inside the scope, and hands it to nothing it starts — a session has a console, the hidden one its spawn gave it. Anywhere else a child shares witness's console, as before. The viewer `design --open` starts is the one window witness means to show, and asks for it. On win32 a session drive stops goes with its whole tree — System32's `taskkill /PID <pid> /T /F`, the POSIX group kill's twin — and the background drive's stop line is that command. | Issue #54, against 0.24.1 on Windows 11 with Windows Terminal as the default terminal: a background drive opened a Terminal window for every git call, session and gate — about one a second while a blocked step looped through 14 sessions — and kept a `pi` window open per session. libuv starts a detached child with `DETACHED_PROCESS`, so the background drive had no console, and Windows gives every console program such a process starts a new console, which is a window. Only `CREATE_NO_WINDOW` avoids that; Node asks for it under `windowsHide: true` alone, and only when no stdio slot inherits a handle. No spawn passed it, and with child_process imported in sixteen modules the rule had no home: 164's `resolveSpawn` said what a harness CLI is started as, not how anything is started. The issue's own fix — `windowsHide` on every spawn — was rejected: a child given a hidden console of its own no longer shares the terminal's, so Ctrl+C never reaches it (nodejs/node#29837), and a foreground drive's sessions are stopped exactly that way — pi takes the signal and stops its own tools — while drive's own stop reached only the `cmd.exe` shim, the agent under it breaking away from libuv's job object. Hiding the sessions took away the window that showed an orphaned one, so the tree stop came with them. `windowsHide` on the `--detach` spawn itself would do nothing: `CREATE_NO_WINDOW` is ignored with `DETACHED_PROCESS`, and libuv skips it for an inherited log handle anyway. A configured `notify:` starts hidden in the background drive as well; Node's flag also sets `SW_HIDE`, so a notifier that opens a window of its own opens it hidden — the notifiers witness names ask the OS to post one. Measured on the reporting machine: MEASURED (Task 5). |
```

- [ ] **Step 3: Notes on the touched rows.**
  - **Row 164:** after `No dependency` (just before ` | Recorded as Open / deferred (a)`), insert: ` **Touched by 201:** \`src/spawn.ts\` is also the only module that imports \`node:child_process\`, and whether a child gets a console window is part of what it hands child_process.`
  - **Row 180:** after `never read back from the file.`, insert: ` **Touched by 201:** on Windows the background drive starts everything hidden, a session drive stops goes with its whole tree, and the stop line \`watch:\` prints there is \`taskkill /PID <pid> /T /F\`.`
  - **Row 184:** after `or the run stopped.`, insert: ` **Touched by 201:** in the background drive the notifier starts hidden.`

- [ ] **Step 4: Open / deferred.** Edit the bullet `**Windows is not a CI platform, …**` (`DESIGN.md:600`):
  - In (a), replace `and the drive and calibrate workers' timeouts leave the agent running.` with `and the calibrate worker's timeout leaves the agent running — drive's session stop takes the tree since row 201.`
  - Before `Nothing left here stops the pipeline outright;`, insert: `(f) the background drive's \`watch:\` line names \`tail -f\`, which neither cmd.exe nor PowerShell has — row 201 made only its stop half Windows's; (g) a prompt a background drive's child puts on its console — an ssh passphrase or host-key question on \`git push\` or \`fetch\` — waits on a console nobody can see, where POSIX fails it for want of a terminal, and with no timeout on \`git\` drive waits with it; (h) \`notify:\` with a \`.cmd\` notifier has (e)'s shape: \`where\` finds it, the bare spawn fails, and the run reports the notifier not found; (i) a witness that another program starts with no console still opens a window per child — only \`--detach\` marks one (row 201), and pi runs its tool shells hidden, so nothing in a drive's tree does so today. `
  - Replace `(a)'s timeout residual is the one that can hang it.` with `(a)'s timeout residual and (g) are the ones that can hang it.`

- [ ] **Step 5: Proofread and commit**

Run each check and compare:
- `grep -c '^| 201 ⊜ |' DESIGN.md` → `1`.
- `grep -c 'Row 201 (⊜)' DESIGN.md` → `1`.
- `grep -c 'Touched by 201' DESIGN.md` → `3`.

```bash
git add DESIGN.md
git commit -m "docs(design): row 201 — a background drive opens no windows (D201)" -m "Fixes issue #54; amends row 180, touches 164 and 184. Records the one owner of child processes, the console-less background drive and the async-local scope, why the issue's blanket windowsHide was rejected (a hidden child never hears the terminal's Ctrl+C), the Windows tree stop that came with hiding sessions, and four Windows residuals under Open / deferred."
```

---

### Task 5: Verify, measure on Windows, ship, close

**Files:** none, except Step 2's one sentence in `DESIGN.md`.

- [ ] **Step 1: Full verification here, at the branch tip**

```bash
pnpm test > "$TMPDIR/witness-201-test.log" 2>&1; grep -E 'Test Files|Tests ' "$TMPDIR/witness-201-test.log"; grep -c AssertionError "$TMPDIR/witness-201-test.log"
pnpm run typecheck && pnpm run build && npx biome check .
```

Expected:
- `Tests` reports 0 failed, and the `AssertionError` count is `0` (E7 records the dry-run's count).
- The other commands exit 0.

- [ ] **Step 2: The Windows probe — human, on the reporting machine**

```powershell
git fetch; git switch console-windows; pnpm install; pnpm run build
pnpm vitest run tests/console.test.ts tests/spawn.test.ts
```

Expected:
- every win32 block passes, including `gets one outside the scope, and none inside it` and the F11 twin;
- one PowerShell window flashes during the console test — that is its control case.

If `hidden` is not `0` while no window appeared, the probe is wrong, not the fix. Note it, and let the watcher below decide.

Then, in `wot-mod-manager`, with at least one runnable step, run `node <checkout>\dist\bin.js drive --detach` with the window-event watcher running for two minutes. Expected:
- no `CASCADIA_HOSTING_WINDOW_CLASS` SHOW events;
- the watch line ends `stop it: taskkill /PID <pid> /T /F`, and running it leaves no `pi` or node process from the run.

Finally, in Windows Terminal, run a foreground `witness drive --manual`, press Ctrl+C mid-session, and confirm the session's processes are gone. This is unchanged behavior, confirmed rather than assumed.

Replace `MEASURED (Task 5)` in row 201 with what was seen (counts before and after, and the foreground check), then commit `docs(design): row 201's Windows measurement (D201)`.

- [ ] **Step 3: Push and open the PR — the human says go first**

```bash
git push -u origin console-windows
gh pr create --title "fix: a background drive opens no windows on Windows (D201)" --body-file "$TMPDIR/201-pr.md"
```

The PR body says, in four short sections:
- **Root cause:** E2–E3.
- **Fix:** Tasks 1–3.
- **Not changed:** E4's foreground and the Open / deferred items.
- **Verification:** Step 1's counts, and Step 2's measurement.

- [ ] **Step 4: Merge and release 0.24.2 — the human says go first**

After CI is green, merge the PR and run `pnpm release patch` from `main`. If the command classifier blocks it, the human runs it. Watch the release run. A vitest flake before `npm publish` publishes nothing, so `gh run rerun <id> --failed` is safe.

- [ ] **Step 5: Close #54 — the human says go first**

Comment on #54 with:
- the root cause in two sentences;
- why the fix hides only the background drive (E4);
- the release;
- the measurement.

Then close the issue, and point `wot-mod-manager` at 0.24.2.
