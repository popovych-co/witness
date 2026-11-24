import { existsSync, mkdirSync } from 'node:fs'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { scratchDir } from '../../tests/scratch.js'

const FAIL = process.env.SCRATCH_LIFE === 'fail'
scratchDir('life-collect-')
beforeAll(() => { scratchDir('life-shared-') })
let cache: string | undefined
it('fills a cache', () => { cache = scratchDir('life-cache-', { shared: true }) })
it('reads the cache a passed test filled', () => { expect(existsSync(cache!)).toBe(true) })
it('passes, with a sibling beside its directory', () => { mkdirSync(`${scratchDir('life-pass-')}-beside`) })
it('skips itself', (ctx) => { scratchDir('life-skip-'); ctx.skip() })
describe('each', () => {
  beforeEach(() => { scratchDir('life-each-') })
  it('uses each', () => { if (FAIL) expect.fail('deliberate') })
})
it('owns and fails', () => {
  scratchDir('life-own-', { report: (d) => `report for ${d}` })
  if (FAIL) expect.fail('deliberate')
})
it.runIf(FAIL)('outlives its timeout', async () => {
  scratchDir('life-slow-')
  await new Promise((r) => setTimeout(r, 600))
}, 100)
