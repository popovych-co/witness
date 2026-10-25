# The human loop: drive waits for you, the chat wakes you, trust never loops

Date: 2026-10-25 · Status: approved 2026-10-25 (grill Q1–Q6, one question at a time; the playback was corrected after one verification pass — my probes plus one opus design-vs-record review, every finding re-run by me — and confirmed "y") · Fixes issue #56 · Evidence: probes P1–P8 (§6)

## 1. Why

Issue #56, filed by the user against 0.24.2 (harness `pi`, Windows 11, `autonomy: on`, `drive.parallel: 2`). The expected behavior, in the issue's words: "fully automatic, return to the human when needed, then back to automatic, and to the human again if needed, all in one session. The human should never have to wait, poll, and tell witness to proceed." About 48 spawned sessions went on a step that could never pass without the human.

Each cause below was checked against the code or a probe:

- **Drive quits exactly when it is needed.** When no session runs and nothing else can start, the loop breaks, prints the report and exits (`src/drive.ts:688-694`). Row 196's take-back runs only inside a live run, so `help: run /witness in a chat — drive takes it back when you are done` (`src/drive.ts:448`) is false once every remaining target waits on the human.
- **The chat ends its turn after `launch:`.** Unless `next:` is a `witness decide` line or a brainstorm or design stage at that instant, the engine ends the turn (`plugin/commands/witness.md:31-32`). A conversation that becomes ready later reaches nobody.
- **One notification, at the end, and none on Windows.** `notify` runs once after the report (`src/drive.ts:701-707`), and `notifyArgv` has no win32 branch (`src/notify.ts:12-14`).
- **Trust for config commands is invisible to routing.** Five places run repo-authored commands behind `ensureTrusted`: the filtered runner template (`src/runner.ts:71`), `ship.test` in full-suite mode (`src/runner.ts:82`), the ship gate's test and lint lanes (`src/gates/ship.ts:25`), `cmd:` criteria (`src/criteria.ts:113`) and `cmd:` needs (`src/needs.ts:38`). Only `cmd:` criteria are visible to `untrustedCmdsFor` and the `trust` verb, and only a gate's checks carry `untrusted` back to the settle pass's `trust grant` kept stop. A refusal inside `test-evidence` journals nothing (`src/evidence.ts:139-140`), so `next` routes the same line again (P5).
- **`witness trust <plan>` reads the plan's own criteria** (`src/verbs/trust.ts:35`). Plans carry none, so it says "nothing to trust" even when its spec carries a `cmd:` criterion (P3).
- **Drive's progress check counts bookkeeping as progress.** Every implement session runs `witness start` first, and `start` journals a `sync` entry on the plan's stream whenever the repo has a remote (`src/verbs/start.ts:46`, `src/verbs/sync.ts:107-117`). `dispatch` telemetry counts too (row 81 calls it "never evidence"). `moved` (`src/drive.ts:296`) excludes only refused writes and vacuous reds, so a session that does nothing but fail moves the key, and drive respawns it to the spawn cap (P2, P6). Without a remote and without a dispatch report, the same session is caught after one spawn (P1).
- **The report hides why.** A trust-blocked target ends `stuck`, not "waits on you · trust grant".
- **The trust verb over-grants and has no session guard.** `witness trust <id> --yes` grants every pending command at once (P4), and nothing stops a session drive spawned from running it: `decide` refuses an autonomous trust grant (`autonomy-cannot`, `src/verbs/decide.ts:318-325`), `trust.ts` has no such check, and the runner's own refusal names `witness trust <id>` as the remedy (`src/criteria.ts:120`).

**Decided by the user in this conversation** (one at a time; "1", "2" and "y" took the stated option):
- **Q1:** When everything left waits on the human, drive keeps running, paused: it watches for the human's act and continues by itself, lets the machine sleep, and gives up after a long idle limit with its report. The user's words: "i should be notifyied" — the notification is a requirement, Windows included.
- **Q2:** The notification fires as soon as something new needs the human, even while drive works on other flows; a burst is one notification; plus one when the run ends.
- **Q3:** The chat goes quiet and is woken when something needs the human — on Claude Code by a command left running in the background, on Pi by witness's add-on. In between, the human can type to the chat as usual.
- **Q4:** Trust is granted in the chat: the chat shows the exact command and where it comes from, the human names it ("trust pnpm test"), and a bare "y" never grants.
- **Q5:** When the waiting chat reaches the context limit, witness opens the fresh chat itself on Pi and carries on; Claude Code still asks the human for `/clear` and `/witness`.
- **Q6:** One release, 0.25.0, with everything. (My recommendation was two; the user chose one.)

