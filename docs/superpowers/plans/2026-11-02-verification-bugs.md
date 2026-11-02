# Verification bugs (#65–#71, #81) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eight CLI bugs found while verifying the witness UI design, each with a test that fails first, and release them as one patch before any UI work.

**Architecture:** Eight independent root fixes in the CLI, one task each, plus one docs task. No new dependency, no new config key. Every human-facing refusal keeps the `{field, rule, got, want}` shape.

**Tech Stack:** TypeScript ESM (strict, `noUncheckedIndexedAccess`), Node ≥ 20, vitest with the in-process CLI against throwaway git repos (`tests/helpers.ts`).

**Spec:** the issues #65–#71 and #81 (each holds its repro), and `docs/superpowers/specs/2026-11-02-witness-ui-design.md` §9 step 1, which puts this release first. Decided with the user 2026-11-02: principles are reviewed like specs (Task 8).

## Global Constraints

- Branch `verification-bugs` from `main` at 0.27.0 (`35b8a81`). Release as a patch (0.27.1); the user runs `pnpm release patch`.
- `src/spawn.ts` stays the only `node:child_process` importer (row 201).
- Every state write goes through `acquireLock` → `withTxn` → `stateCommit` (trailer `Witness-State: 1`).
- Tests keep row 213's rule: never hold the worker's event loop; await every CLI run.
- DESIGN rows 218–225, one per issue, in the order of the tasks below. The UI design's rows move to 226–234.
- Comments cite the row (`// Row 218.`), as the codebase does.

## Review Focus

1. A hand edit that moves only `drift` or `pr` (not `status`): `adopt` must refuse it as well (Task 7).
2. A drive whose host slept past the lease: on wake, no reader may treat it as gone long enough to start a second drive (Task 6).
3. `principles.md` amended by a feature effort *after* that effort's decompose already passed: the doc goes back to draft and the effort's decompose is owed again, never a silent loop (Task 8).
4. `WITNESS_BIN` with a quoted path containing spaces on Windows (`"C:\Program Files\nodejs\node.exe" C:\w\bin.js`) (Task 5).
5. A done plan with a parked ship gate, and an abandoned effort with a parked decompose: neither is listed (Task 2).

---

### Task 0: Branch and commit this plan

- [ ] **Step 1:** `git switch -c verification-bugs` from `main` at `35b8a81`.
- [ ] **Step 2:** Commit `docs/superpowers/plans/2026-11-02-verification-bugs.md` and `docs/superpowers/specs/2026-11-02-witness-ui-design.md` (`docs: plan for the verification bugs; the UI design`).

### Task 1: `satisfy` refuses inside a session (#70, row 223)

**Files:**
- Modify: `src/verbs/satisfy.ts` (after argument parsing, before any read)
- Test: `tests/satisfy.test.ts`

**Interfaces:**
- Consumes: `sessionMarker(env)` from `src/drive-presence.ts`.
- Produces: refusal rule `satisfy-in-session`.

- [ ] **Step 1: Write the failing test** in `tests/satisfy.test.ts`, reusing that file's fixture for a doc with a manual need:

```ts
it('refuses inside a drive session and inside a reviewer (#70)', async () => {
  const repo = await /* the file's manual-need fixture */
  for (const env of [{ WITNESS_DRIVE: '<doc-id>' }, { WITNESS_REVIEWER: '1' }]) {
    const res = await repo.cli(['satisfy', '<doc-id>', '--need', '1'], { env })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('satisfy-in-session')
  }
  expect(readStream(repo.root, '<doc-id>').some((e) => e.t === 'need-satisfied')).toBe(false)
})
```

