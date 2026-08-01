import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpRepo } from './helpers.js'

describe('witness init --agent', () => {
  it('scaffolds and installs the pi payload set in one trailer commit', async () => {
    const repo = tmpRepo()
    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('agent: pi')
    expect(repo.read('.pi/prompts/witness.md')).toContain('# /witness — the engine')
    expect(repo.read('.pi/extensions/witness.ts')).toContain('canonGuard')
    expect(repo.read('.pi/extensions/canon-guard.mjs')).toContain('export function canonGuard')
    expect(repo.read('.pi/extensions/session-dashboard.sh')).toContain('witness.config.yaml')
    expect(repo.read('witness.config.yaml')).toContain('harness: pi')
    // committed, not just written: pi resolves .pi/extensions cwd-relative with no
    // upward walk, so only a COMMITTED payload reaches .witness/worktrees/<plan-id>
    expect(repo.git('status', '--porcelain')).toBe('')
    expect(repo.git('log', '-1', '--format=%(trailers:key=Witness-State,valueonly=true)')).toBe('1')
  })

  it('installs the claude-code payload set with project-dir hook wiring', async () => {
    const repo = tmpRepo()
    expect((await repo.cli(['init', '--agent', 'claude-code'])).code).toBe(0)
    expect(repo.read('.claude/commands/witness.md')).toContain('witness next')
    expect(repo.read('.claude/hooks/guard-state.mjs')).toContain('canon-guard.mjs')
    expect(repo.read('.claude/hooks/canon-guard.mjs')).toContain('canonGuard')
    const settings = JSON.parse(repo.read('.claude/settings.json'))
    expect(settings.hooks.PreToolUse.map((e: { matcher: string }) => e.matcher)).toEqual(['Edit|Write|MultiEdit', 'Bash'])
    for (const e of settings.hooks.PreToolUse) {
      expect(e.hooks[0].command).toContain('$CLAUDE_PROJECT_DIR/.claude/hooks/guard-state.mjs')
    }
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('session-dashboard.sh')
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  it('adds a second harness without touching config, principles or the journal', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const config = repo.read('witness.config.yaml')
    const principles = repo.git('rev-parse', 'HEAD:specs/principles.md')

    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(0)
    expect(repo.read('.claude/commands/witness.md')).toContain('witness next')
    expect(repo.read('witness.config.yaml')).toBe(config)          // harness: stays pi
    expect(repo.git('rev-parse', 'HEAD:specs/principles.md')).toBe(principles)
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  it('is idempotent — a repeat run over identical files writes nothing and makes no commit', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const head = repo.git('rev-parse', 'HEAD')
    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('agent: pi')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
  })

  // Revision 1: sync, not install-once. The engine file's `npx -y @popovych.co/witness@<v>`
  // pin is the single point deciding which CLI the whole pipeline runs; install-once left
  // every repo pinned to whatever version first touched it, forever, silently.
  it('restamps a payload whose only difference is the version pin', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/prompts/witness.md'
    repo.write(rel, repo.read(rel).replace(/@popovych\.co\/witness@[\d.]+/g, '@popovych.co/witness@0.0.1'))
    repo.git('add', rel); repo.git('commit', '-m', 'simulate an upgrade gap')

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(0)
    expect(repo.read(rel)).not.toContain('@popovych.co/witness@0.0.1')
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  // Found by Task 9's manual pass: restamping a pin edit that was never committed
  // restores the file to exactly its HEAD content, so the commit has nothing to
  // commit — `git commit --only` exits non-zero and threw out of gitio. Nothing to
  // commit is the same legal silent success as nothing to write.
  it('restamps an uncommitted pin edit without attempting an empty commit', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const head = repo.git('rev-parse', 'HEAD')
    const rel = '.pi/prompts/witness.md'
    repo.write(rel, repo.read(rel).replace(/@popovych\.co\/witness@[\d.]+/g, '@popovych.co/witness@0.0.1'))

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(0)
    expect(res.stdout).not.toContain('unexpected-error')
    expect(repo.read(rel)).not.toContain('@popovych.co/witness@0.0.1')
    expect(repo.git('status', '--porcelain')).toBe('')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
  })

  it('leaves a human-edited payload alone and reports it', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/prompts/witness.md'
    repo.write(rel, `${repo.read(rel)}\n<!-- my own note -->\n`)
    repo.git('add', rel); repo.git('commit', '-m', 'local edit')
    const head = repo.git('rev-parse', 'HEAD')

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('payload-modified')
    expect(res.stdout).toContain(rel)
    expect(repo.read(rel)).toContain('<!-- my own note -->')
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)
  })

  // Revision 6: pre-flight, so a refusal leaves nothing half-installed. Committing is
  // load-bearing — a worktree is a branch checkout — so an ignored target is a refusal,
  // never a `git add -f` and never a write-without-commit (a silently absent guard).
  it('refuses before writing anything when a payload target is gitignored', async () => {
    const repo = tmpRepo()
    repo.write('.gitignore', '.claude/\n')
    repo.git('add', '.gitignore'); repo.git('commit', '-m', 'ignore .claude')
    const res = await repo.cli(['init', '--agent', 'claude-code'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('payload-ignored')
    expect(existsSync(join(repo.root, '.claude', 'commands', 'witness.md'))).toBe(false)
    expect(existsSync(join(repo.root, 'witness.config.yaml'))).toBe(false)
  })

  // Revision 6: pi loads project prompts AND extensions only after the project is
  // trusted. Declining leaves no /witness (self-revealing) and no guard (silent).
  it('notes the trust requirement on pi', async () => {
    const repo = tmpRepo()
    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.stdout).toContain('trusted')
  })

  it('merges into an existing .claude/settings.json without clobbering user keys', async () => {
    const repo = tmpRepo()
    repo.write('.claude/settings.json', JSON.stringify({
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }, null, 2))
    expect((await repo.cli(['init', '--agent', 'claude-code'])).code).toBe(0)
    const settings = JSON.parse(repo.read('.claude/settings.json'))
    expect(settings.model).toBe('opus')
    const commands = settings.hooks.PreToolUse.flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks.map((h) => h.command))
    expect(commands).toContain('echo mine')
    expect(commands.some((c: string) => c.includes('guard-state.mjs'))).toBe(true)
  })

  it('resolves --agent auto from the detection rungs', async () => {
    const repo = tmpRepo()
    const res = await repo.cli(['init', '--agent', 'auto'], { env: { PI_CODING_AGENT: 'true' } })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('agent: pi')
    expect(repo.read('witness.config.yaml')).toContain('harness: pi')
  })

  it('refuses an unknown agent, listing the valid ones', async () => {
    const repo = tmpRepo()
    const res = await repo.cli(['init', '--agent', 'pikachu'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown-harness')
    expect(res.stderr).toContain('claude-code | pi')
  })
})
