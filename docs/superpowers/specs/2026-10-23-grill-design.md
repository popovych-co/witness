# Grill: brainstorm and design talk with a human; drive runs the rest

Date: 2026-10-23 · Status: approved 2026-10-23 (grill Q1–Q8, played back and confirmed "conf" after three verification passes) · Evidence: probes P1–P5 (§6)

## 1. Why

The user, verbatim: "we should reconsider how drive works, it shouldn't be used for brainstorming and design sessions, and brainstorm session should look more like matt pocock grill session".

Each cause below was checked against the code or a probe:

- **Under autonomy, drive runs brainstorm and design with nobody in the room.** `classifyAction` treats both as conversations only when autonomy is off (`src/drive.ts:75`). Row 178 made both headless under autonomy. Brainstorm drafts the recap from the one-line ask, and an arbiter checks the draft against that same line (row 177). Design authors the look and gates it before anyone has opened it.
- **A chat never interviews under autonomy.** `/witness <words>` queues the ask. `next` then prints `stage: brainstorm` and `launch: witness drive --detach` (P2). The engine's first row runs the launch and ends the turn (`plugin/commands/witness.md:30`).
- **The interview drifted from grill-me into a form.** The stage table still calls brainstorm a "stateless interview (grill-me style)" (DESIGN.md:29). The skill, though, walks five fixed topics (class, goals, non-goals, constraints, slices) and asks each with a five-field block (`plugin/skills/witness-brainstorm/SKILL.md:46-56`, row 125). Pocock's grill-me works differently: it walks every branch of the design tree, gives its recommended answer, and explores the codebase instead of asking.
- **The user's own answers show the gap (P5).** In the one real fewhats brainstorm, 7 of 11 answers took the recommendation, 4 were "verify yourself", and none picked the "strongest alternative" that every question carried. One "verify yourself" made the agent admit its alternative's rationale "was invented".
- **A grill's answers have nowhere to go.** The recap holds class, goals, non-goals, constraints and slice ideas (`src/verbs/recap.ts:17-26`). Specs are behavior-only, with exactly `## Motivation` and `## Behavior`. The plan stage never reads the recap: the plan skill never asks for it, the plan gate reads only `recap.class` (`src/gates/plan.ts:80`), and the plan critic's prompt holds the parent spec, the delta base and the plan, nothing else (`src/gates/plan.ts:69-75`). A chore's plan never sees even its own goals, because plans carry no `covers` (`src/verbs/write.ts:250`).
- **Drive drops a target a human moved mid-run (P1).** A set-aside target stays aside for the whole run (`src/drive.ts:395`, and nothing ever removes one). A need the human satisfied mid-run was never started, and the closing report said `0 wait on you`. The target vanished.
- **Brainstorm loses everything on session death.** "Session died mid-interview? Start over — nothing was persisted; that is the accepted cost" (`SKILL.md:84`). That cost was accepted for a five-field interview; a full grill is far longer.

**Decided by the user in this conversation** (each a one-at-a-time answer: y · 1 · rec · conf):
- **Q1:** Brainstorm and design are conversations with a human in every mode. The headless versions are deleted outright, with no setting to bring them back.
- **Q2:** Under autonomy, `/witness` in a chat starts drive for the machine work and keeps the turn. It lists the stops the human settles outside the chat, takes the conversations one at a time in `next`'s order, and ends with `watch:`. Drive takes back a target as soon as the human's act changed its next step.
- **Q3:** The recap carries numbered decisions. Specs carry them, and a chore's plan carries the whole recap. Decompose checks that each decision landed somewhere. `witness read <spec> --decisions` is a separate mode. The plan critic blocks a plan that contradicts a decision, and a changed decision re-queues the plans that carry it.
- **Q4:** A grill question is in plain words with up to three ranked answers, the pick first, never padded. The agent explores before asking and checks every claim before showing it. The user's own words: "grill questions should provide 3 recomendations if possible".
- **Q5:** The grill walks the whole tree, infers the class, has no short form, and ends with a critique pass, then a playback, then a yes.
- **Q6:** Each settled answer is saved to a local draft, so a dead session resumes.
- **Q7:** Design shows up to three ranked directions on one comparison page, screenshot-checked before it opens.
- **Q8:** A design answer that changes behavior becomes a recap decision.

