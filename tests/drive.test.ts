import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Ctx } from '../src/cli.js'
import { loadConfig, type Config } from '../src/config.js'
import { classifyAction, driveLoop, lineSink, spawnSession } from '../src/drive.js'
import type { Ticker } from '../src/session-clock.js'
import { watchLine } from '../src/drive-presence.js'
import { psArg } from '../src/toon.js'
import { loadHarness } from '../src/harness.js'
import { CLAUDE_THINKING_BUDGET } from '../src/pin.js'
import { worktreePath } from '../src/worktree.js'
import { gateParked } from '../src/verbs/next.js'
import { appendEntry, readStream } from '../src/journal.js'
import { effortReviewedSha } from '../src/reviewed.js'
import { findById, loadCanon } from '../src/scan.js'
import { canonicalSha } from '../src/sha.js'
import { ROUND_BOUND } from '../src/rounds.js'
import {
  DESIGN_HTML, PLAN_BODY, PLAN_META, SPEC_BODY, SPEC_META, addOrigin, approve, autonomyOn, behaviorOnMain, fakeClock, fakeCtx, fakeScenario, fixtureEnv, gateEnv, hermeticEnv, measuredEnv, noopOpener, PLAN_BLOCKING, plannedRepo, putVerdict,
  seededRepo, witnessDesign, writeDesign, writeLocalConfig, writePlan, writeSpec, type TestRepo, patchConfig} from './helpers.js'

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
// A noop keep-awake by default: the real `caffeinate` must never run from the suite.
const ttyCtx = (repo: TestRepo, env: Record<string, string>, out: string[]): Ctx =>
  fakeCtx(repo.root, { tty: true, env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), ...env }), out: (l) => out.push(l) })
// A no-op agent, so whatever the loop routes to AFTER the decision cannot spawn a real
// harness: the assertion under test is the decision, not what follows it. It says `tick`
// so a test can find its session by prefix.
const idleAgent = (): string => {
  const bin = join(fakeScenario(), 'idle-agent')
  writeFileSync(bin, '#!/bin/sh\necho tick\nexit 0\n', { mode: 0o755 })
  return bin
}
const askCtx = (repo: TestRepo, answers: string[], out: string[]): Ctx =>
  fakeCtx(repo.root, {
    tty: true, answers, out: (l) => out.push(l),
    env: fixtureEnv({ WITNESS_DRIVE_AGENT_BIN: idleAgent(), WITNESS_KEEP_AWAKE_BIN: noopOpener() }),
  })

// n started flows, one spec each. A fresh worktree owes its first red, so every flow sits
// at `witness test-evidence <plan> --phase red --step s1` (rank 1). `shipping` gets a pr (rank 3).
async function startedFlows(specs: string[], opts: { shipping?: string } = {}): Promise<TestRepo> {
  const repo = await seededRepo()
  for (const s of specs) {
    await writeSpec(repo, s, { criteria: [{ id: `ac-${s}`, test: `@spec:${s}` }] })
    approve(repo, s)
    await writePlan(repo, `${s}-plan-1`, { parent: s, steps: [{ id: 's1', title: s, criteria: [`ac-${s}`] }] })
    approve(repo, `${s}-plan-1`)
    await repo.cli(['start', `${s}-plan-1`])
  }
  if (opts.shipping) repo.setMeta(`${opts.shipping}-plan-1`, { pr: 7 })
  autonomyOn(repo)
  writeLocalConfig(repo.root, { notify: noopOpener() })
  return repo
}
// Row 202: a run left with only the human's work pauses for them. These tests are about what
// comes before, so the human never comes back: the idle limit is reached at once (the pause's
// own tests are tests/drive-pause.test.ts).
const NO_WAIT = { WITNESS_DRIVE_IDLE_MAX_MS: '0' }
const autoCtx = (repo: TestRepo, env: Record<string, string>, out: string[]): Ctx =>
  fakeCtx(repo.root, { env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: noopOpener(), ...NO_WAIT, ...env }), out: (l) => out.push(l) })
const script = (body: string): string => {
  const bin = join(fakeScenario(), 'agent')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}
// One record as a /bin/sh line: what a harness in its streaming mode writes.
const say = (event: object): string => `printf '%s\\n' '${JSON.stringify(event).replaceAll("'", "'\\''")}'`
// Wait (at most 10 s) for the test to see a line; exit 3 if it never does.
const awaitFlag = (flag: string): string =>
  `i=0; while [ ! -f "${flag}" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; [ -f "${flag}" ] || exit 3`
const MERGE = 'ship: "merge PR #7 on GitHub when ready — the lazy stamp flips plan → done, spec → live"'   // E2's real shape
// Virtual awake time for a real child: each armed check fires on the next macrotask, `ms` later here.
const fastTicker = (): Ticker => {
  let now = 0
  return { now: () => now, after: (ms, fn) => { const t = setTimeout(() => { now += ms; fn() }, 0); return () => clearTimeout(t) } }
}

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
    patchConfig(repo, { drive: { sessionTimeoutMs: 0 } })
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
  it('streams both pipes prefixed, from the action home', async () => {
    const repo = await seededRepo()
    const bin = fakeAgent('echo one\necho two >&2\npwd')
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, {
      tty: true, env: { WITNESS_DRIVE_AGENT_BIN: bin }, out: (l) => lines.push(l),
    })
    const res = await spawnSession(
      { kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1)
    expect(res.outcome).toBe('exited')
    expect(lines).toContain('[1 implement/p1] one')
    expect(lines).toContain('[1 implement/p1] two')
    expect(lines).toContain(`[1 implement/p1] ${repo.root}`)
  }, 20000)

  it('SIGTERMs a hung child at the configured timeout', async () => {
    const repo = await seededRepo()
    const bin = fakeAgent('sleep 60')
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { tty: true, env: { WITNESS_DRIVE_AGENT_BIN: bin }, out: (l) => lines.push(l) })
    const cfg = { ...cfgOf(repo), drive: { ...cfgOf(repo).drive, sessionTimeoutMs: 100 } }
    expect((await spawnSession({ kind: 'spawn', home: repo.root }, cfg, ctx, 2)).outcome).toBe('timeout')
    expect(lines.some((l) => /\] ended \d\d:\d\d:\d\d · timed out · /.test(l))).toBe(true)
  }, 20000)

  it('a host sleep mid-session is not session time (row 210, issue #58)', async () => {
    const repo = await seededRepo()
    let offset = 0
    const ticker: Ticker = { now: () => performance.now() + offset,
      after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) } }
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('echo napping\nsleep 3\necho up') },
      out: (l) => { lines.push(l); if (l.endsWith(' napping')) offset += 9 * 3_600_000 } })
    const cfg = { ...cfgOf(repo), drive: { ...cfgOf(repo).drive, sessionTimeoutMs: 60_000 } }
    const end = await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfg, ctx, 1, { ticker })
    expect(end.outcome).toBe('exited')
    expect(lines).toContain('[1 implement/p1] host slept 9h — not counted against drive.sessionTimeoutMs')
    expect(end.tail.some((l) => l.includes('host slept'))).toBe(false)
    expect(end.ms).toBeLessThan(60_000)
  }, 20000)

  it('a session timeout past 2^31 ms does not stop the session at once (P4)', async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('sleep 1\necho done') } })
    const cfg = { ...cfgOf(repo), drive: { ...cfgOf(repo).drive, sessionTimeoutMs: 2 ** 31 } }
    expect((await spawnSession({ kind: 'spawn', home: repo.root }, cfg, ctx, 1)).outcome).toBe('exited')
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
    expect(res.outcome).toBe('exited')
    expect(lines.some((l) => /\] started$/.test(l))).toBe(true)
    expect(Date.now() - started).toBeLessThan(10000)
  }, 20000)

  it('reports spawn-failed when the binary is not there', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, {
      tty: true, env: { WITNESS_DRIVE_AGENT_BIN: join(repo.root, 'no-such-agent') }, out: (l) => lines.push(l),
    })
    expect((await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 3)).outcome).toBe('spawn-failed')
    expect(lines.some((l) => /\] (started|ended) /.test(l))).toBe(false)
  }, 20000)

  // Each harness names its own session on its own shell commands (P1, and pi's bash tool), so
  // the chat session drive was started from is no fact about the child.
  it('strips WITNESS_CONTEXT and the session variables from the child (row 191 §4.9)', async () => {
    const repo = await seededRepo()
    const bin = fakeAgent('echo "ctx=${WITNESS_CONTEXT-unset} claude=${CLAUDE_CODE_SESSION_ID-unset} pi=${PI_SESSION_ID-unset}"')
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, {
      env: { WITNESS_DRIVE_AGENT_BIN: bin, ...measuredEnv('chat', 170000, 1000000), PI_SESSION_ID: 'chat' }, out: (l) => lines.push(l),
    })
    await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1)
    expect(lines).toContain('[1 implement/p1] ctx=unset claude=unset pi=unset')
  }, 20000)

  // Final review minor 5. Each harness sets its own detection variable on the commands it runs, so
  // a child inherits none: a claude child of a drive typed in a Pi chat detected Pi, read its own
  // reading as stale, journaled no session and relayed with /new. Drive itself still detects: with
  // no `harness:` declared, the chat's harness is the judge whose worker it spawns (pi's flags).
  it('drops every harness detection variable from the child, never from drive (row 191 §4.9)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { harness: 'pi' })   // row 193: the judge is declared; drive spawns on it
    const bin = fakeAgent('echo "args=$* pi=${PI_CODING_AGENT-unset} claude=${CLAUDECODE-unset}"')
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, {
      env: { WITNESS_DRIVE_AGENT_BIN: bin, PI_CODING_AGENT: 'true', CLAUDECODE: '1' }, out: (l) => lines.push(l),
    })
    await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1)
    expect(lines.filter((l) => !/\] (started|ended) /.test(l))).toEqual(['[1 implement/p1] args=-p /witness --mode json pi=unset claude=unset'])
    expect(ctx.env).toMatchObject({ PI_CODING_AGENT: 'true', CLAUDECODE: '1' })
  }, 20000)

  it('builds the headless session command per harness, carrying the stage pin', async () => {
    const claude = loadHarness('claude-code')
    const pi = loadHarness('pi')
    expect(claude.ok && claude.value.worker.spawn('/witness'))
      .toEqual({ cmd: 'claude', args: ['-p', '/witness', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'], env: {} })
    expect(claude.ok && claude.value.worker.spawn('/witness', 'claude-opus-4-6:high'))
      .toEqual({
        cmd: 'claude',
        args: ['-p', '/witness', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', 'claude-opus-4-6'],
        env: { MAX_THINKING_TOKENS: String(CLAUDE_THINKING_BUDGET.high) },
      })
    expect(pi.ok && pi.value.worker.spawn('/witness', 'claude-opus-4-6:high'))
      .toEqual({
        cmd: 'pi',
        args: ['-p', '/witness', '--mode', 'json', '--model', 'anthropic/claude-opus-4-6:high'],
        env: {},
      })
  })

  // Row 214. Print mode wrote one answer when the session ended; drive renders the event stream
  // as it comes. The fake waits on its first line to be seen, so a drive that rendered only at
  // exit deadlocks it into exit 3.
  it('renders the worker\'s events as they arrive (issue #64)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { harness: 'pi' })
    const flag = join(fakeScenario(), 'seen')
    const bin = fakeAgent([
      say({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'witness start p1' } }),
      awaitFlag(flag),
      say({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } }),
    ].join('\n'))
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, {
      env: { WITNESS_DRIVE_AGENT_BIN: bin },
      out: (l) => { lines.push(l); if (l === '[1 implement/p1] $ witness start p1') writeFileSync(flag, '') },
    })
    const end = await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1)
    expect(end.code).toBe(0)
    expect(lines).toContain('[1 implement/p1] Done.')
    expect(lines.some((l) => l.includes('"type":'))).toBe(false)
  }, 20000)

  // D2: once per id, with the folder drive's pi sessions are kept in — and never in the tail
  // row 182 reads.
  it('prints the session id once, outside the tail (issue #64)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { harness: 'pi' })
    const header = say({ type: 'session', version: 3, id: 'S-1', timestamp: '2026-10-29T08:48:09.000Z', cwd: repo.root })
    const bin = fakeAgent(`${header}\n${header}\necho hi`)
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: bin, HOME: '/h' }, out: (l) => lines.push(l) })
    const end = await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1, { root: repo.root })
    expect(lines.filter((l) => /\] session /.test(l))).toHaveLength(1)
    expect(lines.filter((l) => /^\[1 implement\/p1\] session S-1 · \/h\/\.pi\/agent\/sessions\/witness-drive\//.test(l))).toHaveLength(1)
    expect(end.tail).toEqual(['hi'])
  }, 20000)

  // Review Focus 4: an escape a child writes is spelled out, never painted onto the human's terminal.
  it('spells out the control characters a child writes (issue #64)', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent("printf 'a\\033[2Jb\\n' >&2") }, out: (l) => lines.push(l) })
    await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1)
    expect(lines).toContain('[1 implement/p1] a\\x1b[2Jb')
  }, 20000)

  // Review Focus 1 (P16): a throw in a pipe's 'data' listener takes drive down and leaves the
  // session running unwatched, so drive holds even a broken renderer to never throwing.
  it('a renderer that throws never takes drive down (issue #64)', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent(`echo '{"type":"x"}'`) }, out: (l) => lines.push(l) })
    const stream = { line: (): never => { throw new Error('boom') }, inFlight: () => undefined, failed: () => false }
    const end = await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1, { stream })
    expect(end.outcome).toBe('exited')
    expect(lines).toContain('[1 implement/p1] {"type":"x"}')
  }, 20000)
})

