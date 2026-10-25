# The human loop (issue #56) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under `autonomy: on`, drive pauses instead of quitting when everything left waits on the human, the human is notified the moment something new needs them (Windows included), the `/witness` chat sleeps until then and is woken, trust is checked before work and granted per command in the chat, and drive never respawns a session that changed nothing.

**Architecture:** Four slices on one branch, one release (0.25.0). S1 makes trust visible to routing (`trustOwed` inside `flowAction`), makes the `trust` verb per-command and session-proof, and makes drive's progress check count acts only (a `Record<EntryType, …>` table). S2 makes drive pause on a stat-signature watch list, derives one needs-you list for the report, the notifier and `wait`, publishes drive's verdicts to `.witness/live/`, and gives stuck/capped/merge a way back. S3 adds `witness wait`, the `wait:` lines `next` prints, the engine rows, and the Pi add-on waker. S4 adds the Pi fresh chat.

**Tech Stack:** TypeScript (Node ≥ 20), vitest, the repo's own `tests/helpers.ts` fixtures (`seededRepo`, `fakeCtx`, `fakeClock`, `fakeScenario`, `addOrigin`, `autonomyOn`, `writeLocalConfig`), Pi extension API (Pi 0.85.1), biome.

**Spec:** `docs/superpowers/specs/2026-10-25-issue-56-human-loop-design.md` — read it first; §-references below are to it.

## Global Constraints

- Witness-only: never modify fewhats, HYC, KYC or any consumer repo; the differential reads them through `git clone --local` into scratch.
- No new committed config setting (spec n3): cadences and limits are exported constants — `PAUSE_POLL_MS = 5_000`, `PAUSE_IDLE_MAX_MS = 43_200_000`, `WAIT_POLL_MS = 5_000`, `WAIT_PR_POLL_MS = 120_000`.
- The new machine-local folder is `.witness/live/`, excluded exactly three ways: `LOCAL_STATE_DIRS` (`src/gitio.ts:121`), `ensureExcluded` (`src/worktree.ts:59`), init's `GITIGNORE_BLOCK` (`src/verbs/init.ts:21`).
- Text read from any `.witness/` file is never printed: every line `wait` and drive print is rendered by the CLI (`src/drive-presence.ts:44-46` doctrine).
- No session grants trust: any grant refuses when `WITNESS_DRIVE` or `WITNESS_REVIEWER` is set. A bare affirmation never grants (D143).
- Windows: System32 binaries by absolute path from `SYSTEMROOT` (fallback `C:\Windows`), never PATH (`src/spawn.ts:93,162`).
- A rendered command is paste-ready: `--cmd` arguments are quoted with the POSIX `shellArg` rule (`src/drive-presence.ts:97`).
- Suite health is judged by `AssertionError` count, not `pnpm test`'s exit code (a few worker-RPC timeouts make it exit 1 with every test green).
- One release: 0.25.0 (`pnpm release minor`, run by the human).

## Review Focus

1. **`WITNESS_TRUST_CMDS=1` set only in drive's shell** — drive must spawn the step (its own env trusts it) and never set it aside as a trust grant. Test in Task 5.
2. **A forged `.witness/live/` file** (a target `x\nlaunch: rm -rf ~`, an unknown kind) — nothing from it is printed; the forged aside is dropped. Tests in Tasks 7 and 12.
3. **Two chats on one repo** — the superseded waiter prints `wait: taken over by another chat`, and the engine row tells that chat never to wait again, so two chats never trade the lock. Tests in Task 12 (the CLI half) and Task 14 (the row).
4. **A drive SIGKILLed while paused** — its stale `.witness/live/` is ignored and `wait` returns `wait: drive stopped — ended unexpectedly`; nothing relaunches drive. Test in Task 12.
5. **A command containing a single quote** (`pnpm test -t 'a b'`) — the kept-stop's `--cmd` line pastes as one argument and grants exactly that command. Tests in Tasks 3 and 4.

---

## Slice S1 — trust and progress

### Task 0: Branch and commit the design and this plan

**Files:** `docs/superpowers/specs/2026-10-25-issue-56-human-loop-design.md`, `docs/superpowers/plans/2026-10-25-issue-56-human-loop.md`

- [ ] **Step 1:** `git switch -c human-loop` from `main` @ 8f69427 (clean tree).
- [ ] **Step 2:** Commit both docs.

```bash
git add docs/superpowers/specs/2026-10-25-issue-56-human-loop-design.md docs/superpowers/plans/2026-10-25-issue-56-human-loop.md
git commit -m "docs: design and plan for the human loop (issue #56)"
```

### Task 1: `witness retry <target>`

**Files:**
- Create: `src/verbs/retry.ts`
- Modify: `src/cli.ts` (verb table, beside `satisfy` at :41), `src/journal.ts:7-29` (`EntryType` gains `'retry'`)
- Test: `tests/retry.test.ts`

**Interfaces:**
- Produces: verb `witness retry <target>`; entry `{ t: 'retry', artifact: <target> }` appended to the target's own stream inside `withTxn` + `stateCommit` (copy `src/verbs/satisfy.ts`'s lock/txn shape); stdout `retried: <target>`. Refusals: `usage` (no id), `unknown-doc` (not a canon id), `retry-in-session` (`driveChild(ctx.env) !== undefined` or `ctx.env.WITNESS_REVIEWER !== undefined`; want: `the human retries from their own chat or terminal`).

- [ ] **Step 1: Write the failing tests**

```ts
it('journals a retry on the target\'s own stream and commits it', async () => {
  const repo = await startedPlan()                       // spec + approved plan + start
  const res = await repo.cli(['retry', 'auth-refresh-plan-1'])
  expect(res.code).toBe(0)
  expect(res.stdout).toContain('retried: auth-refresh-plan-1')
  expect(readStream(repo.root, 'auth-refresh-plan-1').at(-1)?.t).toBe('retry')
  expect(repo.git('status', '--porcelain')).toBe('')
})
it('refuses inside a drive session', async () => {          // and again with WITNESS_REVIEWER: '1'
  const repo = await startedPlan()
  const res = await repo.cli(['retry', 'auth-refresh-plan-1'], { env: { WITNESS_DRIVE: 'auth-refresh-plan-1' } })
  expect(res.code).toBe(2)
  expect(res.stderr).toContain('retry-in-session')
  expect(readStream(repo.root, 'auth-refresh-plan-1').some((e) => e.t === 'retry')).toBe(false)
})
it('refuses a target that is not in canon', async () => { /* code 2, 'unknown-doc' */ })
```

- [ ] **Step 2:** `npx vitest run tests/retry.test.ts` → FAIL (`unknown verb retry`).
- [ ] **Step 3:** Implement `run(ctx: Ctx, argv: string[]): Promise<number>` in `src/verbs/retry.ts`; register `retry: () => import('./verbs/retry.js')`.
- [ ] **Step 4:** `npx vitest run tests/retry.test.ts` → PASS; `npx tsc --noEmit` → 0.
- [ ] **Step 5:** Commit `feat(retry): a journaled human act that asks drive to try a target again (D207)`.

