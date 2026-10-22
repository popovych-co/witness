# Context-fill relay: a session ends at a configured share of its context window

Date: 2026-10-22 · Status: draft for approval · Evidence: probes P1–P8 run 2026-10-22 against Claude Code 2.1.307/2.1.308 and Pi 0.85.1 (§3, §6) · Builder check: done, four questions folded in (§4.3, §4.5, §4.8)

## 1. Why

The user's premise, from Matt Pocock: once a session's context is more than about 20% full, its output gets worse. The user wants control over that: a number in the config, and witness starting a fresh session when the fill reaches it, or would reach it during the next step.

Today witness has no such control. It never measures context at all:

- The only limit is a step count. `implement.stepsPerDispatch` (default 3, `src/config.ts:111`) says how many plan steps an implement session takes before it relays (`/clear`, then `/witness`).
- Steps only stand in for size. Three small steps waste a fresh session's warm-up, and three large ones can push it far past any sensible fill.
- Skill prose is the only enforcement (row 79: "enforcement is skill-tier by design").
- Stages before implement (brainstorm, decompose, design, plan) and ship have no limit of any kind. One chat session can carry all of them.
- The CLI cannot even tell which plan steps are done. Evidence entries carry no step (`src/evidence.ts:105`), and nothing computes progress through `steps:` (`src/schemas.ts:95-125` validates the manifest; `start.ts:62` and `gate.ts:219` only count it). The implement skill infers the remaining steps from evidence lines on its own (`plugin/skills/witness-implement/SKILL.md:43`).
- Row 79 chose steps because "token counts are invisible to the agent itself". That was true of the agent. It is no longer true of the harness: both harnesses now hand a live fill reading to code running inside the session (§3).

**Decided by the user in this conversation:**
- The measure is the fill as a percentage of the session's context window, read from the harness. Witness does not count or estimate tokens itself.
- The limit lives in the config file.
- Witness relays when the fill reaches the limit, or when the next step would take it past the limit.
- The user approved the behavior playback as a whole ("seems good"). The playback said:
  - every witness session is covered, not only implement, checked at the points where the loop already pauses;
  - a session never relays mid-red, and the relay itself is unchanged;
  - the step budget stays only as the fallback for unmeasured sessions;
  - a session that starts over the limit still makes progress and warns.

  Everything marked *(my call)* below is mine, made inside that frame.

## 2. Goals, non-goals, anti-goals

**Goals**
- Every witness working session stays under the configured fill wherever witness can stop it safely, on both Claude Code and Pi, in chat sessions and under `witness drive`.
- The CLI makes the decision from the harness's own numbers, at points where the journal carries the position across the reset. Nothing depends on the agent judging its own size, or remembering where it is.
- When the fill cannot be read, the behavior is today's, and witness says so.

