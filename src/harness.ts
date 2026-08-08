import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_THINKING_BUDGET, parsePin, type ParsedPin } from './pin.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { pinIn } from './version.js'

export const HARNESSES = ['claude-code', 'pi'] as const
export type HarnessName = (typeof HARNESSES)[number]
export const DEFAULT_HARNESS: HarnessName = 'claude-code'

// The six shipped stage skills, by directory name. `check`'s visibility probe asks
// whether the resolved harness can see all of them; a partial install is a warn, not
// a pass, because the missing one is always the stage you are about to reach.
export const STAGE_SKILLS = [
  'witness-brainstorm', 'witness-decompose', 'witness-design',
  'witness-implement', 'witness-plan', 'witness-ship',
] as const

export interface HarnessSpawn { cmd: string; args: string[]; env: Record<string, string> }
export type ReviewerSpawn = HarnessSpawn

export interface Harness {
  name: HarnessName
  launch: string
  // No `modelFlag` template: Decision 88 made the model flag a renderer over the PARSED
  // pin (modelArg), which a format string cannot express — it must choose a provider
  // per-pin and append pi's native `:thinking` suffix. A leftover template would be a
  // standing invitation to re-derive the flag from it and restore bug B2.
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
  // The judgment lane: how THIS harness runs a headless reviewer and what its stdout
  // means. spawn(undefined) is the session-default rung (no model flag). The exact flag
  // set is part of the reviewer's identity — calibrate measures through the same spawn.
  reviewer: {
    spawn(pin: ParsedPin | undefined, extensions?: readonly string[]): ReviewerSpawn
    parseEnvelope(stdout: string): Result<{ text: string }>
  }
  // The doing lane: how THIS harness runs a headless WORKER — an agent that edits a
  // worktree rather than emitting a verdict. Used by the implement skill-calibration
  // seed. The prompt rides in argv (both CLIs accept a positional message), not stdin.
  worker: {
    spawn(prompt: string): HarnessSpawn
  }
}

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
  const text = (assistant?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  if (text === '') {
    return refuse([v('pi', 'envelope-unparseable', stdout.slice(0, 120),
      'a --mode json event stream whose agent_end carries assistant text')])
  }
  return ok({ text })
}

export type HarnessSource = 'detected' | 'config' | 'default'

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
    relay: '/clear',
    settings: '.claude/settings.json',
    bundled: true,
    payload: [
      { from: 'plugin/commands/witness.md', to: '.claude/commands/witness.md' },
      { from: 'plugin/hooks/canon-guard.mjs', to: '.claude/hooks/canon-guard.mjs' },
      { from: 'plugin/hooks/guard-state.mjs', to: '.claude/hooks/guard-state.mjs' },
      { from: 'plugin/hooks/session-dashboard.sh', to: '.claude/hooks/session-dashboard.sh' },
    ],
    skills: { project: '.claude/skills', global: '.claude/skills' },
    reviewer: {
      spawn(pin: ParsedPin | undefined, _extensions?: readonly string[]): ReviewerSpawn {
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
    worker: {
      // claude gates every tool behind an approval prompt, which no headless run can
      // answer — the bypass flag is what makes print mode able to edit at all.
      spawn: (prompt: string): HarnessSpawn =>
        ({ cmd: 'claude', args: ['-p', prompt, '--dangerously-skip-permissions'], env: {} }),
    },
  },
  pi: {
    name: 'pi',
    launch: 'pi',
    defaultProvider: 'anthropic',
    relay: '/new',
    bundled: false,
    payload: [
      { from: 'plugin/commands/witness.md', to: '.pi/prompts/witness.md' },
      { from: 'plugin/hooks/canon-guard.mjs', to: '.pi/extensions/canon-guard.mjs' },
      // Source-tree sibling of canon-guard.mjs, exactly as it is in .pi/extensions/:
      // the adapter imports the core with ONE static relative specifier, and a
      // specifier that only resolves after install is a trap no unit test can hold.
      { from: 'plugin/hooks/witness-pi.ts', to: '.pi/extensions/witness.ts' },
      { from: 'plugin/hooks/session-dashboard.sh', to: '.pi/extensions/session-dashboard.sh' },
    ],
    skills: { project: '.pi/skills', global: '.pi/agent/skills' },
    // Hermetic (Decision 88): every omitted flag here is a machine-local variable that
    // would silently change reviewer behavior — this machine's `defaultThinkingLevel:
    // xhigh` was the probable true cause of row 87's "stalls on long prompts".
    //
    // Declared reviewerExtensions (machine config) are the ONE sanctioned readmission —
    // auth transport, journaled per gate-run, never part of the verdict-cache key. The
    // worker below keeps full discovery on purpose: skills and context files are what
    // the implement seed measures; auth extensions ride along with everything else there.
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
    worker: {
      // No bypass flag exists or is needed: pi's built-in tools are not approval-gated
      // (`pi --help` lists only --approve/--no-approve, which govern trusting
      // project-local files). --no-session keeps a calibration run out of the user's
      // session store; the worker otherwise keeps its skills and context files, which
      // are exactly what the implement seed is measuring.
      spawn: (prompt: string): HarnessSpawn =>
        ({ cmd: 'pi', args: ['-p', prompt, '--no-session'], env: {} }),
    },
  },
}

