import { parseArgs } from 'node:util'
import { EXIT, type Ctx } from '../cli.js'
import { FLOOR_KEY, FLOOR_STREAM, stateFloor } from '../floor.js'
import { primaryRoot } from '../gitio.js'
import { appendEntry } from '../journal.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { kv } from '../toon.js'
import { compareTriple, version } from '../version.js'

// Row 116's safety valve. The floor is derived from what the state has seen, which is
// correct until a published version turns out to be broken: then every repository that ran
// it once carries a bound no fixed CLI can satisfy, and the tool has locked its users out
// over its own defect. Lowering it is a human act with a reason, so it is journaled as a
// policy-pin — the entry type row 83 added for exactly this shape — and never a flag on
// another verb or a file someone can edit without leaving a trace.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { show: { type: 'boolean' }, set: { type: 'string' }, note: { type: 'string' } },
  })
  const rootRes = primaryRoot(ctx.cwd)
  if (!rootRes.ok) {
    renderRefusal(rootRes.violations).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  const root = rootRes.value

  if (values.set !== undefined) {
    // Both faults in one refusal, the way row 111 collects an approve's: a human who fixes
    // one and learns about the other on the re-run has spent a turn witness could have saved.
    const violations: Violation[] = []
    if (compareTriple(values.set, values.set) === undefined) {
      violations.push(v('--set', 'bad-pin', values.set,
        'a numeric triple such as 0.9.0 — prerelease ordering is out of scope (row 102)'))
    }
    if (values.note === undefined || values.note.trim() === '') {
      violations.push(v('--note', 'note-required', 'absent',
        'a reason — lowering the bound is a decision the journal has to be able to explain later'))
    }
    if (violations.length > 0) {
      renderRefusal(violations).forEach((l) => ctx.err(l))
      return EXIT.REFUSED
    }
    appendEntry(root, FLOOR_STREAM, { t: 'policy-pin', key: FLOOR_KEY, pin: values.set, note: values.note })
    ctx.out(kv('floor', `${values.set} — set by hand: ${values.note}`))
    return EXIT.OK
  }

  const floor = stateFloor(root)
  ctx.out(floor === undefined
    ? kv('floor', 'none — this state predates the writer stamp, so it claims no bound')
    : kv('floor', `${floor.pin} · from ${floor.stream} · this CLI is ${version()}`))
  return EXIT.OK
}
