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

export function renderRefusal(violations: Violation[]): string[] {
  const runnable = [...new Set(
    violations.map((x) => x.remedy).filter((r): r is string => r !== undefined && !/<[^>]+>/.test(r)),
  )]
  return [
    // The destructure keeps `remedy` out of the row objects: the column list already
    // governs what prints, but a remedy is not a column and must not become one.
    ...rows('refused', ['field', 'rule', 'got', 'want'],
      violations.map(({ remedy: _remedy, ...rest }) => rest) as unknown as Array<Record<string, unknown>>),
    ...runnable.map((r) => `run: ${r}`),
    'help: fix each row and re-run — rows are structured for self-repair',
  ]
}
