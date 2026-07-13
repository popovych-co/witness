import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegExp, walkFiles } from './glob.js'
import { ok, refuse, v, type Result } from './refusal.js'

export interface TestOutcome {
  name: string
  classname: string
  status: 'passed' | 'failed' | 'skipped'
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(Number.parseInt(e.slice(2), 16))
    if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? whole
  })
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1] ?? ''] = decode(m[2] ?? m[3] ?? '')
  }
  return out
}

export function parseJUnit(xml: string): TestOutcome[] {
  const clean = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const out: TestOutcome[] = []
  const re = /<testcase\b([^>]*?)(\/)?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    const a = attrs(m[1] ?? '')
    let status: TestOutcome['status'] = 'passed'
    if (m[2] !== '/') {
      const end = clean.indexOf('</testcase>', re.lastIndex)
      const inner = clean.slice(re.lastIndex, end === -1 ? undefined : end)
      if (/<(?:failure|error)\b/.test(inner)) status = 'failed'
      else if (/<skipped\b/.test(inner)) status = 'skipped'
      if (end !== -1) re.lastIndex = end + '</testcase>'.length
    }
    out.push({ name: a.name ?? '', classname: a.classname ?? '', status })
  }
  return out
}

export function reportFiles(root: string, glob: string): string[] {
  const re = globToRegExp(glob)
  return walkFiles(root).filter((f) => re.test(f))
}

export function mergeReports(root: string, glob: string): Result<TestOutcome[]> {
  const files = reportFiles(root, glob)
  if (files.length === 0) {
    return refuse([v('criteria.report', 'no-reports', `junit:${glob} matched no files`, 'at least one report — did the suite run?')])
  }
  return ok(files.flatMap((f) => parseJUnit(readFileSync(join(root, f), 'utf8'))))
}
