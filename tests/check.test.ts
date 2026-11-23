import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { defaultValues } from '../src/settings.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { version } from '../src/cli.js'
import { STAGE_SKILLS } from '../src/harness.js'
import { appendEntry } from '../src/journal.js'
import { NPX_LATEST } from '../src/version.js'
import { worktreePath } from '../src/worktree.js'
import { RECAP, SPEC_META, approve, commitEntry, decidedRepo, turnDecision, fakeScenario, gateEnv, ghState, measuredEnv, seededRepo, shippableRepo, stampLive, undoCanonExclusion, writePlan, writeSpec, patchConfig, configYaml, type TestRepo } from './helpers.js'
import { captureCarry, keepCarry, keepStopped } from '../src/carry.js'
import { findById, loadCanon } from '../src/scan.js'
import { shellLine } from '../src/toon.js'

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

  // Final review (re-graded Important): every refusal says how to fix it, check's included.
  it('a config refusal shows its fix', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { session: { contextLimt: 30, contextLimit: undefined } })
    const res = await repo.cli(['check'])
    expect(res.stdout).toContain('did you mean session.contextLimit?')
    expect(res.stdout).toContain('contextLimit: 20 under session: — or run witness migrate')
  })

  it('flags a configured docs path that does not exist', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { docs: { conventions: ['docs/conventions.md'] } })
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

  // Row 239 (the plan's B15). A stream's name is its file's, and an ask's id is the journal's text:
  // witness writes neither outside the id set, and one committed by hand is reported and never
  // offered — no `next:` names the stream, and no `--ask` routes the ask.
  it('a journal name outside the id set is reported, never offered (row 239)', async () => {
    const repo = await seededRepo({ noRecap: true })
    commitEntry(repo, 'e$(touch M1)', { t: 'recap', ...RECAP, effort: 'e$(touch M1)' })
    expect((await repo.cli(['check'])).stdout).toContain('warn,journal,e$(touch M1).jsonl,stream-name,'
      + 'a stream named outside [a-z0-9][a-z0-9-]* — witness never writes one and never offers it as a command')
    const next = await repo.cli(['next'])
    expect(next.stdout.split('\n').filter((l) => l.includes('e$(touch M1)')), next.stdout).toEqual([])

    commitEntry(repo, 'asks', { t: 'ask', id: 'a$(x)', text: 'build the thing' })
    expect((await repo.cli(['check'])).stdout)
      .toContain('warn,journal,asks.jsonl,ask-id,ask a$(x) is named outside [a-z0-9][a-z0-9-]* — never offered as a command')
    const routed = await repo.cli(['next'])
    expect(routed.stdout, routed.stdout).not.toContain('--ask')
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
    patchConfig(repo, { harness: 'pi' })   // row 193: the judge is declared, never detected
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

  // Row 118. A frozen worktree is precisely what row 116 CANNOT see — the floor binds only
  // CLIs at or after the version that introduced it, and the homes that matter were cut
  // before it. `check` is the verb that finds them, and it was asking its question about
  // the primary root only, so four checkouts of one repository read as one.
  it('reports a stale payload inside a live worktree, and names the home', async () => {
    const { repo, planId } = await shippableRepo()
    await repo.cli(['init', '--agent', 'claude-code'])
    const wt = worktreePath(repo.root, planId)
    const rel = join('.claude', 'commands', 'witness.md')
    writeFileSync(join(wt, rel),
      readFileSync(join(wt, rel), 'utf8').replace(/@popovych\.co\/witness@[\d.]+/g, '@popovych.co/witness@0.0.1'))

    const home = mkdtempSync(join(tmpdir(), 'ckhome-'))
    const res = await repo.cli(['check'], { env: { HOME: home } })
    expect(res.stdout).toContain('payload-stale')
    expect(res.stdout).toContain(planId)

    await repo.cli(['clean'])
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
    patchConfig(repo, { harness: 'pikachu' })
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
    patchConfig(repo, { harness: 'pi' })
    repo.git('add', 'witness.config.yaml'); repo.git('commit', '-m', 'declare the judge')
    const res = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    expect(res.stdout).toContain('judge: pi (declared in witness.config.yaml)')
  })

  // The residual made actionable: an undeclared repo is still judged by the ambient
  // session, and the nudge is the only thing that closes it.
  // Only an older file can leave the judge undeclared (row 193): schema 2 requires harness:.
  it('names the nudge when nothing is declared', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', 'schema: 1\n')
    const res = await repo.cli(['check'], { env: { CLAUDECODE: '1' } })
    expect(res.stdout).toContain('judge: claude-code (detected — undeclared; set harness: in witness.config.yaml to pin it)')
  })

  // The probe follows the judge, which is the behaviour change: it asks whether this
  // machine can run THIS REPO's reviewers, not the caller's.
  it('probes the declared judge, not the session harness', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { harness: 'pi' })
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

// Row 191 §4.11. The adapter is judged by the reading itself, the signal the relay depends on,
// never by Claude Code's own files: the plugin that carries it is installed per machine, outside
// the repo, and only the session check runs in can say whether its reading arrived.
describe('witness check — the context adapter', () => {
  // The whole line, so a remedy that should not be there cannot hide after the expected text.
  const adapterOf = (stdout: string) => stdout.split('\n').find((l) => l.startsWith('adapter:'))

  it('states a reading seen in this session, and its fill', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'], { env: { CLAUDECODE: '1', ...measuredEnv('S', 170000, 1000000) } })
    expect(res.code).toBe(0)
    expect(adapterOf(res.stdout)).toBe('adapter: claude-code — reading seen · 17% of 1M')
  })

  // A fresh session loads the plugin and a running one does not (P9, P10), so the remedy says so.
  // The follow-up is set off from the command, so copying the command takes nothing else with it.
  const INSTALL = 'install once per machine: claude plugin marketplace add popovych-co/witness && claude plugin install witness-context@witness — then start a new session'

  it('names the one-time install in a Claude Code session no adapter wrote a reading for', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'], { env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'S' } })
    expect(res.code).toBe(0)
    expect(adapterOf(res.stdout)).toBe(`adapter: claude-code — no reading in this session (no adapter) · ${INSTALL}`)
  })

  it('names the payload install in a Pi session no adapter wrote a reading for', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'], { env: { PI_CODING_AGENT: 'true', PI_SESSION_ID: 'P' } })
    expect(res.code).toBe(0)
    expect(adapterOf(res.stdout)).toBe(`adapter: pi — no reading in this session (no adapter) · run ${NPX_LATEST} init --agent pi`)
  })

  // A loaded adapter writes this session's reading before every command or clears the variable,
  // so a reading naming another session was inherited from an outer one: this session's adapter
  // wrote nothing, and the install is the remedy, as under `no adapter`.
  it('names the install where the only reading is another session\'s', async () => {
    const repo = await seededRepo()
    const stale = await repo.cli(['check'], { env: { CLAUDECODE: '1', ...measuredEnv('S1', 170000, 1000000), CLAUDE_CODE_SESSION_ID: 'S2' } })
    expect(stale.code).toBe(0)
    expect(adapterOf(stale.stdout)).toBe(`adapter: claude-code — a reading from another session — none from this session's adapter · ${INSTALL}`)
    const pi = await repo.cli(['check'], { env: { PI_CODING_AGENT: 'true', PI_SESSION_ID: 'P2', ...measuredEnv('P1', 170000, 1000000) } })
    expect(adapterOf(pi.stdout)).toBe(`adapter: pi — a reading from another session — none from this session's adapter · run ${NPX_LATEST} init --agent pi`)
  })

  // A malformed reading, or none taken yet, means an adapter is loaded and wrote the variable: an
  // install would change nothing, so the line names the reason and no remedy.
  it('names the reason alone when a loaded adapter wrote a reading this session cannot use', async () => {
    const repo = await seededRepo()
    const broken = await repo.cli(['check'], { env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'S', WITNESS_CONTEXT: '{"session":"S"' } })
    expect(broken.code).toBe(0)
    expect(adapterOf(broken.stdout)).toBe('adapter: claude-code — reading not trusted in this session (malformed)')
    // Pi before its first response sends tokens 0 (P7)
    const reading = JSON.stringify({ session: 'P', tokens: 0, window: 200000 })
    const early = await repo.cli(['check'], { env: { PI_CODING_AGENT: 'true', PI_SESSION_ID: 'P', WITNESS_CONTEXT: reading } })
    expect(adapterOf(early.stdout)).toBe('adapter: pi — no reading yet in this session')
  })

  it('says it cannot tell outside a harness session', async () => {
    const repo = await seededRepo()
    const res = await repo.cli(['check'])
    expect(res.code).toBe(0)
    expect(adapterOf(res.stdout)).toBe('adapter: not checkable outside a harness session — run witness check from a Claude Code or Pi session')
  })
})

