import { join } from 'node:path'
import { EXIT, version, type Ctx } from './cli.js'
import { loadConfig, type Config, type DocKey } from './config.js'
import { writeDoc } from './fm.js'
import { crashPoint, guardTxn, withTxn } from './txn.js'
import { acquireLock } from './lock.js'
import { appendEntry, entryLine, journalRel, readStream } from './journal.js'
import { primaryRoot, stateCommit } from './gitio.js'
import { loadCanon, findById, type Canon } from './scan.js'
import { newRunId } from './drift.js'
import { ok, refuse, renderRefusal, v, type Result } from './refusal.js'
import { kv, rows } from './toon.js'
import { loadMatrix, resolveModel, SESSION_DEFAULT } from './model.js'
import { docKeysFor, docsBlock, invokeClaude, loadLensDocs, parseVerdictText, promptsSha, resolvePrompt, type Lens } from './reviewer.js'
import { anchorMenu, parseVerdict, verdictViolations, type Reviewed } from './verdict.js'
import {
  ROUND_BOUND, appendKind, boundReached, gateRuns, keyOf, roundsSinceApprove, sameKey,
  type GateCheck, type GateKey, type GateRunEntry, type ReviewerVerdict,
} from './rounds.js'
import { prepareStamp, writeStamp, type PreparedStamp } from './stamp.js'

export type GateName = 'decompose' | 'plan' | 'implement' | 'ship' | 'design'
export type ChangeClass = 'feature' | 'fix' | 'chore'

export interface Stamp { artifact: string; to: string }
export interface MetaStamp { artifact: string; patch: Record<string, unknown>; entryType: string }

export interface GateInput {
  class: ChangeClass
  reviewedSha: string
  artifactSha?: string
  reviewed: Reviewed
  promptBody: string
  checks: GateCheck[]
  standingStop?: string
  stamps: Stamp[]
  repin?: { rel: string; meta: Record<string, unknown>; body: string; sha: string }
}

export interface GateSpec {
  gate: GateName
  targetKind: 'effort' | 'plan' | 'spec'
  resolve(root: string, ctx: Ctx, canon: Canon, cfg: Config, target: string): Promise<Result<GateInput>>
  approveStamps?(root: string, canon: Canon, target: string): Stamp[]
  approveMeta?(root: string, canon: Canon, cfg: Config, target: string): MetaStamp[]
}

const GATES = new Map<string, GateSpec>()

export function registerGate(spec: GateSpec): void { GATES.set(spec.gate, spec) }
export function gateSpec(name: string): GateSpec | undefined { return GATES.get(name) }

export const DEFAULT_BATTERIES: Record<GateName, string[] | Record<ChangeClass, string[]>> = {
  decompose: ['slicing-critic'],
  plan: ['plan-critic'],
  implement: {
    feature: ['code-reviewer', 'silent-failure-hunter', 'type-design', 'pr-test'],
    fix: ['code-reviewer', 'silent-failure-hunter'],
    chore: ['code-reviewer'],
  },
  ship: ['drift-reviewer', 'code-reviewer'],
  design: ['design-critic'],
}

export function batteryFor(cfg: Config, gate: GateName, cls: ChangeClass): Result<string[]> {
  const gates = (cfg.raw.gates ?? {}) as Record<string, { reviewers?: unknown } | undefined>
  const raw = gates[gate]?.reviewers ?? DEFAULT_BATTERIES[gate]
  const picked = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)[cls]
  if (!Array.isArray(picked) || picked.length === 0 || !picked.every((x) => typeof x === 'string')) {
    return refuse([v(`gates.${gate}.reviewers`, 'battery-shape', JSON.stringify(raw),
      'a reviewer list or a per-class map of lists')])
  }
  return ok(picked as string[])
}

