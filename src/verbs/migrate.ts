import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { EXIT, type Ctx } from '../cli.js'
import { SCHEMA_VERSION, configPath, keyViolations, resolveSettings, type Resolved } from '../config.js'
import { inlineValue, readComments, renderConfig, type HumanComments } from '../config-file.js'
import { commitWithTrailer, primaryRoot, tryGit } from '../gitio.js'
import { resolveDriver } from '../harness.js'
import { acquireLock } from '../lock.js'
import { deepEqual, migrateValues, withoutEmpty, type Change } from '../migration.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { GATE_NAMES, SETTINGS, getIn, settingAt } from '../settings.js'
import { execFileSync } from '../spawn.js'
import { kv } from '../toon.js'

// Row 193 §4.6, the verb row 23 reserved: bring witness.config.yaml to this CLI's schema and
// make it complete — every setting with its comment, every value that is a choice kept, every
// comment a human wrote kept — and name each change. Config only, never journals (row 23).

const shown = (val: unknown): string => (val === undefined ? 'absent' : inlineValue(val))

// What an ambient setting meant while it was absent, so a `filled:` line says what it replaces.
function filledWhy(path: string): string {
  if (path === 'harness') return "was undeclared · the open session's harness judged"
  if (path.endsWith('.model')) return 'was unpinned · the harness default model answered'
  if (path === 'criteria.runner') return 'was unset · criteria could not run'
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
  const named = new Set(input.changes.filter((c) => c.kind === 'filled' || c.kind === 'moved').map((c) => c.path))
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
  const dir = mkdtempSync(join(tmpdir(), 'witness-migrate-'))
  try {
    writeFileSync(join(dir, 'before.yaml'), oldText)
    writeFileSync(join(dir, 'after.yaml'), newText)
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', '--', 'before.yaml', 'after.yaml'], { cwd: dir, encoding: 'utf8' })
      return []
    } catch (e) {
      // `git diff --no-index` exits 1 when the files differ: the diff is its stdout.
      return String((e as { stdout?: unknown }).stdout ?? '').trimEnd().split('\n')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
  if (newText === oldText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')) {
    ctx.out(kv('config', `schema ${schema} · up to date`))
    return EXIT.OK
  }
  changeLines(changes, schema).forEach((l) => ctx.out(l))
  const kept = humanLines(comments.human).length - comments.moved
  ctx.out(kv('comments', `kept ${kept} · moved ${comments.moved} · dropped ${comments.legacy} old template lines`))
  ctx.out(kv('config', `schema ${schema} → ${SCHEMA_VERSION}`))
  if (dryRun) {
    ctx.out('diff:')
    diffOf(oldText, newText).forEach((l) => ctx.out(l))
    return EXIT.OK
  }

  const lock = acquireLock(root)
  if (!lock.ok) { renderRefusal(lock.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  try {
    writeFileSync(p, newText)
    const commit = commitWithTrailer(root, ['witness.config.yaml'], `migrate: config schema ${schema} → ${SCHEMA_VERSION}`)
    if (!commit.ok) return refused(commit.violations)
  } finally {
    lock.value()
  }
  return EXIT.OK
}
