# Config single-home + reviewer extensions — design

> Status: approved 2026-07-31 (interactive session). Fixes the pi reviewer auth outage
> (`--no-extensions` vs OAuth-adapter auth) and establishes the configuration
> single-home doctrine in the same release. Ships as one combined PR. DESIGN.md gains
> rows 89–90; row 87 (detection ladder) and row 88 (billing-asymmetry residual) are
> amended.

## Motivation

**The bug.** On the pi harness every `witness gate` refuses with a 400 —
`"Third-party apps now draw from your extra usage…"` — misdiagnosed by the current
refusal text as an auth/billing problem. A flag bisect proved `--no-extensions` on the
reviewer spawn (src/harness.ts, pi `reviewer.spawn`) is solely responsible: it disables
`npm:pi-claude-oauth-adapter`, the extension that makes the machine's Anthropic
subscription-OAuth credential usable, so pi falls back to the raw stored token, which
Anthropic now rejects for third-party apps. Verified live 2026-07-31:

- `pi --no-extensions -p "say ok"` → the 400
- `pi --no-extensions -e ~/.pi/agent/npm/node_modules/pi-claude-oauth-adapter -p "say ok"` → `ok`
- the exact witness reviewer argv plus `-e <adapter-dir>` → `agent_end` carrying
  assistant text; the control without `-e` → in-stream `stopReason: "error"` with the 400

pi's own help documents the mechanism: `--no-extensions` *"Disable extension discovery
(explicit -e paths still work)"*. No upstream change is needed.

**Row 88's residual is overturned.** Decision 88 observed this same 400 during its
design probe and accepted it as structural ("Anthropic privileges `claude -p`; the
remedy is the user's provider choice"). The bisect shows it was self-inflicted by
`--no-extensions`. Row 88's hermetic rationale stands (machine-local extensions must not
silently change reviewer behavior); its billing-asymmetry residual does not.

**The doctrine.** Fixing this via an env var was rejected in review: configuration must
have exactly one home. The env-var inventory shows no existing mess — but it also shows
witness has no home for *persistent machine facts*, which is why an env var looked
tempting. This design adds that home and removes the three env knobs that were doing
configuration work.

## Design

### Config model: two files, partitioned keyspace, zero merging

Every key has exactly one legal home. No key exists in both files, so no precedence
rule exists between them.

| File | Holds | Git |
| --- | --- | --- |
| `witness.config.yaml` | repo facts (existing keys + `gates.reviewerTimeoutMs`) | committed |
| `.witness/config.local.yaml` | machine facts: `reviewerExtensions`, `opener` | gitignored |

- `gates.reviewerTimeoutMs` — integer ms per reviewer invocation, default 600 000.
  Resolved inside `loadConfig` following the `resolveImplement` pattern: typed,
  refuse-on-invalid, default-on-absent. It is a repo fact because it is a fact about
  the pinned models, which are repo config.
- `.witness/config.local.yaml` — loaded by a separate `loadLocalConfig(root)`,
  deliberately NOT inside `loadConfig` (row 87 doctrine, verified verbatim: an unread
  key must not brick `witness check`). Missing file → all defaults. Malformed YAML,
  unknown key, or wrong type → refusal at the consuming verbs; `witness check` reports
  the same violations as findings instead of refusing.
  - `reviewerExtensions: [<path>, …]` — extension paths handed verbatim to the
    harness's reviewer spawn (pi: `-e <path>` each, after `--no-extensions`).
    Claude-code ignores them.
  - `opener: <cmd>` — the artifact opener for nonstandard desktops (bare name or
    path), replacing `WITNESS_OPENER`.

### The fix path

- `Harness.reviewer.spawn(pin, extensions?)` — pi appends `-e <path>` per entry after
  `--no-extensions`; hermeticity is preserved for everything not explicitly declared.
  The worker spawn is untouched (it keeps discovery deliberately — skills and context
  files are what the implement seed measures); the harness.ts comment states the two
  lanes' reasoning together.
- `InvokeOpts` gains `timeoutMs?` and `extensions?`. `invokeReviewer` never loads
  config (its cwd is a temp dir under calibration); the four verb boundaries resolve
  once and thread through:
  - gate engine (`src/gate.ts`) — also records non-empty `reviewer_extensions` in the
    `gate-run` journal entry (`GateRunEntry` optional-field precedent: `harness?`)
  - drift deep lane (`src/drift.ts`) — tolerates broken repo config (timeout defaults)
    but refuses on broken local config, like gate
  - calibrate (`src/verbs/calibrate.ts`) — threads an extras param through
    `runReviewerSuites → runReviewerSuite → runSample` and
    `runSkillSuites → runDecomposeSeed / runPlanSeed`, so calibration measures the
    same spawn the gate battery uses (row 88 requirement)
