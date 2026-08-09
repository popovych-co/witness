# witness 0.10.0 — one repo, one version (DESIGN rows 116, 117, 118) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it structurally impossible for two witness versions to drive one repository, so the two-session redirect livelock cannot recur — and make the homes already frozen by it visible and repairable.

**Architecture:** The incident's root cause is that *which CLI runs* became a property of a **git branch**. The payload is committed (row 87, correctly — worktrees are branch checkouts, so only committed files reach the agent), and the payload's engine file carries the pin that selects the CLI. A worktree cut before an upgrade therefore keeps the old pin, the old pin selects the old CLI, and the old CLI is too old to know it is old. Row 102's `cli-behind-payload` cannot catch this: it fires *inside* the home it protects.

This plan moves the constraint off the branch and onto the **shared state**, which every home already reads. Three rows, in dependency order:

- **Row 116 — the state names its floor.** Every journal entry is stamped with the CLI that wrote it (`appendEntry` is the single funnel). The floor is the highest version the state has ever seen, derived, never stored. `cli.ts`'s dispatch refuses `cli-behind-state` before any verb runs. This binds every home, every verb, every harness, with no reference to the payload — and it catches the hand-run `npx witness@0.4` that no payload scheme ever could.
- **Row 117 — an upgrade upgrades every home.** `init` stops installing into the primary root only. It preflights root *and* every live worktree, then writes and commits into each. "Upgrade the repo" starts meaning what it says.
- **Row 118 — `check` audits every home.** The payload staleness probe stops reading `join(root, p.to)` and reads every home, naming the stale one. Diagnosis belongs in the diagnostic verb; this is what finds the homes frozen *before* row 116 shipped, which row 116 by construction cannot.

Row 116 is the fix. Rows 117 and 118 are what make it reachable: 116 only ever binds CLIs at or after 0.10.0, so the repair path (117) and the discovery path (118) are load-bearing, not garnish.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), vitest, git plumbing via `src/gitio.ts`'s `git`/`tryGit`, biome for formatting.

## Global Constraints

- **No per-task commits.** This project's standing preference: implement every task's code and tests, run the verifications, leave the working tree uncommitted, and ask about commit granularity only once the whole plan is green end to end. Every task below ends in a verification step, never a commit step.
- **Branch:** cut a fresh branch off `main` (`git switch -c repo-version-floor-0.10.0`). `main` carries the merged 0.9.0 work at `fd2655f`.
- **Test command:** `npx vitest run tests/<file> --poolOptions.forks.maxForks=4`. The fork pool IPC-times-out under full concurrency on this machine — `[vitest-worker]: Timeout calling "onTaskUpdate"` is a flake, not a failure, and it can make the run exit 1 with every test green. Read the counts, not the exit code. Redirect long output with `>`, never pipe to `tail`.
- **`rm -rf .witness/worktrees` before every full-suite run.** A leaked nested worktree drags fixtures into a root-level run and produces false failures.
- **Baseline suite: 111 files, 867 tests green** (measured on this tree, 2026-08-09, 243s at `maxForks=4`). No task may reduce the test count without replacing what it removed.
- **The floor binds forward only, and the plan must never claim otherwise.** A CLI released before 0.10.0 cannot be taught to check anything. Homes frozen at 0.5.1 today are found by row 118 and repaired by row 117; they are not, and cannot be, stopped by row 116. Any comment or refusal text implying retroactive coverage is wrong.
- **Refusals name remedies.** Every violation added here follows the existing four-field shape — `v(field, rule, got, want)` — and `want` states the command that fixes it. See `src/install.ts:63` for the house voice.
- **No new `WITNESS_*` configuration.** The README states the doctrine outright: configuration has exactly one home, `witness.config.yaml` for repo facts and `.witness/config.local.yaml` for machine facts (row 90 killed `WITNESS_HARNESS` to establish it). The deliberate-downgrade valve in Task 4 is a journaled `policy-pin`, not an env var.
- Style: comments explain *why the rule exists and what breaks without it*, in the voice of the surrounding code. Match it — this codebase carries its design rationale inline and a bare mechanical comment reads as a regression. `src/**` uses no semicolons, 2-space indent, single quotes.

---

## File Structure

