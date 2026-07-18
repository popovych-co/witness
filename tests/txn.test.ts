import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock } from '../src/lock.js'
import { completeTxn, guardTxn, pendingTxn, rollbackTxn, withTxn } from '../src/txn.js'
import { stateCommit } from '../src/gitio.js'
import { ok } from '../src/refusal.js'
import { fakeCtx, tmpRepo, type TestRepo } from './helpers.js'

function seeded(): TestRepo {
  const repo = tmpRepo()
  repo.write('.gitignore', '.specflow/lock\n.specflow/txn.json\n.specflow/allow.json\n')
  repo.write('specs/a.md', 'v1')
  repo.git('add', '.gitignore', 'specs/a.md')
  repo.git('commit', '-m', 'seed')
  return repo
}

describe('acquireLock', () => {
  it('refuses a live foreign holder, steals a stale lock, re-enters for itself', () => {
    const repo = seeded()
    const first = acquireLock(repo.root)
    expect(first.ok).toBe(true)
    const foreign = acquireLock(repo.root, process.pid + 1)
    expect(!foreign.ok && foreign.violations[0]?.rule).toBe('locked')
    if (first.ok) first.value()
    repo.write('.specflow/lock', JSON.stringify({ pid: 999999999 }))
    const stolen = acquireLock(repo.root)
    expect(stolen.ok).toBe(true)
    if (stolen.ok) stolen.value()
  })
})

describe('withTxn', () => {
  it('clears the marker on success', () => {
    const repo = seeded()
    const res = withTxn(repo.root, { op: 'write(a)', files: ['specs/a.md'] }, () => {
      repo.write('specs/a.md', 'v2')
      return stateCommit(repo.root, ['specs/a.md'], 'write(a): amend')
    })
    expect(res.ok).toBe(true)
    expect(pendingTxn(repo.root)).toBeUndefined()
  })

  it('rolls the files back on structured failure', () => {
    const repo = seeded()
    repo.write('specs/unrelated.md', 'dirt')
    const res = withTxn(repo.root, { op: 'write(a)', files: ['specs/a.md'] }, () => {
      repo.write('specs/a.md', 'v2')
      return stateCommit(repo.root, ['specs/a.md'], 'write(a): amend')
    })
    expect(res.ok).toBe(false)
    expect(repo.read('specs/a.md')).toBe('v1')
    expect(pendingTxn(repo.root)).toBeUndefined()
  })
})

describe('recovery', () => {
  function crashState(repo: TestRepo) {
    repo.write('specs/a.md', 'v2-crashed')
    repo.write('.specflow/journal/e.jsonl', '{"v":1,"t":"write","artifact":"a"}\n')
    repo.write('.specflow/txn.json', JSON.stringify({
      op: 'write(a)',
      files: ['specs/a.md', '.specflow/journal/e.jsonl'],
      journal: { stream: 'e', line: '{"v":1,"t":"write","artifact":"a"}' },
    }))
  }

  it('rollback restores tracked files and removes untracked ones', () => {
    const repo = seeded()
    crashState(repo)
    rollbackTxn(repo.root, pendingTxn(repo.root)!)
    expect(repo.read('specs/a.md')).toBe('v1')
    expect(existsSync(join(repo.root, '.specflow/journal/e.jsonl'))).toBe(false)
    expect(pendingTxn(repo.root)).toBeUndefined()
  })

  it('complete lands one trailer commit with the journal line intact', () => {
    const repo = seeded()
    crashState(repo)
    const res = completeTxn(repo.root, pendingTxn(repo.root)!)
    expect(res.ok).toBe(true)
    expect(repo.git('log', '-1', '--format=%(trailers:key=Specflow-State,valueonly=true)')).toBe('1')
    expect(readFileSync(join(repo.root, '.specflow/journal/e.jsonl'), 'utf8')).toBe('{"v":1,"t":"write","artifact":"a"}\n')
    expect(pendingTxn(repo.root)).toBeUndefined()
  })

  it('complete appends the pending journal line when the crash preceded the append', () => {
    const repo = seeded()
    crashState(repo)
    repo.write('.specflow/journal/e.jsonl', '')
    const res = completeTxn(repo.root, pendingTxn(repo.root)!)
    expect(res.ok).toBe(true)
    expect(readFileSync(join(repo.root, '.specflow/journal/e.jsonl'), 'utf8')).toBe('{"v":1,"t":"write","artifact":"a"}\n')
  })

  it('complete resolves id streams into the journal dir, never the repo root', () => {
    // regression: gate/decide markers carry bare artifact ids; completeTxn used to
    // join them onto the root, leaving stray `<root>/<plan-id>` files
    const repo = seeded()
    repo.write('specs/a.md', 'v2-crashed')
    repo.write('.specflow/txn.json', JSON.stringify({
      op: 'gate-plan',
      files: ['specs/a.md', '.specflow/journal/a-plan-1.jsonl'],
      journalMulti: [{ stream: 'a-plan-1', line: '{"v":1,"t":"gate-run","artifact":"a-plan-1"}' }],
    }))
    const res = completeTxn(repo.root, pendingTxn(repo.root)!)
    expect(res.ok).toBe(true)
    expect(readFileSync(join(repo.root, '.specflow/journal/a-plan-1.jsonl'), 'utf8'))
      .toBe('{"v":1,"t":"gate-run","artifact":"a-plan-1"}\n')
    expect(existsSync(join(repo.root, 'a-plan-1'))).toBe(false)
  })

  it('the recover verb blocks non-TTY without a flag and honors --rollback', async () => {
    const repo = seeded()
    crashState(repo)
    const blocked = await repo.cli(['recover'])
    expect(blocked.code).toBe(3)
    const rolled = await repo.cli(['recover', '--rollback'])
    expect(rolled.code).toBe(0)
    expect(repo.read('specs/a.md')).toBe('v1')
  })
})

describe('guardTxn message', () => {
  it('names the files a crashed transaction left at risk', () => {
    const repo = seeded()
    mkdirSync(join(repo.root, '.specflow'), { recursive: true })
    writeFileSync(join(repo.root, '.specflow', 'txn.json'),
      JSON.stringify({ op: 'gate-ship', files: ['specs/a.md', '.specflow/journal/a.jsonl'] }))

    const errs: string[] = []
    const code = guardTxn(fakeCtx(repo.root, { err: (l) => errs.push(l) }), repo.root)

    expect(code).toBe(3)
    expect(errs.join('\n')).toContain('specs/a.md')
  })
})