### Task 2: Drive's progress counts acts, never bookkeeping

**Files:**
- Create: `src/progress.ts`
- Modify: `src/drive.ts:293-296` (`moved` → `movesFlow`), `tests/drive.test.ts:520-529` (busy target)
- Test: `tests/progress.test.ts`, `tests/drive.test.ts`

**Interfaces:**
- Consumes: `EntryType`, `Entry` (`src/journal.ts`), `vacuousEvidence` (`src/steps.ts`).
- Produces:
  - `export const ENTRY_PROGRESS: Record<EntryType, 'act' | 'bookkeeping'>` — bookkeeping: `sync`, `dispatch`, `write-refused`, `drift-check`, `policy-pin`; every other kind (including `retry`) is `act`. The `Record` makes tsc the ratchet: a new `EntryType` without a row fails the build.
  - `export function movesFlow(e: Entry): boolean` — `ENTRY_PROGRESS[e.t] === 'act' && !vacuousEvidence(e)`; an unknown `t` read from a hand-edited journal is `false`.
  - `src/drive.ts` uses `movesFlow` wherever it used `moved` (both `progressKey` reads).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/progress.test.ts
it('classifies bookkeeping as no motion', () => {
  for (const t of ['sync', 'dispatch', 'write-refused', 'drift-check', 'policy-pin'] as const)
    expect(movesFlow({ v: 1, t })).toBe(false)
  expect(movesFlow({ v: 1, t: 'test-evidence', phase: 'red', vacuous: true })).toBe(false)
  expect(movesFlow({ v: 1, t: 'test-evidence', phase: 'red', tests: [{ name: 'x', ok: false }] })).toBe(true)
  expect(movesFlow({ v: 1, t: 'retry', artifact: 'p' })).toBe(true)
})
// tests/drive.test.ts — the issue's two routes to the cap (P2, P6)
it('a session that only reports a zero-step dispatch is caught after one spawn', async () => {
  const repo = await startedFlows(['a'])
  const agent = script(`echo tick\nexec ${witnessCli()} dispatch-report a-plan-1 --steps-assigned 1 --steps-completed 0`)
  const out: string[] = []
  await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 6 }, fakeClock(0))
  expect(out.join('\n')).toContain('drive: no progress — witness test-evidence a-plan-1 --phase red --step s1')
  expect(out.filter((l) => / implement\/a-plan-1\] tick$/.test(l))).toHaveLength(1)
})
it('a session that only re-runs start in a repo with a remote is caught after one spawn', async () => {
  // fixture: seededRepo, writeSpec a, approve, writePlan a-plan-1, approve, addOrigin(repo), cli start, autonomyOn,
  // writeLocalConfig notify noop; the agent execs `start a-plan-1` and nothing else; same two expects
})
```

- [ ] **Step 2:** Rewrite `tests/drive.test.ts:520-529`'s busy agent from `dispatch-report … --steps-completed 0` to `retry a-plan-1` (an act), keeping its three expects.
- [ ] **Step 3:** `npx vitest run tests/progress.test.ts tests/drive.test.ts` → the two new drive tests FAIL (ceiling reached), `progress.test.ts` fails on the missing module.
- [ ] **Step 4:** Implement `src/progress.ts`; switch `src/drive.ts` to `movesFlow`.
- [ ] **Step 5:** Run the same command → PASS; `npx tsc --noEmit` → 0.
- [ ] **Step 6:** Commit `fix(drive): progress counts acts, never bookkeeping — sync and dispatch looped to the cap (D206)`.

### Task 3: The trust verb grants per command, lists config commands, and refuses in a session

**Files:**
- Modify: `src/allowlist.ts` (add `RunCommand`, `configCommands`, `commandsRun`), `src/verbs/trust.ts` (rewrite of `run`)
- Test: `tests/trust.test.ts` (update :35 and :58; add cases)

**Interfaces:**
- Consumes: `criteriaOwner` (`src/scan.ts`), `shellArg` (move `src/drive-presence.ts:97` to `src/toon.ts` and export it; drive-presence imports it back), `driveChild`.
- Produces:
  - `export interface RunCommand { cmd: string; source: string }` — `source` is one of `criteria.runner`, `ship.test`, `ship.lint`, `cmd: <criterion-id>`, `need: <need id or 1-based index>`.
  - `export function configCommands(cfg: Config): RunCommand[]` — the filtered runner template as `criteria.runner`, then `ship.test`, then `ship.lint`, each only when set, deduped by `cmd` keeping the first source (full-suite: the runner *is* `ship.test`).
  - `export function commandsRun(cfg: Config, canon: Canon, doc: CanonDoc | undefined): RunCommand[]` — `configCommands(cfg)`, then `criteriaOwner(canon, id)`'s `cmd:` criteria, then `doc`'s own `cmd:` needs; `doc === undefined` → config commands plus every spec's `cmd:` criteria and every doc's `cmd:` needs.
  - `witness trust [<id>] [--cmd '<exact>']… [--yes]`: lists `commands[N]{cmd,source,status}`; `--cmd` grants exactly the named commands (each must be in the list, else `--cmd,unknown-command,<got>,one of: …`); `--yes` grants all pending only when `ctx.isTTY`, else refuses `--yes,yes-needs-terminal,no terminal,name each command: witness trust <id> --cmd '<cmd>'`; any grant refuses `trust,trust-in-session,<WITNESS_DRIVE|WITNESS_REVIEWER>,the human grants trust in their own chat or terminal` inside a session; a grant needs an `<id>` (the act is journaled against it, `journalTrust` unchanged); without a grant flag and no TTY: exit 1 with `trust: <n> untrusted — name each: witness trust <id> --cmd '<cmd>'`, each line paste-ready via `shellArg`.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists a plan\'s spec criteria and the config commands it runs (P3)', async () => {
  const repo = await planWithCmdCriterion()            // full-suite, ship.test 'pnpm test', ship.lint 'pnpm lint', spec cmd 'echo first'
  const res = await repo.cli(['trust', 'ingest-plan-1'], { env: { WITNESS_TRUST_CMDS: '' } })
  expect(res.stdout).toContain('pnpm test,ship.test,untrusted')
  expect(res.stdout).toContain('pnpm lint,ship.lint,untrusted')
  expect(res.stdout).toContain('echo first,cmd: ac-a,untrusted')
  expect(res.code).toBe(1)
})
it('--cmd grants exactly the named command and journals it (P4)', async () => {
  const res = await repo.cli(['trust', 'ingest', '--cmd', 'echo first'], { env: { WITNESS_TRUST_CMDS: '' } })
  expect(res.code).toBe(0)
  expect(JSON.parse(repo.read('.witness/allow.json')).commands).toEqual(['echo first'])
})
it('--yes refuses without a terminal and grants all at one', async () => {
  // non-TTY → code 2, 'yes-needs-terminal', no allow.json; { tty: true } → both granted
})
it('no session grants trust', async () => {
  // --cmd with { WITNESS_DRIVE: 'ingest-plan-1' } and with { WITNESS_REVIEWER: '1' } → code 2, 'trust-in-session'
})
it('--cmd outside the list refuses', async () => { /* 'unknown-command' */ })
it('a command with a single quote is listed paste-ready and granted exactly (Review Focus 5)', async () => {
  // ship.test: "pnpm test -t 'a b'" → stdout contains `--cmd 'pnpm test -t '\''a b'\'''`; that argv grants it
})
it('with no id it lists everything the repo runs', async () => { /* config + spec cmd + needs rows */ })
```

- [ ] **Step 2:** Update `tests/trust.test.ts:35` (`--yes` now with `{ tty: true }`) and `:58` to the new listing text.
- [ ] **Step 3:** `npx vitest run tests/trust.test.ts` → FAIL.
- [ ] **Step 4:** Implement the functions and the verb.
- [ ] **Step 5:** `npx vitest run tests/trust.test.ts` → PASS; `npx tsc --noEmit` → 0.
- [ ] **Step 6:** Commit `fix(trust): grant per command, cover config commands and a plan's spec, never from a session (D205)`.

