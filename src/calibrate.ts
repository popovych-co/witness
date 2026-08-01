import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { main, type Ctx } from './cli.js'
import { loadConfig } from './config.js'
import { changedFiles, diffBase, evidenceForDiff } from './evidence.js'
import { readDoc, splitDoc, writeDoc } from './fm.js'
import { git, stateCommit } from './gitio.js'
import type { Harness, HarnessName } from './harness.js'
import { ok, refuse, v, type Result } from './refusal.js'
import { PROMPT_NAMES, invokeReviewer, parseVerdictText, resolvePrompt } from './reviewer.js'
import type { InvokeExtras } from './reviewer.js'
import { findById, loadCanon } from './scan.js'
import { anchorMenu, parseVerdict, verdictViolations, type Reviewed } from './verdict.js'
import { createWorktree } from './worktree.js'

export interface CalSeed { id: string; overlay: string; defect: string }
export interface ReviewerSuite { reviewer: string; kind: 'docs' | 'tree' | 'screens'; dir: string; seeds: CalSeed[]; injects: CalSeed[] }
export interface SideScore { ok: number; total: number }
export interface ReviewerScore { reviewer: string; catches: SideScore; clean: SideScore; inject: SideScore; pass: boolean }
export interface SkillScore { skill: string; metric: string; ok: number; total: number; pass: boolean }
export interface CalReport { model: string; reviewers: ReviewerScore[]; skills: SkillScore[] }

export function calibrationDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'calibration')
}

function seedList(group: string): (dir: string) => CalSeed[] {
  return (dir) => {
    const g = join(dir, group)
    if (!existsSync(g)) return []
    return readdirSync(g)
      .filter((n) => statSync(join(g, n)).isDirectory())
      .sort()
      .map((id) => ({
        id,
        overlay: join(g, id, 'overlay'),
        defect: (JSON.parse(readFileSync(join(g, id, 'expect.json'), 'utf8')) as { defect: string }).defect,
      }))
  }
}

export function loadReviewerSuite(reviewer: string): Result<ReviewerSuite> {
  const dir = join(calibrationDir(), 'reviewers', reviewer)
  if (!existsSync(join(dir, 'suite.json'))) {
    return refuse([v('reviewer', 'unknown-suite', reviewer, `one of: ${PROMPT_NAMES.join(' ')}`)])
  }
  const kind = (JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8')) as { kind: 'docs' | 'tree' | 'screens' }).kind
  return ok({ reviewer, kind, dir, seeds: seedList('seeds')(dir), injects: seedList('inject')(dir) })
}

function walkRel(root: string, prefix = ''): string[] {
  return readdirSync(root)
    .sort()
    .flatMap((name) => {
      const p = join(root, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      return statSync(p).isDirectory() ? walkRel(p, rel) : [rel]
    })
}

export function materialize(suite: ReviewerSuite, overlay?: string): { dir: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), `cal-${suite.reviewer}-`))
  cpSync(join(suite.dir, 'base'), dir, { recursive: true })
  if (overlay !== undefined) cpSync(overlay, dir, { recursive: true, force: true })
  return { dir, files: walkRel(dir) }
}

export function composeReviewed(
  suite: ReviewerSuite,
  dir: string,
  files: string[],
): { reviewed: Exclude<Reviewed, { kind: 'design' }>; context: string } {
  if (suite.kind === 'tree') return { reviewed: { kind: 'tree', root: dir, files }, context: '' }
  if (suite.kind === 'screens') {
    const captures = files.filter((f) => f.endsWith('.png')).map((f) => ({ name: f.split('/').pop() as string, path: join(dir, f) }))
    return { reviewed: { kind: 'screens', captures }, context: '' }
  }
  const docs = files
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const body = readFileSync(join(dir, f), 'utf8')
      const filenameId = f.replace(/\.md$/, '').split('/').pop() as string
      // Prefer the doc's own frontmatter id (matches production: gates/decompose.ts
      // and gates/plan.ts both derive Reviewed.docs[].id from CanonDoc.meta.id, never
      // the filename). Fixture files that carry a canon-doc id in frontmatter must
      // resolve the same way calibration measures, or the model's natural anchors
      // (which follow the id it reads, not the file it came from) never resolve.
      const parsed = splitDoc(body)
      const metaId = parsed.ok ? parsed.value.meta.id : undefined
      const id = typeof metaId === 'string' && metaId !== '' ? metaId : filenameId
      return { id, body }
    })
  const context = files
    .filter((f) => f.endsWith('.json'))
    .map((f) => `### ${f}\n\n${readFileSync(join(dir, f), 'utf8')}`)
    .join('\n\n')
  return { reviewed: { kind: 'docs', docs }, context }
}

