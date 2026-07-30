import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { adoptedCommits } from '../adopt.js'
import { EXIT, version, type Ctx } from '../cli.js'
import { HARNESSES, resolveHarness, skillsVisibility } from '../harness.js'
import { probe } from '../probe.js'
import { loadConfig } from '../config.js'
import { designPending } from '../design.js'
import { runDrift } from '../drift.js'
import { auditStateCommits, dirtyStatePaths, primaryRoot } from '../gitio.js'
import { contentAtSha } from '../history.js'
import { effortStreams, readStream } from '../journal.js'
import { sourceTags } from '../matcher.js'
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

  const cfg = loadConfig(root)
  if (!cfg.ok) cfg.violations.forEach((x) => findings.push(f('error', 'config', x.field, x.rule, x.got)))
  else if (cfg.value.warning) findings.push(f('warn', 'config', 'schema', 'older-schema', cfg.value.warning))

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
        findings.push(f('warn', 'motion', id, 'missing-worktree', `specflow start ${id} recreates it`))
      }
    }
    for (const gate of ['plan', 'implement', 'ship']) {
      if (pendingDecision(readStream(root, id), gate)) {
        findings.push(f('warn', 'motion', id, 'gate-awaiting-decision', `specflow decide ${gate} ${id} --show`))
      }
    }
  }
  for (const slug of effortStreams(root)) {
    if (pendingDecision(readStream(root, slug), 'decompose')) {
      findings.push(f('warn', 'motion', slug, 'gate-awaiting-decision', `specflow decide decompose ${slug} --show`))
    }
  }
  for (const spec of canon.docs.filter((d) => d.meta.type === 'spec')) {
    const id = String(spec.meta.id)
    if (pendingDecision(readStream(root, id), 'design')) {
      findings.push(f('warn', 'motion', id, 'gate-awaiting-decision', `specflow decide design ${id} --show`))
    }
    if (designPending(root, spec) && String(spec.meta.status) === 'approved') {
      findings.push(f('warn', 'motion', id, 'design-pending', `ui spec owes a design — specflow design ${id} --file <html>`))
    }
  }
  for (const planId of listWorktrees(root)) {
    const doc = findById(canon, planId)
    if (!doc || ['done', 'abandoned'].includes(String(doc.meta.status))) {
      findings.push(f('warn', 'motion', planId, 'stray-worktree', 'specflow clean sweeps it'))
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
      findings.push(f('error', 'audit', c.sha.slice(0, 7), 'untrailered-commit', `${c.subject} — adopt: specflow adopt <path> · or revert`))
    }
  })
  if (pendingTxn(root)) {
    findings.push(f('error', 'audit', '.specflow/txn.json', 'pending-txn', 'crashed invocation — specflow recover --complete | --rollback'))
  } else if (dirtyStatePaths(root).length) {
    dirtyStatePaths(root).forEach((p) => findings.push(f('error', 'audit', p, 'hand-edit-in-progress', 'uncommitted change on a state path — adopt: specflow adopt <path> · or revert')))
  }

  const journalDir = join(root, '.specflow', 'journal')
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
  // Decision 12: the judgment lane is Claude on EVERY harness — `specflow gate` spawns
  // `claude -p --output-format json` for every reviewer. This is a machine fact, not a
  // harness fact, and the wording must not read as optional.
  if (!probe('claude', ['--version'], ctx.env)) {
    findings.push(f('warn', 'probes', 'claude', 'missing',
      'the claude CLI is required for gates on every harness — install and authenticate it'))
  }

  if (cfg.ok) {
    for (const [key, paths] of Object.entries(cfg.value.docs)) {
      for (const p of paths ?? []) {
        if (!existsSync(join(root, p))) {
          findings.push(f('error', 'config', `docs.${key}`, 'doc-missing', `${p} — gates inject configured docs fail-closed`))
        }
      }
    }
  }

  // `harness:` is the config rung of the resolution ladder, consulted only when no
  // detection rung answered — so a typo there is silent on the machine that has one.
  // check is the diagnostic verb: it reports the value regardless of who answered.
  const configuredHarness = cfg.ok ? cfg.value.raw.harness : undefined
  if (configuredHarness !== undefined && !(HARNESSES as readonly string[]).includes(String(configuredHarness))) {
    findings.push(f('error', 'config', 'harness', 'unknown-harness',
      `${String(configuredHarness)} — expected ${HARNESSES.join(' | ')}`))
  }

  const hxR = resolveHarness(ctx.env, cfg.ok ? cfg.value.raw : {})
  if (!hxR.ok) {
    hxR.violations.forEach((x) => findings.push(f('error', 'harness', x.field, x.rule, x.got)))
  } else {
    const harness = hxR.value.harness
    // Decision 14: pi resolves project skills cwd-relative with no upward walk, and
    // implement runs with cwd inside .specflow/worktrees/<plan-id>. A project-scope
    // install therefore loses every skill in the stage that does the most work.
    const visibility = skillsVisibility(ctx.env, root, harness)
    if (visibility === 'project-only') {
      findings.push(f('warn', 'harness', 'skills', 'skills-project-scope',
        `${harness.skills.project} is invisible from a worktree cwd — reinstall at global scope (${harness.skills.global} under $HOME)`))
    } else if (visibility === 'absent' && !harness.bundled) {
      findings.push(f('warn', 'harness', 'skills', 'skills-not-installed',
        `${harness.name} sees none of the six stage skills — npx skills add <specflow tarball url> at global scope`))
    }

    // Revision 3. Skills present + payload absent is the worst state in the design: the
    // pipeline looks like it works, and nothing blocks a direct edit to canon. `bundled`
    // is the same bit that silences the skills warning — Claude Code's marketplace plugin
    // ships engine, guard and dashboard out of band, so absence there proves nothing.
    const installed = harness.payload.map((p) => p.to).filter((rel) => existsSync(join(root, rel)))
    if (installed.length === 0) {
      if (!harness.bundled) {
        findings.push(f('warn', 'harness', 'payload', 'payload-not-installed',
          `${harness.name} has no engine, guard or dashboard here — run specflow init --agent ${harness.name}`))
      }
    } else {
      // Revision 1's other half: the sync can restamp, but only if someone knows to run
      // it. The engine file's pin decides which CLI the whole pipeline runs, so a lagging
      // pin is a finding, not a detail.
      // The capture must be a semver and nothing else. Both payloads embed the pin as
      // `${SPECFLOW_BIN:-npx -y @whatmatters/specflow@<v>}`, so a trailing-delimiter
      // class that omits `}` swallows the brace and NEVER equals version() — which made
      // payload-stale fire on every fresh install until Task 9's manual pass caught it.
      // Same shape as install.ts's PIN, deliberately.
      const stale = installed.filter((rel) => {
        const m = /@whatmatters\/specflow@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(readFileSync(join(root, rel), 'utf8'))
        return m !== null && m[1] !== version()
      })
      if (stale.length > 0) {
        findings.push(f('warn', 'harness', 'payload', 'payload-stale',
          `${stale.join(' · ')} pin an older CLI than ${version()} — run specflow init --agent ${harness.name} to restamp`))
      }
    }
  }

  const errors = findings.filter((x) => x.level === 'error')
  if (findings.length) rows('findings', ['level', 'area', 'field', 'rule', 'detail'], findings as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  ctx.out(kv('checks', `${canon.docs.length} docs · ${auditStateCommits(root).length} commits audited · ${errors.length} errors`))
  return errors.length ? EXIT.FINDINGS : EXIT.OK
}
