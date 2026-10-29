import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Row 165. Both release scripts decided they were the CLI with
// `import.meta.url === \`file://${process.argv[1]}\``, and a template is not a URL: on
// Windows it compares `file://C:\…` with `file:///C:/…`, on every platform a path a URL
// must escape never equals the escaped import.meta.url, and a symlinked path never equals
// the realpath the loader resolved. The miss is silent — the module loads, the guard is
// false, the process exits 0 — so `release.mjs patch` cut nothing and `release-gate.mjs`
// passed any tag. Each case runs the real scripts under a path the template gets wrong,
// so the Linux CI runner catches the regression too.

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url))

// A throwaway package root holding a copy of scripts/ and the inputs the gate reads.
function packageRoot(dir: string): string {
  mkdirSync(dir, { recursive: true })
  cpSync(SCRIPTS, join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ version: '1.2.3' })}\n`)
  return dir
}

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'witness-')))
}

function gate(script: string, cwd: string) {
  return spawnSync(process.execPath, [script], {
    cwd, encoding: 'utf8', env: { ...process.env, GITHUB_REF_NAME: 'v9.9.9' },
  })
}

describe('the release scripts know when they are the CLI', () => {
  it('release-gate.mjs refuses a mismatched tag when run from a path a URL must escape', () => {
    const root = packageRoot(join(tmp(), 'Jane Doe'))
    const r = gate(join(root, 'scripts', 'release-gate.mjs'), root)
    expect(r.stderr).toContain('tag-version-mismatch')
    expect(r.status).toBe(2)
  })

  it('release-gate.mjs refuses a mismatched tag when run through a symlinked directory', () => {
    const base = tmp()
    const real = packageRoot(join(base, 'real'))
    symlinkSync(real, join(base, 'link'), 'junction')
    const r = gate(join(base, 'link', 'scripts', 'release-gate.mjs'), real)
    expect(r.stderr).toContain('tag-version-mismatch')
    expect(r.status).toBe(2)
  })

  it('release.mjs refuses an unparsable bump when run from a path a URL must escape', () => {
    const root = packageRoot(join(tmp(), 'Jane Doe'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('init', '-b', 'main')
    git('config', 'user.name', 'test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
    git('add', 'scripts', 'package.json')
    git('commit', '-m', 'fixture')
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'release.mjs'), 'nope'], { cwd: root, encoding: 'utf8' })
    expect(r.stderr).toContain('unparsable')
    expect(r.status).toBe(2)
  })
})