export function renderReviewed(reviewed: Exclude<Reviewed, { kind: 'design' }>, context: string): string {
  const parts: string[] = []
  if (context !== '') parts.push(`## Calibration context\n\n${context}`)
  parts.push('## Reviewed content')
  if (reviewed.kind === 'screens') {
    parts.push('Read each PNG at its absolute path with the Read tool before judging:')
    for (const c of reviewed.captures) parts.push(`- ${c.name} — ${c.path}`)
    return parts.join('\n\n')
  }
  if (reviewed.kind === 'docs') {
    for (const d of reviewed.docs) parts.push(`### ${d.id}\n\n${d.body}`)
  } else {
    for (const f of reviewed.files) {
      parts.push(`### ${f}\n\n\`\`\`\n${readFileSync(join(reviewed.root, f), 'utf8')}\`\`\``)
    }
  }
  return parts.join('\n\n')
}

export function distribute(samples: number, buckets: number): number[] {
  const out = new Array<number>(buckets).fill(0)
  for (let i = 0; i < samples; i += 1) out[i % buckets]! += 1
  return out
}

export const threshold = (samples: number): number => Math.ceil(0.9 * samples)
export const injectSamples = (samples: number): number => Math.max(2, Math.ceil(samples / 5))

export function runSample(
  ctx: Ctx,
  harness: Harness,
  model: string,
  lens: string,
  suite: ReviewerSuite,
  overlay?: string,
  extras?: InvokeExtras,
): Result<{ valid: boolean; blocking: number; why: string }> {
  const { dir, files } = materialize(suite, overlay)
  const { reviewed, context } = composeReviewed(suite, dir, files)
  // same anchor-menu injection as the gate path — calibration must measure the
  // prompt condition production reviewers actually see
  const menu = anchorMenu(reviewed)
  const prompt = `${lens}\n\n${menu ? `${menu}\n\n` : ''}${renderReviewed(reviewed, context)}\n`
  const invoked = invokeReviewer(ctx, harness, { cwd: dir, prompt, model, ...extras })
  if (!invoked.ok) return invoked // invocation-layer failure aborts the run
  const raw = parseVerdictText(invoked.value.text)
  if (!raw.ok) return ok({ valid: false, blocking: 0, why: 'verdict-unparseable' })
  const verdict = parseVerdict(raw.value)
  if (!verdict.ok) return ok({ valid: false, blocking: 0, why: 'verdict-shape' })
  const violations = verdictViolations(verdict.value, reviewed)
  if (violations.length > 0) return ok({ valid: false, blocking: 0, why: `malformed: ${violations[0]!.rule}` })
  const blocking = verdict.value.findings.filter((f) => f.blocking).length
  return ok({ valid: true, blocking, why: blocking > 0 ? 'blocking findings' : 'clean' })
}

function side(): SideScore {
  return { ok: 0, total: 0 }
}

export async function runReviewerSuite(ctx: Ctx, harness: Harness, model: string, reviewer: string, samples: number, extras?: InvokeExtras): Promise<Result<ReviewerScore>> {
  const suiteR = loadReviewerSuite(reviewer)
  if (!suiteR.ok) return suiteR
  const suite = suiteR.value
  const lensR = resolvePrompt(reviewer)
  if (!lensR.ok) return lensR
  const lens = lensR.value.contents
  const catches = side()
  const clean = side()
  const inject = side()
  // Deterministic call order (fake-reviewer scripting relies on it):
  // defect seeds (sorted, round-robin) → injects (sorted, injectSamples each) → clean runs.
  const perSeed = distribute(samples, suite.seeds.length)
  for (const [i, seed] of suite.seeds.entries()) {
    for (let n = 0; n < perSeed[i]!; n += 1) {
      const s = runSample(ctx, harness, model, lens, suite, seed.overlay, extras)
      if (!s.ok) return s
      catches.total += 1
      if (s.value.valid && s.value.blocking > 0) catches.ok += 1
    }
  }
  for (const seed of suite.injects) {
    for (let n = 0; n < injectSamples(samples); n += 1) {
      const s = runSample(ctx, harness, model, lens, suite, seed.overlay, extras)
      if (!s.ok) return s
      inject.total += 1
      if (s.value.valid && s.value.blocking > 0) inject.ok += 1
    }
  }
  for (let n = 0; n < samples; n += 1) {
    const s = runSample(ctx, harness, model, lens, suite, undefined, extras)
    if (!s.ok) return s
    clean.total += 1
    if (s.value.valid && s.value.blocking === 0) clean.ok += 1
  }
  const pass = catches.ok >= threshold(catches.total) && clean.ok >= threshold(clean.total) && inject.ok === inject.total
  return ok({ reviewer, catches, clean, inject, pass })
}

