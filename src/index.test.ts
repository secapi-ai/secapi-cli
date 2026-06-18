import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const cliEntry = new URL("./index.ts", import.meta.url)
const secretValues = [
  "ods_live_ARGV_SHOULD_NOT_LEAK",
  "bearer_ARGV_SHOULD_NOT_LEAK",
  "bearer_ENV_BACKED_AUTH",
  "bearer_OMNI_ENV_BACKED_AUTH",
  "opr_live_OPERATOR_AUTH",
  "opr_live_OMNI_OPERATOR_AUTH",
  "opr_live_OMNI_DATASTREAM_OPERATOR_AUTH",
  "secapi_live_ENV_BACKED_AUTH",
  "ods_live_OMNI_ENV_BACKED_AUTH",
  "ods_live_STDIN_BACKED_AUTH",
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

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
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
          headers: { "content-type": "text/csv; charset=utf-8" },
        })
      }
      if (url.pathname === "/v1/portfolio/hedge") {
        const body = JSON.parse(requests.at(-1)?.body || "{}")
        return Response.json(fakePortfolioHedge(body.holdings ?? []))
      }
      if (url.pathname === "/v1/models/factor-analysis") {
        const body = JSON.parse(requests.at(-1)?.body || "{}")
        return Response.json(fakeModelFactorAnalysis(body))
      }
      return Response.json({ ok: true })
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
    const result = await runCli(["health", "--api-key", "ods_live_ARGV_SHOULD_NOT_LEAK"])

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
      env: { OMNI_DATASTREAM_API_KEY: "ods_live_OMNI_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers["x-api-key"]).toBe("ods_live_OMNI_ENV_BACKED_AUTH")
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
      input: "ods_live_STDIN_BACKED_AUTH\n",
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers["x-api-key"]).toBe("ods_live_STDIN_BACKED_AUTH")
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

  test("search fulltext requires a query", async () => {
    const result = await runCli(["search", "fulltext"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--q or --query is required")
    expect(requests).toHaveLength(0)
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
      "tailwind",
      "--weighting-mode",
      "short_leg_focus",
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
      "beneficiaries",
      "--weighting-mode",
      "long_short_equal",
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
    expect(requests[0]?.searchParams.format).toBe("csv")
    expect(result.stdout.startsWith("rank,symbol,factor_key\n")).toBe(true)
    expect(result.stdout.startsWith("\"")).toBe(false)
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

  test("history forwards compact expansion controls", async () => {
    const result = await runCli([
      "factors",
      "history",
      "--factor",
      "VALUE",
      "--range",
      "1y",
      "--view",
      "compact",
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
      "z_score",
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
    expect(JSON.parse(requests[0]?.body ?? "{}").frequency).toBe("weekly")

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
  })

  test("init --client claude-code prints the command with a shell env reference, not a literal key", async () => {
    const result = await runCli(["init", "--client", "claude-code"], { env: { SECAPI_API_KEY: "ods_live_INIT_KEY" } })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("claude mcp add --transport http secapi")
    expect(result.stdout).toContain("/mcp")
    expect(result.stdout).toContain("x-api-key: $SECAPI_API_KEY")
    expect(result.stdout).not.toContain("ods_live_INIT_KEY")
  })

  test("init --client cursor uses an env-var reference (no literal key in a committable file)", async () => {
    const result = await runCli(["init", "--client", "cursor", "--print"], { env: { SECAPI_API_KEY: "ods_live_INIT_KEY" } })
    expect(result.status).toBe(0)
    const json = JSON.parse(result.stdout.split("\n").slice(1).join("\n"))
    expect(json.mcpServers.secapi.url).toContain("/mcp")
    expect(json.mcpServers.secapi.headers["x-api-key"]).toBe("${SECAPI_API_KEY}")
    expect(result.stdout).not.toContain("ods_live_INIT_KEY")
  })

  test("init --client project adds type:http and an env-var reference", async () => {
    const result = await runCli(["init", "--client", "project", "--print"], { env: { SECAPI_API_KEY: "ods_live_INIT_KEY" } })
    expect(result.status).toBe(0)
    const json = JSON.parse(result.stdout.split("\n").slice(1).join("\n"))
    expect(json.mcpServers.secapi.type).toBe("http")
    expect(json.mcpServers.secapi.headers["x-api-key"]).toBe("${SECAPI_API_KEY}")
  })

  test("init --client windsurf writes a merged MCP config into HOME (env ref, 0600)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "secapi-init-"))
    try {
      const result = await runCli(["init", "--client", "windsurf"], { env: { HOME: home, SECAPI_API_KEY: "ods_live_INIT_KEY" } })
      expect(result.status).toBe(0)
      const configPath = path.join(home, ".codeium", "windsurf", "mcp_config.json")
      const raw = readFileSync(configPath, "utf8")
      expect(raw).not.toContain("ods_live_INIT_KEY")
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
      const result = await runCli(["init", "--client", "windsurf"], { env: { HOME: home, SECAPI_API_KEY: "ods_live_INIT_KEY" } })
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

  test("init tightens permissions on an already-existing config", async () => {
    if (process.platform === "win32") return
    const home = mkdtempSync(path.join(tmpdir(), "secapi-init-"))
    try {
      const configPath = path.join(home, ".codeium", "windsurf", "mcp_config.json")
      const { mkdirSync, statSync, chmodSync } = await import("node:fs")
      mkdirSync(path.dirname(configPath), { recursive: true })
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
      chmodSync(configPath, 0o644)
      const result = await runCli(["init", "--client", "windsurf"], { env: { HOME: home, SECAPI_API_KEY: "ods_live_INIT_KEY" } })
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
      const result = await runCli(["init", "--client", "windsurf"], { env: { HOME: home, SECAPI_API_KEY: "ods_live_INIT_KEY" } })
      expect(result.status).toBe(0)
      const written = JSON.parse(readFileSync(configPath, "utf8"))
      expect(written.mcpServers.other.serverUrl).toBe("https://example.com")
      expect(written.mcpServers.secapi.serverUrl).toContain("/mcp")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("init rejects an unknown client", async () => {
    const result = await runCli(["init", "--client", "notepad"], { env: { SECAPI_API_KEY: "ods_live_INIT_KEY" } })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unknown client")
  })

  test("init without a client prints usage", async () => {
    const result = await runCli(["init"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Usage: secapi init --client")
  })

  test("init still rejects an API key passed as an argv flag", async () => {
    const result = await runCli(["init", "--client", "cursor", "--api-key", "ods_live_ARGV_SHOULD_NOT_LEAK"])
    expect(result.status).toBe(1)
    assertNoSecretLeak(result.stdout, result.stderr)
  })
})
