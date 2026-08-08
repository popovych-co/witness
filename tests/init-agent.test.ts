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

  // Row 102: the rule is content, not pins. This case (an older pin, nothing else
  // changed) is the one the old rule DID handle; it must keep working, because the
  // engine file's pin is the single point deciding which CLI the whole pipeline runs.
  it('upgrades a payload behind the shipped content', async () => {
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

  // Row 102: the guard that used to protect an edited payload is gone, so the write
  // clobbers. That is only safe if the previous content is recoverable, and it is
  // recoverable only from git — so an uncommitted payload edit refuses the WHOLE run
  // rather than being silently swallowed by an overwrite.
  it('refuses the whole run when a payload path carries an uncommitted change', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/prompts/witness.md'
    const head = repo.git('rev-parse', 'HEAD')
    repo.write(rel, `${repo.read(rel)}\n<!-- uncommitted -->\n`)

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('payload-dirty')
    expect(res.stderr).toContain(rel)
    expect(repo.read(rel)).toContain('<!-- uncommitted -->')   // nothing written
    expect(repo.git('rev-parse', 'HEAD')).toBe(head)           // nothing committed
  })

  // --untracked-files=all, not the default: a payload file that exists but was never
  // committed is exactly the state the guard must catch, and the default `normal` mode
  // reports an untracked FILE but the pathspec makes that reachable only with `all`.
  it('counts an untracked-but-present payload file as dirty', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/extensions/canon-guard.mjs'
    repo.git('rm', '--cached', rel)
    repo.git('commit', '-m', 'untrack the guard')

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('payload-dirty')
    expect(res.stderr).toContain(rel)
  })

  // The write is ORDERED. Without this, running an old CLI in a repo someone else
  // upgraded silently REVERTS the payload — and the engine file's pin decides which CLI
  // the whole pipeline runs, so the revert re-freezes the repo one version further back.
  it('refuses to revert a payload installed by a newer CLI', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/prompts/witness.md'
    repo.write(rel, repo.read(rel).replace(/@popovych\.co\/witness@[\d.]+/g, '@popovych.co/witness@99.0.0'))
    repo.git('add', rel); repo.git('commit', '-m', 'installed by a newer CLI')

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('cli-behind-payload')
    expect(repo.read(rel)).toContain('@popovych.co/witness@99.0.0')
  })

  // Row 102: the payload is witness's artifact. `pinOnlyDifference` could not tell an
  // untouched-but-outdated file from an edited one — nothing recorded what witness last
  // wrote — so one release read as "modified" declined every later one, permanently and
  // compoundingly, and the ${WITNESS_BIN:-npx …@<v>} pin froze with the file. The
  // asymmetry decides it: a clobbered edit is named here and sits one `git revert` away,
  // because row 87 already commits the payload; a frozen pin is invisible until someone
  // diffs a tarball.
  it('overwrites a human-edited payload, reports it, and leaves it one revert away', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/prompts/witness.md'
    repo.write(rel, `${repo.read(rel)}\n<!-- my own note -->\n`)
    repo.git('add', rel); repo.git('commit', '-m', 'local edit')
    const edited = repo.git('rev-parse', 'HEAD')

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('payload-overwritten')
    expect(res.stdout).toContain(rel)
    expect(repo.read(rel)).not.toContain('<!-- my own note -->')
    expect(repo.git('status', '--porcelain')).toBe('')
    // named AND recoverable: the edit is the parent commit's content, not lost bytes
    expect(repo.git('show', `${edited}:${rel}`)).toContain('<!-- my own note -->')
  })

  // The half the pin probe could never see: three of the five payload files carry no
  // pin at all (canon-guard.mjs, guard-state.mjs, witness-pi.ts), so a guard bugfix was
  // undeliverable AND undetectable on every existing repo. Content compare covers all five.
  it('upgrades a pin-less payload file, which the pin rule could never reach', async () => {
    const repo = tmpRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/extensions/canon-guard.mjs'
    repo.write(rel, '// stale build\n')
    repo.git('add', rel); repo.git('commit', '-m', 'simulate a repo frozen before a guard bugfix')

    const res = await repo.cli(['init', '--agent', 'pi'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('payload-overwritten')
    expect(repo.read(rel)).toContain('export function canonGuard')
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