### Task 4: Trust is checked before work, in `next`

**Files:**
- Modify: `src/allowlist.ts` (add `trustOwed`), `src/verbs/next.ts` (`NextAction.trust`, `flowAction` signature, the two `computeNext` start rows at :996/:999, printing, `humanStop` :1032, `humanAction` :1059, the `outside` set :1143-1156)
- Test: `tests/trust-preflight.test.ts`

**Interfaces:**
- Consumes: `configCommands`, `RunCommand`, `trustedCommands` (Task 3).
- Produces:
  - `export function trustOwed(root: string, env: Ctx['env'], cfg: Config, canon: Canon, action: Pick<NextAction, 'line' | 'target'>): RunCommand[]` — `[]` when `env.WITNESS_TRUST_CMDS === '1'`; otherwise the untrusted commands the line's verb runs: `witness test-evidence`, `witness verify-red`, `witness gate implement`, `witness check --drift` → the runner command (template, or `ship.test` in full-suite); `witness ship` → runner + `ship.test` + `ship.lint`; `witness start <plan>` → that plan's own `cmd:` needs (`src/verbs/start.ts:106`). Never `cmd:` criteria (row 154: a plain approve leaves them blocked).
  - `NextAction.trust?: RunCommand[]`.
  - `export function trustAction(target: string, owed: RunCommand[]): NextAction` → `{ line: 'witness trust <target>', target, trust: owed, note: 'not trusted on this machine — <cmd> (<source>)[ · …] · the human names each to trust it' }`.
  - `flowAction(root, cfg, plan, judge: string | undefined, env: Ctx['env'])` — `env` added (callers :772, :1171, :1180 pass `ctx.env`); its returned action passes through `trustOwed`, and a non-empty result returns `trustAction`. The two `computeNext` start rows do the same.
  - `next` prints, under autonomy, one raw line per owed command above `next:` — `kept-stop: trust grant — <cmd> (<source>) · witness trust <target> --cmd <shellArg(cmd)>` — via `keptStopLine` (`src/autonomy.ts:31`); the `note:` prints in both modes.
  - `humanStop` and `humanAction` treat a `witness trust ` line as the human's (a chat item); the `outside` set is deleted, so a gate's kept trust grant is a chat item too.

- [ ] **Step 1: Write the failing tests**

```ts
it('a step whose runner is untrusted routes to the trust act (P5)', async () => {
  const repo = await untrustedFlow()                     // full-suite, ship.test 'pnpm test', started plan, autonomy on
  const res = await repo.cli(['next'], { env: { WITNESS_TRUST_CMDS: '' } })
  expect(res.stdout).toContain("kept-stop: trust grant — pnpm test (ship.test) · witness trust ingest-plan-1 --cmd 'pnpm test'")
  expect(res.stdout).toContain('next: witness trust ingest-plan-1')
})
it('WITNESS_TRUST_CMDS=1 routes the step itself', async () => { /* next: witness test-evidence ingest-plan-1 --phase red --step s1 */ })
it('a grant moves the route back to the step', async () => { /* trust --cmd 'pnpm test' then next → test-evidence line */ })
it('--flow and a worktree cwd agree with the ladder', async () => { /* next --flow ingest-plan-1 and next from worktreePath → same trust line */ })
it('an untrusted cmd: criterion never routes before the gate (row 154)', async () => {
  // filtered runner trusted, spec cmd 'echo first' untrusted, plan with both steps green → next: witness gate implement …
})
it('a start whose cmd: need is untrusted routes to the trust act', async () => {})
it('with autonomy off the note prints and no kept-stop line does', async () => {})
it('an autonomous chat routes the trust act while drive has other work', async () => {
  // two flows, one trust-blocked → next prints `next: witness trust …` and `launch: witness drive --detach`
})
it('a single-quoted command renders one paste-ready --cmd (Review Focus 5)', async () => {})
```

- [ ] **Step 2:** `npx vitest run tests/trust-preflight.test.ts` → FAIL.
- [ ] **Step 3:** Implement; update the existing tests that pinned the `outside` set or the old routing (run `npx vitest run tests/autonomy-next.test.ts tests/next*.test.ts` and fix only assertions about trust routing).
- [ ] **Step 4:** Same runs → PASS; `npx tsc --noEmit` → 0.
- [ ] **Step 5:** Commit `fix(next): an untrusted config command is the human's before any work starts (D205)`.

### Task 5: Drive sets the trust act aside and reports it

