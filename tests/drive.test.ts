import { describe, expect, it } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { classifyAction, driveLoop, spawnSession } from '../src/drive.js'
import { loadHarness } from '../src/harness.js'
import { CLAUDE_THINKING_BUDGET } from '../src/pin.js'
import { worktreePath } from '../src/worktree.js'
import {
  approve, fakeCtx, fakeScenario, fixtureEnv, seededRepo, writePlan, writeSpec, type TestRepo,
} from './helpers.js'

describe('witness drive skeleton (D145)', () => {
  it('refuses without a TTY', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['drive'])            // repo.cli runs non-TTY
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('drive-needs-tty')
  })

  it('config accepts drive.sessionTimeoutMs and defaults it', async () => {
    const { loadConfig } = await import('../src/config.js')
    const repo = await seededRepo()
    const cfg = loadConfig(repo.root)
    expect(cfg.ok && cfg.value.drive.sessionTimeoutMs).toBe(3600000)
  })

  it('refuses a non-integer drive.sessionTimeoutMs', async () => {
    const { loadConfig } = await import('../src/config.js')
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}drive:\n  sessionTimeoutMs: 0\n`)
    const cfg = loadConfig(repo.root)
    expect(cfg.ok).toBe(false)
    expect(!cfg.ok && cfg.violations[0]?.field).toBe('drive.sessionTimeoutMs')
  })
})

describe('classifyAction (D145 addendum §6)', () => {
  const root = '/repo'

  it('routes each action shape', () => {
    expect(classifyAction({ line: 'witness decide ship p1 --show', target: 'p1' }, root))
      .toEqual({ kind: 'decision', gate: 'ship', target: 'p1' })
    expect(classifyAction({ line: 'witness recap --file recap.json', stage: 'brainstorm' }, root).kind)
      .toBe('conversation')
    expect(classifyAction({ line: 'witness design auth-refresh --open', stage: 'design' }, root).kind)
      .toBe('conversation')
    expect(classifyAction({ line: 'ship: merge PR #4 on GitHub when ready' }, root).kind).toBe('merge')
    expect(classifyAction({
      line: 'witness gate implement p1', stage: 'implement', target: 'p1',
      home: '/repo/.witness/worktrees/p1',
    }, root))
      .toEqual({ kind: 'spawn', home: '/repo/.witness/worktrees/p1', stage: 'implement', target: 'p1', model: undefined })
    expect(classifyAction({ line: 'witness check' }, root).kind).toBe('idle')
  })

  it('reads the bound endgame as a decision — liveExits renders decide verbs too', () => {
    const line = 'witness decide implement p1 --approve --override | witness decide implement p1 --stop | witness abandon p1'
    expect(classifyAction({ line, target: 'p1', note: 'round bound reached — human decision required' }, root))
      .toEqual({ kind: 'decision', gate: 'implement', target: 'p1' })
  })

  it('stops on a rendered block even when the line is runnable (D121)', () => {
    const step = classifyAction({
      line: 'witness recover --complete', block: ['recovery: 2 options · 1 is recommended', '1 · recommended · root'],
    }, root)
    expect(step.kind).toBe('decision')
    expect(step.kind === 'decision' && step.block?.[0]).toMatch(/2 options/)
  })

  it('spawns at the root when the action names no home', () => {
    expect(classifyAction({ line: 'witness gate decompose --effort auth-hardening', target: 'auth-hardening' }, root))
      .toEqual({ kind: 'spawn', home: root, stage: undefined, target: 'auth-hardening', model: undefined })
  })

  it('carries the stage pin to the spawned session', () => {
    expect(classifyAction({
      line: 'witness gate implement p1', stage: 'implement', target: 'p1',
      home: '/repo/wt', model: 'claude-opus-4-6',
    }, root))
      .toEqual({ kind: 'spawn', home: '/repo/wt', stage: 'implement', target: 'p1', model: 'claude-opus-4-6' })
  })
})

describe('spawnSession (D145 addendum §3-5)', () => {
  const cfgOf = (repo: TestRepo): Config => {
    const r = loadConfig(repo.root)
    if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
    return r.value
  }
  // Fakes are written into a mkdtemp scenario dir, never fakeBinDir() — that one is a
  // COMMITTED fixture directory and a test that writes there dirties the repo.
  const fakeAgent = (body: string): string => {
    const bin = join(fakeScenario(), 'fake-agent')
    writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return bin
  }

  it('streams both pipes prefixed, from the action home', async () => {
    const repo = await seededRepo()
    const bin = fakeAgent('echo one\necho two >&2\npwd')
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, {
      tty: true, env: { WITNESS_DRIVE_AGENT_BIN: bin }, out: (l) => lines.push(l),
    })
    const res = await spawnSession(
      { kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1)
    expect(res).toBe('exited')
    expect(lines).toContain('[1 implement/p1] one')
    expect(lines).toContain('[1 implement/p1] two')
    expect(lines).toContain(`[1 implement/p1] ${repo.root}`)
  }, 20000)

  it('SIGTERMs a hung child at the configured timeout', async () => {
    const repo = await seededRepo()
    const bin = fakeAgent('sleep 60')
    const ctx = fakeCtx(repo.root, { tty: true, env: { WITNESS_DRIVE_AGENT_BIN: bin } })
    const cfg = { ...cfgOf(repo), drive: { sessionTimeoutMs: 100 } }
    expect(await spawnSession({ kind: 'spawn', home: repo.root }, cfg, ctx, 2)).toBe('timeout')
  }, 20000)

  it('returns when the session exits even if a grandchild still holds the pipe', async () => {
    const repo = await seededRepo()
    // The shape a real agent session leaves behind: a background child that inherited
    // stdout and outlives its parent. Waiting for `close` alone would hang 30s here.
    const bin = fakeAgent('sleep 30 &\necho started')
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, {
      tty: true, env: { WITNESS_DRIVE_AGENT_BIN: bin }, out: (l) => lines.push(l),
    })
    const started = Date.now()
    const res = await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 9)
    expect(res).toBe('exited')
    expect(lines.join('\n')).toContain('started')
    expect(Date.now() - started).toBeLessThan(10000)
  }, 20000)

  it('reports spawn-failed when the binary is not there', async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, {
      tty: true, env: { WITNESS_DRIVE_AGENT_BIN: join(repo.root, 'no-such-agent') },
    })
    expect(await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 3)).toBe('spawn-failed')
  }, 20000)

  it('builds the headless session command per harness, carrying the stage pin', async () => {
    const claude = loadHarness('claude-code')
    const pi = loadHarness('pi')
    expect(claude.ok && claude.value.worker.spawn('/witness'))
      .toEqual({ cmd: 'claude', args: ['-p', '/witness', '--dangerously-skip-permissions'], env: {} })
    expect(claude.ok && claude.value.worker.spawn('/witness', 'claude-opus-4-6:high'))
      .toEqual({
        cmd: 'claude',
        args: ['-p', '/witness', '--dangerously-skip-permissions', '--model', 'claude-opus-4-6'],
        env: { MAX_THINKING_TOKENS: String(CLAUDE_THINKING_BUDGET.high) },
      })
    expect(pi.ok && pi.value.worker.spawn('/witness', 'claude-opus-4-6:high'))
      .toEqual({
        cmd: 'pi',
        args: ['-p', '/witness', '--no-session', '--model', 'anthropic/claude-opus-4-6:high'],
        env: {},
      })
  })
})

// The fixture every loop case needs: an approved plan, so computeNext's first answer is
// `witness start <plan-id>` — a real act a fake agent can perform through the real CLI.
async function planReady(): Promise<TestRepo> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  approve(repo, 'auth-refresh-plan-1')
  return repo
}

// This repo's CLI, as a command a /bin/sh fake can exec. The suite never spawns the CLI
// otherwise — every other test calls main() in-process — but drive's whole subject IS a
// child process, and a fake that cannot perform a real act could only prove the loop
// spawns, never that it observes what the spawn did.
function witnessCli(): string {
  const repo = resolve(import.meta.dirname, '..')
  return `${join(repo, 'node_modules', '.bin', 'tsx')} ${join(repo, 'src', 'bin.ts')}`
}

// A fake agent that performs ONE real act (the first time it runs) and then does nothing —
// which is exactly the shape the no-progress guard must catch.
function actsOnceAgent(scenario: string, act: string): string {
  const bin = join(scenario, 'fake-driver')
  writeFileSync(bin, [
    '#!/bin/sh',
    'echo tick',
    `flag="${join(scenario, 'acted')}"`,
    '[ -f "$flag" ] && exit 0',
    'touch "$flag"',
    `exec ${witnessCli()} ${act}`,
  ].join('\n'), { mode: 0o755 })
  return bin
}

describe('driveLoop (D145)', () => {
  const cfgOf = (repo: TestRepo): Config => {
    const r = loadConfig(repo.root)
    if (!r.ok) throw new Error(`config refused: ${JSON.stringify(r.violations)}`)
    return r.value
  }
  const ttyCtx = (repo: TestRepo, env: Record<string, string>, out: string[]): Ctx =>
    fakeCtx(repo.root, { tty: true, env: fixtureEnv(env), out: (l) => out.push(l) })

  it('spawns, sees the journal grow, and stops when the action stops moving', async () => {
    const repo = await planReady()
    const bin = actsOnceAgent(fakeScenario(), 'start auth-refresh-plan-1')
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), ttyCtx(repo, { WITNESS_DRIVE_AGENT_BIN: bin }, out), { maxSpawns: 5 })

    expect(code).toBe(1)
    expect(out.join('\n')).toMatch(/drive: no progress — witness /)
    // the child really acted: the worktree exists and the loop moved past `start`
    expect(existsSync(worktreePath(repo.root, 'auth-refresh-plan-1'))).toBe(true)
    // spawn 2 ran in the WORKTREE, under the implement stage the act moved the flow to
    expect(out.join('\n')).toContain('[2 implement/auth-refresh-plan-1] tick')
    await repo.cli(['clean'])
  }, 60000)

  it('stops at the spawn ceiling, in memory, per invocation', async () => {
    const repo = await planReady()
    const bin = actsOnceAgent(fakeScenario(), 'start auth-refresh-plan-1')
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), ttyCtx(repo, { WITNESS_DRIVE_AGENT_BIN: bin }, out), { maxSpawns: 1 })

    expect(code).toBe(1)
    expect(out.join('\n')).toMatch(/drive: spawn ceiling reached \(1\)/)
    expect(out.join('\n')).not.toContain('[2 implement/auth-refresh-plan-1] tick')
    await repo.cli(['clean'])
  }, 60000)

  it('hands a conversation stage back to a chat session and exits 0', async () => {
    const repo = await seededRepo({ noRecap: true })
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), ttyCtx(repo, {}, out), {})

    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/drive: conversation — witness recap/)
  }, 20000)

  it('reports a timed-out child as findings, not as done', async () => {
    const repo = await planReady()
    const bin = join(fakeScenario(), 'hang')
    writeFileSync(bin, '#!/bin/sh\nsleep 60\n', { mode: 0o755 })
    const out: string[] = []
    const cfg = { ...cfgOf(repo), drive: { sessionTimeoutMs: 200 } }
    const code = await driveLoop(repo.root, cfg, ttyCtx(repo, { WITNESS_DRIVE_AGENT_BIN: bin }, out), {})

    expect(code).toBe(1)
    expect(out.join('\n')).toMatch(/drive: spawn-timeout/)
  }, 30000)

  it('--flow refuses a plan that is not a flow', async () => {
    const repo = await planReady()
    const res = await repo.cli(['drive', '--flow', 'auth-refresh-plan-1'], { tty: true })

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('not-started')
  }, 20000)
})
