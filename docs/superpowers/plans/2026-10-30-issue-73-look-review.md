# Issue #73 — Looks Judged From Their Source, Reviewers That Only Read (rows 215–217) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three rows; the first closes issue #73.

- **Row 215 — every judgment of a look reads its HTML source.**
  - The design session checks its pages with a source pass, then a render pass for layout only.
  - A review asked for outside the gate runs the gate's own design-critic, on demand, journaling nothing.
  - A look's `--outline`, and the critic's input, list the controls and hidden states its markup holds.
- **Row 216 — each lens is asked only about debts it can read.**
  - A gate asks a lens only about obligations raised on the kind of content that lens reads.
  - Its silence clears only debts some lens in its battery could read.
- **Row 217 — a reviewer reads; it never acts.**
  - A reviewer gets read-only file tools only where it must open files; otherwise none.
  - Claude reviewers run without the repo's hooks, `CLAUDE.md`, plugins or session files.
  - Witness refuses every acting verb from inside a reviewer.

**Architecture:**

- **Gates declare what their lenses read.**
  - `GateSpec.reads`, plus `lensReads` for an override lens, is checked against the content `resolve` actually hands over (`assertReads`).
  - `readsOf(gate, lens)` answers it.
  - The debt rule (216) reads the declaration; the tool policy (217) reads the content itself (`toolsFor(reviewed)`).
- **One composer.** The prompt assembly is extracted from `judge` (`src/gate.ts`) and from the design gate's `resolve`, so the gate and `witness review design` build the same per-lens question. The parts:
  - `designReviewed` — the reviewed content;
  - `gateLenses` — the lenses and their docs;
  - `gateSetup` — the pins, each lens's own readable debts, and the backstop;
  - `lensPrompt` — the assembly.
- **One evidence rule.** `answersKey` (`src/rounds.ts`) decides whether a journaled run answers a key. The gate's cache uses it, and a review replays only a full answer it accepts.
- **One map.** `lookControls` / `controlsBlock` (`src/design.ts`) — a hand-written single-pass tokenizer and its rendering. `read --design --outline` prints it, and the critic receives it.
- **Prose.**
  - Prompts state their input and their tools.
  - The design skill's check becomes a source pass then a render pass, and gains "A review outside the gate".
  - The implement and plan skills read the controls.
  - `/witness` routes a review ask to the skill.

**Tech Stack:**

- TypeScript (ESM, NodeNext, `strict` + `noUncheckedIndexedAccess`), Node ≥ 20.
- Tests: vitest 3.2.7, the CLI in-process against throwaway git repos (`tests/helpers.ts`), and `/bin/sh` reviewer fakes (`fixtures/fakebin/{claude,pi}`). Each fake records its call's `stdin`, `argv` (one argument per line) and `lens` under `fakeScenario()`.
- No new dependencies.

**Spec:**

