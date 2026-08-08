import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { adoptedCommits } from '../adopt.js'
import { EXIT, version, type Ctx } from '../cli.js'
import { DEFAULT_HARNESS, HARNESSES, judgeLine, loadHarness, resolveJudge, resolveSkills, skillPins } from '../harness.js'
import { packageRoot } from '../install.js'
import { latestPublished } from '../registry.js'
import { NPX_LATEST, compareTriple } from '../version.js'
import { probe } from '../probe.js'
import { loadConfig, loadLocalConfig, localConfigPath } from '../config.js'
import { designPending } from '../design.js'
import { runDrift } from '../drift.js'
import { auditStateCommits, dirtyStatePaths, primaryRoot, tryGit } from '../gitio.js'
import { contentAtSha } from '../history.js'
import { effortStreams, readStream } from '../journal.js'
import { sourceTags } from '../matcher.js'
import { modelFloorLines } from '../model.js'
import { evaluateNeeds } from '../needs.js'
import { renderRefusal } from '../refusal.js'
import { pendingDecision } from '../rounds.js'
import { criteriaExcludes } from '../runner.js'
import { findById, findCycle, loadCanon } from '../scan.js'
import { canonicalSha } from '../sha.js'
import { lazyStamp } from '../stamp.js'
import { kv, rows } from '../toon.js'
import { pendingTxn } from '../txn.js'
import { listWorktrees, worktreePath } from '../worktree.js'

interface Finding {
  level: 'error' | 'warn'
  area: string
  field: string
  rule: string
  detail: string
}

const f = (level: Finding['level'], area: string, field: string, rule: string, detail: string): Finding =>
  ({ level, area, field, rule, detail })

