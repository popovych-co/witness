import { describe, expect, it } from 'vitest'
import { loadFailures, parseJUnit } from '../src/junit.js'

// vitest 4.1.10's own shapes (probe t2b-junit-vitest-4.1.10.xml beside the impl map), trimmed.
const VITEST = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="6" failures="4" errors="0">
  <testsuite name="a-assert.test.ts" tests="2" failures="1" errors="0" skipped="0">
    <testcase classname="a-assert.test.ts" name="assertion fails" time="0.003"><failure message="expected 1 to be 2" type="AssertionError">AssertionError</failure></testcase>
    <testcase classname="a-assert.test.ts" name="passes" time="0.001"></testcase>
  </testsuite>
  <testsuite name="b-throw.test.ts" tests="1" failures="1" errors="0" skipped="0">
    <testcase classname="b-throw.test.ts" name="throws a TypeError" time="0.002"><failure message="Cannot read properties of undefined" type="TypeError">TypeError</failure></testcase>
  </testsuite>
  <testsuite name="c-missing.test.ts" tests="1" failures="1" errors="0" skipped="0">
    <testcase classname="c-missing.test.ts" name="c-missing.test.ts" time="0"><failure message="Cannot find module" type="Error">Error</failure></testcase>
  </testsuite>
  <testsuite name="e-hook.test.ts" tests="2" failures="1" errors="0" skipped="1">
    <testcase classname="e-hook.test.ts" name="under a failed hook" time="0"><skipped/></testcase>
    <testcase classname="e-hook.test.ts" name="e-hook.test.ts" time="0.002"><failure message="hook blew up" type="Error">Error</failure></testcase>
  </testsuite>
</testsuites>`

describe('junit load failures (row 258)', () => {
  it('a vitest file that failed outside any test is a load failure; a failed test is a red', () => {
    expect(parseJUnit(VITEST)).toEqual([
      { name: 'assertion fails', classname: 'a-assert.test.ts', status: 'failed' },
      { name: 'passes', classname: 'a-assert.test.ts', status: 'passed' },
      { name: 'throws a TypeError', classname: 'b-throw.test.ts', status: 'failed' },
      { name: 'c-missing.test.ts', classname: 'c-missing.test.ts', status: 'failed', load: true },
      { name: 'under a failed hook', classname: 'e-hook.test.ts', status: 'skipped' },
      { name: 'e-hook.test.ts', classname: 'e-hook.test.ts', status: 'failed', load: true },
    ])
  })

  it('an <error> element is a load failure, whatever its case is named', () => {
    expect(parseJUnit('<testsuite><testcase classname="db" name="setup"><error message="db down"/></testcase></testsuite>'))
      .toEqual([{ name: 'setup', classname: 'db', status: 'failed', load: true }])
  })

  it('a case named after its file that passed or was skipped is no load failure', () => {
    const xml = '<testsuite><testcase classname="f.test.ts" name="f.test.ts"/><testcase classname="g.test.ts" name="g.test.ts"><skipped/></testcase></testsuite>'
    expect(parseJUnit(xml).filter((t) => t.load)).toEqual([])
  })

  it('loadFailures names each file once, sorted', () => {
    expect(loadFailures([...parseJUnit(VITEST), ...parseJUnit(VITEST)])).toEqual(['c-missing.test.ts', 'e-hook.test.ts'])
    expect(loadFailures(parseJUnit('<testsuite><testcase classname="a" name="ok"/></testsuite>'))).toEqual([])
  })
})

describe('junit load failures — other producers (row 258, slice 1 review)', () => {
  // jest-junit 16's defaults: classname and name are both '{classname} {title}', the suite is named
  // after the top describe (`{title}`) — every testcase's name equals its classname.
  it('a jest-junit red is a red, never a load failure', () => {
    const xml = `<testsuites name="jest tests"><testsuite name="math" tests="2" failures="1">
      <testcase classname="math adds" name="math adds" time="0.002"><failure>Error: expect(received).toBe(expected)</failure></testcase>
      <testcase classname="math subtracts" name="math subtracts" time="0.001"></testcase>
    </testsuite></testsuites>`
    expect(parseJUnit(xml)).toEqual([
      { name: 'math adds', classname: 'math adds', status: 'failed' },
      { name: 'math subtracts', classname: 'math subtracts', status: 'passed' },
    ])
    expect(loadFailures(parseJUnit(xml))).toEqual([])
  })

  it('vitest\'s file-level case is one named after its file inside the suite named after that file', () => {
    const xml = '<testsuites><testsuite name="other.test.ts"><testcase classname="x.test.ts" name="x.test.ts"><failure/></testcase></testsuite>'
      + '<testsuite name="y.test.ts"><testcase classname="y.test.ts" name="y.test.ts"><failure/></testcase></testsuite></testsuites>'
    expect(loadFailures(parseJUnit(xml))).toEqual(['y.test.ts'])
  })
})

describe('junit load failures — vitest projects (row 258, slice 2 review)', () => {
  // vitest 4.1.10 with test.projects whose projects have their own roots: the file-level case is
  // named relative to its project, its classname and its suite relative to the root config.
  it('a file-level case named for its project-relative path is a load failure; a red is not', () => {
    const xml = '<testsuites><testsuite name="packages/api/test/missing.test.mjs">'
      + '<testcase classname="packages/api/test/missing.test.mjs" name="test/missing.test.mjs"><failure message="Cannot find module"/></testcase></testsuite>'
      + '<testsuite name="packages/api/test/a.test.mjs"><testcase classname="packages/api/test/a.test.mjs" name="adds"><failure/></testcase></testsuite></testsuites>'
    expect(loadFailures(parseJUnit(xml))).toEqual(['packages/api/test/missing.test.mjs'])
  })
})
