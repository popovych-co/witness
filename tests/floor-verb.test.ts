import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateFloor } from '../src/floor.js'
import { version } from '../src/version.js'
import { seededRepo } from './helpers.js'

function stampFuture(root: string, pin = '99.0.0'): void {
  writeFileSync(join(root, '.witness', 'journal', 'future.jsonl'),
    `{"v":1,"w":"${pin}","t":"status","artifact":"x","from":"a","to":"b","cause":"start"}\n`)
}

function stripStamps(root: string): void {
  const dir = join(root, '.witness', 'journal')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const p = join(dir, f)
    writeFileSync(p, readFileSync(p, 'utf8').replace(/"w":"[^"]*",/g, ''))
  }
}

describe('witness floor', () => {
  it('reports no bound for a state that predates the stamp', async () => {
    const repo = await seededRepo()
    stripStamps(repo.root)
    const res = await repo.cli(['floor', '--show'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('predates')
  })

  it('reports the derived floor and the stream that set it', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['floor', '--show'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain(`floor: ${version()}`)
  })

  // A lowered bound overrides the derived maximum outright — that is the whole point of
  // the valve, and a rule that merely tied with the maximum could never let anything roll
  // back. Without it one broken publish strands every repository that ran it once.
  it('lets an explicit pin lower the bound below the derived maximum', async () => {
    const repo = await seededRepo()
    stampFuture(repo.root)
    expect(stateFloor(repo.root)?.pin).toBe('99.0.0')
    expect((await repo.cli(['next'])).code).toBe(2)

    const res = await repo.cli(['floor', '--set', '0.5.0', '--note', 'rolling back a bad publish'])
    expect(res.code).toBe(0)
    expect(stateFloor(repo.root)?.pin).toBe('0.5.0')
    expect((await repo.cli(['next'])).code).toBe(0)
  })

  // The latest decision is the state — the same doctrine D94 applies to gate decisions.
  it('lets a second pin supersede the first', async () => {
    const repo = await seededRepo()
    await repo.cli(['floor', '--set', '0.5.0', '--note', 'first'])
    await repo.cli(['floor', '--set', '0.6.0', '--note', 'second'])
    expect(stateFloor(repo.root)?.pin).toBe('0.6.0')
  })

  // The verb has to stay reachable from a repository that refuses everything else, or the
  // valve is welded shut exactly when it is needed.
  it('runs even when the CLI is below the floor', async () => {
    const repo = await seededRepo()
    stampFuture(repo.root)
    expect((await repo.cli(['floor', '--show'])).code).toBe(0)
  })

  // The decision is auditable or it is not a decision.
  it('refuses --set without a note', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['floor', '--set', '0.5.0'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('note-required')
  })

  it('refuses a pin that is not a numeric triple', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['floor', '--set', 'latest', '--note', 'why'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('bad-pin')
  })

  // Row 111's doctrine: one refusal names every reason it could not happen, so the human
  // does not learn the second blocker on the re-run.
  it('names both faults in one refusal', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['floor', '--set', 'latest'])
    expect(res.stderr).toContain('bad-pin')
    expect(res.stderr).toContain('note-required')
  })
})