**Non-goals**
- Gate reviewers. A reviewer is one headless request. It cannot relay, and splitting an oversized review is a different problem.
- Compaction. The harness's auto-compaction stays the harness's continuity mechanism (row 79's own wording), untouched.
- Cost or rate limits. This is about output quality. The reading also carries cost, which witness ignores.

**Anti-goals** (would be a failure even if it technically works)
- A relay that loses work. A session never resets mid-red, mid-interview, or with anything held only in conversation.
- A loop that never makes progress. Example: a session that already starts over the limit and so relays forever.
- A second token ledger. If witness kept its own count or its own table of model window sizes, it would drift from what the harness shows the user.
- Noise in sessions that are not witness sessions.

## 3. What the harnesses expose (verified)

**Claude Code 2.1.307**
- Claude Code computes fill as `round((input + cache_write + cache_read) / window × 100)` from the last API response. Read from the binary: function `PQn`, with the window from `Om(model, betas)`.
- The status line receives this as `context_window.used_percentage`. Witness can't own the status line: this user's runs ccstatusline.
- The plugin API (hooks modules, "mods") has `$.session.usage()`. It returns `{ context: { tokens, window, percent }, ... }`, "the status line's figures", and the docs say the plain call costs nothing. The `session.measure` event pushes the same figures after each main-thread turn. The types live in the plugin-authoring skill's `types/claude-code.d.ts`.
- `$.env.set(name, value)` sets a variable "for this process and everything it starts after", which includes every later Bash child.
- A `tool.call` hook can return `{ result, context }`, where `context` is "what the model reads after the tool's result and the user never sees" (`ToolCallResult`). It is typed `readonly string[]`, and P3 shows the type matters.
- Every Bash command carries `CLAUDE_CODE_SESSION_ID`.
- The plugin docs warn: "The API is early access and moves between releases: the declaration file is the authority."

**Probe P1 (run 2026-10-22).** I built a throwaway plugin with a hooks module and a classic `SessionStart` hook in one `hooks.json`, and ran one headless haiku session through `claude -p --plugin-dir`. Results:
- `claude plugin validate` passed. Classic hooks and `modules` coexist in one `hooks.json`.
- The headless session loaded the module and ran the classic hook.
- Inside `tool.call` on Bash, `$.session.usage().context` read `{"tokens":31627,"window":1000000,"percent":3}` (claude-haiku-5-5, 1M window).
- With `$.env.set('WITNESS_CONTEXT', …)` in that hook, the command's own `printenv WITNESS_CONTEXT` printed `{"session":"ce2ad214-…","tokens":31627,"window":1000000,"percent":3}`.
- The child's `CLAUDE_CODE_SESSION_ID` was its own id, not the id of the parent chat session that launched it. A headless session's transcript is still written to `~/.claude/projects/<slug>/<id>.jsonl`.

**Pi 0.85.1**
- `ctx.getContextUsage()` returns `{ tokens: number | null, contextWindow, percent: number | null }`. It is available to extension event handlers (`core/extensions/types.d.ts:193-198, 244`). `tokens` is `null` right after a compaction.
- The bash tool spawns with `env ?? getShellEnv()`, and `getShellEnv()` spreads `process.env` at spawn time (`utils/shell.js:115-126`, `core/tools/bash.js:53`). So a `process.env` change an extension makes in `tool_call` reaches that command.
- Bash commands also carry `PI_SESSION_ID` and `PI_SESSION_FILE` (`core/tools/bash.js:119-135`).
- A `tool_result` handler can replace the result's `content` (`ToolResultEventResult`, `types.d.ts:835`).

**Probes P2–P8 (run 2026-10-22).** Each ran in the scratchpad: a cheap haiku run on Claude Code, or a scripted local model on Pi. The Pi runs used a mock because this machine's Pi Anthropic login has expired ("Refresh token expired"). `PI_CODING_AGENT_DIR` pointed Pi at a scratch config directory whose `models.json` named the mock.

- **P2, Pi env handoff: passes, on the mock and live.**
  - The extension's `process.env.WITNESS_CONTEXT` reached the bash child: `{"session":"01a16482-ce4a-…","tokens":6020,"contextWindow":100000,"percent":6.02}`.
  - Bash also carries `PI_SESSION_ID`, and it equals the reading's `session`.
  - The appended text block reached the model's next request.
  - After the user logged back in, the run was repeated against `anthropic/claude-haiku-5-5` (RPC mode) with full extension discovery, the way drive's Pi worker runs:
    - the bash child saw `tokens 16523 / window 1000000`, with the session equal to `PI_SESSION_ID`;
    - the real model quoted the appended line back;
    - after `new_session` both ids moved together.
  - Two side findings:
    - Under `--no-extensions`, every request failed with Anthropic's "Third-party apps now draw from your extra usage" 400. That is row 89's auth-extension case: a hermetic Pi run has no auth transport, and no adapter either. Hermetic runs are only the reviewers, which this design leaves out anyway.
    - Pi's figure is an estimate and can go down between turns (17,064 → 15,489 in the live run). Rule 3 uses the largest growth, so a negative sample never counts.
  - Pi refused to compact the tiny live session ("Nothing to compact"), so the post-compaction edge was covered on the mock only (P7).
- **P3, Claude Code warning delivery: passes, with a correction.**
  - Returned as a string, `context` was dropped silently: it isn't in the transcript, and the model didn't see it.
  - Returned as `[string]`, the model received `tool.call hook additional context: ZEBRA-7731: …` right after the command's result.
- **P4, shared pure module: passes.** `register.ts` imported a sibling `./shared.mjs` and parsed `contextLimit: 7` from `witness.config.yaml`, read with `$.fs.read`. One config reader can serve both adapters.
- **P5, marketplace-installed copy: passes in `-p`.** A directory marketplace plus `claude plugin install --scope local` in a scratch project wrote `extraKnownMarketplaces` and `enabledPlugins` to that project's settings. A plain `claude -p` there logged `hooks module gauge-probe@probe-market loaded … admitted` and delivered the reading. The global plugin registry files were restored byte for byte afterwards.
- **P6, the project skills folder: does not load as tried.**
  - A plugin folder at `<repo>/.claude/skills/<name>` did not load in an untrusted scratch project under `-p`.
  - Claude Code collects project skills-dir plugins (`cWt`) but holds them back behind a gate (`scope === "project" && !Opt()`, loaded with `repoAuthoredContent`), most likely workspace trust.
  - The settings-declared route from P5 is the dependable one (§4.11).
- **P7, edges.**
  - Claude Code, before the first response: `$.session.usage()` gives `{window}` with no `tokens`.
  - After `/compact`: a fresh reading, same session.
  - After `/clear`: a new session id, in `$.session.id()` and in the shell's `CLAUDE_CODE_SESSION_ID` alike (`06d8…` → `c134…`).
  - Pi, before the first response: `tokens: 0`.
  - After `compact`: non-null at the next tool call.
  - After `new_session`: the reading's `session` and `PI_SESSION_ID` change together.
- **P8, journal readers: pass.** I patched an export of HEAD so that `entryLine` stamps `ctx` on every line, then ran the full suite.
  - Result: 1674 passed, 2 failed, 8 skipped.
  - Both failures are exact-shape assertions, not readers breaking: `tests/journal.test.ts` (the NDJSON line) and `tests/status-entry.test.ts` (a round trip).
  - A CLI older than the journal never reads the new kinds, because row 116's floor refuses it.
- **The two harnesses measure `tokens` differently.** Pi's is the last response's input plus output (6000 + 20). Claude Code's is the input side only. Each matches the figure its own harness shows the user, which is the "no second ledger" anti-goal (§2).

**One number for scale.** This chat session started at 51k tokens before any work. That is 5% of a 1M window, but 26% of a 200k window: over a 20% limit before the first step.

## 4. The design

### 4.1 The reading: one contract, two adapters

Before every shell command, each harness adapter puts the live reading into that command's environment:

```
WITNESS_CONTEXT={"session":"<harness session id>","tokens":31627,"window":1000000,"percent":3}
```

- **Claude Code.** The witness plugin's `plugin/hooks/hooks.json` gains `"modules": ["./context.ts"]` beside its classic hooks. The module hooks `tool.call` on Bash: it reads `$.session.usage()` and `$.session.id()`, sets `WITNESS_CONTEXT`, then calls `next(e)`. This is exactly P1's module.
- **Pi.** `witness-pi.ts` gains the same step in its existing `tool_call` handler for bash, using `ctx.getContextUsage()` and the session id. It writes `process.env.WITNESS_CONTEXT`.
- **The CLI** reads `WITNESS_CONTEXT` and trusts it only if all three hold:
  - it parses;
  - its `session` equals this harness's session variable (`CLAUDE_CODE_SESSION_ID` or `PI_SESSION_ID`, as named by a new `session` facet on the `Harness` registry in `src/harness.ts`);
  - `tokens` and `window` are positive integers with `tokens ≤ window`.

  Otherwise the reading is **unmeasured**, with a named reason: `no adapter`, `stale` (session mismatch), `malformed`, or `no reading yet`.
- **`no reading yet`** covers `tokens` absent (Claude Code before the first response) and `tokens: 0` (Pi before the first response), per P7.
- The Pi adapter maps Pi's `contextWindow` to the contract's `window`. Each harness's `tokens` keeps its own meaning (§3).
- The session check is what makes stale values harmless. A drive process launched from a chat session's Bash inherits that chat session's `WITNESS_CONTEXT`. Drive also strips the variable from every child's environment, as a second guard.
- The CLI computes the percentage itself from `tokens / window`. The adapter's `percent` is display only, so the two harnesses can't round differently.

### 4.2 The limit

```yaml
session:
  contextLimit: 20     # % of the session's context window; a fresh session starts at or before it
```

- It is an integer from 1 to 100, with default 20. A bad value is refused the way `implement.stepsPerDispatch` is.
- It lives in `witness.config.yaml`, so it is a repo decision. *(my call)* The config is the user's stated home for the number. A machine overlay can come later if someone needs one.
- `implement.stepsPerDispatch` stays, demoted to the fallback for unmeasured sessions (§4.7).

### 4.3 Steps the CLI can see *(my call; your standing "most architecturally correct" preference)*

The relay lands on step boundaries, so the CLI has to know where they are. Today only the agent knows, by inference. This makes it a CLI fact.

- **The flag.** `witness test-evidence <plan> --phase red|green` gains `--step <id>`. It is required for a plan step's cycle and refused if `<id>` isn't a criteria step of this plan. Leave it off for cycles that aren't plan steps: fix rounds after a gate, for example. `verify-red` takes `--step` too.
- **Scaffolding.** A scaffolding step is closed by a light verb that journals the close and nothing else. Today such a step leaves no trace, so this adds a trace. The verb is refused for criteria steps.
- **When a step is done.**
  - A criteria step is done at its first passing green tagged with it that follows a red tagged with it. The protocol is one red→green cycle per step (`SKILL.md:45-50`), so that green closes it. A re-recorded green changes nothing.
  - A scaffolding step is done at its close.
- **Position as a CLI answer.** `start` and `log` print `steps: 2/5 done · next s3`, and the CLI answers "steps remain?". The implement skill's "derive which steps remain from the journal" becomes "read `steps:`".
- **Legacy plans.** A plan already in progress whose evidence predates `--step` gets `steps: unknown (evidence predates step tags)`. For that plan, the skill keeps its own bookkeeping, exactly as today. The fill rule (§4.5) still applies at its passing greens, and rule 1 stays with the skill.
- **Journal.** `test-evidence` entries gain `step`. The scaffolding close is a new entry kind.

### 4.4 Where the decision is made

Only the CLI decides, and only at points where the journal already carries the position, so a fresh session continues with nothing lost:

| Point | Decides |
|---|---|
| A step closes: a passing `test-evidence --phase green --step <id>`, or a scaffolding close | whether this slice ends here |
| A revise is handed to the session: the gate settling `→ revise` under autonomy (`runGate` → `settleStop`, `src/gate.ts:226-239`), or `witness decide --revise` in chat | whether a fresh session takes the revise. `next` already routes there: `revise owed — …` (`src/verbs/next.ts:292,727,824`) |
| A `witness ship` run exits | whether the next ship pass runs in a fresh session |
| `witness next` in a session already at its `home:` | whether this session hands over before the next action |
| A shell command finishes with the fill at or over the limit (adapter) | nothing; it only tells the agent (§4.6) |

A green that closes no step (a fix round, or a re-record) never ends a slice. It only prints `context:`. A fix round's progress lives partly in the conversation, in which findings are already addressed, so it hands over at the revise and gate boundaries instead.

### 4.5 The rule

Write `f` for the fill, `L` for the limit, and `g` for the expected size of the next step.

**At a step close:**
1. **No unfinished steps remain:** no relay. The session goes to the gate, as today.
2. **`f ≥ L`:** the slice ends.
3. **`g` is known and `f + g ≥ L`:** the slice ends.
4. Otherwise, continue.

There is no first-step exemption at a step close: the step has already finished, so every slice makes progress. A session that starts over the limit ends after one step.

**At a revise hand-over, a ship exit, or `next`:**
- Relay when `f ≥ L` and this session has made at least one act (§4.8). There is no projection here. Other stages have no repeated unit to learn a size from, and projecting them is deferred (§7).
- At a revise or a ship exit, the act guard always holds, because the gate run, the decision or the ship pass is itself an act.
- At `next`, the guard keeps a fresh session from relaying before it has done anything.
- `next` meets a stage only at its own persisted boundaries, never in the middle of a conversation:
  - brainstorm, after `witness recap`;
  - design, after `witness design` hands the artifact over;
  - plan and decompose, after their write and gate.

**Before any work:** when the first reading a session's CLI sees (at `start`, or at its first `next`) is already `≥ L`, the CLI prints `warn: this session opens at 26% of 200k — over the 20% limit before any work; each slice will be one step`. *(my call)*

**Expected next step `g`** *(my call)*. A step's growth is the token growth from the entry that closed the previous step to the entry that closes this one, within the same session. `g` is the largest growth this plan has recorded, converted to a percentage with the current window. With no sample yet (a session's first step on a fresh plan), rule 3 is skipped. The largest sample is the conservative choice: the goal is staying under the limit, and an extra relay costs only one warm-up.

