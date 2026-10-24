# Grill Part A: conversations in every mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make brainstorm and design conversations with a human in every mode, which also deletes the headless recap check (row 177) and the gate that ran on unseen looks (row 178). Under `autonomy: on`, a chat keeps the human's own work while drive runs the rest. Drive takes a target back the moment a human moves it.

**Architecture:** Three seams.
- **One classification.** `conversationStage`, moved from `src/drive.ts` into `src/verbs/next.ts`, decides what counts as a conversation, for drive and for `next` alike.
- **A human view in `next`.** It walks the ladder holding drive's work aside, mirroring `driveHasWork`, which holds the human's stops aside. An autonomous chat then prints the human's next item beside `launch:`/`watch:` and keeps its turn.
- **Take-back in drive.** Drive records the progress key (row 181's `progressKey`) each target was set aside at. Every fill releases a `kept`, `decision` or `conversation` target whose key has moved.

**Tech Stack:** TypeScript (ESM), vitest, pnpm, git; the witness CLI and its plugin skills.

**Spec:** `docs/superpowers/specs/2026-10-23-grill-design.md`, Part A: §4.1–4.3, §4.9, the Part A rows of §5, and §9. Read it before Task 0. Parts B (decisions) and C (grill, drafts, design session) are separate plans.

## Global Constraints

- **Witness-only.** Never modify fewhats.com or any other consumer. Task 7's differential reads a throwaway `git clone --local`.
- **Base and branch:** main at `5855647` (0.21.1), branch `conversations`. Release 0.22.0 is cut by the user (`pnpm release minor`) after the merge; the classifier blocks the agent from running it.
- **Judge the suite by AssertionError count, not by exit code.** 3–4 `onTaskUpdate` worker timeouts make vitest exit 1 with every test green.
- **Settling under CI.** GitHub sets `CI=true`, and `settleOwed` returns `[]` under CI. A test that expects `next` to settle passes `{ env: fixtureEnv() }`, as `tests/next-scope.test.ts:135` does.
- **DESIGN rows.** Amend every touched row in place with a bold prefix, as `**Touched by 193:**` does. Rows 194, 195 and 196 are new.
- **No new config key.** `drive.*`, `autonomy` and the kept-stop names stay as they are.
- **Copy, verbatim:**
  - drive's conversation help: `help: run /witness in a chat — drive takes it back when you are done`
  - drive's take-back line: `drive: taken back — <target> · <next line>`, with `untargeted work` as the target for `-`
  - the report on an empty queue: `nothing queued — /witness <what to build> in a chat`
  - the `design look` kept stop's detail: `the human approves the screen or sends a note — witness decide design <spec> --show`
  - the `arbiter.model` comment: `model for the arbiter that settles stops under autonomy · exact id, no aliases`
- **Reviewers.** Spawn any reviewer with model opus.

## Review Focus

1. **An empty repo under autonomy** (no effort, no ask): a chat's `next` opens the grill (`stage: brainstorm`). Drive sets it aside and reports `nothing queued — …` without counting it as a wait. → Tasks 1 and 5.
2. **A pending transaction under autonomy** stays the ladder's. `next` prints the recovery command with no `stage:`, and the human view never walks past it. → Task 4.
3. **A target taken back whose next action is human-owed again** (a new ask, a re-armed look) is set aside again under its new key. It never gets a session and never counts as stuck. → Task 5.
4. **A `--manual`-armed chat under autonomy** ignores `launch:` and acts on `next:`. With nothing left for the human, `next:` is the ladder's own first action, so the chat still reaches drive's work. → Task 4.
5. **An `asks` stream that still holds old recap-check entries:** the ask reads `unanswered` and is offered for a grill, and nothing crashes. → Task 1.

---

### Task 0: Branch and commit the design and this plan

**Files:** `docs/superpowers/specs/2026-10-23-grill-design.md` and this plan. Both are untracked in the main checkout.

- [ ] **Step 1:** `git switch -c conversations main`. Check that `git log --oneline -1` shows `5855647 chore(release): 0.21.1`.
- [ ] **Step 2:** `git add docs/superpowers/specs/2026-10-23-grill-design.md docs/superpowers/plans/2026-10-23-grill-A-conversations.md && git commit -m "docs: the grill design and Part A's plan (D194)"`
- [ ] **Step 3: Baseline.** `pnpm typecheck` exits 0, and `pnpm test` shows 0 AssertionError. Note the test count.

### Task 1: The recap check goes, and no ask is ever parked (row 177)

**Files:**
- Delete: `src/recap-check.ts`, `prompts/arbiter-recap.md`, `tests/recap-check.test.ts`
- Modify:
  - `src/verbs/recap.ts`: imports `:5`/`:11`; the `manual` option `:94`; the autonomy branch `:139-158`; the re-check under the lock `:162-176`; the check's transaction `:180-190`; the `recap-check:` output `:199-202`; `autonomyRefusal` `:214-231`; `sentBack` `:233-256`
  - `src/arbiter.ts:25-33`: `ArbiterMode`, `PROMPT_OF`
  - `src/ask.ts`: `AskStatus` `:18-27`, `RecapCheckEntry` `:32`, `RECAP_CHECK_BOUND` `:36`, `checkReason` `:46`, the check derivation in `askQueue` `:70-96`, `queueAsk`'s open-ask match `:129`, `nextAsk` `:177-179`
  - `src/verbs/next.ts`: import `:4`; the ask rung `:765-773`; the empty-queue rule `:775-785`
  - `src/verbs/dashboard.ts:52-66`: `askRows`, `askState`
  - `src/cli.ts:93`: recap usage becomes `witness recap --file <recap.json> [--ask <id>] [--amend]`
  - `tests/prompts.test.ts`: delete the case at `:85`
  - `tests/next-ask.test.ts:46`: invert it
- Test: `tests/next-ask.test.ts`, plus the recap verb's own test file (`grep -ln "cli(\['recap'" tests`).

**Interfaces — produces:**
- `AskStatus = { id: string; text: string; state: 'unanswered' | 'answered' | 'withdrawn'; effort?: string }`
- `nextAsk(root: string): AskStatus | undefined`: the oldest unanswered ask
- `ArbiterMode = 'decision'`

- [ ] **Step 1: Write the failing tests.** In `tests/next-ask.test.ts`, replace `under autonomy with no ask there is nothing to build` with:

```ts
it('under autonomy with no ask and no effort the grill opens, as without autonomy', async () => {
  const repo = await seededRepo({ noRecap: true })
  autonomyOn(repo)
  const out = await nextLine(repo)
  expect(out).toContain('next: witness recap --file <recap.json>')
  expect(out).toContain('stage: brainstorm')
  expect(out).not.toContain('nothing to build')
})

it('an ask that still holds old recap checks reads unanswered', async () => {
  const repo = await seededRepo({ noRecap: true })
  await repo.cli(['ask', 'one'])
  for (const round of [1, 2, 3]) appendEntry(repo.root, 'asks', {
    v: 1, t: 'human-decision', gate: 'recap', artifact: 'a1', round, run_id: `r${round}`,
    decision: 'revise', selected: 'arbiter', reason: 'no', effort: 'x', class: 'feature',
  } as never)
  expect(await nextLine(repo)).toContain('ask: a1 — one')
  expect((await repo.cli(['status'])).stdout).toContain('  a1,queued,one')
})
```

In the recap verb's test file, add `under autonomy a recap with no ask is born · --manual is gone`:
- Under `autonomyOn(repo)`, `repo.cli(['recap', '--file', repo.writeRecap({ effort: 'e1' })])` exits 0 and prints `effort: e1`.
- The same call with `'--manual'` appended exits 2, and its stderr holds `bad-arguments` and `Unknown option '--manual'`.

- [ ] **Step 2: Run them and see them fail.** `pnpm exec vitest run tests/next-ask.test.ts <recap test file>` → FAIL. Today the empty queue says `nothing to build`, a recap refuses `ask-required`, and the three checks park `a1`.
- [ ] **Step 3: Implement.**
  - Delete the three files.
  - The recap verb keeps its non-autonomous path whole for every recap: `askRefusal` for `--ask`, the slug and the amend checks, and the single-stream transaction.
  - `askQueue` ignores `human-decision` entries on `asks`; their derived fields go with them.
  - `next`'s ask rung drops the rejected-check note. Its empty-queue branch routes `{ line: 'witness recap --file <recap.json>', stage: 'brainstorm' }` in both modes.
  - `askState` returns `'queued'`.
- [ ] **Step 4: Run them and see them pass.** Same command → PASS. `pnpm typecheck` exits 0. `grep -rn "recap-check\|RECAP_CHECK_BOUND\|checkReason\|arbiter-recap" src tests prompts` prints nothing.
- [ ] **Step 5: Commit.** `git commit -am "feat!: the recap check goes — every recap is confirmed by a human (D194)"` (with `git rm` for the deleted files).

### Task 2: A look is gated only once a human has seen it, in every mode (row 178)

**Files:**
- Modify:
  - `src/gate.ts:68-71` (delete `GateRun`), `:76` (`resolve` loses its sixth parameter), `:262`
  - `src/gates/design.ts:25`; and `:43-51`, where `designUnseen` now always applies
  - `src/verbs/next.ts:853`: drop `!cfg.autonomy &&`
  - `src/settle.ts:97-104`: the `design look` detail
  - `src/drive-report.ts:55-58` stays as it is. It already names `--open` and then `decide --show`.
- Test: `tests/design-autonomy.test.ts`

**Interfaces — produces:** `GateSpec.resolve(root: string, ctx: Ctx, canon: Canon, cfg: Config, target: string): Promise<Result<GateInput>>`

- [ ] **Step 1: Rewrite the file's first two cases and add a third.**
  - `under autonomy next routes an unopened look to --open`: the output contains `next: witness design billing-page --open` and `stage: design`.
  - `under autonomy the critic refuses a look nobody opened`: `gate design billing-page` exits 2 with `design-unseen` in its stderr.
  - `a clean opened look under autonomy waits as the design look stop`: opened, then gated clean, `next` (with `fixtureEnv()`) prints `kept-stop: design look — the human approves the screen or sends a note — witness decide design billing-page --show`.
  - `the human opens the look before approving it` stays unchanged.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/design-autonomy.test.ts`
- [ ] **Step 3: Implement.** The settle detail is the one string in Global Constraints.
- [ ] **Step 4: Run and see PASS.** Also run `pnpm exec vitest run tests/design-gate-sight.test.ts tests/autonomy-gate.test.ts` → PASS, and `pnpm typecheck` exits 0.
- [ ] **Step 5: Commit.** `git commit -am "feat!: a look is gated only once a human has seen it, in every mode (D194)"`

### Task 3: Brainstorm and design are conversations in every mode

**Files:**
- Modify `src/verbs/next.ts`:
  - add `conversationStage`, whose body is today's `isConversation`, from `src/drive.ts:39-48`;
  - `humanStop` (`:959`) also returns true when `conversationStage(a)`.
- Modify `src/drive.ts`:
  - delete `isConversation` and import `conversationStage`;
  - `classifyAction` (`:75`) returns the conversation in both modes;
  - rewrite the row-180 comment at `:54-58` to say so;
  - the help line at `:413`.
- Modify `src/verbs/drive.ts`: delete the `ask` option (`:50`), its queueing (`:82-86`) and the `queueAsk` import.
- Modify `src/cli.ts:84`: drop `[--ask "<text>"]` from drive's usage.
- Test: `tests/drive.test.ts` (`:481`, `:624`, `:887`), `tests/next-scope.test.ts`

**Interfaces — produces:** `conversationStage(action: Pick<NextAction, 'stage' | 'line'>): boolean`. True for `stage: brainstorm`, a `witness recap` line, and a `witness design …` line with `--file` or `--open`. Tasks 4 and 5 use it.

- [ ] **Step 1: Write the failing tests.**
  - Replace `:481` with `conversations stay conversations under autonomy · option blocks run headless · decisions stay decisions`:
    - `classifyAction({ line: 'witness recap --file <recap.json> --ask a1', stage: 'brainstorm' }, root, auto)` equals `{ kind: 'conversation', line: 'witness recap --file <recap.json> --ask a1' }`;
    - the design `--file` case's `.kind` is `'conversation'`;
    - the recover block, the choose block and the decide line keep their current expectations.
  - Replace `:624` with `brainstorm waits for a chat under autonomy`: same setup. Assert the `seen` file does not exist; `out` contains `drive: conversation — witness recap --file <recap.json> --ask a1`; and `out` contains `help: run /witness in a chat — drive takes it back when you are done`.
  - Replace `:887` with `--ask is gone`: `repo.cli(['drive', '--ask', 'x'])` exits 2, and its stderr contains `bad-arguments`.
  - In `tests/next-scope.test.ts`'s `the chat shows the human their stop (B1)`, add `prints no launch: when only a conversation waits`. Under autonomy, with an approved ui spec and no look and nothing else, the output contains `next: witness design billing-page --file <html>` and does not match `/^(launch|watch):/m`.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/drive.test.ts tests/next-scope.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** `pnpm typecheck` exits 0.
- [ ] **Step 5: Commit.** `git commit -am "feat!: brainstorm and design are conversations in every mode; drive --ask goes (D194)"`

### Task 4: An autonomous chat keeps the human's work (row 195)

**Files:**
- Modify `src/verbs/next.ts`:
  - add `humanAction` next to `driveHasWork` (`:966`);
  - in `run()`, the output section `:1100-1136` and `turnEnds` at `:1127`.
- Modify `src/autonomy.ts` (add `unmetNeedLine`) and `src/drive.ts:542-553` (`waitingNeed` uses it).
- Test: `tests/next-scope.test.ts`, new describe `the chat keeps the human's work (row 195)`

**Interfaces:**
- Consumes: `conversationStage`, `humanStop` (Task 3), `computeNext`, `unmetNeeds` (`src/needs.ts`), `keptStopLine` (`src/autonomy.ts`).
- Produces:
  - `humanAction(root: string, ctx: Ctx, canon: Canon, cfg: Config, first: NextAction, outside: ReadonlySet<string>): NextAction | undefined`.
    - `outside` holds the targets whose stop the human settles outside the chat. They are the trust grants among this call's `settleOwed` reports (`settled.kind === 'kept' && settled.stop === 'trust-grant'`).
    - **The walk** starts at `first`.
      - It returns the first action that is a conversation, or a `witness decide` line whose target is not in `outside`.
      - It holds every other target aside, need-blocked starts included, through `computeNext`'s `scope` the way `driveHasWork` does.
      - It stops, with no action, at `witness check` or at a target-less action that is not a conversation (the recovery fork).
  - `unmetNeedLine(needs: ReadonlyArray<{ text: string; satisfy: string }>): string` in `src/autonomy.ts`. It is pure and returns today's `waitingNeed` text: `keptStopLine('unmet-need', [...texts, ...satisfies].join(' · '))`. Drive's `waitingNeed` (`src/drive.ts:542`) switches to it.
- **Notices** are not collected by the walk, because a need past the first human item would be missed. They are one `unmetNeedLine` per plan in `unmetNeeds(canon)` whose needs have `blocks === 'start'`.

**Output rules** for an unmarked session under autonomy; a marked session and autonomy off are unchanged:
- **The routing block.** If `humanAction` returned an action, print it as the routing block (`next:`, `stage:`, `target:`, `ask:`, `note:`, block lines). Otherwise print the ladder's own action (Review Focus 4).
- **Notices.** Print each notice once, raw (`ctx.out(line)`), above the routing block, after the settled lines.
- **`launch:` / `watch:`** follow `driveHasWork(…, ladderAction)`, exactly as today.
- **`turnEnds`** is `(toDrive && no human action) || routed line starts with 'witness decide ' || routed line === 'witness check'`. A routed conversation therefore keeps row 191's hand-over guard.

- [ ] **Step 1: Write the failing tests.** Use `nextLine(repo, { env: fixtureEnv() })` and the file's own builders.
  1. `an ask waits in the chat while drive has a flow`: an approved plan started via `repo.cli(['start', …])`, then `ask "add dark mode"`. The output contains `next: witness recap --file <recap.json> --ask a1`, `stage: brainstorm`, `ask: a1 — add dark mode` and `launch: witness drive --detach`.
  2. `a look waits in the chat while drive has a flow`: an approved ui spec `billing-page` with no look, plus another spec's started plan. The output contains `next: witness design billing-page --file <html>`, `stage: design` and `launch: witness drive --detach`.
  3. `an unmet need is a notice and the chat moves on`: `auth-refresh-plan-1` is blocked by manual need `ses-prod` (as in `tests/drive.test.ts:588`), and `billing-page` waits for its look. The output contains `kept-stop: unmet need — SES production access · witness satisfy auth-refresh-plan-1 --need ses-prod` exactly once, and `next: witness design billing-page --file <html>`.
  4. `with nothing for the human next prints the ladder's own action`: only a started flow. `next:` is the flow's `witness test-evidence … --phase red --step s1`, there is no `stage: brainstorm` or `stage: design`, and the output has `launch:`.
  5. `a pending transaction stays the ladder's`: crash a write mid-transaction (`WITNESS_CRASH_AFTER: 'journal-append'`, as `tests/protocol/crash.test.ts:54` does), then queue an ask. `next:` is the recovery command, and the output has no `stage:`.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/next-scope.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** Also run `tests/context-relay.test.ts` and `tests/next.test.ts` → PASS. Both pin `next`'s output unit.
- [ ] **Step 5: Commit.** `git commit -am "feat: an autonomous chat keeps the human's work while drive runs the rest (D194)"`

### Task 5: Drive takes back what a human moved (row 196)

**Files:**
- Modify `src/drive.ts`:
  - `Aside` (`:283`) gains `key0?: string`;
  - the `setAside` calls for `kept` (settle pass `:530`, `waitingNeed` `:550`), `decision` (`:427`, `:432`, settle pass `:533`) and `conversation` (`:414`) pass `key0`;
  - a new closure `takeBack` runs first in every round of the `for (;;)` loop (`:594`), before `settlePass`.
- Modify `src/drive-report.ts:72-77`: the conversation rows.
- Test: `tests/drive.test.ts`, new describe `drive takes back what a human moved (row 196)`

**Interfaces:**
- Consumes: `progressKey` (`src/drive.ts:305`), `computeNext` with `scope`.
- Produces: `Aside` with `key0?: string`.

**Rules:**
- **`key0`.** Every `kept`, `decision` and `conversation` aside records `key0 = progressKey(root, now, family)`, where `now` is the target's own next action at set-aside time.
  - In the settle pass, which has no action in hand, it is `computeNext(root, ctx, canonNow, cfg, { scope: t => t === target })`.
  - For the target-less key `-`, the scope is `t => t === undefined`.
- **`takeBack`.** For each such aside, it derives `now` again. If `progressKey(…) !== key0`, it deletes the aside and prints `drive: taken back — <target> · <now.line>`.
- **Never taken back:** `stuck`, `capped` and `merge`.
- **The report.**
  - A target-less conversation whose line carries `--ask aN` prints `wait: conversation · brainstorm · ask aN`, followed by its `run:`.
  - Without an ask, the report prints `nothing queued — /witness <what to build> in a chat`. That line counts as no wait.

- [ ] **Step 1: Write the failing tests.**
  1. `a need satisfied mid-run is started in the same run`. This is design-doc probe P1, inverted. Plans `auth-refresh-plan-1` (blocked by `ses-prod`) and `auth-mfa-plan-1`. The `auth-mfa-plan-1` session's fake agent runs `<tsx src/bin.ts> satisfy auth-refresh-plan-1 --need ses-prod`; reuse `witnessCli()` from this file. Assert that `seen` contains `auth-refresh-plan-1`, and that `out` contains `drive: taken back — auth-refresh-plan-1 · witness start auth-refresh-plan-1`.
  2. `a target taken back to a new human stop waits again without a session`.
     - Setup: an ask is queued, so `-` is set aside as a conversation; the ask outranks the start (row 176). One approved plan's session runs `<cli> ask "second"`. Use `{ maxSpawns: 1 }`, so the ceiling ends the run before the plan's own lane is judged for progress.
     - Assert that `seen` never contains `-`.
     - `out` contains `drive: taken back — untargeted work · witness recap --file <recap.json> --ask a1`.
     - The report names the conversation exactly once and reports no `stuck:` line.
  3. `an empty queue is reported, not waited on`: autonomy on, no effort, no ask. `out` contains `nothing queued — /witness <what to build> in a chat` and `drive: done — 0 merged · 0 wait on you`.
- [ ] **Step 2: Run and see FAIL.** `pnpm exec vitest run tests/drive.test.ts tests/drive-report.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see PASS.** `pnpm typecheck` exits 0.
- [ ] **Step 5: Commit.** `git commit -am "feat: drive takes back what a human moved (D194)"`

### Task 6: Skills, the engine, the config comment, README and DESIGN rows

**Files:**
- `plugin/skills/witness-brainstorm/SKILL.md`:
  - the frontmatter `description` drops `; under autonomy it drafts the recap from the queued ask with no interview`;
  - delete `## Under \`autonomy: on\`` (`:36-44`).
- `plugin/skills/witness-design/SKILL.md`:
  - `## Under \`autonomy: on\`` keeps one paragraph: *the CLI settles the critic's rounds and prints `decided: … → revise` with a revise-context; re-author, register, `--open` and re-gate, showing the human each new look; when the critic is clean the CLI stops at the kept stop `design look` — render the gate output; the human approves or sends a note*;
  - delete its New screen, Amend and `Never run … --open` bullets.
- `plugin/commands/witness.md`:
  - the `launch:` row (`:30`) and the `watch:` row end with: *then, if `next:` names `witness decide` or a `stage:` is printed, act on it by the rows below — this chat keeps the human's work while drive runs the rest; otherwise END YOUR TURN*;
  - add a row: *`kept-stop:` lines that `next` prints are stops the human settles outside this chat (a trust grant in a terminal, an unmet need): render each verbatim once and never ask about them*.
- `src/settings.ts:151`: the comment from Global Constraints. Regenerate README's settings block from `settingsTable()`; `tests/settings-docs.test.ts` prints the expected block.
- `README.md`:
  - the autonomy paragraph (`:227-236`) gains: *Brainstorm and design stay conversations with a human in every mode: `/witness` starts drive for the machine work and keeps the human's own items — decisions left for them, asks to grill, looks to design — in the chat.*
  - drive's verb row (`:288`) drops `[--ask "<text>"]`.
- `DESIGN.md`:
  - rows 177 and 178 get the prefix `**Superseded by 194:**`, plus one line saying what remains;
  - row 175: "stay conversations until plan A2" becomes "stay conversations";
  - row 176: drop `parked` and the empty-queue rule under autonomy;
  - row 180: conversations in every mode, `--ask` gone, take-back (195, 196);
  - row 191: the turn no longer ends at the drive handoff when the chat has a conversation;
  - add rows 194, 195 and 196 (titles in spec §5), with their Choice from spec §4.1–4.3 and their Why from spec §1 and probes P1, P2 and P4;
  - the rationale-trail paragraph gains a `Rows 194–196 (⊜) added …` sentence, the way rows 192 and 193 did;
  - re-read Open/deferred's `planWriteAction has no ask under autonomy` bullet against the new routing, then fix or remove it.
- `tests/skills.test.ts:259-291`:
  - A8 loops over the skills except `witness-brainstorm`, and asserts brainstorm has no autonomy section;
  - "names what changes per stage" drops the brainstorm line;
  - the design A6 case asserts `the kept stop \`design look\`` and `not.toContain('Skip the directions-and-converge conversation')`;
  - the brainstorm A6 case asserts `not.toContain('there is no interview and no confirmation')` and `not.toContain('Never pass \`--manual\` yourself')`.

- [ ] **Step 1:** Edit `tests/skills.test.ts` as above. Run `pnpm exec vitest run tests/skills.test.ts` → FAIL.
- [ ] **Step 2:** Edit the skills, the command, `src/settings.ts`, `README.md` and `DESIGN.md`.
- [ ] **Step 3:** `pnpm exec vitest run tests/skills.test.ts tests/settings-docs.test.ts tests/verb-usage.test.ts tests/prompts.test.ts` → PASS.
- [ ] **Step 4: Commit.** `git commit -am "docs: conversations in every mode — skills, engine, README, rows 175–180, 191, 194–196 (D194)"`

### Task 7: Verify and hand over

- [ ] **Step 1: Full suite and typecheck.** `pnpm typecheck` exits 0. Run `pnpm test`, then `grep -c AssertionError` on its output, which must give 0.
- [ ] **Step 2: Read-only fewhats differential.** `git clone --local ~/x/personal/fewhats.com "$SCRATCH/fw"`. In the clone, with `CI=true` so nothing settles, run `next` and `status` with `npx -y @popovych.co/witness@0.21.1` and with `node dist/bin.js` (after `pnpm build`).
  - Only two differences are expected: a human item routed ahead of a flow, and the `asks` table.
  - Explain any other difference before going on.
- [ ] **Step 3: Reviews.** Two opus reviewers, from different angles: code against this plan, and behavior against spec §4.1–4.3. Re-run every finding before acting on it, then do one fix pass, red to green.
- [ ] **Step 4 (HUMAN):** push and open the PR (the agent does this when asked). The user merges, then runs `pnpm release minor` → 0.22.0, and pushes main and the tag (the agent does this when asked).
