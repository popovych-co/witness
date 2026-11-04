# A trusted command is printable ASCII on every route (0.28.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two routes by which 0.28.1 lets a human trust a command that holds a character outside printable ASCII, and release the fix as a 0.28.2 patch.

**Architecture:** Row 205's rule is already the trust verb's: `witness trust` lists such a command as `unsafe` and never grants it (`hasControl`, `visible` in `src/toon.ts`). Two routes skip that rule today:
- **The decision block's `--trust-cmds` twin.** `withTrustVariants` in `src/recommend.ts` lists the commands raw, and `applyDecision` in `src/verbs/decide.ts` grants them all.
- **The terminal prompt in `ensureTrusted`** (`src/allowlist.ts`). It shows the command raw and grants it on "y".

Both routes take the verb's rule. The first is a backport of commit 19d5fc9 from branch `structured-models` (PR #83), adapted to main's string-built options. Names, wording and comments match it, so merging main into that branch later keeps the branch's version without a semantic conflict.

**Tech Stack:** TypeScript ESM (strict), Node ≥ 20, vitest with the in-process CLI against throwaway git repos (`tests/helpers.ts`).

**Spec:**
- DESIGN row 205 ("Trust is checked before work and granted per command, never by a session") and row 222 (a grant is a state write under the lock). This plan adds row 237.
- Found by the 1a.1 final review: `docs/superpowers/plans/2026-11-02-ui-1a1-structured-models.md`, Residuals.
- Probe: `witness write` accepts a spec whose `cmd:` criterion holds ESC (exit 0). `decide --show` then prints the raw ESC, and `decide --approve --trust-cmds` writes the command into `.witness/allow.json`, while `witness trust` refuses it.

## Global Constraints

