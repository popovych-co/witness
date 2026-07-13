import { rows } from './toon.js'

export interface Violation {
  field: string
  rule: string
  got: string
  want: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; violations: Violation[] }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function refuse<T>(violations: Violation[]): Result<T> {
  return { ok: false, violations }
}

export function v(field: string, rule: string, got: string, want: string): Violation {
  return { field, rule, got, want }
}

export function renderRefusal(violations: Violation[]): string[] {
  return [
    ...rows('refused', ['field', 'rule', 'got', 'want'], violations as unknown as Array<Record<string, unknown>>),
    'help: fix each row and re-run — rows are structured for self-repair',
  ]
}
