import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// `dist/` is built ONCE, before any test file runs. The protocol suites drive the built CLI,
// and each used to rebuild it in its own beforeAll — in parallel forks, so one file's CLI could
// load a dist another file's `tsc` was halfway through rewriting (CI 2026-10-21: "./version.js
// does not provide an export named 'version'"). ~2 s, once per vitest run.
// Row 218: the build runs the `tsc` that `npm run build` runs, through node itself — on Windows
// `npm` is `npm.cmd`, which `execFileSync` cannot start (ENOENT), so no test ran there at all.
export default function setup(): void {
  const root = resolve(import.meta.dirname, '..')
  execFileSync(process.execPath, [resolve(root, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: root, stdio: 'ignore' })
}
