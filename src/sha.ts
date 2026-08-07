import { createHash } from 'node:crypto'

export const VOLATILE_FIELDS = ['status', 'drift', 'pr', 'design'] as const

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => JSON.stringify(k) + ':' + canonicalJson(val))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}

export function canonicalSha(meta: Record<string, unknown>, body: string): string {
  const kept = Object.fromEntries(
    Object.entries(meta).filter(([k]) => !(VOLATILE_FIELDS as readonly string[]).includes(k)),
  )
  return createHash('sha256')
    .update(canonicalJson(kept))
    .update('\0')
    .update(body.replace(/\s+$/, '') + '\n')
    .digest('hex')
}

// Row 95: a re-authored plan re-arms the implement gate, so the plan's content joins that
// gate's reviewed identity — the battery reads the plan (`codePromptBody` serializes it into
// the prompt), so the identity should say so. `derives-from` is excluded ON TOP of
// VOLATILE_FIELDS because ship's own `repin` rewrites it inside the same transaction as the
// gate run: keep it and the entry invalidates itself the moment it is written, which is
// row 96's self-invalidation in a second place.
export function planContentSha(meta: Record<string, unknown>, body: string): string {
  const { 'derives-from': _repinned, ...rest } = meta
  return canonicalSha(rest, body)
}

export function short(sha: string): string {
  return sha.slice(0, 7)
}
