// Row 250 (#95). JSON written the way a formatter would leave it, so a file witness writes into a
// consumer's repo (`.claude/settings.json`) is clean under the repo's own `biome check`. The rule is
// Biome's default JSON style, which Prettier's matches, reproduced byte for byte by probe
// (t0b-json-format.sh, t0b-json-boundary.sh, Biome 2.4.9):
//  - an object prints one key per line (Biome keeps an object expanded once its source breaks after
//    `{`, so this is always what it leaves alone); `{}` and `[]` print bare;
//  - an array of scalars only prints on one line when the whole line fits in `lineWidth` columns —
//    its indentation (a tab counts `tabWidth`), the `"key": ` before it, and the comma after it;
//  - any other array prints one element per line.
// An all-number array too long for one line is written one element per line, where Biome fills
// lines (Open / deferred).

export interface JsonStyle { indent: string; lineWidth: number; tabWidth: number }

export const DEFAULT_JSON_STYLE: JsonStyle = { indent: '  ', lineWidth: 80, tabWidth: 2 }

const isScalar = (v: unknown): boolean =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

function columns(s: string, style: JsonStyle): number {
  return s.replace(/\t/g, ' '.repeat(style.tabWidth)).length
}

// `prefix` is the columns before the value on its line past the indentation (`"key": `), and
// `suffix` the columns after it (a trailing comma).
function render(value: unknown, style: JsonStyle, depth: number, prefix: number, suffix: number): string {
  if (isScalar(value)) return JSON.stringify(value)
  const pad = style.indent.repeat(depth)
  const inner = style.indent.repeat(depth + 1)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every(isScalar)) {
      const flat = `[${value.map((x) => JSON.stringify(x)).join(', ')}]`
      if (columns(pad, style) + prefix + flat.length + suffix <= style.lineWidth) return flat
    }
    const last = value.length - 1
    const lines = value.map((x, i) => `${inner}${render(x, style, depth + 1, 0, i < last ? 1 : 0)}${i < last ? ',' : ''}`)
    return `[\n${lines.join('\n')}\n${pad}]`
  }
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length === 0) return '{}'
  const last = keys.length - 1
  const lines = keys.map((k, i) => {
    const head = `${JSON.stringify(k)}: `
    const body = render((value as Record<string, unknown>)[k], style, depth + 1, head.length, i < last ? 1 : 0)
    return `${inner}${head}${body}${i < last ? ',' : ''}`
  })
  return `{\n${lines.join('\n')}\n${pad}}`
}

export function formatJson(value: unknown, style: JsonStyle = DEFAULT_JSON_STYLE): string {
  return `${render(value, style, 0, 0, 0)}\n`
}
