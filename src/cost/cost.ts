// Cost transparency — surface the two-tier metering everywhere. The CLI already
// captures per-request cost headers (SECAPI-Estimated-Cost / -Token-Count /
// -Cache-Hit / -Maturity) and can emit them via --request-summary. This module
// parses that summary, accumulates a session ledger, formats inline footers, and
// decides when a metered call needs confirmation. Pure + unit-testable.

export interface RequestCost {
  estimatedCost: number // in dollars (0 when absent)
  tokenCount: number
  cacheHit: boolean | null
  maturity: string | null
  requestId: string | null
}

const num = (v: unknown) => {
  const n = typeof v === "string" ? Number.parseFloat(v.replace(/[$,\s]/g, "")) : typeof v === "number" ? v : Number.NaN
  return Number.isFinite(n) ? n : 0
}

/**
 * Parse a `secapi_cli_request_summary` object (as emitted by --request-summary:
 * `{ object, requests: [ { estimatedCost, tokenCount, cacheHit, maturity,
 * requestId }, ... ] }`). Aggregates all requests into a single RequestCost
 * (summed cost/tokens; cacheHit/maturity/requestId from the last request). Also
 * tolerates a flat single-request object.
 */
export function parseRequestSummary(raw: unknown): RequestCost | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (r.object !== "secapi_cli_request_summary") return null
  const reqs = Array.isArray(r.requests) ? (r.requests as Array<Record<string, unknown>>) : [r]
  if (reqs.length === 0) return { estimatedCost: 0, tokenCount: 0, cacheHit: null, maturity: null, requestId: null }
  let estimatedCost = 0
  let tokenCount = 0
  let cacheHit: boolean | null = null
  let maturity: string | null = null
  let requestId: string | null = null
  for (const req of reqs) {
    estimatedCost += num(req.estimatedCost)
    tokenCount += num(req.tokenCount)
    if (typeof req.cacheHit === "boolean") cacheHit = req.cacheHit
    if (typeof req.maturity === "string") maturity = req.maturity
    if (typeof req.requestId === "string") requestId = req.requestId
  }
  return { estimatedCost, tokenCount, cacheHit, maturity, requestId }
}

/** Find the balanced `{...}` request-summary object anywhere in a stderr blob. */
export function findRequestSummaryJson(stderr: string): string | null {
  const marker = '"object": "secapi_cli_request_summary"'
  const mi = stderr.lastIndexOf(marker)
  if (mi === -1) return null
  const open = stderr.lastIndexOf("{", mi)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < stderr.length; i += 1) {
    const ch = stderr[i]
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return stderr.slice(open, i + 1)
    }
  }
  return null
}

/** Extract + parse the (possibly multi-line, pretty-printed) summary from stderr. */
export function extractRequestSummary(stderr: string): RequestCost | null {
  const json = findRequestSummaryJson(stderr)
  if (!json) return null
  try {
    return parseRequestSummary(JSON.parse(json))
  } catch {
    return null
  }
}

/** Remove the request-summary JSON object from a stderr blob (for clean display). */
export function stripRequestSummary(stderr: string): string {
  const json = findRequestSummaryJson(stderr)
  if (!json) return stderr.trim()
  return stderr.replace(json, "").trim()
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 })
const INT = new Intl.NumberFormat("en-US")

/** "$0.0012 · 1,240 tok · ⚡cache · ga" — compact inline cost footer (plain text). */
export function formatCostFooter(cost: RequestCost): string {
  const parts: string[] = [USD.format(cost.estimatedCost)]
  if (cost.tokenCount > 0) parts.push(`${INT.format(cost.tokenCount)} tok`)
  if (cost.cacheHit === true) parts.push("⚡cache")
  if (cost.maturity) parts.push(cost.maturity)
  return `⎿ ${parts.join(" · ")}`
}

export interface CostLedger {
  record(cost: RequestCost): void
  totalDollars(): number
  calls(): number
  cacheHits(): number
  cacheHitRate(): number
  totalTokens(): number
  /** "$0.04 · 18 calls · 61% cache" — the status-line meter. */
  meterText(): string
}

export function createCostLedger(): CostLedger {
  let total = 0
  let calls = 0
  let hits = 0
  let cacheable = 0
  let tokens = 0
  return {
    record: (cost) => {
      total += cost.estimatedCost
      calls += 1
      tokens += cost.tokenCount
      if (cost.cacheHit !== null) {
        cacheable += 1
        if (cost.cacheHit) hits += 1
      }
    },
    totalDollars: () => total,
    calls: () => calls,
    cacheHits: () => hits,
    cacheHitRate: () => (cacheable === 0 ? 0 : hits / cacheable),
    totalTokens: () => tokens,
    meterText: () => {
      const parts = [USD.format(total), `${calls} call${calls === 1 ? "" : "s"}`]
      if (cacheable > 0) parts.push(`${Math.round((hits / cacheable) * 100)}% cache`)
      return parts.join(" · ")
    },
  }
}

// The AI-metered (ai_queries) command keys — the LLM-backed, charge-per-call
// surfaces. Everything else is deterministic data on the cheap/free tier.
export const METERED_COMMAND_KEYS = new Set([
  "intelligence company",
  "intelligence security",
  "intelligence earnings-preview",
  "intelligence footnotes-query",
])

export function isMeteredCommand(key: string): boolean {
  return METERED_COMMAND_KEYS.has(key)
}

/** Whether a metered call should prompt for confirmation (est ≥ threshold). */
export function shouldConfirmCost(estimatedDollars: number, thresholdDollars: number): boolean {
  if (thresholdDollars <= 0) return true // threshold 0 ⇒ always confirm metered calls
  return estimatedDollars >= thresholdDollars
}
