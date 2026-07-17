import { describe, expect, it } from 'vitest'
import { appendEntry } from '../src/journal.js'
import { SPEC_META, seededRepo, writeSpec } from './helpers.js'

describe('specflow check', () => {
  it('passes a clean freshly-written canon', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('checks:')
  })

  it('flags hand-edited commits missing the trailer', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('specs/auth-refresh.md', repo.read('specs/auth-refresh.md') + '\nsneaky edit\n')
    repo.git('add', 'specs/auth-refresh.md')
    repo.git('commit', '-m', 'hand edit')
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('untrailered-commit')
  })

  it('flags uncommitted hand edits on state paths', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('specs/auth-refresh.md', repo.read('specs/auth-refresh.md') + 'dirt')
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('hand-edit-in-progress')
  })

  it('flags duplicate ids, unknown deps, and unresolvable pins', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('specs/dupe.md', repo.read('specs/auth-refresh.md'))
    repo.git('add', 'specs/dupe.md')
    repo.git('commit', '-m', 'dupe', '-m', 'Specflow-State: 1')
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('duplicate-id')
  })

  it('reports unmet needs as warnings, not errors', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, needs: [{ env: 'NOT_SET_ANYWHERE' }] })
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('need-unmet')
  })

  it('warns on orphan artifact journals', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    appendEntry(repo.root, 'ghost-artifact', { t: 'drift-check', artifact: 'ghost-artifact', criteria: [] })
    repo.git('add', '.specflow/journal/ghost-artifact.jsonl')
    repo.git('commit', '-m', 'orphan', '-m', 'Specflow-State: 1')
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('orphan-journal')
  })

  it('flags a configured docs path that does not exist', async () => {
    const repo = await seededRepo()
    repo.write('specflow.config.yaml',
      repo.read('specflow.config.yaml') + 'docs:\n  conventions: [docs/conventions.md]\n')
    repo.git('add', 'specflow.config.yaml')
    repo.git('commit', '-m', 'register a doc that does not exist')
    const res = await repo.cli(['check'])
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('doc-missing')
    expect(res.stdout).toContain('docs/conventions.md')
    // restore the file → the finding clears
    repo.write('docs/conventions.md', 'rules')
    repo.git('add', 'docs/conventions.md')
    repo.git('commit', '-m', 'add the doc')
    const ok = await repo.cli(['check'])
    expect(ok.stdout).not.toContain('doc-missing')
  })
})
