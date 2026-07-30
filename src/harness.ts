import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'

export const HARNESSES = ['claude-code', 'pi'] as const
export type HarnessName = (typeof HARNESSES)[number]
export const DEFAULT_HARNESS: HarnessName = 'claude-code'

// The six shipped stage skills, by directory name. `check`'s visibility probe asks
// whether the resolved harness can see all of them; a partial install is a warn, not
// a pass, because the missing one is always the stage you are about to reach.
export const STAGE_SKILLS = [
  'specflow-brainstorm', 'specflow-decompose', 'specflow-design',
  'specflow-implement', 'specflow-plan', 'specflow-ship',
] as const

export interface Harness {
  name: HarnessName
  launch: string
  modelFlag: string
  defaultProvider?: string
  relay: string
  settings?: string
  // Does ONE native install deliver skills AND engine AND guard? Claude Code's
  // marketplace plugin does, out of band of every directory check can probe — so an
  // empty probe there is not evidence of a problem, and a false warning on every run is
  // worse than a missing one. Pi has no such bundle, so absence there IS evidence.
  bundled: boolean
  payload: Array<{ from: string; to: string }>
  skills: { project: string; global: string }
}

export type HarnessSource = 'env' | 'detected' | 'config' | 'default'

// Revision 10: a typed constant, not `harness/<name>.json`. Every consumer is
// TypeScript and the name set is closed by loadHarness's refusal, so a data file bought
// extensibility the design forbids — while costing an unchecked `as Harness` cast, a
// registry-missing path, packageRoot(), and a packaging failure mode NO test can catch:
// drop the dir from package.json `files` and every verb refuses in the published
// package while the whole suite stays green, because vitest reads from the repo root.
const REGISTRY: Record<HarnessName, Harness> = {
  'claude-code': {
    name: 'claude-code',
    launch: 'claude',
    modelFlag: '--model {model}',
    relay: '/clear',
    settings: '.claude/settings.json',
    bundled: true,
    payload: [
      { from: 'plugin/commands/specflow.md', to: '.claude/commands/specflow.md' },
      { from: 'plugin/hooks/canon-guard.mjs', to: '.claude/hooks/canon-guard.mjs' },
      { from: 'plugin/hooks/guard-state.mjs', to: '.claude/hooks/guard-state.mjs' },
      { from: 'plugin/hooks/session-dashboard.sh', to: '.claude/hooks/session-dashboard.sh' },
    ],
    skills: { project: '.claude/skills', global: '.claude/skills' },
  },
  pi: {
    name: 'pi',
    launch: 'pi',
    modelFlag: '--model {provider}/{model}',
    defaultProvider: 'anthropic',
    relay: '/new',
    bundled: false,
    payload: [
      { from: 'plugin/commands/specflow.md', to: '.pi/prompts/specflow.md' },
      { from: 'plugin/hooks/canon-guard.mjs', to: '.pi/extensions/canon-guard.mjs' },
      // Source-tree sibling of canon-guard.mjs, exactly as it is in .pi/extensions/:
      // the adapter imports the core with ONE static relative specifier, and a
      // specifier that only resolves after install is a trap no unit test can hold.
      { from: 'plugin/hooks/specflow-pi.ts', to: '.pi/extensions/specflow.ts' },
      { from: 'plugin/hooks/session-dashboard.sh', to: '.pi/extensions/session-dashboard.sh' },
    ],
    skills: { project: '.pi/skills', global: '.pi/agent/skills' },
  },
}

export function loadHarness(name: string): Result<Harness> {
  const harness = (REGISTRY as Record<string, Harness | undefined>)[name]
  if (harness === undefined) {
    return refuse([v('harness', 'unknown-harness', name, HARNESSES.join(' | '))])
  }
  return ok(harness)
}

const relabel = (violations: Violation[], field: string): Violation[] =>
  violations.map((x) => ({ ...x, field }))

