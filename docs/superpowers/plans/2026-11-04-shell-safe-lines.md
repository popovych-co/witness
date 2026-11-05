# A pasted command runs only what witness wrote (row 239, 0.28.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every command line witness offers to be run — a `next:`, a `run:`, a decision option, an `exits:` segment, a kept stop's grant or satisfy, a refusal's remedy, the handoff — runs exactly the command witness composed when pasted, in bash, zsh and dash (interactive or not) and in PowerShell, whatever text from a reviewer, a repo, a journal or a config it carries.

**Architecture:**
- **One quoter** in `src/toon.ts`: `shellWord(word, platform)` prints a word bare in the platform's safe set and quoted otherwise (POSIX `'…'\''…'`, win32 `psArg`). Two renderers use it:
  - **witness's own commands** are acts: `cliAct`'s `word()` quotes every word but the input slots;
  - **other tools' commands** go through `shellLine(argv)` / `offeredLine(argv)`.
- **No reviewer text on a command line.** The revise option prints `witness decide <gate> <target> --revise`, and `decide` derives the note the block used to carry.
- **Readers act on argv.** settle, the policy, the arbiter's menu and drive's `decide>` run an option's `act.argv`; `actOfCommand` and `parseBlock` go.
- **Line shapes.** A command never shares a line with foreign prose: kept stops and `waiting:` print their commands on their own indented `run:` lines. A `run:` or `next:` is one command: a menu prints as `exits:`.
- **Defense in depth.** `pr` is an integer; model pins and `ship.branch` have strict character sets; an id may not start with `-`; names failing `ID_RE` are never offered.
- **Windows.** A command whose foreign word holds `& | ^ < > " % !` is shown and never offered; the handoff speaks PowerShell.

**Tech Stack:** TypeScript ESM (strict, `noUncheckedIndexedAccess`), Node ≥ 20, vitest 3 with the in-process CLI against throwaway git repos (`tests/helpers.ts`), `/bin/bash` 3.2, `/bin/zsh` 5.9 and `/bin/dash` for the paste tests.

**Spec:**
- `docs/superpowers/specs/2026-11-04-shell-safe-lines-design.md` (DESIGN row 239), builder-checked, moved to planning by the user on 2026-11-04. Its §8 lists the calls the user was asked to check.
- Its inventory, beside it: `docs/superpowers/specs/2026-11-04-shell-safe-lines-inventory.md`.
  - Kinds K1–K17 (§1, §2), the parsers and the tests that pin lines (§4), every composition site outside `cliAct` (§5.2) and the prose sites (§5.3).
  - Its `SQ/` evidence paths point at session 41056634's scratchpad, which may be gone. This plan's paste tests re-establish the evidence.
- The user's decisions: "Patch first, like 0.28.2" (2026-11-03) and, for Windows, "Refuse risky words now" (2026-11-04).

## Global Constraints

- **Workspace.**
  - The worktree is `/Users/home/x/personal/witness/.claude/worktrees/shell-quote`, on branch `shell-quote` from main `e4ce06b`, with node_modules installed. It is not pushed until Task 11.
  - Never touch the main checkout: it holds another session's uncommitted roadmap edit.
  - Never use `git stash`: the stack is shared and holds the user's old entries. To check RED, reverse-apply the fix hunk and restore from HEAD.
- **Release.** A patch, 0.28.3, from `main`. The user runs `pnpm release patch`: the classifier blocks it for agents.
- **Text (design g3).** A line whose words are all in the safe set prints byte for byte as today.
  - Only the existing tests each task names under "Changes by design" change. Any other failing expectation is a defect in that task.
  - `tests/text-golden.test.ts` is edited by hand at the lines named, never re-recorded. vitest never runs with `-u`.
- **Data (a1).** Every act's `argv` stays exact. Quoting is how a word prints, never what runs.
- **Witness's own words stay bare (a3).** On every platform, verbs, flags and the input slots print as today: `--note "<why>"` and `--upstream <effort>`. So do the shape lines' placeholders and the handoff's always-quoted words (`'<home>'`, `'/witness'`).
- **One quoter (g2).** Only `src/toon.ts` decides how a printed word is quoted, through `shellWord`, `quotedWord`, `shellLine` and `offeredLine`. The canon guard's twin (Task 7) is the one copy, and a test holds it equal.
- **Placeholders (design §3.1).** An `Act`'s input names stay `why | effort`. A shape line stays templated text, with each foreign word quoted. Every runnable witness command is an `Act`.
- **House rules.**
  - `src/spawn.ts` stays the only `node:child_process` importer under `src/` (row 201). Tests may spawn shells.
  - Tests await every CLI run (row 213).
  - New code cites `// Row 239.`
  - Subagents run on opus.
- **No raw control or bidi characters** in any source, test or doc. Write them as `\u` escapes in code and by name (U+202E) in prose: a Write can turn escape text into the raw character. Before every commit, run this over the files the commit touches. It must print nothing:

  ```
  perl -CSD -ne 'while (/([\x{0}-\x{8}\x{b}-\x{1f}\x{7f}-\x{9f}\x{200b}-\x{200f}\x{2028}\x{2029}\x{202a}-\x{202e}\x{2066}-\x{2069}\x{feff}])/g) { printf "%s line %d: U+%04X\n", $ARGV, $., ord($1) } close ARGV if eof' <files>
  ```

- **Shells.**
  - A pasted line is tested in each mode whose shell exists: `bash -c`, `zsh -f -c`, `dash -c`, interactive `bash --norc --noprofile -i` and `zsh -f -i` on stdin.
  - A mode whose binary is absent is skipped. CI's Ubuntu has no zsh, and there are no shells on win32.
  - This Mac has all three, so the Done gate runs here. Probed 2026-11-04: all five modes delivered a hostile grant's argv exact to a `/bin/sh` stub, with no marker file.
- **Done** means `pnpm typecheck`, `pnpm build`, `npx -y @biomejs/biome@2.5.6 check src tests` and a full `pnpm test` are green (read `Tests N passed` and 0 `AssertionError`), and the scan is clean.

## Builder's calls

The design leaves these to the builder (§7) or does not reach them. Each was checked against the code at `e4ce06b` or by probe.

- **B1. The quoter's home and names: `src/toon.ts`.**
  - `shellArg` gains the leading-`=` rule. Probed: zsh turned a bare `=ls` into `/bin/ls` at the stub, and `'=ls'` arrived as `=ls`. `shellArg`'s two callers keep their bytes: the `--cmd` word and the watch line.
  - `psArg` is unchanged.
  - New: `type Platform`, `shellWord`, `quotedWord`, `shellLine`, `offeredLine`, `withheldOn` and `shellWords`, as in Task 1's Interfaces.
- **B2. A Windows flag prints bare.**
  - `psArg` quotes a leading `-`, because a cmdlet binds such a word as a parameter. On win32 `shellWord` prints a word bare when it matches `/^--?[A-Za-z][A-Za-z0-9-]*$/`; else it uses `psArg`.
  - Why: a native command (`witness`, `git`, `gh`, `claude`) receives such a flag verbatim, and the watch line's cmdlet flags (`-LiteralPath`, `-Wait`) must stay bare to be flags at all.
  - The shape leaves out `.`, `:`, `%` and `=`: PowerShell splits `-a.b` for a native command, and `--%` stops its parsing. A lone `--` does not match and prints `'--'`, which is exact either way.
  - REASONED: there is no Windows here.
- **B3. How the platform reaches a line.**
  - `actOn(platform, argv)` builds an act, and `cliAct(...argv)` is `actOn(process.platform, argv)`. `cliAct`'s rest parameter leaves no room for a platform argument.
  - `exitsLine(acts, platform = process.platform)`.
  - Every builder a test drives on win32 takes a trailing `platform = process.platform`: `grantAct`, `grantOf`, `grantRows`, `trustListing`, `handoffLine` and the toon.ts functions. `watchLine` already does.
- **B4. Windows withholds on the act.**
  - `Act` gains `withheld?: string`. `actOn` sets it when a word other than an input slot holds one of `& | ^ < > " % !`, which only happens on win32.
  - `option()` makes such an option not runnable and adds the note, and a `run:` printer prints a note instead. `offeredLine` returns `undefined` for another tool's withheld command.
  - A cmdlet's arguments are never withheld: PowerShell itself reads the paths given to `Set-Location` and `Get-Content`, and cmd.exe never does.
  - In-process readers read `act.inputs`, never `runnable`: the policy, drive, settle, the arbiter and the UI run argv with no shell, so a withheld act is safe for them.
  - An `exits:` menu is not offered as one command, and `exitsLine` does not read `withheld`. Its acts carry ids and flags only once B15 holds, so none is ever withheld.
- **B5. Each site's Windows fallback** (the design asks for this list). Witness's own acts carry ids and flags only once B15 holds, so they are never withheld. The sites a foreign word can reach:

  | Site | Word that can hold a risky character | On win32 |
  |---|---|---|
  | Trust grant: `next`'s and settle's kept stop, `wait`/drive rows, the trust verb's `run:` lines | the `--cmd` command | The command and its source show as today. A `note:` names the characters, and the listing `run: witness trust <target>` is offered in the grant's place. The listing grants nothing by itself; at a terminal it asks for each command, because the act stays pending. The block's `--approve --trust-cmds` grants with no command on the line. |
  | Restore remedy `git checkout -- <designs>/<parent>.html` (`src/gates/implement.ts:112-117`) | the `paths.designs` path | No `run:` line. The `want` already says to restore the artifact or re-run the design stage. |
  | Push remedy `git push -u origin <branch>` (`src/gitio.ts:237-239`) | none: `ship.branch` is charset-checked (B14) | `offeredLine` keeps the rule all the same |
  | Canon guard `run: witness adopt <rel>` (`plugin/hooks/canon-guard.mjs:221-233`) | the agent's path | The same command shows without its `run:` label, followed by the note |
  | The handoff and the watch line | none: the path is a cmdlet's argument, and the pin is charset-checked | never withheld |
  | `help:` and `want` prose (Task 8) | ids, argv | quoted only, since prose is never offered as `run:` |

- **B6. The revise option** (`src/rounds.ts`, `reviseAct`).
  - When `notePrefill` holds facts, the option is a bare `--revise`, and `decide` derives the same prefill.
  - When `notePrefill` returns `<why>` (a clean stop), the option keeps today's slot, `--revise --note "<why>"`, and a bare `--revise` there still journals no note.
  - Why: g3, and §3.1's "input slots print exactly as now".
- **B7. The policy's shape.**
  - `Policy` is `{ kind: 'take'; act: Act } | { kind: 'pick'; id: string } | { kind: 'arbiter' } | { kind: 'human'; stop: KeptStop }`.
  - `pick` answers a choose block: its options name specs, not commands (`readyChoice`, `src/verbs/next.ts:623-653`), and carry no act.
- **B8. A `next:` line is one command, and carries its act.**
  - `NextAction` gains `act?: Act` on every runnable line, with `line === act.line`.
  - A shape line carries no act and quotes each foreign word: one with `<…>` placeholders, or files to author (`--meta m.json --body b.md`, `--file <html>`, `--file <recap.json>`).
  - `NextAction.block` becomes a `Decision`, rendered where it prints, so that drive can run its options' acts.
  - The bound-stuck rung's line (`src/verbs/next.ts:891-894`) becomes `witness decide <gate> <target> --show`. Today it is `liveExits`, a menu that pasted runs `--approve --override` and `abandon` together: §3.4b's defect, on `next:`. The skills already turn every `next: witness decide` into `--show` (`plugin/commands/witness.md:44`), and drive reads it as a decision.