### 4.6 What the agent sees

- At a step close, the CLI prints `context:` and `slice:`:

  ```
  context: 17% of 1M · limit 20% · next step ≈ +5%
  steps: 3/5 done · next s4
  slice: end — 17% + next step ≈ 22% passes the 20% limit
  ```

  or `slice: continue`.
- On `slice: end`, the implement skill runs `dispatch-report` exactly as today. `dispatch-report` prints the `relay:` line, and the skill ends its turn. `slice:` replaces the skill's own "at most `dispatch-budget` steps" count.
- The early-exit rule loses its "~15 inner-loop iterations" trigger to the measured warning below. The "left the step's scope to fight infrastructure" trigger stays: that one is about scope, not size.
- At a revise hand-over, a ship exit or `next`, when the rule says hand over, the CLI prints `context:` and a same-home `relay:` line with no `run:`. Today `next` prints `relay:` only together with `run:` (`src/verbs/next.ts:1006-1011`).
  - The `/witness` router gains a row: a `relay:` with no `run:` means "print it, say the work continues in a fresh session, END YOUR TURN".
  - The stage skills' autonomy paragraphs gain the same instruction after a settled revise: implement, plan, decompose, design. So does ship's CI loop.
- **Mid-step warning** (the adapter's second duty).
  - The first time a shell command finishes with the fill at or over the limit, the adapter adds one line to that command's result:

    `witness: context 21% of 1M has reached the 20% limit — finish what you are in (implement: the red→green), then hand over`

    On Claude Code this is the `tool.call` result's `context`, which must be an array: `context: [line]` (P3). On Pi it is an extra text block from `tool_result`.
  - It fires once per session *(my call)*.
  - It fires only in sessions that have run the witness CLI (the adapter latches on the first command that invokes it) and never in gate-reviewer spawns. Witness's reviewer spawn sets `WITNESS_REVIEWER=1`, and the adapter stays silent when it is set.
  - The adapter reads the limit with the same plain config reader style as `canon-guard.mjs`. It looks for `witness.config.yaml` up from the cwd and stays silent when there is none.
  - This warning is how a long mid-step excursion learns it is over. The decision itself stays the CLI's.

### 4.7 When the fill cannot be read

- The CLI prints `context: unmeasured (<reason>) — step budget 3`. The slice ends after `implement.stepsPerDispatch` steps have closed in this session, counted by the CLI from step-tagged entries carrying this session (§4.3, §4.8).
- If the session can't be identified, or the plan is legacy, the skill counts its own steps, exactly as today.
- At a revise, a ship exit or `next`, unmeasured means no relay, which is today's behavior.
- A Pi reading with `tokens: null` (right after a compaction) is unmeasured for that one point only.

### 4.8 Journal: session and reading on every entry

- `entryLine` (`src/journal.ts:75`) is "the single funnel every state write passes through". Row 116 stamps the writing CLI's version `w` there for exactly that reason. This change stamps `ctx: { session, tokens?, window? }` there, on every entry kind:
  - `session` is a short hash of the harness session id, never the raw id *(my call: the journal is committed)*. It is present whenever the harness names the session, even when no reading exists, so the fallback can count steps.
  - `tokens` and `window` are present when a trusted reading exists.
- Putting the reading on every entry, not only on evidence, is one rule with no per-kind cases. It also records the history a later per-act projection needs (§7) at no extra cost. *(my call)*
- **"An act this session made"** means an entry carrying this session's hash, of a kind that is the session's own stage work:
  - `recap`, `write`, `design-write`, `gate-run`, `human-decision`, `test-evidence`, the scaffolding close, `dispatch`, and ship's pass entries.

  Bookkeeping the CLI writes on the session's behalf never counts: `status` (the lazy merge stamp), `sync` (start's auto-sync), `ask` (queued by `/witness <words>` before the first `next`), `ask-withdrawn`, the `deferral-*` kinds, `trust`, `policy-pin`, `need-satisfied`. So a session can't relay before it has done any stage work. *(my call)* The builder confirms the list against the kinds in the code.
