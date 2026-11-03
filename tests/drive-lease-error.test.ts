import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renewDriveLock } from '../src/drive-presence.js'
import { seededRepo } from './helpers.js'

// What a virus scanner holding the file looks like to utimes on Windows. Shared by every
// renewal in this file, so a test opts in by setting it.
const fail = vi.hoisted(() => ({ code: undefined as string | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    utimesSync: (...a: Parameters<typeof real.utimesSync>) => {
      if (fail.code !== undefined) throw Object.assign(new Error(fail.code), { code: fail.code })
      return real.utimesSync(...a)
    },
  }
})

// Final review M3. A renewal that fails while the lock is still this drive's is retried on the
// next tick, never read as a lost lease: a lost lease stops the drive and every session.
describe('a renewal error is not a lost lease (row 222)', () => {
  it('keeps the lease when utimes fails on the drive\'s own lock', async () => {
    const repo = await seededRepo()
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    writeFileSync(join(repo.root, '.witness', 'drive.lock'), JSON.stringify({ pid: process.pid, lease: 1 }))
    fail.code = 'EBUSY'
    try {
      expect(renewDriveLock(repo.root)).toBe(true)
    } finally {
      fail.code = undefined
    }
  })
})
