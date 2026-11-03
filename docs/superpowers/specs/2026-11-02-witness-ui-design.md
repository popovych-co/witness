# The witness UI: a local cockpit with the chat inside it

Date: 2026-11-02 · Status: approved 2026-11-02 (grill 2026-10-29 → 2026-11-02, one question at a time, every pick the stated recommendation; two verification passes of three opus reviews each plus a state-machine inventory, every finding re-run by me; look approved on the canvas after a local render check; this doc then checked against HEAD 0.27.0 by one more opus review — 13 findings, all folded in) · Rows 228–236 · Depends on the bug-fix release for #65–#71 and #81 · Look: https://claude.ai/artifact/3RNpsf68v8sSQMoESJdz3n (private canvas, row 2 "Cockpit")

## 1. Why

The user's ask: "a fully functional ui for the witness, it should allow all the interactions allowed currently from a cli, and it should also have a built in terminal so we will run witness in pi so the agent will run it on its own but on the ui we will be able to see more than just we can see now, and if needs be it could be a desktop app if not web". Then: "what about exploring/managing state machine and related files, how the ui will handle this?"

What the human sees today is a chat, a `drive.log` tail (since row 180; it shows running sessions since row 214), desktop notifications and the text of `witness status`. What drive's sessions, the gate reviewers and the arbiter are doing, what is owed and why, and where each artifact stands in its lifecycle are spread over a journal, the canon, `.witness/` and two harnesses' transcript stores.

