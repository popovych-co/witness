# Skills, payload and release (D125, D127, D128) — Plan D of 4 for 0.11.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop specifying the block's shape in skill prose, delete the five stale exit sets that prose carries, let the agent type a decision the human names, extend the interview to the same five-field form, and ship 0.11.0.

**Architecture:** Nine copies of the exits set exist in this system; 0.10.1 removed the four in CLI code, and five remain in skill prose — every one omitting `--revise --upstream`, none aware of the bound set or the repair grant, and all five instructing the agent to print a remembered set that `/witness` line 29 explicitly forbids. Skill prose is the most expensive surface here to change (a payload release plus a version-floor bump per tweak, for every downstream repo), so the fix is to make the block's shape CLI-owned and give skills one key-agnostic ground rule. A negative assertion in `tests/skills.test.ts` keeps the copies from coming back.

**Tech Stack:** Markdown payload files, vitest, npm.

## Global Constraints

- **This plan owns the 0.11.0 release.** It is the only plan in the set that touches `package.json` or a payload pin.
- **Prerequisites: 0.10.1 merged, and Plans A, B and C merged onto the release branch.** Task 1's ground rule describes a block that must already exist; writing it first would ship an instruction for a screen the CLI does not print.
- **Every payload edit lands in all files that carry the text.** A ground rule present in five of six skills is the skew rows 102 and 117 exist to close.
- **Run the suite with a bounded fork pool:** `npx vitest run --poolOptions.forks.maxForks=4`.
- **Do not merge the PR.** Merging is the human's act on GitHub.
- **`npm publish` needs `--otp` and must be cold-verified from OUTSIDE this repo** — a local-project resolution inside the repo shadows the registry and produces a false "command not found".

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `plugin/skills/*/SKILL.md` (6) | One key-agnostic ground rule about rendering CLI decision output; the five hardcoded exit sets deleted; the execution protocol stated. `witness-brainstorm` additionally carries the five-field interview form. |
| `plugin/commands/witness.md` | Line 29's `exits:` instruction generalised; the execution protocol stated once for the loop. |
| `plugin/hooks/session-dashboard.sh` | Pin only. |
| `tests/helpers.ts` | `SKILL_GROUND_RULES` gains the new rule. |
| `tests/skills.test.ts` | Positive assertions for the new rules; a **negative** assertion that no skill body contains an exit-set string. |
| `package.json`, `DESIGN.md` | Release. |

---

### Task 1: One key-agnostic ground rule, and the five copies deleted

**Files:**
- Modify: `plugin/skills/witness-brainstorm/SKILL.md`, `witness-decompose/SKILL.md`, `witness-design/SKILL.md`, `witness-implement/SKILL.md`, `witness-plan/SKILL.md`, `witness-ship/SKILL.md`
- Modify: `plugin/commands/witness.md:29`
- Modify: `tests/helpers.ts` (`SKILL_GROUND_RULES`)
- Test: `tests/skills.test.ts`

**Interfaces:**
- Consumes: the block, which Plan B made the CLI print.
- Produces: the exact ground-rule sentence below, present verbatim in all six skills. Task 3 appends to the same block, so the sentence must land first.

- [ ] **Step 1: Write the failing test**

In `tests/skills.test.ts`, add:

```ts
describe('the block is CLI-owned', () => {
  it('no skill body carries an exit set', () => {
    const offenders: string[] = []
    for (const name of SKILL_NAMES) {
      const body = readFileSync(skillPath(name), 'utf8')
      for (const [i, line] of body.split('\n').entries()) {
        const flags = (line.match(/--(approve|revise|stop|override|repair)/g) ?? []).length
        if (flags >= 2 && line.includes(' | ')) offenders.push(`${name}:${i + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every skill states the render rule without naming a key', () => {
    for (const name of SKILL_NAMES) {
      const body = readFileSync(skillPath(name), 'utf8')
      expect(body, name).toContain('verbatim and in full')
      expect(body, name).toContain('never print a command set you remember')
    }
  })
})
```

`SKILL_NAMES` and `skillPath` already exist in that file's setup — reuse them rather than re-deriving the list.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/skills.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — five offenders named (`witness-plan:91`, `witness-implement:85`, `witness-decompose:97`, `witness-design:80`, `witness-ship:39`), and the render rule is absent everywhere.

- [ ] **Step 3: Add the ground rule to all six skills**

In each skill's `## Ground rules (every witness skill)` list, add as the first bullet:

