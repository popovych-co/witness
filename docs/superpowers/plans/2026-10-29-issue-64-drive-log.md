# Issue #64 — A Running Session Shows in Drive's Log (row 214) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While `witness drive` runs a session, `.witness/drive.log` (and a foreground drive's terminal) shows:
- that the session started;
- each thing its agent does;
- each act the CLI journals for its flow;
- a `still running` line after 5 quiet minutes, naming what the session waits on;
- how the session ended.

This holds on both harnesses. Drive's pi sessions keep their transcripts in a folder of their own; Claude Code's are already kept. This is row 214, closing issue #64.

**Architecture:**
- **Streaming mode.** Drive starts every worker in its harness's event-stream mode: `pi -p --mode json --session-dir <drive's folder>` and `claude -p --output-format stream-json --verbose`.
  - A per-harness renderer, owned by the registry as `harness.worker.stream(home)` and built in `src/worker-stream.ts`, turns each event into a few short lines.
  - It also hands drive two things it never prints: every tool's output, for the merge sniff, and whether the session's last answer was an error, which row 182 needs because pi's JSON mode exits 0 on one.
- **Drive's own lines.** `spawnSession` prints `started`, `session`, `still running`, `journal:` and `ended` from the session clock's 1 s check.
  - One emitter prints every line under a session's prefix. It passes each through `logSafe`, and only the child's own lines enter the 3-line tail.
- **Windows.** The `watch:` line names PowerShell's `Get-Content -LiteralPath … -Wait`.

**Tech Stack:**
- TypeScript (ESM, NodeNext, `strict` + `noUncheckedIndexedAccess`), Node ≥ 20.
- Tests: vitest 3.2.7, the CLI in-process against throwaway git repos (`tests/helpers.ts`), and `/bin/sh` fakes standing in for harness CLIs through `WITNESS_DRIVE_AGENT_BIN`.
- No new dependencies.

**Spec:**
- [Issue #64](https://github.com/popovych-co/witness/issues/64).
- The verified evidence base below.
- The user's answers (2026-10-29):
  - "Everything" in the log; the D1 preview is the approved look.
  - Transcripts: "Keep both".
  - Where drive's pi sessions go: "Separate drive folder".
- The scope direction stands: "the most architecturally correct".

**Verification already run on this plan (2026-10-29):**
- Probes P1–P16.
- Two opus reviews: plan against code and record, and a behaviour attack. Every finding was re-checked before it was folded in.
- A mechanical dry-run of Tasks 1–5 in a throwaway worktree. RED and GREEN were seen per task, and the full gate passed with 2288 tests.
- A second dry-run of this rewrite, on top of the first. The full gate passed with 2318 tests, and its defects are folded in below.

Claims were read at `main` `36783a1` (0.26.1), or probed on this Mac with pi 0.85.1 and claude 2.1.312. Pi 1.4.0, the reporter's version, was read from its published tarball.

---

## Verified evidence base

### E1 — Root cause (read + probe)

1. **Contract vs. code.**
   - Row 145 promises "**streaming** raw, line-buffered, both pipes prefixed `[<n> <stage>/<target>]` — the child's own output is the progress report", and `src/drive.ts:128-131` says the same.
   - The worker spawns are print mode with text output: claude at `src/harness.ts:166-170`, pi at `:219-220`.
   - pi's `dist/modes/print-mode.js` (identical in 0.85.1 and 1.4.0 except for 1.4.0's `length` exit) writes only the last assistant message's text, after `session.prompt` returns. Its JSON mode writes every event as it happens.
   - `claude -p` in text mode prints only the result.
2. **No start line.** `launch` (`src/drive.ts:564-583`) and `spawnSession` (`:164-285`) print only child lines, `host slept …` and a spawn failure.
3. **The suite encodes the wrong assumption.** Every drive fake echoes plain lines as it goes, and `WITNESS_DRIVE_AGENT_BIN` swaps only the binary (`src/drive.ts:184`).

### E2 — The merge sniff reads the same stream (read)

- **What drive looks for.** `launch` sets a flow aside as the human's merge when a child line matches `MERGE_LINE` (`src/drive.ts:349`). The line comes from `mergeOwnPr` (`src/ship.ts:207`, `:244`, `:506`), printed through `kv`.
- **The real line is quoted.** Its value has a comma, so toon quotes it: `ship: "merge PR #7 on GitHub when ready — the lazy stamp flips plan → done, spec → live"`.
- **Print mode hides it.** The line reaches drive only if the agent quotes it in its final message, and the ship skill says only "tell the human the PR is ready to merge" (`plugin/skills/witness-ship/SKILL.md:48`).
- **The fakes hide that.** They echo the line raw (`tests/drive-pause.test.ts:225`, `tests/drive.test.ts:1189`).

### E3 — Row 182's limit check reads the same stream (read)

`sessionLimit` (`src/usage.ts:130-138`) reads the last 3 non-empty child lines. It counts a transient shape only on a non-zero exit. `limited` (`src/drive.ts:609-616`) asks it about timed-out sessions too.

### E4 — Probes

| Probe | What ran | Result |
|---|---|---|
| P1 | pi 0.85.1, `--mode json --no-session`, one `ls` + one read | Records: `session` header `{id, cwd}`; `tool_execution_start {toolCallId, toolName, args}`; `tool_execution_end {result.content[].text, isError}`; `message_start` / `message_end {message: {role, content[], stopReason, errorMessage?}}`; `message_update` deltas; `turn_end`; `agent_end {messages: whole conversation}`; `agent_settled`. |
| P2 | the same, unknown model, stdin `/dev/null` | The error appears only in the stream (`stopReason: "error"`, `errorMessage: "404 {…}"`), and the process **exits 0**. Text mode writes `errorMessage` to stderr and exits 1. |
| P3 | claude 2.1.312 `-p --output-format stream-json --verbose`, `Bash(ls)` + `Read` | Records: `system:init {session_id}`; `assistant`, one content block (`thinking` \| `tool_use {id, name, input}` \| `text`) per record; `user {tool_result {tool_use_id, content, is_error?}}`; `rate_limit_event`; `system:hook_*`; `result {is_error, result}`. With an unknown model: a synthetic assistant text plus `result {is_error: true}`, exit 1. |
| P4 | pi 1.4.0 `docs/json.md` + `print-mode.js` against 0.85.1 | Same event model. Adds `auto_retry_start` / `_end`, `compaction_start` / `_end` and `durationMs`. Stdout is JSONL only, split on LF only. A reader that stops reading stalls pi. |
| P5 | after P3 | `claude -p` saved the session in `~/.claude/projects/<cwd>/`. The Pi add-on keys on the in-memory session id (`plugin/hooks/witness-pi.ts:95-189`). |
| P6 | P2 with an open stdin pipe | pi waited on stdin. Drive's `stdin: 'ignore'` (`src/drive.ts:224`) avoids this. |
| P7 | pi 0.85.1 **without** `--no-session` | The session was saved to `~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl`, the header's id. Nothing appeared in the working directory. In 1.4.0 a `sessionDir` setting may be relative to the working directory. |
| P8 | pi `agent-session.js:2299`; the claude binary | pi: `auto_retry_start {attempt, maxAttempts, errorMessage}`. claude: `system:compact_boundary`, and `system:api_retry {attempt, max_retries, error_status (may be null), error}`. claude `result` subtypes `error_during_execution` / `error_max_*` carry `errors[]` and no `result`. |
| P9 | pi `bash.js:263-264`; claude `Bash(false)` | Both mark **every** non-zero exit as a tool error. pi: "Command exited with code N". claude: `is_error: true`, `"Exit code 1"`. |
| P10 | claude `-p '/probe'` in stream-json, a custom command | The slash command expands, and no `user` record carries the prompt. |
| P11 | the same plus `--dangerously-skip-permissions` (run by the user) | Accepted: `"result":"probe-ok"`. |
| P12 | claude, a command that runs past the Bash limit | The command ran in the background:<br>• `system:task_started {task_id, tool_use_id}` arrived **before** the tool_result ("Command running in background…").<br>• A **first** `result` came, then the process kept running.<br>• `system:task_notification {tool_use_id, status, output_file, summary}` followed; the summary is only a status sentence.<br>• A second `system:init` came with the **same** `session_id`.<br>• The agent `Read` the output file, line-numbered (`1\tprobe-line-merge .`).<br>• A second `result`, then exit 0. |
| P13 | claude `printenv CLAUDE_CODE_SESSION_ID`; pi `bash.js:126-145` | claude's tool commands see the same id as `init.session_id`. pi sets `PI_SESSION_ID = getSessionId()`, default on. Journal entries carry `ctx.session = sessionHash(id)` (`src/context.ts:29`, `:70-76`). |
| P14 | pi 0.85.1 `--session-dir <dir>` | Flat layout `<dir>/<ts>_<id>.jsonl`. `PI_CODING_AGENT_DIR` moves pi's agent dir (default `~/.pi/agent`). The CLI flag outranks the `sessionDir` setting. |
| P15 | 203 real fewhats pi transcripts | 91% of 12,199 bash calls start with `cd …`; the real shape is `cd <worktree> && WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@…}"; $WITNESS start <plan> 2>&1; echo "exit: $?"`. Cut at 160 characters, most witness calls lose their verb. The 203 transcripts total 150 MB, 0.74 MB on average. |
| P16 | a 'data' listener that throws (Node 24) | The parent exits 1 and the detached child keeps running. `src/` has no `uncaughtException` handler. |
| P17 | the second dry-run | Its findings:<br>• A tool named `constructor` or `__proto__` crashed a lookup in a plain object of verbs.<br>• pi sends the assistant's `message_start` only once the provider starts streaming, after `turn_start` (pi-agent-core `agent-loop.js:50`, `:109`, `:201-205`).<br>• claude sends `task_started` for every task it registers (`is_backgrounded`, `task_type`), not only backgrounded Bash.<br>• An empty `HOME` made the pi folder relative, i.e. inside the worktree.<br>• `routed` (`src/drive.ts:652`, `:674`) is never cleared within a run.<br>• `entryDetail` throws on hand-edited entries (a `gate-run` without `reviewed_sha`). |