// Row 214. Drive's own lines frame each session, and never enter the tail row 182 reads.
describe('drive says how a session goes (row 214)', () => {
  it('says when a session started and how it ended (issue #64)', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('echo hi') }, out: (l) => lines.push(l) })
    const end = await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1, { next: 'witness start p1' })
    expect(lines[0]).toMatch(/^\[1 implement\/p1\] started \d\d:\d\d:\d\d · next: witness start p1$/)
    expect(lines[1]).toBe('[1 implement/p1] hi')
    expect(lines.at(-1)).toMatch(/^\[1 implement\/p1\] ended \d\d:\d\d:\d\d · exit 0 · \d+s$/)
    expect(end.tail).toEqual(['hi'])
  }, 20000)

  it('ended names the outcome (issue #64)', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('exit 3') }, out: (l) => lines.push(l) })
    await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1)
    expect(lines.at(-1)).toContain(' · exit 3 · ')
    // pi's JSON mode exits 0 on a provider error (P2): the stream is what says so.
    patchConfig(repo, { harness: 'pi' })
    const error = say({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded' } })
    const pi: string[] = []
    const piCtx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent(`${error}\nexit 0`) }, out: (l) => pi.push(l) })
    await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), piCtx, 2)
    expect(pi.at(-1)).toContain(' · exit 0 (error) · ')
  }, 20000)

  // D8. The fake waits on the quiet line, so a drive that never printed one deadlocks it into exit 3.
  it('a quiet session says it still runs and what it waits on (issue #64)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { harness: 'pi' })
    const flag = join(fakeScenario(), 'seen')
    const bin = fakeAgent(`${say({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'cargo test discovery' } })}\n${awaitFlag(flag)}`)
    let quiet: string | undefined
    const ctx = fakeCtx(repo.root, {
      env: { WITNESS_DRIVE_AGENT_BIN: bin },
      out: (l) => {
        if (quiet === undefined && l.includes('] still running · ') && l.endsWith('in: $ cargo test discovery')) { quiet = l; writeFileSync(flag, '') }
      },
    })
    const cfg = { ...cfgOf(repo), drive: { ...cfgOf(repo).drive, sessionTimeoutMs: 7_200_000 } }
    const end = await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfg, ctx, 1, { ticker: fastTicker() })
    expect(quiet).toMatch(/^\[1 implement\/p1\] still running · \d+m(\d+s)? of 2h · quiet 5m · in: \$ cargo test discovery$/)
    expect(end.code).toBe(0)
  }, 20000)

  // Review Focus 1: a harness whose event shapes changed renders nothing, and drive still says so.
  it('a session that renders nothing still says it runs (issue #64)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { harness: 'pi' })
    const flag = join(fakeScenario(), 'seen')
    const bin = fakeAgent(`${say({ type: 'brand_new' })}\n${awaitFlag(flag)}`)
    const lines: string[] = []
    let quiet: string | undefined
    const ctx = fakeCtx(repo.root, {
      env: { WITNESS_DRIVE_AGENT_BIN: bin },
      out: (l) => { lines.push(l); if (quiet === undefined && l.includes('] still running · ')) { quiet = l; writeFileSync(flag, '') } },
    })
    const cfg = { ...cfgOf(repo), drive: { ...cfgOf(repo).drive, sessionTimeoutMs: 7_200_000 } }
    await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfg, ctx, 1, { ticker: fastTicker() })
    expect(quiet).toMatch(/still running · \d+m(\d+s)? of 2h · quiet 5m$/)
    expect(lines.some((l) => l.includes('brand_new'))).toBe(false)
  }, 20000)

  // Review Focus 4: drive's own lines carry text a child controls (its session id): one emitter
  // spells out every line printed under a session's prefix.
  it('a session id carrying an escape is spelled out (issue #64)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { harness: 'pi' })
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent(say({ type: 'session', id: 'S\x1b[2J' })) }, out: (l) => lines.push(l) })
    await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1)
    expect(lines).toContain('[1 implement/p1] session S\\x1b[2J')
    expect(lines.some((l) => l.includes('\x1b'))).toBe(false)
  }, 20000)
})

// Review Focus 4. What drive prints of an act is repo text (a decision's note): spelled out too.
// `firstPoll`, not `once`: this file imports `once` from node:events.
describe('journal lines (row 214)', () => {
  const firstPoll = (polled: string[]) => { let done = false; return () => { if (done) return []; done = true; return polled } }
  it('journal lines are spelled out too (issue #64)', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('sleep 1.5') }, out: (l) => lines.push(l) })
    await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1,
      { progress: firstPoll(['journal: human-decision implement: approve — ok\x1b]52;c;x\x07']) })
    expect(lines).toContain('[1 implement/p1] journal: human-decision implement: approve — ok\\x1b]52;c;x\\x07')
    expect(lines.some((l) => l.includes('\x1b'))).toBe(false)
  }, 20000)
})

describe('lineSink (row 214)', () => {
  // Review Focus 3: pi's agent_end carries the whole conversation in one record.
  it('lineSink takes one long record in linear time (issue #64)', () => {
    const recs: string[] = []
    const sink = lineSink((r) => recs.push(r))
    const t0 = performance.now()
    for (let i = 0; i < 128; i++) sink.push('x'.repeat(65_536))
    sink.push('\r\nnext\n')
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(recs.map((r) => r.length)).toEqual([8_388_608, 4])
  })
})

