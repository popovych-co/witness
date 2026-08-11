function esc(value: unknown): string {
  const s = String(value ?? '')
  return /[,"\n]|^\s|\s$/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function kv(key: string, value: unknown): string {
  return `${key}: ${esc(value)}`
}

// Commands are the one value class that must survive verbatim: `esc` quotes anything
// containing `,` or `"`, and `--revise --note "<why>"` contains both — so the exits line
// reached humans as `exits: "witness decide … --note ""<why>"" …"`, which pastes into a
// shell as an empty --note. The gate printed the same string clean through a template
// literal, so this is one string with two renderings (D120). Structured values keep `kv`.
export function cmd(key: string, command: string): string {
  return `${key}: ${command}`
}

export function list(key: string, values: unknown[]): string {
  return `${key}[${values.length}]: ${values.map(esc).join(',')}`
}

export function rows(key: string, fields: string[], items: Array<Record<string, unknown>>): string[] {
  return [
    `${key}[${items.length}]{${fields.join(',')}}:`,
    ...items.map((it) => '  ' + fields.map((f) => esc(it[f])).join(',')),
  ]
}