describe('the orientation surfaces state no calibration (row 212)', () => {
  it('check and status print no model floor', async () => {
    const repo = await seededRepo()
    for (const verb of ['check', 'status']) {
      const res = await repo.cli([verb])
      expect(res.code, verb).toBe(0)
      expect(res.stdout, verb).not.toMatch(/model-floor|calibrat/)
    }
  })
})

// Row 132. `witness start` is what removes a pre-upgrade worktree's canon copy — so this
// finding exists to make the state discoverable WITHOUT running the verb that fixes it.
describe('witness check — canon in a worktree', () => {
  async function startedRepo() {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    await repo.cli(['start', 'auth-refresh-plan-1'])
    return { repo, wt: worktreePath(repo.root, 'auth-refresh-plan-1') }
  }
  const hits = (stdout: string) => stdout.split('\n').filter((l) => l.includes('canon-in-worktree'))

  it('says nothing about a worktree the exclusion holds in', async () => {
    const { repo } = await startedRepo()
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)
    expect(hits(res.stdout)).toHaveLength(0)
  })

  it('warns ONCE per worktree that predates the exclusion, and never on the exit code', async () => {
    const { repo, wt } = await startedRepo()
    undoCanonExclusion(wt)
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(0)                     // warn: check's exit code is about canon validity
    const rows = hits(res.stdout)
    expect(rows).toHaveLength(1)                 // not one row per materialized doc
    expect(rows[0]).toContain('warn')
    expect(rows[0]).toContain('auth-refresh-plan-1')
    expect(rows[0]).toContain('witness start auth-refresh-plan-1')
  })

  it('errors per path on a hand edit of canon inside a worktree, and drops the clean row', async () => {
    const { repo, wt } = await startedRepo()
    undoCanonExclusion(wt)
    writeFileSync(join(wt, 'plans/auth-refresh-plan-1.md'),
      `${repo.read('plans/auth-refresh-plan-1.md')}\nhand edit\n`)
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    const rows = hits(res.stdout)
    expect(rows).toHaveLength(1)                 // the dirty path is the whole story
    expect(rows[0]).toContain('error')
    expect(rows[0]).toContain('auth-refresh-plan-1: plans/auth-refresh-plan-1.md')
  })

  // Planting a file where the exclusion put none. Measured on git 2.50.1: an index refresh
  // CLEARS skip-worktree for a path it finds present, so the forgery reads as `planted`
  // before anything refreshes and as a modified ordinary entry after — which is why the
  // classification asks both questions and errors either way.
  it('errors on a canon file planted over the exclusion', async () => {
    const { repo, wt } = await startedRepo()
    mkdirSync(join(wt, 'plans'), { recursive: true })
    writeFileSync(join(wt, 'plans/auth-refresh-plan-1.md'), 'forged\n')
    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(1)
    const rows = hits(res.stdout)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('error')
    expect(rows[0]).toContain('auth-refresh-plan-1: plans/auth-refresh-plan-1.md')
    expect(rows[0]).toMatch(/planted|checked out/)
  })
})