// The fixture every loop case needs: an approved plan, so computeNext's first answer is
// `witness start <plan-id>` — a real act a fake agent can perform through the real CLI.
async function planReady(opts: Parameters<typeof writePlan>[2] = {}): Promise<TestRepo> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1', opts)
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
    const cfg = { ...cfgOf(repo), drive: { ...cfgOf(repo).drive, sessionTimeoutMs: 200 } }
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

// A real decompose gate-run against the fixture reviewer: the effort now carries a
// pending decision, so `next` — and therefore drive — stops at a judgment stop.
async function gatedEffort(): Promise<TestRepo> {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  const scenario = fakeScenario()
  putVerdict(scenario, {
    coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }],
    findings: [{ blocking: true, anchor: 'auth-refresh > ## Behavior', claim: 'no rotation window stated' }],
  })
  const g = await repo.cli(['gate', 'decompose', '--effort', repo.effort], { env: gateEnv(scenario) })
  if (g.code > 1) throw new Error(`gate failed: ${g.stdout}\n${g.stderr}`)
  return repo
}

describe('judgment stops in the driver terminal (D145, D143)', () => {
  const lastDecision = (repo: TestRepo): Record<string, unknown> | undefined =>
    readStream(repo.root, repo.effort).filter((e) => e.t === 'human-decision').at(-1) as
      Record<string, unknown> | undefined

  it('renders the block, then a bare affirmation takes the recommendation --via affirmation', async () => {
    const repo = await gatedEffort()
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), askCtx(repo, ['y'], out), { maxSpawns: 1 })

    expect(out.join('\n')).toContain('1 is recommended')        // the block was rendered here
    const d = lastDecision(repo)
    expect(d?.decision).toBe('revise')                          // the rule's recommendation
    expect(d?.selected).toBe('affirmation')
  }, 30000)

  it('a named option number runs that option, with no affirmation mark', async () => {
    const repo = await gatedEffort()
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), askCtx(repo, ['1'], out), { maxSpawns: 1 })

    const d = lastDecision(repo)
    expect(d?.decision).toBe('revise')
    expect(d?.selected).toBeUndefined()                         // naming is not nodding
  }, 30000)

  it('an empty answer leaves the stop standing and exits 0', async () => {
    const repo = await gatedEffort()
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), askCtx(repo, ['', ''], out), { maxSpawns: 1 })

    expect(code).toBe(0)
    expect(lastDecision(repo)).toBeUndefined()                  // nothing decided
    expect(out.join('\n')).toMatch(/drive: decision stands/)
  }, 30000)

  it('refuses to take an excluded act on a nod, and says which act (D143)', async () => {
    const repo = await gatedEffort()
    // Drive the gate to its bound. The appended rounds carry the effort's CURRENT sha —
    // a stale verdict would take `--approve --override` off the block and recommend the
    // upstream revise instead, which is not an excluded act and would not test the rule.
    // Distinct anchors keep recurrence below the escalation rule for the same reason.
    const sha = effortReviewedSha(repo.root, loadCanon(repo.root), repo.effort).sha
    const anchors = ['auth-refresh > ## Motivation', 'auth-refresh > ## Constraints']
    for (let round = 2; round <= ROUND_BOUND; round++) {
      appendEntry(repo.root, repo.effort, {
        v: 1, t: 'gate-run', gate: 'decompose', artifact: repo.effort, round, run_id: `r${round}`,
        reviewed_sha: sha, prompts_sha: 'p', witness: '0', model: 'm',
        checks: [], outcome: 'stopped',
        verdicts: [{
          reviewer: 'slicing-critic',
          coverage: [{ anchor: anchors[round - 2]!, note: 'read' }],
          findings: [{ blocking: true, anchor: anchors[round - 2]!, claim: 'still unstated' }],
        }],
      })
    }
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), askCtx(repo, ['y', ''], out), { maxSpawns: 1 })

    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/nod-cannot|name the option/)
    expect(lastDecision(repo)).toBeUndefined()
  }, 30000)
})

describe('sessions carry their target (B1 · B3)', () => {
  it('hands the child its target as the drive marker', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('echo "marker=$WITNESS_DRIVE"') }, out: (l) => lines.push(l) })
    await spawnSession({ kind: 'spawn', home: repo.root, stage: 'implement', target: 'p1' }, cfgOf(repo), ctx, 1)
    await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 2)
    expect(lines).toContain('[1 implement/p1] marker=p1')
    expect(lines.find((l) => /^\[2 [^\]]*\] marker=/.test(l))).toMatch(/marker=-$/)
  }, 20000)

  it('reports the exit code and the last three lines', async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent("printf 'a\\nb\\n\\nc\\nd\\n'\nexit 3") } })
    const end = await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 1)
    expect(end).toMatchObject({ outcome: 'exited', code: 3, tail: ['b', 'c', 'd'] })
    expect(end.ms).toBeGreaterThan(0)
  }, 20000)

  it('a stopped session takes its whole process tree with it (F11)', async () => {
    const repo = await seededRepo()
    const dir = fakeScenario()
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent(`(sleep 2; echo acted > "${dir}/late") &\nexec sleep 30`) } })
    const cfg = { ...cfgOf(repo), drive: { ...cfgOf(repo).drive, sessionTimeoutMs: 300 } }
    expect((await spawnSession({ kind: 'spawn', home: repo.root }, cfg, ctx, 1)).outcome).toBe('timeout')
    await new Promise((r) => setTimeout(r, 3_000))
    expect(existsSync(join(dir, 'late'))).toBe(false)
  }, 20000)

  it('hands the child its deadline (F14)', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('echo "deadline=$WITNESS_DRIVE_DEADLINE"') }, out: (l) => lines.push(l) })
    const t0 = Date.now()
    await spawnSession({ kind: 'spawn', home: repo.root, target: 'p1' }, cfgOf(repo), ctx, 1)
    const deadline = Number(/deadline=(\d+)/.exec(lines.join('\n'))?.[1])
    expect(deadline).toBeGreaterThanOrEqual(t0 + cfgOf(repo).drive.sessionTimeoutMs)
    expect(deadline).toBeLessThan(t0 + cfgOf(repo).drive.sessionTimeoutMs + 10_000)
  }, 20000)

  it('prompts a --manual session with /witness --manual', async () => {
    const repo = await seededRepo()
    const lines: string[] = []
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('echo "prompt=$2"') }, out: (l) => lines.push(l) })
    await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 1, { manual: true })
    expect(lines.join('\n')).toContain('prompt=/witness --manual')
  }, 20000)

  it('an abort stops the session', async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, { env: { WITNESS_DRIVE_AGENT_BIN: fakeAgent('sleep 30') } })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const t0 = Date.now()
    const end = await spawnSession({ kind: 'spawn', home: repo.root }, cfgOf(repo), ctx, 1, { signal: ac.signal })
    expect(end.outcome).toBe('stopped')
    expect(Date.now() - t0).toBeLessThan(10_000)
  }, 20000)
})

describe('classifyAction under autonomy (B2)', () => {
  const root = '/repo'
  const auto = { autonomy: true }
  it('conversations stay conversations under autonomy · option blocks run headless · decisions stay decisions', () => {
    expect(classifyAction({ line: 'witness recap --file <recap.json> --ask a1', stage: 'brainstorm' }, root, auto))
      .toEqual({ kind: 'conversation', line: 'witness recap --file <recap.json> --ask a1' })
    expect(classifyAction({ line: 'witness design auth-refresh --file <html>', stage: 'design', target: 'auth-refresh' }, root, auto).kind)
      .toBe('conversation')
    expect(classifyAction({ line: 'witness recover --complete', block: ['recovery: 2 options · 1 is recommended'] }, root, auto).kind)
      .toBe('spawn')
    expect(classifyAction({
      line: 'witness write a-plan-1 --effort e --meta m.json --body b.md', stage: 'plan', target: 'a',
      block: ['choose: 2 options · 1 is recommended'],
    }, root, auto).kind).toBe('spawn')
    expect(classifyAction({ line: 'witness decide ship p1 --show', target: 'p1' }, root, auto))
      .toEqual({ kind: 'decision', gate: 'ship', target: 'p1' })
  })
  it('a look\'s gate is part of the design conversation (row 194)', () => {
    expect(classifyAction({ line: 'witness gate design billing-page', stage: 'design', target: 'billing-page' }, root, auto).kind)
      .toBe('conversation')
    expect(classifyAction({ line: 'witness gate design billing-page', target: 'billing-page' }, root).kind).toBe('conversation')
  })
})