- **Identity vs transport:** extensions do NOT join the verdict-cache key — an auth
  adapter is transport, not reviewer identity, and keying on it would fragment verdicts
  across teammates' auth setups. They ARE journaled per gate-run. Residual, accepted:
  a declared extension could alter behavior; the journal makes that auditable.

### Accurate refusal

`parsePiEnvelope`'s `stopReason === 'error'` branch special-cases the extra-usage 400
(match: `/Third-party apps|extra usage/i`): the `want` text stops saying "check auth
and billing" and says the reviewer runs hermetic (`--no-extensions`), so auth supplied
by a pi extension must be declared in `.witness/config.local.yaml` `reviewerExtensions`.
All other provider errors keep the current text.

### Env-rung removal (breaking → 0.5.0)

| Removed | Replacement |
| --- | --- |
| `WITNESS_HARNESS` | none — ladder becomes **detected → `harness:` → default**; `HarnessSource` drops `'env'`; `init --agent <name>` calls `loadHarness(name)` directly (violations still relabeled `--agent`) |
| `WITNESS_REVIEWER_TIMEOUT_MS` | `gates.reviewerTimeoutMs`; the reviewer-timeout refusal message names the key |
| `WITNESS_OPENER` | `opener` in machine config; `openArtifact(opener, absPath)` takes the resolved value; the `opener-failed` refusal and `witness-design/SKILL.md` guidance name the key |

Stays env, reclassified (not configuration): `PI_CODING_AGENT`/`CLAUDECODE`/`CI`/`HOME`
(external facts), `WITNESS_TRUST_CMDS` (consent — a committed blanket-trust key would
let a cloned repo pre-approve running arbitrary commands), `WITNESS_SCREENS_DIR`
(output export to evidence children), `WITNESS_CRASH_AFTER`/`WITNESS_BIN` (internal
test/plumbing seams).

Tests stop bypassing the ladder: the in-process CLI helper env scrubs
`PI_CODING_AGENT`/`CLAUDECODE` instead of pinning `WITNESS_HARNESS`, and per-test
harness selection sets the real detection var — tests simulate what production
experiences. The unknown-harness test moves to `harness:` config.

### Guardrails

`witness check` gains findings (area `local-config`):

- malformed local config → the loader's violations as `error` findings
- declared `reviewerExtensions` path missing on disk → `warn` `extension-path-missing`
- `.witness/config.local.yaml` present but not git-ignored → `warn`
  `local-config-unignored` (init's gitignore write is scaffold-once — guarded by
  `existing.includes('.witness/lock')` — so pre-0.5.0 repos never receive the new
  ignore line; this finding is the honest path for them)

`GITIGNORE_BLOCK` (new repos) gains `.witness/config.local.yaml`; `DEFAULT_CONFIG`'s
gates block documents `reviewerTimeoutMs` in a comment.

### Records and docs

- DESIGN.md: row 89 (reviewer extensions + accurate refusal; overturns row 88's
  residual with the bisect evidence) and row 90 (configuration single-home doctrine;
  amends row 87's ladder). Row 87's ladder text and row 88's residual sentence get
  bracketed annotations pointing at the new rows.
- README: ladder row updated; config-keys table gains `gates.reviewerTimeoutMs`; new
  machine-config section for `.witness/config.local.yaml`; the stale
  "witness gate spawns the Claude CLI for every reviewer on every harness" paragraph
  (pre-row-88) is rewritten to the routed-reviewer reality.
- Version: 0.5.0 (breaking); `scripts/sync-versions.mjs` restamps the payload pins.
  No CHANGELOG file exists; README + DESIGN.md are the record.

## Non-goals

- No env fallbacks for the three removed vars (no deprecation shim).
- No `reviewerExtensions` in repo config, and no `npm:<name>` resolution — values are
  paths; resolving package names would couple witness to pi's install layout.
- No change to the worker spawn, the verdict-cache key, or `witness calibrate`'s
  overlay format.
- No general repo↔local key merging: a key has one home; anything else refuses.
