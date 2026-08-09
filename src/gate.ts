import { join } from 'node:path'
import { EXIT, version, type Ctx } from './cli.js'
import { loadConfig, loadLocalConfig, type Config, type DocKey } from './config.js'
import { writeDoc } from './fm.js'
import { crashPoint, guardTxn, withTxn } from './txn.js'
import { acquireLock } from './lock.js'
import { appendEntry, entryLine, journalRel, policyPins, readStream, type Entry } from './journal.js'
import { primaryRoot, stateCommit } from './gitio.js'
import { loadCanon, findById, type Canon } from './scan.js'
import { newRunId } from './drift.js'
import { resolveJudge } from './harness.js'
import { ok, refuse, renderRefusal, v, type Result } from './refusal.js'
import { kv, rows } from './toon.js'
import { loadMatrix, resolveModel, SESSION_DEFAULT } from './model.js'
import { docKeysFor, docsBlock, invokeReviewer, loadLensDocs, parseVerdictText, pinsBlock, promptsSha, resolvePrompt, type Lens, type LensDoc } from './reviewer.js'
import { anchorMenu, parseVerdict, verdictViolations, type Reviewed } from './verdict.js'
import {
  ROUND_BOUND, appendKind, boundReached, fellBack, lastGateRun, liveExits, roundBudget,
  roundsSinceApprove, runsSinceReset,
  type GateCheck, type GateKey, type GateRunEntry, type ReviewerVerdict,
} from './rounds.js'
export { liveExits } from './rounds.js'
import { gateSettled } from './verbs/next.js'
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
  // Row 115: battery members to drop this run, journaled `skipped` WITH the cause. A bare
  // name cannot be read — "not applicable" and "could not run" look identical, and only one
  // of them is benign.
  skipLenses?: Array<{ lens: string; why: string }>
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

const DEFAULT_BATTERIES: Record<GateName, string[] | Record<ChangeClass, string[]>> = {
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

// `entries` is the stream AS OF AFTER this entry: without it the renderer cannot tell the
// round that spends the budget from any other, and rows 109/110 are both about that round.
// `help: false` is for callers that render their own `exits:` line (`decide --show`).
export function renderGateRun(
  ctx: Ctx, entry: GateRunEntry, mode: 'ran' | 'resume',
  opts: { entries?: Entry[]; help?: boolean } = {},
): void {
  const entries = opts.entries ?? []
  const budget = opts.entries ? roundBudget(entries, entry.gate) : ROUND_BOUND
  const atBound = opts.entries !== undefined && boundReached(entries, entry.gate)
  ctx.out(kv('gate', entry.gate))
  ctx.out(kv('target', entry.artifact))
  ctx.out(kv('round', `${entry.round} of ${budget}${mode === 'resume' ? ' (resume — content unchanged)' : ''}`))
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
      pin: f.contradicts_pin !== undefined ? `#${f.contradicts_pin}` : '',
      anchor: typeof f.anchor === 'string' ? f.anchor : `omission:${f.anchor.scope}`, claim: f.claim,
    })))
  if (findings.length) ctx.out(rows('findings', ['reviewer', 'blocking', 'pin', 'anchor', 'claim'], findings).join('\n'))
  if (entry.malformed?.length) {
    ctx.out(rows('malformed', ['reviewer', 'field', 'rule'],
      entry.malformed.flatMap((m) => m.violations.map((x) => ({ reviewer: m.reviewer, field: x.field, rule: x.rule })))).join('\n'))
  }
  if (entry.standing) ctx.out(kv('standing-stop', entry.standing))
  ctx.out(kv('outcome', entry.outcome))
  if (entry.outcome !== 'passed') {
    // Row 110. The round that SPENDS the budget is the one that has to say so. It rendered
    // like any other, so the natural next act — fix the finding, re-gate — was advertised
    // by the help line below and then refused twice: the gate short-circuits, and the edit
    // that answered the finding forfeits `--approve` under D75. Nothing warned, and the
    // finding is itself an instruction to edit. Printed above the `help:` suppression, not
    // inside it: `decide --show` renders its own exits and is the surface a human reads
    // while deciding — the one place this warning is most owed.
    if (atBound) {
      ctx.out(kv('last-round', 'the round budget is spent — the gate will not run again, and an edit from here forfeits --approve (the verdict would describe an older tree)'))
    }
    // Without `entries` this stays a pure formatter over the entry it was handed, and the
    // off-bound triple is the right answer; with them it tells the truth at the bound too.
    if (opts.help !== false) ctx.out(`help: ${liveExits(entry.gate, entry.artifact, entries, false)}`)
  }
}