export async function run(ctx: Ctx, argv: string[] = []): Promise<number> {
  if (argv.includes('--drift')) return runDrift(ctx, argv)
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const findings: Finding[] = []
  // Absence keeps at most ONE answer for the whole repo, and it is a stated line rather
  // than a finding (row 104): a permanent warning row for every correctly-configured
  // plugin user costs attention on every run, and row 87's frequency argument holds.
  const payloadAbsent: string[] = []
  const skillsAbsent: string[] = []

  const cfg = loadConfig(root)
  if (!cfg.ok) cfg.violations.forEach((x) => findings.push(f('error', 'config', x.field, x.rule, x.got)))
  else if (cfg.value.warning) findings.push(f('warn', 'config', 'schema', 'older-schema', cfg.value.warning))

  // Machine config is read here as FINDINGS, never a refusal — same doctrine that
  // keeps harness resolution out of loadConfig (row 87): check must be able to
  // report a broken machine file rather than brick on it.
  const local = loadLocalConfig(root)
  if (!local.ok) {
    local.violations.forEach((x) => findings.push(f('error', 'local-config', x.field, x.rule, x.got)))
  } else {
    for (const p of local.value.reviewerExtensions) {
      if (!existsSync(p)) findings.push(f('warn', 'local-config', 'reviewerExtensions', 'extension-path-missing', p))
    }
  }
  // init's gitignore write is scaffold-once, so pre-0.5.0 repos never receive the new
  // ignore line — this finding is their honest path to it.
  if (existsSync(localConfigPath(root)) && !tryGit(root, 'check-ignore', '-q', '--', '.witness/config.local.yaml').ok) {
    findings.push(f('warn', 'local-config', '.witness/config.local.yaml', 'local-config-unignored',
      'machine-local file — add it to .gitignore'))
  }

  const canon0 = loadCanon(root)
  const lazy = lazyStamp(root, ctx, canon0)
  const canon = lazy.stamped.length > 0 ? loadCanon(root) : canon0
  canon.errors.forEach((x) => findings.push(f('error', 'parse', x.field, x.rule, x.got)))
  for (const doc of canon.docs) {
    doc.violations.forEach((x) => findings.push(f('error', 'schema', `${doc.rel}: ${x.field}`, x.rule, x.got)))
  }

  const byId = new Map<string, number>()
  canon.docs.forEach((d) => byId.set(String(d.meta.id), (byId.get(String(d.meta.id)) ?? 0) + 1))
  for (const [id, count] of byId) {
    if (count > 1) findings.push(f('error', 'graph', id, 'duplicate-id', `${count} docs carry this id`))
  }
  for (const doc of canon.docs) {
    const depends = Array.isArray(doc.meta.depends) ? (doc.meta.depends as string[]) : []
    depends.forEach((dep) => {
      if (!findById(canon, dep)) findings.push(f('error', 'graph', `${doc.rel}: depends`, 'unknown-dep', dep))
    })
  }
  const cycle = findCycle(canon)
  if (cycle) findings.push(f('error', 'graph', 'depends', 'cycle', cycle.join(' -> ')))

  for (const plan of canon.docs.filter((d) => d.meta.type === 'plan')) {
    const parent = typeof plan.meta.parent === 'string' ? findById(canon, plan.meta.parent) : undefined
    if (!parent) {
      findings.push(f('error', 'invariants', `${plan.rel}: parent`, 'unknown-parent', String(plan.meta.parent)))
      continue
    }
    if (plan.meta.status !== 'draft' && plan.meta.status !== 'abandoned' && parent.meta.status === 'draft') {
      findings.push(f('error', 'invariants', `${plan.rel}: status`, 'status-pairing', `plan is ${plan.meta.status} but parent is draft`))
    }
    const pin = plan.meta['derives-from']
    if (typeof pin === 'string' && !contentAtSha(root, parent.rel, pin)) {
      findings.push(f('error', 'invariants', `${plan.rel}: derives-from`, 'pin-unresolvable', `no committed version of ${parent.rel} matches ${pin.slice(0, 7)}`))
    }
  }

  for (const plan of canon.docs.filter((d) => d.meta.type === 'plan')) {
    const id = String(plan.meta.id)
    if (String(plan.meta.status) === 'in-progress') {
      const parent = findById(canon, String(plan.meta.parent))
      if (parent && canonicalSha(parent.meta, parent.body) !== String(plan.meta['derives-from'])) {
        findings.push(f('warn', 'motion', id, 'mid-flight-amendment',
          `parent ${String(parent.meta.id)} moved off the pin — ship will re-verify against current content`))
      }
      if (!existsSync(worktreePath(root, id))) {
        findings.push(f('warn', 'motion', id, 'missing-worktree', `witness start ${id} recreates it`))
      }
    }
    for (const gate of ['plan', 'implement', 'ship']) {
      if (pendingDecision(readStream(root, id), gate)) {
        findings.push(f('warn', 'motion', id, 'gate-awaiting-decision', `witness decide ${gate} ${id} --show`))
      }
    }
  }
  for (const slug of effortStreams(root)) {
    if (pendingDecision(readStream(root, slug), 'decompose')) {
      findings.push(f('warn', 'motion', slug, 'gate-awaiting-decision', `witness decide decompose ${slug} --show`))
    }
  }
  for (const spec of canon.docs.filter((d) => d.meta.type === 'spec')) {
    const id = String(spec.meta.id)
    if (pendingDecision(readStream(root, id), 'design')) {
      findings.push(f('warn', 'motion', id, 'gate-awaiting-decision', `witness decide design ${id} --show`))
    }
    if (designPending(root, spec) && String(spec.meta.status) === 'approved') {
      findings.push(f('warn', 'motion', id, 'design-pending', `ui spec owes a design — witness design ${id} --file <html>`))
    }
  }
  for (const planId of listWorktrees(root)) {
    const doc = findById(canon, planId)
    if (!doc || ['done', 'abandoned'].includes(String(doc.meta.status))) {
      findings.push(f('warn', 'motion', planId, 'stray-worktree', 'witness clean sweeps it'))
    }
  }

  for (const doc of canon.docs) {
    const needs = Array.isArray(doc.meta.needs) ? doc.meta.needs : []
    if (needs.length === 0) continue
    for (const r of await evaluateNeeds(root, ctx, needs)) {
      if (r.status === 'ok') continue
      const rule = r.status === 'unmet' ? 'need-unmet' : `need-${r.status}`
      findings.push(f('warn', 'needs', `${doc.rel}: ${r.label}`, rule, r.detail))
    }
  }

  const absolved = adoptedCommits(root)
  auditStateCommits(root).forEach((c) => {
    if (!c.trailered && !absolved.has(c.sha)) {
      findings.push(f('error', 'audit', c.sha.slice(0, 7), 'untrailered-commit', `${c.subject} — adopt: witness adopt <path> · or revert`))
    }
  })
  if (pendingTxn(root)) {
    findings.push(f('error', 'audit', '.witness/txn.json', 'pending-txn', 'crashed invocation — witness recover --complete | --rollback'))
  } else if (dirtyStatePaths(root).length) {
    dirtyStatePaths(root).forEach((p) => findings.push(f('error', 'audit', p, 'hand-edit-in-progress', 'uncommitted change on a state path — adopt: witness adopt <path> · or revert')))
  }

  const journalDir = join(root, '.witness', 'journal')
  if (existsSync(journalDir)) {
    for (const file of readdirSync(journalDir)) {
      if (!file.endsWith('.jsonl')) continue
      const id = file.slice(0, -'.jsonl'.length)
      const entries = readStream(root, id)
      if (entries[0]?.t === 'recap') continue
      if (!findById(canon, id)) findings.push(f('warn', 'journal', file, 'orphan-journal', 'stream matches no doc (frozen lineage or stray)'))
    }
  }

  if (cfg.ok) {
    const src = sourceTags(root, criteriaExcludes(cfg.value))
    for (const [tag, files] of src.files) {
      if (!findById(canon, tag)) {
        findings.push(f('warn', 'criteria', tag, 'orphan-tag', `${files[0] ?? '?'} tags a spec that does not exist`))
      }
    }
  }

  if (!probe('gh', ['--version'], ctx.env)) findings.push(f('warn', 'probes', 'gh', 'missing', 'PR operations (later slice) will stop loudly'))
  else if (!probe('gh', ['auth', 'status'], ctx.env)) findings.push(f('warn', 'probes', 'gh', 'unauthenticated', 'run gh auth login'))

  if (cfg.ok) {
    for (const [key, paths] of Object.entries(cfg.value.docs)) {
      for (const p of paths ?? []) {
        if (!existsSync(join(root, p))) {
          findings.push(f('error', 'config', `docs.${key}`, 'doc-missing', `${p} — gates inject configured docs fail-closed`))
        }
      }
    }
  }

  // `harness:` is rung ONE of the judgment ladder (which binary judges this repo) and
  // rung TWO of the session ladder (which CLI is about to be typed at), so a typo brings
  // judgment down everywhere while still being invisible to launch lines on a machine
  // with a detection var. check is the diagnostic verb: it reports the value regardless
  // of who answered, and it is the ONLY reporter — resolveJudge can fail on exactly this
  // input, so pushing its violations too would say one thing twice.
  const configuredHarness = cfg.ok ? cfg.value.raw.harness : undefined
  if (configuredHarness !== undefined && !(HARNESSES as readonly string[]).includes(String(configuredHarness))) {
    findings.push(f('error', 'config', 'harness', 'unknown-harness',
      `${String(configuredHarness)} — expected ${HARNESSES.join(' | ')}`))
  }

  const judgeR = resolveJudge(ctx.env, cfg.ok ? cfg.value.raw : {})
  if (judgeR.ok) {
    // Row 104/105: the probe asks whether THIS MACHINE can run THIS REPO's reviewers, so
    // it follows the judge — which is why it kept a harness resolution when row 104 took
    // one away from the audit. An unresolvable judge has no binary to probe.
    const launch = judgeR.value.harness.launch
    if (!probe(launch, ['--version'], ctx.env)) {
      findings.push(f('warn', 'probes', launch, 'missing',
        `the ${launch} CLI runs this harness's gate reviewers — install and authenticate it`))
    }
  }

  // Row 103: ONE query, both halves of the skew. Best-effort and silent on every failure
  // — `undefined` means "we do not know", which is never a finding, because an
  // air-gapped machine must report nothing about the network rather than a complaint
  // about it. Warn level only: check's exit code is a contract about canon validity
  // (row 101), and nothing here may move it.
  const latest = await latestPublished(ctx.env)
  const behind = (pin: string): boolean =>
    latest !== undefined && (compareTriple(pin, latest) ?? 0) < 0
  if (latest !== undefined && behind(version())) {
    findings.push(f('warn', 'harness', 'cli', 'cli-behind',
      `running ${version()}, published latest is ${latest} — every invocation surface pins the CLI, so upgrade with ${NPX_LATEST} init --agent <name>`))
  }

  // Row 104. `check` printed `0 errors` in a repo whose .pi/ payload was a release
  // behind, and `payload-stale` on the same repo in the same second under a different
  // agent's environment variable — because it reused row 90's SPAWN ladder to choose
  // what to AUDIT. The audit has no caller: every registry entry is reported over what
  // exists on disk, so a repo carrying both payload sets reads as the state it is.
  for (const name of HARNESSES) {
    const hx = loadHarness(name)
    if (!hx.ok) continue   // unreachable: HARNESSES is the registry's own key set
    const harness = hx.value
    const installed = harness.payload.filter((p) => existsSync(join(root, p.to)))
    if (installed.length === 0) {
      // `bundled` EXPLAINS the absence; it does not suppress the report of one, which
      // is what its comment in harness.ts always claimed it meant.
      payloadAbsent.push(`${name} — ${harness.bundled
        ? 'expected under the marketplace plugin'
        : `run ${NPX_LATEST} init --agent ${name}`}`)
    } else {
      // Row 102: content, not pins. THREE of the five payload files carry no pin at all
      // (canon-guard.mjs, guard-state.mjs, witness-pi.ts), so the pin probe left a guard
      // bugfix undeliverable AND undetectable — silent in both directions.
      //
      // A shipped file we cannot read is a PACKAGING failure, not repo staleness, and
      // "cannot compare" stays silent here: harness.ts:107 names the exact mode — drop
      // the dir from package.json `files` and the published package breaks while the
      // whole suite stays green, because vitest reads from the repo root. installPayload
      // is where that condition refuses (`source-missing`); a diagnostic verb must not
      // crash on it, and must not report the repo as stale for it either.
      const stale = installed.filter((p) => {
        const src = join(packageRoot(), p.from)
        if (!existsSync(src)) return false
        return readFileSync(join(root, p.to), 'utf8') !== readFileSync(src, 'utf8')
      })
      if (stale.length > 0) {
        findings.push(f('warn', 'harness', `${name}: payload`, 'payload-stale',
          `${stale.map((p) => p.to).join(' · ')} differ from what ${version()} ships — run ${NPX_LATEST} init --agent ${name}`))
      }
    }

    const skills = resolveSkills(ctx.env, root, harness)
    if (skills.scope === 'project-only') {
      // A content question, not an absence: the files ARE here, in a place the stage
      // that does the most work cannot see.
      findings.push(f('warn', 'harness', `${name}: skills`, 'skills-project-scope',
        `${harness.skills.project} is invisible from a worktree cwd — reinstall at global scope (${harness.skills.global} under $HOME)`))
    } else if (skills.scope === 'absent') {
      skillsAbsent.push(`${name} — ${harness.bundled
        ? 'expected under the marketplace plugin'
        : 'npx skills@latest add <witness tarball url> at global scope'}`)
    } else {
      // The second half of the same query. A tarball URL is version-pinned so `skills
      // update` cannot resolve forward, and each skill pins the CLI it invokes — stale
      // skills therefore keep running the stale CLI, which reports its own version and
      // sees nothing wrong. Skills first, then init --agent: the fresh pin is what
      // invokes a CLI new enough to restamp the payload.
      const stale = skillPins(skills.dir!).filter((s) => behind(s.pin))
      if (stale.length > 0) {
        findings.push(f('warn', 'harness', `${name}: skills`, 'skills-behind',
          `${stale.map((s) => `${s.skill}@${s.pin}`).join(' · ')} — published latest is ${latest}; re-add the skills tarball at ${latest}, then run ${NPX_LATEST} init --agent ${name}`))
      }
    }
  }

  const errors = findings.filter((x) => x.level === 'error')
  if (findings.length) rows('findings', ['level', 'area', 'field', 'rule', 'detail'], findings as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  // Stated, never findings — they touch neither the findings table nor the exit code. The
  // line appears only when NO harness has one, because a repo driven by pi does not owe a
  // claude-code payload and naming its absence is the permanent noise row 87 refused.
  if (payloadAbsent.length === HARNESSES.length) {
    ctx.out(kv('payload', `none installed here (${payloadAbsent.join(' · ')})`))
  }
  if (skillsAbsent.length === HARNESSES.length) {
    ctx.out(kv('skills', `none visible here (${skillsAbsent.join(' · ')})`))
  }
  // Judge first, then the floor computed FOR that judge: read top to bottom, the second
  // line is a consequence of the first, and the pair answers "which reviewers will this
  // repo spawn, and are they calibrated". Stated lines, never findings — neither touches
  // the findings table nor the exit code, which is a contract about canon validity (101).
  // The calibration state reads the same here as on `status` (D98a) — one renderer, so
  // the fact the gate run no longer repeats still reaches both orientation surfaces.
  ctx.out(kv('judge', judgeLine(judgeR)))
  if (cfg.ok) {
    for (const line of modelFloorLines(root, cfg.value, judgeR.ok ? judgeR.value.harness.name : DEFAULT_HARNESS)) {
      ctx.out(kv('model-floor', line))
    }
  }
  ctx.out(kv('checks', `${canon.docs.length} docs · ${auditStateCommits(root).length} commits audited · ${errors.length} errors`))
  return errors.length ? EXIT.FINDINGS : EXIT.OK
}