- [Issue #73](https://github.com/popovych-co/witness/issues/73) and its three asks. The third was optional; D7 builds it.
- DESIGN "Open / deferred" `:610`, the debt residual row 216 closes.
- The verified evidence base below.
- The user's answers (2026-10-30):
  - "fix it without band-aids and with a proper architecture solution";
  - verify the plan first;
  - "i wil run it myself": the build runs in a fresh session from this file alone;
  - the debt bug: "Fix in this plan";
  - the reviewer-tools gap: "Fix in this plan";
  - verify the rewrite, then verify v3.

**Verification already run (2026-10-30):**

- Probes P1–P14 below.
- Three rounds of review and trial builds:

  | Round | Text | `opus` reviews | Trial build | Worktree |
  |---|---|---|---|---|
  | 1 | first draft | two | Tasks 1–3: gate 2360 passed | `agent-a71bf084e2c67347b` |
  | 2 | v2 | one | Tasks 1–4: one shared Critical, gate 2394 passed | `agent-aa39c8297b9a61142` |
  | 3 | v3 | one: no Critical, 5 Important, 13 Minor | Tasks 1–4: 21 findings, gate 2434 passed once its 4 test corrections and 9 test-file edits were made | `agent-a3f10bb47fb8168c4` |

- Every finding was re-checked before it was folded in. Round 3 found no shipped-code bug; its Critical was a step that could not pass as written.
- **This v4 text has not been trial-built.** All worktrees sit under `.claude/worktrees/` and are reference only; this plan wins.
- Claims were read at `main` `dc4b3d4` (0.26.2), with claude 2.1.314 and pi 0.85.1 on this Mac, and pi 1.4.0 read from its published tarball.

---

## Verified evidence base

### E1 — Root causes (read)

1. **Looks are judged from pictures outside the gate (#73).**
   - The skill's only check is a screenshot: `plugin/skills/witness-design/SKILL.md:67` (step 3) and `:78` ("the same way"), as row 200 records.
   - The gate's critic reads the whole HTML (`src/gates/design.ts:56-59`; anchors in `src/verdict.ts:88-104`, `:204-226`), but only through `judge` (`src/gate.ts:232-611`). That path:
     - refuses an unshown look (`src/gates/design.ts:39-43`);
     - spends a round;
     - journals under the lock;
     - settles under autonomy.
   - So "review this UI" has no sanctioned method, and agents reuse the screenshot. That is how the issue's false "never drawn" happened.
   - The critic's prompt understates its input: `prompts/design-critic.md:3` says "element-id list", and `:12` says "the artifact's ids".
   - `--outline` lists anchors only (`src/verbs/read.ts:27-34`), and implement reads looks section by section from that map (`plugin/skills/witness-implement/SKILL.md:61`).
2. **A gate asks about, and clears, debts its lenses cannot read (pre-existing).**
   - D122 moves a plan's open debts onto its parent spec at merge (`src/stamp.ts:82-92`), and onto a successor spec at re-slice (`src/verbs/write.ts:225-228`, `src/departure.ts:208`).
   - `judge` injects every open debt into every lens through one shared setup string (`src/gate.ts:280`, `:461`).
   - It discharges every debt a round does not report (`:566-568`). Neither step filters.
   - DESIGN `:610` records this. It asks for "a rule for which battery can judge which anchor", and warns that "filtering on the minting `gate` alone is not it".
3. **Reviewers can act, and are not shut off from the repo's own config (pre-existing).**
   - **Claude.** The reviewer spawn passes no tool flag (`src/harness.ts:160`), and the repo's Claude settings allowlist `Bash(witness *)` and `Bash(npx -y @popovych.co/witness*)` (`src/install.ts:250-251`).
   - **pi.** The spawn passes no tool flag either (`:218`), so the reviewer gets pi's default `read, bash, edit, write`, with no approval step (P7).
   - **Repo config.** A claude reviewer runs the repo's hooks and reads its `CLAUDE.md` (P11). The witness SessionStart hook runs bare `witness` (status, which can stamp) in every claude session (`plugin/hooks/session-dashboard.sh:6`).
   - **Session refusals.** Only `trust`, `retry` and `wait` refuse sessions. They key on `sessionMarker`, which names `WITNESS_DRIVE` first (`src/drive-presence.ts:25-28`). A reviewer spawned inside a drive session carries both markers (`src/drive.ts:228`, `src/reviewer.ts:170-172`).

### E2 — Probes

| Probe | What ran | Result |
|---|---|---|
| P1 | Headless Chrome screenshot (1024×700) of a look with a 4-option `<select>`, a closed `<details>`, a class-hidden error, a 180 px `overflow:hidden` pane of 7 rows, and an `aria-label`. | **Visible:** "Unsafe code", the summary line, rows 1–6. **Missing:** three options, the details body, the error, row 7, the label. **Also:** the same picture showed a real clipping bug, so the render pass stays. |
| P2 | All 28 consumer looks (fewhats 14, HYC 4, KYC 10), read-only. | No selects, dialogs or popovers. 19 `<details>` in live markup, 17 of them closed. 9 `hidden`/`aria-hidden` elements: 8 are painted decorative `<svg aria-hidden="true">`, and 1 is a real hidden panel of nested divs (fewhats `laptop-download.html:121`). |
| P3 | Scanner drafts on P2 and on synthetic pages: four reviewers, three trial builds. | Every regex, `indexOf` or prefix design failed some case, silently dropping or inventing rows. The cases: a comment naming `<script>`; a script holding `'<!--'`; `<style-guide>`; a quoted `>`; `<selectedcontent>` read as `<select`; `</p` matching `</path>`; `İ` shifting `toLowerCase` offsets; an svg `<title/>`; template bodies holding comments; `/>` on HTML elements; an apostrophe in an unquoted value; nested same-name elements cut at an inner close; words glued where only whitespace separated tags. Several designs ran in quadratic time. D7 therefore specifies a hand-written single pass, element ends matched with per-name stacks, and precomputed indices. |
| P4 | fewhats `thread-mirror.html:119-129`. | A whole phone frame sits on one line, so anchors are attributed by character offset within `--outline`'s line spans. |
| P5 | Consumer journals, read-only. | Open code debts moved onto UI specs: KYC `cover-argument` (ship), KYC `recommended-view` (implement), fewhats `setup-hours` (implement). The bug has fired: KYC `provenance-vocabulary-plan-1.jsonl` — screenshot debt `d-fc7d8111` (line 129) malformed ship round 3 (line 130), and the next round's silence then discharged it (lines 131–132). Replaying K3 over history, a battery that could not read the debt made 60 of fewhats' 81 discharges, 24 of KYC's 71, and 3 of HYC's 7. |
| P6 | claude 2.1.314 `-p --output-format json --strict-mcp-config`, asked to read a secret file and to create a file through the shell. | `--tools ""`: nothing ran, but the model wrote fake `<invoke>`/`<bash>` text. `--tools Read`: it read, with no shell. `--tools "Read,Grep,Glob"` as one argument: Glob and Read ran, no shell. |
| P7 | pi 0.85.1 source (`core/sdk.js:139-144`); pi 1.4.0 tarball (`cli/args.js:108,114`; `core/sdk.js:148-160`). | No flag gives `read, bash, edit, write`. `--no-tools` gives none; `--tools read,grep,find,ls` gives just those. 1.4.0 behaves the same. A live pi call is impossible here: the provider answers 400 "Third-party apps now draw from your extra usage". |
| P8 | `src/install.ts:243-252`, `src/harness.ts:155-225`, `src/reviewer.ts:163-172`, `src/drive.ts:228`, `src/drive-presence.ts:25-28`. | E1.3 as stated. Round 2's trial build showed a drive child's reviewer, carrying both markers, running `decide … --approve` and `abandon`. |
| P9 | Every prompt. | The code lenses already say "You cannot read files, run commands, or ask" (`prompts/code-reviewer.md:15`; silent-failure-hunter, type-design, pr-test). `design-reviewer` must Read its captures (`prompts/design-reviewer.md:3-4`). Ship hands the drift lens its source inline (`src/gates/ship.ts:102-103`); `check --drift --deep` does not (`src/drift.ts:143`, `:153`). The arbiter passes `lens: 'arbiter'` (`src/arbiter.ts:91`). |
| P10 | `src/spawn.ts:72-81`, `:123`. | On win32, a batch shim turns the argument `''` into `""`, written on the cmd line as `^^^"^^^"`. |
| P11 | claude 2.1.314 in a scratch repo whose SessionStart hook writes a file and prints a marker, and whose `CLAUDE.md` says "end every reply with PINEAPPLE". | **Without a flag:** the hook ran, its marker reached the model, and the reply ended "PINEAPPLE". **With `--safe-mode`:** no hook, no marker, no `CLAUDE.md`, and OAuth still worked. |
| P12 | claude 2.1.314 `--safe-mode --strict-mcp-config --tools "Read,Grep,Glob"`, prompt on stdin. | Read outside the working directory was denied (logged in `permission_denials`); inside it, Read worked. `--tools` is variadic: a positional prompt placed after it was read as a tool name. Witness sends the prompt on stdin. |
| P13 | `tests/helpers.ts:85`, `:312-314`; `tests/spawn.test.ts:266`, `:304`; `tests/stamp.test.ts:73-92`; seven test files that call `registerGate`. | The suite scrubs `WITNESS_DRIVE` at `:85` only, never `WITNESS_REVIEWER`. Two Windows-only tests pin the full reviewer argv. The deep-drift reviewer test lives in `stamp.test.ts`. Stand-in gates in `decide`, `docs-injection`, `gate-delta-synthetic`, `gate-lens-override`, `gate-engine`, `gate-stale-checks` and `policy-pins` declare no `reads`. Two of them give `code-reviewer` a `screens` override. |
| P14 | claude `--safe-mode` in a scratch repo whose `.claude/settings.json` sets `env.ANTHROPIC_BASE_URL` to a dead port, plus a control run without that file. | The control answered in 2 s; the probe hung on the dead port. So `--safe-mode` keeps settings `env` (provider settings survive). The same help text says it also keeps permissions. The control's JSON carried a `session_id`: claude saves reviewer sessions unless told not to (`--no-session-persistence`, print mode only). |

### E3 — Design decisions

**Row 215 — a look is judged from its source.**

- **D1 — One critic, two callers.** `witness review design <spec-id> [--file <html>]` runs the design gate's battery: `batteryFor(cfg, 'design', class)`, with the class taken from the effort's latest recap, else `feature`.
  - **What it uses:** the gate's canon docs, setup, model pin (`stageModel(cfg, 'design')`), harness, reviewer extensions and timeout.
  - **What it doesn't do:** it writes nothing (no journal line, commit, lock, draft or `.witness/` file), needs no sight, spends no round and settles nothing.
  - **What it reviews:** without `--file`, the registered look; with `--file`, a page not registered yet, resolved against the cwd. That page must be a regular file.
  - **The first positional names the gate,** as in `witness gate`; only `design` is accepted.
  - **A review is advice, not evidence.** No gate, stamp, recommendation, arbiter or settle pass reads it. Row 48 and North star 3 bind evidence; rows 72 and 194 make sight the precondition of gating and approving. A review does neither.
- **D2 — The same question.** The gate and the review build a lens's prompt with the same four functions.
  - `designReviewed(html, spec)` orders its sections:
    1. `### Design artifact: the look for <spec-id>` (never a path);
    2. the HTML;
    3. `### Controls in the look (from markup)` and `controlsBlock(html)`;
    4. `### Parent spec: <spec-id>` and the spec.
  - A review is always a full review (row 185). So it is byte-identical to the design gate's prompt on the same bytes, in any round without a delta base.
- **D3 — A full answer is not asked again.**
  - **The evidence rule.** `answersKey(run, key)` is the one rule, and `appendKind`'s cached search calls it. A run answers a key when it is not malformed, has not fallen back, has verdicts, and `sameKey(keyOf(run), key)` holds.
  - **The replay.** The review replays the newest design gate run that `answersKey` accepts **and** that carries no `delta` mark; edit-then-revert is covered. A delta round, or a cached replay of one (`gate.ts:521` copies the mark), answered a narrower question and is never replayed.
  - **The key:** `{ reviewed_sha: designGateSha(html, spec), gate: 'design', prompts_sha: promptsSha(lenses, setup.text || undefined), pin, witness: version(), harness: harness.name }`.
  - **The `earlier:` line.** When nothing is replayed, but the newest judged run on the same bytes exists (equal `reviewed_sha`, not malformed, verdicts present), print `earlier:` with the first reason that applies:
    1. the run has a `delta` mark → `in delta mode`;
    2. `fellBack(run)` → `under another setup (pin)`;
    3. otherwise → `under another setup (<fields>)`.
- **D4 — Output and exits.** The copy is in Global Constraints.
  - **Rows** come from `findingRows` / `malformedRows`. `findingRows` passes every anchor and claim through `logSafe`, which also hardens the gate's own table.
  - **Outcome:** any malformed verdict → `malformed`; else any blocking finding → `<b> blocking`; else `clean`.
  - **Exit codes:** 0 clean; 1 blocking or malformed; 2 refused; 3 a pending transaction.
  - **Line order:** `review`, `look`, `model`, `answered` or `earlier`, `findings`, `malformed`, `outcome`, `note`.
  - There is no decision block and no `exits:` line, and the note names no command.
- **D5 — Refusals, in order:**
  1. usage, unless there are exactly two positionals;
  2. `review-scope`;
  3. `review-in-session`, under `sessionMarker(ctx.env)`. In practice this is reached only by a drive session: R3 refuses every reviewer first.
  4. `primaryRoot`'s;
  5. a pending transaction (exit 3);
  6. config;
  7. `unknown-spec`;
  8. `not-ui`;
  9. the look: `input-unreadable` for an unreadable `--file` or one that is not a regular file, with `statSync` and the read inside one `try`; else `no-design`;
  10. `validateDesignArtifact`'s rows;
  11. `gateLenses`' `unknown-reviewer` / `doc-missing`;
  12. the gate's harness, local-config and pin refusals;
  13. `unansweredPin`'s rows.

  There is no class refusal.
- **D6 — The session checks a source pass, then a render pass** (amends row 200).
  - **No critic in the session.** The session never runs the critic itself: the gate's critic reads those bytes right after the human sees them, and a pre-show run would double the stage's reviewer spend.
  - **The source pass** reads the session's own scratch file. (`witness read --design` refuses a new screen, and returns the old look in amend mode.)
    - Directions: each carries real content, and nothing promised is reachable only behind a closed control.
    - Full look: every promised state, what each closed control holds, every control's accessible name, content past a scrolling pane, and the id showing each promised behavior.
  - **The render pass:**
    - runs at the canon's widths, else 1024 px;
    - judges layout only;
    - also renders a copy with every `<details>` open, and each `<dialog>` alone.
- **D7 — `--outline` lists a look's controls** (amends row 132).
  - The row keeps the refusal of a section extractor, which lives in `src/verbs/read.ts:16-22`.
  - `lookControls(html)` lives in `src/design.ts`. It prints only with `--design --outline`, after the outline table, and goes to the critic (D2).
  - It never throws, and runs in time linear in the source.

  The rules:

  1. **Tokenize** in one forward pass, by index over the original string. The output is a token array:
     - open tags (name, attributes, start, end);
     - close tags (name, start);
     - text runs (start, end), whitespace-only runs included.

     Only ASCII names are lowercased; the source itself is never lowercased. At each `<`:
     - **`<!--`** opens a comment, ending at the first `-->` or `--!>`. `<!-->` and `<!--->` end at once; an unclosed comment runs to the end.
     - **Any other `<!` or `<?`** opens a bogus comment, ending at the next `>`.
     - **`</` and an ASCII letter** is a close tag. Its name is the characters before whitespace, `/` or `>`, and the tag runs to the next `>`.
     - **`<` and an ASCII letter** is an open tag, named the same way. Then come its attributes:
       - a quote opens a value only directly after `=` (whitespace allowed between);
       - a value quote that never closes swallows the rest of the source;
       - a tag the source ends inside is dropped, and no tokens follow it.
     - **Anything else:** the `<` is text.
  2. **After an open tag:**
     - **`/>`** self-closes only inside `svg` or `math`; on an HTML element it is ignored, as browsers do.
       - Foreign content is tracked with a depth counter. A self-closing `svg` or `math` does not enter it.
       - The HTML spec's breakout tags reset the depth to 0: `b big blockquote body br center code dd div dl dt em embed h1–h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var`.
     - **Raw text.** `script`, `style`, `textarea`, `title`, `xmp`, `iframe`, `noembed`, `noframes` and `noscript` take raw text, but inside foreign content only `script` does.
       - The body is skipped to its first `</name` followed by whitespace, `/` or `>`, matched ASCII-case-insensitively on the original string, else to the end.
       - The body of `textarea`, `title` or `xmp` becomes one text run, since a browser shows it. The other raw-text bodies emit nothing.
       - The close tag itself is emitted as a close token.
       - `plaintext` makes the rest of the source one text run.
     - **Inert.** For `template`, the body is run through this same tokenizer with its output suppressed, so comments, raw text and quotes are honored. Same-name open and close tokens are counted until the balanced close, and that close is emitted as a close token.
  3. **Indices**, each built in one pass:
     - **Element ends.** Each open tag's matching close, found with per-name stacks in one forward pass. A void element (`area base br col embed hr img input link meta source track wbr`) has no end; an unmatched open ends at the source's end.
     - **The text chain.** The next text run or `br` after each token: the chain text collection walks.
     - **Ids.** Each quoted `id` maps to its first open tag.
     - **Line anchors.** The last id before each element on its line, found by one sweep over id offsets and element offsets in document order, with two pointers.
  4. **An element's text.** Walk the chain from its open tag to its end, joining text runs as written.
     - A whitespace-only run, or a `br`, adds one space. Every other tag adds nothing.
     - Collection stops at 240 code points, setting a `truncated` flag.
     - The result is processed in order:
       1. entities decoded in one pass (`&amp; &lt; &gt; &quot; &#39; &apos; &nbsp;`, `&#N;`, `&#xN;`; 0, a surrogate or anything above U+10FFFF becomes U+FFFD; other named entities stay as written);
       2. whitespace collapsed and trimmed;
       3. `logSafe`;
       4. cut to 120 code points. When `truncated` is set or this cut fires, the result ends `…`.
  5. **Rows.** One row per element. The checks below run in order, and an element matching none is no row.
     - **`select`.** `holds` is its options' text joined ` | `.
       - Its region runs to its matching close, or to the next `select` open, by exact name.
       - An option's text is its non-empty `label`, else its text up to the next `option`/`optgroup`/`hr` open or `option`/`select` close inside the region.
       - Options still empty after trimming are dropped.
     - **`details` without `open`.** `holds` is the text of its first child element when that child is a `summary` (the next open tag, with only whitespace between), else `Details`.
     - **`dialog` without `open`.**
     - **A `popover` attribute** → kind `popover`.
     - **A `role`** (first token, lowercase) of `menu`, `listbox`, `tooltip`, `tabpanel`, `alertdialog` or `dialog` → that role.
     - **`aria-expanded="false"`** → kind `collapsed`.
     - **A `hidden` attribute,** or an inline `style` holding `display: none` / `visibility: hidden` once its CSS comments are removed → kind `hidden`. Remove the comments with a forward `indexOf` loop; an unclosed `/*` comments out the rest.
     - **`template`.**

     An open `details` or `dialog` falls through to the later checks, so `<details open hidden>` is a `hidden` row. Never a row: `option`, `optgroup`, `summary`. `aria-hidden` alone matches no kind: it hides an element from assistive tech, not from the screen (P2).
  6. **`holds` for the other kinds** — and for a `select` or `details` whose `holds` came out empty — is the first available of:
     1. `aria-label`;
     2. the element text of each id `aria-labelledby` names, joined by a space;
     3. `title`;
     4. the element's own text;
     5. `<name>.<first class>`, else `<name>`.
  7. **`anchor`:**
     - the element's own id, meaning the first `elementIds` match inside its start tag. It is exactly what the outline and the critic's anchor menu list, `data-id` included.
     - Otherwise, the id whose `--outline` span holds the element's line: the last id before it on its line (D7.3), else the first id on its line, else the last id on an earlier line.
     - With none, `-`.
     - `logSafe`'d.
  8. **`line`:** the 1-based line of the element's `<`.
  9. **The note always prints.**
- **D8 — Prompts** (amends row 72).
  - **The critic's prompt:**
    - it names its whole input and says it has no tools;
    - it gains "**The source is the look.**", including that position still counts;
    - its mechanical-checks sentence and its journal sentence become true for both callers.
  - **The deferrals block** (`src/deferral.ts:64-69`) says "The gate reads silence as fixed".
  - `prompts_sha` moves, so cached verdicts are asked again once. Approved looks keep their stamps.
- **D9 — Routing, and the skill's review rules.**
  - **`witness-design` gains "A review outside the gate":**
    - run it only when the human asks — never on your own, never before showing, registering or gating;
    - once per ask: after fixing, show the human the page instead of re-running;
    - `--file` takes only the full look this session wrote;
    - on `malformed`, run it once more, then tell the human.
  - **The running app is not a look.** Read its code and DOM against the look's outline; use pictures for layout only.
  - **The skill's description** scopes it to "a registered witness look".
  - **`/witness`** routes a review ask to the skill: a pointer line, plus an exception in the ask rule at `:10`.
- **D10 — Release: minor, 0.27.0.**
  - Consumers re-add skills and run `init --agent`; the payload includes the dashboard hook.
  - No config change; `witness migrate` is untouched.
- **D11 — Plan and implement read the controls** (`witness-plan/SKILL.md:54`, `witness-implement/SKILL.md:61`).

**Row 216 — each lens is asked only about debts it can read.**

- **K1 — Gates declare what their lenses read.**
  - `GateSpec` gains `reads: ContentKind`: `decompose`/`plan` → `docs`, `design` → `design`, `implement`/`ship` → `tree`.
  - It also gains `lensReads?: Record<string, ContentKind>`. Implement declares `{ 'design-reviewer': 'screens' }` beside the override it builds.
  - `readsOf(gate, lens)` = `lensReads?.[lens] ?? reads`.
  - `assertReads(spec, reviewed, overrides?)` throws if `reviewed.kind !== spec.reads`, or if an override's kind differs from `lensReads`. `judge` runs it right after `resolve`, and `reviewOnce` before any lens runs. A mismatch is a witness bug, so it fails loudly.
  - Every stand-in gate a test registers declares `reads` too (P13).
- **K2 — A debt's kinds are what its raising lenses read.**
  1. **Find the minting stream.**
     - If the debt has no `moved_from`, the minting stream is the stream being judged; use the entries already in hand, never `d.artifact`, which `rename` leaves stale.
     - Otherwise walk, with a visited set that starts empty. From `d.moved_from`, take that stream's **first** `deferral` entry for `d.id`, and follow its `moved_from` the same way, until an entry has none. That stream is the minting stream.
     - Every read is inside a `try`.
  2. **Find the anchor round** there: the `gate-run` whose `run_id` is `caused_by_run`.
  3. **The kinds** are `readsOf(round.gate, lens)` for each lens with a blocking finding whose anchor key equals the debt's.
  4. **Fall back** to `[readsOf(d.gate)]` (unknown gate → `[]`) when any read throws, a stream repeats, no entry or round is found, or the kinds come out empty.
- **K3 — Per lens and per battery.**
  - `gateSetup` builds each lens's setup: pins, then the debts whose kinds include `readsOf(gate, lens)`, then the backstop.
  - `text`, hashed into `prompts_sha`, is the lens setups sorted by lens name, each written `### Lens <name>\n\n<setup>`. It is empty when every setup is empty. Sorting keeps `prompts_sha` independent of battery order, as `promptsSha` already is.
  - During a delta round, `askedSha = promptsSha(lenses, setup.text + block)`.
  - A debt is judgeable when some lens in the battery reads one of its kinds. `judge`'s discharge clears only judgeable, unreported debts.
  - Every other debt stays open. `next`, `status`, `check` and the arbiter still read all of them, and `witness dismiss` closes any.
- **K4 — Effects.** These debts are no longer shown to, or cleared by, a lens that cannot read them:
  - P5's code debts, at design rounds;
  - screenshot debts, at code lenses; code debts, at the design-reviewer;
  - screenshot debts, at ship;
  - implement debts, at a plan re-gate.

  Per P5's replay, such debts now wait for a battery that can read them, or for `witness dismiss`. A screenshot debt approved over at implement now outlives ship and moves to the spec at merge. `src/verbs/next.ts:600-606`'s comment ("the battery injection, which no round can skip") is reworded.

**Row 217 — a reviewer reads; it never acts.**

- **R1 — Tools follow the content handed over.** `toolsFor(reviewed)` returns `read` for `screens` (captures named by path), else `none`.
  - `runBattery` passes `toolsFor(lens.reviewed)` per lens.
  - `deepDrift` passes `read` explicitly: its tree carries no inline files.
  - The arbiter passes nothing (`none`); its `lens: 'arbiter'` only names its calls.
  - At ship, the drift lens gets `none`: its source is inline.
- **R2 — Each harness renders the policy:**

  | | `none` | `read` | always |
  |---|---|---|---|
  | claude | `--tools ""` | `--tools Read,Grep,Glob` | `--safe-mode`, `--strict-mcp-config`, `--no-session-persistence` |
  | pi | `--no-tools` | `--tools read,grep,find,ls` | |

  - The prompt rides stdin, so nothing positional follows the variadic `--tools` (P12).
  - `InvokeOpts` gains `tools?: ToolPolicy` (default `none`), passed to `reviewer.spawn`.
- **R3 — Witness refuses a reviewer's acts.**
  - `isReviewer(env)` (`src/drive-presence.ts`) is `(env.WITNESS_REVIEWER ?? '') !== ''`.
  - `main` checks it directly — never through `sessionMarker`. Under it, only `read`, `index`, `log`, `diff`, `--version` and help requests run. Every other verb, and bare `witness`, refuses with `reviewer-cannot` (exit 2).
  - `session-dashboard.sh` exits at once under `WITNESS_REVIEWER`.
  - **This guard is a tripwire, not a control.** It catches a harness that ignored the tool flags. A reviewer that had a shell could unset the variable; R1–R2 are what take the shell away.
- **R4 — Prompts tell the truth about tools.**
  - design-critic, plan-critic, slicing-critic and the arbiter say they have none.
  - drift-reviewer says it has none at ship, and read-only file tools in deep mode.
- **R5 — Windows.** The two Windows-only argv tests gain R2's flags, and a caret test pins `''` on the batch-shim path (P10).
- **R6 — The suite's env.** `tests/helpers.ts` gains `WITNESS_REVIEWER: undefined` at `:85` and in `hermeticEnv`, so a suite run inside a reviewer still runs.

### E4 — Recorded, not fixed (Task 6 → DESIGN "Open / deferred")

1. **Hidden states get no layout check.** A select's open list, popovers and script-drawn states are never rendered by the check; the human sees them live at `--open`.
2. **`controls` lists markup only.**
   - States drawn by a CSS class or by script are not listed, nor `:hover`/`:focus` styling, nor content past a scrolling pane.
   - Named entities beyond the seven listed stay as written.
   - `<p>` is not auto-closed, so `<p hidden>Error<p>Next</p>` reads as one element.
   - Ids `elementIds` finds in comments, scripts or `data-id` can anchor a row; this is the outline's existing looseness.
3. **There is no CLI-owned render pass.**
4. **A review cannot be forced past a full gate answer on the same key.** The levers are the look, the spec, a canon doc, the pin or harness, or `witness gate design <id> --fresh` while unsettled.
5. **Each review of bytes the gate has not judged in full asks again.** The skill's once-per-ask rule bounds this.
6. **`--file` has no size cap** (gate parity).
7. **Debts no battery can read wait for `witness dismiss`.**
   - Moved debts on a spec are judged by no battery: no code battery reads a spec's stream.
   - Row 122's "the next effort meets them" is display-only. P5 measures how much silence used to clear.
   - A `moved_from` that `rename` left stale falls back to the minting gate's kind.
8. **A `read` lens can reach what its harness allows.**
   - pi has no path confinement.
   - Claude's Read stays in the working directory by default (P12), but settings allow rules or `additionalDirectories`, which `--safe-mode` keeps (P14), widen it.
   - Under the root, a gitignored file such as `.env.local` is readable, and claims are journaled free text.
   - Only `design-reviewer` and deep drift get `read`.
9. **An older claude or pi without these flags fails every reviewer call loudly:** claude's `--tools`, `--safe-mode` or `--no-session-persistence`, pi's `--no-tools`.
10. **R3's guard is a tripwire.** It stops a harness that ignored the tool flags, not a reviewer that has a shell.
11. **There is no CLI route for reviewing the running app** — only the skill's method.

## Global Constraints

- Node ≥ 20. TypeScript ESM, `strict` + `noUncheckedIndexedAccess`. `npx biome check src tests plugin scripts` clean. No new dependencies.
- No new config key; `witness migrate` is untouched.
- `witness review` writes nothing: no journal line, state commit, lock, draft or `.witness/` file.
- **Exact copy — review** (D3, D4):
  - `review: design <spec-id>`
  - `look: <path> · <sha7> · registered` or `look: <path> · <sha7> · not registered`
    - `<sha7>` is `short(htmlSha(html))`.
    - `<path>` is `designRel`, or the resolved `--file` path.
    - `registered` means the bytes' `htmlSha` equals the registered look's.
  - `model: <model>` — the replayed run's `model` on a replay.
  - `answered: gate round <r> · run <run-id> — the gate judged these bytes in full under this setup; nobody was asked again`
  - `earlier: gate round <r> judged these bytes in delta mode — <b> blocking`, or `earlier: gate round <r> judged these bytes under another setup (<fields>) — <b> blocking`. `<fields>` lists those of `witness`, `pin`, `harness` and `prompts` that differ, joined ` · `.
  - `findings[N]{reviewer,blocking,pin,anchor,claim}:` (only with findings) and `malformed[N]{reviewer,field,rule}:` (only when malformed)
  - `outcome: clean` | `outcome: <b> blocking` | `outcome: malformed — a reviewer answered twice with an invalid verdict; run the review again`
  - `note: a review journals nothing and decides nothing — only the gate's verdict counts`
- **Exact copy — refusals** (D5, R3):
  - `usage: witness review design <spec-id> [--file <html>]`, identical in `VERB_USAGE`.
  - `v('gate', 'review-scope', <name>, "design — only the design gate's reviewers run on demand: witness review design <spec-id>")`
  - `v('review', 'review-in-session', '<marker> is set', "a human's chat — a session drive started never runs a review")`
  - `v('design', 'no-design', '<spec-id> — <rel> absent', 'a registered look — or a page: witness review design <spec-id> --file <html>')`
  - `v('--file', 'input-unreadable', <abs> | '<abs> is not a regular file', 'a readable HTML file')`
  - `v('witness', 'reviewer-cannot', '<verb> under WITNESS_REVIEWER' | '(no verb) under WITNESS_REVIEWER', 'nothing — a reviewer reads and never acts; it may run witness read, index, log or diff')`
  - `unknown-spec` and `not-ui` reuse the `v()` calls at `src/verbs/design.ts:39` and `:45` word for word.
- **Exact copy — outline, critic and deferrals** (D2, D7, D8):
  - `controls[N]{anchor,line,kind,holds}:` through `rows`.
  - `controls-note: from markup only — states a CSS class or a script draws, :hover and :focus styles, and content past a scrolling pane are not listed; read the source for those`. Print it through `cmd`, never `kv`: `kv` quotes values that contain commas.
  - `### Design artifact: the look for <spec-id>` and `### Controls in the look (from markup)`.
  - The deferrals block's sentence "Silence is read as fixed: an obligation this round does not report is discharged." becomes "The gate reads silence as fixed: an obligation a gate round does not report is discharged."
- **Exact flags** (R2):
  - claude: `['-p', '--output-format', 'json', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--tools', <'' | 'Read,Grep,Glob'>]`, then `--model` if pinned.
  - pi: `--no-tools`, or `--tools read,grep,find,ls`, after `'--no-context-files'`.
- Code comments cite "row 215", "row 216" or "row 217". D-, K- and R-labels are local to this plan.
- Fakes live in `fakeScenario()` dirs. No test holds its worker's event loop for 60 s or more (row 213).
- **New assertions go in new tests** whose titles end `(issue #73)`. An existing test changes only where it pins behaviour this plan changes, and each task lists those edits.
- Never modify a consumer repo. Reviewer subagents run on model `opus`.

## Review Focus

1. **Markup a tokenizer can misread must not drop or invent a row.** Cases:
   - a comment naming `<script>`, or a script holding `'<!--'`;
   - `<style-guide>` containing a details;
   - a quoted `>` before `hidden`, or an apostrophe in an unquoted value;
   - `</p` against `</path>`;
   - `İ` before a script;
   - an svg `<title/>`, `<script/>` or `<template/>`;
   - template bodies holding comments, or `</TEMPLATE>`;
   - a hidden panel of nested divs.

   → Task 1.
2. **The issue's own false finding, in new forms:** options carrying markup, a `label` or a bare `<`; a customizable select's `<selectedcontent>`; a comment inside a select. → Task 1.
3. **A review after a delta round, or after edit-then-revert,** replays only a full answer. → Task 3.
4. **A debt no lens can read is neither asked about nor cleared:** a code debt on a spec at design; a screenshot debt at ship; a code debt shown to the design-reviewer; a debt handed home by a take-back. → Task 2.
5. **A reviewer inside a drive session (both markers set) that a page tells to act:** it has no tool to act with, and witness refuses its verbs. → Task 4.

## File Structure

| File | Change |
|---|---|
| `src/design.ts` | Add `ControlKind`, `LookControl`, `CONTROLS_NOTE`, `lookControls`, `controlsBlock`, `designReviewed` |
| `src/verbs/read.ts` | `--design --outline` prints `controlsBlock` after the outline (`:115-119`) |
| `src/gate.ts` | `GateSpec.reads` / `lensReads`; `readsOf`, `assertReads`, `debtKinds`, `judgeable`. Extract `gateLenses` (`:281-297`), `gateSetup` (`:274-280`, `:315-317`), `lensPrompt` (`:461`), `findingRows` (`:137-142`) and `malformedRows` (`:147-150`). The discharge at `:566-568` |
| `src/gates/*.ts` | Each `registerGate` declares `reads` (implement also `lensReads`). `design.ts`'s `resolve` uses `designReviewed` (`:53-59`, `:68`) |
| `src/rounds.ts` | Add `answersKey`; `appendKind`'s cached search (`:460`) calls it |
| `src/deferral.ts` | D8 wording (`:64-69`) |
| `src/verbs/next.ts` | The `:600-606` comment |
| `src/review.ts` | **Create.** `ReviewInput`, `ReviewRun`, `reviewOnce` |
| `src/verbs/review.ts` | **Create.** The verb |
| `src/reviewer.ts` | `ContentKind`, `ToolPolicy`, `toolsFor`; `InvokeOpts.tools`, passed to the spawn (`:163`) |
| `src/battery.ts` | `runLens` passes `tools: toolsFor(lens.reviewed)` (`:30-32`) |
| `src/harness.ts` | Both `reviewer.spawn`s take `tools: ToolPolicy = 'none'` (`:159-167`, `:217-226`) |
| `src/drift.ts` | `deepDrift` passes `tools: 'read'` (`:144`) |
| `src/drive-presence.ts` | Add `isReviewer` |
| `src/cli.ts` | `review` in `VERBS` / `VERB_USAGE`; the R3 guard |
| `plugin/hooks/session-dashboard.sh` | The R3 early exit |
| `prompts/design-critic.md`, `plan-critic.md`, `slicing-critic.md`, `drift-reviewer.md`, `arbiter.md` | D8, R4 |
| `plugin/skills/witness-design/SKILL.md`, `witness-plan/SKILL.md:54`, `witness-implement/SKILL.md:61`, `plugin/commands/witness.md` | D6, D9, D11 |
| `tests/design-controls.test.ts`, `tests/debt-kind.test.ts`, `tests/review.test.ts`, `tests/reviewer-guard.test.ts` | **Create** |
| `tests/helpers.ts` | R6 |
| Stand-in gate declarations: `tests/decide.test.ts:22`, `docs-injection.test.ts:61`, `gate-delta-synthetic.test.ts:36-39`, `gate-lens-override.test.ts:18`, `gate-engine.test.ts:24`, `gate-stale-checks.test.ts:21`, `policy-pins.test.ts:68`. Also `tests/deferral.test.ts:71`, `:165` | K1 declarations, D8 wording |
| `tests/read.test.ts`, `rounds.test.ts`, `gate-design.test.ts`, `harness.test.ts`, `spawn.test.ts`, `design-lens.test.ts`, `arbiter.test.ts`, `stamp.test.ts`, `retry.test.ts`, `trust.test.ts`, `hooks-dashboard.test.ts`, `skills.test.ts`, `prompts.test.ts` | Tests below |
| `DESIGN.md`, `README.md` | Rows 215–217; markers; Open / deferred; the "Design gate." paragraph; the verbs table; the reviewer paragraph |

---

### Task 0: Branch, and commit this plan

- [ ] **Step 1**

```bash
git switch -c issue-73-look-review main
git add docs/superpowers/plans/2026-10-30-issue-73-look-review.md
git commit -m "docs: plan for issue #73 — looks judged from their source, reviewers that only read (rows 215-217)"
```

---

### Task 1: A look's controls (D7)

**Files:**
- Modify: `src/design.ts`, `src/verbs/read.ts:115-119`
- Create: `tests/design-controls.test.ts`
- Modify: `tests/read.test.ts`. `uiRepo()` gains a parameter `html = DESIGN_HTML`, passed to `writeDesign`.

**Interfaces:**
- Consumes: `elementIds`' regex (`src/design.ts:13`), `logSafe` (`src/toon.ts:33`), `rows`, `cmd` (`src/toon.ts`).
- Produces:

```ts
// src/design.ts — row 215
export type ControlKind = 'select' | 'details' | 'dialog' | 'popover' | 'menu' | 'listbox' | 'tooltip'
  | 'tabpanel' | 'alertdialog' | 'collapsed' | 'hidden' | 'template'
export type LookControl = { anchor: string; line: number; kind: ControlKind; holds: string }  // a type, so `rows` accepts it
export const CONTROLS_NOTE: string        // the exact note text (Global Constraints)
export function lookControls(html: string): LookControl[]   // D7; never throws; linear
export function controlsBlock(html: string): string[]       // rows('controls', …), then cmd('controls-note', CONTROLS_NOTE)
```

- [ ] **Step 1: Write the failing tests** in `tests/design-controls.test.ts`. The two helpers below put body line 1 at line 3.

```ts
const page = (body: string) => '<!doctype html>\n<html><body>\n' + body + '\n</body></html>\n'
const rows = (html: string) => lookControls(html).map((c) => [c.anchor, c.line, c.kind, c.holds])
```

```ts
it('lists every option of a select — markup, a label, a bare "<", optional end tags (issue #73)', () => {
  expect(rows(page(['<section id="reject-form">', '<select id="reject-reason" aria-label="Reject reason">',
    '<option><span class="dot"></span>Unsafe code</option><option>Doesn&#39;t work',
    '<option label="Not from the author"></option><option>< 1 hour</option><option>  </option>',
    '<option label="Short">Long reason</option>', '</select></section>'].join('\n')))).toEqual([
    ['reject-reason', 4, 'select', "Unsafe code | Doesn't work | Not from the author | < 1 hour | Short"]])
})

it('a customizable select, and a comment inside a select, change nothing (issue #73)', () => {
  expect(rows(page('<select id="s"><button><selectedcontent></selectedcontent></button><option>A</option><!-- <option>Legacy</option> --><!-- </select> --><option>B</option></select>')))
    .toEqual([['s', 3, 'select', 'A | B']])
})

it('lists a closed details by its first-child summary, "Details" without one, never an open one (issue #73)', () => {
  expect(rows(page(['<div id="a"><details><p>no summary</p></details>',
    '<details>\n  <summary>What happens on <b>reject</b>?</summary><p>x</p></details>',
    '<details open><summary>Shown</summary></details></div>'].join('\n'))))
    .toEqual([['a', 3, 'details', 'Details'], ['a', 4, 'details', 'What happens on reject?']])
})

it.each([
  ['a comment that names <script>', '<!-- the <script> at implement --><details id="d"><summary>D</summary></details>', [['d', 3, 'details', 'D']]],
  ["a script holding '<!--'", "<script>const s = '<!--'</script><details id=\"d\"><summary>D</summary></details><!-- x -->", [['d', 3, 'details', 'D']]],
  ['a custom element named style-*', '<style-guide id="sg"><details><summary>A</summary></details></style-guide>', [['sg', 3, 'details', 'A']]],
  ['a quoted ">" before hidden', '<div id="k" title="a > b" hidden>x</div>', [['k', 3, 'hidden', 'a > b']]],
  ["an apostrophe in an unquoted value", "<img alt=Don't src=\"data:,x\"><details id=\"d\"><summary>More</summary></details><p title='x'>t</p>", [['d', 3, 'details', 'More']]],
  ['</path> is not </p', '<p id="p" hidden><svg><path></path></svg> Saved</p>', [['p', 3, 'hidden', 'Saved']]],
  ['a "</scripts>" string in a script', '<script>var s = "</scripts>"; s = "<dialog>x</dialog>"</script><dialog id="z" aria-label="Z"></dialog>', [['z', 3, 'dialog', 'Z']]],
  ['an upper-case </SCRIPT>', '<SCRIPT>x()</SCRIPT><details id="d"><summary>D</summary></details>', [['d', 3, 'details', 'D']]],
  ['İ before a script', 'İ'.repeat(40) + '<script>x()</script><details id="d"><summary>D</summary></details>', [['d', 3, 'details', 'D']]],
  ['an svg <title/>, and an svg left open before a div', '<svg><title/><title>t</title><div><textarea><dialog>no</dialog></textarea></div><details id="d"><summary>D</summary></details>', [['d', 3, 'details', 'D']]],
  ['<script/> and <template/> on HTML elements', '<script/>document.write("<dialog>no</dialog>")</script><template/><dialog>inert</dialog></template><dialog id="y" aria-label="Y"></dialog>', [['y', 3, 'template', 'template'], ['y', 3, 'dialog', 'Y']]],
  ['nested templates', '<template><template></template><dialog>no</dialog></template><dialog id="y" aria-label="Y"></dialog>', [['y', 3, 'template', 'template'], ['y', 3, 'dialog', 'Y']]],
  ['a template body holding comments and </TEMPLATE>', '<template id="t"><!-- cloned from this <template> --><!-- ends at </template> --><dialog>inert</dialog></TEMPLATE><details id="d"><summary>D</summary></details>', [['t', 3, 'template', 'template'], ['d', 3, 'details', 'D']]],
  ['<noscript>, <details.x>, <xmp>, --!> and <!-->', '<noscript><dialog>no</dialog></noscript><details.x>no</details.x><xmp><dialog>no</dialog></xmp><!-- a --!><!--><dialog id="v" aria-label="V"></dialog>', [['v', 3, 'dialog', 'V']]],
  ['a tag the source ends inside', '<dialog id="v" aria-label="V"></dialog><div hidden title="never', [['v', 3, 'dialog', 'V']]],
])('%s misleads nothing (issue #73)', (_name, body, want) => expect(rows(page(body))).toEqual(want))

it('lists nothing inside a comment, script, style, template or noscript, nor after an unclosed comment (issue #73)', () => {
  expect(rows(page(['<!-- <select id="ghost"><option>no</option></select> -->',
    "<script>document.body.innerHTML = '<dialog>no</dialog>'</script>", '<style>/* <details> */</style>',
    '<template id="row" aria-label="Row"><details><summary>no</summary></details></template>',
    '<noscript><div hidden>no</div></noscript>', '<!-- unclosed', '<details><summary>no</summary></details>'].join('\n'))))
    .toEqual([['row', 6, 'template', 'Row']])
})

it("anchors to the element's own id as the outline reads it, else the span holding its line (issue #73)", () => {
  expect(rows(page(['<div id="a"><select><option>x</option></select></div><div id="b"><dialog aria-label="Confirm"></dialog><select id="c"><option>y</option></select></div>',
    '<select><option>z</option></select><div id="d">d</div>', '<p hidden id=bare>q</p>', '<p hidden data-id="q7">r</p>'].join('\n')))).toEqual([
    ['a', 3, 'select', 'x'], ['b', 3, 'dialog', 'Confirm'], ['c', 3, 'select', 'y'], ['d', 4, 'select', 'z'], ['d', 5, 'hidden', 'q'], ['q7', 6, 'hidden', 'r']])
  expect(rows(page('<select><option>x</option></select>\n<div id="a">a</div>'))).toEqual([['-', 3, 'select', 'x']])
})

it.each([
  ['<dialog id="k">\n  <h2>Delete</h2>\n  <p>this item?</p>\n</dialog>', 'dialog', 'Delete this item?'],
  ['<div id="k" hidden>\n  <div class="step">Step 1</div>\n  <div>Control-click the app</div>\n</div>', 'hidden', 'Step 1 Control-click the app'],
  ['<div id="k" popover>Tip</div>', 'popover', 'Tip'],
  ['<ul id="k" role="menu" aria-label="Actions"><li>x</li></ul>', 'menu', 'Actions'],
  ['<div id="k" role="listbox" title="Pick one">a</div>', 'listbox', 'Pick one'],
  ['<section id="k" role="alertdialog" aria-labelledby="t"><h2 id="t">Sure <em>now</em>?</h2></section>', 'alertdialog', 'Sure now?'],
  ['<button id="k" aria-expanded="false">More</button>', 'collapsed', 'More'],
  ['<p id="k" hidden>Pick <b>a reason</b> first.</p>', 'hidden', 'Pick a reason first.'],
  ['<p id="k" hidden><b>Pick</b> <i>one</i></p>', 'hidden', 'Pick one'],
  ['<p id="k" hidden>Step 1<br>Pick a reason</p>', 'hidden', 'Step 1 Pick a reason'],
  ['<p id="k" style="color:red; display: none">Gone</p>', 'hidden', 'Gone'],
  ['<div id="k" class="guide pane" hidden></div>', 'hidden', 'div.guide'],
  ['<details id="k" open hidden><summary>S</summary></details>', 'hidden', 'S'],
  ['<select id="k"></select>', 'select', 'select'],
  ['<textarea id="k" hidden>Default</textarea><p>Shown paragraph</p>', 'hidden', 'Default'],
  ['<template id="k" aria-label="Row"><p>r</p></template>', 'template', 'Row'],
])('lists %s as %s (issue #73)', (markup, kind, holds) => {
  expect(rows(page(`<main id="x">${markup}</main>`))).toEqual([['k', 3, kind, holds]])
})

it('never lists an open dialog, a disabled, class-hidden or comment-styled element, aria-hidden, an option or a summary (issue #73)', () => {
  expect(rows(page(['<main id="x"><dialog open>Hi</dialog><button disabled>Go</button><p class="err hidden">E</p>',
    '<div title="a hidden gem">g</div><svg aria-hidden="true"><path d="m9 18 6-6"/></svg><p style="/* display:none */ color:red">c</p>',
    '<select><option hidden>Pick one</option><option>A</option></select>',
    '<details><summary aria-expanded="false">S</summary></details></main>'].join('\n'))))
    .toEqual([['x', 5, 'select', 'Pick one | A'], ['x', 6, 'details', 'S']])
})

it('decodes entities once and turns an impossible code point into U+FFFD (issue #73)', () => {
  expect(rows(page('<main id="x"><select><option>a &amp;lt;b&amp;gt; &#39;c&#39;</option><option>&#99999999;&#0;&#xD800;</option></select></main>'))[0]![3])
    .toBe("a &lt;b&gt; 'c' | \u{FFFD}\u{FFFD}\u{FFFD}")
})

it('spells out control and format characters, and marks every cut with "…" (issue #73)', () => {
  expect(rows(page('<main id="x"><dialog aria-label="&#27;[2Jx&#x202e;"></dialog></main>'))[0]![3]).toBe('\\x1b[2Jx\\u{202e}')
  const long = lookControls(page(`<main id="x"><dialog aria-label="${'😀'.repeat(200)}"></dialog></main>`))[0]!.holds
  expect([...long]).toHaveLength(120)
  expect(long.endsWith('…')).toBe(true)
  const runs = lookControls(page(`<main id="x"><p hidden>${Array.from({ length: 60 }, (_, i) => `<b>  w${i}  </b>`).join('')}</p></main>`))[0]!.holds
  expect(runs.endsWith('…')).toBe(true)
})

it.each([
  ['<!--'], ['<details '], ['<a '], ['<select><option>'], ['<a ', '">'], ['<div hidden>', '</div>'], ['<dialog>', '</dialog>'],
  ['<details><summary>', '</summary>'], ['<select>', '</select>'], ['<p hidden aria-labelledby="t">', '<h2 id="t">T</h2>'],
  ['<p hidden><br>', '</p>'], ['<i id="a"></i><p hidden>', ''], ['<template>', ''], ['<p hidden style="/* ', '">'],
])('scans %j ×40,000 in linear time (issue #73)', (junk, tail = '') => {
  const t0 = performance.now()
  lookControls(junk.repeat(40_000) + tail)                       // bare: no trailing ">" from a page wrapper
  expect(performance.now() - t0).toBeLessThan(1500)
})
```

In `tests/read.test.ts`:

```ts
it("a look's outline lists its controls after the anchors, and names what markup cannot show (issue #73)", async () => {
  const repo = await uiRepo(DESIGN_HTML.replace('<button>Save</button>',
    '<select id="reason"><option>Unsafe code</option><option>Other</option></select><button>Save</button>'))
  const r = await repo.cli(['read', 'booking-form', '--design', '--outline'])
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('controls[1]{anchor,line,kind,holds}:\n  reason,6,select,Unsafe code | Other')
  expect(r.stdout).toContain(`controls-note: ${CONTROLS_NOTE}`)
  expect(r.stdout.indexOf('outline[')).toBeLessThan(r.stdout.indexOf('controls['))
})

it('a look with no controls still prints the table and the note; a markdown outline has neither (issue #73)', async () => {
  expect((await (await uiRepo()).cli(['read', 'booking-form', '--design', '--outline'])).stdout).toContain('controls[0]{anchor,line,kind,holds}:')
  expect((await (await planRepo()).cli(['read', 'auth-refresh-plan-1', '--outline'])).stdout).not.toContain('controls-note:')
})
```

- [ ] **Step 2: Run them; they fail**

Run: `pnpm vitest run tests/design-controls.test.ts tests/read.test.ts -t "issue #73"`
Expected: FAIL — `lookControls` / `CONTROLS_NOTE` are not exported, and there is no `controls[`.

- [ ] **Step 3: Implement** D7 in `src/design.ts` beside `elementIds`, in three passes over arrays, never re-scanning per element:
  1. the index-walking tokenizer (D7.1–7.2), with an inner suppressed run for template bodies;
  2. the four D7.3 indices;
  3. rows (D7.4–7.7), with line numbers from a precomputed array of newline offsets.

  Search for closers with forward cursors that never move back. Use no regex over unbounded spans.

  In `read.ts`, inside `if (values.outline)` and only when `values.design`: after the outline rows, call `controlsBlock(text).forEach(ctx.out)`.

- [ ] **Step 4: Run them; they pass**

Run: `pnpm vitest run tests/design-controls.test.ts tests/read.test.ts`
Expected: PASS, every pre-existing `read` test included.

- [ ] **Step 5: Commit**

```bash
git add src/design.ts src/verbs/read.ts tests/design-controls.test.ts tests/read.test.ts
git commit -m "feat(read): a look's outline lists its controls and hidden states, from a single-pass tokenizer (issue #73)"
```

---

### Task 2: Gates declare what their lenses read; one composer; debts per lens (rows 216, 215 D2/D3)

**Files:**
- Modify:
  - `src/gate.ts`, `src/reviewer.ts`, `src/rounds.ts`, `src/deferral.ts:64-69`, `src/verbs/next.ts:600-606`;
  - the `registerGate` objects in `src/gates/{decompose,plan,design,implement,ship}.ts`.
- Modify (stand-in gates, K1):
  - `tests/decide.test.ts:22`, `tests/docs-injection.test.ts:61`, `tests/gate-engine.test.ts:24`, `tests/gate-stale-checks.test.ts:21`, `tests/policy-pins.test.ts:68` — add `reads: 'docs'`;
  - `tests/gate-lens-override.test.ts:18` and `tests/gate-delta-synthetic.test.ts:36-39` — add `reads: 'docs'` and `lensReads: { 'code-reviewer': 'screens' }`.
- Modify (D8 wording): `tests/deferral.test.ts:71`, `:165` assert "The gate reads silence as fixed".
- Create: `tests/debt-kind.test.ts`
- Modify: `tests/rounds.test.ts`

**Interfaces:**
- Consumes: `openDeferrals`, `deferralsBlock`, `DeferralEntry` (`src/deferral.ts`); `readStream` (`src/journal.ts`); `anchorKey` (`src/verdict.ts`); `keyOf`, `sameKey`, `fellBack`, `GateRunEntry` (`src/rounds.ts`).
- Produces:

```ts
// src/reviewer.ts — rows 216/217
export type ContentKind = 'tree' | 'docs' | 'design' | 'screens'
// src/gate.ts — row 216
export interface GateSpec { /* … */ reads: ContentKind; lensReads?: Record<string, ContentKind> }
export function readsOf(gate: string, lens?: string): ContentKind | undefined        // undefined: unknown gate
export function assertReads(spec: GateSpec, reviewed: Reviewed, overrides?: Record<string, LensOverride>): void  // K1; throws
export function debtKinds(root: string, d: DeferralEntry, home: Entry[]): ContentKind[]   // K2; `home` = the judged stream
export function judgeable(root: string, d: DeferralEntry, home: Entry[], gate: GateName, lenses: readonly string[]): boolean
export function gateLenses(root: string, cfg: Config, gate: GateName, names: string[],
  overrides?: Record<string, LensOverride>): Result<Lens[]>
export function gateSetup(root: string, spec: GateSpec, entries: Entry[], lenses: readonly string[]):
  { forLens(name: string): string; text: string; backstopped: OutstandingDemotion[] }   // K3
export function lensPrompt(lens: Lens, setup: string, menu: string, body: string): string
export function findingRows(verdicts: ReviewerVerdict[]): Array<Record<string, string>>
export function malformedRows(malformed: NonNullable<GateRunEntry['malformed']>): Array<Record<string, string>>
// src/rounds.ts — row 215 D3
export function answersKey(run: GateRunEntry, key: GateKey): boolean
```

- [ ] **Step 1: Write the failing tests** in `tests/debt-kind.test.ts`.
  - Streams are built with `seededRepo()` and `commitEntry` (`tests/helpers.ts:642`).
  - Copy locally, since neither is exported:
    - the design setup `designed()` and its `CLEAN`, from `tests/gate-design.test.ts:12-28`;
    - the plan setup and its clean verdict, from `tests/gate-plan.test.ts`.
  - "A round" means a `gate-run` entry `{ run_id, gate, verdicts: [{ reviewer, findings: [{ blocking: true, anchor, claim: 'x' }] }] }`.

```ts
it('gates declare what their lenses read, and readsOf answers it (issue #73)', async () => {
  await import('../src/gates/index.js')
  expect(['decompose', 'plan', 'design', 'implement', 'ship'].map((g) => readsOf(g)))
    .toEqual(['docs', 'docs', 'design', 'tree', 'tree'])
  expect(readsOf('implement', 'design-reviewer')).toBe('screens')
  expect(readsOf('implement', 'code-reviewer')).toBe('tree')
  expect(readsOf('nope')).toBeUndefined()
  expect(() => assertReads(gateSpec('design')!, { kind: 'tree', root: '/', files: [] })).toThrow()
})
```

  - **"a debt is of the kinds its raising lenses read, after a take-back too (issue #73)".**
    - Stream `p1` holds round `r-1`, gate `implement`, with a design-reviewer finding at `initial.png`.
    - The debt `d-1` (gate implement, anchor `initial.png`, `caused_by_run: 'r-1'`) moves `p1 → s1 → s2 → s1`. Stream `s1` therefore holds two deferral entries for `d-1`: first one with `moved_from: 'p1'`, then one with `moved_from: 's2'`. Stream `s2` holds one, with `moved_from: 's1'`.
    - Expect `debtKinds(root, <s1's second entry>, readStream(root, 's1'))` → `['screens']`.
  - **"an unmoved debt reads its anchor round from the stream being judged, even after a rename (issue #73)".**
    - On stream `p2`, a round `r-2` with a design-reviewer finding at `shot.png`.
    - A debt with `artifact: 'old-name'` (no `moved_from`) and `caused_by_run: 'r-2'`.
    - `debtKinds(root, d, readStream(root, 'p2'))` → `['screens']`.
  - **"with no anchor round, or an unreadable stream, a debt takes its minting gate's kind (issue #73)".**
    - With `caused_by_run: 'r-gone'`:
      - `implement`, `ship` → `['tree']`;
      - `design` → `['design']`;
      - `plan`, `decompose` → `['docs']`.
    - A gate-`implement` debt whose `moved_from` stream holds the line `{not json` → `['tree']`, with no throw.
  - **"each lens is asked only about the debts it reads, in an order-free text (issue #73)".**
    - The implement plan's stream holds a tree debt `d-code` (anchor `src/token.ts#rotate`) and a screens debt `d-shot` (anchor `initial.png`, raised by design-reviewer in its round).
    - `s = gateSetup(root, gateSpec('implement')!, entries, ['code-reviewer', 'design-reviewer'])`:
      - `s.forLens('code-reviewer')` contains `(d-code)` and not `(d-shot)`; `s.forLens('design-reviewer')` the reverse;
      - `s.text` equals the `text` from the battery `['design-reviewer', 'code-reviewer']`.
    - `judgeable(root, d-shot, entries, 'ship', ['drift-reviewer', 'code-reviewer'])` is false; `judgeable(root, d-code, entries, 'ship', ['drift-reviewer', 'code-reviewer'])` is true.
  - **"the design gate neither asks about nor clears a code debt moved onto its spec (issue #73)".**
    - Setup: `designed()`.
    - Commit two debts to stream `booking-form`:
      - `d-code`: gate implement, anchor `src/token.ts#rotate`, `moved_from: 'booking-form-plan-1'`, `caused_by_run: 'r-gone'`;
      - `d-look`: gate design, anchor `design#save-bar`, `caused_by_run: 'r-gone'`.
    - Run the gate with `CLEAN`. The design-critic's `stdin` contains `(d-look)` and `The gate reads silence as fixed`, and not `(d-code)`.
    - After the round, `openDeferrals(readStream(root, 'booking-form')).map((d) => d.id)` equals `['d-code']`.
  - **"the plan gate neither asks about nor clears an implement debt on its plan (issue #73)".**
    - Use the plan setup, with an implement debt `d-code` committed on the plan's stream.
    - Run the plan gate with its clean verdict. The plan-critic's `stdin` has no `(d-code)`, and the debt stays open.
  - **In `tests/rounds.test.ts`, "answersKey accepts only a judged, pinned run on the same key (issue #73)".**
    - False: a `malformed` run; a run with no verdicts; any differing key field.
    - False: a fallen-back run written `{ ...run, model: 'm-standin', pin: 'm0' }`, checked against a key with `pin: 'm0'`.
    - True otherwise.

- [ ] **Step 2: Run them; they fail**

Run: `pnpm vitest run tests/debt-kind.test.ts tests/rounds.test.ts -t "issue #73"`
Expected: FAIL — exports are missing, and the design gate still lists `(d-code)` and clears both debts.

- [ ] **Step 3: Implement.**
  - **Declarations.** Add `reads`/`lensReads` to `GateSpec` and declare them in the five gates and the seven stand-in gates.
  - **The rule.** Write `readsOf`, `assertReads`, `debtKinds` (K2) and `judgeable`.
  - **`answersKey`.** Add it; `appendKind`'s loop at `src/rounds.ts:460` calls it.
  - **The extraction.** Extract the five `gate.ts` functions from the lines in File Structure. Then in `judge`:
    - call `assertReads(spec, input.reviewed, input.lensOverrides)` right after `resolve`;
    - call `gateSetup(root, spec, entries, active)`;
    - pass `setup.forLens(lens.name) + (delta && inDelta(lens.name) ? block : '')` to `lensPrompt`;
    - hash `setup.text` (plus `block` in a delta round) into the setup and asked shas;
    - in the discharge at `:566-568`, add `judgeable(root, d, entriesNow, spec.gate, active)`.

    `renderGateRun` uses `findingRows` / `malformedRows`.
  - **Wording.**
    - Apply D8's deferrals wording, and update `tests/deferral.test.ts:71`, `:165`.
    - Reword the `next.ts:600-606` comment to: "The real bite is the injection into every lens that can read the debt" (row 216).

- [ ] **Step 4: Run them, and the gate's suites; they pass**

Run: `pnpm vitest run tests/debt-kind.test.ts tests/rounds.test.ts tests/gate-design.test.ts tests/gate-plan.test.ts tests/gate-engine.test.ts tests/gate-implement.test.ts tests/docs-injection.test.ts tests/policy-pins.test.ts tests/deferral.test.ts tests/gate-delta.test.ts tests/gate-delta-code.test.ts tests/gate-delta-synthetic.test.ts tests/gate-lens-override.test.ts tests/gate-stale-checks.test.ts tests/decide.test.ts tests/design-lens.test.ts tests/battery.test.ts tests/exits-line.test.ts tests/decide-show.test.ts tests/delta-plan.test.ts tests/next.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts src/gates src/reviewer.ts src/rounds.ts src/deferral.ts src/verbs/next.ts tests
git commit -m "fix(gate): each lens is asked only about debts it can read, and silence clears only those (row 216)"
```

---

### Task 3: `witness review design` — the gate's question, on demand (row 215)

**Files:**
- Modify: `src/design.ts`, `src/gates/design.ts:53-59` and `:68`, `src/gate.ts` (`findingRows`), `src/cli.ts`
- Create: `src/review.ts`, `src/verbs/review.ts`, `tests/review.test.ts`
- Modify: `tests/gate-design.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `controlsBlock`.
  - Task 2: `readsOf`, `assertReads`, `gateLenses`, `gateSetup`, `lensPrompt`, `findingRows`, `malformedRows`, `answersKey`.
  - Existing: `batteryFor`, `gateSpec`; `runBattery`; `anchorMenu`; `promptsSha`; `resolveJudge`; `stageModel`, `unansweredPin`; `designGateSha`, `designRel`, `htmlSha`, `validateDesignArtifact`; `sessionMarker`; `short`; `logSafe`.
- Produces:

```ts
// src/design.ts — the one home for what the design critic reads (D2)
export function designReviewed(html: string | undefined, spec: CanonDoc): { reviewed: Reviewed; promptBody: string }
// src/review.ts
export interface ReviewInput { cls: ChangeClass; reviewedSha: string; reviewed: Reviewed; promptBody: string }
export interface ReviewRun {
  model: string
  verdicts: ReviewerVerdict[]
  malformed: NonNullable<GateRunEntry['malformed']>
  answered?: { round: number; run: string }                       // D3 replay
  earlier?: { round: number; why: string; blocking: number }     // D3 `earlier:`
}
export async function reviewOnce(ctx: Ctx, root: string, cfg: Config, gate: GateName, target: string,
  input: ReviewInput): Promise<Result<ReviewRun>>
// src/verbs/review.ts
export async function run(ctx: Ctx, argv: string[]): Promise<number>
```

- [ ] **Step 1: Write the failing tests** in `tests/review.test.ts`.
  - **Setup per test.**
    - Build the repo:
      - `seededRepo()`;
      - `writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })`;
      - `approve`;
      - `patchConfig(repo, { docs: { design: ['docs/ui/canon.md'] } })`;
      - `repo.write('docs/ui/canon.md', '# Canon\nOne primary action.\n')`, then commit.
    - Then `scenario = fakeScenario()` and `env = gateEnv(scenario)`.
    - No `writeDesign`/`witnessDesign` in shared setup. Tests that need a registered look call `writeDesign` themselves.
  - **Local verdicts:**
    - `CLEAN`, as in `gate-design.test.ts:12-18`;
    - `BLOCKING = { coverage: CLEAN.coverage, findings: [{ blocking: true, anchor: 'design#save-bar', claim: 'Save sits below the fold.' }] }`;
    - `V2 = DESIGN_HTML.replace('New service', 'Edit service')`.

```ts
it('reviews the registered look, unseen, and writes nothing (issue #73)', async () => {
  await writeDesign(repo, 'booking-form')                                 // registered, never --open'd
  putVerdict(scenario, BLOCKING)
  const head = repo.git('rev-parse', 'HEAD'); const lines = readStream(repo.root, 'booking-form').length
  const status = repo.git('status', '--porcelain')
  const local = () => readdirSync(join(repo.root, '.witness'), { recursive: true }).map(String).sort()
  const before = local()
  const r = await repo.cli(['review', 'design', 'booking-form'], { env })
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('review: design booking-form')
  expect(r.stdout).toMatch(/look: designs\/booking-form\.html · [0-9a-f]{7} · registered/)
  expect(r.stdout).toContain('design-critic,true,,design#save-bar,Save sits below the fold.')
  expect(r.stdout).toContain('outcome: 1 blocking')
  expect(r.stdout).toContain("note: a review journals nothing and decides nothing — only the gate's verdict counts")
  expect([repo.git('rev-parse', 'HEAD'), readStream(repo.root, 'booking-form').length, repo.git('status', '--porcelain')])
    .toEqual([head, lines, status])
  expect(local()).toEqual(before)
  expect(callCount(scenario)).toBe(1)
})

