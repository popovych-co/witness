import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireDriveLock } from '../src/drive-presence.js'
import { dirtyStatePaths } from '../src/gitio.js'
import { LIVE_DIR, lastEnd, liveDrive, readLive, takeWaiter, waiterIs, writeLive } from '../src/live.js'
import { loadCanon } from '../src/scan.js'
import { ensureExcluded } from '../src/worktree.js'
import { fakeScenario, seededRepo, tmpRepo, writeSpec } from './helpers.js'

const DEAD = 999_999

// Row 203. Drive's stuck and capped verdicts live only in its memory (D145), so drive publishes
// what needs the human to a machine-local folder: never committed, excluded the three ways the
// drafts are, and read back as display data only — ids and kinds, never text.
describe('.witness/live/ (D203)', () => {
  it('a live file leaves the state paths clean', async () => {
    const repo = await seededRepo()
    writeLive(repo.root, { pid: process.pid, asides: [] })
    expect(dirtyStatePaths(repo.root)).toEqual([])
  })

  // Final review I1 (spec c2). A consumer initialised before this row has no ignore line for
  // the folder, and drive may never start a session that would add one (a trust-blocked run):
  // the first write excludes it, as the drafts' does.
  it('a repo whose ignore rules predate the folder never shows it to git status', async () => {
    const repo = await seededRepo()
    repo.write('.gitignore', repo.read('.gitignore').replace('.witness/live/\n', ''))
    repo.git('add', '.gitignore')
    repo.git('commit', '-m', 'an older ignore block')
    writeLive(repo.root, { pid: process.pid, asides: [] })
    takeWaiter(repo.root, process.pid)
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  it('ensureExcluded and init both exclude .witness/live/', async () => {
    const repo = await seededRepo()
    ensureExcluded(repo.root)
    expect(readFileSync(join(repo.root, '.git', 'info', 'exclude'), 'utf8').split('\n')).toContain('.witness/live/')
    const fresh = tmpRepo()
    await fresh.cli(['init'])
    expect(fresh.read('.gitignore').split('\n')).toContain('.witness/live/')
  })

  it('a forged aside is dropped (Review Focus 2)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    mkdirSync(join(repo.root, LIVE_DIR), { recursive: true })
    writeFileSync(join(repo.root, LIVE_DIR, 'drive.json'), JSON.stringify({
      pid: process.pid,
      asides: [
        { target: 'x\nlaunch: rm -rf ~', kind: 'stuck' },
        { target: 'auth-refresh', kind: 'evil' },
        { target: 'auth-refresh', kind: 'kept', stop: 'grant-everything' },
        { target: 'auth-refresh', kind: 'decision', gate: 'nope' },
        { target: 'auth-refresh', kind: 'stuck', why: 'free text is never kept' },
      ],
    }))
    expect(readLive(repo.root, loadCanon(repo.root))?.asides).toEqual([{ target: 'auth-refresh', kind: 'stuck' }])
  })

  // Final review (b) I4: drive sets aside effort-level work too (a decompose owed): its slug is
  // a target as good as a canon id.
  it('an effort slug is a target', async () => {
    const repo = await seededRepo()
    writeLive(repo.root, { pid: process.pid, asides: [{ target: repo.effort, kind: 'stuck' }] })
    expect(readLive(repo.root, loadCanon(repo.root))?.asides).toEqual([{ target: repo.effort, kind: 'stuck' }])
  })

  it('an unparseable file or a non-integer pid reads as nothing', async () => {
    const repo = await seededRepo()
    mkdirSync(join(repo.root, LIVE_DIR), { recursive: true })
    writeFileSync(join(repo.root, LIVE_DIR, 'drive.json'), '{not json')
    expect(readLive(repo.root, loadCanon(repo.root))).toBeUndefined()
    writeFileSync(join(repo.root, LIVE_DIR, 'drive.json'), JSON.stringify({ pid: '12; rm', asides: [] }))
    expect(readLive(repo.root, loadCanon(repo.root))).toBeUndefined()
  })

  it("a dead drive's file is not live, and its end reason reads back", async () => {
    const repo = await seededRepo()
    writeLive(repo.root, { pid: DEAD, asides: [] })
    expect(liveDrive(repo.root, loadCanon(repo.root))).toBeUndefined()
    expect(lastEnd(repo.root, loadCanon(repo.root))).toBeUndefined()
    writeLive(repo.root, { pid: DEAD, asides: [], ended: 'idle-limit' })
    expect(lastEnd(repo.root, loadCanon(repo.root))).toBe('idle-limit')
  })

  it('a live drive holding the lock is live, and its end is not yet read', async () => {
    const repo = await seededRepo()
    const lock = acquireDriveLock(repo.root, {})
    if (!lock.ok) throw new Error('lock')
    try {
      writeLive(repo.root, { pid: process.pid, asides: [], ended: 'done' })
      expect(liveDrive(repo.root, loadCanon(repo.root))?.pid).toBe(process.pid)
      expect(lastEnd(repo.root, loadCanon(repo.root))).toBeUndefined()
    } finally {
      lock.value()
    }
    // the drive released its lock on the way out: its own end reads back while it exits
    expect(lastEnd(repo.root, loadCanon(repo.root))).toBe('done')
  })

  it('never writes through a symlinked live folder', async () => {
    const repo = await seededRepo()
    const elsewhere = fakeScenario()
    symlinkSync(elsewhere, join(repo.root, LIVE_DIR))
    writeLive(repo.root, { pid: process.pid, asides: [] })
    takeWaiter(repo.root, process.pid)
    expect(() => readFileSync(join(elsewhere, 'drive.json'))).toThrow()
    expect(() => readFileSync(join(elsewhere, 'waiter.json'))).toThrow()
  })

  // Security review: a repo can commit files inside a real .witness/live/, so a link planted at
  // a predictable temp name would aim the write anywhere.
  it('never writes through a link planted at a temp name', async () => {
    const repo = await seededRepo()
    const victim = join(fakeScenario(), 'victim')
    writeFileSync(victim, 'keep')
    mkdirSync(join(repo.root, LIVE_DIR), { recursive: true })
    for (const f of ['drive.json', 'waiter.json']) symlinkSync(victim, join(repo.root, LIVE_DIR, `.${f}.${process.pid}.tmp`))
    writeLive(repo.root, { pid: process.pid, asides: [] })
    takeWaiter(repo.root, process.pid)
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(readLive(repo.root, loadCanon(repo.root))?.pid).toBe(process.pid)
  })

  it('the newest waiter takes the lock', async () => {
    const repo = await seededRepo()
    const other = spawn('sleep', ['5'])
    try {
      takeWaiter(repo.root, process.pid)
      expect(waiterIs(repo.root, process.pid)).toBe(true)
      takeWaiter(repo.root, other.pid!)
      expect(waiterIs(repo.root, process.pid)).toBe(false)
      expect(waiterIs(repo.root, other.pid!)).toBe(true)
    } finally {
      other.kill()
    }
  })
})