// Row 79: the human approving a plan sees the run's shape before it starts.
// Display only — no lens, no threshold; loads config/canon itself so the
// entry-renderers stay pure formatters.
export function printDispatchArithmetic(ctx: Ctx, root: string, gateName: string, target: string): void {
  if (gateName !== 'plan') return
  const cfg = loadConfig(root)
  if (!cfg.ok) return
  const doc = findById(loadCanon(root), target)
  if (!doc || doc.meta.type !== 'plan') return
  const budget = cfg.value.implement.stepsPerDispatch
  const steps = ((doc.meta.steps ?? []) as unknown[]).length
  ctx.out(kv('dispatches', `${steps} step(s) ≈ ${Math.ceil(steps / budget)} dispatch(es) at budget ${budget}`))
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
  const skip = new Map((input.skipLenses ?? []).map((s) => [s.lens, s.why]))
  const active = batteryR.value.filter((n) => !skip.has(n))
  const dropped = batteryR.value.filter((n) => skip.has(n)).map((n) => `${n} — ${skip.get(n)!}`)
  const entries = readStream(root, target)
  const pins = policyPins(entries)
  const pinsText = pinsBlock(pins)
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
  const hxR = resolveJudge(ctx.env, cfgR.value.raw)
  if (!hxR.ok) { renderRefusal(hxR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const harness = hxR.value.harness
  const localR = loadLocalConfig(root)
  if (!localR.ok) { renderRefusal(localR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const extras = {
    timeoutMs: cfgR.value.gates.reviewerTimeoutMs,
    extensions: localR.value.reviewerExtensions,
  }
  const modelR = resolveModel(cfgR.value, loadMatrix(root, harness.name), spec.gate)
  if (!modelR.ok) { renderRefusal(modelR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const { chain, calibrationOf, warning, warningKind } = modelR.value
  // matrix-empty is a fact about this witness build, reported once by `status`/`check`
  // (D98a). Only the caller's own pin being below the floor is news at run time.
  if (warning && warningKind === 'below-floor') ctx.err(`warning: ${warning}`)

  // Row 106: the key is built BEFORE invoking, so the only model knowable here is the one
  // being asked for. Naming it `pin` is what stops the entry's `model` — what actually
  // answered — from being compared against it by accident, which is how the streak brake
  // below spent three releases never firing.
  const pin = chain[0]!
  const key: GateKey = {
    reviewed_sha: input.reviewedSha, gate: spec.gate,
    prompts_sha: promptsSha(lenses, pinsText === '' ? undefined : pinsText), pin, witness: version(),
    harness: harness.name,
  }
  // D99: `gateSettled` reads only the last run, so any new run un-settles the gate.
  // Content moving is a legitimate, self-explaining reason. A flag is not — `--fresh`
  // discarded a human decision with nothing printed and nothing journaled about it, and
  // row 94 removed its other job (escaping the changed-nothing deadlock), so it can
  // refuse and send the human through the verb that states a retraction and its reason.
  const settledBefore = gateSettled(entries, spec.gate)
  if (flags.fresh && settledBefore) {
    renderRefusal([v('gate', 'settled-approve', `${spec.gate} ${target} is settled`,
      `witness decide ${spec.gate} ${target} --revise --note "<why>" — retract the approval, then re-gate`)])
      .forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }

  let kind = flags.fresh ? { kind: 'fresh' as const } : appendKind(entries, spec.gate, key)
  // Row 112. The cache key is the REVIEWED content digest, but the deterministic checks
  // read inputs it cannot see — decompose's `goal-coverage`/`spec-coverage` read journaled
  // `covers`, `amendment-ack` reads a sibling plan's pin, `graph` reads the whole canon. So
  // correcting a goal mapping left the doc bytes untouched, the key unmoved, and `resume`
  // served a blocking finding describing a state that no longer existed; `--fresh` was the
  // only escape, and an operator who did not think of it spent a human decision on it.
  // `resolve` has already recomputed the checks by this point — the fresh answer was in
  // hand and thrown away. A flip is a new judgment, so it appends a real round rather than
  // silently re-rendering; the verdicts are REPLAYED (`cached`), so no battery is spent.
  // Compared on `ok` alone: a detail carries run output on some gates (timings, paths), and
  // keying on it would append a round for every re-run of an unchanged tree.
  const checkOk = (cs: GateCheck[]) => cs.map((c) => `${c.name}:${c.ok}`).sort().join('|')
  if ((kind.kind === 'resume' || kind.kind === 'changed-nothing') &&
      checkOk(kind.entry.checks) !== checkOk(input.checks) &&
      kind.entry.outcome !== 'malformed' && (kind.entry.verdicts?.length ?? 0) > 0) {
    kind = { kind: 'cached' as const, from: kind.entry }
  }
  // A key that moved for a NON-content reason — edited prompt, re-pinned model, new
  // witness version — un-settles just as quietly as --fresh did. Content moving explains
  // itself; this does not.
  const lastRun = lastGateRun(entries, spec.gate)
  if (settledBefore && kind.kind === 'fresh' && lastRun && lastRun.reviewed_sha === input.reviewedSha) {
    ctx.err(`warning: reviewer setup changed — this run discards the settled approve on ${spec.gate} ${target}`)
  }
  if (kind.kind === 'resume') {
    renderGateRun(ctx, kind.entry, 'resume', { entries })
    printDispatchArithmetic(ctx, root, spec.gate, target)
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
    ctx.out(`help: witness decide ${spec.gate} ${target} --approve --override | --revise --upstream <id> | --stop`)
    ctx.out(`help: or discard the plan: witness abandon ${target}`)
    return EXIT.BLOCKED
  }
  if (!flags.fresh) {
    // Both brakes guard the SAME window as the round budget (rounds.ts): exempt rounds
    // could otherwise repeat for free, and a run on the far side of an approve was
    // disposed of and can trip nothing.
    const tail = runsSinceReset(entries, spec.gate).slice(-2)
    const samePin = (r: GateRunEntry) =>
      (r.pin ?? r.model) === key.pin && (r.harness ?? 'claude-code') === key.harness
    // Row 107. A fallen-back round does not spend the budget, and an exempt round that
    // repeats forever is D67's livelock — the exemption and this trigger are one change.
    // `prompts_sha` is deliberately NOT compared: a lens edit has nothing to do with
    // whether a model answers, and comparing it would let an unrelated edit reset a brake
    // on a dead pin. Checked first because when both hold, "the pinned model is not
    // answering" is the true remedy and "your battery emits invalid verdicts" is not.
    // No --fresh in the want: --fresh bypasses the brake and would spend a battery
    // re-invoking the same dead pin. Fixing the pin moves key.pin, samePin goes false,
    // and the battery runs — which is only reachable BECAUSE these rounds were exempt.
    if (tail.length === 2 && tail.every((r) => fellBack(r) && samePin(r))) {
      renderRefusal([v(`gates.${spec.gate}.model`, 'fallback-streak',
        `${tail.length} consecutive rounds fell back from ${key.pin}`,
        'a reachable gates.<gate>.model — the pinned model is not answering')])
        .forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    // malformed rounds don't spend the bound either — this brake is what stops an
    // unreliable battery from re-running for free forever instead. Row 106: "same setup"
    // always meant the same PIN, and comparing the answering rung meant two malformed
    // fallen-back rounds never matched, which is the one thing this exists to stop.
    const sameSetup = (r: GateRunEntry) =>
      r.outcome === 'malformed' && samePin(r) && r.prompts_sha === key.prompts_sha
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
  let model = pin
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
      let prompt = `${lens.contents}\n\n${docsBlock(lens.docs ?? [])}${pinsText}${menu ? `${menu}\n\n` : ''}## Reviewed content\n\n${body}\n`
      for (let attempt = 0; ; attempt++) {
        let answered: string | undefined
        for (;;) {
          const id = chain[rung]!
          const r = invokeReviewer(ctx, harness, { cwd: root, prompt, model: id === SESSION_DEFAULT ? undefined : id, ...extras })
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

  const blocking = verdicts.flatMap((x) => x.findings).filter((f) => f.blocking).length
  const pinConflicts = verdicts.flatMap((x) => x.findings).filter((f) => f.contradicts_pin !== undefined).length
  const standing = [
    input.standingStop,
    pinConflicts > 0 ? 'contradicts-pin — a finding disputes a settled policy pin; the human decides which one dies' : undefined,
    // Row 98c, specified by row 107. Composed HERE, after the battery, because whether a
    // fallback happened is not knowable at resolve() time. Dismissed by a plain
    // --approve: --override is reserved for the bound and this is a first-round event.
    // The remedy is deliberately absent — on round one the honest statement is that a
    // human decides whether the verdict counts; the remedy becomes true only once the pin
    // proves persistently dead, which is what fallback-streak above prints. It REPLACES
    // the stderr warning that fired on this same condition: unjournaled and non-blocking,
    // it let a substituted verdict pass behind a line that scrolls by.
    model !== pin
      ? `fallback — reviewers ran on ${model}, not the pinned ${pin}; the human decides whether that verdict counts`
      : undefined,
  ].filter((s): s is string => s !== undefined).join(' · ') || undefined
  const checksGreen = input.checks.every((c) => c.ok)
  const outcome: GateRunEntry['outcome'] =
    malformed.length > 0 ? 'malformed'
    : !checksGreen || blocking > 0 ? 'stopped'
    : standing !== undefined || flags.manual ? 'stopped'
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
      ctx.out(`help: witness decide ${spec.gate} ${target} --approve --override | --revise --upstream <id> | --stop`)
      ctx.out(`help: or discard the plan: witness abandon ${target}`)
      return EXIT.BLOCKED
    }

    const entry: GateRunEntry = {
      v: 1, t: 'gate-run', gate: spec.gate, artifact: target,
      round: roundsSinceApprove(entriesNow, spec.gate) + 1, run_id: newRunId(),
      reviewed_sha: input.reviewedSha, prompts_sha: key.prompts_sha,
      witness: key.witness, model, pin, harness: harness.name, calibration: calibrationOf(model),
      ...(localR.value.reviewerExtensions.length ? { reviewer_extensions: localR.value.reviewerExtensions } : {}),
      ...(cached ? { cached: true } : {}),
      ...(flags.manual ? { manual: true } : {}),
      ...(fallback.length ? { fallback } : {}),
      ...(rerolled.length ? { rerolled } : {}),
      ...(dropped.length ? { skipped: dropped } : {}),
      ...(outcome === 'stopped' && standing ? { standing } : {}),
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

    renderGateRun(ctx, entry, 'ran', { entries: [...entriesNow, entry as unknown as Entry] })
    printDispatchArithmetic(ctx, root, spec.gate, target)
    if (input.repin) ctx.out(kv('re-pinned', `derives-from → ${input.repin.sha.slice(0, 7)} (witnessed by the drift lane)`))
    return outcome === 'passed' ? EXIT.OK : EXIT.FINDINGS
  } finally {
    release()
  }
}
