import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stateCommit } from '../src/gitio.js'
import { appendEntry, effortCause, journalRel, latestRecap, readStream } from '../src/journal.js'
import { effortReviewedSha } from '../src/reviewed.js'
import { loadCanon } from '../src/scan.js'
import { RECAP, draftSave, hermeticEnv, seededRepo, type TestRepo } from './helpers.js'

// Row 253. A fix says whether it escaped: its cause is its own journal entry beside the recap —
// never a recap field, so no gate, prompt or reviewed identity reads it (decision 8) — written
// at a fix's birth, by an amend that names another, or by the classify act for an old fix.

// An old fix, born before causes existed: a recap line and its state commit, as 0.30 wrote them.
function seedOldFix(repo: TestRepo, slug: string): void {
  appendEntry(repo.root, slug, { t: 'recap', effort: slug, class: 'fix', goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [] })
  const r = stateCommit(repo.root, [journalRel(slug)], `recap(${slug}): fix`)
  if (!r.ok) throw new Error('seed commit')
}
const kinds = (repo: TestRepo, slug: string) => readStream(repo.root, slug).map((e) => e.t)
const head = (repo: TestRepo) => repo.git('rev-parse', 'HEAD').trim()
const subject = (repo: TestRepo) => repo.git('log', '-1', '--format=%s').trim()
async function recapFile(repo: TestRepo, body: Record<string, unknown>, extra: string[] = []) {
  repo.write('r.json', JSON.stringify({ ...RECAP, ...body }))
  return repo.cli(['recap', '--file', 'r.json', ...extra])
}
const classify = (repo: TestRepo, slug: string, cause: string, env?: Record<string, string>) =>
  repo.cli(['recap', '--effort', slug, '--cause', cause], env ? { env } : {})

