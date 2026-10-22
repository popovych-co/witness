import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ASK_STREAM } from '../src/ask.js'
import { sessionHash } from '../src/context.js'
import {
  appendEntry, effortStreams, entryLine, journalRel, latestRecap, readStream, streamExists, withJournalCtx,
} from '../src/journal.js'
import { version } from '../src/version.js'
import { hermeticEnv, measuredEnv, seededRepo, tmpRepo, type TestRepo } from './helpers.js'

describe('journal', () => {
  it('appends NDJSON with v:1, the writer stamp, and reads it back in order', () => {
    const repo = tmpRepo()
    const line = appendEntry(repo.root, 'auth-hardening', { t: 'recap', effort: 'auth-hardening', class: 'feature', goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [] })
    // Row 116: schema, then author, then content — a human reading raw jsonl learns which
    // CLI wrote a line before they read what it says.
    expect(line).toBe(JSON.stringify({ v: 1, w: version(), t: 'recap', effort: 'auth-hardening', class: 'feature', goals: [{ id: 'g1', text: 'x' }], non_goals: [], constraints: [], slices: [] }))
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

describe('ctx stamp (row 191 §4.8, extends 116)', () => {
  const lastAsk = (repo: TestRepo): Record<string, unknown> =>
    JSON.parse(repo.read(journalRel(ASK_STREAM)).trim().split('\n').at(-1)!) as Record<string, unknown>

  it('stamps ctx last inside a scope', () => {
    const line = withJournalCtx({ session: 'abc123abc123', tokens: 5, window: 100 },
      () => entryLine({ t: 'sync', trigger: 'start', result: 'ok' }))
    expect(line).toBe(JSON.stringify({ v: 1, w: version(), t: 'sync', trigger: 'start', result: 'ok',
      ctx: { session: 'abc123abc123', tokens: 5, window: 100 } }))
  })

  it('writes no ctx outside a scope', () => {
    expect(entryLine({ t: 'sync' })).not.toContain('"ctx"')
  })

  it('a verb run in a measured session stamps the hash, never the raw id', async () => {
    const repo = await seededRepo()
    expect((await repo.cli(['ask', 'do a thing'], { env: measuredEnv('raw-session-1', 170000, 1000000) })).code).toBe(0)
    expect(lastAsk(repo).ctx).toEqual({ session: sessionHash('raw-session-1'), tokens: 170000, window: 1000000 })
    expect(repo.read(journalRel(ASK_STREAM))).not.toContain('raw-session-1')
  })

  it('stamps the session alone when the reading is untrusted', async () => {
    const repo = await seededRepo()
    expect((await repo.cli(['ask', 'do a thing'], { env: { CLAUDE_CODE_SESSION_ID: 'raw-2', WITNESS_CONTEXT: '{bad' } })).code).toBe(0)
    expect(lastAsk(repo).ctx).toEqual({ session: sessionHash('raw-2') })
  })

  it('keeps overlapping invocations apart', async () => {
    const a = withJournalCtx({ session: 'aaaaaaaaaaaa' }, async () => { await new Promise((r) => setTimeout(r, 10)); return entryLine({ t: 'sync' }) })
    const b = withJournalCtx({ session: 'bbbbbbbbbbbb' }, async () => entryLine({ t: 'sync' }))
    const [la, lb] = await Promise.all([a, b])
    expect(JSON.parse(la).ctx.session).toBe('aaaaaaaaaaaa')
    expect(JSON.parse(lb).ctx.session).toBe('bbbbbbbbbbbb')
  })

  it('ignores the session the test process itself runs in', async () => {
    const repo = await seededRepo()
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'ambient')
    vi.stubEnv('WITNESS_CONTEXT', JSON.stringify({ session: 'ambient', tokens: 9, window: 10 }))
    try {
      expect((await repo.cli(['ask', 'x'])).code).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(lastAsk(repo)).not.toHaveProperty('ctx')
  })

  // The spawned twin of the test above: a CLI started as a process of its own never passes
  // through tmpRepo's scrub. Both session variables are set, so the test bites whichever
  // harness the suite's own env detects.
  it('a CLI the suite spawns ignores that session too', async () => {
    const repo = await seededRepo()
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'ambient')
    vi.stubEnv('PI_SESSION_ID', 'ambient')
    vi.stubEnv('WITNESS_CONTEXT', JSON.stringify({ session: 'ambient', tokens: 9, window: 10 }))
    try {
      const bin = join(import.meta.dirname, '..', 'dist', 'bin.js')
      const r = spawnSync(process.execPath, [bin, 'ask', 'x'], { cwd: repo.root, env: hermeticEnv(), encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(lastAsk(repo)).not.toHaveProperty('ctx')
  })

  it('witness log shows what a line says, not the session that wrote it', async () => {
    const repo = await seededRepo()
    withJournalCtx({ session: 'abc123abc123', tokens: 5, window: 100 },
      () => appendEntry(repo.root, repo.effort, { t: 'sync', trigger: 'start', result: 'ok' }))
    const out = (await repo.cli(['log', repo.effort])).stdout
    expect(out).toContain('trigger')
    expect(out).not.toContain('abc123abc123')
  })
})
