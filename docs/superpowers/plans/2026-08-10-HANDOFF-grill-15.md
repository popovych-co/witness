# Handoff — grill #15, the decision block (DESIGN rows 119–130)

**Written 2026-08-10.** Read this before touching any of the five plans in this directory.

---

## 1. State of the world

| | |
|---|---|
| **Decided** | DESIGN.md rows 119–130 (symbol `⊗`), plus amendments to 121, 122, 123 |
| **Built** | Nothing. Zero lines of `src/` have changed. |
| **Committed** | Nothing. `DESIGN.md` is modified; the six files in this directory dated 2026-08-10 are untracked. |
| **Published** | `@popovych.co/witness@0.10.0` is on npm (`dist-tags: { latest: '0.10.0' }`), and `main` is at `3eacef7` with PR #8 merged. |
| **Branch** | `main`, otherwise clean. |

Nothing in this handoff has been verified by a build. Everything in it *has* been verified by running the CLI — see §6.

---

## 2. What this work is

Every place the CLI asks a human to choose now ranks the choices: a recommended option with a runnable command and a one-line why, each alternative with when it wins and what it costs, and a `run:` line that pastes.

The requirement came from the user in one sentence: *"every time the witness asks for a user decision it should provide a recommended approach (with a note if needed), why it was chosen; and with a strongest alternative (also with a note if needed), when to use it and the tradeoff over recommended if any."*

Two constraints shaped everything downstream:

- **The recommendation is CLI-computed from journal facts, never from reading what a finding says.** A model-authored recommendation is an uncalibrated, unjournaled verdict delivered by the party the stop exists to exclude (rows 48, 88). The recommender reads `blocking`, `anchor`, `contradicts_pin`, `outcome`, `standing`, `manual`, check `ok`, and journal state. Code that inspects a finding's `claim` text is a defect.
- **Band-aids are accounted for, not just labelled.** Every option carries a depth (`root` / `deferral` / `terminal`); a deferral is never recommended without naming the act that discharges it; and taking one mints a durable obligation. This encodes a standing preference of the user's: prefer the root fix, and treat a re-patched seam as an architecture signal.

---

## 3. Five live defects this ships against

All five were reproduced by running the CLI in a seeded test repo, not by reading source.

1. **`decide --show`'s exits line is mangled.** It goes through `kv()`, which escapes on `,` or `"`, so the below-bound set renders `exits: "witness decide … --revise --note ""<why>"" …"` and pastes into a shell as an empty `--note`. The gate prints the same string clean through a template literal. **Conditional**: the bound set has no quotes and renders fine, which makes it a defect nobody reproduces first try. → D120
2. **Nine hand-copied exits sets.** Four in CLI code (`gate.ts:286`, `gate.ts:427`, `ship.ts:226`, `ship.ts:231`), five in skill prose (`witness-plan:91`, `witness-implement:85`, `witness-decompose:97`, `witness-design:80`, `witness-ship:39`). Every one omits `--revise --upstream`; none knows the bound set or the repair grant. `ship.ts:226` prints an approve-only line *directly beneath* the gate's own complete one. All five skill copies contradict `/witness` line 29, which orders the CLI's line rendered *"verbatim — never a remembered set"*. → D119, D128
3. **Two literal placeholders ship.** `--revise --note "<why>"` and `--revise --upstream <id>`, the second from a **default parameter** on `liveExits`, defended by a comment claiming the gate and decide surfaces cannot resolve the upstream. They can — `decide.ts` loads canon at `:75`. → D129
4. **`--stop` is inert.** `next.ts` contains zero references to it; `gateSettled` settles only on `approve` or a passed run. After `decide … --stop`, `--show` says `settled — stop` while `next` and `status` say re-gate and the gate answers `resume`. A stall with contradictory reporting, not a livelock — `resume` appends nothing, so no rounds burn. → D124
5. **A malformed round is offered as a decision.** `pendingDecision` returns any run whose outcome is not `passed`, so a round where the battery emitted three schema violations and no verdict routes to `--show` and offers `--approve` — stamping an artifact on zero judgment. → D126

---

## 4. The plan chain, and why the order is not negotiable

```
0.10.1  exits-line-honesty          D119, D120, D129          8 tasks
   ↓
A       gate-semantics-A            D124, D126                4 tasks   ┐
   ↓                                                                    │
B       decision-block-B            D121, D123, D129½, D130   8 tasks   │ all
   ↓                                                                    │ 0.11.0
C       obligations-C               D122                      7 tasks   │
   ↓                                                                    │
D       skills-and-release-D        D125, D127, D128 + rel.   4 tasks   ┘
```

- **0.10.1 first** because everything after it calls `liveExits(gate, target, entries, stale, upstream)` with the required fifth argument and uses `cmd()` for raw command emission.
- **A before B** because B's spent-ladder rule recommends `--stop`. Recommending a known-inert exit would ship defect #4 as a feature.
- **C after B** because C consumes B's depth labels and the `anchor` field on `DecisionEntry`.
- **D last** because its skill ground rule describes a block that must already print. Writing it earlier ships an instruction for a screen the CLI does not have.

0.11.0 is one release across A–D — **one version bump, in Plan D, at the end**. Plans A, B and C must not touch `package.json` or any payload pin.

---

## 5. Exact next commands

```bash
git add DESIGN.md docs/superpowers/plans/2026-08-10-*.md
git commit -m "docs: grill #15 decisions (DESIGN rows 119-130) + 0.10.1 and 0.11.0 execution plans"
git checkout -b exits-line-honesty-0.10.1
```

