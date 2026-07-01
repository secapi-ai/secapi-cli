import { describe, expect, test } from "bun:test"
import {
  createCostLedger,
  extractRequestSummary,
  formatCostFooter,
  isMeteredCommand,
  parseRequestSummary,
  shouldConfirmCost,
  stripRequestSummary,
} from "./cost.ts"

// The REAL shape emitted by emitRequestSummary(): { object, requests: [...] },
// pretty-printed (2-space), cost fields nested per-request with string numerics.
function realSummary(requests: Array<Record<string, unknown>>): string {
  return `${JSON.stringify({ object: "secapi_cli_request_summary", requests }, null, 2)}\n`
}

describe("parseRequestSummary (real wrapper shape)", () => {
  test("aggregates requests[]: sums cost/tokens, last cacheHit/maturity/requestId", () => {
    const c = parseRequestSummary({
      object: "secapi_cli_request_summary",
      requests: [
        { estimatedCost: "$0.0012", tokenCount: "1,240", cacheHit: false, maturity: "ga", requestId: "req_1" },
        { estimatedCost: "0.0008", tokenCount: "500", cacheHit: true, maturity: "ga", requestId: "req_2" },
      ],
    })
    expect(c?.estimatedCost).toBeCloseTo(0.002, 6)
    expect(c?.tokenCount).toBe(1740)
    expect(c?.cacheHit).toBe(true)
    expect(c?.requestId).toBe("req_2")
  })
  test("rejects non-summary objects", () => {
    expect(parseRequestSummary({ object: "other" })).toBeNull()
    expect(parseRequestSummary(null)).toBeNull()
  })
  test("empty requests[] → zeroed cost", () => {
    const c = parseRequestSummary({ object: "secapi_cli_request_summary", requests: [] })
    expect(c).toEqual({ estimatedCost: 0, tokenCount: 0, cacheHit: null, maturity: null, requestId: null })
  })
})

describe("extractRequestSummary (multi-line pretty output)", () => {
  test("extracts the real multi-line summary from stderr", () => {
    const stderr = `Some warning line\n${realSummary([{ estimatedCost: "0.5", tokenCount: "10", cacheHit: true, maturity: "ga", requestId: "r1" }])}`
    const c = extractRequestSummary(stderr)
    expect(c?.estimatedCost).toBe(0.5)
    expect(c?.tokenCount).toBe(10)
    expect(c?.cacheHit).toBe(true)
  })
  test("works when an error precedes the summary", () => {
    const stderr = `Error: something failed (request_id: req_x)\n${realSummary([{ estimatedCost: "$0.1", tokenCount: "3" }])}`
    expect(extractRequestSummary(stderr)?.estimatedCost).toBe(0.1)
  })
  test("returns null when absent", () => {
    expect(extractRequestSummary("just an error\n")).toBeNull()
  })
})

describe("stripRequestSummary", () => {
  test("removes the multi-line summary, keeping the error text", () => {
    const stderr = `Error: boom\n${realSummary([{ estimatedCost: "0.1" }])}`
    const stripped = stripRequestSummary(stderr)
    expect(stripped).toContain("Error: boom")
    expect(stripped).not.toContain("secapi_cli_request_summary")
    expect(stripped).not.toContain("estimatedCost")
  })
})

describe("formatCostFooter", () => {
  test("includes cost, tokens, cache, maturity", () => {
    const footer = formatCostFooter({ estimatedCost: 0.0012, tokenCount: 1240, cacheHit: true, maturity: "ga", requestId: null })
    expect(footer).toContain("$0.0012")
    expect(footer).toContain("1,240 tok")
    expect(footer).toContain("⚡cache")
    expect(footer).toContain("ga")
  })
  test("omits cache marker when not a hit", () => {
    expect(formatCostFooter({ estimatedCost: 0, tokenCount: 0, cacheHit: false, maturity: null, requestId: null })).not.toContain("⚡")
  })
})

describe("createCostLedger", () => {
  test("accumulates total, calls, tokens, and cache-hit rate", () => {
    const l = createCostLedger()
    l.record({ estimatedCost: 0.01, tokenCount: 100, cacheHit: true, maturity: null, requestId: null })
    l.record({ estimatedCost: 0.03, tokenCount: 200, cacheHit: false, maturity: null, requestId: null })
    expect(l.totalDollars()).toBeCloseTo(0.04, 5)
    expect(l.calls()).toBe(2)
    expect(l.totalTokens()).toBe(300)
    expect(l.cacheHitRate()).toBeCloseTo(0.5, 5)
    expect(l.meterText()).toContain("2 calls")
    expect(l.meterText()).toContain("50% cache")
  })
})

describe("metering + confirmation", () => {
  test("isMeteredCommand flags only the AI-backed intelligence commands", () => {
    expect(isMeteredCommand("intelligence company")).toBe(true)
    expect(isMeteredCommand("filings latest")).toBe(false)
  })
  test("shouldConfirmCost: threshold 0 always confirms; else by estimate", () => {
    expect(shouldConfirmCost(0.001, 0)).toBe(true)
    expect(shouldConfirmCost(0.001, 0.01)).toBe(false)
    expect(shouldConfirmCost(0.02, 0.01)).toBe(true)
  })
})