- [ ] **Step 2:** Run `pnpm vitest run tests/satisfy.test.ts -t "#70"` — expect FAIL (exit 0, the need is satisfied).
- [ ] **Step 3:** In `run`, copy `retry.ts`'s guard: when `sessionMarker(ctx.env)` is set, refuse `v('satisfy', 'satisfy-in-session', marker, 'the human marks a need met from their own chat or terminal')`, exit 2.
- [ ] **Step 4:** Run the test — PASS; run `pnpm vitest run tests/satisfy.test.ts` — all PASS.
- [ ] **Step 5:** Commit `fix(satisfy): refuse inside a drive or reviewer session (#70)`.

### Task 2: Parked gates of terminal work owe nothing (#81, row 225)

**Files:**
- Modify: `src/verbs/next.ts` — `parkedGates`
- Test: `tests/next-live-queue.test.ts` (or the file that already covers `parkedGates`; `grep -rn parkedGates tests`)

**Interfaces:**
- Consumes: `effortAbandoned(entries)` from `src/journal.ts`.
- Produces: `parkedGates` skips plans whose `status` is `done` or `abandoned`, and efforts whose stream `effortAbandoned` says is abandoned.

- [ ] **Step 1: Write the failing tests:** (a) a plan with a parked implement gate (a `human-decision` `stop`), then `witness abandon <plan>` → `parkedGates(root, loadCanon(root))` has no entry for it, and `needsYou(...)` has no `parked` item for it; (b) the same for a plan stamped `done` with a parked ship gate; (c) an effort with a parked decompose gate, then `witness abandon <effort>` → no entry; (d) a parked gate on a live plan is still listed. Build each stop with the journal fixture the existing parked tests use (`grep -rn "gateParked\|parkedGates" tests`).
- [ ] **Step 2:** Run them — FAIL (both still listed).
- [ ] **Step 3:** In `parkedGates`, filter `canon.docs` plans with `!['done', 'abandoned'].includes(String(d.meta.status))` and skip effort slugs whose `readStream(root, slug)` is `effortAbandoned`. Comment: `// Row 225. A parked gate on terminal work is owed to no one.`
- [ ] **Step 4:** Run the tests — PASS; run `pnpm vitest run tests/next*.test.ts tests/needs*.test.ts tests/status*.test.ts` — PASS.
- [ ] **Step 5:** Commit `fix(next): parked gates of abandoned or done work are not owed (#81)`.

### Task 3: Trust grants take the repo lock (#67, row 220)

**Files:**
- Modify: `src/verbs/trust.ts` (`journalTrust` → `grantTrust`), `src/verbs/decide.ts` (its `--trust-cmds` grant after the lock release)
- Test: `tests/trust.test.ts`

**Interfaces:**
- Produces: `grantTrust(ctx: Ctx, root: string, artifact: string, cmds: string[], via: 'verb' | 'decide'): Result<void>` in `src/verbs/trust.ts` — acquires the repo lock, then inside one `withTxn` writes `allow.json` (`grantCommands`) and appends the `trust` entry, commits, releases. Lock contention → refusal `locked` (exit 3 from the verb); a refused commit → the refusal rows, and `allow.json` unchanged.
- `journalTrust` and the bare `grantCommands` calls in `trust.ts` and `decide.ts` are replaced by `grantTrust`.

- [ ] **Step 1: Write the failing tests:** (a) while the test holds the repo lock (`acquireLock(repo.root)`, with `LOCK_WAIT_MS` shortened the way the lock tests do), `repo.cli(['trust', '<id>', '--cmd', '<c>'])` exits 3 with `locked`, `allow.json` does not contain `<c>`, and the stream has no new `trust` entry; (b) the same through `decide <gate> <id> --approve --trust-cmds` on a stop that carries an untrusted command.
- [ ] **Step 2:** Run — FAIL (both grant while the lock is held).
- [ ] **Step 3:** Implement `grantTrust`; add `crashPoint(ctx.env, 'trust-journal')` between append and commit; call it from both sites. In `decide.ts` keep the release of decide's own lock before the call (the lock is not re-entrant).
- [ ] **Step 4:** Run `pnpm vitest run tests/trust*.test.ts tests/decide*.test.ts` — PASS.
- [ ] **Step 5:** Commit `fix(trust): grants write allow.json and the journal under the repo lock (#67)`.