export async function runReviewerSuites(ctx: Ctx, harness: Harness, model: string, samples: number, only?: string, extras?: InvokeExtras): Promise<Result<ReviewerScore[]>> {
  const names = [...PROMPT_NAMES].sort().filter((n) => only === undefined || n === only)
  if (names.length === 0) return refuse([v('--only', 'unknown-reviewer', only ?? '', PROMPT_NAMES.join(' '))])
  const scores: ReviewerScore[] = []
  for (const name of names) {
    const r = await runReviewerSuite(ctx, harness, model, name, samples, extras)
    if (!r.ok) return r
    scores.push(r.value)
  }
  return ok(scores)
}

export const reportPass = (r: CalReport): boolean => r.reviewers.every((x) => x.pass) && r.skills.every((x) => x.pass)

export function aggregate(r: CalReport): number {
  let okCount = 0
  let total = 0
  for (const s of r.reviewers) {
    okCount += s.catches.ok + s.clean.ok + s.inject.ok
    total += s.catches.total + s.clean.total + s.inject.total
  }
  for (const s of r.skills) {
    okCount += s.ok
    total += s.total
  }
  return total === 0 ? 0 : okCount / total
}

export const localOverlayPath = (root: string): string => join(root, '.witness', 'calibration.local.yaml')

export function addToLocalOverlay(root: string, model: string, harness: HarnessName): void {
  const path = localOverlayPath(root)
  const current = existsSync(path)
    ? (parse(readFileSync(path, 'utf8')) as { models?: string[]; matrices?: Record<string, { models?: string[] }> })
    : {}
  const matrices = current.matrices ?? {}
  const models = matrices[harness]?.models ?? []
  if (!models.includes(model)) models.push(model)
  matrices[harness] = { models }
  mkdirSync(dirname(path), { recursive: true })
  // legacy top-level `models:` (claude-code measurements) is preserved verbatim
  writeFileSync(path, stringify({ ...current, matrices }))
}

// --- Skill-suite half (stage-skill calibration contracts) ---

export const SKILL_NAMES = ['decompose', 'plan', 'implement'] as const

export interface SkillExpect { forbid?: string[]; expect_amend?: string[]; expect_extraction?: boolean; expect_empty?: boolean }
export interface SkillSeed { id: string; dir: string; expect: SkillExpect }
export interface SkillArtifact { id: string; meta: Record<string, unknown>; body: string }

export function loadSkillSeeds(skill: (typeof SKILL_NAMES)[number]): SkillSeed[] {
  const dir = join(calibrationDir(), 'skills', skill, 'seeds')
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort()
    .map((id) => {
      const seedDir = join(dir, id)
      const expectPath = join(seedDir, 'expect.json')
      const expect = existsSync(expectPath) ? (JSON.parse(readFileSync(expectPath, 'utf8')) as SkillExpect) : {}
      return { id, dir: seedDir, expect }
    })
}

export function skillMdPath(stage: (typeof SKILL_NAMES)[number]): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'skills', `witness-${stage}`, 'SKILL.md')
}

export const NONINTERACTIVE_OVERRIDE = `## Calibration override

You are running non-interactively for calibration. Ignore every instruction
above that says to run commands, ask questions, invoke skills, or use tools —
you cannot. Author the artifact(s) you would hand to \`witness write\` and
output ONLY this JSON object, no prose before or after it:

{"artifacts": [{"id": "<artifact-id>", "meta": { ...the manifest JSON... }, "body": "<the markdown body>"}]}

An empty set is \`{"artifacts": []}\`. The meta object is exactly what you would
put in the --meta file; the body string is exactly what you would put in the
--body file.`

