import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { getPrompt } from "../../contracts/src/index.ts"

const cliEntry = new URL("./index.ts", import.meta.url)
const secretValues = [
  "secapi_live_ARGV_SHOULD_NOT_LEAK",
  "bearer_ARGV_SHOULD_NOT_LEAK",
  "bearer_ENV_BACKED_AUTH",
  "bearer_OMNI_ENV_BACKED_AUTH",
  "opr_live_OPERATOR_AUTH",
  "opr_live_OMNI_OPERATOR_AUTH",
  "opr_live_OMNI_DATASTREAM_OPERATOR_AUTH",
  "secapi_live_ENV_BACKED_AUTH",
  "secapi_live_DOCTOR_ECHO_SECRET",
  "secapi_live_OMNI_ENV_BACKED_AUTH",
  "secapi_live_PROFILE_AUTH",
  "secapi_live_STDIN_BACKED_AUTH",
  "bearer_STDIN_BACKED_AUTH",
]

type CapturedRequest = {
  method: string
  path: string
  searchParams: Record<string, string>
  headers: Record<string, string>
  body: string
}

let server: ReturnType<typeof Bun.serve>
let requests: CapturedRequest[] = []

async function runCli(command: string[], options: {
  env?: Record<string, string | undefined>
  input?: string
} = {}) {
  const env = { ...process.env }
  for (const name of [
    "SECAPI_API_KEY",
    "SECAPI_BASE_URL",
    "SECAPI_BEARER_TOKEN",
    "SECAPI_OPERATOR_API_KEY",
    "SECAPI_API_BASE_URL",
    "SECAPI_CONFIG_FILE",
    "SECAPI_PROFILE",
    "OMNI_DATASTREAM_API_KEY",
    "OMNI_OPERATOR_API_KEY",
    "OMNI_DATASTREAM_OPERATOR_API_KEY",
    "OMNI_DATASTREAM_BEARER_TOKEN",
    "OMNI_DATASTREAM_BASE_URL",
    "OMNI_DATASTREAM_API_BASE_URL",
  ]) {
    delete env[name]
  }

  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry.pathname, ...command], {
      env: {
        ...env,
        SECAPI_BASE_URL: `http://127.0.0.1:${server.port}`,
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (status) => resolve({ status, stdout, stderr }))
    if (options.input !== undefined) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }
  })
}

function assertNoSecretLeak(stdout: string, stderr: string) {
  for (const secret of secretValues) {
    expect(stdout.includes(secret)).toBe(false)
    expect(stderr.includes(secret)).toBe(false)
  }
}

function parseRequestSummaryFromStderr(stderr: string) {
  const jsonStart = stderr.indexOf('{\n  "object": "secapi_cli_request_summary"')
  expect(jsonStart).toBeGreaterThanOrEqual(0)
  return JSON.parse(stderr.slice(jsonStart))
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const responseHeaders = {
        "Request-Id": "req_cli_test",
        "traceparent": "00-test-trace-test-span-01",
        "SECAPI-Estimated-Cost": "$0.0042",
        "SECAPI-Token-Count": "123",
        "SECAPI-Token-Count-Source": "test",
        "SECAPI-Cache-Hit": "false",
        "SECAPI-Maturity": "beta",
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        searchParams: Object.fromEntries(url.searchParams.entries()),
        headers: Object.fromEntries(request.headers.entries()),
        body: request.method === "GET" || request.method === "HEAD" ? "" : await request.text(),
      })
      if (url.searchParams.get("format") === "csv") {
        const body = url.pathname === "/v1/factors/valuations/stocks"
          ? "rank,symbol,factor_key\n1,MSFT,VALUE\n"
          : "rank,factor_key\n1,VALUE\n"
        return new Response(body, {
          headers: { ...responseHeaders, "content-type": "text/csv; charset=utf-8" },
        })
      }
      if (url.pathname === "/v1/me" && request.headers.get("x-api-key") === "secapi_live_DOCTOR_ECHO_SECRET") {
        return Response.json({
          object: "error",
          code: "doctor_secret_echo",
          message: "bad key secapi_live_DOCTOR_ECHO_SECRET",
        }, { status: 401, headers: responseHeaders })
      }
      if (url.pathname === "/v1/me") {
        return Response.json({
          object: "principal",
          requestId: "req_cli_test",
          principal: {
            authMode: "api_key",
            principalId: "ak_test_123",
            orgId: "org_test",
            scopes: ["read:sec", "billing:read"],
            publicPlanKey: "personal",
            billingState: "payg_active",
          },
        }, { headers: responseHeaders })
      }
      if (url.pathname === "/v1/billing") {
        return Response.json({
          object: "billing_snapshot",
          requestId: "req_cli_test",
          publicPlanKey: "personal",
          billingState: "payg_active",
          rightsKey: "personal",
          cardOnFile: true,
          freeGrantTotal: 100,
          freeGrantRemaining: 60,
          budget: {
            accruedUsageCents: 2500,
            spendCapCents: 10000,
          },
          monthlyQuotas: {
            ai_queries: {
              limit: 600,
              remaining: 475,
            },
          },
        }, { headers: responseHeaders })
      }
      if (url.pathname === "/v1/usage") {
        return Response.json({
          object: "usage_summary",
          requestId: "req_cli_test",
          orgId: "org_test",
          recordedAt: "2026-06-23T22:45:00.000Z",
          totalRequests: 42,
          meters: [
            {
              meterClass: "ai_queries",
              count: 30,
              successCount: 29,
              errorCount: 1,
              avgLatencyMs: 120.5,
              lastSeenAt: "2026-06-23T22:44:00.000Z",
            },
          ],
        }, { headers: responseHeaders })
      }
      if (url.pathname === "/v1/limits") {
        return Response.json({
          object: "limits",
          requestId: "req_cli_test",
          orgId: "org_test",
          recordedAt: "2026-06-23T22:45:00.000Z",
          effectivePlanKey: "personal",
          billingState: "payg_active",
          quotas: [
            {
              meterClass: "section_extract",
              limit: 1000,
              period: "month",
              allowed: true,
              planKey: "personal",
              billingState: "payg_active",
            },
          ],
        }, { headers: responseHeaders })
      }
      if (url.pathname === "/v1/portfolio/hedge") {
        const body = JSON.parse(requests.at(-1)?.body || "{}")
        return Response.json(fakePortfolioHedge(body.holdings ?? []))
      }
      if (url.pathname === "/v1/models/factor-analysis") {
        const body = JSON.parse(requests.at(-1)?.body || "{}")
        return Response.json(fakeModelFactorAnalysis(body))
      }
      if (url.searchParams.get("q") === "server-required-error") {
        return Response.json({
          object: "error",
          code: "server_required_field",
          message: "A downstream field is required",
        }, { status: 400, headers: responseHeaders })
      }
      return Response.json({ ok: true }, { headers: responseHeaders })
    },
  })
})

beforeEach(() => {
  requests = []
})

afterAll(() => {
  server.stop(true)
})

const investorMetadata = {
  provenance: {
    source: "test",
    sourceLabel: "Test",
    accessionNumber: null,
    filingUrl: "https://secapi.ai",
    retrievedAt: "2026-06-11T00:00:00.000Z",
    parserVersion: "test",
  },
  sourceRights: {
    source: "test",
    sourceLabel: "Test",
    posture: "public_safe",
    publicAvailability: "public",
    contractStatus: "approved",
    restrictions: [],
  },
}

function fakePortfolioAnalysis(holdings: unknown[] = []) {
  return {
    object: "portfolio_analysis",
    id: "portfolio_analysis_test",
    asOf: "2026-06-11",
    holdings,
    exposures: [],
    fit: null,
    benchmarkLabel: null,
    benchmarkTilts: [],
    whatIfComparison: null,
    positionViews: [],
    positionExposures: [],
    attribution: [],
    hedgeSuggestions: [],
    optimizationNotes: [],
    factorNeutralPlan: [],
    summaryMd: "Test portfolio analysis.",
    ...investorMetadata,
  }
}

function fakePortfolioHedge(holdings: unknown[] = []) {
  return {
    object: "portfolio_hedge",
    id: "portfolio_hedge_test",
    analysisId: null,
    asOf: "2026-06-11",
    country: "US",
    lookback: "6m",
    objective: "factor_neutral",
    mode: "compact",
    constraints: {},
    holdings,
    targetExposures: [],
    hedges: [],
    residualExposure: {},
    exposures: [],
    optimizationNotes: [],
    factorNeutralPlan: [],
    summaryMd: "Test hedge analysis.",
    ...investorMetadata,
  }
}

function fakeModelFactorAnalysis(body: Record<string, any>) {
  const holdings = Array.isArray(body.holdings) ? body.holdings : []
  return {
    object: "model_factor_analysis",
    id: "model_factor_analysis_test",
    asOf: "2026-06-11",
    model: {
      id: body.model?.id ?? "test_model",
      label: body.model?.label ?? "Test model",
      description: body.model?.description ?? "Test model.",
      tags: body.model?.tags ?? [],
      source: body.model?.source ?? "client",
    },
    country: body.country ?? "US",
    lookback: body.lookback ?? "6m",
    window: body.window ?? "1m",
    category: body.category ?? "all",
    holdings,
    include: {
      attribution: body.include?.attribution ?? true,
      hedge: body.include?.hedge ?? false,
      optimizer: body.include?.optimizer ?? false,
      positionViews: body.include?.positionViews ?? true,
    },
    analysis: fakePortfolioAnalysis(holdings),
    attribution: null,
    hedge: null,
    optimizerCandidates: [],
    optimizerCandidateCount: 0,
    optimizerCandidateSample: [],
    selectedCandidate: null,
    optimizerDisclosures: [],
    positionViews: [],
    positionExposures: [],
    summaryMd: "Test model factor analysis.",
    ...investorMetadata,
  }
}

