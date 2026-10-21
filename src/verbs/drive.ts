import { parseArgs } from 'node:util'
import { queueAsk } from '../ask.js'
import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { detachDrive, driveLoop } from '../drive.js'
import { acquireDriveLock, DRIVE_ENV, DRIVE_LOG_ENV, driveChild, driveHolder, watchLine } from '../drive-presence.js'
import { primaryRoot } from '../gitio.js'
import { renderRefusal, v } from '../refusal.js'
import { loadCanon } from '../scan.js'
import { kv } from '../toon.js'
import { resolveFlow } from './next.js'

// D145, amended by row 180. Drive runs every session itself. Under autonomy it asks no
// decision question, so it needs no terminal; with autonomy off (or `--manual`) it asks at
// every stop and stays a human's foreground verb. The recursion guard is no longer the TTY
// rule but the marker drive sets on every child: agents are what drive spawns, never what
// spawns drive. That refusal is first — before the root lookup — because "a drive session
// typed this" is true wherever it was typed.
export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  const refused = (field: string, rule: string, got: string, want: string): number => {
    renderRefusal([v(field, rule, got, want)]).forEach((l) => ctx.err(l))
    return EXIT.REFUSED
  }
  if (driveChild(ctx.env) !== undefined) {
    return refused(DRIVE_ENV, 'drive-inside-drive', `set (${ctx.env[DRIVE_ENV]})`,
      'run witness drive in your own terminal — agents are what drive spawns, never what spawns drive')
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) { renderRefusal(rootR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  const root = rootR.value
  const cfgR = loadConfig(root)
  if (!cfgR.ok) { renderRefusal(cfgR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }

  const { values } = parseArgs({
    args: argv,
    options: {
      flow: { type: 'string' }, 'max-spawns': { type: 'string' }, manual: { type: 'boolean' },
      detach: { type: 'boolean' }, ask: { type: 'string' },
    },
    allowPositionals: true,
  })
  let maxSpawns: number | undefined
  if (values['max-spawns'] !== undefined) {
    const n = Number(values['max-spawns'])
    if (!Number.isInteger(n) || n < 1) {
      return refused('--max-spawns', 'invalid', String(values['max-spawns']), 'an integer >= 1 — sessions this invocation may spawn')
    }
    maxSpawns = n
  }
  const manual = values.manual === true
  const autonomous = cfgR.value.autonomy && !manual
  const why = manual ? '--manual' : 'autonomy off'
  if (values.detach && !autonomous) {
    return refused('--detach', 'detach-needs-autonomy', why,
      'autonomy: on in witness.config.yaml — a background drive cannot ask you anything')
  }
  if (!ctx.isTTY && !autonomous) {
    return refused('tty', 'drive-needs-tty', `non-interactive session · ${why}`,
      'a terminal — drive asks you at every stop unless autonomy: on is set in witness.config.yaml')
  }
  const holder = driveHolder(root)
  if (holder !== undefined && holder.pid !== process.pid) {
    return refused('.witness/drive.lock', 'drive-running', `pid ${holder.pid}`, `one drive per repo — ${watchLine(holder)}`)
  }
  // `--flow` is a claim, and a false claim refuses at the door — the loop only scopes to it.
  if (values.flow !== undefined) {
    const flowR = resolveFlow(loadCanon(root), values.flow)
    if (!flowR.ok) { renderRefusal(flowR.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  }
  if (values.ask !== undefined) {
    const res = queueAsk(ctx, root, values.ask)
    if (!res.ok) { renderRefusal(res.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(kv('ask', `${res.value.id} — ${res.value.already ? 'already queued' : 'queued'}`))
  }
  if (values.detach) {
    const args = [
      ...(values.flow !== undefined ? ['--flow', values.flow] : []),
      ...(maxSpawns !== undefined ? ['--max-spawns', String(maxSpawns)] : []),
    ]
    const r = detachDrive(root, ctx, args)
    if (!r.ok) { renderRefusal(r.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
    ctx.out(`drive: started in the background · pid ${r.value.pid}`)
    ctx.out(`watch: ${watchLine(r.value)}`)
    return EXIT.OK
  }
  const log = ctx.env[DRIVE_LOG_ENV]
  const lock = acquireDriveLock(root, log !== undefined ? { log } : {})
  if (!lock.ok) { renderRefusal(lock.violations).forEach((l) => ctx.err(l)); return EXIT.REFUSED }
  try {
    return await driveLoop(root, cfgR.value, ctx, {
      ...(values.flow !== undefined ? { flow: values.flow } : {}),
      ...(maxSpawns !== undefined ? { maxSpawns } : {}),
      ...(manual ? { manual } : {}),
    })
  } finally {
    lock.value()
  }
}
