import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

// The repo's own test files, run with every test filtered out (tests/scratch.test.ts). A file whose
// every test is skipped runs none of its hooks, the setup file's afterAll included, so whatever its
// collection made would never be removed: nothing may be made at collection.
export default defineConfig({
  root: resolve(import.meta.dirname, '..', '..'),
  cacheDir: process.env.SCRATCH_LIFE_CACHE,
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/fixtures/**', '**/.claude/**'],
    setupFiles: ['tests/scratch-setup.ts'],
    pool: 'forks',
    passWithNoTests: true,
  },
})