### E5 — Design decisions

- **D1 (user: "Everything").** The approved look, exact copy:

  ```
  [3 implement/discovery-plan-1] started 08:48:09 · next: witness start discovery-plan-1
  [3 implement/discovery-plan-1] $ witness start discovery-plan-1
  [3 implement/discovery-plan-1] read plans/discovery-plan-1.md
  [3 implement/discovery-plan-1] edit src-tauri/src/discovery/scan.rs
  [3 implement/discovery-plan-1] journal: step-close step=s1
  [3 implement/discovery-plan-1] $ cargo test discovery
  [3 implement/discovery-plan-1] journal: test-evidence phase=red step=s2 tests=4 failed=4
  [3 implement/discovery-plan-1] still running · 47m of 2h · quiet 5m · in: $ cargo test discovery
  [3 implement/discovery-plan-1] Steps s1-s2 done; s3 next.
  [3 implement/discovery-plan-1] ended 09:41:02 · exit 0 · 53m
  ```

- **D2 (user: "Keep both", then "Separate drive folder").**
  - **pi.** The worker drops `--no-session` and runs with `--session-dir <agentDir>/sessions/witness-drive/<name>`.
    - `<agentDir>` is `PI_CODING_AGENT_DIR`, else `<home>/.pi/agent`, where `<home>` is `HOME`, else `USERPROFILE`, else `os.homedir()`. An empty value counts as unset. The folder is always absolute; a relative one would resolve inside the worktree (P17).
    - `<name>` is the repo root's basename with any character outside `[\w.-]` turned into `-`, then `-` and the first 8 hex of sha1(root).
    - So `pi -c` and `pi -r` in the repo stay the human's.
    - The flag outranks any `sessionDir` setting, so a transcript never lands in a worktree, where ship's `git add -A` (`src/ship.ts:280`, `:465`) would commit it.
  - **claude.** It keeps its own store, because it has no such flag (P5). Drive passes no `--name` / `--session-id`: those flags exist only in newer CLIs.
  - **The `session` line.** Drive prints `session <id>` the first time the stream names an id, or when the id changes. For pi it appends ` · <folder>`.
- **D3 — The renderer lives with the harness.**
  - `worker.stream(home)` sits beside `worker.spawn` (`src/harness.ts:52-57`: one home for "how this harness runs headless"), and `worker.transcripts(env, root)` (pi only) names D2's folder.
  - Parsers go in `src/worker-stream.ts`. Drive never imports a per-harness parser.
- **D4 — What renders.** A renderer **never throws**: every field is type-checked before use.

  | Input | Rendered line(s) |
  |---|---|
  | A tool call (pi `tool_execution_start`, claude `tool_use`) | One action line (`actionLine`), built in this order: (1) a shell tool's command is passed through `shellCommand`, which strips a leading preamble and shows `$WITNESS` as `witness` (P15); (2) only the first line is kept, with ` …` when there were more; (3) a path **argument** under the session home is made relative, comparing on `/` and, for a drive-letter home, without case (paths inside a shell command are left alone); (4) `logSafe`; (5) the result is cut to `ACTION_MAX = 160` code points, ending `…`. Verbs: `$` (bash, powershell), `read`, `edit` (edit, multiedit, notebookedit), `write`, `grep`, `find` (find, glob), `ls`. They are looked up by **own key** (P17). Any other tool shows `<tool> <first string arg>`. An action line means *attempted*: a call a guard refused prints the same. |
  | Assistant text | As written, one line per non-blank line. |
  | A tool's result, error or not | Nothing printed. Its lines are `heard`, `logSafe`'d. P9 makes a `failed` line noise on every red run. claude `Read` results lose their `^\s*\d+\t` prefix first (P12). |
  | A retry | pi `auto_retry_start`: `retrying · attempt <a>/<m> · <first line of errorMessage>`. claude `system:api_retry`: `retrying · attempt <a>/<m> · <error_status> <error>`, a null status left out. |
  | Compaction (pi `compaction_start`, claude `system:compact_boundary`) | `compacting context`. |
  | A pi assistant turn that ended `error` / `aborted` | Its `errorMessage` lines, else `Request <reason>`. |
  | A claude `result` | A `result` whose `result` is a string: its lines, when they differ from the last text shown. A `result` with no `result` string, on `is_error`: each `errors[]` string, else its `subtype`. There may be several `result` records (P12). |
  | A claude backgrounded call | `task_started {tool_use_id, is_backgrounded: true}` keeps that call open past its tool_result. `task_notification {tool_use_id}`, or a `task_updated` whose `patch.status` is `completed`, `failed` or `killed`, closes it. A `task_started` without `is_backgrounded` changes nothing (P17). None of these prints. |
  | A record that is not a JSON object, and every stderr line | Passes through `passthrough`: `logSafe`, then capped at `PASSTHROUGH_MAX = 400` code points of the spelled text, plus ` … (<n> characters)`, where `n` counts the spelled text's code points. |

  Nothing else prints: thinking, deltas, `turn_end`, `agent_end`, hooks, `rate_limit_event`, `task_*`, user prompts (string content included), unknown types.
- **D5 — Failed.**
  - pi: the session failed when its last assistant message ended `error` / `aborted`. A later successful message clears it.
  - claude: the session failed when its last `result` had `is_error` set.
  - Row 182 then counts a transient shape when the session failed, or on a non-zero exit of a session that did not time out. A timed-out session whose tail still shows a retried 529 is no limit.
