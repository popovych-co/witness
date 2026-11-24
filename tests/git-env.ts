import { fileURLToPath } from 'node:url'

// Row 272 (issue #101). The env through which every git a test runs reads tests/gitconfig as its
// global config, in place of the config of whoever runs the suite: auto maintenance off, so no git
// a test runs starts a process that outlives it. vitest.config.ts puts it in every worker's env
// (test.env); helpers.ts spreads it into the env builders that start from nothing.
//
// The channel is GIT_CONFIG_GLOBAL, not GIT_CONFIG_COUNT/KEY/VALUE or `-c`: a push to a local origin
// starts receive-pack in that origin with env-level config cleared (git's local_repo_env), and
// receive-pack starts its own auto maintenance. GIT_CONFIG_GLOBAL is not cleared. git reads it from
// 2.32, so the suite needs git 2.32.
//
// Imports only node:*: vitest.config.ts loads this module, and so may a setup file
// (tests/setup-files.test.ts, row 213).
export const FIXTURE_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: fileURLToPath(new URL('gitconfig', import.meta.url)),
})
