import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegExp } from './glob.js'
import { git } from './gitio.js'

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/_/g, '-')
}

const CHARSET = /[a-z0-9-]/
const ALNUM = /[a-z0-9]/

export function matchesTag(testName: string, specId: string): boolean {
  const n = normalizeName(testName)
  for (const form of [`@spec:${specId}`, `spec-${specId}`]) {
    for (let i = n.indexOf(form); i !== -1; i = n.indexOf(form, i + 1)) {
      const before = i === 0 ? undefined : n[i - 1]
      const after = n[i + form.length]
      const beforeOk = form.startsWith('@') || before === undefined || !ALNUM.test(before)
      const afterOk = after === undefined || !CHARSET.test(after)
      if (beforeOk && afterOk) return true
    }
  }
  return false
}

export function extractCanonicalTags(text: string): string[] {
  return [...text.matchAll(/@spec:([a-z0-9-]+)/g)].map((m) => m[1] ?? '').filter(Boolean)
}

export interface SourceTags {
  counts: Map<string, number>
  files: Map<string, string[]>
}

const MAX_SCAN_BYTES = 512 * 1024

export function sourceTags(root: string, excludes: string[]): SourceTags {
  const res = { counts: new Map<string, number>(), files: new Map<string, string[]>() }
  const skip = excludes.map(globToRegExp)
  const listed = git(root, 'ls-files', '--cached', '--others', '--exclude-standard')
    .split('\n')
    .filter(Boolean)
  for (const rel of new Set(listed)) {
    if (skip.some((re) => re.test(rel))) continue
    const abs = join(root, rel)
    if (!existsSync(abs) || statSync(abs).size > MAX_SCAN_BYTES) continue
    const content = readFileSync(abs, 'utf8')
    if (content.includes('\0')) continue
    for (const tag of extractCanonicalTags(content)) {
      res.counts.set(tag, (res.counts.get(tag) ?? 0) + 1)
      const list = res.files.get(tag) ?? []
      if (!list.includes(rel)) list.push(rel)
      res.files.set(tag, list)
    }
  }
  return res
}
