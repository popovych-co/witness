import { EXIT, type Ctx } from '../cli.js'
import { loadConfig } from '../config.js'
import { driveChild } from '../drive-presence.js'
import { primaryRoot } from '../gitio.js'
import { JOB_ENV, RESULT_MAX_BYTES, isJobKey, jobKinds, type JobResult } from '../jobs.js'
import { renderRefusal, v, type Violation } from '../refusal.js'
import { withRunnerTurn } from '../runner-lock.js'
import { crashPoint } from '../txn.js'

// Row 257. One shard of a drive job, run as drive's child: `witness job <kind> <key> <shard>/<of>`.
// It reports on stdout, one JSON object per line — `{"job":"running"}` once its work begins (after
// its turn, when its kind takes one: drive starts the shard's box there), then
// `{"job":"result","outcome":"done","result":…}` or `{"job":"result","outcome":"failed","why":"…"}`
// last — and journals nothing. Drive journals the outcome itself, because a child stopped at its box
// dies at once and must never die mid-write (settled point 3). A refusal writes nothing to stdout.
//
// The env marks are scheduling guards, not a trust boundary: a session never does a job's work
// (spec §3.5), and jobs run only as drive's children. The verb journals nothing either way.
const USAGE = 'usage: witness job <kind> <key> <shard>/<of>'
const MAX_SHARDS = 1_000
const SHARD_RE = /^([1-9][0-9]*)\/([1-9][0-9]*)$/

const refused = (ctx: Ctx, rows: Violation[]): number => {
  renderRefusal(rows).forEach((l) => ctx.err(l))
  return EXIT.REFUSED
}

export async function run(ctx: Ctx, argv: string[]): Promise<number> {
  if (driveChild(ctx.env) !== undefined) {
    return refused(ctx, [v('witness job', 'job-in-session', 'a drive session', 'nothing — drive runs its jobs itself; a session never does a job\'s work')])
  }
  if (ctx.env[JOB_ENV] === undefined) {
    return refused(ctx, [v('witness job', 'job-outside-drive', `${JOB_ENV} unset`, 'nothing — jobs run only as witness drive\'s children')])
  }
  if (argv.length !== 3) {
    ctx.err(USAGE)
    return EXIT.REFUSED
  }
  const [name, key, part] = argv as [string, string, string]
  const kind = jobKinds(ctx.env).find((k) => k.kind === name)
  if (kind === undefined) return refused(ctx, [v('kind', 'unknown-job', name, 'a job kind this CLI registers')])
  if (!isJobKey(key)) return refused(ctx, [v('key', 'bad-key', key, 'a job key — [a-z0-9][a-z0-9._@-]*, at most 200 characters')])
  const m = SHARD_RE.exec(part)
  const shard = m ? Number(m[1]) : NaN
  const of = m ? Number(m[2]) : NaN
  if (!(shard >= 1 && shard <= of && of <= MAX_SHARDS)) {
    return refused(ctx, [v('shard', 'bad-shard', part, `<shard>/<of>, integers with 1 ≤ shard ≤ of ≤ ${MAX_SHARDS}`)])
  }
  const rootR = primaryRoot(ctx.cwd)
  if (!rootR.ok) return refused(ctx, rootR.violations)
  const root = rootR.value
  const cfgR = loadConfig(root)
  if (!cfgR.ok) return refused(ctx, cfgR.violations)
  const unit = { kind: kind.kind, key, shards: of }
  const work = (env: Ctx['env']): JobResult => {
    ctx.out(JSON.stringify({ job: 'running' }))
    try {
      return kind.run(root, { ...ctx, env }, cfgR.value, unit, shard)
    } catch {
      return { outcome: 'failed', why: 'the job threw' }
    }
  }
  const result = kind.turn
    ? withRunnerTurn(root, ctx, `job ${kind.kind} ${key} ${shard}/${of}`, work, { job: kind.kind, gated: kind.gated })
    : work(ctx.env)
  crashPoint(ctx.env, 'job-result')
  const line = JSON.stringify({ job: 'result', ...result })
  // Settled point 4: a result line rides one pipe write, so a bigger one reads failed.
  ctx.out(Buffer.byteLength(line, 'utf8') <= RESULT_MAX_BYTES ? line : JSON.stringify({ job: 'result', outcome: 'failed', why: 'result over 48 KiB' }))
  return EXIT.OK
}
