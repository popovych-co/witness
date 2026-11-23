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
