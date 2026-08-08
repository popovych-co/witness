// Row 103. The freeze is self-concealing: version() reports the RUNNING CLI, and all
// seven invocation surfaces (the engine prompt plus six skills) pin the CLI — so a
// frozen repo only ever runs the frozen CLI, which compares the payload against itself
// and reports clean. The one fact living outside that loop is what the registry
// publishes, which is why this is the single network call in the codebase.
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
// The scope's slash must be percent-encoded; the `@` must not be. Same shape pacote uses.
const PACKAGE = '@popovych.co%2Fwitness'
// Short on purpose: this rides inside `check`, and a validator that hangs on a bad
// network is worse than one that stays quiet about it.
const TIMEOUT_MS = 2000

// Best-effort and SILENT on every failure — offline, air-gapped, proxied, rate-limited,
// HTML interstitial, garbage JSON. `undefined` means "we do not know", which is never a
// finding: an air-gapped machine must report nothing about the network rather than a
// complaint about it, and nothing here may touch check's exit code (row 101).
//
// WITNESS_REGISTRY is a TEST SEAM, not a configuration key — it overrides the base URL
// and the literal `off` skips the query, which is what keeps the suite off the network.
// It is deliberately undocumented, on the precedent of crashPoint's WITNESS_CRASH_AFTER
// (txn.ts:26): row 90 killed WITNESS_HARNESS to establish that configuration has exactly
// one home, and the README says so outright. If suppressing this call ever becomes a
// real user need, it belongs in .witness/config.local.yaml with the other machine facts.
export async function latestPublished(
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const base = env.WITNESS_REGISTRY ?? DEFAULT_REGISTRY
  if (base === 'off') return undefined
  try {
    const res = await fetch(`${base}/-/package/${PACKAGE}/dist-tags`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const tags = (await res.json()) as { latest?: unknown }
    return typeof tags.latest === 'string' ? tags.latest : undefined
  } catch {
    return undefined
  }
}
