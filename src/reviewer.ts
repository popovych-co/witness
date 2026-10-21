import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ctx } from './cli.js'
import { validatePin, type Harness } from './harness.js'
import type { PolicyPin } from './journal.js'
import type { ParsedPin } from './pin.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'
import { resolveSpawn } from './spawn.js'
import { driveChild } from './drive-presence.js'
import { duration, limitIn, realClock, SINGLE_WAIT_MAX_MS, waitFor, type Clock, type Limit } from './usage.js'

export const PROMPT_NAMES = [
  'slicing-critic', 'plan-critic', 'code-reviewer', 'silent-failure-hunter',
  'type-design', 'pr-test', 'drift-reviewer', 'design-critic', 'design-reviewer',
] as const

export interface LensDoc { path: string; contents: string }
export interface Lens { name: string; contents: string; docs?: LensDoc[] }

export function promptsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')
}

export function resolvePrompt(name: string): Result<Lens> {
  const path = join(promptsDir(), `${name}.md`)
  if (!existsSync(path)) {
    return refuse([v('reviewers', 'unknown-reviewer', name,
      `a lens file at prompts/${name}.md (shipped: ${PROMPT_NAMES.join(' ')})`)])
  }
  return ok({ name, contents: readFileSync(path, 'utf8') })
}

// docs.<key> → which lenses at which gates consume it. The design-stage plan
// extends this map (design → design-critic / design-reviewer); keys here must
// stay in lockstep with DOC_KEYS in config.ts — no key without a consumer.
const DOC_CONSUMERS: Record<string, { lenses: string[]; gates: string[] }> = {
  conventions: { lenses: ['code-reviewer'], gates: ['implement', 'ship'] },
  design: { lenses: ['design-critic', 'design-reviewer'], gates: ['design', 'implement'] },
}

export function docKeysFor(gate: string, lens: string): string[] {
  return Object.entries(DOC_CONSUMERS)
    .filter(([, c]) => c.lenses.includes(lens) && c.gates.includes(gate))
    .map(([k]) => k)
}

export function loadLensDocs(root: string, paths: string[]): Result<LensDoc[]> {
  const docs: LensDoc[] = []
  const violations: Violation[] = []
  for (const p of paths) {
    const abs = join(root, p)
    if (!existsSync(abs)) {
      violations.push(v('docs', 'doc-missing', p,
        'an existing file — gates inject configured docs fail-closed; fix the path or restore the file'))
      continue
    }
    docs.push({ path: p, contents: readFileSync(abs, 'utf8') })
  }
  return violations.length ? refuse(violations) : ok(docs)
}

export function docsBlock(docs: LensDoc[]): string {
  if (docs.length === 0) return ''
  return `## Repo conventions (injected from docs config)\n\n${
    docs.map((d) => `### ${d.path}\n\n${d.contents}`).join('\n\n')
  }\n\n`
}

// Row 83: settled content policies, injected into every battery for the plan. The
// contradiction channel is reviewer self-report — deterministic semantic matching of a
// freeform finding against a pin is not honestly implementable, so the schema carries it.
export function pinsBlock(pins: PolicyPin[]): string {
  if (pins.length === 0) return ''
  return `## Settled policy pins (human decisions — do not re-litigate)\n\n` +
    `The human has pinned these content policies for this plan. They are settled: a finding that merely disagrees with a pin is not a finding. If a defect you must report can only be fixed by violating a pin, report it AND set \`"contradicts_pin": <pin number>\` on that finding — the gate escalates the conflict to the human. Where pins conflict, the later pin wins.\n\n` +
    pins.map((p) => `${p.ordinal}. ${p.text}`).join('\n') + '\n\n'
}

export function promptsSha(lenses: Lens[], extra?: string): string {
  const h = createHash('sha256')
  for (const l of [...lenses].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(`lens ${l.name} ${l.contents.length}\n`)
    h.update(l.contents)
    h.update('\n')
    // injected docs are part of what the reviewer read — an edited doc is a
    // different reviewer, exactly like an edited lens (verdict-cache key)
    for (const d of l.docs ?? []) {
      h.update(`doc ${d.path} ${d.contents.length}\n`)
      h.update(d.contents)
      h.update('\n')
    }
  }
  // policy pins are part of what every reviewer read — a changed pin-set re-arms review
  if (extra !== undefined && extra !== '') {
    h.update(`pins ${extra.length}\n`)
    h.update(extra)
    h.update('\n')
  }
  return h.digest('hex')
}

// The two machine-resolved knobs, split out: every reviewer lane resolves them once at
// its verb boundary (row 90 — invokeReviewer's own cwd is a temp dir under calibration,
// so it can never load config itself) and threads them down through the fan-out.
export interface InvokeExtras {
  timeoutMs?: number
  extensions?: readonly string[]
}