export function loadHarness(name: string): Result<Harness> {
  const harness = (REGISTRY as Record<string, Harness | undefined>)[name]
  if (harness === undefined) {
    return refuse([v('harness', 'unknown-harness', name, HARNESSES.join(' | '))])
  }
  return ok(harness)
}

// Decision 5. Detection is the authority; config is the fallback. A config-authority
// default in a fresh repo emits a runnable-LOOKING, unrunnable handoff behind a warning
// that gets scrolled past — bug B2's exact shape. Detection tests PRESENCE: neither
// CLAUDECODE=1 nor PI_CODING_AGENT=true is a documented value contract.
//
// Deliberately NOT wired into loadConfig: every verb calls that, so an invalid
// `harness:` there would brick `witness check` on a key nothing read. Verbs that need
// a harness ask for one; `check` reports a malformed config value as a finding.
//
// Row 90 removed the WITNESS_HARNESS env rung: configuration has one home, and tests
// simulate harnesses by setting the detection vars production actually reads.
export function resolveHarness(
  env: Record<string, string | undefined>,
  raw: Record<string, unknown>,
): Result<{ harness: Harness; source: HarnessSource }> {
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
// Revision 9: the provider is the HARNESS's default, never a config key.
//
// Extended by Decision 88: the flag renders over the PARSED pin, not the raw string.
// Treating the whole string as {model} emitted `--model anthropic/google/gemini-3.6-pro`
// for a provider-qualified pin — pastes cleanly, resolves to nothing: bug B2's shape.
// Pi renders the provider and its native `:thinking` suffix; claude-code renders the
// bare id and carries non-off thinking as a MAX_THINKING_TOKENS prefix on the line.
function modelArg(harness: Harness, model: string | undefined): string {
  if (model === undefined || model === '') return ''
  const parsed = parsePin('gates.model', model)
  if (!parsed.ok) return ''  // stagePin refused upstream; render nothing rather than garbage
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

// No comma: toon's esc() quotes any value containing one (toon.ts:3), and a quoted
// `relay: "/clear, then /witness"` is what the implement skill would then print
// verbatim — the same class of defect as the double-quoted handoff note above.
export function relayLine(harness: Harness): string {
  return `${harness.relay} then /witness`
}

// Decision 14. Pi resolves project skills at resolve(cwd, '.pi', 'skills') with no
// upward walk, and implement runs with cwd inside .witness/worktrees/<plan-id> — an
// untracked directory the installer never touched. A project-scope install therefore
// loses every skill in the stage that does the most work.
//
// Row 103 needs the DIRECTORY, not just the verdict: with `latest` in hand, one pass
// reports both halves of the skew, and the skills half has to read the files it found.
export function resolveSkills(
  env: Record<string, string | undefined>, root: string, harness: Harness,
): { scope: 'global' | 'project-only' | 'absent'; dir?: string } {
  const home = env.HOME ?? env.USERPROFILE ?? ''
  const has = (dir: string): boolean =>
    STAGE_SKILLS.every((s) => existsSync(join(dir, s, 'SKILL.md')))
  const global = home === '' ? undefined : join(home, harness.skills.global)
  if (global !== undefined && has(global)) return { scope: 'global', dir: global }
  const project = join(root, harness.skills.project)
  if (has(project)) return { scope: 'project-only', dir: project }
  return { scope: 'absent' }
}

export function skillsVisibility(
  env: Record<string, string | undefined>, root: string, harness: Harness,
): 'global' | 'project-only' | 'absent' {
  return resolveSkills(env, root, harness).scope
}

// What pin does each installed skill carry? Nothing more — whether a pin is a PROBLEM
// takes the published `latest`, which is check's question and check's alone. A skill
// whose SKILL.md carries no pin is simply absent from the result: the pin is what makes
// a skill invoke a particular CLI, so one without it says nothing about skew.
export function skillPins(dir: string): Array<{ skill: string; pin: string }> {
  return STAGE_SKILLS.flatMap((skill) => {
    const p = join(dir, skill, 'SKILL.md')
    if (!existsSync(p)) return []
    const pin = pinIn(readFileSync(p, 'utf8'))
    return pin === undefined ? [] : [{ skill, pin }]
  })
}

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
