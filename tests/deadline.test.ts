import { spawnSync } from 'node:child_process'
import { readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEADLINE_DIR, deadlineFile, driveDeadline, liveIo, sweepDeadlines, writeDeadline } from '../src/deadline.js'
import { tmpRepo } from './helpers.js'
import { scratchDir } from './scratch.js'

const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!

describe('the deadline file (row 256)', () => {
  it('driveDeadline is the later of the spawn deadline and the one drive moved', () => {
    const repo = tmpRepo()
    const file = deadlineFile(repo.root, '77-3')
    expect(driveDeadline({})).toBeUndefined()
    expect(driveDeadline({ WITNESS_DRIVE_DEADLINE: '1000' })).toBe(1000)
    writeDeadline(repo.root, '77-3', 5000)
    expect(driveDeadline({ WITNESS_DRIVE_DEADLINE: '1000', WITNESS_DRIVE_DEADLINE_FILE: file })).toBe(5000)
    writeDeadline(repo.root, '77-3', 500)
    expect(driveDeadline({ WITNESS_DRIVE_DEADLINE: '1000', WITNESS_DRIVE_DEADLINE_FILE: file })).toBe(1000)
    expect(driveDeadline({ WITNESS_DRIVE_DEADLINE_FILE: file })).toBe(500)
  })

  it('a missing, linked, oversized or garbled file leaves the spawn deadline', () => {
    const dir = scratchDir('witness-dl-')
    const real = join(dir, 'real.json'); writeFileSync(real, '{"deadline":9000000000000}')
    const link = join(dir, '1-1.json'); symlinkSync(real, link)
    const big = join(dir, '1-2.json'); writeFileSync(big, `{"deadline":9000000000000,"pad":"${'x'.repeat(2048)}"}`)
    const junk = join(dir, '1-3.json'); writeFileSync(junk, 'not json')
    const word = join(dir, '1-4.json'); writeFileSync(word, '{"deadline":"later"}')
    for (const f of [join(dir, 'gone.json'), link, big, junk, word]) {
      expect(driveDeadline({ WITNESS_DRIVE_DEADLINE: '1000', WITNESS_DRIVE_DEADLINE_FILE: f })).toBe(1000)
    }
  })

  it("sweepDeadlines drops a dead drive's files and its own leftovers, and keeps the lanes'", () => {
    const repo = tmpRepo()
    writeDeadline(repo.root, `${deadPid()}-1`, 1)
    writeDeadline(repo.root, `${process.pid}-2`, 1)
    writeDeadline(repo.root, `${process.pid}-3`, 1)
    expect(sweepDeadlines(repo.root, new Set([`${process.pid}-3`]))).toBe(2)
    expect(readdirSync(join(repo.root, DEADLINE_DIR)).filter((n) => n.endsWith('.json'))).toEqual([`${process.pid}-3.json`])
  })

  it('a write a Windows scanner blocks is best effort: it never throws (slice 2 review I1)', () => {
    const repo = tmpRepo()
    const io = { ...liveIo }
    const busy = () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }) }
    liveIo.rename = busy
    liveIo.rm = busy
    try {
      expect(() => writeDeadline(repo.root, '77-3', 5000)).not.toThrow()
    } finally {
      Object.assign(liveIo, io)
    }
    expect(driveDeadline({ WITNESS_DRIVE_DEADLINE_FILE: deadlineFile(repo.root, '77-3') })).toBeUndefined()
  })
})
