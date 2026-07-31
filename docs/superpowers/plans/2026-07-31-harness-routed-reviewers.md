# Harness-Routed Reviewers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gate reviewer lane, calibration, and the `check` probe all spawn the *resolved harness* (claude-code or pi) instead of hard-coding `claude -p` — full routing, no fallback — with a `[provider/]model[:thinking]` pin grammar and per-(harness, model) calibration.

**Architecture:** The harness registry (`src/harness.ts`) grows a per-harness `reviewer` contract: a `spawn(pin)` renderer and a `parseEnvelope(stdout)` parser. `invokeClaude` becomes `invokeReviewer(ctx, harness, opts)` — same timeout/retry loop, harness-supplied command and envelope. The verdict-cache key and gate-run journal entries gain a `harness` field (legacy entries default to `claude-code`). The calibration matrix becomes per-harness (`matrices.<name>.models`, legacy top-level `models:` reads as claude-code). Reviewer spawns on pi are hermetic (`--no-session --no-extensions --no-skills --no-context-files`) with thinking pinned (default `off`).

**Tech Stack:** TypeScript (strict, ESM, Node builtins only — no new runtime deps), vitest, `yaml` package (already a dep), POSIX-sh fake binaries under `fixtures/fakebin/`.

**Design provenance:** Overturns DESIGN.md row 87's four residuals. Decisions locked in the 2026-07-31 design interview: full routing no fallback (Q2); per-(harness, model) matrix with self-calibrate-or-floor-warn (Q3); one pin string `[provider/]model[:thinking]`, bare→harness default provider, provider-qualified refused on claude-code, omitted thinking→`off`, claude-code maps non-off levels to a pinned `MAX_THINKING_TOKENS` table (Q4+Q6); hermetic spawn whose flag set joins the reviewer identity (Q5). Probe evidence: pi `--mode json` emits an NDJSON event stream ending in `agent_end`; provider errors arrive in-stream as `stopReason: "error"` (observed: Anthropic's third-party billing 400), not necessarily as a nonzero exit.

## Global Constraints

- Refusals use the existing `Result` / `refuse([v(field, rule, got, want)])` pattern from `src/refusal.ts` — never throw for user-facing errors.
- No commas inside `kv()` output values (toon `esc()` quotes any value containing one — see `src/harness.ts` relayLine comment).
- `spawnSync` timeout/retry semantics of `invokeClaude` are preserved exactly: `WITNESS_REVIEWER_TIMEOUT_MS` override, 600 000 ms default, 2 retries on ETIMEDOUT only.
- Legacy journal entries (no `harness` field) must keep cache-hitting: absent `harness` reads as `claude-code`.
- Legacy calibration overlays (top-level `models:` list) must keep working: they read as the claude-code matrix.
- The existing `fixtures/fakebin/claude` contract (call recording under `$WITNESS_FAKE_DIR/claude-calls/call-N/{argv,stdin}`, `verdict.json` / `verdict-N.json` bodies, `claude-fail` / `claude-hang` knobs) is mirrored, not changed.
- Conventional commits (`feat:`, `test:`, `docs:`), one commit per task.
- Run a task's named test file with `npx vitest run tests/<file>`; full suite with `npx vitest run`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/pin.ts` (create) | Pin grammar: parse `[provider/]model[:thinking]`, thinking-level vocabulary, claude `MAX_THINKING_TOKENS` budget table. Pure functions, no I/O. |
| `src/harness.ts` (modify) | Per-harness `reviewer` contract (`spawn`, `parseEnvelope`), `validatePin` (harness-compat rules), thinking-aware `modelArg`/`handoffLine`. |
| `src/reviewer.ts` (modify) | `invokeReviewer(ctx, harness, opts)` — harness-agnostic spawn loop; `invokeClaude` shim lives here between Tasks 4 and 7, then dies. |
| `src/model.ts` (modify) | Per-harness matrix loading; `stagePin` validates the new grammar. |
| `src/rounds.ts` (modify) | `harness` in `GateKey`/`GateRunEntry`/`keyOf`/`sameKey` with claude-code default. |
| `src/gate.ts` (modify) | Resolve harness once per gate run; thread to matrix, invoker, cache key, entry, malformed-streak brake. |
| `src/calibrate.ts` + `src/verbs/calibrate.ts` (modify) | Calibration routes through the harness; overlay writes `matrices.<name>.models`. |
| `src/verbs/check.ts` (modify) | Probe the resolved harness launch binary, not hard-coded `claude`. |
| `src/verbs/dashboard.ts` (modify) | Harness-aware matrix load for floor warnings. |
| `fixtures/fakebin/pi` (create) | Protocol-tier fake pi: records calls, answers NDJSON `agent_end` envelopes, `pi-fail`/`pi-hang`/`pi-error` knobs. |
| `DESIGN.md` (modify) | Row 88. |

Dependency order: Task 1 → 2 → 3 → 4 → 5 → 6 → 7; Tasks 8, 9, 10 depend only on Tasks 1–2 and can follow in any order after 7.

---

### Task 1: Pin grammar module

**Files:**

- Create: `src/pin.ts`
- Test: `tests/pin.test.ts`

**Interfaces:**

- Consumes: `ok, refuse, v, Result` from `src/refusal.ts`.
- Produces (later tasks rely on these exact names):
  - `THINKING_LEVELS: readonly ['off','minimal','low','medium','high','xhigh','max']`, `type ThinkingLevel`
  - `interface ParsedPin { provider?: string; model: string; thinking: ThinkingLevel }`
  - `CLAUDE_THINKING_BUDGET: Record<Exclude<ThinkingLevel,'off'>, number>`
  - `parsePin(field: string, raw: string): Result<ParsedPin>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/pin.test.ts
import { describe, expect, it } from 'vitest'
import { CLAUDE_THINKING_BUDGET, parsePin, THINKING_LEVELS } from '../src/pin.js'

describe('parsePin', () => {
  it('parses a bare model id with thinking defaulting to off', () => {
    const r = parsePin('gates.model', 'claude-fable-5')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ provider: undefined, model: 'claude-fable-5', thinking: 'off' })
  })

  it('parses provider-qualified and thinking-suffixed pins', () => {
    const r = parsePin('gates.model', 'google/gemini-3.6-pro:low')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ provider: 'google', model: 'gemini-3.6-pro', thinking: 'low' })
    const bare = parsePin('gates.model', 'claude-fable-5:xhigh')
    expect(bare.ok).toBe(true)
    if (bare.ok) expect(bare.value).toEqual({ provider: undefined, model: 'claude-fable-5', thinking: 'xhigh' })
  })

  it('refuses unknown thinking levels and empty model segments', () => {
    const lvl = parsePin('gates.model', 'claude-fable-5:turbo')
    expect(lvl.ok).toBe(false)
    if (!lvl.ok) expect(lvl.violations[0]!.rule).toBe('unknown-thinking-level')
    for (const bad of ['', ':low', 'google/', 'google/:low']) {
      const r = parsePin('gates.model', bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.violations[0]!.rule).toBe('pin-malformed')
    }
  })

  it('keeps the budget table total over non-off levels', () => {
    for (const level of THINKING_LEVELS) {
      if (level === 'off') continue
      expect(CLAUDE_THINKING_BUDGET[level]).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pin.test.ts`
