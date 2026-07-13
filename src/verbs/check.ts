import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { auditStateCommits, dirtyStatePaths, primaryRoot } from '../gitio.js'
import { contentAtSha } from '../history.js'
import { readStream } from '../journal.js'
import { evaluateNeeds } from '../needs.js'
import { renderRefusal } from '../refusal.js'
import { findById, findCycle, loadCanon } from '../scan.js'
import { kv, rows } from '../toon.js'
import { pendingTxn } from '../txn.js'

interface Finding {
  level: 'error' | 'warn'
  area: string
  field: string
  rule: string
  detail: string
}

const f = (level: Finding['level'], area: string, field: string, rule: string, detail: string): Finding =>
  ({ level, area, field, rule, detail })

function probe(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export async function run(ctx: Ctx): Promise<number> {
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value
  const findings: Finding[] = []

  const cfg = loadConfig(root)
  if (!cfg.ok) cfg.violations.forEach((x) => findings.push(f('error', 'config', x.field, x.rule, x.got)))
  else if (cfg.value.warning) findings.push(f('warn', 'config', 'schema', 'older-schema', cfg.value.warning))

  const canon = loadCanon(root)
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

  for (const doc of canon.docs) {
    const needs = Array.isArray(doc.meta.needs) ? doc.meta.needs : []
    if (needs.length === 0) continue
    for (const r of await evaluateNeeds(root, ctx, needs)) {
      if (r.status === 'ok') continue
      const rule = r.status === 'unmet' ? 'need-unmet' : `need-${r.status}`
      findings.push(f('warn', 'needs', `${doc.rel}: ${r.label}`, rule, r.detail))
    }
  }

  auditStateCommits(root).forEach((c) => {
    if (!c.trailered) findings.push(f('error', 'audit', c.sha.slice(0, 7), 'untrailered-commit', `${c.subject} — revert it or re-apply via specflow write`))
  })
  if (pendingTxn(root)) {
    findings.push(f('error', 'audit', '.specflow/txn.json', 'pending-txn', 'crashed invocation — specflow recover --complete | --rollback'))
  } else if (dirtyStatePaths(root).length) {
    dirtyStatePaths(root).forEach((p) => findings.push(f('error', 'audit', p, 'hand-edit-in-progress', 'uncommitted change on a state path — revert or re-apply via specflow write')))
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

  if (!probe('gh', ['--version'])) findings.push(f('warn', 'probes', 'gh', 'missing', 'PR operations (later slice) will stop loudly'))
  else if (!probe('gh', ['auth', 'status'])) findings.push(f('warn', 'probes', 'gh', 'unauthenticated', 'run gh auth login'))
  if (!probe('claude', ['--version'])) findings.push(f('warn', 'probes', 'claude', 'missing', 'gate reviewers (later slice) will stop loudly'))

  const errors = findings.filter((x) => x.level === 'error')
  if (findings.length) rows('findings', ['level', 'area', 'field', 'rule', 'detail'], findings as unknown as Array<Record<string, unknown>>).forEach(ctx.out)
  ctx.out(kv('checks', `${canon.docs.length} docs · ${auditStateCommits(root).length} commits audited · ${errors.length} errors`))
  return errors.length ? EXIT.FINDINGS : EXIT.OK
}