### Task 4: `floor --set` commits its decision (#71, row 224)

**Files:**
- Modify: `src/verbs/floor.ts` (the `--set` branch)
- Test: `tests/floor-verb.test.ts`

**Interfaces:**
- Produces: `floor --set` appends its `policy-pin` under `acquireLock` + `withTxn` and lands `stateCommit(root, [journalRel(FLOOR_STREAM)], 'floor(<pin>): <note, first 60 chars>')`. It stays exempt from the floor gate in `main` (unchanged).

- [ ] **Step 1: Write the failing test:** after `repo.cli(['floor', '--set', '0.1.0', '--note', 'rollback'])` → exit 0, `repo.git('status', '--porcelain')` is `''`, and the last commit's message contains `Witness-State: 1` and `floor(0.1.0)`.
- [ ] **Step 2:** Run — FAIL (the journal line is left uncommitted).
- [ ] **Step 3:** Wrap the append as above; lock contention exits 3, a pending transaction refuses as every writer does.
- [ ] **Step 4:** Run `pnpm vitest run tests/floor*.test.ts tests/cli-floor.test.ts` — PASS.
- [ ] **Step 5:** Commit `fix(floor): --set journals under the lock and commits (#71)`.

### Task 5: `drive --detach` under `WITNESS_BIN` on Windows (#68, row 221)

**Files:**
- Modify: `src/drive.ts` — `detachDrive`
- Test: `tests/drive-detach.test.ts` (create if no detach test file exists; `grep -rln detachDrive tests`)

**Interfaces:**
- Consumes: `splitArgv(command)` (`src/drive.ts`), `resolveSpawn(cmd, args, env, platform)` (`src/spawn.ts`).
- Produces: `detachArgv(bin: string | undefined, args: readonly string[], env, platform): Result<{ file: string; args: string[]; windowsVerbatimArguments: boolean }>`, exported from `src/drive.ts`. posix with a bin: today's `/bin/sh -c 'exec <bin> "$@"'`; win32 with a bin: `splitArgv(bin)` then `resolveSpawn(argv[0], [...argv.slice(1), 'drive', ...args], env, 'win32')`; no bin: `process.execPath` + this CLI's `bin.js` (unchanged).

- [ ] **Step 1: Write the failing tests** (pure, `platform` passed in): `detachArgv('node C:\\w\\dist\\bin.js', ['--detach'], env, 'win32')` → `file` is not `/bin/sh` and the args end with `drive --detach`; `detachArgv('"C:\\Program Files\\nodejs\\node.exe" C:\\w\\bin.js', [], env, 'win32')` → the first word resolves to the quoted path (Review Focus 4); posix keeps `/bin/sh`.
- [ ] **Step 2:** Run — FAIL (`detachArgv` does not exist).
- [ ] **Step 3:** Extract `detachArgv`; `detachDrive` spawns its result with `windowsVerbatimArguments` passed through, keeping `detached: true` and `WITNESS_NO_CONSOLE`.
- [ ] **Step 4:** Run `pnpm vitest run tests/drive*.test.ts` — PASS.
- [ ] **Step 5:** Commit `fix(drive): --detach starts WITNESS_BIN without /bin/sh on Windows (#68)`.

### Task 6: The drive lock is a lease (#69, row 222)

**Files:**
- Modify: `src/drive-presence.ts` (`acquireDriveLock`, `readHolder`, `driveHolder`), `src/drive.ts` (renewal while drive runs)
- Test: `tests/live.test.ts` or the file that covers `driveHolder` (`grep -rln driveHolder tests`)