- The numbers come from the harness and remain telemetry under row 81's fence: no gate consumes them. The relay decision does consume them, and row 81 is amended to say that the fence is about gates, which it always was.
- Every journal reader must accept the new optional fields (§6, P8).
- `dispatch-report --tokens` becomes redundant on measured sessions. It stays for the fallback.

### 4.9 Drive

- Drive changes only in one respect: it strips `WITNESS_CONTEXT` from children.
- A child ends its turn on a relay and exits. Drive runs `next` again and spawns a fresh child: the child that relayed after a settled revise is followed by one that picks up `revise owed`. This is already how slices work under drive (row 145).
- Drive's no-progress check still holds. Every slice closes at least one step, and every other hand-over follows an act.

### 4.10 Display lines

`start` and the plan gate print the run's shape today: `9 step(s) ≈ 3 dispatch(es) at budget 3`. Under a measured harness that number is unknowable in advance. The lines become `slices: by context — relay at 20% (step budget 3 if unmeasured)`. `start` also prints `steps:` and the session's opening `context:` line.

### 4.11 Install paths

- **Claude Code via the marketplace plugin:** the module ships in `plugin/hooks/`, beside the classic hooks.
- **Claude Code via `witness install`** (the project-local `.claude/` payload): the install also declares witness's plugin in the project's settings, `extraKnownMarketplaces` plus `enabledPlugins`, as a directory source inside the installed payload. P5 proved this route at local scope.
  - Project scope (`.claude/settings.json`, committed) uses the same mechanism and also reaches teammates. *(my call)*
  - The project skills-folder route is not used, because it is held behind workspace trust (P6).
  - Until a project re-runs install, its sessions are unmeasured and say so (`no adapter`).