- **D6 — The merge sniff hears what the CLI printed.** `spawnSession` hands every shown, heard and stderr line, `logSafe`'d and unprefixed, to `opts.hear`. F10's guards stay as they are.
- **D7 — One emitter, and the tail stays the child's.**
  - Every line printed under a session's prefix passes `logSafe` in one place.
  - Drive's own lines never enter the tail: `started`, `session`, `still running`, `journal:`, `ended`, `host slept`.
- **D8 — The quiet line.**
  - `SESSION_QUIET_MS = 300_000`, measured on awake time.
  - It prints after 5 printed-nothing minutes, then after each further 5.
  - `quiet` shows `duration(n × SESSION_QUIET_MS)`, never the measured time, which drifts with check lateness.
  - It names `inFlight()`: the oldest open call (backgrounded claude calls included), else `the model`.
    - pi: "awaiting the model" lasts from `turn_start` until the assistant's `message_end` (P17).
    - claude: it lasts from `init` or a tool_result until a record carrying `tool_use`, or a `result`.
  - "Quiet" means nothing printed under the session's prefix. Every line counts, `host slept` included, except the quiet line itself. No clamp is needed: a sleep is reported through the emitter by the same check.
  - `sessionClock` re-arms **before** calling `tick`. Drive's tick handler, and the final `progress` poll in `settle`, catch everything (P16).
- **D9 — Journal lines.** `journalWatch(root, target)` owns its selection.
  - **The flow.** It is the target plus its family (row 181 F2: a spec and the plans written for it), from `flowOf(canon, t)`. It is re-derived from a fresh `loadCanon` whenever the effort stream changes, so a plan written mid-session joins.
  - **What it reads.** Each flow member's own stream, and the effort's entries whose `artifact` is in the flow.
  - **Positions.** Tracked per stream on the unfiltered entries; the filter applies only at render. A member that joins later starts at 0.
  - **Baseline.** Taken at creation; if that read fails, at the first readable check.
  - **Reading.** The size+mtime gate is taken before the read. It never throws: a parse failure is read again next check, a stream that shrank re-baselines, and each entry is rendered under its own guard, so an entry whose rendering throws is skipped (P17). While the target's effort is unknown (an adopted spec), it is looked up again whenever a watched stream changes.
  - **What prints.** `movesFlow` entries (row 206) as `journal: <t> <entryDetail>`. Once the session id is known, an entry whose `ctx.session` differs from `sessionHash(id)` or is absent gets ` · not this session` (P13).
  - **Scope.** Target-less lanes print none. `progressKey` stays as it is.
- **D10 — `logSafe`.** It spells out `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]` in `visible()`'s spelling: ESC, CR, TAB, bidi overrides, zero-width characters, and U+2028/U+2029, which editors render as line breaks. Printable text in any script stays.
- **D11 — `lineSink`.** One record per LF, a trailing CR stripped. A chunk without LF is only appended; today `buf.split` runs on every chunk, which is quadratic.
- **D12 — The Windows watch line.**
  - The line: `Get-Content -LiteralPath <p> -Wait -Tail 50 -Encoding UTF8 · stop it: taskkill /PID <pid> /T /F`.
  - `-LiteralPath` because `-Path` treats `[ ]` as wildcards. `-Encoding UTF8` because Windows PowerShell 5.1 reads BOM-less files as ANSI.
  - `psArg` leaves a path bare only when it matches `/^[\w%+=:./\\][\w%+=:./\\-]*$/`. A bare `,` would build an array, a leading `@` splats, and a leading `-` binds as a parameter. Otherwise it single-quotes the path, doubling each of `'‘’‚‛`.
- **D13 — The `started` line** names the line the session will take. When this fill turned a decision into a spawn for a settle-routed re-run (`src/drive.ts:833-836`), that is the re-run; otherwise it is `action.line`. `routed` is never cleared within a run (P17), so looking it up for every spawn would mislabel later ones.
- **D14 — Release.** Patch 0.26.2, run by the human with `pnpm release patch`.

**Rejected:**
- **R1 — `.witness/sessions` in the repo.** It needs a local-state folder excluded three ways and only works for pi. D2's folder sits outside the repo.
- **R2 — Journal lines without the event stream.** The merge sniff and `in:` need the stream.
- **R3 — Children writing drive.log themselves.**
- **R4 — `rate_limit_event` as a limit detector.**
- **R5 — A `failed`/`refused` line for tool errors.** P9 makes it noise, and telling a guard's block from an exit code means matching error text.

### E6 — Recorded, not fixed (Task 6 → DESIGN "Open / deferred")

- **Schema drift.** A harness release that changes event shapes makes the log quieter, never a crash (D4 never throws, D8 catches). `started`, `still running`, `journal:` and `ended` remain.
- **Secrets.** Action lines show commands an agent typed, into a gitignored local log — the same exposure as each harness's own transcript.
- **Log growth.** drive.log has no rotation. It grows on the order of 30 KB per implement session.
- **`claude -c`.** In the repo root it can open drive's last claude session, as it already does today; claude has no session-folder flag.
- **`rate_limit_event`** is unused.
- **`witness log`** prints decision notes raw (`src/verbs/log.ts:44`). This predates the plan; drive's `journal:` lines are spelled at the emitter.
- **The log and the stuck verdict can disagree.** `journalWatch` reads every flow member's stream; row 181's progress key counts only the target's stream plus the effort's entries. So a spec-keyed session that only re-gates an existing plan prints `journal: gate-run …`, yet drive still reports `no progress`.

### E7 — What only a live run shows

Task 7 Step 5 (HUMAN, Windows, pi 1.4.0) checks four things:
- the real harness streams;
- the pi session lands in D2's folder;
- the `watch:` line runs in PowerShell;
- `·` reads correctly.

---

## Global Constraints

- Node ≥ 20. TypeScript ESM, `strict` + `noUncheckedIndexedAccess`. `npx biome check src tests` clean, though its linter is off. No new dependencies.
- No new config key: `SESSION_QUIET_MS`, `ACTION_MAX` and `PASSTHROUGH_MAX` are constants, and `witness migrate` is untouched.
- `src/spawn.ts` stays the only `node:child_process` importer (row 201). Session-variable names stay in `src/harness.ts` (`tests/harness.test.ts:338`).
- Drive journals nothing (row 145). `journalWatch` only reads.
- Exact copy (D1; times local `HH:MM:SS`, durations from `duration()` in `src/usage.ts`):
  - `started <HH:MM:SS> · next: <line>`
  - `session <id>[ · <folder>]`
  - `still running · <awake> of <limit> · quiet <n×5m>[ · in: <what>]`
  - `journal: <t> <detail>[ · not this session]`
  - `ended <HH:MM:SS> · <exit N[ (error)] | killed | timed out | stopped> · <awake>`
  - `retrying · attempt <a>/<m> · <reason>`
  - `compacting context`
- Code comments cite "row 214". The plan's D-labels are local to this plan; DESIGN uses `D<n>` for rows.
- Fakes live in `fakeScenario()` dirs. No test holds its worker's event loop for 60 s or more (row 213).
- Every new test's title ends with `(issue #64)`, so `-t "issue #64"` selects them all.
- Never modify a consumer repo. Reviewer subagents run on model `opus`.

## Review Focus

1. **A known event with a changed field type** (a null `toolName`, string `content`, `message: null`, a `result` with no `result`) must not throw, and drive must not crash (P16). → Task 1 (never-throws tests) and Task 2 (`stream.line` guard).
2. **Real command shapes** (`cd … && WITNESS=…; $WITNESS gate …`) must still show the verb. → Task 1 (`shellCommand` cases from P15).
3. **A record of several megabytes** must not slow drive. → Task 2 (`lineSink`, 8 MiB in 64 KiB chunks under 1 s).
4. **Agent- or repo-controlled text carrying ESC, OSC 52, bidi or U+2028** is spelled out, never painted. → Task 1 (`logSafe`, prose, `errorMessage`), Task 2 (stderr) and Task 4 (a decision note).
5. **A journal stream read mid-append** must not throw, and the entry shows once its line completes. → Task 4.

## File Structure

