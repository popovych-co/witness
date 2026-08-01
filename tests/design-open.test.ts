import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { approve, seededRepo, witnessDesign, writeDesign, writeLocalConfig, writeSpec } from './helpers.js'
import { readStream } from '../src/journal.js'
import { htmlSha } from '../src/design.js'

function recorder(): { cmd: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-open-'))
  const log = join(dir, 'opened.txt')
  const cmd = join(dir, 'rec.sh')
  writeFileSync(cmd, `#!/bin/sh\necho "$1" >> "${log}"\n`)
  chmodSync(cmd, 0o755)
  return { cmd, log }
}

async function waitForLog(log: string, ms = 3000): Promise<string> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (existsSync(log)) return readFileSync(log, 'utf8')
    await new Promise((r) => setTimeout(r, 25))
  }
  return ''
}

describe('witness design --open', () => {
  it('spawns the opener and journals a design-shown entry for the current sha', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    await writeDesign(repo, 'auth-refresh')
    const { cmd, log } = recorder()

    writeLocalConfig(repo.root, { opener: cmd })
    const res = await repo.cli(['design', 'auth-refresh', '--open'])

    expect(res.code).toBe(0)
    expect((await waitForLog(log)).trim()).toBe(join(repo.root, 'designs/auth-refresh.html'))
    const sha = htmlSha(readFileSync(join(repo.root, 'designs/auth-refresh.html'), 'utf8'))
    const entry = readStream(repo.root, 'auth-refresh').filter((e) => e.t === 'design-shown').at(-1) as
      { sha?: string; opener?: string; by?: string } | undefined
    expect(entry?.sha).toBe(sha)
    expect(entry?.opener).toBe(cmd)          // WHAT was run is on the record
    expect(entry?.by).toMatch(/@/)           // user@host — the machine it was shown on
  })

  it('refuses when no artifact exists yet', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')

    const res = await repo.cli(['design', 'auth-refresh', '--open'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('no-artifact')
  })

  it('refuses with the file:// path when no opener resolves', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    await writeDesign(repo, 'auth-refresh')

    writeLocalConfig(repo.root, { opener: 'witness-no-such-opener-xyz' })
    const res = await repo.cli(['design', 'auth-refresh', '--open'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('opener-failed')
    expect(res.stderr).toContain('file://')
    expect(readStream(repo.root, 'auth-refresh').some((e) => e.t === 'design-shown')).toBe(false)
  })
})

describe('next routes to --open', () => {
  it('asks for the show step between register and gate', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    await writeDesign(repo, 'auth-refresh')

    const res = await repo.cli(['next'])

    expect(res.stdout).toContain('design auth-refresh --open')
  })

  it('asks for the gate once the artifact has been shown', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ui: true })
    approve(repo, 'auth-refresh')
    await writeDesign(repo, 'auth-refresh')
    await witnessDesign(repo, 'auth-refresh')

    const res = await repo.cli(['next'])

    expect(res.stdout).toContain('gate design auth-refresh')
  })
})
