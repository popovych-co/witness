import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The CLI's one owner of scratch directories (row 268, issue #99): made, handed to `use`, and
// removed when `use` returns or throws. Synchronous, as every caller is. A site that paired its
// own temp directory with its own removal could forget the removal, and `witness diff` did;
// tests/scratch-owner.test.ts keeps every site here.
export function withScratch<T>(prefix: string, use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    return use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
