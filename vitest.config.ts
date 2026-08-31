import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    // 20000 was a budget for unit tests, and 49 of the 125 files are not unit tests: they
    // drive the CLI against throwaway git repos and spawn a NESTED `vitest run` plus real
    // `git` (helpers.ts `vitestBin`/`fixtureEnv`). Measured 2026-08-30 on a 10-core box:
    // those files take 8–11s with the machine IDLE, so 20s was a 2× margin over the best
    // case — a race, not a timeout, and which tests lost it changed every run.
    //
    // Shrinking the pool is the wrong lever and was measured too: total test time is ~2900s
    // whatever the pool size (so per-test duration is not contention-dominated), and
    // maxForks=4 gave 2.4× the wall clock and 5× the failures. At 60000 the full suite is
    // 1055/1055 green in 357s versus 310s — the difference is the tests that used to die.
    testTimeout: 60000,
    // `.claude/**`: a git worktree checked out INSIDE the repo is a second full copy of
    // `tests/`, so vitest collected every file twice — 243 files and ~5000s of test time,
    // which starves the fork pool until the heaviest files trip the 20s timeout. The
    // failures read as flake because the losers change run to run. (`.witness/worktrees/**`
    // is the same shape during dogfooding and is NOT excluded here — see the note in the
    // commit; it needs its own decision.)
    exclude: [...configDefaults.exclude, '**/fixtures/**', '**/calibration/**', '**/plugin/**', '**/.claude/**'],
  },
})
