import { rows } from './toon.js'

export interface Violation {
  field: string
  rule: string
  got: string
  want: string
  // D147. A runnable next command, rendered as `run:` only when it passes the same
  // no-placeholder test the decision block uses (`recommend.ts`) — a `run:` that needs
  // editing before it runs is the promise broken, which is D129's whole point.
  remedy?: string
  // D166. The row names a decision that belongs to a human: re-running cannot clear it, so the
  // self-repair trailer would be false there — row 108's principle, for a refusal.
  human?: true
}

export type Result<T> = { ok: true; value: T } | { ok: false; violations: Violation[] }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function refuse<T>(violations: Violation[]): Result<T> {
  return { ok: false, violations }
}

export function v(field: string, rule: string, got: string, want: string, remedy?: string): Violation {
  return remedy === undefined ? { field, rule, got, want } : { field, rule, got, want, remedy }
}

export const humanCall = (x: Violation): Violation => ({ ...x, human: true })

export function renderRefusal(violations: Violation[]): string[] {
  const runnable = [...new Set(
    violations.map((x) => x.remedy).filter((r): r is string => r !== undefined && !/<[^>]+>/.test(r)),
  )]
  // D167. Row 108's principle cuts both ways: the stop is true for the human's rows and false for
  // the reader's own, so the trailer names the human's rules and leaves the rest self-repairable.
  const human = [...new Set(violations.filter((x) => x.human).map((x) => x.rule))]
  const mixed = violations.some((x) => !x.human)
  return [
    // The destructure keeps `remedy` out of the row objects: the column list already
    // governs what prints, but a remedy is not a column and must not become one.
    ...rows('refused', ['field', 'rule', 'got', 'want'],
      violations.map(({ remedy: _remedy, ...rest }) => rest) as unknown as Array<Record<string, unknown>>),
    ...runnable.map((r) => `run: ${r}`),
    human.length
      ? `help: a human's decision: ${human.join(' · ')} — stop and surface the list; re-running cannot clear it`
        + (mixed ? ' · the other rows are structured for self-repair once it is settled' : '')
      : 'help: fix each row and re-run — rows are structured for self-repair',
  ]
}
