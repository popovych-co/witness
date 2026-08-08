import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { version } from '../src/cli.js'
import { STAGE_SKILLS } from '../src/harness.js'
import { appendEntry } from '../src/journal.js'
import { NPX_LATEST } from '../src/version.js'
import { SPEC_META, fakeScenario, gateEnv, seededRepo, writeSpec } from './helpers.js'

// A local dist-tags endpoint. The suite pins WITNESS_REGISTRY off (helpers.ts); the
// skew tests are the only ones that turn it back on, and they point it here.
async function fakeRegistry(latest: string): Promise<{ base: string; close: () => void }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ latest }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() }
}

describe('witness check', () => {
  it('passes a clean freshly-written canon', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('checks:')
  })

  it('flags hand-edited commits missing the trailer', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('specs/auth-refresh.md', repo.read('specs/auth-refresh.md') + '\nsneaky edit\n')
    repo.git('add', 'specs/auth-refresh.md')
    repo.git('commit', '-m', 'hand edit')
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('untrailered-commit')
  })

  it('flags uncommitted hand edits on state paths', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('specs/auth-refresh.md', repo.read('specs/auth-refresh.md') + 'dirt')
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('hand-edit-in-progress')
  })

  it('flags duplicate ids, unknown deps, and unresolvable pins', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('specs/dupe.md', repo.read('specs/auth-refresh.md'))
    repo.git('add', 'specs/dupe.md')
    repo.git('commit', '-m', 'dupe', '-m', 'Witness-State: 1')
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('duplicate-id')
  })

  it('reports unmet needs as warnings, not errors', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { ...SPEC_META, needs: [{ env: 'NOT_SET_ANYWHERE' }] })
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('need-unmet')
  })

  it('warns on orphan artifact journals', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    appendEntry(repo.root, 'ghost-artifact', { t: 'drift-check', artifact: 'ghost-artifact', criteria: [] })
    repo.git('add', '.witness/journal/ghost-artifact.jsonl')
    repo.git('commit', '-m', 'orphan', '-m', 'Witness-State: 1')
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('orphan-journal')
  })

  it('flags a configured docs path that does not exist', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml',
      repo.read('witness.config.yaml') + 'docs:\n  conventions: [docs/conventions.md]\n')
    repo.git('add', 'witness.config.yaml')
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