**Created:**
- `src/floor.ts` — pure derivation plus one read: `stateFloor(root)` answers *what is the highest witness version this repository's state has ever been written by*, and nothing else. Imports `journal.ts` and `version.ts` only. Deliberately not in `journal.ts`: the journal module is about appending and reading streams, and a policy question living there is how `check`'s inline pin regex happened (row 102's finding).
- `src/verbs/floor.ts` — the `witness floor` verb: `--show` reports the floor and its author, `--set <triple> --note <why>` journals a deliberate lower bound. The safety valve for a bad release; without it a single broken publish strands every repository that ran it once.
- `tests/floor.test.ts` — Task 1 and Task 2.
- `tests/cli-floor.test.ts` — Task 3.
- `tests/floor-verb.test.ts` — Task 4.
- `tests/init-homes.test.ts` — Task 5.

**Modified:**
- `src/version.ts` — gains `version()`, moved from `cli.ts`. It already declares itself "the one home for which version of witness is which"; `journal.ts` needs it, and importing `cli.js` from `journal.js` would close a cycle (`cli` → `verbs/*` → `journal`). `cli.ts` re-exports it so no call site changes.
- `src/journal.ts` — `entryLine` stamps `w: version()` on every entry. One funnel, every verb.
- `src/cli.ts` — `version()` becomes a re-export; `main()` gains the floor gate before verb dispatch; `VERBS`/`VERB_USAGE` gain `floor`.
- `src/install.ts` — `installPayload` stays single-home and unchanged; a new `payloadHomes(root)` and `installAllHomes(root, harness)` layer above it preflight every home before writing any.
- `src/verbs/init.ts` — calls `installAllHomes`; commits per home; reports each home it touched.
- `src/verbs/check.ts` — the payload staleness probe iterates homes and names the stale one.
- `DESIGN.md` — rows 116, 117, 118 (marked ⊙), legend line at `DESIGN.md:308`.
- `README.md` — the upgrade order gains "and every live worktree".
- `package.json` + every `plugin/**` pin — 0.10.0, via `pnpm run sync-versions`.

**Modified tests:** `tests/journal.test.ts`, `tests/check.test.ts`, `tests/init-agent.test.ts`, `tests/cli.test.ts`.

---

### Task 1: `version()` moves to `src/version.ts`, and every entry is stamped with it

`journal.ts` is where the stamp belongs — `entryLine` is the single funnel every state write passes through (`src/journal.ts:51`), so stamping there covers all fourteen entry types and every verb without a widened signature to disagree over. It cannot reach `version()` where it currently lives: `cli.ts` imports the verb loaders, the verbs import `journal.ts`, and importing back would close the cycle. `version.ts` is the honest home anyway — its own docblock claims to be "the one home for which version of witness is which", and today it holds the pin regex and the comparator while the actual version reader sits in the CLI shell.

**Files:**
- Modify: `src/version.ts` (add `version()`), `src/cli.ts:80-85` (delete the body, re-export), `src/journal.ts:51`
- Test: `tests/floor.test.ts` (create), `tests/journal.test.ts` (extend)

**Interfaces:**
- Produces:
  - `version(): string` — now exported from `src/version.ts`; `src/cli.ts` re-exports the same binding so `import { version } from './cli.js'` keeps working at all eleven existing call sites.
  - Every journal line gains `w: <triple>` immediately after `v: 1`.

- [ ] **Step 1: Write the failing test**

Create `tests/floor.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { appendEntry, readStream } from '../src/journal.js'
import { version } from '../src/version.js'
import { seededRepo } from './helpers.js'

describe('every entry names the CLI that wrote it', () => {
  // The stamp is what makes the state self-describing: without it the floor would have
  // to be stored, and a stored floor is a second source of truth that can drift from
  // the entries it claims to summarise.
  it('stamps w on every appended entry', async () => {
    const repo = await seededRepo()
    appendEntry(repo.root, 'auth-hardening', { t: 'status', artifact: 'x', from: 'a', to: 'b', cause: 'start' })
    const last = readStream(repo.root, 'auth-hardening').at(-1)!
    expect(last.w).toBe(version())
  })

  // Ordering is part of the contract: `v` then `w` then the payload, so a human reading
  // raw jsonl sees schema and author before content.
  it('places w directly after v in the serialised line', async () => {
    const repo = await seededRepo()
    appendEntry(repo.root, 'auth-hardening', { t: 'status', artifact: 'x', from: 'a', to: 'b', cause: 'start' })
    const raw = repo.read('.witness/journal/auth-hardening.jsonl').trim().split('\n').at(-1)!
    expect(raw.startsWith(`{"v":1,"w":"${version()}"`)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/floor.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `expected undefined to be '0.9.0'`, and the second case fails on the raw prefix.

- [ ] **Step 3: Move `version()` and stamp the line**

In `src/version.ts`, add the import and the function (the file currently imports nothing — this is the one I/O it gains, and the reason is stated):

```typescript
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Moved here from cli.ts. `journal.ts` stamps every entry with it and cannot import the
// CLI shell without closing a cycle (cli → verbs/* → journal). This module already
// claimed to be the one home for "which version of witness is which"; it held the pin
// and the comparator while the reader lived in the shell, which is the same split rows
// 93/95/96 keep naming. The single readFileSync is the exception to this file's no-I/O
// rule and the only one it may ever have.
export function version(): string {
  const pkg = JSON.parse(
    readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'package.json'), 'utf8'),
  ) as { version: string }
  return pkg.version
}
```

In `src/cli.ts`, delete the old body at lines 80-85 and re-export instead, so no call site moves:

```typescript
export { version } from './version.js'
```

In `src/journal.ts`, import it and stamp:

```typescript
import { version } from './version.js'

// `w` is the CLI that wrote this line. Stamped HERE because entryLine is the single
// funnel every state write passes through, so one edit covers fourteen entry types and
// every verb. It is what lets the state name its own floor (floor.ts) instead of a
// stored number that can drift from the entries it summarises — and it is why a repo
// can refuse a CLI older than its own history without consulting any payload file.
export const entryLine = (entry: { t: EntryType; [k: string]: unknown }): string =>
  JSON.stringify({ v: 1, w: version(), ...entry })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/floor.test.ts tests/journal.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. If `tests/journal.test.ts` has a test asserting an exact serialised line, update that fixture to carry `"w"` — it is the one place the new field is visible.

- [ ] **Step 5: Verify no call site of `version()` broke**

Run: `npx tsc --noEmit`
Expected: exit 0. Eleven call sites import `version` from `./cli.js` or `../cli.js`; the re-export keeps every one of them valid.

---

### Task 2: `src/floor.ts` — the highest version the state has seen

The floor is **derived, never stored**. A stored floor is a second answer to a question the entries already answer, and this codebase has three rows (93, 95, 96) about exactly that mistake. Derivation also makes it unforgeable by accident: there is no file a human can edit to lower it, only a journaled decision (Task 4).

**Files:**
- Create: `src/floor.ts`
- Test: `tests/floor.test.ts` (extend)

