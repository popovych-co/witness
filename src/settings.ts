import { createHash } from 'node:crypto'

// Row 193 §4.1. The one list of every setting witness.config.yaml holds. Everything else is
// derived from it: the resolver (config.ts), the file `init` writes and `migrate` rewrites
// (config-file.ts), the in-memory upgrade of older files (migration.ts) and the README table.
// A setting read anywhere but through this list is the `cfg.raw` drift row 193 removed.

// File order (§4.5), which is also the order every per-gate line prints in.
export const GATE_NAMES = ['decompose', 'plan', 'design', 'implement', 'ship'] as const
export type GateName = (typeof GATE_NAMES)[number]
export const CHANGE_CLASSES = ['feature', 'fix', 'chore'] as const
export type ChangeClass = (typeof CHANGE_CLASSES)[number]
export type Battery = string[] | Record<ChangeClass, string[]>

// The model `init` prefills on every gate and the arbiter (§4.4).
export const DEFAULT_MODEL = 'claude-opus-5-5'

// Row 13's built-in reviewer lists. Under schema 2 they are the prefill, not a run-time fallback.
export const DEFAULT_BATTERIES: Record<GateName, Battery> = {
  decompose: ['slicing-critic'],
  plan: ['plan-critic'],
  implement: {
    feature: ['code-reviewer', 'silent-failure-hunter', 'type-design', 'pr-test', 'design-reviewer'],
    fix: ['code-reviewer', 'silent-failure-hunter', 'design-reviewer'],
    chore: ['code-reviewer'],
  },
  ship: ['drift-reviewer', 'code-reviewer'],
  design: ['design-critic'],
}

export type Shape =
  | { kind: 'int'; min: number; max?: number } | { kind: 'bool' } | { kind: 'enum'; values: readonly string[] }
  | { kind: 'text' } | { kind: 'dir' } | { kind: 'files' } | { kind: 'globs' }
  | { kind: 'runner' } | { kind: 'report' } | { kind: 'pin' } | { kind: 'battery' }

export type Group = 'setup' | 'behavior' | 'tuning'

export interface Setting {
  path: string                                   // dotted, e.g. 'session.contextLimit'
  shape: Shape
  since: number                                  // first schema holding it
  defaults: Readonly<Record<number, unknown>>    // schema → default from that schema on
  // Absent in an older file meant something else (detection, the calibration chain, "not
  // configured"), so an in-memory read leaves it absent; only `migrate` fills it, and says so.
  ambient?: true
  // Read outside the CLI by a dependency-free hook (§4.9): its path never moves or renames.
  hookRead?: true
  group: Group
  comment: string   // the end-of-line comment in the file
  want: string      // want: of an `invalid` refusal
}

// A setting an older schema knew and the current one does not. Known up to `until`; its
// refusal in a newer file says what replaced it.
export interface Retired { path: string; until: number; shape: Shape; instead: string }

const INT1 = { kind: 'int', min: 1 } as const
const PIN = { kind: 'pin' } as const
const PIN_WANT = '[provider/]model[:thinking]'
const BATTERY_WANT = 'a reviewer list or a per-class map of lists in witness.config.yaml — e.g. reviewers: [code-reviewer]'
  + ' — a per-class map names feature, fix and chore'
const DIR_WANT = 'a repo-relative directory'
const DIR_COMMENT = (what: string) => `folder for ${what}, repo-relative · git mv the docs when you change it`

const GATE_COMMENTS: Record<GateName, { model: string; reviewers: string }> = {
  decompose: {
    model: "model for this gate's reviewers · exact id, [provider/]id[:thinking], no aliases",
    reviewers: 'reviewers this gate runs · one list, or one list per class (feature, fix, chore)',
  },
  plan: { model: "model for this gate's reviewers · exact id, no aliases", reviewers: 'reviewers this gate runs · one list, or one list per class' },
  design: { model: "model for this gate's reviewers · runs only on specs marked ui", reviewers: 'reviewers this gate runs · one list, or one list per class' },
  implement: {
    model: "model for this gate's reviewers AND for the agent that writes the code",
    reviewers: 'reviewers this gate runs · one list, or one list per class',
  },
  ship: { model: "model for this gate's reviewers · exact id, no aliases", reviewers: 'reviewers this gate runs · one list, or one list per class' },
}

