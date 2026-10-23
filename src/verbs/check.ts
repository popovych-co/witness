import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { adoptedCommits } from '../adopt.js'
import { EXIT, version, type Ctx } from '../cli.js'
import { pctOf, readFill, windowLabel } from '../context.js'
import {
  DEFAULT_HARNESS, HARNESSES, judgeLine, loadHarness, resolveDriver, resolveJudge, resolveSkills, skillPins,
  type HarnessName,
} from '../harness.js'
import { CONTEXT_INSTALL, packageRoot, payloadHomes } from '../install.js'
import { latestPublished } from '../registry.js'
import { NPX_LATEST, compareTriple } from '../version.js'
import { probe } from '../probe.js'
import { loadConfig, loadLocalConfig, localConfigPath } from '../config.js'
import { openDeferrals } from '../deferral.js'
import { canonExit } from '../departure.js'
import { designPending } from '../design.js'
import { ASK_STREAM, reservedId } from '../ask.js'
import { runDrift } from '../drift.js'
import { auditStateCommits, dirtyStatePaths, divergence, primaryRoot, stateDirs, tryGit } from '../gitio.js'
import { contentAtSha } from '../history.js'
import { effortStreams, readStream } from '../journal.js'
import { sourceTags } from '../matcher.js'
import { modelFloorLines } from '../model.js'
import { evaluateNeeds } from '../needs.js'
import { renderRefusal } from '../refusal.js'
import { pendingDecision } from '../rounds.js'
import { criteriaExcludes } from '../runner.js'
import { findById, findCycle, loadCanon, planFinished } from '../scan.js'
import { canonicalSha } from '../sha.js'
import { lazyStamp } from '../stamp.js'
import { kv, rows } from '../toon.js'
import { pendingTxn } from '../txn.js'
import { listWorktrees, materializedCanon, RESIDUE_GOT, worktreePath } from '../worktree.js'

interface Finding {
  level: 'error' | 'warn'
  area: string
  field: string
  rule: string
  detail: string
}

const f = (level: Finding['level'], area: string, field: string, rule: string, detail: string): Finding =>
  ({ level, area, field, rule, detail })

// Row 191 §4.11. What gives a harness's sessions the reading: on Claude Code the witness-context
// plugin, installed per machine, which a fresh session loads and a running one does not (P9, P10),
// the follow-up set off by a dash so the command copies on its own; on Pi the extension the payload
// installs.
const ADAPTER_REMEDY: Record<HarnessName, string> = {
  'claude-code': `install once per machine: ${CONTEXT_INSTALL} — then start a new session`,
  pi: `run ${NPX_LATEST} init --agent pi`,
}

