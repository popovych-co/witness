import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { EXIT, type Ctx } from '../cli.js'
import { SCHEMA_VERSION, configPath, keyViolations, partsOf, resolveSettings, type Resolved } from '../config.js'
import { inlineValue, readComments, renderConfig, type HumanComments } from '../config-file.js'
import { commitWithTrailer, primaryRoot, tryGit } from '../gitio.js'
import { resolveDriver } from '../harness.js'
import { acquireLock } from '../lock.js'
import { deepEqual, migrateValues, withoutEmpty, type Change } from '../migration.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { withScratch } from '../scratch.js'
import { GATE_NAMES, SETTINGS, getIn, settingAt } from '../settings.js'
import { execFileSync } from '../spawn.js'
import { kv } from '../toon.js'
import { appendEntry, entryLine, journalRel } from '../journal.js'
import { findById, loadCanon } from '../scan.js'
import { prepareStamp, writeStamp, type PreparedStamp } from '../stamp.js'
import { crashPoint, withTxn } from '../txn.js'
import { templateDraft } from '../principles.js'
import { detectPrepare } from '../prepare.js'
import { detectReaders, readerUnused, unboundReaders } from '../lint-parts.js'
import { runRow } from '../act.js'
import { grantCommands, repoGrantAct, shownCmd, trustedNow, UNGRANTABLE, type RunCommand } from '../allowlist.js'
import { sessionMarker } from '../drive-presence.js'
import { TRUST_STREAM } from '../streams.js'
import { hasControl } from '../toon.js'
import { repoTrustEntry, trustStreamTaken } from './trust.js'

// Row 193 §4.6, the verb row 23 reserved: bring witness.config.yaml to this CLI's schema and
// make it complete — every setting with its comment, every value that is a choice kept, every
// comment a human wrote kept — and name each change. Config only (row 23), with one exception
// row 221 made: the untouched principles template an older init wrote draft is stamped approved,
// journaled as the template, in the same trailer commit.

// Row 221. The untouched template an older init left draft, stamped approved as the template.
function templateStamp(root: string): PreparedStamp | undefined {
  const doc = findById(loadCanon(root), 'principles')
  return templateDraft(root, doc) ? prepareStamp(doc, 'approved', 'template') : undefined
}

const shown = (val: unknown): string => (val === undefined ? 'absent' : inlineValue(val))

// Row 259. The settings whose value is a command witness runs: a `filled` or `added` one is a
// proposal the human may grant in the same act. Rows 261–262: the lint parts and the readers.
export const COMMAND_SETTINGS: readonly string[] = [
  'ship.lint', 'readers.biome', 'readers.eslint', 'readers.clippy', 'readers.tsc', 'scratch.prepare',
]

// A command setting migrate fills (ambient) or adds (not ambient: the readers). A `ship.lint` is
// one proposal per part, each under its own source (row 261); `none` is never one.
export const proposalsOf = (changes: readonly Change[]): RunCommand[] =>
  changes.filter((c) => (c.kind === 'filled' || c.kind === 'added') && COMMAND_SETTINGS.includes(c.path))
    .flatMap((c): RunCommand[] => {
      if (c.path === 'ship.lint') return (partsOf('ship.lint', c.to) ?? []).map((p) => ({ cmd: p.cmd, source: p.source }))
      return typeof c.to === 'string' && c.to !== 'none' ? [{ cmd: c.to, source: c.path }] : []
    })

// What stays for the human: each untrusted proposal, and its grant to run (none for a command the
// verb would not take).
function untrustedLines(left: readonly RunCommand[]): string[] {
  return left.flatMap((c) => {
    const act = repoGrantAct(c)
    return [`trust: ${shownCmd(c)} untrusted — the human grants it`, act === undefined ? `  note: ${UNGRANTABLE}` : runRow(act)]
  })
}

