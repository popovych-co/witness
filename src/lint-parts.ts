// Row 261. `ship.lint`'s parts as repo commands: what trust grants and migrate proposes.
import type { RunCommand } from './allowlist.js'
import type { Config } from './config.js'

// Every part under its own source, in file order.
export function lintCommands(cfg: Config): RunCommand[] {
  return (cfg.ship.lint ?? []).map((p) => ({ cmd: p.cmd, source: p.source }))
}