| File | Change |
|---|---|
| `src/worker-stream.ts` | **Create.** `WorkerLine`, `WorkerStream`, `ACTION_MAX`, `PASSTHROUGH_MAX`, `shellCommand`, `actionLine`, `piStream`, `claudeStream` |
| `src/toon.ts` | `logSafe` beside `visible` (`:9-14`); `psArg` beside `shellArg` (`:3`) |
| `src/harness.ts` | Worker interface (`:52-60`), claude worker (`:160-171`), pi worker and its comment (`:213-221`) |
| `src/drive.ts` | `SessionEnd` (`:97-100`), `lineSink` (`:128-145`), `spawnSession` (`:164-285`), `STREAM_PREFIX` removed (`:347`), `family` → `flowOf` (`:437-445`), `launch` (`:564-583`), new `journalWatch` and `SESSION_QUIET_MS` |
| `src/usage.ts` | `sessionLimit` (`:130-138`) |
| `src/session-clock.ts` | `check` (`:48-54`), the `on` type |
| `src/verbs/log.ts` | `detail` (`:15-67`) exported as `entryDetail`; uses at `:134`, `:146`, `:157` |
| `src/drive-presence.ts` | `watchLine` (`:109-114`) |
| `tests/worker-stream.test.ts` | **Create** |
| `tests/drive.test.ts`, `tests/drive-pause.test.ts`, `tests/harness.test.ts`, `tests/usage.test.ts`, `tests/session-clock.test.ts` | Tests below |
| `DESIGN.md`, `README.md` | Row 214, markers, Open / deferred, `README.md:296` |

---

### Task 0: Branch, and commit this plan

- [ ] **Step 1**

```bash
git switch -c issue-64-drive-log main
git add docs/superpowers/plans/2026-10-29-issue-64-drive-log.md
git commit -m "docs: plan for issue #64 — a running session shows in drive's log (row 214)"
```

---

### Task 1: The renderers

**Files:**
- Create: `src/worker-stream.ts`
- Modify: `src/toon.ts:9-14`
- Test: `tests/worker-stream.test.ts`

**Interfaces:**
- Consumes: `visible`'s spelling (`src/toon.ts:12-14`), factored into one `spell(c)`.
- Produces:

```ts
// src/toon.ts
export const logSafe: (s: string) => string     // D10
// src/worker-stream.ts
export type WorkerLine =
  | { kind: 'show'; text: string }      // printed under the session's prefix
  | { kind: 'heard'; text: string }     // a line of a tool's output, logSafe'd: drive reads it, never prints it
  | { kind: 'session'; id: string }     // emitted when the stream first names an id, or names a new one
export interface WorkerStream {
  line(record: string): WorkerLine[]    // one stdout record, LF and trailing CR gone; never throws (D4)
  inFlight(): string | undefined        // D8
  failed(): boolean                     // D5
}
export const ACTION_MAX = 160
export const PASSTHROUGH_MAX = 400
export function passthrough(record: string): string   // logSafe, then the PASSTHROUGH_MAX cap (D4)
export function shellCommand(command: string): string
export function actionLine(tool: string, args: unknown, home: string): string
export function piStream(home: string): WorkerStream
export function claudeStream(home: string): WorkerStream
```

- [ ] **Step 1: Write the failing tests** in `tests/worker-stream.test.ts`. Every title ends `(issue #64)`. Records come from `JSON.stringify` in the shapes of P1, P3, P8 and P12.

```ts
it('logSafe spells out control, format and separator characters (issue #64)', () => {
  expect(logSafe('a\x1b[2Jb\tc\u202ed\u2028e · → é')).toBe('a\\x1b[2Jb\\tc\\u{202e}d\\u{2028}e · → é')
})

it.each([
  ['cd /r/.witness/worktrees/p1 && WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.26.1}"; $WITNESS start p1 2>&1; echo "exit: $?"',
    'witness start p1 2>&1; echo "exit: $?"'],
  ['cd /r/.witness/worktrees/p1 && WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.26.1}" && "$WITNESS" gate implement p1',
    'witness gate implement p1'],
  ['WITNESS=x\n$WITNESS next', 'witness next'],
  ['export FOO="a;b"; set -e; npm test', 'npm test'],
  ['set -euo pipefail; npm test', 'npm test'],
  ['cd /r &&\n  cargo test', 'cargo test'],                 // an empty segment counts as setup
  ['cd /r && cargo test discovery', 'cargo test discovery'],
  ['cd /r', 'cd /r'],
])('shellCommand %j (issue #64)', (raw, want) => expect(shellCommand(raw)).toBe(want))

it.each([
  ['bash', { command: 'cd /r && cargo test discovery\n--nocapture' }, '$ cargo test discovery …'],
  ['powershell', { command: 'Get-ChildItem' }, '$ Get-ChildItem'],
  ['Read', { file_path: '/r/src/a.rs' }, 'read src/a.rs'],
  ['Read', { file_path: 'C:\\R\\src\\a.rs' }, 'read src/a.rs'],          // home 'c:/r' below
  ['edit', { path: 'src/b.rs' }, 'edit src/b.rs'],
  ['Write', { file_path: '/elsewhere/c.md' }, 'write /elsewhere/c.md'],
  ['Grep', { pattern: 'fn main' }, 'grep fn main'],
  ['Glob', { pattern: '**/*.rs' }, 'find **/*.rs'],
  ['Task', { description: 'review the diff', prompt: 'x' }, 'Task review the diff'],
  ['TodoWrite', { todos: [] }, 'TodoWrite'],
  ['bash', { command: 'echo \x1b]0;pwned\x07' }, '$ echo \\x1b]0;pwned\\x07'],
])('actionLine %s %j (issue #64)', (tool, args, want) =>
  expect(actionLine(tool, args, String((args as { file_path?: string }).file_path).startsWith('C:') ? 'c:/r' : '/r')).toBe(want))

it('an action line is at most ACTION_MAX code points (issue #64)', () => {
  const a = actionLine('bash', { command: '😀'.repeat(400) }, '/r')
  expect([...a]).toHaveLength(ACTION_MAX)
  expect(a.endsWith('…')).toBe(true)
})
```

`piStream('/r')`, one `it` per behaviour:
- `session` `{id:'S1'}` → `[{kind:'session', id:'S1'}]`.
- `tool_execution_start` (bash `ls`, `c1`) → `show '$ ls'`; `inFlight()` is `'$ ls'`.
- `tool_execution_end` (`c1`, text `'a\nship: "merge PR #7 on GitHub when ready — x"'`) → two `heard` lines and no `show`; `inFlight()` is `undefined`.
- An `isError` end with text `'boom\nCommand exited with code 1'` → only `heard` lines (P9).
- `message_start` (assistant): `inFlight()` is `'the model'`. Then `message_end` (assistant, `[text 'Done.\n\nNext.', toolCall]`) → `show 'Done.'`, `show 'Next.'`.
- **RF4:** `message_end` (assistant, text `'x\x1b[2Jy'`) → `show 'x\\x1b[2Jy'`.
- **D5 and RF4:** `message_end` (assistant, `stopReason:'error'`, `errorMessage:'529 {"type":"error","error":{"type":"overloaded_error","message":"\x1b]52;c;x\x07"}}'`) → shows it spelled, and `failed()` is `true`. Then a `message_end` with `stopReason:'stop'` → `failed()` is `false`.
- `stopReason:'aborted'` with no message → `show 'Request aborted'`.
- `auto_retry_start {attempt:1, maxAttempts:3, errorMessage:'529 overloaded'}` → `show 'retrying · attempt 1/3 · 529 overloaded'`.
- `compaction_start` → `show 'compacting context'`.
- `message_update`, `turn_end`, `agent_end`, `agent_settled`, user/toolResult `message_end`, and `{"type":"brand_new"}` → `[]`.
- `turn_start` → `[]`, and `inFlight()` is `'the model'` (D8).
- **RF1:** `{"type":"tool_execution_start","toolName":null,"args":null}`, `{"type":"message_end","message":null}`, a `message_end` whose `content` is a string, and tool names `'constructor'` and `'__proto__'` (with `args {x:'y'}`) → each returns an array and never throws. The last two show `'constructor y'` and `'__proto__ y'` (P17).
- `'Warning: x'` → `show` as written. `'x'.repeat(1000)` → `show` of 400 code points + `' … (1000 characters)'`. `'[1,2]'` → `show '[1,2]'`.

