import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ctx } from './cli.js'
import type { PolicyPin } from './journal.js'
import { ok, refuse, v, type Result, type Violation } from './refusal.js'

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

export interface InvokeOpts { cwd: string; prompt: string; model?: string }

const REVIEWER_TIMEOUT_MS = 600_000
// One stalled call must not cost a whole run: a full calibration battery is ~200
// invocations over hours, and treating a transient stall as fatal throws away every
// sample already paid for. Retries are bounded so a genuinely wedged binary still ends.
const TIMEOUT_RETRIES = 2

export function invokeClaude(ctx: Ctx, opts: InvokeOpts): Result<{ text: string }> {
  const args = ['-p', '--output-format', 'json']
  if (opts.model) args.push('--model', opts.model)
  const timeout = Number(ctx.env.SPECFLOW_REVIEWER_TIMEOUT_MS) || REVIEWER_TIMEOUT_MS
  for (let attempt = 0; ; attempt += 1) {
    const r = spawnSync('claude', args, {
      cwd: opts.cwd,
      env: ctx.env as NodeJS.ProcessEnv,
      input: opts.prompt,
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (r.error) {
      // A stall is NOT the missing-binary case. Reporting it as one sent the last
      // reader hunting a PATH problem on a machine where `claude` answered in 6s.
      if ((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        if (attempt < TIMEOUT_RETRIES) continue
        return refuse([v('claude', 'reviewer-timeout',
          `no response in ${timeout}ms after ${attempt + 1} attempts`,
          'a reviewer that answers within the timeout — raise SPECFLOW_REVIEWER_TIMEOUT_MS if the model is simply slow')])
      }
      return refuse([v('claude', 'reviewer-invocation', String((r.error as Error).message),
        'a runnable claude binary on PATH — gates invoke reviewers headlessly; specflow check probes this')])
    }
    if (r.status !== 0) {
      return refuse([v('claude', 'reviewer-invocation',
        `exit ${String(r.status)}: ${(r.stderr ?? '').slice(0, 200)}`, 'claude -p exiting 0')])
    }
    try {
      const envelope = JSON.parse(r.stdout) as { result?: unknown }
      if (typeof envelope.result !== 'string') throw new Error('missing result')
      return ok({ text: envelope.result })
    } catch {
      return refuse([v('claude', 'envelope-unparseable', (r.stdout ?? '').slice(0, 120),
        'a --output-format json envelope carrying a result string')])
    }
  }
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
