function esc(value: unknown): string {
  const s = String(value ?? '')
  return /[,"\n]|^\s|\s$/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function kv(key: string, value: unknown): string {
  return `${key}: ${esc(value)}`
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