**Interfaces:**
- Consumes: `journalDir` listing and `readStream` from `src/journal.ts`; `compareTriple` from `src/version.ts`.
- Produces:
  - `stateFloor(root: string): { pin: string; stream: string } | undefined` — the highest `w` across every stream and the stream it came from, or `undefined` when the state carries no stamp at all (every repository written before 0.10.0).

- [ ] **Step 1: Write the failing test**

Append to `tests/floor.test.ts`:

```typescript
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateFloor } from '../src/floor.js'

describe('the floor is the highest version the state has seen', () => {
  // A repository whose whole history predates the stamp has no floor — and no floor is
  // silence, never zero. Treating "unstamped" as 0.0.0 would be a claim the state never
  // made, and it is the state of every repo in the field on the day 0.10.0 ships.
  it('is undefined when no entry carries a stamp', async () => {
    const repo = await seededRepo()
    writeFileSync(join(repo.root, '.witness', 'journal', 'legacy.jsonl'),
      '{"v":1,"t":"status","artifact":"x","from":"a","to":"b","cause":"start"}\n')
    expect(stateFloor(repo.root)?.pin).toBeUndefined()
  })

  // Highest, not last: a downgrade writes a lower stamp after a higher one, and the
  // floor must not fall just because the most recent writer was older.
  it('takes the maximum across streams, not the most recent entry', async () => {
    const repo = await seededRepo()
    writeFileSync(join(repo.root, '.witness', 'journal', 'a.jsonl'),
      '{"v":1,"w":"0.9.0","t":"status","artifact":"x","from":"a","to":"b","cause":"start"}\n' +
      '{"v":1,"w":"0.5.1","t":"status","artifact":"x","from":"b","to":"c","cause":"ship"}\n')
    writeFileSync(join(repo.root, '.witness', 'journal', 'b.jsonl'),
      '{"v":1,"w":"0.7.0","t":"status","artifact":"y","from":"a","to":"b","cause":"start"}\n')
    expect(stateFloor(repo.root)).toEqual({ pin: '0.9.0', stream: 'a' })
  })

  // An unparseable stamp is "cannot compare", which is compareTriple's documented
  // contract and the rule both payload guards already follow: never invent a bound out
  // of a value you could not read.
  it('ignores an unparseable stamp rather than refusing on it', async () => {
    const repo = await seededRepo()
    writeFileSync(join(repo.root, '.witness', 'journal', 'a.jsonl'),
      '{"v":1,"w":"garbage","t":"status","artifact":"x","from":"a","to":"b","cause":"start"}\n' +
      '{"v":1,"w":"0.6.0","t":"status","artifact":"x","from":"b","to":"c","cause":"ship"}\n')
    expect(stateFloor(repo.root)?.pin).toBe('0.6.0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/floor.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `Cannot find module '../src/floor.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/floor.ts`:

```typescript
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readStream } from './journal.js'
import { compareTriple } from './version.js'

// Row 116. The state's own answer to "what is the oldest CLI allowed to touch this
// repository", derived from the `w` stamps entryLine writes and stored nowhere. Derived
// because a stored floor is a second source of truth that drifts from the entries it
// summarises — the shape rows 93, 95 and 96 all name — and because a derived one cannot
// be lowered by editing a file, only by a journaled decision (verbs/floor.ts).
//
// MAXIMUM, not most-recent: a downgraded CLI writing a lower stamp after a higher one is
// exactly the event this guards against, and a floor that fell to the last writer would
// ratify the regression it exists to refuse.
//
// `undefined` means the state carries no stamp at all — every repository written before
// 0.10.0. It is silence, not zero: a floor of 0.0.0 would be a claim the state never
// made, and it would refuse nothing anyway.
export function stateFloor(root: string): { pin: string; stream: string } | undefined {
  const dir = join(root, '.witness', 'journal')
  if (!existsSync(dir)) return undefined
  let best: { pin: string; stream: string } | undefined
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const stream = file.slice(0, -'.jsonl'.length)
    for (const entry of readStream(root, stream)) {
      const pin = typeof entry.w === 'string' ? entry.w : undefined
      // `?? 0` is the "cannot compare, so do not raise the bound" rule — the same
      // contract install.ts's two guards read compareTriple under.
      if (pin === undefined) continue
      if (best === undefined ? compareTriple(pin, pin) !== undefined : (compareTriple(pin, best.pin) ?? 0) > 0) {
        best = { pin, stream }
      }
    }
  }
  return best
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/floor.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the cost is bounded**

Run: `npx vitest run tests/floor.test.ts tests/next.test.ts tests/flows.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS with no measurable slowdown versus the baseline timings in those files. `stateFloor` reads every stream once per verb; the largest stream observed in the field is ~390KB, and the verbs that matter already call `readStream` over live efforts. If a repo ever makes this hot, the fix is to read each stream's last line rather than all of them — do not pre-optimise it here.

---

### Task 3: the dispatch refuses a CLI below the floor

One gate, above every verb. `cli.ts`'s `main()` is the single dispatch (`src/cli.ts:98`), which is what makes this cover fourteen verbs and both harnesses without a per-verb opt-in that some future verb forgets.

`--version` and `help` stay open: they are answered above the dispatch already, and a human diagnosing a refused repo needs to be able to ask what they are running. Everything else refuses — including `check`, whose own answer would be computed by the very CLI the state has rejected.

**Files:**
- Modify: `src/cli.ts` (inside `main`, after the help/usage block, before `const load = VERBS[verb]`)
- Test: `tests/cli-floor.test.ts` (create)

