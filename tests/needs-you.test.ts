import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliAct } from '../src/act.js'
import { loadConfig } from '../src/config.js'
import { appendEntry } from '../src/journal.js'
import { type NeedYou, needsYou, needsYouToken, needYouRows } from '../src/needs-you.js'
import { loadCanon } from '../src/scan.js'
import { approve, autonomyOn, fakeCtx, hermeticEnv, seededRepo, writePlan, writeSpec } from './helpers.js'
import { needsYouRepo } from './model-fixtures.js'

const cfgOf = (root: string) => {
  const r = loadConfig(root)
  if (!r.ok) throw new Error('config')
  return r.value
}

// Row 203. One derivation of what needs the human, read by drive's report, its notifier and
// `witness wait`. The key never depends on rendered text, so drive, `next` and `wait` compute
// the same token for the same state.
describe('needsYou (D203)', () => {
  it('stuck, capped and a policy park are items', async () => {
    const repo = await seededRepo()
    autonomyOn(repo)
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    await writePlan(repo, 'auth-refresh-plan-2')
    await writePlan(repo, 'auth-refresh-plan-3')
    appendEntry(repo.root, 'auth-refresh-plan-3', { v: 1, t: 'gate-run', gate: 'plan', artifact: 'auth-refresh-plan-3', round: 1,
      run_id: 'r', reviewed_sha: 's', prompts_sha: 'p', witness: '0', model: 'm', checks: [], outcome: 'stopped' } as never)
    appendEntry(repo.root, 'auth-refresh-plan-3', { v: 1, t: 'human-decision', gate: 'plan', artifact: 'auth-refresh-plan-3', round: 1,
      decision: 'stop', selected: 'policy', rule: 'cap-rounds', note: 'drive cap: plan ran 16 rounds' } as never)
    const items = needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo.root), loadCanon(repo.root), [
      { target: 'auth-refresh-plan-1', kind: 'stuck' },
      { target: 'auth-refresh-plan-2', kind: 'capped' },
    ])
    const byKind = (k: string) => items.filter((i) => i.kind === k)
    // final review: a stuck or capped target names its way back
    expect(byKind('stuck')[0]).toMatchObject({ target: 'auth-refresh-plan-1' })
    expect(needYouRows(byKind('stuck')[0]!))
      .toEqual(['stuck: auth-refresh-plan-1 — witness log auth-refresh-plan-1', '  run: witness retry auth-refresh-plan-1'])
    expect(byKind('capped')[0]).toMatchObject({ target: 'auth-refresh-plan-2' })
    expect(needYouRows(byKind('capped')[0]!))
      .toEqual(['stuck: auth-refresh-plan-2 — witness log auth-refresh-plan-2', '  run: witness retry auth-refresh-plan-2'])
    expect(byKind('parked')[0]).toMatchObject({ target: 'auth-refresh-plan-3', key: 'parked:auth-refresh-plan-3:plan' })
    expect(needYouRows(byKind('parked')[0]!)[0]).toBe('parked: auth-refresh-plan-3 · plan round 1 — drive cap: plan ran 16 rounds')
  })

  it('a pending transaction is first', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh', { needs: [{ id: 'sbx', manual: 'Stripe sandbox', satisfied: false }] })
    // crashPoint exits the process, so the crashed write runs in a child of its own
    const here = resolve(import.meta.dirname, '..')
    const crashed = spawnSync(join(here, 'node_modules', '.bin', 'tsx'), [join(here, 'src', 'bin.ts'), 'ask', 'crashed'],
      { cwd: repo.root, env: hermeticEnv({ WITNESS_CRASH_AFTER: 'journal-append' }), encoding: 'utf8' })
    expect(crashed.status).toBe(9)
    const items = needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo.root), loadCanon(repo.root), [])
    expect(items[0]!.kind).toBe('pending-txn')
    expect(needYouRows(items[0]!)[0]).toMatch(/^wait: pending transaction · /)
    expect(items.some((i) => i.kind === 'need' && i.target === 'auth-refresh')).toBe(true)
  })

  it('a kept trust grant read from the live folder renders its grant without text', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const items = needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo.root), loadCanon(repo.root), [
      { target: 'auth-refresh', kind: 'kept', stop: 'trust-grant' },
    ])
    expect(items).toEqual([{ kind: 'trust-grant', target: 'auth-refresh', key: 'trust-grant:auth-refresh',
      list: cliAct('trust', 'auth-refresh') }])
    expect(items.map((i) => needYouRows(i))).toEqual([['wait: trust grant · auth-refresh', '  run: witness trust auth-refresh']])
  })

  it('the token ignores order and changes when an item is added', () => {
    const a: NeedYou = { kind: 'stuck', target: 'a', key: 'stuck:a' }
    const b: NeedYou = { kind: 'decision', target: 'b', key: 'decision:b:plan', gate: 'plan', show: cliAct('decide', 'plan', 'b', '--show') }
    const c: NeedYou = { kind: 'merge', target: 'c', key: 'merge:c' }
    expect(needsYouToken([a, b])).toBe(needsYouToken([b, a]))
    expect(needsYouToken([a, b, c])).not.toBe(needsYouToken([a, b]))
    expect(needsYouToken([a, { ...b, gate: 'implement' }])).toBe(needsYouToken([a, b]))
    expect(needsYouToken([a, b])).toMatch(/^[0-9a-f]{12}$/)
  })
})

