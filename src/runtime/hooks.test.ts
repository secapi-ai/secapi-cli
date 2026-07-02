import { describe, expect, test } from "bun:test"
import {
  apiKeyShape,
  blockLiveModeInCi,
  headersToRecord,
  runPostRequestHooks,
  runPreRequestHooks,
  warnOnExpensiveRequest,
  type PostRequestContext,
  type PreRequestContext,
} from "./hooks.ts"

describe("apiKeyShape", () => {
  test("classifies by documented prefix", () => {
    expect(apiKeyShape("secapi_live_abc123")).toBe("live")
    expect(apiKeyShape("secapi_test_abc123")).toBe("test")
    expect(apiKeyShape("secapi_boot_abc123")).toBe("boot")
    expect(apiKeyShape("something-else")).toBe("unknown")
    expect(apiKeyShape(undefined)).toBe("unknown")
  })

  test("classifies legacy ods_ prefixes the same as secapi_ (auth hashes them prefix-agnostically)", () => {
    expect(apiKeyShape("ods_live_abc123")).toBe("live")
    expect(apiKeyShape("ods_test_abc123")).toBe("test")
    expect(apiKeyShape("ods_boot_abc123")).toBe("boot")
  })
})

function preContext(overrides: Partial<PreRequestContext> = {}): PreRequestContext {
  return { url: "https://api.secapi.ai/v1/health", method: "GET", apiKeyShape: "live", env: {}, ...overrides }
}

describe("blockLiveModeInCi", () => {
  test("blocks a live-mode key when CI is set", () => {
    const result = blockLiveModeInCi(preContext({ env: { CI: "true" } }))
    expect(result.block).toBe(true)
    expect(result.reason).toContain("live-mode")
  })

  test("does not block outside CI", () => {
    expect(blockLiveModeInCi(preContext({ env: {} })).block).toBe(false)
  })

  test("does not block a test-mode key in CI", () => {
    expect(blockLiveModeInCi(preContext({ apiKeyShape: "test", env: { CI: "true" } })).block).toBe(false)
  })

  test("SECAPI_ALLOW_LIVE_IN_CI=1 overrides the block", () => {
    expect(blockLiveModeInCi(preContext({ env: { CI: "true", SECAPI_ALLOW_LIVE_IN_CI: "1" } })).block).toBe(false)
  })

  test("unknown-shaped keys are not blocked (only a confirmed live key triggers it)", () => {
    expect(blockLiveModeInCi(preContext({ apiKeyShape: "unknown", env: { CI: "true" } })).block).toBe(false)
  })

  test("never blocks a loopback host — that's a local mock server, not the real API", () => {
    for (const url of [
      "http://127.0.0.1:4173/v1/health",
      "http://localhost:4173/v1/health",
      "http://[::1]:4173/v1/health",
    ]) {
      expect(blockLiveModeInCi(preContext({ url, env: { CI: "true" } })).block).toBe(false)
    }
  })

  test("still blocks a real (non-loopback) host in CI", () => {
    expect(blockLiveModeInCi(preContext({ url: "https://api.secapi.ai/v1/health", env: { CI: "true" } })).block).toBe(true)
  })

  test("blocks a legacy ods_live_ key exactly like a secapi_live_ key", () => {
    expect(blockLiveModeInCi(preContext({ apiKeyShape: apiKeyShape("ods_live_abc123"), env: { CI: "true" } })).block).toBe(true)
  })
})

describe("runPreRequestHooks", () => {
  test("stops at the first blocking hook", () => {
    const calls: string[] = []
    const first = () => {
      calls.push("first")
      return { block: true, reason: "nope" }
    }
    const second = () => {
      calls.push("second")
      return { block: false }
    }
    const result = runPreRequestHooks([first, second], preContext())
    expect(result).toEqual({ block: true, reason: "nope" })
    expect(calls).toEqual(["first"])
  })

  test("no hooks block -> not blocked", () => {
    expect(runPreRequestHooks([() => ({ block: false })], preContext())).toEqual({ block: false })
  })
})

function postContext(overrides: Partial<PostRequestContext> = {}): PostRequestContext {
  return { url: "https://api.secapi.ai/v1/intelligence/query", method: "POST", status: 200, durationMs: 120, headers: {}, env: {}, ...overrides }
}

describe("warnOnExpensiveRequest", () => {
  test("warns when the estimated cost meets or exceeds the threshold", () => {
    const message = warnOnExpensiveRequest(postContext({ headers: { "secapi-estimated-cost": "0.05" } }), 0.05)
    expect(message).toContain("Expensive request")
    expect(message).toContain("$0.0500")
  })

  test("no warning below the threshold", () => {
    expect(warnOnExpensiveRequest(postContext({ headers: { "secapi-estimated-cost": "0.01" } }), 0.05)).toBeNull()
  })

  test("no threshold configured -> never warns", () => {
    expect(warnOnExpensiveRequest(postContext({ headers: { "secapi-estimated-cost": "999" } }), undefined)).toBeNull()
  })

  test("missing or non-numeric cost header -> no warning", () => {
    expect(warnOnExpensiveRequest(postContext({ headers: {} }), 0.01)).toBeNull()
    expect(warnOnExpensiveRequest(postContext({ headers: { "secapi-estimated-cost": "n/a" } }), 0.01)).toBeNull()
  })

  test("parses a dollar-formatted cost header (production's actual formatEstimatedCostUsd shape)", () => {
    const message = warnOnExpensiveRequest(postContext({ headers: { "secapi-estimated-cost": "$0.0200" } }), 0.01)
    expect(message).toContain("Expensive request")
    expect(message).toContain("$0.0200")
  })
})

describe("runPostRequestHooks", () => {
  test("collects every non-null message in order", () => {
    const messages = runPostRequestHooks([() => "a", () => null, () => "b"], postContext())
    expect(messages).toEqual(["a", "b"])
  })
})

describe("headersToRecord", () => {
  test("lower-cases header names", () => {
    const headers = new Headers({ "SECAPI-Estimated-Cost": "0.01", "X-Custom": "value" })
    expect(headersToRecord(headers)).toEqual({ "secapi-estimated-cost": "0.01", "x-custom": "value" })
  })
})