// D166 / issue #34. A spec leaves canon through two verbs, and its stream records the
// departure. A plan that no longer moves keeps its parent there; a stream that departed is
// lineage, not an orphan. These drive the real verbs, except where a test must build a state
// the fixed verbs can no longer reach — then by hand, and said.
describe('check — a departure is lineage (D166)', () => {
  const SETUP_CARD = { criteria: [{ id: 'ac-setup', test: '@spec:setup-card' }] }

  it('accepts a done plan whose parent a re-slice superseded, and reads its stream as lineage', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')                        // shipped: the documented re-slice target
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    const res = await repo.cli(['check'])
    expect(res.stdout).not.toContain('unknown-parent')
    expect(res.stdout).not.toContain('pin-unresolvable')
    expect(res.stdout).not.toContain('orphan-journal')
    expect(res.code).toBe(0)
  })

  it('accepts an abandoned plan whose parent a re-slice superseded — the issue #34 end state', async () => {
    const repo = await seededRepo({ preexisting: ['auth-refresh'] })   // live before this effort: abandon unwinds nothing
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect((await repo.cli(['start', 'auth-refresh-plan-1'])).code).toBe(0)
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)
    expect((await writeSpec(repo, 'setup-card', { supersedes: 'auth-refresh', ...SETUP_CARD })).code).toBe(0)
    const res = await repo.cli(['check'])
    expect(res.stdout).not.toContain('unknown-parent')
    expect(res.code).toBe(0)
  })

  it('accepts an abandoned plan whose parent the abandon itself unwound — the plainest abandon', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')                  // created by this effort
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)   // unwinds the spec: `removed`
    const res = await repo.cli(['check'])
    expect(res.stdout).not.toContain('unknown-parent')
    expect(res.stdout).not.toContain('orphan-journal')
    expect(res.code).toBe(0)
  })

  it('a plan still moving under a departed parent is an error that names the way out', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    // A re-slice from before D166, built by hand: the fixed `write` refuses to make this state.
    repo.git('rm', '-q', 'specs/auth-refresh.md')
    appendEntry(repo.root, 'auth-refresh', {
      t: 'status', artifact: 'auth-refresh', from: 'approved', to: 'superseded', cause: 'supersede', by: 'setup-card',
    })
    repo.git('add', '.witness/journal/auth-refresh.jsonl')
    repo.git('commit', '-q', '-m', 'write(setup-card): create spec', '-m', 'Witness-State: 1')
    const res = await repo.cli(['check'])
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('unknown-parent')
    expect(res.stdout).toContain('superseded by setup-card while this plan is approved')
    expect(res.stdout).toContain('witness abandon auth-refresh-plan-1')
    // the way out it names works: abandoning finishes the plan, and a finished plan reads the journal
    expect((await repo.cli(['abandon', 'auth-refresh-plan-1'])).code).toBe(0)
    const after = await repo.cli(['check'])
    expect(after.stdout).not.toContain('unknown-parent')
    expect(after.code).toBe(0)
  })

  it('a parent deleted by hand stays a bare unknown-parent, and its stream a stray', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    // the stream exists and its last word is `live` — existence is not a departure
    appendEntry(repo.root, 'auth-refresh', { t: 'status', artifact: 'auth-refresh', from: 'approved', to: 'live', cause: 'merge' })
    repo.git('rm', '-q', 'specs/auth-refresh.md')
    repo.git('add', '.witness/journal/auth-refresh.jsonl')
    repo.git('commit', '-q', '-m', 'hand delete', '-m', 'Witness-State: 1')
    const res = await repo.cli(['check'])
    expect(res.code).toBe(1)
    expect(res.stdout).toMatch(/unknown-parent,auth-refresh$/m)
    expect(res.stdout).toContain('orphan-journal')
    expect(res.stdout).toContain('records no departure — a stray')
  })

  it('a departed stream that still holds an open obligation is listed and warned until dismissed', async () => {
    const repo = await seededRepo()
    // a departure from before D166 moved nothing: the obligation stayed on the departed stream
    appendEntry(repo.root, 'old-spec', {
      t: 'deferral', id: 'd-0000beef', artifact: 'old-spec', gate: 'design', round: 1,
      anchor: 'old-spec > ## Behavior', kind: 'artifact-debt', caused_by_run: 'r-1',
    })
    appendEntry(repo.root, 'old-spec', { t: 'status', artifact: 'old-spec', from: 'live', to: 'superseded', cause: 'supersede', by: 'new-spec' })
    repo.git('add', '.witness/journal/old-spec.jsonl')
    repo.git('commit', '-q', '-m', 'legacy departure', '-m', 'Witness-State: 1')
    const res = await repo.cli(['check'])
    expect(res.stdout).toContain('stranded-deferral')
    expect(res.stdout).toContain('d-0000beef')
    expect(res.stdout).toContain('--cause superseded')
    expect(res.stdout).not.toContain('orphan-journal')
    expect((await repo.cli(['status'])).stdout).toContain('d-0000beef')   // the ledger lists it too
    expect((await repo.cli(['dismiss', 'old-spec', '--deferral', 'd-0000beef', '--cause', 'superseded', '--note', 'pre-D166 re-slice'])).code).toBe(0)
    const after = await repo.cli(['check'])
    expect(after.stdout).not.toContain('stranded-deferral')
    expect(after.stdout).not.toContain('orphan-journal')
    expect((await repo.cli(['status'])).stdout).not.toContain('d-0000beef')
  })

  it('witness\'s own floor stream is not an orphan', async () => {
    const repo = await seededRepo()
    appendEntry(repo.root, 'floor', { t: 'policy-pin', key: 'floor', pin: '0.14.0', note: 'probe' })
    repo.git('add', '.witness/journal/floor.jsonl')
    repo.git('commit', '-q', '-m', 'floor pin', '-m', 'Witness-State: 1')
    expect((await repo.cli(['check'])).stdout).not.toContain('orphan-journal')
  })

  it('a done plan under a removed parent stays an error: that unwind deleted shipped behavior', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    repo.flipStatus('auth-refresh-plan-1', 'done')
    stampLive(repo, 'auth-refresh')
    // An unwind from before D166, built by hand: the fixed abandon keeps a spec a done plan stands on.
    repo.git('rm', '-q', 'specs/auth-refresh.md')
    appendEntry(repo.root, 'auth-refresh', { t: 'status', artifact: 'auth-refresh', from: 'live', to: 'removed', cause: 'abandon' })
    repo.git('add', '.witness/journal/auth-refresh.jsonl')
    repo.git('commit', '-q', '-m', 'abandon(auth-refresh-plan-2)', '-m', 'Witness-State: 1')
    const res = await repo.cli(['check'])
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('removed by abandon after this plan shipped it')
    // the way out it names: the same spec written again under its own id, then approved
    expect((await writeSpec(repo, 'auth-refresh')).code).toBe(0)
    approve(repo, 'auth-refresh')
    expect((await repo.cli(['check'])).code).toBe(0)
  })
})