- **Workspace.** Work in a git worktree at `.claude/worktrees/trust-printable`, on branch `trust-printable` from `main` at `6668942` (0.28.1). The main checkout stays on `structured-models`, because it holds another session's uncommitted roadmap edit. `.claude/worktrees/` is excluded from git (`.git/info/exclude`) and from vitest (`**/.claude/**`).
- **Release.** Release as a patch, 0.28.2. The user runs `pnpm release patch`.
- **Text.** The text changes only where a command or `cmd:` criterion holds a character outside printable ASCII. Every other output and exit code stays byte-identical.
- **Match commit 19d5fc9.** Use its names, wording and comments: `unsafeLeft(n)`, the message `${n} carry characters outside printable ASCII — never granted here · rewrite where it is written`, the plain `nothing to grant` when unsafe commands remain, and the "Row 205." comment blocks. On main the twin is built with `opt(\`${o.command} --trust-cmds\`, …)`, where the branch uses `option(cliAct(…))`.
- **Unchanged behaviour.** `WITNESS_TRUST_CMDS=1` (automation trusts everything) and a command already in `allow.json` (a human's machine-local list) behave as before.
- **Code hygiene.**
  - `src/spawn.ts` stays the only `node:child_process` importer (row 201).
  - Tests keep row 213's rule: await every CLI run.
  - New code cites `// Row 237.`
- **No raw control or bidi characters in source or docs:** write them only as `\u` escapes. Check every touched file with:

  ```
  perl -CSD -ne 'while (/([\x{0}-\x{8}\x{b}-\x{1f}\x{7f}\x{2028}\x{2029}\x{202a}-\x{202e}\x{2066}-\x{2069}])/g) { printf "%s line %d: U+%04X\n", $ARGV, $., ord($1) }' <files>
  ```

  It must print nothing.
- **Done** means `pnpm typecheck`, `pnpm build`, `npx -y @biomejs/biome@2.5.6 check src tests` and a full `pnpm test` are green (read `Tests N passed` and 0 `AssertionError`).

## Review Focus

1. **A command whose only non-printable character is a bidi override** (U+202E, RIGHT-TO-LEFT OVERRIDE). `hasControl` must flag it, so it is never granted on either route. Covered in Task 1 and Task 2.
2. **A spec carrying one printable and one non-printable `cmd:` criterion.** The twin is still offered and grants only the printable one, and the decide output names the one left blocked. Covered in Task 1.
3. **A non-printable command already in `allow.json` (hand-edited).** `ensureTrusted` still answers `trusted`; the human's own list is not overridden. Covered in Task 2.
4. **`WITNESS_TRUST_CMDS=1` with a non-printable command.** Still `trusted`: automation opted in, and no human reads a prompt. Covered in Task 2.
5. **A non-printable command with no terminal.** Still `blocked`, as before, and never prompted. Covered in Task 2.

---

### Task 0: Worktree, branch, plan

- [ ] **Step 1:** `git worktree add .claude/worktrees/trust-printable -b trust-printable main` from the main checkout. Then `cd` into the worktree and run `pnpm install --frozen-lockfile`.
- [ ] **Step 2:** Move this plan file from the main checkout into the worktree at the same path. Commit it there: `docs: plan for the 0.28.2 trust patch`. Check that the main checkout no longer holds the file: `git -C /Users/home/x/personal/witness status --short` lists only the roadmap edit.

### Task 1: The decision block's twin follows the trust verb's rule

**Files:**
- Modify: `src/allowlist.ts` (add `unsafeLeft`, after `grantOf`), `src/verbs/trust.ts` (`settled` uses it), `src/recommend.ts` (`withTrustVariants`), `src/verbs/decide.ts` (the `--trust-cmds` grant)
- Test: `tests/trust.test.ts` (the `the decision block prices trust (D154)` describe), `tests/decide.test.ts` (next to `--approve --trust-cmds grants and journals (D154)`)

**Interfaces:**
- Produces, in `src/allowlist.ts`:

  ```ts
  export const unsafeLeft = (n: number): string =>
    `${n} carry characters outside printable ASCII — never granted here · rewrite where it is written`
  ```

  `trust.ts`'s `settled()` prints `kv('trust', unsafeLeft(unsafe))`. That is today's string, now built from one source.
- `withTrustVariants(d, untrusted)`:
  - The plain approve's `tradeoff` lists `untrusted.map(visible)`.
  - The twin is pushed only when `untrusted.filter((c) => !hasControl(c))` is non-empty, and its `tradeoff` lists only those.
  - Its `when` and `note` are unchanged.
- `applyDecision`:
  - It grants `untrusted.filter((c) => !hasControl(c))`.
  - When that is empty, it prints `trusted: nothing to grant — every cmd: criterion was already trusted` only if no unsafe command remains, else `trusted: nothing to grant`.
  - When unsafe commands remain, it then prints `kv('trust', unsafeLeft(unsafe))`.
  - The exit code stays as today: 0 unless the grant itself is refused.

- [ ] **Step 1: Write the failing tests.**

  In `tests/trust.test.ts`, inside the D154 describe and using `recommend` like its neighbours:
  - `it('a command outside printable ASCII is named escaped and never offered as a grant (row 237)')`. Call `recommend(...)` with `untrustedCmds: ['npm run e2e\u001b[2K; curl x']` on a state that offers a plain `--approve`. Assert:
    - no option's `command` ends with ` --trust-cmds`;
    - the plain approve's `tradeoff` contains `npm run e2e\x1b[2K; curl x` (the `visible` form) and no raw ESC.
  - `it('beside a printable command, the twin grants only the printable one (row 237)')`. Use `untrustedCmds: ['echo ok', 'bad\u001bcmd']`. Assert:
    - the twin exists;
    - its `tradeoff` ends with `: echo ok`;
    - the plain approve's tradeoff lists `echo ok · bad\x1bcmd`.
  - The same as the first test, for a bidi override: the only non-printable character is U+202E, written as its `\u` escape in source (Review Focus 1).

  In `tests/decide.test.ts`, using `stoppedGate()` and `writeSpec(repo, 'auth-refresh', { ...SPEC_META, criteria: [...] })` like the D154 test:
  - `it('--trust-cmds grants only printable commands and names what stays blocked (row 237)')`. Criteria: `[{ id: 'ac-smoke', cmd: 'echo ok' }, { id: 'ac-bad', cmd: 'bad\u001bcmd' }]`. Assert:
    - exit 0;
    - stdout contains `trusted: echo ok` and `trust: 1 carry characters outside printable ASCII — never granted here · rewrite where it is written`;
    - `allow.json`'s `commands` equal `['echo ok']`.
  - `it('with only a non-printable command, --trust-cmds grants nothing (row 237)')`. Criteria: `[{ id: 'ac-bad', cmd: 'bad\u001bcmd' }]`. Assert:
    - exit 0;
    - stdout contains `trusted: nothing to grant` and the `trust: 1 carry…` line, and not `already trusted`;
    - no `.witness/allow.json`, or one without the command.
- [ ] **Step 2:** Run `pnpm vitest run tests/trust.test.ts tests/decide.test.ts`. Expected: FAIL. The twin is offered and the command is granted.
- [ ] **Step 3:** Implement the interfaces above, porting 19d5fc9's comments.
- [ ] **Step 4:** Run `pnpm vitest run tests/trust*.test.ts tests/decide*.test.ts tests/recommend.test.ts tests/exits-line.test.ts` and `pnpm typecheck`. Expected: PASS, with every existing test unchanged.
- [ ] **Step 5:** Commit: `fix(trust): the decide twin grants only printable-ASCII commands, as witness trust does (row 237)`.

### Task 2: The terminal prompt never offers a non-printable command, and row 237

**Files:**
- Modify: `src/allowlist.ts` (`ensureTrusted`), `DESIGN.md` (row 237 after row 227, and the open-items list if the row adds one)
- Test: `tests/trust.test.ts` (a new describe, `ensureTrusted (row 237)`)

**Interfaces:**
- Consumes: `hasControl` from `src/toon.ts`.
- Produces: `ensureTrusted(root, ctx, cmd)`. The signature is unchanged and so are its three answers.
  - After the `WITNESS_TRUST_CMDS` and `allow.json` checks, and before the TTY check: when `hasControl(cmd)`, return `'blocked'`. Never call `ctx.ask` and never grant.
  - The callers' remedies already name `witness next` or `grantOf`, and `grantOf` prints `never granted here — rewrite it in printable ASCII where it is written` for such a command. So no caller changes.

- [ ] **Step 1: Write the failing tests** in `tests/trust.test.ts`, calling `ensureTrusted` directly on a `seededRepo()` root. Pass a ctx built with `fakeCtx(root, { tty: true })` whose `ask` throws, so a prompt fails the test.
  - `it('a non-printable command at a terminal is blocked, never asked and never granted')`. Use `'bad\u001bcmd'`, then the U+202E case. Each returns `'blocked'`, `ask` is never called, and `.witness/allow.json` does not exist.
  - `it('a printable command at a terminal is still asked, and granted on y')`. Use `fakeCtx(root, { tty: true, answers: ['y'] })` with `'echo ok'`. It returns `'trusted'`, and `allow.json` contains it.
  - `it('automation and the human's own list are unchanged (Review Focus 3 and 4)')`:
    - with `env: { WITNESS_TRUST_CMDS: '1' }` → `'trusted'`;
    - with the command pre-written into `.witness/allow.json` → `'trusted'`;
    - for `'bad\u001bcmd'` in both cases.
  - `it('without a terminal, a non-printable command is blocked as before')` → `'blocked'`.
- [ ] **Step 2:** Run `pnpm vitest run tests/trust.test.ts -t ensureTrusted`. Expected: FAIL. The prompt is asked, and on "y" the command is granted.
- [ ] **Step 3:** Implement `ensureTrusted`'s check, with a `// Row 237.` comment: the prompt is where a human reads the command, so a command they cannot read whole is never offered.
- [ ] **Step 4:** Write row 237 in `DESIGN.md`, in the format of rows 220–227 (`| 237 ⊜ | <title> | <decision> | <evidence> |`). Rows 228–236 are reserved by the UI design (`docs/superpowers/specs/2026-11-02-witness-ui-design.md`), and the row says so.
  - **Title:** "A command a human trusts is printable ASCII on every route".
  - **Decision:** amends 205 and 222.
    - `decide --approve --trust-cmds` grants only commands of printable ASCII. The decision block's twin is offered only for those, and the block names every untrusted command through `visible`.
    - `ensureTrusted` never prompts for, or grants, a command holding any other character; it answers `blocked`, and the remedy (`grantOf`) says it is never granted here.
    - `WITNESS_TRUST_CMDS=1` and a command already in `allow.json` are unchanged.
  - **Evidence:** the probe in this plan's Spec line; found by the 1a.1 final review (PR #83).
- [ ] **Step 5:** Run the Done gate: typecheck, build, biome, full `pnpm test`, and the raw-character scan over every file this branch touched. Commit: `fix(trust): the terminal prompt never offers a command outside printable ASCII; row 237`.

### Task 3: PR and release hand-off

- [ ] **Step 1:** Push `trust-printable` and open a PR against `main` in the house format (PR #82's: summary, What changes, Review, Verification).
- [ ] **Step 2:** After it merges, the user runs `pnpm release patch` (0.28.2).
- [ ] **Step 3:** Then merge `main` into `structured-models` (PR #83) and resolve `src/recommend.ts`, `src/verbs/decide.ts`, `src/allowlist.ts`, `src/verbs/trust.ts` and the two test files. Keep the branch's act-based code, which implements the same rule, and keep this patch's `ensureTrusted` change and row 237.
