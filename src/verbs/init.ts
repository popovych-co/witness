import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { configPath } from '../config.js'
import { writeDoc } from '../fm.js'
import { commitWithTrailer, primaryRoot, tryGit } from '../gitio.js'
import { resolveHarness, type Harness } from '../harness.js'
import {
  installPayload, mergeSettings, preflightPayload, readIfExists, recordHarness,
  writeSettings, type SyncResult,
} from '../install.js'
import { probe } from '../probe.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'

const DEFAULT_CONFIG = `# witness.config.yaml — the whole surface
schema: 1
# paths: { specs: docs/specs, plans: docs/plans }   # optional canon roots (defaults: specs, plans); git mv existing docs when changing
# docs:                      # repo docs registry — enumerated keys, unknown keys refused
#   conventions: [docs/code/architecture.md]   # → injected into code-reviewer at implement + ship (cache-keyed)
gates:
  model: claude-fable-5      # reviewer model pin — exact id, aliases refused
  # any gate block may pin its own model (wins over the global pin), e.g.
  # decompose: { reviewers: [slicing-critic], model: claude-opus-4-8 }
  decompose: { reviewers: [slicing-critic] }
  plan: { reviewers: [plan-critic] }
  implement:
    reviewers:               # per change class; a plain list = all classes
      feature: [code-reviewer, silent-failure-hunter, type-design, pr-test, design-reviewer]
      fix: [code-reviewer, silent-failure-hunter, design-reviewer]
      chore: [code-reviewer]
  ship: { reviewers: [drift-reviewer, code-reviewer] }
criteria:
  runner: 'npm test -- -t "@spec:{id}"'   # or: runner: full-suite + report: junit:**/reports/junit.xml
ship: { test: "npm test", lint: "npm run lint", branch: main }
`

const GITIGNORE_BLOCK = `# witness local (never committed)
.witness/lock
.witness/txn.json
.witness/allow.json
.witness/calibration.local.yaml
.witness/screens/
`

const PRINCIPLES_BODY = `# Principles

Repo-wide rules and trade-offs. Amend via \`witness write\`; chores may name
this doc as their plan's parent.
`

const USAGE = 'usage: witness init [--agent claude-code|pi|auto]'

