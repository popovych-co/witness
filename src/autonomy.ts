import type { Config } from './config.js'
import { cmd, kv } from './toon.js'

// Rows 171-175. PURE, like recommend.ts: the setting's rendering, the kept-stop names, and
// (row 171) the policy that acts on a stop under `autonomy: on`. It takes facts its caller
// resolved and returns data — it never loads canon, config or the trust list.

// The stops that reach a human whatever the setting says (design §3 G2). Named once here,
// because every surface that prints the set must print the same set.
export type KeptStop = 'design-look' | 'unmet-need' | 'trust-grant'

export const KEPT_STOP_NAMES: Record<KeptStop, string> = {
  'design-look': 'design look',
  'unmet-need': 'unmet need',
  'trust-grant': 'trust grant',
}

// Printed first on `next`, `start`, `gate` and `decide --show` whenever the repo has opted
// in, so a skill learns the mode from CLI output and never from memory (A1, A8).
export function autonomyLines(cfg: Pick<Config, 'autonomy'>): string[] {
  if (!cfg.autonomy) return []
  return [kv('autonomy', 'on'),
    kv('kept-stops', (Object.keys(KEPT_STOP_NAMES) as KeptStop[]).map((k) => KEPT_STOP_NAMES[k]).join(' · '))]
}

// `cmd`, not `kv`: a detail can carry a quoted command, and `kv` would quote the whole
// line into something that no longer pastes (D120).
export function keptStopLine(stop: KeptStop, detail: string): string {
  return cmd('kept-stop', `${KEPT_STOP_NAMES[stop]} — ${detail}`)
}
