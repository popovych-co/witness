# Config surface: every setting in the file, commented, nothing inherited

Date: 2026-10-23 · Status: approved 2026-10-23 · Evidence: probes P1–P4 run 2026-10-23 (§6) · Builder check: done; both of its questions settled in the doc by the user's own rules (§4.3, the arbiter's model; §4.5, comment lines old templates wrote)

## 1. Why

The user shipped `session.contextLimit` in 0.20.0. Then, upgrading a consumer, they could not tell where to set it, how to set it, or what its value means: a percent, or something else. If the person who wrote the setting cannot find it in a consumer, nobody else will.

Each cause below was checked against the code:

- **`witness init` never writes most settings.** Its template (`src/verbs/init.ts:18-38`) has no `session:` line. Twelve settings never appear in any file `init` creates: `implement.stepsPerDispatch`, `session.contextLimit`, the seven `drive.*` settings, `ship.merge`, `ship.ciSettleMs` and `autonomy`. Four more appear only as commented-out lines: `harness`, `paths`, `docs` and `gates.reviewerTimeoutMs`. The template has no `gates.design` block at all.
- **Upgrades never show a new setting.** Re-running `init --agent` on an existing repo changes only `harness:` (`src/verbs/init.ts:168-171`). That is the command the user runs on every upgrade.
- **What a value means lives only in the README.** The settings table (`README.md:163-180`) says `contextLimit` is a percent from 1 to 100. Nothing next to the value says so. The table also leaves out `gates.*.model`, `gates.*.reviewers`, `criteria.*`, `ship.test`, `ship.lint`, `ship.branch`, `paths` and `docs`.
- **A typo is silently ignored.** Only `drive:` refuses keys it does not know (`src/config.ts:204`). `contextLimt: 30` is ignored, and the session limit stays 20 (`src/config.ts:148`). The same goes for `session`, `implement`, `gates`, `ship` and `paths`.
- **No single place knows every setting.** Typed resolvers in `src/config.ts` check and default some settings. Everything else is read loosely through `cfg.raw` in 14 files: `gates.*.model` (`src/model.ts:52-66`), `gates.*.reviewers` (`src/gate.ts:120-128`), `ship.test`, `ship.lint` and `ship.branch` (`src/runner.ts:29`, `src/gates/ship.ts:79`, `src/ship.ts:213`, `src/evidence.ts:155` and four verbs), `criteria.*` (`src/runner.ts:14-50`) and `harness` (`src/harness.ts:263`).
- **Inheritance is invisible.** `gates.<gate>.model` overrides `gates.model` (`src/model.ts:57`). A missing `gates.<gate>.reviewers` falls back to a list built into the code (`src/gate.ts:107-121`). The file shows neither rule. All three consumers (fewhats.com, know-your-customer-mvp, hear-your-customer-mvp) repeat the parent's model under `implement` and `ship`, and copy the built-in reviewer lists word for word. None of them sets any value different from what it would inherit anyway (P4).
- **This is where row 14 led.** The config was "thin, convention-first … minimal to learn" (DESIGN.md:280, row 14). Minimal to learn only works if you can find out what exists.

**Decided by the user in this conversation:**
- Every setting is required in `witness.config.yaml`. Settings that are optional today are prefilled with their defaults.
- `witness init` writes a comment on every setting.
- Nothing is inherited: every gate states its own `model` and `reviewers`. The user accepted the cost: one model id is written five times, and switching models means editing five lines.
- The user approved the refined design as played back ("looks good"):
  - a complete, commented file, instead of a short file plus a lookup command;
  - `migrate` moves values still at an old default to the new default, and names each move;
  - an upgrade lists what is new or changed;
  - comment ownership (§4.5);
  - settings ordered by when you would touch them;
  - every refusal says how to fix it;
  - no key renames;
  - the canon guard's comment fix.

Everything marked *(my call)* below is mine. Some of those calls were played back and approved as a set, and the handover lists which.

## 2. Goals, non-goals, anti-goals

**Goals**
- In any consumer, you open `witness.config.yaml` and see every setting witness reads, its value, and what the value means: what it does, its unit, its allowed range. You never need the README or the source.
- An upgrade tells you, in words, which settings are new or changed, and one command brings the file up to date.
- A wrong key, a missing setting or an invalid value is refused, and the message says how to fix it.
- What witness does in a repo changes only through a committed diff of this file, and never because a new witness version quietly changed a default.