// What an ambient setting meant while it was absent, so a `filled:` line says what it replaces.
function filledWhy(path: string): string {
  if (path === 'harness') return "was undeclared · the open session's harness judged"
  if (path.endsWith('.model')) return 'was unpinned · the harness default model answered'
  if (path === 'criteria.runner') return 'was unset · criteria could not run'
  if (path === 'scratch.prepare') return 'was unset · scratch runs were off'
  return `was unset · ship reported ${path === 'ship.test' ? 'tests' : 'lint'} not configured`
}

// The schema whose default the value moved to: the first step after `from` holding it.
function movedIn(c: Change, from: number): number | undefined {
  const s = settingAt(c.path)
  if (!s) return undefined
  return Object.keys(s.defaults).map(Number).filter((k) => k > from && deepEqual(s.defaults[k], c.to)).sort((a, b) => a - b)[0]
}

// One line per change, in the list's order. The 1 → 2 expansion is one line: one value, copied.
// These lines quote the file's own comments, which hold commas, so they print verbatim.
function changeLines(changes: readonly Change[], from: number): string[] {
  const lines: string[] = []
  const expanded = changes.filter((c) => c.kind === 'expanded')
  let expandedSaid = false
  for (const s of SETTINGS) {
    for (const c of changes.filter((x) => x.path === s.path && x.kind !== 'expanded')) {
      if (c.kind === 'added') lines.push(`added: ${c.path} ${shown(c.to)} — ${s.comment}`)
      else if (c.kind === 'filled') lines.push(`filled: ${c.path} ${shown(c.to)} — ${filledWhy(c.path)}`)
      else {
        const at = movedIn(c, from)
        lines.push(`moved: ${c.path} ${shown(c.from)} → ${shown(c.to)} — default changed${at === undefined ? '' : ` in schema ${at}`}`)
      }
    }
    if (!expandedSaid && expanded.some((c) => c.path === s.path)) {
      expandedSaid = true
      const targets = [
        ...GATE_NAMES.filter((g) => expanded.some((c) => c.path === `gates.${g}.model`)),
        ...(expanded.some((c) => c.path === 'arbiter.model') ? ['arbiter.model'] : []),
      ]
      lines.push(`expanded: gates.model ${shown(expanded[0]!.to)} → ${targets.join(' · ')}`)
    }
  }
  return lines
}

const humanLines = (h: HumanComments): string[] => [...h.top, ...[...h.above.values()].flat(), ...h.end]

// The guard (§4.6): what the old file meant, read as loadConfig reads it, against what the new
// file means under the current schema. A difference no `filled:` or `moved:` line names, or a
// human's comment missing from the new text, is a witness bug, and nothing is written.
export function guardMigration(input: {
  before: Resolved; after: Resolved; changes: readonly Change[]; human: HumanComments; newText: string
}): Violation[] {
  // Row 262. An `added` change is named too: a reader is not ambient, so the in-memory read fills
  // `none` while the write takes what was detected, and the `added:` line names that value.
  const named = new Set(input.changes.filter((c) => c.kind === 'filled' || c.kind === 'moved' || c.kind === 'added').map((c) => c.path))
  const out: Violation[] = []
  for (const s of SETTINGS) {
    const was = getIn(input.before as unknown as Record<string, unknown>, s.path)
    const now = getIn(input.after as unknown as Record<string, unknown>, s.path)
    if (!deepEqual(was, now) && !named.has(s.path)) {
      out.push(v(s.path, 'value-changed', `${shown(was)} → ${shown(now)}`,
        'the value the file held — migrate changes only what it names; nothing was written, report this'))
    }
  }
  for (const line of humanLines(input.human)) {
    if (!input.newText.includes(line.trim())) {
      out.push(v('witness.config.yaml', 'comment-lost', line.trim(),
        'every comment a human wrote, kept — nothing was written, report this'))
    }
  }
  return out
}