**Interfaces:**
- Consumes: `stateFloor` from `src/floor.ts`; `primaryRoot` from `src/gitio.ts` (already imported in `cli.ts`); `renderRefusal`/`v` from `src/refusal.js` (already imported).
- Produces: violation rule `cli-behind-state`, `EXIT.REFUSED` (2).

- [ ] **Step 1: Write the failing test**

Create `tests/cli-floor.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { version } from '../src/version.js'
import { seededRepo } from './helpers.js'

// A stamp higher than the running CLI is the only way to simulate the future from the
// present: the suite always runs the newest witness there is.
function stampFuture(root: string, pin = '99.0.0'): void {
  writeFileSync(join(root, '.witness', 'journal', 'future.jsonl'),
    `{"v":1,"w":"${pin}","t":"status","artifact":"x","from":"a","to":"b","cause":"start"}\n`)
}

describe('a CLI below the state floor refuses', () => {
  // The incident in one assertion: a CLI a lifecycle behind the repository must not be
  // able to answer a routing question, because its answer is computed from rules the
  // repository has already moved past.
  it('refuses next when the state has been written by a newer CLI', async () => {
    const repo = await seededRepo()
    stampFuture(repo.root)
    const res = await repo.cli(['next'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('cli-behind-state')
    expect(res.stderr).toContain(`this CLI is ${version()}`)
    expect(res.stderr).toContain('99.0.0')
    expect(res.stdout).toBe('')
  })

  // Every verb, not a list someone has to remember to extend.
  it('refuses a mutating verb on the same rule', async () => {
    const repo = await seededRepo()
    stampFuture(repo.root)
    const res = await repo.cli(['check'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('cli-behind-state')
  })

  // The two questions a refused human needs answered are still answerable.
  it('leaves --version and help open', async () => {
    const repo = await seededRepo()
    stampFuture(repo.root)
    expect((await repo.cli(['--version'])).code).toBe(0)
    expect((await repo.cli(['help'])).code).toBe(0)
  })

  // Equal is not behind. The witness developer runs the version they are building.
  it('allows a CLI at the floor', async () => {
    const repo = await seededRepo()
    stampFuture(repo.root, version())
    expect((await repo.cli(['next'])).code).toBe(0)
  })

  // Pre-0.10.0 state has no stamp, and silence must not become a refusal — that would
  // brick every repository in the field on upgrade day.
  it('allows an unstamped repository', async () => {
    const repo = await seededRepo()
    writeFileSync(join(repo.root, '.witness', 'journal', 'legacy.jsonl'),
      '{"v":1,"t":"status","artifact":"x","from":"a","to":"b","cause":"start"}\n')
    expect((await repo.cli(['next'])).code).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-floor.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — the first two cases return 0 and print a routing answer.

- [ ] **Step 3: Write the implementation**

In `src/cli.ts`, inside `main()`, immediately after the help/usage block and before `const load = VERBS[verb]`:

```typescript
  // Row 116. Above the verb table on purpose: the invariant is "one repository, one
  // witness version", and a per-verb opt-in is a list some future verb forgets to join.
  //
  // This is the guard row 102's `cli-behind-payload` structurally could not be. That one
  // fires inside the home it protects, so a home frozen at an old pin runs an old CLI
  // that never learned to check — which is how two sessions a lifecycle apart each
  // computed a different next stage, each redirected to the other's home, and each
  // honestly ended its turn. The state is the one thing both homes share, so the state
  // is where the bound belongs.
  //
  // Forward-only, and the text must never imply otherwise: a CLI published before 0.10.0
  // cannot run this code. Homes already frozen are found by `check` (row 118) and
  // repaired by `init` (row 117).
  const rootRes = primaryRoot(ctx.cwd)
  if (rootRes.ok) {
    const floor = stateFloor(rootRes.value)
    if (floor !== undefined && (compareTriple(version(), floor.pin) ?? 0) < 0) {
      renderRefusal([v('witness', 'cli-behind-state',
        `this CLI is ${version()}, this repository's state was written by ${floor.pin}`,
        `a CLI at or ahead of ${floor.pin} — run ${NPX_LATEST} init --agent <name>; if you are ` +
        `deliberately rolling back, lower the bound first with witness floor --set ${version()} --note <why>`,
      )]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
  }
```

Add to `cli.ts`'s imports:

```typescript
import { stateFloor } from './floor.js'
import { NPX_LATEST, compareTriple, version } from './version.js'
```

and change the `version` re-export from Task 1 to `export { version }` so the binding is imported once and re-exported once.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli-floor.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify nothing else routes through a refused dispatch**

Run: `npx vitest run tests/cli.test.ts tests/index.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. These exercise the dispatch itself; a repo seeded by the current CLI stamps its own version, so the floor equals `version()` and never refuses.

---

### Task 4: `witness floor` — the deliberate downgrade

Without a valve, one bad publish strands every repository that ran it once: the state's floor is the broken version, and the fixed older CLI is refused. The valve is a **journaled decision**, not a flag and not a file — `policy-pin` already exists as an entry type (`src/journal.ts:8`) for exactly this shape of human act, and journaling it means the rollback is auditable rather than invisible.

**Files:**
- Create: `src/verbs/floor.ts`
- Modify: `src/cli.ts` (`VERBS`, `VERB_USAGE`), `src/floor.ts` (honour the pin)
- Test: `tests/floor-verb.test.ts` (create)

**Interfaces:**
- Consumes: `stateFloor` from `src/floor.ts`; `appendEntry` from `src/journal.ts`; `primaryRoot` from `src/gitio.ts`.
- Produces:
  - `witness floor --show` → `floor: <pin> · set by <stream>` or `floor: none — this state predates 0.10.0`.
  - `witness floor --set <triple> --note <why>` → appends `{ t: 'policy-pin', key: 'floor', pin, note }` to the `floor` stream and reports it.
  - `stateFloor` gains: the **latest** `policy-pin` with `key: 'floor'` wins outright over the derived maximum.

- [ ] **Step 1: Write the failing test**

Create `tests/floor-verb.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateFloor } from '../src/floor.js'
import { version } from '../src/version.js'
import { seededRepo } from './helpers.js'

describe('witness floor', () => {
  it('reports no floor for a state that predates the stamp', async () => {
    const repo = await seededRepo()
    writeFileSync(join(repo.root, '.witness', 'journal', 'legacy.jsonl'),
      '{"v":1,"t":"status","artifact":"x","from":"a","to":"b","cause":"start"}\n')
    const res = await repo.cli(['floor', '--show'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('predates')
  })

  it('reports the derived floor and the stream that set it', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['floor', '--show'])
    expect(res.stdout).toContain(`floor: ${version()}`)
  })

  // A lowered bound overrides the derived maximum outright — that is the whole point of
  // the valve, and a rule that merely tied with the maximum would never let anything
  // roll back.
  it('lets an explicit pin lower the bound below the derived maximum', async () => {
    const repo = await seededRepo()
    writeFileSync(join(repo.root, '.witness', 'journal', 'future.jsonl'),
      '{"v":1,"w":"99.0.0","t":"status","artifact":"x","from":"a","to":"b","cause":"start"}\n')
    expect(stateFloor(repo.root)?.pin).toBe('99.0.0')

    const res = await repo.cli(['floor', '--set', '0.5.0', '--note', 'rolling back a bad publish'])
    expect(res.code).toBe(0)
    expect(stateFloor(repo.root)?.pin).toBe('0.5.0')
    // and the dispatch stops refusing
    expect((await repo.cli(['next'])).code).toBe(0)
  })

  // The decision is auditable or it is not a decision.
  it('refuses --set without a note', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['floor', '--set', '0.5.0'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('note-required')
  })

  it('refuses a pin that is not a numeric triple', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['floor', '--set', 'latest', '--note', 'why'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('bad-pin')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/floor-verb.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — `unknown verb: floor`.

- [ ] **Step 3: Write the implementation**

Create `src/verbs/floor.ts`:

```typescript
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { stateFloor } from '../floor.js'
import { primaryRoot } from '../gitio.js'
import { appendEntry } from '../journal.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'
import { compareTriple, version } from '../version.js'

// Row 116's safety valve. The floor is derived from what the state has seen, which is
// correct until a published version is broken: then every repository that ran it once
// has a bound no fixed CLI can satisfy, and the tool has locked its users out over its
// own defect. Lowering it is a human act with a reason, so it is journaled as a
// policy-pin — the entry type row 83 added for exactly this shape — and never a flag on
// another verb or a file someone can edit without leaving a trace.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { show: { type: 'boolean' }, set: { type: 'string' }, note: { type: 'string' } },
  })
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootRes.value

  if (values.set !== undefined) {
    // Two refusals, collected the way row 111 collects an approve's: a human fixing one
    // and learning about the other on the re-run has spent a turn witness could have saved.
    const violations = []
    if (compareTriple(values.set, values.set) === undefined) {
      violations.push(v('--set', 'bad-pin', values.set, 'a numeric triple such as 0.9.0 — prerelease ordering is out of scope'))
    }
    if (values.note === undefined || values.note.trim() === '') {
      violations.push(v('--note', 'note-required', 'absent',
        'a reason — lowering the bound is a decision the journal has to be able to explain later'))
    }
    if (violations.length > 0) { renderRefusal(violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    appendEntry(root, 'floor', { t: 'policy-pin', key: 'floor', pin: values.set, note: values.note })
    ctx.out(kv('floor', `${values.set} — set by hand: ${values.note}`))
    return EXIT.OK
  }

  const floor = stateFloor(root)
  ctx.out(floor === undefined
    ? kv('floor', 'none — this state predates 0.10.0, so no bound is claimed')
    : kv('floor', `${floor.pin} · set by ${floor.stream} · this CLI is ${version()}`))
  return EXIT.OK
}
```

In `src/floor.ts`, an explicit pin wins outright. Add above the stream scan in `stateFloor`:

```typescript
  // An explicit decision outranks the derived maximum — including downward, which is the
  // only reason the verb exists. Latest wins, so a second rollback supersedes the first.
  const pinned = readStream(root, 'floor')
    .filter((e) => e.t === 'policy-pin' && e.key === 'floor' && typeof e.pin === 'string')
    .at(-1)
  if (pinned !== undefined) return { pin: pinned.pin as string, stream: 'floor (set by hand)' }
```

In `src/cli.ts`, register the verb in `VERBS` and `VERB_USAGE`:

```typescript
  floor: () => import('./verbs/floor.js'),
```
```typescript
  floor: 'witness floor --show | --set <triple> --note <why>',
```

`floor` must also be exempt from the Task 3 gate — a repository refusing every verb cannot run the verb that unrefuses it. In `cli.ts`'s floor gate, guard with `if (rootRes.ok && verb !== 'floor')`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/floor-verb.test.ts tests/cli-floor.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS, 11 tests total.

- [ ] **Step 5: Verify the exemption is not a hole**

Run: `npx vitest run tests/floor.test.ts tests/floor-verb.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. `floor --set` is the only verb an under-floor CLI may run, it writes exactly one journal line, and that line is stamped `w` with the old CLI's version like every other — which is correct: the rollback is part of the history it rolls back into.

---

### Task 5: `init` installs into every home, or into none

`installPayload` has exactly one call site (`src/verbs/init.ts:135`) and it targets the primary root. That is the whole reason a live worktree can sit a lifecycle behind: nothing ever refreshes it, because "upgrade the repo" only ever meant "upgrade one checkout of it".

The doctrine at `src/install.ts:52` — *refuse the WHOLE run, so a refusal leaves nothing half-installed* — extends rather than bends: preflight **every** home first, then write every home. A half-upgraded set of homes is precisely the skew this row exists to close.

**Files:**
- Modify: `src/install.ts` (add `payloadHomes`, `installAllHomes`), `src/verbs/init.ts:135-160`
- Test: `tests/init-homes.test.ts` (create)

**Interfaces:**
- Consumes: `installPayload`/`preflightPayload` unchanged; `worktreePath` and the worktree listing from `src/worktree.ts`.
- Produces:
  - `payloadHomes(root: string): string[]` — the primary root followed by every existing `.witness/worktrees/<id>`, sorted, root always first.
  - `installAllHomes(root: string, harness: Harness): Result<Array<{ home: string; synced: SyncResult }>>` — preflights every home, then writes every home.

- [ ] **Step 1: Write the failing test**

Create `tests/init-homes.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinIn, version } from '../src/version.js'
import { worktreePath } from '../src/worktree.js'
import { shippableRepo } from './helpers.js'

const ENGINE = join('.claude', 'commands', 'witness.md')

describe('init upgrades every home of the repository', () => {
  // The incident, prevented: the human upgrades and re-inits at the root, and the live
  // worktree stops being a time capsule of the CLI that cut it.
  it('rewrites the payload inside a live worktree', async () => {
    const { repo, planId } = await shippableRepo()
    const wt = worktreePath(repo.root, planId)
    writeFileSync(join(wt, ENGINE), 'WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.5.1}"\n')
    repo.git('-C', wt, 'add', '-A')
    repo.git('-C', wt, 'commit', '-m', 'freeze the payload at 0.5.1')

    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(0)
    expect(pinIn(readFileSync(join(wt, ENGINE), 'utf8'))).toBe(version())
    expect(res.stdout).toContain(planId)

    await repo.cli(['clean'])
  })

  // The payload must be COMMITTED in the worktree or the agent never sees it: a worktree
  // is a branch checkout, which is row 87's whole argument for committing it at the root.
  it('commits the worktree payload on the plan branch', async () => {
    const { repo, planId } = await shippableRepo()
    const wt = worktreePath(repo.root, planId)
    writeFileSync(join(wt, ENGINE), 'WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.5.1}"\n')
    repo.git('-C', wt, 'add', '-A')
    repo.git('-C', wt, 'commit', '-m', 'freeze the payload at 0.5.1')

    await repo.cli(['init', '--agent', 'claude-code'])
    const status = repo.git('-C', wt, 'status', '--porcelain', '--', ENGINE)
    expect(status).toBe('')

    await repo.cli(['clean'])
  })

  // All or nothing across homes. A dirty payload in ONE home must not leave the others
  // upgraded — a half-upgraded set of homes is the skew this row exists to close.
  it('refuses every home when one home has a dirty payload', async () => {
    const { repo, planId } = await shippableRepo()
    const wt = worktreePath(repo.root, planId)
    writeFileSync(join(wt, ENGINE), 'WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.5.1}"\n')
    // deliberately NOT committed — this is the dirty case
    const before = readFileSync(join(repo.root, ENGINE), 'utf8')

    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('payload-dirty')
    expect(res.stderr).toContain(planId)
    expect(readFileSync(join(repo.root, ENGINE), 'utf8')).toBe(before)

    await repo.cli(['clean'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init-homes.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — the worktree payload still reads `0.5.1` after `init`, and the third case exits 0 having upgraded the root only.

- [ ] **Step 3: Write the implementation**

In `src/install.ts`:

```typescript
// Row 117. "Upgrade the repository" has always meant "upgrade one checkout of it", which
// is why a worktree can sit a lifecycle behind the root: installPayload had exactly one
// call site and it targeted the primary root. A worktree is a branch checkout, so its
// payload is a different file on a different timeline — the same property row 87 relies
// on to get the payload to the agent at all.
//
// Root first, then worktrees in sorted order: the root is the home the human is standing
// in, and if a later home fails they need the report to read top-down.
export function payloadHomes(root: string): string[] {
  const dir = join(root, '.witness', 'worktrees')
  if (!existsSync(dir)) return [root]
  return [root, ...readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name))
    .sort()]
}