describe('witness check — harness findings', () => {
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

  // Decision 88: the probe follows the RESOLVED harness. Under PI_CODING_AGENT=true the
  // reviewer lane never spawns claude, so a claude probe would be a false prerequisite.
  it('probes the resolved harness launch binary instead of hard-coding claude', async () => {
    const repo = await seededRepo()
    const scenario = fakeScenario()
    const res = await repo.cli(['check'], { env: gateEnv(scenario, { PI_CODING_AGENT: 'true' }) })
    expect(res.stdout).not.toContain('required for gates on every harness')
    expect(res.stdout).not.toMatch(/probes.*claude.*missing/)
  })

  it('names the resolved harness binary when THAT binary is the missing one', async () => {
    const repo = await seededRepo()
    const bin = mkdtempSync(join(tmpdir(), 'nobin-'))
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'))
    const res = await repo.cli(['check'], { env: { PATH: bin, PI_CODING_AGENT: 'true' } })
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
    const res = await repo.cli(['check'], { env: { PI_CODING_AGENT: 'true', HOME: home } })
    expect(res.stdout).toContain('skills-project-scope')
    expect(res.stdout).toContain('worktree')
  })

  // Row 104: absence is a STATED LINE, never a finding. A permanent warning row for
  // every correctly-configured user costs attention on every run (row 87's frequency
  // argument), and the indictment was never the missing warning — it was the confident
  // silence. One answer for the whole repo, naming every harness.
  it('states skills absence once, for every registry entry, without a finding', async () => {
    const repo = await seededRepo()
    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    const res = await repo.cli(['check'], { env: { HOME: home } })
    expect(res.code).toBe(0)
    expect(res.stdout).not.toContain('skills-not-installed')
    expect(res.stdout).toContain('skills: none visible here')
    expect(res.stdout).toContain('claude-code')
    expect(res.stdout).toContain('pi')
  })

  // `bundled` EXPLAINS an absence; it does not suppress the report of one. The
  // marketplace plugin ships skills out of band of both directories, so the honest line
  // says so rather than saying nothing.
  it('explains a bundled absence rather than suppressing it', async () => {
    const repo = await seededRepo()
    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    const res = await repo.cli(['check'], { env: { HOME: home } })
    expect(res.stdout).toContain('claude-code — expected under the marketplace plugin')
  })

  it('states payload absence once, for every registry entry, without a finding', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'])
    expect(res.code).toBe(0)
    expect(res.stdout).not.toContain('payload-not-installed')
    expect(res.stdout).toContain('payload: none installed here')
    expect(res.stdout).toContain(`pi — run ${NPX_LATEST} init --agent pi`)
  })

  // Found by Task 9's manual pass: the pin is embedded as
  // `${WITNESS_BIN:-npx -y @popovych.co/witness@<v>}`, so a capture group that stops
  // only at whitespace/quote/paren swallows the closing brace and never equals
  // version() — payload-stale then fired on EVERY fresh install, which is a warning
  // nobody would keep reading.
  it('stays quiet about a payload it just installed at the running version', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const res = await repo.cli(['check'], { env: { PI_CODING_AGENT: 'true' } })
    expect(res.stdout).not.toContain('payload-stale')
  })

  it('warns when an installed payload pins an older CLI than the one running', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/prompts/witness.md'
    repo.write(rel, repo.read(rel).replace(/@popovych\.co\/witness@[\d.]+/g, '@popovych.co/witness@0.0.1'))
    const res = await repo.cli(['check'], { env: { PI_CODING_AGENT: 'true' } })
    expect(res.stdout).toContain('payload-stale')
  })

  // The field report: `check` reported `0 errors` in a repo whose .pi/ payload was a
  // release behind, then reported payload-stale on the SAME repo in the SAME second
  // under `env -u CLAUDECODE PI_CODING_AGENT=1`. The only difference between the runs
  // was which agent's environment variable was set. The audit has no caller now.
  it('reports the same payload state whichever harness is driving the session', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'pi'])
    const rel = '.pi/extensions/canon-guard.mjs'
    repo.write(rel, '// a release behind\n')
    repo.git('add', rel); repo.git('commit', '-m', 'freeze the guard')

    const fromClaude = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    const fromPi = await repo.cli(['check'], { env: { PI_CODING_AGENT: 'true' } })
    for (const res of [fromClaude, fromPi]) {
      expect(res.stdout).toContain('payload-stale')
      expect(res.stdout).toContain(rel)
    }
  })

  // Content, not pins. Three of the five payload files carry no pin at all, so the pin
  // probe could see neither a shipped guard bugfix nor its absence — a guard bugfix was
  // undeliverable AND undetectable on every existing repo, silent in both directions.
  it('sees staleness in a payload file that carries no pin', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'pi'])
    repo.write('.pi/extensions/witness.ts', '// stale adapter\n')
    repo.git('add', '.pi/extensions/witness.ts'); repo.git('commit', '-m', 'freeze the adapter')
    const res = await repo.cli(['check'])
    expect(res.stdout).toContain('payload-stale')
    expect(res.stdout).toContain('.pi/extensions/witness.ts')
  })

  // A repo carrying BOTH payload sets is a reachable state (a marketplace plugin install
  // and a project-scope init both fire), and the honest report is per harness.
  it('reports both payload sets in a repo that carries both', async () => {
    const repo = await seededRepo()
    await repo.cli(['init', '--agent', 'pi'])
    await repo.cli(['init', '--agent', 'claude-code'])
    repo.write('.pi/extensions/canon-guard.mjs', '// stale\n')
    repo.git('add', '.pi/extensions/canon-guard.mjs'); repo.git('commit', '-m', 'freeze pi only')
    const res = await repo.cli(['check'])
    expect(res.stdout).toContain('pi: payload')
    expect(res.stdout).not.toContain('payload: none installed here')
    expect(res.stdout).not.toContain('claude-code: payload')   // claude-code's set is current
  })

  // The config rung is rung ONE of the judgment ladder now, so `resolveJudge` refuses on
  // this input too. The explicit validation above is the single reporter, because it names
  // the expected set where a violation-derived row renders only `got` — one question, one
  // answer, which is this release's whole theme.
  it('reports an unreadable harness: exactly once', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}harness: pikachu\n`)
    repo.git('add', 'witness.config.yaml')
    repo.git('commit', '-m', 'bad harness')
    const res = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    expect(res.code).toBe(1)
    expect(res.stdout.match(/unknown-harness/g)?.length).toBe(1)
    expect(res.stdout).toContain('judge: claude-code (default — harness: pikachu is unreadable; witness check reports it)')
  })

  // Row 105: the judge is a repo fact and it prints unconditionally, declared or not.
  it('names the declared judge and where it was declared', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}harness: pi\n`)
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'declare the judge')
    const res = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    expect(res.stdout).toContain('judge: pi (declared in witness.config.yaml)')
  })

  // The residual made actionable: an undeclared repo is still judged by the ambient
  // session, and the nudge is the only thing that closes it.
  it('names the nudge when nothing is declared', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    expect(res.stdout).toContain('judge: claude-code (detected — undeclared; set harness: in witness.config.yaml to pin it)')
  })

  // The probe follows the judge, which is the behaviour change: it asks whether this
  // machine can run THIS REPO's reviewers, not the caller's.
  it('probes the declared judge, not the session harness', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', `${repo.read('witness.config.yaml')}harness: pi\n`)
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'declare the judge')
    const bin = mkdtempSync(join(tmpdir(), 'nobin-'))
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'))
    const res = await repo.cli(['check'], { env: { PATH: bin, CLAUDECODE: '1' } })
    expect(res.stdout).toContain('pi,missing')
    expect(res.stdout).not.toContain('claude,missing')
  })

  // Row 103. version() reads the RUNNING CLI's own package.json and every invocation
  // surface pins the CLI, so on a frozen repo every witness invocation IS the old CLI,
  // comparing the payload against itself and reporting clean. The freeze is
  // self-concealing; the registry is the one fact outside the loop.
  it('warns that the running CLI is behind the published latest', async () => {
    const repo = await seededRepo()
    const reg = await fakeRegistry('99.0.0')
    const res = await repo.cli(['check'], { env: { WITNESS_REGISTRY: reg.base } })
    expect(res.stdout).toContain('cli-behind')
    expect(res.stdout).toContain('99.0.0')
    expect(res.code).toBe(0)          // warn level only — the exit code is a contract
    reg.close()
  })

  it('says nothing when the running CLI is the published latest', async () => {
    const repo = await seededRepo()
    const reg = await fakeRegistry(version())
    const res = await repo.cli(['check'], { env: { WITNESS_REGISTRY: reg.base } })
    expect(res.stdout).not.toContain('cli-behind')
    reg.close()
  })

  // Silent on failure, and silence means SILENT: an offline machine reports nothing
  // rather than a finding about the network.
  it('reports nothing at all when the registry cannot be reached', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'], { env: { WITNESS_REGISTRY: 'http://127.0.0.1:1' } })
    expect(res.stdout).not.toContain('cli-behind')
    expect(res.stdout).not.toContain('skills-behind')
    expect(res.code).toBe(0)
  })

  // The other half of the SAME query. Pi's skills are version-pinned tarballs that do
  // not auto-update, and each pins the CLI it invokes — so stale skills keep running the
  // stale CLI, and dashboard.ts prints that version and sees nothing wrong.
  it('warns that visible skills pin an older CLI than the published latest', async () => {
    const repo = await seededRepo()
    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    for (const s of STAGE_SKILLS) {
      mkdirSync(join(home, '.pi', 'agent', 'skills', s), { recursive: true })
      writeFileSync(join(home, '.pi', 'agent', 'skills', s, 'SKILL.md'),
        '---\nname: x\n---\nWITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.1.0}"\n')
    }
    const reg = await fakeRegistry('99.0.0')
    const res = await repo.cli(['check'], { env: { HOME: home, WITNESS_REGISTRY: reg.base } })
    expect(res.stdout).toContain('skills-behind')
    expect(res.stdout).toContain('witness-plan')
    expect(res.code).toBe(0)
    reg.close()
  })

  it('reports malformed local config as findings, not a refusal', async () => {
    const repo = await seededRepo()
    repo.write('.witness/config.local.yaml', 'harness: pi\n')
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.stdout).toContain('unknown-local-key')
    expect(res.code).not.toBe(2)
  })

  it('warns on a declared extension path that does not exist', async () => {
    const repo = await seededRepo()
    repo.write('.witness/config.local.yaml', "reviewerExtensions: ['/nope/missing-ext']\n")
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.stdout).toContain('extension-path-missing')
  })

  it('warns when the local config file is not git-ignored (pre-0.5.0 scaffolds)', async () => {
    const repo = await seededRepo()
    repo.write('.gitignore', '.witness/lock\n')  // old block, no config.local.yaml line
    repo.write('.witness/config.local.yaml', "opener: '/usr/bin/true'\n")
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.stdout).toContain('local-config-unignored')
  })
})

describe('witness check states the calibration fact', () => {
  it('reports the empty matrix once, on the orientation surface', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('calibration matrix is empty')
  })
})
