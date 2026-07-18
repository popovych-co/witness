import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openArtifact } from '../src/opener.js'

// A recorder standing in for `open`/`xdg-open`: appends its argv to a file so the
// test can assert WHICH path the CLI handed the platform. Spawn is detached and
// unawaited, so the assertion polls rather than reading immediately.
function recorder(): { cmd: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-opener-'))
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

describe('openArtifact', () => {
  it('spawns SPECFLOW_OPENER with the absolute artifact path', async () => {
    const { cmd, log } = recorder()
    const res = openArtifact({ SPECFLOW_OPENER: cmd }, '/tmp/look.html')
    expect(res.outcome).toBe('spawned')
    expect(res.command).toBe(cmd)
    expect((await waitForLog(log)).trim()).toBe('/tmp/look.html')
  })

  it('resolves a bare override off PATH, not just an absolute path', async () => {
    // the documented escape hatch for nonstandard desktops is `SPECFLOW_OPENER=firefox`,
    // so the probe must be `command -v`, never existsSync
    const res = openArtifact({ SPECFLOW_OPENER: 'true' }, '/tmp/look.html')
    expect(res.outcome).toBe('spawned')
  })

  it('reports failed when the override does not resolve', () => {
    const res = openArtifact({ SPECFLOW_OPENER: 'specflow-no-such-opener-xyz' }, '/tmp/look.html')
    expect(res.outcome).toBe('failed')
  })

  it('names the resolved command so the journal can record what was run', () => {
    const res = openArtifact({}, '/tmp/look.html')
    expect(res.command).toBe(process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd' : 'xdg-open')
  })
})
