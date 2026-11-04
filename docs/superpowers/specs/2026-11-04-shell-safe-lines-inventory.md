# Shell-quote inventory: every paste-ready line witness prints, and what a hostile value does in it

Read at `e4ce06b` (main, as checked out in `.claude/worktrees/display-rule`; `src/` equals main). Read-only on the
repo: nothing in it was edited, created or deleted. Every probe, stub and output is under
`/private/tmp/claude-501/-Users-home-x-personal-witness/41056634-59dd-4c1f-b13b-113cc0c71998/scratchpad/shell-quote/`
(called `SQ/` below). Shells: `/bin/bash` 3.2, `/bin/zsh` 5.9, `/bin/dash`. No PowerShell on this machine: every
PowerShell verdict is REASONED from its documented rules.

The invariant under test (the brief's): **no command line witness prints for a human or an agent to run can execute
anything that text witness did not write put into it**, in bash, zsh, dash and PowerShell.

---

## 0. How to read this

- **Verdict.** `EXEC` = a hostile value in that slot runs code when the line is pasted. `inert` = it does not.
  `VERIFIED` = the line was built by witness's own code (in process, or the CLI's `main` on a seeded repo) and pasted
  into `bash -c`, `zsh -f -c` and `dash -c` with stub `witness`/`git`/`gh`/`claude`/`pi`/`tail` on PATH, and the
  marker file appeared (or did not). `bash-i`/`zsh-i` = the line fed on stdin to an interactive shell, where history
  expansion (`!`) is on. `REASONED` = from the code and the shells' documented rules, not executed.
- **Payloads.** `P1` `$(touch PWNED1)`, `P2` `` `touch PWNED2` ``, `P3` `"; touch PWNED3; "`, `P4`
  `'; touch PWNED4; '` (the brief's), `P5` `;touch PWNED5;` (breaks a bare word without quotes or `$`), `P6`
  `!#;touch PWNED6;#` (history expansion; only interactive shells), and for `ship.branch` the space-free ref names
  git accepts: `B1` `main$(touch${IFS}PWNED1)`, `B2` `` main`touch${IFS}PWNED2` ``, `B5` `main;touch${IFS}PWNED5;`,
  `B7` `main$(touch${=IFS}PWNED7)` (zsh does not split `${IFS}`; `${=IFS}` it does).
- **Which payload bites where.** Inside `"…"`: P1, P2, P3 (and P6 interactively). Inside hand-rolled `'…'`: P4.
  In a bare word: P1, P2, P5 (P3/P4 are just quoted literals there). In a `|`-joined exits line P5 makes a syntax
  error (`; |`), so nothing runs; P1/P2 still do.
- **Sources.** `reviewer` = a reviewer model's verdict (the anchor must resolve, see §3.1); `canon` = spec/plan
  frontmatter a hand edit or a hostile commit can set; `journal` = `.witness/journal/*.jsonl`, committed files a
  hostile commit can forge (stream names, ask ids, journaled strings); `config` = committed `witness.config.yaml`;
  `local` = machine-local (checkout path, `.witness/` state, env); `argv` = the invoker's own arguments echoed back;
  `witness` = constants and witness-generated tokens.
- **Who runs it.** `skill` = a witness skill via the agent's Bash tool (non-interactive shell; no history
  expansion); `human` = pasted into an interactive terminal; `drive`/`settle`/`arbiter`/`UI` = in process, no shell.
  The skills run a chosen option's printed command byte-for-byte on a named option or a nod
  (`plugin/skills/*/SKILL.md:22-23`; `plugin/commands/witness.md:30-53,69`), run `next:` lines verbatim
  (`witness.md:53`), run a kept stop's `witness satisfy …`/`--cmd` grant (`witness.md:30,32`), run `launch:` and
  `wait:` (`witness.md:33-34`), and may run a refusal's "mechanical remedy" (`witness.md:53`).
- Evidence files: `SQ/out/lines.json` (every built line: site, source, payload, printed, pasted),
  `SQ/out/shells.tsv` (one row per line: markers per shell), `SQ/out/shells.json` (exit codes, stub argv),
  `SQ/out/extras.json` (in-process reader results, raw CLI outputs), `SQ/out/proto-shells.tsv` (§4 prototype).

---

## 1. Summary

**Counts by kind** (composition sites in `src/` and `plugin/hooks/`; the AST scan `SQ/scan/commands.mts` found 394
string literals that compose a command or carry a command prefix: 226 static, safe by construction, and 168 with
interpolation, classified below; plus 22 `cliAct(...)` call sites).