describe('side by side (B3)', () => {
  it('runs two targets at once, most advanced first, never two on one target (Review Focus 2)', async () => {
    const repo = await startedFlows(['a', 'b', 'c'], { shipping: 'c' })
    const log = join(fakeScenario(), 'log')
    const agent = script(`echo hi\necho "$WITNESS_DRIVE start" >> "${log}"\nsleep 1\necho "$WITNESS_DRIVE end" >> "${log}"`)
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {})
    expect(out).toContain('[1 ship/c-plan-1] hi')                    // the ladder's own order (D73)
    expect(out).toContain('[2 implement/a-plan-1] hi')
    expect(out).toContain('[3 implement/b-plan-1] hi')
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines.slice(0, 2).sort()).toEqual(['a-plan-1 start', 'c-plan-1 start'])      // both ran at once
    expect(lines.indexOf('b-plan-1 start')).toBeGreaterThan(Math.min(lines.indexOf('c-plan-1 end'), lines.indexOf('a-plan-1 end')))
    for (const t of ['a-plan-1', 'b-plan-1', 'c-plan-1']) expect(lines.filter((l) => l === `${t} start`)).toHaveLength(1)
    expect(code).toBe(1)                               // all three made no progress
  }, 60000)

  it('catches a stalled target while another target journals every spawn (Review Focus 1)', async () => {
    const repo = await startedFlows(['a', 'b'])
    // a-plan-1 moves every spawn with a real act (row 206: a dispatch report is bookkeeping). A
    // session may not retry its own target (row 207), so the agent drops its marker: the retry
    // stands in for a human act landing while each session runs.
    const agent = script(`echo tick\ncase "$WITNESS_DRIVE" in a-plan-1) WITNESS_DRIVE= exec ${witnessCli()} retry a-plan-1 ;; *) exit 0 ;; esac`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 6 })
    const all = out.join('\n')
    expect(all).toContain('drive: no progress — witness test-evidence b-plan-1 --phase red --step s1')
    expect(out.filter((l) => / implement\/b-plan-1\] tick$/.test(l))).toHaveLength(1)
    expect(all).toMatch(/drive: spawn ceiling reached \(6\)/)
  }, 90000)

  // Issue #56, P2: a zero-step dispatch report is row 81's telemetry, never progress.
  it('a session that only reports a zero-step dispatch is caught after one spawn', async () => {
    const repo = await startedFlows(['a'])
    const agent = script(`echo tick\nexec ${witnessCli()} dispatch-report a-plan-1 --steps-assigned 1 --steps-completed 0`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 6 }, fakeClock(0))
    expect(out.join('\n')).toContain('drive: no progress — witness test-evidence a-plan-1 --phase red --step s1')
    expect(out.filter((l) => / implement\/a-plan-1\] tick$/.test(l))).toHaveLength(1)
  }, 60000)

  // Issue #56, P6: every implement session runs `start`, which journals a sync when the repo
  // has a remote — bookkeeping, so a session that does nothing else is caught after one spawn.
  it('a session that only re-runs start in a repo with a remote is caught after one spawn', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'a', { criteria: [{ id: 'ac-a', test: '@spec:a' }] })
    approve(repo, 'a')
    await writePlan(repo, 'a-plan-1', { parent: 'a', steps: [{ id: 's1', title: 'a', criteria: ['ac-a'] }] })
    approve(repo, 'a-plan-1')
    addOrigin(repo)
    await repo.cli(['start', 'a-plan-1'])
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const agent = script(`echo tick\nexec ${witnessCli()} start a-plan-1`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 6 }, fakeClock(0))
    expect(out.join('\n')).toContain('drive: no progress — witness test-evidence a-plan-1 --phase red --step s1')
    expect(out.filter((l) => / implement\/a-plan-1\] tick$/.test(l))).toHaveLength(1)
  }, 90000)

  it('with autonomy off a standing decision no longer ends the run', async () => {
    const repo = await gatedEffort()
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    approve(repo, 'auth-mfa')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
    approve(repo, 'auth-mfa-plan-1')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), askCtx(repo, ['', ''], out), { maxSpawns: 1 })
    expect(out.join('\n')).toMatch(/drive: decision stands/)
    expect(out.join('\n')).toMatch(/\[1 drive\/auth-mfa-plan-1\]/)       // the start ran after it
  }, 60000)
})

// a ui spec whose design gate stopped clean: under autonomy the look is the human's (A1)
// The verdict carries the gate's own current sha (with no artifact, the spec's): a stale
// verdict would make A1 route a re-run instead of keeping the look for the human.
function pendingLook(repo: TestRepo, spec: string): void {
  const doc = findById(loadCanon(repo.root), spec)!
  appendEntry(repo.root, spec, {
    v: 1, t: 'gate-run', gate: 'design', artifact: spec, round: 1, run_id: 'rd1', reviewed_sha: canonicalSha(doc.meta, doc.body),
    prompts_sha: 'p', witness: '0', model: 'm', pin: 'm', checks: [], outcome: 'stopped',
    standing: 'design always stops — the human judges the look',
    verdicts: [{ reviewer: 'design-critic', coverage: [{ anchor: `${spec} > ## Behavior`, note: 'read' }], findings: [] }],
  })
}
const uiSpec = async (repo: TestRepo, id: string) => {
  await writeSpec(repo, id, { ui: true, criteria: [{ id: `ac-${id}`, test: `@spec:${id}` }] })
  approve(repo, id)
}

