import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { recommend } from '../src/recommend.js'
import { SPEC_META, approve, patchConfig, seededRepo, stampLive, writePlan, writeSpec } from './helpers.js'

// D154. Headless gates block every untrusted per-criterion command (`allowlist.ts`,
// `!isTTY → blocked`) — the Aug 1 all-four-`ac-*`-fail false negative. Approvals are
// agent-typed (D127), so there is no prompt to give; trust rides the surfaces that exist.
async function cmdSpec() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh', {
    ...SPEC_META,
    criteria: [
      { id: 'ac-rotate', test: '@spec:auth-refresh' },
      { id: 'ac-smoke', cmd: 'echo ok' },
      { id: 'ac-lint', cmd: 'echo lint' },
    ],
  })
  stampLive(repo, 'auth-refresh')
  return repo
}

describe('witness trust (D154)', () => {
  it('lists the cmd: criteria with status and grants nothing without --yes', async () => {
    const repo = await cmdSpec()

    const res = await repo.cli(['trust', 'auth-refresh'])

    expect(res.stdout).toContain('echo ok')
    expect(res.stdout).toContain('untrusted')
    expect(res.code).toBe(1)                                   // listing is not granting
    expect(() => repo.read('.witness/allow.json')).toThrow()
  })

  it('grants every listed command with --yes and journals the act', async () => {
    const repo = await cmdSpec()

    const res = await repo.cli(['trust', 'auth-refresh', '--yes'], { tty: true })

    expect(res.code).toBe(0)
    const allow = JSON.parse(repo.read('.witness/allow.json')) as { commands: string[] }
    expect(allow.commands).toEqual(expect.arrayContaining(['echo ok', 'echo lint']))
    const entry = readStream(repo.root, repo.effort).findLast((e) => e.t === 'trust')
    expect(entry?.via).toBe('verb')
    // row 205: the config commands the flow runs are listed, and granted, beside the criteria
    expect(entry?.cmds).toEqual(['npm test -- -t "@spec:{id}"', 'npm test', 'npm run lint', 'echo ok', 'echo lint'])
  })

  it('is idempotent and says so when nothing is left to grant', async () => {
    const repo = await cmdSpec()
    await repo.cli(['trust', 'auth-refresh', '--yes'], { tty: true })

    const again = await repo.cli(['trust', 'auth-refresh'])

    expect(again.code).toBe(0)
    expect(again.stdout).toContain('already trusted')
  })

  it('lists the config commands for an artifact with no cmd: criteria (row 205)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')

    const res = await repo.cli(['trust', 'auth-refresh'])

    expect(res.code).toBe(1)
    expect(res.stdout).toContain('npm test,ship.test,untrusted')
    expect(res.stdout).toContain('npm run lint,ship.lint,untrusted')
    expect(res.stdout).toContain("run: witness trust auth-refresh --cmd 'npm test'")
  })

  it('refuses an unknown artifact with a runnable remedy', async () => {
    const repo = await seededRepo()

    const res = await repo.cli(['trust', 'ghost'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown-artifact')
    expect(res.stderr).toContain('run: witness index')
  })
})

// Row 205 (issue #56). A plan carries no criteria of its own, so the verb read nothing for it
// even when its spec runs a command; and the config commands every flow runs — the runner,
// ship.test, ship.lint — were invisible to it. Grants are per named command, never a nod, and
// never a session's.
async function planWithCmdCriterion(shipTest = 'pnpm test') {
  const repo = await seededRepo()
  patchConfig(repo, { criteria: { runner: 'full-suite', report: 'junit:**/reports/junit.xml' }, ship: { test: shipTest, lint: 'pnpm lint' } })
  repo.git('add', 'witness.config.yaml')
  repo.git('commit', '-m', 'full-suite')
  await writeSpec(repo, 'ingest', {
    criteria: [{ id: 'ac-i', test: '@spec:ingest' }, { id: 'ac-a', cmd: 'echo first' }],
    needs: [{ cmd: 'test -d .git' }],
  })
  approve(repo, 'ingest')
  await writePlan(repo, 'ingest-plan-1', { parent: 'ingest', steps: [{ id: 's1', title: 'ingest', criteria: ['ac-i', 'ac-a'] }] })
  return repo
}
const allowed = (repo: { read: (rel: string) => string }): string[] =>
  (JSON.parse(repo.read('.witness/allow.json')) as { commands: string[] }).commands

