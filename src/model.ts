import type { Config } from './config.js'
import { checkPin, parsePin } from './pin.js'
import type { GateName } from './settings.js'
import { humanCall, ok, refuse, v, type Result, type Violation } from './refusal.js'

export { MODEL_ALIASES } from './pin.js'
export const SESSION_DEFAULT = 'session-default'

// A stage's model pin, from its own setting (row 193: nothing inherited). A gate's pin drives
// its reviewers AND, for implement, its worker agent; the arbiter's is its own (row 172).
// Undefined only for an older file that never pinned one: the session default answers.
export function stagePin(cfg: Config, role: GateName | 'arbiter'): Result<string | undefined> {
  const pin = role === 'arbiter' ? cfg.arbiter.model : cfg.gates[role].model
  if (pin === undefined) return ok(undefined)
  const checked = checkPin(role === 'arbiter' ? 'arbiter.model' : `gates.${role}.model`, pin)
  return checked.ok ? ok(pin) : refuse(checked.violations)
}

// Row 212. The one model a stage's reviewers (or the arbiter) are asked on: its pin, else the
// session default. There is no stand-in — a model that cannot be invoked refuses the gate.
export function stageModel(cfg: Config, role: GateName | 'arbiter'): Result<string> {
  const pinR = stagePin(cfg, role)
  if (!pinR.ok) return refuse(pinR.violations)
  return ok(pinR.value ?? SESSION_DEFAULT)
}

// Row 212 (C3). Every stand-in round in the field came from a pin edited into a model the
// harness could not invoke, so a refusal on a pinned model names the setting to fix. It is a
// human's call only when the harness's own error names that model as one it cannot run — only
// the config's owner knows which model they meant. Anything else (a provider blip, a missing
// binary, an expired login) is named, not blamed: clearing that error and re-running is the
// fix, and the human trailer would say re-running cannot clear it.
export function unansweredPin(rows: Violation[], field: string, model: string, harness: string): Violation[] {
  if (model === SESSION_DEFAULT) return rows
  const failed = rows.filter((x) => x.rule === 'reviewer-invocation')
  if (failed.length === 0) return rows
  const named = failed.some((x) => namesMissingModel(x.got, model))
  const row = v(field, 'pin-unanswered', model, named
    ? `a model the ${harness} harness can invoke — its error names this pin, so fix it in witness.config.yaml`
    : `a model the ${harness} harness can invoke — if the error above is about this pin, fix it in witness.config.yaml; otherwise clear that error and re-run`)
  return [...rows, named ? humanCall(row) : row]
}

// The model id itself in the error, beside a phrase saying it cannot be run: claude's
// `not_found_error` and its "issue with the selected model" text, pi's "not found" — an error
// that names no model (a 5xx, a login, ENOENT) is about something else.
const MISSING_MODEL = /not.?found|not exist|unknown|invalid|unsupported|not available|access to/i
function namesMissingModel(got: string, pin: string): boolean {
  const parsed = parsePin('model', pin)
  return got.includes(parsed.ok ? parsed.value.model : pin) && MISSING_MODEL.test(got)
}