export function artifactsEnvelope(raw: unknown): Result<SkillArtifact[]> {
  const bad = (): Result<SkillArtifact[]> =>
    refuse([v('envelope', 'shape', JSON.stringify(raw).slice(0, 200), '{ "artifacts": [{id, meta, body}] }')])
  if (typeof raw !== 'object' || raw === null) return bad()
  const artifacts = (raw as { artifacts?: unknown }).artifacts
  if (!Array.isArray(artifacts)) return bad()
  const out: SkillArtifact[] = []
  for (const a of artifacts) {
    const e = a as { id?: unknown; meta?: unknown; body?: unknown }
    if (typeof e.id !== 'string' || e.id === '' || typeof e.meta !== 'object' || e.meta === null || typeof e.body !== 'string') {
      return bad()
    }
    out.push({ id: e.id, meta: e.meta as Record<string, unknown>, body: e.body })
  }
  return ok(out)
}

// Captures a Ctx with buffered out/err so a seeded CLI call can be inspected.
// (Named captureCtx, not harness: the Harness registry owns that noun now.)
function captureCtx(cwd: string, env: Record<string, string | undefined>): { ctx: Ctx; out(): string; err(): string } {
  const outs: string[] = []
  const errs: string[] = []
  const ctx: Ctx = { cwd, env, isTTY: false, out: (l) => outs.push(l), err: (l) => errs.push(l), ask: async () => '' }
  return { ctx, out: () => outs.join('\n'), err: () => errs.join('\n') }
}

export function seedScratchRepo(prefix: string): { root: string } {
  const root = mkdtempSync(join(tmpdir(), `cal-${prefix}-`))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'witness-calibration')
  git(root, 'config', 'user.email', 'calibration@witness.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(
    join(root, 'witness.config.yaml'),
    // No path argument at all — the only form portable across our engines range. A bare
    // `tests/` arg is resolved as a module path on Node 24, and a glob is taken literally
    // on Node 20 ("Could not find 'tests/**/*.test.mjs'": glob args landed in Node 21),
    // which silently scores every implement sample 0. Node's default discovery already
    // walks the repo for *.test.mjs and skips node_modules.
    'schema: 1\ncriteria:\n  runner: \'node --test --test-name-pattern "@spec:{id}"\'\n',
  )
  writeFileSync(
    join(root, '.gitignore'),
    '.witness/lock\n.witness/allow.json\n.witness/calibration.local.yaml\n.witness/worktrees/\n',
  )
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'seed')
  return { root }
}

export function seedCanonDoc(root: string, id: string, content: string): void {
  const doc = splitDoc(content)
  if (!doc.ok) throw new Error(`unparseable canon seed doc: ${id}`)
  const rel = `${doc.value.meta.type === 'plan' ? 'plans' : 'specs'}/${id}.md`
  writeDoc(join(root, rel), doc.value)
  const res = stateCommit(root, [rel], `seed: canon(${id})`)
  if (!res.ok) throw new Error(`seed canon commit failed: ${id}: ${res.violations.map((x) => x.rule).join(',')}`)
}

export function seedStatus(root: string, id: string, status: string): void {
  const rel = existsSync(join(root, 'specs', `${id}.md`)) ? `specs/${id}.md` : `plans/${id}.md`
  const doc = readDoc(join(root, rel))
  if (!doc.ok) throw new Error(`unreadable doc for status seed: ${id}`)
  writeDoc(join(root, rel), { meta: { ...doc.value.meta, status }, body: doc.value.body })
  const res = stateCommit(root, [rel], `seed: status(${id}) -> ${status}`)
  if (!res.ok) throw new Error(`seed status commit failed: ${id}: ${res.violations.map((x) => x.rule).join(',')}`)
}

function firstCriterionTag(meta: { criteria?: unknown }): string {
  const criteria = Array.isArray(meta.criteria) ? (meta.criteria as Array<Record<string, unknown>>) : []
  const withTest = criteria.find((c) => typeof c.test === 'string')
  return withTest ? String(withTest.test).replace(/^@spec:/, '') : ''
}