describe("CLI credential handling", () => {
  test("--api-key argv credentials fail without echoing the secret", async () => {
    const result = await runCli(["health", "--api-key", "secapi_live_ARGV_SHOULD_NOT_LEAK"])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--api-key is no longer supported")
    expect(result.stderr).toContain("SECAPI_API_KEY")
    expect(result.stderr).toContain("--api-key-stdin")
    assertNoSecretLeak(result.stdout, result.stderr)
    expect(requests).toHaveLength(0)
  })

  test("--bearer-token argv credentials fail without echoing the secret", async () => {
    const result = await runCli(["agent", "bootstrap-token", "--bearer-token=bearer_ARGV_SHOULD_NOT_LEAK"])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--bearer-token is no longer supported")
    expect(result.stderr).toContain("SECAPI_BEARER_TOKEN")
    expect(result.stderr).toContain("--bearer-token-stdin")
    assertNoSecretLeak(result.stdout, result.stderr)
    expect(requests).toHaveLength(0)
  })

  test("SECAPI_API_KEY env auth sends x-api-key", async () => {
    const result = await runCli(["health"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/healthz")
    expect(requests[0]?.headers["x-api-key"]).toBe("secapi_live_ENV_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("--request-summary keeps stdout parseable and writes request metadata to stderr", async () => {
    const result = await runCli(["health", "--request-summary"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ ok: true })
    const summary = parseRequestSummaryFromStderr(result.stderr)
    expect(summary).toMatchObject({
      object: "secapi_cli_request_summary",
      requests: [{
        method: "GET",
        path: "/healthz",
        status: 200,
        requestId: "req_cli_test",
        traceparent: "00-test-trace-test-span-01",
        estimatedCost: "$0.0042",
        tokenCount: "123",
        tokenCountSource: "test",
        cacheHit: false,
        maturity: "beta",
      }],
    })
    expect(typeof summary.requests[0].durationMs).toBe("number")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("--request-summary is still emitted after API errors", async () => {
    const result = await runCli(["companies", "search", "--q", "server-required-error", "--request-summary"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("A downstream field is required")
    const summary = parseRequestSummaryFromStderr(result.stderr)
    expect(summary).toMatchObject({
      object: "secapi_cli_request_summary",
      requests: [{
        method: "GET",
        path: "/v1/companies/search",
        status: 400,
        requestId: "req_cli_test",
      }],
    })
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("SECAPI_OPERATOR_API_KEY env auth sends x-api-key", async () => {
    const result = await runCli(["health"], {
      env: { SECAPI_OPERATOR_API_KEY: "opr_live_OPERATOR_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers["x-api-key"]).toBe("opr_live_OPERATOR_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("legacy OMNI operator env auth sends x-api-key", async () => {
    const result = await runCli(["health"], {
      env: { OMNI_OPERATOR_API_KEY: "opr_live_OMNI_OPERATOR_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers["x-api-key"]).toBe("opr_live_OMNI_OPERATOR_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("legacy OMNI datastream env auth sends x-api-key", async () => {
    const result = await runCli(["health"], {
      env: { OMNI_DATASTREAM_API_KEY: "secapi_live_OMNI_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers["x-api-key"]).toBe("secapi_live_OMNI_ENV_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("legacy OMNI datastream operator env auth sends x-api-key", async () => {
    const result = await runCli(["health"], {
      env: { OMNI_DATASTREAM_OPERATOR_API_KEY: "opr_live_OMNI_DATASTREAM_OPERATOR_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers["x-api-key"]).toBe("opr_live_OMNI_DATASTREAM_OPERATOR_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("legacy OMNI base URL env is honored", async () => {
    const fallbackServer = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push({
          path: `fallback:${url.pathname}`,
          searchParams: Object.fromEntries(url.searchParams.entries()),
          headers: Object.fromEntries(request.headers.entries()),
        })
        return Response.json({ ok: true })
      },
    })

    try {
      const result = await runCli(["health"], {
        env: {
          SECAPI_BASE_URL: undefined,
          OMNI_DATASTREAM_BASE_URL: `http://127.0.0.1:${fallbackServer.port}`,
        },
      })

      expect(result.status).toBe(0)
      expect(requests[0]?.path).toBe("fallback:/healthz")
      assertNoSecretLeak(result.stdout, result.stderr)
    } finally {
      fallbackServer.stop(true)
    }
  })

  test("legacy OMNI API base URL env is honored", async () => {
    const fallbackServer = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push({
          path: `api-fallback:${url.pathname}`,
          searchParams: Object.fromEntries(url.searchParams.entries()),
          headers: Object.fromEntries(request.headers.entries()),
        })
        return Response.json({ ok: true })
      },
    })

    try {
      const result = await runCli(["health"], {
        env: {
          SECAPI_BASE_URL: undefined,
          OMNI_DATASTREAM_API_BASE_URL: `http://127.0.0.1:${fallbackServer.port}`,
        },
      })

      expect(result.status).toBe(0)
      expect(requests[0]?.path).toBe("api-fallback:/healthz")
      assertNoSecretLeak(result.stdout, result.stderr)
    } finally {
      fallbackServer.stop(true)
    }
  })

  test("SECAPI_BEARER_TOKEN env auth sends bearer token", async () => {
    const result = await runCli(["health"], {
      env: { SECAPI_BEARER_TOKEN: "bearer_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers.authorization).toBe("Bearer bearer_ENV_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("--api-key-stdin reads x-api-key from stdin", async () => {
    const result = await runCli(["health", "--api-key-stdin"], {
      input: "secapi_live_STDIN_BACKED_AUTH\n",
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers["x-api-key"]).toBe("secapi_live_STDIN_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("--bearer-token-stdin reads bearer token from stdin", async () => {
    const result = await runCli(["health", "--bearer-token-stdin"], {
      input: "bearer_STDIN_BACKED_AUTH\n",
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers.authorization).toBe("Bearer bearer_STDIN_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("stdin credential flags reject separated boolean-looking values", async () => {
    const apiKeyResult = await runCli(["health", "--api-key-stdin", "false"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(apiKeyResult.status).not.toBe(0)
    expect(apiKeyResult.stdout).toBe("")
    expect(apiKeyResult.stderr).toContain("--api-key-stdin does not accept a value")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(apiKeyResult.stdout, apiKeyResult.stderr)

    const bearerResult = await runCli(["health", "--bearer-token-stdin", "false"], {
      env: { SECAPI_BEARER_TOKEN: "bearer_ENV_BACKED_AUTH" },
    })

    expect(bearerResult.status).not.toBe(0)
    expect(bearerResult.stdout).toBe("")
    expect(bearerResult.stderr).toContain("--bearer-token-stdin does not accept a value")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(bearerResult.stdout, bearerResult.stderr)
  })

  test("legacy OMNI bearer env auth sends bearer token", async () => {
    const result = await runCli(["health"], {
      env: { OMNI_DATASTREAM_BEARER_TOKEN: "bearer_OMNI_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers.authorization).toBe("Bearer bearer_OMNI_ENV_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("package exposes preferred secapi bin and legacy omni-sec alias", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json()

    expect(packageJson.bin.secapi).toBe("dist/index.js")
    expect(packageJson.bin[["omni", "sec"].join("-")]).toBe("dist/index.js")
  })
})

describe("CLI version and search commands", () => {
  test("--version prints the bare package version, not the help banner", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json()
    const result = await runCli(["--version"])

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(packageJson.version)
    expect(result.stdout).not.toContain("SEC API CLI")
    expect(requests).toHaveLength(0)
  })

  test("-v alias prints the version", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json()
    const result = await runCli(["-v"])

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(packageJson.version)
    expect(result.stdout).not.toContain("Commands:")
  })

  test("root help commands still print help successfully", async () => {
    for (const command of [[], ["help"], ["--help"], ["-h"], ["help", "--api-key-stdin"]]) {
      const result = await runCli(command)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("SEC API CLI")
      expect(result.stdout).toContain("Start here:")
      expect(result.stdout).toContain("Core workflows:")
      expect(result.stdout).toContain("Discovery:")
      expect(result.stdout).toContain("secapi config show")
      expect(result.stdout).toContain("secapi config profiles")
      expect(result.stdout).toContain("secapi help all")
      expect(result.stdout).toContain("--base-url <url>")
      expect(result.stdout).not.toContain("Full command inventory")
      expect(result.stdout.split("\n").length).toBeLessThan(60)
      expect(result.stderr).toBe("")
    }
    expect(requests).toHaveLength(0)
  })

  test("root help ignores broken base URL config so recovery help still prints", async () => {
    const result = await runCli(["--help"], {
      env: { SECAPI_BASE_URL: "not-a-url" },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("SEC API CLI")
    expect(result.stdout).toContain("secapi config show")
    expect(result.stderr).toBe("")
    expect(requests).toHaveLength(0)
  })

  test("full root help remains available without credentials or requests", async () => {
    for (const command of [["help", "all"], ["--help-all"]]) {
      const result = await runCli(command, {
        env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("SEC API CLI")
      expect(result.stdout).toContain("Commands:")
      expect(result.stdout).toContain("secapi config profiles")
      expect(result.stdout).toContain("secapi filings latest --ticker AAPL --form 10-K")
      expect(result.stdout).toContain("secapi factors valuations")
      expect(result.stdout.split("\n").length).toBeGreaterThan(100)
      expect(result.stderr).toBe("")
      assertNoSecretLeak(result.stdout, result.stderr)
    }
    expect(requests).toHaveLength(0)
  })

  test("--help-all is root-only and fails locally on API commands", async () => {
    const result = await runCli(["health", "--help-all"])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Unknown option for secapi health: --help-all")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("per-command help is specific and never calls the API", async () => {
    const result = await runCli(["filings", "latest", "--help"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Usage: secapi filings latest --ticker")
    expect(result.stdout).toContain("--form <form>")
    expect(result.stdout).toContain("Examples:")
    expect(result.stderr).toBe("")
    expect(requests).toHaveLength(0)
  })

  test("portfolio analyze help documents file-backed benchmark inputs", async () => {
    const result = await runCli(["portfolio", "analyze", "--help"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("--benchmark-label <label>")
    expect(result.stdout).toContain("--benchmark-holdings-file <path>")
    expect(result.stdout).not.toContain("--benchmark <symbol>")
    expect(result.stderr).toBe("")
    expect(requests).toHaveLength(0)
  })

  test("single-token command help resolves before treating --help as a subcommand", async () => {
    for (const command of [["health", "--help"], ["me", "--help"], ["init", "--help"], ["agent-context", "--help"], ["examples", "--help"]]) {
      const result = await runCli(command)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`Usage: secapi ${command[0]}`)
      expect(result.stderr).toBe("")
    }
    expect(requests).toHaveLength(0)
  })

  test("implemented commands without handwritten help still get fallback command help", async () => {
    const result = await runCli(["companies", "search", "--help"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Usage: secapi companies search --q Apple")
    expect(result.stdout).toContain("--q|--query")
    expect(result.stdout).toContain("Examples:")
    expect(result.stderr).toBe("")
    expect(requests).toHaveLength(0)
  })

  test("config show help stays local-only and does not ask for credentials", async () => {
    const result = await runCli(["config", "show", "--help"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Usage: secapi config show")
    expect(result.stdout).toContain("Print local CLI configuration")
    expect(result.stdout).not.toContain("Authentication: set SECAPI_API_KEY")
    expect(result.stderr).toBe("")
    expect(requests).toHaveLength(0)
  })

  test("config profiles help stays local-only and does not ask for credentials", async () => {
    const result = await runCli(["config", "profiles", "--help"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Usage: secapi config profiles")
    expect(result.stdout).toContain("List configured no-secret profiles")
    expect(result.stdout).not.toContain("Authentication: set SECAPI_API_KEY")
    expect(result.stderr).toBe("")
    expect(requests).toHaveLength(0)
  })

  test("group help lists commands without resolving stdin credentials", async () => {
    const result = await runCli(["filings", "--help", "--api-key-stdin"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Usage: secapi filings <command>")
    expect(result.stdout).toContain("secapi filings search")
    expect(result.stdout).toContain("secapi filings latest")
    expect(result.stderr).toBe("")
    expect(requests).toHaveLength(0)
  })

  test("examples prints starter workflows locally for agents and humans", async () => {
    const json = await runCli(["examples"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(json.status).toBe(0)
    expect(json.stderr).toBe("")
    const catalog = JSON.parse(json.stdout)
    expect(catalog.object).toBe("secapi_cli_examples")
    expect(catalog.examples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "diagnose-setup",
        command: "secapi doctor",
        auth: "optional_api_key",
        callsApi: true,
        mutates: false,
      }),
      expect.objectContaining({
        id: "latest-10k",
        command: "secapi filings latest --ticker AAPL --form 10-K",
        auth: "api_key",
        callsApi: true,
        mutates: false,
      }),
      expect.objectContaining({
        id: "agent-context",
        command: "secapi agent-context --output secapi-cli-context.json",
        auth: "none",
        callsApi: false,
        mutates: false,
      }),
      expect.objectContaining({
        id: "portfolio-holdings-file",
        command: "secapi portfolio analyze --holdings-file holdings.json --benchmark-label SPY --benchmark-holdings-file benchmark.json --keys VALUE,QUALITY --response-mode compact",
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "holdings.json",
            json: [
              { symbol: "AAPL", weight: 0.6 },
              { symbol: "MSFT", weight: 0.4 },
            ],
          }),
          expect.objectContaining({
            path: "benchmark.json",
            json: [{ symbol: "SPY", weight: 1 }],
          }),
        ]),
      }),
      expect.objectContaining({
        id: "model-factor-analysis-files",
        command: "secapi models factor-analysis --holdings-file holdings.json --model-file model.json --include-optimizer true --response-mode compact",
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "model.json",
            json: {
              id: "growth-core",
              label: "Growth Core",
              source: "model_builder",
            },
          }),
        ]),
      }),
    ]))
    expect(catalog.next.requestMetadata).toContain("--request-summary")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(json.stdout, json.stderr)

    const human = await runCli(["examples", "--json=false"])
    expect(human.status).toBe(0)
    expect(human.stdout).toContain("SEC API CLI starter examples")
    expect(human.stdout).toContain("secapi doctor")
    expect(human.stdout).toContain("secapi search fulltext")
    expect(human.stdout).toContain("Create holdings.json")
    expect(human.stdout).toContain("secapi models factor-analysis --holdings-file holdings.json --model-file model.json")
    expect(human.stderr).toBe("")
    expect(requests).toHaveLength(0)
  })

  test("examples ignores stdin credential flags because it is local-only", async () => {
    const result = await runCli(["examples", "--api-key-stdin"], {
      env: { SECAPI_API_KEY: undefined },
    })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).object).toBe("secapi_cli_examples")
    expect(result.stderr).toBe("")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("completion prints shell scripts locally for both CLI binaries", async () => {
    const zsh = await runCli(["completion", "zsh"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(zsh.status).toBe(0)
    expect(zsh.stdout).toContain("#compdef secapi omni-sec")
    expect(zsh.stdout).toContain("commands=(")
    expect(zsh.stdout).toContain("config")
    expect(zsh.stdout).toContain("filings")
    expect(zsh.stdout).toContain("latest")
    expect(zsh.stdout).toContain("show")
    expect(zsh.stdout).toContain("--base-url")
    expect(zsh.stdout).toContain("--api-key-stdin")
    expect(zsh.stdout).not.toMatch(/(^|\s)--api-key(\s|\))/)
    expect(zsh.stderr).toBe("")
    expect(requests).toHaveLength(0)

    const zshAvailable = spawnSync("zsh", ["--version"], { encoding: "utf8" }).status === 0
    if (zshAvailable) {
      const tempDir = mkdtempSync(path.join(tmpdir(), "secapi-zsh-completion-"))
      try {
        writeFileSync(path.join(tempDir, "_secapi"), zsh.stdout)
        const zshLoad = spawnSync("zsh", [
          "-f",
          "-c",
          `fpath=(${tempDir} $fpath); autoload -Uz compinit; compinit -D -i; print -- $_comps[secapi] $_comps[omni-sec]`,
        ], { encoding: "utf8" })
        expect(zshLoad.status).toBe(0)
        expect(zshLoad.stdout.trim()).toBe("_secapi _secapi")
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }

    const bash = await runCli(["completion", "bash"])
    expect(bash.status).toBe(0)
    expect(bash.stdout).toContain("complete -F _secapi_completion secapi")
    expect(bash.stdout).toContain("complete -F _secapi_completion omni-sec")

    const fish = await runCli(["completion", "fish"])
    expect(fish.status).toBe(0)
    expect(fish.stdout).toContain("complete -c secapi -f")
    expect(fish.stdout).toContain("complete -c omni-sec -f")
  })

  test("completion rejects unsupported shells with usage before credentials or requests", async () => {
    const result = await runCli(["completion", "powershell"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unsupported completion shell: powershell")
    expect(result.stderr).toContain("Usage: secapi completion <bash|zsh|fish>")
    expect(requests).toHaveLength(0)
  })

  test("--output writes JSON and raw command output to files", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "secapi-output-"))
    try {
      const healthPath = path.join(tmp, "nested", "health.json")
      const health = await runCli(["health", "--output", healthPath], {
        env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
      })

      expect(health.status).toBe(0)
      expect(health.stdout).toBe("")
      expect(health.stderr).toBe("")
      expect(JSON.parse(readFileSync(healthPath, "utf8"))).toEqual({ ok: true })
      expect((statSync(healthPath).mode & 0o777)).toBe(0o600)
      expect(requests[0]?.path).toBe("/healthz")

      writeFileSync(healthPath, "loose\n", { mode: 0o644 })
      chmodSync(healthPath, 0o644)
      const overwrite = await runCli(["health", "--output", healthPath], {
        env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
      })

      expect(overwrite.status).toBe(0)
      expect((statSync(healthPath).mode & 0o777)).toBe(0o600)

      requests = []
      const completionPath = path.join(tmp, "completion.zsh")
      const completion = await runCli(["completion", "zsh", `--output=${completionPath}`], {
        env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
      })

      expect(completion.status).toBe(0)
      expect(completion.stdout).toBe("")
      expect(completion.stderr).toBe("")
      expect(readFileSync(completionPath, "utf8")).toContain("#compdef secapi omni-sec")
      expect(requests).toHaveLength(0)

      const promptPath = path.join(tmp, "prompt.txt")
      const prompt = getPrompt("investment-manager-factor-decomposition")
      expect(prompt).toBeDefined()
      const copiedPrompt = await runCli(["agents", "prompts", "copy", "investment-manager-factor-decomposition", "--output", promptPath])

      expect(copiedPrompt.status).toBe(0)
      expect(copiedPrompt.stdout).toBe("")
      expect(copiedPrompt.stderr).toBe("")
      expect(readFileSync(promptPath, "utf8")).toBe(prompt?.prompt)
      expect(requests).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("--output requires a path before credentials or API requests", async () => {
    const result = await runCli(["health", "--output"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("--output requires a value")
    expect(requests).toHaveLength(0)
  })

  test("--base-url overrides the environment origin for one invocation", async () => {
    const overrideRequests: CapturedRequest[] = []
    const overrideServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        overrideRequests.push({
          method: request.method,
          path: url.pathname,
          searchParams: Object.fromEntries(url.searchParams.entries()),
          headers: Object.fromEntries(request.headers.entries()),
          body: "",
        })
        return Response.json({ ok: true, origin: "override" })
      },
    })

    try {
      const result = await runCli(["--base-url", `http://127.0.0.1:${overrideServer.port}`, "health"], {
        env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
      })

      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, origin: "override" })
      expect(result.stderr).toBe("")
      expect(overrideRequests[0]?.path).toBe("/healthz")
      expect(overrideRequests[0]?.headers["x-api-key"]).toBe("secapi_live_ENV_BACKED_AUTH")
      expect(requests).toHaveLength(0)
      assertNoSecretLeak(result.stdout, result.stderr)
    } finally {
      overrideServer.stop(true)
    }
  })

  test("--base-url validation fails locally before auth or requests", async () => {
    const missing = await runCli(["health", "--base-url"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })
    expect(missing.status).not.toBe(0)
    expect(missing.stdout).toBe("")
    expect(missing.stderr).toContain("--base-url requires a value")

    const unsupported = await runCli(["health", "--base-url", "ftp://example.com"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })
    expect(unsupported.status).not.toBe(0)
    expect(unsupported.stdout).toBe("")
    expect(unsupported.stderr).toContain("--base-url must be an http(s) origin/path without embedded credentials, query, or fragment")

    const duplicate = await runCli(["health", "--base-url", "http://127.0.0.1:1", "--base-url", "http://127.0.0.1:2"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })
    expect(duplicate.status).not.toBe(0)
    expect(duplicate.stdout).toBe("")
    expect(duplicate.stderr).toContain("--base-url may only be provided once")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(`${missing.stdout}${unsupported.stdout}${duplicate.stdout}`, `${missing.stderr}${unsupported.stderr}${duplicate.stderr}`)
  })

  test("--base-url rejects echoed URL secrets before doctor or agent-context output", async () => {
    const doctor = await runCli(["doctor", "--base-url", "http://127.0.0.1:1/?token=secapi_live_ARGV_SHOULD_NOT_LEAK"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(doctor.status).not.toBe(0)
    expect(doctor.stdout).toBe("")
    expect(doctor.stderr).toContain("--base-url must be an http(s) origin/path without embedded credentials, query, or fragment")
    expect(doctor.stderr).not.toContain("secapi_live_ARGV_SHOULD_NOT_LEAK")

    const agentContext = await runCli(["agent-context", "--base-url", "http://127.0.0.1:1/#secapi_live_ARGV_SHOULD_NOT_LEAK"])
    expect(agentContext.status).not.toBe(0)
    expect(agentContext.stdout).toBe("")
    expect(agentContext.stderr).toContain("--base-url must be an http(s) origin/path without embedded credentials, query, or fragment")
    expect(agentContext.stderr).not.toContain("secapi_live_ARGV_SHOULD_NOT_LEAK")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(`${doctor.stdout}${agentContext.stdout}`, `${doctor.stderr}${agentContext.stderr}`)
  })

  test("config show reports local settings without reading stdin or calling the API", async () => {
    const result = await runCli(["--base-url", `http://127.0.0.1:${server.port}/proxy`, "config", "show", "--api-key-stdin"], {
      env: {
        SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH",
        SECAPI_BEARER_TOKEN: "bearer_ENV_BACKED_AUTH",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(requests).toHaveLength(0)
    const config = JSON.parse(result.stdout)
    expect(config.object).toBe("secapi_cli_config")
    expect(config.baseUrl).toBe(`http://127.0.0.1:${server.port}/proxy`)
    expect(config.baseUrlSource).toEqual({ type: "flag", source: "--base-url" })
    expect(config.auth.apiKey).toEqual({
      configured: true,
      source: "SECAPI_API_KEY",
      stdinFlagPresent: true,
    })
    expect(config.auth.bearerToken).toEqual({
      configured: true,
      source: "SECAPI_BEARER_TOKEN",
      stdinFlagPresent: false,
    })
    expect(config.mcp.url).toBe(`http://127.0.0.1:${server.port}/proxy/mcp`)
    expect(config.localOnly).toBe(true)
    expect(config.note).toContain("does not read stdin or call the API")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("config show reports env base URL source and writes through --output", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "secapi-config-show-"))
    try {
      const outputPath = path.join(tmp, "config.json")
      const result = await runCli(["config", "show", "--output", outputPath], {
        env: {
          SECAPI_API_KEY: undefined,
          SECAPI_BASE_URL: undefined,
          SECAPI_API_BASE_URL: "http://127.0.0.1:8788",
        },
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("")
      expect(requests).toHaveLength(0)
      const config = JSON.parse(readFileSync(outputPath, "utf8"))
      expect(config.baseUrl).toBe("http://127.0.0.1:8788")
      expect(config.baseUrlSource).toEqual({ type: "env", source: "SECAPI_API_BASE_URL" })
      expect(config.auth.apiKey).toEqual({
        configured: false,
        source: null,
        stdinFlagPresent: false,
      })
      expect((statSync(outputPath).mode & 0o777)).toBe(0o600)
      assertNoSecretLeak(JSON.stringify(config), result.stderr)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("config profiles lists local profiles without reading stdin or calling the API", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "secapi-config-profiles-"))
    try {
      const configPath = path.join(tmp, "profiles.json")
      writeFileSync(configPath, JSON.stringify({
        profiles: {
          staging: {
            baseUrl: "https://staging.secapi.ai",
            apiKeyEnv: "SECAPI_STAGING_API_KEY",
          },
          local: {
            baseUrl: `http://127.0.0.1:${server.port}/profile`,
            apiKeyEnv: "SECAPI_LOCAL_API_KEY",
            bearerTokenEnv: "SECAPI_LOCAL_BEARER_TOKEN",
          },
        },
      }))

      const result = await runCli(["--profile", "local", "config", "profiles", "--api-key-stdin"], {
        env: {
          SECAPI_CONFIG_FILE: configPath,
          SECAPI_BASE_URL: "http://127.0.0.1:8787/?token=secapi_live_ARGV_SHOULD_NOT_LEAK",
          SECAPI_LOCAL_API_KEY: "secapi_live_PROFILE_AUTH",
          SECAPI_STAGING_API_KEY: undefined,
        },
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      expect(requests).toHaveLength(0)
      const report = JSON.parse(result.stdout)
      expect(report).toMatchObject({
        object: "secapi_cli_profiles",
        configPath,
        exists: true,
        active: "local",
        localOnly: true,
      })
      expect(report.note).toContain("does not read stdin or call the API")
      expect(report.profiles).toEqual([
        {
          name: "local",
          selected: true,
          baseUrl: `http://127.0.0.1:${server.port}/profile`,
          apiKeyEnv: "SECAPI_LOCAL_API_KEY",
          apiKeyConfigured: true,
          bearerTokenEnv: "SECAPI_LOCAL_BEARER_TOKEN",
          bearerTokenConfigured: false,
        },
        {
          name: "staging",
          selected: false,
          baseUrl: "https://staging.secapi.ai",
          apiKeyEnv: "SECAPI_STAGING_API_KEY",
          apiKeyConfigured: false,
          bearerTokenEnv: null,
          bearerTokenConfigured: false,
        },
      ])
      assertNoSecretLeak(result.stdout, result.stderr)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("config profiles reports a missing profiles file locally", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "secapi-config-profiles-missing-"))
    try {
      const missingPath = path.join(tmp, "missing.json")
      const result = await runCli(["config", "profiles"], {
        env: {
          SECAPI_CONFIG_FILE: missingPath,
          SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH",
        },
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      expect(requests).toHaveLength(0)
      const report = JSON.parse(result.stdout)
      expect(report).toMatchObject({
        object: "secapi_cli_profiles",
        configPath: missingPath,
        exists: false,
        active: null,
        profiles: [],
        localOnly: true,
      })
      assertNoSecretLeak(result.stdout, result.stderr)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("config profiles rejects credential-shaped profile names and env fields before printing them", async () => {
    const unsafeName = "secapi_live_PROFILE_LITERAL"
    const unsafeField = "bearer_PROFILE_LITERAL"

    const unsafeNameTmp = mkdtempSync(path.join(tmpdir(), "secapi-config-profiles-unsafe-name-"))
    try {
      const configPath = path.join(unsafeNameTmp, "profiles.json")
      writeFileSync(configPath, JSON.stringify({
        profiles: {
          [unsafeName]: {
            baseUrl: "http://127.0.0.1:8787",
            apiKeyEnv: "SECAPI_LOCAL_API_KEY",
          },
        },
      }))

      const result = await runCli(["config", "profiles"], {
        env: { SECAPI_CONFIG_FILE: configPath },
      })

      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("must name a profile")
      expect(result.stderr).not.toContain(unsafeName)
      expect(requests).toHaveLength(0)
      assertNoSecretLeak(result.stdout, result.stderr)
    } finally {
      rmSync(unsafeNameTmp, { recursive: true, force: true })
    }

    requests = []
    const unsafeFieldTmp = mkdtempSync(path.join(tmpdir(), "secapi-config-profiles-unsafe-field-"))
    try {
      const configPath = path.join(unsafeFieldTmp, "profiles.json")
      writeFileSync(configPath, JSON.stringify({
        profiles: {
          unsafe: {
            baseUrl: "http://127.0.0.1:8787",
            apiKeyEnv: unsafeField,
          },
        },
      }))

      const result = await runCli(["config", "profiles"], {
        env: { SECAPI_CONFIG_FILE: configPath },
      })

      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("must name an environment variable")
      expect(result.stderr).not.toContain(unsafeField)
      expect(requests).toHaveLength(0)
      assertNoSecretLeak(result.stdout, result.stderr)
    } finally {
      rmSync(unsafeFieldTmp, { recursive: true, force: true })
    }
  })

  test("profiles select base URL and credential env names without leaking values", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "secapi-profile-"))
    try {
      const configPath = path.join(tmp, "profiles.json")
      writeFileSync(configPath, JSON.stringify({
        profiles: {
          local: {
            baseUrl: `http://127.0.0.1:${server.port}/profile`,
            apiKeyEnv: "SECAPI_LOCAL_API_KEY",
            bearerTokenEnv: "SECAPI_LOCAL_BEARER_TOKEN",
          },
        },
      }))

      const config = await runCli(["--profile", "local", "config", "show"], {
        env: {
          SECAPI_CONFIG_FILE: configPath,
          SECAPI_BASE_URL: undefined,
          SECAPI_LOCAL_API_KEY: "secapi_live_PROFILE_AUTH",
        },
      })

      expect(config.status).toBe(0)
      expect(config.stderr).toBe("")
      expect(requests).toHaveLength(0)
      const report = JSON.parse(config.stdout)
      expect(report.profile).toMatchObject({
        name: "local",
        source: "--profile",
        configPath,
        apiKeyEnv: "SECAPI_LOCAL_API_KEY",
        bearerTokenEnv: "SECAPI_LOCAL_BEARER_TOKEN",
      })
      expect(report.baseUrl).toBe(`http://127.0.0.1:${server.port}/profile`)
      expect(report.baseUrlSource).toEqual({ type: "profile", source: "local" })
      expect(report.auth.apiKey).toEqual({
        configured: true,
        source: "SECAPI_LOCAL_API_KEY",
        stdinFlagPresent: false,
      })
      assertNoSecretLeak(config.stdout, config.stderr)

      const health = await runCli(["health"], {
        env: {
          SECAPI_CONFIG_FILE: configPath,
          SECAPI_PROFILE: "local",
          SECAPI_BASE_URL: undefined,
          SECAPI_LOCAL_API_KEY: "secapi_live_PROFILE_AUTH",
        },
      })

      expect(health.status).toBe(0)
      expect(requests[0]?.path).toBe("/profile/healthz")
      expect(requests[0]?.headers["x-api-key"]).toBe("secapi_live_PROFILE_AUTH")
      assertNoSecretLeak(health.stdout, health.stderr)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("selected profile errors stay local before credentials or API requests", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "secapi-profile-missing-"))
    try {
      const configPath = path.join(tmp, "profiles.json")
      writeFileSync(configPath, JSON.stringify({ profiles: { local: { baseUrl: "http://127.0.0.1:8787" } } }))

      const missingProfile = await runCli(["config", "show"], {
        env: {
          SECAPI_CONFIG_FILE: configPath,
          SECAPI_PROFILE: "staging",
          SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH",
        },
      })

      expect(missingProfile.status).not.toBe(0)
      expect(missingProfile.stderr).toContain("Profile 'staging' was not found")
      expect(requests).toHaveLength(0)
      assertNoSecretLeak(missingProfile.stdout, missingProfile.stderr)

      const missingFile = await runCli(["--profile", "local", "health"], {
        env: {
          SECAPI_CONFIG_FILE: path.join(tmp, "missing.json"),
          SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH",
        },
      })

      expect(missingFile.status).not.toBe(0)
      expect(missingFile.stderr).toContain("selected a profile")
      expect(requests).toHaveLength(0)
      assertNoSecretLeak(missingFile.stdout, missingFile.stderr)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("profile credential env fields reject literal credential-shaped values before printing them", async () => {
    const credentialLikeValues = [
      "secapi_live_PROFILE_LITERAL",
      "opr_live_PROFILE_LITERAL",
      "ods_live_PROFILE_LITERAL",
      "bearer_PROFILE_LITERAL",
    ]

    for (const value of credentialLikeValues) {
      requests = []
      const tmp = mkdtempSync(path.join(tmpdir(), "secapi-profile-secret-"))
      try {
        const configPath = path.join(tmp, "profiles.json")
        writeFileSync(configPath, JSON.stringify({
          profiles: {
            unsafe: {
              baseUrl: "http://127.0.0.1:8787",
              apiKeyEnv: value,
              bearerTokenEnv: value,
            },
          },
        }))

        const result = await runCli(["--profile", "unsafe", "config", "show"], {
          env: {
            SECAPI_CONFIG_FILE: configPath,
            SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH",
          },
        })

        expect(result.status).not.toBe(0)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("must name an environment variable")
        expect(result.stderr).not.toContain(value)
        expect(requests).toHaveLength(0)
        assertNoSecretLeak(result.stdout, result.stderr)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
  })

  test("profile names reject literal credential-shaped values before printing them", async () => {
    const credentialLikeNames = [
      "secapi_live_PROFILE_LITERAL",
      "opr_live_PROFILE_LITERAL",
      "ods_live_PROFILE_LITERAL",
      "bearer_PROFILE_LITERAL",
    ]

    for (const name of credentialLikeNames) {
      requests = []
      const tmp = mkdtempSync(path.join(tmpdir(), "secapi-profile-name-secret-"))
      try {
        const configPath = path.join(tmp, "profiles.json")
        writeFileSync(configPath, JSON.stringify({
          profiles: {
            [name]: {
              baseUrl: "http://127.0.0.1:8787",
              apiKeyEnv: "SECAPI_LOCAL_API_KEY",
            },
          },
        }))

        const byFlag = await runCli(["--profile", name, "config", "show"], {
          env: { SECAPI_CONFIG_FILE: configPath },
        })

        expect(byFlag.status).not.toBe(0)
        expect(byFlag.stdout).toBe("")
        expect(byFlag.stderr).toContain("must name a profile")
        expect(byFlag.stderr).not.toContain(name)
        expect(requests).toHaveLength(0)
        assertNoSecretLeak(byFlag.stdout, byFlag.stderr)

        requests = []
        const byEnv = await runCli(["config", "show"], {
          env: {
            SECAPI_CONFIG_FILE: configPath,
            SECAPI_PROFILE: name,
          },
        })

        expect(byEnv.status).not.toBe(0)
        expect(byEnv.stdout).toBe("")
        expect(byEnv.stderr).toContain("must name a profile")
        expect(byEnv.stderr).not.toContain(name)
        expect(requests).toHaveLength(0)
        assertNoSecretLeak(byEnv.stdout, byEnv.stderr)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    }
  })

  test("account commands keep JSON as the pipe default", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }

    const me = await runCli(["me"], { env: auth })
    expect(me.status).toBe(0)
    expect(JSON.parse(me.stdout)).toMatchObject({
      object: "principal",
      principal: {
        orgId: "org_test",
        publicPlanKey: "personal",
      },
    })

    const billing = await runCli(["billing", "show"], { env: auth })
    expect(billing.status).toBe(0)
    expect(JSON.parse(billing.stdout)).toMatchObject({
      object: "billing_snapshot",
      publicPlanKey: "personal",
      billingState: "payg_active",
    })

    const usage = await runCli(["usage", "show"], { env: auth })
    expect(usage.status).toBe(0)
    expect(JSON.parse(usage.stdout)).toMatchObject({
      object: "usage_summary",
      totalRequests: 42,
    })

    const limits = await runCli(["limits", "show"], { env: auth })
    expect(limits.status).toBe(0)
    expect(JSON.parse(limits.stdout)).toMatchObject({
      object: "limits",
      effectivePlanKey: "personal",
    })

    expect(requests.map((request) => request.path)).toEqual(["/v1/me", "/v1/billing", "/v1/usage", "/v1/limits"])
    assertNoSecretLeak(me.stdout + billing.stdout + usage.stdout + limits.stdout, me.stderr + billing.stderr + usage.stderr + limits.stderr)
  })

  test("account commands print compact human summaries with --json=false", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }
    const cases = [
      {
        args: ["me", "--json=false"],
        title: "SEC API account",
        snippets: ["Auth: api_key", "Organization: org_test", "Scopes: read:sec, billing:read"],
      },
      {
        args: ["billing", "show", "--json=false"],
        title: "SEC API billing",
        snippets: ["Plan: personal", "Free grant: 60 / 100 remaining", "Budget: $25.00 / $100.00 accrued"],
      },
      {
        args: ["usage", "show", "--json=false"],
        title: "SEC API usage",
        snippets: ["Total requests: 42", "Top meters: ai_queries 30 requests, 1 errors, 120.5ms avg"],
      },
      {
        args: ["limits", "show", "--json=false"],
        title: "SEC API limits",
        snippets: ["Plan: personal", "Quotas: section_extract 1,000 per month (yes)"],
      },
    ]

    for (const entry of cases) {
      const result = await runCli(entry.args, { env: auth })
      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain(entry.title)
      for (const snippet of entry.snippets) expect(result.stdout).toContain(snippet)
      expect(() => JSON.parse(result.stdout)).toThrow()
      assertNoSecretLeak(result.stdout, result.stderr)
    }
  })

  test("account command discovery documents human summaries", async () => {
    const billingHelp = await runCli(["billing", "show", "--help"])
    expect(billingHelp.status).toBe(0)
    expect(billingHelp.stdout).toContain("Usage: secapi billing show [--json=false]")
    expect(billingHelp.stdout).toContain("--json=false")

    const usageGroupHelp = await runCli(["usage", "--help", "--api-key-stdin"])
    expect(usageGroupHelp.status).toBe(0)
    expect(usageGroupHelp.stdout).toContain("secapi usage show [--json=false]")
    expect(requests).toHaveLength(0)

    const agentContext = await runCli(["agent-context"])
    expect(agentContext.status).toBe(0)
    const ctx = JSON.parse(agentContext.stdout)
    const details = ctx.commandGroups
      .flatMap((entry: { details: Array<{ command: string }> }) => entry.details)
    const detailByCommand = new Map(details.map((detail: { command: string }) => [detail.command, detail]))
    expect(detailByCommand.get("secapi me")).toMatchObject({
      output: "human_or_json",
      examples: ["secapi me", "secapi me --json=false"],
    })
    expect(detailByCommand.get("secapi billing show")).toMatchObject({
      output: "human_or_json",
      examples: ["secapi billing show", "secapi billing show --json=false"],
    })
    expect(detailByCommand.get("secapi usage show")).toMatchObject({
      output: "human_or_json",
    })
    expect(detailByCommand.get("secapi limits show")).toMatchObject({
      output: "human_or_json",
    })
  })

  test("boolean flags honor explicit false values and reject invalid values locally", async () => {
    const humanPersonas = await runCli(["agents", "personas", "--json=false"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(humanPersonas.status).toBe(0)
    expect(humanPersonas.stdout).toContain("Available personas:")
    expect(humanPersonas.stdout).not.toContain('"object"')
    expect(humanPersonas.stderr).toBe("")
    expect(requests).toHaveLength(0)

    const invalidBoolean = await runCli(["agents", "personas", "--json=maybe"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(invalidBoolean.status).not.toBe(0)
    expect(invalidBoolean.stdout).toBe("")
    expect(invalidBoolean.stderr).toContain("--json must be true or false")
    expect(requests).toHaveLength(0)

    const liveFalse = await runCli(["api-keys", "create", "--label", "ci", "--live=false"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(liveFalse.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/api_keys")
    expect(JSON.parse(requests[0]?.body ?? "{}").livemode).toBe(false)
  })

  test("unknown command help fails locally without a request", async () => {
    const result = await runCli(["filings", "latset", "--help"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Unknown command: secapi filings latset")
    expect(result.stderr).toContain("Did you mean 'secapi filings latest'?")
    expect(result.stderr).toContain("secapi --help")
    expect(requests).toHaveLength(0)
  })

  test("unknown commands suggest nearest command without echoing flag values", async () => {
    const result = await runCli(["filings", "latset", "--ticker", "AAPL", "--made-up-secret", "secapi_live_ARGV_SHOULD_NOT_LEAK"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unknown command: secapi filings latset")
    expect(result.stderr).toContain("Did you mean 'secapi filings latest'?")
    expect(result.stderr).not.toContain("--made-up-secret")
    expect(result.stderr).not.toContain("AAPL")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("unknown single-token commands suggest nearest command", async () => {
    const result = await runCli(["helth"])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Unknown command: secapi helth")
    expect(result.stderr).toContain("Did you mean 'secapi health'?")
    expect(requests).toHaveLength(0)
  })

  test("unknown option typos fail locally before auth or API requests", async () => {
    const result = await runCli(["filings", "search", "--ticker", "AAPL", "--limt", "5"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unknown option for secapi filings search: --limt")
    expect(result.stderr).toContain("Did you mean '--limit'?")
    expect(result.stderr).toContain("secapi filings search --help")
    expect(result.stderr).not.toContain("AAPL")
    expect(result.stderr).not.toContain("5")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("unknown inline option typos fail locally without echoing values", async () => {
    const result = await runCli(["search", "semantic", "--q", "revenue", "--limt=secapi_live_ARGV_SHOULD_NOT_LEAK"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unknown option for secapi search semantic: --limt")
    expect(result.stderr).toContain("Did you mean '--limit'?")
    expect(result.stderr).not.toContain("revenue")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("unknown option validation covers implemented commands missing help metadata", async () => {
    const result = await runCli(["sections", "search", "--ticker", "AAPL", "--limt", "5"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unknown option for secapi sections search: --limt")
    expect(result.stderr).toContain("Did you mean '--limit'?")
    expect(result.stderr).toContain("secapi sections search --help")
    expect(result.stderr).not.toContain("AAPL")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("known flags from other commands fail locally before requests", async () => {
    const result = await runCli(["health", "--ticker", "AAPL", "--base-url", "http://127.0.0.1:1"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unsupported option for secapi health: --ticker")
    expect(result.stderr).toContain("secapi health --help")
    expect(result.stderr).not.toContain("AAPL")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("command-specific option validation rejects known flags on the wrong command", async () => {
    const result = await runCli(["traces", "get", "--trace-id", "trc_test", "--ticker", "AAPL"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unsupported option for secapi traces get: --ticker")
    expect(result.stderr).toContain("secapi traces get --help")
    expect(result.stderr).not.toContain("AAPL")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("setup aliases reject known flags from unrelated commands before writing config", async () => {
    const result = await runCli(["agents", "setup", "--client", "cursor", "--ticker", "AAPL", "--print"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unsupported option for secapi agents setup: --ticker")
    expect(result.stderr).toContain("secapi agents setup --help")
    expect(result.stderr).not.toContain("AAPL")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("agent-context aliases reject known flags from unrelated commands", async () => {
    const result = await runCli(["agents", "context", "--ticker", "AAPL"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unsupported option for secapi agents context: --ticker")
    expect(result.stderr).toContain("secapi agents context --help")
    expect(result.stderr).not.toContain("AAPL")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("documented command aliases remain valid under option validation", async () => {
    const result = await runCli(["search", "fulltext", "--query", "risk", "--limit", "2"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/search/fulltext")
    expect(requests[0]?.searchParams.q).toBe("risk")
    expect(requests[0]?.searchParams.limit).toBe("2")
  })

  test("documented entity and section aliases are forwarded", async () => {
    const entity = await runCli(["entities", "resolve", "--query", "Apple"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })
    expect(entity.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/entities/resolve")
    expect(requests[0]?.searchParams.name).toBe("Apple")

    requests = []
    const section = await runCli(["sections", "get", "--ticker", "AAPL", "--section", "item_1a", "--view", "agent"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })
    expect(section.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/filings/latest/sections/item_1a")
    expect(requests[0]?.searchParams.ticker).toBe("AAPL")
    expect(requests[0]?.searchParams.mode).toBe("compact")
  })

  test("unknown commands fail without echoing arbitrary flag values", async () => {
    const result = await runCli(["intelligence", "query", "--ticker", "AAPL", "--made-up-secret", "secapi_live_ARGV_SHOULD_NOT_LEAK"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unknown command: secapi intelligence query")
    expect(result.stderr).not.toContain("--made-up-secret")
    expect(result.stderr).not.toContain("AAPL")
    expect(result.stderr).toContain("secapi --help")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("unknown single-token commands do not mistake flag values for subcommands", async () => {
    const result = await runCli(["intelligence", "--made-up-secret", "secapi_live_ARGV_SHOULD_NOT_LEAK"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unknown command: secapi intelligence")
    expect(result.stderr).not.toContain("--made-up-secret")
    assertNoSecretLeak(result.stdout, result.stderr)
    expect(requests).toHaveLength(0)
  })

  test("unknown flag-first invocations do not echo flag values", async () => {
    const result = await runCli(["--made-up-secret", "secapi_live_ARGV_SHOULD_NOT_LEAK"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unknown command: secapi unknown")
    expect(result.stderr).not.toContain("--made-up-secret")
    assertNoSecretLeak(result.stdout, result.stderr)
    expect(requests).toHaveLength(0)
  })

  test("search fulltext forwards query and filters", async () => {
    const result = await runCli([
      "search",
      "fulltext",
      "--q",
      "supply chain",
      "--form",
      "10-K",
      "--limit",
      "5",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/search/fulltext")
    expect(requests[0]?.searchParams.q).toBe("supply chain")
    expect(requests[0]?.searchParams.form).toBe("10-K")
    expect(requests[0]?.searchParams.limit).toBe("5")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("search semantic forwards mode, filing_year, and agent view", async () => {
    const result = await runCli([
      "search",
      "semantic",
      "--q",
      "revenue concentration",
      "--ticker",
      "AAPL",
      "--mode",
      "hybrid",
      "--filing-year",
      "2025",
      "--view",
      "agent",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/search/semantic")
    expect(requests[0]?.searchParams.q).toBe("revenue concentration")
    expect(requests[0]?.searchParams.ticker).toBe("AAPL")
    expect(requests[0]?.searchParams.mode).toBe("hybrid")
    expect(requests[0]?.searchParams.filing_year).toBe("2025")
    expect(requests[0]?.searchParams.view).toBe("agent")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("search semantic rejects unsupported response views locally", async () => {
    const result = await runCli([
      "search",
      "semantic",
      "--q",
      "revenue concentration",
      "--view",
      "full",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--view must be one of: default, compact, agent")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("search semantic rejects unsupported search modes locally", async () => {
    const result = await runCli([
      "search",
      "semantic",
      "--q",
      "revenue concentration",
      "--mode",
      "vector",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--mode must be one of: keyword, semantic, hybrid")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("search fulltext requires a query", async () => {
    const result = await runCli(["search", "fulltext"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--q or --query is required")
    expect(result.stderr).toContain("Usage: secapi search fulltext --q <query>")
    expect(result.stderr).toContain("Example: secapi search fulltext --q \"supply chain\" --form 10-K --limit 10")
    expect(result.stderr).toContain("secapi search fulltext --help")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("server errors containing required are not decorated as missing CLI flags", async () => {
    const result = await runCli(["companies", "search", "--q", "server-required-error"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("A downstream field is required")
    expect(result.stderr).not.toContain("Usage: secapi companies search")
    expect(result.stderr).not.toContain("Example:")
    expect(result.stderr).not.toContain("secapi companies search --help")
    expect(requests).toHaveLength(1)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("mutating commands can preview request payloads with --dry-run without auth or API calls", async () => {
    const cases = [
      {
        args: ["api-keys", "create", "--label", "local-dev", "--scopes", "read:sec", "--dry-run"],
        command: "secapi api-keys create",
        method: "POST",
        path: "/v1/api_keys",
        body: { label: "local-dev", scopes: ["read:sec"], livemode: false },
      },
      {
        args: ["billing", "budget", "--spend-cap-cents", "900", "--soft-cap-cents", "500", "--dry-run"],
        command: "secapi billing budget",
        method: "PUT",
        path: "/v1/billing/budget",
        body: { spendCapCents: 900, softCapCents: 500 },
      },
      {
        args: ["billing", "checkout", "--plan", "personal", "--dry-run"],
        command: "secapi billing checkout",
        method: "POST",
        path: "/v1/billing/checkout",
        body: { planKey: "personal" },
      },
      {
        args: ["webhooks", "create", "--destination-url", "https://example.com/hooks/sec", "--event-types", "artifact.created", "--dry-run"],
        command: "secapi webhooks create",
        method: "POST",
        path: "/v1/webhook_endpoints",
        body: {
          destinationUrl: "https://example.com/hooks/sec",
          subscribedEventTypes: ["artifact.created"],
          livemode: false,
        },
      },
      {
        args: ["webhooks", "rotate-secret", "--webhook-id", "wh/with spaces", "--dry-run"],
        command: "secapi webhooks rotate-secret",
        method: "POST",
        path: "/v1/webhook_endpoints/wh%2Fwith%20spaces/rotate_secret",
        body: null,
      },
      {
        args: ["webhooks", "replay-delivery", "--webhook-id", "wh_123", "--delivery-id", "wdel/with spaces", "--dry-run"],
        command: "secapi webhooks replay-delivery",
        method: "POST",
        path: "/v1/webhook_endpoints/wh_123/deliveries/wdel%2Fwith%20spaces/replay",
        body: null,
      },
      {
        args: ["streams", "create", "--event-types", "artifact.created", "--transport", "websocket", "--dry-run"],
        command: "secapi streams create",
        method: "POST",
        path: "/v1/stream_subscriptions",
        body: { eventTypes: ["artifact.created"], transport: "websocket", livemode: false },
      },
    ]

    for (const entry of cases) {
      requests = []
      const result = await runCli(entry.args)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      expect(requests).toHaveLength(0)

      const preview = JSON.parse(result.stdout)
      expect(preview.object).toBe("secapi_cli_dry_run")
      expect(preview.command).toBe(entry.command)
      expect(preview.mutates).toBe(true)
      expect(preview.callsApi).toBe(false)
      expect(preview.request).toMatchObject({
        method: entry.method,
        baseUrl: `http://127.0.0.1:${server.port}`,
        path: entry.path,
        url: `http://127.0.0.1:${server.port}${entry.path}`,
      })
      expect(preview.request.body).toEqual(entry.body)
      assertNoSecretLeak(result.stdout, result.stderr)
    }
  })

  test("unsupported dry-run flags fail locally before the API is called", async () => {
    const result = await runCli(["health", "--dry-run"])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--dry-run is not supported for secapi health")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("streams create validates transport locally and forwards websocket subscriptions", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }
    const created = await runCli(["streams", "create", "--event-types", "artifact.created", "--transport", "websocket"], { env: auth })

    expect(created.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/stream_subscriptions")
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      eventTypes: ["artifact.created"],
      transport: "websocket",
      livemode: false,
    })

    requests = []
    const invalid = await runCli(["streams", "create", "--transport", "udp"], { env: auth })
    expect(invalid.status).not.toBe(0)
    expect(invalid.stderr).toContain("--transport must be one of: poll, webhook_mirror, websocket")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(created.stdout + invalid.stdout, created.stderr + invalid.stderr)
  })
})

describe("CLI doctor", () => {
  test("doctor reports base URL, health, and skipped account context without auth", async () => {
    const result = await runCli(["doctor"])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.path).toBe("/healthz")
    expect(requests[0]?.headers["x-api-key"]).toBeUndefined()
    expect(requests[0]?.headers.authorization).toBeUndefined()

    const report = JSON.parse(result.stdout)
    expect(report.object).toBe("secapi_cli_doctor")
    expect(report.ok).toBe(true)
    expect(report.baseUrl).toBe(`http://127.0.0.1:${server.port}`)
    expect(report.auth.apiKey.configured).toBe(false)
    expect(report.auth.bearerToken.configured).toBe(false)
    expect(report.checks.health.ok).toBe(true)
    expect(report.checks.me.skipped).toBe(true)
    expect(report.mcp.url).toBe(`http://127.0.0.1:${server.port}/mcp`)
    expect(report.mcp.authConfigured).toBe(false)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("doctor verifies account context with env-backed auth without leaking the key", async () => {
    const result = await runCli(["doctor"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(requests.map((request) => request.path)).toEqual(["/healthz", "/v1/me"])
    expect(requests[0]?.headers["x-api-key"]).toBe("secapi_live_ENV_BACKED_AUTH")
    expect(requests[1]?.headers["x-api-key"]).toBe("secapi_live_ENV_BACKED_AUTH")

    const report = JSON.parse(result.stdout)
    expect(report.ok).toBe(true)
    expect(report.auth.apiKey.configured).toBe(true)
    expect(report.auth.apiKey.source).toBe("SECAPI_API_KEY")
    expect(report.auth.bearerToken.configured).toBe(false)
    expect(report.checks.health.ok).toBe(true)
    expect(report.checks.me.ok).toBe(true)
    expect(report.mcp.authConfigured).toBe(true)
    expect(report.mcp.authHeader).toBe("x-api-key")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("doctor redacts credentials from failed diagnostic messages", async () => {
    const result = await runCli(["doctor"], {
      env: { SECAPI_API_KEY: "secapi_live_DOCTOR_ECHO_SECRET" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toBe("")
    expect(requests.map((request) => request.path)).toEqual(["/healthz", "/v1/me"])

    const report = JSON.parse(result.stdout)
    expect(report.ok).toBe(false)
    expect(report.checks.health.ok).toBe(true)
    expect(report.checks.me.ok).toBe(false)
    expect(report.checks.me.status).toBe(401)
    expect(report.checks.me.code).toBe("doctor_secret_echo")
    expect(report.checks.me.message).toContain("[redacted]")
    expect(report.checks.me.message).not.toContain("secapi_live_DOCTOR_ECHO_SECRET")
    assertNoSecretLeak(result.stdout, result.stderr)
  })
})

describe("CLI trace commands", () => {
  test("traces get resolves a single trace by flag or positional id", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }

    const byFlag = await runCli(["traces", "get", "--trace-id", "trc_single"], { env: auth })
    expect(byFlag.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/traces/trc_single")

    requests = []
    const byPosition = await runCli(["traces", "get", "trc_positional"], { env: auth })
    expect(byPosition.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/traces/trc_positional")

    requests = []
    const withBaseUrl = await runCli(["traces", "get", "--base-url", `http://127.0.0.1:${server.port}`, "trc_global_flag"], { env: auth })
    expect(withBaseUrl.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/traces/trc_global_flag")
    assertNoSecretLeak(byFlag.stdout + byPosition.stdout + withBaseUrl.stdout, byFlag.stderr + byPosition.stderr + withBaseUrl.stderr)
  })

  test("traces list forwards comma-separated trace ids", async () => {
    const result = await runCli(["traces", "list", "--ids", "trc_one,trc_two"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/traces")
    expect(requests[0]?.searchParams.ids).toBe("trc_one,trc_two")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("traces list requires ids before making a request", async () => {
    const result = await runCli(["traces", "list"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--ids is required")
    expect(result.stderr).toContain("Usage: secapi traces list --ids <trace_id_1,trace_id_2>")
    expect(result.stderr).toContain("Example: secapi traces list --ids trc_1,trc_2")
    expect(result.stderr).toContain("secapi traces list --help")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("traces get requires a trace id before making a request", async () => {
    const result = await runCli(["traces", "get"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--trace-id is required")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })
})

describe("CLI factor valuation commands", () => {
  test("valuations forwards AI/DX aliases", async () => {
    const result = await runCli([
      "factors",
      "valuations",
      "--factors",
      "VALUE,DIVIDEND_YIELD",
      "--signal",
      "TAILWIND",
      "--weighting-mode",
      "short-leg",
      "--sort",
      "ABS-Z-SCORE",
      "--view",
      "compact",
      "--expand",
      "trust",
      "--limit",
      "5",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/valuations")
    expect(requests[0]?.searchParams.keys).toBe("VALUE,DIVIDEND_YIELD")
    expect(requests[0]?.searchParams.signal).toBe("tailwind")
    expect(requests[0]?.searchParams.weighting_mode).toBe("short_leg_focus")
    expect(requests[0]?.searchParams.sort).toBe("abs_z_score")
    expect(requests[0]?.searchParams.response_mode).toBe("compact")
    expect(requests[0]?.searchParams.include).toBe("trust")
    expect(requests[0]?.searchParams.limit).toBe("5")
    expect(result.stdout).toContain("\"ok\": true")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("valuations supports raw CSV export", async () => {
    const result = await runCli([
      "factors",
      "valuations",
      "--category",
      "style",
      "--format",
      "csv",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/valuations")
    expect(requests[0]?.searchParams.category).toBe("style")
    expect(requests[0]?.searchParams.format).toBe("csv")
    expect(result.stdout.startsWith("rank,factor_key\n")).toBe(true)
    expect(result.stdout.startsWith("\"")).toBe(false)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("valuation-stocks supports canonical stance and CSV export", async () => {
    const result = await runCli([
      "factors",
      "valuation-stocks",
      "--factor",
      "VALUE",
      "--stance",
      "opportunity",
      "--weighting-mode",
      "equal-weighted",
      "--sort",
      "ABS-BETA",
      "--format",
      "csv",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/valuations/stocks")
    expect(requests[0]?.searchParams.factor).toBe("VALUE")
    expect(requests[0]?.searchParams.stance).toBe("beneficiaries")
    expect(requests[0]?.searchParams.weighting_mode).toBe("long_short_equal")
    expect(requests[0]?.searchParams.sort).toBe("abs_beta")
    expect(requests[0]?.searchParams.format).toBe("csv")
    expect(result.stdout.startsWith("rank,symbol,factor_key\n")).toBe(true)
    expect(result.stdout.startsWith("\"")).toBe(false)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("valuation commands reject unsupported enum flags locally", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }
    const invalidSide = await runCli([
      "factors",
      "valuations",
      "--side",
      "sideways",
    ], { env: auth })

    expect(invalidSide.status).not.toBe(0)
    expect(invalidSide.stderr).toContain("--side must be one of: tailwind, headwind, neutral, all")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidSide.stdout, invalidSide.stderr)

    requests = []
    const invalidWeighting = await runCli([
      "factors",
      "valuations",
      "--weighting-mode",
      "balanced",
    ], { env: auth })

    expect(invalidWeighting.status).not.toBe(0)
    expect(invalidWeighting.stderr).toContain("--weighting-mode must be one of: long_short_equal, long_leg_focus, short_leg_focus")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidWeighting.stdout, invalidWeighting.stderr)

    requests = []
    const invalidStance = await runCli([
      "factors",
      "valuation-stocks",
      "--stance",
      "watchlist",
    ], { env: auth })

    expect(invalidStance.status).not.toBe(0)
    expect(invalidStance.stderr).toContain("--stance must be one of: beneficiaries, at_risk, both")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidStance.stdout, invalidStance.stderr)

    requests = []
    const invalidStockSort = await runCli([
      "factors",
      "valuation-stocks",
      "--sort",
      "opportunity_score",
    ], { env: auth })

    expect(invalidStockSort.status).not.toBe(0)
    expect(invalidStockSort.stderr).toContain("--sort must be one of: score, abs_beta, symbol")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidStockSort.stdout, invalidStockSort.stderr)
  })
})

describe("CLI event and dilution enum filters", () => {
  const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }

  test("forwards AAER enforcement source filters", async () => {
    const result = await runCli([
      "events",
      "enforcement",
      "--source-type",
      "aaer",
    ], { env: auth })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/events/enforcement")
    expect(requests[0]?.searchParams.source_type).toBe("aaer")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("rejects unsupported event filter enum values locally", async () => {
    const enforcement = await runCli([
      "events",
      "enforcement",
      "--source-type",
      "court_order",
    ], { env: auth })

    expect(enforcement.status).not.toBe(0)
    expect(enforcement.stderr).toContain("--source-type must be one of: litigation_release, administrative_proceeding, aaer")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(enforcement.stdout, enforcement.stderr)

    requests = []
    const voting = await runCli([
      "events",
      "voting-results",
      "--meeting-type",
      "quarterly",
    ], { env: auth })

    expect(voting.status).not.toBe(0)
    expect(voting.stderr).toContain("--meeting-type must be one of: annual, special")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(voting.stdout, voting.stderr)
  })

  test("rejects unsupported dilution risk filters locally", async () => {
    const allowed = await runCli([
      "dilution",
      "ratings",
      "--overall-risk",
      "elevated",
    ], { env: auth })

    expect(allowed.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/dilution/ratings")
    expect(requests[0]?.searchParams.overall_risk).toBe("elevated")
    assertNoSecretLeak(allowed.stdout, allowed.stderr)

    requests = []
    const result = await runCli([
      "dilution",
      "ratings",
      "--overall-risk",
      "critical",
    ], { env: auth })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--overall-risk must be one of: low, moderate, elevated, high")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })
})

describe("CLI factor parity commands", () => {
  test("catalog, dashboard, and model portfolio views forward compact trust controls", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }

    const catalog = await runCli([
      "factors",
      "catalog",
      "--category",
      "style",
      "--response-mode",
      "compact",
      "--include",
      "trust",
    ], { env: auth })
    expect(catalog.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/catalog")
    expect(requests[0]?.searchParams.category).toBe("style")
    expect(requests[0]?.searchParams.response_mode).toBe("compact")
    expect(requests[0]?.searchParams.include).toBe("trust")

    requests = []
    const dashboard = await runCli([
      "factors",
      "dashboard",
      "--country",
      "US",
      "--category",
      "style",
      "--ticker",
      "AAPL",
      "--response-mode",
      "compact",
      "--include",
      "trust",
    ], { env: auth })
    expect(dashboard.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/dashboard")
    expect(requests[0]?.searchParams.country).toBe("US")
    expect(requests[0]?.searchParams.category).toBe("style")
    expect(requests[0]?.searchParams.ticker).toBe("AAPL")
    expect(requests[0]?.searchParams.response_mode).toBe("compact")
    expect(requests[0]?.searchParams.include).toBe("trust")

    requests = []
    const factorView = await runCli([
      "model-portfolios",
      "factor-view",
      "--portfolio-id",
      "growth-core",
      "--keys",
      "VALUE,QUALITY",
      "--response-mode",
      "compact",
      "--include",
      "trust",
    ], { env: auth })
    expect(factorView.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/model-portfolios/growth-core/factor-view")
    expect(requests[0]?.searchParams.keys).toBe("VALUE,QUALITY")
    expect(requests[0]?.searchParams.response_mode).toBe("compact")
    expect(requests[0]?.searchParams.include).toBe("trust")
    assertNoSecretLeak(catalog.stdout + dashboard.stdout + factorView.stdout, catalog.stderr + dashboard.stderr + factorView.stderr)
  })

  test("history forwards response view aliases as response modes", async () => {
    const result = await runCli([
      "factors",
      "history",
      "--factor",
      "VALUE",
      "--range",
      "1y",
      "--view",
      "agent",
      "--expand",
      "trust,series",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.method).toBe("GET")
    expect(requests[0]?.path).toBe("/v1/factors/history/VALUE")
    expect(requests[0]?.searchParams.range).toBe("1y")
    expect(requests[0]?.searchParams.response_mode).toBe("compact")
    expect(requests[0]?.searchParams.include).toBe("trust,series")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("factor commands reject duplicate response mode flags locally", async () => {
    const result = await runCli([
      "factors",
      "history",
      "--factor",
      "VALUE",
      "--view",
      "compact",
      "--view",
      "agent",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--view may only be provided once")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("factor commands reject unsupported response modes locally", async () => {
    const result = await runCli([
      "factors",
      "history",
      "--factor",
      "VALUE",
      "--response-mode",
      "agent",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--response-mode must be one of: compact, standard, verbose")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("factor extreme commands validate side and sort flags locally", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }
    const moves = await runCli([
      "factors",
      "extreme-moves",
      "--keys",
      "VALUE",
      "--direction",
      "UP",
      "--sort",
      "ABS-SCALED-RETURN",
      "--view",
      "agent",
    ], { env: auth })

    expect(moves.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/extreme-moves")
    expect(requests[0]?.searchParams.direction).toBe("up")
    expect(requests[0]?.searchParams.sort).toBe("abs_scaled_return")
    expect(requests[0]?.searchParams.response_mode).toBe("compact")

    requests = []
    const pairs = await runCli([
      "factors",
      "extreme-pairs",
      "--keys",
      "VALUE,MOMENTUM",
      "--side",
      "FACTOR1",
      "--sort",
      "ABS-SPREAD-RETURN",
      "--view",
      "default",
    ], { env: auth })

    expect(pairs.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/extreme-pairs")
    expect(requests[0]?.searchParams.side).toBe("factor1")
    expect(requests[0]?.searchParams.sort).toBe("abs_spread_return")
    expect(requests[0]?.searchParams.response_mode).toBe("standard")
    assertNoSecretLeak(moves.stdout + pairs.stdout, moves.stderr + pairs.stderr)
  })

  test("factor pair commands forward response view aliases", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }
    const pairs = await runCli([
      "factors",
      "pairs",
      "--factor1",
      "VALUE",
      "--factor2",
      "MOMENTUM",
      "--view",
      "agent",
    ], { env: auth })

    expect(pairs.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/pairs")
    expect(requests[0]?.searchParams.response_mode).toBe("compact")

    requests = []
    const history = await runCli([
      "factors",
      "pair-history",
      "--factor1",
      "VALUE",
      "--factor2",
      "MOMENTUM",
      "--view",
      "default",
    ], { env: auth })

    expect(history.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/pair-history/VALUE/MOMENTUM")
    expect(requests[0]?.searchParams.response_mode).toBe("standard")
    assertNoSecretLeak(pairs.stdout + history.stdout, pairs.stderr + history.stderr)
  })

  test("factor extreme commands reject unsupported side and sort flags locally", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }
    const duplicateMoveSide = await runCli([
      "factors",
      "extreme-moves",
      "--keys",
      "VALUE",
      "--side",
      "up",
      "--side",
      "down",
    ], { env: auth })

    expect(duplicateMoveSide.status).not.toBe(0)
    expect(duplicateMoveSide.stderr).toContain("--side may only be provided once")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(duplicateMoveSide.stdout, duplicateMoveSide.stderr)

    requests = []
    const invalidMoveSide = await runCli([
      "factors",
      "extreme-moves",
      "--keys",
      "VALUE",
      "--side",
      "sideways",
    ], { env: auth })

    expect(invalidMoveSide.status).not.toBe(0)
    expect(invalidMoveSide.stderr).toContain("--side must be one of: both, up, down, flat")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidMoveSide.stdout, invalidMoveSide.stderr)

    requests = []
    const invalidMoveSort = await runCli([
      "factors",
      "extreme-moves",
      "--keys",
      "VALUE",
      "--sort",
      "abs_spread_return",
    ], { env: auth })

    expect(invalidMoveSort.status).not.toBe(0)
    expect(invalidMoveSort.stderr).toContain("--sort must be one of: abs_z_score, abs_scaled_return")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidMoveSort.stdout, invalidMoveSort.stderr)

    requests = []
    const invalidPairSide = await runCli([
      "factors",
      "extreme-pairs",
      "--keys",
      "VALUE,MOMENTUM",
      "--direction",
      "winner",
    ], { env: auth })

    expect(invalidPairSide.status).not.toBe(0)
    expect(invalidPairSide.stderr).toContain("--direction must be one of: both, factor1, factor2, flat")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidPairSide.stdout, invalidPairSide.stderr)

    requests = []
    const invalidPairSort = await runCli([
      "factors",
      "extreme-pairs",
      "--keys",
      "VALUE,MOMENTUM",
      "--sort",
      "abs_scaled_return",
    ], { env: auth })

    expect(invalidPairSort.status).not.toBe(0)
    expect(invalidPairSort.stderr).toContain("--sort must be one of: abs_z_score, abs_spread_return")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidPairSort.stdout, invalidPairSort.stderr)
  })

  test("sparklines, exposures, and bulk-download expose launch GET workflows", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }

    const sparklines = await runCli([
      "factors",
      "sparklines",
      "--factors",
      "VALUE,MOMENTUM",
      "--range",
      "1y",
      "--points",
      "32",
      "--metric",
      "Z-SCORE",
    ], { env: auth })
    expect(sparklines.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/sparklines")
    expect(requests[0]?.searchParams.keys).toBe("VALUE,MOMENTUM")
    expect(requests[0]?.searchParams.points).toBe("32")
    expect(requests[0]?.searchParams.metric).toBe("z_score")

    requests = []
    const exposures = await runCli([
      "factors",
      "exposures",
      "--symbols",
      "AAPL,MSFT",
      "--keys",
      "QUALITY",
      "--model",
      "joint_elasticnet",
    ], { env: auth })
    expect(exposures.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/exposures")
    expect(requests[0]?.searchParams.symbols).toBe("AAPL,MSFT")
    expect(requests[0]?.searchParams.keys).toBe("QUALITY")
    expect(requests[0]?.searchParams.model).toBe("joint_elasticnet")

    requests = []
    const bulk = await runCli([
      "factors",
      "bulk-download",
      "--keys",
      "VALUE",
      "--format",
      "csv",
    ], { env: auth })
    expect(bulk.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/factors/bulk-download")
    expect(requests[0]?.searchParams.format).toBe("csv")
    expect(bulk.stdout.startsWith("rank,factor_key\n")).toBe(true)
    assertNoSecretLeak(sparklines.stdout + exposures.stdout + bulk.stdout, sparklines.stderr + exposures.stderr + bulk.stderr)
  })

  test("sparklines rejects unsupported metrics locally", async () => {
    const result = await runCli([
      "factors",
      "sparklines",
      "--keys",
      "VALUE",
      "--metric",
      "drawdown",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--metric must be one of: scaled_return, pure_return, raw_return, z_score")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("custom factor command posts JSON body with compact controls", async () => {
    const result = await runCli([
      "factors",
      "custom",
      "--body-json",
      "{\"symbol\":\"NVDA\",\"candidates\":[\"MSFT\"]}",
      "--response-mode",
      "compact",
      "--include",
      "trust",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.path).toBe("/v1/factors/custom")
    expect(requests[0]?.searchParams.response_mode).toBe("compact")
    expect(requests[0]?.searchParams.include).toBe("trust")
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ symbol: "NVDA", candidates: ["MSFT"] })
    assertNoSecretLeak(result.stdout, result.stderr)
  })
})

describe("CLI portfolio and model factor commands", () => {
  const holdingsJson = "[{\"symbol\":\"AAPL\",\"weight\":0.6},{\"symbol\":\"MSFT\",\"weight\":0.4}]"

  test("portfolio analyze posts benchmark and what-if holdings from JSON and file inputs", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "secapi-cli-"))
    const benchmarkPath = path.join(tmp, "benchmark.json")
    try {
      writeFileSync(benchmarkPath, "[{\"symbol\":\"SPY\",\"weight\":1}]\n")
      const result = await runCli([
        "portfolio",
        "analyze",
        "--holdings-json",
        holdingsJson,
        "--benchmark-label",
        "SPY",
        "--benchmark-holdings-file",
        benchmarkPath,
        "--what-if-label",
        "More Microsoft",
        "--what-if-holdings-json",
        "[{\"symbol\":\"MSFT\",\"weight\":1}]",
        "--response-mode",
        "compact",
      ], {
        env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
      })

      expect(result.status).toBe(0)
      expect(requests[0]?.method).toBe("POST")
      expect(requests[0]?.path).toBe("/v1/portfolio/analyze")
      expect(requests[0]?.searchParams.response_mode).toBe("compact")
      const body = JSON.parse(requests[0]?.body ?? "{}")
      expect(body.holdings).toHaveLength(2)
      expect(body.benchmarkLabel).toBe("SPY")
      expect(body.benchmarkHoldings).toEqual([{ symbol: "SPY", weight: 1 }])
      expect(body.whatIfLabel).toBe("More Microsoft")
      expect(body.whatIfHoldings).toEqual([{ symbol: "MSFT", weight: 1 }])
      assertNoSecretLeak(result.stdout, result.stderr)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("portfolio optimize posts holdings and optimizer constraints", async () => {
    const result = await runCli([
      "portfolio",
      "optimize",
      "--holdings-json",
      holdingsJson,
      "--objective",
      "regime_aware",
      "--constraints-json",
      "{\"maxCandidates\":3,\"maxRuntimeMs\":750}",
      "--response-mode",
      "compact",
      "--include",
      "trust",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.path).toBe("/v1/portfolio/optimize")
    expect(requests[0]?.searchParams.response_mode).toBe("compact")
    const body = JSON.parse(requests[0]?.body ?? "{}")
    expect(body.holdings).toHaveLength(2)
    expect(body.objective).toBe("regime_aware")
    expect(body.constraints.maxCandidates).toBe(3)
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("portfolio workflows reject unsupported objectives and hedge modes locally", async () => {
    const invalidObjective = await runCli([
      "portfolio",
      "optimize",
      "--holdings-json",
      holdingsJson,
      "--objective",
      "maximize_alpha",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(invalidObjective.status).not.toBe(0)
    expect(invalidObjective.stderr).toContain("--objective must be one of: factor_neutral, min_drawdown, regime_aware")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidObjective.stdout, invalidObjective.stderr)

    requests = []
    const invalidMode = await runCli([
      "portfolio",
      "hedge",
      "--holdings-json",
      holdingsJson,
      "--mode",
      "full",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(invalidMode.status).not.toBe(0)
    expect(invalidMode.stderr).toContain("--mode must be one of: compact, standard")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidMode.stdout, invalidMode.stderr)
  })

  test("portfolio attribution and hedge expose workflow-specific controls", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }
    const attribution = await runCli([
      "portfolio",
      "attribution",
      "--holdings-json",
      holdingsJson,
      "--window",
      "1m",
      "--frequency",
      "weekly",
      "--export-format",
      "csv",
    ], { env: auth })

    expect(attribution.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/portfolio/attribution")
    const attributionBody = JSON.parse(requests[0]?.body ?? "{}")
    expect(attributionBody.frequency).toBe("weekly")
    expect(attributionBody.exportFormat).toBe("csv")

    requests = []
    const hedge = await runCli([
      "portfolio",
      "hedge",
      "--holdings-json",
      holdingsJson,
      "--objective",
      "min_drawdown",
      "--constraints-json",
      "{\"maxHedges\":2,\"hedgeIntensity\":0.5}",
    ], { env: auth })

    expect(hedge.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/portfolio/hedge")
    const body = JSON.parse(requests[0]?.body ?? "{}")
    expect(body.objective).toBe("min_drawdown")
    expect(body.constraints.maxHedges).toBe(2)
    assertNoSecretLeak(attribution.stdout + hedge.stdout, attribution.stderr + hedge.stderr)
  })

  test("portfolio workflows reject unsupported attribution and scenario enum flags locally", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }
    const invalidFrequency = await runCli([
      "portfolio",
      "attribution",
      "--holdings-json",
      holdingsJson,
      "--frequency",
      "biweekly",
    ], { env: auth })

    expect(invalidFrequency.status).not.toBe(0)
    expect(invalidFrequency.stderr).toContain("--frequency must be one of: daily, weekly, monthly, quarterly, annual")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidFrequency.stdout, invalidFrequency.stderr)

    requests = []
    const invalidExport = await runCli([
      "portfolio",
      "attribution",
      "--holdings-json",
      holdingsJson,
      "--export-format",
      "xlsx",
    ], { env: auth })

    expect(invalidExport.status).not.toBe(0)
    expect(invalidExport.stderr).toContain("--export-format must be one of: json, csv, both")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidExport.stdout, invalidExport.stderr)

    requests = []
    const invalidScenario = await runCli([
      "portfolio",
      "stress-test",
      "--holdings-json",
      holdingsJson,
      "--scenario-key",
      "soft_landing",
    ], { env: auth })

    expect(invalidScenario.status).not.toBe(0)
    expect(invalidScenario.stderr).toContain("--scenario-key must be one of: us_recession, higher_for_longer, china_growth_scare")
    expect(requests).toHaveLength(0)
    assertNoSecretLeak(invalidScenario.stdout, invalidScenario.stderr)
  })

  test("portfolio stress-test posts scenario and holdings from file input", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "secapi-cli-"))
    const holdingsPath = path.join(tmp, "holdings.json")
    try {
      writeFileSync(holdingsPath, `${holdingsJson}\n`)
      const result = await runCli([
        "portfolio",
        "stress-test",
        "--holdings-file",
        holdingsPath,
        "--scenario-key",
        "higher_for_longer",
        "--category",
        "style",
      ], {
        env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
      })

      expect(result.status).toBe(0)
      expect(requests[0]?.method).toBe("POST")
      expect(requests[0]?.path).toBe("/v1/portfolio/stress-test")
      const body = JSON.parse(requests[0]?.body ?? "{}")
      expect(body.holdings).toHaveLength(2)
      expect(body.scenarioKey).toBe("higher_for_longer")
      expect(body.category).toBe("style")
      assertNoSecretLeak(result.stdout, result.stderr)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("models factor-analysis posts model sections and optimizer options", async () => {
    const result = await runCli([
      "models",
      "factor-analysis",
      "--holdings-json",
      holdingsJson,
      "--label",
      "AI leaders",
      "--source",
      "model_builder",
      "--include-attribution",
      "true",
      "--include-hedge",
      "true",
      "--include-optimizer",
      "true",
      "--include-position-views",
      "false",
      "--optimizer-json",
      "{\"objective\":\"regime_aware\",\"constraints\":{\"maxCandidates\":3}}",
      "--response-mode",
      "compact",
    ], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/models/factor-analysis")
    expect(requests[0]?.searchParams.response_mode).toBe("compact")
    expect(requests[0]?.searchParams.include).toBe("trust")
    const body = JSON.parse(requests[0]?.body ?? "{}")
    expect(body.model.label).toBe("AI leaders")
    expect(body.model.source).toBe("model_builder")
    expect(body.include.optimizer).toBe(true)
    expect(body.include.positionViews).toBe(false)
    expect(body.optimizer.objective).toBe("regime_aware")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("strategy commands post compact factor workflow bodies", async () => {
    const auth = { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" }
    const rotation = await runCli([
      "strategies",
      "factor-rotation",
      "--country",
      "US",
      "--category",
      "style",
      "--limit",
      "5",
    ], { env: auth })

    expect(rotation.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/strategies/factor-rotation")
    expect(JSON.parse(requests[0]?.body ?? "{}").limit).toBe(5)

    requests = []
    const regime = await runCli([
      "strategies",
      "regime-screen",
      "--country",
      "US",
      "--lookback",
      "6m",
    ], { env: auth })

    expect(regime.status).toBe(0)
    expect(requests[0]?.path).toBe("/v1/strategies/regime-screen")
    expect(JSON.parse(requests[0]?.body ?? "{}").lookback).toBe("6m")
    assertNoSecretLeak(rotation.stdout + regime.stdout, rotation.stderr + regime.stderr)
  })
})

describe("CLI agent setup (init + agent-context)", () => {
  test("agent-context emits machine-readable JSON describing the CLI surface", async () => {
    const result = await runCli(["agent-context"])
    expect(result.status).toBe(0)
    const ctx = JSON.parse(result.stdout)
    expect(ctx.object).toBe("agent_context")
    expect(ctx.mcpUrl).toContain("/mcp")
    expect(ctx.auth.header).toBe("x-api-key")
    expect(ctx.install.skills).toContain("npx skills add secapi-ai/secapi-skills")
    expect(Array.isArray(ctx.commandGroups)).toBe(true)
    const groups = new Map(ctx.commandGroups.map((entry: { group: string; commands: string[] }) => [entry.group, entry.commands]))
    expect(groups.get("root")).toContain("secapi health")
    expect(groups.get("root")).toContain("secapi examples [--json=false]")
    expect(groups.get("config")).toContain("secapi config show")
    expect(groups.get("config")).toContain("secapi config profiles")
    expect(groups.get("traces")).toContain("secapi traces get --trace-id <trace_id>")
    expect(groups.get("dilution")).toContain("secapi dilution events")
    expect(groups.get("macro")).toContain("secapi macro calendar")
    expect(groups.get("artifacts")).toContain("secapi artifacts bundle")
    expect(groups.get("webhooks")).toContain("secapi webhooks create")
    expect(groups.get("models")).toContain("secapi models factor-analysis")
    expect(groups.get("portfolio")).toContain("secapi portfolio stress-test")
    const details = ctx.commandGroups
      .flatMap((entry: { details: Array<{ command: string }> }) => entry.details)
    const detailByCommand = new Map(details.map((detail: { command: string }) => [detail.command, detail]))
    expect(detailByCommand.get("secapi agent-context")).toMatchObject({
      auth: "none",
      mutates: false,
      output: "json",
      requiredFlags: [],
    })
    expect(detailByCommand.get("secapi doctor")).toMatchObject({
      auth: "optional_api_key",
      mutates: false,
      output: "json",
      requiredFlags: [],
    })
    expect(detailByCommand.get("secapi config show")).toMatchObject({
      auth: "none",
      mutates: false,
      output: "json",
      requiredFlags: [],
    })
    expect(detailByCommand.get("secapi config profiles")).toMatchObject({
      auth: "none",
      mutates: false,
      output: "json",
      requiredFlags: [],
    })
    expect(detailByCommand.get("secapi examples")).toMatchObject({
      auth: "none",
      mutates: false,
      output: "human_or_json",
      requiredFlags: [],
    })
    expect(detailByCommand.get("secapi completion")).toMatchObject({
      auth: "none",
      mutates: false,
      output: "text",
      requiredFlags: [],
      examples: ["secapi completion zsh"],
    })
    expect(detailByCommand.get("secapi agent bootstrap-token")).toMatchObject({
      auth: "bearer",
      mutates: true,
      requiredFlags: ["--label"],
    })
    expect(detailByCommand.get("secapi init")).toMatchObject({
      auth: "optional_api_key",
      mutates: true,
      output: "file_or_text",
      requiredFlags: ["--client"],
    })
    expect(detailByCommand.get("secapi filings latest")).toMatchObject({
      auth: "api_key",
      mutates: false,
      requiredFlags: ["--ticker|--cik"],
    })
    expect(detailByCommand.get("secapi factors valuations")).toMatchObject({
      output: "json_or_csv",
      examples: ["secapi factors valuations --keys VALUE,MOMENTUM --side all"],
    })
    expect(detailByCommand.get("secapi factors decomposition")).toMatchObject({
      requiredFlags: ["--ticker|--symbol"],
      examples: ["secapi factors decomposition --ticker AAPL"],
    })
    expect(detailByCommand.get("secapi admin org")).toMatchObject({
      requiredFlags: ["--org-id"],
    })
    expect(detailByCommand.get("secapi admin request")).toMatchObject({
      requiredFlags: ["--org-id", "--request-id"],
    })
    expect(detailByCommand.get("secapi admin deliveries-summary")).toMatchObject({
      requiredFlags: ["--org-id"],
    })
    expect(detailByCommand.get("secapi facts get")).toMatchObject({
      requiredFlags: ["--tag"],
    })
    expect(detailByCommand.get("secapi portfolio optimize")).toMatchObject({
      mutates: false,
      requiredFlags: ["--holdings-json|--holdings-file"],
    })
  })

  test("init --client claude-code prints the command with a shell env reference, not a literal key", async () => {
    const result = await runCli(["init", "--client", "claude-code"], { env: { SECAPI_API_KEY: "secapi_live_INIT_KEY" } })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("claude mcp add --transport http secapi")
    expect(result.stdout).toContain("/mcp")
    expect(result.stdout).toContain("x-api-key: $SECAPI_API_KEY")
    expect(result.stdout).not.toContain("secapi_live_INIT_KEY")
  })

  test("init --client cursor uses an env-var reference (no literal key in a committable file)", async () => {
    const result = await runCli(["init", "--client", "cursor", "--print"], { env: { SECAPI_API_KEY: "secapi_live_INIT_KEY" } })
    expect(result.status).toBe(0)
    const json = JSON.parse(result.stdout.split("\n").slice(1).join("\n"))
    expect(json.mcpServers.secapi.url).toContain("/mcp")
    expect(json.mcpServers.secapi.headers["x-api-key"]).toBe("${SECAPI_API_KEY}")
    expect(result.stdout).not.toContain("secapi_live_INIT_KEY")
  })

  test("mcp install aliases init for agent-client setup", async () => {
    const byFlag = await runCli(["mcp", "install", "--client", "cursor", "--print"], { env: { SECAPI_API_KEY: "secapi_live_INIT_KEY" } })
    expect(byFlag.status).toBe(0)
    const byFlagJson = JSON.parse(byFlag.stdout.split("\n").slice(1).join("\n"))
    expect(byFlagJson.mcpServers.secapi.url).toContain("/mcp")
    expect(byFlagJson.mcpServers.secapi.headers["x-api-key"]).toBe("${SECAPI_API_KEY}")
    expect(byFlag.stdout).not.toContain("secapi_live_INIT_KEY")

    const byPosition = await runCli(["mcp", "install", "claude-code"], { env: { SECAPI_API_KEY: "secapi_live_INIT_KEY" } })
    expect(byPosition.status).toBe(0)
    expect(byPosition.stdout).toContain("claude mcp add --transport http secapi")
    expect(byPosition.stdout).toContain("x-api-key: $SECAPI_API_KEY")
    expect(byPosition.stdout).not.toContain("secapi_live_INIT_KEY")
  })

  test("init --client project adds type:http and an env-var reference", async () => {
    const result = await runCli(["init", "--client", "project", "--print"], { env: { SECAPI_API_KEY: "secapi_live_INIT_KEY" } })
    expect(result.status).toBe(0)
    const json = JSON.parse(result.stdout.split("\n").slice(1).join("\n"))
    expect(json.mcpServers.secapi.type).toBe("http")
    expect(json.mcpServers.secapi.headers["x-api-key"]).toBe("${SECAPI_API_KEY}")
  })

  test("init --client windsurf writes a merged MCP config into HOME (env ref, 0600)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "secapi-init-"))
    try {
      const result = await runCli(["init", "--client", "windsurf"], { env: { HOME: home, SECAPI_API_KEY: "secapi_live_INIT_KEY" } })
      expect(result.status).toBe(0)
      const configPath = path.join(home, ".codeium", "windsurf", "mcp_config.json")
      const raw = readFileSync(configPath, "utf8")
      expect(raw).not.toContain("secapi_live_INIT_KEY")
      const written = JSON.parse(raw)
      expect(written.mcpServers.secapi.serverUrl).toContain("/mcp")
      expect(written.mcpServers.secapi.headers["x-api-key"]).toBe("${env:SECAPI_API_KEY}")
      if (process.platform !== "win32") {
        const { statSync } = await import("node:fs")
        expect(statSync(configPath).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("init rejects an existing config whose mcpServers is an array", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "secapi-init-"))
    try {
      const configPath = path.join(home, ".codeium", "windsurf", "mcp_config.json")
      const { mkdirSync } = await import("node:fs")
      mkdirSync(path.dirname(configPath), { recursive: true })
      writeFileSync(configPath, JSON.stringify({ mcpServers: ["nope"] }))
      const result = await runCli(["init", "--client", "windsurf"], { env: { HOME: home, SECAPI_API_KEY: "secapi_live_INIT_KEY" } })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("is not an object")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("init treats --client followed by a flag as a missing client", async () => {
    const result = await runCli(["init", "--client", "--print"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Usage: secapi init --client")
  })

  test("init never persists an operator key (only SECAPI_API_KEY/stdin)", async () => {
    const result = await runCli(["init", "--client", "claude-desktop", "--print"], {
      env: { SECAPI_OPERATOR_API_KEY: "opr_live_OPERATOR_AUTH" },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain("opr_live_OPERATOR_AUTH")
    expect(result.stdout).toContain("YOUR_API_KEY")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("setup previews do not require stdin-backed credentials", async () => {
    for (const command of [
      ["init", "--client", "cursor", "--print", "--api-key-stdin"],
      ["mcp", "install", "--client", "cursor", "--dry-run", "--api-key-stdin"],
      ["agents", "setup", "--client", "cursor", "--print", "--api-key-stdin"],
    ]) {
      const result = await runCli(command)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("${SECAPI_API_KEY}")
    }

    const shellPreview = await runCli(["init", "--client", "claude-desktop", "--print", "--api-key-stdin"])
    expect(shellPreview.status).toBe(0)
    expect(shellPreview.stderr).toBe("")
    expect(shellPreview.stdout).toContain("YOUR_API_KEY")
  })

  test("init tightens permissions on an already-existing config", async () => {
    if (process.platform === "win32") return
    const home = mkdtempSync(path.join(tmpdir(), "secapi-init-"))
    try {
      const configPath = path.join(home, ".codeium", "windsurf", "mcp_config.json")
      const { mkdirSync, statSync, chmodSync } = await import("node:fs")
      mkdirSync(path.dirname(configPath), { recursive: true })
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
      chmodSync(configPath, 0o644)
      const result = await runCli(["init", "--client", "windsurf"], { env: { HOME: home, SECAPI_API_KEY: "secapi_live_INIT_KEY" } })
      expect(result.status).toBe(0)
      expect(statSync(configPath).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("init preserves existing servers when merging", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "secapi-init-"))
    try {
      const configPath = path.join(home, ".codeium", "windsurf", "mcp_config.json")
      const { mkdirSync } = await import("node:fs")
      mkdirSync(path.dirname(configPath), { recursive: true })
      writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { serverUrl: "https://example.com" } } }, null, 2))
      const result = await runCli(["init", "--client", "windsurf"], { env: { HOME: home, SECAPI_API_KEY: "secapi_live_INIT_KEY" } })
      expect(result.status).toBe(0)
      const written = JSON.parse(readFileSync(configPath, "utf8"))
      expect(written.mcpServers.other.serverUrl).toBe("https://example.com")
      expect(written.mcpServers.secapi.serverUrl).toContain("/mcp")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("init rejects an unknown client", async () => {
    const result = await runCli(["init", "--client", "notepad"], { env: { SECAPI_API_KEY: "secapi_live_INIT_KEY" } })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unknown client")
  })

  test("init without a client prints usage", async () => {
    const result = await runCli(["init"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Usage: secapi init --client")
  })

  test("mcp install without a client prints alias-specific usage", async () => {
    const result = await runCli(["mcp", "install"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Usage: secapi mcp install --client")
  })

  test("init still rejects an API key passed as an argv flag", async () => {
    const result = await runCli(["init", "--client", "cursor", "--api-key", "secapi_live_ARGV_SHOULD_NOT_LEAK"])
    expect(result.status).toBe(1)
    assertNoSecretLeak(result.stdout, result.stderr)
  })
})