describe('autonomy in the loop (B2)', () => {
  it('a kept stop holds only its target and the run moves on (Review Focus 3)', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await uiSpec(repo, 'billing-page')
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    approve(repo, 'auth-mfa')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
    approve(repo, 'auth-mfa-plan-1')
    pendingLook(repo, 'billing-page')                   // last: an uncommitted append makes a later write refuse
    const seen = join(fakeScenario(), 'seen')
    const out: string[] = []
    let asked = 0
    const ctx = { ...autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "$WITNESS_DRIVE" >> "${seen}"`) }, out), ask: async () => { asked++; return '' } }
    await driveLoop(repo.root, cfgOf(repo), ctx, {})
    expect(out.join('\n')).toContain('kept-stop: design look — ')
    expect(out).toContain('drive: waits on you — billing-page · design look')
    expect(readFileSync(seen, 'utf8')).toContain('auth-mfa-plan-1')
    expect(asked).toBe(0)
  }, 60000)

  it('a run that ends on kept stops alone exits 0', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await uiSpec(repo, 'billing-page')
    pendingLook(repo, 'billing-page')
    const out: string[] = []
    expect(await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 9') }, out), {})).toBe(0)
    expect(out.join('\n')).not.toMatch(/\[\d+ /)        // no session was spawned
  }, 60000)

  it('a plan waiting on a manual need waits without a session', async () => {
    const repo = await planReady({ needs: [{ id: 'ses-prod', manual: 'SES production access', satisfied: false }] })
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 9') }, out), {})
    expect(out).toContain('drive: waits on you — auth-refresh-plan-1 · unmet need')
    expect(out).toContain('kept-stop: unmet need — SES production access · witness satisfy auth-refresh-plan-1 --need ses-prod')
    expect(out.join('\n')).not.toMatch(/\[\d+ /)
    expect(code).toBe(0)
  }, 60000)

  it('drive settles a waiting decision itself, then hands the target to its own session', async () => {
    const repo = await gatedEffort()                    // stopped on a blocking finding while autonomy was off
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const seen = join(fakeScenario(), 'seen')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "$WITNESS_DRIVE" >> "${seen}"`) }, out), { maxSpawns: 1 })
    expect(out).toContain(`decided: decompose ${repo.effort} → revise · policy · blocking-here`)
    expect(readFileSync(seen, 'utf8').trim()).toBe(repo.effort)
  }, 60000)

  // D13. A stop whose settle the CLI routed to a re-run is spawned for the target, whose own `next`
  // prints the re-run: the session's `started` line names the re-run, not the decision it replaced.
  it('started names the re-run a settle routed (issue #64)', async () => {
    const repo = await plannedRepo({ autonomy: false })
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    expect((await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })).code).toBe(1)
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    expect((await writePlan(repo, 'auth-refresh-plan-1', {}, '## Step: s1\nRewritten.\n')).code).toBe(0)   // the verdict is stale
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 0') }, out), { maxSpawns: 1 })
    expect(out.filter((l) => / started \d\d:\d\d:\d\d · /.test(l)))
      .toEqual([expect.stringMatching(/^\[1 [^\]]*\] started \d\d:\d\d:\d\d · next: witness gate plan auth-refresh-plan-1$/)])
  }, 60000)

  it('a --manual run\'s stop waits for the human and is never settled', async () => {
    const repo = await plannedRepo()                    // A1 · autonomy on
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1', '--manual'], { env: gateEnv(scenario) })
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 9') }, out), {})
    expect(out).toContain('drive: waits on you — auth-refresh-plan-1 · decision · witness decide plan auth-refresh-plan-1 --show')
    expect(readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'human-decision')).toEqual([])
    expect(code).toBe(0)
  }, 60000)

  it('brainstorm waits for a chat under autonomy', async () => {
    const repo = await seededRepo({ noRecap: true })
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await repo.cli(['ask', 'Refresh tokens rotate before expiry'])
    const seen = join(fakeScenario(), 'seen')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "$WITNESS_DRIVE" >> "${seen}"`) }, out), { maxSpawns: 1 })
    expect(existsSync(seen)).toBe(false)
    expect(out.join('\n')).toContain('drive: conversation — witness recap --file <recap.json> --ask a1')
    expect(out.join('\n')).toContain('help: run /witness in a chat — drive takes it back when you are done')
  }, 60000)
})

// `witness next` in a process of its own: two of them are two settlers, which two
// in-process calls (one pid, one lock re-entry) could never be.
function nextChild(root: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  const repo = resolve(import.meta.dirname, '..')
  return new Promise((done) => {
    const child = spawn(join(repo, 'node_modules', '.bin', 'tsx'), [join(repo, 'src', 'bin.ts'), 'next'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout!.on('data', (d) => { stdout += String(d) })
    child.on('close', (code) => done({ code, stdout }))
  })
}

describe('one decision per stop (B3)', () => {
  it('two settlers racing one stop journal exactly one decision · the loser reads left', async () => {
    // a stopped plan gate with one blocking-here finding, taken under autonomy: the policy revises
    const repo = await plannedRepo({ autonomy: false })
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    await repo.cli(['gate', 'plan', 'auth-refresh-plan-1'], { env: gateEnv(scenario) })
    autonomyOn(repo)
    const env = hermeticEnv(gateEnv(scenario))
    const [x, y] = await Promise.all([nextChild(repo.root, env), nextChild(repo.root, env)])
    const decided = readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'human-decision')
    expect(decided).toHaveLength(1)
    expect([x, y].filter((r) => r.stdout.includes('decided:'))).toHaveLength(1)
  }, 60_000)
})

describe('caps (B5)', () => {
  it('parks a capped flow through the policy even after the author moved the tree (Review Focus 4)', async () => {
    const repo = await startedFlows(['a'])
    for (const round of [1, 2]) {
      appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'gate-run', gate: 'implement', artifact: 'a-plan-1', round,
        run_id: `ri${round}`, reviewed_sha: `s${round}`, prompts_sha: 'p', witness: '0', model: 'm', pin: 'm',
        checks: [], outcome: 'stopped' })
      appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'human-decision', gate: 'implement', artifact: 'a-plan-1', round, decision: 'revise' })
    }
    writeFileSync(join(worktreePath(repo.root, 'a-plan-1'), 'moved.txt'), 'the author kept working\n')
    patchConfig(repo, { drive: { caps: { rounds: 2 } } })
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'caps')
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('echo tick') }, out), {})
    const entries = readStream(repo.root, 'a-plan-1')
    expect(gateParked(entries, 'implement')).toBe(true)
    expect(entries.at(-1)).toMatchObject({ t: 'human-decision', decision: 'stop', selected: 'policy', rule: 'cap-rounds' })
    expect(out.join('\n')).toContain('drive: parked — a-plan-1 · drive cap: implement ran 2 rounds across budget resets · drive.caps.rounds 2')
    expect(out.join('\n')).not.toContain('] tick')       // no session past the cap
    expect(code).toBe(1)
  }, 60000)

  it('a cap never parks a flow on a gate that settled (F7)', async () => {
    const repo = await startedFlows(['a'])
    appendEntry(repo.root, 'a-plan-1', { v: 1, t: 'gate-run', gate: 'implement', artifact: 'a-plan-1', round: 1,
      run_id: 'ri1', reviewed_sha: 's1', prompts_sha: 'p', witness: '0', model: 'm', pin: 'm',
      checks: [], outcome: 'passed' })
    patchConfig(repo, { drive: { caps: { spawns: 1 } } })
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'caps')
    const agent = script(`exec ${witnessCli()} dispatch-report a-plan-1 --steps-assigned 1 --steps-completed 0`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {})
    expect(readStream(repo.root, 'a-plan-1').filter((e) => e.t === 'human-decision')).toEqual([])
    expect(gateParked(readStream(repo.root, 'a-plan-1'), 'implement')).toBe(false)
    expect(out.join('\n')).toContain('drive: capped — a-plan-1 · drive cap: 1 session(s) this run · drive.caps.spawns 1 · no open gate to park it on')
  }, 60000)

  it('a target with no gate run to park on is set aside and named', async () => {
    const repo = await startedFlows(['a'])
    patchConfig(repo, { drive: { caps: { spawns: 1 } } })
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'caps')
    const agent = script(`exec ${witnessCli()} dispatch-report a-plan-1 --steps-assigned 1 --steps-completed 0`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {})
    expect(out.join('\n')).toContain('drive: capped — a-plan-1 · drive cap: 1 session(s) this run · drive.caps.spawns 1 · no gate run to park it on')
  }, 60000)
})

describe('surviving unattended (B4)', () => {
  const LIMIT = "You've hit your session limit · resets 2pm (America/Los_Angeles)"
  const START = Date.parse('2026-10-19T19:30:00Z')

  it('waits out a usage limit and spawns again after the reset', async () => {
    const repo = await planReady()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const flag = join(fakeScenario(), 'limited')
    const agent = script(`if [ ! -f "${flag}" ]; then touch "${flag}"; echo "${LIMIT}" >&2; exit 1; fi\nexec ${witnessCli()} start auth-refresh-plan-1`)
    const clock = fakeClock(START)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 2 }, clock)
    expect(out.join('\n')).toContain(`drive: usage limit — waiting 1h31m · ${LIMIT}`)
    expect(clock.slept).toEqual([5_460_000])
    expect(existsSync(worktreePath(repo.root, 'auth-refresh-plan-1'))).toBe(true)   // the second session acted
    expect(out.join('\n')).not.toContain('drive: no progress — witness start')
  }, 60000)

  // Row 214. pi's JSON mode reports a provider error only in the stream and exits 0 (P2): read
  // from the exit code alone, the 529 would stop drive waiting.
  it('a pi provider error at exit 0 is waited out (row 182, issue #64)', async () => {
    const repo = await planReady()
    patchConfig(repo, { harness: 'pi' })
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const flag = join(fakeScenario(), 'limited')
    const body = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    const error = say({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: body } })
    const agent = script(`if [ ! -f "${flag}" ]; then touch "${flag}"; ${error}; exit 0; fi\nexec ${witnessCli()} start auth-refresh-plan-1`)
    const clock = fakeClock(START)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 2 }, clock)
    expect(out.join('\n')).toContain(`drive: usage limit — waiting 1m · ${body}`)
  }, 60000)

  it('a reset past the single wait stops the run', async () => {
    const repo = await planReady()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const late = "You've hit your session limit · resets 4am (America/Los_Angeles)"          // 15h30m away
    const clock = fakeClock(START)
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "${late}" >&2\nexit 1`) }, out), {}, clock)
    expect(out.join('\n')).toContain("drive: usage limit — resets in 15h31m — beyond drive's 6h wait")
    expect(clock.slept).toEqual([])
    expect(code).toBe(1)
  }, 60000)

  it('a limit that never lifts never waits past the total bound (Review Focus 5)', async () => {
    const repo = await planReady()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const spawned = join(fakeScenario(), 'spawned')
    const agent = script(`echo x >> "${spawned}"\necho '429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}' >&2\nexit 1`)
    const clock = fakeClock(START)
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {}, clock)
    expect(out.join('\n')).toContain("the next wait passes drive's 12h bound")
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(43_200_000)
    expect(readFileSync(spawned, 'utf8').trim().split('\n')).toHaveLength(clock.slept.length + 1)
    expect(code).toBe(1)
  }, 120000)

  it('keeps the machine awake for the run and lets go after', async () => {
    const repo = await planReady()
    const dir = fakeScenario()
    const awake = join(dir, 'awake')
    writeFileSync(awake, `#!/bin/sh\necho "$@" > "${dir}/args"\necho $$ > "${dir}/pid"\nexec sleep 30\n`, { mode: 0o755 })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), fakeCtx(repo.root, { tty: true, out: (l) => out.push(l),
      env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: awake, WITNESS_DRIVE_AGENT_BIN: script('sleep 0.5') }) }), { maxSpawns: 1 })
    expect(readFileSync(join(dir, 'args'), 'utf8').trim()).toBe(`-ims -w ${process.pid}`)
    expect(out.join('\n')).toContain(`keep-awake: ${awake} -ims -w ${process.pid} — a closed lid on battery still sleeps`)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    await expect.poll(() => { try { process.kill(pid, 0); return 'alive' } catch { return 'gone' } }, { timeout: 5_000 }).toBe('gone')
  }, 60000)

  it('says so when the keep-awake helper dies early (row 211)', async () => {
    const repo = await planReady()
    const dies = join(fakeScenario(), 'fake-awake')
    writeFileSync(dies, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), fakeCtx(repo.root, { tty: true, out: (l) => out.push(l),
      env: fixtureEnv({ WITNESS_KEEP_AWAKE_BIN: dies, WITNESS_DRIVE_AGENT_BIN: script('sleep 0.5') }) }), { maxSpawns: 1 })
    expect(out).toContain('keep-awake: lost — fake-awake exited 1 · keep the host awake yourself')
  }, 60000)
})

describe('coming back (B6)', () => {
  const recorder = () => {
    const dir = fakeScenario()
    const bin = join(dir, 'notify')
    writeFileSync(bin, `#!/bin/sh\necho "$1" >> "${dir}/got"\n`, { mode: 0o755 })
    return { bin, got: join(dir, 'got') }
  }

  // Row 203 (Q2): the item notified when it first needs the human, once, and the run's end.
  it('an autonomous run ends with the report, its new item notified once and the end once', async () => {
    const repo = await startedFlows(['a'])
    const n = recorder()
    writeLocalConfig(repo.root, { notify: n.bin })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 0') }, out), {})
    expect(out).toContain('drive: done — 0 merged · 0 wait on you · 0 parked · 1 stuck')
    await expect.poll(() => readFileSync(n.got, 'utf8').trim().split('\n').sort(), { timeout: 5000 }).toEqual([
      `witness · ${basename(repo.root)}: stuck · a-plan-1`,
      `witness drive — ${basename(repo.root)} · 0 merged · 0 wait on you · 0 parked · 1 stuck`,
    ].sort())
    expect(out).toContain(`notify: sent via ${n.bin}`)
  }, 60000)

  it('a run with autonomy off reports and sends nothing', async () => {
    const repo = await planReady()
    const n = recorder()
    writeLocalConfig(repo.root, { notify: n.bin })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), ttyCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 0'), WITNESS_KEEP_AWAKE_BIN: noopOpener() }, out), { maxSpawns: 1 })
    expect(out.some((l) => l.startsWith('drive: done — ') || l.startsWith('drive: stopped — '))).toBe(true)
    expect(existsSync(n.got)).toBe(false)
  }, 60000)
})

