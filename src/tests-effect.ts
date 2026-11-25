import { baseTestsKey } from './base-tests.js'
import { readStream, streamIds } from './journal.js'
import type { JunitCounts, JunitSummary } from './junit.js'
import { suiteKey, type RunnerConfig } from './runner.js'
import { codeTree } from './snapshot.js'

// Row 275. The tests effect (§4 T3): passing tagged cases per spec never drop without a spec amendment.

export type FullSuite = Extract<RunnerConfig, { mode: 'full-suite' }>

export type BaseCounts =
  | { read: 'found'; from: 'ship' | 'job'; code: string; specs: Record<string, JunitCounts> }
  | { read: 'missing'; code: string; key: string }
  | { read: 'unreadable'; why: string }

// C29. The base's per-spec counts: any shipped summary whose code tree and suite match the base commit's
// — one code under one suite measures the same thing, so any match serves. Streams in `streamIds` order,
// each read newest first; a scan of every stream costs 31 ms on fewhats' 11 MB journal, so no index.
export function baseCounts(root: string, rc: FullSuite, base: string): BaseCounts {
  const code = codeTree(root, base)
  if (code === undefined) return { read: 'unreadable', why: "the base's code tree could not be read" }
  const suite = suiteKey(rc)
  for (const id of streamIds(root)) {
    const entries = readStream(root, id)
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { t?: unknown; gate?: unknown; junit?: JunitSummary }
      if (e.t !== 'gate-run' || e.gate !== 'ship' || e.junit === undefined) continue
      if (e.junit.code === code && e.junit.suite === suite) return { read: 'found', from: 'ship', code, specs: e.junit.specs }
    }
  }
  return { read: 'missing', code, key: baseTestsKey(base, suite) }
}
