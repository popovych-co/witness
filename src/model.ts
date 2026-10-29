import type { Config } from './config.js'
import { checkPin } from './pin.js'
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
// harness could not invoke, so a dead pin's refusal names the setting to fix — a human's
// call, because only the config's owner knows which model they meant.
export function unansweredPin(rows: Violation[], field: string, model: string, harness: string): Violation[] {
  if (model === SESSION_DEFAULT || !rows.some((x) => x.rule === 'reviewer-invocation')) return rows
  return [...rows, humanCall(v(field, 'pin-unanswered', model,
    `a model the ${harness} harness can invoke — if this pin is the cause, fix it in witness.config.yaml`))]
}