describe('witness trust per command (D205)', () => {
  it("lists a plan's spec criteria and the config commands it runs (P3)", async () => {
    const repo = await planWithCmdCriterion()
    const res = await repo.cli(['trust', 'ingest-plan-1'], { env: { WITNESS_TRUST_CMDS: '' } })
    expect(res.stdout).toContain('pnpm test,ship.test,untrusted')
    expect(res.stdout).toContain('pnpm lint,ship.lint,untrusted')
    expect(res.stdout).toContain('echo first,cmd: ac-a,untrusted')
    expect(res.stdout).not.toContain('full-suite,')
    expect(res.code).toBe(1)
  })

  it('--cmd grants exactly the named command and journals it (P4)', async () => {
    const repo = await planWithCmdCriterion()
    const res = await repo.cli(['trust', 'ingest', '--cmd', 'echo first'], { env: { WITNESS_TRUST_CMDS: '' } })
    expect(res.code).toBe(0)
    expect(allowed(repo)).toEqual(['echo first'])
    expect(readStream(repo.root, repo.effort).findLast((e) => e.t === 'trust')?.cmds).toEqual(['echo first'])
  })

  it('--yes refuses without a terminal and grants all at one', async () => {
    const repo = await planWithCmdCriterion()
    const headless = await repo.cli(['trust', 'ingest', '--yes'])
    expect(headless.code).toBe(2)
    expect(headless.stderr).toContain('yes-needs-terminal')
    expect(() => repo.read('.witness/allow.json')).toThrow()
    const human = await repo.cli(['trust', 'ingest', '--yes'], { tty: true })
    expect(human.code).toBe(0)
    expect(allowed(repo)).toEqual(['pnpm test', 'pnpm lint', 'echo first', 'test -d .git'])
  })

  it('no session grants trust', async () => {
    const repo = await planWithCmdCriterion()
    for (const env of [{ WITNESS_DRIVE: 'ingest-plan-1' }, { WITNESS_REVIEWER: '1' }]) {
      for (const flag of [['--cmd', 'pnpm test'], ['--yes']]) {
        const res = await repo.cli(['trust', 'ingest-plan-1', ...flag], { env, tty: true })
        expect(res.code).toBe(2)
        expect(res.stderr).toContain('trust-in-session')
      }
    }
    expect(() => repo.read('.witness/allow.json')).toThrow()
  })

  it('--cmd outside the list refuses', async () => {
    const repo = await planWithCmdCriterion()
    const res = await repo.cli(['trust', 'ingest-plan-1', '--cmd', 'rm -rf ~'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown-command')
    expect(() => repo.read('.witness/allow.json')).toThrow()
  })

  it('a command with a single quote is listed paste-ready and granted exactly (Review Focus 5)', async () => {
    const repo = await planWithCmdCriterion("pnpm test -t 'a b'")
    const listed = await repo.cli(['trust', 'ingest-plan-1'])
    expect(listed.stdout).toContain(`run: witness trust ingest-plan-1 --cmd 'pnpm test -t '\\''a b'\\'''`)
    const res = await repo.cli(['trust', 'ingest-plan-1', '--cmd', "pnpm test -t 'a b'"])
    expect(res.code).toBe(0)
    expect(allowed(repo)).toEqual(["pnpm test -t 'a b'"])
  })

  it('with no id it lists everything the repo runs, and a grant needs a target', async () => {
    const repo = await planWithCmdCriterion()
    const res = await repo.cli(['trust'])
    expect(res.code).toBe(1)
    expect(res.stdout).toContain('pnpm test,ship.test,-,untrusted')
    expect(res.stdout).toContain('echo first,cmd: ac-a,ingest,untrusted')
    expect(res.stdout).toContain('test -d .git,need: 1,ingest,untrusted')
    const bare = await repo.cli(['trust', '--cmd', 'pnpm test'], { tty: true })
    expect(bare.code).toBe(2)
    expect(bare.stderr).toContain('usage')
  })
})

// The block renders BOTH approve forms so trust is never the toll for approval, and names
// the commands verbatim — a grant the human cannot read is not one they made.
describe('the decision block prices trust (D154)', () => {
  const entries = [{
    v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round: 1, run_id: 'r-1',
    reviewed_sha: 'a', prompts_sha: 'ps', witness: '0.13.0', model: 'm', pin: 'm',
    harness: 'claude-code', calibration: 'none', checks: [{ name: 'c', ok: true }],
    outcome: 'stopped', verdicts: [{ reviewer: 'plan-critic', findings: [], coverage: [] }],
  }] as unknown as Parameters<typeof recommend>[0]['entries']

  it('offers plain approve FIRST and a trusting twin beside it', () => {
    const d = recommend({
      gate: 'plan', target: 'p1', entries, upstream: undefined, stale: false,
      untrustedCmds: ['echo ok', 'echo lint'],
    })!
    const plain = d.options.findIndex((o) => o.command.endsWith('--approve'))
    const trusting = d.options.findIndex((o) => o.command.endsWith('--approve --trust-cmds'))

    expect(plain).toBeGreaterThanOrEqual(0)
    expect(trusting).toBe(plain + 1)                               // plain first: never the toll
    expect(d.options[plain]!.tradeoff).toContain('echo ok · echo lint')
    expect(d.options[trusting]!.tradeoff).toContain('echo ok · echo lint')
    expect(d.options[trusting]!.note).toContain('never grants trust')
  })

  it('changes nothing when every command is already trusted', () => {
    const withTrust = recommend({
      gate: 'plan', target: 'p1', entries, upstream: undefined, stale: false, untrustedCmds: [],
    })!
    expect(withTrust.options.some((o) => o.command.includes('--trust-cmds'))).toBe(false)
  })

  it('never stacks a grant onto the obligation-minting override', () => {
    const d = recommend({
      gate: 'plan', target: 'p1', entries, upstream: undefined, stale: false, untrustedCmds: ['echo ok'],
    })!
    expect(d.options.some((o) => o.command.includes('--override --trust-cmds'))).toBe(false)
  })
})
