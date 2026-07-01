// Live --watch dashboards. The pure policy here (which commands are watchable,
// per-domain refresh intervals, TTY/--once gating) is unit-testable; the Ink
// full-screen renderer (watch-view.tsx) consumes it.
//
// --watch only engages in a real TTY. Piped/CI/--json runs a SINGLE shot and
// keep the exact one-shot JSON, so the pipe contract is preserved.

/** Command keys that support a live --watch dashboard. */
export const WATCHABLE_COMMAND_KEYS = new Set([
  "factors dashboard",
  "factors extreme-moves",
  "factors extreme-pairs",
  "factors returns-intraday",
  "macro regimes",
  "dilution score",
])

export function isWatchable(commandKey: string): boolean {
  return WATCHABLE_COMMAND_KEYS.has(commandKey)
}

// Per-domain refresh defaults (ms) — factors tick fast, macro is slow.
const DEFAULT_INTERVAL_MS = 15_000
const DOMAIN_INTERVALS: Array<{ prefix: string; ms: number }> = [
  { prefix: "factors", ms: 10_000 },
  { prefix: "dilution", ms: 60_000 },
  { prefix: "macro", ms: 600_000 },
]

export function defaultIntervalMs(commandKey: string): number {
  for (const { prefix, ms } of DOMAIN_INTERVALS) {
    if (commandKey.startsWith(prefix)) return ms
  }
  return DEFAULT_INTERVAL_MS
}

/** Parse --interval (seconds), clamped to [2s, 1h]; falls back to the domain default. */
export function resolveIntervalMs(commandKey: string, intervalFlagSeconds: number | undefined): number {
  if (intervalFlagSeconds === undefined || !Number.isFinite(intervalFlagSeconds)) return defaultIntervalMs(commandKey)
  const ms = Math.round(intervalFlagSeconds * 1000)
  return Math.max(2_000, Math.min(3_600_000, ms))
}

export interface WatchDecision {
  /** Run the live full-screen dashboard (TTY + --watch + not --once + not --json). */
  watch: boolean
  /** Run the command once and exit (everything else, incl. --once and non-TTY). */
  singleShot: boolean
}

export function decideWatch(input: {
  watchFlag: boolean
  onceFlag: boolean
  isTty: boolean
  jsonFlag: boolean | undefined
  /** An --output <file> path forces single-shot machine output (pipe-safe). */
  hasOutputPath?: boolean
}): WatchDecision {
  const liveOk =
    input.watchFlag && !input.onceFlag && input.isTty && input.jsonFlag !== true && !input.hasOutputPath
  return { watch: liveOk, singleShot: !liveOk }
}