// `lens` reaches the reviewer as WITNESS_LENS, the way runners get WITNESS_SCREENS_DIR: the
// battery launches its lenses at once, so call order no longer says which lens a call was.
export interface InvokeOpts extends InvokeExtras { cwd: string; prompt: string; model?: string; lens?: string; clock?: Clock }

// Row 182. Inside a drive session a usage-limited reviewer call waits for the reset and
// retries, at most this long in all per invocation. Outside drive it refuses at once: an
// attended gate must never block silently for hours.
export const REVIEWER_WAIT_MAX_MS = SINGLE_WAIT_MAX_MS
const OUTSIDE_DRIVE_WANT = 'wait for the reset — witness drive waits it out on its own'

const REVIEWER_TIMEOUT_MS = 600_000
// One stalled call must not cost a whole run: a full calibration battery is ~200
// invocations over hours, and treating a transient stall as fatal throws away every
// sample already paid for. Retries are bounded so a genuinely wedged binary still ends.
const TIMEOUT_RETRIES = 2
const MAX_OUTPUT = 64 * 1024 * 1024
const TERM_GRACE_MS = 5_000
// setTimeout clamps a delay above 2^31-1 ms to 1 ms, which would turn a "never time out"
// config into an instant timeout on every call. spawnSync has no such ceiling.
const MAX_TIMER_MS = 2 ** 31 - 1
const EXIT_GRACE_MS = 2_000

interface Prepared {
  cmd: string
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  windowsVerbatimArguments: boolean
  timeout: number
}

interface Attempt {
  timedOut: boolean
  error?: Error
  status: number | null
  stdout: string
  stderr: string
}

// The two invokers share everything but the spawn itself, so they cannot drift apart:
// the pin check, the spawn resolution, and below, the mapping from what happened to a row.
function prepareInvocation(ctx: Ctx, harness: Harness, opts: InvokeOpts): Result<Prepared> {
  let pin: ParsedPin | undefined
  if (opts.model !== undefined) {
    const pinR = validatePin(harness, 'gates.model', opts.model)
    if (!pinR.ok) return refuse(pinR.violations)
    pin = pinR.value
  }
  const { cmd, args, env } = harness.reviewer.spawn(pin, opts.extensions)
  // Row 164: on Windows the CLI may be a `.cmd` shim, which only cmd.exe can start. The
  // prompt rides stdin, so the shim's second parse of the command line never sees it. A
  // reviewer that cannot be started is an invocation failure on every platform: the
  // resolution's own got/want, under the rule a missing binary has always reported.
  const run = resolveSpawn(cmd, args, {
    ...ctx.env, ...env, ...(opts.lens !== undefined ? { WITNESS_LENS: opts.lens } : {}),
  })
  if (!run.ok) return refuse(run.violations.map((x) => ({ ...x, rule: 'reviewer-invocation' })))
  return ok({
    cmd, file: run.value.file, args: run.value.args, env: run.value.env as NodeJS.ProcessEnv,
    windowsVerbatimArguments: run.value.windowsVerbatimArguments,
    timeout: opts.timeoutMs ?? REVIEWER_TIMEOUT_MS,
  })
}

function classifyAttempt(harness: Harness, p: Prepared, attempt: number, r: Attempt): 'retry' | Result<{ text: string }> {
  // A stall is NOT the missing-binary case. Reporting it as one sent the last
  // reader hunting a PATH problem on a machine where the reviewer answered in 6s.
  if (r.timedOut) {
    if (attempt < TIMEOUT_RETRIES) return 'retry'
    return refuse([v(p.cmd, 'reviewer-timeout',
      `no response in ${p.timeout}ms after ${attempt + 1} attempts`,
      'a reviewer that answers within the timeout — raise gates.reviewerTimeoutMs in witness.config.yaml if the model is simply slow')])
  }
  if (r.error) {
    return refuse([v(p.cmd, 'reviewer-invocation', String(r.error.message),
      `a runnable ${p.cmd} binary on PATH — gates invoke reviewers headlessly; witness check probes this`)])
  }
  if (r.status !== 0) {
    return refuse([v(p.cmd, 'reviewer-invocation',
      `exit ${String(r.status)}: ${r.stderr.slice(0, 200)}`, `${p.cmd} print mode exiting 0`)])
  }
  return harness.reviewer.parseEnvelope(r.stdout)
}

