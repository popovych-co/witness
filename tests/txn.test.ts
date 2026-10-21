import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock } from '../src/lock.js'
import { completeTxn, guardTxn, pendingTxn, rollbackTxn, withTxn } from '../src/txn.js'
import { recoverChoice } from '../src/verbs/recover.js'
import { stateCommit } from '../src/gitio.js'
import { ok } from '../src/refusal.js'
import { fakeCtx, tmpRepo, type TestRepo } from './helpers.js'

function seeded(): TestRepo {
  const repo = tmpRepo()
  repo.write('.gitignore', '.witness/lock\n.witness/txn.json\n.witness/allow.json\n')
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
    const foreign = acquireLock(repo.root, process.pid + 1, 0)
    expect(!foreign.ok && foreign.violations[0]?.rule).toBe('locked')
    if (first.ok) first.value()
    repo.write('.witness/lock', JSON.stringify({ pid: 999999999 }))
    const stolen = acquireLock(repo.root)
    expect(stolen.ok).toBe(true)
    if (stolen.ok) stolen.value()
  })
})

// A second process holds the lock: a same-process holder cannot let go while
// acquireLock's synchronous wait blocks the thread.
async function holdLock(root: string, ms: number): Promise<ChildProcess> {
  mkdirSync(join(root, '.witness'), { recursive: true })
  const child = spawn(process.execPath, ['-e', `
    const fs = require('fs'); const p = process.argv[1]
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
    process.stdout.write('held\\n')
    setTimeout(() => { fs.rmSync(p, { force: true }); process.exit(0) }, ${ms})
  `, join(root, '.witness', 'lock')], { stdio: ['ignore', 'pipe', 'inherit'] })
  await once(child.stdout!, 'data')
  return child
}