export async function runDecomposeSeed(ctx: Ctx, harness: Harness, model: string, seed: SkillSeed, extras?: InvokeExtras): Promise<Result<{ ok: boolean; why: string }>> {
  const { root } = seedScratchRepo(`decompose-${seed.id}`)
  const canonDir = join(seed.dir, 'canon')
  if (existsSync(canonDir)) {
    for (const f of readdirSync(canonDir)) seedCanonDoc(root, f.replace(/\.md$/, ''), readFileSync(join(canonDir, f), 'utf8'))
  }

  const recapText = readFileSync(join(seed.dir, 'recap.json'), 'utf8')
  const recap = JSON.parse(recapText) as { effort: string; goals: Array<{ id: string }> }
  writeFileSync(join(root, '.cal-recap.json'), recapText)
  const recapH = captureCtx(root, ctx.env)
  const recapCode = await main(recapH.ctx, ['recap', '--file', '.cal-recap.json'])
  rmSync(join(root, '.cal-recap.json'), { force: true })
  if (recapCode !== 0) return ok({ ok: false, why: `seed recap failed: ${recapH.err()}` })

  const indexH = captureCtx(root, ctx.env)
  await main(indexH.ctx, ['index'])

  const prompt = [
    readFileSync(skillMdPath('decompose'), 'utf8'),
    '## Calibration inputs',
    `### recap.json\n\n${recapText}`,
    `### witness index\n\n${indexH.out()}`,
    NONINTERACTIVE_OVERRIDE,
  ].join('\n\n')

  const invoked = invokeReviewer(ctx, harness, { cwd: root, prompt, model, ...extras })
  if (!invoked.ok) return invoked
  const raw = parseVerdictText(invoked.value.text)
  if (!raw.ok) return ok({ ok: false, why: 'envelope-unparseable' })
  const envelope = artifactsEnvelope(raw.value)
  if (!envelope.ok) return ok({ ok: false, why: `envelope-shape: ${envelope.violations[0]!.rule}` })
  const artifacts = envelope.value

  if (seed.expect.expect_empty) {
    return artifacts.length === 0
      ? ok({ ok: true, why: 'empty envelope as expected' })
      : ok({ ok: false, why: 'expected an empty artifact set for a chore' })
  }

  for (const a of artifacts) {
    const metaTmp = join(root, `.cal-meta-${a.id}.json`)
    const bodyTmp = join(root, `.cal-body-${a.id}.md`)
    writeFileSync(metaTmp, JSON.stringify(a.meta))
    writeFileSync(bodyTmp, a.body)
    const wH = captureCtx(root, ctx.env)
    const code = await main(wH.ctx, ['write', a.id, '--effort', recap.effort, '--meta', `.cal-meta-${a.id}.json`, '--body', `.cal-body-${a.id}.md`])
    rmSync(metaTmp, { force: true })
    rmSync(bodyTmp, { force: true })
    if (code !== 0) return ok({ ok: false, why: `write-refused:${a.id}: ${wH.err()}` })
  }

  if (seed.expect.forbid) {
    const haystack = artifacts.map((a) => `${JSON.stringify(a.meta)}\n${a.body}`).join('\n').toLowerCase()
    const hit = seed.expect.forbid.find((term) => haystack.includes(term.toLowerCase()))
    if (hit) return ok({ ok: false, why: `forbidden term present: ${hit}` })
  }
  if (seed.expect.expect_amend) {
    const got = new Set(artifacts.map((a) => a.id))
    const want = new Set(seed.expect.expect_amend)
    if (got.size !== want.size || [...want].some((id) => !got.has(id))) {
      return ok({ ok: false, why: `expected amend set {${[...want].join(',')}}, got {${[...got].join(',')}}` })
    }
  }
  if (seed.expect.expect_extraction) {
    if (artifacts.length < 3) return ok({ ok: false, why: 'expected extraction: fewer than 3 artifacts emitted' })
    const extracted = artifacts.some((a) => {
      const dependents = artifacts.filter(
        (other) => other.id !== a.id && Array.isArray(other.meta.depends) && (other.meta.depends as unknown[]).includes(a.id),
      )
      return dependents.length >= 2
    })
    if (!extracted) return ok({ ok: false, why: 'no artifact is depended on by >=2 others — the duplicated fact was not extracted' })
  }

  const goalIds = new Set(recap.goals.map((g) => g.id))
  const specArtifacts = artifacts.filter((a) => a.meta.type === 'spec')
  const covered = new Set<string>()
  for (const a of specArtifacts) {
    const covers = Array.isArray(a.meta.covers) ? (a.meta.covers as string[]) : []
    if (covers.length === 0) return ok({ ok: false, why: `spec ${a.id} covers no goal` })
    for (const g of covers) covered.add(g)
  }
  const uncovered = [...goalIds].filter((g) => !covered.has(g))
  if (uncovered.length > 0) return ok({ ok: false, why: `goals uncovered: ${uncovered.join(',')}` })

  return ok({ ok: true, why: 'first-try valid' })
}

