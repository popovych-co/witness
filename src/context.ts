import { createHash } from 'node:crypto'
import { HARNESSES, loadHarness, resolveDriver } from './harness.js'
import type { JournalCtx } from './journal.js'

type Env = Record<string, string | undefined>

// Row 191 §4.1. Before every shell command the harness adapter puts the session's live fill
// here, as the harness itself measures it:
//   {"session":"<harness session id>","tokens":31627,"window":1000000,"percent":3}
// The CLI counts nothing and keeps no table of windows (§2: a second ledger would drift from
// what the harness shows), and it ignores `percent`, so the two harnesses cannot round apart.
export const CONTEXT_ENV = 'WITNESS_CONTEXT'

export interface Reading { session: string; tokens: number; window: number }
export type Unmeasured = 'no adapter' | 'stale' | 'malformed' | 'no reading yet'
export type Fill = { measured: true; reading: Reading } | { measured: false; reason: Unmeasured }

// The session is a fact about the process running this command, not about the repo, so it
// comes from the driver ladder without the config rung: detection, else the default harness.
// The variable is the registry's `session` facet, never spelled here.
export function sessionIdOf(env: Env): string | undefined {
  const driver = resolveDriver(env, {})
  if (!driver.ok) return undefined
  const id = env[driver.value.harness.session]
  return id === undefined || id === '' ? undefined : id
}

// Row 191 §4.8: the journal is committed, so it carries this hash and never the id itself.
export function sessionHash(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12)
}

const unmeasured = (reason: Unmeasured): Fill => ({ measured: false, reason })
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x)

// Row 191 §4.1. Trusted only when it parses, carries integer counts with tokens ≤ window, and
// names the session the harness names. That last check is what makes an inherited value
// harmless: a drive launched from a chat session's shell carries the chat's reading, and its
// child runs as a session of its own. The order is the reasons' precedence: a broken value is
// malformed whoever wrote it, and only this session's own value can say it has no reading yet.
export function readFill(env: Env): Fill {
  const raw = env[CONTEXT_ENV]
  if (raw === undefined || raw === '') return unmeasured('no adapter')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return unmeasured('malformed')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return unmeasured('malformed')
  const { session, tokens, window } = parsed as Record<string, unknown>
  if (typeof session !== 'string' || session === '') return unmeasured('malformed')
  if (!isInt(window) || window < 1) return unmeasured('malformed')
  if (tokens !== undefined && tokens !== null && (!isInt(tokens) || tokens < 0 || tokens > window)) {
    return unmeasured('malformed')
  }
  if (session !== sessionIdOf(env)) return unmeasured('stale')
  // P7: Claude Code sends no `tokens` before the session's first response, Pi sends 0 then,
  // and Pi sends null right after a compaction. Each is a reading not taken yet.
  if (!isInt(tokens) || tokens === 0) return unmeasured('no reading yet')
  return { measured: true, reading: { session, tokens, window } }
}

// Row 191 §4.8: what this invocation's journal lines carry. The session whenever the harness
// names one, even unmeasured, because the step-budget fallback counts a session's steps by
// it; the reading only when it is trusted. Outside a harness session, nothing.
export function journalStamp(env: Env): JournalCtx | undefined {
  const id = sessionIdOf(env)
  if (id === undefined) return undefined
  const session = sessionHash(id)
  const fill = readFill(env)
  return fill.measured ? { session, tokens: fill.reading.tokens, window: fill.reading.window } : { session }
}

// Row 191 §4.9. Drive is a scheduler, not a session. Started from a chat session's shell, it
// inherits that session's reading and the harness's session variable, and neither is a fact
// about drive or about the sessions it spawns: each harness names its own session on its own
// commands (P1, and pi's bash tool). Every harness's variable goes, whichever drive spawns,
// read from the registry so none is spelled here.
export function withoutSession(env: Env): Env {
  const out = { ...env }
  delete out[CONTEXT_ENV]
  for (const name of HARNESSES) {
    const harness = loadHarness(name)
    if (harness.ok) delete out[harness.value.session]
  }
  return out
}

// Row 191 §4.5. The decision is `reached`, in integer tokens; the display is floored, so the
// two agree: a printed 19% never hands over and a printed 20% always does. Rounding would
// print 20% beside a session that carries on.
//
// pctOf and windowLabel have a twin in plugin/hooks/context-core.mjs, for the adapters' warning:
// the CLI must not import plugin/ at runtime, so tests/context-core.test.ts holds the two equal.
export function pctOf(tokens: number, window: number): number {
  return Math.floor(tokens * 100 / window)
}

export function reached(tokens: number, window: number, limit: number): boolean {
  return tokens * 100 >= limit * window
}

// The window a fill is a share of, the way people say it: 1M, 200k. Display only: a window that
// is not round reads approximately (1048576 is 1M), and the percentage still uses the exact one.
// Thousands are rounded first, so a window that rounds up to a thousand of them reads 1M, never
// 1000k.
export function windowLabel(window: number): string {
  if (window < 1_000) return String(window)
  const thousands = Math.round(window / 1_000)
  if (thousands < 1_000) return `${thousands}k`
  return `${Math.round(window / 100_000) / 10}M`
}