describe('acquireLock waits (B3)', () => {
  it('waits for a live holder to let go, then takes the lock', async () => {
    const repo = seeded()
    await holdLock(repo.root, 400)
    const t0 = Date.now()
    const r = acquireLock(repo.root, process.pid, 5_000)
    expect(r.ok).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    if (r.ok) r.value()
  }, 15_000)

  it('refuses once the wait is spent and names the holder', async () => {
    const repo = seeded()
    const holder = await holdLock(repo.root, 5_000)
    const r = acquireLock(repo.root, process.pid, 300)
    expect(!r.ok && r.violations[0]!.rule).toBe('locked')
    expect(!r.ok && r.violations[0]!.got).toBe(`held by pid ${holder.pid} · waited 300ms`)
    holder.kill()
  }, 15_000)

  it('a lock it cannot write refuses at once instead of spinning', () => {
    const repo = seeded()
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    chmodSync(join(repo.root, '.witness'), 0o555)
    try {
      const t0 = Date.now()
      const r = acquireLock(repo.root, process.pid, 5_000)
      expect(!r.ok && r.violations[0]!.rule).toBe('lock-unwritable')
      expect(Date.now() - t0).toBeLessThan(1_000)
    } finally {
      chmodSync(join(repo.root, '.witness'), 0o755)
    }
  })

  it('a dangling symlink at the lock path is unreadable · taken after the grace and replaced by a file', () => {
    const repo = seeded()
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    symlinkSync(join(repo.root, 'nowhere'), join(repo.root, '.witness', 'lock'))
    const t0 = Date.now()
    const r = acquireLock(repo.root, process.pid, 5_000)
    expect(r.ok).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000)
    expect(Date.now() - t0).toBeLessThan(4_000)
    expect(lstatSync(join(repo.root, '.witness', 'lock')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(repo.root, 'nowhere'))).toBe(false)
    if (r.ok) r.value()
  })

  it('reads an unreadable lock as a write in progress and takes it after a grace', () => {
    const repo = seeded()
    repo.write('.witness/lock', '')
    const t0 = Date.now()
    const r = acquireLock(repo.root, process.pid, 5_000)
    expect(r.ok).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000)
    if (r.ok) r.value()
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
    repo.write('.witness/journal/e.jsonl', '{"v":1,"t":"write","artifact":"a"}\n')
    repo.write('.witness/txn.json', JSON.stringify({
      op: 'write(a)',
      files: ['specs/a.md', '.witness/journal/e.jsonl'],
      journal: { stream: 'e', line: '{"v":1,"t":"write","artifact":"a"}' },
    }))
  }

  it('rollback restores tracked files and removes untracked ones', () => {
    const repo = seeded()
    crashState(repo)
    rollbackTxn(repo.root, pendingTxn(repo.root)!)
    expect(repo.read('specs/a.md')).toBe('v1')
    expect(existsSync(join(repo.root, '.witness/journal/e.jsonl'))).toBe(false)
    expect(pendingTxn(repo.root)).toBeUndefined()
  })

  it('complete lands one trailer commit with the journal line intact', () => {
    const repo = seeded()
    crashState(repo)
    const res = completeTxn(repo.root, pendingTxn(repo.root)!)
    expect(res.ok).toBe(true)
    expect(repo.git('log', '-1', '--format=%(trailers:key=Witness-State,valueonly=true)')).toBe('1')
    expect(readFileSync(join(repo.root, '.witness/journal/e.jsonl'), 'utf8')).toBe('{"v":1,"t":"write","artifact":"a"}\n')
    expect(pendingTxn(repo.root)).toBeUndefined()
  })

  it('complete appends the pending journal line when the crash preceded the append', () => {
    const repo = seeded()
    crashState(repo)
    repo.write('.witness/journal/e.jsonl', '')
    const res = completeTxn(repo.root, pendingTxn(repo.root)!)
    expect(res.ok).toBe(true)
    expect(readFileSync(join(repo.root, '.witness/journal/e.jsonl'), 'utf8')).toBe('{"v":1,"t":"write","artifact":"a"}\n')
  })

  it('complete appends only the missing tail when one stream takes several lines (D166)', () => {
    const a = '{"v":1,"t":"status","artifact":"p","to":"done"}'
    const b = '{"v":1,"t":"deferral-moved","id":"d-1","to":"s"}'
    // the crash can land before either append, between them, or after both
    for (const landed of [[], [a], [a, b]]) {
      const repo = seeded()
      repo.write('.witness/journal/p.jsonl', ['{"seed":1}', ...landed].join('\n') + '\n')
      repo.write('.witness/txn.json', JSON.stringify({
        op: 'merge-stamp', files: ['.witness/journal/p.jsonl'],
        journalMulti: [{ stream: 'p', line: a }, { stream: 'p', line: b }],
      }))
      expect(completeTxn(repo.root, pendingTxn(repo.root)!).ok).toBe(true)
      expect(readFileSync(join(repo.root, '.witness/journal/p.jsonl'), 'utf8')).toBe(`{"seed":1}\n${a}\n${b}\n`)
    }
  })

  it('recover reads several lines on one stream the way complete does (D166)', () => {
    const a = '{"v":1,"t":"status","artifact":"p","to":"done"}'
    const b = '{"v":1,"t":"deferral-moved","id":"d-1","to":"s"}'
    const marker = {
      op: 'merge-stamp', files: ['.witness/journal/p.jsonl'],
      journalMulti: [{ stream: 'p', line: a }, { stream: 'p', line: b }],
    }
    const repo = seeded()
    repo.write('.witness/journal/p.jsonl', `{"seed":1}\n${a}\n${b}\n`)
    expect(recoverChoice(repo.root, marker).rule).toBe('txn-write-landed')   // finished: complete it
    repo.write('.witness/journal/p.jsonl', `{"seed":1}\n${a}\n`)
    expect(recoverChoice(repo.root, marker).rule).toBe('txn-write-partial')  // interrupted mid-write
  })

  it('complete resolves id streams into the journal dir, never the repo root', () => {
    // regression: gate/decide markers carry bare artifact ids; completeTxn used to
    // join them onto the root, leaving stray `<root>/<plan-id>` files
    const repo = seeded()
    repo.write('specs/a.md', 'v2-crashed')
    repo.write('.witness/txn.json', JSON.stringify({
      op: 'gate-plan',
      files: ['specs/a.md', '.witness/journal/a-plan-1.jsonl'],
      journalMulti: [{ stream: 'a-plan-1', line: '{"v":1,"t":"gate-run","artifact":"a-plan-1"}' }],
    }))
    const res = completeTxn(repo.root, pendingTxn(repo.root)!)
    expect(res.ok).toBe(true)
    expect(readFileSync(join(repo.root, '.witness/journal/a-plan-1.jsonl'), 'utf8'))
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
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    writeFileSync(join(repo.root, '.witness', 'txn.json'),
      JSON.stringify({ op: 'gate-ship', files: ['specs/a.md', '.witness/journal/a.jsonl'] }))

    const errs: string[] = []
    const code = guardTxn(fakeCtx(repo.root, { err: (l) => errs.push(l) }), repo.root)

    expect(code).toBe(3)
    expect(errs.join('\n')).toContain('specs/a.md')
  })
})
