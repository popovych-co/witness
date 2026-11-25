import { BASE_TESTS, baseTestsKey, baseTestsResult, parseBaseTestsKey, specCounts } from './base-tests.js'
import { readStream, streamIds } from './journal.js'
import type { JunitCounts } from './junit.js'
import { suiteKey, type RunnerConfig } from './runner.js'
import { codeTree } from './snapshot.js'
import { JOB_STREAM } from './streams.js'

// Row 275. The tests effect (§4 T3): passing tagged cases per spec never drop without a spec amendment.

export type FullSuite = Extract<RunnerConfig, { mode: 'full-suite' }>

export type BaseCounts =
  | { read: 'found'; from: 'ship' | 'job'; code: string; specs: Record<string, JunitCounts> }
  | { read: 'missing'; code: string; key: string }
  | { read: 'unreadable'; why: string }

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

// C29. The base's per-spec counts: any shipped summary whose code tree and suite match the base commit's
// — one code under one suite measures the same thing, so any match serves. Streams in `streamIds` order,
// each read newest first; a scan of every stream costs 31 ms on fewhats' 11 MB journal, so no index.
// Failing that, a done `base-tests` result under today's suite whose code is the base's, newest first:
// one result serves every base commit of its code. A ship line serves only on the stream it names, with
// well-formed counts (security review): the journal is witness's own state, read as the gates read it.
export function baseCounts(root: string, rc: FullSuite, base: string): BaseCounts {
  const code = codeTree(root, base)
  if (code === undefined) return { read: 'unreadable', why: "the base's code tree could not be read" }
  const suite = suiteKey(rc)
  for (const id of streamIds(root)) {
    if (id === JOB_STREAM) continue
    const entries = readStream(root, id)
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as Obj
      if (e.t !== 'gate-run' || e.gate !== 'ship' || e.artifact !== id || !isObj(e.junit)) continue
      if (e.junit.code !== code || e.junit.suite !== suite) continue
      const specs = specCounts(e.junit.specs, Number.MAX_SAFE_INTEGER)
      if (specs !== undefined) return { read: 'found', from: 'ship', code, specs }
    }
  }
  const shards = readStream(root, JOB_STREAM)
  for (let i = shards.length - 1; i >= 0; i--) {
    const e = shards[i] as Obj
    if (e.t !== 'job-shard' || e.kind !== BASE_TESTS || e.outcome !== 'done' || typeof e.key !== 'string') continue
    if (parseBaseTestsKey(e.key)?.suite !== suite) continue
    const result = baseTestsResult(e.result)
    if (result !== undefined && result.code === code) return { read: 'found', from: 'job', code, specs: result.specs }
  }
  return { read: 'missing', code, key: baseTestsKey(base, suite) }
}