- **Pi:** the existing extension.
- `witness check` reports the adapter state: present, reading seen, or absent.

## 5. DESIGN.md rows

- **New row 191.** Context-fill relay: the reading, the limit, the step-aware rule, the hand-over points, and the warning.
- **Amends row 26.** Every journal entry may carry `ctx`, and there is a new scaffolding-close kind.
- **Amends row 44.** `test-evidence --step`.
- **Amends row 54.** Step closure is computed, and scaffolding steps get a close.
- **Amends row 79.** The trigger becomes measured fill. The step budget becomes the unmeasured fallback, and its "token counts are invisible" premise is answered by the harness reading.
- **Amends row 80.** The early-exit trigger becomes measured.
- **Amends row 81.** The context numbers are harness-measured, not reported. The fence is restated as "no gate consumes".
- **Amends row 82.** Same-home `relay:` without `run:`.
- **Amends row 145.** Drive spawns are sized by fill, and drive strips `WITNESS_CONTEXT`.
- **Extends row 116.** `entryLine` stamps `ctx` beside `w`.
- The config surface block in DESIGN.md gains `session.contextLimit`. README's "Run economics" section is rewritten: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` stays an operator note.

## 6. Probes

P1 through P8 all ran on 2026-10-22, with the results in §3. What they changed in the design:
- P3: the warning's `context` is an array.
- P6: `witness install` uses the settings-declared plugin, not the skills folder.
- P7: `no reading yet` covers both harnesses' forms.
- P8: two exact-shape tests get updated.

