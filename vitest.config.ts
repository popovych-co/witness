import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 20000,
    // `.claude/**`: a git worktree checked out INSIDE the repo is a second full copy of
    // `tests/`, so vitest collected every file twice — 243 files and ~5000s of test time,
    // which starves the fork pool until the heaviest files trip the 20s timeout. The
    // failures read as flake because the losers change run to run. (`.witness/worktrees/**`
    // is the same shape during dogfooding and is NOT excluded here — see the note in the
    // commit; it needs its own decision.)
    exclude: [...configDefaults.exclude, '**/fixtures/**', '**/calibration/**', '**/plugin/**', '**/.claude/**'],
  },
})
