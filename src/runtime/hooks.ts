// Lifecycle hooks on the captureFetch seam — PreRequest can block a call
// before it goes out (cost-gating/safety), PostRequest observes the response
// (redaction/cost alerts). Pure and unit-testable; index.ts wires these into
// captureFetch() and decides what to do with the results (throw / print).

export interface PreRequestContext {
  url: string
  method: string
  /** Derived from the credential shape, never the credential itself. */
  apiKeyShape: "live" | "test" | "boot" | "unknown"
  env: NodeJS.ProcessEnv
}

export interface PreRequestResult {
  block: boolean
  reason?: string
}

export interface PostRequestContext {
  url: string
  method: string
  status: number
  durationMs: number
  /** Lower-cased header name -> value (or null when absent). */
  headers: Record<string, string | null>
  env: NodeJS.ProcessEnv
}

export type PreRequestHook = (context: PreRequestContext) => PreRequestResult
export type PostRequestHook = (context: PostRequestContext) => string | null

/**
 * Classifies an API key by its documented prefix — never returns the key
 * itself. `ods_*` is the legacy prefix that predates the `secapi_*` rename;
 * the auth layer still hashes/validates it prefix-agnostically alongside
 * `secapi_*` (services/datastream-api/src/lib/db/auth-key-format.test.ts), so
 * a legacy live key is exactly as real/billable as a `secapi_live_` one.
 */
export function apiKeyShape(apiKey: string | undefined): PreRequestContext["apiKeyShape"] {
  if (!apiKey) return "unknown"
  if (/^(secapi|ods)_live_/i.test(apiKey)) return "live"
  if (/^(secapi|ods)_test_/i.test(apiKey)) return "test"
  if (/^(secapi|ods)_boot_/i.test(apiKey)) return "boot"
  return "unknown"
}

/** Loopback hosts are always a local mock server, never the real paid API. */
function isLocalHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "0.0.0.0"
  } catch {
    return false
  }
}

/**
 * Built-in PreRequest hook: refuse a live-mode (billable, real-money) API call
 * against the real API while running inside CI. Never blocks calls to a
 * loopback host (127.0.0.1/localhost/::1) — those are local mock servers
 * (e.g. this package's own black-box tests, or `--base-url` pointed at a
 * fixture), not the production API a CI job could accidentally spend real
 * money on. Escape hatch: SECAPI_ALLOW_LIVE_IN_CI=1.
 */
export const blockLiveModeInCi: PreRequestHook = (context) => {
  const isCi = Boolean(context.env.CI?.trim())
  const allowed = context.env.SECAPI_ALLOW_LIVE_IN_CI?.trim() === "1"
  if (isCi && context.apiKeyShape === "live" && !allowed && !isLocalHost(context.url)) {
    return {
      block: true,
      reason: "Refusing a live-mode API call inside CI (CI is set and the credential is a secapi_live_ key). Use a secapi_test_ key in CI, or set SECAPI_ALLOW_LIVE_IN_CI=1 to override.",
    }
  }
  return { block: false }
}

const DEFAULT_COST_HEADER = "secapi-estimated-cost"

/**
 * Built-in PostRequest hook: warns (never blocks — the call already happened)
 * when a response's estimated cost crosses `thresholdUsd`. Returns the warning
 * text, or null when nothing crossed the threshold or no threshold is set.
 */
export function warnOnExpensiveRequest(context: PostRequestContext, thresholdUsd: number | undefined): string | null {
  if (thresholdUsd === undefined || !Number.isFinite(thresholdUsd)) return null
  const raw = context.headers[DEFAULT_COST_HEADER]
  // Production formats this header as "$0.0200" (formatEstimatedCostUsd) — strip
  // the currency symbol/thousands separators the same way the CLI's own cost
  // ledger parser does (src/cost/cost.ts) before comparing to the threshold.
  const cost = raw ? Number.parseFloat(raw.replace(/[$,\s]/g, "")) : Number.NaN
  if (!Number.isFinite(cost) || cost < thresholdUsd) return null
  return `⚠ Expensive request: ${context.method} ${context.url} cost $${cost.toFixed(4)} (threshold $${thresholdUsd.toFixed(4)}).`
}

export function runPreRequestHooks(hooks: PreRequestHook[], context: PreRequestContext): PreRequestResult {
  for (const hook of hooks) {
    const result = hook(context)
    if (result.block) return result
  }
  return { block: false }
}

/** Runs every PostRequest hook and returns the non-null messages, in order. */
export function runPostRequestHooks(hooks: PostRequestHook[], context: PostRequestContext): string[] {
  const messages: string[] = []
  for (const hook of hooks) {
    const message = hook(context)
    if (message) messages.push(message)
  }
  return messages
}

/** Lower-cases Headers into a plain record for hook contexts. */
export function headersToRecord(headers: Headers): Record<string, string | null> {
  const record: Record<string, string | null> = {}
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value
  })
  return record
}