export async function runPlanSeed(ctx: Ctx, harness: Harness, model: string, seed: SkillSeed, extras?: InvokeExtras): Promise<Result<{ ok: boolean; why: string }>> {
  const { root } = seedScratchRepo(`plan-${seed.id}`)

  const recapText = readFileSync(join(seed.dir, 'recap.json'), 'utf8')
  const recap = JSON.parse(recapText) as { effort: string }
  writeFileSync(join(root, '.cal-recap.json'), recapText)
  const recapH = captureCtx(root, ctx.env)
  const recapCode = await main(recapH.ctx, ['recap', '--file', '.cal-recap.json'])
  rmSync(join(root, '.cal-recap.json'), { force: true })
  if (recapCode !== 0) return ok({ ok: false, why: `seed recap failed: ${recapH.err()}` })

  const parentMeta = JSON.parse(readFileSync(join(seed.dir, 'parent.meta.json'), 'utf8')) as Record<string, unknown>
  const parentBody = readFileSync(join(seed.dir, 'parent.body.md'), 'utf8')
  const parentId = firstCriterionTag(parentMeta)
  writeFileSync(join(root, '.cal-parent-meta.json'), JSON.stringify(parentMeta))
  writeFileSync(join(root, '.cal-parent-body.md'), parentBody)
  const parentH = captureCtx(root, ctx.env)
  const parentCode = await main(parentH.ctx, ['write', parentId, '--effort', recap.effort, '--meta', '.cal-parent-meta.json', '--body', '.cal-parent-body.md'])
  rmSync(join(root, '.cal-parent-meta.json'), { force: true })
  rmSync(join(root, '.cal-parent-body.md'), { force: true })
  if (parentCode !== 0) return ok({ ok: false, why: `seed parent write failed: ${parentH.err()}` })
  seedStatus(root, parentId, 'approved')

  const diffH = captureCtx(root, ctx.env)
  await main(diffH.ctx, ['diff', parentId])
  const parentRendering = readFileSync(join(root, 'specs', `${parentId}.md`), 'utf8')

  const prompt = [
    readFileSync(skillMdPath('plan'), 'utf8'),
    '## Calibration inputs',
    `### recap.json\n\n${recapText}`,
    `### specs/${parentId}.md\n\n${parentRendering}`,
    `### witness diff ${parentId}\n\n${diffH.out()}`,
    NONINTERACTIVE_OVERRIDE,
  ].join('\n\n')

  const invoked = invokeReviewer(ctx, harness, { cwd: root, prompt, model, ...extras })
  if (!invoked.ok) return invoked
  const raw = parseVerdictText(invoked.value.text)
  if (!raw.ok) return ok({ ok: false, why: 'envelope-unparseable' })
  const envelope = artifactsEnvelope(raw.value)
  if (!envelope.ok) return ok({ ok: false, why: `envelope-shape: ${envelope.violations[0]!.rule}` })
  const artifacts = envelope.value
  const plan = artifacts[0]
  if (artifacts.length !== 1 || !plan || plan.meta.type !== 'plan' || plan.meta.parent !== parentId) {
    return ok({ ok: false, why: `expected exactly one plan artifact with parent ${parentId}, got ${artifacts.length} artifact(s)` })
  }

  const metaTmp = join(root, '.cal-plan-meta.json')
  const bodyTmp = join(root, '.cal-plan-body.md')
  writeFileSync(metaTmp, JSON.stringify(plan.meta))
  writeFileSync(bodyTmp, plan.body)
  const planH = captureCtx(root, ctx.env)
  const code = await main(planH.ctx, ['write', plan.id, '--effort', recap.effort, '--meta', '.cal-plan-meta.json', '--body', '.cal-plan-body.md'])
  rmSync(metaTmp, { force: true })
  rmSync(bodyTmp, { force: true })
  if (code !== 0) return ok({ ok: false, why: `write-refused:${plan.id}: ${planH.err()}` })
  return ok({ ok: true, why: 'first-try valid' })
}