```markdown
- **Render the CLI's decision output verbatim and in full — every line, unmodified.** Never print a command set you remember; never recompose, reformat, summarise or reorder what the CLI emitted. Which decisions are live, how they rank, and what each costs are the CLI's answers, and they change with the round, the bound, the repair grant and the content sha — a remembered set is wrong in more states than it is right.
```

- [ ] **Step 4: Delete the five hardcoded sets**

`plugin/skills/witness-plan/SKILL.md:91` becomes:

```markdown
- **Stop** → render the gate output verbatim, including its ranked options and `run:` line, and END YOUR TURN.
```

Apply the same replacement shape at `witness-implement/SKILL.md:85`, `witness-decompose/SKILL.md:97`, `witness-design/SKILL.md:80` and `witness-ship/SKILL.md:39`, keeping each line's surrounding context (the decompose one keeps its fix-created-spec tripwire clause; the design one keeps its "the findings are never a substitute for the human being shown it" sentence).

- [ ] **Step 5: Generalise `/witness` line 29**

```markdown
| `next:` names `witness decide` | A gate is stopped and the decision is the human's. Run `$WITNESS decide <gate> <target> --show`, render everything it emits verbatim and in full — the checks, the findings, and its ranked options — and **END YOUR TURN**. Never substitute a command set you remember: it is wrong at the round bound, in the reopened and stale states, and wherever a repair grant is unspent. Never run `--approve`, `--revise` or `--stop` on your own judgment. |
```

- [ ] **Step 6: Add the rule to `SKILL_GROUND_RULES`**

In `tests/helpers.ts`:

```ts
export const SKILL_GROUND_RULES = [
  'The CLI is the sole writer',
  'Never invoke gate reviewers',
  '3 total attempts',
  'mktemp',
  'never from conversation memory',
  'a stop, not a step to drop',
  'verbatim and in full',
]
```

- [ ] **Step 7: Run the test**