Expected: FAIL — `Cannot find module '../src/pin.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/pin.ts
import { ok, refuse, v, type Result } from './refusal.js'

// Pi's native --thinking vocabulary. One grammar for every harness: pi renders it
// natively; claude-code maps non-off levels through CLAUDE_THINKING_BUDGET.
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export interface ParsedPin {
  provider?: string        // absent = harness default provider
  model: string            // exact id — aliases are refused upstream (stagePin)
  thinking: ThinkingLevel  // omitted in config = 'off' (deterministic on every harness)
}

// claude has no --thinking flag; non-off levels render as the documented
// MAX_THINKING_TOKENS env var. Budgets are pinned constants: the raw pin string is in
// the verdict-cache key, so a level change re-rolls verdicts; a budget-table change
// ships as a new witness version, which is also in the key.
export const CLAUDE_THINKING_BUDGET: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  minimal: 1024, low: 4096, medium: 8192, high: 16384, xhigh: 32768, max: 63999,
}

// Grammar: [provider/]model[:thinking]. First '/' splits provider; last ':' after the
// slash splits thinking — model ids themselves never contain ':' in any catalog we ship.
export function parsePin(field: string, raw: string): Result<ParsedPin> {
  const slash = raw.indexOf('/')
  const provider = slash > 0 ? raw.slice(0, slash) : undefined
  const rest = slash >= 0 ? raw.slice(slash + 1) : raw
  const colon = rest.lastIndexOf(':')
  const model = colon >= 0 ? rest.slice(0, colon) : rest
  const level = colon >= 0 ? rest.slice(colon + 1) : 'off'
  if (model === '' || (slash >= 0 && provider === undefined)) {
    return refuse([v(field, 'pin-malformed', raw, '[provider/]model[:thinking]')])
  }
  if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
    return refuse([v(field, 'unknown-thinking-level', level, THINKING_LEVELS.join(' | '))])
  }
  return ok({ provider, model, thinking: level as ThinkingLevel })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pin.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/pin.ts tests/pin.test.ts
git commit -m "feat: pin grammar [provider/]model[:thinking] with claude thinking-budget table"
```

---

### Task 2: Per-harness reviewer contract in the registry

**Files:**

- Modify: `src/harness.ts`
- Test: `tests/harness.test.ts` (append a new describe block)

**Interfaces:**

- Consumes: `ParsedPin, CLAUDE_THINKING_BUDGET, parsePin` from Task 1.
- Produces:
  - `Harness.reviewer: { spawn(pin: ParsedPin | undefined): ReviewerSpawn; parseEnvelope(stdout: string): Result<{ text: string }> }`
  - `interface ReviewerSpawn { cmd: string; args: string[]; env: Record<string, string> }`
  - `validatePin(harness: Harness, field: string, raw: string): Result<ParsedPin>`

- [ ] **Step 1: Write the failing test**

Append to `tests/harness.test.ts`:

```ts
import { loadHarness, validatePin } from '../src/harness.js'

describe('reviewer contract', () => {
  const claude = (() => { const r = loadHarness('claude-code'); if (!r.ok) throw new Error('registry'); return r.value })()
  const pi = (() => { const r = loadHarness('pi'); if (!r.ok) throw new Error('registry'); return r.value })()

  it('claude-code spawns claude -p json with model flag and thinking as env budget', () => {
    const s = claude.reviewer.spawn({ provider: undefined, model: 'claude-fable-5', thinking: 'low' })
    expect(s.cmd).toBe('claude')
    expect(s.args).toEqual(['-p', '--output-format', 'json', '--model', 'claude-fable-5'])
    expect(s.env).toEqual({ MAX_THINKING_TOKENS: '4096' })
    const off = claude.reviewer.spawn({ provider: undefined, model: 'claude-fable-5', thinking: 'off' })
    expect(off.env).toEqual({})
    const sessionDefault = claude.reviewer.spawn(undefined)
    expect(sessionDefault.args).toEqual(['-p', '--output-format', 'json'])
  })

  it('pi spawns hermetic print mode with pinned thinking and provider-qualified model', () => {
    const s = pi.reviewer.spawn({ provider: 'google', model: 'gemini-3.6-pro', thinking: 'low' })
    expect(s.cmd).toBe('pi')
    expect(s.args).toEqual(['-p', '--mode', 'json', '--no-session', '--no-extensions',
      '--no-skills', '--no-context-files', '--thinking', 'low', '--model', 'google/gemini-3.6-pro'])
    const bare = pi.reviewer.spawn({ provider: undefined, model: 'claude-fable-5', thinking: 'off' })
    expect(bare.args).toContain('anthropic/claude-fable-5')
    expect(bare.args).toContain('off')
    const sessionDefault = pi.reviewer.spawn(undefined)
    expect(sessionDefault.args).not.toContain('--model')
    expect(sessionDefault.args).toContain('--thinking')
  })

  it('claude-code parses the {result} envelope and pi parses the agent_end event stream', () => {
    const c = claude.reviewer.parseEnvelope(JSON.stringify({ type: 'result', result: 'VERDICT' }))
    expect(c.ok).toBe(true)
    if (c.ok) expect(c.value.text).toBe('VERDICT')
    const stream = [
      JSON.stringify({ type: 'turn_end', message: { role: 'assistant' } }),
      JSON.stringify({ type: 'agent_end', messages: [
        { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'VERDICT' }], stopReason: 'stop' },
      ] }),
      JSON.stringify({ type: 'agent_settled' }),
    ].join('\n')
    const p = pi.reviewer.parseEnvelope(stream)
    expect(p.ok).toBe(true)
    if (p.ok) expect(p.value.text).toBe('VERDICT')
  })

  it('pi surfaces in-stream provider errors as reviewer-invocation refusals', () => {
    const stream = JSON.stringify({ type: 'agent_end', messages: [
      { role: 'assistant', content: [], stopReason: 'error', errorMessage: '400 third-party billing blocked' },
    ] })
    const r = pi.reviewer.parseEnvelope(stream)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations[0]!.rule).toBe('reviewer-invocation')
      expect(r.violations[0]!.got).toContain('billing')
    }
    const empty = pi.reviewer.parseEnvelope('not json at all')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.violations[0]!.rule).toBe('envelope-unparseable')
  })

  it('validatePin refuses provider-qualified pins on claude-code and passes them on pi', () => {
    const bad = validatePin(claude, 'gates.model', 'google/gemini-3.6-pro')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.violations[0]!.rule).toBe('provider-unrunnable')
    expect(validatePin(claude, 'gates.model', 'claude-fable-5:high').ok).toBe(true)
    expect(validatePin(pi, 'gates.model', 'google/gemini-3.6-pro:low').ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/harness.test.ts`