**Files:**
- Modify: `src/drive.ts` (`DriveStep`, `classifyAction`, `standAside`, `Aside`), `src/settle.ts` (`Settled` kept gains `untrusted?: string[]`; drive's settle pass copies it onto the aside), `src/drive-report.ts:52-57`
- Test: `tests/drive.test.ts`, `tests/drive-report.test.ts`

**Interfaces:**
- Consumes: `NextAction.trust`, `RunCommand`.
- Produces: `DriveStep` gains `{ kind: 'kept'; stop: 'trust-grant'; line: string }`, returned by `classifyAction` for an action with `trust` (checked before the conversation rule); `standAside` prints `drive: waits on you — <target> · trust grant` and sets the target aside `kept`/`trust-grant` with `key0` and `trust`. `Aside.trust?: RunCommand[]`. The report prints per command `wait: trust grant · <target> · <cmd> (<source>)` and `  run: witness trust <target> --cmd <shellArg(cmd)>`; a gate's kept trust grant uses its owner (`criteriaOwner`) and `source` `cmd: <id>` — the `<gate>` placeholder is gone.

- [ ] **Step 1: Write the failing tests**

```ts
it('spawns nothing for a trust-blocked step and reports the grant (P1)', async () => {
  const repo = await untrustedFlow()
  const marker = join(fakeScenario(), 'spawned')
  const agent = script(`touch ${marker}`)
  const out: string[] = []
  await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent, WITNESS_TRUST_CMDS: '' }, out), {}, fakeClock(0))
  expect(existsSync(marker)).toBe(false)
  expect(out).toContain('drive: waits on you — ingest-plan-1 · trust grant')
  expect(out).toContain('wait: trust grant · ingest-plan-1 · pnpm test (ship.test)')
  expect(out).toContain("  run: witness trust ingest-plan-1 --cmd 'pnpm test'")
})
it('a drive started with WITNESS_TRUST_CMDS=1 spawns the step (Review Focus 1)', async () => { /* marker exists, no trust aside */ })
it('classifyAction reads a trust act as kept', () => {
  expect(classifyAction({ line: 'witness trust p1', target: 'p1', trust: [{ cmd: 'pnpm test', source: 'ship.test' }] }, '/r'))
    .toEqual({ kind: 'kept', stop: 'trust-grant', line: 'witness trust p1' })
})
```

- [ ] **Step 2:** Update `tests/drive-report.test.ts:67`'s trust row to the new two lines.
- [ ] **Step 3:** `npx vitest run tests/drive.test.ts tests/drive-report.test.ts` → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Same run → PASS; `npx tsc --noEmit` → 0.
- [ ] **Step 6:** Commit `fix(drive): a trust grant waits on the human without a session (D205)`.

### Task 6: Remedy text, the gate's kept-stop text, the implement skill

**Files:**
- Modify: `src/runner.ts:74,85`, `src/needs.ts:42`, `src/criteria.ts:120`, `src/settle.ts:97-99`, `plugin/skills/witness-implement/SKILL.md:27-28`
- Test: `tests/command.test.ts:99-104`, `tests/autonomy-gate.test.ts:107` (update), `tests/calibrate-skills.test.ts` (if it snapshots the skill)

**Interfaces:**
- Produces, exact copy:
  - Runner refusals' `want`: `a trusted command — witness next names the grant to make, or set WITNESS_TRUST_CMDS=1 for automation` (the runner knows no target, so it names no placeholder).
  - `needs.ts` detail: `untrusted on this machine — witness next names the grant to make`.
  - `criteria.ts:120` detail: `untrusted-<trust> — the human names it: witness trust <id> --cmd <shellArg(cmd)>`.
  - `settle.ts` kept detail: `<cmd>[ · …] — the human names each in the chat: witness trust <owner> --cmd <shellArg(cmd)>`.
  - Implement skill, after the refusal-repair bullet: `- **An \`untrusted-\` refusal is the human's.** Stop, show the rows verbatim, end your turn. Never run \`witness trust\` — no session grants trust.`

- [ ] **Step 1:** Update the three tests to the new copy (they fail).
- [ ] **Step 2:** `npx vitest run tests/command.test.ts tests/autonomy-gate.test.ts` → FAIL.
- [ ] **Step 3:** Change the strings and the skill.
- [ ] **Step 4:** Same run → PASS.
- [ ] **Step 5:** Commit `docs(trust): every refusal names a grant a human can make in the chat (D205)`.

---

## Slice S2 — drive waits

### Task 7: `.witness/live/`

**Files:**
- Create: `src/live.ts`
- Modify: `src/gitio.ts:121`, `src/worktree.ts:59`, `src/verbs/init.ts:21-32`
- Test: `tests/live.test.ts`

**Interfaces:**
- Consumes: `driveHolder` (`src/drive-presence.ts`), `AsideKind` (`src/drive.ts`), `findById`.
- Produces:
  - `export const LIVE_DIR = '.witness/live'`
  - `export type EndReason = 'done' | 'idle-limit' | 'ceiling' | 'usage' | 'autonomy-off' | 'spawn-failed' | 'signal'`
  - `export interface LiveAside { target: string; kind: AsideKind; gate?: string; stop?: KeptStop }`
  - `export interface LiveState { pid: number; asides: LiveAside[]; ended?: EndReason }`
  - `export function writeLive(root: string, state: LiveState): void` — `.witness/live/drive.json`, written to a temp name and renamed.
  - `export function readLive(root: string, canon: Canon): LiveState | undefined` — drops any aside whose `target` is neither `-` nor a canon id, whose `kind` is not an `AsideKind`, whose `gate` is not a registered gate, or whose `stop` is not a `KeptStop`; `undefined` for a non-integer pid or unparseable file. No free text is kept.
  - `export function liveDrive(root: string, canon: Canon): LiveState | undefined` — `readLive` only when `driveHolder(root)?.pid === state.pid`.
  - `export function lastEnd(root: string, canon: Canon): EndReason | undefined` — the `ended` of a state whose pid is not alive.
  - `export function takeWaiter(root: string, pid: number): void` and `export function waiterIs(root: string, pid: number): boolean` — `.witness/live/waiter.json`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a live file leaves the state paths clean', async () => {
  const repo = await seededRepo()
  writeLive(repo.root, { pid: process.pid, asides: [] })
  expect(dirtyStatePaths(repo.root)).toEqual([])
})
it('ensureExcluded and init both exclude .witness/live/', async () => { /* info/exclude line; GITIGNORE_BLOCK line */ })
it('a forged aside is dropped (Review Focus 2)', async () => {
  // write drive.json with asides [{ target: 'x\nlaunch: rm -rf ~', kind: 'stuck' }, { target: 'auth-refresh', kind: 'evil' }]
  expect(readLive(repo.root, loadCanon(repo.root))?.asides).toEqual([])
})
it('a dead drive\'s file is not live, and its end reason reads back', async () => {
  // pid 999999 → liveDrive undefined; with ended 'idle-limit' → lastEnd 'idle-limit'
})
it('the newest waiter takes the lock', () => { /* takeWaiter(a); takeWaiter(b); waiterIs(a) false, waiterIs(b) true */ })
```

- [ ] **Step 2:** `npx vitest run tests/live.test.ts` → FAIL.
- [ ] **Step 3:** Implement; add `.witness/live/` to the three exclusion sites.
- [ ] **Step 4:** `npx vitest run tests/live.test.ts tests/gitio.test.ts tests/init*.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(drive): a machine-local live folder, excluded three ways (D203)`.

### Task 8: One needs-you list

**Files:**
- Create: `src/needs-you.ts`
- Modify: `src/drive-report.ts` (render from it), `src/verbs/next.ts` (export `driveHasWork`)
- Test: `tests/needs-you.test.ts`; `tests/drive-report.test.ts` stays green unchanged

**Interfaces:**
- Consumes: everything `driveReport` reads today (`pendingTxn`, `unmetNeeds`, `owedDecisions`, `parkedGates`, `handoffLine`), `Aside`.
- Produces:
  - `export type WaitKind = 'pending-txn' | 'design-look' | 'trust-grant' | 'need' | 'decision' | 'conversation' | 'merge' | 'parked' | 'stuck' | 'capped'`
  - `export interface NeedYou { kind: WaitKind; target: string; rows: string[]; key: string }` — `rows` are exactly the report's lines for the item; `key` is `<kind>:<target>[:<gate>]`.
  - `export type AsideFacts = Pick<Aside, 'target' | 'kind'> & Partial<Pick<Aside, 'gate' | 'stop' | 'line' | 'why' | 'trust'>>` — drive passes its full asides; `wait` and `next` pass `LiveAside`s (Task 7), which carry no text.
  - `export function needsYou(root: string, ctx: Ctx, cfg: Config, canon: Canon, aside: readonly AsideFacts[]): NeedYou[]` — the report's order: pending transaction, looks and trust grants, needs, decisions, conversations and merges, parked, stuck and capped. Rows use `line`/`why`/`trust` only when given; otherwise a fixed template rendered from canon and the journal (`stuck: <target> — witness log <target>`, a trust grant re-derived with `trustOwed`, a merge's PR from the plan's `pr`). The key never depends on that text, so drive, `next` and `wait` compute the same token for the same state.
  - `export function needsYouToken(items: readonly NeedYou[]): string` — first 12 hex of sha1 over the sorted keys.
  - `export const WAIT_LABEL: Record<WaitKind, string>` — `pending transaction`, `design look`, `trust grant`, `unmet need`, `decision`, `conversation`, `merge`, `parked`, `stuck`, `capped`.
  - `driveReport` builds its wait/parked/stuck lines from `needsYou`; its output is byte-identical.

- [ ] **Step 1: Write the failing tests**

```ts
it('stuck, capped and a policy park are items', async () => {})
it('a pending transaction is first', async () => {})
it('the token ignores order and changes when an item is added', () => {
  expect(needsYouToken([a, b])).toBe(needsYouToken([b, a]))
  expect(needsYouToken([a, b, c])).not.toBe(needsYouToken([a, b]))
})
```

- [ ] **Step 2:** `npx vitest run tests/needs-you.test.ts` → FAIL.
- [ ] **Step 3:** Implement and re-point `driveReport`.
- [ ] **Step 4:** `npx vitest run tests/needs-you.test.ts tests/drive-report.test.ts tests/drive.test.ts` → PASS with no edit to existing report assertions.
- [ ] **Step 5:** Commit `refactor(drive): one needs-you list behind the report (D203)`.

### Task 9: The notifier — Windows toast, and a background mode

**Files:**
- Modify: `src/notify.ts`, `src/drive.ts:701-707` (caller)
- Test: `tests/drive-report.test.ts:63-70` (`describe('notify (B6)')`, update win32), `tests/notify.test.ts` (new)

**Interfaces:**
- Produces:
  - `export function notifyArgv(platform: NodeJS.Platform, configured: string | undefined, title: string, message: string, env?: Record<string, string | undefined>): { argv: string[]; env?: Record<string, string> } | undefined` — darwin/linux/configured unchanged (wrapped in `{ argv }`); win32 → `argv: [<SYSTEMROOT>\System32\WindowsPowerShell\v1.0\powershell.exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', TOAST_SCRIPT]`, `env: { WITNESS_NOTIFY_TITLE: title, WITNESS_NOTIFY_TEXT: message }`.
  - `export const TOAST_SCRIPT` — fixed copy:

```powershell
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $xml.GetElementsByTagName('text')
$t.Item(0).AppendChild($xml.CreateTextNode($env:WITNESS_NOTIFY_TITLE)) > $null
$t.Item(1).AppendChild($xml.CreateTextNode($env:WITNESS_NOTIFY_TEXT)) > $null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
```

  - `notify(configured, title, message, platform = process.platform, opts: { wait: boolean } = { wait: true })` → `{ outcome: 'sent' | 'started' | 'failed' | 'none'; command?: string }` — `wait: false` spawns detached with `stdio: 'ignore'`, unrefs, and returns `started` without waiting (spawned through `src/spawn.ts`, so a background drive starts it hidden). The win32 path is used as is (absolute), never probed through `resolves`.

- [ ] **Step 1: Write the failing tests**

```ts
it('win32 names System32 PowerShell by absolute path and keeps the message out of argv', () => {
  const r = notifyArgv('win32', undefined, 'witness drive', 'a "b" $(evil)', { SYSTEMROOT: 'C:\\Windows' })!
  expect(r.argv[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(r.argv.join(' ')).not.toContain('$(evil)')
  expect(r.env).toEqual({ WITNESS_NOTIFY_TITLE: 'witness drive', WITNESS_NOTIFY_TEXT: 'a "b" $(evil)' })
  expect(TOAST_SCRIPT).toContain('$env:WITNESS_NOTIFY_TEXT')
})
it('a configured notifier still wins on win32', () => {
  expect(notifyArgv('win32', '/bin/ping-me', 'witness drive', 'm')).toEqual({ argv: ['/bin/ping-me', 'm'] })
})
it('a background notify returns without waiting', async () => {
  const slow = script('sleep 5')
  const t0 = Date.now()
  expect(notify(slow, 't', 'm', 'darwin', { wait: false }).outcome).toBe('started')
  expect(Date.now() - t0).toBeLessThan(1000)
})
```

- [ ] **Step 2:** `npx vitest run tests/notify.test.ts tests/drive-report.test.ts` → FAIL.
- [ ] **Step 3:** Implement; adapt the one caller.
- [ ] **Step 4:** Same run → PASS.
- [ ] **Step 5:** Commit `feat(notify): a Windows toast by default, and a notify that never stalls drive (D203)`.

### Task 10: Drive pauses instead of quitting

**Files:**
- Modify: `src/drive.ts` (the loop :615-713, keep-awake, notifications per round, live publish, `stop` gains `'idle-limit'`, the `EndReason` value)
- Test: `tests/drive-pause.test.ts`; every autonomous `driveLoop` test that ends with a target aside passes `fakeClock(0)` (find them with `grep -n "driveLoop(.*autoCtx" tests/drive*.test.ts`; without it they poll for 12 h)

**Interfaces:**
- Consumes: `needsYou`, `WAIT_LABEL` (Task 8), `notify(…, { wait: false })` (Task 9), `writeLive` (Task 7), `keepAwake`.
- Produces:
  - `export const PAUSE_POLL_MS = 5_000`, `export const PAUSE_IDLE_MAX_MS = 43_200_000`
  - `export function watchSignature(root: string): string` — `size:mtimeMs` of every file under the journal dir and the canon dirs, plus `witness.config.yaml`, `.witness/allow.json`, `.witness/config.local.yaml` (absent → `-`); never `.witness/drive.log` or `.witness/live/`.
  - Loop: when `lanes.size === 0`, the run is autonomous and not stopping, and `aside` is non-empty → pause: print `drive: waiting on you — <n> item(s)` and the `needsYou` rows whenever the needs-you token differs from the last one printed (an unrelated journal write re-enters the pause silently), stop keep-awake, `writeLive`, then `await clock.sleep(PAUSE_POLL_MS)` (raced with the abort) until `watchSignature` changes (→ next round; keep-awake is taken again before the next spawn) or the pause reaches `PAUSE_IDLE_MAX_MS` (→ `drive: idle limit — waited 12h on you · the run ends`, `stop = 'idle-limit'`). With nothing aside the run ends as today. Not autonomous → today's `break`.
  - After every round under autonomy: items of `needsYou` whose `key` was not yet notified in this run go into one background notification, `witness · <repo>: <label> · <target>[ · <label> · <target>]{0,2}[ (+N)]`; the end-of-run notification keeps its bounded wait.
  - `writeLive` once when the loop starts, after any change to `aside`, and with `ended` (the `stop`, `'signal'`, or `'done'`) in the `finally`.

- [ ] **Step 1: Write the failing tests** — a scripted clock runs a callback on its n-th sleep:

```ts
const scripted = (acts: Record<number, () => Promise<void> | void>) => {
  const c = fakeClock(0); let n = 0; const sleep = c.sleep
  return { ...c, sleep: async (ms: number) => { n += 1; await acts[n]?.(); return sleep(ms) } }
}
it('a run whose last target waits on the human pauses, and a satisfied need resumes it', async () => {
  // a plan blocked by an unmet manual need + nothing else; act #2 runs `witness satisfy <plan> --need …`
  expect(out).toContain('drive: waiting on you — 1 item(s)')
  expect(out.some((l) => l.startsWith('drive: taken back — '))).toBe(true)
})
it('a grant written only to allow.json resumes a trust-blocked target', async () => {})
it('the pause ends at the idle limit with the report and a notification', async () => {
  expect(out).toContain('drive: idle limit — waited 12h on you · the run ends')
  expect(clock.now()).toBeGreaterThanOrEqual(PAUSE_IDLE_MAX_MS)
})
it('drive never wakes on its own log or live folder', async () => {
  const before = watchSignature(repo.root)
  writeFileSync(join(repo.root, '.witness/drive.log'), 'x'); writeLive(repo.root, { pid: 1, asides: [] })
  expect(watchSignature(repo.root)).toBe(before)
})
it('a needs-you item is notified once per run', async () => { /* recorder notify script logs one message naming 'trust grant · ingest-plan-1' */ })
it('keep-awake is released while paused', async () => { /* WITNESS_KEEP_AWAKE_BIN recorder sees start then TERM during the pause */ })
it('autonomy off still ends the run', async () => { /* existing 'hands a conversation stage back…' test stays green */ })
```

- [ ] **Step 2:** `npx vitest run tests/drive-pause.test.ts` → FAIL.
- [ ] **Step 3:** Implement; pass `fakeClock(0)` in the autonomous tests that now pause.
- [ ] **Step 4:** `npx vitest run tests/drive-pause.test.ts tests/drive.test.ts tests/drive-report.test.ts` → PASS; `npx tsc --noEmit` → 0.
- [ ] **Step 5:** Commit `feat(drive): wait for the human instead of quitting, and notify each new item (D202, D203)`.

### Task 11: What drive set aside comes back

**Files:**
- Modify: `src/drive.ts` (`stuck` :460-464 and `capped` :596-613 record `key0`; the merge asides :467-470 and :546-549 record `key0`; `takeBack` and `refreshAside` release them; a release deletes `use` and `progress` for the key)
- Test: `tests/drive-pause.test.ts`

**Interfaces:**
- Consumes: `witness retry` (Task 1), `movesFlow` (Task 2).
- Produces: every `Aside` carries `key0`; the comment and row 196's "never taken back" go.

- [ ] **Step 1: Write the failing tests**

```ts
it('a stuck target comes back when the human retries it', async () => {
  // agent exits 0 doing nothing → stuck; act #2 runs `witness retry a-plan-1` → 'drive: taken back — a-plan-1', a second tick
})
it('a capped target starts its spawn count over on release', async () => {
  // drive.caps.spawns 1; retry after the cap → spawned again, not 'capped' at once
})
it('a merge aside leaves when the merge stamp lands', async () => {
  // set PR merged in the fake gh dir, act #2 runs `witness next` (lazy stamp) → aside released, nothing spawned for it
})
```

- [ ] **Step 2:** `npx vitest run tests/drive-pause.test.ts` → FAIL.
- [ ] **Step 3:** Implement; update the row-196 tests that asserted a stuck target stays aside.
- [ ] **Step 4:** `npx vitest run tests/drive*.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(drive): stuck, capped and merge come back when their record moves (D207)`.

---

## Slice S3 — the chat

### Task 12: `witness wait`

**Files:**
- Create: `src/verbs/wait.ts`
- Modify: `src/cli.ts` (verb table), `src/stamp.ts:48` (export `prState`)
- Test: `tests/wait.test.ts`

**Interfaces:**
- Consumes: `needsYou`, `needsYouToken` (Task 8), `liveDrive`, `lastEnd`, `takeWaiter`, `waiterIs` (Task 7), `driveHolder`, `driveHasWork` (Task 8), `prState`.
- Produces:
  - `export const WAIT_POLL_MS = 5_000`, `export const WAIT_PR_POLL_MS = 120_000`
  - `export async function waitLoop(root: string, ctx: Ctx, cfg: Config, opts: { since?: string }, clock: Clock): Promise<number>` — the verb calls it with `realClock`. Items are `needsYou(root, ctx, cfg, canon, liveDrive(root, canon)?.asides ?? [])`. It takes the waiter lock first; if `needsYouToken(items) !== since` it returns at once (rule 4); otherwise it keeps the start set of keys, and each poll:
    1. not the waiter → `wait: taken over by another chat`, exit 0;
    2. no drive holds the lock (`driveHolder` undefined — a 0.24.x drive, which writes no live file, still holds it) and `driveHasWork` → `wait: drive stopped — <why>` + `token: <t>`, where `why` is `waited 12h on you` / `spawn ceiling` / `usage limit` / `autonomy is off` / `this machine could not start a session` / `stopped by a signal` from `lastEnd`, else `ended unexpectedly`;
    3. no drive, no work and nothing needs you → `wait: nothing owed`;
    4. an item whose key is not in the start set → `wait: needs you — <n> item(s)`, the rows, `token: <t>`; an item that left the set updates it silently (a removal never wakes the chat);
    5. every `WAIT_PR_POLL_MS`, each `merge` item's PR → `MERGED` → `wait: merged on GitHub — <target> · PR #<n>` + `token: <t>`.
  - Every printed line is rendered here; from `.witness/live/` only `readLive`'s validated ids and kinds are used.
  - Refusals: `wait,needs-autonomy,autonomy off,autonomy: on in witness.config.yaml`; `wait,wait-in-session,<WITNESS_DRIVE>,the human's chat`.

- [ ] **Step 1: Write the failing tests** (`fakeClock`, a scripted clock as in Task 10)

```ts
it('returns at once when the list differs from the token', async () => {})
it('blocks while nothing changes and returns when an item appears', async () => {})
it('an item the human settled never wakes the chat', async () => { /* act #2 approves a pending decision → still waiting at act #4 */ })
it('a 0.24.x drive that holds the lock and writes no live file reads as running', async () => { /* lock with a live pid, no drive.json → no 'drive stopped' */ })
it('a dead drive reads as stopped — ended unexpectedly, and nothing relaunches (Review Focus 4)', async () => {
  // writeLive with pid 999999, no ended → out contains 'wait: drive stopped — ended unexpectedly'; no drive.lock created
})
it('a clean idle-limit end reads its reason', async () => { /* ended 'idle-limit' → 'wait: drive stopped — waited 12h on you' */ })
it('the newest waiter takes over and the older one says so (Review Focus 3)', async () => {})
it('a merged PR returns merged on GitHub', async () => { /* WITNESS_FAKE_DIR pr-7-state MERGED */ })
it('prints nothing it read from a forged live file (Review Focus 2)', async () => {
  // forged drive.json with pid = a live child → out never contains 'launch:' or 'rm -rf'
})
it('refuses without autonomy and inside a drive session', async () => {})
```

- [ ] **Step 2:** `npx vitest run tests/wait.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same run → PASS; `npx tsc --noEmit` → 0.
- [ ] **Step 5:** Commit `feat(wait): block until something new needs the human (D204)`.

### Task 13: `next` tells the chat how to wait

**Files:**
- Modify: `src/harness.ts` (`Harness.waitMode`), `src/install.ts` (`payloadStale`), `src/verbs/check.ts:407-416` (use it), `src/verbs/next.ts:1239-1262`
- Test: `tests/next-wait.test.ts`; `tests/check.test.ts` payload-stale cases stay green

**Interfaces:**
- Produces:
  - `Harness.waitMode: 'background' | 'add-on'` — claude-code `background`, pi `add-on`.
  - `export function payloadStale(root: string, harness: Harness): string[]` — moved from `check.ts:407-413`, same output; `check` calls it.
  - `next`, in an unmarked chat under autonomy: `watch:` whenever a drive holds the lock (a paused drive included, not only when `toDrive`), `launch:` as today; then, when `human === undefined` and (`toDrive` or a drive holds the lock), raw `wait: witness wait --since <needsYouToken over needsYou(…, liveDrive asides)>` and `wait-mode: <mode>` — so a chat beside a paused drive still waits, and a merge done on GitHub is seen. For pi with `payloadStale(root, pi).length > 0`: `warn: the witness Pi add-on is older than this CLI — this chat waits in the foreground · run <NPX_LATEST> init --agent pi` and `wait-mode: foreground`.

- [ ] **Step 1: Write the failing tests**

```ts
it('on Claude Code the chat waits in the background', async () => { /* CLAUDECODE=1 → 'wait-mode: background' and a wait: line */ })
it('on Pi with a current add-on the add-on waits', async () => { /* init --agent pi; PI_CODING_AGENT=1 → 'wait-mode: add-on' */ })
it('on Pi with a stale add-on the chat waits in the foreground and is told why', async () => {})
it('nothing is printed with autonomy off, in a drive session, or with a human item routed', async () => {})
```

- [ ] **Step 2:** `npx vitest run tests/next-wait.test.ts tests/check.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same run → PASS.
- [ ] **Step 5:** Commit `feat(next): print how this chat waits, per harness (D204)`.

### Task 14: The engine rows, the skill, the README

**Files:**
- Modify: `plugin/commands/witness.md:28-54`, `README.md` (operator notes: notifications, Windows toast, `wait`, `retry`)
- Test: `tests/command.test.ts` (assertions on the rows)

**Interfaces:**
- Produces, rows (exact signals; wording may be tightened, the actions may not):
  - `kept-stop: trust grant` → show each command and its source; ask which to trust; for each the human **names**, run the `witness trust … --cmd …` text printed after `·`; a bare "y" grants nothing; END YOUR TURN to wait for the answer.
  - `kept-stop: unmet need` → show one need; on "done" run its `witness satisfy …`; on "not yet" leave it.
  - `launch:` / `watch:` → run or print; act on a routed human item; otherwise by `wait-mode:` — `background`: run the `wait:` command in the background (Claude Code: the Bash tool's `run_in_background`) and END YOUR TURN; `add-on`: END YOUR TURN (witness's add-on wakes this chat); `foreground`: run it and act on what it prints.
  - `wait: needs you` → run `$WITNESS next`, act on the first item. `wait: drive stopped — <why>` → tell the human, END YOUR TURN; on "go" run `$WITNESS next`, whose `launch:` restarts drive. `wait: taken over by another chat` → END YOUR TURN and never wait again in this chat. `wait: merged on GitHub` → run `$WITNESS next`. `wait: nothing owed` → END YOUR TURN.
  - "Under `autonomy: on`": trust grants and unmet needs are answered in this chat (replaces "outside this chat … in a terminal").

- [ ] **Step 1:** Add assertions to `tests/command.test.ts`: the file contains `wait-mode:`, `taken over by another chat`, `run_in_background`, `--cmd`; it no longer contains `a trust grant in a terminal`.
- [ ] **Step 2:** `npx vitest run tests/command.test.ts` → FAIL.
- [ ] **Step 3:** Edit the rows and the README.
- [ ] **Step 4:** `npx vitest run tests/command.test.ts tests/calibrate-skills.test.ts` → PASS.
- [ ] **Step 5:** Commit `docs(engine): the chat waits, trust and needs are answered in it (D204, D205)`.

### Task 15: The Pi add-on wakes the chat

**Files:**
- Modify: `plugin/hooks/context-core.mjs`, `plugin/hooks/witness-pi.ts`
- Test: `tests/context-core.test.ts`, `tests/pi-extension.test.ts` (extend `stubPi` with `sendMessage`, `sendUserMessage`, `registerCommand` recorders)

**Interfaces:**
- Produces (core, pure):
  - `export function waitRequest(output)` → `{ token } | undefined` — needs both `wait: witness wait --since <token>` and `wait-mode: add-on` lines; `token` must match `/^[0-9a-f]{12}$/`.
  - `export function pinOf(engineText)` → `x.y.z | undefined` — the `@popovych.co/witness@<x.y.z>` pin of the installed engine file.
  - `export function waitArgv({ bin, pin, token, platform, systemRoot })` → `WITNESS_BIN` set: `['sh', '-c', 'exec ' + bin + ' wait --since ' + token]`; else `['npx', '-y', '@popovych.co/witness@' + pin, 'wait', '--since', token]`. On win32 either line runs as `[<systemRoot>\System32\cmd.exe, '/d', '/s', '/c', <the line>]` — `npx` is a `.cmd` shim there (row 164), and the line carries only the validated pin and token beside the user's own `WITNESS_BIN`. `pin` must match `/^\d+\.\d+\.\d+$/`, else no wait is started.
  - `export function wakeAllowed({ hasUI, env })` → `hasUI && env.WITNESS_DRIVE === undefined && env.WITNESS_REVIEWER === undefined`.
- Adapter: on `tool_result` for a bash call where `invokesWitness(command)`, keep `waitRequest(text)` for the session (a newer one replaces it). On `agent_end`, when a request is kept and `wakeAllowed`, spawn `waitArgv` (pin read from `../prompts/witness.md` beside the extension file; `windowsHide: true`), one child per session, a new request killing the old child; on exit `pi.sendMessage({ customType: 'witness-wait', content: stdout, display: true }, { triggerTurn: true, deliverAs: 'followUp' })`. `session_shutdown` kills the child. The command run is always `waitArgv`'s — text from tool output contributes only the validated token.

- [ ] **Step 1: Write the failing tests**

```ts
it('wakes the chat with the wait output when the turn ends', async () => {
  // WITNESS_BIN = a fake script printing 'wait: needs you — 1 item(s)'; fire tool_result (witness next output
  // with wait + wait-mode add-on), fire agent_end, await the child → sendMessage called with
  // { customType: 'witness-wait' } and { triggerTurn: true, deliverAs: 'followUp' }, content containing 'needs you'
})
it('never waits without a screen, in a drive session or in a reviewer', async () => {})
it('ignores a wait line from a command that is not witness\'s', async () => {})
it('kills the waiter on session_shutdown', async () => {})
// context-core.test.ts
it('waitRequest rejects a malformed token and a missing add-on mode', () => {})
it('pinOf reads the engine pin', () => { expect(pinOf('WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.25.0}"')).toBe('0.25.0') })
```

- [ ] **Step 2:** `npx vitest run tests/pi-extension.test.ts tests/context-core.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same run → PASS; `npx tsc --noEmit` → 0.
- [ ] **Step 5:** Commit `feat(pi): the add-on wakes the chat when something needs the human (D204)`.

---

## Slice S4 — a fresh chat on Pi

### Task 16: The Pi add-on opens the fresh chat at the fill limit

**Files:**
- Modify: `plugin/hooks/context-core.mjs`, `plugin/hooks/witness-pi.ts`
- Test: `tests/context-core.test.ts`, `tests/pi-extension.test.ts`

**Interfaces:**
- Produces:
  - `export function freshDue(output)` → `true` when the output has a `relay:` line and no `run:` line.
  - `export function armedBy(input)` → `true` for a `/witness` prompt carrying `--manual`.
  - Adapter: `pi.registerCommand('witness-fresh', { description: 'continue witness in a fresh session', handler })`; the handler runs `ctx.newSession({ parentSession: ctx.sessionManager.getSessionFile(), withSession: async (c) => c.sendUserMessage(armed ? '/witness --manual' : '/witness') })`. `input` events latch `armed` per session. On `tool_result` (witness bash call) latch `freshDue`; on `agent_end`, when latched and `wakeAllowed`, `pi.sendUserMessage('/witness-fresh', { deliverAs: 'followUp' })` and clear the latch.

- [ ] **Step 1: Write the failing tests**

```ts
it('a relay with no run: opens a fresh session that runs /witness', async () => {
  // fire tool_result 'context: 21% of 1M\nrelay: /new then /witness', fire agent_end →
  // sendUserMessage('/witness-fresh', { deliverAs: 'followUp' }); call the registered handler with a ctx whose
  // newSession records → withSession's ctx.sendUserMessage called with '/witness'
})
it('a relay printed beside run: never opens one', async () => {})
it('an armed chat continues armed', async () => { /* input '/witness --manual' → '/witness --manual' */ })
it('never without a screen or in a drive session', async () => {})
```

- [ ] **Step 2:** `npx vitest run tests/pi-extension.test.ts tests/context-core.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same run → PASS.
- [ ] **Step 5:** Commit `feat(pi): a full chat continues in a fresh one by itself (D204)`.

---

## Finish

### Task 17: DESIGN.md rows

**Files:** `DESIGN.md`

- [ ] **Step 1:** Amend rows 81, 145, 154, 171, 173, 180, 182, 183, 184, 195 and 196 in place, each with a `**Touched by 20x:**` clause as the spec's §5 table says (house style: name the amending row).
- [ ] **Step 2:** Add rows 202–207 (`⊜`), titles from spec §5, each opening `Fixes issue #56;` and naming the rows it amends; 203 and 204 end `MEASURED (Task 18)` where the Windows and live-Pi results go.
- [ ] **Step 3:** `grep -cE '^\| 20[2-7] ⊜' DESIGN.md` → `6`.
- [ ] **Step 4:** Commit `docs(design): rows 202-207 — the human loop (issue #56)`.

### Task 18: Verify, review, measure, release

- [ ] **Step 1:** `npx tsc --noEmit` → 0; `pnpm build` → 0; `npx biome check src tests plugin` → 0.
- [ ] **Step 2:** `pnpm test 2>&1 | tee /tmp/…/suite.log; grep -c AssertionError …/suite.log` → `0` (worker-RPC timeouts alone are the known quirk; re-run those files).
- [ ] **Step 3:** Read-only differential: `git clone --local` fewhats.com and hear-your-customer-mvp into scratch; in each, with `CI=true`, run `next`, `status`, `check` under `npx -y @popovych.co/witness@0.24.2` and under `node <branch>/dist/bin.js`; outputs identical (both repos trust their config commands, P8).
- [ ] **Step 4:** Two opus reviews of `main..human-loop`: (a) code reality vs this plan and the spec; (b) behavior attack using the Review Focus list. Re-run every finding before fixing; fix RED→GREEN in one pass; repeat Steps 1–2.
- [ ] **Step 5 (HUMAN, Windows reporting machine):** with a 0.25.0 build: `witness drive --detach` on a repo whose `ship.test` is untrusted → a toast appears, no console window flashes, the report names the trust grant; in a Pi chat, `/witness` sleeps and is woken by the add-on; "trust pnpm test" grants and drive takes the flow back. Record the results in rows 203 and 204.
- [ ] **Step 6 (HUMAN, live Pi on this Mac):** a chat woken by a needs-you item; a chat over the fill limit continuing in a fresh session.
- [ ] **Step 7:** Push `human-loop`, open the PR (`Fixes #56`), CI green, the human merges.
- [ ] **Step 8 (HUMAN):** `pnpm release minor` → 0.25.0; push `main` and the tag.
