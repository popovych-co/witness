import { afterAll } from 'vitest'
import { settleFile } from './scratch.js'   // never helpers.ts: it loads src

// The file lifetime of scratchDir: what a test file made outside any test, or shared, settles
// once the whole file has run (tests/scratch.ts).
afterAll((file) => settleFile(file))