Still owed. None of these blocks the plan; they are checks during the build.
- **Chat-mode confirmation.** The probes ran headless (`-p`, stream-json, and Pi RPC). The first interactive session after the build confirms that the module loads and the warning reaches the model in chat. It is the same engine path: this interactive session runs plugin modules itself, and the plugin-authoring tools here are registered through `$.tool.register`.
- **Project scope.** `--scope project` (committed settings) instead of P5's `--scope local`.
- **Every Claude Code upgrade.** The plugin API is early access. `witness check` reports the adapter state, so a release that breaks the module shows up as `no adapter` rather than as a silent miss.

## 7. Edge cases and residuals

- **Starting over the limit** (a 200k window and heavy warm-up): one step per slice, with a warning (§4.5).
- **A step bigger than the limit:** it still finishes. The plan is too coarse for the limit, which is a plan-quality signal the journal now shows. Recorded as a residual, not acted on.
- **A fix round can exceed the limit** until its re-gate, because it hands over only at revise and gate boundaries (§4.4). This is deliberate: mid-round state isn't journaled.
- **Parallel tool calls in one response** share one reading. That is correct: the fill is a fact of the response.
- **A model switch mid-session:** the reading follows the live window.
- **Older harness versions** without the plugin API: the module doesn't load, the session is unmeasured, and witness says so.
- **The plugin API is early access** and "moves between releases". A release that changes `$.session.usage`, `$.env.set` or `ToolCallResult.context` turns the reading off, and the warning with it. Sessions fall back to the step budget, `witness check` says so, and the warning is the part that would fail silently. The chat-mode and upgrade checks (§6) watch for it.
- **Deferred:**
  - projecting the next act in non-implement stages (the per-entry readings of §4.8 are its data);
  - an implement-gate check that every criteria step closed;
  - oversized gate reviews;
  - a machine-local override for the limit.