- **B9. `Settled.line` stays a string.** The routed kind gains the act: `{ kind: 'routed'; act: Act; line: string }`. `next` and drive read `act`, instead of stripping `autonomy: re-run owed — ` off the line (`src/verbs/next.ts:1234`, `src/drive.ts:898`).
- **B10. Drive's `decide>` view.**
  - `shownView(ctx, gate, target)` in `src/verbs/decide.ts` makes `show()`'s reads and refusals (root, config, canon, unknown gate) and returns the view. `show()` and drive both print `decideViewLines(view)`.
  - An option without an act is not selectable, as `parseBlock` skipped it; numbering stays positional.
- **B11. `shellWords`' grammar**, for a human's typed answer:
  - an unquoted space or tab ends a word;
  - `'…'` is literal;
  - inside `"…"`, a backslash escapes only `"`, `\`, `$` and `` ` ``;
  - outside quotes, `\x` is `x`;
  - nothing expands;
  - an unclosed quote or a trailing backslash returns `undefined`.

  `splitArgv` stays for `WITNESS_BIN` alone (`src/drive.ts:1146`).
- **B12. §3.4 reaches two more sites than the design names.**
  - **The trust-grant kept stop** (`src/verbs/next.ts:1305`, `src/settle.ts:102`) prints the repo's command beside its grant. A `cmd:` criterion or `ship.test` holding ` · witness trust … ` plants a fake grant first, which is the unmet-need forgery.
  - **`start`'s unmet-need kept stop** (`src/verbs/start.ts:121`) prints the design's line through a fourth printer.

  Both take the new shape.
- **B13. Journaled `held` rows** (§3.5).
  - `HeldRow` gains `spec`, written by `laneCheck` from now on. Printing rebuilds the command as `cliAct('satisfy', spec, '--need', need)` when both pass `ID_RE`.
  - A row journaled before this row has no `spec`. It prints its stored command only when the command is exactly `witness satisfy <id> --need <id>`. Any other row prints with no command.
  - The only other journaled check detail that names a command is the design gate's `artifact` detail (`src/gates/design.ts:48`): a shape with a placeholder, in a table cell (R4).
- **B14. Character sets.**
  - **Pins:** `/^[A-Za-z0-9][A-Za-z0-9._:\/@\[\]-]*$/`, in `checkPin` (rule `pin-charset`).
    - Every pin in `src/`, `tests/` and the user's three consumer configs passes: `m`, `test-model-1`, `claude-opus-5`, `claude-opus-5-5`, `anthropic/test-model-1`, `google/gemini-3.6-pro:low`, `claude-fable-5:medium`. Checked 2026-11-04: fewhats, hear-your-customer, know-your-customer.
    - `@` keeps a Vertex-style `model@version` id.
    - `[` and `]` keep Claude Code's `claude-opus-4-6[1m]`-style ids. They are glob characters, so the quoter quotes them. Today such a pin prints bare after `--model`, and zsh refuses the handoff with "no matches found".
  - **`ship.branch`:** `BRANCH_RE`, as in Task 9. It follows git's rules for these characters, and every name it admits prints bare on both platforms.
  - **Why the branch rule needs no schema step.** The schema fingerprint hashes `path`, `shape`, `since` and the default (`src/settings.ts:282-290`), so a new shape kind would be a schema step. The rule rides a new `Setting.pattern`, which the fingerprint leaves out, as it leaves out `want`. The rule refuses values no shell-safe line can carry, and `migrate` has nothing to rewrite.
  - **Ids:** `ID_RE = /^[a-z0-9][a-z0-9-]*$/`. Every want naming the set says `[a-z0-9][a-z0-9-]*`.
- **B15. Names failing `ID_RE` are never offered.**
  - `effortStreams` filters them, so `liveEfforts`, `parkedGates` and `owedDecisions` inherit the filter. `askQueue` skips such asks, and `unmetNeeds` skips such docs and need ids.
  - `parkedGates` and `owedDecisions` skip such docs.
  - A plan's parent that fails `ID_RE` gives no upstream, in both derivations: the plan gate's `upstreamOf` (`src/gates/plan.ts:136-139`), and `next`'s own `upstreamFor` (`src/verbs/next.ts:567-572`). The second is the one `parkedGates`, the bound rung and `principlesApproval` read, and it agrees with the first by test (`tests/exits-line.test.ts`).
  - `check` warns `stream-name` and `ask-id`. A canon id is already flagged by its schema.
  - The trust listing is not on the design's list. It keeps offering grants for the target it was asked about, quoted (`tests/trust.test.ts:352-355`, ruling R15).
- **B16. The handoff on win32.**
  - It reads `Set-Location -LiteralPath '<home>' -ErrorAction Stop; ` then, with a thinking budget, `$env:MAX_THINKING_TOKENS = '<n>'; `, then `<launch>[ --model <pin>] '/witness'`.
  - `-ErrorAction Stop` keeps `&&`'s promise: a failed change of directory makes a terminating error, so nothing after it on the pasted line runs. REASONED.
  - `<home>` and `/witness` go through `quotedWord`.
- **B17. Prose that names a command** (§5.3, and the help lines B6 of the inventory). A runnable command inside a `want`, a `help:`, a `note` or a check detail is an act's line. A shape quotes its foreign words. A mention with no foreign word stays as it is.
- **B18. A command value prints with `cmd()`**: `next:`, `run:` and `relay:` (`src/verbs/next.ts:1309,1331,1332`, `src/slice.ts:190`, `src/verbs/dispatch.ts:85`). Status table cells stay TOON (R2).

## Review Focus

1. **A Windows trust grant holding `&&` or `"`** (`npm test && npm run lint`, `vitest -t "x"`), the commonest real command.
   - Expect the command and source shown, a note naming `&` (or `"`), and `run: witness trust <target>`.
   - Expect the listing to keep it pending, so that at a terminal it is asked.
   - Pinned in Task 6: `grantRows` on win32, and `pendingCmds(trustListing(…, 'win32'))` still holding the command.
2. **A consumer config with a pin or `ship.branch` outside the new sets**, such as `feature/#12` or `m$(x)`.
   - Expect a config refusal naming the setting and the set, at every verb, with `check` listing it.
   - Expect every branch and pin a real repo uses to still load: `main`, `release/1.2`, `feat/x+y`, `anthropic/claude-x:high`, `claude-x@20250514`, `claude-opus-4-6[1m]`.
   - Pinned in Task 9.
3. **A human typing at drive's `decide>`** a command holding quotes, such as `--note "don't ship"` or `--note 'it'\''s'`. Expect the note journaled exactly. Pinned in Task 5.
4. **A 0.28.2 journal**: a `held` row without `spec`, and a forged one holding `; touch …`. Expect the first to print its command, and the forged one to print with no command. Pinned in Task 6.
5. **A checkout path holding `'`, a space or `$(…)`.** Expect the handoff to `cd` to exactly that path, run nothing else, and the watch line's `tail -f` to name it exactly. Pinned in Task 7.

---

### Task 0: The design, inventory and plan land on the branch

- [ ] **Step 1:** In the worktree, scan and commit the three documents:

  ```bash
  cd /Users/home/x/personal/witness/.claude/worktrees/shell-quote
  F="docs/superpowers/specs/2026-11-04-shell-safe-lines-design.md docs/superpowers/specs/2026-11-04-shell-safe-lines-inventory.md docs/superpowers/plans/2026-11-04-shell-safe-lines.md"
  perl -CSD -ne '…the Global Constraints scan…' $F     # prints nothing
  git add $F && git commit -m "docs: design, inventory and plan for shell-safe lines (row 239)"
  ```

- [ ] **Step 2:** Check that `git -C /Users/home/x/personal/witness status --short` still lists only the other session's roadmap edit.

### Task 1: One quoter, and the paste harness

**Files:**
- Modify: `src/toon.ts:1-10` (`shellArg`; new functions after `psArg`).
- Create: `tests/quote.test.ts`, `tests/shells.ts` (the harness), `tests/paste.test.ts` (the table; later tasks add rows).

**Interfaces:**
- Produces, in `src/toon.ts`:

  ```ts
  export type Platform = NodeJS.Platform
  export const shellArg: (p: string) => string     // + quoted when it starts with '='
  export function shellWord(w: string, platform: Platform = process.platform): string
  export function quotedWord(w: string, platform: Platform = process.platform): string     // always quoted
  export function shellLine(argv: readonly string[], platform: Platform = process.platform): string
  export function withheldOn(words: readonly string[], platform: Platform = process.platform): string | undefined
  export function offeredLine(argv: readonly string[], platform: Platform = process.platform): string | undefined
  export function shellWords(line: string): string[] | undefined
  ```

  - `shellWord`: on win32, bare when the word matches B2's flag shape, else `psArg(w)`; elsewhere, `shellArg(w)`.
  - `quotedWord`: on win32, `'…'` with each of `'`, `‘`, `’`, `‚`, `‛` doubled; elsewhere, `'…'` with `'` written `'\''`.
  - `shellLine`: the words through `shellWord`, joined by one space.
  - `withheldOn`: `undefined` off win32, and on win32 when no word holds a risky character. Otherwise it returns this exact copy, where `<chars>` lists the characters found, in the order `& | ^ < > " % !`, joined by a space:

    `not offered on Windows — it holds <chars>, which cmd.exe or Windows PowerShell can read as more than text`
  - `offeredLine`: `withheldOn(argv, platform) === undefined ? shellLine(argv, platform) : undefined`.
  - `shellWords`: B11's grammar.
- Produces, in `tests/shells.ts`:

  ```ts
  export type Mode = 'bash' | 'zsh' | 'dash' | 'bash-i' | 'zsh-i'
  export const MODES: readonly Mode[]            // those whose /bin/<shell> exists; none on win32
  export const PAYLOADS: readonly string[]       // design §5's seven, then zsh's split form
  export const REF_PAYLOADS: readonly string[]   // the space-free forms a git ref name can hold
  export interface Pasteable { line: string; calls?: string[][]; cwd?: string }   // calls: undefined = check inertness only
  export interface Pasted { markers: string[]; calls: string[][] }
  export function pasteIn(mode: Mode, line: string, cwd?: string): Pasted
  ```

  - `PAYLOADS` are `$(touch M1)`, `` `touch M2` ``, `"; touch M3; "`, `'; touch M4; '`, `;touch M5;`, `!#;touch M6;#`, `main$(touch${IFS}M7)` and `main$(touch${=IFS}M8)`.
    - zsh does not split `${IFS}`, so M7 never fires there; `${=IFS}` is the inventory's form that does (its B7).
    - bash and dash refuse `${=IFS}` as a bad substitution, so M8 is a zsh payload.
  - `REF_PAYLOADS` are the inventory's B1, B2, B5 and B7: `main$(touch${IFS}M1)`, `` main`touch${IFS}M2` ``, `main;touch${IFS}M5;` and `main$(touch${=IFS}M7)`. git calls a ref holding a space an `invalid refspec`, so only these reach a push remedy. Probed 2026-11-04.
  - `pasteIn` is synchronous. It makes a fresh `mkdtempSync` stub directory, with `bin/` stubs for `witness`, `git`, `gh`, `claude`, `pi` and `tail`. Each stub is `#!/bin/sh`, running `printf '%s\0' "${0##*/}" "$@" >> "$ARGVLOG"; printf '\n' >> "$ARGVLOG"`.
  - It runs the line with `cwd` (default: a fresh temporary directory) and `env: { PATH: <stubs>/bin:/usr/bin:/bin, ARGVLOG, HOME: cwd, ZDOTDIR: cwd }`, using `spawnSync`:

    | Mode | How the line runs |
    |---|---|
    | `bash` | `/bin/bash --norc --noprofile -c <line>` |
    | `zsh` | `/bin/zsh -f -c <line>` |
    | `dash` | `/bin/dash -c <line>` |
    | `bash-i` | `/bin/bash --norc --noprofile -i`, with `<line>\n` on stdin |
    | `zsh-i` | `/bin/zsh -f -i`, with `<line>\n` on stdin |

  - It returns every file under `cwd` named `/^M\d$/` as a marker, and each log record split on NUL as a call. It deletes the markers it found, and removes its stub directory and any default `cwd`, so the next mode starts clean.
