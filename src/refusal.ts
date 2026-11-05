import { logSafe, rows } from './toon.js'

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

// Row 239 (ruling R25). A cell as the table prints it: as `rows` reads a value, spelled out.
const spelled = (cell: unknown): string => logSafe(String(cell ?? ''))

export function renderRefusal(violations: Violation[]): string[] {
  const runnable = [...new Set(
    violations.map((x) => x.remedy).filter((r): r is string => r !== undefined && !/<[^>]+>/.test(r)),
  )]
  // D167. Row 108's principle cuts both ways: the stop is true for the human's rows and false for
  // the reader's own, so the trailer names the human's rules and leaves the rest self-repairable.
  const human = [...new Set(violations.filter((x) => x.human).map((x) => x.rule))]
  const mixed = violations.some((x) => !x.human)
  return [
    // The four columns alone make each row: a remedy is not a column and must not become one.
    // Row 239 (ruling R25): the table heads the `run:` remedy rows below it, so, as R16(a) has every
    // line heading an offered row print, each cell is spelled out (`logSafe`): a `got` or a `want`
    // echoing foreign text — a hand-edited doc's id, a typed argument, a tool's output — that holds a
    // line break would otherwise start a physical line of its own, which can read `run:`. Printable
    // text prints as it did, and only this printed copy is spelled: the violations stay as given.
    ...rows('refused', ['field', 'rule', 'got', 'want'], violations.map((x) => ({
      field: spelled(x.field), rule: spelled(x.rule), got: spelled(x.got), want: spelled(x.want),
    }))),
    ...runnable.map((r) => `run: ${r}`),
    human.length
      ? `help: a human's decision: ${human.join(' · ')} — stop and surface the list; re-running cannot clear it`
        + (mixed ? ' · the other rows are structured for self-repair once it is settled' : '')
      : 'help: fix each row and re-run — rows are structured for self-repair',
  ]
}
