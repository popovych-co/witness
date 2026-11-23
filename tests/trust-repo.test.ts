import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { trustedCommands } from '../src/allowlist.js'
import { reservedId } from '../src/ask.js'
import { readStream } from '../src/journal.js'
import { patchConfig, seededRepo } from './helpers.js'

async function repoWith(prepare: string) {
  const repo = await seededRepo()
  patchConfig(repo, { scratch: { prepare } })
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'prepare')
  return repo
}

describe('repo commands are granted with no target (row 259)', () => {
  it('journals the grant on witness\'s trust stream, then trusts it', async () => {
    const repo = await repoWith('sh prepare.sh')
    const r = await repo.cli(['trust', '--cmd', 'sh prepare.sh'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('trusted: sh prepare.sh')
    expect(trustedCommands(repo.root)).toContain('sh prepare.sh')
    expect(readStream(repo.root, 'trust')).toEqual([expect.objectContaining({ t: 'trust', artifact: '-', cmds: ['sh prepare.sh'], via: 'verb' })])
    expect(repo.git('log', '-1', '--format=%s')).toBe('trust: 1 repo command(s)')
    expect((await repo.cli(['trust', '--cmd', 'sh prepare.sh'])).stdout).toContain('already trusted: sh prepare.sh')
    expect(readStream(repo.root, 'trust')).toHaveLength(1)
  })

  it('takes only a command a repo setting declares, never inside a session; --yes still needs a target', async () => {
    const repo = await repoWith('sh prepare.sh')
    const unknown = await repo.cli(['trust', '--cmd', 'rm -rf x'])
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toMatch(/unknown-command/)
    expect(unknown.stderr).toContain('sh prepare.sh')
    expect((await repo.cli(['trust', '--cmd', 'sh prepare.sh'], { env: { WITNESS_DRIVE: 'p1' } })).stderr).toMatch(/trust-in-session/)
    expect((await repo.cli(['trust', '--yes'], { tty: true })).stderr).toMatch(/required/)
    expect(trustedCommands(repo.root)).not.toContain('sh prepare.sh')
  })

  it('the repo listing names the targetless grant for a repo command', async () => {
    const repo = await repoWith('sh prepare.sh')
    expect((await repo.cli(['trust'])).stdout).toContain("a repo command (doc -): witness trust --cmd '<cmd>'")
  })

  it('trust is a reserved id: check names a stream another history holds, and no repo grant lands there', async () => {
    expect(reservedId('trust')).toBe("witness's own trust grants")
    const repo = await repoWith('sh prepare.sh')
    mkdirSync(join(repo.root, '.witness', 'journal'), { recursive: true })
    writeFileSync(join(repo.root, '.witness', 'journal', 'trust.jsonl'), '{"v":1,"t":"recap","effort":"trust"}\n')
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'a stream that took the name', '-m', 'Witness-State: 1')
    expect((await repo.cli(['check'])).stdout).toMatch(/reserved-stream-taken/)
    expect((await repo.cli(['trust', '--cmd', 'sh prepare.sh'])).stderr).toMatch(/stream-taken/)
    expect(trustedCommands(repo.root)).not.toContain('sh prepare.sh')
  })
})