function diffOf(oldText: string, newText: string): string[] {
  return withScratch('witness-migrate-', (dir) => {
    writeFileSync(join(dir, 'before.yaml'), oldText)
    writeFileSync(join(dir, 'after.yaml'), newText)
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', '--', 'before.yaml', 'after.yaml'], { cwd: dir, encoding: 'utf8' })
      return []
    } catch (e) {
      // `git diff --no-index` exits 1 when the files differ: the diff is its stdout.
      return String((e as { stdout?: unknown }).stdout ?? '').trimEnd().split('\n')
    }
  })
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  // Worktrees share the primary root's config (row 191): a worktree's copy is its branch's file.
  const root = rootR.value
  // Strict on purpose: a typo'd flag throws, and cli.ts renders it as `bad-arguments` (row 113).
  const dryRun = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' } }, allowPositionals: false, strict: true })
    .values['dry-run'] === true
  const refused = (violations: Violation[]) => { renderRefusal(violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }

  const p = configPath(root)
  if (!existsSync(p)) return refused([v('witness.config.yaml', 'missing', 'no config at repo root', 'run witness init')])
  const oldText = readFileSync(p, 'utf8')
  let parsed: unknown
  try {
    parsed = parseYaml(oldText)
  } catch (e) {
    return refused([v('witness.config.yaml', 'yaml-parse', String((e as Error).message).slice(0, 120), 'valid YAML')])
  }
  const raw = withoutEmpty((parsed ?? {}) as Record<string, unknown>)
  const schema = raw.schema
  if (typeof schema !== 'number' || !Number.isInteger(schema)) {
    return refused([v('schema', 'required', String(schema ?? 'absent'), 'integer schema version')])
  }
  if (schema > SCHEMA_VERSION) return refused([v('schema', 'newer-than-cli', String(schema), `<=${SCHEMA_VERSION} — upgrade witness`)])
  // Keys the file's own schema never knew: the human fixes or deletes them; migrate drops nothing.
  const unknown = keyViolations(raw, schema)
  if (unknown.length) return refused(unknown)
  const beforeM = migrateValues(raw, schema, { mode: 'memory' })
  if (!beforeM.ok) return refused(beforeM.violations)
  const before = resolveSettings(beforeM.value.raw, 'lenient')
  if (!before.ok) return refused(before.violations)
  if (tryGit(root, 'status', '--porcelain', '--', 'witness.config.yaml').out.trim() !== '') {
    return refused([v('witness.config.yaml', 'dirty', 'uncommitted changes', 'commit or clean witness.config.yaml first')])
  }

  const driver = resolveDriver(ctx.env, undefined)
  const written = migrateValues(raw, schema, {
    mode: 'write', harness: driver.ok ? driver.value.harness.name : undefined,
    detected: { 'scratch.prepare': detectPrepare(root), ...detectReaders(root) },
  })
  if (!written.ok) return refused(written.violations)
  const { changes } = written.value
  const comments = readComments(oldText)
  const newText = renderConfig(written.value.raw, comments.human)
  let reread: Record<string, unknown>
  try {
    reread = parseYaml(newText) as Record<string, unknown>
  } catch (e) {
    return refused([v('witness.config.yaml', 'invalid-output', String((e as Error).message).slice(0, 120),
      `a file that resolves under schema ${SCHEMA_VERSION} — nothing was written, report this`)])
  }
  const after = resolveSettings(reread, 'strict')
  if (!after.ok) {
    return refused(after.violations.map((x) => v(x.field, 'invalid-output', `${x.rule}: ${x.got}`,
      `a file that resolves under schema ${SCHEMA_VERSION} — nothing was written, report this`)))
  }
  const guard = guardMigration({ before: before.value, after: after.value, changes, human: comments.human, newText })
  if (guard.length) return refused(guard)

  // Line ends and a BOM are the checkout's, not the file's: with core.autocrlf a Windows working
  // copy of an up-to-date file reads CRLF, and is still up to date.
  const current = newText === oldText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const stamp = templateStamp(root)
  if (current) ctx.out(kv('config', `schema ${schema} · up to date`))
  else {
    changeLines(changes, schema).forEach((l) => ctx.out(l))
    const kept = humanLines(comments.human).length - comments.moved
    ctx.out(kv('comments', `kept ${kept} · moved ${comments.moved} · dropped ${comments.legacy} old template lines`))
    ctx.out(kv('config', `schema ${schema} → ${SCHEMA_VERSION}`))
  }
  if (stamp !== undefined) ctx.out(kv('principles', 'draft → approved — the untouched template an older init wrote draft'))
  // Whole-branch review I2. A reader this file sets beside a ship.lint with no part of its name binds
  // nothing until the part is named for its tool — said where the reader is written, not only by check.
  const readers = (getIn(reread, 'readers') ?? {}) as Record<string, unknown>
  for (const tool of unboundReaders(readers, partsOf('ship.lint', getIn(reread, 'ship.lint')))) ctx.out(`note: ${readerUnused(tool)}`)
  if (current && stamp === undefined) return EXIT.OK
  // Row 259. The commands this migrate proposes that this machine does not trust yet.
  const untrusted = proposalsOf(changes).filter((c) => !trustedNow(root, ctx.env, c.cmd))
  if (dryRun) {
    if (!current) {
      ctx.out('diff:')
      diffOf(oldText, newText).forEach((l) => ctx.out(l))
    }
    untrustedLines(untrusted).forEach((l) => ctx.out(l))
    return EXIT.OK
  }
  // Asked once per command at a terminal, outside any session, before the write: a grant is the
  // human's (row 205), and it rides the config's own transaction and commit. A command the verb
  // would not take is never offered.
  const asked: string[] = []
  if (!current && ctx.isTTY && sessionMarker(ctx.env) === undefined) {
    for (const c of untrusted.filter((x) => !hasControl(x.cmd))) {
      const answer = await ctx.ask(`trust: ${shownCmd(c)}\ngrant? saves to .witness/allow.json (gitignored) [y/N]`)
      if (answer.trim().toLowerCase().startsWith('y')) asked.push(c.cmd)
    }
  }

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  let granted: string[] = []
  try {
    // A trust stream another history holds skips the grant and never blocks the config.
    const taken = asked.length > 0 ? trustStreamTaken(root) : undefined
    if (taken !== undefined) ctx.out(`note: ${taken.rule}: ${taken.got} — ${taken.want}`)
    granted = taken === undefined ? asked : []
    const trustEntry = repoTrustEntry(granted, 'migrate')
    const files = [
      ...(current ? [] : ['witness.config.yaml']), ...(stamp !== undefined ? [stamp.rel, journalRel(stamp.stream)] : []),
      ...(granted.length > 0 ? [journalRel(TRUST_STREAM)] : []),
    ]
    const subject = [
      ...(current ? [] : [`config schema ${schema} → ${SCHEMA_VERSION}`]),
      ...(stamp !== undefined ? ['principles approved (the untouched template)'] : []),
      ...(granted.length > 0 ? [`trust: ${granted.length} repo command(s)`] : []),
    ].join(' · ')
    const lines = [
      ...(stamp !== undefined ? [{ stream: stamp.stream, line: stamp.line }] : []),
      ...(granted.length > 0 ? [{ stream: TRUST_STREAM, line: entryLine(trustEntry) }] : []),
    ]
    const marker = { op: 'migrate', files, ...(lines.length > 0 ? { journalMulti: lines } : {}) }
    const commit = withTxn(root, marker, () => {
      if (!current) writeFileSync(p, newText)
      if (stamp !== undefined) writeStamp(root, stamp)
      if (granted.length > 0) appendEntry(root, TRUST_STREAM, trustEntry)
      crashPoint(ctx.env, 'migrate-write')
      const committed = commitWithTrailer(root, files, `migrate: ${subject}`)
      // D154's order: allow.json takes a grant only once its record is committed.
      if (committed.ok && granted.length > 0) grantCommands(root, granted)
      return committed
    })
    if (!commit.ok) return refused(commit.violations)
  } finally {
    lock.value()
  }
  if (granted.length > 0) ctx.out(kv('trusted', granted.join(' · ')))
  untrustedLines(untrusted.filter((c) => !granted.includes(c.cmd))).forEach((l) => ctx.out(l))
  return EXIT.OK
}