describe('one command (B1)', () => {
  const autonomous = async (): Promise<TestRepo> => {
    const repo = await seededRepo()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    return repo
  }
  const quiet = { WITNESS_DRIVE_AGENT_BIN: '/usr/bin/true', WITNESS_KEEP_AWAKE_BIN: '/usr/bin/true', ...NO_WAIT }

  it('names the stop the platform has (row 201)', () => {
    const h = { pid: 7, log: '/r/.witness/drive.log' }
    expect(watchLine(h, 'linux')).toBe('tail -f /r/.witness/drive.log · stop it: kill 7')
    expect(watchLine(h, 'win32')).toBe('Get-Content -LiteralPath /r/.witness/drive.log -Wait -Tail 50 -Encoding UTF8 · stop it: taskkill /PID 7 /T /F')
    // Row 214 (D12): a PowerShell word, bare only when nothing in it means anything to PowerShell.
    expect(psArg('C:\\r\\.witness\\drive.log')).toBe('C:\\r\\.witness\\drive.log')
    expect(psArg('C:\\a,b\\x')).toBe("'C:\\a,b\\x'")
    expect(psArg("C:\\o'k\\x")).toBe("'C:\\o''k\\x'")
    expect(psArg('C:\\o’k\\x')).toBe("'C:\\o’’k\\x'")
    expect(psArg('@x')).toBe("'@x'")
    expect(psArg('-x')).toBe("'-x'")
    expect(watchLine({ pid: 7 }, 'win32')).toBe('the terminal running witness drive · pid 7')
  })

  it('a session drive spawned is refused even in a terminal', async () => {
    const repo = await seededRepo()
    // `quiet` matters while this test fails: today's drive would otherwise spawn the real harness CLI
    const r = await repo.cli(['drive'], { tty: true, env: { ...quiet, WITNESS_DRIVE: 'p1' } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('drive-inside-drive')
  })

  it('under autonomy drive needs no terminal · --manual still does', async () => {
    const repo = await autonomous()
    const r = await repo.cli(['drive', '--max-spawns', '1'], { env: quiet })
    expect(r.stderr).not.toContain('drive-needs-tty')
    const manual = await repo.cli(['drive', '--manual'], { env: quiet })
    expect(manual.code).toBe(2)
    expect(manual.stderr).toContain('drive-needs-tty')
  }, 60000)

  it('one drive per repo', async () => {
    const repo = await autonomous()
    const holder = spawn('sleep', ['30'])
    writeFileSync(join(repo.root, '.witness/drive.lock'), JSON.stringify({ pid: holder.pid, log: join(repo.root, '.witness/drive.log') }))
    const r = await repo.cli(['drive'], { env: quiet })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('drive-running')
    expect(r.stderr).toContain(`stop it: kill ${holder.pid}`)
    holder.kill()
    await once(holder, 'exit')
    expect((await repo.cli(['drive', '--max-spawns', '1'], { env: quiet })).stderr).not.toContain('drive-running')
  }, 60000)

  it('--detach needs autonomy', async () => {
    const repo = await seededRepo()
    const r = await repo.cli(['drive', '--detach'], { env: quiet })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('detach-needs-autonomy')
  })

  it('--detach starts drive in the background · says where to watch · a SIGTERM stops it and its sessions', async () => {
    const repo = await autonomous()
    const dir = fakeScenario()
    const agent = join(dir, 'agent')
    writeFileSync(agent, `#!/bin/sh\nenv > "${dir}/env"\necho $$ > "${dir}/session"\nexec sleep 30\n`, { mode: 0o755 })
    // a child started with no env of its own inherits drive's process environment
    const awake = join(dir, 'awake')
    writeFileSync(awake, `#!/bin/sh\nenv > "${dir}/awake-env"\n`, { mode: 0o755 })
    const r = await repo.cli(['drive', '--detach'], { env: { WITNESS_BIN: witnessCli(), WITNESS_DRIVE_AGENT_BIN: agent, WITNESS_KEEP_AWAKE_BIN: awake } })
    expect(r.code).toBe(0)
    const pid = Number(/background · pid (\d+)/.exec(r.stdout)![1])
    // final review: --detach returns once the child holds the lock, so a chat's `wait` started
    // right after it never reads the drive as stopped
    expect(existsSync(join(repo.root, '.witness', 'drive.lock'))).toBe(true)
    const log = join(repo.root, '.witness', 'drive.log')
    expect(r.stdout).toContain(`watch: tail -f ${log} · stop it: kill ${pid}`)
    await expect.poll(() => existsSync(join(dir, 'session')), { timeout: 30_000 }).toBe(true)
    // Row 201: the marker describes the background drive alone — a session has a console
    expect(readFileSync(join(dir, 'env'), 'utf8')).toContain('WITNESS_DRIVE=')
    expect(readFileSync(join(dir, 'env'), 'utf8')).not.toContain('WITNESS_NO_CONSOLE')
    await expect.poll(() => existsSync(join(dir, 'awake-env')), { timeout: 15_000 }).toBe(true)
    expect(readFileSync(join(dir, 'awake-env'), 'utf8')).toContain('WITNESS_DRIVE_LOG=')
    expect(readFileSync(join(dir, 'awake-env'), 'utf8')).not.toContain('WITNESS_NO_CONSOLE')
    process.kill(pid, 'SIGTERM')
    await expect.poll(() => readFileSync(log, 'utf8'), { timeout: 30_000 }).toContain('drive: stopped — signal SIGTERM')
    const session = Number(readFileSync(join(dir, 'session'), 'utf8'))
    await expect.poll(() => { try { process.kill(session, 0); return 'alive' } catch { return 'gone' } }, { timeout: 15_000 }).toBe('gone')
    // released after the report and the notification, which print after the stopped line
    await expect.poll(() => existsSync(join(repo.root, '.witness', 'drive.lock')), { timeout: 15_000 }).toBe(false)
  }, 90000)

  it('--detach never writes through a symlinked log', async () => {
    const repo = await autonomous()
    const outside = join(fakeScenario(), 'rc')
    writeFileSync(outside, 'export SAFE=1\n')
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    symlinkSync(outside, join(repo.root, '.witness', 'drive.log'))
    const r = await repo.cli(['drive', '--detach'], { env: quiet })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('drive-log-unsafe')
    expect(readFileSync(outside, 'utf8')).toBe('export SAFE=1\n')
  })

  it('--ask is gone', async () => {
    const repo = await autonomous()
    const r = await repo.cli(['drive', '--ask', 'x'], { env: quiet })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('bad-arguments')
  })
})

// Row 191 §4.9. `witness drive` typed in a chat session's shell inherits that session's reading
// and session variable. Through the verb, so `main` has opened the chat session's stamp first.
describe('drive is a scheduler, not a session (row 191 §4.9)', () => {
  const chat = measuredEnv('chat-1', 170000, 1000000)
  const decisionOf = (repo: TestRepo) =>
    readStream(repo.root, repo.effort).filter((e) => e.t === 'human-decision').at(-1)
  // Each journal line that carries a session stamp, as `stream: kind`. Nothing the setup wrote ran
  // in a session, so after the run none may: whatever drive journals, it journals as no session.
  const stamped = (repo: TestRepo): string[] => {
    const dir = join(repo.root, '.witness', 'journal')
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) =>
      readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => 'ctx' in e)
        .map((e) => `${f}: ${String(e.t)}`))
  }

  it('a decision drive settles is stamped by no session · the session it spawns inherits none', async () => {
    const repo = await gatedEffort()                    // stopped on a blocking finding while autonomy was off
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const seen = join(fakeScenario(), 'seen')
    const agent = script(`echo "\${WITNESS_CONTEXT-unset} \${CLAUDE_CODE_SESSION_ID-unset}" >> "${seen}"`)
    // CI cleared, as gateEnv does: settling never runs under CI (settle.ts), and a CI runner
    // exports CI=true into the process this suite spreads into every CLI's env.
    const r = await repo.cli(['drive', '--max-spawns', '1'],
      { env: { ...chat, CI: '', WITNESS_DRIVE_AGENT_BIN: agent, WITNESS_KEEP_AWAKE_BIN: '/usr/bin/true' } })
    expect(r.stdout).toContain(`decided: decompose ${repo.effort} → revise · policy · blocking-here`)
    expect(decisionOf(repo)).toMatchObject({ decision: 'revise', selected: 'policy' })
    expect(decisionOf(repo)).not.toHaveProperty('ctx')
    expect(stamped(repo)).toEqual([])
    expect(readFileSync(seen, 'utf8').trim()).toBe('unset unset')
  }, 60000)

  it('a decision taken at drive\'s prompt is stamped by no session', async () => {
    const repo = await gatedEffort()
    await repo.cli(['drive', '--max-spawns', '1'],
      { answers: ['1'], env: { ...chat, WITNESS_DRIVE_AGENT_BIN: idleAgent(), WITNESS_KEEP_AWAKE_BIN: '/usr/bin/true' } })
    expect(decisionOf(repo)).toMatchObject({ decision: 'revise' })
    expect(decisionOf(repo)).not.toHaveProperty('ctx')
    expect(stamped(repo)).toEqual([])
  }, 60000)
})