const gateSettings = (g: GateName): Setting[] => [
  {
    path: `gates.${g}.model`, shape: PIN, since: 1, defaults: { 2: DEFAULT_MODEL }, ambient: true,
    group: 'behavior', comment: GATE_COMMENTS[g].model, want: PIN_WANT,
  },
  {
    path: `gates.${g}.reviewers`, shape: { kind: 'battery' }, since: 1, defaults: { 1: DEFAULT_BATTERIES[g] },
    group: 'behavior', comment: GATE_COMMENTS[g].reviewers, want: BATTERY_WANT,
  },
]

export const SETTINGS: readonly Setting[] = [
  {
    path: 'harness', shape: { kind: 'text' }, since: 1, defaults: { 1: 'claude-code' }, ambient: true, group: 'setup',
    comment: "the judge: the agent CLI that runs this repo's gate reviewers and arbiter · claude-code | pi",
    want: "claude-code | pi — the judge: which agent CLI runs this repo's gate reviewers and arbiter",
  },
  { path: 'paths.specs', shape: { kind: 'dir' }, since: 1, defaults: { 1: 'specs' }, hookRead: true, group: 'setup', comment: DIR_COMMENT('specs'), want: DIR_WANT },
  { path: 'paths.plans', shape: { kind: 'dir' }, since: 1, defaults: { 1: 'plans' }, hookRead: true, group: 'setup', comment: DIR_COMMENT('plans'), want: DIR_WANT },
  {
    path: 'paths.designs', shape: { kind: 'dir' }, since: 1, defaults: { 1: 'designs' }, hookRead: true, group: 'setup',
    comment: DIR_COMMENT('approved designs'), want: DIR_WANT,
  },
  {
    path: 'docs.conventions', shape: { kind: 'files' }, since: 1, defaults: { 1: [] }, group: 'setup',
    comment: 'code docs handed to code-reviewer at implement and ship · file list, [] = none',
    want: 'a list of repo-relative file paths ([] = none)',
  },
  {
    path: 'docs.design', shape: { kind: 'files' }, since: 1, defaults: { 1: [] }, group: 'setup',
    comment: 'design docs handed to design-critic and design-reviewer · file list, [] = none',
    want: 'a list of repo-relative file paths ([] = none)',
  },
  {
    path: 'criteria.runner', shape: { kind: 'runner' }, since: 1, defaults: { 1: 'npm test -- -t "@spec:{id}"' }, ambient: true, group: 'setup',
    comment: "how a spec's criteria run · a command with {id}, or full-suite",
    want: 'a filtered template containing {id}, or full-suite',
  },
  {
    path: 'criteria.report', shape: { kind: 'report' }, since: 1, defaults: { 1: 'none' }, group: 'setup',
    comment: 'the junit report witness reads · junit:<glob>, or none · full-suite needs one',
    want: 'none, or junit:<glob> (only junit is supported)',
  },
  {
    path: 'criteria.exclude', shape: { kind: 'globs' }, since: 1, defaults: { 1: [] }, group: 'setup',
    comment: 'extra globs never scanned for criteria tags · [] = none', want: 'a list of globs ([] = none)',
  },
  {
    path: 'ship.test', shape: { kind: 'text' }, since: 1, defaults: { 1: 'npm test' }, ambient: true, group: 'setup',
    comment: 'the suite command ship runs · full-suite criteria run it too', want: 'a shell command',
  },
  {
    path: 'ship.lint', shape: { kind: 'text' }, since: 1, defaults: { 1: 'npm run lint' }, ambient: true, group: 'setup',
    comment: 'the lint command ship runs', want: 'a shell command',
  },
  { path: 'ship.branch', shape: { kind: 'text' }, since: 1, defaults: { 1: 'main' }, group: 'setup', comment: 'the branch witness ships into', want: 'a branch name' },
  {
    path: 'ship.merge', shape: { kind: 'enum', values: ['merge', 'squash', 'rebase'] }, since: 1, defaults: { 1: 'merge' }, group: 'setup',
    comment: 'how ship merges its own PR under autonomy · merge | squash | rebase', want: 'merge | squash | rebase',
  },
  {
    path: 'ship.ciSettleMs', shape: { kind: 'int', min: 0, max: 1_800_000 }, since: 1, defaults: { 1: 60_000 }, group: 'setup',
    comment: 'ms green CI must hold still before an autonomous merge · 0–1800000',
    want: 'an integer from 0 to 1800000 — milliseconds a green check set must hold before witness merges',
  },
  {
    path: 'autonomy', shape: { kind: 'enum', values: ['on', 'off'] }, since: 1, defaults: { 1: 'off' }, hookRead: true, group: 'behavior',
    comment: 'on = the CLI settles its own stops and merges green PRs · on | off · counts once committed', want: 'on | off',
  },
  {
    path: 'arbiter.model', shape: PIN, since: 2, defaults: { 2: DEFAULT_MODEL }, ambient: true, group: 'behavior',
    comment: 'model for the arbiter that settles stops and checks recaps under autonomy · exact id, no aliases', want: PIN_WANT,
  },
  {
    path: 'session.contextLimit', shape: { kind: 'int', min: 1, max: 100 }, since: 1, defaults: { 1: 20 }, hookRead: true, group: 'behavior',
    comment: '% of the context window at which a session hands over to a fresh one · 1–100',
    want: "an integer from 1 to 100 — % of the session's context window at which witness hands over to a fresh session",
  },
  {
    path: 'implement.stepsPerDispatch', shape: INT1, since: 1, defaults: { 1: 3 }, group: 'behavior',
    comment: "steps an implement session takes when its context fill can't be read · ≥ 1",
    want: 'an integer >= 1 — steps handed to each fresh implement agent',
  },
  {
    path: 'gates.reviewerTimeoutMs', shape: INT1, since: 1, defaults: { 1: 600_000 }, group: 'behavior',
    comment: 'ms one reviewer, or the arbiter, may run before it is stopped (10 min) · ≥ 1',
    want: 'an integer >= 1 — milliseconds each reviewer invocation may take',
  },
  ...GATE_NAMES.flatMap(gateSettings),
  {
    path: 'drive.parallel', shape: INT1, since: 1, defaults: { 1: 2 }, group: 'tuning',
    comment: 'sessions drive runs at once, one per target · ≥ 1', want: 'an integer >= 1 — sessions drive runs at once · one per target',
  },
  {
    path: 'drive.parallelSuites', shape: { kind: 'bool' }, since: 1, defaults: { 1: false }, group: 'tuning',
    comment: 'let test runs in two worktrees overlap · true | false', want: 'true | false — whether test runs in two worktrees may overlap',
  },
  {
    path: 'drive.sessionTimeoutMs', shape: INT1, since: 1, defaults: { 1: 3_600_000 }, group: 'tuning',
    comment: 'ms one spawned session may run before it is stopped (1 h) · ≥ 1',
    want: 'an integer >= 1 — milliseconds each spawned session may take before SIGTERM',
  },
  {
    path: 'drive.caps.rounds', shape: INT1, since: 1, defaults: { 1: 16 }, group: 'tuning',
    comment: 'gate rounds one target may run across budget resets, then it is parked · ≥ 1',
    want: 'an integer >= 1 — gate rounds one target may run across budget resets before drive parks it',
  },
  {
    path: 'drive.caps.upstream', shape: INT1, since: 1, defaults: { 1: 6 }, group: 'tuning',
    comment: 'upstream resets one target may take, then it is parked · ≥ 1',
    want: 'an integer >= 1 — upstream resets one target may take before drive parks it',
  },
  {
    path: 'drive.caps.spawns', shape: INT1, since: 1, defaults: { 1: 24 }, group: 'tuning',
    comment: 'sessions one target may take in one run, then it is parked · ≥ 1',
    want: 'an integer >= 1 — sessions one target may take in one drive run',
  },
  {
    path: 'drive.caps.wallClockMs', shape: INT1, since: 1, defaults: { 1: 57_600_000 }, group: 'tuning',
    comment: 'ms of session time one target may take in one run (16 h), then it is parked · ≥ 1',
    want: 'an integer >= 1 — milliseconds of session time one target may take in one drive run',
  },
]