- **The 20% figure** is the user's premise. Witness does not validate it. It is a default, and the limit is configurable.

## 8. Testing

Red→green per behavior, in the repo's usual style:
- **Reading validation:** absent, malformed, stale session, `tokens > window`, a Pi `null`.
- **Steps:**
  - `--step` validation: unknown id, a scaffolding id passed for evidence;
  - closure: a red→green pair closes, a re-record changes nothing;
  - the scaffolding close, and refusing it for criteria steps;
  - `steps:` output, and the legacy-plan `unknown` path.
- **The rule as a table:**
  - at a step close: all done; reached; projected; continue; no first-step exemption;
  - at hand-overs: reached with the act guard; bookkeeping-only sessions don't count;
  - the warning when a session opens over the limit;
  - the unmeasured fallback counting steps per session.
- **Projection from journal fixtures:** same session only; the largest sample; the window conversion.
- **Verb output:** a step close prints `context:`, `steps:` and `slice:`; a settled revise, `decide --revise`, a ship exit and `next` print a same-home `relay:`; the display lines.
- **The journal:** `ctx` is stamped on every kind through `entryLine`; the hash, not the raw id, is stored. The two exact-shape tests P8 found (`tests/journal.test.ts`, `tests/status-entry.test.ts`) are updated for the new field.
- **Harness neutrality:** the session variable comes from the registry, never inline.
- **Skill text:** the skill-text assertions in `tests/dispatch-economics.test.ts` are rewritten for the new protocol lines. The router row and the autonomy paragraphs are asserted.
- **Adapters:** the Pi extension against a fake `ctx`; the Claude Code module through `claude plugin test`.
- **Drive** strips the variable.

## 9. Left to the builder

- Exact wording of the TOON lines and the warning.
- The scaffolding-close verb's name.
- Module and file names.
- The hash length.
- Where `slice:` and `steps:` are computed.
- The final act-kind list (§4.8).
- How P4 comes out.