// Rows 139/203. Each item is a model: the facts its rows print and the acts its commands are, so
// a reader of the model is handed what the text offers, and the text renders from it.
describe('what needs you is a model (rows 139/203)', () => {
  it('each kind carries its facts and acts (rows 139/203)', async () => {
    const { repo, asides } = await needsYouRepo()
    const items = needsYou(repo.root, { env: {} }, cfgOf(repo.root), loadCanon(repo.root), asides)
    const of = <K extends NeedYou['kind']>(k: K, target?: string) =>
      items.find((i) => i.kind === k && (target === undefined || i.target === target)) as Extract<NeedYou, { kind: K }>
    expect(of('pending-txn').recover.options.map((o) => o.act?.argv))
      .toEqual([['recover', '--complete'], ['recover', '--rollback']])
    expect(of('need', 'auth-refresh')).toMatchObject({ need: 'prod', text: 'production access granted', holds: ['ac-prod'],
      satisfy: cliAct('satisfy', 'auth-refresh', '--need', 'prod') })
    expect(items.find((i) => i.kind === 'need' && i.need === 'docs reviewed'))
      .toMatchObject({ satisfy: cliAct('satisfy', 'auth-refresh', '--need', '2') })
    expect(of('decision')).toMatchObject({ target: 'auth-refresh-plan-1', gate: 'plan',
      show: cliAct('decide', 'plan', 'auth-refresh-plan-1', '--show') })
    expect(of('parked', 'auth-refresh-plan-2').reopen).toEqual([cliAct('gate', 'plan', 'auth-refresh-plan-2', '--fresh')])
    expect(of('parked', 'auth-refresh-plan-3').reopen.at(-1)).toEqual(cliAct('abandon', 'auth-refresh-plan-3'))
    expect(of('stuck', 'x-plan-1')).toMatchObject({ why: 'no progress on witness ship x-plan-1', retry: cliAct('retry', 'x-plan-1') })
    expect(of('stuck', '-').retry).toBeUndefined()
    expect(JSON.parse(JSON.stringify(items))).toEqual(items)
  })

  it('a trust grant carries each command escaped, a grant only where the verb would take one (Review Focus 2)', async () => {
    const { repo, asides } = await needsYouRepo()
    const items = needsYou(repo.root, { env: {} }, cfgOf(repo.root), loadCanon(repo.root), asides)
    const grant = items.find((i) => i.kind === 'trust-grant' && i.target === 'auth-refresh-plan-5')
    expect(grant).toMatchObject({ commands: [
      { cmd: "echo 'hi'", source: 'ship.test', grant: cliAct('trust', 'auth-refresh-plan-5', '--cmd', "echo 'hi'") },
      { cmd: 'bad\\x1bcmd', source: 'ship.lint' },
    ] })
    expect(grant?.kind === 'trust-grant' && grant.commands?.[1]?.grant).toBeFalsy()
    expect(JSON.stringify(items)).not.toContain('\u001b')
    // JSON.stringify spells a raw ESC as `\u001b`, so the line above alone could never fail: no
    // field anywhere in the model may hold the raw byte.
    expect(JSON.stringify(items)).not.toContain('\\u001b')
  })

  it('an aside read from the live folder still builds a whole model (Review Focus 4)', async () => {
    const { repo } = await needsYouRepo()
    const items = needsYou(repo.root, { env: {} }, cfgOf(repo.root), loadCanon(repo.root), [
      { target: 'auth-refresh-plan-6', kind: 'kept', stop: 'trust-grant' },
      { target: '-', kind: 'conversation' },
      { target: 'auth-refresh-plan-4', kind: 'merge' },
    ])
    expect(items.find((i) => i.kind === 'trust-grant'))
      .toEqual({ kind: 'trust-grant', target: 'auth-refresh-plan-6', key: 'trust-grant:auth-refresh-plan-6', list: cliAct('trust', 'auth-refresh-plan-6') })
    const talk = items.find((i) => i.kind === 'conversation') as Extract<NeedYou, { kind: 'conversation' }>
    expect(talk).toMatchObject({ target: '-', key: 'conversation:-' })
    expect(talk.ask).toBeUndefined()
    expect(talk.notice).toBeUndefined()
    expect(items.find((i) => i.kind === 'merge')).toMatchObject({ target: 'auth-refresh-plan-4', pr: '9' })
  })
})
