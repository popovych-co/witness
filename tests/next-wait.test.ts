import { describe, expect, it } from 'vitest'
import { type TestRepo, approve, autonomyOn, patchConfig, seededRepo, trustConfig, writePlan, writeSpec } from './helpers.js'

const WAIT = /^wait: witness wait --since [0-9a-f]{12}$/m

// A started flow drive has work for, its runner trusted, autonomy on.
async function flowing(opts: { autonomy?: boolean } = {}): Promise<TestRepo> {
  const repo = await seededRepo()
  trustConfig(repo)
  await writeSpec(repo, 'a', { criteria: [{ id: 'ac-a', test: '@spec:a' }] })
  approve(repo, 'a')
  await writePlan(repo, 'a-plan-1', { parent: 'a', steps: [{ id: 's1', title: 'a', criteria: ['ac-a'] }] })
  approve(repo, 'a-plan-1')
  await repo.cli(['start', 'a-plan-1'])
  if (opts.autonomy !== false) autonomyOn(repo)
  return repo
}

// Row 204. With nothing routed for the human and drive running or launched, the chat no longer
// ends its turn after `launch:`: `next` prints how this chat waits, rendered for its harness.
describe('next tells the chat how to wait (D204)', () => {
  it('on Claude Code the chat waits in the background', async () => {
    const repo = await flowing()
    const res = await repo.cli(['next'], { env: { CLAUDECODE: '1' } })
    expect(res.stdout).toContain('launch: witness drive --detach')
    expect(res.stdout).toMatch(WAIT)
    expect(res.stdout).toContain('wait-mode: background')
    const lines = res.stdout.trim().split('\n')
    expect(lines.slice(-3).map((l) => l.split(':')[0])).toEqual(['launch', 'wait', 'wait-mode'])
  })

  it('on Pi with a current add-on the add-on waits', async () => {
    const repo = await flowing()
    patchConfig(repo, { harness: 'pi' })
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'pi')
    await repo.cli(['init', '--agent', 'pi'])
    const res = await repo.cli(['next'], { env: { PI_CODING_AGENT: 'true' } })
    expect(res.stdout).toMatch(WAIT)
    expect(res.stdout).toContain('wait-mode: add-on')
    expect(res.stdout).not.toContain('older than this CLI')
  })

  it('on Pi with a stale add-on the chat waits in the foreground and is told why', async () => {
    const repo = await flowing()
    patchConfig(repo, { harness: 'pi' })
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'pi')
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/extensions/witness.ts'
    repo.write(rel, `${repo.read(rel)}\n// an older add-on\n`)
    const res = await repo.cli(['next'], { env: { PI_CODING_AGENT: 'true' } })
    expect(res.stdout).toContain('warn: the witness Pi add-on is older than this CLI — this chat waits in the foreground · run npx -y @popovych.co/witness@latest init --agent pi')
    expect(res.stdout).toContain('wait-mode: foreground')
  })

  it('a paused drive holding the lock still gets watch: and wait:', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    const { spawn } = await import('node:child_process')
    const holder = spawn('sleep', ['10'])
    try {
      repo.write('.witness/drive.lock', JSON.stringify({ pid: holder.pid, log: `${repo.root}/.witness/drive.log` }))
      const res = await repo.cli(['next'], { env: { CLAUDECODE: '1' } })
      expect(res.stdout).toContain(`watch: tail -f ${repo.root}/.witness/drive.log · stop it: kill ${holder.pid}`)
      expect(res.stdout).toMatch(WAIT)
    } finally { holder.kill() }
  })

  it('nothing is printed with autonomy off, in a drive session, or with a human item routed', async () => {
    const off = await flowing({ autonomy: false })
    expect((await off.cli(['next'], { env: { CLAUDECODE: '1' } })).stdout).not.toMatch(/^wait/m)
    const repo = await flowing()
    expect((await repo.cli(['next'], { env: { CLAUDECODE: '1', WITNESS_DRIVE: 'a-plan-1' } })).stdout).not.toMatch(/^wait/m)
    // an untrusted runner makes the flow's step the human's trust act
    repo.write('.witness/allow.json', JSON.stringify({ commands: [] }))
    const human = await repo.cli(['next'], { env: { CLAUDECODE: '1', WITNESS_TRUST_CMDS: '' } })
    expect(human.stdout).toContain('next: witness trust a-plan-1')
    expect(human.stdout).not.toMatch(/^wait/m)
  })
})
