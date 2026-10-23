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

// Names that re-point when a vendor ships a new model, so a pin naming one is no pin.
export const MODEL_ALIASES: readonly string[] = ['sonnet', 'opus', 'haiku', 'fable', 'default', 'latest']

// The one pin check (row 193): the grammar, then the alias refusal. Every pinned setting —
// a gate's model, the arbiter's — runs it where it is read and where it is used.
export function checkPin(field: string, raw: string): Result<string> {
  const parsed = parsePin(field, raw)
  if (!parsed.ok) return refuse(parsed.violations)
  if (MODEL_ALIASES.includes(parsed.value.model)) {
    return refuse([v(field, 'alias-refused', raw,
      'an exact model id — aliases re-point under the calibration (Decision 55)')])
  }
  return ok(raw)
}
