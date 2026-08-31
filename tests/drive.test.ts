import { describe, expect, it } from 'vitest'
import { classifyAction } from '../src/drive.js'
import { seededRepo } from './helpers.js'

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