export function invokeReviewer(ctx: Ctx, harness: Harness, opts: InvokeOpts): Result<{ text: string }> {
  const pR = prepareInvocation(ctx, harness, opts)
  if (!pR.ok) return pR
  const p = pR.value
  for (let attempt = 0; ; attempt += 1) {
    const r = spawnSync(p.file, p.args, {
      cwd: opts.cwd,
      env: p.env,
      input: opts.prompt,
      encoding: 'utf8',
      timeout: p.timeout,
      maxBuffer: MAX_OUTPUT,
      windowsVerbatimArguments: p.windowsVerbatimArguments,
    })
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    const c = classifyAttempt(harness, p, attempt, {
      timedOut, error: timedOut ? undefined : r.error, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
    })
    if (c === 'retry') continue
    // Calibration's lane never waits: it refuses a limit as an attended gate does.
    const limit = usageLimitOf(c, Date.now())
    return limit ? refuse([v(p.cmd, 'usage-limit', limit.text, OUTSIDE_DRIVE_WANT)]) : c
  }
}

// The battery's invoker: lenses run at once, so a reviewer call cannot block the process.
// Settles on `close`, bounded by `exit` plus a grace, for D145's reason: a reviewer CLI
// spawns its own children, they inherit stdout, and a killed parent whose grandchild
// survives would otherwise hold the pipe — and this call — open with no timeout above it.
export async function invokeReviewerAsync(ctx: Ctx, harness: Harness, opts: InvokeOpts): Promise<Result<{ text: string }>> {
  const pR = prepareInvocation(ctx, harness, opts)
  if (!pR.ok) return pR
  const p = pR.value
  const clock = opts.clock ?? realClock
  const inDrive = driveChild(ctx.env) !== undefined
  let waited = 0
  let streak = 0
  for (let attempt = 0; ; ) {
    const r = await spawnAttempt(p, opts)
    const c = classifyAttempt(harness, p, attempt, r)
    if (c === 'retry') { attempt += 1; continue }
    const limit = usageLimitOf(c, clock.now())
    if (!limit) return c
    // A wait spends no timeout retry: the same rung is asked again after the reset.
    const wait = waitFor(limit, streak, clock.now())
    if (!inDrive || waited + wait > REVIEWER_WAIT_MAX_MS) {
      return refuse([v(p.cmd, 'usage-limit', limit.text, inDrive
        ? 'a reset inside the 6h reviewer wait — re-run the gate after it'
        : OUTSIDE_DRIVE_WANT)])
    }
    ctx.err(`reviewer: usage limit — waiting ${duration(wait)} · ${limit.text}`)
    await clock.sleep(wait)
    waited += wait
    streak += 1
  }
}

// Only a provider failure is read — a refusal's got, never verdict text: a finding that
// quotes a limit message stays a finding.
function usageLimitOf(r: Result<{ text: string }>, now: number): Limit | undefined {
  if (r.ok) return undefined
  const row = r.violations.find((x) => x.rule === 'reviewer-invocation')
  return row ? limitIn(row.got, now) : undefined
}

function spawnAttempt(p: Prepared, opts: InvokeOpts): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    const child = spawn(p.file, p.args, {
      cwd: opts.cwd, env: p.env, stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: p.windowsVerbatimArguments,
    })
    const out: string[] = []
    const err: string[] = []
    let outBytes = 0
    let epipe = false
    let timedOut = false
    let error: Error | undefined
    let status: number | null = null
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let grace: NodeJS.Timeout | undefined
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(grace)
      child.stdout.destroy()
      child.stderr.destroy()
      // Exit 0 after closing its stdin early means the reviewer answered without reading the
      // whole prompt — a verdict on content it never saw, so it fails closed, as sync does.
      if (epipe && status === 0 && !timedOut && error === undefined) {
        error = new Error('exited 0 before reading the whole prompt (EPIPE)')
      }
      resolve({ timedOut, error, status, stdout: out.join(''), stderr: err.join('') })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), TERM_GRACE_MS)
    }, Math.min(p.timeout, MAX_TIMER_MS))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      outBytes += Buffer.byteLength(c)
      if (outBytes > MAX_OUTPUT) {
        if (error === undefined) error = new Error('output exceeded 64 MiB')
        child.kill('SIGKILL')
        return
      }
      out.push(c)
    })
    child.stderr.on('data', (c: string) => { err.push(c) })
    // A reviewer that exits before reading its whole prompt closes the pipe under us: a
    // nonzero exit is the answer, and exit 0 is refused at settle.
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EPIPE') epipe = true
      else if (error === undefined) error = e
    })
    child.stdin.end(opts.prompt)
    child.on('error', (e) => { error = e; settle() })
    child.on('exit', (code) => {
      status = code
      clearTimeout(killTimer)
      grace = setTimeout(settle, EXIT_GRACE_MS)
    })
    child.on('close', (code) => { status = code; settle() })
  })
}

export function parseVerdictText(text: string): Result<unknown> {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text)
  const body = (fenced ? fenced[1] ?? '' : text).trim()
  try {
    return ok(JSON.parse(body))
  } catch {
    return refuse([v('verdict', 'verdict-unparseable', body.slice(0, 120),
      'a JSON object {coverage, findings} and nothing else')])
  }
}