Expected: FAIL — `reviewer` does not exist on `Harness`; `validatePin` not exported.

- [ ] **Step 3: Write the implementation**

In `src/harness.ts`:

3a. Add imports at the top:

```ts
import { CLAUDE_THINKING_BUDGET, parsePin, type ParsedPin } from './pin.js'
```

3b. Extend the `Harness` interface (after the `skills` field):

```ts
export interface ReviewerSpawn { cmd: string; args: string[]; env: Record<string, string> }
```

and inside `interface Harness`:

```ts
  // The judgment lane: how THIS harness runs a headless reviewer and what its stdout
  // means. spawn(undefined) is the session-default rung (no model flag). The exact flag
  // set is part of the reviewer's identity — calibrate measures through the same spawn.
  reviewer: {
    spawn(pin: ParsedPin | undefined): ReviewerSpawn
    parseEnvelope(stdout: string): Result<{ text: string }>
  }
```

3c. Add the two envelope parsers as module-level functions (above `REGISTRY`):

```ts
function parseClaudeEnvelope(stdout: string): Result<{ text: string }> {
  try {
    const envelope = JSON.parse(stdout) as { result?: unknown }
    if (typeof envelope.result !== 'string') throw new Error('missing result')
    return ok({ text: envelope.result })
  } catch {
    return refuse([v('claude', 'envelope-unparseable', stdout.slice(0, 120),
      'a --output-format json envelope carrying a result string')])
  }
}

interface PiMessage {
  role?: string
  content?: Array<{ type?: string; text?: string }>
  stopReason?: string
  errorMessage?: string
}

// pi --mode json emits an NDJSON event stream; the terminal agent_end event carries the
// full message history. Provider failures arrive IN-stream (stopReason: "error") — the
// process can still exit 0, so exit-code checks alone cannot detect them.
function parsePiEnvelope(stdout: string): Result<{ text: string }> {
  let end: { messages?: PiMessage[] } | undefined
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const evt = JSON.parse(line) as { type?: string }
      if (evt.type === 'agent_end') end = evt as { messages?: PiMessage[] }
    } catch { /* interleaved non-JSON output — skip the line, keep scanning */ }
  }
  const assistant = end?.messages?.filter((m) => m.role === 'assistant').at(-1)
  if (assistant?.stopReason === 'error') {
    return refuse([v('pi', 'reviewer-invocation', (assistant.errorMessage ?? 'provider error').slice(0, 200),
      'a provider the pinned model can reach — check auth and billing for that provider')])
  }
  const text = (assistant?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  if (text === '') {
    return refuse([v('pi', 'envelope-unparseable', stdout.slice(0, 120),
      'a --mode json event stream whose agent_end carries assistant text')])
  }
  return ok({ text })
}
```

3d. Add `reviewer` blocks to both `REGISTRY` entries:

For `'claude-code'`:

```ts
    reviewer: {
      spawn(pin: ParsedPin | undefined): ReviewerSpawn {
        const args = ['-p', '--output-format', 'json']
        const env: Record<string, string> = {}
        if (pin !== undefined) {
          args.push('--model', pin.model)
          if (pin.thinking !== 'off') env.MAX_THINKING_TOKENS = String(CLAUDE_THINKING_BUDGET[pin.thinking])
        }
        return { cmd: 'claude', args, env }
      },
      parseEnvelope: parseClaudeEnvelope,
    },
```

For `pi` (hermetic per Q5 — every omitted flag here is a machine-local variable that
would silently change reviewer behavior):

```ts
    reviewer: {
      spawn(pin: ParsedPin | undefined): ReviewerSpawn {
        const args = ['-p', '--mode', 'json', '--no-session', '--no-extensions',
          '--no-skills', '--no-context-files', '--thinking', pin?.thinking ?? 'off']
        if (pin !== undefined) args.push('--model', `${pin.provider ?? 'anthropic'}/${pin.model}`)
        return { cmd: 'pi', args, env: {} }
      },
      parseEnvelope: parsePiEnvelope,
    },
```

3e. Add `validatePin` at the bottom of the file:

```ts
// Harness-compat rung of pin validation. Grammar and alias checks live in stagePin
// (model.ts); THIS check needs the harness, which stagePin deliberately never resolves.
export function validatePin(harness: Harness, field: string, raw: string): Result<ParsedPin> {
  const r = parsePin(field, raw)
  if (!r.ok) return r
  if (harness.name === 'claude-code' && r.value.provider !== undefined) {
    return refuse([v(field, 'provider-unrunnable', raw,
      'a bare model id — the claude CLI cannot run provider-qualified models')])
  }
  return r
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/harness.test.ts`
Expected: PASS (existing tests + 5 new)

- [ ] **Step 5: Commit**

```bash
git add src/harness.ts tests/harness.test.ts
git commit -m "feat: per-harness reviewer spawn/envelope contract and validatePin in the registry"
```

---

### Task 3: Fake pi binary for the protocol tier

**Files:**

- Create: `fixtures/fakebin/pi` (mode 755)
- Test: `tests/fakebin.test.ts` (append a describe block)

**Interfaces:**

- Consumes: the `WITNESS_FAKE_DIR` scenario convention from `fixtures/fakebin/claude` and `tests/helpers.ts` (`fakeScenario()`, `gateEnv()`, `putVerdict()`).
- Produces: `pi-calls/call-N/{argv,stdin}` recordings; NDJSON `agent_end` envelope wrapping `verdict.json` / `verdict-N.json`; knobs `pi-fail` (nonzero exit), `pi-hang` (sleep past timeout), `pi-error` (in-stream `stopReason: "error"` with exit 0 — the billing-block shape).

- [ ] **Step 1: Write the failing test**