describe('witness check — carried decisions (row 198)', () => {
  it("warns when an in-progress plan's carried decisions moved", async () => {
    const repo = await decidedRepo()
    repo.flipStatus('auth-refresh-plan-1', 'in-progress')
    await turnDecision(repo, 'Rotation is client-side')
    const r = await repo.cli(['check'])
    expect(r.stdout).toContain('mid-flight-amendment')
    expect(r.stdout).toContain('the decisions auth-refresh carries moved off the pin')
  })
})


// Row 243 (design §4.1.4, §4.1.1 step 10). What older versions and ended plans leave behind: check
// warns for each, naming it by its sha or its ref, gives every drop as prose and never as a runnable
// row, deletes nothing, and leaves its exit alone (row 139). The lazy stamp deletes a merged plan's
// kept refs; an abandon keeps them (D168).
describe('witness check — the carry\'s leftovers (row 243)', () => {
  // An entry as `git rebase --autostash` leaves one when its re-apply clashes: `git stash create
  // autostash` on the branch, so the stash commit's subject is "On <branch>: autostash", then `git
  // stash store -m autostash`, the reflog's message. Made in the test's own tmp repo, on its own list.
  const autostash = (repo: TestRepo, branch: string, body: string): string => {
    const back = repo.git('symbolic-ref', '--short', 'HEAD')
    if (branch !== back) repo.git('switch', '-q', '-c', branch)
    repo.write('notes.txt', body)
    const sha = repo.git('stash', 'create', 'autostash')
    repo.git('checkout', '-q', '--', 'notes.txt')
    if (branch !== back) repo.git('switch', '-q', back)
    repo.git('stash', 'store', '-m', 'autostash', sha)
    return sha
  }
  const findingRows = (stdout: string, rule: string): string[] => stdout.split('\n').filter((l) => l.startsWith('  warn,git,') && l.includes(`,${rule},`))
  const fieldOf = (row: string): string => row.split(',')[2]!
  const noRunRow = (stdout: string): void => expect(stdout.split('\n').filter((l) => /^\s*run:/.test(l))).toEqual([])
  const refsUnder = (repo: TestRepo, prefix: string): string[] =>
    repo.git('for-each-ref', '--format=%(refname)', prefix).split('\n').filter((r) => r !== '')
  const gitIn = (wt: string, ...args: string[]): string => execFileSync('git', args, { cwd: wt, encoding: 'utf8' }).trim()

  // Two plans, each started (a worktree each): auth-refresh-plan-1 under auth-refresh and
  // auth-other-plan-1 under a second spec, so the second can be abandoned with the first standing.
  async function twoPlans(): Promise<TestRepo> {
    const repo = await seededRepo()
    expect((await writeSpec(repo, 'auth-refresh')).code).toBe(0)
    approve(repo, 'auth-refresh')
    expect((await writePlan(repo, 'auth-refresh-plan-1')).code).toBe(0)
    repo.flipStatus('auth-refresh-plan-1', 'approved')
    expect((await repo.cli(['start', 'auth-refresh-plan-1'])).code).toBe(0)
    expect((await writeSpec(repo, 'auth-other', { criteria: [{ id: 'ac-rotate', test: '@spec:auth-other' }] })).code).toBe(0)
    approve(repo, 'auth-other')
    expect((await writePlan(repo, 'auth-other-plan-1', { parent: 'auth-other' })).code).toBe(0)
    repo.flipStatus('auth-other-plan-1', 'approved')
    expect((await repo.cli(['start', 'auth-other-plan-1'])).code).toBe(0)
    return repo
  }
  // The plan's uncommitted work captured into its carry ref, as ship's step 4 does.
  const carryOf = (wt: string, planId: string, file: string): string => {
    writeFileSync(join(wt, file), `${planId}'s uncommitted work\n`)
    gitIn(wt, 'add', '--', file)
    const carry = captureCarry(wt, planId)
    if (!carry.ok || carry.value === undefined) throw new Error(`capture: ${JSON.stringify(carry)}`)
    return carry.value
  }
  // A clash's backup as step 7 writes it (stash-shaped, two parents), and a stopped rebase's as
  // step 0 writes it (one parent): the plan's next kept ref each.
  const keptFromCarry = (wt: string, planId: string, file: string): string => {
    const kept = keepCarry(wt, planId, carryOf(wt, planId, file), [file])
    if (!kept.ok) throw new Error(`keepCarry: ${JSON.stringify(kept.violations)}`)
    return kept.value
  }
  const keptFromStop = (wt: string, planId: string, file: string): string => {
    writeFileSync(join(wt, file), 'the conflicted file as the worktree held it\n')
    const kept = keepStopped(wt, planId, [file])
    if (!kept.ok) throw new Error(`keepStopped: ${JSON.stringify(kept.violations)}`)
    return kept.value
  }
  const cleanTree = (wt: string): void => { gitIn(wt, 'reset', '-q', '--hard'); gitIn(wt, 'clean', '-q', '-fd') }

  it('warns per witness autostash entry by sha with the drop as prose; skips On main: autostash; exit unchanged', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    repo.write('notes.txt', 'base\n')
    repo.git('add', 'notes.txt')
    repo.git('commit', '-q', '-m', 'notes')
    const clean = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(clean.code).toBe(0)
    expect(clean.stdout).not.toContain('autostash-left')

    const p1 = autostash(repo, 'witness/p1', 'p1 work\n')
    const human = autostash(repo, 'main', 'my own work\n')
    const p2 = autostash(repo, 'witness/p2', 'p2 work\n')
    // git's own shape: the subject names the branch, the reflog's message is just "autostash"
    expect(repo.git('show', '-s', '--format=%s', p1)).toBe('On witness/p1: autostash')
    expect(repo.git('show', '-s', '--format=%s', human)).toBe('On main: autostash')
    expect(repo.git('stash', 'list', '--format=%gs').split('\n')).toEqual(['autostash', 'autostash', 'autostash'])
    const listed = repo.git('stash', 'list', '--format=%gd %H')

    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(clean.code)
    const rows = findingRows(res.stdout, 'autostash-left')
    expect(rows.map(fieldOf).sort()).toEqual([p1, p2].sort())
    for (const [sha, plan] of [[p1, 'p1'], [p2, 'p2']] as const) {
      const row = rows.find((l) => fieldOf(l) === sha)!
      expect(row).toContain(`an autostash entry ship left for ${plan} (0.29.0 and earlier)`)
      expect(row).toContain('the only clean copy of that plan\'s work')
      expect(row).toContain(shellLine(['git', 'stash', 'show', '-p', sha]))
      expect(row).toContain(shellLine(['git', 'diff', `${sha}^1`, `${sha}^2`]))
      expect(row).toContain(`find its stash@{N} with ${shellLine(['git', 'stash', 'list', '--format=%gd %H'])}`)
      expect(row).toContain('git stash drop refuses a sha')
    }
    expect(res.stdout).not.toContain(human)
    noRunRow(res.stdout)
    expect(repo.git('stash', 'list', '--format=%gd %H')).toBe(listed)   // read, never changed
  }, 120_000)

  it('warns for an abandoned plan\'s kept ref and for a carry ref of a plan not in progress', async () => {
    const repo = await twoPlans()
    await writePlan(repo, 'auth-refresh-plan-2')
    repo.flipStatus('auth-refresh-plan-2', 'approved')                          // a plan, not in progress
    const baseline = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(baseline.stdout).not.toContain('witness-ref-left')

    // auth-other-plan-1 clashed twice before the human abandoned it, and a move of it never finished
    const wt = worktreePath(repo.root, 'auth-other-plan-1')
    const stashShaped = keptFromCarry(wt, 'auth-other-plan-1', 'clash.txt')
    const oneParent = keptFromStop(wt, 'auth-other-plan-1', 'stop.txt')
    carryOf(wt, 'auth-other-plan-1', 'carried.txt')
    cleanTree(wt)
    expect(gitIn(wt, 'rev-list', '--parents', '-n', '1', stashShaped).split(' ')).toHaveLength(3)
    expect(gitIn(wt, 'rev-list', '--parents', '-n', '1', oneParent).split(' ')).toHaveLength(2)
    expect((await repo.cli(['abandon', 'auth-other-plan-1'])).code).toBe(0)
    expect(refsUnder(repo, 'refs/witness/kept/auth-other-plan-1/')).toEqual([stashShaped, oneParent])   // D168: kept

    const head = repo.git('rev-parse', 'HEAD')
    for (const ref of [
      'refs/witness/kept/auth-refresh-plan-1/1', 'refs/witness/carry/auth-refresh-plan-1',   // in progress: its own
      'refs/witness/kept/auth-refresh-plan-2/1', 'refs/witness/carry/auth-refresh-plan-2',   // approved: the carry warns
      'refs/witness/kept/gone-plan/1', 'refs/witness/carry/gone-plan',                         // no such plan
    ]) repo.git('update-ref', ref, head)
    const before = refsUnder(repo, 'refs/witness/')

    const res = await repo.cli(['check'], { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(res.code).toBe(baseline.code)
    const rows = findingRows(res.stdout, 'witness-ref-left')
    expect(rows.map(fieldOf).sort()).toEqual([
      stashShaped, oneParent, 'refs/witness/carry/auth-other-plan-1',
      'refs/witness/carry/auth-refresh-plan-2', 'refs/witness/kept/gone-plan/1', 'refs/witness/carry/gone-plan',
    ].sort())
    const row = (ref: string): string => rows.find((l) => fieldOf(l) === ref)!
    expect(row(stashShaped)).toContain('auth-other-plan-1 is abandoned, and this backup of its work stays')
    expect(row(stashShaped)).toContain(shellLine(['git', 'stash', 'show', '-p', stashShaped]))
    expect(row(stashShaped)).toContain(shellLine(['git', 'diff', `${stashShaped}^1`, `${stashShaped}^2`]))
    // a stopped rebase's backup has one parent: read with git show, never as a stash
    expect(row(oneParent)).toContain(shellLine(['git', 'show', oneParent]))
    expect(row(oneParent)).not.toContain('git stash show')
    expect(row(oneParent)).not.toContain('^2')
    expect(row('refs/witness/carry/auth-other-plan-1')).toContain('auth-other-plan-1 is abandoned, and this ref holds its uncommitted work from a move that never finished — it may be the only copy')
    expect(row('refs/witness/carry/auth-refresh-plan-2')).toContain('auth-refresh-plan-2 is approved, and this ref holds its uncommitted work')
    expect(row('refs/witness/kept/gone-plan/1')).toContain('gone-plan is no longer a plan, and this backup of its work stays')
    for (const ref of rows.map(fieldOf)) {
      expect(row(ref)).toContain('never deleted for you')
      expect(row(ref)).toContain(`once you no longer need it: ${shellLine(['git', 'update-ref', '-d', ref])}`)
    }
    noRunRow(res.stdout)
    expect(refsUnder(repo, 'refs/witness/')).toEqual(before)                     // check deletes nothing
  }, 180_000)

  it('a merged plan\'s kept refs are deleted by the stamp; an abandoned plan\'s stay, and check warns', async () => {
    const repo = await twoPlans()
    const wt1 = worktreePath(repo.root, 'auth-refresh-plan-1')
    const fromStop = repo.git('rev-parse', keptFromStop(wt1, 'auth-refresh-plan-1', 'stop.txt'))
    keptFromCarry(wt1, 'auth-refresh-plan-1', 'clash.txt')
    repo.git('update-ref', 'refs/witness/kept/auth-refresh-plan-1/mine', fromStop)   // renamed inside the prefix: still the plan's
    carryOf(wt1, 'auth-refresh-plan-1', 'carried.txt')                                 // a move that never finished
    cleanTree(wt1)
    repo.git('update-ref', 'refs/witness/kept/auth-refresh-plan-10/1', fromStop)        // another plan's prefix
    expect(refsUnder(repo, 'refs/witness/kept/auth-refresh-plan-1/')).toHaveLength(3)

    const wt2 = worktreePath(repo.root, 'auth-other-plan-1')
    const abandoned = keptFromStop(wt2, 'auth-other-plan-1', 'stop.txt')
    cleanTree(wt2)
    expect((await repo.cli(['abandon', 'auth-other-plan-1'])).code).toBe(0)

    repo.setMeta('auth-refresh-plan-1', { pr: 1 })
    const scenario = fakeScenario()
    ghState(scenario, 1, 'MERGED')
    const res = await repo.cli(['check'], { env: gateEnv(scenario) })
    expect(findById(loadCanon(repo.root), 'auth-refresh-plan-1')!.meta.status).toBe('done')
    expect(refsUnder(repo, 'refs/witness/kept/auth-refresh-plan-1/')).toEqual([])             // every ref under the prefix, alike
    expect(refsUnder(repo, 'refs/witness/kept/auth-refresh-plan-10/')).toEqual(['refs/witness/kept/auth-refresh-plan-10/1'])
    expect(refsUnder(repo, 'refs/witness/kept/auth-other-plan-1/')).toEqual([abandoned])
    expect(refsUnder(repo, 'refs/witness/carry/')).toEqual(['refs/witness/carry/auth-refresh-plan-1'])   // carried work is never dropped
    const rows = findingRows(res.stdout, 'witness-ref-left')
    expect(rows.map(fieldOf).sort()).toEqual([abandoned, 'refs/witness/carry/auth-refresh-plan-1', 'refs/witness/kept/auth-refresh-plan-10/1'].sort())
    expect(rows.find((l) => fieldOf(l) === abandoned)).toContain('auth-other-plan-1 is abandoned, and this backup')
    expect(rows.find((l) => fieldOf(l) === 'refs/witness/carry/auth-refresh-plan-1')).toContain('auth-refresh-plan-1 is done, and this ref holds its uncommitted work')

    // a done plan's kept ref the stamp did not delete (a crash after its commit, say) is warned too
    repo.git('update-ref', 'refs/witness/kept/auth-refresh-plan-1/3', fromStop)
    const again = await repo.cli(['check'], { env: gateEnv(scenario) })
    expect(findingRows(again.stdout, 'witness-ref-left').find((l) => fieldOf(l) === 'refs/witness/kept/auth-refresh-plan-1/3'))
      .toContain('auth-refresh-plan-1 is done, and this backup of its work stays')
    expect(again.code).toBe(res.code)
  }, 180_000)
})

describe('witness check — scratch runs (row 259)', () => {
  it('names scratch runs off once while scratch.prepare is unset (row 259)', async () => {
    const repo = await seededRepo()
    repo.write('witness.config.yaml', stringify(defaultValues({ harness: 'claude-code', schema: 2 })))
    repo.git('add', '-A')
    repo.git('commit', '-m', 'schema 2')
    const out = (await repo.cli(['check'])).stdout
    expect(out.split('\n').filter((l) => l.includes('feature-off'))).toHaveLength(1)
    expect(out).toContain('scratch runs are off — scratch.prepare is not set · witness migrate proposes one')
    repo.write('witness.config.yaml', configYaml())
    repo.git('add', '-A')
    repo.git('commit', '-m', 'schema 3')
    expect((await repo.cli(['check'])).stdout).not.toContain('feature-off')
  })
})

describe('reader-unused (row 262)', () => {
  it('names a reader no part bears the name of, once each (row 262)', async () => {
    const repo = await seededRepo()
    patchConfig(repo, { readers: { biome: 'pnpm exec biome check --reporter=sarif .' } })
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'reader')
    const out = (await repo.cli(['check'])).stdout
    expect(out.split('\n').filter((l) => l.includes('reader-unused'))).toHaveLength(1)
    expect(out).toContain('readers.biome is set, but no ship.lint part is named biome')
    patchConfig(repo, { ship: { lint: { biome: 'pnpm exec biome check .' } }, readers: { biome: 'pnpm exec biome check --reporter=sarif .' } })
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'part')
    expect((await repo.cli(['check'])).stdout).not.toContain('reader-unused')
  })
})