Run: `npx vitest run tests/skills.test.ts tests/command.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. If the negative assertion still names a file, that file is a copy Step 4 missed — delete it rather than exempting it.

- [ ] **Step 8: Commit**

```bash
git add plugin tests/helpers.ts tests/skills.test.ts
git commit -m "feat(skills): the block's shape is CLI-owned; five stale exit sets deleted (D128)"
```

---

### Task 2: The interview asks the same way the CLI does

**Files:**
- Modify: `plugin/skills/witness-brainstorm/SKILL.md:33`
- Modify: `plugin/skills/witness-design/SKILL.md` (the convergence step)
- Test: `tests/skills.test.ts`

**Interfaces:**
- Consumes: the ground rule from Task 1.
- Produces: the five-field interview form, asserted by name.

- [ ] **Step 1: Write the failing test**

```ts
describe('the interview asks the same way the CLI does', () => {
  it('brainstorm states the five-field form', () => {
    const body = readFileSync(skillPath('witness-brainstorm'), 'utf8')
    for (const f of ['recommendation', 'why', 'alternative', 'when', 'tradeoff']) {
      expect(body, f).toContain(f)
    }
    expect(body).toContain('One question per turn')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/skills.test.ts -t "the interview asks" --poolOptions.forks.maxForks=4`
Expected: FAIL — `when` and `tradeoff` are absent.

- [ ] **Step 3: Extend the brainstorm protocol**

Replace `witness-brainstorm/SKILL.md:33`:

```markdown
**One question per turn.** Every question carries the same five fields the CLI's decision block uses, so a human meets one shape everywhere in this pipeline: a concrete **recommendation**, a one-line **why**, the strongest **alternative**, **when** that alternative is the right call, and the **tradeoff** it carries against the recommendation. Add a short note to either option only when running with it has a caveat the option itself does not state. Lock each answer before the next; walk in dependency order:
```

- [ ] **Step 4: Extend the design convergence step**

In `witness-design/SKILL.md`, step 3 of the session becomes:

```markdown
3. **Converge.** With the human, pick or synthesize the winner — and ask for that choice the same way every other decision in this pipeline is asked: a recommendation, a one-line why, the strongest alternative with when it wins and what it costs. Every behavior the spec promises must be visible and operable in the winner (the design-critic checks this as blocking coverage).
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/skills.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS.

*Note for the implementer:* this assertion pins the **instruction**, not the model's compliance. Compliance is unverifiable here by construction — the skill calibration suites (`calibration/skills/*/seeds`) measure the artifact a skill produces via a headless runner, brainstorm has no seed directory, and a multi-turn interview with a human answering has no headless form. Do not try to build one.

- [ ] **Step 6: Commit**

```bash
git add plugin/skills tests/skills.test.ts
git commit -m "feat(skills): the interview carries the block's five fields (D125)"
```

---

### Task 3: The agent types, the human decides

**Files:**
- Modify: all six `plugin/skills/*/SKILL.md` (the ground-rule block from Task 1)
- Modify: `plugin/commands/witness.md` (stop conditions)
- Test: `tests/skills.test.ts`

**Interfaces:**
- Consumes: Task 1's ground rule (this appends to the same bullet block).
- Produces: the execution protocol, asserted by name in every skill.

- [ ] **Step 1: Write the failing test**

```ts
describe('the execution protocol', () => {
  it('every skill states that a named option may be run byte-for-byte', () => {
    for (const name of SKILL_NAMES) {
      const body = readFileSync(skillPath(name), 'utf8')
      expect(body, name).toContain('names an option')
      expect(body, name).toContain('byte-for-byte')
      expect(body, name).toContain('is not a selection')
    }
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/skills.test.ts -t "execution protocol" --poolOptions.forks.maxForks=4`
Expected: FAIL.

- [ ] **Step 3: Add the protocol to all six skills**

Directly below Task 1's ground rule:

```markdown
- **The human decides; you may type it.** Run a `witness decide` verb only when the human **names an option** — its number or its verb — and then run the **printed string byte-for-byte**: never recomposed, never reformatted, never with a placeholder you resolved yourself. The moment you compose a `--note` or resolve an id, you are authoring their decision. A bare affirmation ("ok", "sounds good", "yes") **is not a selection** — ask which option, especially where option 1 is `--approve` at a stop that exists because a human must look. A selection does not survive session death: killed and re-run, render the block again and ask again.
```

- [ ] **Step 4: State it once in the loop**

In `plugin/commands/witness.md`, under **Stop conditions**, add:

```markdown
- After a `decide` line surfaced and you rendered it, the turn ends. If the human then names an option, run that option's printed string byte-for-byte and resume the loop — naming the option is their judgment, typing it is not yours to substitute.
```

- [ ] **Step 5: Run the test and the whole suite**

Run: `npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugin tests/skills.test.ts
git commit -m "feat(skills): the agent types a decision the human names (D127)"
```

---

### Task 4: Release 0.11.0

**Files:**
- Modify: `package.json`
- Modify: all 8 files carrying the pin
- Modify: `DESIGN.md`

**Interfaces:**
- Consumes: Plans A, B, C and Tasks 1-3.
- Produces: `@popovych.co/witness@0.11.0`.

- [ ] **Step 1: Verify the pin count before touching anything**

Run: `grep -rn "witness@0.10.1" plugin | wc -l`
Expected: `8` — six skills, `plugin/commands/witness.md`, and `plugin/hooks/session-dashboard.sh`. If it is not 8, stop: a payload file was added or removed and this list is stale.

- [ ] **Step 2: Bump the pin everywhere**

```bash
grep -rl "witness@0.10.1" plugin | xargs sed -i '' 's/witness@0.10.1/witness@0.11.0/g'
grep -rn "witness@0.11.0" plugin | wc -l
```
Expected: `8`.

- [ ] **Step 3: Bump `package.json`**

Set `"version": "0.11.0"`.

- [ ] **Step 4: Full verification**

Run: `npx tsc --noEmit && npx biome check src tests && npx vitest run --poolOptions.forks.maxForks=4`
Expected: PASS, all green.

- [ ] **Step 5: Mark the rows built in `DESIGN.md`**

In the `⊗` status paragraph, record that 0.11.0 shipped rows 121–128 and 130, and that 0.10.1 shipped 119, 120 and 129. Add anything the build corrected — this repository's practice (rows 75, 77, 106) is that defects found while executing a plan are recorded in the rows rather than quietly fixed.

- [ ] **Step 6: Commit and open the PR**

```bash
git add package.json plugin DESIGN.md
git commit -m "chore(release): 0.11.0 — the decision block (D121-D128, D130)"
git push -u origin decision-block-0.11.0
gh pr create --title "0.11.0 — the decision block (D121–D128, D130)" --body "$(cat <<'EOF'
Every place the CLI asks a human to choose now ranks the choices.

- D121: ranked option rows with runnable commands, an ordered first-match rule
  table whose matched id is journaled beside the decision, and a run: line.
- D122: a deferral mints an obligation — injected into later batteries as an
  inverted pin, re-booked onto the parent spec when its flow completes, closed by
  evidence or by `witness dismiss --cause`.
- D123: recurrence escalates. Two memories: within-window grade, cross-window
  ladder fact, because revise-upstream is itself a window reset.
- D124: a stop parks its flow. gateSettled and decide --show had two definitions
  of settled with `stop` on opposite sides; status now reports parked flows.
- D125/D127/D128: the interview carries the same five fields; the agent may type
  a decision the human names, byte-for-byte; the block's shape is CLI-owned and
  five stale exit sets are gone from skill prose.
- D126: a malformed round is no longer offered as a disposition.
- D130: status reports each rule's override rate — the subject is the rule, never
  the human.

Routing changes: D124 and D126. Everything else is display or new state.
EOF
)"
```

**Do not merge.**

- [ ] **Step 7: Publish, after the PR is merged by the human**

```bash
npm publish --otp <code>
```

Then cold-verify from a directory **outside this repository**:

```bash
cd /tmp && npx -y @popovych.co/witness@0.11.0 --help
```

Expected: the help screen. Running this inside the repo resolves the local project and produces a false result either way.

---

## Self-Review

**Spec coverage.** D128 — Task 1 (ground rule, five deletions, negative assertion, `/witness` line 29). D125 — Task 2 (brainstorm and design convergence). D127 — Task 3 (all six skills plus the loop). Release — Task 4.

**Placeholder scan.** No TBDs. Every prose replacement is written out in full rather than described. The only judgement left to the implementer is preserving each deleted line's surrounding context, and Step 4 of Task 1 names which clauses to keep.

**Type consistency.** No types here. The strings asserted by `tests/skills.test.ts` (`verbatim and in full`, `never print a command set you remember`, `names an option`, `byte-for-byte`, `is not a selection`) appear verbatim in the prose written in Tasks 1 and 3 — check each by eye before running, since a paraphrase passes review and fails the test.

**Ordering note.** Task 1 must precede Task 3: both edit the same ground-rule bullet block, and Task 3's assertion depends on Task 1's bullet existing. Task 4 must be last — it is the only task that moves the version, and a pin bumped before the payload prose is final would ship a release describing a screen that changed after it.

**Known consequence.** 0.11.0 is a payload release in the full sense — prose *and* pin. Every downstream home must upgrade before it sees any of it (rows 102, 116, 117). D128 is what makes this the last payload change the block itself needs: after it, the block's shape evolves with a plain CLI release.
