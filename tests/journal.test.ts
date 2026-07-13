import { describe, expect, it } from 'vitest'
import {
  appendEntry, effortStreams, latestRecap, readStream, streamExists,
} from '../src/journal.js'
import { tmpRepo } from './helpers.js'

describe('journal', () => {
  it('appends NDJSON with v:1 and reads it back in order', () => {
    const repo = tmpRepo()
    const line = appendEntry(repo.root, 'auth-hardening', { t: 'recap', effort: 'auth-hardening', class: 'feature', goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [] })
    expect(line).toBe(JSON.stringify({ v: 1, t: 'recap', effort: 'auth-hardening', class: 'feature', goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [] }))
    appendEntry(repo.root, 'auth-hardening', { t: 'write', effort: 'auth-hardening', artifact: 'auth-refresh', sha: 'a'.repeat(64), covers: ['g1'] })
    const entries = readStream(repo.root, 'auth-hardening')
    expect(entries.map((e) => e.t)).toEqual(['recap', 'write'])
    expect(entries.every((e) => e.v === 1)).toBe(true)
    expect(streamExists(repo.root, 'auth-hardening')).toBe(true)
    expect(streamExists(repo.root, 'nope')).toBe(false)
  })

  it('entries carry no timestamps', () => {
    const repo = tmpRepo()
    appendEntry(repo.root, 'e', { t: 'recap', effort: 'e', class: 'fix', goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [] })
    const entry = readStream(repo.root, 'e')[0] as Record<string, unknown>
    expect(entry.at).toBeUndefined()
    expect(entry.ts).toBeUndefined()
  })

  it('latestRecap returns the last recap entry (amendments supersede)', () => {
    const repo = tmpRepo()
    appendEntry(repo.root, 'e', { t: 'recap', effort: 'e', class: 'feature', goals: [{ id: 'g1', text: 'old' }], non_goals: [], constraints: [], slices: [] })
    appendEntry(repo.root, 'e', { t: 'recap', effort: 'e', class: 'feature', goals: [{ id: 'g1', text: 'new' }], non_goals: [], constraints: [], slices: [] })
    expect(latestRecap(repo.root, 'e')?.goals[0]?.text).toBe('new')
  })

  it('effortStreams lists only streams born by a recap', () => {
    const repo = tmpRepo()
    appendEntry(repo.root, 'effort-a', { t: 'recap', effort: 'effort-a', class: 'chore', goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [] })
    appendEntry(repo.root, 'some-artifact', { t: 'write', effort: 'effort-a', artifact: 'some-artifact', sha: 'a'.repeat(64), covers: [] })
    expect(effortStreams(repo.root)).toEqual(['effort-a'])
  })
})
