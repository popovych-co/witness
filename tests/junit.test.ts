import { describe, expect, it } from 'vitest'
import { mergeReports, parseJUnit } from '../src/junit.js'
import { tmpRepo } from './helpers.js'

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest" tests="4">
  <testsuite name="tests/token.test.ts" tests="4">
    <testcase name="rotates token before expiry @spec:auth-refresh" classname="tests/token.test.ts" time="0.01"/>
    <testcase classname="tests/token.test.ts" name="issues fresh token @spec:auth-refresh" time="0.01">
      <failure message="expected 'a1-r' to not be 'a1'">assertion text with &lt;angle&gt; noise</failure>
    </testcase>
    <testcase name="flaky one" classname="tests/token.test.ts">
      <skipped/>
    </testcase>
    <testcase name="errored one" classname="tests/token.test.ts">
      <error message="boom"><![CDATA[<testcase name="fake @spec:not-real"/>]]></error>
    </testcase>
  </testsuite>
</testsuites>`

describe('parseJUnit', () => {
  it('reads name/classname regardless of attribute order and maps statuses', () => {
    const out = parseJUnit(REPORT)
    expect(out).toHaveLength(4)
    expect(out[0]).toEqual({ name: 'rotates token before expiry @spec:auth-refresh', classname: 'tests/token.test.ts', status: 'passed' })
    expect(out[1]?.status).toBe('failed')
    expect(out[2]?.status).toBe('skipped')
    expect(out[3]?.status).toBe('failed')
  })

  it('ignores testcase-looking markup inside CDATA (no phantom tests)', () => {
    expect(parseJUnit(REPORT).some((t) => t.name.includes('not-real'))).toBe(false)
  })

  it('decodes XML entities in names', () => {
    const xml = '<testsuite><testcase name="a &amp; b &quot;q&quot; &#x40;spec" classname="c"/></testsuite>'
    expect(parseJUnit(xml)[0]?.name).toBe('a & b "q" @spec')
  })

  it('handles single-quoted attributes', () => {
    const xml = "<testsuite><testcase name='sq name' classname='sq.ts'/></testsuite>"
    expect(parseJUnit(xml)[0]).toEqual({ name: 'sq name', classname: 'sq.ts', status: 'passed' })
  })
})

describe('mergeReports', () => {
  it('merges one report per package (the monorepo shape)', () => {
    const repo = tmpRepo()
    repo.write('packages/a/reports/junit.xml', '<testsuite><testcase name="a1 @spec:rate-limit" classname="a"/></testsuite>')
    repo.write('packages/b/reports/junit.xml', '<testsuite><testcase name="b1 @spec:quota" classname="b"/></testsuite>')
    const res = mergeReports(repo.root, '**/reports/junit.xml')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.map((t) => t.name).sort()).toEqual(['a1 @spec:rate-limit', 'b1 @spec:quota'])
  })

  it('refuses when the glob matches nothing — fail-closed, never green', () => {
    const repo = tmpRepo()
    const res = mergeReports(repo.root, '**/reports/junit.xml')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.violations[0]?.rule).toBe('no-reports')
  })
})