`claudeStream('/r')`, one `it` per behaviour:
- `init {session_id:'S2'}` → `session S2`, and `inFlight()` is `'the model'`. A second `init` with the same id → `[]`.
- `assistant` (`tool_use t1 Bash {command:'ls'}`) → `show '$ ls'`.
- `user` (`tool_result t1 'a\nb'`) → `heard 'a'`, `heard 'b'`; `inFlight()` is `'the model'`.
- `assistant` (`thinking`) → `inFlight()` is still `'the model'`. `assistant` (`text 'Done.'`) → `show 'Done.'`, `inFlight()` still `'the model'`. `result` → `inFlight()` is `undefined`.
- **P12 background:** `assistant` (`tool_use t3 Bash {command:'$WITNESS ship p1'}`), then `system:task_started {tool_use_id:'t3', is_backgrounded:true}`, then `user` (`tool_result t3 'Command running in background…'`) → `inFlight()` is `'$ witness ship p1'`. Then `system:task_notification {tool_use_id:'t3', status:'completed'}` → `[]`, and `inFlight()` is no longer that call.
- **P17:** a `task_started` for `t5` with no `is_backgrounded` leaves `t5` to close at its tool_result. A backgrounded `t6` is closed by `system:task_updated {task_id, patch:{status:'killed'}}`, matched through its `task_started`'s `task_id`.
- `assistant` (`tool_use t4 Read {file_path:'/r/o.txt'}`), then `user` (`tool_result t4 '1\tship: "merge PR #7 on GitHub when ready — x"\n2\t'`) → `heard 'ship: "merge PR #7 on GitHub when ready — x"'`.
- `result {is_error:false, result:'Done.'}` after `'Done.'` was shown → `[]`. A second `result {is_error:false, result:'Later.'}` → `show 'Later.'`.
- `result {is_error:true, result:'Claude AI usage limit reached|1793313000'}` → shows it, and `failed()` is `true`.
- `result {is_error:true, subtype:'error_during_execution', errors:['boom']}` → `show 'boom'`.
- `result {is_error:true, subtype:'success', result:<the text shown just before>}` → `[]`. Its `subtype` is never printed when a `result` string is present.
- `system:api_retry {attempt:1, max_retries:10, error_status:null, error:'connection'}` → `show 'retrying · attempt 1/10 · connection'`.
- `system:compact_boundary` → `show 'compacting context'`.
- `rate_limit_event`, `system:hook_started`, `system:task_updated`, and a `user` with string content → `[]`.
- **RF1:** `assistant` records whose `message.content` is `{}`, `5` or `"x"`, and `{"type":"result"}` → `[]`, never throw. The `{}` and `5` cases are the ones a naive loop throws on (P17).

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/worker-stream.test.ts`
Expected: FAIL — `Cannot find module '../src/worker-stream.js'`.

- [ ] **Step 3: Implement**

- **`logSafe`.** Per D10.
- **`shellCommand`.**
  - Scan left to right, tracking `'…'`, `"…"`, `$(…)` and `${…}`. A segment ends at an unquoted, depth-0 `&&`, `;` or newline.
  - While the leading segment is empty, or matches `cd <word>`, `[export ]NAME=<value>` or `set -<flags>[ <words>]` (as in `set -euo pipefail`), drop it together with its separator.
  - If nothing remains, return the original.
  - Then replace each `"${WITNESS}"`, `"$WITNESS"`, `${WITNESS}` and `$WITNESS` with `witness`.
- **`actionLine`.** Per D4's order.
- **Streams.** State per D4, D5 and D8. Every field is type-guarded, and verbs are looked up by own key (`Object.hasOwn`, or a `Map`).

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run tests/worker-stream.test.ts tests/toon.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker-stream.ts src/toon.ts tests/worker-stream.test.ts
git commit -m "feat(drive): render each harness's event stream as short lines (row 214)"
```

---

### Task 2: Drive runs its workers in streaming mode and reads them

**Files:**
- Modify: `src/harness.ts:52-60`, `:160-171`, `:213-221`
- Modify: `src/drive.ts:97-100`, `:128-145`, `:164-285`, `:347`, `:564-583`, `:640-643`
- Modify: `src/usage.ts:130-138`
- Test:
  - `tests/harness.test.ts:280-299`
  - `tests/drive.test.ts`: argv test `:253`; echo test `:249`; `spawnSession` describe `:153`; merge-sniff describe `:1176`; B4 describe `:783`
  - `tests/usage.test.ts:42-47`

**Interfaces:**
- Consumes: Task 1.
- Produces:

```ts
// src/harness.ts — Harness['worker']
worker: {
  spawn(prompt: string, model?: string, transcripts?: string): HarnessSpawn   // pi adds --session-dir <transcripts>
  stream(home: string): WorkerStream
  transcripts?(env: Record<string, string | undefined>, root: string): string // pi only, D2
}
// src/drive.ts
export interface SessionEnd { outcome: SpawnOutcome; code: number | null; tail: string[]; ms: number; failed: boolean }
export function lineSink(emit: (record: string) => void): { push(chunk: string): void; flush(): void }
spawnSession(step, cfg, ctx, spawnN, opts?: { manual?; signal?; ticker?; hear?: (line: string) => void; root?: string
  stream?: WorkerStream })   // test seam on `ticker`'s precedent: replaces the harness's renderer
// src/usage.ts
sessionLimit(end: { code: number | null; tail: readonly string[]; failed?: boolean; outcome?: string }, now: number)
```

Test helpers in `tests/drive.test.ts`:

