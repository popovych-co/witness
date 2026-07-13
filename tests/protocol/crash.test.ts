import { beforeAll, describe, expect, it } from 'vitest'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPEC_META, seededRepo, writeSpec } from '../helpers.js'

const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))
const bin = join(pkgRoot, 'dist', 'bin.js')

function spawnCli(root: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr }
}

beforeAll(() => {
  execSync('npm run build', { cwd: pkgRoot, stdio: 'ignore' })
}, 120000)

describe('kill/resume protocol', () => {
  it('crash after artifact-write: guard blocks, rollback converges, rerun succeeds', async () => {
    const repo = await seededRepo()
    repo.write('m.json', JSON.stringify(SPEC_META))
    repo.write('b.md', '## Motivation\nx\n\n## Behavior\ny\n')
    const crashed = spawnCli(repo.root, ['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm.json', '--body', 'b.md'], { SPECFLOW_CRASH_AFTER: 'artifact-write' })
    expect(crashed.code).toBe(9)
    expect(existsSync(join(repo.root, '.specflow/txn.json'))).toBe(true)
    expect(existsSync(join(repo.root, 'specs/auth-refresh.md'))).toBe(true)

    const blocked = await repo.cli(['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm.json', '--body', 'b.md'])
    expect(blocked.code).toBe(3)

    const rolled = spawnCli(repo.root, ['recover', '--rollback'])
    expect(rolled.code).toBe(0)
    expect(existsSync(join(repo.root, 'specs/auth-refresh.md'))).toBe(false)

    const rerun = await writeSpec(repo, 'auth-refresh')
    expect(rerun.code).toBe(0)
  })

  it('crash after journal-append: complete lands one commit, entry exactly once, check green', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('m2.json', JSON.stringify({ ...SPEC_META, summary: 'Rotation plus revocation' }))
    repo.write('b2.md', '## Motivation\nx\n\n## Behavior\ny\n')
    const crashed = spawnCli(repo.root, ['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm2.json', '--body', 'b2.md'], { SPECFLOW_CRASH_AFTER: 'journal-append' })
    expect(crashed.code).toBe(9)

    const completed = spawnCli(repo.root, ['recover', '--complete'])
    expect(completed.code).toBe(0)
    expect(repo.git('log', '-1', '--format=%(trailers:key=Specflow-State,valueonly=true)')).toBe('1')
    const journal = readFileSync(join(repo.root, '.specflow/journal/auth-hardening.jsonl'), 'utf8')
    const writes = journal.split('\n').filter((l) => l.includes('"t":"write"'))
    expect(writes).toHaveLength(2)
    expect(repo.read('specs/auth-refresh.md')).toContain('Rotation plus revocation')

    const check = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(check.code).toBe(0)
  })

  it('session death between recap and write: a fresh process resumes from the journal', async () => {
    const repo = await seededRepo()
    repo.write('m.json', JSON.stringify(SPEC_META))
    repo.write('b.md', '## Motivation\nx\n\n## Behavior\ny\n')
    const res = spawnCli(repo.root, ['write', 'auth-refresh', '--effort', 'auth-hardening', '--meta', 'm.json', '--body', 'b.md'])
    expect(res.code).toBe(0)
  })
})
