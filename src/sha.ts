import { createHash } from 'node:crypto'

export const VOLATILE_FIELDS = ['status', 'drift', 'pr'] as const

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

export function short(sha: string): string {
  return sha.slice(0, 7)
}