**Interfaces:**
- Produces: `DRIVE_LEASE_MS = 120_000` and `renewDriveLock(root: string, pid = process.pid): void` (sets `drive.lock`'s mtime to now when its pid is `pid`; never follows a link) in `src/drive-presence.ts`. `driveHolder(root, now = Date.now())` returns a holder only when the pid is alive **and** `now - mtimeMs < DRIVE_LEASE_MS`. `acquireDriveLock` takes over a lock whose lease expired the same way it takes over a dead pid.
- Drive calls `renewDriveLock` on every session-clock tick (the 1 s check from row 214) and on every pause poll, so a host that wakes renews within a second.

- [ ] **Step 1: Write the failing tests:** (a) a `drive.lock` naming the test process's own pid (alive) with an mtime 10 minutes old → `driveHolder(root)` is `undefined`, and `watchLine` is never reached for it (`next` prints no `watch:`); (b) the same lock renewed (`renewDriveLock(root)`) → a holder; (c) `acquireDriveLock` takes over the expired lock (Review Focus 2's other half: a fresh lease is never taken over).
- [ ] **Step 2:** Run — FAIL ((a) reports a live drive).
- [ ] **Step 3:** Implement as in Interfaces; `utimesSync` on the lock path after an `lstat` that refuses a link.
- [ ] **Step 4:** Run `pnpm vitest run tests/live*.test.ts tests/drive*.test.ts tests/wait*.test.ts` — PASS.
- [ ] **Step 5:** Commit `fix(drive): the drive lock is a lease renewed while drive runs (#69)`.

### Task 7: `adopt` refuses a moved position (#65, row 218)

**Files:**
- Modify: `src/adopt.ts` (`Witnessed`, `lastWitnessed`), `src/verbs/adopt.ts`
- Test: `tests/adopt.test.ts`

