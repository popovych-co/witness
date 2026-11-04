# witness UI — implementation map

The whole build, item by item. **Spec:** `docs/superpowers/specs/2026-11-02-witness-ui-design.md` (§ numbers below point into it). **Look:** the approved Cockpit canvas, https://claude.ai/artifact/3RNpsf68v8sSQMoESJdz3n (row 2).

**How to iterate.** Pick the first unchecked item whose dependencies are checked → write its plan (`superpowers:writing-plans`, from the spec § and this entry) → build it red→green → review → merge → tick it here. A release ships when all its items are ticked (`pnpm release minor`, run by the user). Items in the same release that do not depend on each other can be built in parallel sessions.

Size: **S** ≈ one task · **M** ≈ 2–4 tasks · **L** ≈ 5+ tasks.

---

## Release 0 — bug fixes (shipped)

- [x] **0.1** #65–#71, #81 — rows 220–227 · PR #82 · 0.28.1
- [ ] **0.2** Rollout of 0.28.1: global skills, fewhats + HYC `init --agent pi` + `witness migrate` (stamps the untouched principles), `check` 0 errors, not pushed
- [ ] **0.3** Human Windows check of row 223 (`drive --detach` under `WITNESS_BIN`)

## Release 1a — CLI foundations (minor) · rows 229–234 · no UI yet, each item testable by CLI alone

| Item | Row | What | Done when | Depends | Size |
|---|---|---|---|---|---|
| - [ ] **1a.1** Structured models | — (rows 139/203: one computation, two renderers) | `needsYou` items, `decide --show` (checks, findings, ranked options with `runnable`, `<why>`/`<effort>` as input fields), the trust listing (escaped; `hasControl` never offered) become models; the TOON text renders from them | text output byte-identical in the suite; models exported for the UI | — | L |
| - [ ] **1a.2** Acts carry what they were shown | 230 | `decide --run <id>`, `gate --fresh --run <id>`; every option `decide --show` prints carries its `--run` | a decide or re-open against a moved round refuses `anchor-moved`, from the CLI and from a stale chat "y" | 1a.1 | S |
| - [ ] **1a.3** Drive stops gently, says it is limited | 233 | `drive --stop`: posix SIGTERM; win32 a stop request keyed to the lease holder, polled into drive's abort race, cleared on start; tree kill after a grace period, reported "killed". `drive.json` gains `{limited, until}` | `drive --stop` ends a running drive and its sessions on macOS (and the Windows check); a usage wait reads `limited`, never "needs you" | lease (row 224) ✓ | M |
| - [ ] **1a.4** The human's merge is a verb | 232 | `witness merge <plan>`: `gh pr merge <n> --<ship.merge> --match-head-commit <sha>`, or the stamp alone for a PR already merged; never settles | merging and stamping work without a TTY; no arbiter call | — | S |
| - [ ] **1a.5** Every agent run is visible | 234 | run registry `.witness/live/runs/<id>.json` per process (worker, reviewer, arbiter, review, drift; lens; awake ms; ids only); derived transcript paths; Claude reviewer → `stream-json`, verdict from the last `result`; tees `runs/<id>.jsonl`; deep drift gets a fd | every one of the five agent-run sites leaves a valid registry entry and a stream file; verdicts unchanged | — | L |
| - [ ] **1a.6** Who presents what | 229 | `ui.json` presence (pid + lease + nonce handshake, fail open); one ownership function feeding `humanAction`, `kept-stop:`/`waiting:` lines, `next`'s token and `wait`'s filter; the `ui:` line; `wait`'s endings; engine prose rows; chat state from the pi add-on (+ a Claude Code hook); re-arm on `session_start`; drive's notifier defers to a present UI | with a fake UI (a test server answering `/presence`), `next`/`wait` route as §4.3; with it gone, today's behaviour; `init` reinstalls the payload | 1a.1 | L |
| - [ ] **1a.7** A look shown in the UI | 231 | `design --open --in-ui --sha <served>`; the skill's `--open`/`--preview` hand to a present UI | sight journaled only for the served sha; refused when the bytes moved | 1a.6 | M |

Suggested order: 1a.1 → (1a.2 · 1a.3 · 1a.4 · 1a.5 in parallel) → 1a.6 → 1a.7.

## Release 1b — the UI (minor) · row 228