Calls marked *(my call)* are the designer's. §11 lists the ones to check while reading.

## 2. Goals, non-goals, anti-goals

**Goals**
- g1. Every recap and every look comes out of a conversation with a human, in every mode. Drive authors neither.
- g2. Under autonomy, a human who types `/witness <ask>` is grilled in that chat while drive builds everything else in the background.
- g3. The grill reads like Pocock's grill-me: the whole tree, one question per turn, ranked recommended answers, the repo explored before the human is asked, every claim checked before it is shown.
- g4. Every answer the grill settles reaches the stage that acts on it, and a gate checks that it arrived.
- g5. A dead, rate-limited or relayed session loses no settled answer.
- g6. The design session shows its directions rendered and checked, before it asks which one.
- g7. Drive picks up whatever a human moved during its run, and its report never hides a target.

**Non-goals**
- n1. Who settles a gate stop under autonomy is unchanged: the policy, the arbiter and the kept stops all stay. The only exception is the recap check, which goes.
- n2. Decompose, plan, implement and ship keep running headless under drive.
- n3. No glossary or ADR upkeep (grill-with-docs). Witness's specs are the domain record.
- n4. Drafts don't travel between machines.
- n5. No new harness UI such as pickers. Plain text works on every harness witness supports.

**Anti-goals**
- Asking the human something the repo can answer.
- Keeping a headless path "just in case" behind a setting.
- Padding a question's answers to reach three.

**Constraints**
- c1. Witness-only. Upgrading a consumer is the user's call, made separately.
- c2. An upgrade must not re-queue an existing plan, and must not leave a consumer's tree dirty.
- c3. Build after D192 lands. Both changes amend row 191.

## 3. Evidence

### 3.1 The one real brainstorm and design session (fewhats, 2026-09-17, P5)

- **Brainstorm: 16.5 minutes and 11 answers, from `stage: brainstorm` to "conf".**
  - Answers: "recom", "feat", "verify yourself", "as recom", "verify yourself", "10", "verfiy yourself", "as corrected", "as recom", "verify yourself", "conf".
  - Each "verify yourself" came right after the agent proposed a batch: seven goals, ten non-goals, eight constraints, nine slices.
- **Design: describing the directions in words didn't work.**
  - The agent described three layouts in words. The user answered "show me visually in html" (22:12).
  - The agent then built all three as one comparison page and opened it (22:14:01) **before** screenshotting it (22:14:10). The screenshot showed the app bar broken in all three, so the user probably saw that first. Two more render bugs were caught by later screenshots.
  - Seeing the real layouts, the user made the session's one real design steer: "groups/folders with ability to colaps them and reorder" (22:17).
- **The steer changed behavior, and the recap was the only place that could settle it.**
  - The steer contradicted the recap's non-goal `n10`. The design session edited the spec itself.
  - The decompose gate then stopped on two scope findings. One said "a contradiction between two recap facts… **Only the recap can resolve that**" (22:27).
  - That led to an upstream re-interview.

### 3.2 Consumers (P4)

| Repo | `autonomy` | asks | recap checks |
| --- | --- | --- | --- |
| fewhats.com | on | 0 | 0 |
| hear-your-customer-mvp | off | 0 | 0 |
| know-your-customer-mvp | unset (pins 0.14.4) | 0 | 0 |

Deleting row 177's machinery touches no existing data. fewhats has never run drive: there is no `.witness/drive.log`.

## 4. The design

### 4.1 Conversations in every mode *(Q1, the user's decision)*