export const RETIRED: readonly Retired[] = [
  {
    path: 'gates.model', until: 1, shape: PIN,
    instead: "each gate's own model (gates.<gate>.model) and arbiter.model — witness migrate writes them from it",
  },
]

export const SECTION_ORDER: readonly string[] = [
  'harness', 'paths', 'docs', 'criteria', 'ship', 'autonomy', 'arbiter', 'session', 'implement', 'gates', 'drive',
]

export const FIRST_LINE = '# witness.config.yaml — every setting witness reads. Change a value in place; `witness migrate` keeps the file current.'
export const SCHEMA_COMMENT = 'format version · witness migrate raises it; never edit by hand'
export const GROUP_HEADINGS: Record<Group, string> = {
  setup: '# ── Setup: what this repo is ─────────────────────────────────────────────────',
  behavior: '# ── Behavior: how witness works here ─────────────────────────────────────────',
  tuning: '# ── Tuning: witness drive ────────────────────────────────────────────────────',
}

export function settingAt(path: string, list: readonly Setting[] = SETTINGS): Setting | undefined {
  return list.find((s) => s.path === path)
}

// The default in force at `schema`: the entry under the greatest key ≤ schema. Undefined
// before `since`, and for a schema that gave the setting no default (a pin at 1: the chain).
export function defaultAt(s: Setting, schema: number): unknown {
  if (schema < s.since) return undefined
  const keys = Object.keys(s.defaults).map(Number).filter((k) => k <= schema)
  return keys.length === 0 ? undefined : s.defaults[Math.max(...keys)]
}

