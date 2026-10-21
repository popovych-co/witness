import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// `dist/` is built ONCE, before any test file runs. The protocol suites drive the built CLI,
// and each used to rebuild it in its own beforeAll — in parallel forks, so one file's CLI could
// load a dist another file's `tsc` was halfway through rewriting (CI 2026-10-21: "./version.js
// does not provide an export named 'version'"). ~2 s, once per vitest run.
export default function setup(): void {
  execFileSync('npm', ['run', 'build'], { cwd: resolve(import.meta.dirname, '..'), stdio: 'ignore' })
}
