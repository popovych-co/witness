import { describe, expect, it } from 'vitest'
import { readStream } from '../src/journal.js'
import { recommend } from '../src/recommend.js'
import { SPEC_META, seededRepo, stampLive, writeSpec } from './helpers.js'

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

    const res = await repo.cli(['trust', 'auth-refresh', '--yes'])

    expect(res.code).toBe(0)
    const allow = JSON.parse(repo.read('.witness/allow.json')) as { commands: string[] }
    expect(allow.commands).toEqual(expect.arrayContaining(['echo ok', 'echo lint']))
    const entry = readStream(repo.root, repo.effort).findLast((e) => e.t === 'trust')
    expect(entry?.via).toBe('verb')
    expect(entry?.cmds).toEqual(['echo ok', 'echo lint'])
  })

  it('is idempotent and says so when nothing is left to grant', async () => {
    const repo = await cmdSpec()
    await repo.cli(['trust', 'auth-refresh', '--yes'])

    const again = await repo.cli(['trust', 'auth-refresh'])

    expect(again.code).toBe(0)
    expect(again.stdout).toContain('already trusted')
  })

  it('says nothing to trust for an artifact with no cmd: criteria', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')

    const res = await repo.cli(['trust', 'auth-refresh'])

    expect(res.code).toBe(0)
    expect(res.stdout).toContain('no cmd: criteria')
  })

  it('refuses an unknown artifact with a runnable remedy', async () => {
    const repo = await seededRepo()

    const res = await repo.cli(['trust', 'ghost'])

    expect(res.code).toBe(2)
    expect(res.stderr).toContain('unknown-artifact')
    expect(res.stderr).toContain('run: witness index')
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
