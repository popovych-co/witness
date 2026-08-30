# Triage Wave 3 — `witness drive` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `witness drive` (D145): the CLI schedules headless agent sessions through every green-path step, and the human appears only at judgment stops — the root fix for the 989-turn approval treadmill.

**Architecture:** Drive is a foreground TTY loop in the CLI: derive the next action in-process (the same `computeNext`/`flowAction` the dashboard already reuses), classify it, and either spawn a fresh headless agent session in the action's home, render a decision block in the driver's own terminal, or yield. No new state anywhere — position derives from frontmatter + journal (north star 2), and every existing bound/budget predicate binds the children unchanged. Amends D82: the spawner changes, the fresh-context economics and never-Task-subagents doctrine stay.

**Tech Stack:** TypeScript (Node `child_process.spawn` with line-buffered piping), vitest with a fake agent binary behind an env seam (the calibration fixture pattern: `fakeBinDir()`/`gateEnv` in `tests/helpers.ts`).

**Spec:** `docs/superpowers/specs/2026-08-29-pi-sessions-triage-design.md`, row D145 — plus the Design addendum below, which settles what D145 explicitly deferred.

## Design addendum (extends D145 — REVIEW THIS SECTION BEFORE EXECUTING)

The spec deferred verb surface, streaming, and timeout policy to a follow-up design pass; the user asked for the plan now, so these decisions are made here, each with its reason, and they are part of what plan approval approves:

1. **Verb surface:** `witness drive [--flow <plan-id>] [--max-spawns <n>]`. `--flow` claims one flow (refuses when false — `next`'s existing semantics); default drives the global ladder. `--max-spawns` defaults **20** per invocation — a per-run ceiling, held in memory only, because drive must hold no state (north star 2).
2. **TTY-only.** `drive` refuses on `!ctx.isTTY` (`drive-needs-tty`) — it is a human's foreground verb; an agent must not run it, and this also makes drive-inside-drive structurally impossible.
3. **Spawn command:** the **declared** harness (`harness:` in config), detection ladder as fallback — drive is a programmatic spawn surface like the reviewer battery, not a "which CLI are you typing at" session line. claude-code: `claude -p '/witness' --dangerously-skip-permissions`, cwd = the action's home (the calibration worker's exact shape, `src/harness.ts:144`); pi: the pi headless form from the same module. Model: the stage's pin when one exists (`stagePin`, as `start` already surfaces for implement), else the harness session default.
4. **Streaming:** child stdout+stderr are line-buffered and re-printed prefixed `[<spawnN> <stage>/<target>] ` — raw text, no JSON mode; drive is a terminal for a human, and the child's own output is the progress report.
5. **Timeout:** new config key `drive.sessionTimeoutMs`, default **3600000** (1h — an implement slice is ~25 min at budget 3; generous beats a starved e2e run, the failure grill #9 measured). On expiry: SIGTERM the child, print `spawn-timeout`, stop the loop with findings.
6. **Stop taxonomy** (spec D145's set, made operational): after each child exits, drive re-derives the action and classifies: **decision** (a pending decision anywhere in the action → render the block in drive's TTY and ask); **conversation** (stage is brainstorm, or the action is design authoring/`--open` — print the handoff line and exit 0; a chat session owns those); **merge** (ship printed "merge PR on GitHub" — exit 0 with that line); **no-progress** (same action line twice with no journal growth → exit 1); **idle** (nothing to do → exit 0); else **spawn**.
7. **Decisions in the TTY honor D143 verbatim** — same rule, different surface (the spec's surface-independence clause): a bare affirmation at drive's prompt selects the recommended option and records `--via affirmation`; excluded acts (override, stop, trust, abandon) require typing the option; the typed/affirmed command executes in-process through the CLI dispatcher.
8. **Test seam:** `WITNESS_DRIVE_AGENT_BIN` env overrides the spawned binary — tests point it at a scripted fake that performs real CLI acts (write/evidence/gate with the fixture reviewer) and exits; the seam is test-only and documented beside `WITNESS_TRUST_CMDS` in the code, never in user docs.
9. **Drive journals nothing.** Children journal their own acts through the CLI they call; drive is pure orchestration, so a crashed drive leaves zero cleanup and `witness drive` re-run converges (north star 6).

## Global Constraints

- Requires waves 1–2 merged and released (`0.15.0`); drive releases as **`0.16.0`** (T7).
- New files only, plus registry/config touch: no changes to gate outcomes, `next` derivation, or journal semantics — drive consumes them.
- `pnpm test && pnpm run typecheck && pnpm run build` green after every task.
- Commits conventional with `(D145)`.

---

### Task 1: Verb skeleton, config key, TTY refusal

**Files:**
- Create: `src/verbs/drive.ts`
- Modify: `src/cli.ts` (verb registry + usage table), `src/config.ts` (drive.sessionTimeoutMs, default 3600000 — mirror `implement.stepsPerDispatch`'s shape at `config.ts:107-120`)
- Test: `tests/drive.test.ts` (create)

**Interfaces:**
- Produces: `run(ctx, argv)` for `drive`; `Config.drive: { sessionTimeoutMs: number }`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { seededRepo } from './helpers.js'

describe('witness drive skeleton (D145)', () => {
  it('refuses without a TTY', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['drive'])            // repo.cli runs non-TTY
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('drive-needs-tty')
  })
  it('config accepts drive.sessionTimeoutMs and defaults it', async () => {
    const { loadConfig } = await import('../src/config.js')
    const repo = await seededRepo()
    const cfg = loadConfig(repo.root)
    expect(cfg.ok && cfg.value.drive.sessionTimeoutMs).toBe(3600000)
  })
})
```

- [ ] **Step 2: Verify failure** (`unknown verb`, missing config field).

- [ ] **Step 3: Implement**

`src/verbs/drive.ts`:

```ts
import { EXIT, type Ctx } from '../cli.js'
import { primaryRoot } from '../gitio.js'
import { renderRefusal, v } from '../refusal.js'

// D145. Drive is a human's foreground verb: TTY-only, which is also what makes
// drive-inside-drive structurally impossible (an agent's Bash has no TTY).
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  if (!ctx.isTTY) {
    renderRefusal([v('tty', 'drive-needs-tty', 'non-interactive session',
      'run witness drive in your own terminal — agents are what drive spawns, never what spawns drive')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  ctx.out('drive: nothing to do')   // replaced by the loop in Task 4
  return EXIT.OK
}
```

`src/config.ts`: a `drive` block parsed exactly like `implement` (default `{ sessionTimeoutMs: 3600000 }`, integer > 0 refused otherwise). `src/cli.ts`: register `drive` in the verb map and one usage line: `drive — schedule green-path work through headless sessions; you appear at judgment stops`.

- [ ] **Step 4: Verify pass.** — [ ] **Step 5: Commit** — `feat(drive): verb skeleton, TTY refusal, session timeout config (D145)`

---

### Task 2: The action classifier (pure)

**Files:**
- Create: `src/drive.ts`
- Test: `tests/drive.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export type DriveStep =
    | { kind: 'spawn'; home: string; stage?: string; target?: string; model?: string }
    | { kind: 'decision'; gate: string; target: string }
    | { kind: 'conversation'; line: string }
    | { kind: 'merge'; line: string }
    | { kind: 'idle' }
  export function classifyAction(action: NextAction, root: string): DriveStep
  ```
  Pure over the `NextAction` shape `next` already produces (`line`, `stage`, `target`, `home`, `note`, `block`). Rules, first match: line starts with `witness decide ` → decision (parse gate+target from the line's tokens); stage is `brainstorm`, or line contains `witness recap` or `witness design ` with `--open`/`--file` → conversation; line/note contains `merge PR` → merge; line is `witness check` with no stage and no pending anything → idle; else spawn with `home: action.home ?? root`.
- Consumes: `NextAction` (export the type from `src/verbs/next.ts` if not already exported).

- [ ] **Step 1: Failing unit tests** — one `expect` per taxonomy branch:

```ts
import { classifyAction } from '../src/drive.js'

describe('classifyAction (D145 addendum §6)', () => {
  const root = '/repo'
  it('routes each action shape', () => {
    expect(classifyAction({ line: 'witness decide ship p1 --show', target: 'p1' }, root)).toEqual({ kind: 'decision', gate: 'ship', target: 'p1' })
    expect(classifyAction({ line: 'witness recap --file recap.json', stage: 'brainstorm' }, root).kind).toBe('conversation')
    expect(classifyAction({ line: 'witness design auth-refresh --open', stage: 'design' }, root).kind).toBe('conversation')
    expect(classifyAction({ line: 'ship: merge PR #4 on GitHub when ready' }, root).kind).toBe('merge')
    expect(classifyAction({ line: 'witness gate implement p1', stage: 'implement', target: 'p1', home: '/repo/.witness/worktrees/p1' }, root)).toEqual({ kind: 'spawn', home: '/repo/.witness/worktrees/p1', stage: 'implement', target: 'p1', model: undefined })
    expect(classifyAction({ line: 'witness check' }, root).kind).toBe('idle')
  })
})
```

- [ ] **Step 2: Verify failure.** — [ ] **Step 3: Implement** `classifyAction` exactly to the rules above (ordered `if` chain, ~25 lines, no I/O). — [ ] **Step 4: Verify pass.** — [ ] **Step 5: Commit** — `feat(drive): pure action classifier (D145)`

---

### Task 3: Headless session spawn with streaming and timeout

**Files:**
- Modify: `src/harness.ts` (exported `sessionSpawnCmd(harness, model): { cmd: string; args: string[] }` — factor from the calibration worker's builder at ~130-144), `src/drive.ts`
- Test: `tests/drive.test.ts` (extend, using the fake-bin seam)

**Interfaces:**
- Produces: `spawnSession(step, root, cfg, ctx, spawnN): Promise<'exited' | 'timeout' | 'spawn-failed'>` in `src/drive.ts` — resolves the declared harness (fallback: detection ladder), builds the command via `sessionSpawnCmd`, overrides the binary with `ctx.env.WITNESS_DRIVE_AGENT_BIN` when set (test seam), spawns with `cwd: step.home`, line-buffers stdout+stderr through `ctx.out` prefixed `[<spawnN> <stage>/<target>] `, SIGTERMs at `cfg.drive.sessionTimeoutMs`.

- [ ] **Step 1: Failing test**

```ts
  it('spawns the fake agent in the action home, streams prefixed lines, times out a hung child', async () => {
    const repo = await seededRepo()
    // fake agent: prints two lines, exits 0
    const bin = join(fakeBinDir(), 'fake-agent')
    writeFileSync(bin, '#!/bin/sh\necho one\necho two\n', { mode: 0o755 })
    const lines: string[] = []
    const res = await spawnSession(
      { kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' },
      repo.root, cfgOf(repo), { ...fakeCtx(repo.root, {}), out: (l: string) => lines.push(l), env: { WITNESS_DRIVE_AGENT_BIN: bin } } as never, 1)
    expect(res).toBe('exited')
    expect(lines).toContain('[1 implement/p1] one')
    // hung child + 100ms timeout
    writeFileSync(bin, '#!/bin/sh\nsleep 60\n', { mode: 0o755 })
    const hung = await spawnSession({ kind: 'spawn', home: repo.root }, repo.root,
      { ...cfgOf(repo), drive: { sessionTimeoutMs: 100 } }, ctxWithEnv(bin), 2)
    expect(hung).toBe('timeout')
  }, 15000)
```

(`cfgOf`/`ctxWithEnv` are three-line local helpers in the test file — write them out; `fakeCtx` and `fakeBinDir` exist in `tests/helpers.ts`.)

- [ ] **Step 2: Verify failure.** — [ ] **Step 3: Implement** with `child_process.spawn`, a small line-splitter on both pipes, `setTimeout` for the kill, and `sessionSpawnCmd` factored so the calibration worker and drive share one command builder (one home for "how do we spawn this harness headless").

- [ ] **Step 4: Verify pass.** — [ ] **Step 5: Commit** — `feat(drive): headless spawn with streaming and timeout, shared with the calibration worker (D145)`

---

### Task 4: The loop — spawn, re-derive, guard

**Files:**
- Modify: `src/drive.ts` (`driveLoop`), `src/verbs/drive.ts` (wire it)
- Test: `tests/drive.test.ts` (extend)

**Interfaces:**
- Produces: `driveLoop(root, cfg, ctx, flags): Promise<number>` — loop: derive action (`--flow` → `resolveFlow`+`flowAction`, else `computeNext`; both already exported from `src/verbs/next.ts`) → `classifyAction` → spawn / return per taxonomy. Guards: **no-progress** (previous action line identical AND total journal line-count unchanged → print `drive: no progress — <line>` and exit `FINDINGS`); **max-spawns** (default 20, `--max-spawns` flag) → print and exit `FINDINGS`; `spawn-failed`/`timeout` → exit `FINDINGS`. `merge`/`conversation`/`idle` print their line and exit `OK`. `decision` defers to Task 5 (until then: print the block line and exit `OK`).
- Journal growth check: sum of line counts across `.witness/journal/*.jsonl` — cheap, derived, stateless.

- [ ] **Step 1: Failing test** — fake agent that performs one real act then idles:

```ts
  it('spawns until idle and stops on no-progress (D145)', async () => {
    const repo = await seededRepo()
    // fake agent appends a real journal entry via the CLI once, then does nothing on
    // later spawns → second identical action with no journal growth must stop the loop
    const bin = join(fakeBinDir(), 'fake-driver')
    writeFileSync(bin, `#!/bin/sh\n${process.execPath} ${join(repo.root, '..', 'noop.mjs')}\n`, { mode: 0o755 })
    // …seed an in-progress plan whose next action is a gate the fake never satisfies
    // (copy the started-plan fixture from tests/start.test.ts), then:
    const res = await driveLoop(repo.root, cfg, ttyCtx({ WITNESS_DRIVE_AGENT_BIN: bin }), { maxSpawns: 5 })
    expect(res).toBe(1)
    expect(out.join('\n')).toMatch(/drive: no progress — witness gate/)
  })
```

(The fixture comment is a placeholder only in this plan's prose — the executor writes the seeded-plan setup out fully, copying `tests/start.test.ts`; the assertions are the contract.)

- [ ] **Step 2: Verify failure.** — [ ] **Step 3: Implement** `driveLoop` (~60 lines) + flag parsing (`parseArgs` as `next.ts:762` does). — [ ] **Step 4: Verify pass.** — [ ] **Step 5: Commit** — `feat(drive): the scheduler loop with no-progress and spawn ceilings (D145)`

---

### Task 5: Judgment stops in the driver's terminal

**Files:**
- Modify: `src/drive.ts`, `src/verbs/drive.ts`
- Test: `tests/drive.test.ts` (extend — scripted `ctx.ask`)

**Interfaces:**
- Produces: on `kind: 'decision'`, drive runs the in-process equivalent of `decide <gate> <target> --show` (call the decide verb's `run` with those argv through the CLI dispatcher so rendering stays one-home), then `ctx.ask('decide> ')`: input is matched **D143-verbatim** — an option number or verb executes that option's printed command via the dispatcher; a bare affirmation (`y`/`ok`/`go`) executes the recommended option with `--via affirmation` appended; affirmation against an excluded act (the block's recommended option is an override/stop/trust/abandon) re-asks instead of executing (the CLI's `nod-cannot` would refuse anyway — drive avoids burning the round-trip); empty input re-asks once then exits `OK` leaving the stop standing. After a decision executes, the loop continues.
- Consumes: T6 of wave 2 (`--via affirmation` exists in `decide`).

- [ ] **Step 1: Failing test** — seed a stopped gate (fixture reviewer, copy from `tests/decide.test.ts`), scripted ask returning `'y'`:

```ts
    const asks: string[] = ['y']
    const ctx = ttyCtx({}, { ask: async () => asks.shift() ?? '' })
    const res = await driveLoop(repo.root, cfg, ctx, {})
    const entry = readStream(repo.root, planId).findLast((e) => e.t === 'human-decision')
    expect(entry?.selected).toBe('affirmation')
```

- [ ] **Step 2: Verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Verify pass** + full suite. — [ ] **Step 5: Commit** — `feat(drive): judgment stops render and resolve in the driver terminal (D145, D143)`

---

### Task 6: Docs

**Files:** `README.md` (verbs table row: `drive` — `schedule green-path work through headless sessions; you appear only at judgment stops`; a Configuration row for `drive.sessionTimeoutMs`), `DESIGN.md` (row 145 annotation: **Built and shipped as 0.16.0**, plus the addendum decisions 1–9 above condensed into the row's Choice column — they are now design, and DESIGN.md is where design lives; anything a probe corrected while building is recorded per house practice).

- [ ] **Step 1:** Edit both files. — **Step 2:** `pnpm vitest run` (version-sync and skills contracts must stay green — drive touches no payload). — **Step 3:** Commit — `docs: drive verb, config key, row 145 annotated (D145)`

---

### Task 7: Ship wave 3

- [ ] **Step 1:** `pnpm test && pnpm run typecheck && pnpm run build` — green (superpowers:verification-before-completion).
- [ ] **Step 2:** Push, `gh pr create --title "Triage wave 3: witness drive (D145)" --body "The CLI schedules headless sessions through green-path steps; humans appear at judgment stops. Implements row D145 + the reviewed design addendum in docs/superpowers/plans/2026-08-29-triage-wave-3-drive.md."`
- [ ] **Step 3 (human-gated):** after merge: `git checkout main && git pull && node scripts/release.mjs minor && git push origin main && git push origin v0.16.0`. Stop and hand merge + release to the human. First field run of drive re-measures the treadmill numbers (989 turns / 95% waiting) — note that in the PR body so the next report has its baseline.

---

## Self-review notes

- The addendum is the design work D145 deferred — its nine decisions are explicit, each with a reason, and reviewing this plan reviews them; flag disagreements before execution, not after.
- Dependency: Task 5 consumes wave 2's `--via affirmation` — this plan cannot start before wave 2 lands.
- Drive holds no state and journals nothing (addendum §9): kill it anywhere, re-run converges — north star 6 is a testable property and Task 4's no-progress test doubles as its regression net.
- Deliberately absent (YAGNI, spec residuals): parallel spawns (the DAG unlock stays future), a daemon mode, drive-driven brainstorm (conversations belong to chat sessions), any persistence of spawn history.