Calls marked *(my call)* are the designer's. §11 lists the ones to check while reading.

## 2. Goals, non-goals, anti-goals

**Goals**
- g1. A step that needs a trust grant never spends a session: witness sees it before work starts, and it becomes something that needs the human.
- g2. Drive never respawns a session that changed nothing a flow depends on.
- g3. When everything left waits on the human, drive pauses and resumes the moment the human's act lands.
- g4. The human is notified as soon as something new needs them, on macOS, Linux and Windows.
- g5. The chat sleeps until something needs the human, presents it, takes the answer — trust named, a need done, a decision, a design, a grill — and sleeps again. One session, no polling, no relaunch.
- g6. A chat that fills up continues in a fresh chat by itself on Pi.
- g7. Whatever drive set aside comes back once its record moves.

**Non-goals**
- n1. Who settles a gate stop is unchanged: the policy, the arbiter and the kept stops stay as they are.
- n2. Runs with autonomy off or `--manual` keep today's lifecycle: the human is at drive's prompt. They gain only the trust check before work (§4.5), which helps every mode.
- n3. No new committed config settings, so an upgrade needs no `witness migrate`.
- n4. No keep-awake on Windows or Linux (unchanged).
- n5. No reminders: an item already notified in a run is not notified again.

**Anti-goals**
- Granting trust on a nod, or granting more than the human named.
- A session granting itself trust.
- Restarting drive behind the human's back.
- Waking the chat for anything that does not need the human.

**Constraints**
- c1. Witness-only. Upgrading a consumer is the user's call, made separately.
- c2. An upgrade must not re-queue a plan or leave a consumer's tree dirty. A new machine-local file under `.witness/` is excluded the three ways the drafts are (`src/gitio.ts:96-121`, the init block, `.git/info/exclude`).
- c3. Windows behavior is measured by the human on the reporting machine before the row says MEASURED, as for #54.

## 3. Evidence

- **The issue's runs.** `drive: capped — ingest-pipeline-plan-1 · drive cap: 24 session(s) this run · drive.caps.spawns 24 · no open gate to park it on`, twice in two runs; `drive: done — 0 merged · 5 wait on you · 0 parked · 1 stuck`; `notify: none on win32`.
- **Why a new machine meets this first.** `.witness/allow.json` is machine-local and gitignored, so every new machine or clone starts with nothing trusted. On this Mac, fewhats and HYC already trust their config commands (`pnpm test`, `pnpm lint && pnpm typecheck`, P8).
- **The harnesses.** Claude Code's Bash tool runs a command in the background, keeps it running across turns and re-invokes the chat when it exits. Pi 0.85.1: the bash tool has no default timeout; an extension wakes an idle agent with `pi.sendMessage(…, { triggerTurn: true })` (Pi's `examples/extensions/file-trigger.ts` does it from a file watcher); `ctx.newSession` exists only in command handlers, and an extension runs its own command with `pi.sendUserMessage('/<cmd>', { deliverAs: 'followUp' })` (`examples/extensions/reload-runtime.ts`). Witness installs its Pi extension per repo at `.pi/extensions/witness.ts` (`src/harness.ts:183`), and drive's headless `pi -p` sessions load it too.

## 4. The design

### 4.1 Drive waits instead of quitting *(Q1, the user's decision; the mechanism is my call)*

Under autonomy (not `--manual`), when no lane runs and every remaining target is set aside for a human, drive pauses rather than breaking out of the loop:

- It prints `drive: waiting on you — <n> · <the needs-you summary>` and the same wait rows the report prints (§4.2), notifies (§4.2), and releases keep-awake (macOS `caffeinate`; nothing is held elsewhere).
- It watches an explicit list by stat signature every 5 s: the journal directory, the canon directories, `witness.config.yaml`, `.witness/allow.json` and `.witness/config.local.yaml`. It never watches `.witness/drive.log` or its own waits folder, which it writes itself.
- On a change it runs a round as today: take-back, the settle pass, the fill. When a lane starts, keep-awake is taken again.
- After 12 h paused with nothing moving it exits with the full report and the end notification. The limit is a constant read through the `Clock` seam (`src/drive.ts:345`), not a setting (n3), so the suite can run it.
- Every other ending is unchanged: a signal, the spawn ceiling, a usage stop, autonomy turned off, a spawn failure.

### 4.2 One list of what needs you, three readers *(Q2, the user's decision; the list is my call)*

One function derives what needs the human from the journal, the canon and drive's set-asides: a pending transaction, design looks, trust grants, unmet and holding needs, decisions left for a human, conversations, merges left to the human, policy parks, and stuck or capped targets. Today the report keeps its own list (`src/drive-report.ts:46-92`); the report, the notifier and `witness wait` all read the one function.

