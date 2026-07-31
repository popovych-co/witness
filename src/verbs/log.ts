import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { git, primaryRoot, tryGit } from '../gitio.js'
import { journalRel, readStream, streamExists, type Entry, type StatusEntry } from '../journal.js'
import { renderRefusal, v } from '../refusal.js'
import { short } from '../sha.js'
import { rows } from '../toon.js'

function detail(e: Entry): string {
  switch (e.t) {
    case 'recap': {
      const size = (k: string) => (Array.isArray(e[k]) ? (e[k] as unknown[]).length : 0)
      return `class=${String(e.class)} goals=${size('goals')} non_goals=${size('non_goals')} slices=${size('slices')}`
    }
    case 'write': {
      const covers = Array.isArray(e.covers) && e.covers.length ? ` covers=${(e.covers as string[]).join('+')}` : ''
      return `artifact=${String(e.artifact)} sha=${short(String(e.sha))}${covers}`
    }
    case 'write-refused': {
      const pairs = Array.isArray(e.rules)
        ? (e.rules as Array<{ field: string; rule: string }>).map((r) => `${r.field}:${r.rule}`).join('+')
        : ''
      return `artifact=${String(e.artifact)} rules=${pairs}`
    }
    case 'gate-run': {
      const g = e as unknown as { gate: string; round: number; outcome: string; reviewed_sha: string }
      return `gate ${g.gate} r${g.round} ${g.outcome} @${g.reviewed_sha.slice(0, 7)}`
    }
    case 'human-decision': {
      const d = e as unknown as { gate: string; decision: string; note?: string }
      return `${d.gate}: ${d.decision}${d.note ? ` — ${d.note.slice(0, 60)}` : ''}`
    }
    case 'status': {
      const s = e as unknown as { from: string; to: string; cause: string }
      return `${s.from} → ${s.to} (${s.cause})`
    }
    default: {
      const { v: _v, t: _t, ...rest } = e
      return JSON.stringify(rest).slice(0, 100)
    }
  }
}

const streamIds = (root: string): string[] => {
  const dir = join(root, '.witness', 'journal')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort()
}

function successorOf(root: string, id: string): string | undefined {
  const terminal = readStream(root, id).find(
    (e) => e.t === 'status' && (e as unknown as StatusEntry).to === 'superseded') as unknown as StatusEntry | undefined
  return terminal?.by
}

function predecessorsOf(root: string, id: string): string[] {
  return streamIds(root).filter((s) => successorOf(root, s) === id)
}

export function lineageChain(root: string, id: string): string[] {
  const chain = [id]
  for (let cur = id; ; ) {
    const prev = predecessorsOf(root, cur)[0]
    if (!prev || chain.includes(prev)) break
    chain.unshift(prev); cur = prev
  }
  for (let cur = id; ; ) {
    const next = successorOf(root, cur)
    if (!next || chain.includes(next)) break
    chain.push(next); cur = next
  }
  return chain
}

function commitIndex(root: string): Map<string, number> {
  const map = new Map<string, number>()
  git(root, 'rev-list', '--reverse', 'HEAD').split('\n').filter(Boolean)
    .forEach((sha, i) => map.set(sha, i))
  return map
}

function lineOrigins(root: string, rel: string): string[] {
  const blame = tryGit(root, 'blame', '--porcelain', '--', rel)
  if (!blame.ok) return []
  const shas: string[] = []
  for (const line of blame.out.split('\n')) {
    if (/^[0-9a-f]{40} \d+ \d+/.test(line)) shas.push(line.slice(0, 40))
  }
  return shas
}

export function mergedRows(root: string): Array<{ stream: string; entry: Entry }> {
  const order = commitIndex(root)
  const rowsOut: Array<{ stream: string; entry: Entry; idx: number; lineNo: number }> = []
  for (const stream of streamIds(root)) {
    const entries = readStream(root, stream)
    const origins = lineOrigins(root, journalRel(stream))
    entries.forEach((entry, lineNo) => {
      const sha = origins[lineNo]
      rowsOut.push({ stream, entry, lineNo, idx: sha !== undefined ? (order.get(sha) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER })
    })
  }
  rowsOut.sort((a, b) => a.idx - b.idx || a.stream.localeCompare(b.stream) || a.lineNo - b.lineNo)
  return rowsOut.map(({ stream, entry }) => ({ stream, entry }))
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { all: { type: 'boolean' }, lineage: { type: 'boolean' } },
    allowPositionals: true,
  })
  const id = positionals[0]
  if (!values.all && !id) {
    renderRefusal([v('id', 'required', 'absent', 'witness log <id> [--lineage] | witness log --all')]).forEach(ctx.err)
    return EXIT.REFUSED
  }
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) { renderRefusal(rootRes.violations).forEach(ctx.err); return EXIT.REFUSED }
  const root = rootRes.value

  if (values.all) {
    const merged = mergedRows(root)
    rows('all', ['n', 'stream', 't', 'detail'], merged.map((r, i) => ({ n: i + 1, stream: r.stream, t: r.entry.t, detail: detail(r.entry) })))
      .forEach(ctx.out)
    return EXIT.OK
  }

  if (values.lineage) {
    // a lineage member (e.g. a re-slice successor) may have no gate-run/status
    // activity of its own yet — walk the chain by journal existence on the *other*
    // streams rather than requiring id's own stream to exist.
    const chain = lineageChain(root, id!)
    ctx.out(`lineage: ${chain.join(' → ')}`)
    const merged = chain.flatMap((sid) => readStream(root, sid).map((entry) => ({ stream: sid, entry })))
    rows('lineage', ['n', 'stream', 't', 'detail'], merged.map((r, i) => ({ n: i + 1, stream: r.stream, t: r.entry.t, detail: detail(r.entry) })))
      .forEach(ctx.out)
    return EXIT.OK
  }

  if (!streamExists(root, id!)) {
    renderRefusal([v('id', 'unknown-stream', id!, 'an artifact or effort with a journal stream')]).forEach(ctx.err)
    return EXIT.REFUSED
  }

  const entries = readStream(root, id!)
  rows('entries', ['n', 't', 'detail'], entries.map((e, i) => ({ n: i + 1, t: e.t, detail: detail(e) })))
    .forEach(ctx.out)
  return EXIT.OK
}