export function renderGateRun(ctx: Ctx, entry: GateRunEntry, mode: 'ran' | 'resume'): void {
  ctx.out(kv('gate', entry.gate))
  ctx.out(kv('target', entry.artifact))
  ctx.out(kv('round', `${entry.round} of ${ROUND_BOUND}${mode === 'resume' ? ' (resume — content unchanged)' : ''}`))
  ctx.out(kv('reviewed', entry.reviewed_sha.slice(0, 7)))
  ctx.out(kv('model', `${entry.model} · calibration: ${entry.calibration}${entry.cached ? ' · cached' : ''}`))
  if (entry.fallback?.length) ctx.out(kv('fallback', entry.fallback.join(' → ')))
  if (entry.rerolled?.length) ctx.out(kv('rerolled', entry.rerolled.join(' · ')))
  ctx.out(rows('checks', ['name', 'ok', 'detail'],
    entry.checks.map((c) => ({ name: c.name, ok: String(c.ok), detail: c.detail ?? '' }))).join('\n'))
  const findings = (entry.verdicts ?? []).flatMap((rv) =>
    rv.findings.map((f) => ({
      reviewer: rv.reviewer, blocking: String(f.blocking),
      anchor: typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`, claim: f.claim,
    })))
  if (findings.length) ctx.out(rows('findings', ['reviewer', 'blocking', 'anchor', 'claim'], findings).join('\n'))
  if (entry.malformed?.length) {
    ctx.out(rows('malformed', ['reviewer', 'field', 'rule'],
      entry.malformed.flatMap((m) => m.violations.map((x) => ({ reviewer: m.reviewer, field: x.field, rule: x.rule })))).join('\n'))
  }
  if (entry.standing) ctx.out(kv('standing-stop', entry.standing))
  ctx.out(kv('outcome', entry.outcome))
  if (entry.outcome !== 'passed') {
    ctx.out(`help: specflow decide ${entry.gate} ${entry.artifact} --approve | --revise --note "<why>" | --revise --upstream <id> | --stop`)
  }
}

export async function runGate(
  ctx: Ctx, gateName: string, target: string, flags: { fresh: boolean; manual: boolean },
): Promise<number> {
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const blocked = guardTxn(ctx, root)
  if (blocked !== undefined) return blocked

  const spec = gateSpec(gateName)
  if (!spec) {
    renderRefusal([v('gate', 'unknown-gate', gateName, 'decompose | plan | implement | ship | design')]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const canon = loadCanon(root)
  const inputR = await spec.resolve(root, ctx, canon, cfgR.value, target)
  if (!inputR.ok) { renderRefusal(inputR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const input = inputR.value

  const batteryR = batteryFor(cfgR.value, spec.gate, input.class)
  if (!batteryR.ok) { renderRefusal(batteryR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const lenses: Lens[] = []
  for (const name of batteryR.value) {
    const lensR = resolvePrompt(name)
    if (!lensR.ok) { renderRefusal(lensR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const lens = lensR.value
    const docPaths = docKeysFor(spec.gate, name).flatMap((k) => cfgR.value.docs[k as DocKey] ?? [])
    if (docPaths.length > 0) {
      const docsR = loadLensDocs(root, docPaths)
      if (!docsR.ok) { renderRefusal(docsR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
      lens.docs = docsR.value
    }
    lenses.push(lens)
  }
  const modelR = resolveModel(cfgR.value, loadMatrix(root), spec.gate)
  if (!modelR.ok) { renderRefusal(modelR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const { chain, calibrationOf, warning } = modelR.value
  if (warning) ctx.err(`warning: ${warning}`)

  const entries = readStream(root, target)
  const key: GateKey = {
    reviewed_sha: input.reviewedSha, gate: spec.gate,
    prompts_sha: promptsSha(lenses), model: chain[0]!, specflow: version(),
  }
  const kind = flags.fresh ? { kind: 'fresh' as const } : appendKind(entries, spec.gate, key)
  if (kind.kind === 'resume') {
    renderGateRun(ctx, kind.entry, 'resume')
    return kind.entry.outcome === 'passed' ? EXIT.OK : EXIT.FINDINGS
  }
  if (kind.kind === 'changed-nothing') {
    ctx.out(kv('gate', spec.gate))
    ctx.out(kv('outcome', 'revise changed nothing — reviewed content is identical to the last round'))
    ctx.out('help: edit the artifact (or code) before re-running, or decide --approve/--stop')
    return EXIT.FINDINGS
  }
  if (boundReached(entries, spec.gate)) {
    ctx.out(kv('gate', spec.gate))
    ctx.out(kv('outcome', `round bound reached (${roundsSinceApprove(entries, spec.gate)} rounds since last approve)`))
    ctx.out(`help: specflow decide ${spec.gate} ${target} --approve --override | --revise --upstream <id> | --stop`)
    ctx.out(`help: or discard the plan: specflow abandon ${target}`)
    return EXIT.BLOCKED
  }
  if (!flags.fresh) {
    // malformed rounds don't spend the bound (rounds.ts) — this brake is what
    // stops an unreliable battery from re-running for free forever instead
    const tail = gateRuns(entries, spec.gate).slice(-2)
    const sameSetup = (r: GateRunEntry) =>
      r.outcome === 'malformed' && r.model === key.model && r.prompts_sha === key.prompts_sha
    if (tail.length === 2 && tail.every(sameSetup)) {
      renderRefusal([v('reviewers', 'malformed-streak',
        `${tail.length} consecutive malformed rounds on ${tail[1]!.model}`,
        `a changed gates.${spec.gate}.model pin or updated prompts — the battery is emitting invalid verdicts (or force with --fresh)`,
      )]).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
  }

  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  const release = lockR.value
  try {
    let verdicts: ReviewerVerdict[] = []
    const malformed: NonNullable<GateRunEntry['malformed']> = []
    const fallback: string[] = []
    const rerolled: string[] = []
    let rung = 0
    let model = chain[0]!
    let cached = false

    if (kind.kind === 'cached') {
      verdicts = kind.from.verdicts ?? []
      model = kind.from.model
      cached = true
    } else {
      const menu = anchorMenu(input.reviewed)
      for (const lens of lenses) {
        let prompt = `${lens.contents}\n\n${docsBlock(lens.docs ?? [])}${menu ? `${menu}\n\n` : ''}## Reviewed content\n\n${input.promptBody}\n`
        for (let attempt = 0; ; attempt++) {
          let answered: string | undefined
          for (;;) {
            const id = chain[rung]!
            const r = invokeClaude(ctx, { cwd: root, prompt, model: id === SESSION_DEFAULT ? undefined : id })
            if (r.ok) { answered = r.value.text; model = id; break }
            if (rung >= chain.length - 1) {
              renderRefusal(r.violations).forEach((l) => ctx.err(l))
              return EXIT.REFUSED
            }
            fallback.push(id)
            rung += 1
          }
          const rawR = parseVerdictText(answered)
          const parsedR = rawR.ok ? parseVerdict(rawR.value) : rawR
          const violations = parsedR.ok ? verdictViolations(parsedR.value, input.reviewed) : parsedR.violations
          if (parsedR.ok && violations.length === 0) {
            verdicts.push({ reviewer: lens.name, coverage: parsedR.value.coverage, findings: parsedR.value.findings })
            break
          }
          if (attempt === 0) {
            // one self-repair reroll per reviewer — a single flaky verdict would
            // otherwise poison the whole round as 'malformed'; the reroll is not
            // part of the gate key, so cached rounds replay the settled result
            rerolled.push(lens.name)
            prompt += `\n## Previous attempt rejected\n\n${
              violations.map((x) => `- ${x.field}: ${x.rule} — got ${x.got}; want ${x.want}`).join('\n')
            }\n\nRe-emit the complete corrected verdict JSON.\n`
            continue
          }
          malformed.push({ reviewer: lens.name, violations })
          break
        }
      }
    }

    if (fallback.length > 0 && chain[0] !== SESSION_DEFAULT && fallback.includes(chain[0]!)) {
      ctx.err(`warning: head model ${chain[0]} failed to invoke — reviewers ran on ${model}; check gates.${spec.gate}.model`)
    }
    const blocking = verdicts.flatMap((x) => x.findings).filter((f) => f.blocking).length
    const checksGreen = input.checks.every((c) => c.ok)
    const outcome: GateRunEntry['outcome'] =
      malformed.length > 0 ? 'malformed'
      : !checksGreen || blocking > 0 ? 'stopped'
      : input.standingStop !== undefined || flags.manual ? 'stopped'
      : 'passed'

    const entry: GateRunEntry = {
      v: 1, t: 'gate-run', gate: spec.gate, artifact: target,
      round: roundsSinceApprove(entries, spec.gate) + 1, run_id: newRunId(),
      reviewed_sha: input.reviewedSha, prompts_sha: key.prompts_sha,
      specflow: key.specflow, model, calibration: calibrationOf(model),
      ...(cached ? { cached: true } : {}),
      ...(flags.manual ? { manual: true } : {}),
      ...(fallback.length ? { fallback } : {}),
      ...(rerolled.length ? { rerolled } : {}),
      ...(outcome === 'stopped' && input.standingStop ? { standing: input.standingStop } : {}),
      ...(input.artifactSha ? { artifact_sha: input.artifactSha } : {}),
      checks: input.checks,
      ...(verdicts.length ? { verdicts } : {}),
      ...(malformed.length ? { malformed } : {}),
      outcome,
    }

    const stamps: PreparedStamp[] = outcome === 'passed'
      ? input.stamps.flatMap((s) => {
          const doc = findById(canon, s.artifact)
          return doc && String(doc.meta.status) !== s.to
            ? [prepareStamp(doc, s.to, 'gate-approve', { run_id: entry.run_id })] : []
        })
      : []

    const files = [
      journalRel(target), ...stamps.flatMap((s) => [s.rel, journalRel(s.stream)]),
      ...(input.repin ? [input.repin.rel] : []),
    ]
    const marker = {
      op: `gate-${spec.gate}`,
      files: [...new Set(files)],
      journalMulti: [
        { stream: target, line: entryLine(entry as unknown as { t: 'gate-run'; [k: string]: unknown }) },
        ...stamps.map((s) => ({ stream: s.stream, line: s.line })),
      ],
    }
    const txn = withTxn(root, marker, () => {
      appendEntry(root, target, entry as unknown as { t: 'gate-run'; [k: string]: unknown })
      for (const s of stamps) writeStamp(root, s)
      if (input.repin) {
        writeDoc(join(root, input.repin.rel),
          { meta: { ...input.repin.meta, 'derives-from': input.repin.sha }, body: input.repin.body })
      }
      crashPoint(ctx.env, 'gate-journal')
      return stateCommit(root, marker.files,
        `gate(${spec.gate}): ${target} round ${entry.round} ${outcome}`)
    })
    if (!txn.ok) { renderRefusal(txn.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }

    renderGateRun(ctx, entry, 'ran')
    if (input.repin) ctx.out(kv('re-pinned', `derives-from → ${input.repin.sha.slice(0, 7)} (witnessed by the drift lane)`))
    return outcome === 'passed' ? EXIT.OK : EXIT.FINDINGS
  } finally {
    release()
  }
}