// Row 191 §4.11. The adapter of the harness driving this session, judged by the reading itself,
// the signal the relay depends on, and never by Claude Code's own files: the plugin is installed
// per machine, outside the repo, and only the session check runs in can say whether its reading
// arrived. Whether check runs in a harness session is the detection rung's answer, since each
// harness names itself on every command it runs. A driver that will not resolve had no detection
// rung behind it (a detected harness always resolves), so there is no session to speak for, and
// `check` reports the unreadable `harness:` itself. A loaded adapter writes this session's reading
// before every command or clears the variable, so under `no adapter` nothing wrote it, and under
// `stale` this session's adapter wrote nothing either: the reading was inherited from an outer
// session. Both take the install as the remedy. Under `malformed` and `no reading yet` an adapter
// is loaded, and an install would change nothing.
function adapterLine(env: Ctx['env'], declared: string | undefined): string {
  const outside = 'not checkable outside a harness session — run witness check from a Claude Code or Pi session'
  const driver = resolveDriver(env, declared)
  if (!driver.ok) return outside
  const { harness, source } = driver.value
  const fill = readFill(env)
  if (fill.measured) {
    const { tokens, window } = fill.reading
    return `${harness.name} — reading seen · ${pctOf(tokens, window)}% of ${windowLabel(window)}`
  }
  if (source !== 'detected') return outside
  switch (fill.reason) {
    case 'no adapter': return `${harness.name} — no reading in this session (no adapter) · ${ADAPTER_REMEDY[harness.name]}`
    case 'stale': return `${harness.name} — a reading from another session — none from this session's adapter · ${ADAPTER_REMEDY[harness.name]}`
    case 'malformed': return `${harness.name} — reading not trusted in this session (malformed)`
    case 'no reading yet': return `${harness.name} — no reading yet in this session`
  }
}

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

  // D139. Invisible drift is what let a downstream repo reach 165 unpushed commits. `warn`
  // on purpose: this is a fact about the repo's relationship to origin, not a broken state,
  // and only `error` moves check's exit.
  if (cfg.ok) {
    const shipBranch = cfg.value.ship.branch
    const div = divergence(root, shipBranch)
    if (div && (div.ahead > 0 || div.behind > 0)) {
      const rule = div.ahead > 0 && div.behind > 0 ? 'diverged' : div.ahead > 0 ? 'ahead' : 'behind'
      findings.push(f('warn', 'git', shipBranch, rule,
        `${div.ahead} ahead · ${div.behind} behind origin/${shipBranch} — witness sync`))
    }
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
      // D166. A plan that no longer moves keeps its parent in the departed spec's stream — the
      // rule row 62 already applies to `supersedes:` and `--lineage`. Its pin is not
      // re-verified: nothing reads a finished plan's pin once its parent is history, and the
      // departure never journaled the path it would resolve against. Two cases stay errors: a
      // plan still moving (every gate reads its parent), and a `done` plan under `removed` —
      // only a re-slice may take shipped content out of canon, so that is a pre-D166 unwind
      // that deleted built behavior. No departure entry at all is a stray, as before.
      const exit = typeof plan.meta.parent === 'string' ? canonExit(readStream(root, plan.meta.parent)) : undefined
      const status = String(plan.meta.status)
      if (exit !== undefined && (status === 'abandoned' || (status === 'done' && exit.to === 'superseded'))) continue
      findings.push(f('error', 'invariants', `${plan.rel}: parent`, 'unknown-parent', exit === undefined
        ? String(plan.meta.parent)
        : status === 'done'
          ? `${String(plan.meta.parent)} removed by abandon after this plan shipped it — canon lost built behavior; write that spec again under this id`
          : `${String(plan.meta.parent)} ${exit.to} by ${exit.by ?? exit.cause} while this plan is ${status} — witness abandon ${String(plan.meta.id)} · or re-author it under a live parent`))
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
    if (!doc || planFinished(doc)) {
      findings.push(f('warn', 'motion', planId, 'stray-worktree', 'witness clean sweeps it'))
    }
    // Row 132. A worktree cut before the canon exclusion existed still carries a copy, and
    // `start` is what removes it — so this finding exists to make that state discoverable
    // WITHOUT running the verb that fixes it. Indexed by worktree, like every finding in
    // this loop; severity is what splits the causes apart, because they are different
    // events with different remedies.
    const wtPath = worktreePath(root, planId)
    const residue = materializedCanon(root, wtPath)
    if (residue.length === 0) continue
    const st = tryGit(wtPath, 'status', '--porcelain', '--untracked-files=all', '--', ...stateDirs(root))
    const edited = new Set(st.ok && st.out !== ''
      ? st.out.split('\n').flatMap((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> '))
      : [])
    // A clean pre-upgrade copy is status-silent; a hand edit is not. `planted` and
    // `untracked` are hand events by definition whatever status says — sparse never leaves
    // an `S` file on disk and never invents an untracked one — so cause alone convicts them
    // and the status query is only there to sort the `materialized` rows.
    const handled = residue.filter((r) => r.how !== 'materialized' || edited.has(r.rel))
    if (handled.length > 0) {
      // The dirty paths are the whole story while they exist: read-tree declines them, so
      // the clean rows' remedy (`witness start`) would refuse until these are resolved, and
      // advertising it here would name a command that cannot run.
      for (const r of handled) {
        findings.push(f('error', 'motion', `${planId}: ${r.rel}`, 'canon-in-worktree',
          `${RESIDUE_GOT[r.how]} — revert it in the worktree; canon changes belong at the primary root (witness write · witness adopt)`))
      }
      continue
    }
    // ONE row for the clean case, never one per path: a pre-upgrade worktree materializes
    // EVERY canon doc, and a row each is dozens of identical warns for a single event. The
    // sample names an ARTIFACT when the set has one: the finding is about a doc a session
    // could read, while `.gitkeep` and journal rows sort first and name nothing at stake.
    const sample = (residue.find((r) => /\.(md|html)$/.test(r.rel)) ?? residue[0]!).rel
    findings.push(f('warn', 'motion', planId, 'canon-in-worktree',
      `${residue.length} canon file(s) checked out here (e.g. ${sample}) — worktree predates the exclusion; witness start ${planId} removes them`))
  }

  for (const doc of canon.docs) {
    const needs = Array.isArray(doc.meta.needs) ? doc.meta.needs : []
    if (needs.length === 0) continue
    for (const r of await evaluateNeeds(root, ctx, needs, doc)) {
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
      if (id === ASK_STREAM && entries[0] !== undefined && entries[0].t !== 'ask') {
        findings.push(f('error', 'journal', file, 'reserved-stream-taken', `witness's ask queue is held by a ${entries[0].t} history — witness ask refuses until it moves`))
        continue
      }
      if (entries[0]?.t === 'recap' || reservedId(id) !== undefined) continue
      if (findById(canon, id)) continue
      // D166. A departed spec's stream is not an orphan — it is lineage by construction, what a
      // finished plan's parent and `log --lineage` resolve against. It speaks only while it
      // still holds open obligations: a re-slice moves them to the successor, but an unwind has
      // no successor, and a departure from before D166 moved nothing. `superseded` is the
      // dismissal cause that fits either: the thing the obligation was about no longer exists.
      // A stream with no departure entry is what this rule was always for: a stray.
      const exit = canonExit(entries)
      if (exit === undefined) {
        findings.push(f('warn', 'journal', file, 'orphan-journal', 'stream matches no doc and records no departure — a stray'))
        continue
      }
      const owed = openDeferrals(entries)
      if (owed.length > 0) {
        findings.push(f('warn', 'journal', id, 'stranded-deferral',
          `${owed.length} open deferral(s) on a spec that left canon (${exit.to} by ${exit.by ?? exit.cause}): ${owed.map((d) => d.id).join(' ')} — witness dismiss ${id} --deferral <id> --cause superseded --note <why>`))
      }
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
  const configuredHarness = cfg.ok ? cfg.value.harness : undefined
  if (configuredHarness !== undefined && !(HARNESSES as readonly string[]).includes(String(configuredHarness))) {
    findings.push(f('error', 'config', 'harness', 'unknown-harness',
      `${String(configuredHarness)} — expected ${HARNESSES.join(' | ')}`))
  }

  const judgeR = resolveJudge(ctx.env, cfg.ok ? cfg.value.harness : undefined)
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
      //
      // Row 118: per HOME, not per repository. A worktree is a branch checkout, so its
      // payload is a different file that can be a different age — and that is exactly the
      // state row 116's floor cannot see, because the floor binds only CLIs at or after
      // the version that introduced it while the frozen homes were cut before it. The
      // root keeps its bare relative path; a worktree is named, or four checkouts of one
      // repository all report `.claude/commands/witness.md` and the human cannot tell
      // which of them is the rotten one.
      const stale = payloadHomes(root).flatMap((home) => installed
        .filter((p) => {
          const src = join(packageRoot(), p.from)
          if (!existsSync(src) || !existsSync(join(home, p.to))) return false
          return readFileSync(join(home, p.to), 'utf8') !== readFileSync(src, 'utf8')
        })
        .map((p) => (home === root ? p.to : `${home}: ${p.to}`)))
      if (stale.length > 0) {
        findings.push(f('warn', 'harness', `${name}: payload`, 'payload-stale',
          `${stale.join(' · ')} differ from what ${version()} ships — run ${NPX_LATEST} init --agent ${name}`))
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
  // Every run, stated: a session without the reading is not broken canon, it runs on the step
  // budget (§4.7), and the line is how the human learns which one this session is on.
  ctx.out(kv('adapter', adapterLine(ctx.env, cfg.ok ? cfg.value.harness : undefined)))
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