// `--agent` is what makes a second run legal. A bare `witness init` keeps its tested
// contract — it refuses `already-initialized` — because scaffolding twice is a mistake.
// Installing a payload set twice is not: it is how a Claude Code repo gains Pi support,
// and how a half-finished install is completed.
export async function run(ctx: Ctx, argv: string[] = []): Promise<number> {
  let agent: string | undefined
  try {
    agent = parseArgs({ args: argv, options: { agent: { type: 'string' } }, allowPositionals: false })
      .values.agent
  } catch {
    ctx.err(USAGE)
    return EXIT.REFUSED
  }

  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) {
    renderRefusal(rootRes.violations).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const root = rootRes.value
  const scaffolded = existsSync(configPath(root))
  if (scaffolded && agent === undefined) {
    renderRefusal([v('witness.config.yaml', 'already-initialized', 'config exists',
      'witness is already set up here — witness init --agent <name> installs an agent payload set')]).forEach(ctx.err)
    return EXIT.REFUSED
  }

  let harness: Harness | undefined
  if (agent !== undefined) {
    // `auto` is the one value that consults the detection rungs; a named agent is a
    // claim and refuses when false, listing the harnesses that exist.
    const hxR = agent === 'auto'
      ? resolveHarness(ctx.env, {})
      : resolveHarness({ WITNESS_HARNESS: agent }, {})
    if (!hxR.ok) {
      renderRefusal(hxR.violations.map((x) => ({ ...x, field: '--agent' }))).forEach(ctx.err)
      return EXIT.REFUSED
    }
    harness = hxR.value.harness
    // Revision 6: pre-flight before the lock and before any scaffold write, so a
    // refusal here leaves the repo exactly as it was.
    const pre = preflightPayload(root, harness)
    if (!pre.ok) {
      renderRefusal(pre.violations).forEach(ctx.err)
      return EXIT.REFUSED
    }
  }

  const lock = acquireLock(root)
  if (!lock.ok) {
    renderRefusal(lock.violations).forEach(ctx.err)
    return EXIT.BLOCKED
  }
  try {
    const files: string[] = []
    if (!scaffolded) {
      writeFileSync(configPath(root), DEFAULT_CONFIG)
      mkdirSync(join(root, 'plans'), { recursive: true })
      mkdirSync(join(root, '.witness', 'journal'), { recursive: true })
      writeFileSync(join(root, 'plans', '.gitkeep'), '')
      writeFileSync(join(root, '.witness', 'journal', '.gitkeep'), '')
      const gi = join(root, '.gitignore')
      const existing = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
      if (!existing.includes('.witness/lock')) {
        writeFileSync(gi, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + GITIGNORE_BLOCK)
      }
      writeDoc(join(root, 'specs', 'principles.md'), {
        meta: { id: 'principles', type: 'principles', status: 'draft', depends: [], needs: [] },
        body: PRINCIPLES_BODY,
      })
      files.push('witness.config.yaml', '.gitignore', 'specs/principles.md',
        'plans/.gitkeep', '.witness/journal/.gitkeep')
    }

    let synced: SyncResult | undefined
    if (harness !== undefined) {
      const payload = installPayload(root, harness)
      if (!payload.ok) {
        renderRefusal(payload.violations).forEach(ctx.err)
        return EXIT.REFUSED
      }
      synced = payload.value
      files.push(...synced.written, ...synced.restamped)
      if (harness.settings !== undefined) {
        const merged = mergeSettings(readIfExists(root, harness.settings))
        if (merged.changed) {
          writeSettings(root, harness.settings, merged.text)
          files.push(harness.settings)
        }
      }
      const recorded = recordHarness(readFileSync(configPath(root), 'utf8'), harness.name)
      if (recorded.changed) {
        writeFileSync(configPath(root), recorded.text)
        if (!files.includes('witness.config.yaml')) files.push('witness.config.yaml')
      }
    }

    // Nothing to COMMIT is the same legal silent success as nothing to write. A
    // restamp can restore a file to exactly its HEAD content (an uncommitted pin edit),
    // and `git commit --only` over a pathspec with no diff exits non-zero — which threw
    // out of gitio until Task 9's manual pass caught it. Ask git what actually changed
    // rather than assuming every file we touched is dirty.
    const dirty = files.length > 0
      ? new Set(tryGit(root, 'status', '--porcelain', '--', ...files).out
          .split('\n').filter((l) => l !== '').map((l) => l.slice(3).trim()))
      : new Set<string>()
    const staged = files.filter((rel) => dirty.has(rel))
    if (staged.length > 0) {
      const subject = scaffolded
        ? `init(${harness?.name ?? '?'}): agent payloads`
        : 'init: witness scaffold'
      const commit = commitWithTrailer(root, staged, subject)
      if (!commit.ok) {
        renderRefusal(commit.violations).forEach(ctx.err)
        return EXIT.REFUSED
      }
    }

    if (!scaffolded) {
      ctx.out(kv('initialized', root))
      ctx.out(kv('canon', 'specs/principles.md (draft)'))
    }
    if (harness !== undefined) {
      ctx.out(kv('agent', harness.name))
      ctx.out(kv('payload', files.length > 0 ? files.join(' · ') : 'already installed'))
      // Never silent: a file we chose not to touch is a file that may now be a version
      // behind the CLI running this command.
      if (synced && synced.modified.length > 0) {
        ctx.out(kv('payload-modified', `${synced.modified.join(' · ')} — locally edited, left alone`))
      }
      // Revision 4: surface the prerequisite at the one moment the human can act on it
      // cheaply. A note, not a refusal — a machine may legitimately author without ever
      // running gates, and blocking init there would be wrong.
      if (!probe('claude', ['--version'], ctx.env)) {
        ctx.out('note: the claude CLI is required for gates on every harness — install and authenticate it')
      }
      // Revision 6: silent-guard prevention. Prompts are self-revealing when trust is
      // declined (/witness simply is not there); the guard is not.
      if (harness.name === 'pi') {
        ctx.out('note: pi loads .pi/prompts and .pi/extensions only after the project is trusted — decline it and both /witness and the canon guard are absent')
      }
    }
    ctx.out(scaffolded ? 'next: witness next' : 'next: witness recap --file <recap.json>')
    return EXIT.OK
  } finally {
    lock.value()
  }
}