- **`classifyAction` drops its autonomy guard on conversations** (`src/drive.ts:75`). Brainstorm, `witness recap`, and design authoring and showing are conversations in both modes. Drive never spawns a session for them. It sets the target aside as a conversation and names it in the report with the act: `run /witness in a chat`.
- **Deleted, from row 177:**
  - the arbiter's `recap` mode: `src/recap-check.ts`, `prompts/arbiter-recap.md`, and the recap branch of `src/arbiter.ts`;
  - `recap`'s `ask-required` / `ask-parked` / `class-change` refusals (`autonomyRefusal`, `src/verbs/recap.ts:214`) and `sentBack` (`:233`);
  - `recap --manual`. Every recap is now confirmed by a human, so the claim carries nothing, and the flag becomes an unknown option.
  - The decompose arbiter still reads the ask its effort was born from (`askOf`, `src/ask.ts:184`).
- **Deleted, from row 178:**
  - the gate that runs on a look nobody has seen. `gate design` requires `design-shown` in both modes again, so row 72 applies in full.
  - `next` routes a registered but unshown look to `--open` in both modes (`src/verbs/next.ts:827` loses `!cfg.autonomy`).
  - the `design look` kept stop's "the human opens the look" detail (`src/settle.ts`).
  - the brainstorm skill's `Under autonomy: on` section, and the design skill's autonomy rules for authoring and opening. Its gate paragraph stays, because under autonomy the policy still settles the critic's revise rounds (§4.7 step 7).
- **Asks:** the queue stays in both modes (row 176).
  - `parked` goes. `askQueue` stops deriving it (`src/ask.ts:82-84`), and `nextAsk` loses its autonomy parameter (`:177-179`). An old recap-check entry stays as history that `log` and `status` still print; none exist (P4).
  - `drive --ask` goes (`src/verbs/drive.ts:82`). Drive never grills anything, and `witness ask` and `/witness <words>` already queue asks.
- **Row 176's "Under autonomy with no ask `next` says nothing is to be built" goes** (`src/verbs/next.ts:751-757`). With no ask and no effort, `next` routes to the grill in both modes. A chat starts it. Drive sets it aside, and its report says `nothing queued — /witness <what to build> in a chat`.

### 4.2 The chat under autonomy *(Q2, the user's decision)*

In an unmarked chat session that prints `autonomy: on` and is not `--manual`-armed, `/witness`:

1. **Starts drive.** When drive has machine work, `next` prints `launch: witness drive --detach`, or `watch:` while a drive runs, exactly as today (`src/verbs/next.ts:1094-1109`). The chat runs the launch and **keeps the turn**.
2. **Lists the stops settled outside the chat, once each, with the exact command.** These are trust grants (answered in a terminal, per the kept stop's own detail, `src/settle.ts:104`) and unmet needs (`witness satisfy …`). They are shown, not asked.
3. **Takes the conversations one at a time, in the CLI's order.** `next` computes the order over the ladder with machine work removed, the way `driveHasWork` already filters out the human's stops (`src/verbs/next.ts:933-948`). The ladder's own order holds: tier 2's decisions before tier 3's asks, asks oldest first (row 176), then looks to design.
   - A decision the arbiter could not make is rendered with `decide --show`, and the human names an option.
   - An ask gets its grill (§4.4).
   - A look gets its design session (§4.7).
4. **Ends** with the `watch:` line when nothing is left for the human.

`next`'s output for that session is the first human-owed action (`next:`, `stage:`, `target:`, `ask:`), the notices, and the `launch:` or `watch:` line. The `/witness` row for `launch:` changes from "run it and END YOUR TURN" to "run it, then act on the `stage:` it printed, if any".

Row 191: `turnEnds` (`src/verbs/next.ts:1101`) no longer counts the drive handoff as the end of the turn when a conversation follows. The context guard therefore covers the chat's conversations.

### 4.3 Drive takes back what a human moved *(Q2's point 5, the user's decision; the mechanism is my call)*

- **The rule.** On every fill, each target set aside as `kept`, `decision` or `conversation` is derived again through its scoped `next`. If its action line differs from the line it was set aside on, it leaves the aside set and competes for a slot like any other target.
  - `stuck` and `capped` stay aside, because they are drive's own verdicts about its own sessions.
  - `merge` stays aside too; the merge stamp lands on the next derivation.
- **The settle pass records the action line it set aside on**, not only its `kept-stop:` line, so the two lines can be compared.
- **The report derives every target still aside at the end once more and prints its current line.** A target the human moved can no longer vanish (P1).
- **The conversation help line names `/witness` in a chat.** It drops "then re-run witness drive" (`src/drive.ts:413`), because drive now takes the target back itself.

### 4.4 The grill *(Q4, Q5, the user's decisions)*

**The shape of a question.** This amends row 125, and its "one shape everywhere" survives:
- **One question per turn, in plain words.**
- **Up to three ranked answers, using the CLI block's own fields (row 121).** Answer 1 is the pick, with its `why`. Answers 2 and 3 each carry `when` (better if…) and `tradeoff` (the cost). A question gets fewer answers when fewer real answers exist, and is never padded to reach three.
- **The human replies `y` or `1` for the pick, `2` or `3`, or in their own words.** A number in a grill picks one of the agent's answers. It is not a `witness decide` option; D143 still governs CLI blocks, and the skills' ground rules say so.
- **Explore before asking.** Any question the repo can answer (code, canon via `witness index` / `witness read`, product docs, journals), the agent answers itself, stating what it found with `file:line`. Only intent, priorities, taste and facts outside the repo reach the human.
- **Check before showing.** Every factual claim in a question is verified by a file read or a probe before the human sees it.

**The walk.** This amends row 156: the recap's fields stay the floor, and the walk goes past them.
- **Order, by dependency:** the problem and who has it → scope edges → behavior, including edge cases and failures → data and approach → rollout and compatibility. Branches the repo already answers are skipped.
- **Class is inferred by today's rules** (a fix restores promised behavior; a chore changes no state; anything else is a feature). It is shown in the playback, and asked only when unclear.
- **No short forms for fixes and chores.** Their trees are small, so their grills end fast.
- **Out of bounds:** the look (that's the design session) and the order of steps (that's the plan).
- **The end:**
  1. Once no open branch would change what gets built, the agent runs one critique pass over the whole set from the human's seat, and probes each finding.
  2. Then comes the playback table: class · goals · non-goals · constraints · decisions · slices.
  3. Then an explicit yes.
  4. Then `witness recap --ask <id>`, or `--amend <effort>` for an amendment.

### 4.5 Numbered decisions *(Q3, the user's decision)*

This amends rows 38 and 52.

- **The recap gains `decisions: [{id: "d<n>", text}]`.** It is optional, and absent means none. Each decision is one settled answer, written as a plain statement, and is validated like goals (`idTextList`, prefix `d`).
- **Where an answer goes:**
  - goals are outcomes;
  - non-goals are deliberate noes;
  - constraints are standing limits on the whole effort;
  - decisions are settled answers that shape at least one spec, in behavior or in approach.
  - An answer that shapes no single spec is a constraint or a non-goal instead.
- **Features and fixes.**
  - The write manifest gains `carries: [d-ids]` next to `covers`. It is journaled in the write entry and never in frontmatter (row 38's rule).
  - At write time, every id must exist in the latest recap; otherwise the write is refused with `unknown-decision`.
  - At the decompose gate, a new `decision-coverage` check requires every decision to be carried by at least one spec. There is no reverse rule: a spec may carry no decisions.
  - The gate's prompt body gains a decision table next to the goal-coverage table (`src/gates/decompose.ts:78-84`).
  - The slicing critic treats two things as blocking: a spec that contradicts a decision it carries, and a behavior decision missing from the Behavior section of the spec that carries it.
- **Chores.** A chore writes no specs and never reaches decompose (`src/verbs/next.ts:764-776`). Its plan therefore carries the whole recap: goals, decisions, constraints and non-goals.
- **Reading: `witness read <spec> --decisions`.** It is a mode next to `--design`, and its output never mixes into the artifact's own lines (`src/verbs/read.ts:84-89` keeps one line array for the whole file, the outline and slices).
  - It prints the decisions the spec carries, taken from the latest write of its latest effort, plus that effort's constraints and non-goals.
  - `witness read <effort> --decisions` prints a chore effort's whole recap.
  - The plan skill reads this before authoring.
- **The plan gate.** The plan critic's prompt (`src/gates/plan.ts:69-75`) gains the same lines, and a plan that contradicts one of them is blocking. A chore plan's prompt gets the chore's whole recap.
- **Staleness.**
  - Today a plan's basis is its parent spec's content sha.
  - It becomes the spec sha plus the text of the decisions that spec carries. It stays **exactly the spec sha when the spec carries none**, so no existing plan re-queues on upgrade (c2).
  - A changed carried decision moves the basis, and the plan re-queues the same way it does for an amended spec (D157/D160's queue).
- **The design stage reads nothing new.** Decisions a user can see are already in the spec's Behavior.

### 4.6 Drafts *(Q6, the user's decision; the key and the exemption are my calls)*

- **Saving.** After each settled answer, the skill hands the growing draft to the CLI, for example with `witness recap --draft --ask <id> --file <json>` (or `--amend <effort>`). The CLI checks its shape, not whether it is complete. It writes `.witness/drafts/ask-<id>.json` (or `amend-<effort>.json`). The draft is never committed and never journaled.
- **Resuming.** On an ask that has a draft, `next` prints `draft: <n> decisions settled · resume`. Such an ask routes before other asks *(my call: finish what you started)*. The skill reads the draft back through the CLI and continues after the last settled answer.
- **Ending.** A confirmed `witness recap` deletes the draft, and so does `witness ask --withdraw`. A draft whose ask was answered somewhere else is ignored by `next` and deleted by the next write to that ask.
- **The key: every grill starts by queuing an ask** *(my call)*.
  - `/witness <words>` already queues one.
  - A bare `/witness` with nothing queued opens with "what do you want to build?" and queues the answer before the first real question. `witness ask` has no autonomy gate (`src/verbs/ask.ts`).
  - Side effect: every new effort has the human's own words on record.
- **The exemption is load-bearing *(my call)*.**
  - `.witness` is a state directory (`src/gitio.ts:57`). An untracked file under it reads as a hand edit (`dirtyStatePaths`, `src/gitio.ts:115-121`). `stateCommit` refuses while one exists (`:175`), and `check` reports an error (`src/verbs/check.ts:277`).
  - `init` never adds lines to an existing repo's `.gitignore` (`src/verbs/init.ts:115`).
  - So `.witness/drafts/` is exempted by prefix in `dirtyStatePaths`, following row 90's precedent ("the exemption is load-bearing rather than belt-and-braces"), and `init`'s block lists it for new repos.
- **Relay.** This amends row 191.
  - Row 191 counts an act only as a journal entry carrying the session, and a draft save is not one.
  - For brainstorm and design, a draft save is made to count as an act. A session past its context limit then hands over at the next settled answer, and the fresh session resumes from the draft.
  - This settles row 191's recorded residual, "`next` cannot tell a session mid-interview".
  - The skills' "Finish the act you are in (here: the interview, through its recap)" becomes "(here: the answer you are on)".
- **Design drafts** use the same store, keyed by spec: the chosen direction, the settled answers, and the current page.

### 4.7 The design session *(Q7, the user's decision)*

This amends row 125's design clause.

1. **Context**, as today.
2. **Directions, rendered.** Up to three ranked structural directions, side by side on one self-contained comparison page, using the spec's real content.
3. **Check before showing.**
   - Screenshot the page with whatever browser the machine has (headless Chrome worked in fewhats), fix what is broken, and check again.
   - With no browser available, say "not checked" when opening it. Never claim a check that didn't run.
4. **Open it as a preview.** `witness design <spec> --preview <html>` opens the page through the configured opener (`WITNESS_OPENER` / `opener:`). It registers nothing and journals nothing; row 72's `design-shown` stays reserved for registered bytes.
5. **Converge.** Ask which direction, in the grill's shape (§4.4), pick first.
6. **Author the full look**, with every state the spec promises, and check it the same way.
7. **Register, show, gate.**
   - Run `witness design <spec> --file`, then `--open` (row 72, now in both modes), then `witness gate design`.
   - Under autonomy, the policy settles the critic's revise rounds. The `design look` kept stop is where the human, who is present, approves.
   - Without autonomy, the human decides each round, as today.

### 4.8 A design answer that changes behavior *(Q8, the user's decision)*

- **The session pauses the look.** When the human's answer adds or changes something the screen *does*, not only how it looks, the session checks the change against the recap and amends the recap with it as a numbered decision (`witness recap --amend <effort>`). The human confirms that decision.
- **A clash is settled in the same amendment.** If the change clashes with a non-goal or a constraint, the amendment settles it with one question in the grill's shape.
- **The amendment re-arms decompose (row 52).**
  - Drive updates the spec, and its gate runs; under autonomy, the arbiter settles the scope stop.
  - The look is then pending again on the amended spec, and drive's report and notification say so.
- **The design draft keeps the chosen direction, the answers and the page.** Nothing is redone.

### 4.9 What is removed

- `src/recap-check.ts`, `prompts/arbiter-recap.md`, and the arbiter's recap mode.
- The `ask-required`, `ask-parked` and `class-change` refusals, and `recap --manual`.
- The `parked` ask state, and `nextAsk`'s autonomy parameter.
- `drive --ask`.
- The unseen design gate, and the autonomy branch of `next`'s design routing.
- The `design look` "opens the look" detail.
- `next`'s "nothing to build" rule under autonomy.
- The brainstorm skill's autonomy section, the design skill's autonomy rules for authoring and opening (its gate paragraph stays), and the brainstorm skill's "Stateless by design" section (Part C).
- The tests that pin each of these:
  - `tests/recap-check.test.ts` (16 cases);
  - the `arbiter-recap` case in `tests/prompts.test.ts:85`;
  - `tests/design-autonomy.test.ts`'s two unseen-look cases (`:18`, `:24`). Its "the human opens the look before approving it" case (`:33`) stays and now holds in both modes;
  - `tests/next-ask.test.ts`'s "under autonomy with no ask there is nothing to build" (`:46`), which is inverted;
  - drive's "brainstorm runs headless under autonomy" (`tests/drive.test.ts:624`), which is inverted.
- `tests/arbiter-ask.test.ts` stays, because the decompose arbiter still reads the ask.

### 4.10 Docs, prompts and config

- **DESIGN.md prose:**
  - stage table row 1, brainstorm: the grill, with drafts and decisions;
  - the effort section (DESIGN.md:76-79): the recap carries decisions, and the interview no longer has to survive session death on its own;
  - the rows in §5.
- **README:** the autonomy section, and what brainstorm and design are.
- **`plugin/commands/witness.md`:** the `launch:` row (§4.2), and the stop conditions.
- **Skills:**
  - every skill's ground rules: a number in a grill is not a decide option, and the relay wording (§4.6);
  - `witness-brainstorm`: rewritten as the grill;
  - `witness-design`: the session (§4.7–4.8);
  - `witness-decompose`: `carries`, and the decision totality self-check;
  - `witness-plan`: `read --decisions`, and the chore plan carrying the whole recap.
- **Prompts:**
  - `slicing-critic.md`: decisions;
  - `plan-critic.md`: decisions, constraints and non-goals;
  - `arbiter-recap.md`: deleted.
- **Config:**
  - The `arbiter.model` comment loses "and checks recaps" (`src/settings.ts:151`).
  - Consumers get the new comment through `witness migrate`, which re-renders witness's own comments from the settings table and keeps human ones (`src/verbs/migrate.ts:152-153`).
  - `init`'s `.gitignore` block gains `.witness/drafts/`.
- **Tests:**
  - `tests/skills.test.ts:221-232`, row 125's pins, are re-pinned to the up-to-three-answer shape in the CLI's field words;
  - `:52-57`, row 156's floor phrase, stays.

### 4.11 Rollout

- **Witness only (c1).** fewhats (autonomy on), hear-your-customer-mvp (autonomy off) and know-your-customer-mvp (pinned to 0.14.4) upgrade only when the user asks.
- **What an upgrade shows:**
  - nothing new until a new ask arrives or a look is due;
  - no plan re-queues (§4.5);
  - drafts never dirty the tree (§4.6);
  - `witness migrate` refreshes the `arbiter.model` comment.

## 5. DESIGN.md rows

**Amended in place:**

| Row | Change |
| --- | --- |
| stage table, row 1 | Brainstorm: "stateless interview (grill-me style)" becomes the grill (197), with drafts (199) and decisions in the recap (198). |
| effort prose | The recap carries decisions; drafts (DESIGN.md:76-79). |
| 38 | Goal coverage gains decision coverage through `carries`. |
| 52 | An amendment re-validates decisions too, and decisions born in design land here. |
| 125 | The interview asks in the CLI's shape, with up to three ranked answers. The design session's converge question does the same. |
| 156 | The floor is the recap's fields; the walk is the whole tree. |
| 175 | "stay conversations until plan A2" becomes "stay conversations". |
| 176 | The `parked` state goes, and so does the empty-queue rule under autonomy. |
| 177 | Superseded by 194: there is no recap check. |
| 178 | Superseded by 194: brainstorm and design are no longer headless, and row 72 applies in full in both modes. |
| 180 | Drive never runs a conversation in any mode; `--ask` goes; drive takes back what a human moved (195, 196). |
| 191 | The brainstorm and design boundary becomes a settled answer, and a draft save counts as an act. The mid-interview residual is settled. |

**New rows** start at 194: 192 is D192's, still on branch `relay-cleanup`, and 193 is D193's.

| Row | Title |
| --- | --- |
| 194 | Brainstorm and design talk with a human in every mode |
| 195 | Under autonomy the chat keeps the human's work, and drive the rest |
| 196 | Drive takes back what a human moved |
| 197 | The grill |
| 198 | The recap carries numbered decisions to the stage that acts on them |
| 199 | A grill and a design session save as they go |
| 200 | The design session shows its directions, and a behavior answer goes to the recap |

## 6. Probes (2026-10-23)

- **P1. Drive, and a target a human moved mid-run.**
  - Setup: a temporary test, deleted afterwards, so the tree is clean. Plan A was blocked by an unmet manual need; plan B could start. B's fake session ran `witness satisfy A --need ses-prod` mid-run.
  - Result: drive never spawned A. The report read `drive: done — 0 merged · 0 wait on you · 0 parked · 1 stuck` and named only B. → §4.3.
- **P2. `/witness <ask>` under autonomy today.** `witness ask "add card payments"` followed by `witness next` printed `stage: brainstorm`, `ask: a1 — add card payments` and `launch: witness drive --detach`. → §1, §4.2.
- **P3. Drafts under `.witness`, checked by file reads:** `src/gitio.ts:57,94-121,175`, `src/verbs/check.ts:277`, `src/verbs/init.ts:115`. → §4.6.
- **P4. Consumers:** asks and recap checks counted in all three repos. → §3.2.
- **P5. The fewhats pi log** (session `2026-09-17T21-43-52`): the brainstorm answers and their timing, the design timeline, the steer and the gate finding. → §3.1.

## 7. Edge cases and residuals

- **Drafts live on one machine** (Q6, accepted). A grill started on a laptop doesn't resume on another.
- **A formerly parked ask reads as unanswered** and is offered for a grill. None exist (P4).
- **Two grills at once.** Two chats grilling two asks keep two drafts, keyed by their asks. Both conversations are the human's.
- **A design note given at the approval stop** follows §4.8 when it changes behavior. A note only about the look is still `--revise --note`.
- **A decision removed by an amendment.** Writes that carried it keep the id as history. Coverage and `read --decisions` read only the latest recap.
- **Drive notifies during a grill.** The human may get a notification while answering in a chat. Accepted.
- **The chat and drive both write state.** The repo lock serializes them (row 181). They never share a target, because drive sets conversation targets aside.
- **With no browser on the machine**, the design session says "not checked" rather than skipping the check silently.

## 8. Testing

- `classifyAction` returns conversations for brainstorm, recap and design in both modes.
- Under autonomy, a chat's `next` prints the human-owed stage together with `launch:`. The notices list trust grants and unmet needs, and the order is decisions → asks → designs.
- P1 inverted: a need satisfied mid-run is started in the same run, and the report names every target still aside, with its current line.
- `stuck` and `capped` targets are never taken back.
- Recap `decisions` are validated, and `carries` refuses `unknown-decision`.
- `decision-coverage` fails on a decision no spec carries.
- `read --decisions` prints a spec's decisions plus the effort's constraints and non-goals, and the whole recap for a chore effort. `--outline` and `--lines` are unchanged.
- The plan critic's prompt holds the decisions, and a chore plan's prompt holds the whole recap.
- A spec with no decisions keeps its plan's basis byte-for-byte. A changed carried decision re-queues the plan.
- A draft present under `.witness/drafts/` blocks no state commit, and `check` reports no error.
- A draft resumes through `next`; a confirmed recap deletes it, and so does a withdrawal.
- A draft save counts as an act for the relay.
- `design --preview` journals nothing, and `gate design` refuses `design-unseen` in both modes.
- Removed surfaces refuse as unknown: `recap --manual`, `drive --ask`.
- The skills tests are re-pinned to the new shape. The floor phrase stays.

## 9. Build order *(my call)*

Build after D192 lands, because both amend row 191. The work splits into three parts, each one fresh session and one release, as the autopilot build was:

| Part | Release | Scope |
| --- | --- | --- |
| A | 0.22.0 | Conversations in every mode, the chat under autonomy, drive taking targets back, and the removals (§4.1–4.3, §4.9) |
| B | 0.23.0 | Numbered decisions (§4.5) |
| C | 0.24.0 | The grill, drafts, the design session, and decisions born in design (§4.4, §4.6–4.8) |

- A ships the user's first ask first.
- B comes before C, because C's grill writes the decisions B defines.
- Between A and C, the old five-field interview runs as a conversation in every mode, and it still works.

## 10. Left to the builder

- Exact names: `--draft`, `--preview`, `--decisions`, `carries`, `decision-coverage`, `unknown-decision`, and the draft file names.
- The draft's JSON shape: the recap fields so far, plus the open branches.
- One basis function for plan pins, used everywhere a pin is compared: write, the plan gate, decompose's `amendment-ack`, `next`'s queue, and `witness diff`.
- Whether `migrate` rewrites a file whose only change is a witness comment.
- `turnEnds` and the handover guard for an autonomous chat that keeps the turn.
- The report's wording for conversations and for targets drive took back.

## 11. Calls for the user to check while reading

- Three releases (A, B, C) rather than one.
- An ask that has a draft routes before other asks.
- `recap --manual` is removed outright and becomes an unknown option, rather than staying as a no-op.
- Under autonomy, an empty queue opens a grill in a chat, and drive reports it as waiting.
- `witness read <effort> --decisions` accepts a chore's effort slug, the only non-canon id `read` takes.
- New rows 194–200 assume D192 merges first.