Append to `tests/fakebin.test.ts` (mirror the file's existing claude assertions — it drives fakes via `execFileSync` with `gateEnv`):

```ts
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeScenario, gateEnv, putVerdict } from './helpers.js'

describe('fake pi', () => {
  it('records argv+stdin and emits an agent_end NDJSON envelope carrying the verdict', () => {
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const out = execFileSync('pi', ['-p', '--mode', 'json', '--thinking', 'off'], {
      env: gateEnv(scenario) as NodeJS.ProcessEnv, input: 'PROMPT BODY', encoding: 'utf8',
    })
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as { type: string })
    expect(lines.at(-1)!.type).toBe('agent_settled')
    const end = lines.find((l) => l.type === 'agent_end') as unknown as {
      messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>
    }
    const text = end.messages.at(-1)!.content[0]!.text
    expect(JSON.parse(text)).toEqual({ coverage: [], findings: [] })
    expect(readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')).toContain('--thinking\noff')
    expect(readFileSync(join(scenario, 'pi-calls/call-1/stdin'), 'utf8')).toBe('PROMPT BODY')
  })

  it('pi-error emits stopReason error with exit 0', () => {
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'pi-error'), '400 third-party billing blocked')
    const out = execFileSync('pi', ['-p', '--mode', 'json'], {
      env: gateEnv(scenario) as NodeJS.ProcessEnv, input: 'x', encoding: 'utf8',
    })
    expect(out).toContain('"stopReason":"error"')
    expect(out).toContain('billing')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fakebin.test.ts`
Expected: FAIL — `spawn pi ENOENT` is NOT acceptable here: the real `pi` may be on PATH ahead of the fixture. Verify the failure is `ENOENT` *or* real-pi output; either way the fixture directory must precede PATH via `gateEnv` (it already does — `PATH: fakeBinDir() + delimiter + base.PATH`), so once the file exists the fake wins.

- [ ] **Step 3: Write the fake**

```sh
#!/bin/sh
# witness protocol-tier fake pi: records calls, answers canned NDJSON agent_end
# envelopes (the --mode json contract parsePiEnvelope consumes). Mirrors fakebin/claude.
set -e
if [ "$1" = "--version" ]; then echo "pi fake 0.0.0"; exit 0; fi
dir="${WITNESS_FAKE_DIR:?WITNESS_FAKE_DIR unset}"
mkdir -p "$dir/pi-calls"
n=0
for d in "$dir"/pi-calls/call-*; do [ -e "$d" ] && n=$((n + 1)); done
n=$((n + 1))
call="$dir/pi-calls/call-$n"
mkdir -p "$call"
if [ -e ".witness/lock" ]; then echo held > "$call/lock"; else echo free > "$call/lock"; fi
printf '%s\n' "$@" > "$call/argv"
cat > "$call/stdin"
if [ -f "$dir/pi-hang" ] && [ "$n" -le "$(cat "$dir/pi-hang")" ]; then
  sleep 30
fi
if [ -f "$dir/pi-fail" ] && [ "$n" -le "$(cat "$dir/pi-fail")" ]; then
  echo "fake pi: injected failure for call $n" >&2
  exit 1
fi
# pi-error: the in-stream provider-error shape (billing block) — exit 0, stopReason error.
if [ -f "$dir/pi-error" ]; then
  node -e '
    const fs = require("fs")
    const msg = fs.readFileSync(process.argv[1], "utf8").trim()
    const assistant = { role: "assistant", content: [], stopReason: "error", errorMessage: msg }
    process.stdout.write(JSON.stringify({ type: "agent_end", messages: [assistant] }) + "\n")
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n")
  ' "$dir/pi-error"
  exit 0
fi
body="$dir/verdict.json"
[ -f "$dir/verdict-$n.json" ] && body="$dir/verdict-$n.json"
node -e '
  const fs = require("fs")
  const result = fs.readFileSync(process.argv[1], "utf8")
  const user = { role: "user", content: [{ type: "text", text: "" }] }
  const assistant = { role: "assistant", content: [{ type: "text", text: result }], stopReason: "stop" }
  process.stdout.write(JSON.stringify({ type: "turn_end", message: assistant }) + "\n")
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [user, assistant] }) + "\n")
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n")
' "$body"
```

Then: `chmod 755 fixtures/fakebin/pi`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fakebin.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fixtures/fakebin/pi tests/fakebin.test.ts
git commit -m "test: protocol-tier fake pi emitting NDJSON agent_end envelopes"
```

---

### Task 4: `invokeReviewer` — harness-agnostic spawn loop

**Files:**

- Modify: `src/reviewer.ts` (replace `invokeClaude` body; keep a shim)
- Test: `tests/reviewer.test.ts`

**Interfaces:**

- Consumes: `Harness, loadHarness, validatePin` (Task 2), fake pi (Task 3).
- Produces: `invokeReviewer(ctx: Ctx, harness: Harness, opts: InvokeOpts): Result<{ text: string }>` — `InvokeOpts` unchanged (`{ cwd, prompt, model? }`, `model` is the *raw pin string*). `invokeClaude(ctx, opts)` remains as a one-line shim until Task 7.

- [ ] **Step 1: Write the failing test**

Append to `tests/reviewer.test.ts`:

```ts
import { invokeReviewer } from '../src/reviewer.js'
import { loadHarness } from '../src/harness.js'

const piHarness = (() => { const r = loadHarness('pi'); if (!r.ok) throw new Error('registry'); return r.value })()

describe('invokeReviewer via pi', () => {
  it('spawns hermetic pi print mode and parses the agent_end envelope', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, piHarness, { cwd: repo.root, prompt: 'LENS\nBODY', model: 'google/gemini-3.6-pro:low' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.value.text)).toEqual({ coverage: [], findings: [] })
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('--no-session')
    expect(argv).toContain('--no-extensions')
    expect(argv).toContain('--thinking\nlow')
    expect(argv).toContain('--model\ngoogle/gemini-3.6-pro')
    expect(readFileSync(join(scenario, 'pi-calls/call-1/stdin'), 'utf8')).toContain('BODY')
  })

  it('surfaces the in-stream provider error as a refusal', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [], findings: [] })
    writeFileSync(join(scenario, 'pi-error'), '400 third-party billing blocked')
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, piHarness, { cwd: repo.root, prompt: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]!.rule).toBe('reviewer-invocation')
  })

  it('refuses a provider-qualified pin on claude-code before spawning anything', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    const claudeH = loadHarness('claude-code')
    if (!claudeH.ok) throw new Error('registry')
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario) })
    const r = invokeReviewer(ctx, claudeH.value, { cwd: repo.root, prompt: 'x', model: 'google/gemini-3.6-pro' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]!.rule).toBe('provider-unrunnable')
    expect(existsSync(join(scenario, 'claude-calls'))).toBe(false)
  })
})
```

Add `existsSync` to the `node:fs` import line of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reviewer.test.ts`
Expected: FAIL — `invokeReviewer` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/reviewer.ts`, replace the whole `invokeClaude` function (keep `InvokeOpts`, `REVIEWER_TIMEOUT_MS`, `TIMEOUT_RETRIES` as they are) with:

```ts
import { loadHarness, validatePin, type Harness } from './harness.js'
import type { ParsedPin } from './pin.js'
```

```ts
export function invokeReviewer(ctx: Ctx, harness: Harness, opts: InvokeOpts): Result<{ text: string }> {
  let pin: ParsedPin | undefined
  if (opts.model !== undefined) {
    const pinR = validatePin(harness, 'gates.model', opts.model)
    if (!pinR.ok) return refuse(pinR.violations)
    pin = pinR.value
  }
  const { cmd, args, env } = harness.reviewer.spawn(pin)
  const timeout = Number(ctx.env.WITNESS_REVIEWER_TIMEOUT_MS) || REVIEWER_TIMEOUT_MS
  for (let attempt = 0; ; attempt += 1) {
    const r = spawnSync(cmd, args, {
      cwd: opts.cwd,
      env: { ...ctx.env, ...env } as NodeJS.ProcessEnv,
      input: opts.prompt,
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (r.error) {
      // A stall is NOT the missing-binary case. Reporting it as one sent the last
      // reader hunting a PATH problem on a machine where the reviewer answered in 6s.
      if ((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        if (attempt < TIMEOUT_RETRIES) continue
        return refuse([v(cmd, 'reviewer-timeout',
          `no response in ${timeout}ms after ${attempt + 1} attempts`,
          'a reviewer that answers within the timeout — raise WITNESS_REVIEWER_TIMEOUT_MS if the model is simply slow')])
      }
      return refuse([v(cmd, 'reviewer-invocation', String((r.error as Error).message),
        `a runnable ${cmd} binary on PATH — gates invoke reviewers headlessly; witness check probes this`)])
    }
    if (r.status !== 0) {
      return refuse([v(cmd, 'reviewer-invocation',
        `exit ${String(r.status)}: ${(r.stderr ?? '').slice(0, 200)}`, `${cmd} print mode exiting 0`)])
    }
    return harness.reviewer.parseEnvelope(r.stdout)
  }
}

// Back-compat shim for gate.ts/calibrate.ts — deleted in the calibrate task once every
// caller passes a resolved harness.
export function invokeClaude(ctx: Ctx, opts: InvokeOpts): Result<{ text: string }> {
  const h = loadHarness('claude-code')
  if (!h.ok) return refuse(h.violations)
  return invokeReviewer(ctx, h.value, opts)
}
```

- [ ] **Step 4: Run the file's tests, then the full suite**

Run: `npx vitest run tests/reviewer.test.ts` — Expected: PASS (existing `invokeClaude` tests still green through the shim).
Run: `npx vitest run` — Expected: PASS (no caller signature changed yet).

- [ ] **Step 5: Commit**

```bash
git add src/reviewer.ts tests/reviewer.test.ts
git commit -m "feat: invokeReviewer routes reviewer spawns through the harness registry"
```

---

### Task 5: Per-harness calibration matrix + pin-grammar validation in `stagePin`

**Files:**

- Modify: `src/model.ts`
- Modify: `src/gate.ts:195` (one call site), `src/verbs/dashboard.ts` (`run()`, around line 53)
- Test: `tests/model.test.ts`

**Interfaces:**

- Consumes: `parsePin` (Task 1), `resolveHarness, HarnessName` from `src/harness.ts`.
- Produces:
  - `loadMatrix(root: string, harness: HarnessName): MatrixInfo` (signature change)
  - `stagePin` unchanged signature, now refuses `pin-malformed` / `unknown-thinking-level` and applies the alias check to the *model segment*.

- [ ] **Step 1: Write the failing test**

Append to `tests/model.test.ts` (it already has `tmpRepo`-style helpers and writes `.witness/calibration.local.yaml`; mirror its existing setup for the file-writing test):

```ts
import { loadMatrix, stagePin } from '../src/model.js'

describe('per-harness matrix', () => {
  it('reads legacy top-level models as claude-code and matrices.<name> for pi', async () => {
    const repo = await tmpRepo()
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    writeFileSync(join(repo.root, '.witness', 'calibration.local.yaml'),
      'models:\n  - claude-fable-5\nmatrices:\n  pi:\n    models:\n      - google/gemini-3.6-pro\n')
    expect(loadMatrix(repo.root, 'claude-code').local).toEqual(['claude-fable-5'])
    expect(loadMatrix(repo.root, 'pi').local).toEqual(['google/gemini-3.6-pro'])
  })
})

describe('stagePin grammar', () => {
  it('refuses aliases in the model segment and unknown thinking levels', () => {
    const aliased = stagePin(cfgWith({ gates: { model: 'anthropic/opus:low' } }))
    expect(aliased.ok).toBe(false)
    if (!aliased.ok) expect(aliased.violations[0]!.rule).toBe('alias-refused')
    const lvl = stagePin(cfgWith({ gates: { model: 'claude-fable-5:turbo' } }))
    expect(lvl.ok).toBe(false)
    if (!lvl.ok) expect(lvl.violations[0]!.rule).toBe('unknown-thinking-level')
    const good = stagePin(cfgWith({ gates: { model: 'google/gemini-3.6-pro:low' } }))
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.value).toBe('google/gemini-3.6-pro:low')
  })
})
```

`cfgWith` — use the file's existing config-construction helper; if it has none, build the minimal `Config` shape the file's other `stagePin` tests already use (read them first and copy that construction exactly).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/model.test.ts`
Expected: FAIL — `loadMatrix` takes 1 argument; `anthropic/opus:low` is not caught by the whole-string alias check.

- [ ] **Step 3: Write the implementation**

In `src/model.ts`:

```ts
import { parsePin } from './pin.js'
import type { HarnessName } from './harness.js'
```

Replace `readModels` and `loadMatrix`:

```ts
interface MatrixDoc { models?: unknown; matrices?: Record<string, { models?: unknown } | undefined> }

// Per-(harness, model) calibration (Decision 88): a pi-invoked reviewer on the same
// model id is a DIFFERENT reviewer. Legacy top-level `models:` predates the harness
// dimension and was only ever measured through claude -p — it reads as claude-code.
function readModels(path: string, harness: HarnessName): string[] {
  if (!existsSync(path)) return []
  const doc = parse(readFileSync(path, 'utf8')) as MatrixDoc | null
  const scoped = doc?.matrices?.[harness]?.models
  if (Array.isArray(scoped)) return scoped.map(String)
  return harness === 'claude-code' && Array.isArray(doc?.models) ? doc.models.map(String) : []
}

export function loadMatrix(root: string, harness: HarnessName): MatrixInfo {
  return {
    shipped: readModels(shippedMatrixPath(), harness),
    local: readModels(join(root, '.witness', 'calibration.local.yaml'), harness),
  }
}
```

In `stagePin`, replace the alias check block:

```ts
  if (pin !== undefined) {
    const parsed = parsePin(pinField, pin)
    if (!parsed.ok) return refuse(parsed.violations)
    if (MODEL_ALIASES.includes(parsed.value.model)) {
      return refuse([v(pinField, 'alias-refused', pin,
        'an exact model id — aliases re-point under the calibration (Decision 55)')])
    }
  }
```

3b. Update `src/gate.ts:195`. The gate must resolve the harness anyway for Task 6 — do it here once. Add imports `resolveHarness, type Harness` from `./harness.js`, then immediately before the `resolveModel` call:

```ts
  const hxR = resolveHarness(ctx.env, cfgR.value.raw)
  if (!hxR.ok) { renderRefusal(hxR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const harness = hxR.value.harness
  const modelR = resolveModel(cfgR.value, loadMatrix(root, harness.name), spec.gate)
```

3c. Update `src/verbs/dashboard.ts` — inside `run()`, the `if (cfg.ok)` block: add `import { resolveHarness } from '../harness.js'`, then:

```ts
    const hxR = resolveHarness(ctx.env, cfg.value.raw)
    const matrix = loadMatrix(root, hxR.ok ? hxR.value.harness.name : 'claude-code')
```

(The dashboard is diagnostic — a broken harness config must not brick it; `check` reports that as a finding.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/model.test.ts tests/dashboard.test.ts tests/gate-engine.test.ts`
Expected: PASS. Then `npx vitest run` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model.ts src/gate.ts src/verbs/dashboard.ts tests/model.test.ts
git commit -m "feat: per-harness calibration matrix and pin-grammar validation in stagePin"
```

---

### Task 6: Gate battery through the harness + harness in the verdict-cache key

**Files:**

- Modify: `src/rounds.ts` (`GateRunEntry`, `GateKey`, `keyOf`, `sameKey`)
- Modify: `src/gate.ts` (key construction ~line 200, invoker call ~line 266, malformed-streak brake ~line 228, gate-run entry literal — search `t: 'gate-run'`)
- Test: `tests/rounds.test.ts`, `tests/gate-engine.test.ts`

**Interfaces:**

- Consumes: `harness` local resolved in gate.ts (Task 5), `invokeReviewer` (Task 4).
- Produces: `GateKey.harness: string`, `GateRunEntry.harness?: string` (optional — legacy entries lack it), `keyOf` defaulting absent to `'claude-code'`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/rounds.test.ts` (mirror its existing entry-construction helpers):

```ts
describe('harness in the gate key', () => {
  it('a legacy entry without harness cache-matches a claude-code key and not a pi key', () => {
    const legacy = runEntry({ reviewed_sha: 's1', gate: 'plan', prompts_sha: 'p1', model: 'm1', witness: '1.0.0' })
    delete (legacy as Record<string, unknown>).harness
    const claudeKey = { reviewed_sha: 's1', gate: 'plan', prompts_sha: 'p1', model: 'm1', witness: '1.0.0', harness: 'claude-code' }
    expect(sameKey(keyOf(legacy), claudeKey)).toBe(true)
    expect(sameKey(keyOf(legacy), { ...claudeKey, harness: 'pi' })).toBe(false)
  })
})
```

(`runEntry` — use the file's existing gate-run fixture builder; copy its construction if named differently.)

Append to `tests/gate-engine.test.ts`, cloning the file's simplest passing-gate scenario (same repo setup, same `putVerdict`), with two changes — `WITNESS_HARNESS: 'pi'` in the env and pi-side assertions:

```ts
  it('runs the battery through pi when the resolved harness is pi', async () => {
    // ...same arrange as the adjacent passing-gate test, but:
    const ctx = fakeCtx(repo.root, { env: gateEnv(scenario, { WITNESS_HARNESS: 'pi' }) })
    // ...same act (run the gate)...
    const argv = readFileSync(join(scenario, 'pi-calls/call-1/argv'), 'utf8')
    expect(argv).toContain('--mode\njson')
    expect(argv).toContain('--thinking\noff')
    expect(existsSync(join(scenario, 'claude-calls'))).toBe(false)
    // the journal entry stamps the harness:
    // read the stream as the adjacent tests do and assert entry.harness === 'pi'
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rounds.test.ts tests/gate-engine.test.ts`
Expected: FAIL — `harness` missing from `GateKey`; gate spawns `claude` (finds `claude-calls`, not `pi-calls`).

- [ ] **Step 3: Write the implementation**

3a. `src/rounds.ts`:

- `GateRunEntry`: add `harness?: string` after `model: string`. Optional — every pre-88 journal on disk lacks it.
- `GateKey`: add `harness: string` (required — keys are always constructed fresh).
- `keyOf`:

```ts
export function keyOf(run: GateRunEntry): GateKey {
  const { reviewed_sha, gate, prompts_sha, model, witness } = run
  return { reviewed_sha, gate, prompts_sha, model, witness, harness: run.harness ?? 'claude-code' }
}
```

- `sameKey`: add `&& a.harness === b.harness`.

3b. `src/gate.ts`:

- Key construction (~line 200): add `harness: harness.name` to the `GateKey` literal.
- Malformed-streak brake (~line 228): extend `sameSetup`:

```ts
    const sameSetup = (r: GateRunEntry) =>
      r.outcome === 'malformed' && r.model === key.model && r.prompts_sha === key.prompts_sha &&
      (r.harness ?? 'claude-code') === key.harness
```

- Invoker (~line 266): replace `invokeClaude(ctx, {...})` with `invokeReviewer(ctx, harness, {...})`; update the import from `./reviewer.js`.
- Gate-run entry literal (search `t: 'gate-run'`): add `harness: harness.name` next to `model`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/rounds.test.ts tests/gate-engine.test.ts`, then `npx vitest run`.
Expected: PASS. Protocol-tier gate tests still pass on claude-code (default harness; `fixtureEnv` sets no `WITNESS_HARNESS`/`PI_CODING_AGENT` — verify in `tests/helpers.ts` and add `WITNESS_HARNESS: 'claude-code'` to `fixtureEnv`'s base if the suite itself runs under pi and leaks `PI_CODING_AGENT`).

- [ ] **Step 5: Commit**

```bash
git add src/rounds.ts src/gate.ts tests/rounds.test.ts tests/gate-engine.test.ts
git commit -m "feat: gate battery spawns the resolved harness; harness joins the verdict-cache key"
```

---

### Task 7: Calibration through the harness; per-harness overlay; delete the shim

**Files:**

- Modify: `src/calibrate.ts` (`runSample` ~line 130, skill-suite invocations at lines 370 and 469, `addToLocalOverlay` ~line 228)
- Modify: `src/verbs/calibrate.ts` (resolve harness once, pass down; overlay output line ~line 104)
- Modify: `src/reviewer.ts` (delete `invokeClaude` shim)
- Test: `tests/calibrate.test.ts`

**Interfaces:**

- Consumes: `invokeReviewer`, `resolveHarness`, `loadHarness`.
- Produces:
  - `runSample(ctx, harness: Harness, model, lens, suite, overlay?)` (parameter added after `ctx`; same for `runReviewerSuite` and the two skill-suite functions at lines 370/469 — thread `harness` through their call chains)
  - `addToLocalOverlay(root: string, model: string, harness: HarnessName): void` writing `matrices.<name>.models`, preserving legacy top-level `models:` untouched.

- [ ] **Step 1: Write the failing test**

Append to `tests/calibrate.test.ts`:

```ts
import { addToLocalOverlay, localOverlayPath } from '../src/calibrate.js'
import { loadMatrix } from '../src/model.js'

describe('per-harness overlay', () => {
  it('writes matrices.<harness>.models and leaves legacy models untouched', async () => {
    const repo = await tmpRepo()
    mkdirSync(dirname(localOverlayPath(repo.root)), { recursive: true })
    writeFileSync(localOverlayPath(repo.root), 'models:\n  - claude-fable-5\n')
    addToLocalOverlay(repo.root, 'google/gemini-3.6-pro', 'pi')
    addToLocalOverlay(repo.root, 'google/gemini-3.6-pro', 'pi') // idempotent
    expect(loadMatrix(repo.root, 'pi').local).toEqual(['google/gemini-3.6-pro'])
    expect(loadMatrix(repo.root, 'claude-code').local).toEqual(['claude-fable-5'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/calibrate.test.ts`
Expected: FAIL — `addToLocalOverlay` takes 2 arguments and writes top-level `models`.

- [ ] **Step 3: Write the implementation**

3a. `src/calibrate.ts` — replace `addToLocalOverlay`:

```ts
export function addToLocalOverlay(root: string, model: string, harness: HarnessName): void {
  const path = localOverlayPath(root)
  const current = existsSync(path)
    ? (parse(readFileSync(path, 'utf8')) as { models?: string[]; matrices?: Record<string, { models?: string[] }> })
    : {}
  const matrices = current.matrices ?? {}
  const models = matrices[harness]?.models ?? []
  if (!models.includes(model)) models.push(model)
  matrices[harness] = { models }
  mkdirSync(dirname(path), { recursive: true })
  // legacy top-level `models:` (claude-code measurements) is preserved verbatim
  writeFileSync(path, stringify({ ...current, matrices }))
}
```

3b. `src/calibrate.ts` — `runSample`: change signature to `(ctx: Ctx, harness: Harness, model: string, lens: string, suite: ReviewerSuite, overlay?: string)` and replace `invokeClaude(ctx, { cwd: dir, prompt, model })` with `invokeReviewer(ctx, harness, { cwd: dir, prompt, model })`. Do the same substitution at the two skill-suite invocation sites (lines 370 and 469): add a `harness: Harness` parameter to their enclosing functions and every caller up to `src/verbs/calibrate.ts`. Update the import line to `import { PROMPT_NAMES, invokeReviewer, parseVerdictText, resolvePrompt } from './reviewer.js'`.

3c. `src/verbs/calibrate.ts` — near the top of `run()` (after config load), resolve once:

```ts
  const hxR = resolveHarness(ctx.env, cfgR.ok ? cfgR.value.raw : {})
  if (!hxR.ok) { for (const line of renderRefusal(hxR.violations)) ctx.err(line); return EXIT.REFUSED }
  const harness = hxR.value.harness
```

Pass `harness` into every suite call; change the overlay call to `addToLocalOverlay(rootR.value, model, harness.name)`; update the output line (no commas — toon):

```ts
  ctx.out(kv('overlay', `.witness/calibration.local.yaml + ${harness.name}/${model} (gate-runs stamp calibration: local)`))
```

3d. `src/reviewer.ts` — delete the `invokeClaude` shim and its `loadHarness` import if now unused. Update the two legacy `invokeClaude` tests in `tests/reviewer.test.ts` to call `invokeReviewer(ctx, claudeHarness, ...)` with identical assertions (argv/stdin recording proves behavior is unchanged).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/calibrate.test.ts tests/reviewer.test.ts tests/calibrate-skills.test.ts`, then `npx vitest run`.
Expected: PASS. `rg -n "invokeClaude" src tests` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add src/calibrate.ts src/verbs/calibrate.ts src/reviewer.ts tests/calibrate.test.ts tests/reviewer.test.ts
git commit -m "feat: calibrate routes through the harness and writes per-harness overlay entries"
```

---

### Task 8: `check` probes the resolved harness, not `claude`

**Files:**

- Modify: `src/verbs/check.ts` (lines ~166–175: the hard-coded claude probe and its Decision-12 comment; the probe moves *into* the existing `hxR.ok` branch at ~line 197)
- Test: `tests/check.test.ts`

**Interfaces:**

- Consumes: the existing `probe()` helper and `resolveHarness` result already present in `check.ts`.
- Produces: a `probes` finding keyed by the harness launch binary name.

- [ ] **Step 1: Write the failing test**

Append to `tests/check.test.ts` (mirror its existing probe tests — they control PATH via env):

```ts
  it('probes the resolved harness launch binary instead of hard-coding claude', async () => {
    const repo = await tmpRepo()
    const scenario = fakeScenario()
    // fake pi IS on the fixture PATH — under WITNESS_HARNESS=pi there must be no
    // missing-probe finding for pi and no claude probe at all
    const r = await repo.cli(['check'], { env: gateEnv(scenario, { WITNESS_HARNESS: 'pi' }) })
    expect(r.stdout).not.toContain('the claude CLI is required for gates on every harness')
    expect(r.stdout).not.toMatch(/probes.*claude.*missing/)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/check.test.ts`
Expected: FAIL — the hard-coded claude wording still prints (fixture PATH has a fake `claude`, so assert on the *wording*, which this task deletes).

- [ ] **Step 3: Write the implementation**

Delete the block at `src/verbs/check.ts:168–174` (the Decision-12 comment plus the `probe('claude', ...)` finding). Inside the `else` branch of `hxR` (~line 197, where `const harness = hxR.value.harness` already exists), add:

```ts
    // Decision 88: the judgment lane runs on the RESOLVED harness — the probe follows it.
    if (!probe(harness.launch, ['--version'], ctx.env)) {
      findings.push(f('warn', 'probes', harness.launch, 'missing',
        `the ${harness.launch} CLI runs this harness's gate reviewers — install and authenticate it`))
    }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/check.test.ts`, then `npx vitest run`.
Expected: PASS. Existing check tests asserting the old wording must be updated to the new wording in this task.

- [ ] **Step 5: Commit**

```bash
git add src/verbs/check.ts tests/check.test.ts
git commit -m "feat: check probes the resolved harness launch binary for the reviewer lane"
```

---

### Task 9: Thinking-aware handoff rendering

**Files:**

- Modify: `src/harness.ts` (`modelArg`, `handoffLine`)
- Test: `tests/harness.test.ts`

**Interfaces:**

- Consumes: `parsePin`, `CLAUDE_THINKING_BUDGET` (already imported in Task 2).
- Produces: `handoffLine(harness, home, model)` — unchanged signature; renders `provider/model:level` on pi and a `MAX_THINKING_TOKENS=<n>` env prefix on claude-code for non-off levels.

- [ ] **Step 1: Write the failing test**

Append to the reviewer-contract describe block in `tests/harness.test.ts`:

```ts
  it('handoff renders the thinking suffix natively on pi', () => {
    expect(handoffLine(pi, '/wt', 'claude-fable-5:low'))
      .toBe("cd '/wt' && pi --model anthropic/claude-fable-5:low '/witness'")
    expect(handoffLine(pi, '/wt', 'google/gemini-3.6-pro'))
      .toBe("cd '/wt' && pi --model google/gemini-3.6-pro '/witness'")
  })

  it('handoff renders non-off thinking as MAX_THINKING_TOKENS on claude-code', () => {
    expect(handoffLine(claude, '/wt', 'claude-fable-5:medium'))
      .toBe("cd '/wt' && MAX_THINKING_TOKENS=8192 claude --model claude-fable-5 '/witness'")
    expect(handoffLine(claude, '/wt', 'claude-fable-5'))
      .toBe("cd '/wt' && claude --model claude-fable-5 '/witness'")
    expect(handoffLine(claude, '/wt', undefined))
      .toBe("cd '/wt' && claude '/witness'")
  })
```

Add `handoffLine` to the test file's import from `../src/harness.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/harness.test.ts`
Expected: FAIL — current `modelArg` renders `--model anthropic/claude-fable-5:low` wrong (treats the whole string as `{model}`) and no env prefix exists.

- [ ] **Step 3: Write the implementation**

Replace `modelArg` and `handoffLine` in `src/harness.ts`:

```ts
// Decision 9 (extended by 88): the model flag is a renderer over the parsed pin. Pi
// renders provider + native :thinking suffix; claude-code renders the bare id and
// carries non-off thinking as a MAX_THINKING_TOKENS env prefix on the handoff line.
function modelArg(harness: Harness, model: string | undefined): string {
  if (model === undefined || model === '') return ''
  const parsed = parsePin('gates.model', model)
  if (!parsed.ok) return '' // stagePin refused upstream; render nothing rather than garbage
  const pin = parsed.value
  if (harness.name === 'pi') {
    const suffix = pin.thinking === 'off' ? '' : `:${pin.thinking}`
    return ` --model ${pin.provider ?? harness.defaultProvider ?? ''}/${pin.model}${suffix}`
  }
  return ` --model ${pin.model}`
}

// Single quotes: a double-quoted form trips toon esc() quoting and emits an
// unpasteable line (see the note this replaces at verbs/next.ts:69).
export function handoffLine(harness: Harness, home: string, model: string | undefined): string {
  const parsed = model !== undefined && model !== '' ? parsePin('gates.model', model) : undefined
  const budget = harness.name === 'claude-code' && parsed?.ok === true && parsed.value.thinking !== 'off'
    ? `MAX_THINKING_TOKENS=${CLAUDE_THINKING_BUDGET[parsed.value.thinking]} `
    : ''
  return `cd '${home}' && ${budget}${harness.launch}${modelArg(harness, model)} '/witness'`
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/harness.test.ts tests/next.test.ts`, then `npx vitest run`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness.ts tests/harness.test.ts
git commit -m "feat: handoff lines render thinking natively on pi and as env budget on claude-code"
```

---

### Task 10: DESIGN.md row 88

**Files:**

- Modify: `DESIGN.md` (append to the decision-rows table; extend the rationale-trail preamble at line 303)

- [ ] **Step 1: Append the row**

Add to the preamble sentence at DESIGN.md:303: `Row 88 (✹) is grill #11 — harness-routed reviewers, 2026-07-31.`

Append after row 87:

```markdown
| 88 ✹ | The judgment lane runs on the resolved harness | Overturns row 87's four residuals: `invokeReviewer(ctx, harness, opts)` spawns the RESOLVED harness's headless mode (claude-code: `claude -p --output-format json`; pi: hermetic `pi -p --mode json --no-session --no-extensions --no-skills --no-context-files --thinking <level>` — every omitted flag was a machine-local variable silently changing reviewer behavior, and this machine's `defaultThinkingLevel: xhigh` was the probable true cause of row 87's "stalls on long prompts"). Full routing, NO fallback: a silent claude fallback would swap the reviewer identity mid-pipeline. The pin grammar becomes `[provider/]model[:thinking]` — one knob (row 87's no-`provider:`-key argument dies with the forced-claude pin that justified it); bare pins resolve through the harness default provider, provider-qualified pins refuse `provider-unrunnable` on claude-code, omitted thinking is `off` on every harness, and claude-code renders non-off levels through a pinned `MAX_THINKING_TOKENS` budget table. The verdict-cache key and gate-run entries gain `harness` (absent reads `claude-code` — a pi verdict must never cache-hit a claude one); calibration becomes per-(harness, model): the shipped matrix stays claude-code, `witness calibrate` routes through the harness and writes `matrices.<name>.models` to the local overlay, and an uncalibrated (harness, model) pair rides the EXISTING floor machinery — loud warning, `--manual` stop, `calibration: local` stamps. `check` probes the resolved harness's launch binary. Residual accepted, not fixed: Anthropic structurally privileges `claude -p` (first-party, plan limits) over third-party harnesses — the empirical probe hit `400 "Third-party apps now draw from your extra usage"` on a fresh `pi -p` spawn against subscription OAuth while `claude -p` answered in 3.6s on the same machine; under full routing that surfaces as a loud in-stream `reviewer-invocation` refusal (pi's `--mode json` reports provider errors as `stopReason: "error"` with exit 0 — the envelope parser, not the exit code, is the error channel), and the remedy is the user's provider choice, not witness's | Row 87 measured the reviewer lane as the deepest coupling and accepted it four ways (claude-on-every-harness, claude-only calibration, dual-meaning `gates.model`, no provider key); the 2026-07-31 design interview overturned it after a probe re-tested the two operational objections and found both soft — the "long-prompt stall" resolved into closed upstream stdin/loop bugs (earendil-works/pi #161 #2584 #2677 #4303 #5571) compounded by the xhigh default, and headless PNG input is a documented pi feature (`pi -p @screenshot.png` file arguments; the Read tool sends images as attachments) — while the billing asymmetry hardened from anecdote to a reproduced 400. Chosen over two rejected shapes: silent-fallback routing (corrupts the cache key and the calibration claim) and reviewer-lane-stays-claude with an opt-in knob (preserves the dual-meaning pin and the claude-on-PATH requirement for pure-pi users — the two residuals the redesign existed to kill) |
```

- [ ] **Step 2: Verify the docs tests still pass**

Run: `npx vitest run tests/harness-neutrality.test.ts tests/version-sync.test.ts`
Expected: PASS (row 88 lives in DESIGN.md, not in `plugin/skills/**` or `plugin/commands/**`, so the neutrality regex never sees it).

- [ ] **Step 3: Full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add DESIGN.md
git commit -m "docs: row 88 — harness-routed reviewers overturn row 87's residuals"
```

---

## Self-Review (performed while writing)

1. **Spec coverage:** Q2 full routing → Tasks 4, 6, 7, 8. Q3 per-(harness, model) calibration + floor → Tasks 5, 7 (floor warnings need no change — `resolveModel`'s `calibrationOf` now reads harness-scoped lists by construction). Q4+Q6 pin grammar + thinking → Tasks 1, 5, 9. Q5 hermetic spawn + identity-in-key → Tasks 2, 6. NDJSON envelope + in-stream errors → Tasks 2, 3, 4. Probe follows harness → Task 8. DESIGN row → Task 10.
2. **Known gap, accepted:** `GateRunEntry.harness` is stamped but the dashboard/`next` render of gate-run history does not display it — display is additive and deferred to real need.
3. **Type consistency:** `ParsedPin` produced in Task 1 is the exact type consumed by Tasks 2, 4, 9. `loadMatrix(root, HarnessName)` (Task 5) matches every call site updated in Tasks 5–7. `invokeReviewer(ctx, Harness, InvokeOpts)` is identical across Tasks 4, 6, 7.
4. **Fixture-env caveat (Task 6 Step 4):** if the suite itself runs under pi, `PI_CODING_AGENT` may leak into `fixtureEnv` and flip every protocol test to pi — the step includes the check and the one-line fix (`WITNESS_HARNESS: 'claude-code'` in the base env).