**Decided by the user** (2026-10-29 to 2026-11-02, one at a time; every pick was the recommendation):
- **Q1** `witness ui` in a repo opens a browser tab; a desktop wrapper may later host the same page.
- **Q2** One tab per repo, each served by that repo's own witness version; an all-repos hub comes later.
- **Q3** Buttons for the human's acts, a page for every read; agent-only verbs (recap, draft, write, test-evidence, verify-red, step-close, dispatch-report) show as history. (`witness review design`, new in 0.27.0, is a human-requested act: it gets a button, §4.4.)
- **Q4** A click runs the witness command itself; conversation items get "open in chat".
- **Q5** Terminal tabs: the first opens pi in the repo, idle; "+" opens a shell or another pi; tabs outlive a closed browser tab and end when the UI stops.
- **Q6** This computer only.
- **Q7** Release 1 = terminal tabs + the "needs you" inbox with buttons + live drive (sessions, reviewers, arbiter) + ask box + next line. Then the state explorer, then journal/gates/evidence, then housekeeping.
- **Q8** While the UI runs, the chat wakes only for conversations; the rest goes to the UI.
- **Q9** `witness ui` runs the server in the background; `witness ui --stop` or a Stop button ends it.
- **Q10** Specs stay read-only in the UI: "Change this…" queues an ask and the agent amends through the write path; Adopt is offered only for a hand edit made elsewhere.
- **Q11** Settings are shown read-only with their explanations; the human edits them in an editor.
- **Q12** The CLI bugs found during verification are fixed first, in their own release (#65–#71, #81).
- **Q13** The look: layout A "Cockpit" (inbox left, terminal centre, live right); details in a wide panel over the terminal; side columns fold to count strips on a laptop; dark only; the inbox grouped, most urgent first.

Calls marked *(my call)* are the designer's. §11 lists the ones to check while reading.

## 2. Goals, non-goals, anti-goals

**Goals**
- g1. Every human act the CLI offers is one click away, with the same refusals the CLI gives.
- g2. Every agent run witness starts — drive's sessions, gate reviewers, the arbiter — is watchable live, with its transcript.
- g3. The human never has to read journals or `.witness/` to know what is owed, why, and what each choice costs.
- g4. The chat stays the place for conversations (grills, design sessions) and is never woken to repeat what the UI shows.
- g5. Every artifact's lifecycle is visible and drawn from the CLI's own transition table, so the drawing cannot drift from the code.

**Non-goals**
- n1. No new writer: the UI writes no state file; every change is a CLI verb.
- n2. No remote access, no hub, no desktop wrapper in this effort.
- n3. No config editing (Q11); no canon editing (Q10).
- n4. No light theme in release 1 (Q13).

**Anti-goals**
- a1. A UI that renders the CLI's text by parsing it: the UI reads the same model the text is rendered from.
- a2. A UI version that differs from the repo's pin: one raised floor would lock the agent's pinned CLI out (row 116).
- a3. A path by which a session marked `WITNESS_DRIVE` or `WITNESS_REVIEWER` reaches a human act through the UI.

## 3. Evidence

Two verification passes (2026-10-29): pass 1 attacked the first draft against the DESIGN record, against deployment reality and from the user's seat, with a separate state-machine inventory; pass 2 attacked the revised draft pairwise, by walking six full days (macOS, Windows, upgrade, autonomy off, failures) and the state-machine design against the code. About seventy findings; every load-bearing one was re-run by me by file read or probe before it changed the design. The probes are in §6.

## 4. The design

### 4.1 Processes *(Q1, Q2, Q9; the mechanism is my call)*

- **Launcher `witness ui`** (verb in `@popovych.co/witness`). Resolves the primary root (works from a worktree); refuses without `witness.config.yaml` ("init first"), inside a session marker, without a TTY, and inside a UI terminal tab (`WITNESS_UI_TAB`). Resolves the CLI the way the engine and drive do: `WITNESS_BIN` if set, else the pin all *in-use* homes agree on — the engine pins of the harnesses `harness:` and the chat use, their global skills, and Claude Code's user-scope plugin engine — refusing when they disagree or sit below `stateFloor`, naming each pin and the remedy. Re-execs itself at that pin when it is not running it. A start lock admits one launch at a time; a live UI (§4.3) is reopened, not restarted.
- **Server** (`@popovych.co/witness-ui`, the same version, exact dependency on the CLI). Started the way `detachDrive` starts drive — detached, with `WITNESS_NO_CONSOLE` — because on Windows a non-detached child dies with its parent's job object, and the no-console mode is what keeps row 201's windows hidden. Its env is scrubbed of npx's leftovers (`npm_config_*`, `_npx` PATH entries). It binds 127.0.0.1 on a port derived from the repo root (next free on collision), so the page's origin is stable across restarts. It exits if its launch code is never exchanged and it has no session.
- **Reads** run in a worker thread from the CLI's own pure functions — `loadCanon`, `readStream`, `needsYou`, `computeNext` (never `next`), `readLive`, `lastEnd`, `stateFloor`, `unmetNeeds`, `owedDecisions`, `parkedGates` — inside `withoutConsole`. On fewhats `computeNext` takes about 1 s and `needsYou` about 0.2 s (11 MB journal), so the main thread stays free for the terminal and `/presence`. Never called: `next` (lazy stamp, and under autonomy the arbiter), `status` (lazy stamp, `git fetch`, auto-sync), `check` (the same, and it runs `cmd:` needs), `diff` (temp dirs), the trust listing at a TTY.
- **Refresh**: directory watches (file watches die after a rename) on the UI's own set — row 202's signature set (journal, specs, plans, designs, `witness.config.yaml`, `.witness/allow.json`, `.witness/config.local.yaml`) plus `.witness/txn.json`, `.witness/lock`, `.witness/drive.lock`, `.witness/live/{drive,ui,waiter}.json`, `.witness/live/runs/*.json` and `.witness/live/chats/*` — debounced, plus a 5 s liveness poll, because a crash or a killed drive writes nothing. `drive.log` and every `*.jsonl` stream are tailed to the page and never trigger a recompute: since row 214 they change on every stream event, and each recompute costs about a second. Nor does `drive.lock`'s mtime alone: since row 224 the running drive renews it every 10 s as its lease, so only a change of its content (a new holder, or none) recomputes, and the liveness poll reads the lease through `driveHolder`. Floor and config schema are checked on every recompute: past the UI's version the page freezes to the refusal and offers a restart.
- **Acts** run one at a time per repo, each a child CLI started through `spawn.ts` with the no-console marker, non-TTY, cwd the root. Each act carries its inbox item's key and anchor; the server re-derives the inbox before running it.

### 4.2 Security *(my call, threat model stated)*

The threat model is the CLI's own — honest agents that obey refusals — plus other web pages in the user's browser.
- **Login.** The server hands a one-time code only to the process that started it (its stdout pipe); the launcher opens `http://127.0.0.1:<port>/#code=…`; the page swaps it for a token kept in its own storage (port-scoped) and sends it as a header and as the WebSocket's first message. No cookies: probed, a 127.0.0.1 cookie reaches every port, and two repos' UIs overwrite each other's. When no tab is signed in, the TTY launcher writes the hash of a fresh code into `.witness/live` for the running server, the same bar as `trust --yes`.
- **Every request** checks Host, Origin and `Sec-Fetch-Site`; `/presence` alone is exempt (Node's fetch sends neither header).
- **Agent-written bytes** (designs, design drafts) are served with `Content-Security-Policy: sandbox allow-scripts` and framed sandboxed, through a one-time render URL minted by an authenticated fetch: probed, the frame attribute alone protects only while framed. All other agent or third-party text (spec bodies, findings, arbiter reasons, asks, PR text, transcripts, live lines) renders as text: markdown with HTML off, agent prose and findings through `logSafe` (as `drive.log` and row 215's finding rows do; other scripts kept), and only the commands a human grants through `visible()`.
- **Terminal tabs** never see the token. Their env carries `WITNESS_UI_TAB=1`, `WITNESS_BIN=witness` and a PATH shim that resolves `witness` to the repo's pin on every call, so a tab follows an `init`, never runs PATH's CLI, and never carries a path with spaces into the engine.

### 4.3 Who presents what *(Q4, Q8; the rule is my call)*

- **Presence**: `.witness/live/ui.json` {pid, port, nonce, start time}, validated like `readLive`. Present = the pid lives, its start time matches, and `GET /presence` answers the nonce; a slow answer counts as present, and absent needs consecutive misses. Any failure leaves the chat waking for everything (fail open).
- **One ownership function**, read by `humanAction`, the `kept-stop:` and `waiting:` lines, `next`'s wait token and `wait`'s filter, so `next` and `wait` never disagree. Under autonomy, with a UI present: conversations and design looks are the chat's (a note on a look can become a recap amendment, which only the chat can make — row 200); decisions, trust grants, needs, merges, parked, stuck, capped and an unfinished write are the UI's, and "Approve look" is also a button.
- **Output**: `next` prints `ui: N item(s) wait in the UI · http://127.0.0.1:<port>` and never an actionable `next:` for a UI-owned item; `wait` ends only for a chat-owned item, the UI going absent, or its mechanical endings (`replaced` by this chat's newer wait, `taken over` by another chat, drive stopped with work left), and with nothing for the chat prints `wait: the UI holds N item(s)`. With autonomy off nothing is rerouted: inbox buttons work, and after an act the inbox offers "continue in chat".
- **Chat state**: the pi add-on (and a Claude Code hook) publishes {session, cwd, harness, idle|busy, waiting} to `.witness/live/chats/`. "Open in chat" and "continue in chat" type `/witness` — never a `run:` line — into an idle tab whose cwd is the action's home, opening one there if none. The add-on re-arms its wait on `session_start`; the UI types `/witness` into an idle chat when a chat-owned item exists and no waiter lives.
- **Notifications**: while a UI is present it is the one notifier (drive defers); it notifies when new items arrive and no tab is visible, and when drive ends.

### 4.4 Acts carry what they were shown *(my call, from pass 2)*

- `decide --run <id>` and `gate --fresh --run <id>`: a newer round refuses `anchor-moved`. `decide --show` prints every option with its `--run`, so a stale "y" in the chat after a UI act refuses too.
- A click on an option names it (D127/D143). No "accept recommended" shortcut: one would be a nod and carry `--via affirmation` with its limits.
- `design --open --in-ui --sha <served>` journals `design-shown` with opener `witness-ui`, refused when the file's bytes moved; with a UI present, the design skill's `--open` hands the look to the UI instead of the OS opener, and so does `design --preview` (the session's directions page), shown sealed and recording nothing, as today.
- **Review look** (row 215's `witness review design <spec-id>`): a button on the design panel, its output labelled advice, never a verdict. It writes nothing and takes no lock, so it runs beside the act queue and never blocks it; its lens runs appear in the live column. The ask box only queues asks (`witness ask`); a look review is this button, so the UI never has to sniff words the way the engine does.
- `witness merge <plan>`: the human's merge as a verb — `gh pr merge <n> --<ship.merge> --match-head-commit <sha>`, as ship merges (a bare `gh pr merge` fails without a TTY) — or, for a PR already merged on GitHub, the merge stamp alone; it never settles. The UI polls PR state read-only at `wait`'s 120 s and runs it on MERGED.
- Risky acts confirm with their consequence: approve with override, stop, abandon, rename, rollback, trust, adopt, clean, satisfy, reconfirm, dismiss, migrate.

### 4.5 Drive and every agent run *(Q7; my call)*

- `witness drive --stop`: graceful first — SIGTERM on posix (drive's own abort), on Windows a stop request keyed to the lock holder's pid and start time that drive's abort race polls, cleared when a drive starts — then the tree kill after a grace period, reported as "killed".
- `drive.json` publishes {limited, until} so a usage-limit wait (row 182) reads as limited, never as "needs you" — "paused" already means drive waiting on the human (rows 202, 204).
- **Run registry** `.witness/live/runs/<run-id>.json`, one per process: kind (worker, reviewer, arbiter, review, drift), target, gate, lens, round (none for a review), harness, session id (workers only), pid, start time, awake ms (row 210). Ids, kinds and numbers only — no text, no paths (row 180, row 203). Worker runs are bound to the drive holding the lock; a run whose pid lives without its drive shows as orphaned. The agent-run sites at HEAD are exactly five: drive's worker, the gate battery, the review battery, the arbiter and deep drift.
- **Paths are derived**: a pi worker's transcript is found in row 214's folder by its id (pi names it `<timestamp>_<id>.jsonl` and writes it only after the first assistant message; the session file is not the `--mode json` stream, so it gets its own renderer); a Claude worker's is Claude's project store plus the id. A reviewer, review lens or the arbiter keeps no session at all (row 217: `--no-session-persistence`, `--no-session`), so its tee `.witness/live/runs/<run-id>.jsonl` (local state, so no `unrelated-dirty`) is its only transcript.
- **Reviewers stream**: pi's already runs `--mode json`; Claude's moves from `--output-format json` to `stream-json --verbose` with row 217's flags kept, its verdict read from the last `result` record (probed at HEAD's flags: the same keys plus `model_usage_since_last_result`). The arbiter goes through the same async invocation, so it streams with that change. Deep drift's synchronous reviewer gets a file descriptor to tee into.

### 4.6 The cockpit *(Q5, Q7, Q13)*

Release 1's page, as approved on the canvas: a top bar (repo, autonomy, the next action with its owner — drive, you, the chat or automatic — never a run button for drive's work; drive status with Start or Stop); the inbox (left), grouped most urgent first in `needsYou`'s order, each item with its acts; terminal tabs (centre); live drive (right): each lane's session with its current action, time against its limit, its reviewers nested, transcript on click. Details — a decision, a transcript, a design look — open in a wide panel over the terminal. Under about 1440 px the side columns fold to strips with counts. Dark only.

Inbox truth across drive's life: with drive gone, its last asides (`drive.json`) are shown labelled with its end reason, merged with `computeNext`'s human routes; an item whose resolving act already landed shows "done — waiting for drive" with its button off.

### 4.7 The state explorer *(Q10, Q11, the user's "exploring/managing state machine and related files"; release 2 onward)*

- **The machine is a table the writers obey.** Every `status` write goes through a typed transition table — `prepareStamp(transitionId)` asserts the `from` — with rows for the moves that write no `status` entry (spec amend, re-author, adopt, look approval, reconfirm, drift, rename, departures), each naming its evidence entry. Derived states (`gateSettled`, `gateParked`, `boundReached`, `openReopen`, `owedRun`, `designPending`, `designUnseen`, red in flight, `unmetNeeds`, open deferrals — split by row 216's `judgeable` into debts a battery can still judge and debts only `witness dismiss` can close) are a separate registry drawn as overlays. `who` points at its decider (`policyFor`). The test is an oracle at the trailer commit: every status change in a commit matches a row whose evidence line is in that commit.
- **The map**: efforts, specs and plans as a graph (an effort and a spec relate many-to-many), each with state, flags, gate state, flow progress, PR and CI, and who moves it next; `computeNext`'s pick highlighted, with its reasons from a trace sink on the same code path.
- **The item page**: its lifecycle strip from the table; every past move (journal, ordered by git blame — the journal has no timestamps), with who (human, affirmation, policy, arbiter, a session) and the writer's version; what can move it and who may; its files (the rendered doc, the design, the worktree diff, the tests carrying its criteria tag, PR and CI, its journal, a grill's draft while open).
- **Managing**: every move runs its verb; "Change this…" on a spec queues an ask; Adopt (with its diff) appears only when the trailer audit (`auditStateCommits`, a pure git read — never the `check` verb) finds a hand edit. Missing verbs are added to the CLI first, in the same release as the explorer: `satisfy --withdraw` and `trust --revoke --cmd`. Settings are read-only with each one's explanation, its violations, and a warning when an autonomy change is not committed.

### 4.8 Packaging and release *(my call)*

The repo becomes a pnpm workspace with `@popovych.co/witness-ui` beside the CLI, linked by `workspace:*`, built with `pnpm pack` (npm pack leaves `workspace:*` in the manifest). The release publishes witness-ui first, then witness — a failed second publish leaves nothing reachable — each guarded by `npm view <pkg>@X version ||` so a rerun after an OIDC 401 is idempotent, then verifies both. The first witness-ui publish is manual (trusted publishing needs the package to exist). The PTY package is chosen at plan time by probe, a release at least two weeks old (`@homebridge/node-pty-prebuilt-multiarch` 0.14.1, or `@lydell/node-pty`), installed with `--ignore-scripts`. The page is React, Vite and xterm.js; the server is Node's http plus `ws`.

## 5. DESIGN.md rows

- **228 — The UI is a door and a renderer, never a writer.** `witness ui` serves a local page from `@popovych.co/witness-ui` at the repo's own pin; every act is a CLI child, every read the CLI's own pure computation; never `next`, `status`, `check` or `diff` on a refresh. Security per §4.2. Amends 116 (in-process reads honour the floor).
- **229 — Who presents what.** UI presence, one ownership function, the `ui:` line, `wait`'s endings, chat state from the add-on, re-arming, one notifier. Amends 180, 195, 202, 203, 204 and the engine rows.
- **230 — An act carries what it was shown.** `--run` on decide and gate --fresh, in every printed option; item key and anchor on every UI act.
- **231 — A look shown in the UI is a look shown.** `design --open --in-ui --sha`; the skill's `--open` and `--preview` hand to a present UI; Review look as a button. Amends 72, 194, 200.
- **232 — The human's merge is a verb.** `witness merge`, merge or stamp, never settles; a read-only poll triggers it.
- **233 — Drive stops gently and says it is limited.** `drive --stop`, `{limited, until}`. Amends 145, 182, 201, 203, 214.
- **234 — Every agent run is visible.** The run registry (one entry per process, with its lens), derived paths, streaming reviewers and arbiter, the tee as a reviewer's only transcript. Amends 88, 180, 203, 210, 214, 215 (a review now leaves local live files), 217.
- **235 — The machine is a table the writers obey.** §4.7's transition table, derived-state registry, commit oracle and `computeNext` trace.
- **236 — Undo for the human's own marks.** `satisfy --withdraw`, `trust --revoke --cmd`.

## 6. Probes (2026-10-29 to 2026-11-02, this Mac, Node 24.11.1, pi 0.85.1)

- P1 Floor: `stateFloor` is the maximum `w` across the journal (`src/floor.ts`) — read.
- P2 PTY: homebridge 0.15.0 ran a real 101×33 PTY (6.7 MB); official node-pty 1.1.0 failed `posix_spawnp` (62 MB, spawn-helper not executable); homebridge 0.15.0 was published the day of the probe.
- P3 Cookies: Chrome 156 sent one 127.0.0.1 port's HttpOnly cookie to another and let a same-named cookie overwrite it (pass-1 deploy review).
- P4 Frame sandbox: opened top-level, a design page sent the token and passed the Origin check; with the CSP header it did neither (pass-1 deploy review).
- P5 Claude reviewer stream: the `stream-json` last `result` record carries the `json` envelope's keys (pass-1 deploy review).
- P6 Read cost on fewhats: `computeNext` 987–1020 ms, `needsYou` 196–213 ms (re-run by me).
- P7 `adopt` forgery: reproduced on a fresh repo → #65. Chore loop: reproduced → #66.
- P8 `detachDrive` under `WITNESS_BIN` spawns `/bin/sh` (read) → #68. Windows job object: documented at `src/drive.ts` (read).
- P9 Look render check: every artboard rendered in headless Chrome with a stand-in runtime; three defects fixed (a table shrinking to one row, a wrapping chip, cut placeholders).

## 7. Edge cases and residuals

- A UI killed with `kill -9`: presence fails its nonce check, the chat wakes for everything again.
- Upgrade while the UI runs: the banner appears only when every in-use pin agrees on X ≥ floor and `npm view @popovych.co/witness@X` succeeds; restart is deferred while a chat is busy; pi tabs resume their own sessions — each tab's session id persisted locally and resumed with `--session <id>` (pi 0.85.1 has it; row 214 records that older CLIs refuse `--session-id`, so a pi without `--session` falls back to `pi -c` for the first tab only); shell tabs end — stated.
- Issue #80: a pi worker whose turn has ended can hold its lane until `sessionTimeoutMs`; until it is fixed the live column shows such a lane as running.
- The pi transcript folder is derived from the server's env (`PI_CODING_AGENT_DIR`, else `HOME`); a drive started from a different env can put it elsewhere — the run then shows without a transcript link.
- Windows runtime behaviour (detached server, ConPTY tabs, the stop request, console flashes) is unverified until the windows-latest CI job and the human check.
- Phone width is not checked: headless Chrome will not render below about 500 px, and phone access is out of scope (Q6).
- The canvas's own runtime was not used for the render check; the look was checked with a stand-in.

## 8. Testing

Server and models: vitest, keeping row 213's event-loop rule. The page: browser end-to-end tests driving the real UI (row 66's doctrine). Each CLI row: red then green in a throwaway repo, as the suite does today. A windows-latest CI job for the server start, a PTY tab, a pi tab and drive stop, plus the human Windows check before each release.

## 9. Build order *(my call)*

1. The bug-fix release: #65–#71 and #81 (patch).
2. Release 1a, the CLI foundations — rows 229–234; each testable without the UI (minor).
3. Release 1b, the UI package and `witness ui` — row 228, with the two-package release flow and the manual first publish of witness-ui (minor).
4. Release 2, the state explorer — rows 235 and 236 (its undo verbs ship with it). Release 3, journal, gate rounds, evidence. Release 4, the machine room and housekeeping.

## 10. Left to the builder

The PTY package version; the claude transcript-path encoding; the lowest pi with `--session`; Linux recursive directory watching; the exact copy of the `ui:` and `wait:` lines.

## 11. Calls for the user to check while reading

- 4.1 refusing the UI when in-use pins disagree, rather than picking one.
- 4.2 no cookies; re-login through the TTY launcher only.
- 4.3 a design look counts as a conversation.
- 4.5 Windows stop: a request drive polls, then a tree kill.
- 4.7 the writers obey the transition table — a CLI-wide change in release 2.
- 4.8 two packages in one repo, released together.
