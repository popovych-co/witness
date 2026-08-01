# Config Single-Home + Reviewer Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the pi reviewer auth outage (`--no-extensions` disables auth-supplying extensions → 400) via a machine-local config file, and complete the configuration single-home doctrine by removing the `WITNESS_HARNESS`, `WITNESS_REVIEWER_TIMEOUT_MS`, and `WITNESS_OPENER` env knobs. One combined breaking release: 0.5.0.

**Architecture:** Two config files with a partitioned keyspace (no merging): `witness.config.yaml` holds repo facts (gains `gates.reviewerTimeoutMs`), new gitignored `.witness/config.local.yaml` holds machine facts (`reviewerExtensions`, `opener`). `loadLocalConfig` is separate from `loadConfig` (row 87: an unread key must not brick `witness check`). Reviewer lanes thread `{timeoutMs, extensions}` through `InvokeOpts` from four verb boundaries; `invokeReviewer` never loads config (its cwd is a temp dir under calibration). pi renders extensions as `-e <path>` after `--no-extensions` (pi docs: explicit `-e` paths survive discovery-off — verified live).

**Tech Stack:** TypeScript ESM (Node ≥20), vitest, `yaml` package (already a dependency). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-31-config-single-home-reviewer-extensions-design.md`

## Global Constraints

- House style: no semicolons, single quotes, 2-space indent, trailing commas in multiline; match surrounding comment voice (dense, decision-citing). No formatter runs — match by hand.
- Refusals always use `v(field, rule, got, want)` from `src/refusal.js`; `want` describes the fixed state, not the error.
- Every task: failing test → watch it fail → minimal implementation → watch it pass → commit. Run single files with `pnpm vitest run tests/<file>.test.ts`; full suite `pnpm test`; types `pnpm typecheck`.
- Conventional commits. Breaking changes marked `!`.
- The default reviewer timeout stays 600 000 ms; the retry count (2) and `maxBuffer` are untouched.
- Never touch the worker spawns, the verdict-cache key fields, or `.witness/calibration.local.yaml`.
- pnpm only (`pnpm-lock.yaml`); do not run `npm`.

---

### Task 1: Config layer — `gates.reviewerTimeoutMs` + `loadLocalConfig`

**Files:**

- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**

- Consumes: existing `ok/refuse/v/Result` from `src/refusal.js`, `parseYaml`.
- Produces (later tasks rely on these exact names):
  - `export const DEFAULT_REVIEWER_TIMEOUT_MS = 600_000`
  - `export interface GatesConfig { reviewerTimeoutMs: number }` and `Config.gates: GatesConfig`
  - `export interface LocalConfig { reviewerExtensions: string[]; opener?: string }`
  - `export const localConfigPath = (root: string) => join(root, '.witness', 'config.local.yaml')`
  - `export function loadLocalConfig(root: string): Result<LocalConfig>` — missing file → `ok({ reviewerExtensions: [] })`

- [ ] **Step 1: Write the failing tests** — append to `tests/config.test.ts` (mirror the file's existing imports; add `loadLocalConfig, localConfigPath, resolveGates, DEFAULT_REVIEWER_TIMEOUT_MS` to the `../src/config.js` import, and `mkdtempSync`/`mkdirSync`/`writeFileSync`/`join`/`tmpdir` from node if not present):

```ts
describe('resolveGates — reviewerTimeoutMs', () => {
  it('defaults when absent', () => {
    const r = resolveGates({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.reviewerTimeoutMs).toBe(DEFAULT_REVIEWER_TIMEOUT_MS)
    const r2 = resolveGates({ gates: { model: 'claude-fable-5' } })
    if (r2.ok) expect(r2.value.reviewerTimeoutMs).toBe(DEFAULT_REVIEWER_TIMEOUT_MS)
  })

  it('accepts an integer >= 1', () => {
    const r = resolveGates({ gates: { reviewerTimeoutMs: 120000 } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.reviewerTimeoutMs).toBe(120000)
  })

  it('refuses non-integer values', () => {
    for (const bad of ['600000', 0, -1, 1.5]) {
      const r = resolveGates({ gates: { reviewerTimeoutMs: bad } })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.violations[0]).toMatchObject({ field: 'gates.reviewerTimeoutMs', rule: 'invalid' })
    }
  })
})

describe('loadLocalConfig — .witness/config.local.yaml', () => {
  const scratch = () => mkdtempSync(join(tmpdir(), 'witness-local-'))
  const put = (root: string, yaml: string) => {
    mkdirSync(join(root, '.witness'), { recursive: true })
    writeFileSync(localConfigPath(root), yaml)
  }

  it('missing file is all defaults', () => {
    const r = loadLocalConfig(scratch())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ reviewerExtensions: [] })
  })

  it('loads reviewerExtensions and opener', () => {
    const root = scratch()
    put(root, "reviewerExtensions: ['/a/ext', '/b/ext']\nopener: my-open\n")
    const r = loadLocalConfig(root)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ reviewerExtensions: ['/a/ext', '/b/ext'], opener: 'my-open' })
  })

  it('refuses unknown keys — closed set', () => {
    const root = scratch()
    put(root, 'harness: pi\n')
    const r = loadLocalConfig(root)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]).toMatchObject({ rule: 'unknown-local-key', got: 'harness' })
  })

  it('refuses wrong types and unparseable yaml', () => {
    const root = scratch()
    put(root, 'reviewerExtensions: nope\n')
    const r = loadLocalConfig(root)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]).toMatchObject({ field: 'reviewerExtensions', rule: 'invalid' })
    put(root, 'opener: [1, 2\n')
    expect(loadLocalConfig(root).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/config.test.ts` — expected: FAIL (`resolveGates` not exported).

- [ ] **Step 3: Implement in `src/config.ts`.** Add after `resolveImplement` (same shape — it is the pattern being followed):

```ts
export const DEFAULT_REVIEWER_TIMEOUT_MS = 600_000

export interface GatesConfig {
  reviewerTimeoutMs: number
}

// gates.* is otherwise read loosely at its consumers (stagePin); the timeout is
// resolved here, typed, because a typo'd key silently defaulting to ten minutes is
// exactly the ambient-value class row 90 removed from env.
export function resolveGates(raw: Record<string, unknown>): Result<GatesConfig> {
  const conf = raw.gates
  if (conf === undefined) return ok({ reviewerTimeoutMs: DEFAULT_REVIEWER_TIMEOUT_MS })
  if (typeof conf !== 'object' || conf === null || Array.isArray(conf)) {
    return refuse([v('gates', 'invalid', String(conf), 'a map of gate settings')])
  }
  const val = (conf as Record<string, unknown>).reviewerTimeoutMs
  if (val === undefined) return ok({ reviewerTimeoutMs: DEFAULT_REVIEWER_TIMEOUT_MS })
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
    return refuse([v('gates.reviewerTimeoutMs', 'invalid', String(val),
      'an integer >= 1 — milliseconds each reviewer invocation may take')])
  }
  return ok({ reviewerTimeoutMs: val })
}

