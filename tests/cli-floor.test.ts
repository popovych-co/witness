import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { version } from '../src/version.js'
import { seededRepo } from './helpers.js'

// A stamp higher than the running CLI is the only way to simulate the future from the
// present: the suite always runs the newest witness there is.
function stampFuture(root: string, pin = '99.0.0'): void {
  writeFileSync(join(root, '.witness', 'journal', 'future.jsonl'),
    `{"v":1,"w":"${pin}","t":"status","artifact":"x","from":"a","to":"b","cause":"start"}\n`)
}

// Every repository in the field on the day this ships: a full history, none of it stamped.
// Silence must not become a refusal, or the row bricks the users it exists to protect.
function stripStamps(root: string): void {
  const dir = join(root, '.witness', 'journal')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const p = join(dir, f)
    writeFileSync(p, readFileSync(p, 'utf8').replace(/"w":"[^"]*",/g, ''))
  }
}

describe('a CLI below the state floor refuses', () => {
  // The incident in one assertion: a CLI a lifecycle behind the repository must not be
  // able to answer a routing question, because its answer is computed from rules the
  // repository has already moved past.
  it('refuses next when the state has been written by a newer CLI', async () => {
    const repo = await seededRepo()
    stampFuture(repo.root)
    const res = await repo.cli(['next'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('cli-behind-state')
    expect(res.stderr).toContain(`this CLI is ${version()}`)
    expect(res.stderr).toContain('99.0.0')
    expect(res.stdout).toBe('')
  })

  // Every verb, not a list someone has to remember to extend.
  it('refuses a diagnostic verb on the same rule', async () => {
    const repo = await seededRepo()
    stampFuture(repo.root)
    const res = await repo.cli(['check'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('cli-behind-state')
  })

  // The two questions a refused human needs answered are still answerable.
  it('leaves --version and help open', async () => {
    const repo = await seededRepo()
    stampFuture(repo.root)
    expect((await repo.cli(['--version'])).code).toBe(0)
    expect((await repo.cli(['help'])).code).toBe(0)
  })

  // Equal is not behind. The witness developer runs the version they are building.
  it('allows a CLI at the floor', async () => {
    const repo = await seededRepo()
    stampFuture(repo.root, version())
    expect((await repo.cli(['next'])).code).toBe(0)
  })

  // Pre-0.10.0 state claims no bound, so no bound is enforced.
  it('allows a repository whose history carries no stamp', async () => {
    const repo = await seededRepo()
    stripStamps(repo.root)
    expect((await repo.cli(['next'])).code).toBe(0)
  })
})