export type AgentRunner = (ctx: Ctx, harness: Harness, worktree: string, prompt: string) => Promise<void>

// Decision 88 (worker half): the implement seed measures the stage skill as the
// RESOLVED harness runs it. A claude-only worker measured a reviewer-routed pipeline's
// other half on the wrong binary — and left `calibrate --only implement` unrunnable for
// a pure-pi user, the residual the routing decision exists to kill.
export async function defaultAgent(ctx: Ctx, harness: Harness, worktree: string, prompt: string): Promise<void> {
  const { cmd, args, env } = harness.worker.spawn(prompt)
  spawnSync(cmd, args, {
    cwd: worktree,
    env: { ...ctx.env, ...env, WITNESS_BIN: `node ${join(dirname(fileURLToPath(import.meta.url)), 'bin.js')}` },
    timeout: 900_000,
    stdio: 'ignore',
  })
}

export async function runImplementSeed(ctx: Ctx, harness: Harness, seed: SkillSeed, agent: AgentRunner): Promise<Result<{ ok: boolean; why: string }>> {
  const { root } = seedScratchRepo(`implement-${seed.id}`)
  cpSync(join(seed.dir, 'repo'), root, { recursive: true })
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'seed: repo')

  const recapText = readFileSync(join(seed.dir, 'recap.json'), 'utf8')
  const recap = JSON.parse(recapText) as { effort: string }
  writeFileSync(join(root, '.cal-recap.json'), recapText)
  const recapH = captureCtx(root, ctx.env)
  const recapCode = await main(recapH.ctx, ['recap', '--file', '.cal-recap.json'])
  rmSync(join(root, '.cal-recap.json'), { force: true })
  if (recapCode !== 0) return ok({ ok: false, why: `seed recap failed: ${recapH.err()}` })

  const specMeta = JSON.parse(readFileSync(join(seed.dir, 'spec.meta.json'), 'utf8')) as Record<string, unknown>
  const specBody = readFileSync(join(seed.dir, 'spec.body.md'), 'utf8')
  const specId = firstCriterionTag(specMeta)
  writeFileSync(join(root, '.cal-spec-meta.json'), JSON.stringify(specMeta))
  writeFileSync(join(root, '.cal-spec-body.md'), specBody)
  const specH = captureCtx(root, ctx.env)
  const specCode = await main(specH.ctx, ['write', specId, '--effort', recap.effort, '--meta', '.cal-spec-meta.json', '--body', '.cal-spec-body.md'])
  rmSync(join(root, '.cal-spec-meta.json'), { force: true })
  rmSync(join(root, '.cal-spec-body.md'), { force: true })
  if (specCode !== 0) return ok({ ok: false, why: `seed spec write failed: ${specH.err()}` })
  seedStatus(root, specId, 'approved')

  const planMeta = JSON.parse(readFileSync(join(seed.dir, 'plan.meta.json'), 'utf8')) as Record<string, unknown>
  const planBody = readFileSync(join(seed.dir, 'plan.body.md'), 'utf8')
  const planId = `${specId}-plan-1`
  writeFileSync(join(root, '.cal-plan-meta.json'), JSON.stringify(planMeta))
  writeFileSync(join(root, '.cal-plan-body.md'), planBody)
  const planH = captureCtx(root, ctx.env)
  const planCode = await main(planH.ctx, ['write', planId, '--effort', recap.effort, '--meta', '.cal-plan-meta.json', '--body', '.cal-plan-body.md'])
  rmSync(join(root, '.cal-plan-meta.json'), { force: true })
  rmSync(join(root, '.cal-plan-body.md'), { force: true })
  if (planCode !== 0) return ok({ ok: false, why: `seed plan write failed: ${planH.err()}` })
  seedStatus(root, planId, 'approved')
  seedStatus(root, planId, 'in-progress')

  const wt = createWorktree(root, planId, 'main')
  if (!wt.ok) return wt

  const prompt = [
    readFileSync(skillMdPath('implement'), 'utf8'),
    planBody,
    'Your working directory IS the worktree; begin at step s1.',
  ].join('\n\n')

  await agent(ctx, harness, wt.value.path, prompt)

  const cfg = loadConfig(wt.value.path)
  if (!cfg.ok) return cfg
  const base = diffBase(wt.value.path, cfg.value)
  if (!base.ok) return base
  // evidenceForDiff's required-tags array is empty (and .every() vacuously true) when
  // nothing changed — an idle agent must not read as "satisfied" for lack of anything to check.
  if (changedFiles(wt.value.path, base.value).length === 0) {
    return ok({ ok: false, why: 'no changes vs base — the agent made no diff' })
  }
  const planDoc = findById(loadCanon(root), planId)
  if (!planDoc) return refuse([v('plan', 'seed-plan-missing', planId, 'the plan just written by the seed')])
  const report = evidenceForDiff(wt.value.path, root, planDoc, base.value)
  return ok({ ok: report.satisfied, why: report.satisfied ? 'evidence satisfied' : JSON.stringify(report.required) })
}