- Produces, in `tests/paste.test.ts`: `type Row = [name: string, build: (payload: string) => Pasteable[] | Promise<Pasteable[]>, payloads?: readonly string[]]`, a `ROWS` table, and one test:

  ```ts
  // Built once per payload (a build may need a repo, which is async), then pasted alone into every mode.
  describe.skipIf(MODES.length === 0)('a pasted line runs only what witness wrote (row 239)', () => {
    it.each(ROWS)('%s', async (_, build, payloads = PAYLOADS) => {
      for (const p of payloads) {
        const items = await build(p)
        for (const mode of MODES) for (const x of items) {
          // pasteIn(mode, x.line, x.cwd): markers must be [], and calls equal x.calls when given
        }
      }
    }, 120_000)
  })
  ```

  A row whose line names a directory, as the handoff's `cd` does, creates it under a directory of its own and passes that directory as `cwd`, so markers made after the `cd` are found too.

- [ ] **Step 1: Write the failing tests.**
  - In `tests/quote.test.ts`:
    - `it('a POSIX word is bare in shellArg\'s set, never when it starts with = (row 239)')`:

      | Call | Returns |
      |---|---|
      | `shellWord('auth-refresh-plan-1', 'darwin')` | itself |
      | `shellWord('--approve', 'linux')` | itself |
      | `shellWord('a=b', 'darwin')` | `'a=b'` |
      | `shellWord('=ls', 'darwin')` and `shellArg('=ls')` | `"'=ls'"` |
      | `shellWord('', 'darwin')` | `"''"` |
      | `shellWord("it's", 'darwin')` | `` `'it'\\''s'` `` |

    - `it('a Windows word is psArg\'s, and a flag stays bare')`:

      | Call | Returns |
      |---|---|
      | `shellWord(w, 'win32')` for `--revise`, `-LiteralPath` and `-u` | the word, bare |
      | `shellWord('--', 'win32')` | `"'--'"` |
      | `shellWord('-a.b', 'win32')` | `"'-a.b'"` |
      | `shellWord('--%', 'win32')` | `"'--%'"` |
      | `shellWord('a,b', 'win32')` | `"'a,b'"` |
      | `shellWord('@x', 'win32')` | `"'@x'"` |
      | `shellWord('C:\\w\\repo', 'win32')` | the path, bare |
      | `shellWord("o'b\u2019c", 'win32')` | `"'o''b\u2019\u2019c'"` |

    - `it('a quoted Windows word reads back exact under PowerShell\'s single-quote rule')`. A test-local `psRead` strips the outer `'…'` and collapses each doubled quote-like character to one. For a corpus (the payloads, `über plan`, `it's`, `a‘b’c‚d‛`, `$env:X`, `a b`, `''`), every word holds: `psRead(shellWord(w, 'win32')) === w`.
    - `it('a quoted POSIX word reads back exact through shellWords')`. For the same corpus: `shellWords(shellLine(['witness', w], 'darwin'))` toEqual `['witness', w]`.
    - `it('quotedWord quotes every word, as the handoff prints its path and /witness')`:

      | Call | Returns |
      |---|---|
      | `quotedWord('/w/repo', 'darwin')` | `"'/w/repo'"` |
      | `quotedWord("/o'b", 'darwin')` | `` `'/o'\\''b'` `` |
      | `quotedWord('C:\\w', 'win32')` | `"'C:\\w'"` |
      | `quotedWord("C:\\o'b", 'win32')` | `"'C:\\o''b'"` |

    - `it('withheldOn names what cmd.exe or Windows PowerShell read, on Windows only')`:
      - `withheldOn(['trust', 'p1', '--cmd', 'npm test && npm run lint'], 'win32')` returns the exact copy with `<chars>` = `&`;
      - `['a"b%c']` gives `" %`;
      - each of the eight characters alone is withheld;
      - `withheldOn(['x&y'], 'darwin')` and `withheldOn(['plain words'], 'win32')` are `undefined`.
    - `it('offeredLine is shellLine unless Windows withholds it')`:
      - `offeredLine(['git', 'push', '-u', 'origin', 'main'], 'darwin')` === `'git push -u origin main'`;
      - `offeredLine(['git', 'checkout', '--', 'd&x.html'], 'win32')` is `undefined`.
    - `it('shellWords reads the quoter\'s grammar and a human\'s typing, and refuses an open quote')`:

      | Input | Result |
      |---|---|
      | `` `witness decide plan p1 --revise --note "don't ship"` `` | ends `['--note', "don't ship"]` |
      | `"a 'b'\\''c' d"` | `['a', "b'c", 'd']` |
      | `'a "x\\"y" \\$z'` | `['a', 'x"y', '$z']` |
      | `'  a   b  '` | `['a', 'b']` |
      | `'a "" b'` | `['a', '', 'b']` |
      | `'$(touch M1)'` | `['$(touch', 'M1)']` |
      | `"a 'open"` and `'a\\'` | `undefined` |

  - In `tests/paste.test.ts`, the first rows:

    | Row | Builds | Expects |
    |---|---|---|
    | `quoter: a POSIX word` | `shellLine(['witness', 'x', p], 'darwin')` | calls `[['witness', 'x', p]]` |
    | `quoter: a word starting with =` | `shellLine(['witness', '=ls'], 'darwin')` | calls `[['witness', '=ls']]` |
    | `quoter: the Windows form in a POSIX shell` | `shellLine(['witness', 'x', p], 'win32')` | inert only (lossy for `'`) |

  - Also in `tests/paste.test.ts`, a check on the harness itself: `it('the harness sees a line that does run code', …)`. `pasteIn('bash', 'witness x $(touch M1)')` returns marker `M1`. Without it, a broken harness would pass every row.

- [ ] **Step 2:** Run `pnpm vitest run tests/quote.test.ts tests/paste.test.ts`. Expected: FAIL, because the functions are not exported.
- [ ] **Step 3:** Implement the Interfaces in `src/toon.ts`. A `// Row 239.` comment block names the platform rule, B2's flag shape and why the risky set is what it is.
- [ ] **Step 4:** Run `pnpm vitest run tests/quote.test.ts tests/paste.test.ts tests/trust*.test.ts tests/drive.test.ts tests/act.test.ts` and `pnpm typecheck`. Expected: PASS, with every existing test unchanged; no grant or watch line in them starts with `=`.
- [ ] **Step 5:** Commit: `fix(quote): one quoter for every pasted word, with the paste harness (row 239)`.

### Task 2: The revise option carries no note