// Final review I3 (behavior attack, probe p10). s1's behavior predates the plan, so the session
// drive spawns for it re-runs a vacuous verify-red: one vacuous red, and a green that confirms the
// restore and journals nothing. A vacuous red moves nothing, so the target is set aside after that
// one session; counted, it read as progress and drive respawned it until drive.caps.spawns.
describe('a vacuous red is no progress (row 191)', () => {
  it('sets aside a target whose session only re-runs a vacuous verify-red', async () => {
    const { repo, wt, planId } = await behaviorOnMain({ drive: { caps: { spawns: 4 } } })
    const red = await repo.cli(['test-evidence', planId, '--phase', 'red', '--step', 's1'], { cwd: wt, env: fixtureEnv() })
    expect(red.code).toBe(1)
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const agent = script(`echo tick\n${witnessCli()} verify-red ${planId} --step s1\nexit 0`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {})
    expect(out.filter((l) => / tick$/.test(l))).toHaveLength(1)
    expect(out).toContain(`[1 implement/${planId}] verify-red: red NOT observed · green confirmed`)
    expect(out).toContain(`drive: no progress — witness verify-red ${planId} --step s1`)
    expect(readStream(repo.root, planId).filter((e) => e.t === 'test-evidence').map((e) => e.phase)).toEqual(['red', 'red'])
  }, 120000)
})

// Final review F4. A crashed transaction no session resolves answered every fill with the same
// target-less recovery line, never judged and never capped: drive spent its whole ceiling.
describe('a wedged transaction (B3)', () => {
  it('is set aside after one empty session and named in the report', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    mkdirSync(join(repo.root, '.witness'), { recursive: true })
    writeFileSync(join(repo.root, '.witness', 'txn.json'), JSON.stringify({ op: 'write(a)', files: [] }))
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('echo tick') }, out), { maxSpawns: 6 })
    expect(out.filter((l) => /\] tick$/.test(l))).toHaveLength(1)
    expect(out).toContain('wait: pending transaction · write(a)')
    expect(out.some((l) => l.startsWith('  run: witness recover'))).toBe(true)
    expect(code).toBe(1)
  }, 60_000)
})

// Final review F2. The plan queue's lane is keyed by the SPEC, and its session writes the plan
// and keeps working on it (witness-plan gates it in the same session): the plan's own id must
// not read as a free target meanwhile.
describe('one session per flow (Review Focus 2)', () => {
  it('a plan-writing lane and its new plan never run at once', async () => {
    const repo = await startedFlows(['a'])
    await writeSpec(repo, 'x', { criteria: [{ id: 'ac-x', test: '@spec:x' }] })
    approve(repo, 'x')
    const dir = fakeScenario()
    writeFileSync(join(dir, 'm.json'), JSON.stringify({ ...PLAN_META, parent: 'x', steps: [{ id: 's1', title: 'x', criteria: ['ac-x'] }] }))
    writeFileSync(join(dir, 'b.md'), PLAN_BODY)
    const log = join(dir, 'log')
    const agent = script(`echo "start $WITNESS_DRIVE" >> "${log}"
case "$WITNESS_DRIVE" in
  x) cd "${repo.root}" && ${witnessCli()} write x-plan-1 --effort ${repo.effort} --meta "${dir}/m.json" --body "${dir}/b.md" >/dev/null 2>&1; sleep 6 ;;
  *) sleep 0.5 ;;
esac
echo "end $WITNESS_DRIVE" >> "${log}"`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 6 })
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    const planStart = lines.indexOf('start x-plan-1')
    expect(planStart === -1 || planStart > lines.indexOf('end x')).toBe(true)
  }, 120_000)
})

// Final review F5. Progress keyed on the whole effort stream: a sibling's write anywhere in
// the shared effort reset a stalled flow's key, and a refused write counted as progress.
describe('progress is the target\'s own (Review Focus 1)', () => {
  it('a stalled flow is set aside while a sibling writes to their shared effort', async () => {
    const repo = await startedFlows(['a', 'b'])
    const dir = fakeScenario()
    writeFileSync(join(dir, 'm.json'), JSON.stringify({ ...SPEC_META, criteria: [] }))
    writeFileSync(join(dir, 'b.md'), SPEC_BODY)
    const agent = script(`echo tick
case "$WITNESS_DRIVE" in
  a-plan-1)
    n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${dir}/n"
    cd "${repo.root}" && ${witnessCli()} write extra-$n --effort ${repo.effort} --meta "${dir}/m.json" --body "${dir}/b.md" >/dev/null 2>&1 ;;
  *) sleep 2 ;;
esac`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 8 })
    expect(out.filter((l) => / implement\/b-plan-1\] tick$/.test(l))).toHaveLength(1)
    expect(out.filter((l) => / implement\/a-plan-1\] tick$/.test(l))).toHaveLength(1)   // its refused write is no progress
  }, 120_000)
})

// Final review F6. The settle pass's arbiter met a usage limit and waited inside the reviewer:
// silently (the pass's ctx is quiet), outside drive's 12 h total, deaf to a signal, and even
// while drive itself was paused. The pass now never waits: a limit there is drive's own pause.
describe('a limit in the settle pass is drive\'s pause (B4)', () => {
  it('prints and counts the wait · then the arbiter is asked again', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: 'auth-refresh > ## Behavior', note: 'read' }], findings: [] })
    await repo.cli(['gate', 'decompose', '--effort', repo.effort], { env: gateEnv(scenario) })   // autonomy off: the stop waits
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    putVerdict(scenario, { choice: 1, reason: 'one slice covers the recap' }, 'arbiter')
    const used = existsSync(join(scenario, 'claude-calls')) ? readdirSync(join(scenario, 'claude-calls')).length : 0
    writeFileSync(join(scenario, 'claude-error'), "You've hit your session limit · resets in 0m")
    writeFileSync(join(scenario, 'claude-error-calls'), String(used + 1))   // one call: the arbiter asks its pin alone (row 212)
    const clock = fakeClock(Date.parse('2026-10-19T19:30:00Z'))
    const out: string[] = []
    const t0 = Date.now()
    await driveLoop(repo.root, cfgOf(repo), fakeCtx(repo.root, {
      env: gateEnv(scenario, { WITNESS_DRIVE_AGENT_BIN: script('echo tick'), WITNESS_KEEP_AWAKE_BIN: noopOpener() }), out: (l) => out.push(l),
    }), { maxSpawns: 1 }, clock)
    expect(out.join('\n')).toContain("drive: usage limit — waiting 1m · You've hit your session limit · resets in 0m")
    expect(clock.slept).toContain(60_000)
    expect(Date.now() - t0).toBeLessThan(30_000)                                  // nothing slept for real
    expect(readStream(repo.root, repo.effort).filter((e) => e.t === 'human-decision').at(-1)).toMatchObject({ selected: 'arbiter' })
  }, 120_000)
})

// Final review F9. drive read the config once: a human who committed autonomy: off mid-run
// still had their stops settled by the policy until the run ended.
describe('autonomy turned off mid-run (B2)', () => {
  it('drive stops deciding and starts nothing more', async () => {
    const repo = await plannedRepo()                                     // A1 · autonomy on
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const scenario = fakeScenario()
    putVerdict(scenario, PLAN_BLOCKING)
    const agent = script(`cd "${repo.root}"
perl -pi -e 's/^autonomy: on\\b/autonomy: off/' witness.config.yaml && git add witness.config.yaml && git commit -qm 'autonomy: off'
${witnessCli()} gate plan auth-refresh-plan-1 >/dev/null 2>&1
echo gated`)
    const out: string[] = []
    const code = await driveLoop(repo.root, cfgOf(repo), fakeCtx(repo.root, {
      env: gateEnv(scenario, { WITNESS_KEEP_AWAKE_BIN: noopOpener(), WITNESS_DRIVE_AGENT_BIN: agent }), out: (l) => out.push(l),
    }), { maxSpawns: 3 })
    expect(readStream(repo.root, 'auth-refresh-plan-1').filter((e) => e.t === 'human-decision')).toEqual([])
    expect(out).toContain('drive: autonomy is off now — no new session starts')
    expect(out.filter((l) => l.endsWith('] gated'))).toHaveLength(1)
    expect(code).toBe(1)
  }, 120_000)
})

// Final review F10. Any child line containing "merge PR" set the flow aside as a merge for the
// human and the report handed out `gh pr merge <n>` — for a flow with no PR at all.
describe('the merge sniff (B2)', () => {
  it('agent text that mentions a merge is not one', async () => {
    const repo = await startedFlows(['a'])
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('echo "next the ship stage will merge PR #7 once CI is green"') }, out), {})
    expect(out.join('\n')).not.toContain('drive: merge')
    expect(out.join('\n')).not.toContain('gh pr merge')
  }, 60_000)
  it('the CLI\'s own merge line on a flow with a PR still sets it aside', async () => {
    const repo = await startedFlows(['a'], { shipping: 'a' })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('echo "ship: merge PR #7 on GitHub when ready — the lazy stamp flips plan → done · spec → live"') }, out), {})
    expect(out).toContain('wait: merge · a-plan-1 · PR #7')
    expect(out).toContain('  run: gh pr merge 7')
  }, 60_000)
  // Row 214. `mergeOwnPr` prints its line inside the agent's bash tool, so in production it is a
  // tool's output — which print mode never wrote unless the agent quoted it.
  it('the CLI\'s merge line inside a tool\'s output sets the flow aside (issue #64)', async () => {
    const repo = await startedFlows(['a'], { shipping: 'a' })
    patchConfig(repo, { harness: 'pi' })
    const agent = script(say({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: MERGE }] }, isError: false }))
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {})
    expect(out).toContain('wait: merge · a-plan-1 · PR #7')
    expect(out).toContain('  run: gh pr merge 7')
    expect(out.some((l) => /^\[\d+ [^\]]*\] ship: /.test(l))).toBe(false)
  }, 60_000)
})