describe('a fix carries its cause (row 253)', () => {
  it('a fix recap without a cause is refused, naming both causes', async () => {
    const repo = await seededRepo({ noRecap: true })
    const r = await recapFile(repo, { effort: 'quick-fix', class: 'fix' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('cause,required')
    expect(r.stderr).toContain('escape')
    expect(r.stderr).toContain('decision')
    expect(kinds(repo, 'quick-fix')).toEqual([])
  })

  it('a feature or chore recap with a cause is refused', async () => {
    const repo = await seededRepo({ noRecap: true })
    for (const cls of ['feature', 'chore']) {
      const r = await recapFile(repo, { effort: `a-${cls}`, class: cls, cause: 'escape' })
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('fix-only')
      expect(kinds(repo, `a-${cls}`)).toEqual([])
    }
  })

  it('a cause that is neither escape nor decision is refused', async () => {
    const repo = await seededRepo({ noRecap: true })
    const r = await recapFile(repo, { effort: 'quick-fix', class: 'fix', cause: 'oops' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('enum')
  })

  it('a fix recap journals the recap, then its cause, in one state commit', async () => {
    const repo = await seededRepo({ class: 'fix', slug: 'quick-fix', cause: 'decision' })
    const entries = readStream(repo.root, 'quick-fix')
    expect(entries.map((e) => e.t)).toEqual(['recap', 'cause'])
    expect('cause' in entries[0]!).toBe(false)
    expect(entries[1]).toMatchObject({ effort: 'quick-fix', cause: 'decision' })
    expect(subject(repo)).toBe('recap(quick-fix): fix')
    expect(repo.git('show', '--format=', '--name-only', 'HEAD').trim()).toBe(journalRel('quick-fix'))
    expect(repo.git('status', '--porcelain', '--', '.witness').trim()).toBe('')
    expect(effortCause(entries)).toBe('decision')
  })

  it("the decompose identity and the arbiter's recap never see a cause", async () => {
    const repo = await seededRepo({ class: 'fix', slug: 'quick-fix', cause: 'decision' })
    const before = effortReviewedSha(repo.root, loadCanon(repo.root), 'quick-fix').sha
    expect((await classify(repo, 'quick-fix', 'escape')).code).toBe(0)
    expect(effortReviewedSha(repo.root, loadCanon(repo.root), 'quick-fix').sha).toBe(before)
    expect('cause' in latestRecap(repo.root, 'quick-fix')!).toBe(false)
  })

  it('an old fix is classified by --effort --cause; the latest wins; the same cause writes nothing', async () => {
    const repo = await seededRepo()
    seedOldFix(repo, 'old-fix')
    const first = await classify(repo, 'old-fix', 'decision')
    expect(first.code, first.stderr).toBe(0)
    expect(first.stdout).toContain('effort: old-fix')
    expect(first.stdout).toContain('cause: decision')
    expect(subject(repo)).toBe('cause(old-fix): decision')
    expect((await classify(repo, 'old-fix', 'escape')).code).toBe(0)
    expect(effortCause(readStream(repo.root, 'old-fix'))).toBe('escape')
    const at = head(repo)
    const again = await classify(repo, 'old-fix', 'escape')
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('cause: escape (unchanged)')
    expect(head(repo)).toBe(at)
    expect(kinds(repo, 'old-fix')).toEqual(['recap', 'cause', 'cause'])
  })

  type Case = { repo: TestRepo; argv: string[]; env?: Record<string, string> }
  const cases: Array<[string, string, () => Promise<Case>]> = [
    ['a feature effort', 'fix-only', async () => ({ repo: await seededRepo(), argv: ['--effort', 'auth-hardening', '--cause', 'escape'] })],
    ['an effort amended to a chore', 'fix-only', async () => {
      const repo = await seededRepo({ class: 'fix', slug: 'quick-fix', cause: 'escape' })
      const a = await recapFile(repo, { effort: 'quick-fix', class: 'chore' }, ['--amend'])
      if (a.code !== 0) throw new Error(a.stderr)
      return { repo, argv: ['--effort', 'quick-fix', '--cause', 'decision'] }
    }],
    ['an abandoned fix', 'terminal', async () => {
      const repo = await seededRepo({ class: 'fix', slug: 'quick-fix', cause: 'escape' })
      const a = await repo.cli(['abandon', 'quick-fix'])
      if (a.code !== 0) throw new Error(a.stderr)
      return { repo, argv: ['--effort', 'quick-fix', '--cause', 'decision'] }
    }],
    ['an unknown effort', 'unknown-effort', async () => ({ repo: await seededRepo(), argv: ['--effort', 'nope', '--cause', 'escape'] })],
    ['a reserved effort id', 'id-taken', async () => ({ repo: await seededRepo(), argv: ['--effort', 'asks', '--cause', 'escape'] })],
    ['a bad cause', 'enum', async () => {
      const repo = await seededRepo()
      seedOldFix(repo, 'old-fix')
      return { repo, argv: ['--effort', 'old-fix', '--cause', 'oops'] }
    }],
    ['--file beside --cause', 'cause-in-file', async () => {
      const repo = await seededRepo()
      seedOldFix(repo, 'old-fix')
      repo.write('r.json', JSON.stringify({ ...RECAP, effort: 'old-fix', class: 'fix', cause: 'escape' }))
      return { repo, argv: ['--file', 'r.json', '--amend', '--effort', 'old-fix', '--cause', 'escape'] }
    }],
    ['--cause without --effort', '--effort,required', async () => ({ repo: await seededRepo(), argv: ['--cause', 'escape'] })],
    ['a drive session (WITNESS_DRIVE set)', 'cause-in-session', async () => {
      const repo = await seededRepo()
      seedOldFix(repo, 'old-fix')
      return { repo, argv: ['--effort', 'old-fix', '--cause', 'escape'], env: { WITNESS_DRIVE: 'old-fix' } }
    }],
  ]
  it.each(cases)('classify refuses %s (%s)', async (_case, rule, setup) => {
    const { repo, argv, env } = await setup()
    const at = head(repo)
    const r = await repo.cli(['recap', ...argv], env ? { env } : {})
    expect(r.code, r.stdout).toBe(2)
    expect(r.stderr).toContain(rule)
    expect(head(repo)).toBe(at)
  })

  it('an amend keeps the recorded cause, needs one for a causeless fix, and journals a different one', async () => {
    const repo = await seededRepo({ class: 'fix', slug: 'quick-fix', cause: 'decision' })
    expect((await recapFile(repo, { effort: 'quick-fix', class: 'fix' }, ['--amend'])).code).toBe(0)
    expect(kinds(repo, 'quick-fix')).toEqual(['recap', 'cause', 'recap'])
    expect((await recapFile(repo, { effort: 'quick-fix', class: 'fix', cause: 'decision' }, ['--amend'])).code).toBe(0)
    expect(kinds(repo, 'quick-fix')).toEqual(['recap', 'cause', 'recap', 'recap'])
    expect((await recapFile(repo, { effort: 'quick-fix', class: 'fix', cause: 'escape' }, ['--amend'])).code).toBe(0)
    expect(kinds(repo, 'quick-fix')).toEqual(['recap', 'cause', 'recap', 'recap', 'recap', 'cause'])
    expect(subject(repo)).toBe('recap(quick-fix) --amend: fix')
    expect(effortCause(readStream(repo.root, 'quick-fix'))).toBe('escape')

    seedOldFix(repo, 'old-fix')
    const r = await recapFile(repo, { effort: 'old-fix', class: 'fix' }, ['--amend'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('cause,required')
    expect(kinds(repo, 'old-fix')).toEqual(['recap'])
  })

  it('a crash after the lines land completes to one recap and one cause', async () => {
    const repo = await seededRepo({ noRecap: true })
    repo.write('r.json', JSON.stringify({ ...RECAP, effort: 'quick-fix', class: 'fix', cause: 'escape' }))
    // crashPoint exits the process, so the crashed write runs in a child of its own
    const here = resolve(import.meta.dirname, '..')
    const crashed = spawnSync(join(here, 'node_modules', '.bin', 'tsx'), [join(here, 'src', 'bin.ts'), 'recap', '--file', 'r.json'],
      { cwd: repo.root, env: hermeticEnv({ WITNESS_CRASH_AFTER: 'journal-append' }), encoding: 'utf8' })
    expect(crashed.status).toBe(9)
    const rec = await repo.cli(['recover', '--complete'])
    expect(rec.code, rec.stderr).toBe(0)
    expect(kinds(repo, 'quick-fix')).toEqual(['recap', 'cause'])
    expect(effortCause(readStream(repo.root, 'quick-fix'))).toBe('escape')
  })

  it("the amend draft's seed carries the cause, and a draft's cause must be escape or decision", async () => {
    const repo = await seededRepo({ class: 'fix', slug: 'quick-fix', cause: 'decision' })
    const seed = await repo.cli(['draft', 'amend-quick-fix'])
    expect(seed.code, seed.stderr).toBe(0)
    expect(seed.stdout).toContain('"cause": "decision"')
    const bad = await draftSave(repo, 'amend-quick-fix', { effort: 'quick-fix', class: 'fix', cause: 'oops' })
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('enum')
    const good = await draftSave(repo, 'amend-quick-fix', { effort: 'quick-fix', class: 'fix', cause: 'escape' })
    expect(good.code, good.stderr).toBe(0)
  })

  it('witness log prints a cause line', async () => {
    const repo = await seededRepo({ class: 'fix', slug: 'quick-fix', cause: 'decision' })
    const r = await repo.cli(['log', 'quick-fix'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('cause=decision')
  })
})
