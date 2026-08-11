// D121. The block: every set of live options renders ranked, with runnable commands.
// This module is PURE — it takes journal entries and ids the caller already resolved and
// returns data. It never loads canon, never reads a finding's claim text, and never
// decides anything a gate predicate consumes.

export type Depth = 'root' | 'deferral' | 'terminal'

export interface Option {
  command: string
  depth: Depth
  why?: string
  when?: string
  tradeoff?: string
  note?: string
  runnable: boolean
  judgeFirst?: string
}

export interface Decision {
  key: string
  options: Option[]
  rule: string
  anchor?: string
}

// Commands are emitted raw (D120): `esc` would quote the `--note "…"` argument and the
// line would paste into a shell as an empty note.
export function renderDecision(d: Decision): string[] {
  const n = d.options.length
  const out = [`${d.key}: ${n} option${n === 1 ? '' : 's'} · 1 is recommended`]
  d.options.forEach((o, i) => {
    const tags = [String(i + 1), ...(i === 0 ? ['recommended'] : []), o.depth,
      ...(o.runnable ? [] : ['not runnable'])]
    out.push(tags.join(' · '))
    out.push(`   ${o.command}`)
    if (o.why) out.push(`   why: ${o.why}`)
    if (o.judgeFirst) out.push(`   judge-first: ${o.judgeFirst}`)
    if (o.when) out.push(`   when: ${o.when}`)
    if (o.tradeoff) out.push(`   tradeoff: ${o.tradeoff}`)
    if (o.note) out.push(`   note: ${o.note}`)
  })
  // No run: line when the recommendation cannot be pasted — a run: that needs editing is
  // the promise this block exists to keep, broken.
  if (d.options[0]?.runnable) out.push(`run: ${d.options[0]!.command}`)
  return out
}
