// Row 193 §4.5. Every comment text a released witness wrote into witness.config.yaml — the one
// record of which comments are witness's. A comment line whose trimmed text is one of these is
// witness's wherever it sits: `migrate` writes the current text on a setting's line and drops an
// old one on a line of its own, since what it described now exists for real. An edited copy no
// longer matches, so it is the human's. Append-only: rewording a comment in `src/settings.ts`
// adds its new text here and leaves the old one, which is what keeps every file an older witness
// wrote readable (tests/config-file.test.ts fails on a written text missing from the record).
// What this witness no longer writes is derived (config-file.ts), never a second list to keep.
export const RELEASED_COMMENTS: ReadonlySet<string> = new Set([
  // ── Before 0.21.0: each version of `init`'s template (git log -p --follow -- src/verbs/init.ts,
  // the specflow era included; a continuation line is its own entry) and both of
  // `recordHarness`'s texts (src/install.ts).
  'any gate block may pin its own model (wins over the global pin), e.g.',
  'conventions: [docs/code/architecture.md]   # → injected into code-reviewer at implement + ship (cache-keyed)',
  'declared beats the ambient session (init --agent writes it once)',
  'decompose: { reviewers: [slicing-critic], model: claude-opus-4-8 }',
  'docs:                      # repo docs registry — enumerated keys, unknown keys refused',
  "harness: pi               # the judge — which harness runs this repo's gate reviewers;",
  'or: runner: full-suite + report: junit:**/reports/junit.xml',
  'paths: { specs: docs/specs, plans: docs/plans }   # optional canon roots (defaults: specs, plans); git mv existing docs when changing',
  'per change class; a plain list = all classes',
  'reviewer model pin — exact id, aliases refused',
  'reviewerTimeoutMs: 600000  # ms per reviewer invocation (machine auth/extension knobs live in .witness/config.local.yaml)',
  'specflow.config.yaml — the whole surface',
  'witness.config.yaml — the whole surface',
  "the judge — which harness runs this repo's gate reviewers; declared wins",
  'detection wins; this is the fallback',
  // The end-of-line comments of the template's commented-out settings, which the template meant
  // the human to uncomment (final review I3).
  'optional canon roots (defaults: specs, plans); git mv existing docs when changing',
  'repo docs registry — enumerated keys, unknown keys refused',
  '→ injected into code-reviewer at implement + ship (cache-keyed)',
  "the judge — which harness runs this repo's gate reviewers;",
  'ms per reviewer invocation (machine auth/extension knobs live in .witness/config.local.yaml)',
  // ── Since 0.21.0 the template is `src/settings.ts`: every setting's comment, the per-class
  // `for a …` lines, the schema line, the first line and the group headings, in every release.
  // Collected from the published tarballs 0.21.0, 0.21.1, 0.22.0, 0.23.0 and 0.24.0.
  "% of the context window at which a session hands over to a fresh one · 1–100",
  "code docs handed to code-reviewer at implement and ship · file list, [] = none",
  "design docs handed to design-critic and design-reviewer · file list, [] = none",
  "extra globs never scanned for criteria tags · [] = none",
  "folder for approved designs, repo-relative · git mv the docs when you change it",
  "folder for plans, repo-relative · git mv the docs when you change it",
  "folder for specs, repo-relative · git mv the docs when you change it",
  "for a chore",
  "for a feature",
  "for a fix",
  "format version · witness migrate raises it; never edit by hand",
  "gate rounds one target may run across budget resets, then it is parked · ≥ 1",
  "how a spec's criteria run · a command with {id}, or full-suite",
  "how ship merges its own PR under autonomy · merge | squash | rebase",
  "let test runs in two worktrees overlap · true | false",
  "model for the arbiter that settles stops and checks recaps under autonomy · exact id, no aliases",
  "model for the arbiter that settles stops under autonomy · exact id, no aliases",
  "model for this gate's reviewers AND for the agent that writes the code",
  "model for this gate's reviewers · exact id, [provider/]id[:thinking], no aliases",
  "model for this gate's reviewers · exact id, no aliases",
  "model for this gate's reviewers · runs only on specs marked ui",
  "ms green CI must hold still before an autonomous merge · 0–1800000",
  "ms of session time one target may take in one run (16 h), then it is parked · ≥ 1",
  "ms one reviewer, or the arbiter, may run before it is stopped (10 min) · ≥ 1",
  "ms one spawned session may run before it is stopped (1 h) · ≥ 1",
  "on = the CLI settles its own stops and merges green PRs · on | off · counts once committed",
  "reviewers this gate runs · one list, or one list per class",
  "reviewers this gate runs · one list, or one list per class (feature, fix, chore)",
  "sessions drive runs at once, one per target · ≥ 1",
  "sessions one target may take in one run, then it is parked · ≥ 1",
  "steps an implement session takes when its context fill can't be read · ≥ 1",
  "the branch witness ships into",
  "the judge: the agent CLI that runs this repo's gate reviewers and arbiter · claude-code | pi",
  "the junit report witness reads · junit:<glob>, or none · full-suite needs one",
  "the lint command ship runs",
  "the suite command ship runs · full-suite criteria run it too",
  "upstream resets one target may take, then it is parked · ≥ 1",
  "witness.config.yaml — every setting witness reads. Change a value in place; `witness migrate` keeps the file current.",
  "── Behavior: how witness works here ─────────────────────────────────────────",
  "── Setup: what this repo is ─────────────────────────────────────────────────",
  "── Tuning: witness drive ────────────────────────────────────────────────────",
])
