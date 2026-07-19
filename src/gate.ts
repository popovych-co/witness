import { join } from 'node:path'
import { EXIT, version, type Ctx } from './cli.js'
import { loadConfig, type Config, type DocKey } from './config.js'
import { writeDoc } from './fm.js'
import { crashPoint, guardTxn, withTxn } from './txn.js'
import { acquireLock } from './lock.js'
import { appendEntry, entryLine, journalRel, readStream, type Entry } from './journal.js'
import { primaryRoot, stateCommit } from './gitio.js'
import { loadCanon, findById, type Canon } from './scan.js'
import { newRunId } from './drift.js'
import { ok, refuse, renderRefusal, v, type Result } from './refusal.js'
import { kv, rows } from './toon.js'
import { loadMatrix, resolveModel, SESSION_DEFAULT } from './model.js'
import { docKeysFor, docsBlock, invokeClaude, loadLensDocs, parseVerdictText, promptsSha, resolvePrompt, type Lens, type LensDoc } from './reviewer.js'
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

export interface LensOverride {
  reviewed?: Reviewed
  promptBody?: string
  docs?: LensDoc[]
}

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
  lensOverrides?: Record<string, LensOverride>   // per-lens reviewed/body/docs (design-reviewer)
  skipLenses?: string[]                          // battery members to drop this run, journaled `skipped`
}

