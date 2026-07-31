import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STAGE_SKILLS } from '../src/harness.js'
import { appendEntry } from '../src/journal.js'
import { SPEC_META, fakeScenario, gateEnv, seededRepo, writeSpec } from './helpers.js'

describe('specflow check', () => {
  it('passes a clean freshly-written canon', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('checks:')
  })

  it('flags hand-edited commits missing the trailer', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('specs/auth-refresh.md', repo.read('specs/auth-refresh.md') + '\nsneaky edit\n')
    repo.git('add', 'specs/auth-refresh.md')
    repo.git('commit', '-m', 'hand edit')
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('untrailered-commit')
  })

  it('flags uncommitted hand edits on state paths', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('specs/auth-refresh.md', repo.read('specs/auth-refresh.md') + 'dirt')
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('hand-edit-in-progress')
  })

  it('flags duplicate ids, unknown deps, and unresolvable pins', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('specs/dupe.md', repo.read('specs/auth-refresh.md'))
    repo.git('add', 'specs/dupe.md')
    repo.git('commit', '-m', 'dupe', '-m', 'Specflow-State: 1')
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('duplicate-id')
  })

  it('reports unmet needs as warnings, not errors', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, needs: [{ env: 'NOT_SET_ANYWHERE' }] })
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('need-unmet')
  })

  it('warns on orphan artifact journals', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    appendEntry(repo.root, 'ghost-artifact', { t: 'drift-check', artifact: 'ghost-artifact', criteria: [] })
    repo.git('add', '.specflow/journal/ghost-artifact.jsonl')
    repo.git('commit', '-m', 'orphan', '-m', 'Specflow-State: 1')
    const res = await repo.cli(['check'], { env: { SPECFLOW_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('orphan-journal')
  })

  it('flags a configured docs path that does not exist', async () => {
    const repo = await seededRepo()
    repo.write('specflow.config.yaml',
      repo.read('specflow.config.yaml') + 'docs:\n  conventions: [docs/conventions.md]\n')
    repo.git('add', 'specflow.config.yaml')
    repo.git('commit', '-m', 'register a doc that does not exist')
    const res = await repo.cli(['check'])
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('doc-missing')
    expect(res.stdout).toContain('docs/conventions.md')
    // restore the file → the finding clears
    repo.write('docs/conventions.md', 'rules')
    repo.git('add', 'docs/conventions.md')
    repo.git('commit', '-m', 'add the doc')
    const ok = await repo.cli(['check'])
    expect(ok.stdout).not.toContain('doc-missing')
  })
})