it("asks exactly the gate's question: the look, then its controls, then the spec (issue #73)", async () => {
  repo.write('d.html', DESIGN_HTML); putVerdict(scenario, CLEAN)
  expect((await repo.cli(['review', 'design', 'booking-form', '--file', 'd.html'], { env })).code).toBe(0)
  const asked = readFileSync(join(scenario, 'claude-calls/call-1/stdin'), 'utf8')
  rmSync(join(repo.root, 'd.html'))
  await writeDesign(repo, 'booking-form'); await witnessDesign(repo, 'booking-form')
  await repo.cli(['gate', 'design', 'booking-form'], { env })
  expect(readFileSync(join(scenario, 'claude-calls/call-2/stdin'), 'utf8')).toBe(asked)
  const at = (s: string) => asked.indexOf(s)
  expect(at('### Design artifact: the look for booking-form')).toBeGreaterThan(-1)
  expect(at('### Design artifact: the look for booking-form')).toBeLessThan(at('### Controls in the look (from markup)'))
  expect(at('### Controls in the look (from markup)')).toBeLessThan(at('### Parent spec: booking-form'))
  expect(asked).toContain('One primary action.')
  expect(asked).not.toContain('designs/booking-form.html')
})
```

  Further `it`s, one per behaviour:

  - **The gate's full answer (D3).**
    - `writeDesign`, `witnessDesign`, then `gate design` with `BLOCKING`.
    - Then `review design booking-form` prints `answered: gate round 1 · run ` and the finding row. Exit 1; `callCount` stays 1.
  - **A delta round is never the answer.**
    - Round 1 on `DESIGN_HTML` with `BLOCKING`.
    - `writeDesign(repo, 'booking-form', V2)`, `witnessDesign`, then round 2 with `CLEAN`. Round 2's `stdin` contains `## Delta review`.
    - The review gives:
      - no `answered:`;
      - `earlier: gate round 2 judged these bytes in delta mode — 0 blocking`;
      - one more call, whose `stdin` has no `## Delta review`.
  - **Edit-then-revert replays the older full round.** After those two rounds, `writeDesign(repo, 'booking-form')` with no gate. The review prints `answered: gate round 1` and makes no call.
  - **A moved look or canon doc asks again.**
    - After round 1, `writeDesign` with V2: a new call, and no `answered:`.
    - Separately, after round 1, edit `docs/ui/canon.md` and commit: a new call, plus `earlier: gate round 1 judged these bytes under another setup (prompts) — 1 blocking`.
  - **Clean, with a note, and a claim spelled out.** Register the look with `writeDesign`. One `blocking: false` finding whose claim is `"Tighten \u001b[2J spacing"` gives:
    - exit 0;
    - `outcome: clean`;
    - a row containing `,false,`;
    - `Tighten \\x1b[2J spacing` (logSafe'd);
    - no raw ESC in stdout.
  - **Malformed.** Register the look with `writeDesign`. A verdict whose only finding is anchored `design#nope` gives:
    - exit 1;
    - `malformed[1]{reviewer,field,rule}:`;
    - the malformed outcome copy;
    - `callCount` 2.
  - **Refusals.** Each runs with `callCount` 0, and exits 2 unless stated:

    | Input | Refusal |
    |---|---|
    | no arguments, or `review design a b` | usage |
    | `review plan x` | `review-scope` |
    | `env: { ...env, WITNESS_DRIVE: '1' }` | `review-in-session` |
    | an unknown id | `unknown-spec` |
    | a spec without `ui: true` | `not-ui` |
    | no look and no `--file` | `no-design` |
    | `--file missing.html` | `input-unreadable` (exit 2, no crash) |
    | `--file .` | `input-unreadable` with `is not a regular file` |
    | a `--file` holding `DESIGN_HTML` plus `<script src="https://x/y.js"></script>` | `external-ref` |
  - **The resolved harness.**
    - `writeDesign`, then `patchConfig(repo, { harness: 'pi' })` and commit, then `putVerdict(scenario, CLEAN)`.
    - Exit 0; `callFor(scenario, 'design-critic', 'pi')` is defined; `callCount(scenario)` is 0.
  - **Subdirectory, relative file, held lock.**
    - `mkdirSync(join(repo.root, 'sub'))`, `repo.write('sub/d.html', DESIGN_HTML)`, `putVerdict(scenario, CLEAN)`.
    - Hold `acquireLock(repo.root, process.ppid)` while running `review design booking-form --file d.html` with `{ cwd: join(repo.root, 'sub') }`. The holder must be another live pid: `acquireLock` returns at once for its own pid (`src/lock.ts:139`).
    - Expect exit 0 and `/look: .*sub\/d\.html · [0-9a-f]{7} · not registered/`. Then release.

  In `tests/gate-design.test.ts`, add "the critic's input names the look and lists its controls (issue #73)": the critic's `stdin` contains `### Design artifact: the look for booking-form` and `controls[0]{anchor,line,kind,holds}:`.

- [ ] **Step 2: Run them; they fail**

Run: `pnpm vitest run tests/review.test.ts tests/gate-design.test.ts -t "issue #73"`
Expected: FAIL — `unknown verb: review`, and the old artifact header.

- [ ] **Step 3: Implement.**
  - **`designReviewed`.**
    - It absorbs `src/gates/design.ts:53-59` and the `reviewed` literal at `:68`, laid out as in D2.
    - With no artifact, the body keeps `(missing — no artifact to review)` and has no controls block.
    - `resolve` calls it.
  - **`findingRows`.** Pass anchor and claim through `logSafe`.
  - **`reviewOnce`**, in order:
    1. Battery, then `gateLenses`.
    2. `assertReads(gateSpec(gate)!, input.reviewed)`.
    3. Entries, then `gateSetup(root, gateSpec(gate)!, entries, battery)`.
    4. `resolveJudge`, `loadLocalConfig`, `stageModel`. Each refusal is returned as is.
    5. D3's key, replay and `earlier`.
    6. Otherwise `runBattery` over `lensPrompt(lens, setup.forLens(lens.name), anchorMenu(input.reviewed), input.promptBody)` with `{ cwd: root, pinField: `gates.${gate}.model`, timeoutMs, extensions }`. A refusal goes through `unansweredPin`, as at `src/gate.ts:470-473`.
  - **The verb.**
    - It follows D5 and imports `../gates/index.js`.
    - It runs `statSync(abs).isFile()` and the read inside one `try`.
    - It prints D4's lines through `kv` and `rows`.
  - **`src/cli.ts`:**

```ts
  // Row 215. The design gate's reviewers on demand: the gate's question, journaled nowhere.
  review: () => import('./verbs/review.js'),
```

```ts
  review: 'witness review design <spec-id> [--file <html>]',
```

- [ ] **Step 4: Run them; they pass**

Run: `pnpm vitest run tests/review.test.ts tests/gate-design.test.ts tests/verb-usage.test.ts tests/cli.test.ts tests/design-autonomy.test.ts tests/design-amend.test.ts tests/exits-line.test.ts tests/decide-show.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/design.ts src/gates/design.ts src/gate.ts src/review.ts src/verbs/review.ts src/cli.ts tests/review.test.ts tests/gate-design.test.ts
git commit -m "feat(review): witness review design — the gate's design critic on demand, journaling nothing (issue #73)"
```

---

### Task 4: A reviewer reads; it never acts (row 217)

**Files:**
- Modify (source):
  - `src/reviewer.ts`, `src/battery.ts:30-32`, `src/drift.ts:144`, `src/drive-presence.ts`, `src/cli.ts`;
  - `src/harness.ts:159-167` and `:217-226`;
  - `plugin/hooks/session-dashboard.sh`;
  - `tests/helpers.ts:85` and `:312-314`.
- Create: `tests/reviewer-guard.test.ts`
- Modify (tests):
  - `tests/harness.test.ts:193-221`;
  - `tests/spawn.test.ts`, plus its Windows-only expectations at `:266` and `:304`;
  - `tests/gate-design.test.ts`, `tests/design-lens.test.ts`, `tests/arbiter.test.ts`, `tests/stamp.test.ts`, `tests/hooks-dashboard.test.ts`;
  - `tests/retry.test.ts:26-34`, `tests/trust.test.ts:132-143`.

**Interfaces:**
- Consumes: `ContentKind` (Task 2).
- Produces:

```ts
// src/reviewer.ts — row 217
export type ToolPolicy = 'none' | 'read'
export function toolsFor(reviewed: Reviewed): ToolPolicy          // 'read' only for screens
// InvokeOpts gains: tools?: ToolPolicy                            // default 'none'
// src/harness.ts — both harnesses
reviewer: { spawn(pin: ParsedPin | undefined, extensions?: readonly string[], tools?: ToolPolicy): ReviewerSpawn, … }
// src/drive-presence.ts
export function isReviewer(env: Record<string, string | undefined>): boolean
// src/cli.ts
const REVIEWER_VERBS: ReadonlySet<string>   // read, index, log, diff
```

- [ ] **Step 1: Write the failing tests.**
  - **`tests/harness.test.ts`.**
    - Update the four pinned arrays at `:193-221` to R2's default (`none`) flags.
    - New: "a reviewer is spawned with no tools, or read-only ones (issue #73)".
      - `claude.reviewer.spawn(pin, [], 'read')` equals `['-p', '--output-format', 'json', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--tools', 'Read,Grep,Glob', '--model', …]`.
      - `pi.reviewer.spawn(pin, [], 'read')` contains `'--tools', 'read,grep,find,ls'` and not `'--no-tools'`.
    - New: "toolsFor gives read only to content named by path (issue #73)": `screens` → `'read'`; tree, docs, design → `'none'`.
  - **`tests/spawn.test.ts`.**
    - Update the Windows-only expectations at `:266` (pi) and `:304` (claude) with R2's flags.
    - New: "an empty argument survives the win32 batch shim (issue #73)": with a `claude.cmd` on the test PATH, `resolveSpawn('claude', ['--tools', ''], env, 'win32')` produces a cmd line (args index 4) containing `^^^"--tools^^^" ^^^"^^^"`.
  - **Call argv, through the fakes.** New `(issue #73)` tests:
    - `gate-design.test.ts`: the design-critic's argv has `--safe-mode`, `--strict-mcp-config`, `--no-session-persistence`, and `--tools` followed by an empty line.
    - `design-lens.test.ts`, with its implement setup: the design-reviewer's argv has `--tools` then `Read,Grep,Glob`; a code lens's has `--tools` then an empty line.
    - `arbiter.test.ts`: `--tools` then an empty line.
    - `stamp.test.ts`, with the `check --drift --deep` setup at `:73-92`: `--tools` then `Read,Grep,Glob`.
  - **`tests/retry.test.ts:26-34`, `tests/trust.test.ts:132-143`.** The existing loops keep `WITNESS_DRIVE` alone and their verb's rule. A new `(issue #73)` test in each expects `reviewer-cannot` under `{ WITNESS_REVIEWER: '1' }` and under `{ WITNESS_DRIVE: 'p1', WITNESS_REVIEWER: '1' }`.
  - **`tests/hooks-dashboard.test.ts`.** New: "is silent inside a reviewer, in a drive session too (issue #73)". In a directory holding `witness.config.yaml` (as the first test there writes it), run the hook with `WITNESS_BIN: stubBin(dir)` under `{ WITNESS_REVIEWER: '1' }`, then under `{ WITNESS_DRIVE: 'p1', WITNESS_REVIEWER: '1' }`. Both give empty stdout and exit 0.
  - **`tests/reviewer-guard.test.ts`**, on `seededRepo()` plus a ui spec and look:

```ts
const MARKS = [{ WITNESS_REVIEWER: '1' }, { WITNESS_DRIVE: 'booking-form-plan-1', WITNESS_REVIEWER: '1' }, { WITNESS_DRIVE: '-', WITNESS_REVIEWER: '1' }]
const ACTS = [['decide', 'design', 'booking-form', '--approve'], ['gate', 'design', 'booking-form'], ['abandon', 'x'],
  ['review', 'design', 'booking-form'], ['status'], []]

it.each(MARKS.flatMap((env) => ACTS.map((args) => [env, args] as const)))
  ('under %j a reviewer cannot run witness %j (issue #73)', async (env, args) => {
    const r = await repo.cli([...args], { env })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('reviewer-cannot')
    expect(r.stdout).toBe('')
  })

it.each([[['read', 'booking-form']], [['index']], [['log', 'booking-form']], [['--version']], [['decide', '--help']]])
  ('a reviewer may still read: witness %j (issue #73)', async (args) => {
    expect((await repo.cli(args, { env: MARKS[1]! })).code).toBe(0)
  })
```

- [ ] **Step 2: Run them; they fail**

Run: `pnpm vitest run tests/harness.test.ts tests/spawn.test.ts tests/reviewer-guard.test.ts tests/gate-design.test.ts tests/design-lens.test.ts tests/arbiter.test.ts tests/stamp.test.ts tests/retry.test.ts tests/trust.test.ts tests/hooks-dashboard.test.ts -t "issue #73"`
Expected: FAIL — no tool flags, no guard, no hook exit. These pass by design:
- the win32 caret test;
- the five read cases;
- Task 3's "the critic's input names the look and lists its controls".

- [ ] **Step 3: Implement.**
  - **Tools.**
    - Add `toolsFor`, and `InvokeOpts.tools` passed as `harness.reviewer.spawn(pin, opts.extensions, opts.tools ?? 'none')`.
    - `runLens` passes `tools: toolsFor(lens.reviewed)`; `deepDrift` passes `tools: 'read'`.
    - Both spawns render R2.
  - **Marker and hook.**
    - Add `isReviewer` to `src/drive-presence.ts`.
    - After `session-dashboard.sh`'s `witness.config.yaml` check, add: `[ -n "$WITNESS_REVIEWER" ] && exit 0`.
  - **Test env.** In `tests/helpers.ts`, add `WITNESS_REVIEWER: undefined` at `:85` and in `hermeticEnv`.
  - **The guard**, in `main`, after the `--version` branch and `helpRequested`, before the floor gate:

```ts
  // Row 217. A reviewer reads; it never acts. Its tools are already gone (the spawn flags); this tripwire
  // refuses what a harness that ignored them could still run. Checked directly: a reviewer spawned inside
  // a drive session carries both markers, and `sessionMarker` names the drive's first.
  if (isReviewer(ctx.env) && !helpRequested && !REVIEWER_VERBS.has(verb ?? '')) {
    renderRefusal([v('witness', 'reviewer-cannot', `${verb ?? '(no verb)'} under WITNESS_REVIEWER`,
      'nothing — a reviewer reads and never acts; it may run witness read, index, log or diff')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
```

- [ ] **Step 4: Run them, unfiltered; they pass**

Run: `pnpm vitest run tests/harness.test.ts tests/spawn.test.ts tests/reviewer-guard.test.ts tests/gate-design.test.ts tests/design-lens.test.ts tests/arbiter.test.ts tests/stamp.test.ts tests/retry.test.ts tests/trust.test.ts tests/wait.test.ts tests/hooks-dashboard.test.ts tests/reviewer.test.ts tests/battery.test.ts tests/harness-neutrality.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reviewer.ts src/battery.ts src/harness.ts src/drift.ts src/drive-presence.ts src/cli.ts plugin/hooks/session-dashboard.sh tests
git commit -m "fix(reviewers): reviewers get no tools or read-only ones, run without repo config, and cannot act (row 217)"
```

---

### Task 5: The prompts, the skills and `/witness` (D6, D8, D9, D11, R4)

**Files:**
- Modify: `prompts/design-critic.md`, `prompts/plan-critic.md`, `prompts/slicing-critic.md`, `prompts/arbiter.md`, `prompts/drift-reviewer.md`
- Modify: `plugin/skills/witness-design/SKILL.md`, `plugin/skills/witness-plan/SKILL.md`, `plugin/skills/witness-implement/SKILL.md`, `plugin/commands/witness.md`
- Test: `tests/skills.test.ts`, `tests/prompts.test.ts`

**Interfaces:**
- Consumes: the `witness review design` verb (Task 3) and the tool policy (Task 4).
- Produces: the prose below, exactly.

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/prompts.test.ts
it('a tool-less prompt says so, and the drift reviewer says when it reads (issue #73)', () => {
  for (const n of ['design-critic', 'plan-critic', 'slicing-critic', 'arbiter'])
    expect(readFileSync(promptPath(n), 'utf8'), n).toContain('You have no tools: you cannot read files, run commands or ask questions')
  const drift = readFileSync(promptPath('drift-reviewer'), 'utf8')
  expect(drift).toContain('At the ship gate the source files are inline and you have no tools')
  expect(drift).toContain('your file tools, which only read')
})

// tests/skills.test.ts, inside describe('design-critic prompt')
it('names its whole input and reads hidden content from the source (issue #73)', () => {
  expect(critic()).toContain("You receive the artifact's full HTML source")
  expect(critic()).toContain('**The source is the look.**')
  expect(critic()).toContain('Position still counts')
  expect(critic()).not.toContain('element-id list and the spec')
  expect(critic()).not.toContain('notes land in the journal')
})

it('the design skill checks the source, then renders only for layout (issue #73)', () => {
  const body = readFileSync(skillPath('witness-design'), 'utf8')
  for (const s of ['**Source pass**', '**Render pass**', 'never the evidence that something is missing',
    'layout not checked', 'every `<details>` open', 'that one open']) expect(body, s).toContain(s)
  expect(body).not.toContain('look at the picture')
})

it('a review outside the gate goes to the CLI, only when the human asks (issue #73)', () => {
  const body = readFileSync(skillPath('witness-design'), 'utf8')
  for (const s of ['## A review outside the gate', '$WITNESS review design <spec-id> --file "$DIR/look.html"',
    'Run it only when the human asks', 'The running app is not a look']) expect(body, s).toContain(s)
  expect(/^description: .*registered witness look.*witness review design/m.test(body)).toBe(true)
  const cmd = readFileSync(join(__dirname, '..', 'plugin', 'commands', 'witness.md'), 'utf8')
  expect(cmd.match(/\*\*A review outside the gate\*\*/g)?.length).toBe(2)
  for (const s of ['witness-plan', 'witness-implement'])
    expect(readFileSync(skillPath(s), 'utf8'), s).toContain('`controls`')
})
```

- [ ] **Step 2: Run them; they fail**

Run: `pnpm vitest run tests/skills.test.ts tests/prompts.test.ts -t "issue #73"`
Expected: FAIL, 4 tests.

- [ ] **Step 3: The prompts.**
  - **`prompts/design-critic.md`, `:3`.** Two replacements:
    - Replace "You receive the artifact's element-id list and the spec (frontmatter + `## Motivation` / `## Behavior`)." with "You receive the artifact's full HTML source, a `## Valid anchors` menu of its element ids, a list of its controls read from markup, and the parent spec in full. You have no tools: you cannot read files, run commands or ask questions — everything you may consider is below."
    - Replace "Mechanical checks already passed (artifact exists, self-contained, id-attributed sections, spec is ui-flagged, feature effort). You judge what machines cannot." with "Machines check that the artifact is self-contained and id-attributed and that the spec is ui-flagged; you judge what machines cannot."
  - **`:12`.** Replace "The reviewed content arrives as the artifact's ids and the parent spec." with "The reviewed content arrives as the artifact's source, its controls, and the parent spec."
  - **`:33`.** Replace "notes land in the journal without stopping anyone." with "a note never stops anyone."
  - **After the axes list (`:10`)**, add:

> **The source is the look.** A select's options, a closed menu, popover, dialog or `<details>`, a state drawn by CSS (`:hover`, `:focus`, `:disabled`) or by script, and content past a scrolling pane's height are all part of it: judge them from the source, and use the controls list as a checklist of what stays hidden until a control is used. Never report as missing what the source holds — when it stays hidden until a control is used, judge whether that control is visible and operable. Position still counts: a primary action below the fold is still a finding under axis 4.

  - **`prompts/plan-critic.md`, `slicing-critic.md`, `arbiter.md`.** At the end of the first paragraph after the `#` heading, add: "You have no tools: you cannot read files, run commands or ask questions — everything you may consider is below."
  - **`prompts/drift-reviewer.md`.** After "The reviewed content arrives as a tree: the spec's rendering plus source files.", add: "At the ship gate the source files are inline and you have no tools. In `witness check --drift --deep` no source files are inline: find and read the code with your file tools, which only read — you cannot run commands, edit files or ask questions."

- [ ] **Step 4: `plugin/skills/witness-design/SKILL.md`.**
  - **Frontmatter `description`.** Before "Normally invoked by /witness with the spec id.", insert "Also reviews a registered witness look when asked, through witness review design."
  - **Ground rule `:27`** becomes: "- **Never invoke gate reviewers or relay verdicts.** `witness gate design` runs the design-critic itself and journals what it said; `witness review design` runs it only when the human asks, and journals nothing."
  - **Step 3 (`:67`)** becomes:

> 3. **Check before showing: the source, then a render.** A picture shows one state of a page, so it is never the evidence that something is missing, unlabeled or out of reach. **Source pass** — read the page you wrote: each direction carries the spec's real content, and no promised element is reachable only behind a closed control. **Render pass** — then render it with the machine's browser (for example headless Chrome: `--headless --screenshot --window-size=1024,900`) at the widths the canon names, else 1024 px, and judge only layout: overflow, wrapping, clipping. Fix what either pass finds, naming the element by its `id`, and check again. With no browser, say "layout not checked" when you open it — never claim a check that did not run.

  - **Step 6 (`:78`).** Replace "Check it the same way as step 3, and save the page in the draft as `page`." with "Check it the same way as step 3, more deeply: the source pass confirms every state the spec promises, what each closed control holds (a select's options, a menu, popover, dialog or `<details>`), each control's accessible name, content past a scrolling pane's height, and the `id` of the element that shows each promised behavior; the render pass also renders a copy with every `<details>` open, and each `<dialog>` in a copy with that one open. Then save the page in the draft as `page`."
  - **New section**, directly before `## A behavior answer`:

````markdown
## A review outside the gate

When the human asks you to review or check a look — "check the UI for gaps", "review this screen" — the gate's own reviewers answer:

```bash
$WITNESS review design <spec-id>                          # the registered look
$WITNESS review design <spec-id> --file "$DIR/look.html"  # the full look this session is drafting, not registered yet
```

- It reads the look's source, its controls, the canon and the spec, exactly as the gate does, and journals nothing: no round, no sight, no decision. Render its output verbatim and in full; each finding names its anchor.
- Run it only when the human asks — never on your own, and never before showing, registering or gating a look: your own checks are steps 3 and 6. Once per ask: after fixing what it found, show the human the page instead of running it again. `--file` takes the full look you wrote, never the directions page or a file from elsewhere. On `outcome: malformed` run it once more; if it is malformed again, tell the human.
- `answered:` means the gate already judged these bytes in full under this setup, and that round's verdict is the answer; `earlier:` names a round that judged them in delta mode or under another setup.
- A screenshot may add layout notes (overflow, wrapping, clipping), each labeled as from a picture — never a claim that something is missing, unlabeled or out of reach.
- The running app is not a look: read the screen's code and the browser's DOM against `$WITNESS read <spec-id> --design --outline`, and use pictures only for layout. The implement gate's `design-reviewer` judges its screens from the browser test's captures.
````

- [ ] **Step 5: The other skills and `/witness`.**
  - **`witness-plan/SKILL.md:54`.** After "(`--outline`, then `--lines <a>-<b>`, when it is fat)", insert ": its `controls` rows name each closed or hidden state — a select's options, a closed panel, a dialog — and some step realizes each one".
  - **`witness-implement/SKILL.md:61`.** After "names every anchor with its line range", insert " and lists the look's `controls` — every closed or hidden state is one to build and to reach in a browser test, so fetch those lines too".
  - **`plugin/commands/witness.md:10`.** After "before the first `next`.", add "Words that ask you to review or check a look are not an ask: answer them with the `witness-design` skill's **A review outside the gate**, and queue nothing."
  - **After the closing "Never merge a PR" paragraph**, add "A human asking you to review or check a look — the approved `designs/<spec-id>.html`, or the page a design session is drafting, never the running app — is answered by the `witness-design` skill's **A review outside the gate**, never from a screenshot."

- [ ] **Step 6: Run them; they pass**

Run: `pnpm vitest run tests/skills.test.ts tests/prompts.test.ts tests/harness-neutrality.test.ts tests/command.test.ts`
Expected: PASS. `SKILL_GROUND_RULES` still matches ("Never invoke gate reviewers"), and "not checked" matches "layout not checked".

- [ ] **Step 7: Commit**

```bash
git add prompts plugin tests/skills.test.ts tests/prompts.test.ts
git commit -m "fix(design): check a look by its source, review it through the critic, and say which lenses have tools (issue #73)"
```

---

### Task 6: The decision record

**Files:**
- Modify: `DESIGN.md`:
  - three new rows after the last row;
  - markers on rows 48 (`:402`), 69 (`:423`), 70 (`:424`), 72 (`:426`), 88 (`:443`), 89 (`:444`), 105 (`:460`), 106 (`:461`), 122 (`:477`), 132 (`:487`), 185 (`:540`), 187 (`:542`), 191 (`:546`), 194 (`:549`) and 200 (`:555`);
  - the "**Design gate.**" paragraph (`:233`);
  - Open / deferred (`:610` and the list's end).
- Modify: `README.md`: the verbs table (`:283`, `:293`) and the reviewer paragraph (`:255-258`).

- [ ] **Step 1: Take the next three row numbers.** Re-read the table's last row: the witness-UI effort planned rows from 215. Use the same numbers in every marker and code comment (`grep -rni "row 21[5-7]" src tests plugin`).
- [ ] **Step 2: Three rows.** For each, the Choice column is its decisions condensed in the house's dense style, with the exact copy from Global Constraints. The Rationale column is its E1 item and its probes.
  - **215 ⊜ "A look is judged from its source, on demand as at the gate".**
    - Header: "Fixes issue #73; amends 72, 132 and 200; touches 48, 69, 70, 106, 185 and 194."
    - Choice: D1–D11.
    - Rationale: E1.1, P1–P4, and P3's failed scanner shapes — the reason this is a tokenizer and a lister, never a slicer.
  - **216 ⊜ "Each lens is asked only about debts it can read".**
    - Header: "Amends 122 and 187; closes the Open / deferred item on discharging other gates' debts."
    - Choice: K1–K4.
    - Rationale: E1.2 and P5, with KYC's malformed ship round and the measured volume.
  - **217 ⊜ "A reviewer reads; it never acts".**
    - Header: "Amends 88; touches 48, 89, 105 and 191."
    - Choice: R1–R6, stating that R3 is a tripwire.
    - Rationale: E1.3 and P6–P14, with P11's leak of hooks and `CLAUDE.md`, P8's two markers, and the round-2 trial build's bypass.
- [ ] **Step 3: Markers**, appended to each row's Choice cell:
  - **72:** "**Amended by 215:** the design-critic is reachable outside the gate — `witness review design <spec-id> [--file <html>]` asks it the gate's full-review question and journals nothing; its prompt names its whole input, the source and its controls, and makes hidden content part of the look."
  - **132:** "**Amended by 215:** a look's `--outline` also lists its controls and hidden states, read by a single-pass tokenizer; a lister, never a slicer, so the section extractor refused in `src/verbs/read.ts:16-22` stays refused."
  - **200:** "**Amended by 215:** the check is a source pass, then a render pass for layout only; a picture is never the evidence that something is missing."
  - **122:** "**Amended by 216:** each lens is asked only about the debts it can read — by what the raising lens read, which a move does not change — and a battery's silence discharges only those."
  - **187:** "**Amended by 216:** silence counts only for a debt some lens in the round could have reported."
  - **88:** "**Amended by 217:** the claude flag set gains `--safe-mode --strict-mcp-config --no-session-persistence --tools …`, and pi's `--no-tools` or `--tools …` — no tools, or read-only ones where a lens must open files; claude reviewers no longer load the repo's hooks or `CLAUDE.md`, nor save sessions."
  - **"Touched by 215:"**
    - 48: a review is advice, never evidence.
    - 69: the stage gains an on-demand review.
    - 70: a review's anchors are the gate's.
    - 106: a review replays only a full answer on its key.
    - 185: a review is always full.
    - 194: sight stays the precondition of gating and approving, and a review does neither.
  - **"Touched by 217:"**
    - 48: a reviewer can no longer act on what it judges.
    - 89: declared extensions still ride inside the hermetic set.
    - 105: the judge's harness renders the tool flags.
    - 191: claude reviewers load no plugin, and the dashboard hook exits in any reviewer.
- [ ] **Step 4: The "Design gate." paragraph.** Append: "`witness review design <spec-id> [--file <html>]` asks the same reviewers the same full-review question on demand — the registered look, or a page not yet registered — and journals nothing, takes no lock and needs no sight (row 215)."
- [ ] **Step 5: Open / deferred.** Delete the bullet at `:610`, which row 216 closes, and add E4's eleven items as bullets.
- [ ] **Step 6: README.**
  - **New row after `design`:** "| `review design <spec-id> [--file <html>]` | the design gate's reviewers on a look — the registered one, or a page not yet registered — asking the gate's full-review question; journals nothing, decides nothing, and replays the gate's answer when the gate already judged the same bytes in full |"
  - **The `read` row:** after "`--outline` names each anchor's line range for fat artifacts", add ", and for a look its controls and hidden states".
  - **The reviewer paragraph:** after "The pi reviewer runs hermetic (`--no-extensions --no-skills --no-context-files`)", add: "; claude's runs with `--safe-mode` (no hooks, `CLAUDE.md`, plugins or MCP servers) and saves no session; every reviewer gets no tools, or read-only file tools where it must open files, and witness refuses any verb but read, index, log and diff inside one".
- [ ] **Step 7: Commit**

```bash
git add DESIGN.md README.md
git commit -m "docs: rows 215-217 — looks judged from their source, debts judged by who can read them, reviewers that only read (issue #73)"
```

---

### Task 7: Verify, review, ship

- [ ] **Step 1: Full gate**

Run: `caffeinate -dims sh -c 'pnpm typecheck && pnpm build && npx biome check src tests plugin scripts && pnpm test'`
Expected: exit 0, 0 `AssertionError`, 0 `onTaskUpdate`.
- `-dims` is needed because round 3's run under `-i` alone slept for 15 minutes.
- If a known fake-call flake recurs alone, re-run once (row 213).

- [ ] **Step 2: Read-only differential.**
  - Build `main` (`dc4b3d4`) in a throwaway worktree under the scratchpad.
  - Make throwaway `git clone --local` copies of `~/x/personal/know-your-customer-mvp` and `~/x/personal/fewhats.com`.
  - With `CI=true`, run `next`, `status`, and `read <id> --design --outline` for KYC `section-disclosure` and fewhats `thread-mirror`, first with `main`'s `dist/bin.js` and then with the branch's.
  - Expected:
    - `next` and `status` are byte-identical.
    - Each outline's `main` output is a prefix of the branch's. The branch adds `controls[11]{…}` (section-disclosure) or `controls[0]{…}` (thread-mirror), then the note.
- [ ] **Step 3: Live claude reviews** on the KYC clone.
  - KYC declares `harness: pi`, and its clone has no `.witness/config.local.yaml`. So first set `harness: claude-code` in the clone and commit it there.
  - `witness review design section-disclosure`: anchored findings, an `outcome:` line, `git status` clean, HEAD unchanged.
  - `witness review design cover-argument` (P5's moved ship debt): no `malformed`.
  - If the auto-mode classifier refuses the reviewer spawn, this step is the human's.
- [ ] **Step 4: Two `opus` reviews** of the diff: plan against code and record, and a behaviour attack on `review`, `lookControls`, the debt rule and the guard. Re-run each finding before acting on it, and fix RED→GREEN.
- [ ] **Step 5: Push and open the PR on the user's go.** `Fixes #73`, then wait for CI green.
- [ ] **Step 6: HUMAN — one pi gate run** on a pi repo (for example fewhats): the reviewer answers under `--no-tools`. P7 could not run pi live here.
- [ ] **Step 7: Release.** The human merges and runs `pnpm release minor` (0.27.0).
- [ ] **Step 8: Owed after release, each on the user's go:**
  - the global skills upgrade;
  - consumers `init --agent` (fewhats, HYC);
  - a root-cause comment on #73;
  - removing the trial-build worktrees `.claude/worktrees/agent-a71bf084e2c67347b`, `agent-aa39c8297b9a61142` and `agent-a3f10bb47fb8168c4`, with their branches.