```ts
// One record as a /bin/sh line: what a harness in its streaming mode writes.
const say = (event: object): string => `printf '%s\\n' '${JSON.stringify(event).replaceAll("'", "'\\''")}'`
// Wait (at most 10 s) for the test to see a line; exit 3 if it never does.
const awaitFlag = (flag: string): string =>
  `i=0; while [ ! -f "${flag}" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; [ -f "${flag}" ] || exit 3`
const MERGE = 'ship: "merge PR #7 on GitHub when ready — the lazy stamp flips plan → done, spec → live"'   // E2's real shape
```

- [ ] **Step 1: Write the failing tests**

1. **`tests/harness.test.ts` worker contract.**
   - claude: `['-p','IMPLEMENT THIS','--output-format','stream-json','--verbose','--dangerously-skip-permissions']`.
   - pi: `['-p','IMPLEMENT THIS','--mode','json']`, and with `spawn('IMPLEMENT THIS', undefined, '/s')` → `[…, '--session-dir', '/s']`.
   - Retitle the pi test "with a transcript folder and no bypass flag", and assert `not.toContain('--no-session')`.
   - `transcripts({ HOME: '/h' }, '/r/fewhats.com')` matches `/^\/h\/\.pi\/agent\/sessions\/witness-drive\/fewhats\.com-[0-9a-f]{8}$/`.
   - With `PI_CODING_AGENT_DIR: '/a'`, it starts `/a/sessions/witness-drive/`.
   - With `{ HOME: '', USERPROFILE: '' }`, `isAbsolute(…)` is `true` and it starts with `os.homedir()` (P17).
2. **`tests/drive.test.ts` argv test `:253`.** The same argv, plus pinned `'--model'`. **Echo test `:249`:** `args=-p /witness --mode json pi=unset claude=unset`.
3. **`renders the worker's events as they arrive (issue #64)`.**
   - Setup: `patchConfig(repo, { harness: 'pi' })`.
   - Fake: `say` a bash start for `witness start p1`; then `awaitFlag`; then `say` a `message_end` with text `Done.`.
   - The test's `out` writes the flag on `'[1 implement/p1] $ witness start p1'`.
   - Expect: `end.code === 0`, `'[1 implement/p1] Done.'`, and no line containing `'"type":'`.
4. **`prints the session id once, outside the tail (issue #64)`.**
   - Setup: harness pi, a ctx env with `HOME: '/h'`, and `{ root: repo.root }` passed.
   - Fake: two identical `session {id:'S-1'}` headers, then `echo hi`.
   - Expect exactly one line matching `` /^\[1 implement\/p1\] session S-1 · \/h\/\.pi\/agent\/sessions\/witness-drive\// ``, and `end.tail` equal to `['hi']`.
5. **`the CLI's merge line inside a tool's output sets the flow aside (issue #64)`.**
   - Setup: `startedFlows(['a'], { shipping: 'a' })`, then `patchConfig(repo, { harness: 'pi' })`.
   - Fake: `say` a `tool_execution_end` carrying `MERGE`.
   - Expect: `'wait: merge · a-plan-1 · PR #7'` and `'  run: gh pr merge 7'`, and no line matching `/^\[\d+ [^\]]*\] ship: /`.
6. **`a pi provider error at exit 0 is waited out (row 182, issue #64)`.**
   - Setup: in the B4 describe, `planReady()`, then `patchConfig(repo, { harness: 'pi' })` **before** `autonomyOn(repo)`.
   - Fake: on its first run, `say` an error `message_end` (`529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`) and `exit 0`; on the second run, `exec witness start …`.
   - Expect: `` `drive: usage limit — waiting 1m · ${body}` ``.
7. **`tests/usage.test.ts`.**
   - `{code:0, failed:true, tail:['Request timed out.']}` → `'transient'`.
   - `{code:0, failed:false, …}` → `undefined`.
   - `{outcome:'timeout', code:143, failed:false, tail:['529 {"type":"error","error":{"type":"overloaded_error"}}', 'retrying · attempt 1/3 · 529', '$ cargo test']}` → `undefined`.
8. **`lineSink takes one long record in linear time (issue #64)`.** 128 × `'x'.repeat(65_536)`, then `'\r\nnext\n'`. Expect under 1000 ms, and records of lengths `[8_388_608, 4]`.
9. **`spells out the control characters a child writes (issue #64)`.** Fake `printf 'a\033[2Jb\n' >&2` → `'[1 implement/p1] a\\x1b[2Jb'`.
10. **RF1: `a renderer that throws never takes drive down (issue #64)`.**
    - Pass `{ stream: { line: () => { throw new Error('boom') }, inFlight: () => undefined, failed: () => false } }`. Fake: `echo '{"type":"x"}'`.
    - Expect: `spawnSession` resolves `exited`, and `'[1 implement/p1] {"type":"x"}'` is printed via `passthrough`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/harness.test.ts tests/usage.test.ts tests/drive.test.ts -t "issue #64|worker contract|headless session command|detection variable"`
Expected: FAIL on every item above. The dry-run saw 8 of these fail with exactly the plan's predicted messages, including the exit-3 deadlock of item 3.

- [ ] **Step 3: Implement**

- **`harness.ts`.**
  - argv per Step 1.
  - `stream` wired to the Task 1 streams.
  - pi `transcripts` per D2, using `node:crypto`'s `createHash` and `node:os`'s `homedir()`. Every rung uses a truthy check, as pi's own `getAgentDir` does, so the folder is always absolute.
  - The pi worker comment is rewritten for D2.
- **`drive.ts`.**
  - `lineSink(emit)` per D11.
  - In `spawnSession`: `transcripts = opts.root !== undefined ? harness.worker.transcripts?.(ctx.env, opts.root) : undefined`.
  - Each stdout record goes through `(opts.stream ?? harness.worker.stream(step.home)).line` inside a `try`. On a throw, show `passthrough(record)`.
    - `show` → tail (if non-blank), print, `hear`;
    - `heard` → `hear`;
    - `session` → print `session <id>[ · <transcripts>]`, never into the tail.
  - stderr records → `passthrough` → the `show` path.
  - `failed: stream.failed()` on every `SessionEnd`.
  - `launch` passes `root` and `hear` (MERGE_LINE + pr). `STREAM_PREFIX` is deleted.
  - Update the `SessionEnd` and `lineSink` comments.
- **`usage.ts`.** D5's rule, and the comment.
- **`drive.ts` `limited`.** It already passes the whole `SessionEnd`; `outcome` rides along.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run tests/harness.test.ts tests/usage.test.ts tests/drive.test.ts tests/drive-pause.test.ts tests/worker-stream.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness.ts src/drive.ts src/usage.ts tests/harness.test.ts tests/drive.test.ts tests/usage.test.ts
git commit -m "fix(drive): run workers in their streaming mode and read what the CLI printed (issue #64)"
```

---

### Task 3: Drive's own session lines — started, still running, ended

**Files:**
- Modify: `src/session-clock.ts:48-54` and the `on` type
- Modify: `src/drive.ts` (`spawnSession`, `launch`, the fill's `rerun` `:833-836`)
- Test:
  - `tests/session-clock.test.ts`
  - `tests/drive.test.ts`: the `spawnSession` describe; `:169`; `:200-212`; `:215`; `:240-250`; `:447-455`

**Interfaces:**
- Consumes: Task 2's `spawnSession`, `stream.inFlight()` and `stream.failed()`.
- Produces:

```ts
// src/session-clock.ts
on: { expire(): void; slept(ms: number): void; tick?(awakeMs: number): void }   // tick runs after re-arming
// src/drive.ts
export const SESSION_QUIET_MS = 300_000
// spawnSession opts gain: next?: string
```

  Inside `spawnSession`, one emitter for drive's own lines (D7). Task 4 prints through it.

```ts
// Virtual awake time for a real child: each armed check fires on the next macrotask, `ms` later here.
const fastTicker = (): Ticker => {
  let now = 0
  return { now: () => now, after: (ms, fn) => { const t = setTimeout(() => { now += ms; fn() }, 0); return () => clearTimeout(t) } }
}
```

- [ ] **Step 1: Write the failing tests**

1. **`session-clock.test.ts`: `ticks with the awake time, after re-arming (issue #64)`.** With `host()` and `limit 10_000`, the tick records `[awake, h.armed.length]`. After `h.run(3_000)`, expect `[[1000, 2], [2000, 3], [3000, 4]]`.
2. **`says when a session started and how it ended (issue #64)`.** Fake `echo hi`, `{ next: 'witness start p1' }`.
   - `lines[0]` matches `/^\[1 implement\/p1\] started \d\d:\d\d:\d\d · next: witness start p1$/`.
   - `lines[1]` is `'[1 implement/p1] hi'`.
   - The last line matches `/^\[1 implement\/p1\] ended \d\d:\d\d:\d\d · exit 0 · \d+s$/`.
   - `end.tail` equals `['hi']`.
3. **`ended names the outcome (issue #64)`.**
   - `fakeAgent('exit 3')` → the last line contains `' · exit 3 · '`.
   - A pi fake that `say`s an error `message_end` and exits 0 → the last line contains `' · exit 0 (error) · '`.
   - The existing timeout test (`:169`, now capturing `out`) → a line matching `/\] ended \d\d:\d\d:\d\d · timed out · /`.
4. **`a quiet session says it still runs and what it waits on (issue #64)`.**
   - Setup: harness pi, `sessionTimeoutMs: 7_200_000`, `{ ticker: fastTicker() }`.
   - Fake: `say` a bash start for `cargo test discovery`, then `awaitFlag`.
   - The flag is written on a line that contains `'] still running · '` and ends with `'in: $ cargo test discovery'`.
   - Expect: that line matches `/^\[1 implement\/p1\] still running · \d+m(\d+s)? of 2h · quiet 5m · in: \$ cargo test discovery$/`, and `end.code === 0`.
5. **`a session that renders nothing still says it runs (issue #64)`.**
   - Setup: harness pi, 2h, `fastTicker()`.
   - Fake: `say({type:'brand_new'})`, then `awaitFlag`. The flag is written on the first `still running` line.
   - Expect: it matches `/still running · \d+m(\d+s)? of 2h · quiet 5m$/`, and no line contains `brand_new`.
6. **`started names the re-run a settle routed (issue #64)`** (D13), in the describe that holds `a --manual run's stop waits for the human` in `tests/drive.test.ts`:

```ts
const repo = await plannedRepo({ autonomy: false })
const scenario = fakeScenario()
putVerdict(scenario, PLAN_BLOCKING)
expect((await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })).code).toBe(1)
autonomyOn(repo)
writeLocalConfig(repo.root, { notify: noopOpener() })
expect((await writePlan(repo, 'auth-refresh-plan-1', {}, '## Step: s1\nRewritten.\n')).code).toBe(0)   // the verdict is stale
const out: string[] = []
await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 0') }, out), { maxSpawns: 1 })
expect(out.filter((l) => / started \d\d:\d\d:\d\d · /.test(l)))
  .toEqual([expect.stringMatching(/^\[1 [^\]]*\] started \d\d:\d\d:\d\d · next: witness gate plan auth-refresh-plan-1$/)])
```

7. **RF4: `a session id carrying an escape is spelled out (issue #64)`.** A pi fake `say`s `session {id:'S\x1b[2J'}` → the line `'[1 implement/p1] session S\\x1b[2J'`, so the emitter spells drive's own lines.
8. **Adapted existing tests.**
   - `:215` spawn-failed, now capturing `out`: no line matches `/\] (started|ended) /`.
   - `:211`: `lines.some((l) => /\] started$/.test(l))`.
   - `:454`: `lines.find((l) => /^\[2 [^\]]*\] marker=/.test(l))` matches `/marker=-$/`.
   - `:249`: compare `lines.filter((l) => !/\] (started|ended) /.test(l))`.
   - The host-sleep test (`:180`): `end.tail` does not contain its `host slept` line.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/session-clock.test.ts tests/drive.test.ts -t "issue #64"`
Expected: FAIL. The dry-run saw: the tick array empty; `expected '[1 implement/p1] hi' to match /…started…/`; the quiet-line tests hitting the fake's exit 3; no `ended` line.

- [ ] **Step 3: Implement**

- **`sessionClock`.** `if (awake < limitMs) { arm(awake); on.tick?.(awake); return }`.
- **`spawnSession`.**
  - Print `started` once `child.pid !== undefined`, naming `opts.next`.
  - Route `host slept` through the own-line emitter.
  - On each tick, inside a `try`, apply D8. `lastHeard` is the awake time of the last printed line; `started` prints before the clock exists, so stamp it through a small indirection.
  - Print `ended` in `settle` for every outcome except `spawn-failed` (D1's outcome words).
- **`launch`.** Takes the `next` line from the fill: the re-run only when the fill turned a decision into a spawn for it (`src/drive.ts:834-835`), else `action.line` (D13).

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run tests/session-clock.test.ts tests/drive.test.ts tests/drive-pause.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-clock.ts src/drive.ts tests/session-clock.test.ts tests/drive.test.ts
git commit -m "feat(drive): a session says when it started, that it still runs, and how it ended (issue #64)"
```

---

### Task 4: A session's journaled acts print as they land

**Files:**
- Modify: `src/verbs/log.ts:15-67` (export `entryDetail`; uses `:134`, `:146`, `:157`)
- Modify: `src/drive.ts` (`family` → a pure `flowOf(canon, t)` plus the closure; new `journalWatch`; `spawnSession`; `launch`)
- Test: `tests/drive-pause.test.ts` (tests 1–5), `tests/drive.test.ts` (test 6)

**Interfaces:**
- Consumes: Task 3's tick and emitter; `movesFlow` (`src/progress.ts`); `effortOf` (`src/reviewed.ts:104`); `readStream` and `journalRel` (`src/journal.ts:117`, `:76`); `sessionHash` (`src/context.ts:29`); `loadCanon`. Tests also use `withJournalCtx`, `appendEntry` and `entryLine` (`src/journal.ts:88`, `:110`, `:104`).
- Produces:

```ts
// src/verbs/log.ts
export function entryDetail(e: Entry): string                 // `witness log` stays byte-identical
// src/drive.ts
export function flowOf(canon: Canon, target: string): string[] // today's `family` body
export function journalWatch(root: string, target: string): (session?: string) => string[]   // D9
// spawnSession opts gain: progress?: (session?: string) => string[] — polled each tick and once before `ended`
```

In `tests/drive-pause.test.ts`, add the same `awaitFlag` helper as Task 2.

- [ ] **Step 1: Write the failing tests** in a new describe, `drive prints a session's journaled acts (row 214)`.

1. **`a step close shows while the session still runs (issue #64)`.**
   - Setup: `startedThreeStepPlan({}, SCAFFOLDING_FIRST)`, `autonomyOn`, `writeLocalConfig(repo.root, { notify: noopOpener() })`.
   - Fake: `` `${witnessCli()} step-close ${planId} --step s1 > /dev/null\n${awaitFlag(flag)}` ``.
   - The test's `out` writes the flag on a line matching `` new RegExp(`^\\[1 \\w+/${planId}\\] journal: step-close step=s1$`) ``.
   - Run with `{ maxSpawns: 1 }`, `fakeClock(0)` and `WITNESS_DRIVE_IDLE_MAX_MS: '0'`.
   - Expect spawn 1's `ended` line to contain `' · exit 0 · '`. A drive that reads only at session end deadlocks the fake into exit 3.
2. **`an append in flight is read once it completes (issue #64)`.**
   - Setup: `seededRepo()`, `writeSpec(repo, 'auth-refresh')`, `approve(repo, 'auth-refresh')`, `writePlan(repo, 'p', { parent: 'auth-refresh' })`.
   - `const poll = journalWatch(repo.root, 'p')` and `const line = entryLine({ t: 'step-close', step: 's9' })`.
   - Append `line.slice(0, 10)` to `p`'s stream → `poll()` equals `[]`.
   - Append the rest plus `'\n'` → `poll()` (no session known, so no attribution) equals `['journal: step-close step=s9']`.
   - A third `poll()` equals `[]`.
3. **`bookkeeping prints nothing (issue #64)`.** Appending `entryLine({ t: 'dispatch', plan: 'p' })` → `[]`.
4. **`a plan written and gated mid-session joins the flow (issue #64)`.**
   - Setup: watch the spec (`journalWatch(repo.root, 'auth-refresh')`) before `p2` exists.
   - Then `writePlan(repo, 'p2', { parent: 'auth-refresh' })`, which appends the effort's `write`.
   - `poll()` contains a line starting `'journal: write artifact=p2 '`.
   - Then `appendEntry(repo.root, 'p2', { t: 'gate-run', gate: 'plan', round: 1, outcome: 'passed', reviewed_sha: 'abc1234', verdicts: [] })` → `poll()` contains a line starting `'journal: gate-run gate plan r1 passed'`.
5. **`an entry from another session says so (issue #64)`.**
   - `entryLine` drops a carried `ctx` and stamps the writer's own (`src/journal.ts:104-108`), so the session must come from `withJournalCtx`:
     - `withJournalCtx({ session: sessionHash('S-1') }, () => appendEntry(repo.root, 'p', { t: 'step-close', step: 's1' }))`;
     - the same with `'S-2'` and `step: 's2'`.
   - `poll('S-1')` equals `['journal: step-close step=s1', 'journal: step-close step=s2 · not this session']`.
6. **RF4: `journal lines are spelled out too (issue #64)`.**
   - In the `spawnSession` describe of `tests/drive.test.ts`, fake `sleep 1.5`, with opts `{ progress: firstPoll(['journal: human-decision implement: approve — ok\x1b]52;c;x\x07']) }`. `firstPoll` returns the lines on its first call and `[]` after; it is not named `once`, because `tests/drive.test.ts:3` imports `once` from `node:events`.
   - Expect: `'[1 implement/p1] journal: human-decision implement: approve — ok\\x1b]52;c;x\\x07'` printed, and no printed line containing a raw `\x1b`.
7. **`a hand-edited entry is skipped, not thrown (issue #64)`.** Append the raw line `{"v":1,"t":"gate-run","gate":"plan"}` (no `reviewed_sha`) to `p`'s stream, then `entryLine({ t: 'step-close', step: 's3' })` plus `'\n'`. `poll()` equals `['journal: step-close step=s3']` and does not throw (P17).
8. **`a stream that shrank starts over (issue #64)`.**
   - Baseline a stream holding two entries, then truncate it to one, then poll: the result is `[]`.
   - Append one more: the next poll returns that entry alone.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/drive-pause.test.ts tests/drive.test.ts -t "issue #64"`
Expected: FAIL — `journalWatch is not a function`, no `journal:` line, and the `progress` opt is unknown.

- [ ] **Step 3: Implement**

- **`log.ts`.** Rename `detail` to an exported `entryDetail`.
- **`flowOf`.** Extracted, with `family = (t) => flowOf(canonNow, t)`.
- **`journalWatch`.** Per D9.
- **`spawnSession`.** Polls `opts.progress(sessionId)` on each tick (inside D8's `try`) and once in `settle` before `ended`, printing through the emitter, which applies `logSafe`.
- **`launch`.** Passes `progress: journalWatch(root, action.target)` when the action has a target.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run tests/drive-pause.test.ts tests/drive.test.ts tests/log.test.ts && pnpm typecheck`
Expected: PASS. `log.test.ts` must stay unchanged and green, which is the byte-identity check.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/log.ts src/drive.ts tests/drive-pause.test.ts tests/drive.test.ts
git commit -m "feat(drive): print each act a session journals as it lands (issue #64)"
```

---

### Task 5: The Windows watch line names PowerShell's reader

**Files:**
- Modify: `src/drive-presence.ts:109-114`, `src/toon.ts:3`
- Test: `tests/drive.test.ts:898-902` ("one command (B1) › names the stop the platform has (row 201)")

**Interfaces:**
- Produces: `export const psArg: (p: string) => string`, per D12.

- [ ] **Step 1: Write the failing test.** Replace the win32 expectation, and add `psArg` cases:

```ts
expect(watchLine(h, 'win32')).toBe('Get-Content -LiteralPath /r/.witness/drive.log -Wait -Tail 50 -Encoding UTF8 · stop it: taskkill /PID 7 /T /F')
expect(psArg('C:\\r\\.witness\\drive.log')).toBe('C:\\r\\.witness\\drive.log')
expect(psArg('C:\\a,b\\x')).toBe("'C:\\a,b\\x'")
expect(psArg("C:\\o'k\\x")).toBe("'C:\\o''k\\x'")
expect(psArg('C:\\o’k\\x')).toBe("'C:\\o’’k\\x'")
expect(psArg('@x')).toBe("'@x'")
expect(psArg('-x')).toBe("'-x'")
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run tests/drive.test.ts -t "names the stop the platform has"`
Expected: FAIL — `expected 'tail -f /r/.witness/drive.log · stop …' to be 'Get-Content …'`.

- [ ] **Step 3: Implement** the win32 branch with `psArg`. The comment explains D12's three reasons.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm vitest run tests/drive.test.ts tests/next-wait.test.ts -t "names the stop the platform has|watch" && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drive-presence.ts src/toon.ts tests/drive.test.ts
git commit -m "fix(drive): the Windows watch line names Get-Content, beside its taskkill (issue #64)"
```

---

### Task 6: The decision record

**Files:**
- Modify: `DESIGN.md`:
  - new row after row 213 (`:568`);
  - markers on rows 145 (`:500`), 180 (`:535`), 181 (`:536`), 182 (`:537`), 201 (`:556`), 206 (`:561`) and 210 (`:565`);
  - "Open / deferred" (`:572`).
- Modify: `README.md:296`

- [ ] **Step 1: Row 214 ⊜, "A running session shows in drive's log".**
  - **Header:** "Fixes issue #64; amends 145, 180 and 182; touches 181, 201, 206 and 210."
  - **Choice column:** D1–D13, condensed, with their names and the exact copy from Global Constraints.
  - **Rationale column:** E1–E4. P1–P16 are cited by what each showed, in the house's dense style, including that row 145's "the child's own output IS the progress report" held only for the fakes.
- [ ] **Step 2: Markers.**
  - Row 145: "**Amended by 214:** a worker runs in its harness's event-stream mode and drive renders it — the events are the progress report, never raw bytes; drive's pi sessions are kept in a folder of their own."
  - Row 180: "**Amended by 214:** what `.witness/drive.log` shows of a running session; the merge sniff hears the CLI's line in a tool's output."
  - Row 182: "**Amended by 214:** a transient shape counts on a session that failed, or on a non-zero exit of one that did not time out."
  - "**Touched by 214:**" on rows 181 (`journalWatch` reads the lane's flow), 201 (`Get-Content -LiteralPath` beside `taskkill`), 206 (`journal:` lines print `movesFlow` acts) and 210 (the quiet line counts awake time).
- [ ] **Step 3: Open / deferred.** Add E6's seven items as bullets.
- [ ] **Step 4: README `drive` row.** After "`--detach` (autonomy only) runs it in the background into `.witness/drive.log`", add: "— each session's start, every command and file its agent touches, every act it journals for its flow, a `still running` line after 5 quiet minutes, and how it ended; drive's pi sessions are kept in pi's session store under `witness-drive/`".
- [ ] **Step 5: Commit**

```bash
git add DESIGN.md README.md
git commit -m "docs: row 214 — a running session shows in drive's log (issue #64)"
```

---

### Task 7: Verify, review, measure on Windows, ship

- [ ] **Step 1: Full gate**

Run: `caffeinate -i sh -c 'pnpm typecheck && pnpm build && npx biome check src tests && pnpm test'`
Expected: exit 0 and 0 `AssertionError`. The dry-run of the earlier plan text passed 2288; this plan adds tests. A lone `onTaskUpdate` timeout is re-run per row 213.

- [ ] **Step 2: Read-only differential.** With a throwaway `git clone --local ~/x/personal/fewhats.com` and `CI=true`, run `witness next`, `witness status` and `witness log <one plan id>` with main's `dist/` and then the branch's.
  Expected: byte-identical.
- [ ] **Step 3: Two `opus` reviews** of the diff: spec vs code, and a behaviour attack. Re-run each finding before acting on it, and fix it RED→GREEN.
- [ ] **Step 4: Push and open the PR on the user's go:** `Fixes #64`, then wait for CI green.
- [ ] **Step 5: HUMAN — Windows, pi 1.4.0, the reporting repo.** Run `witness drive --detach`, then the printed `watch:` line in PowerShell. Confirm:
  - `started`, action lines with their verbs, `journal:`, a `still running` line during a long test run, and `ended`;
  - `·` reads correctly;
  - `session <id> · <folder>` names a folder where the pi transcript sits;
  - `pi -c` in the repo still opens your own last session.
- [ ] **Step 5b: HUMAN — one claude drive session**, in a repo whose harness is `claude-code`; the classifier blocks the agent from running claude with the bypass flag (P11). While the session runs a long `witness gate` or `witness ship`, which claude backgrounds (P12), confirm:
  - the `still running` line names that command;
  - it stops naming it after the command ends;
  - a foreground subagent call (P17) never stays named after it returns.
- [ ] **Step 6: Release.** The human merges and runs `pnpm release patch` (0.26.2).
