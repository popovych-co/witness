import { describe, expect, it } from 'vitest'
import { ASK_STREAM, askQueue } from '../src/ask.js'
import { idRetired } from '../src/departure.js'
import { effortStreams, readStream } from '../src/journal.js'
import { seededRepo, tmpRepo, writeSpec } from './helpers.js'

const initialized = async () => { const repo = tmpRepo(); await repo.cli(['init']); return repo }

describe('witness ask (A9)', () => {
  it('queues an ask as a trailered state commit on the asks stream', async () => {
    const repo = await initialized()
    const r = await repo.cli(['ask', 'Guests can pay by card at checkout'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('ask: a1 — queued')
    expect(r.stdout).toContain('queue: 1 unanswered — next routes the oldest first')
    expect(readStream(repo.root, ASK_STREAM)).toMatchObject([{ v: 1, t: 'ask', id: 'a1', text: 'Guests can pay by card at checkout' }])
    expect(repo.git('log', '-1', '--format=%s')).toBe('ask(a1): Guests can pay by card at checkout')
    expect(repo.git('log', '-1', '--format=%(trailers:key=Witness-State,valueonly=true)')).toBe('1')
  })

  it('numbers asks in queue order and joins unquoted words', async () => {
    const repo = await initialized()
    await repo.cli(['ask', 'first'])
    await repo.cli(['ask', 'pay', 'by', 'card'])
    expect(askQueue(repo.root).map((a) => [a.id, a.text, a.state]))
      .toEqual([['a1', 'first', 'unanswered'], ['a2', 'pay by card', 'unanswered']])
  })

  it('refuses an empty ask and text beside --withdraw', async () => {
    const repo = await initialized()
    const empty = await repo.cli(['ask', '   '])
    expect(empty.code).toBe(2)
    expect(empty.stderr).toContain('text,required')
    const both = await repo.cli(['ask', 'x', '--withdraw', 'a1'])
    expect(both.code).toBe(2)
    expect(both.stderr).toContain('ask,usage')
  })

  it('withdraws an unanswered ask once and refuses an unknown one', async () => {
    const repo = await initialized()
    await repo.cli(['ask', 'first'])
    const w = await repo.cli(['ask', '--withdraw', 'a1', '--note', 'wrong repo'])
    expect(w.code).toBe(0)
    expect(w.stdout).toContain('ask: a1 — withdrawn')
    expect(askQueue(repo.root)[0]!.state).toBe('withdrawn')
    expect(readStream(repo.root, ASK_STREAM).at(-1)).toMatchObject({ t: 'ask-withdrawn', ask: 'a1', note: 'wrong repo' })
    const head = repo.git('rev-parse', 'HEAD')
    const again = await repo.cli(['ask', '--withdraw', 'a1'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('ask: a1 — already withdrawn')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
    const ghost = await repo.cli(['ask', '--withdraw', 'a9'])
    expect(ghost.code).toBe(2)
    expect(ghost.stderr).toContain('unknown-ask')
  })

  it('reserves the asks id before the stream exists, and the stream is no effort and no orphan', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    for (const slug of [ASK_STREAM, 'floor']) {
      repo.write('r.json', JSON.stringify({ effort: slug, class: 'feature', goals: [{ id: 'g1', text: 'x' }] }))
      const r = await repo.cli(['recap', '--file', 'r.json'])
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('id-taken')
      const rn = await repo.cli(['rename', 'auth-refresh', slug])
      expect(rn.code).toBe(2)
      expect(rn.stderr).toContain('id-taken')
    }
    expect((await writeSpec(repo, ASK_STREAM)).stderr).toContain('id-taken')
    await repo.cli(['ask', 'first'])
    expect(effortStreams(repo.root)).not.toContain(ASK_STREAM)
    expect(idRetired(repo.root, ASK_STREAM, 'spec')?.rule).toBe('id-taken')
    expect((await repo.cli(['check'])).stdout).not.toContain('orphan-journal')
  })

  it('log renders an ask', async () => {
    const repo = await initialized()
    await repo.cli(['ask', 'first'])
    expect((await repo.cli(['log', ASK_STREAM])).stdout).toContain('a1 — first')
  })
})
