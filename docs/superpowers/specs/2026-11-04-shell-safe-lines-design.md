# A pasted command runs only what witness wrote

Date: 2026-11-04 · Status: builder-checked (four questions: three settled as my calls, one answered by the user); the user moved it to planning on 2026-11-04 ("i want to write a plan in a new session") · DESIGN row 239 (rows 228–236 are reserved by the UI design, 237 is the 0.28.2 trust patch, 238 is reserved by the display rule, roadmap item 1a.8) · A patch release from `main` (0.28.3), built before 1a.8 · Inventory: `2026-11-04-shell-safe-lines-inventory.md`, beside this file

## 1. Why

Witness prints commands for a human or an agent to run: `next:`, `run:`, the decision block's options, `exits:`, `kept-stop:`, `waiting:`, refusal remedies, the handoff line. The witness skills run them through the agent's Bash tool:
- a `next:` line, verbatim (`plugin/commands/witness.md:53`);
- a chosen decision option, byte for byte, on a named option or a bare "y" (`plugin/skills/*/SKILL.md:22`);
- a kept stop's `witness satisfy …` or `--cmd` grant (`witness.md:30,32`).

Humans paste the rest.

These lines carry text witness did not write, and almost none of it is quoted:
- **The decision block.** Its revise option carries the reviewer's anchor raw inside `--note "…"` (`src/act.ts:39-43`), so `$(…)`, backticks or a `"` in the anchor run code on a "y". No prompt injection is needed. An anchor must name something real in the reviewed content, so a hostile file name, heading, element id or symbol is enough.
- **Twelve of the seventeen kinds** of paste-ready line can run code (VERIFIED in bash, zsh and dash, by pasting witness's own output with a marker file; PowerShell REASONED). Among them:
  - the `exits:` and reopen commands (a hand-edited `parent` through `--upstream`);
  - `wait`, `status` and drive's report (need ids, plan ids, `gh pr merge <pr>` with `pr` never validated);
  - the handoff line (a committed model pin printed bare after `--model`; a `'` in the checkout path breaking `cd '…'`);
  - two refusal remedies (`git push -u origin <ship.branch>`, `git checkout -- <paths.designs>/…`);
  - `next:` lines built from a forged, committed journal stream;
  - the canon guard's `run: witness adopt <path>`;
  - lines where foreign prose sits beside a command, so it can plant a fake one.
- **Interactive shells.** In a human's terminal, `!` in double quotes is expanded from history before quoting applies (`!#` runs code in bash; `!!` splices a history entry in zsh).
- **PowerShell.** The trust grant's POSIX quoting (`'…'\''…'`) breaks out, so a `cmd:` criterion holding `'` would run when a Windows human pastes its grant line.

The inventory beside this document lists every site with file:line, source, quoting, who runs it and the evidence.

**The user's decision (2026-11-03): "Patch first, like 0.28.2."**

## 2. Goals, non-goals, anti-goals

**Goals**
- **g1.** Every command line witness offers to be run is inert. Pasting it runs exactly the command witness composed, with the arguments witness meant, and nothing else, in bash, zsh and dash, interactive or not, and in PowerShell. Offered means printed as a command or inside text that names one to run (a `want`, a `help:`), or held as a model's line.
- **g2.** One quoter. Every such line is rendered from its argv by one function, applied per word. No offered command is built by templating a string.
- **g3.** A line whose words are all safe prints byte for byte as today. The one exception is the revise option, which stops carrying a note (§3.2).
- **g4.** Witness's own readers (drive, settle, the arbiter's menu, the UI) act on an option's argv and never reparse a printed line.

**Non-goals**
- **n1.** Spelling out hidden characters: that is row 238 (1a.8).
- **n2.** `cmd.exe`: witness never asks a human to paste into it. Also out: `resolveSpawn`'s quoting for `.cmd` shims, which is a spawn, not a printed line.
- **n3.** Rewriting old journals. A journaled command string is rebuilt from its fields when it is printed (§3.5).

**Anti-goals**
- **a1.** Changing data. Argv stays exact; quoting is only how a word prints.
- **a2.** A line that looks runnable and is not. TOON-quoting a command value into one word is the D120 defect, as is a lossy line that silently runs something else.
- **a3.** Quoting witness's own constant words. Verbs and flags stay bare, so lines stay readable.

## 3. The rule (decided)

### 3.1 One quoter, per platform

A word prints bare when it is in the platform's safe set, and quoted otherwise:

| Platform | Bare when | Quoted as | Proven |
|---|---|---|---|
| every platform but win32 | `shellArg`'s set (`[\w@%+=:,./-]`) and not starting with `=` (zsh's EQUALS expansion) | `'…'`, a `'` written `'\''` | inert and exact in bash, zsh and dash, interactive included: single quotes stop history expansion (VERIFIED, prototype in the inventory §4) |
| win32 | `psArg`'s set | `psArg`: `'…'`, every single-quote-like character doubled | the watch line's precedent (`src/drive-presence.ts:199-204`). Inert in PowerShell (REASONED); inert in bash, zsh and dash too (VERIFIED), but lossy there for `'`, so a line pasted into Git Bash names other bytes and fails closed (an unknown id or command refuses) |

The platform is that of the machine printing the line, which is the machine where it is pasted.

**On Windows, risky words are refused** *(the user's decision, 2026-11-04: "Refuse risky words now")*.
- **The risk.** On Windows a pasted line can reach cmd.exe after PowerShell: npm's `witness.cmd` and `npx.cmd` shims pass their arguments through it. PowerShell passes a word that holds no space unquoted, and cmd.exe then treats `&`, `|`, `^`, `<` and `>` in it as new commands or redirections, which does not fail closed. Separately, Windows PowerShell 5.1 passes an embedded `"` unescaped, which moves cmd.exe's argument boundaries, and cmd.exe expands `%NAME%` (and `!NAME!` under delayed expansion). This was reasoned from cmd.exe's and PowerShell's documented behaviour; there is no Windows here.
- **The rule.** On win32, a command any of whose foreign words holds `&`, `|`, `^`, `<`, `>`, `"`, `%` or `!` is still shown, but never offered as paste-ready:
  - it is never on a `run:` or `next:` line, and never a runnable option;
  - a short note says why it is shown and not offered;
  - the skills run only `run:` and `next:` lines, so they never run it.

  The builder lists each site's fallback in the plan. For a trust grant, for example, the fallback is the listing form `witness trust <target>`, which grants nothing.
- **Handoff on win32.** The handoff line takes PowerShell syntax, as the watch line already does: `Set-Location -LiteralPath '<home>'`, an `$env:` assignment for the thinking budget, then the launch command. Today's POSIX `cd '…' && MAX_THINKING_TOKENS=n …` does not parse in Windows PowerShell 5.1, and no PowerShell reads the assignment.
- **Later.** A measured Windows pass on the user's machine is its own row, after this patch: PowerShell 5.1 and 7, npm's shims, Git Bash.

**Two renderers share the quoter:**
- **Witness's own commands go through `cliAct`'s `word()`.** Every witness command a line offers becomes an `Act`:
  - `next`'s action lines;
  - settle's and the policy's re-runs;
  - drive's set-aside line;
  - the `help:` and `want` text that names a command to run (inventory §5.2, §5.3).
- **Other tools' commands go through one `argv → line` renderer:** `gh pr merge`; `git push`; the three `git checkout` remedies; the handoff line (two commands joined by ` && `, and the `MAX_THINKING_TOKENS=<n>` assignment written by witness); the watch line, folded in.

A command value prints with `cmd()`, never `kv()`. `kv` quotes a value holding `,` or `"` as one TOON word, which pastes as one unrunnable argument.

**Placeholders and shapes print as today** *(my call, after the builder check)*. Witness's own words are never quoted (a3):
- **Input slots** print exactly as now: `--note "<why>"` and `--upstream <effort>`. A line holding one is not runnable, and the human fills it before running it.
- **Shape lines** stay templated text: lines such as `witness write <spec-id> --effort <slug> --meta m.json --body b.md` or `witness recap --file <recap.json>` hold placeholders that the reader fills. Each foreign word in them (the effort slug, an id) goes through the quoter. The `Act` model's input names stay `why | effort`, so the UI's sense of "runnable" does not change. g2 reads: every runnable command is an `Act`.

**The handoff keeps its quoted words** *(my call)*. Its path and its `'/witness'` word stay single-quoted always, as today (the renderer has an always-quote form). That keeps today's bytes, and keeps `witness.md:46`'s instruction to make the argument `'/witness --manual'`.

**A human's typed answer at drive's `decide>`** is split by a POSIX tokenizer that reads the quoter's single quotes. `WITNESS_BIN` (a Windows command line, where `'` is literal) keeps today's splitter.

The canon guard hook (`plugin/hooks/canon-guard.mjs`) ships standalone into consumer repos and cannot import the CLI. It gets a twin of the quoter, held equal to the CLI's by a test, on `plugin/hooks/context-core.mjs`'s precedent.

### 3.2 The revise option carries no note *(my call)*

The option prints `witness decide <gate> <target> --revise`. When a revise names none of `--note`, `--upstream` and `--repair`, `decide` derives the note itself: `notePrefill(entries, gate)`, the same index of the anchoring run that it journals today.
- So no reviewer text is ever on a paste-ready line. The UI, drive, settle, the arbiter and a pasted line journal one note by construction.
- The `why:` line still names the anchors (spelled out by row 238).
- **Cost:** a human who types a bare `--revise` now journals the prefill, where today they journal no note. The prefill is an index, never a judgment (`src/rounds.ts:287-292`), so it adds a record, not an opinion.
- Unchanged: `--note <why>` (an input the human fills), a note a human types, and `--revise --upstream` and `--revise --repair`, which carry no note today.

This is stronger than quoting the note:
- nothing reviewer-written remains to quote;
- the Windows form's loss of `'` cannot change a journaled note;
- the two parsers that read notes back out of printed lines can go (§3.3).

### 3.3 Readers act on argv

- **settle.** The policy returns the option's act (`{ kind: 'take', act }`); its two re-run arms become `cliAct('gate', gate, target)`. The arbiter's menu is the options, which already carry acts. Settle runs `decisionAct(act.argv.slice(1))` for a decide act and routes any other act as a re-run. `actOfCommand` is deleted.
- **drive's `decide>`.** Drive builds `decideView(…)`, prints `decideViewLines(view)` (byte-identical to `decide --show`, so D143's one block across surfaces holds), and runs the chosen option's `act.argv`. A nod appends `--via affirmation` to the argv. A `witness …` answer the human types is their own argv, split as today.
- **Line tests become argv tests.** `selectOption`, `byVerb`, `nodExcluded`, `menuFor` (with its `PLACEHOLDER` screen), `classifyAction` and `recommendedVerb` read `act.argv`, `act.inputs` or the action's target, never the line's text. This also fixes misreadings that exist today: an anchor holding `--approve`, `--stop` or `<effort>` misfilters the menu or the nod.
- **`splitArgv`** stays only for `WITNESS_BIN` (a Windows command line, where `'` is literal) and for the human's typed answer.

### 3.4 A command never shares a line with foreign prose

Two lines print text that witness did not write beside the commands a skill runs, so that text can plant a fake command first:
- `kept-stop: unmet need — <texts> · <satisfy commands>` (`src/autonomy.ts:37-39`);
- `waiting: <row> · run: <reopen>` (`src/verbs/next.ts:1297-1300`).

Each command moves to its own indented `  run:` line under the prose, as the inbox rows already print. `plugin/commands/witness.md` then tells the skill to run that `run:` line. The Pi add-on's `^run:` test reads unindented lines only (`plugin/hooks/context-core.mjs:331`), so the add-on is unaffected.

### 3.4b A `run:` line is one command *(my call, after the builder check)*

At the round bound, a parked gate's reopen is the whole endgame set. `wait`, drive's pause and report, and `next`'s `waiting:` print it as one line: `run: witness decide plan p3 --approve --override | --revise --repair | --stop | witness abandon p3` (`src/needs-you.ts:185`, pinned at `tests/text-golden.test.ts:96`).

Pasted, that line is a pipeline. It ran both `decide plan p3 --approve --override` and `abandon p3` (probed in bash with a stub `witness`, 2026-11-04; the builder check saw the same in zsh and dash). No foreign text is needed.
- **The fix:** a menu prints as `exits:`, the label `decide --show` already uses for a set of choices. `run:` is kept for a single command, so below the bound the lone `gate --fresh` reopen stays `run:`.
- **Tests:** they paste each act of a menu on its own, never the `exits:` line whole.

### 3.5 Journaled command strings are rebuilt

`GateCheck.held[].satisfy` and any check detail that embeds a command are rebuilt from their structured fields when printed. A journal written before this row, or forged, is never trusted to hold a safe line.

### 3.6 Defense in depth *(my calls)*

These narrow what can reach a line; the quoter is the fix.
- **`pr`:** a positive integer, by a schema rule on frontmatter `pr`, and with `Number()` where the inbox reads it.
- **Model pins and `ship.branch`:** strict character sets, refused as config violations. The builder confirms each set against every documented pin form (`src/pin.ts`) and against git's ref rules.
- **Ids:** an id may not start with `-` (`ID_RE` becomes `^[a-z0-9][a-z0-9-]*$`). This closes 1a.1's residual R10, where an id was read as a flag.
- **Names that fail `ID_RE` are never offered as commands.** `unmetNeeds`, `parkedGates`, `owedDecisions`, the effort streams and the ask stream skip them, and `check` reports them.

## 4. Fit with 1a.8 (row 238)

1a.8 is built after this patch merges; its plan says so.
- **Its Task 3** (spelling the prefill at its source) then spells a prefill that is journaled and shown in `why:` lines, never printed in a command.
- **Its Task 5** (`Act.line` spelled) spells each word first, then quotes it with this row's quoter. A spelled word holds a backslash, which the POSIX safe set does not allow, so a spelled word is quoted. It stays inert and exact.
- Its plan's R17 and line pins are refreshed against this row's output before it starts.

## 5. Testing

- **One table-driven test over the kinds** (K1–K12 of the inventory, plus each win32 form).
  - Build each line with witness's own code, carrying these payloads in its foreign slot:
    - `$(touch M1)`;
    - `` `touch M2` ``;
    - `"; touch M3; "`;
    - `'; touch M4; '`;
    - `;touch M5;`;
    - `!#;touch M6;#`;
    - git-ref forms such as `main$(touch${IFS}M7)`.
  - Paste each line into `bash -c`, `zsh -f -c`, `dash -c`, and into interactive bash and zsh on stdin, with stubs for `witness`, `git`, `gh`, `claude` and `pi` on PATH.
  - Assert that no marker file appears, and that the stub received witness's argv byte for byte.
- **The win32 forms.** There is no Windows here, so these are tested without it:
  - unit tests of the quoter against PowerShell's quoting rules;
  - the refusal rule, over every risky character in every kind;
  - the PowerShell handoff's text;
  - the psArg form pasted into the POSIX shells (inert, VERIFIED).

  The measured Windows pass is its own later row.
- **One note.** For one block, the UI's argv, drive's run, settle's run and a pasted `run:` line journal the same note, and no line is reparsed.
- **Byte-identity.** Every existing test passes, except tests named in the plan that change by design:
  - pins of the revise option's line;
  - pins of words the quoter now quotes (inventory §4).

## 6. Release

A patch, 0.28.3, from `main`. The user runs `pnpm release patch`.

## 7. Left to the builder

- The quoter's module and names. Beside `shellArg` and `psArg` in `src/toon.ts` is the obvious home.
- How the platform reaches `cliAct`: by default `process.platform`, as a parameter for tests, as `watchLine` does.
- The exact character sets in §3.6.
- For each `want` and `help:` text in inventory §5.3, whether it names a command to run (rendered as an act) or only mentions one.
- Whether `Settled.line` stays a string or carries the act.

## 8. Calls for the user to check while reading

- §3.2: the revise option drops `--note "…"`, and a bare `--revise` journals the prefill.
- §3.1: on Windows, a line pasted into Git Bash is lossy for `'` and fails closed. A command holding `& | ^ < > " % !` in a foreign word is shown but never offered (the user's decision), and the handoff takes PowerShell syntax.
- §3.4: the unmet-need kept stop and `waiting:` print their commands on their own `run:` lines, and the skills' instructions change to match.
- §3.6: a config whose model pin or `ship.branch` falls outside the new character sets is refused.
- §3.4b: the at-bound reopen menu in `wait`, drive's report and `waiting:` prints as `exits:`, not `run:`.
- §3.1: placeholders, shape lines and the handoff's quoted words print exactly as today.
