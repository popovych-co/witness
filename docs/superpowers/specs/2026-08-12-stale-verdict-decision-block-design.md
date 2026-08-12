# The stale verdict has no block — design

*2026-08-12 · target release 0.11.1 · DESIGN.md row 131*

## The incident

A dogfood flow on `know-your-customer-mvp` sat at `implement · verdict-and-segment-depth-plan-1`, round 2 of 3, gate stopped with 13 findings (2 blocking). `witness next` named the decision surface; `witness decide implement … --show` rendered the run and ended with:

```
outcome: stopped
exits: witness gate implement verdict-and-segment-depth-plan-1
```

No ranked block. No `run:` line. No reason. The human asked why there was no recommended next step, which is the question D121 exists to answer on every surface.

The state was stale — the worktree moved after the battery read it:

```
reviewed_sha : 970d33b6d8f6879355311b3cff06de1e63d0bcd8878d00995120a12e3df6163b
current sha  : 598341a20c693fd8ee382ccc4a233113c7b61d629d6155fbddd35f91086dfe65
```

`recommend()` returns `undefined` at `recommend.ts:147` (`stale && !atBound`), so `decide.ts:137` falls back to `liveExits`, whose stale branch (`rounds.ts:283`) returns one command. Every layer behaved as written. The writing is what is wrong.

## What the doctrine says, and where it is over-general

Four sites state the same sentence, and each says a re-gate is *the only live act* while stale:

- `recommend.ts:146` — "stale below the bound: no decision exists, the caller renders the re-gate act"
- `decide.ts:133-134` — "`undefined` is stale below the bound, where no decision exists and the exits line's single re-gate act is the honest answer"
- `gate.ts:161-162` — "`undefined` from `recommend` means no decision exists at this state (stale below the bound, where the only live act is a re-gate)"
- `tests/decide-show.test.ts:72` — "a fake sha makes the state stale, where the only honest exit is a re-gate"

The sentence is true about `--approve` and false about everything else. Measured against the shipped CLI at a stale-pending decompose gate, round 1 of 3:

| Act | Exit | Result |
|---|---|---|
| `decide --stop --note` | 0 | `decided: … → stop` |
| `decide --revise --note` | 0 | `decided: … → revise` |
| `decide --revise --upstream` | 0 | `decided: … → revise-upstream` |
| `decide --approve` | 2 | `gate,stale-verdict,"verdict @deadbee, content @12abb3a"` |
| `decide --approve --override` | 2 | same refusal — the override answers the round bound, not staleness |
| `witness gate <gate> <target>` | 1 | runs; round 2 of 3 recorded. The recommended command is runnable verbatim, positionally, with no `--effort` form |

Three legal acts are advertised nowhere. That is the failure D119 was written to end, surviving inside the module written to end it. Staleness blocks **stamping** — approve asserts about current content — and does not block **judging**, because a stop or a revise is about the work, not about a sha.

## Where the sentence is right

The same probe, run against the **reopened** state (`decide.ts:103-112`, which reads the same `liveExits` stale branch), refuses every decide act:

```
--stop / --revise / --approve → exit 2
  gate,nothing-pending,…,a stopped gate-run awaiting a decision — run: witness gate …
```

So the single-act answer is correct there, and a blanket widening would put three refusing commands on the reopened screen — the D67 lie, introduced by the fix for D119.

The discriminator is `pendingDecision(entries, gate)`, and it is exact rather than heuristic. `decide.ts:216` resolves the anchor every decide verb needs as `pending ?? ((boundEndgame || revisedAnchor) ? last : undefined)`. Below the bound `boundEndgame` is false, and `revisedAnchor` requires `unchanged` (`decide.ts:214`) which is the negation of stale. So under `stale && !atBound`, an anchor resolves **if and only if** a decision is pending — the same condition, derived from the verb rather than guessed at.

## Design

Three seams, all inside the decision layer.

### 1 — `recommend.ts`: rule 2 returns a Decision

Rule 2 becomes `stale-below-bound`, firing when `stale && !atBound && pendingDecision(entries, gate) !== undefined`. Without a pending decision it still returns `undefined`, preserving today's behavior on the reopened and revised screens.

Options, ordered:

1. `witness gate <gate> <target>` — *why:* verdict and content disagree; no battery has read the current bytes, so every finding on screen describes bytes that no longer exist. *tradeoff:* spends a round — and names which, e.g. *round 3 of 3, the last before the bound*.
2. `witness decide … --revise --note "<prefill>"` — *when:* you already know the next edit and want no verdict on this state. *tradeoff:* spends no round now; the round is spent by the re-gate that follows.
3. `witness decide … --revise --upstream <id>` — omitted when no upstream resolves (D129).
4. `witness decide … --stop` — *when:* this work should not continue as scoped. *tradeoff:* parks the flow.

`--approve` is absent by construction: `decide.ts:269-280` refuses it with `stale-verdict`, and D129 forbids advertising an act that refuses. `--approve --override` is likewise absent — the override exists for the round bound, and the stale-verdict refusal fires above it.

The re-gate ranks first because it is the only act that produces knowledge: at a stale verdict nothing on screen describes the current tree, and options 2–4 are judgments made without one.