Precedent for the design-and-plans commit on `main`: `f132a35 docs: grill #12 decisions (DESIGN rows 93-101) + 0.5.2 execution plan` — two files, no code.

Then execute `2026-08-10-exits-line-honesty-0.10.1.md` task by task.

**Execution mode: subagent-driven, with one deviation — Tasks 3 and 4 go to a single worker.** Task 3 deliberately leaves the build broken so the compiler enumerates every unmigrated `liveExits` call site; that failure *is* the migration checklist. A fresh agent handed Task 3 alone will "fix" the build by restoring the `upstream = '<id>'` default, which is the exact defect being removed. The plan warns about this in Task 3 Step 7, but a subagent reading only its own task will not see a neighbouring task's warning.

---

## 6. Landmines

**Verify by running, not by reading.** Five probes ran during this grill; four changed a row. Reading `next.ts` correctly established that `--stop` is inert, but only running it revealed that `decide --show` positively contradicts `next` about the same state. Reading `gate.ts` established that the bound branch was hand-copied; only running it showed `witness abandon` is offered there and `liveExits` never returns it — which would have been silently deleted by the collapse. **Write a throwaway `tests/zz-*.test.ts`, run it, read the output, delete it.** Cost is about two minutes.

**Bounded fork pool.** `npx vitest run --poolOptions.forks.maxForks=4`. The default pool causes IPC timeouts and produces false failures on this suite. Redirect to a file rather than piping to `tail`.

**The payload pin lives in 8 files, not 7.** Six skills, `plugin/commands/witness.md`, **and `plugin/hooks/session-dashboard.sh`** — that last one is easy to miss and was missed while writing the 0.10.1 plan. `grep -rn "witness@<version>" plugin | wc -l` before and after every bump.

**No release in this system is CLI-only.** `installPayload` copies payload files verbatim (`install.ts:107`) and the pin is literal text inside them. A repo whose skills pin `@0.10.0` will never run a 0.10.1 CLI. An earlier version of the DESIGN status paragraph claimed otherwise; it has been corrected.

**There are no timestamps anywhere.** The gate-run entry carries none, and there is no turn concept — every invocation is a fresh process reading a journal. Anything expressed in wall-clock is unbuildable; age is expressed in rounds. This is also why the double-print of the block in a driven `/witness` turn cannot be de-duplicated, and why that duplication was accepted rather than engineered around.

**Publishing** (Plan D, Task 4, Step 7) needs `npm publish --otp <code>`, and cold verification must run from a directory **outside this repository** — a local-project resolution inside the repo shadows the registry and gives a false result either way.

**Never merge the PR.** Merging is the human's act on GitHub; the lazy stamp finishes the lifecycle on the next scan.

---

## 7. Risks carried into the build

**Plan C has a known hole, deliberately not closed.** Task 7 discharges an obligation whenever a non-malformed run does not report its anchor. If the lens that raised the finding was dropped from that run's battery — a class-scaled battery, or a `skipLenses` entry — the anchor *cannot* be reported and the debt closes with nobody looking. The narrow fix is to record `lens` on the `deferral` entry at mint time and gate discharge on it. It is out of the plan because the entry does not carry `lens` today. **If the first real run shows spurious discharges, add the field and record a new DESIGN row — do not patch it quietly.**

**Plan C's injection makes every override cost a battery.** Open obligations join `prompts_sha`, so minting one invalidates the verdict cache and the next round re-invokes the full battery. That is the designed cost — the battery must judge with the deferral in view — but it will appear as tokens in the first field report, and it should not be diagnosed as a caching bug.

**Plan B's rule table ends in a catch, not a throw.** An unanticipated state falls through to `manual-stop`, producing a wrong label rather than a crash. That is the intended failure direction. The "exactly one rule matches" property only covers the four states enumerated in Task 8.

**Plan A changes routing for every gate in every repo.** Its full-suite triage step distinguishes *a test pinned the old behavior* (update it) from *something depended on stop being inert* (stop and report). Do not blur the two.

**One residual is admitted in the design and not solved.** Row 121 makes `--approve` the named default at the three stops north star 3 reserved for human judgment (ship, design, feature decompose). The `judge-first:` line mitigates it; it does not cancel it. Row 130 is what makes the cost measurable — if `reserved-stop-clean` fires often and is rarely overridden, look at how fast those approvals arrive before concluding the rule is right.

---

## 8. Working conventions that produced this

- **One question at a time, each with a recommendation** — and, after a mid-session correction, **each with the screen it produces**. Rendered comparisons changed three decisions that prose had not.
- **`rec` / `recomm` means adopt the recommendation** and move to the next question.
- **Defects found while executing get recorded in the DESIGN rows**, not quietly fixed. Rows 75, 77 and 106 already follow this; three rows in this grill were corrected the same way before a line was built.
- **Full prose in design discussion**, even when the caveman output hook is active.
- **DESIGN.md gets one revision pass at the end of a session**, not incremental edits per answer.

---

## 9. If you are a fresh session picking this up

1. Read `DESIGN.md` rows 119–130 and the `⊗` paragraph in the status blockquote at the top. That paragraph carries the reasoning, the corrections, and the release split.
2. Read this file's §3 and §6.
3. Read `2026-08-10-exits-line-honesty-0.10.1.md` end to end before writing code.
4. Reproduce at least defect #1 with a throwaway probe before fixing it. If it does not reproduce, something changed — stop and report rather than building against a stale claim.
