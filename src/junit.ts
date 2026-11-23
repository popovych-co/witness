import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegExp, walkFiles } from './glob.js'
import { matchesTag } from './matcher.js'
import { ok, refuse, v, type Result } from './refusal.js'

export interface TestOutcome {
  name: string
  classname: string
  status: 'passed' | 'failed' | 'skipped'
  // Row 258. The case failed outside any test: its file never loaded (a missing import, a syntax
  // error, a module or a hook that threw). Its status stays 'failed', so no existing reader moves.
  load?: true
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

// Row 258, the load rule. A load failure is a testcase holding an <error> element, or a failed one
// whose name equals its classname and the name of the suite it sits in. The second rule is vitest's:
// 4.1.10 (both consumers' runner) never writes <error> — a missing import, a syntax error, a module
// that throws at import and a beforeAll that throws each write <failure> on a synthetic testcase
// named after its file, in the suite named after that file (probe t2b-junit-vitest-4.1.10.xml
// beside the impl map), while a failed test is named for itself. The suite's name is what keeps
// jest-junit out (slice 1 review): its defaults name every case '{classname} {title}' twice over,
// inside a suite named after the top describe.
export function parseJUnit(xml: string): TestOutcome[] {
  const clean = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const out: TestOutcome[] = []
  // Each <testsuite> opening (never <testsuites>), in document order: a case's suite is the last
  // one opened before it.
  const suites = [...clean.matchAll(/<testsuite\b([^>]*?)\/?>/g)].map((s) => ({ at: s.index, name: attrs(s[1] ?? '').name }))
  let si = -1
  const suiteOf = (at: number): string | undefined => {    // called with `at` rising: one pass
    while (si + 1 < suites.length && suites[si + 1]!.at < at) si++
    return si >= 0 ? suites[si]!.name : undefined
  }
  const re = /<testcase\b([^>]*?)(\/)?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    const a = attrs(m[1] ?? '')
    const name = a.name ?? ''
    const classname = a.classname ?? ''
    let status: TestOutcome['status'] = 'passed'
    let load = false
    if (m[2] !== '/') {
      const end = clean.indexOf('</testcase>', re.lastIndex)
      const inner = clean.slice(re.lastIndex, end === -1 ? undefined : end)
      const error = /<error\b/.test(inner)
      const failure = /<failure\b/.test(inner)
      if (error || failure) {
        status = 'failed'
        load = error || (name === classname && suiteOf(m.index) === classname)
      } else if (/<skipped\b/.test(inner)) status = 'skipped'
      if (end !== -1) re.lastIndex = end + '</testcase>'.length
    }
    out.push({ name, classname, status, ...(load ? { load: true as const } : {}) })
  }
  return out
}

// Row 258. The files that failed to load, once each, sorted.
export function loadFailures(tests: readonly TestOutcome[]): string[] {
  return [...new Set(tests.filter((t) => t.load).map((t) => t.classname))].sort()
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

// Row 251. One suite run's counts, whole and per spec — ship journals it on its gate-run in
// full-suite mode, with the tree the gate reviewed (T3 reads it as the base summary).
export interface JunitCounts { passed: number; failed: number; skipped: number }
export interface JunitSummary extends JunitCounts { tree?: string; specs: Record<string, JunitCounts> }

const countsOf = (tests: readonly TestOutcome[]): JunitCounts => ({
  passed: tests.filter((t) => t.status === 'passed').length,
  failed: tests.filter((t) => t.status === 'failed').length,
  skipped: tests.filter((t) => t.status === 'skipped').length,
})

// `specs` keys only the ids with at least one tagged case, inserted in sorted id order.
export function junitSummary(tests: readonly TestOutcome[], specIds: readonly string[], tree?: string): JunitSummary {
  const specs: Record<string, JunitCounts> = {}
  for (const id of [...new Set(specIds)].sort()) {
    const mine = tests.filter((t) => matchesTag(t.name, id))
    if (mine.length > 0) specs[id] = countsOf(mine)
  }
  return { ...countsOf(tests), ...(tree !== undefined ? { tree } : {}), specs }
}