### 2 — `rounds.ts`: the stale branch learns the same distinction

`liveExits`' `if (stale)` branch returns the widened set when a decision is pending, and the single re-gate act otherwise. The block and the exits line then carry the same members in the same order in both states — the property D119 asks for, now state-aware rather than blanket.

### 3 — `decide.ts:293`: journal the staleness that actually held

`recommend({… stale: false})` is hardcoded so that a decision entry always receives `recommended` and `rule`. Measured consequence: a `--stop` taken at a stale state journals

```json
{ "decision": "stop", "recommended": "revise", "rule": "blocking-here" }
```

naming a rule that was never rendered — the surface showed a bare exits line. D130's `status` audit then reports `blocking-here · fired · overridden` for a rule that never fired, which corrupts the recommender's only feedback loop with rows it did not produce.

The hardcode was a workaround for the hole seam 1 closes: with no stale rule, honest staleness meant empty fields. It becomes `stale: nowSha !== undefined && nowSha !== anchor.reviewed_sha`, reusing the value already computed at `decide.ts:212`. No new derivation, no new I/O.

**What this buys, exactly.** It removes false rows; it adds no true ones. `recommenderRowsFrom` (`dashboard.ts:85`) skips any decision lacking `recommended`, and `stale-below-bound`'s option 1 is a *gate* verb, so `recommendedVerb` — a match on `--(approve|revise|stop)` — stays `undefined` and the row is dropped. The rule is therefore **structurally unauditable** under D130: following its recommendation writes no `human-decision` entry at all, and diverging from it writes one the tally ignores. The alternative, journaling `recommended: 'gate'`, is worse than silence — `decision.startsWith('gate')` is never true, so the rule would report 100% overridden while behaving perfectly, which is precisely the "same data, opposite effect" failure D130 was written against. Silence is the honest reading, and the residual is recorded below rather than papered over.

## What this change does not touch, and why

**`next.ts` keeps routing stale pendings to `decide --show`.** The first shape considered was widening tier 1 (`flowBlocked`) so the flow's own re-gate line answered instead. Rejected on evidence:

- A re-gate spends a round. Measured: from a stale round-1 state, `witness gate decompose` recorded `round: 2 of 3`; journal rounds `[1, 2]`. On the incident flow the re-gate is round 3 of 3, and the bound follows it.
- The agent contract makes the two routes behave differently. `plugin/commands/witness.md:29` — when `next:` names `witness decide`, the agent renders `--show` verbatim and **ends its turn**, and never runs `--approve`/`--revise`/`--stop` on its own judgment. When `next:` names `witness gate`, that is unattended motion.

So routing the stale pending to the gate would hand the last round to the driving loop to spend without asking. D121's own premise forbids it: *"every remaining act carries a cost, and which cost is worth paying is the whole question."* The routing is not the defect; the missing block is. `next` answers *who owes the next act*, `next --flow` answers *what motion exists* — both true, and the block is the translation between them.

## Residuals

- **The dashboard's `flows` row disagrees with its `next:` line.** `dashboard.ts:198` calls `flowAction` directly and never consults pending decisions, so a stale-pending flow shows `witness gate …` in the table while `next:` shows `decide … --show`. Both statements are true of different questions. Recorded in DESIGN.md's open list rather than grown into this change.
- **`stale-below-bound` never appears in `status`'s recommender table.** Its recommendation is a gate act, so neither compliance nor divergence produces a countable row (see seam 3). Measuring it needs a different instrument — gate-runs whose immediately preceding state was stale-pending — which `status` does not compute today. Left open; the rule's correctness rests on the probes recorded here rather than on field data.
- **`--revise` at a stale verdict defers a round rather than avoiding one.** The tradeoff line says so; nothing enforces it.
- **The revised (non-reopened) stale screen is unprobed.** After a `revise`, `revisedAnchor` requires `unchanged` (`decide.ts:214`), so a stale revise should resolve no anchor and refuse like the reopened state — the pending discriminator therefore returns the single act, which is believed correct and is a plan step to confirm rather than an assumption to ship.

## Verification

- `tests/recommend.test.ts` — the new rule fires at stale-pending-below-bound; does **not** fire without a pending decision; ordered ahead of `ladder-spent`; the existing totality and no-unflagged-placeholder properties extend over it.
- `tests/exits-line.test.ts` — block members and `liveExits` members are identical in both states, pending and not.
- `tests/decide-show.test.ts` — the `:72` doctrine comment is retired and replaced by the two-state assertion; the stale-pending screen renders four options and a `run:` line.
- New coverage for seam 3: a decision taken while stale journals `rule: "stale-below-bound"` and the `recommended` verb the block actually showed.
- Regression: the reopened screen still prints exactly one act.

All four doctrine comments are rewritten to the two-state rule as part of the change. Four copies of one over-general sentence, each true-looking beside its own code, is the mechanism by which it survived three releases — the D119 duplication defect in prose rather than in code.

## Out of scope

Widening `next.ts` tiers; changing the round bound or its budget; the dashboard mismatch; any change to what `--approve` refuses.