// Preflight EVERY home before writing ANY. install.ts's standing doctrine is that a
// refusal leaves nothing half-installed; across homes that matters more, not less — a
// half-upgraded set of homes IS the skew row 116 refuses and row 117 prevents.
export function installAllHomes(
  root: string, harness: Harness,
): Result<Array<{ home: string; synced: SyncResult }>> {
  const homes = payloadHomes(root)
  const failures = homes.flatMap((home) => {
    const pre = preflightPayload(home, harness)
    // Name the home in the field, or a `payload-dirty` row over `.claude/commands/witness.md`
    // is ambiguous across four checkouts of the same repository.
    return pre.ok ? [] : pre.violations.map((x) => ({ ...x, field: `${home}: ${x.field}` }))
  })
  if (failures.length > 0) return refuse(failures)

  const out: Array<{ home: string; synced: SyncResult }> = []
  for (const home of homes) {
    const synced = installPayload(home, harness)
    if (!synced.ok) return refuse(synced.violations)
    out.push({ home, synced: synced.value })
  }
  return ok(out)
}
```

Add `readdirSync` to the `node:fs` import at `src/install.ts:1`.

In `src/verbs/init.ts`, replace the single-home call at line 135. The root's files continue to be collected into `files` and committed by the existing block; each worktree commits its own payload on its own branch, because that is the only branch the file exists on:

```typescript
      const payload = installAllHomes(root, harness)
      if (!payload.ok) {
        renderRefusal(payload.violations).forEach(ctx.err)
        return EXIT.REFUSED
      }
      synced = payload.value.find((p) => p.home === root)?.synced ?? { written: [], overwritten: [] }
      files.push(...synced.written, ...synced.overwritten)
      // Each worktree is a separate checkout on a separate branch: its payload can only be
      // committed there. `--only` over the payload paths so nothing else in a live
      // worktree — the human's in-flight implement work — is swept into a state commit.
      for (const { home, synced: s } of payload.value.filter((p) => p.home !== root)) {
        const touched = [...s.written, ...s.overwritten]
        if (touched.length === 0) continue
        const r = tryGit(home, 'commit', '--no-verify', '--only', '-m',
          `init(${harness.name}): agent payloads`, '--', ...touched)
        if (!r.ok) {
          renderRefusal([v(home, 'home-commit-failed', r.out.split('\n')[0] ?? 'git commit failed',
            'a committable worktree — commit or stash the payload paths in that home, then re-run init')])
            .forEach(ctx.err)
          return EXIT.REFUSED
        }
        ctx.out(kv('payload-synced', `${home} — ${touched.join(' · ')}`))
      }