| Kind | Composition sites | Foreign text reaches it | Verdict (POSIX shells) |
|------|-------------------|-------------------------|------------------------|
| K1 decision block: option lines + `run:` (+ the skills' nod) | 1 renderer (`recommend.ts:39-57`), 6 printers; options from `cliAct` at `recommend.ts:127,146,182,198,224`, `recover.ts:27-36` | reviewer anchor (note prefill), canon parent (`--upstream`) | **EXEC, VERIFIED** (e2e) |
| K2 `exits:` / `help:` exits / reopen acts | `exitsLine` (`act.ts:59-66`) via `exitActs`/`reopenActs` (`rounds.ts:323-374`); 5 printers | reviewer anchor (below the bound), canon parent/target, journal effort slug | **EXEC, VERIFIED** |
| K3 `next:` (NextAction.line) | 27 interpolated templates in `verbs/next.ts` + 4 elsewhere | canon ids (guarded), journal effort slug / ask id (unguarded) | **EXEC, VERIFIED** (forged effort stream) |
| K4 `run:` handoff (`cd '<home>' && <launch> --model <pin> '/witness'`) | `harness.ts:413-416`, printed `next.ts:1331`, `needs-you.ts:119,180` | config model pin, local path | **EXEC, VERIFIED** (pin e2e; path in process) |
| K5 refusal `run:` remedies | `refusal.ts:46`; 2 remedies carry foreign text (`gitio.ts:239`, `gates/implement.ts:116`) | config `ship.branch`, `paths.designs` (+ canon parent) | **EXEC, VERIFIED** (branch e2e) |
| K6 `wait` / drive pause / drive report rows (`needYouRows`) | `needs-you.ts:148-191` (11 `run:`/`then:` lines) | canon need id, `pr`, parent; journal anchor (in `why`) | **EXEC, VERIFIED** (e2e) |
| K7 `kept-stop:` lines | `autonomy.ts:31-39`; printers `next.ts:1292,1305`, `settle.ts:101-104`, `drive.ts:911` | canon need id (satisfy), manual need text (forgery), config/canon command (`--cmd`, inert) | **EXEC, VERIFIED** (satisfy e2e) |
| K8 `waiting:` | `next.ts:1297-1300` | canon parent/target, reviewer anchor (forgery) | **EXEC, VERIFIED** (e2e) |
| K9 `status` table cells (parked `reopen`, flows `next`, needs `satisfy`) and `next:` | `dashboard.ts:279-280,314-336,340-344,386` | canon ids/parent/need id, journal effort slug | **EXEC, VERIFIED** (e2e) |
| K10 trust grants (`witness trust <id> --cmd '<cmd>'`) | `allowlist.ts:73-76` → `next.ts:1305`, `settle.ts:102`, `needs-you.ts:154`, `trust.ts:134` | config/canon command (shellArg'd), canon target (bare) | `--cmd` inert VERIFIED; target **EXEC, VERIFIED** (in process) |
| K11 `help:` lines naming a non-witness command | `verbs/adopt.ts:56,127` | argv path (a repo file name) | **EXEC, VERIFIED** (e2e) |
| K12 the canon guard hook's `run: witness adopt <rel>` | `plugin/hooks/canon-guard.mjs:221-233` | the agent's own tool-call path | **EXEC, VERIFIED** (in process) |
| K13 `watch:` / `launch:` / `wait:` / `relay:` | `drive-presence.ts:199-204`, `next.ts:1359,1372`, `harness.ts:421-423` | local path (shellArg/psArg), integer pid, hex token, constants | inert, VERIFIED |
| K14 install lines | `install.ts:204`, `version.ts:44` (`NPX_LATEST`) and 9 users | closed harness names only | inert (constants) |
| K15 in-process readers (drive `decide>`, settle, arbiter, UI) | `drive.ts:1303-1342`, `settle.ts:108-165`, `arbiter.ts:119-127` | the same lines, reparsed | no shell; VERIFIED (argv shown in `extras.json`) |
| K16 prose that names a command (want/detail/note/help text, journaled `held:`/check details) | 68 template sites (list in §5.3) | canon ids, argv, journal strings | REASONED; same bare-word exposure |
| K17 models (`Act.line`, `Option.command`, `DecideView.exits[].line`, `NeedYou` acts, `TrustListing.pending[].line`) | `act.ts:47-53` | as K1, K2, K6, K10 | same strings as printed; the UI runs `argv` (no shell) |

**The root cause** is one rule applied in two places and absent everywhere else: `act.ts:39-43` `word()` prints the
`--note` word in raw double quotes and every other word bare, and the 37 hand-composed paste-ready templates (K3,
K4, K5, K11, K12) and 68 prose templates (K16) interpolate bare. Only the `--cmd` word (`shellArg`) and the drive log path (`shellArg`/`psArg`)
are quoted, and those are inert in POSIX shells (VERIFIED).

---

## 2. The map: every paste-ready line

Columns: **Site** (where the line is composed → where it prints) · **Values** (each interpolated value · source) ·
**Quoting today** · **Runs it** · **Verdict** (POSIX / PowerShell).

### 2.1 Witness's own commands rendered by `cliAct` (`act.ts:47-53`, `word()` `:39-43`)

`word()`: the word after `--note` → `"${w}"` raw (D120); the word after `--cmd` → `shellArg(w)`; every other word
bare. `exitsLine` (`act.ts:59-66`) uses the same `words()`, dropping `witness decide <gate> <target>` from a segment
that repeats the previous one.

| # | Site | Values · source | Quoting today | Runs it | Verdict |
|---|------|-----------------|---------------|---------|---------|
| A1 | `rounds.ts:293-311` `notePrefill` → `recommend.ts:148` `note` act → `renderDecision` option line `recommend.ts:46` and `run:` `:55`. Printers: gate stop/resume/changed-nothing/bound (`gate.ts:277` via `renderGateRun` `:253`), `decide` bound refusal (`decide.ts:72`, stderr), `decide --show` (`decide-view.ts:153`), settle kept/left (`settle.ts:103,137`), ship stop (`ship.ts:456`), drive `decide>` (`drive.ts:1310-1319`) | `--note`: `<N> blocking finding(s): <anchor>[, …]` · **reviewer** (first 3 blocking anchors, cut at 120) or `failed checks: <names>` · witness; gate, target · canon id | `"…"` raw | **skill** on a named option or a nod (`+ --via affirmation`), human; drive/settle in process | **EXEC VERIFIED** P1/P2/P3 all three shells (`block-*`, e2e `e2e-gate-run-*`, `e2e-show-option-*`); P6 **EXEC bash-i** (VERIFIED), zsh-i rewrites the line (VERIFIED) and `!!` re-runs a history entry's `$(…)` (VERIFIED, §6.2). PS: EXEC (REASONED §6.1) |
| A2 | `recommend.ts:147` `up` act / `rounds.ts:327` → option `--revise --upstream <id>` | upstream · plan gate: `String(plan.meta.parent)` (`gates/plan.ts:136-139`) **canon**; design gate: `effortOf` · **journal**; decompose: the effort slug · **journal**; implement/ship: the plan id · canon | bare | skill on a named option, human | **EXEC VERIFIED** (e2e `e2e-show-upstream-*`: `decide plan … --show` prints `witness decide plan auth-refresh-plan-1 --revise --upstream auth-refresh$(touch PWNED1)`) |
| A3 | `rounds.ts:323-354` `exitActs` → `exitsLine` → `exits:` `decide-view.ts:125` (reopened), `:154` (no block), `decide.ts:73` (bound refusal), `help:` `gate.ts:278`, `ship.ts:457` | below the bound: the A1 note; at the bound: `--upstream` (A2), target · canon | note `"…"`, rest bare | human; skills "act on the `exits:` line" (`witness-design/SKILL.md:109`, `witness-decompose/SKILL.md:105`), reconstructing a segment | **EXEC VERIFIED** (`exits-*` P1-P3; `bound-exits-upstream-*` P1/P2) |
| A4 | `rounds.ts:368-374` `reopenActs` (`gate --fresh` below the bound, the endgame at it) → status `reopen` column `dashboard.ts:280`, wait parked `run:` `needs-you.ts:185`, `next` `waiting:` | target · canon id or effort slug; upstream · A2 | bare | human; skill on request | **EXEC VERIFIED** (`reopen-target-*` P1/P2/P5; e2e `e2e-status-reopen-*`, `e2e-wait-*`, `e2e-next-waiting-*` P1/P2) |
| A5 | `recommend.ts:127` trust twin `cliAct(...argv, '--trust-cmds')`; `:182` abandon; `:198,224` re-gate; `rounds.ts:344,351-352,373` | target · canon id | bare | skill on a named option | as A4 (the target word) |
| A6 | `allowlist.ts:73-76` `grantAct`/`grantOf` → `kept-stop: trust grant — <shownCmd> · <grant>` (`next.ts:1305`, `settle.ts:102`), wait `run:` (`needs-you.ts:154`), `trust <id>` listing `run:` (`trust.ts:134`), `TrustListing.pending` (`allowlist.ts:170`) | `--cmd`: a config command (`criteria.runner`, `ship.test`, `ship.lint`) or a spec `cmd:` criterion / `cmd:` need · **config/canon**, printable ASCII only (`hasControl` → no act); target · canon id | `--cmd` `shellArg` (`toon.ts:3`); target bare | **skill** runs the grant after the `·` byte-for-byte when the human names the command (`witness.md:30,45`) | `--cmd` **inert VERIFIED** P1-P5 (`trust-grant-cmd-*`); target **EXEC VERIFIED** (`trust-grant-target-*`). PS: `--cmd` **EXEC REASONED** for a command holding `'` (`'\''` breaks out, §6.1) |
| A7 | `needs.ts:64-66` `satisfyCommand` (`cliAct('satisfy', doc, '--need', ref)`) → wait `run:` `needs-you.ts:173`, status needs `satisfy` cell `dashboard.ts:341`, `unmetNeedLine` `autonomy.ts:37-39` (`next.ts:1292` chat notice, `drive.ts:911` set-aside), `held:` rows (`criteria.ts:157`, journaled, printed `gate-run-view.ts:105`), check detail `criteria.ts:79` | doc · canon id; ref · the need's `id` (**canon**; validated only as a violation, `dsl.ts` `validateNeeds`) else its 1-based index · witness | bare | **skill** runs the satisfy after the `·` on "done" (`witness.md:32`); human | **EXEC VERIFIED** (`satisfy-need-*`; e2e `e2e-wait-*`, `e2e-status-needs-*`, `e2e-next-keptstop-*` P1/P2/P5) |
| A8 | `needs-you.ts:87` design look `run:`/`then:` (`:165`), `:93` trust list `run:` (`:150`), `:103` decision `run:` (`:176`), `:140` retry `run:` (`:189`) | target · canon id or a live-folder aside whose target must equal a canon id or effort (`live.ts:88-108`) | bare | human; skill | as A4 (target word); not separately probed |
| A9 | `verbs/recover.ts:27-36` recover options → `next:` (`next.ts:827,831`), wait `run:` (`needs-you.ts:163`) | none | constants | skill | inert |

### 2.2 Witness's own commands hand-composed as paste-ready lines (no renderer)

| # | Site | Values · source | Quoting | Runs it | Verdict |
|---|------|-----------------|---------|---------|---------|
| B1 | `NextAction.line` templates in `verbs/next.ts`: `:223`, `:234-235`, `:244-249` (test-evidence, verify-red, step-close: plan id, step id), `:347,351,929,938` (`--effort <slug>`), `:395` (`witness trust <target>`), `:429,430,456,510,521` (start/ship/test-evidence/gate implement: plan id), `:799` (write: plan id, owner effort), `:889` (`witness decide <gate> <target> --show`), `:906` (`--ask <id>`), `:972,977,983,986` (design: spec id), `:1053` (gate plan), `:1078,1082` (start) → printed `next.ts:1309` (`kv('next', …)`), status flows cell `dashboard.ts:329`, `next:` `dashboard.ts:386`, drive's `action.line` lines (`drive.ts:739,764,770,778,855,860,1072,1318,1340`) | canon ids (guarded by `next.ts:833` on the ladder only); **effort slug = a journal stream name** (`journal.ts:158-160`); **ask id = the journal's `ask` entry** (`ask.ts:41-43`); step ids · canon | bare (`kv` TOON-quotes the whole value if it holds `,` `"` or LF) | **skill** runs `next:` verbatim (`witness.md:53`); stage skills compose from `target:` | **EXEC VERIFIED**: forged effort stream → `next: witness write <spec-id> --effort e$(touch PWNED1) --meta m.json --body b.md` runs the substitution in all three shells even though `<spec-id>` fails the command (`e2e-stream-effort-*`); hostile plan id in the status flows cell (`e2e-status-flows-*`). Ask id: composition VERIFIED (`SQ/out/streams.json`), execution REASONED (same shape) |
| B2 | `settle.ts:47` `leftLine` (`autonomy: left for a human — <why> · witness decide <gate> <target> --show`), `:101` (`kept-stop: design look — … witness decide design <target> --show`), `:112` (`autonomy: re-run owed — <policy.command>`, parsed back `next.ts:1234`) | gate · witness; target · canon/journal (from `owedDecisions`, no canon guard, `settle.ts:195`); `why` may carry a config pin (`settle.ts:142`) | bare | skill (reads), human | REASONED EXEC for a hostile target (same bare word) |
| B3 | `autonomy.ts:87,93` re-run `witness gate <gate> <target>` → B2 `:112` → `next:` via `routed` (`next.ts:1267-1270`) | target · canon/journal | bare | skill | REASONED (as B1) |
| B4 | `drive.ts:896` aside line `witness decide <gate> <target> --show`; `drive.ts:741` `help: … witness retry <target>` | target · canon/journal | bare | human | REASONED |
| B5 | `verbs/design.ts:139,183` `next: witness gate design <id>`; `verbs/recap.ts:160` (`--effort <slug>`, ID_RE-validated); `verbs/init.ts:229`, `verbs/write.ts:300` (constants) | spec id · argv matched to canon | bare | skill | REASONED (id must equal a canon id) |
| B6 | `help:` naming witness commands: `ship.ts:410` (`edit the code in <wt> · then re-run witness ship <id>`), `verbs/decide.ts:635,656,668`, `verbs/start.ts:155`, `drive.ts:1073`, `txn.ts:114`, `cli.ts:136`, `decide-view.ts:139`, `dashboard.ts:387`, `index-verb.ts:43`, `drift.ts:273`, `drive-report.ts:66` | ids · canon/argv, or none | bare | human | ids only; REASONED |

### 2.3 Other tools' commands (no renderer except `watchLine`)

| # | Site | Values · source | Quoting | Runs it | Verdict |
|---|------|-----------------|---------|---------|---------|
| C1 | `needs-you.ts:183` `run: gh pr merge <pr>` (built `:121-122`: `prOf(aside.line)` = digits, else `String(meta.pr)`) → wait, drive pause/report, `next` `waiting:` | `pr` · **canon** frontmatter (never validated: `schemas.ts` has no `pr` rule; `stampPr` writes a number) | bare | **human** (the merge is the human's) | **EXEC VERIFIED** (e2e `e2e-merge-*` P1/P2/P5; `merge-pr-*`) |
| C2 | `gitio.ts:237-239` remedy `git push -u origin <branch>` (only when the fetch says "couldn't find remote ref") → `refusal.ts:46` `run:` (`start.ts:51-52`, its one caller) | `ship.branch` · **config** (`settings.ts:135`, shape `text`: any non-empty string) | bare | human; skill as a "mechanical remedy" (`witness.md:53`) | **EXEC VERIFIED** e2e `witness start`: B1/B2/B5 bash+dash, B7 zsh (`e2e-start-push-*`) |
| C3 | `gates/implement.ts:112-117` remedy `git checkout -- <paths.designs>/<parent>.html` (`design.ts:503-505` `designRel`) → `refusal.ts:46` | `paths.designs` · **config** (shape `dir`: `relPath` refuses absolute, `.`/`..`, `.witness/` and nothing else); parent · canon | bare | human; skill | **EXEC VERIFIED** in process (`remedy-checkout-*` P1/P2/P5); the loader accepts the value (`SQ/out/extras.json` `config-P*`) |
| C4 | `harness.ts:413-416` `handoffLine` = `cd '<home>' && <MAX_THINKING_TOKENS=n >?<launch><modelArg> '/witness'` (`modelArg` `:406-409` over `modelFlags` `:384-394`) → `next.ts:1331` `kv('run', …)`, `needs-you.ts:119` → wait `run:` `:180` | model · **config** `gates.implement.model` (`next.ts:424-427`; `checkPin`/`parsePin` `pin.ts:24-53` check grammar and aliases, not characters); home · **local** (worktree under the root, or the root); launch · witness (closed registry) | model bare; home hand-rolled `'…'` with no escaping | **human** (the skill prints it verbatim, `witness.md:46`) | **EXEC VERIFIED**: pin e2e `witness next` → `run: cd '…/worktrees/auth-refresh-plan-1' && claude --model claude-opus-5$(touch PWNED1) '/witness'` (P1/P2/P5, `e2e-next-handoff-*`), pi in process (`handoff-pin-pi-*`); home P4 (`handoff-home-*-P4`). `kv` TOON-quotes the value when the path holds `,` or `"` (VERIFIED, `SQ/scan/kv.mts`) |
| C5 | `verbs/adopt.ts:56` `help: fix the file and re-run, or revert instead: git checkout HEAD -- <rel>`; `:127` want `git checkout <sha> -- <rel>` | `rel` · **argv** (the agent passes a repo file name, which a hostile commit chose) | bare | human; skill | **EXEC VERIFIED** e2e `witness adopt 'specs/a$(touch PWNED1).md'` (`e2e-adopt-help-*` P1/P2/P5) |
| C6 | `plugin/hooks/canon-guard.mjs:221-233` block reason `remedy: witness write <id> … · already hand-edited? run: witness adopt <rel>` (to the agent, on a blocked Write/Edit/Bash) | `rel`, `id` · the agent's own tool-call path (a repo file name); canon dirs · config (regex-read) | bare | **skill/agent** (handed as `run:`) | **EXEC VERIFIED** in process `canonGuard()` (`guard-*` P1/P2/P5) |
| C7 | `drive-presence.ts:199-204` `watchLine`: `tail -f <shellArg(log)> · stop it: kill <pid>`; win32 `Get-Content -LiteralPath <psArg(log)> … · stop it: taskkill /PID <pid> /T /F` → `next.ts:1359`, `verbs/drive.ts:88` | log · derived `join(root, '.witness/drive.log')` (never read from the lock file, `:76-81`) · local; pid · validated integer | `shellArg` / `psArg` | human | **inert VERIFIED** POSIX (`watch-*`); win32 psArg REASONED inert in PS |
| C8 | `install.ts:204` `CONTEXT_INSTALL`; `version.ts:44` `NPX_LATEST` in `install.ts:95`, `cli.ts:194`, `next.ts:1369`, `check.ts:51-52,381,399,422,445` | harness name · closed `HARNESSES` | constants | human | inert |

### 2.4 Composite lines (several commands, or a command beside foreign prose)

| # | Site | What can be forged | Runs it | Verdict |
|---|------|--------------------|---------|---------|
| D1 | `autonomy.ts:37-39` `unmetNeedLine` = `kept-stop: unmet need — <texts> · <satisfy commands>` (`next.ts:1292`, `drive.ts:911`) | a manual need text (spec prose) holding ` · witness satisfy <doc> --need 1 $(…)` puts a second, fake command before the real one | skill: "run the `witness satisfy …` text printed after its `·`" | **EXEC VERIFIED** if the first `witness satisfy` is taken (`unmet-forged-first-*`); the last segment is inert (`-last-*`). Agent-dependent |
| D2 | `next.ts:1297-1300` `waiting: <row> · run: <reopen>` from `needYouRows`; a parked `why` = `parked at <anchor>` (`needs-you.ts:130`) | a reviewer anchor holding ` · run: witness … $(…)` puts a fake `run:` before the real one | skill on request | **EXEC VERIFIED** if the first `run:` is taken (`waiting-forged-*`); real one inert (`waiting-real-*`) |
| D3 | `gate-run-view.ts:105` `held: <criterion> — <need> unmet · <satisfy>` and checks detail `criteria.ts:79` | `satisfy` is a **journaled string** (`GateCheck.held[].satisfy`), printed as stored; a forged journal line prints any text | human | REASONED EXEC |
| D4 | `decide.ts:650` `obligation: <id> — <anchor> · … witness dismiss <target> … --note "<why>"`; `drive-report.ts:46` | the anchor sits beside a placeholder command | human | not runnable (`<…>`); prose |

---

## 3. Validation that guards values

### 3.1 What a reviewer anchor must be

`verdict.ts:37-38` accepts any non-blank string; `verdictViolations` (`verdict.ts:273-330`) then requires it to
resolve (`resolveAnchor`, `:228-271`): a code anchor names a file in the reviewed tree (`resolveCodeAnchor`,
`:176-202`) and an optional `#symbol` that must match `\b<symbol>\b` in that file; a doc anchor is
`<doc-id> > ## Heading` matching a heading in a reviewed doc; a design anchor is `design#<element id>`; an omission
names a path. So the payload rides in **a file name in the diff** (`src/$(touch PWNED1).ts`), **a heading**
(VERIFIED: a plan body heading `## Notes $(touch PWNED1)` passed `witness write` and a real `witness gate plan`
with a fake reviewer, `e2e-gate-run-*`), **an element id**, or **a symbol present in a reviewed file** (a comment
holding `x$(touch P)y`). No prompt injection is needed: an honest reviewer blocking on a hostile file name is enough.

### 3.2 Ids: who checks them, and which printers skip the check

`ID_RE` `/^[a-z0-9-]+$/` (`dsl.ts:3`) is shell-safe. It is enforced by `write`, `adopt`, `recap`, `rename`
(`write.ts:106`, `schemas.ts:18-19`, `recap.ts:34`, `rename.ts:46`) and flagged by `check`; `computeNext` routes
nothing while canon has a violation (`next.ts:833-835`). **What bypasses it:**

1. Printers that iterate canon without that check (VERIFIED with hand-edited canon, `SQ/out/extras.json`
   `canon-P*`): `witness wait` (`wait.ts:42-55` → `needsYou` `needs-you.ts:70-143`: `unmetNeeds`, `owedDecisions`,
   `parkedGates` all read every doc), `witness status` (`dashboard.ts:279-344`: parked, flows via `flowAction` with
   no guard, needs), `witness next` in an autonomy chat above the routing block (`needNotices` `next.ts:1158-1164`, printed `:1292`,
   and `waiting:` `:1296-1300`, both printed before `computeNext` answers `witness check`), drive's pause and report
   (`drive.ts:1003-1004`, `drive-report.ts:38-43`), `decide --show` (the view's `upstreamOf` reads `meta.parent`),
   settle's lines (`settleOwed` → `owedDecisions`, `settle.ts:195`), the trust listing (target = argv matched to a
   canon id). Also `next --flow <id>` and the ambient worktree flow call `flowAction` without the guard
   (`next.ts:1249-1263`; REASONED).
2. Values that are not ids and have no charset rule: a need's `id` (flagged by `validateNeeds` but used by
   `unmetNeeds` and `heldCriteria` regardless), a plan's `parent` (flagged, but `gates/plan.ts:136-139` and
   `parkedGates` `next.ts:596` read it raw), **`pr`** (no rule anywhere; `needs-you.ts:121-122` stringifies it;
   `stamp.ts:66` and `wait.ts:83` at least `Number()` it), and the plan `id` itself once hand-edited.
3. **Journal-derived names, which no canon check sees**: an effort slug is any `.witness/journal/<name>.jsonl` whose
   first entry is a recap (`journal.ts:150-160`; `liveEfforts` `next.ts:293-298`); an ask id is whatever the `asks`
   stream's entry says (`ask.ts:41-43`); live-folder asides are kept only when their target equals a canon id or an
   effort (`live.ts:88-108`), which inherits both problems. VERIFIED: a committed forged stream reaches `next:`,
   `target:`, `ask:` and the status efforts table with the canon clean (`SQ/out/streams.json`).

### 3.3 Config values that reach a paste-ready line unvalidated

| Setting | Shape (`settings.ts`) | Check | Reaches | Verdict |
|---------|-----------------------|-------|---------|---------|
| `ship.branch` | `text` (`:135`) | non-empty string | C2 `run: git push -u origin <branch>` | **EXEC VERIFIED** (git accepts `$`, `(`, `)`, `` ` ``, `;`, `{`, `}`, `=` in a ref name; no space) |
| `paths.designs` | `dir` (`:100`) | `relPath` (`config.ts:120-130`) | C3 `run: git checkout -- <designs>/<id>.html` | **EXEC VERIFIED** (loader accepts `designs$(touch PWNED1)`) |
| `gates.<gate>.model`, `arbiter.model` | `pin` (`:59`) | `checkPin` = grammar `[provider/]model[:thinking]` + alias refusal (`pin.ts:24-53`) | C4 handoff `--model <pin>` (implement's pin), `agent-model:` prose (`start.ts:80,150`) | **EXEC VERIFIED** (loader and `stagePin` accept `claude-opus-5$(touch PWNED1)`) |
| `harness` | `text` (`:93`) | resolved against the closed registry (`harness.ts:275-281`) before any line | handoff/relay print `harness.launch`/`harness.relay` constants; `judgeLine` prints the raw value in prose (`harness.ts:362`) | inert for lines |
| `ship.test`, `ship.lint`, `criteria.runner` | `text`/`runner` | trust + printable-ASCII for a grant | A6 `--cmd` (shellArg) | inert in POSIX; PS REASONED EXEC for `'` (§6.1) |
| `notify`, `opener`, `reviewerExtensions` (local) | local config | argv spawns | not printed as commands | n/a |

---

## 4. Parsers of those lines, and what each needs

The prototype `SQ/proto.probe.mts` renders real `cliAct` argv under the brief's grammar — **(a)** the `--note` word
keeps `"…"` when its text holds none of `$`, `` ` ``, `\`, `"` or `!` (and, for PowerShell, U+201C U+201D U+201E), else
POSIX single quotes with `'\''`; **(b)** any other word outside shellArg's bare set (or starting with `=`) is
single-quoted — then reads the lines back with today's parsers (`SQ/out/proto.json`) and pastes them
(`SQ/proto.py` → `SQ/out/proto-shells.tsv`):

- **Shells: inert and exact.** Every prototype line, P1-P6 notes and hostile ids (`p$(touch PWNED1)`,
  `p'; touch PWNED4; '`, `über plan`, empty), is inert **and** delivers `act.argv` byte for byte to a witness stub
  in bash, zsh, dash, interactive bash and interactive zsh (also under zsh `setopt RC_QUOTES`). Today's lines run
  P1/P2/P3 (P6 in bash-i) and mangle `a "b", c`, `p'…'`, `über plan` and the empty id.
- **Readers: two break silently.** Results per parser:

| Parser | Where | Reads | Today with a hostile note | Under (a) | Under (b) | Needs | Act-based alternative |
|--------|-------|-------|---------------------------|-----------|-----------|-------|-----------------------|
| `actOfCommand` | `verbs/decide.ts:142-149`; callers `settle.ts:109` (`policy.command`), `:150` (`chosen.command`) | `/^witness decide (.*)$/`, greedy trailing `/ --note "(.*)"$/`, the rest `split(/\s+/)` | round-trips (in process, no shell); LF/CR/U+2028/U+2029 refuse `not-a-decision` (prior Q2) | **silently journals the wrong note**: a single-quoted note gives `note = "'1"` (PROBED, `proto.json` `settleProto`), not a refusal | a quoted target/upstream splits into garbage words | a ` --note '((?:[^']\|'\\'')*)'$` branch with `'\''` → `'`, and a POSIX-subset tokenizer for the rest | **delete it**: `policyFor` (`autonomy.ts:64-103`) returns the option's `act` (every block option has one; its two re-run arms become `cliAct('gate', gate, target)`), `menuFor` already returns `Option`s carrying `act`; settle does `act.argv[0] === 'decide' ? decisionAct(act.argv.slice(1)) : routed(act.line)`. Its only other users are `decide.test.ts:567-570`; `Policy`'s `{ kind: 'take', command }` shape is pinned by `autonomy.test.ts:72-147` |
| `splitArgv` | `drive.ts:1274-1290`; block commands `:1333`, typed `witness …` answers `:1247`, **and `WITNESS_BIN` on Windows `:1146`** | toggles on `"`, splits on unquoted space, no escapes | P3 splits the note into extra positionals (`extras.json` `readers-P3`) | single-quoted note splits on spaces, quotes kept: note `"'1"` (PROBED) | quoted ids split | POSIX single quotes + `'\''` — but **not** for `WITNESS_BIN`, a Windows command line where `'` is literal (`C:\Users\O'Brien\…`): split the two uses | drive builds the block from `decideView(...)` (`decide-view.ts:53-106`) and prints `decideViewLines(view)` (byte-identical to `decide --show`), choosing `view.block.options[i].act.argv`; `step.block` (recover/choose, `drive.ts:44,79-80`) carries the `Decision`, not lines. Only the human's typed `witness …` answer still needs a tokenizer |
| `parseBlock` | `drive.ts:1210-1224` | `^(\d+) · (.+)$` then the next line trimmed, starting `witness ` | fine | fine | fine | nothing (a raw line terminator breaks it: display rule) | unnecessary with the view's acts |
| `selectOption` / `byVerb` / `nodExcluded` | `drive.ts:1229-1271` | substring tests `--<verb>`, `--override`/`--stop`/`--trust-cmds`; the nod appends ` --via affirmation` to the line | a note holding `--stop`/`--override` makes the recommended revise "nod-excluded", `--approve` makes `approve` ambiguous (pre-existing) | unchanged | unchanged | nothing for quoting | `act.argv.includes(flag)`; nod = `[...argv, '--via', 'affirmation']` |
| `menuFor` + `PLACEHOLDER` | `arbiter.ts:119-127`, `recommend.ts:84` | `startsWith('witness decide ')`, `/ --trust-cmds\b/`, `PLACEHOLDER.test(line.replace(' --note "<why>"', ''))`, `/ --approve\b/` | PROBED: an anchor holding ` --approve`, ` --trust-cmds` or `<effort>` drops the note option from the arbiter's menu (`extras.json` `menu …`) | `"<why>"` keeps its double quotes, so the literal replace still works; a single-quoted note holding those strings still mis-filters | unchanged | nothing if `<why>` stays `"<why>"`; the literal `' --note "<why>"'` must follow any change to how `<why>` prints | `o.act?.argv[0] === 'decide'`, `!o.act.argv.includes('--trust-cmds')`, `o.act.inputs.every((i) => i.name === 'why')`, `!(approveBarred && o.act.argv.includes('--approve'))` |
| `recommendedVerb` | `verbs/decide.ts:448` | `command.match(/--(approve\|revise\|stop)/)` | fine (the decision flag precedes the note) | fine | fine | nothing | `act.argv` |
| `classifyAction` | `drive.ts:62-69` | `line.split(' ')` for gate/target of `witness decide …` | fine for ids | fine | a quoted target splits wrong | use `action.target` | NextAction carrying an act |
| re-run owed | `settle.ts:112` built, parsed `next.ts:1234` (and drive's `routed`) | strips `autonomy: re-run owed — ` from `Settled.line` | fine | fine | fine | nothing | `Settled.routed` carries the act |
| aside regexes | `needs-you.ts:68` `prOf` `/PR #(\d+)/`, `:113` `/ --ask (\S+)/` over `Aside.line` | digits; `\S+` | fine | fine | a quoted ask id captures its quotes | carry `ask`/`pr` as fields of the aside | — |
| `trustOwed`, next/drive prefix tests | `allowlist.ts` `trustOwed` regex; `next.ts:536,1097-1099,1116-1117,1127,1148-1149,1267,1348-1349` | `startsWith('witness decide ')` etc. | fine | fine | fine | nothing | — |
| Pi add-on core | `plugin/hooks/context-core.mjs:249-262` (`WAIT_LINE` `^wait: witness wait --since ([0-9a-f]{12})$`, `ADD_ON`), `:273` (`^next: `), `:331` (`^relay: ` and no `^run: `) | prefixes and a hex token; it builds its own argv (`waitArgv` `:294`) | fine | fine | fine | nothing | — |
| refusal readers | `settle.ts:41-44` `refusedRule`, `caps.ts:83` | the rule column | fine | fine | fine | nothing | — |
| **tests** | see below | | | | | | |

**Tests that parse or pin printed lines.** Most pins hold notes with no shell-active character and survive (a)
unchanged (`recommend.test.ts` ×20, `exits-line.test.ts:39-40,68,172-174`, `text-golden.test.ts:208,222,249`,
`autonomy.test.ts:72-147`, `arbiter.test.ts:39`). They change under (a): `act.test.ts:8-9` (`a "b", c`),
`recommend.test.ts:990` (`"x"`), `decide-view.test.ts:54` (`REVIEWER_ANCHOR` once the display rule spells it to
`\x1b…`: a backslash is active under a conservative set; inside `"…"` a backslash before `x` is in fact inert, so
the plan can choose to treat `\` as active only before `$`, `` ` ``, `"`, `\` or a newline), `decide.test.ts:567`
(a hand-written double-quoted input, still valid if `actOfCommand` keeps its `"…"` branch). They change under (b):
`act.test.ts:28` (`--upstream <why>` is not a slot, so it is quoted), `:31-34` (`über plan`, `Auth Refresh`,
`prod access`, the empty need), `trust.test.ts:353-355` (ruling R15's raw target), and any handoff pin if C4 moves
to a quoting renderer (`harness.test.ts:127-140,338-350`, `context-relay.test.ts:333`, `flows.test.ts:226`,
`next-home.test.ts:70`, `text-golden.test.ts:76,80,138`). Unchanged: `--cmd` pins (`act.test.ts:12,23`,
`trust.test.ts:79,166,270`, `text-golden.test.ts:54,333-348`, `drive.test.ts:1632`, `trust-preflight.test.ts:38,89`,
`autonomy-gate.test.ts:108-109`), numeric `gh pr merge` (`text-golden.test.ts:84,88`, `drive.test.ts:1457,1468`),
`git push`/`git checkout` with safe values (`start.test.ts:92`, `adopt.test.ts:88,130`), watch lines
(`drive.test.ts:1159-1168`), prefix regexes (`next-wait.test.ts:6`, `next-scope.test.ts`, `autonomy-next.test.ts:66`,
`recommend.test.ts:346`, `start.test.ts:79`, `context-relay.test.ts:240`, `autonomy-gate.test.ts:63,109`,
`decide-show.test.ts:111`). No test exercises `splitArgv`, `parseBlock` or `selectOption` directly; drive's
`decide>` is covered end to end at `drive.test.ts:615,664`.

---

## 5. One choke point

### 5.1 Recommendation

1. **Witness's own commands: `act.ts:39-43` `word()` is the choke point, and every witness command becomes an Act.**
   Make `word()` emit every word inert by construction: bare only for shellArg's set (`toon.ts:3`, minus a leading
   `=` for zsh's EQUALS expansion, VERIFIED `shellarg-equals`), else quoted. `exitsLine` already uses `words()`.
   Then convert every hand-composed witness command (§5.2 B-list) to `cliAct`: `NextAction.line` →
   `NextAction.act` with `line` derived (the B1 templates), settle's and autonomy's re-runs (B2, B3), drive's aside
   line (B4), `next:` in design/recap (B5), the `help:` commands (B6), and, where they are offered as commands,
   the refusal wants and check findings (§5.3). Print command values with `cmd()`, never `kv()`: `next.ts:1309`
   (`next:`), `:1331` (`run:`), `:1332`, `slice.ts:190`, `dispatch.ts:85` (`relay:`), where `esc` TOON-quotes a
   value holding `,` or `"` into one unrunnable word (VERIFIED `SQ/scan/kv.mts`; D120's defect class).
2. **The `--note` word.** Either quote it like any other word (simplest; churns the pins listed in §4), or keep (a)
   with the active set `$`, `` ` ``, `\`, `"`, `!` plus U+201C U+201D U+201E. `!` is not optional: in an interactive bash
   the double-quoted note `…!#;touch PWNED6;#…` runs code (VERIFIED), and in zsh `!!` re-runs a history entry's
   substitution (VERIFIED). The deeper fix removes the foreign text from the line altogether: the note prefill is
   "an index of the anchoring run" (`rounds.ts:287-292`) that exists only to make the revise runnable; `decide`
   accepts a revise with no `--note` (`decide.ts:124,448`), so the verb could derive the same prefill itself
   (`notePrefill(entries, gate)`, the run it disposes of) and the block print `witness decide <gate> <target>
   --revise`, with the anchors in the option's (spelled) `why:`. Then no reviewer text is ever on a paste-ready
   line, and all four readers journal one note by construction. Trade-off: a bare `--revise` typed by a human would
   journal the prefill instead of no note.
3. **Other tools' commands: one argv → line renderer** beside `shellArg`/`psArg` in `toon.ts` (say
   `shellLine(argv, platform)`), used by C1 (`['gh','pr','merge',pr]`), C2 (`['git','push','-u','origin',branch]`),
   C3, C5 (`['git','checkout',…,'--',path]`), C4 (two argvs joined by ` && `, with the `MAX_THINKING_TOKENS=<n>`
   assignment a witness-written word), C7 (already per-word; fold in), and a copy in
   `plugin/hooks/canon-guard.mjs` (C6), which ships standalone into user repos and cannot import `src/`.
4. **Platform.** No single quoting form is both exact in POSIX and inert in PowerShell for a word holding a single
   quote (§6.1). The renderer should follow `watchLine`'s precedent (`drive-presence.ts:199-204`): POSIX form off
   win32, `psArg` form on win32. The `psArg` form is inert in POSIX shells too (VERIFIED `SQ/psform.py`: bash, zsh,
   dash, bash-i, zsh-i), only lossy there (`'` dropped, smart single quotes doubled); so a line printed on Windows
   and run by Git Bash cannot execute either, though a `--cmd` grant would then name different bytes and refuse
   `unknown-command` (fail-safe).
5. **Defense in depth, not the fix:** validate `pr` as a positive integer where it is read (`needs-you.ts:122`
   should use `Number`, as `stamp.ts:66`/`wait.ts:83` do); give model pins a charset (`[A-Za-z0-9._:/-]`),
   `ship.branch` git's ref-format rules or a stricter set, `paths.*` a path charset; have `unmetNeeds`,
   `parkedGates`, `owedDecisions` and `effortStreams` skip names that fail `ID_RE`. Re-derive journaled command
   strings at print time from their structured fields (`HeldRow.satisfy` from `{spec, need}`), since a renderer fix
   cannot reach journals already written.

### 5.2 Every site that composes a paste-ready line outside `cliAct` today

- **Witness commands (B):** `verbs/next.ts:223,234,235,244,245,247,249,347,351,395,429,430,456,510,521,799,
  889,906,929,938,972,977,983,986,1053,1078,1082` (and constants `:366,371,379,388,795,834,909,913,1088,1251`);
  `settle.ts:47,101,112`; `autonomy.ts:87,93`; `drive.ts:741,896`; `verbs/design.ts:139,183`; `verbs/recap.ts:160`;
  `verbs/init.ts:229`; `verbs/write.ts:300`; `verbs/dashboard.ts:386` (prints `computeNext().line`);
  `ship.ts:410`; `verbs/decide.ts:635,656,668`; `verbs/start.ts:155`.
- **Other tools (C):** `needs-you.ts:183`; `gitio.ts:239`; `gates/implement.ts:116`; `verbs/adopt.ts:56,127`;
  `harness.ts:415`; `drive-presence.ts:202-203` (quotes per word already); `install.ts:204`; `version.ts:44` users;
  `plugin/hooks/canon-guard.mjs:226,231-232`.
- **Composite (D):** `autonomy.ts:32,38`; `verbs/next.ts:1299,1305`; `gate-run-view.ts:105`; `criteria.ts:79`;
  `verbs/decide.ts:650`; `drive-report.ts:46`.
- **Printed through `kv`/`rows` (TOON-quoting a command value):** `verbs/next.ts:1309,1331,1332`;
  `slice.ts:190`; `verbs/dispatch.ts:85`; `verbs/dashboard.ts:279-280,336,344`.

### 5.3 Prose that names a command (want, detail, note, help text)

Interpolated, ids or argv, bare: `abandon.ts:443`; `ask.ts:121`; `cli.ts:195`; `config.ts:242,281`;
`decide-view.ts:124,136`; `departure.ts:254`; `drafts.ts:178`; `gate.ts:409`; `gates/decompose.ts:52`;
`gates/design.ts:42,48`; `gates/implement.ts:94`; `gates/plan.ts:61,62,92,100,101`; `gates/ship.ts:46`;
`migration.ts:180`; `needs-you.ts:188`; `scan.ts:42`; `ship.ts:160,217,229,240,255`; `stamp.ts:70`;
`steps.ts:185,190,193`; `verbs/check.ts:129,172,192,195,200,206,212,215,256,279,285,320`; `verbs/decide.ts:292,349,
390,411,421,584`; `verbs/design.ts:90,103`; `verbs/diff.ts:44,59`; `verbs/draft.ts:38,74`; `verbs/next.ts:387,675,
1182`; `verbs/read.ts:78`; `verbs/rename.ts:43`; `verbs/sync.ts:83,87`; `verbs/trust.ts:57,87`;
`verbs/write.ts:345,357,369`. Several are labelled `run:` inside a refusal's `want` (`decide.ts:349,390,411,421,584`,
`gates/*.ts`, `verbs/design.ts:103`, `write.ts:369`, `next.ts:366,385`), which a skill may treat as a mechanical
remedy; they print through `esc`, which TOON-quotes a want holding `,` or `"`. Static ones (226) carry no foreign
text.

---

## 6. PowerShell, and interactive POSIX shells

### 6.1 PowerShell (REASONED; no PowerShell here)

Rules used: double quotes expand `$var` and run `$(…)`, backtick is the escape character, `""` is a literal quote,
and U+201C, U+201D, U+201E act as double quotes; single quotes expand nothing, `''` is a literal quote, and U+2018,
U+2019, U+201A, U+201B act as single quotes; in argument mode a bare word containing `$(…)` is expanded (the
subexpression runs), `;` ends a statement, `|`, `&`, `>` are operators, a leading `@`/`(`/`,` changes meaning;
PowerShell parses the whole input before running any of it, so a parse error runs nothing.

| Form | Where | In PowerShell |
|------|-------|---------------|
| `--note "…"` (A1, A3) | every block | **EXEC**: `$(…)` runs (P1 with a cmdlet, e.g. `$(New-Item PWNED)`); `"` ends the string (P3); a smart double quote ends it too (`”; New-Item PWNED; “`), which POSIX shells treat as a literal character; a trailing backtick escapes the closing quote |
| bare words (A2, A4-A8, B, C1-C3, C5, C6, pins in C4) | ids, upstream, need ref, pr, branch, paths, pin | **EXEC** for `$(…)` and `;` (P1, P5); P3/P4 are quoted literals as in POSIX |
| `shellArg` `'…'\''…'` (A6 `--cmd`; C7 off win32) | trust grants | **EXEC** for a command holding `'`: `'npm test '\''; New-Item X; '\'''` is `'npm test '`, `\` + `''`, then an unquoted `;` and `New-Item X` runs. Smart single quotes would break out the same way, but `hasControl` keeps them off grants |
| `psArg` (C7 on win32) | the watch line | inert |
| hand-rolled `cd '<home>' && …` (C4) | handoff | a `'` in the path breaks out (as in POSIX); `&&` is a parse error in Windows PowerShell 5.1 (nothing runs) and works in PowerShell 7 |
| TOON `"…"` from `kv`/`rows` | `next:`/`run:` values or table cells holding `,`/`"` | an expandable string: `$(…)` inside runs if pasted |

Who pastes into PowerShell: a human on Windows (witness already renders the watch line for it). The agents' Bash
tools on Windows run bash (Git Bash) for Claude Code; what Pi's tool runs on Windows was not checked. cmd.exe (not
asked): `"` toggles quoting and `&`, `|` run commands outside it, `%VAR%` expands inside it, so P3-style breakouts
apply there as well (not probed).

### 6.2 History expansion (interactive bash and zsh only)

- bash 3.2 interactive (`bash -i`, histexpand on by default): `witness … --note "1 blocking finding: src/!#;touch
  PWNED6;#.ts"` → `!#` inserts the line typed so far, which carries the opening `"`; the quote balance flips, `;`
  runs `touch PWNED6`, `#` comments out the closing quote. **EXEC VERIFIED** (`block-*-P6`, `proto-shells.tsv`).
- zsh 5.9 interactive: the same line expands but stays unbalanced (no `interactive_comments`), so nothing runs
  (VERIFIED `no-run`); but `!!` (or any event designator) splices a history entry into the double-quoted note and
  its `$(…)` runs: `echo 'x $(touch PWNEDH)'` then `echo "note !! end"` created `PWNEDH` (VERIFIED,
  `SQ/hist/`).
- Single quotes stop both (VERIFIED: `'a!#;touch …;# !! end'` inert in bash-i and zsh-i). The agents' Bash tools are
  non-interactive (no history expansion); human pastes are interactive.

---

## 7. Probe evidence

Run from `SQ/` with `WITNESS_REGISTRY=off` and the session variables unset:
`npx --prefix <worktree> vitest run --config probe.config.mjs <probe>` then `python3 -I shells.py` (or `proto.py`,
`psform.py`). Stubs: `SQ/stubs/bin/*` record `[argv]` to `$STUBLOG`; `SQ/stubs/argv/witness` writes NUL-separated
argv to `$ARGVLOG`.

| Probe | What it builds | Result |
|-------|----------------|--------|
| `lines.probe.mts` test 1 (in process) | A1, A3, A4, A6, A7, C1, C3, C4, C7, C5-style remedies, D1, D2, the nod, readers, menu, zsh `=` | 181 lines; `shells.tsv` |
| `lines.probe.mts` e2e 1 | a real `witness gate plan` + `decide --show`, fake reviewer blocking on a heading holding the payload | `run:` and option lines EXEC P1-P3 |
| `lines.probe.mts` e2e 2 | hand-edited canon (need id, parent at the bound, plan id, `pr`), autonomy on: `status`, `wait --since 000000000000`, `next`, `needsYou` with a merge aside | every `run:`/cell/kept-stop/waiting line EXEC P1/P2 (P5 where bare) |
| `lines.probe.mts` e2e 3-4 | config loader on hostile `ship.branch`, `paths.designs`, `gates.implement.model`; `witness next` handoff on a started plan | all accepted; handoff EXEC P1/P2/P5 |
| `branch.probe.mts` | `witness start` with an origin lacking a hostile `ship.branch`; `witness adopt` with a hostile path | push remedy EXEC (B1/B2/B5 bash+dash, B7 zsh); adopt `help:` EXEC P1/P2/P5 |
| `streams.probe.mts` | forged effort stream and ask entry, clean canon | `next:`, `target:`, `ask:`, status show them raw; `next:` EXEC P1/P2/P5 |
| `upstream.probe.mts` | `decide plan --show` with a hand-edited parent | `--upstream` option EXEC P1/P2/P5 |
| `guard.probe.mts` | `canonGuard()` on Write and Bash calls naming a hostile path | `run: witness adopt …` EXEC P1/P2/P5 |
| `proto.probe.mts` + `proto.py` | §4 prototype grammar | inert and exact in all five shell modes; `actOfCommand`/`splitArgv` journal `'1` |
| `psform.py` | psArg-style quoting pasted into POSIX shells | inert in all five modes, lossy for `'` |
| `scan/commands.mts`, `scan/remedies.mts` | AST scan of `src/` for command strings and 5-argument `v(...)` | 394 / 6 |
| `scan/kv.mts` | `kv('run', handoffLine(...))` with `,`, `"`, `'` in the path | TOON-quoted (unrunnable) / unbalanced |

---

## 8. Not checked

- PowerShell and cmd.exe were not run (none here); every PowerShell verdict is REASONED. Pi's tool shell on
  Windows is unknown.
- Not probed end to end, composition read from code only: A8's targets, B2-B6 with hostile ids, D3 (journaled
  `held:` strings), the ask-id `next:` execution (composition VERIFIED), C3 through a real implement gate (the
  remedy line was built by `renderRefusal` + `designRel` in process), `next --flow`/ambient flow without the canon
  guard, the trust listing with a hostile canon id.
- The desktop UI that consumes `Act.argv` is not in this repo; "runs argv, never line" is taken from `act.ts:15`
  and the 1a.1 design.
- `resolveSpawn`'s cmd.exe quoting (`spawn.ts:72-106`, argv to `.cmd` shims on Windows, which carries model pins)
  is a spawn, not a printed line; it was not reviewed.
- zsh options other than the defaults and `RC_QUOTES` (e.g. `SH_WORD_SPLIT`, `KSH_ARRAYS`) were not tried on the
  prototype.
- Side effect outside `SQ/`: the seeded repos come from `tests/helpers.ts` `tmpRepo()` (`mkdtempSync(tmpdir())`), as
  the suite's own do, so about 79 `witness-*` directories (and `-origin.git` bare remotes, `witness-fake-*`
  scenarios) were created under the OS temp dir (`/var/folders/_6/…/T/`) from 23:45 on. They were not removed
  (other sessions' test runs write the same names there).
