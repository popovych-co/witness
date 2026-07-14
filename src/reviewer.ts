import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ctx } from './cli.js'
import { ok, refuse, v, type Result } from './refusal.js'

export const PROMPT_NAMES = [
  'slicing-critic', 'plan-critic', 'code-reviewer', 'silent-failure-hunter',
  'type-design', 'pr-test', 'drift-reviewer',
] as const

export interface Lens { name: string; contents: string }

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

export function promptsSha(lenses: Lens[]): string {
  const h = createHash('sha256')
  for (const l of [...lenses].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(`lens ${l.name} ${l.contents.length}\n`)
    h.update(l.contents)
    h.update('\n')
  }
  return h.digest('hex')
}

export interface InvokeOpts { cwd: string; prompt: string; model?: string }

export function invokeClaude(ctx: Ctx, opts: InvokeOpts): Result<{ text: string }> {
  const args = ['-p', '--output-format', 'json']
  if (opts.model) args.push('--model', opts.model)
  const r = spawnSync('claude', args, {
    cwd: opts.cwd,
    env: ctx.env as NodeJS.ProcessEnv,
    input: opts.prompt,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) {
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
