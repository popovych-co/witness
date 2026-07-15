import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { configPath } from '../config.js'
import { writeDoc } from '../fm.js'
import { commitWithTrailer, primaryRoot } from '../gitio.js'
import { acquireLock } from '../lock.js'
import { renderRefusal, v } from '../refusal.js'
import { kv } from '../toon.js'

const DEFAULT_CONFIG = `# specflow.config.yaml — the whole surface
schema: 1
gates:
  model: claude-fable-5      # reviewer model pin — exact id, aliases refused
  # any gate block may pin its own model (wins over the global pin), e.g.
  # decompose: { reviewers: [slicing-critic], model: claude-opus-4-8 }
  decompose: { reviewers: [slicing-critic] }
  plan: { reviewers: [plan-critic] }
  implement:
    reviewers:               # per change class; a plain list = all classes
      feature: [code-reviewer, silent-failure-hunter, type-design, pr-test]
      fix: [code-reviewer, silent-failure-hunter]
      chore: [code-reviewer]
  ship: { reviewers: [drift-reviewer, code-reviewer] }
criteria:
  runner: 'npm test -- -t "@spec:{id}"'   # or: runner: full-suite + report: junit:**/reports/junit.xml
ship: { test: "npm test", lint: "npm run lint", branch: main }
`

const GITIGNORE_BLOCK = `# specflow local (never committed)
.specflow/lock
.specflow/txn.json
.specflow/allow.json
.specflow/calibration.local.yaml
`

const PRINCIPLES_BODY = `# Principles

Repo-wide rules and trade-offs. Amend via \`specflow write\`; chores may name
this doc as their plan's parent.
`

export async function run(ctx: Ctx): Promise<number> {
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) {
    renderRefusal(rootRes.violations).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const root = rootRes.value
  if (existsSync(configPath(root))) {
    renderRefusal([v('specflow.config.yaml', 'already-initialized', 'config exists', 'specflow is already set up here')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const lock = acquireLock(root)
  if (!lock.ok) {
    renderRefusal(lock.violations).forEach(ctx.err)
    return EXIT.BLOCKED
  }
  try {
    writeFileSync(configPath(root), DEFAULT_CONFIG)
    mkdirSync(join(root, 'plans'), { recursive: true })
    mkdirSync(join(root, '.specflow', 'journal'), { recursive: true })
    writeFileSync(join(root, 'plans', '.gitkeep'), '')
    writeFileSync(join(root, '.specflow', 'journal', '.gitkeep'), '')
    const gi = join(root, '.gitignore')
    const existing = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
    if (!existing.includes('.specflow/lock')) {
      writeFileSync(gi, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + GITIGNORE_BLOCK)
    }
    writeDoc(join(root, 'specs', 'principles.md'), {
      meta: { id: 'principles', type: 'principles', status: 'draft', depends: [], needs: [] },
      body: PRINCIPLES_BODY,
    })
    const commit = commitWithTrailer(
      root,
      ['specflow.config.yaml', '.gitignore', 'specs/principles.md', 'plans/.gitkeep', '.specflow/journal/.gitkeep'],
      'init: specflow scaffold',
    )
    if (!commit.ok) {
      renderRefusal(commit.violations).forEach(ctx.err)
      return EXIT.REFUSED
    }
    ctx.out(kv('initialized', root))
    ctx.out(kv('canon', 'specs/principles.md (draft)'))
    ctx.out('next: specflow recap --file <recap.json>')
    return EXIT.OK
  } finally {
    lock.value()
  }
}