// Row 196. A target set aside for a human (a kept stop, a decision, a conversation) is drive's
// again once its progress key moves: P1 inverted.
describe('drive takes back what a human moved (row 196)', () => {
  it('a need satisfied mid-run is started in the same run', async () => {
    const repo = await planReady({ needs: [{ id: 'ses-prod', manual: 'SES production access', satisfied: false }] })
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    approve(repo, 'auth-mfa')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
    approve(repo, 'auth-mfa-plan-1')
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const seen = join(fakeScenario(), 'seen')
    const agent = script([
      `echo "$WITNESS_DRIVE" >> "${seen}"`,
      `if [ "$WITNESS_DRIVE" = auth-mfa-plan-1 ]; then ${witnessCli()} satisfy auth-refresh-plan-1 --need ses-prod; fi`,
    ].join('\n'))
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), {})
    expect(readFileSync(seen, 'utf8')).toContain('auth-refresh-plan-1')
    expect(out).toContain('drive: taken back — auth-refresh-plan-1 · witness start auth-refresh-plan-1')
  }, 120000)

  it('a target taken back to a new human stop waits again without a session', async () => {
    const repo = await planReady()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await repo.cli(['ask', 'first'])
    const seen = join(fakeScenario(), 'seen')
    const agent = script([`echo "$WITNESS_DRIVE" >> "${seen}"`, `${witnessCli()} ask "second"`].join('\n'))
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 1 })
    expect(readFileSync(seen, 'utf8').split('\n')).not.toContain('-')
    expect(out).toContain('drive: taken back — untargeted work · witness recap --file <recap.json> --ask a1')
    expect(out.filter((l) => l.startsWith('wait: conversation'))).toEqual(['wait: conversation · brainstorm · ask a1'])
    expect(out.join('\n')).not.toMatch(/^stuck:/m)
  }, 120000)

  it('an empty queue is reported, not waited on', async () => {
    const repo = await seededRepo({ noRecap: true })
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script('exit 9') }, out), {})
    expect(out).toContain('nothing queued — /witness <what to build> in a chat')
    expect(out.join('\n')).toContain('drive: done — 0 merged · 0 wait on you')
  }, 60000)

  it('an opened look waits for its chat, never a session', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await uiSpec(repo, 'billing-page')
    await writeDesign(repo, 'billing-page')
    await witnessDesign(repo, 'billing-page')
    const seen = join(fakeScenario(), 'seen')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "$WITNESS_DRIVE" >> "${seen}"`) }, out), {})
    expect(existsSync(seen)).toBe(false)
    expect(out).toContain('drive: conversation — witness gate design billing-page')
  }, 60000)

  it('a stopping run still names the conversation it holds', async () => {
    const repo = await planReady()
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    approve(repo, 'auth-mfa')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
    approve(repo, 'auth-mfa-plan-1')
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await repo.cli(['ask', 'first'])
    const agent = script(`${witnessCli()} ask "second"`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 1 })
    expect(out.join('\n')).toContain('drive: spawn ceiling reached (1)')
    expect(out).toContain('wait: conversation · brainstorm · ask a1')
  }, 120000)

  it('a pending transaction releases nothing', async () => {
    const repo = await planReady({ needs: [{ id: 'ses-prod', manual: 'SES production access', satisfied: false }] })
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    approve(repo, 'auth-mfa')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
    approve(repo, 'auth-mfa-plan-1')
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    const agent = script(`if [ "$WITNESS_DRIVE" = auth-mfa-plan-1 ]; then WITNESS_CRASH_AFTER=journal-append ${witnessCli()} ask crashed; fi`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 3 })
    expect(out).toContain('drive: waits on you — auth-refresh-plan-1 · unmet need')
    expect(out.filter((l) => l.startsWith('drive: taken back — auth-refresh-plan-1'))).toEqual([])
  }, 120000)

  it('a re-authored look whose stop the settle pass routes to a re-run stays the chat\'s', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await uiSpec(repo, 'billing-page')
    await writeDesign(repo, 'billing-page')
    await witnessDesign(repo, 'billing-page')
    const scenario = fakeScenario()
    putVerdict(scenario, { coverage: [{ anchor: 'design#save-bar', note: 'r' }, { anchor: 'billing-page > ## Behavior', note: 'r' }], findings: [] })
    await repo.cli(['gate', 'design', 'billing-page'], { env: gateEnv(scenario) })   // clean → the kept stop
    await writeDesign(repo, 'billing-page', DESIGN_HTML.replace('New service', 'New booking'))   // re-authored · the verdict is stale
    const seen = join(fakeScenario(), 'seen')
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: script(`echo "$WITNESS_DRIVE" >> "${seen}"`) }, out), {})
    expect(existsSync(seen) ? readFileSync(seen, 'utf8') : '').not.toContain('billing-page')
  }, 60000)

  it('a stopping run reports what it holds as it is now, not as it was set aside', async () => {
    const repo = await planReady()
    await writeSpec(repo, 'auth-mfa', { criteria: [{ id: 'ac-mfa', test: '@spec:auth-mfa' }] })
    approve(repo, 'auth-mfa')
    await writePlan(repo, 'auth-mfa-plan-1', { parent: 'auth-mfa', steps: [{ id: 's1', title: 'mfa', criteria: ['ac-mfa'] }] })
    approve(repo, 'auth-mfa-plan-1')
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    await repo.cli(['ask', 'dark mode'])
    const recap = join(fakeScenario(), 'recap.json')
    writeFileSync(recap, JSON.stringify({ effort: 'dark-mode', class: 'feature', goals: [{ id: 'g1', text: 'dark mode' }] }))
    const agent = script(`${witnessCli()} recap --file "${recap}" --ask a1`)   // the human's chat answers a1 meanwhile
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent }, out), { maxSpawns: 1 })
    expect(out.join('\n')).toContain('drive: spawn ceiling reached (1)')
    expect(readStream(repo.root, 'dark-mode').some((e) => e.t === 'recap')).toBe(true)
    expect(out.filter((l) => l.startsWith('wait: conversation'))).toEqual([])
  }, 120000)
})

// Row 205 (issue #56, P1). A step whose config command this machine does not trust is the
// human's: drive spends no session on it, sets it aside as a trust grant, and the report names
// each command with the grant that takes it.
describe('a trust grant waits on the human without a session (D205)', () => {
  async function untrustedFlow(): Promise<TestRepo> {
    const repo = await seededRepo()
    patchConfig(repo, { criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' }, ship: { test: 'pnpm test', lint: 'pnpm lint' } })
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'full-suite')
    await writeSpec(repo, 'ingest', { criteria: [{ id: 'ac-i', test: '@spec:ingest' }] })
    approve(repo, 'ingest')
    await writePlan(repo, 'ingest-plan-1', { parent: 'ingest', steps: [{ id: 's1', title: 'ingest', criteria: ['ac-i'] }] })
    approve(repo, 'ingest-plan-1')
    await repo.cli(['start', 'ingest-plan-1'])
    autonomyOn(repo)
    writeLocalConfig(repo.root, { notify: noopOpener() })
    return repo
  }

  it('spawns nothing for a trust-blocked step and reports the grant (P1)', async () => {
    const repo = await untrustedFlow()
    const marker = join(fakeScenario(), 'spawned')
    const agent = script(`touch ${marker}`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent, WITNESS_TRUST_CMDS: '' }, out), {}, fakeClock(0))
    expect(existsSync(marker)).toBe(false)
    expect(out).toContain('drive: waits on you — ingest-plan-1 · trust grant')
    expect(out).toContain('wait: trust grant · ingest-plan-1 · pnpm test (ship.test)')
    expect(out).toContain("  run: witness trust ingest-plan-1 --cmd 'pnpm test'")
    expect(out.join('\n')).not.toContain('<gate>')
  }, 60000)

  it('a drive started with WITNESS_TRUST_CMDS=1 spawns the step (Review Focus 1)', async () => {
    const repo = await untrustedFlow()
    const marker = join(fakeScenario(), 'spawned')
    const agent = script(`touch ${marker}`)
    const out: string[] = []
    await driveLoop(repo.root, cfgOf(repo), autoCtx(repo, { WITNESS_DRIVE_AGENT_BIN: agent, WITNESS_TRUST_CMDS: '1' }, out), { maxSpawns: 1 }, fakeClock(0))
    expect(existsSync(marker)).toBe(true)
    expect(out.join('\n')).not.toContain('trust grant ·')
  }, 60000)

  it('classifyAction reads a trust act as kept', () => {
    expect(classifyAction({ line: 'witness trust p1', target: 'p1', trust: [{ cmd: 'pnpm test', source: 'ship.test' }] }, '/r'))
      .toEqual({ kind: 'kept', stop: 'trust-grant', line: 'witness trust p1' })
    expect(classifyAction({ line: 'witness trust p1', target: 'p1', trust: [{ cmd: 'pnpm test', source: 'ship.test' }] }, '/r', { autonomy: true }))
      .toEqual({ kind: 'kept', stop: 'trust-grant', line: 'witness trust p1' })
  })
})
