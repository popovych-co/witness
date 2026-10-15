import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Row 163. version() found its package.json through `URL.pathname`, and a pathname is
// URL syntax, not a filesystem path: on Windows it is `/C:/…`, which readFileSync resolves
// to `C:\C:\…`, and on every platform a space stays `%20`. Either way the read threw ENOENT
// and took down every verb that stamps a journal entry. The module is copied under a
// directory name a URL must escape, so the Linux CI runner catches the regression too —
// a test that only failed on a Windows box would guard nothing in CI.
describe('version', () => {
  it('reads the package.json beside its own install, even when the install path needs URL escaping', async () => {
    const pkg = join(realpathSync(mkdtempSync(join(tmpdir(), 'witness-'))), 'Jane Doe', 'witness')
    mkdirSync(join(pkg, 'src'), { recursive: true })
    copyFileSync(fileURLToPath(new URL('../src/version.ts', import.meta.url)), join(pkg, 'src', 'version.ts'))
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '7.8.9' }))
    const { version } = await import(pathToFileURL(join(pkg, 'src', 'version.ts')).href)
    expect(version()).toBe('7.8.9')
  })
})