// Decision 5. Detection is the authority; config is the fallback. A config-authority
// default in a fresh repo emits a runnable-LOOKING, unrunnable handoff behind a warning
// that gets scrolled past — bug B2's exact shape. Detection tests PRESENCE: neither
// CLAUDECODE=1 nor PI_CODING_AGENT=true is a documented value contract.
//
// Deliberately NOT wired into loadConfig: every verb calls that, so an invalid
// `harness:` there would brick `specflow check` on a key nothing read. Verbs that need
// a harness ask for one; `check` reports a malformed config value as a finding.
export function resolveHarness(
  env: Record<string, string | undefined>,
  raw: Record<string, unknown>,
): Result<{ harness: Harness; source: HarnessSource }> {
  const override = env.SPECFLOW_HARNESS
  if (override !== undefined && override !== '') {
    const r = loadHarness(override)
    return r.ok ? ok({ harness: r.value, source: 'env' }) : refuse(relabel(r.violations, 'SPECFLOW_HARNESS'))
  }
  if (env.PI_CODING_AGENT !== undefined) {
    const r = loadHarness('pi')
    return r.ok ? ok({ harness: r.value, source: 'detected' }) : refuse(r.violations)
  }
  if (env.CLAUDECODE !== undefined) {
    const r = loadHarness('claude-code')
    return r.ok ? ok({ harness: r.value, source: 'detected' }) : refuse(r.violations)
  }
  const configured = raw.harness
  if (configured !== undefined) {
    const r = loadHarness(String(configured))
    return r.ok ? ok({ harness: r.value, source: 'config' }) : refuse(r.violations)
  }
  const r = loadHarness(DEFAULT_HARNESS)
  return r.ok ? ok({ harness: r.value, source: 'default' }) : refuse(r.violations)
}

// Decision 9: the model flag is a renderer, not a string. Pi's default provider is
// `google`, so a bare `--model claude-opus-5` in a Pi handoff resolves wrong or not at
// all — and a relay session silently running an unpinned model corrupts what row 83's
// pins and the calibration story rest on.
//
// Revision 9: the provider is the HARNESS's default, never a config key. Decision 12
// forces the pin to be a claude-runnable id (the same value drives that stage's gate
// reviewers, model.ts:37), so `anthropic` is a consequence, not a preference — and the
// only other reachable state was silently wrong: `pi --model google/claude-opus-5`
// pastes cleanly and resolves to nothing, which is bug B2's exact shape.
function modelArg(harness: Harness, model: string | undefined): string {
  if (model === undefined || model === '') return ''
  const rendered = harness.modelFlag
    .replace('{provider}', harness.defaultProvider ?? '')
    .replace('{model}', model)
  return ` ${rendered}`
}

// Single quotes: a double-quoted form trips toon esc() quoting and emits an
// unpasteable line (see the note this replaces at verbs/next.ts:69).
export function handoffLine(harness: Harness, home: string, model: string | undefined): string {
  return `cd '${home}' && ${harness.launch}${modelArg(harness, model)} '/specflow'`
}

// No comma: toon's esc() quotes any value containing one (toon.ts:3), and a quoted
// `relay: "/clear, then /specflow"` is what the implement skill would then print
// verbatim — the same class of defect as the double-quoted handoff note above.
export function relayLine(harness: Harness): string {
  return `${harness.relay} then /specflow`
}

// Decision 14. Pi resolves project skills at resolve(cwd, '.pi', 'skills') with no
// upward walk, and implement runs with cwd inside .specflow/worktrees/<plan-id> — an
// untracked directory the installer never touched. A project-scope install therefore
// loses every skill in the stage that does the most work.
export function skillsVisibility(
  env: Record<string, string | undefined>, root: string, harness: Harness,
): 'global' | 'project-only' | 'absent' {
  const home = env.HOME ?? env.USERPROFILE ?? ''
  const has = (dir: string): boolean =>
    STAGE_SKILLS.every((s) => existsSync(join(dir, s, 'SKILL.md')))
  if (home !== '' && has(join(home, harness.skills.global))) return 'global'
  if (has(join(root, harness.skills.project))) return 'project-only'
  return 'absent'
}
