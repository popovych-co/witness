// Row 193 §4.5. Every comment text a released witness wrote into witness.config.yaml: each
// version of `init`'s template (git log -p --follow -- src/verbs/init.ts, the specflow era
// included; a continuation line is its own entry) and both of `recordHarness`'s texts
// (src/install.ts). A comment line whose trimmed text is one of these is witness's, wherever it
// sits: `migrate` replaces it on a setting's line and drops it on a line of its own, since what
// it described now exists for real. An edited copy no longer matches, so it is the human's.
export const LEGACY_COMMENTS: ReadonlySet<string> = new Set([
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
])