```

`--no-verify` matches the standing rule for state commits: a host pre-commit hook that stashes unrelated dirty files can lose a human's in-flight work when it fires inside a live worktree.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/init-homes.test.ts tests/init-agent.test.ts tests/init.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. Existing `init` tests run in repos with no worktrees, where `payloadHomes` returns `[root]` and behaviour is byte-identical to today.

- [ ] **Step 5: Verify the lock still covers the whole run**

Read `src/verbs/init.ts` around the `acquireLock` call and confirm `installAllHomes` sits inside it, exactly where `installPayload` did. Worktree commits are state writes; they belong under the same lock as the root's.

---

### Task 6: `check` audits every home

Row 116 binds nothing that shipped before it, so the homes frozen today are invisible to it by construction. `check` is where they become visible — it already owns the question (`payload-stale`, `src/verbs/check.ts:271`) and already answers it by comparing content against what the running CLI ships. It only ever asked it about `join(root, p.to)`.

**Files:**
- Modify: `src/verbs/check.ts:265-279`
- Test: `tests/check.test.ts` (extend)

**Interfaces:**
- Consumes: `payloadHomes` from `src/install.ts` (Task 5).
- Produces: the existing `payload-stale` finding, with the home named when it is not the root.

- [ ] **Step 1: Write the failing test**

Append to `tests/check.test.ts`:

```typescript
  // Row 118. A frozen worktree is what row 116 cannot see — it binds only CLIs at or
  // after 0.10.0, and the homes that matter were cut before it. `check` is the verb that
  // finds them, and it was asking its question about the root only.
  it('reports a stale payload inside a live worktree', async () => {
    const { repo, planId } = await shippableRepo()
    const wt = worktreePath(repo.root, planId)
    writeFileSync(join(wt, '.claude', 'commands', 'witness.md'),
      'WITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.5.1}"\n')

    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    const res = await repo.cli(['check'], { env: { HOME: home } })
    expect(res.stdout).toContain('payload-stale')
    expect(res.stdout).toContain(planId)

    await repo.cli(['clean'])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/check.test.ts --poolOptions.forks.maxForks=4`
Expected: FAIL — no `payload-stale` finding; the root's payload is current and the worktree is never read.

- [ ] **Step 3: Write the implementation**

In `src/verbs/check.ts`, the `installed`/`stale` block becomes per-home. Replace the single-root read with:

```typescript
      // Row 118. Per HOME, not per repository: a worktree is a branch checkout, so its
      // payload is a different file that can be a different age — which is the whole
      // failure row 116 refuses and row 117 repairs. The root keeps its bare relative
      // path in the finding; a worktree is named, or four checkouts of one repo all
      // report `.claude/commands/witness.md` and the human cannot tell which is rotten.
      const stale = payloadHomes(root).flatMap((home) => installed
        .filter((p) => {
          const src = join(packageRoot(), p.from)
          if (!existsSync(src) || !existsSync(join(home, p.to))) return false
          return readFileSync(join(home, p.to), 'utf8') !== readFileSync(src, 'utf8')
        })
        .map((p) => (home === root ? p.to : `${home}: ${p.to}`)))
      if (stale.length > 0) {
        findings.push(f('warn', 'harness', `${name}: payload`, 'payload-stale',
          `${stale.join(' · ')} differ from what ${version()} ships — run ${NPX_LATEST} init --agent ${name}`))
      }
```

`installed` keeps its existing meaning (payload entries present at the root), so a harness absent from the repository still reports absence exactly as it does today.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/check.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS, all existing `check` tests plus the new one.

- [ ] **Step 5: Verify the exit contract did not move**

Run: `npx vitest run tests/check.test.ts tests/index.test.ts --poolOptions.forks.maxForks=4`
Expected: PASS. `payload-stale` is a `warn`, and row 101 makes `check`'s exit code a statement about canon validity only — a new warn must not change any exit code assertion.

---

### Task 7: DESIGN rows, README, version bump, full green

**Files:**
- Modify: `DESIGN.md` (rows 116-118 and the legend at `DESIGN.md:308`), `README.md`, `package.json` + `plugin/**` pins

- [ ] **Step 1: Write DESIGN rows 116, 117, 118**

Insert above the `## Open / deferred` heading, in the existing four-column shape. Use the marker `⊙` — the glyphs `● ✦ ⟳ ◇ ◆ ◈ ◉ ❖ ✧ ✸ ✾ ❂ ✹ ⊚ ⊛ ⊕` are taken.

- **116 ⊙ — The state names the oldest CLI allowed to touch it.** `entryLine` stamps `w: version()`; `stateFloor` derives the maximum; `cli.ts`'s dispatch refuses `cli-behind-state` above the verb table, with `floor` exempt so a bad publish is recoverable. Why: the payload is committed, so *which CLI runs* became a property of a git branch — a worktree cut before an upgrade keeps the old pin, the pin selects the CLI, and that CLI is too old to know it is old. Row 102's `cli-behind-payload` fires inside the home it protects and structurally cannot see this. Two sessions a lifecycle apart each computed a different next stage, each redirected to the other's home, and each honestly ended its turn (109-115) — a livelock the human read as an infinite redirect with no version in sight. The state is the one thing every home shares.
- **117 ⊙ — An upgrade upgrades every home.** `payloadHomes` + `installAllHomes`: preflight every home, then write every home, each worktree committing on its own branch. Why: `installPayload` had one call site targeting the primary root, so nothing ever refreshed a live worktree. The all-or-nothing rule extends across homes rather than bending, because a half-upgraded set of homes is exactly the skew 116 refuses.
- **118 ⊙ — `check` audits every home, not every repository.** The staleness probe reads each home and names the non-root ones. Why: 116 binds only CLIs at or after 0.10.0, so the homes frozen before it are invisible to it by construction. Diagnosis belongs in the diagnostic verb, not as a guard in `next`'s hot path.

Amend the legend sentence at `DESIGN.md:308` with: `Rows 116–118 (⊙) added 2026-08-09 — post-incident amendment, no grill: the two-session redirect livelock reported against 0.9.0 (amended: 87, 102).`

- [ ] **Step 2: Update the README upgrade order**

Find the upgrade paragraph added by row 103 (skills first, then `init --agent`) and extend it: `init` now installs into the primary root **and every live worktree**, and a repository whose state was written by a newer CLI refuses every verb until the CLI is upgraded — `witness floor --show` reports the bound.

- [ ] **Step 3: Bump to 0.10.0**

```bash
pnpm run sync-versions
```

Verify every `plugin/**` pin and `package.json` read `0.10.0`:

```bash
grep -rn "@popovych.co/witness@" plugin/ | grep -v "0.10.0" || echo "all pins at 0.10.0"
```

- [ ] **Step 4: Full suite**

```bash
rm -rf .witness/worktrees
npx vitest run --poolOptions.forks.maxForks=4 > /tmp/full.txt 2>&1; tail -8 /tmp/full.txt
```

Expected: **111+ files, ≥ 886 tests green** (867 baseline + 19 added here: 5 floor, 5 cli-floor, 6 floor-verb, 3 init-homes, 1 check, minus none removed). A `[vitest-worker]: Timeout calling "onTaskUpdate"` unhandled error with every test green is the known flake — read the counts.

- [ ] **Step 5: Typecheck and lint**

```bash
npx tsc --noEmit && npx biome check src tests && echo "clean"
```

Expected: `clean`.

- [ ] **Step 6: Verify against the repository that produced the incident**

```bash
npm run build
cd /Users/home/x/personal/know-your-customer-mvp
env -u CLAUDECODE PI_CODING_AGENT=true node /Users/home/x/personal/specflow/dist/bin.js check
```

Expected: a `payload-stale` finding naming `.witness/worktrees/segments-and-reconciliation-plan-1`. That repository's state predates the stamp, so `stateFloor` is `undefined` and no verb refuses — which is the correct reading of a state that never claimed a bound. The repair is `init --agent pi` at the root, which under row 117 now reaches the worktree too.

---

## Self-Review

**Spec coverage.** Row 116 → Tasks 1, 2, 3 (stamp, derivation, enforcement) and Task 4 (the valve that makes enforcement survivable). Row 117 → Task 5. Row 118 → Task 6. Documentation, version and end-to-end verification → Task 7. The reverted `home-payload-behind` guard in `next` is deliberately **not** here: its enforcement value is subsumed by row 116, which binds every verb rather than one, and its diagnostic value by row 118, which lives in the verb that already owns diagnosis.

**Placeholder scan.** Every code step carries the actual code. Two steps are deliberately reading steps rather than writing steps — Task 5 Step 5 (confirm `installAllHomes` sits inside the lock) and Task 7 Step 1 (DESIGN prose) — and both name exactly what to look at and what the answer must be.

**Type consistency.** `stateFloor` returns `{ pin, stream } | undefined` in Tasks 2, 3, 4 alike. `payloadHomes(root): string[]` is defined in Task 5 and consumed in Task 6. `installAllHomes` returns `Result<Array<{ home, synced }>>`, and Task 5's `init` edit destructures exactly those two fields. `version()` is imported from `src/version.js` in every new file and re-exported from `cli.ts` for the eleven existing call sites.

**Known limit, stated rather than hidden.** Row 116 cannot bind a CLI published before it. The plan says so in the Global Constraints, in the row 116 comment, and in Task 7 Step 6's expected output — a repository frozen today is *found* by this work and *repaired* by it, not retroactively protected.