export async function runSkillSuites(
  ctx: Ctx, harness: Harness, model: string, samples: number,
  opts: { only?: string; agent?: AgentRunner; extras?: InvokeExtras } = {},
): Promise<Result<SkillScore[]>> {
  const only = opts.only
  const agent = opts.agent ?? defaultAgent
  const scores: SkillScore[] = []

  if (only === undefined || only === 'decompose') {
    const seeds = loadSkillSeeds('decompose')
    const perSeed = distribute(samples, seeds.length)
    let okCount = 0
    let total = 0
    for (const [i, seed] of seeds.entries()) {
      for (let n = 0; n < perSeed[i]!; n += 1) {
        const r = await runDecomposeSeed(ctx, harness, model, seed, opts.extras)
        if (!r.ok) return r
        total += 1
        if (r.value.ok) okCount += 1
      }
    }
    scores.push({ skill: 'decompose', metric: 'first-try-valid', ok: okCount, total, pass: okCount >= threshold(total) })
  }
  if (only === undefined || only === 'plan') {
    const seeds = loadSkillSeeds('plan')
    const perSeed = distribute(samples, seeds.length)
    let okCount = 0
    let total = 0
    for (const [i, seed] of seeds.entries()) {
      for (let n = 0; n < perSeed[i]!; n += 1) {
        const r = await runPlanSeed(ctx, harness, model, seed, opts.extras)
        if (!r.ok) return r
        total += 1
        if (r.value.ok) okCount += 1
      }
    }
    scores.push({ skill: 'plan', metric: 'first-try-valid', ok: okCount, total, pass: okCount >= threshold(total) })
  }
  if (only === undefined || only === 'implement') {
    const seeds = loadSkillSeeds('implement')
    let okCount = 0
    for (const seed of seeds) {
      const r = await runImplementSeed(ctx, harness, seed, agent)
      if (!r.ok) return r
      if (r.value.ok) okCount += 1
    }
    scores.push({ skill: 'implement', metric: 'red-green-evidence', ok: okCount, total: seeds.length, pass: okCount === seeds.length })
  }
  return ok(scores)
}

export function publishScore(pkgRoot: string, model: string, report: CalReport): Result<{ path: string }> {
  const pkgPath = join(pkgRoot, 'package.json')
  const name = existsSync(pkgPath) ? (JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }).name : undefined
  if (name !== '@popovych.co/witness') return refuse([v('--publish', 'not-package-repo', name ?? 'no package.json', 'run inside the witness repo')])
  const resultsDir = join(pkgRoot, 'calibration-results')
  mkdirSync(resultsDir, { recursive: true })
  const scorePath = join(resultsDir, `${model}.json`)
  writeFileSync(scorePath, `${JSON.stringify({ model, aggregate: aggregate(report), report }, null, 2)}\n`)
  const matrixPath = join(pkgRoot, 'calibration.yaml')
  const previous = existsSync(matrixPath) ? ((parse(readFileSync(matrixPath, 'utf8')) as { models?: string[] }).models ?? []) : []
  const scored = readdirSync(resultsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(resultsDir, f), 'utf8')) as { model: string; aggregate: number })
    .sort((a, b) => b.aggregate - a.aggregate)
    .map((s) => s.model)
  const models = [...scored, ...previous.filter((m) => !scored.includes(m))]
  writeFileSync(matrixPath, stringify({ models }))
  return ok({ path: scorePath })
}