**Interfaces:**
- Produces: `Witnessed` gains `position: Record<(typeof VOLATILE_FIELDS)[number], unknown>` (the witnessed doc's `status`, `drift`, `pr`, `design`). `adopt` refuses `v('<field>', 'position-moved', '<witnessed> → <now>', 'position is written by the CLI — revert the field: git checkout <last witnessed sha> -- <rel>')` for every volatile field whose `canonicalJson` differs; a doc with no witnessed state must be `status: draft` with no `drift`, `pr` or `design`.

- [ ] **Step 1: Write the failing tests:** the issue's repro — write a ui spec (draft), hand-edit only its frontmatter to `status: live` plus a `design: {sha, spec}` stamp, commit → `adopt` exits 2 with `position-moved` on `status` and on `design`, and `check` still reports the untrailered commit. Then a hand edit that moves only `drift` (Review Focus 1) → refused too. And a body-only hand edit still adopts (exit 0).
- [ ] **Step 2:** Run — FAIL (exit 0, the forged position is absolved).
- [ ] **Step 3:** Implement; the refusal lists every moved field in one block.
- [ ] **Step 4:** Run `pnpm vitest run tests/adopt*.test.ts` — PASS, then the full suite (other tests adopt hand edits).
- [ ] **Step 5:** Commit `fix(adopt): a hand edit may not move a doc's position (#65)`.

### Task 8: Principles are reviewed like specs (#66, row 219)

**Files:**
- Modify: `src/gates/decompose.ts` (the docs it judges and stamps), `src/reviewed.ts` (`effortSpecs` or a new `effortCanon`), `src/verbs/init.ts` (born approved), `src/verbs/migrate.ts` (the template stamp), `src/journal.ts` (`StatusCause` gains `'template'`), `src/verbs/write.ts` (the `parent-not-approved` remedy for principles), `src/verbs/next.ts` (the chore rung)
- Test: `tests/gate-decompose.test.ts`, `tests/migrate.test.ts`, a new `tests/principles.test.ts`

**Interfaces:**
- Produces:
  - `effortCanon(root, canon, effort): CanonDoc[]` in `src/reviewed.ts` — the effort's written specs **and** its written principles; the decompose gate resolves, reviews and stamps (`stampsFor`) over it. `effortSpecs` stays for callers that need specs only.
  - `init` writes `principles.md` with `status: approved` (the empty template has nothing to judge).
  - `witness migrate` stamps a `draft` principles whose body equals `PRINCIPLES_BODY` (exported from `init.ts`) as `approved`, journaling `status {from: 'draft', to: 'approved', cause: 'template'}` on the `principles` stream, in the same trailer commit as the config change; `--dry-run` names it. A changed principles body is never stamped by migrate.
  - The `parent-not-approved` refusal for a principles parent names the owner: `principles are approved by the decompose gate of the effort that wrote them — run: witness gate decompose <effortOf(root, 'principles')>`, or, with no owner, `amend principles through a feature or fix effort`.
  - `next`, for a chore effort whose parent principles is draft, routes the owner's `witness gate decompose <effort>` when it has one, else prints `note: principles.md is draft and no effort owns it` with `next: witness check` — never the refused write again.

- [ ] **Step 1: Write the failing tests:** (a) the issue's repro on a fresh repo (`init` → chore recap → `next` → write the plan with parent `principles`) → the write succeeds (exit 0); (b) a feature effort that writes specs and amends principles → after its decompose passes, principles is `approved` and its stream has a `status` entry with cause `gate-approve`; (c) Review Focus 3: the same effort amends principles again after its decompose passed → principles is `draft` and `next` routes `witness gate decompose <effort>`; (d) `migrate` on a repo whose principles is the draft template → `approved`, a `template` status entry, clean tree; a repo with a changed draft body → untouched; (e) a chore with a non-template draft principles and no owner → `next` prints the note, and running `next` twice prints the same note, not the write.
- [ ] **Step 2:** Run — FAIL ((a) refused `parent-not-approved`).
- [ ] **Step 3:** Implement as in Interfaces. Comment: `// Row 219. Principles are canon like a spec: the effort that changes them has them reviewed.`
- [ ] **Step 4:** Run `pnpm vitest run tests/principles.test.ts tests/gate-decompose.test.ts tests/migrate.test.ts tests/next*.test.ts` — PASS; then the full suite (`init`'s output and fixtures that expect `principles.md (draft)` change).
- [ ] **Step 5:** Commit `fix(principles): reviewed by the decompose gate, born approved, the untouched template stamped by migrate (#66)`.

### Task 9: Rows, docs, verification

**Files:**
- Modify: `DESIGN.md` (rows 218–225), `README.md` (`migrate` and `adopt` paragraphs; the `satisfy` verb row), `docs/superpowers/specs/2026-11-02-witness-ui-design.md` (its rows renumbered 226–234)

- [ ] **Step 1:** Add rows 218–225 (one line each, the style of rows 208–217): 218 adopt refuses a moved position (#65); 219 principles reviewed like specs, born approved, the template stamped by migrate (#66); 220 trust grants under the lock (#67); 221 detach without `/bin/sh` on Windows (#68); 222 the drive lock is a lease (#69); 223 satisfy refused in a session (#70); 224 floor --set commits (#71); 225 parked gates of terminal work are owed to no one (#81). Name each amended row (adopt: 57/186; principles: 20, 166; trust: 154/205; detach: 180/201; lease: 145/180; satisfy: 173/207; floor: 116; parked: 124).
- [ ] **Step 2:** Renumber the UI design's rows 218→226 … 226→234 and its §9 references.
- [ ] **Step 3:** `pnpm run typecheck && npx biome check src tests && pnpm test` — all green; record the counts.
- [ ] **Step 4:** Two opus reviews of the branch from different angles (the fixes vs DESIGN; behaviour attack in a throwaway repo per issue's repro); re-run every finding before acting on it.
- [ ] **Step 5:** Commit `docs: rows 218-225 — the verification bugs (#65-#71, #81)`; open the PR; after merge the user runs `pnpm release patch` (0.27.1). Then `witness migrate` in fewhats stamps its untouched principles approved.