// Machine facts live in ONE gitignored file with a closed key set (row 90): a key in
// the wrong home refuses, so no repo↔local precedence rule can exist. Deliberately
// NOT wired into loadConfig — same doctrine as harness resolution (row 87): an
// unread key must not brick `witness check`; the four reviewer/opener boundaries
// load it, and check reports its violations as findings.
export interface LocalConfig {
  reviewerExtensions: string[]
  opener?: string
}

const LOCAL_KEYS = ['reviewerExtensions', 'opener'] as const

export const localConfigPath = (root: string) => join(root, '.witness', 'config.local.yaml')

export function loadLocalConfig(root: string): Result<LocalConfig> {
  const p = localConfigPath(root)
  if (!existsSync(p)) return ok({ reviewerExtensions: [] })
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(p, 'utf8'))
  } catch (e) {
    return refuse([v('.witness/config.local.yaml', 'yaml-parse',
      String((e as Error).message).slice(0, 120), 'valid YAML')])
  }
  const obj = (raw ?? {}) as Record<string, unknown>
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return refuse([v('.witness/config.local.yaml', 'invalid', String(obj), 'a map of machine-local keys')])
  }
  const violations: Violation[] = []
  for (const key of Object.keys(obj)) {
    if (!(LOCAL_KEYS as readonly string[]).includes(key)) {
      violations.push(v(key, 'unknown-local-key', key,
        `a machine-local key (${LOCAL_KEYS.join(' | ')}) — repo facts belong in witness.config.yaml`))
    }
  }
  let reviewerExtensions: string[] = []
  const ext = obj.reviewerExtensions
  if (ext !== undefined) {
    if (!Array.isArray(ext) || !ext.every((x) => typeof x === 'string' && x !== '')) {
      violations.push(v('reviewerExtensions', 'invalid', JSON.stringify(ext),
        'a list of extension paths handed to the harness reviewer spawn'))
    } else {
      reviewerExtensions = ext as string[]
    }
  }
  let opener: string | undefined
  if (obj.opener !== undefined) {
    if (typeof obj.opener !== 'string' || obj.opener === '') {
      violations.push(v('opener', 'invalid', String(obj.opener), 'a command name or path'))
    } else {
      opener = obj.opener
    }
  }
  if (violations.length) return refuse(violations)
  return ok({ reviewerExtensions, ...(opener !== undefined ? { opener } : {}) })
}
```

Then wire `gates` into `Config`: add `gates: GatesConfig` to the `Config` interface, and in `loadConfig` after the `implement` resolution add:

```ts
  const gates = resolveGates(obj)
  if (!gates.ok) return refuse(gates.violations)
```

and `gates: gates.value,` to the returned `ok({...})` object.

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run tests/config.test.ts` then `pnpm typecheck`. Expected: PASS, no type errors (nothing consumes `Config.gates` yet).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): gates.reviewerTimeoutMs + machine-local config loader (.witness/config.local.yaml)"
```

---

### Task 2: Remove the `WITNESS_HARNESS` env rung (breaking)

**Files:**

- Modify: `src/harness.ts` (resolveHarness, `HarnessSource`, delete `relabel`)
- Modify: `src/verbs/init.ts:84-94` (`--agent` no longer fakes an env)
- Modify: `tests/helpers.ts:55-58` (cli base env scrubs detection vars)
- Modify: `tests/harness.test.ts` (resolution describe), `tests/next.test.ts`, `tests/check.test.ts`, `tests/gate-engine.test.ts`, `tests/dispatch-relay.test.ts`, `tests/init-agent.test.ts`, `tests/design-open.test.ts` (whichever of these carry `WITNESS_HARNESS` — enumerate by grep in Step 1)

**Interfaces:**

- Consumes: `loadHarness(name): Result<Harness>` (existing).
- Produces: `resolveHarness(env, raw)` with rungs **detected → config → default** only; `export type HarnessSource = 'detected' | 'config' | 'default'`. Test convention consumed by ALL later tasks: select pi with `PI_CODING_AGENT: 'true'`, claude-code with `CLAUDECODE: '1'`, in `opts.env`.

- [ ] **Step 1: Enumerate every site** — `rg -n "WITNESS_HARNESS" src/ tests/ README.md`. Convert tests by this mapping (mechanical; the README row is Task 8's):
  - `WITNESS_HARNESS: 'claude-code'` → `CLAUDECODE: '1'`
  - `WITNESS_HARNESS: 'pi'` → `PI_CODING_AGENT: 'true'`
  - `WITNESS_HARNESS: 'pikachu'` (tests/next.test.ts:82) → drop the env; instead append `harness: pikachu\n` to the fixture's `witness.config.yaml` before the cli call (`repo.write('witness.config.yaml', repo.read('witness.config.yaml') + 'harness: pikachu\n')`), and change the expected refusal field from `WITNESS_HARNESS` to `harness`.

- [ ] **Step 2: Rewrite the resolution unit tests** in `tests/harness.test.ts`. Rename the describe `'harness resolution — five rungs'` → `'harness resolution — three rungs'`. Delete the `'WITNESS_HARNESS outranks detection'` test and the `{ WITNESS_HARNESS: 'nope' }` invalid-env case. Add:

```ts
  it('WITNESS_HARNESS is dead — row 90: configuration has one home', () => {
    const r = resolveHarness({ WITNESS_HARNESS: 'pi' }, {})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toMatchObject({ harness: { name: 'claude-code' }, source: 'default' })
    const detected = resolveHarness({ WITNESS_HARNESS: 'claude-code', PI_CODING_AGENT: 'true' }, {})
    if (detected.ok) expect(detected.value.source).toBe('detected')
  })