- **When drive notifies.** At the end of each round, if the list gained items, one notification names what is new (`witness · <repo>: design look · static-site · trust grant · ingest-pipeline-plan-1 (+1)`), and the end-of-run notification stays. An item notified once in a run is not notified again (n5). The notifier is started in the background; today's synchronous 10 s call (`src/notify.ts:17-21`) would stall every round.
- **Windows.** The default notifier is a toast through Windows PowerShell 5.1, started from its absolute System32 path (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`) — never from PATH, on row 201's `taskkill` precedent (`src/spawn.ts:93,162`) — hidden under `withoutConsole`, with the message passed through an environment variable and never interpolated into the command, and PowerShell's own AppUserModelID so no registration is needed. A `notify:` command in `.witness/config.local.yaml` still wins and now receives every notification.
- **Drive publishes the list.** Drive's stuck and capped verdicts live only in its memory (D145), so drive writes the list and its end reason to a machine-local folder (`.witness/live/`, my call), excluded the three ways (c2). Readers check that the drive named there is alive (`driveHolder`) before trusting a line of it (row 145: a killed drive leaves no cleanup), and treat its contents as display data only: nothing in it is ever run.

### 4.3 The chat sleeps and is woken *(Q3, Q5, the user's decisions; the verb and the guards are my calls)*

- **`witness wait [--since <token>]`.** Under autonomy, in an unmarked session, it returns at once when the needs-you list already differs from the one the token names; otherwise it blocks until something new joins the list (an item the human settled never wakes the chat), or until no drive holds the lock while work remains, or until a newer waiter takes over. It prints what changed and a new token, and journals nothing. One waiter per repo (a lock in `.witness/live/`): the newest takes over, and the superseded waiter prints `wait: taken over by another chat`, after which that chat stops waiting for good — two chats never trade the lock back and forth.
- **Merges.** For a merge left to the human, `wait` checks the PR on a slow timer (2 min, read-only `gh`, my call) and returns when it merged. The chat then runs `next`, whose lazy stamp records the merge, and drive's take-back sees the journal move. Drive itself still stamps nothing (`src/drive.ts:338-343`).
- **What `next` prints.** In an unmarked chat under autonomy, with nothing routed for the human and drive running (a paused drive included, which now also gets its `watch:` line) or launched, `next` prints a `wait:` line and an instruction rendered for the harness, the way it renders `relay:`. On Claude Code: run it in the background and end the turn. On Pi: end the turn, and the witness add-on wakes this chat. When the installed Pi payload is stale (`check`'s `payload-stale`, `src/verbs/check.ts:407-416`), `next` warns in the chat and the instruction falls back to running `wait` in the foreground.
- **The engine.** The `launch:` and `watch:` rows no longer end the turn when nothing is for the human; they follow the `wait:` instruction. On a wake the chat runs `next` and acts on the first item the human owes, one at a time; after the answer it loops.
- **The chat never restarts drive by itself.** When `wait` finds drive gone with work left, it returns `wait: drive stopped — <why>` (from drive's end record, or "ended unexpectedly" when the pid died without one). The chat says so and ends its turn; on the human's "go" it runs `next`, whose `launch:` it already runs. A deliberate stop from the `watch:` line is respected, and a run's in-memory verdicts are never thrown away silently.
- **The Pi add-on wakes the chat.** When an agent turn ends and the last witness command the agent ran in this session printed a `wait:` line — the CLI's own output, from a bash call that invoked witness (`invokesWitness`, `plugin/hooks/context-core.mjs`) — and the session has a screen (`ctx.hasUI`) and no drive marker (`WITNESS_DRIVE`), the add-on runs that wait as a child and, when it exits, posts its output with `pi.sendMessage(…, { triggerTurn: true, deliverAs: 'followUp' })`. The child is killed on `session_shutdown`. Drive's headless children never wait.
- **A full chat starts fresh on Pi (Q5).** The add-on registers its own command. When the CLI prints a `relay:` line with no `run:` beside it (`next` prints one beside `run:` for a handoff to another directory, `src/verbs/next.ts:1235-1237`, which must never trigger this), in a session with a screen and no drive marker, the add-on sends that command as a follow-up once the turn ends; its handler opens a new session and sends `/witness` there — `/witness --manual` when this session was armed (`plugin/commands/witness.md:8`). Claude Code is unchanged.

### 4.4 What drive set aside comes back *(my call, from the verification pass)*

Row 196 never takes back `stuck`, `capped` or `merge`. A paused drive would then hold them forever (the drive lock keeps `next` printing `watch:` and `witness drive` refusing `drive-running`).

- `stuck` and `capped` record `key0` and are released when their key moves — a trust grant, a satisfied need, a decision, a retry. Their per-run spawn and wall-clock use resets on release: a human act is a new chance.
- **`witness retry <target>`** is a journaled human act (a `retry` entry on the target's stream) for a fix that leaves no other record — code, a tool, an account. It moves the key, and drive takes the target back. It refuses inside a session drive spawned: a session never un-sticks itself.
- `merge` records `key0`; the merge stamp moves it.

### 4.5 Trust *(Q4, the user's decision; the check and the verb are my calls)*

- **Checked before work, for the commands that have no "no" path.** `next` and `flowAction` (so `next --flow` and a worktree `next` agree, `src/verbs/next.ts:334`) check the config commands the routed action runs: the filtered runner template, or `ship.test` in full-suite mode, for `test-evidence`, `verify-red`, `gate implement` and `check --drift`; `ship.test` and `ship.lint` for `gate ship` and `ship`; `cmd:` needs for `start`. When one is untrusted, the action becomes the trust act: `next: witness trust <target>` — the listing form, which grants nothing — plus, under autonomy, `kept-stop: trust grant — <cmd> (<source>)`. The check honors `WITNESS_TRUST_CMDS=1` and skips held criteria, as `allowlist.ts` and `settle.ts` do.
- **`cmd:` criteria keep row 154's path.** A plain `--approve` leaves them blocked at headless gates, so trust is never the toll for approval: checking them before every step would trap a flow the human deliberately left that way. A gate whose check failed on one reaches the settle pass's trust-grant stop as today, which is now a chat item.
- **Drive** treats the trust act as a human stop: the target is set aside `kept` (`trust-grant`) with `key0`, and no session is spawned. It is taken back when its line changes, which happens on the grant even if the grant's journal write was refused (`src/verbs/trust.ts:75-87`).
- **The verb.** `witness trust <id>` lists every command the target's flow runs, each with its source: the config commands, the criteria owner's `cmd:` criteria (the spec, for a plan), and `cmd:` needs. `witness trust` with no id lists everything the repo runs. `--cmd '<exact command>'` (repeatable) grants exactly the named commands, which must be in the list. `--yes` grants every pending command only at a terminal; without one it refuses and names `--cmd`. Any grant refuses inside a session drive spawned or a reviewer runs in — row 173's "no autonomous decision grants trust", extended from `decide` to the verb. Grants are journaled as today.
- **Remedy text.** The refusals in `src/runner.ts:74,85`, `src/needs.ts:42` and `src/criteria.ts:120` name `witness trust <id> --cmd '<cmd>'` first, and `WITNESS_TRUST_CMDS=1` second, as the CI and automation route.
- **The chat (Q4).** It shows each command with its source and asks the human to name the ones to trust. For each named command it runs `witness trust <id> --cmd '<named>'`. A bare "y" never grants. A "no" leaves the item waiting, or, for a `cmd:` criterion at a gate stop, renders that decision.
- **The report** prints `wait: trust grant · <target> · <cmd> (<source>)` and `run: witness trust <target> --cmd '<cmd>'` — no more `<gate>` placeholder for a target with no gate (`src/drive-report.ts:56`).

### 4.6 Unmet needs in the chat *(my call)*

The chat shows one need at a time with its text. "done" runs `witness satisfy <doc> --need <id>`; "not yet" leaves it, and the token keeps it from waking the chat again. One at a time because `satisfy` takes a single `--need` (`src/verbs/satisfy.ts:18-22`), so a "done" said to a list would be ambiguous.

### 4.7 Drive's progress counts acts, never bookkeeping *(my call, from P1, P2 and P6)*

Every journal entry kind is classified in one table as an act (moves a flow) or bookkeeping (does not): `sync`, `dispatch`, `write-refused`, a vacuous `test-evidence`, `drift-check` and `policy-pin` are bookkeeping. Both readers of `moved` — the no-progress check and the take-back key — use the table. A test scans the source for every entry kind it can write, the way the child_process scan test holds `src/spawn.ts`, and fails on one the table does not classify, so a new kind cannot loop drive by default. `tests/drive.test.ts:520-529`, which uses a zero-step `dispatch-report` as "a target that journals every spawn", is rewritten with a real act.

### 4.8 Docs, prompts and skills

- `plugin/commands/witness.md`: the `launch:`, `watch:` and `kept-stop:` rows; a `wait:` row; `wait: drive stopped`; `wait: taken over`; trust and needs answered in the chat.
- `plugin/skills/witness-implement/SKILL.md`: an untrusted-command refusal is a stop for the human, never a grant.
- `plugin/hooks/witness-pi.ts` and `plugin/hooks/context-core.mjs`: the waker and the fresh chat; the pure decisions (wake or not, fresh or not) in the core so they are unit-tested.
- `README.md`: the operator notes for notifications, Windows, `wait` and `retry`.

### 4.9 Rollout *(the user's call, made separately)*

Skills upgrade, plus `witness init --agent pi` in each Pi repo for the add-on. No `migrate`: no setting changed (n3).

## 5. DESIGN.md rows

**Amended in place:**

| Row | Change |
| --- | --- |
| 81 | `dispatch` is never drive progress either (206). |
| 145 | Drive pauses; a killed drive may leave `.witness/live/`, which readers check against the lock. |
| 154 | Grants are per command; the verb covers config commands and a plan's spec; a session never grants (205). |
| 171 | A trust grant is answered in the chat, by naming the command. |
| 173 | "No autonomous decision grants trust" covers the `trust` verb too. |
| 180 | Drive pauses instead of exiting (202); the chat never relaunches it by itself (204). |
| 182 | Keep-awake is released while drive is paused. |
| 183 | A human release resets a target's per-run use. |
| 184 | One needs-you list; a notification per new item; the Windows default (203). |
| 195 | Trust grants and needs are the chat's; the chat waits instead of ending its turn (204). |
| 196 | Stuck, capped and merge come back when their record moves (207). |

**New rows** start at 202 (201 is #54's).

| Row | Title |
| --- | --- |
| 202 | Drive waits for the human instead of quitting |
| 203 | One list of what needs you, read by the report, the notifier and `witness wait` |
| 204 | The chat sleeps and is woken; on Pi a full chat starts fresh |
| 205 | Trust is checked before work and granted per command, never by a session |
| 206 | Drive's progress counts acts, never bookkeeping |
| 207 | What drive set aside comes back when its record moves, and `witness retry` |

## 6. Probes (2026-10-25)

Each probe was a temporary test file, deleted afterwards, so the tree stayed clean.

- **P1. A trust-blocked session, refusal only.** Full-suite runner, `ship.test: pnpm test` untrusted, autonomy on; the fake session ran `test-evidence … --phase red --step s1` and exited. → `drive: no progress` after 1 spawn; report `0 wait on you · 1 stuck`.
- **P2. The same, plus `dispatch-report … --steps-completed 0`.** → `drive: capped — ingest-plan-1 · drive cap: 5 session(s) this run · drive.caps.spawns 5`, five `dispatch` entries. The issue's message.
- **P3. `witness trust <plan>` whose spec carries `cmd: echo first`.** → `trust: ingest-plan-1 carries no cmd: criteria — nothing to trust`.
- **P4. `witness trust <spec> --yes`, two pending `cmd:` criteria, no TTY.** → `trusted: echo first · echo second`.
- **P5. `next` under autonomy for the blocked step.** → `kept-stops:` roster, then `next: witness test-evidence ingest-plan-1 --phase red --step s1`; no `kept-stop: trust grant`.
- **P6. A session that only re-runs `start`** (the reviewer's probe, re-run by me). No origin → `no progress` after 1 spawn. With an origin → `spawn ceiling reached (4)`, one `sync` entry per session.
- **P7. The harness facts in §3,** read from Claude Code's tool contract and from Pi 0.85.1's docs and shipped examples. Not a live run (§7).
- **P8. Consumer trust lists,** read-only: fewhats and HYC trust their configured `ship.test` and `ship.lint`.

## 7. Edge cases and residuals

- **Windows is measured by the human** (c3): the toast, a hidden PowerShell, and the Pi wake on the reporting machine.
- **A live Pi run is owed**: the wake and the fresh chat, read from Pi's docs and examples, run once on a real session before release.
- **Claude Code at the fill limit** still asks for `/clear` and `/witness` (Q5).
- **With no chat open,** the human gets notifications only; the next `/witness` shows what waits.
- **A merge done on GitHub** is noticed by a waiting chat's 2-minute check or the next `next`; a paused drive with no chat waiting does not see it.
- **A 0.24.x drive running at the upgrade** writes no `.witness/live/`; a new chat's `wait` reads it as "drive running, waits unknown" and wakes when it ends.
- **`WITNESS_TRUST_CMDS=1` set only in drive's shell:** the chat's `next` may show a grant drive does not need. Granting it is harmless.
- **A fix that leaves no record** (code, a tool) needs `witness retry <target>`.
- **A notification while the human is mid-conversation** in the chat: accepted.
- **Windows and Linux machines may sleep** during a long run (n4, unchanged).

## 8. Testing

- **Unit:** the needs-you list; `classifyAction` on the trust act; the entry-kind table and its scan; `notifyArgv` for win32 (absolute path, message in the environment); the trust verb (listing, `--cmd`, `--yes` at and away from a terminal, the session refusal); the trust check per action kind, `WITNESS_TRUST_CMDS`, held criteria, `flowAction`.
- **Drive, through the `Clock` seam:** the pause is printed and notified once; it resumes on a journal write, an `allow.json` change and a config change; it does not wake on its own log or waits; the idle limit; stuck and capped released on a key move and by `retry`; the use reset; the merge release.
- **`wait`:** token semantics; the superseded waiter; drive gone; the PR check against a fake `gh`; a dead drive's `.witness/live/` ignored.
- **Pi add-on:** the pure wake and fresh decisions in the core; the wiring against a fake `pi` API.
- **Regression:** P1, P2, P3, P4 and P6 as tests; the issue end to end — a trust-blocked step spawns nothing, waits as a trust grant, is granted by `--cmd` in the chat, and drive takes it back.
- **Differential:** fewhats and HYC read-only `next`, `status` and `check` (CI=true), expected identical.
- **Windows:** the human's measurement checklist (c3).

## 9. Build order *(my call)*

One branch, one release, 0.25.0 (Q6), in slices that each go green before the next:

1. **S1, trust and progress:** §4.5 and §4.7. This stops the waste.
2. **S2, drive waits:** §4.1, §4.2 and §4.4.
3. **S3, the chat:** §4.3 (without the fresh chat) and §4.6.
4. **S4, a fresh chat on Pi:** the end of §4.3.

## 10. Left to the builder

The cadences (5 s watch, 2 min PR check), the `.witness/live/` file names, the token format, the notification wording, and the `retry` entry's shape.

## 11. Calls for the user to check while reading

- `--yes` grants all pending commands only at a terminal; an agent must name each one with `--cmd`.
- A new verb, `witness retry <target>`.
- The chat never restarts drive by itself; it says drive stopped and waits for "go".
- A merge done on GitHub is noticed by a waiting chat, not by drive.
- The Windows toast uses Windows PowerShell 5.1, which ships with Windows, not PowerShell 7.