export interface GateSpec {
  gate: GateName
  targetKind: 'effort' | 'plan' | 'spec'
  resolve(root: string, ctx: Ctx, canon: Canon, cfg: Config, target: string): Promise<Result<GateInput>>
  // The sha `resolve` would report for the CURRENT content, without doing resolve's work.
  // `decide --approve` needs it to refuse stamping bytes no gate read (D75: staleness at
  // consumption), and resolve() is not usable there — the ship and implement gates run
  // the test, lint and criteria lanes inside it. Returns undefined when the sha cannot be
  // computed (no worktree, missing parent); the caller then approves rather than
  // converting an unrelated condition into a misleading refusal.
  currentSha?(root: string, canon: Canon, cfg: Config, target: string): string | undefined
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
    feature: ['code-reviewer', 'silent-failure-hunter', 'type-design', 'pr-test', 'design-reviewer'],
    fix: ['code-reviewer', 'silent-failure-hunter', 'design-reviewer'],
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

// Which decisions are legal RIGHT NOW is a pure function of journal state, so it belongs
// where the state is. Skills used to recite a fixed triple, which is wrong at the bound
// (D67's endgame set) — and now wrong in three more states.
export function liveExits(gate: string, target: string, entries: Entry[], stale: boolean): string {
  if (stale) return `specflow gate ${gate} ${target}`
  if (boundReached(entries, gate)) {
    return `specflow decide ${gate} ${target} --approve --override | --revise --upstream <id> | --stop`
  }
  return `specflow decide ${gate} ${target} --approve | --revise --note "<why>" | --revise --upstream <id> | --stop`
}

export function renderGateRun(ctx: Ctx, entry: GateRunEntry, mode: 'ran' | 'resume'): void {
  ctx.out(kv('gate', entry.gate))
  ctx.out(kv('target', entry.artifact))
  ctx.out(kv('round', `${entry.round} of ${ROUND_BOUND}${mode === 'resume' ? ' (resume — content unchanged)' : ''}`))
  ctx.out(kv('reviewed', entry.reviewed_sha.slice(0, 7)))
  ctx.out(kv('model', `${entry.model} · calibration: ${entry.calibration}${entry.cached ? ' · cached' : ''}`))
  if (entry.skipped?.length) ctx.out(kv('skipped', entry.skipped.join(' · ')))
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
    // `[]` keeps this a pure formatter over the entry it was handed — callers that know
    // the stream (`--show`) render their own `exits:` line from the real entries. The
    // non-bound triple is correct for runGate's own post-run render: a run that reached
    // the bound short-circuits before rendering.
    ctx.out(`help: ${liveExits(entry.gate, entry.artifact, [], false)}`)
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
  const skip = new Set(input.skipLenses ?? [])
  const active = batteryR.value.filter((n) => !skip.has(n))
  const dropped = batteryR.value.filter((n) => skip.has(n))
  const lenses: Lens[] = []
  for (const name of active) {
    const lensR = resolvePrompt(name)
    if (!lensR.ok) { renderRefusal(lensR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    const lens = lensR.value
    const docPaths = docKeysFor(spec.gate, name).flatMap((k) => cfgR.value.docs[k as DocKey] ?? [])
    let docs: LensDoc[] = []
    if (docPaths.length > 0) {
      const docsR = loadLensDocs(root, docPaths)
      if (!docsR.ok) { renderRefusal(docsR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
      docs = docsR.value
    }
    const ov = input.lensOverrides?.[name]
    if (ov?.docs?.length) docs = [...docs, ...ov.docs]     // living design joins prompts_sha
    if (docs.length) lens.docs = docs
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

  // The reviewer battery runs UNLOCKED. It writes nothing — every symbol it produces is
  // an in-memory local, and reviewer caching is journal-derived (appendKind), not on-disk.
  // Holding the repo-global lock across a multi-minute LLM battery refuses every state
  // write in every other flow for its full duration, on a lock whose real job is a ~100ms
  // commit. The guarded window opens below, immediately before the journal append.
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
    for (const lens of lenses) {
      const ov = input.lensOverrides?.[lens.name]
      const reviewed = ov?.reviewed ?? input.reviewed
      const body = ov?.promptBody ?? input.promptBody
      const menu = anchorMenu(reviewed)
      let prompt = `${lens.contents}\n\n${docsBlock(lens.docs ?? [])}${menu ? `${menu}\n\n` : ''}## Reviewed content\n\n${body}\n`
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
        const violations = parsedR.ok ? verdictViolations(parsedR.value, reviewed) : parsedR.violations
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

  const lockR = acquireLock(root)
  if (!lockR.ok) { renderRefusal(lockR.violations).forEach((l) => ctx.err(l)); return EXIT.BLOCKED }
  const release = lockR.value
  try {
    // The battery ran unlocked, so the journal may have moved under us. `entries` (read
    // at :160) feeds appendKind, boundReached, and the round number — all three must be
    // recomputed against the stream as it stands NOW, or two concurrent gate runs on one
    // target both journal round N and both slip past the bound.
    // Content staleness is deliberately NOT checked here: the entry we write is honest
    // (it records the sha we judged), and a stale verdict stops settling its gate at
    // consumption time (gateSettled's reviewed_sha check).
    const entriesNow = readStream(root, target)
    if (boundReached(entriesNow, spec.gate)) {
      ctx.out(kv('gate', spec.gate))
      ctx.out(kv('outcome', `round bound reached (${roundsSinceApprove(entriesNow, spec.gate)} rounds since last approve)`))
      ctx.out(`help: specflow decide ${spec.gate} ${target} --approve --override | --revise --upstream <id> | --stop`)
      ctx.out(`help: or discard the plan: specflow abandon ${target}`)
      return EXIT.BLOCKED
    }

    const entry: GateRunEntry = {
      v: 1, t: 'gate-run', gate: spec.gate, artifact: target,
      round: roundsSinceApprove(entriesNow, spec.gate) + 1, run_id: newRunId(),
      reviewed_sha: input.reviewedSha, prompts_sha: key.prompts_sha,
      specflow: key.specflow, model, calibration: calibrationOf(model),
      ...(cached ? { cached: true } : {}),
      ...(flags.manual ? { manual: true } : {}),
      ...(fallback.length ? { fallback } : {}),
      ...(rerolled.length ? { rerolled } : {}),
      ...(dropped.length ? { skipped: dropped } : {}),
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