```

Keep the existing detection/config/default cases (lines 43-72 shapes) unchanged.

- [ ] **Step 3: Run to verify failure** — `pnpm vitest run tests/harness.test.ts` — expected: FAIL (env rung still wins).

- [ ] **Step 4: Implement.** In `src/harness.ts`:
  1. `export type HarnessSource = 'detected' | 'config' | 'default'`
  2. Delete the `relabel` helper (its only caller dies here; verify with `rg -n "relabel" src/`).
  3. In `resolveHarness`, delete the `env.WITNESS_HARNESS` block (the first `if`), leaving detection → config → default.
  4. Update the doc comment above `resolveHarness`: keep the Decision 5 detection-authority text, append one sentence: `// Row 90 removed the WITNESS_HARNESS env rung: configuration has one home, and tests simulate harnesses by setting the detection vars production actually reads.`

  In `src/verbs/init.ts`, replace the `--agent` resolution (current lines 84-94, the block reading `const hxR = agent === 'auto' ? resolveHarness(ctx.env, {}) : resolveHarness({ WITNESS_HARNESS: agent }, {})`) with:

```ts
    // `auto` is the one value that consults the detection rungs; a named agent is a
    // claim and refuses when false, listing the harnesses that exist (row 90: no env
    // impersonation — a name resolves through the registry directly).
    const hxR = agent === 'auto' ? resolveHarness(ctx.env, {}) : loadHarness(agent)
    if (!hxR.ok) {
      renderRefusal(hxR.violations.map((x) => ({ ...x, field: '--agent' }))).forEach(ctx.err)
      return EXIT.REFUSED
    }
    harness = 'harness' in hxR.value ? hxR.value.harness : hxR.value
```

  (Add `loadHarness` to the import from `../harness.js`. The `'harness' in` discrimination handles the two result shapes; if the surrounding code destructures differently, preserve its variable names exactly.)

  In `tests/helpers.ts`, replace the cli ctx env line and its comment:

```ts
      // Detection vars scrubbed AFTER process.env and BEFORE opts.env: the ambient
      // session's CLAUDECODE/PI_CODING_AGENT must not decide what `next` renders
      // (this suite dogfoods under pi), and a harness test asks for one by setting
      // the SAME detection var production reads — row 90 killed the env override.
      env: { ...process.env, PI_CODING_AGENT: undefined, CLAUDECODE: undefined, ...opts.env },
```

- [ ] **Step 5: Apply the Step-1 mapping to every test site**, then run the full suite — `pnpm test`. Expected: PASS. If a protocol-tier test flips harness unexpectedly, its fixture leaked a detection var through `opts.env` — fix the fixture, not helpers.

- [ ] **Step 6: Commit**

```bash
git add src/harness.ts src/verbs/init.ts tests/
git commit -m "feat(harness)!: drop the WITNESS_HARNESS env rung — detected → config → default"
```

---

### Task 3: pi spawn gains declared extensions + the accurate extra-usage refusal

**Files:**

- Modify: `src/harness.ts` (Harness interface, both `reviewer.spawn` impls, `parsePiEnvelope`, lane comments)
- Test: `tests/harness.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `Harness.reviewer.spawn(pin: ParsedPin | undefined, extensions?: readonly string[]): ReviewerSpawn`. pi argv order: `-p --mode json --no-session --no-extensions [-e <path>]... --no-skills --no-context-files --thinking <level> [--model <p>/<m>]`. claude-code ignores `extensions`.

- [ ] **Step 1: Write the failing tests** — in `tests/harness.test.ts`, next to the existing pi spawn test:

```ts
  it('pi renders declared extensions as -e paths INSIDE the hermetic flag set — row 89', () => {
    const s = pi.reviewer.spawn({ provider: undefined, model: 'claude-fable-5', thinking: 'off' },
      ['/home/u/.pi/agent/npm/node_modules/pi-claude-oauth-adapter'])
    expect(s.args).toEqual(['-p', '--mode', 'json', '--no-session', '--no-extensions',
      '-e', '/home/u/.pi/agent/npm/node_modules/pi-claude-oauth-adapter',
      '--no-skills', '--no-context-files', '--thinking', 'off', '--model', 'anthropic/claude-fable-5'])
    // claude-code accepts and ignores the param — the key is machine config, pi-only in effect
    const c = hx('claude-code').reviewer.spawn(undefined, ['/anything'])
    expect(c.args).not.toContain('-e')
  })

  it('pi maps the extra-usage 400 to the extensions remedy, other provider errors unchanged', () => {
    const end = (errorMessage: string) => JSON.stringify({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage }],
    })
    const oauth = pi.reviewer.parseEnvelope(end('400 {"type":"error","error":{"message":"Third-party apps now draw from your extra usage, not your plan limits."}}'))
    expect(oauth.ok).toBe(false)
    if (!oauth.ok) expect(oauth.violations[0]!.want).toContain('.witness/config.local.yaml')
    const other = pi.reviewer.parseEnvelope(end('529 overloaded'))
    if (!other.ok) expect(other.violations[0]!.want).toContain('check auth and billing')
  })
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/harness.test.ts` — expected: FAIL (spawn takes one arg; both envelope errors share one want).

- [ ] **Step 3: Implement in `src/harness.ts`.**
  1. Interface: `spawn(pin: ParsedPin | undefined, extensions?: readonly string[]): ReviewerSpawn`
  2. pi impl:

```ts
    reviewer: {
      spawn(pin: ParsedPin | undefined, extensions?: readonly string[]): ReviewerSpawn {
        const args = ['-p', '--mode', 'json', '--no-session', '--no-extensions']
        // Declared machine extensions ride INSIDE the hermetic set (row 89): pi's
        // --no-extensions disables discovery but explicit -e paths still load, so
        // auth-supplying adapters work without readmitting ambient machine state.
        for (const e of extensions ?? []) args.push('-e', e)
        args.push('--no-skills', '--no-context-files', '--thinking', pin?.thinking ?? 'off')
        if (pin !== undefined) args.push('--model', `${pin.provider ?? 'anthropic'}/${pin.model}`)
        return { cmd: 'pi', args, env: {} }
      },
      parseEnvelope: parsePiEnvelope,
    },
