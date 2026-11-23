import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Row 259. The setup command a repo's root lockfile names: what `init` writes and `migrate` fills
// as `scratch.prepare`. First match wins; a root with no JavaScript lockfile prepares nothing
// (`none`) — a Cargo workspace builds on demand, and a human states anything else.
export function detectPrepare(root: string): string {
  const has = (f: string) => existsSync(join(root, f))
  if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile'
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm ci'
  if (has('yarn.lock')) return has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile'
  if (has('bun.lock') || has('bun.lockb')) return 'bun install --frozen-lockfile'
  return 'none'
}