export function knownAt(schema: number, list: readonly Setting[] = SETTINGS): Set<string> {
  return new Set([
    ...list.filter((s) => s.since <= schema).map((s) => s.path),
    ...RETIRED.filter((r) => r.until >= schema).map((r) => r.path),
  ])
}

const isMap = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

export function getIn(raw: Record<string, unknown>, path: string): unknown {
  let cur: unknown = raw
  for (const k of path.split('.')) {
    if (!isMap(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

// `{a: {b: 1}}` from 'a.b' and 1; the building block of every nested patch.
export function nest(path: string, value: unknown): Record<string, unknown> {
  return path.split('.').reduceRight<unknown>((acc, k) => ({ [k]: acc }), value) as Record<string, unknown>
}

// Maps merge, everything else replaces, and an undefined value deletes its key. Never mutates.
export function withValues(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, val] of Object.entries(patch)) {
    if (val === undefined) delete out[k]
    else if (isMap(val) && isMap(out[k])) out[k] = withValues(out[k] as Record<string, unknown>, val)
    else out[k] = structuredClone(val)
  }
  return out
}

// Every setting at its default for `schema` (the newest by default), as the nested map a file
// parses to, `schema` key included. `harness` overrides the list's default judge.
export function defaultValues(opts: { harness?: string; schema?: number } = {}): Record<string, unknown> {
  const schema = opts.schema ?? Math.max(...Object.keys(SCHEMA_FINGERPRINTS).map(Number))
  let out: Record<string, unknown> = { schema }
  for (const s of SETTINGS) {
    const d = s.path === 'harness' && opts.harness !== undefined ? opts.harness : defaultAt(s, schema)
    if (d !== undefined) out = withValues(out, nest(s.path, d))
  }
  return out
}

// What a schema promises a file means: every path, shape, `since` and default in force at
// that schema. Comments, wants and groups are left out, so rewording one needs no schema step:
// `migrate` refreshes witness's comments on every run (§4.1).
export function fingerprint(schema: number, list: readonly Setting[] = SETTINGS): string {
  const live = list.filter((s) => s.since <= schema)
    .map((s) => [s.path, s.shape, s.since, defaultAt(s, schema) ?? null] as const)
  const retired = RETIRED.filter((r) => r.until >= schema).map((r) => [r.path, r.shape, 'retired', r.until] as const)
  const all = [...live, ...retired].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(all)).digest('hex')
}

// One entry per schema this list can describe. A change that moves any of them is a schema
// step: add the default under the next number, raise SCHEMA_VERSION, pin the new fingerprint.
export const SCHEMA_FINGERPRINTS: Readonly<Record<number, string>> = {
  1: 'eb9dc2e9b1e2bf2a35db862bf57185f717e21f8446c473b7da67e645100fa7ed',
  2: '8e75dcbd5e9af13e7846fc5b954f082812e50f9c4807607235e47489bcabeeae',
}