```

  1. claude-code impl signature becomes `spawn(pin: ParsedPin | undefined, _extensions?: readonly string[]): ReviewerSpawn` (body unchanged).
  2. `parsePiEnvelope` error branch:

```ts
  const assistant = end?.messages?.filter((m) => m.role === 'assistant').at(-1)
  if (assistant?.stopReason === 'error') {
    const msg = (assistant.errorMessage ?? 'provider error').slice(0, 200)
    // Anthropic's extra-usage 400 against subscription OAuth is the hermetic spawn
    // disabling an auth-supplying extension, NOT an auth/billing problem — the old
    // want text cost a real user rounds of re-login (row 89 overturned row 88's
    // billing-asymmetry residual on this evidence).
    if (/Third-party apps|extra usage/i.test(msg)) {
      return refuse([v('pi', 'reviewer-invocation', msg,
        'a credential headless pi can use — the reviewer runs hermetic (--no-extensions); if your provider auth is supplied by a pi extension, declare its path in .witness/config.local.yaml reviewerExtensions')])
    }
    return refuse([v('pi', 'reviewer-invocation', msg,
      'a provider the pinned model can reach — check auth and billing for that provider')])
  }
```

  1. Update the comment above the pi `reviewer:` block: keep the Decision 88 hermetic rationale, append: `// Declared reviewerExtensions (machine config) are the ONE sanctioned readmission — auth transport, journaled per gate-run, never part of the verdict-cache key. The worker below keeps full discovery on purpose: skills and context files are what the implement seed measures; auth extensions ride along with everything else there.`

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run tests/harness.test.ts tests/reviewer.test.ts` (the second must stay green: existing exact-argv assertions are unchanged when no extensions are passed). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness.ts tests/harness.test.ts
git commit -m "feat(harness): declared reviewer extensions ride the hermetic pi spawn; accurate extra-usage refusal"
```

---

### Task 4: `invokeReviewer` threads `{timeoutMs, extensions}`; `WITNESS_REVIEWER_TIMEOUT_MS` dies (breaking)

**Files:**

- Modify: `src/reviewer.ts` (`InvokeOpts`, `invokeReviewer`, timeout refusal text)
- Test: `tests/reviewer.test.ts`

**Interfaces:**

- Consumes: `spawn(pin, extensions?)` from Task 3.
- Produces: `export interface InvokeOpts { cwd: string; prompt: string; model?: string; timeoutMs?: number; extensions?: readonly string[] }` and `export interface InvokeExtras { timeoutMs?: number; extensions?: readonly string[] }` (Task 5 threads `InvokeExtras` through calibrate).

- [ ] **Step 1: Write the failing test** — in `tests/reviewer.test.ts`, clone the existing fake-pi invocation test (the one asserting `pi-calls/call-1/argv`, reviewer.test.ts:~100) as a new `it`, with two changes — pass extensions and assert them:

```ts
  it('threads declared extensions into the pi argv', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, piHarness, {
      cwd: repo.root, prompt: 'LENS\nBODY', model: 'google/gemini-3.6-pro:low',
      extensions: ['/opt/pi/oauth-adapter'],
    })
    expect(r.ok).toBe(true)
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('-e\n/opt/pi/oauth-adapter')
    expect(argv).toContain('--no-extensions')
  })
```