describe('specflow check — harness findings', () => {
  // Revision 3: this test only works because probe() now takes ctx.env. With the old
  // form it read process.env, so the starved PATH never reached it and the finding never
  // fired on any machine with `claude` installed — i.e. every machine that can run gates.
  // PATH must still carry git (check shells out to it for the trailer audit), so starve
  // it with a directory holding git and nothing else.
  it('reports the resolved harness launch binary as a gate prerequisite, not a later slice', async () => {
    const repo = await seededRepo()
    const bin = mkdtempSync(join(tmpdir(), 'nobin-'))
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'))
    const res = await repo.cli(['check'], { env: { PATH: bin } })
    const claudeRow = res.stdout.split('\n').find((l) => l.includes('claude'))
    expect(claudeRow).toContain("runs this harness's gate reviewers")
    // Narrowed to the claude row on purpose: starving PATH also kills the gh probe,
    // whose finding legitimately says "later slice", so asserting over all of stdout
    // would fail on somebody else's row.
    expect(claudeRow).not.toContain('later slice')
  })

  // Decision 88: the probe follows the RESOLVED harness. Under SPECFLOW_HARNESS=pi the
  // reviewer lane never spawns claude, so a claude probe would be a false prerequisite.
  it('probes the resolved harness launch binary instead of hard-coding claude', async () => {
    const repo = await seededRepo()
    const scenario = fakeScenario()
    const res = await repo.cli(['check'], { env: gateEnv(scenario, { SPECFLOW_HARNESS: 'pi' }) })
    expect(res.stdout).not.toContain('required for gates on every harness')
    expect(res.stdout).not.toMatch(/probes.*claude.*missing/)
  })

  it('names the resolved harness binary when THAT binary is the missing one', async () => {
    const repo = await seededRepo()
    const bin = mkdtempSync(join(tmpdir(), 'nobin-'))
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'))
    const res = await repo.cli(['check'], { env: { PATH: bin, SPECFLOW_HARNESS: 'pi' } })
    const row = res.stdout.split('\n').find((l) => l.includes('probes') && l.includes('pi'))
    expect(row).toContain("the pi CLI runs this harness's gate reviewers")
    expect(res.stdout).not.toMatch(/probes.*claude.*missing/)
  })

  it('flags a project-scope skills install as invisible from worktrees', async () => {
    const repo = await seededRepo()
    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    for (const s of STAGE_SKILLS) {
      mkdirSync(join(repo.root, '.pi', 'skills', s), { recursive: true })
      writeFileSync(join(repo.root, '.pi', 'skills', s, 'SKILL.md'), '---\nname: x\n---\n')
    }
    const res = await repo.cli(['check'], { env: { SPECFLOW_HARNESS: 'pi', HOME: home } })
    expect(res.stdout).toContain('skills-project-scope')
    expect(res.stdout).toContain('worktree')
  })

  it('warns when a harness that needs an ecosystem install has no skills at all', async () => {
    const repo = await seededRepo()
    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    const res = await repo.cli(['check'], { env: { SPECFLOW_HARNESS: 'pi', HOME: home } })
    expect(res.stdout).toContain('skills-not-installed')
  })

  // claude-code ships skills through its plugin, out of band of both dirs — an empty
  // pair there is not evidence of anything, and a false warning on every run is worse
  // than a missing one.
  it('stays quiet about skills on claude-code', async () => {
    const repo = await seededRepo()
    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    const res = await repo.cli(['check'], { env: { SPECFLOW_HARNESS: 'claude-code', HOME: home } })
    expect(res.stdout).not.toContain('skills-not-installed')
  })

  // Revision 3: the worst state in the design is skills present + payload absent. The
  // pipeline LOOKS like it works — a model reads a skill, edits specs/ directly, and
  // nothing blocks it. The trailer audit catches it eventually; the diagnostic verb
  // should not be the last to know.
  it('warns when the resolved harness has no payload installed', async () => {
    const repo = await seededRepo()
    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    const res = await repo.cli(['check'], { env: { SPECFLOW_HARNESS: 'pi', HOME: home } })
    expect(res.stdout).toContain('payload-not-installed')
  })

  // Found by Task 9's manual pass: the pin is embedded as
  // `${SPECFLOW_BIN:-npx -y @whatmatters/specflow@<v>}`, so a capture group that stops
  // only at whitespace/quote/paren swallows the closing brace and never equals
  // version() — payload-stale then fired on EVERY fresh install, which is a warning
  // nobody would keep reading.
  it('stays quiet about a payload it just installed at the running version', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const res = await repo.cli(['check'], { env: { SPECFLOW_HARNESS: 'pi' } })
    expect(res.stdout).not.toContain('payload-stale')
  })

  it('warns when an installed payload pins an older CLI than the one running', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/prompts/specflow.md'
    repo.write(rel, repo.read(rel).replace(/@whatmatters\/specflow@[\d.]+/g, '@whatmatters/specflow@0.0.1'))
    const res = await repo.cli(['check'], { env: { SPECFLOW_HARNESS: 'pi' } })
    expect(res.stdout).toContain('payload-stale')
  })

  // Same `bundled` bit that silences the skills warning: the marketplace plugin ships
  // engine, guard and dashboard out of band, so absence there is not evidence.
  it('stays quiet about payloads on claude-code', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'], { env: { SPECFLOW_HARNESS: 'claude-code' } })
    expect(res.stdout).not.toContain('payload-not-installed')
  })

  // resolveHarness never consults `harness:` when a detection rung answered, so the
  // typo would otherwise be invisible forever — check is where it surfaces.
  it('reports an unreadable harness: even when detection answered', async () => {
    const repo = await seededRepo()
    repo.write('specflow.config.yaml', `${repo.read('specflow.config.yaml')}harness: pikachu\n`)
    repo.git('add', 'specflow.config.yaml')
    repo.git('commit', '-m', 'bad harness')
    const res = await repo.cli(['check'], { env: { SPECFLOW_HARNESS: 'claude-code' } })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('unknown-harness')
  })
})