| Item | What | Done when | Depends | Size |
|---|---|---|---|---|
| - [ ] **1b.1** Two packages | pnpm workspace; `@popovych.co/witness-ui` skeleton; `pnpm pack`; release publishes witness-ui first with `npm view … ||` guards, verifies both; sync-versions covers both; **user:** manual first publish | a dry-run release packs both; CI green | — | M |
| - [ ] **1b.2** Launcher `witness ui` | §4.1: in-use pin agreement, refusals (no config, session, no TTY, UI tab), re-exec at the pin, start lock, detached start with `WITNESS_NO_CONSOLE`, scrubbed env, code over stdout, opener; `--stop`, `--restart` | opens a working page; a second run reopens it; refuses each listed case | 1b.1, 1a.6 | M |
| - [ ] **1b.3** Server core | §4.1–§4.2: 127.0.0.1 stable port; token auth, Host/Origin/Sec-Fetch; `/presence`; reads in a worker thread; the UI's watch set + 5 s liveness poll; floor/schema freeze; act queue through `spawn.ts`; CSP sandbox for agent bytes | a fake-repo e2e: page loads, inbox matches `needsYou`, an act runs as a CLI child | 1b.2, 1a.1 | L |
| - [ ] **1b.4** Terminal tabs | §4.2/§3.5: PTY package (probe, ≥2 weeks old, `--ignore-scripts`); tab env (`WITNESS_UI_TAB`, `WITNESS_BIN=witness` + PATH shim); pi via `resolveSpawn`; session ids persisted; reattach with scrollback; idle/busy from chat state | pi and a shell run in tabs; a closed browser tab reattaches; a restart resumes pi tabs | 1b.3, 1a.6 | L |
| - [ ] **1b.5** Cockpit shell | §4.6: layout A, dark tokens, folding columns, top bar (next line with its owner, drive Start/Stop), ask box, wide panel | matches the canvas at 1440 and 1280 | 1b.3 | M |
| - [ ] **1b.6** Inbox | §6 of the spec's table: every WaitKind with its acts, urgent-first groups, decision panel (findings, ranked options, note/upstream fields, `--run`), per-command trust, design look sealed + Approve + Review look + discuss in chat, merge, "done — waiting for drive", confirms on risky acts | every kind settles from the page in an e2e | 1b.5, 1a.2, 1a.4, 1a.7 | L |
| - [ ] **1b.7** Live drive | lanes from the registry, nested reviewers/arbiter/review lenses, transcript in the panel (pi session-file renderer, Claude store, tees), limited / paused / stopped / orphaned states | a running drive shows every run with its current action and transcript | 1b.5, 1a.5, 1a.3 | L |
| - [ ] **1b.8** Chat routing + notifications | open / continue in chat into an idle tab of the right harness and home; the UI as the one notifier (tab not visible, drive ended) | an e2e: a conversation item opens in the pi tab; a new item notifies | 1b.4, 1a.6 | M |
| - [ ] **1b.9** Windows + e2e hardening | windows-latest CI job (server start, PTY tab, pi tab, drive stop); browser e2e suite; **user:** hands-on Windows check | CI green on Windows; the human check passes | 1b.1–1b.8 | M |

## Release 2 — the state explorer · rows 235–236

| Item | What | Done when | Depends | Size |
|---|---|---|---|---|
| - [ ] **2.1** The machine is a table the writers obey | row 235: typed transition table (`prepareStamp(transitionId)` asserts `from`), rows for moves with no `status` entry, derived-state registry (incl. row 216's judgeable debts), `who` → its decider, commit oracle test | every status change in the suite matches a row; an illegal move refuses | — | L |
| - [ ] **2.2** "Why next" | `computeNext` trace sink on the same code path | the trace names the rung that fired and why | — | S |
| - [ ] **2.3** Undo verbs | row 236: `satisfy --withdraw`, `trust --revoke --cmd` | each undoes and journals; refused in a session | — | S |
| - [ ] **2.4** The map | efforts ↔ specs ↔ plans as a graph; state, flags, gate state, flow, PR/CI, owner; the pick highlighted | matches `index` + `computeNext` on fewhats | 2.1, 2.2, 1b | L |
| - [ ] **2.5** Item pages | lifecycle strip, history (git-blame order), what can move it and who, files (doc, design, worktree diff, criteria tests, PR/CI, journal, open drafts), Change this… (ask), Adopt with diff, undo buttons | every artifact kind has a page; every move is a verb | 2.1, 2.3, 2.4 | L |

## Release 3 — history

- [ ] **3.1** Journal explorer — per stream and across streams, entry-type filter, raw view · M
- [ ] **3.2** Gate rounds — every round's checks, findings, verdicts, decisions; dismiss a deferral; manual re-run · M
- [ ] **3.3** Evidence — red→green per step, test output, shas · M

## Release 4 — the machine room

- [ ] **4.1** Local state — locks, pending write, drive lease and end, worktrees (live/stray/missing), trust grants, floor and every pin with skew, payload per home, divergence, the file inventory · M
- [ ] **4.2** Settings view — read-only, each setting explained, violations, uncommitted-autonomy warning · S
- [ ] **4.3** Housekeeping acts — check, migrate, sync, clean, rename, abandon, adopt, init, floor --set, start, ship --manual · M

## Later (out of this effort)

Desktop wrapper and all-repos hub · phone / remote access · light theme · manual-mode `run:` handoffs opened in a new tab.
