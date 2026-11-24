import { defineConfig } from 'vitest/config'

// The suite tests/scratch.test.ts runs to read what scratchDir leaves behind: SCRATCH_LIFE picks a
// passing or a failing run (never MODE, which vite overwrites with 'test'), and the cache lives
// where the caller says so no node_modules/.vite lands in this fixture.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: process.env.SCRATCH_LIFE_CACHE,
  test: { include: ['*.test.ts'], setupFiles: ['../../tests/scratch-setup.ts'], pool: 'forks' },
})
