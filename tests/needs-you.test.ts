import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { actOn, cliAct } from '../src/act.js'
import { loadConfig } from '../src/config.js'
import { appendEntry } from '../src/journal.js'
import { type NeedYou, needsYou, needsYouToken, needYouRows } from '../src/needs-you.js'
import { loadCanon } from '../src/scan.js'
import { approve, autonomyOn, fakeCtx, hermeticEnv, seededRepo, writePlan, writeSpec } from './helpers.js'
import { controlStrings, needsYouRepo } from './model-fixtures.js'

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

  // Row 239. A merge's `pr` falls back to canon frontmatter, which a hand edit can make any text:
  // only a positive integer names a PR, so `run: gh pr merge` never holds a word but its number.
  it('a pr that is not a positive integer names no merge (row 239)', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const merge = () => needsYou(repo.root, fakeCtx(repo.root), cfgOf(repo.root), loadCanon(repo.root),
      [{ target: 'auth-refresh-plan-1', kind: 'merge' }]).find((i) => i.kind === 'merge')!
    for (const pr of ['9$(touch M1)', 0, -3, 1.5]) {
      repo.setMeta('auth-refresh-plan-1', { pr })
      expect(merge(), String(pr)).toEqual({ kind: 'merge', target: 'auth-refresh-plan-1', key: 'merge:auth-refresh-plan-1' })
      expect(needYouRows(merge()), String(pr)).toEqual(['wait: merge · auth-refresh-plan-1'])
    }
    repo.setMeta('auth-refresh-plan-1', { pr: 9 })
    expect(merge()).toMatchObject({ pr: '9' })
    expect(needYouRows(merge())).toEqual(['wait: merge · auth-refresh-plan-1 · PR #9', '  run: gh pr merge 9'])
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
    // R7: no string anywhere in the model holds a raw control or bidi character. Searching
    // JSON.stringify's text for a raw ESC could never fail: it spells C0 controls out as `\u001b`.
    expect(controlStrings(items)).toEqual([])
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

  // Row 239 (design §3.4b). Pasted whole, a menu is a pipeline that runs every act it names: at the
  // bound a park's reopen prints as `exits:`, and `run:` is kept for its one command below it.
  it('a parked menu prints as exits:, a single reopen as run: (row 239)', async () => {
    const { repo, asides } = await needsYouRepo()
    const items = needsYou(repo.root, { env: {} }, cfgOf(repo.root), loadCanon(repo.root), asides)
    const rowsOf = (target: string) => needYouRows(items.find((i) => i.kind === 'parked' && i.target === target)!)
    const atBound = rowsOf('auth-refresh-plan-3')
    expect(atBound).toHaveLength(2)
    expect(atBound[1]).toMatch(/^ {2}exits: witness decide plan /)
    const below = rowsOf('auth-refresh-plan-2')
    expect(below).toHaveLength(2)
    expect(below[1]).toMatch(/^ {2}run: witness gate plan /)
  })

  // Ruling R16(a), pinned per field. Prose a doc, a journal or drive wrote on a head line is spelled
  // out where it holds a line break, which would start a `run:` row of its own ahead of the real one.
  it('a newline in a need, its holds or a stuck why is spelled on its head (row 239)', () => {
    const nl = '\n  run: witness retry p1; touch M1'
    const shown = '\\n  run: witness retry p1; touch M1'
    const satisfy = cliAct('satisfy', 'p1', '--need', 'n1')
    const need = (holds: string[]): NeedYou => ({ kind: 'need', target: 'p1', key: 'need', need: 'n1', text: `prod${nl}`, holds, satisfy })
    expect(needYouRows(need([]))).toEqual([`wait: unmet need · p1 · prod${shown}`, '  run: witness satisfy p1 --need n1'])
    expect(needYouRows(need([`ac-a${nl}`])))
      .toEqual([`wait: held criterion · p1 · prod${shown} holds ac-a${shown}`, '  run: witness satisfy p1 --need n1'])
    for (const kind of ['stuck', 'capped'] as const) {
      expect(needYouRows({ kind, target: 'p1', key: kind, why: `no progress${nl}`, retry: cliAct('retry', 'p1') }))
        .toEqual([`stuck: p1 — no progress${shown}`, '  run: witness retry p1'])
    }
  })

  // Ruling R16(b) (the plan's B4). Every row printed from an act goes through `runRow`: an act Windows
  // withholds is shown with why on a `note:` row, and never offered as a `run:` or `then:`, the trust
  // grant's listing fallback included.
  it('on Windows an act holding a risky word prints a note row, never run: (row 239)', () => {
    const t = 'p1&x'
    const win = (...argv: string[]) => actOn('win32', argv)
    const items: NeedYou[] = [
      { kind: 'design-look', target: t, key: 'design-look', open: win('design', t, '--open'), show: win('decide', 'design', t, '--show') },
      { kind: 'need', target: t, key: 'need', need: 'n1', text: 'prod access', holds: [], satisfy: win('satisfy', t, '--need', 'n1') },
      { kind: 'decision', target: t, key: 'decision', gate: 'plan', show: win('decide', 'plan', t, '--show') },
      { kind: 'parked', target: t, key: 'parked', gate: 'plan', round: 1, why: 'parked at x', reopen: [win('gate', 'plan', t, '--fresh')] },
      { kind: 'stuck', target: t, key: 'stuck', retry: win('retry', t) },
      { kind: 'trust-grant', target: t, key: 'trust-grant', list: win('trust', t) },
      { kind: 'trust-grant', target: t, key: 'trust-grant', list: win('trust', t),
        commands: [{ cmd: 'npm test', source: 'ship.test', grant: win('trust', t, '--cmd', 'npm test') }] },
    ]
    const rows = items.flatMap((i) => needYouRows(i).slice(1))
    expect(rows.filter((r) => /^ {2}(run|then): /.test(r))).toEqual([])
    const why = 'not offered on Windows — it holds &, which cmd.exe or Windows PowerShell can read as more than text'
    expect(rows).toEqual([
      `  note: witness design 'p1&x' --open — ${why}`,
      `  note: witness decide design 'p1&x' --show — ${why}`,
      `  note: witness satisfy 'p1&x' --need n1 — ${why}`,
      `  note: witness decide plan 'p1&x' --show — ${why}`,
      `  note: witness gate plan 'p1&x' --fresh — ${why}`,
      `  note: witness retry 'p1&x' — ${why}`,
      `  note: witness trust 'p1&x' — ${why}`,
      `  note: ${why}`,
      `  note: witness trust 'p1&x' — ${why}`,
    ])
  })
})