(`piHarness`, `fakeCtx`, `gateEnv`, `putVerdict`, `fakeScenario` all exist in the file already — reuse its exact import list.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/reviewer.test.ts` — expected: FAIL (`extensions` not in `InvokeOpts`, argv lacks `-e`).

- [ ] **Step 3: Implement in `src/reviewer.ts`:**

```ts
export interface InvokeExtras {
  timeoutMs?: number
  extensions?: readonly string[]
}

export interface InvokeOpts extends InvokeExtras { cwd: string; prompt: string; model?: string }
```

In `invokeReviewer`:

- `const { cmd, args, env } = harness.reviewer.spawn(pin, opts.extensions)`
- `const timeout = opts.timeoutMs ?? REVIEWER_TIMEOUT_MS` (delete the `ctx.env.WITNESS_REVIEWER_TIMEOUT_MS` read — row 90; callers resolve `gates.reviewerTimeoutMs`)
- Timeout refusal want-text becomes: `'a reviewer that answers within the timeout — raise gates.reviewerTimeoutMs in witness.config.yaml if the model is simply slow'`

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run tests/reviewer.test.ts` then `pnpm typecheck` (callers pass fewer fields than `InvokeOpts` allows — optional, so no errors). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reviewer.ts tests/reviewer.test.ts
git commit -m "feat(reviewer)!: thread timeoutMs + extensions through InvokeOpts; retire WITNESS_REVIEWER_TIMEOUT_MS"
```

---

### Task 5: Resolve at the four verb boundaries; journal `reviewer_extensions`

**Files:**

- Modify: `src/gate.ts` (~line 198 harness block, ~272 call, ~344 entry), `src/rounds.ts` (`GateRunEntry`), `src/drift.ts` (~118-128), `src/calibrate.ts` (6 signatures: `runSample`, `runReviewerSuite`, `runReviewerSuites`, `runDecomposeSeed`, `runPlanSeed`, `runSkillSuites`), `src/verbs/calibrate.ts` (~74-88)
- Test: `tests/gate-engine.test.ts`

**Interfaces:**

- Consumes: `loadLocalConfig`, `Config.gates.reviewerTimeoutMs` (Task 1), `InvokeExtras` (Task 4).
- Produces: `GateRunEntry.reviewer_extensions?: string[]`; every `invokeReviewer` call site passes `timeoutMs` and `extensions`.

- [ ] **Step 1: Write the failing test** — in `tests/gate-engine.test.ts`, locate the simplest passing pi-harness gate test (after Task 2 it sets `PI_CODING_AGENT: 'true'` and uses `putVerdict` + `gateEnv`; the 2026-07-31 plan built it as "clone the file's simplest passing-gate scenario"). Duplicate that `it` under the name below, add the local-config write before the gate call, and append the two assertions after its existing outcome assertion — keep every setup line identical to the donor test:

```ts
  it('declared reviewerExtensions reach the pi argv and the gate-run journal entry', async () => {
    // ...donor scenario setup, verbatim, through putVerdict(...)...
    repo.write('.witness/config.local.yaml', "reviewerExtensions: ['/opt/pi/oauth-adapter']\n")
    // ...donor gate invocation line, verbatim...
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('-e\n/opt/pi/oauth-adapter')
    const entries = repo.read(`.witness/journal/${'<donor artifact id>'}`)
      .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const run = entries.filter((e) => e.t === 'gate-run').at(-1)!
    expect(run.reviewer_extensions).toEqual(['/opt/pi/oauth-adapter'])
  })
```

(Substitute the donor's actual artifact id and variable names — the journal stream file is named by the artifact id, NDJSON, one entry per line.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/gate-engine.test.ts` — expected: FAIL (no `-e` in argv, no `reviewer_extensions` field).

- [ ] **Step 3: Implement.**

  `src/rounds.ts` — in `GateRunEntry`, after `harness?: string` (keeping its comment style):

```ts
  // Optional: machine extensions declared for the reviewer spawn (row 89). Journaled
  // for auditability; deliberately NOT part of the verdict-cache key — auth transport
  // is not reviewer identity, and keying on it would fragment verdicts across
  // teammates' auth setups.
  reviewer_extensions?: string[]
```

  `src/gate.ts` — after the harness resolution block (`const harness = hxR.value.harness`):

```ts
  const localR = loadLocalConfig(root)
  if (!localR.ok) { renderRefusal(localR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const extras = {
    timeoutMs: cfgR.value.gates.reviewerTimeoutMs,
    extensions: localR.value.reviewerExtensions,
  }
```

  At the `invokeReviewer` call (~272): `invokeReviewer(ctx, harness, { cwd: root, prompt, model: id === SESSION_DEFAULT ? undefined : id, ...extras })`.

  In the `GateRunEntry` construction (~344), after the `calibration:` field line, add:

```ts
      ...(localR.value.reviewerExtensions.length ? { reviewer_extensions: localR.value.reviewerExtensions } : {}),
```

  Import `loadLocalConfig` from `./config.js`.

  `src/drift.ts` — after the `hxR` block in the deep lane:

```ts
  const localR = loadLocalConfig(root)
  if (!localR.ok) { renderRefusal(localR.violations).forEach(ctx.err); return EXIT.REFUSED }
```

  and the call becomes:

```ts
  const invoked = invokeReviewer(ctx, hxR.value.harness, {
    cwd: root, prompt,
    timeoutMs: cfgR.ok ? cfgR.value.gates.reviewerTimeoutMs : undefined,
    extensions: localR.value.reviewerExtensions,
  })
```

  (Repo config may be broken here by design — timeout falls to the default; a broken LOCAL file refuses, because silently dropping declared extensions reproduces the exact misdiagnosed 400 this release exists to kill.)

  `src/calibrate.ts` — add `import type { InvokeExtras } from './reviewer.js'`, then append a trailing optional `extras?: InvokeExtras` parameter to `runSample`, `runReviewerSuite`, `runReviewerSuites`, `runDecomposeSeed`, `runPlanSeed`; inside each, forward it (`runSample(ctx, harness, model, lens, suite, seed.overlay, extras)` etc.), and at each of the three `invokeReviewer` sites spread it into the opts object (`{ cwd: dir, prompt, model, ...extras }`). For `runSkillSuites` extend its options object type with `extras?: InvokeExtras` and forward to `runDecomposeSeed`/`runPlanSeed`.

  `src/verbs/calibrate.ts` — after the `cfgR`/`hxR` block (~74-78):

```ts
  const localR = loadLocalConfig(rootR.value)
  if (!localR.ok) { for (const line of renderRefusal(localR.violations)) ctx.err(line); return EXIT.REFUSED }
  const extras = {
    timeoutMs: cfgR.ok ? cfgR.value.gates.reviewerTimeoutMs : undefined,
    extensions: localR.value.reviewerExtensions,
  }
```

  and pass `extras` at line ~82 (`runReviewerSuites(ctx, harness, model, flags.samples, reviewerOnly, extras)`) and inside the options object at ~87 (`runSkillSuites(ctx, harness, model, flags.samples, { only: skillOnly, extras })`). Calibration measuring through the same spawn as the gate battery is a row 88 requirement — do not skip these two.

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run tests/gate-engine.test.ts tests/calibrate.test.ts tests/drift.test.ts` then `pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts src/rounds.ts src/drift.ts src/calibrate.ts src/verbs/calibrate.ts tests/gate-engine.test.ts
git commit -m "feat(gates): resolve machine extensions + timeout at verb boundaries; journal reviewer_extensions"
```

---

### Task 6: Opener moves to machine config; `WITNESS_OPENER` dies (breaking)

**Files:**

- Modify: `src/opener.ts` (signature + comment), `src/verbs/design.ts` (`openOnly` ~70-92), `plugin/skills/witness-design/SKILL.md:72`
- Modify: `tests/helpers.ts` (`fixtureEnv`, `witnessDesign`, new `writeLocalConfig`), `tests/opener.test.ts`, `tests/design-open.test.ts`, every other test touching `WITNESS_OPENER` or `--open`
- Test: `tests/opener.test.ts`, `tests/design-open.test.ts`

**Interfaces:**

- Consumes: `loadLocalConfig` (Task 1).
- Produces: `openArtifact(opener: string | undefined, absPath: string)`; helper `writeLocalConfig(root: string, opts: { opener?: string; reviewerExtensions?: string[] }): void` in `tests/helpers.ts`.

- [ ] **Step 1: Write the failing tests.** In `tests/opener.test.ts`, update every `openArtifact({ WITNESS_OPENER: x }, path)` call to `openArtifact(x, path)` and every `openArtifact({}, path)` / env-less call to `openArtifact(undefined, path)`, preserving each test's assertion. In `tests/design-open.test.ts`, replace `{ env: { WITNESS_OPENER: recorder } }`-style plumbing with a local-config write before the cli call:

```ts
    writeLocalConfig(repo.root, { opener: recorder })
    const r = await repo.cli(['design', specId, '--open'])
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/opener.test.ts tests/design-open.test.ts` — expected: FAIL (signature mismatch / opener not found).

- [ ] **Step 3: Implement.**

  `src/opener.ts` — signature and comment:

```ts
// Show a file to the human. Returns the resolved command alongside the outcome so the
// caller can journal WHAT was run — a degenerate opener (`opener: /usr/bin/true` in
// .witness/config.local.yaml) then reads as a degenerate opener in the record instead
// of as a human looking at a screen. `opener` is the machine-config value (row 90 —
// nonstandard desktops declare it there; tests inject it as a parameter), a bare name
// off PATH or a path.
export function openArtifact(
  opener: string | undefined, absPath: string,
): { outcome: OpenOutcome; command: string } {
  const argv = opener !== undefined && opener !== '' ? [opener] : platformOpener()
```

  (rest of the body unchanged).

  `src/verbs/design.ts` — in `openOnly`, before the `openArtifact` call:

```ts
  const localR = loadLocalConfig(root)
  if (!localR.ok) { renderRefusal(localR.violations).forEach(ctx.err); return EXIT.REFUSED }
  const { outcome, command } = openArtifact(localR.value.opener, abs)
```

  and the `opener-failed` want-text becomes: `` `a working platform opener, or opener: in .witness/config.local.yaml — meanwhile open it yourself: file://${abs}` ``. Import `loadLocalConfig` from `../config.js`.

  `plugin/skills/witness-design/SKILL.md:72` — replace the `WITNESS_OPENER` clause: `…do not work around it by pointing \`opener:\` in \`.witness/config.local.yaml\` at something that does not show anything.`

  `tests/helpers.ts` —

```ts
export function writeLocalConfig(root: string, opts: { opener?: string; reviewerExtensions?: string[] } = {}): void {
  mkdirSync(join(root, '.witness'), { recursive: true })
  const lines: string[] = []
  if (opts.opener !== undefined) lines.push(`opener: '${opts.opener}'`)
  if (opts.reviewerExtensions !== undefined) {
    lines.push(`reviewerExtensions: [${opts.reviewerExtensions.map((x) => `'${x}'`).join(', ')}]`)
  }
  writeFileSync(join(root, '.witness', 'config.local.yaml'), `${lines.join('\n')}\n`)
}
```

  Delete `WITNESS_OPENER: noopOpener(),` from `fixtureEnv`. Rewrite `witnessDesign`:

```ts
// Register → show. The protocol's normal prelude to `gate design`, as one call. The
// noop opener rides machine config now (row 90) — without it, --open would spawn the
// REAL platform opener from a test.
export async function witnessDesign(repo: TestRepo, specId: string): Promise<CliResult> {
  writeLocalConfig(repo.root, { opener: noopOpener() })
  return repo.cli(['design', specId, '--open'])
}
```

- [ ] **Step 4: Audit every `--open` in tests** — `rg -n '\-\-open' tests/` — each hit must either go through `witnessDesign` or be preceded by `writeLocalConfig(root, { opener: … })`. A test that reaches `--open` with no local config would launch the machine's real GUI opener; that is a test bug, fix it here.

- [ ] **Step 5: Run to verify pass** — `pnpm vitest run tests/opener.test.ts tests/design-open.test.ts tests/design-gate-sight.test.ts tests/design-unseen.test.ts tests/design-verb.test.ts` then `pnpm test`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/opener.ts src/verbs/design.ts plugin/skills/witness-design/SKILL.md tests/
git commit -m "feat(opener)!: opener moves to machine config; WITNESS_OPENER dies"
```

---

### Task 7: `check` findings for local config; scaffold updates

**Files:**

- Modify: `src/verbs/check.ts` (findings, after the `cfg` block ~44-46), `src/verbs/init.ts` (`GITIGNORE_BLOCK`, `DEFAULT_CONFIG`)
- Test: `tests/check.test.ts`, `tests/init.test.ts`

**Interfaces:**

- Consumes: `loadLocalConfig`, `localConfigPath` (Task 1), `tryGit` from `../gitio.js` (existing), `f(level, area, field, rule, detail)` (existing in check.ts).
- Produces: findings area `local-config`, rules `extension-path-missing`, `local-config-unignored`, plus the loader's own violation rules surfaced as `error` findings.

- [ ] **Step 1: Write the failing tests** — append to `tests/check.test.ts` (reuse its `tmpRepo`/cli patterns):

```ts
  it('reports malformed local config as findings, not a refusal', async () => {
    const repo = await tmpRepo()
    repo.write('.witness/config.local.yaml', 'harness: pi\n')
    const r = await repo.cli(['check'])
    expect(r.stdout).toContain('unknown-local-key')
    expect(r.code).not.toBe(EXIT.REFUSED)
  })

  it('warns on a declared extension path that does not exist', async () => {
    const repo = await tmpRepo()
    repo.write('.witness/config.local.yaml', "reviewerExtensions: ['/nope/missing-ext']\n")
    const r = await repo.cli(['check'])
    expect(r.stdout).toContain('extension-path-missing')
  })

  it('warns when the local config file is not git-ignored (pre-0.5.0 scaffolds)', async () => {
    const repo = await tmpRepo()
    repo.write('.gitignore', '.witness/lock\n')  // old block, no config.local.yaml line
    repo.write('.witness/config.local.yaml', "opener: '/usr/bin/true'\n")
    const r = await repo.cli(['check'])
    expect(r.stdout).toContain('local-config-unignored')
  })
```

  (Match the file's existing assertion idiom for findings — if it asserts via rendered rows rather than raw stdout, mirror that. If `tmpRepo` scaffolds a `.gitignore` that already ignores the file, overwrite it as shown.)

  And in `tests/init.test.ts`, extend the gitignore assertion to include `.witness/config.local.yaml`.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/check.test.ts tests/init.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement.**

  `src/verbs/check.ts` — after the `cfg` findings block (~46), add (ensure `existsSync`, `loadLocalConfig`, `localConfigPath`, `tryGit` are imported):

```ts
  // Machine config is read here as FINDINGS, never a refusal — same doctrine that
  // keeps harness resolution out of loadConfig (row 87): check must be able to
  // report a broken machine file rather than brick on it.
  const local = loadLocalConfig(root)
  if (!local.ok) {
    local.violations.forEach((x) => findings.push(f('error', 'local-config', x.field, x.rule, x.got)))
  } else {
    for (const p of local.value.reviewerExtensions) {
      if (!existsSync(p)) findings.push(f('warn', 'local-config', 'reviewerExtensions', 'extension-path-missing', p))
    }
  }
  // init's gitignore write is scaffold-once, so pre-0.5.0 repos never receive the new
  // ignore line — this finding is their honest path to it.
  if (existsSync(localConfigPath(root)) && !tryGit(root, 'check-ignore', '-q', '--', '.witness/config.local.yaml').ok) {
    findings.push(f('warn', 'local-config', '.witness/config.local.yaml', 'local-config-unignored',
      'machine-local file — add it to .gitignore'))
  }
```

  `src/verbs/init.ts` — `GITIGNORE_BLOCK` gains a line after `.witness/calibration.local.yaml`:

```
.witness/config.local.yaml
```

  `DEFAULT_CONFIG`, inside the `gates:` block after the `model:` line:

```
  # reviewerTimeoutMs: 600000  # ms per reviewer invocation (machine auth/extension knobs live in .witness/config.local.yaml)
```

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run tests/check.test.ts tests/init.test.ts` then `pnpm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/check.ts src/verbs/init.ts tests/check.test.ts tests/init.test.ts
git commit -m "feat(check): local-config findings (malformed / missing extension path / unignored) + scaffold updates"
```

---

### Task 8: Docs, DESIGN.md rows 89–90, version 0.5.0

**Files:**

- Modify: `README.md` (~lines 100-112 + config-keys table), `DESIGN.md` (status line, rows 87/88 annotations, new rows 89/90), `package.json` (version)
- Run: `pnpm sync-versions` (restamps `@popovych.co/witness@<v>` pins across plugin payloads)

- [ ] **Step 1: README.** Replace the ladder row (line ~104):

```markdown
| `harness: claude-code \| pi` | fallback used only when detection cannot answer. Order: `PI_CODING_AGENT` → `CLAUDECODE` → `harness:` → `claude-code` |
```

Add to the same table:

```markdown
| `gates.reviewerTimeoutMs` | milliseconds per reviewer invocation (default 600000) |
```

Replace the stale paragraph below the table (the one beginning `There is no \`provider:\` key.` and claiming `witness gate spawns the Claude CLI for every reviewer on every harness`) with:

```markdown
There is no `provider:` key. `witness gate` spawns the RESOLVED harness's headless
mode for every reviewer (Decision 88): claude-code renders bare Anthropic ids, pi
renders `provider/model[:thinking]` with the provider witness knows it needs. The pi
reviewer runs hermetic (`--no-extensions --no-skills --no-context-files`); machine
extensions it must keep — e.g. an OAuth adapter that supplies your Anthropic auth —
are declared in machine config, not env:

​```yaml
# .witness/config.local.yaml — machine facts, gitignored, never committed
reviewerExtensions:
  - /Users/you/.pi/agent/npm/node_modules/pi-claude-oauth-adapter
opener: xdg-open   # optional; nonstandard desktops only
​```

Repo facts live in `witness.config.yaml` (committed); machine facts live in
`.witness/config.local.yaml` (gitignored). Every key has exactly one home — a key in
the wrong file refuses. There are no `WITNESS_*` env vars for configuration.
```

(Remove the zero-width characters around the inner fence markers when pasting.)

- [ ] **Step 2: DESIGN.md.** Verify the mark is unused (`rg -c "⟐" DESIGN.md` → no matches; if taken, pick another unused glyph and use it consistently below).
  1. Append to the end of the `> Status:` line (line 5): ` **2026-07-31 amendment (⟐):** rows 89–90 — **reviewer extensions via machine config** (89: pi's hermetic reviewer spawn readmits ONLY paths declared in gitignored `.witness/config.local.yaml` `reviewerExtensions`, rendered`-e <path>` after `--no-extensions`; the extra-usage 400 gets an accurate refusal; overturns row 88's billing-asymmetry residual — a flag bisect proved the 400 self-inflicted) and **configuration single-home** (90: the`WITNESS_HARNESS` / `WITNESS_REVIEWER_TIMEOUT_MS` / `WITNESS_OPENER` env knobs die — timeout becomes `gates.reviewerTimeoutMs`, opener becomes machine config; env keeps external facts, consent, seams and outputs; amends row 87's ladder).`
  2. Row 87: replace the substring `` (`WITNESS_HARNESS` → `PI_CODING_AGENT` → `CLAUDECODE` → `harness:` → `claude-code`) `` with `` (`PI_CODING_AGENT` → `CLAUDECODE` → `harness:` → `claude-code`; ⟐90 removed the `WITNESS_HARNESS` env rung) ``.
  3. Row 88: after the substring `and the remedy is the user's provider choice, not witness's`, insert ` (overturned by ⟐89: the 400 was self-inflicted — `--no-extensions` had disabled the machine's auth-supplying OAuth adapter; the same call succeeds with the adapter re-admitted via `-e`)`.
  4. Append rows 89 and 90 after row 88 in the decision table, in the table's three-column format (decision | mechanism | rationale):

```markdown
| 89 ⟐ | Machine auth extensions are declared, not ambient — and not banished | The pi reviewer spawn stays hermetic (88) but readmits explicitly declared extension paths: `.witness/config.local.yaml` `reviewerExtensions` renders as `-e <path>` after `--no-extensions` (pi documents that explicit `-e` survives discovery-off; verified live — the exact reviewer argv 400s without the adapter and answers with it). Declared paths are journaled per gate-run (`reviewer_extensions`) and deliberately excluded from the verdict-cache key: auth transport is not reviewer identity, and keying on it would fragment verdicts across teammates' auth setups — the journal keeps divergence auditable. `parsePiEnvelope` maps the extra-usage 400 signature to a refusal naming the real remedy; `check` warns on declared-but-missing paths. The worker lane is untouched: it keeps full discovery on purpose (skills and context files are what the implement seed measures), so the two lanes now differ by declared design rather than by accident | Row 88 observed this exact 400 during its probe and accepted it as Anthropic structurally privileging `claude -p` — "the remedy is the user's provider choice". A production outage (every gate refused; the misdiagnosed want-text sent the user through rounds of re-login and balance checks) forced a flag bisect that overturned the residual: `--no-extensions` alone flips the result, because it disables the machine's `pi-claude-oauth-adapter`, without which pi falls back to raw subscription-OAuth that Anthropic rejects for third-party apps. Rejected: dropping `--no-extensions` (reopens 88's ambient-behavior hole — a machine's `defaultThinkingLevel: xhigh` was a real incident), an env var (row 90), and repo-config declaration (extension paths are machine facts; committing `/Users/...` breaks every other machine, and resolving `npm:` names would couple witness to pi's install layout) |
| 90 ⟐ | Configuration has one home per key | Two config files partition the keyspace — `witness.config.yaml` (repo facts, committed) and `.witness/config.local.yaml` (machine facts: `reviewerExtensions`, `opener`; gitignored, closed key set, loaded by a separate `loadLocalConfig` that check surfaces as findings) — with NO merge rule, because no key has two homes. Three env knobs die: `WITNESS_HARNESS` (ladder shrinks to detected → `harness:` → default; `init --agent` resolves through the registry; tests select harnesses by setting the detection vars production reads), `WITNESS_REVIEWER_TIMEOUT_MS` (→ `gates.reviewerTimeoutMs`, typed, refuse-on-invalid), `WITNESS_OPENER` (→ machine `opener`, injected as a parameter). Env retains what is genuinely environmental: external facts (`PI_CODING_AGENT`, `CLAUDECODE`, `CI`, `HOME`), consent (`WITNESS_TRUST_CMDS` — a committed blanket-trust key would let a cloned repo pre-approve arbitrary command execution), output exports (`WITNESS_SCREENS_DIR`, `MAX_THINKING_TOKENS`), and internal seams (`WITNESS_CRASH_AFTER`, `WITNESS_BIN`) | Review of the row-89 fix rejected an env-var mechanism and forced the question the codebase had never answered: where do persistent machine facts live? The env inventory showed no mess — every existing var was an override rung, consent, seam, or export — but also no home for machine facts, which is why an env var kept looking tempting. Precedent generalized: `.witness/calibration.local.yaml` was already this tier, bespoke. One home per key kills the multi-channel debugging question ("where did this value come from") that the row-89 outage demonstrated at its worst |
```

- [ ] **Step 3: Version.** In `package.json` set `"version": "0.5.0"`, run `pnpm sync-versions` (stamps plugin payload pins, including `witness-design/SKILL.md:19`'s `@0.4.1`).

- [ ] **Step 4: Full verification.**

```bash
pnpm typecheck && pnpm test
rg -n "WITNESS_HARNESS|WITNESS_REVIEWER_TIMEOUT_MS|WITNESS_OPENER" src/ plugin/ README.md
```

Expected: suite green; the grep over `src/ plugin/ README.md` returns NOTHING (the only surviving mention of `WITNESS_HARNESS` in the repo is the "WITNESS_HARNESS is dead" tombstone test in `tests/harness.test.ts`, plus DESIGN.md's historical rows — neither path is in the grep). Run project diagnostics (`lens_diagnostics mode=all` if driving from pi) — no blocking errors.

- [ ] **Step 5: Commit**

```bash
git add README.md DESIGN.md package.json plugin/
git commit -m "docs + chore(release)!: config single-home doctrine (rows 89-90), 0.5.0"
```

---

## Post-plan note for the human

After merge, unblock the stuck machine by writing its machine config:

```bash
cat > .witness/config.local.yaml <<'EOF'
reviewerExtensions:
  - /Users/home/.pi/agent/npm/node_modules/pi-claude-oauth-adapter
EOF
witness gate design report-view
```