**Files:**
- Modify: `src/rounds.ts:323-355` (add `reviseAct` before `exitActs`; `exitActs`' `note` uses it), `src/recommend.ts:148` (`note` uses it), `src/verbs/decide.ts:214` (the derived note) and `:442` (`recommendedVerb`).
- Test: `tests/recommend.test.ts`, `tests/exits-line.test.ts`, `tests/decide.test.ts`, `tests/paste.test.ts`.

**Interfaces:**
- Produces: `export function reviseAct(gate: string, target: string, entries: Entry[]): Act` in `src/rounds.ts`. It returns `cliAct('decide', gate, target, '--revise')` when `notePrefill(entries, gate) !== '<why>'`, and `cliAct('decide', gate, target, '--revise', '--note', '<why>')` otherwise.
- `applyDecision`:

  ```ts
  const prefill = notePrefill(entries, gate)
  const note = act.note ?? (decision === 'revise' && act.upstream === undefined && act.repair !== true && prefill !== '<why>' ? prefill : undefined)
  ```

  Everything downstream reads `note` as today: the entry, the reopen entries and the `revise-context` print.
- `recommendedVerb` is read off the act: `rec?.options[0]?.act?.argv.find((w) => w === '--approve' || w === '--revise' || w === '--stop')?.slice(2)`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/recommend.test.ts`, `it('the revise option carries no reviewer text: bare where the run holds facts, the <why> slot where it holds none (row 239)')`:
    - **A blocking-here run, with anchor `p1 > ## Notes $(touch M1)`.** The note option's `act.argv` is `['decide', 'plan', 'p1', '--revise']`, its `command` is `witness decide plan p1 --revise`, and it is runnable. No option's `command` holds `$(`.
    - **A non-blocking-only run.** The note option's argv ends `['--revise', '--note', '<why>']`, and it is not runnable.
  - `tests/exits-line.test.ts`, `it('the exits name the bare revise below the bound (row 239)')`: `liveExits('plan', 'p1', <one blocking run>, false, 'auth-refresh')` === `'witness decide plan p1 --approve | --revise | --revise --upstream auth-refresh | --stop'`.
  - `tests/decide.test.ts`, beside the revise tests, using `stoppedGate()` (or the file's blocking-run setup):
    - `it('a bare --revise journals the prefill the block used to carry (row 239)')`: exit 0, and the last `human-decision`'s `note` equals `notePrefill(readStream(…), 'plan')`, i.e. `1 blocking finding: <its anchor>`. stdout holds `note: 1 blocking finding:`.
    - `it('a bare --revise on a run with no facts journals no note (row 239)')`: on a clean manual stop, the entry has no `note`.
    - `it('--note, --upstream and --repair journal what they did before (row 239)')`:
      - `--revise --note fixit` journals `note: 'fixit'`;
      - `--revise --upstream <parent>` journals no `note` on either entry;
      - `--revise --repair` at the bound journals no `note`.
    - `it('recommended is option 1\'s verb, read off its argv (row 239)')`: `entry.recommended === 'revise'` on blocking-here.
  - `tests/paste.test.ts`, row `K1 the decision block, a reviewer's anchor`. Entries hold one stopped plan run whose blocking finding is anchored at `` `p1 > ## Notes ${p}` ``. For each runnable option of `recommend({ gate: 'plan', target: 'p1', entries, upstream: 'auth-refresh', stale: false })`, paste `o.command`; and paste the `run:` line of `renderDecision(…)` with `run: ` cut. Each call is `['witness', ...o.act.argv]`.
- [ ] **Step 2:** Run `pnpm vitest run tests/recommend.test.ts tests/exits-line.test.ts tests/decide.test.ts tests/paste.test.ts`. Expected: FAIL. The option carries the note, and the K1 row makes marker `M1` in bash.
- [ ] **Step 3:** Implement the Interfaces. Rewrite `notePrefill`'s comment: it is what `decide` journals for a bare revise, no longer what a command carries.
- [ ] **Step 4: Changes by design.** Each pinned prefilled-note line loses ` --note "…"`. Nothing else in these expectations moves.
  - `tests/recommend.test.ts`: 19, 39, 160, 173, 221, 259, 287, 295, 627, 765, 781, 795, 803, 819, 833, 841, 857, 871.
  - `tests/recommend.test.ts:983-991` ("keeps a reviewer's anchor one word of the note"). Its anchor `src/a.ts "x" | <why>` is a fact, so the revise is bare, and its `.find(… '--note')` would come back empty. It becomes "a reviewer's anchor is in no command, whatever it holds": the revise option's argv is `['decide', 'plan', 'p1', '--revise']`, it is runnable, and no option's `command` holds `src/a.ts`.
  - `tests/exits-line.test.ts`: 68, 172, 174.
  - `tests/autonomy.test.ts`: 72, 76, 92, 93, 98, 147. The strings drop the note. The `take` shape changes in Task 5.
  - `tests/decide-view.test.ts`:
    - :33 — the first option's argv is `['decide', 'implement', target, '--revise']`.
    - :47-63 (ruling R17) — the anchor now reaches `block.anchor` and `block.options.0.why` only. `note.act.argv` and `note.command` drop the note. `controlPaths(view).sort()` equals `['block.anchor', 'block.options.0.why']`. The `it` title and its comment say the anchor is in no command.
  - `tests/text-golden.test.ts`: 208, 222. Line 249's `<why>` slot is unchanged.

  `tests/arbiter.test.ts:39` keeps its `--revise --note "<why>"` (the ship stop holds no facts), and `tests/autonomy-gate.test.ts:60` keeps its journaled note.
- [ ] **Step 5:** Run `pnpm vitest run tests/recommend.test.ts tests/exits-line.test.ts tests/decide*.test.ts tests/autonomy*.test.ts tests/arbiter*.test.ts tests/text-golden.test.ts tests/drive.test.ts tests/paste.test.ts` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit: `fix(decide): the revise option carries no reviewer text; decide derives the prefill (row 239)`.

### Task 3: Every act renders through the quoter

**Files:**
- Modify: `src/act.ts` (the whole renderer: `Act`, `word`, `actOn`, `cliAct`, `exitsLine`), `src/recommend.ts:88-92` (`option`), `src/allowlist.ts:73-76` (`grantAct`, `grantOf`, with `platform`).
- Test: `tests/act.test.ts`, `tests/recommend.test.ts`, `tests/exits-line.test.ts`, `tests/paste.test.ts`.

**Interfaces:**
- Consumes: `shellWord`, `withheldOn`, `Platform` (Task 1).
- Produces:

  ```ts
  export interface Act { argv: readonly string[]; inputs: readonly ActInput[]; line: string; withheld?: string }
  export function actOn(platform: Platform, argv: readonly string[]): Act
  export function cliAct(...argv: string[]): Act                     // actOn(process.platform, argv)
  export function exitsLine(acts: readonly Act[], platform: Platform = process.platform): string
  export function grantAct(target: string, c: Pick<RunCommand, 'cmd'>, platform: Platform = process.platform): Act | undefined
  export const grantOf: (target: string, c: Pick<RunCommand, 'cmd'>, platform?: Platform) => string
  ```

  - `word(argv, at, platform)`: an input slot prints as today, `"<why>"` or `<effort>`. Every other word prints through `shellWord(w, platform)`, the `--note` and `--cmd` words included.
  - `actOn` sets `withheld` to `withheldOn(<argv without its input slots>, platform)` when that is defined.
  - `option()`:
    - `runnable` is `act.inputs.length === 0 && act.withheld === undefined`;
    - `note` is `[rest.note, act.withheld]` without the undefined ones, joined by ` · `, and omitted when empty.
  - `grantOf` keeps today's answers (the grant's line, or `UNGRANTABLE`). For a withheld act it returns `` `${act.withheld} · at a terminal, ${actOn(platform, ['trust', target]).line} asks for each command` ``.
  - Rewrite `act.ts`'s header comments. The `--note` word is no longer raw, and D120's grammar is the quoter's now. Delete the `actOfCommand` mention. `Act.withheld` names B4.

- [ ] **Step 1: Write the failing tests.**
  - `tests/act.test.ts`:
    - `it('a Windows act prints psArg words and keeps witness\'s own bare (row 239)')`:
      - `actOn('win32', ['trust', 'p1', '--cmd', "echo 'hi'"]).line` === `"witness trust p1 --cmd 'echo ''hi'''"`;
      - `actOn('win32', ['decide', 'plan', 'p1', '--revise', '--note', '<why>']).line` === `'witness decide plan p1 --revise --note "<why>"'`.
    - `it('on Windows an act whose word holds a risky character is withheld, and only there (row 239)')`:
      - for each of `& | ^ < > " % !`, `actOn('win32', ['trust', 'p1', '--cmd', \`a${c}b\`]).withheld` is defined;
      - the same act from `actOn('darwin', …)` has no `withheld` key;
      - `actOn('win32', ['decide', 'plan', 'p1', '--revise', '--note', '<why>']).withheld` is `undefined`, since the slot is the CLI's.
  - `tests/recommend.test.ts`, `it('a withheld act is shown and never a runnable option (row 239)')`:
    - `option(actOn('win32', ['trust', 'p1', '--cmd', 'a&b']), 'root', { note: 'n' })` has `runnable: false` and `note: 'n · <the withheld copy>'`;
    - `renderDecision` of a block whose option 1 is that prints `1 · recommended · root · not runnable` and no `run:` line.
  - `tests/exits-line.test.ts`, `it('a Windows exits line shares the prefix the same way (row 239)')`: `exitsLine([d('--approve'), d('--stop')], 'win32')`, where `d` builds with `actOn('win32', …)`, equals `'witness decide plan p1 --approve | --stop'`.
  - `tests/paste.test.ts`, rows. Each expects calls `[['witness', ...act.argv]]` for each act or row command:

    | Row | Builds |
    |---|---|
    | `K1 the decision block, a hostile target and upstream` | `recommend({ gate: 'plan', target: \`p1${p}\`, upstream: \`up${p}\`, … })` over Task 2's run, for each runnable option |
    | `K2 exits below and at the bound` | `exitActs('plan', \`p1${p}\`, entries, false, \`up${p}\`)`, for a below-bound and an at-bound stream |
    | `K2 a reopen` | `reopenActs('plan', \`p1${p}\`, <a parked below-bound stream>, \`up${p}\`)` |
    | `K6 an inbox row` | `needYouRows` of hand-built items of kinds `decision`, `design-look`, `need`, `stuck` and `parked` (below the bound), each id `\`p1${p}\``; each `run:` or `then:` row with its label cut |
    | `K7 a satisfy` | `satisfyCommand(\`p1${p}\`, \`n${p}\`)` |
    | `K10 a trust grant` | `grantAct(\`p1${p}\`, { cmd: p })!.line` |

- [ ] **Step 2:** Run `pnpm vitest run tests/act.test.ts tests/recommend.test.ts tests/exits-line.test.ts tests/paste.test.ts`. Expected: FAIL. `actOn` does not exist, and the K rows make markers.
- [ ] **Step 3:** Implement the Interfaces.
- [ ] **Step 4: Changes by design**, in `tests/act.test.ts`.
  - :8-9 — the note word is single-quoted: `--note '2 blocking findings: a "b", c'`.
  - :28 — `--upstream '<why>'` and `--note '<effort>'`.
  - :31-34 — `'über plan'`, `'Auth Refresh'` (twice), `'prod access'`, `''`.

  The `it` title becomes "every word but the CLI's own slots prints through the quoter". `tests/trust.test.ts:352-355` compares with `cliAct` and passes as it stands.
- [ ] **Step 5:** Run `pnpm vitest run tests/act.test.ts tests/recommend.test.ts tests/exits-line.test.ts tests/trust*.test.ts tests/needs-you.test.ts tests/text-golden.test.ts tests/paste.test.ts` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit: `fix(act): every word of an offered command prints through the quoter; Windows withholds risky ones (row 239)`.

### Task 4: `next`'s lines are acts, and one command each

**Files:**
- Modify: `src/verbs/next.ts`:
  - `NextAction` (:267-288) gains `act`;
  - every template B8 calls runnable becomes an act: `:223`, `:233-235` (`verify-red` and the second `test-evidence`), `:244-249` (`stepLine` returns `{ act, why? }`), `:351`, `:366`, `:371`, `:379`, `:388`, `:395`, `:429-430`, `:456`, `:510`, `:521`, `:831` (the recover option's own act), `:834`, `:889`, `:977`, `:986`, `:1053`, `:1078`, `:1082`, `:1088`, `:1251`;
  - the shapes quote their foreign words: `:347`, `:799`, `:906`, `:929`, `:938`, `:972`, `:983`. `:795`, `:909` and `:913` hold none;
  - the bound-stuck rung (:891-894) names `--show`;
  - `cmd()` prints at :1309, :1331 and :1332;
  - the `wait:` line (:1372) prints `cliAct('wait', '--since', <token>).line`;
  - the note at :984 (`… from witness decide design ' + id + ' --show`) is built from `cliAct`.
- Modify: `src/verbs/design.ts:139,183` and `src/verbs/recap.ts:160` (their `next:` lines), `src/drive.ts:741` (`help:`) and `:896` (the aside's `line`), `src/slice.ts:190` and `src/verbs/dispatch.ts:85` (`cmd('relay', …)`).
- Test: `tests/next.test.ts` (or the file holding its rung tests), `tests/paste.test.ts`.

**Interfaces:**
- Produces: `NextAction.act?: Act`, present exactly when the line is a runnable witness command, with `line === act.line`.
- Shape lines quote each foreign word with `shellWord`. For example: `` `witness write <spec-id> --effort ${shellWord(e.slug)} --meta m.json --body b.md` ``.
- The bound-stuck rung returns `{ line, act: cliAct('decide', owed.gate, owed.target, '--show'), target, note: 'round bound reached — human decision required' }`.
- `withTrust`, `trustOwed`, `conversationStage`, `withDeferralNote`, `keyOf` and next's own prefix tests read `line` as today. A verb or flag is never quoted, so their prefixes hold.

- [ ] **Step 1: Write the failing tests** in `tests/next.test.ts`:
  - `it('every runnable next: line is its act\'s line, and a shape line carries none (row 239)')`, using `computeNext` on the file's seeded states:
    - a draft plan's gate owed (`src/verbs/next.ts:1044-1053`) gives `act.argv` `['gate', 'plan', <id>]` and `line === act.line`;
    - a decompose with no spec written gives no `act`, and a line starting `witness write <spec-id> --effort `;
    - an approved plan to start gives `act.argv` `['start', <id>]`.
  - `it('at the round bound next names decide --show, one command (row 239)')`. This is the rung no existing test reaches: a gate at the bound with no pending decision.
    - Set up `gatedEffort()` (`tests/drive.test.ts:593-605`) and append rounds 2 and 3 on the current sha, as `:648-660` does.
    - Then append `{ v: 1, t: 'human-decision', gate: 'decompose', artifact: <effort>, round: 3, decision: 'revise' }` directly.
    - stdout of `next` holds `next: witness decide decompose <effort> --show` and `note: round bound reached — human decision required`. No `next:` line holds ` | `.
  - `tests/paste.test.ts`, row `K3 a next: shape from a forged effort stream` (an async build). A `seededRepo({ noRecap: true })` gets a committed `.witness/journal/e${p}.jsonl` whose first entry is a recap, and the row returns `next`'s `next:` value. Paste it inert only: its `<spec-id>` redirect fails. This row changes in Task 9, where the stream is never offered.
  - `it('a next: or run: value holding a comma prints raw, never TOON-quoted (row 239, D120)')`. The same setup, with the stream named `e,x`. stdout's `next:` line is exactly `next: witness write <spec-id> --effort e,x --meta m.json --body b.md`. Only that line is checked: `target:` is a TOON value and stays `target: "e,x"` (`src/verbs/next.ts:1311`). This row also changes in Task 9.
- [ ] **Step 2:** Run `pnpm vitest run tests/next.test.ts tests/paste.test.ts`. Expected: FAIL. There is no `act`, the bound line is the menu, the forged slug makes a marker, and the comma line is TOON-quoted.
- [ ] **Step 3:** Implement. `design.ts` and `recap.ts` print `cmd('next', …)` from `cliAct` (design) and a quoted shape (recap). `drive.ts:896` stores `cliAct('decide', r.gate, r.target, '--show').line`, and `:741` names `cliAct('retry', target).line`.
- [ ] **Step 4: Changes by design:** none. `tests/drive.test.ts:142-144` builds its own bound line and still classifies until Task 5.
- [ ] **Step 5:** Run `pnpm vitest run tests/next*.test.ts tests/flows.test.ts tests/dashboard.test.ts tests/drive*.test.ts tests/design*.test.ts tests/recap*.test.ts tests/context-relay.test.ts tests/autonomy*.test.ts tests/trust-preflight.test.ts tests/paste.test.ts` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit: `fix(next): every next: line is one command, built from its act; shapes quote their words (row 239)`.

### Task 5: Witness's readers act on argv

**Files:**
- Modify:
  - `src/autonomy.ts:41-103` (`Policy`, `StopFacts`, `policyFor`);
  - `src/settle.ts:23-29` (`Settled`), `:46-47` (`leftLine` via `cliAct`), `:96-117`, `:149-165`;
  - `src/arbiter.ts:10,119-127` (`menuFor`);
  - `src/recommend.ts:78-84` (delete `PLACEHOLDER`);
  - `src/verbs/decide.ts:139-149` (delete `actOfCommand`; add `shownView`), `:173-182` (`show` uses it);
  - `src/drive.ts` — `DriveStep` (:42-49), `classifyAction` (:62-69), the `routed` map (:876, :898, :1061), and :1199-1342 (delete `BlockOption`, `parseBlock`; rewrite `nodExcluded`, `byVerb`, `selectOption`, `resolveDecision`; keep `splitArgv` for `WITNESS_BIN` with its comment saying so);
  - `src/verbs/next.ts` — `block` (:276, :831, :1037, :1316), the recover and choose policies (:825-828, :1026-1028), and `routed` (:1227-1236, :1267-1270).
- Create: `tests/one-note.test.ts`.
- Test: `tests/autonomy.test.ts`, `tests/autonomy-gate.test.ts` (settle's arbiter path), `tests/drive.test.ts`, `tests/arbiter.test.ts`, `tests/decide.test.ts`.

**Interfaces:**
- Consumes: `Act` and `actOn` (Task 3), `NextAction.act` (Task 4), `shellWords` (Task 1).
- Produces:

  ```ts
  export type Policy = { kind: 'take'; act: Act } | { kind: 'pick'; id: string } | { kind: 'arbiter' } | { kind: 'human'; stop: KeptStop }
  export type StopFacts = | { at: 'gate'; …as today } | { at: 'choose'; block: Decision } | { at: 'recover'; block: Decision } | { at: 'start'; …as today }
  export type Settled = … | { kind: 'routed'; act: Act; line: string } | …
  export function shownView(ctx: Ctx, gate: string, target: string): DecideView | undefined   // decide.ts
  ```

  - **The policy.**
    - `first()` takes option 1 when `o.act !== undefined && o.act.inputs.length === 0`.
    - The fallen-back and trust re-run arms take `cliAct('gate', gate, target)`.
    - `at: 'recover'` takes `options[0].act`, with `{ kind: 'arbiter' }` if it has none: `Option.act` is optional, and `recoverChoice`'s options always carry one.
    - `at: 'choose'` gives `{ kind: 'pick', id: options[0].command }`.
  - **settle's own lines**: `leftLine` (`:46-47`) and the design-look kept stop (`:101`) name `cliAct('decide', gate, target, '--show').line`.
  - **settle's take.** An act whose `argv[0] !== 'decide'` is routed: `{ kind: 'routed', act, line: cmd('autonomy', \`re-run owed — ${act.line}\`) }`. A decide act goes through `decisionAct([...act.argv.slice(1)])`; a refusal there is `left`, as today's `not-a-decision` would have been.
  - **The arbiter's choice.** `menu[choice - 1].act` is copied, each of its `why` inputs (`argv[i.at]`) is filled with `ruling.value.note ?? ruling.value.reason`, and the result goes through `decisionAct(argv.slice(1))`.
  - **`menuFor`** keeps an option when all of these hold:
    - `o.act?.argv[0] === 'decide'`;
    - `!o.act.argv.includes('--trust-cmds')`;
    - `o.act.inputs.every((i) => i.name === 'why')`;
    - `!(approveBarred && o.act.argv.includes('--approve'))`.
  - **`classifyAction`** gives `{ kind: 'decision', gate: act.argv[1], target: act.argv[2] ?? action.target }` when `action.act?.argv[0] === 'decide'`. Its other arms are unchanged.
  - **`resolveDecision(step, action, ctx)`.**
    - With `step.block`, it prints `renderDecision(step.block)`, and the options are `step.block.options`.
    - Else it prints `decideViewLines(shownView(ctx, gate, target))` (or returns `'refused'` when that is `undefined`), and the options are the view's `block.options` when actionable, else `[]`.
  - **Selection** works over `options.flatMap((o, i) => o.act ? [{ n: i + 1, act: o.act, recommended: i === 0, runnable: o.act.inputs.length === 0 }] : [])`. This is `parseBlock`'s shape with `command` replaced by `act`.
    - A pick whose act has an input slot is refused, with today's messages (`src/drive.ts:1251,1261`): `the recommended option needs an id you must fill in — type it out`, and `option <n> needs an id you must fill in — type it out`. Otherwise answering `2` at a clean stop would journal the note `<why>`.
    - `runnable` reads `inputs`, never `withheld` (B4): drive runs in process.
    - A nod runs `[...act.argv, '--via', 'affirmation']` and prints `` `${act.line} --via affirmation` ``.
    - A number or a verb runs `act.argv`.
    - A typed `witness …` answer runs `shellWords(answer)!.slice(1)`. When `shellWords` returns `undefined`, it refuses with `help: its quotes do not close — type the command again`.
    - `byVerb` matches `act.argv.includes(\`--${word}\`) || act.argv[0] === word`.
    - `nodExcluded` reads `act.argv`: `abandon` as `argv[0]`, and `--override`, `--stop` or `--trust-cmds` as words.
  - **`NextAction.block` and `DriveStep`'s `block`** are `Decision`s.
- Delete `actOfCommand`, `parseBlock`, `BlockOption` and `PLACEHOLDER`, and every comment that cites them (`src/act.ts:8,33`, `src/recommend.ts:37-38,78-84`, `src/drive.ts:1206-1209`).

- [ ] **Step 1: Write the failing tests.**
  - `tests/autonomy.test.ts`. The helper becomes `const take = (...argv: string[]) => ({ kind: 'take', act: cliAct(...argv) })`:
    - lines 70-147 assert acts, e.g. `take('decide', 'plan', 'p1', '--revise')` and `take('gate', 'plan', 'p1')`;
    - `:110` becomes `{ kind: 'pick', id: 'token-store' }`;
    - `:111` becomes `take('recover', '--complete')`. Its fixture option gains `act: cliAct('recover', '--complete')`, which `recoverChoice` always gives.
  - `tests/arbiter.test.ts`, `it('the menu reads acts: an anchor holding --approve, --trust-cmds or <effort> filters nothing (row 239)')`. A block whose `why` holds those words has an unchanged menu. A hand-built option `{ command: 'witness decide plan p1 --approve', … }` with no act is not offered.
  - `tests/drive.test.ts`:
    - `it('a typed answer is split by the quoter\'s grammar (row 239)')`. On `gatedEffort()`, the answer `` `witness decide decompose ${repo.effort} --revise --note 'it'\''s'` `` journals the note `it's`. Today's `splitArgv` journals `'it'\''s'` (probed), so this is the RED case. A `"don't ship"` answer already splits right and is a guard.
    - `it('a pick that needs a word filled is refused, as before (row 239)')`.
      - Build `gatedEffort()`'s repo, but with a verdict holding no findings and the gate run with `--manual`. That is a `manual-stop`, whose revise option holds the `<why>` slot.
      - Answering with that option's number prints `option <n> needs an id you must fill in — type it out` and decides nothing.
    - `it('an answer with an open quote is refused, not run (row 239)')`: answers `['witness decide x "open', '']` print `its quotes do not close` and decide nothing.
    - `it('decide> prints decide --show byte for byte (row 239, D143)')`. On `gatedEffort()` with answers `['']`, the lines of `(await repo.cli(['decide', 'decompose', repo.effort, '--show'])).stdout` appear in drive's output contiguous and in order.
  - `tests/decide.test.ts`: `it('no reader parses a printed decision back (row 239)')`. The module exports no `actOfCommand`, and `src/drive.js` exports no `parseBlock`.
  - `tests/one-note.test.ts`, `it('one block journals one note on every surface, and no line is reparsed (row 239)')`.
    - Build one stopped plan gate whose blocking finding is anchored at `p1 > ## Notes $(touch M1) "q" 'r'`.
    - Run the recommended revise four ways, each on a fresh copy of the same state:
      - **the UI:** `main(ctx, ['decide', ...view.block.options[0].act.argv.slice(1)])`;
      - **drive:** `driveLoop` with answer `y`;
      - **settle:** autonomy on, `settleStop`;
      - **a pasted line:** the `run:` line from `decide --show` goes through `pasteIn('bash', …)`, and the stub's argv then runs through `main`.
    - Each run journals `note === notePrefill(entries, 'plan')`.
  - `tests/autonomy-gate.test.ts` (the file that fakes the arbiter with `putVerdict(…, 'arbiter')`), `it('the arbiter fills the <why> slot through argv (row 239)')`. On a `reserved-stop-clean` stop whose fake arbiter picks the note option with `note: 'it\'s wrong'`, the journal holds `note: "it's wrong"` and `selected: 'arbiter'`.
- [ ] **Step 2:** Run `pnpm vitest run tests/autonomy.test.ts tests/autonomy-gate.test.ts tests/arbiter.test.ts tests/drive.test.ts tests/decide.test.ts tests/one-note.test.ts`.
  - **Expected FAIL:** the `take`/`pick` shapes, the act-less menu option, the typed `'it'\''s'` answer, the open-quote answer, and the missing exports.
  - **Guards, which pass already once Task 2 has landed and pin what this task must keep:** the one-note test, the arbiter's `<why>` fill, the byte-for-byte `decide>` view, and the slot refusal.
- [ ] **Step 3:** Implement the Interfaces.
- [ ] **Step 4: Changes by design.**
  - `tests/autonomy.test.ts:70-147`: the `take` shape, as in Step 1.
  - `tests/drive.test.ts:126-127`, `:142-144`, `:746-747`: each `witness decide` fixture gains its `act` (`cliAct('decide', 'ship', 'p1', '--show')`). The `:142-144` fixture becomes the `--show` line Task 4 prints.
  - `tests/drive.test.ts:147-152`, `:740`, `:742-745`: each `block` fixture becomes a `Decision` (`{ key, rule, options }`).
  - `tests/decide.test.ts:566-570`: the `actOfCommand` assertions are deleted. Their subject is gone, and `tests/one-note.test.ts` covers what they guarded. Line 571's `decisionAct(…, '--via', 'affirmation')` assertion stays, under an `it` renamed for it.
- [ ] **Step 5:** Run `pnpm vitest run tests/autonomy*.test.ts tests/arbiter*.test.ts tests/drive*.test.ts tests/decide*.test.ts tests/next*.test.ts tests/one-note.test.ts tests/ship*.test.ts` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit: `fix(readers): settle, the arbiter and drive run an option's argv; no printed line is parsed back (row 239)`.

### Task 6: A command never shares a line with foreign prose, and a `run:` is one command

**Files:**
- Modify:
  - `src/autonomy.ts:35-39` (`unmetNeedLine`);
  - `src/verbs/start.ts:118-123`;
  - `src/allowlist.ts` (`grantRows`, `pendingRows`; `trustListing` takes `platform`);
  - `src/verbs/next.ts:1296-1307` (`waiting:` and the trust kept stop);
  - `src/settle.ts:96-105`;
  - `src/needs-you.ts:145-156` (`trustRows`) and `:184-185` (`parked`);
  - `src/verbs/trust.ts:129-135`;
  - `src/needs.ts:91` and `src/criteria.ts:154-157` (`HeldRow.spec`);
  - `src/gate-run-view.ts:50,72,105` (the view's `held` type, and the rebuilt command);
  - `src/ship.ts:83-87` (`prBody`'s held rows, rebuilt the same way: a PR is a surface too);
  - `plugin/commands/witness.md:25,30,31,32,46`.
- Test: `tests/autonomy.test.ts`, `tests/needs-you.test.ts`, `tests/trust.test.ts`, `tests/held-gates.test.ts`, `tests/command.test.ts`, `tests/paste.test.ts`.

**Interfaces:**
- **`unmetNeedLine(needs)`** returns `[keptStopLine('unmet-need', needs.map((u) => u.text).join(' · ')), ...needs.map((u) => \`  run: ${u.satisfy}\`)].join('\n')`. `start.ts` prints the same shape from its labels and satisfy commands.
- **`grantRows(target, c, platform = process.platform): string[]`** has three answers:

  | The command | Rows |
  |---|---|
  | grantable | `['  run: <grant line>']` |
  | `hasControl` | `['  note: <UNGRANTABLE>']` |
  | withheld | `['  note: <withheld copy>', \`  run: ${actOn(platform, ['trust', target]).line}\`]` |

  The trust kept stop prints `keptStopLine('trust-grant', shownCmd(c))` and then its rows, in `next` and in settle. needs-you's `trustRows` prints its `wait:` head and then `grantRows`.
- **`pendingRows(listing, platform = process.platform): string[]`** (allowlist.ts) gives the trust verb's non-terminal rows. A grantable act gives `` `run: ${a.line}` ``. A withheld one gives `` `note: ${visible(a.argv[3]!)} — ${a.withheld} · at a terminal, ${actOn(platform, ['trust', listing.target!]).line} asks for each command` ``.
- **`trustListing(root, cfg, canon, target?, platform = process.platform)`** keeps every untrusted printable command in `pending`, withheld ones included, so `pendingCmds` and the terminal prompt still reach them.
- **`waiting:`** is `export function waitingRows(item: NeedYou): string[]` in `src/needs-you.ts`, beside `needYouRows`: `cmd('waiting', head.replace(/^wait: /, ''))`, then the item's other rows as `needYouRows` prints them, already indented. `next` prints it.
- **The parked row** prints `` `  run: ${reopen[0].line}` `` for one act, and `` `  exits: ${exitsLine(item.reopen)}` `` for more than one.
- **`HeldRow`** is `{ criterion: string; need: string; satisfy: string; spec?: string }`. `laneCheck` writes `spec: lane.value.spec`.
- **`heldSatisfy(h: HeldRow): string | undefined`** (`src/needs.ts`, beside `HeldRow` and `satisfyCommand`). `GateRunView.held` becomes `Array<{ criterion: string; need: string; satisfy?: string }>`, and `prBody` uses the same helper. Its answer is the first that applies:

  | When | `satisfy` |
  |---|---|
  | `h.spec` and `h.need` both pass `ID_RE` | `cliAct('satisfy', h.spec, '--need', h.need).line` |
  | there is no `spec`, and the stored `h.satisfy` matches `/^witness satisfy [a-z0-9][a-z0-9-]* --need [a-z0-9][a-z0-9-]*$/` | the stored string |
  | otherwise | `undefined` |

  `gateRunLines` prints `` `held: ${c} — ${n} unmet${s ? ` · ${s}` : ''}` ``. `prBody` prints `` `- ${c}: ${n} unmet${s ? ` — ${s}` : ''}` ``.
- **`witness.md`**, changed rows:
  - **Row 30**: "For each command the human **names**, run the `run:` line printed under its `kept-stop:` line — `witness trust <target>` with a `--cmd` naming that one command — byte-for-byte". It keeps 'a bare "y" grants nothing' and "keep matching the rows below". It adds: "A `note:` that says `not offered on Windows` cannot be granted by a line: say so; the `run: witness trust <target>` under it lists the command, and asks for it when the human runs it in their own terminal."
  - **Row 31**: "with its command — the `run:` line under it, or the segment of its `exits:` line they name, completed with the `witness decide <gate> <target>` it shares".
  - **Row 32**: 'On "done", run the `run:` line printed under it'.
  - **Rows 25 and 46**: the handoff `run:` is the **unindented** one in the routing unit. An indented `  run:` belongs to the line above it.

- [ ] **Step 1: Write the failing tests.**
  - `tests/autonomy.test.ts`, `it('an unmet need prints its commands on their own lines (row 239)')`: `unmetNeedLine([{ text: 'a', satisfy: 'witness satisfy p1 --need 1' }, { text: 'b', satisfy: 'witness satisfy p1 --need x' }])` === `'kept-stop: unmet need — a · b\n  run: witness satisfy p1 --need 1\n  run: witness satisfy p1 --need x'`.
  - `tests/trust.test.ts`:
    - `it('a grant prints on its own line; on Windows a risky one is withheld for the listing (row 239)')`:
      - `grantRows('p1', { cmd: 'npm test' }, 'darwin')` toEqual `["  run: witness trust p1 --cmd 'npm test'"]`;
      - `grantRows('p1', { cmd: 'bad\u001bcmd' })` toEqual `['  note: never granted here — rewrite it in printable ASCII where it is written']`;
      - `grantRows('p1', { cmd: 'npm test && npm run lint' }, 'win32')` toEqual `['  note: not offered on Windows — it holds &, which cmd.exe or Windows PowerShell can read as more than text', '  run: witness trust p1']`.
    - `it('a withheld command stays pending, so the terminal prompt still asks for it (Review Focus 1)')`: on a repo whose `ship.test` is `npm test && npm run lint`, `pendingCmds(trustListing(root, cfg, canon, id, 'win32').value)` contains it, and `pendingRows(…)` gives its `note:` row.
  - `tests/needs-you.test.ts`, `it('a parked menu prints as exits:, a single reopen as run: (row 239)')`. An at-bound parked item's second row starts `  exits: witness decide plan `; a below-bound one starts `  run: witness gate plan `.
  - `tests/held-gates.test.ts`, `it('a journaled satisfy is rebuilt from its fields, and a forged one prints none (Review Focus 4)')`. It uses `gateRunLines(gateRunView(entry, 'ran'))` over hand-built entries whose drift-lane check holds one row:
    - a row `{ criterion: 'ac-prod', need: 'prod', spec: 'auth-refresh', satisfy: 'x' }` gives `held: ac-prod — prod unmet · witness satisfy auth-refresh --need prod`;
    - a row with no `spec` and `satisfy: 'witness satisfy auth-refresh --need prod'` gives the same line;
    - a row with no `spec` and `satisfy: 'witness satisfy x --need y; touch M1'` gives `held: ac-prod — prod unmet`;
    - `heldSatisfy` gives the same three answers that `prBody`'s rows print.
  - `tests/command.test.ts`, `it('a kept stop\'s and a waiting line\'s commands are their run: lines (row 239)')`:
    - row 30 contains "the `run:` line printed under" and `not offered on Windows`;
    - row 32 contains "the `run:` line printed under it";
    - row 31 contains "`exits:`";
    - row 46 contains "unindented".
  - `tests/paste.test.ts`, rows:
    - **`K7 an unmet need, forged text`.** `unmetNeedLine([{ text: \`ses · witness satisfy p1 --need 1 ${p}\`, satisfy: satisfyCommand('p1', 'ses') }])`. `unmetNeeds` passes a manual text through unchanged, so this is the line `next`, drive and `start` print.
      - Its first line is exactly `` `kept-stop: unmet need — ${text}` ``: prose, which the skill never runs.
      - Each `  run:` row pastes exact (`['witness', 'satisfy', 'p1', '--need', 'ses']`).
    - **`K8 waiting, a forged park note`.** `waitingRows` of a parked item whose `why` holds `` ` · run: witness gate plan p1 ${p}` ``.
      - The `waiting:` line is exactly `` `waiting: parked: ${target} · plan round ${n} — ${why}` ``.
      - Its one `  run:` row pastes exact.
    - **`K2 an at-bound park`.** Each act of its `exits:` line is pasted on its own (design §3.4b), each exact.
- [ ] **Step 2:** Run `pnpm vitest run tests/autonomy.test.ts tests/trust.test.ts tests/needs-you.test.ts tests/held-gates.test.ts tests/command.test.ts tests/paste.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the Interfaces, and edit `witness.md` as above.
- [ ] **Step 4: Changes by design.** Each pin takes the new shape: the head line, then `\n  run: <command>` (or `\n  note: …`).
  - `tests/autonomy-next.test.ts:78`;
  - `tests/autonomy-gate.test.ts:108-109` (`:192` still matches its head);
  - `tests/drive.test.ts:886`;
  - `tests/next-wait.test.ts:96`, which becomes `waiting: stuck: a-plan-1 — witness log a-plan-1\n  run: witness retry a-plan-1`;
  - `tests/next-scope.test.ts:219-220`. Its check is `out.split('\n').filter((l) => l === notice)`, and a two-line notice matches no single line, so the logic changes too: count the notice's head line, and check that its `  run:` line follows it;
  - `tests/next.test.ts:471`;
  - `tests/held-gates.test.ts:27`: `ROW` gains `spec: 'auth-refresh'`, because `laneCheck` now journals it. Line 33's `toEqual` reads the journaled row;
  - `tests/trust-preflight.test.ts:38`, `:89`, `:133`;
  - `tests/text-golden.test.ts:96`: `run:` becomes `exits:`. Its `held:` line (:198) is unchanged: its row has no `spec`, and the stored command passes the strict form.
- [ ] **Step 5:** Run `pnpm vitest run tests/autonomy*.test.ts tests/trust*.test.ts tests/needs-you.test.ts tests/next*.test.ts tests/drive*.test.ts tests/wait*.test.ts tests/text-golden.test.ts tests/command.test.ts tests/gate*.test.ts tests/held-gates.test.ts tests/ship*.test.ts tests/start.test.ts tests/paste.test.ts` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit: `fix(lines): a command never shares a line with foreign prose, and a run: is one command (row 239)`.

### Task 7: Other tools' commands through one renderer, and the canon guard's twin

**Files:**
- Modify:
  - `src/needs-you.ts:121-123` (a `pr` read with `Number`) and `:183` (`shellLine(['gh', 'pr', 'merge', pr])`);
  - `src/gitio.ts:237-239` (`offeredLine(['git', 'push', '-u', 'origin', branch])`);
  - `src/gates/implement.ts:112-117` (`offeredLine(['git', 'checkout', '--', artRel])`);
  - `src/verbs/adopt.ts:56,127` (`shellLine` for both `git checkout` texts);
  - `src/harness.ts:411-416` (`handoffLine` with `platform`);
  - `src/drive-presence.ts:199-204` (`watchLine` builds each command with `shellLine`);
  - `src/ship.ts:160` (`git fetch` want);
  - `plugin/hooks/canon-guard.mjs:215-233` (the twin and `remedyFor`).
- Test: `tests/harness.test.ts`, `tests/canon-guard.test.ts`, `tests/needs-you.test.ts`, `tests/paste.test.ts`, `tests/quote.test.ts`.

**Interfaces:**
- **`handoffLine(harness, home, model, platform = process.platform)`.**
  - POSIX: `` `cd ${quotedWord(home)} && ${budget}${shellLine([harness.launch, ...modelFlags(harness, model)])} ${quotedWord('/witness')}` ``. The budget is `MAX_THINKING_TOKENS=<n> ` when set.
  - win32: B16. It is never withheld.
- **`needsYou`'s merge `pr`**: `prOf(a.line)` (digits), else `String(n)` where `n = Number(meta)` passes `Number.isInteger(n) && n > 0`, else none.
- **The canon guard** gains standalone twins: `export function shellWord(w, platform = process.platform)` and `export function withheldOn(words, platform = process.platform)`. They copy the toon.ts definitions, held equal by test, on `context-core.mjs`'s precedent of a dependency-free hook.
  - `remedyFor` quotes `id` and `rel` through the twin.
  - Withheld, the tail reads `` ` · already hand-edited? ${line} — ${withheld}` `` with no `run:`.
  - `canonGuard(call)` reads an optional `call.platform`, default `process.platform`, so tests can drive it on win32.

- [ ] **Step 1: Write the failing tests.**
  - `tests/harness.test.ts`, `it('the Windows handoff speaks PowerShell (row 239, B16)')`:
    - `handoffLine(claude, 'C:\\w\\repo', 'claude-opus-5:high', 'win32')` === `"Set-Location -LiteralPath 'C:\\w\\repo' -ErrorAction Stop; $env:MAX_THINKING_TOKENS = '16384'; claude --model claude-opus-5 '/witness'"`;
    - `handoffLine(pi, "C:\\o'b", 'claude-opus-5', 'win32')` === `"Set-Location -LiteralPath 'C:\\o''b' -ErrorAction Stop; pi --model anthropic/claude-opus-5 '/witness'"`.

    `:127-140` and `:338-350` stay as they are, for POSIX.
  - `tests/canon-guard.test.ts`, `describe('the quoter twin (row 239)')`:
    - for every word of a corpus (`tests/quote.test.ts`'s, plus `-LiteralPath`, `--`, `=x`, `a&b`, `''`) × `['darwin', 'linux', 'win32']`, the twin's `shellWord` and `withheldOn` equal toon.ts's;
    - a Write blocked at `specs/a'b c.md` gives a reason containing `run: witness adopt 'specs/a'\''b c.md'`;
    - with `platform: 'win32'` and `specs/a&b.md`, the reason holds no `run: witness adopt` and holds `not offered on Windows`.
  - `tests/needs-you.test.ts`, `it('a pr that is not a positive integer names no merge (row 239)')`. Canon `pr: '9$(touch M1)'` on the merge aside's target gives no `pr`. `pr: 9` gives `'9'`.
  - `tests/adopt.test.ts`, `it('adopt\'s revert help quotes the path it was given (row 239)')`.
    - Commit a doc at `specs/a$(touch M1).md` that fails a schema check: no `## Behavior`.
    - Run `witness adopt` on that path. It refuses, and its stderr holds `` `help: fix the file and re-run, or revert instead: git checkout HEAD -- 'specs/a$(touch M1).md'` ``.
  - `tests/quote.test.ts`, `it('on Windows every kind a foreign word reaches withholds a risky one (row 239)')`. For each of the eight characters:
    - `actOn('win32', ['trust', 'p1', '--cmd', \`x${c}y\`]).withheld` is defined;
    - `grantRows('p1', { cmd: \`x${c}y\` }, 'win32')` holds no `--cmd` row;
    - `offeredLine(['git', 'checkout', '--', \`d${c}.html\`], 'win32')` and `offeredLine(['git', 'push', '-u', 'origin', \`b${c}\`], 'win32')` are `undefined`;
    - the canon guard on `specs/a${c}b.md` with `platform: 'win32'` has no `run: witness adopt`;
    - `handoffLine(claude, \`C:\\a${c}b\`, undefined, 'win32')` is a line that quotes the path.
  - `tests/paste.test.ts`, rows:

    | Row | Builds | Expects |
    |---|---|---|
    | `K4 the handoff, claude` | its own `base = mkdtempSync(…)`, then `mkdirSync(join(base, \`h'${p} x\`))` → `handoffLine(claude, that path, 'claude-opus-5:high', 'darwin')`, with `cwd: base` | calls `[['claude', '--model', 'claude-opus-5', '/witness']]` |
    | `K4 the handoff, pi` | the same kind of home, `handoffLine(pi, …, \`claude${p}\`, 'darwin')` (the pin is charset-checked only at load) | calls `[['pi', '--model', \`anthropic/claude${p}\`, '/witness']]` |
    | `K5 the push remedy` (async build, `REF_PAYLOADS`) | `tmpRepo()` with an empty bare origin, as `tests/start.test.ts:82-86` sets one up; `renderRefusal(resolveStartBase(root, \`main${p}\`).violations)`'s `run:` line | calls `[['git', 'push', '-u', 'origin', \`main${p}\`]]` |
    | `K5 the restore remedy` | `offeredLine(['git', 'checkout', '--', \`designs/${p}.html\`], 'darwin')!` | calls `[['git', 'checkout', '--', \`designs/${p}.html\`]]` |
    | `C1 the merge` | `needYouRows({ kind: 'merge', target: 'x', key: 'k', pr: p })` | its `run:` row, inert |
    | `K11 adopt's help` | `shellLine(['git', 'checkout', 'HEAD', '--', \`specs/a${p}.md\`], 'darwin')`, the text `adopt.ts:56` prints | calls `[['git', 'checkout', 'HEAD', '--', \`specs/a${p}.md\`]]` |
    | `K12 the canon guard` | a Write at `specs/a${p}.md` in a repo holding `witness.config.yaml`, as `tests/canon-guard.test.ts` builds one; the text after the reason's `run: ` | calls `[['witness', 'adopt', \`specs/a${p}.md\`]]` |
    | `K13 the watch line` | `watchLine({ pid: 1, log: join(base, \`l ${p}.log\`) }, 'darwin')` cut at ` · stop it: `, under a `base` of its own | calls `[['tail', '-f', log]]` |
    | `K4, K5, K10, K12 in the Windows form` | each built with `'win32'`. K5 goes through `offeredLine(['git', 'push', '-u', 'origin', \`main${p}\`], 'win32')` and `offeredLine(['git', 'checkout', '--', …], 'win32')`, since `resolveStartBase` takes no platform. | inert only, where the line exists |

    For `C1`, `run: gh pr merge` never holds a word a validated `pr` could not.
- [ ] **Step 2:** Run `pnpm vitest run tests/harness.test.ts tests/canon-guard.test.ts tests/needs-you.test.ts tests/quote.test.ts tests/paste.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the Interfaces. `watchLine`'s win32 branch keeps its bytes: `Get-Content`, its flags and `taskkill /PID <pid> /T /F` are bare under B2, and the path stays `psArg`'s.
- [ ] **Step 4: Changes by design:** none. Every existing handoff, watch, merge, push and adopt pin holds safe words.
- [ ] **Step 5:** Run `pnpm vitest run tests/harness.test.ts tests/canon-guard.test.ts tests/needs-you.test.ts tests/drive*.test.ts tests/start.test.ts tests/adopt.test.ts tests/next-home.test.ts tests/flows.test.ts tests/context-relay.test.ts tests/text-golden.test.ts tests/wait*.test.ts tests/quote.test.ts tests/paste.test.ts` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit: `fix(lines): other tools' commands and the handoff go through one renderer; the canon guard's twin (row 239)`.

### Task 8: Prose that names a command quotes its foreign words

**Files:**
- Modify the sites of inventory §5.3 and its help lines (B6), by B17's rule. The runnable commands named in prose become `cliAct(…).line`:
  - `src/ask.ts:121`, `src/decide-view.ts:124,136`, `src/drafts.ts:178`;
  - `src/gates/design.ts:42`, `src/gates/implement.ts:94`, `src/gates/plan.ts:92,100,101`, `src/gates/ship.ts:46`;
  - `src/needs-you.ts:188`, `src/ship.ts:217,229,240,255,410`, `src/stamp.ts:70`, `src/steps.ts:190,193`;
  - `src/verbs/check.ts:172,192,195,200,206,212,256`;
  - `src/verbs/decide.ts:349,390,411,421,584,635,656`;
  - `src/verbs/diff.ts:44,59`, `src/verbs/draft.ts:74`, `src/verbs/next.ts:387,1182`, `src/verbs/read.ts:78`, `src/verbs/write.ts:345`;
  - the ones built by `+` rather than a template: `src/gates/ship.ts:78`, `src/verbs/adopt.ts:110`, `src/verbs/start.ts:90`.
- The shapes quote their foreign words through `shellWord`:
  - `src/gate.ts:409`, `src/gates/decompose.ts:52`, `src/gates/design.ts:48` (new journals), `src/steps.ts:185`;
  - `src/verbs/check.ts:215,320`, `src/verbs/decide.ts:292,650,668`, `src/verbs/design.ts:90,103`, `src/verbs/draft.ts:38`;
  - `src/verbs/start.ts:155`, `src/verbs/trust.ts:57`, `src/verbs/write.ts:369`.
- Unchanged, since no foreign word is in a command: `verbs/adopt.ts:26` (a usage line, whose `<…>` names config dirs), `abandon.ts:443`, `cli.ts:195`, `config.ts:242,281`, `departure.ts:254`, `migration.ts:180`, `scan.ts:42`, `rename.ts:43`, `sync.ts:83,87`, `trust.ts:87`, `write.ts:357`, `check.ts:129,279,285`, `next.ts:675`, `gates/plan.ts:61,62`, and the constant help lines.
- Test: `tests/prose-quote.test.ts` (new).

**Interfaces:** none new. These sites consume `cliAct` and `shellWord`.

- [ ] **Step 1: Write the failing tests** in `tests/prose-quote.test.ts`: two argv-reachable sites, end to end, plus a static check. `steps.ts:190,193` echo only a real step id, which the schema already holds to `ID_RE` (`src/steps.ts:187-188`), so no argv reaches them.
  - `it('a refusal\'s want quotes the target the human typed (row 239)')`: `witness decide plan 'p1$(touch M1)' --approve` refuses, and its stderr holds `` `run: witness gate plan 'p1$(touch M1)'` ``.
  - `it('trust --yes without a terminal quotes the id')`: `witness trust 'p$(touch M1)' --yes` gives a want holding `` `witness trust 'p$(touch M1)' --cmd '<cmd>'` ``.
  - `it('no template under src/ interpolates a bare value into a witness command')`. This is a regression net. It scans each line of `src/**/*.ts` with two patterns, a template one and a concatenation one:

    ```
    /`[^`]*\bwitness [a-z][^`]*\$\{(?!shellWord\(|cliAct\(|quotedWord\()/
    /'[^']*\bwitness [a-z][^']*'\s*\+/
    ```

    It allows a fixed list of `[file, substring]` exceptions, each with a comment saying why it is not a command: for example, the trust prompt `witness wants to run: ${cmd}`, the drive report's summary `witness drive — ${…}`, `witness floor --set ${version()}`, and adopt's usage line. It fails on any other match.
- [ ] **Step 2:** Run `pnpm vitest run tests/prose-quote.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the sweep. Each edited line keeps its bytes for an `ID_RE` id.
- [ ] **Step 4: Changes by design:** none.
- [ ] **Step 5:** Run the full `pnpm test` and `pnpm typecheck`. Expected: PASS. This is the first full run since Task 1: every file the sweep touched is under test.
- [ ] **Step 6:** Commit: `fix(prose): every command a want or help names quotes its foreign words (row 239)`.

### Task 9: Defense in depth

**Files:**
- Modify:
  - `src/dsl.ts:3` (`ID_RE`) and the `[a-z0-9-]+` wants at `src/dsl.ts:32,81`, `src/schemas.ts:19,37,108`, `src/drafts.ts:128`, `src/verbs/recap.ts:35`, `src/verbs/write.ts:106`, and `src/verbs/rename.ts:47` (`ids match ^[a-z0-9-]+$`);
  - `src/schemas.ts:75` (the plan `pr` rule);
  - `src/pin.ts:45-53` (`checkPin`'s charset);
  - `src/settings.ts:39-52` (`Setting.pattern`), `:135` (`ship.branch`: pattern and want), `:282-284` (the fingerprint's comment);
  - `src/config.ts:148-149` (the `text` case honors `pattern`);
  - `src/journal.ts:158-160` (`effortStreams`), `src/ask.ts:41-46` (`askQueue`), `src/needs.ts:107-126` (`unmetNeeds`);
  - `src/verbs/next.ts` (`upstreamFor` :567-572, `parkedGates` :592-599, `owedDecisions` :736-741), `src/gates/plan.ts:136-139` (`upstreamOf`);
  - `src/verbs/check.ts:294-323` (the `stream-name` and `ask-id` findings);
  - `README.md:184` (the generated settings row);
  - `plugin/skills/witness-brainstorm/SKILL.md:120` and `plugin/skills/witness-decompose/SKILL.md:93` (the id set).
- Test: `tests/schemas.test.ts`, `tests/dsl.test.ts`, the pin and config tests (`tests/model*.test.ts`, `tests/config*.test.ts`), `tests/check.test.ts`, `tests/needs*.test.ts`, `tests/next*.test.ts`, `tests/paste.test.ts`.

**Interfaces:**
- `export const ID_RE = /^[a-z0-9][a-z0-9-]*$/`, and every want naming it reads `[a-z0-9][a-z0-9-]*`.
- The plan schema gains: `if (meta.pr !== undefined && !(typeof meta.pr === 'number' && Number.isInteger(meta.pr) && meta.pr > 0)) out.push(v('pr', 'shape', String(meta.pr), 'a positive integer — the PR number ship stamps'))`.
- `checkPin`, after the alias check: `if (!/^[A-Za-z0-9][A-Za-z0-9._:\/@\[\]-]*$/.test(raw)) return refuse([v(field, 'pin-charset', raw, 'letters, digits and . _ : / @ [ ] -, starting with a letter or digit — a pin is printed into commands a human pastes')])`.
- `Setting` gains `pattern?: RegExp`, which the fingerprint leaves out. `ship.branch` gets `pattern: BRANCH_RE` and the want `a branch name: letters, digits and . _ / + -, as git allows them — it is printed into git commands`. The constant:

  ```ts
  export const BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._\/+-]*(?<![./])$/
  ```

- `checkValue`'s `text` case: `typeof val === 'string' && val !== '' && (s.pattern?.test(val) ?? true) ? ok(val) : invalid()`.
- The skips are B15's.
- `check`'s journal loop, ahead of today's rules:
  - for a stream id failing `ID_RE`: `f('warn', 'journal', file, 'stream-name', 'a stream named outside [a-z0-9][a-z0-9-]* — witness never writes one and never offers it as a command')`, then `continue`;
  - in the `asks` stream, for each `ask` entry whose `id` fails `ID_RE`: `f('warn', 'journal', file, 'ask-id', \`ask ${visible(String(id))} is named outside [a-z0-9][a-z0-9-]* — never offered as a command\`)`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/schemas.test.ts`:
    - `it('an id may not start with - (row 239)')`: ids `-x` and `-` are refused with `id-charset`; `a-1` passes;
    - `it('a plan\'s pr is a positive integer (row 239)')`: `pr: 7` passes; `'7'`, `0`, `1.5` and `'9$(x)'` are refused as `pr:shape`.
  - `tests/pin.test.ts`, `it('a pin outside the printable set is refused (row 239)')`:
    - `checkPin('gates.plan.model', 'claude$(x)')` and `'a b'` are refused as `pin-charset`;
    - `m`, `claude-opus-5-5`, `anthropic/claude-x:high`, `google/gemini-3.6-pro:low`, `claude-x@20250514` and `claude-opus-4-6[1m]` pass.
  - `tests/harness.test.ts`, `it('a [1m] pin is quoted in the handoff (row 239)')`: `handoffLine(claude, '/wt', 'claude-opus-4-6[1m]', 'darwin')` === `"cd '/wt' && claude --model 'claude-opus-4-6[1m]' '/witness'"`. This needs Task 7's `handoffLine`, which lands first.
  - Config tests, `it('ship.branch outside git\'s safe names is refused at load (Review Focus 2)')`:
    - `main`, `release/1.2` and `feat/x+y` load;
    - `feature/#12`, `a b`, `-x`, `a..b`, `a/`, `x.lock` and `main$(touch${IFS}M7)` are each refused as `ship.branch,invalid` with the new want;
    - `witness check` lists the refusal as a `config` finding;
    - `fingerprint(1)` and `fingerprint(2)` are unchanged (`tests/settings.test.ts:57-64` still passes).
  - `tests/check.test.ts`, `it('a journal name outside the id set is reported, never offered (row 239)')`: a committed forged stream `e$(touch M1).jsonl` (a recap first) gives a `stream-name` warning, and `next` prints no line naming it. An `asks` entry `{ t: 'ask', id: 'a$(x)', … }` gives `ask-id`, and `next` routes no `--ask` for it.
  - `tests/needs.test.ts`, `it('a need or doc named outside the id set is never offered (row 239)')`:
    - hand-edited canon gives a need `id: 'n x'` and a plan id `P1`, and `unmetNeeds` lists neither;
    - `parkedGates` and `owedDecisions` skip `P1`;
    - a plan whose `parent` is `p$(x)` gets no `--upstream` option, in the block (`upstreamOf`) or in a parked plan's reopen (`upstreamFor`).
- [ ] **Step 2:** Run the test files above. Expected: FAIL.
- [ ] **Step 3:** Implement, then regenerate `README.md`'s settings block from `settingsTable()` (the message from `tests/settings-docs.test.ts` prints it).
- [ ] **Step 4: Changes by design.** Task 4's two forged-stream rows (`K3` in `tests/paste.test.ts`, and the comma test in `tests/next.test.ts`) now assert that the stream is never offered: no `next:` names it, and `check` warns `stream-name`.
- [ ] **Step 5:** Run the full `pnpm test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit: `fix(validate): ids, pins, ship.branch and pr hold only what a pasted line can carry; names outside the set are never offered (row 239)`.

### Task 10: Row 239, its residuals, and the Done gate

**Files:**
- Modify: `DESIGN.md` (row 239 after row 237, and the Open / deferred list).

- [ ] **Step 1:** Write row 239 in row 237's format (`| 239 ⊜ | <title> | <decision> | <evidence> |`). Rows 228–236 are reserved by the UI design and row 238 by the display rule, and the row says so.
  - **Title:** "A pasted command runs only what witness wrote".
  - **Decision.** It amends:
    - D120 — commands still print raw, now word by word through one quoter;
    - rows 139 and 203 — `Act.line` through the quoter, and `Act.withheld`;
    - D121 and D129 — the bare revise, and decide derives the prefill;
    - D143 — a nod is argv;
    - rows 171 and 173 — the policy takes acts;
    - rows 179 and 195 — the unmet-need kept stop;
    - rows 204 and 205 — `waiting:`, the trust kept stop and grant rows;
    - row 179 — `HeldRow.spec`;
    - row 193 — `Setting.pattern`;
    - rows 201 and 214 — Windows handoff and watch.

    It names B1–B18 by subject, in one sentence each.
  - **Evidence:**
    - `tests/paste.test.ts`: kinds K1–K8 and K10–K13, in every shell mode present, with the eight payloads, and the ref payloads for the push remedy. K9's status cells print K2's, K3's and K7's lines, so those rows cover them.
    - `tests/one-note.test.ts`.
    - Windows is REASONED, and its measured pass is a later row.
- [ ] **Step 2:** Add the residuals to Open / deferred, one bullet each:
  - **R1** — the measured Windows pass: PowerShell 5.1 and 7, npm's shims, Git Bash.
  - **R2** — `status` table cells (`reopen`, `next`, `satisfy`) are TOON cells: a quoted word holding `,` or `"` would be TOON-quoted. Unreachable while B15 holds.
  - **R3** — `help:` and `exits:` menus (`txn.ts:114`, `gate.ts:277`) pasted whole still form a pipeline of witness's own words. They are never a `run:`.
  - **R4** — the design gate's journaled `artifact` detail prints as stored: a placeholder shape, in a table cell.
  - **R5** — the win32 handoff's `$env:MAX_THINKING_TOKENS` outlives the pasted line in that PowerShell session.
  - **R6** — `resolveSpawn`'s cmd.exe quoting (n2).
  - **R7** — the risky-character refusal is conservative: it also refuses a word that PowerShell would double-quote.
  - **R8** — a choose block's `run:` names a spec id, not a command, as before this row.
  - **R9** — until row 238 (1a.8) spells line terminators in prose, a line break inside foreign text can still forge a physical line of its own. Examples: a manual need's text above its `  run:` lines, a park note in `waiting:`, a reviewer's anchor in an option's `why:`. Design n1 leaves spelling to row 238, whose B2 and floor (B3) close this; 1a.8 is built right after this patch.
- [ ] **Step 3:** Run the Done gate: typecheck, build, biome, the full `pnpm test` (read `Tests N passed`), and the scan over every file this branch touched: `git diff --name-only main...HEAD` plus the new files.
- [ ] **Step 4:** Commit: `docs: row 239 — a pasted command runs only what witness wrote`.

### Task 11: PR, release hand-off, and 1a.8's refresh

- [ ] **Step 1:** Push `shell-quote` and open a PR against `main` in PR #84's format: summary, What changes, Review, Verification. The Verification section gives the paste table's modes and counts.
- [ ] **Step 2:** After it merges, the user runs `pnpm release patch` (0.28.3).
- [ ] **Step 3:** In `/Users/home/x/personal/witness/.claude/worktrees/display-rule`, merge `main` and refresh the 1a.8 plan (`docs/superpowers/plans/2026-11-03-display-rule.md`) against this row's output:
  - **Task 3** spells a prefill that is journaled and shown in `why:`, never in a command.
  - **Task 5** spells each word, then quotes it with `shellWord`. A spelled word holds `\`, so it is quoted.
  - **R17's pin** (`tests/decide-view.test.ts:47-63`) now lists `['block.anchor', 'block.options.0.why']`.
  - **The Global Constraints' "exactly three existing tests change" line** follows that.
- [ ] **Step 4:** The roll-out to consumers (global skills, fewhats, HYC) is the user's call after the release, as for 0.28.2.