**Non-goals**
- `.witness/config.local.yaml`. Machine facts keep their own file and closed key set (row 90) *(my call)*.
- Changing a resolver default value *(my call)*. The one exception is the model `init` prefills (§4.4).
- A `witness config` command to view or set values, or a JSON Schema for editors. With every setting already in the file, changing one is editing one value, and `witness check` validates. Agents make most edits, and agents don't hover.
- Renaming existing keys. Hooks installed on each machine read some keys by name (§4.9).
- Migrating journals or frontmatter. Row 23 says `migrate` never rewrites journals.

**Anti-goals** (failures even if the code technically works)
- An upgrade that stops a running `drive`, or blocks a consumer with autonomy on, until someone edits the file.
- `migrate` losing a value the human chose, or a comment the human wrote.
- `migrate` changing behavior that its output does not name.
- A hook (the context adapter, the canon guard) reading the new file differently from the CLI.
- Prefilled defaults frozen for good, so nobody can tell a real choice from a leftover.

## 3. The settings today

The design moves 37 settings into one list: the 36 below plus `arbiter.model`, which is new (§4.3). Each gate's `model` and `reviewers` count as two settings, and a per-class reviewer map counts as one.

| Setting | Value | Default | Read at today |
|---|---|---|---|
| `schema` | integer | 1 | `config.ts:410` (`loadConfig`) |
| `harness` | `claude-code \| pi` | unset: the session's harness judges | `harness.ts:263`, `:278-293` |
| `paths.specs`, `.plans`, `.designs` | repo-relative folder | `specs`, `plans`, `designs` | `config.ts:35`; `canon-guard.mjs:33-40` |
| `docs.conventions`, `.design` | non-empty file list | unset | `config.ts:76` |
| `criteria.runner` | a command containing `{id}`, or `full-suite` | none (required today) | `runner.ts:14-19` |
| `criteria.report` | `junit:<glob>` | unset (required for full-suite) | `runner.ts:21-42` |
| `criteria.exclude` | glob list | `[]` | `runner.ts:47-51` |
| `ship.test`, `.lint` | shell command | unset | `gates/ship.ts:79`, `runner.ts:29` |
| `ship.branch` | branch name | `main` | `ship.ts:213`, `evidence.ts:156`, verbs |
| `ship.merge` | `merge \| squash \| rebase` | `merge` | `config.ts:293` |
| `ship.ciSettleMs` | ms, 0–1800000 | 60000 | `config.ts:293` |
| `autonomy` | `on \| off` | `off` | `config.ts:272`, `:315` |
| `session.contextLimit` | percent, 1–100 | 20 | `config.ts:142`; `context-core.mjs:114` |
| `implement.stepsPerDispatch` | integer ≥ 1 | 3 | `config.ts:118` |
| `gates.reviewerTimeoutMs` | ms ≥ 1 | 600000 | `config.ts:253` |
| `gates.<gate>.model` ×5 | `[provider/]id[:thinking]`, no aliases | `gates.model`, else the calibration chain | `model.ts:52-66`; the implement worker at `next.ts:284`, `start.ts:58` |
| `gates.<gate>.reviewers` ×5 | list, or a per-class map | the built-in list | `gate.ts:107-128` |
| (the arbiter's model) | no setting of its own | `gates.model` alone, never a per-gate pin (row 172) | `arbiter.ts:84`, for every autonomous stop (`settle.ts`) and the recap check (`recap-check.ts:55`) |
| `drive.sessionTimeoutMs` | ms ≥ 1 | 3600000 | `config.ts:194` |
| `drive.parallel` | integer ≥ 1 | 2 | `config.ts:194` |
| `drive.parallelSuites` | boolean | false | `config.ts:194` |
| `drive.caps.rounds`, `.upstream`, `.spawns`, `.wallClockMs` | integers ≥ 1 | 16, 6, 24, 57600000 | `config.ts:171`, `:194` |

The five gates are `decompose`, `plan`, `design`, `implement` and `ship`.

## 4. The design

### 4.1 One list of settings *(my call)*

A single list in the code describes every setting:
- its path and type, with its allowed values or range;
- its default, kept per schema version, because §4.7 needs the history;
- its group (§4.5) and its one-line comment.

Everything else is derived from that list:
- the resolver, which checks the file and returns a fully typed `Config`;
- the file `init` writes;
- what `migrate` adds, moves and comments;
- the README settings table;
- every config refusal message;
- `check`'s config findings.

Code that reads a setting gets a typed value. The 14 files that read `cfg.raw` stop doing so, and `Config.raw` goes away unless something outside config resolution still needs it.

A test ties the list to `SCHEMA_VERSION`. Changing a setting's path, type, range or default without raising the schema number and recording the history fails the build. Changing only a comment's text raises nothing: `migrate` refreshes witness's comments on every run (§4.6).

### 4.2 Schema 2: every setting present, nothing unknown

- `SCHEMA_VERSION` becomes 2. In a schema-2 file every setting in the list is required, and every key must be in the list *(my call)*.
- A missing setting is refused. The message names the setting, gives the exact line to add (value plus witness's comment) and points at `witness migrate`, which restores it.
- An unknown key is refused. The message names the key and, where one is close, the setting it probably meant *(my call)*. `contextLimt` refuses instead of quietly giving 20.
- An invalid value is refused in the same words as its comment, as today's `want:` text already does.
- A list whose default is "nothing" is written empty, and an empty list means none: `docs.conventions: []`, `docs.design: []`, `criteria.exclude: []` *(my call)*. Today `docs` refuses an empty list (`config.ts:91`). Under schema 2 an empty list is how the file says "none".
- `criteria.report` is `none` or `junit:<glob>`. `full-suite` still needs a `junit:` report *(my call)*.
- A per-class reviewer map must name all three classes: `feature`, `fix` and `chore`. A missing class is refused when the file is loaded, not when that gate first runs (`gate.ts:124` refuses it at run time today) *(my call)*. A plain list still means "all classes": that is visible in the file, not looked up anywhere else (row 13).

### 4.3 Nothing inherited (the user's decision)

- `gates.model` is gone. In a schema-2 file it is an unknown key, and the refusal says each gate now states its own model.
- Each of the five gates has a required `model` and a required `reviewers`.
- `gates.design` is required even in a repo with no `ui` specs. The file is the catalogue, and the gate's comment says it runs only on specs marked `ui` *(my call)*.
- The built-in reviewer lists (`DEFAULT_BATTERIES`, `gate.ts:107`) no longer apply at run time. They become the list's defaults, which `init` prefills and `migrate` fills in.
- **The arbiter gets its own required `arbiter.model`** *(my call, found by the builder check)*.
  - Today the arbiter resolves its model with no gate (`arbiter.ts:84`), so it runs on `gates.model`'s chain and never on a per-gate pin. Row 172 chose that so one arbiter is comparable across every gate it judges.
  - Deleting `gates.model` without a replacement would leave the arbiter unpinned. On fewhats.com (autonomy on, an empty calibration matrix, `harness: pi`) every autonomous stop and recap check would then quietly move off `claude-opus-5-5` onto Pi's default model, with no diff.
  - Its own setting keeps row 172's property, keeps the user's no-inheritance rule, and the 1 → 2 step fills it from `gates.model`.
  - It is a top-level section, not a gate block: the arbiter is not a gate, and `autonomy` must stay a plain `on | off` string (§4.9).
  - The arbiter also shares two settings, which their comments say: the judge (`harness`, through `resolveJudge`) and `gates.reviewerTimeoutMs` (`arbiter.ts:96`). Sharing one visible setting is not inheritance, because nothing is looked up from a parent.
- The model fallback chain (row 55: pinned, then the next calibrated id, then the session's default with a floor warning) is unchanged. The only difference is that its first rung is always a pin, for every gate and for the arbiter.

### 4.4 Required `harness`, and the model `init` prefills *(my call)*

- **`harness` is required.** In a schema-2 file the judge comes only from `harness:`. Today's undeclared state, where the open session's harness judges (row 105's judge ladder: `harness:`, then detection, then the default), is gone. The driver ladder (detection first) is unchanged. All three consumers already declare `pi`.
- **What `init` writes for `harness`:** the harness named by `--agent`. Without `--agent`, the detected driver, else `claude-code`. `init` prints which one and why. A later `init --agent <other>` keeps today's warning that the judge did not move (`init.ts:172-177`).
- **The model `init` prefills is `claude-opus-5-5`, on all five gates.** Today's template pins `claude-fable-5` (`init.ts:26`), which is superseded, and every consumer replaced it with an Opus id. This is the one default value this design changes, and it is flagged for the user to check (§10).

### 4.5 The file *(the user: a comment on every setting; layout rules are my calls)*

`init` writes this file, and `migrate` rewrites every file into the same shape. The values below are the defaults `init` writes in a repo with no `--agent`.

```yaml
# witness.config.yaml — every setting witness reads. Change a value in place; `witness migrate` keeps the file current.
schema: 2                      # format version · witness migrate raises it; never edit by hand

# ── Setup: what this repo is ─────────────────────────────────────────────────
harness: claude-code           # the judge: the agent CLI that runs this repo's gate reviewers and arbiter · claude-code | pi
paths:
  specs: specs                 # folder for specs, repo-relative · git mv the docs when you change it
  plans: plans                 # folder for plans, repo-relative · git mv the docs when you change it
  designs: designs             # folder for approved designs, repo-relative · git mv the docs when you change it
docs:
  conventions: []              # code docs handed to code-reviewer at implement and ship · file list, [] = none
  design: []                   # design docs handed to design-critic and design-reviewer · file list, [] = none
criteria:
  runner: 'npm test -- -t "@spec:{id}"'  # how a spec's criteria run · a command with {id}, or full-suite
  report: none                 # the junit report witness reads · junit:<glob>, or none · full-suite needs one
  exclude: []                  # extra globs never scanned for criteria tags · [] = none
ship:
  test: npm test               # the suite command ship runs · full-suite criteria run it too
  lint: npm run lint           # the lint command ship runs
  branch: main                 # the branch witness ships into
  merge: merge                 # how ship merges its own PR under autonomy · merge | squash | rebase
  ciSettleMs: 60000            # ms green CI must hold still before an autonomous merge · 0–1800000

# ── Behavior: how witness works here ─────────────────────────────────────────
autonomy: off                  # on = the CLI settles its own stops and merges green PRs · on | off · counts once committed
arbiter:
  model: claude-opus-5-5       # model for the arbiter that settles stops and checks recaps under autonomy · exact id, no aliases
session:
  contextLimit: 20             # % of the context window at which a session hands over to a fresh one · 1–100
implement:
  stepsPerDispatch: 3          # steps an implement session takes when its context fill can't be read · ≥ 1
gates:
  reviewerTimeoutMs: 600000    # ms one reviewer, or the arbiter, may run before it is stopped (10 min) · ≥ 1
  decompose:
    model: claude-opus-5-5     # model for this gate's reviewers · exact id, [provider/]id[:thinking], no aliases
    reviewers: [slicing-critic]  # reviewers this gate runs · one list, or one list per class (feature, fix, chore)
  plan:
    model: claude-opus-5-5     # model for this gate's reviewers · exact id, no aliases
    reviewers: [plan-critic]   # reviewers this gate runs · one list, or one list per class
  design:
    model: claude-opus-5-5     # model for this gate's reviewers · runs only on specs marked ui
    reviewers: [design-critic] # reviewers this gate runs · one list, or one list per class
  implement:
    model: claude-opus-5-5     # model for this gate's reviewers AND for the agent that writes the code
    reviewers:
      feature: [code-reviewer, silent-failure-hunter, type-design, pr-test, design-reviewer]  # for a feature
      fix: [code-reviewer, silent-failure-hunter, design-reviewer]  # for a fix
      chore: [code-reviewer]   # for a chore
  ship:
    model: claude-opus-5-5     # model for this gate's reviewers · exact id, no aliases
    reviewers: [drift-reviewer, code-reviewer]  # reviewers this gate runs · one list, or one list per class

# ── Tuning: witness drive ────────────────────────────────────────────────────
drive:
  parallel: 2                  # sessions drive runs at once, one per target · ≥ 1
  parallelSuites: false        # let test runs in two worktrees overlap · true | false
  sessionTimeoutMs: 3600000    # ms one spawned session may run before it is stopped (1 h) · ≥ 1
  caps:
    rounds: 16                 # gate rounds one target may run across budget resets, then it is parked · ≥ 1
    upstream: 6                # upstream resets one target may take, then it is parked · ≥ 1
    spawns: 24                 # sessions one target may take in one run, then it is parked · ≥ 1
    wallClockMs: 57600000      # ms of session time one target may take in one run (16 h), then it is parked · ≥ 1
```

Layout rules:
- **Order: by when you would touch a setting.** Setup sections come first (`schema`, `harness`, `paths`, `docs`, `criteria`, `ship`), then behavior (`autonomy`, `arbiter`, `session`, `implement`, `gates`), then tuning (`drive`). Each group gets one heading line. YAML cannot split a section, so the order is by section and then by key within each section.
- **Block style for every map.** Each setting gets its own line, so it can carry its own comment. Lists stay in flow style (`[a, b]`).
- **A setting's own line ends with witness's comment.** The comment says what the setting does, then its unit or allowed values, and its default where that helps. Comment text never contains a word followed by a colon, because the canon guard's reader could take it for a key (P2).
- **Section lines (`paths:`, `gates:`, `caps:` …) carry no comment.** A comment on the `paths:` line makes today's canon guard fall back to the default folders (P3).

Who owns which comment:
- **Witness owns** the comment at the end of each setting's line, the file's first line, and the three group headings. `migrate` rewrites them to the current text.
- **Witness also owns every comment line whose text exactly matches a line a released witness wrote, wherever it sits** *(my call, found by the builder check)*.
  - These texts are every version of `init`'s template (`src/verbs/init.ts:18-41` and its git history, v0.4.1 onward) and `recordHarness`'s `# the judge — … declared wins` (`src/install.ts:272`). The builder collects them from git history.
  - They include the templates' commented-out settings (`# paths: { … }`, `# harness: pi …` and its second line, `# reviewerTimeoutMs: …`) and their advice line `# any gate block may pin its own model (wins over the global pin), e.g.`. That line is still in know-your-customer-mvp (line 27) and hear-your-customer-mvp (line 41), and schema 2 makes it false.
  - On a setting's line, `migrate` replaces such a text with the current comment. On a line of its own, `migrate` drops it, since the setting it commented out now exists for real.
  - Left in place, these lines would sit beside the real settings and contradict the file, which undercuts goal 1.
- **The human owns every other comment line.** That includes any old template line the human edited, because it no longer matches. `migrate` never edits or drops one.
- **Any other comment on a setting's line is the human's.** `migrate` moves it to the line above that setting, word for word.
- **When `migrate` removes a setting** (the old `gates.model`), the human comments above it move to the next setting in the same section, and the output names the move.

### 4.6 `witness migrate` *(the verb row 23 reserved; its rules are my calls inside the approved design)*

**What it does.** `migrate` brings `witness.config.yaml` up to this CLI's schema and makes it complete:
- adds every missing setting, with its default and its comment;
- on 1 → 2, writes each gate's current effective `model` and `reviewers` (its own pin, else `gates.model`; its own list, else the built-in one), writes `arbiter.model` from `gates.model`, then drops `gates.model`;
- moves values that sit at an old default to the new default (§4.7);
- rewrites witness's comments, and drops lines old templates wrote on their own (§4.5);
- puts the sections in the §4.5 order and every map in block style;
- sets `schema:` to the current number.

**What it keeps.** Every value that is a choice, and every human comment, attached to the setting or section it sat above.

**What it guards.** Before writing, `migrate` refuses if:
- the old file, resolved under its own schema's rules, and the new file, resolved under schema 2, differ in anything other than the default moves it is about to report;
- any human comment's text from the old file is missing from the new one. Only human comments count, by §4.5's ownership rules;
- the old file has unknown keys. It names each one and the setting it probably meant. The human fixes or deletes them; `migrate` never drops a key on its own.
- the file declares a newer schema than this CLI knows;
- `witness.config.yaml` has uncommitted changes. The human commits or cleans first, as with `init` *(my call)*.

**What it says.** One line per change, for example:
- `added session.contextLimit: 20 — % of the context window at which a session hands over to a fresh one (1–100)`
- `expanded gates.model claude-opus-5-5 → decompose, plan, design and arbiter.model (implement and ship already pinned it)`
- `moved drive.caps.spawns 24 → 30 — default changed in schema 3`
- `kept 38 comments · moved 1 (gates.model → gates.reviewerTimeoutMs) · dropped 2 old template lines`
- `config: schema 1 → 2 · up to date`

`--dry-run` prints the same lines and the new file's diff, and writes nothing. On a file that is already current and complete, `migrate` prints `up to date` and changes nothing.

**How it writes.** Like `init`: it takes the repo lock, writes, and commits `witness.config.yaml` alone through `commitWithTrailer` with the subject `migrate: config schema N → M` *(my call)*.

**Why it rewrites instead of making minimal edits.** P1: the `yaml` library keeps values and comments but not spacing or line breaks, so even untouched lines change. Minimal edits would not stay minimal anyway: a flow map such as `ship: { test, lint, branch }` cannot hold one comment per setting, so nearly every line changes once every setting carries its comment. One canonical rewrite, done once per consumer, is the honest form. After that, a later `migrate` changes only the lines whose settings changed.

### 4.7 Defaults that can move *(my call, approved as "default moves")*

Prefilling turns "I never picked this" into "I picked 24". Without a remedy, witness could never improve a default for anyone. Row 191 already records that drive's defaults need revisiting.

- The list keeps each setting's default per schema version.
- On each schema step, `migrate` moves a value that still equals the old default to the new default, and names the move.
- A value different from the old default is a choice, and stays.
- Equality is deep for lists and maps, so a reviewer list equal to the old built-in list counts as at the default.
- A human who deliberately chose a value that happens to equal the old default sees it moved, in `migrate`'s output and in the diff, and can set it back. That is a residual, accepted (§7).

Behavior still changes only through a committed diff, which is the repo's own rule (configured, never ambient).

### 4.8 Older files keep running *(my call, row 23's "warn on older")*

- `loadConfig` on a file with an older schema runs the same migration in memory, writes nothing, resolves the result under the current rules, and warns, for example: `warn: witness.config.yaml is schema 1 — witness migrate adds 12 settings (session.contextLimit, …), expands gates.model and refreshes comments`. The warning prints where today's schema warning prints (`config.ts:457`).
- In memory, missing settings take the current default, which is exactly today's behavior. A value present in the file is never moved in memory: moving it would be a behavior change with no committed diff. Only `migrate`, which writes the file, moves defaults.
- In memory, the older schema's leniency holds: unknown keys are ignored as schema 1 ignored them, except where schema 1 already refused (`drive`). So an upgrade never refuses a consumer that worked yesterday. `migrate` is the act that requires a clean file.
- A file declaring a newer schema is still refused with "upgrade witness" (row 23).
- `witness check` reports an older schema as a finding, with the `migrate` line and the count of new settings. `init --agent`, the upgrade command, prints the same line.

### 4.9 Code outside the CLI that reads the file

Two hook files read `witness.config.yaml` without a YAML parser. They are dependency-free by design, because they run inside the agent's harness, and each machine's installed copy updates on its own schedule. The file's layout is therefore a contract with them:

- **The context adapter** (`plugin/hooks/context-core.mjs:114`, copied byte for byte into `plugin-context/`) reads `session.contextLimit` by name. It handles block and flow maps, with comments, and treats the key as a direct child of a top-level `session:` (`context-core.mjs:28-36`). The §4.5 layout is inside those forms. The key name must never change: the plugin updates only on `claude plugin update`, and a rename would silently turn the warning off.
- **The canon guard** (`plugin/hooks/canon-guard.mjs:29-43`) reads `paths:` with a regex that does not skip comments. A comment line above a path containing `specs:` makes it read the specs folder as the next word (P2). A comment on the `paths:` line makes it fall back to the default folders, so a repo with `docs/specs` would be guarded at the wrong place (P3). **Root fix, in this release:** the guard drops comments before matching, as `context-core.mjs`'s `uncomment` does, and both probe cases become tests. Until every machine's payload is refreshed (`init --agent`), the §4.5 rules keep `migrate`'s own output safe for the old guard: witness's comments sit at the end of setting lines, and section lines carry none.
- **`autonomyAt`** (`config.ts:315`) parses `autonomy` at any git revision with the YAML parser. It is unaffected, as long as `autonomy` stays a top-level `on | off` string, which the list must keep.
- **The design skill** reads `docs.design` by asking the agent to read the file (`plugin/skills/witness-design/SKILL.md:56-57`). Its example shows the old flow form. The builder updates the example.

Keys read by hooks (`session.contextLimit`, `paths.*`, `autonomy`) never move or rename. The list marks them, and the §4.1 test refuses a change to them.

### 4.10 Docs

- The README's "Configuration keys" table becomes the list's table, generated from it or checked against it by a test, so it can't drift again.
- DESIGN.md's config block (DESIGN.md:283-302) becomes the §4.5 file. Its "thin, convention-first" bullet (DESIGN.md:280) is rewritten: strong defaults survive as the prefilled values, and the file is now the full catalogue.

### 4.11 Rollout

This happens after release. It is an outward act on the user's repos, so the user runs it or approves it.
- fewhats.com: upgrade, `witness migrate`, review the diff, commit.
- hear-your-customer-mvp: the same.
- know-your-customer-mvp pins 0.14.4 and is out of this rollout until it upgrades.

## 5. DESIGN.md rows

Row 192 is relay cleanup's (`docs/superpowers/plans/2026-10-23-relay-cleanup.md:50`), so this design is row 193 (D193).

- **New row 193.** Every setting lives in `witness.config.yaml`, commented, with nothing inherited. It covers the one list, schema 2, `witness migrate`, defaults that move, and older files read through the in-memory migration.
- **Amends row 14.** The config surface stops being "thin, convention-first" and becomes complete, explicit and commented. Strong defaults survive as prefilled values.
- **Amends row 23.** `migrate` is built, for config only and never for journals. "Warn on older" now means "read through the in-memory migration, and warn".
- **Amends row 55.** `gates.model` is replaced by a required pin per gate. The fallback chain is unchanged.
- **Amends row 172.** The arbiter's model is `arbiter.model`, its own required pin, instead of the `gates.model` chain. One arbiter across every gate stays. Row 177's recap check reaches it through the same module, unchanged.
- **Amends row 13.** Built-in reviewer lists become prefill, not run-time fallback. A per-class map must name all three classes. A plain list still means all classes.
- **Amends row 105.** Under schema 2 the judge is declared only; the undeclared state is gone. The driver half is unchanged.
- **Amends row 68.** An empty `docs` list means none.
- **Touches row 191.** `session.contextLimit` is now in every file. The adapter's built-in default matters only for files that predate it.
- The config block and the "Config:" bullet in Deliverable & distribution are rewritten (§4.10).
- Row 90 is unchanged.

## 6. Probes (2026-10-23)

- **P1. Comment-keeping rewrite.** Using `yaml` 2.9.0's Document API on a copy of fewhats.com's config, the probe added `session.contextLimit` with a comment, added `ship.merge` to a flow map turned to block style, copied `gates.model` into the three gates without one, and deleted it.
  - Kept: every value, and all 40 comment lines except the one on the deleted `gates.model` line.
  - Reformatted, on untouched lines: `{ specs: … }` became `{specs: …}` (or `[ a ]` gained padding, depending on `flowCollectionPadding`); the multi-line `feature:` list was folded onto one line; the comment on `reviewers:` moved down a line.
  - So `migrate` cannot promise byte-identical untouched lines through the Document API, which is why §4.6 chose a canonical rewrite.
- **P2. Canon guard, comment line above.** Running a copy of the guard's extraction (`canon-guard.mjs:33-40`) on a `paths:` block with `# repo-relative; for specs: no . or ..` above `specs: docs/specs` gave `['no', 'docs/plans', 'docs/designs']`. With the comment at the end of the line instead, it read correctly.
- **P3. Canon guard, comment on the section line.** The same copy, run on `paths:  # canon roots` followed by `docs/*` paths, gave `['specs', 'plans', 'designs']`: the defaults.
- **P4. Consumer configs.** In all three consumers, `gates.implement.model` and `gates.ship.model` equal `gates.model` (fewhats.com `claude-opus-5-5`; the other two `claude-opus-5`). Every reviewer list equals `DEFAULT_BATTERIES` (`gate.ts:107-117`). No consumer sets `implement`, `session`, `drive`, `gates.reviewerTimeoutMs`, `ship.merge` or `ship.ciSettleMs`. Only fewhats.com sets `autonomy`. Every end-of-line comment in them is witness-written text (the old template, `recordHarness`). Comments on their own lines were not checked until the builder check: know-your-customer-mvp:27 and hear-your-customer-mvp:41 carry the old template's `# any gate block may pin its own model (wins over the global pin), e.g.` (verified).
- **Read, not run.** `context-core.mjs` strips comments before matching (`uncomment`, line 44) and reads block and flow maps (`sessionEntries`, lines 85-101).

## 7. Edge cases and residuals

- **A deliberate value equal to an old default** gets moved at the next default change. The output names the move, the diff shows it, and the human sets it back. Residual, by design.
- **A schema-1 file with no model pin anywhere** (none of the three consumers): `migrate` writes the list's default model on every gate and on `arbiter.model`, and says so. Today's effective value comes from the calibration chain, so there is no fixed value to preserve.
- **A schema-1 file with no `harness`:** in memory, today's judge ladder holds. `migrate` writes the detected driver, else `claude-code`, and says so.
- **Comments the `yaml` library attaches to an unexpected setting:** the guard in §4.6 catches a lost comment, not a misplaced one. A misplaced comment shows in the diff `--dry-run` prints. Residual.
- **A teammate on an older witness after `migrate`** is refused with "upgrade witness" (row 23, unchanged).
- **An old installed canon guard and a human comment moved above a path:** a human's inline comment that contains `specs:`, moved above `specs:` by `migrate`, recreates P2's shape until that machine's payload is refreshed. No consumer has one today. Residual, small.
- **Worktrees:** the CLI and the adapters read the primary root's config (row 191), so `migrate` runs at the primary root. A worktree's own copy is the branch's file, which the CLI does not read, and it catches up when the branch merges.
- **`drive` running while `migrate` commits:** each invocation reads the file again, and the effective values are equal by §4.6's guard, so nothing changes mid-run. The repo lock keeps `migrate` from writing while another CLI write is in progress.
- **`calibrate`'s scratch config** (`calibrate.ts:437`) writes `schema: 1`. The builder moves it to a full schema-2 file from the list, or it prints the older-schema warning in every calibration run.

## 8. Testing

- **The list:** every setting has a type, a default and a comment; comments contain no `word:` text; `init`'s file resolves to the defaults; the README table matches the list; the §4.1 test refuses a path, type, range or default change without a schema step; keys read by hooks are marked and frozen.
- **The resolver:** each refusal (missing, unknown, invalid) carries its fix line; empty lists and `report: none` are accepted; a per-class map missing a class is refused when the file loads.
- **`migrate`:** golden tests on copies of the three consumer configs, comparing the expected new file and the expected output lines. Those expectations include know-your-customer-mvp and hear-your-customer-mvp dropping their old template lines, and `arbiter.model` taking `gates.model`'s value. Also:
  - a value change refuses; a lost comment refuses;
  - unknown keys refuse, with the probable setting;
  - a dirty file refuses; a newer schema refuses;
  - a run on a current file is idempotent;
  - a default moves on a synthetic schema 3;
  - `--dry-run` writes nothing;
  - the commit carries the trailer.
- **In memory:** a differential test. For every schema-1 fixture and the three consumer configs, the in-memory result resolves to the same typed values the current resolvers plus `cfg.raw` reads give today. That includes the arbiter's model, which today comes from a call with no gate (`arbiter.ts:84`).
- **Hooks:**
  - the canon guard's P2 and P3 cases, before and after the fix;
  - `contextLimitOf` on the §4.5 file and on `migrate`'s output for each consumer;
  - the canon guard's extraction on the same files.
- **The existing suite:** many fixtures write minimal `schema: 1` configs. The older-schema warning will break exact-output assertions, as row 191's `ctx` stamp did (its P8). The builder chooses between a test helper that writes schema-2 files from the list and a quieter path for fixtures, but must not hide the warning from real runs. `pnpm test` exits 1 with every test green (a few worker-RPC timeouts), so judge a run by `AssertionError`, not by the exit code.

## 9. Left to the builder

- Module and file names, and the list's representation, including how it keeps defaults per schema.
- How the file is rendered: the `yaml` Document API with comment re-attachment, or a writer that emits the §4.5 text and re-attaches human comments. Either must pass §4.6's guard.
- The exact wording of comments, within §4.5's rules: what the setting does, its unit or allowed values, its default where it helps, and no `word:` text. Column alignment, and how to handle a line whose value is too long for an inline comment.
- Whether the README table is generated or checked by a test.
- How `--dry-run` shows the diff, and how a close setting name is found for an unknown key.
- Whether `Config.raw` survives for anything outside config resolution.

## 10. Calls for the user to check while reading

- §4.4: the model `init` prefills changes from `claude-fable-5` to `claude-opus-5-5`.
- §4.4: `harness` becomes required, and the undeclared judge goes away.
- §4.2: `criteria.report: none`; empty lists mean none; a per-class map must name all three classes.
- §4.3: `gates.design` is required even in a repo with no `ui` specs.
- §4.3: the arbiter gets its own top-level `arbiter.model`, filled from `gates.model` (the builder check found it reads `gates.model` alone).
- §4.5: comment lines an old template wrote on their own lines are witness's, and `migrate` drops them, unless the human edited them.
- §4.6: `migrate` refuses unknown keys and uncommitted changes to the file, and commits its own change.
- §4.1 and §4.6: a comment-only change raises no schema step, because `migrate` refreshes comments on every run.
