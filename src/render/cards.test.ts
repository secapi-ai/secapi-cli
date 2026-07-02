import { describe, expect, test } from "bun:test"
import { createTheme } from "../theme/theme.ts"
import { citationsCard, dilutionCard, extremeMovesCard, factorDashboardCard, factorSparklinesCard, filingCard, financialsCard, formatFilingStreamEvent, macroRegimeCard, monitorsCard, newsCard, portfolioCard, searchCard, traceCard } from "./cards.ts"

const plain = createTheme({ name: "terminal", support: "none" })

describe("filingCard", () => {
  const card = filingCard(plain)

  test("renders a filing-shaped value", () => {
    const out = card({
      ticker: "AAPL",
      formType: "10-K",
      filingDate: "2026-11-01",
      accessionNumber: "0000320193-26-000123",
      sourceUrl: "https://sec.gov/x",
      maturity: "ga",
    })
    expect(out).not.toBeNull()
    expect(out).toContain("AAPL")
    expect(out).toContain("10-K")
    expect(out).toContain("0000320193-26-000123")
    expect(out).toContain("filed 2026-11-01")
  })

  test("unwraps a { filing } envelope", () => {
    const out = card({ filing: { formType: "8-K", accessionNumber: "x" } })
    expect(out).toContain("8-K")
  })

  test("returns null for a non-filing shape (defers to JSON)", () => {
    expect(card({ unrelated: true })).toBeNull()
    expect(card(null)).toBeNull()
    expect(card([1, 2, 3])).toBeNull()
  })
})

describe("factorSparklinesCard", () => {
  const card = factorSparklinesCard(plain)

  test("renders a table from sparkline items", () => {
    const out = card({
      sparklines: [
        { key: "VALUE", points: [1, 2, 3, 4] },
        { key: "MOMENTUM", points: [4, 3, 2, 1] },
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("VALUE")
    expect(out).toContain("MOMENTUM")
    expect(out).toContain("FACTOR")
  })

  test("accepts a bare array and {data}", () => {
    expect(card([{ key: "QUALITY", series: [1, 2, 3] }])).toContain("QUALITY")
    expect(card({ data: [{ factorKey: "SIZE", values: [3, 2, 1] }] })).toContain("SIZE")
  })

  test("reports absolute point deltas for zero-baseline series", () => {
    const out = card({ sparklines: [{ key: "CUM_RET", points: [0, 2, 4] }] })
    expect(out).not.toBeNull()
    expect(out).toContain("+4.0 pts")
    expect(out).not.toContain("+0.0%")
  })

  test("keeps flat zero-baseline series visibly flat", () => {
    const out = card({ sparklines: [{ key: "FLAT", points: [0, 0, 0] }] })
    expect(out).not.toBeNull()
    expect(out).toContain("+0.0 pts")
  })

  test("returns null when there are no usable series", () => {
    expect(card({ sparklines: [] })).toBeNull()
    expect(card({ sparklines: [{ key: "X", points: [1] }] })).toBeNull() // <2 points
    expect(card({ nope: 1 })).toBeNull()
  })
})

describe("portfolioCard", () => {
  const card = portfolioCard(plain)

  test("renders exposures from a portfolio_analysis value", () => {
    const out = card({
      object: "portfolio_analysis",
      asOf: "2026-06-11",
      exposures: [
        { factorKey: "VALUE", beta: 0.42 },
        { factorKey: "MOMENTUM", beta: -0.18 },
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("VALUE")
    expect(out).toContain("MOMENTUM")
    expect(out).toContain("0.42")
  })

  test("renders a portfolio_hedge value using the same exposures table", () => {
    const out = card({ object: "portfolio_hedge", exposures: [{ factorKey: "SIZE", beta: 0.1 }] })
    expect(out).toContain("SIZE")
    expect(out).toContain("Portfolio hedge")
  })

  test("renders stress-test scenario + contributions", () => {
    const out = card({
      object: "portfolio_stress_test",
      scenarioLabel: "US Recession",
      estimatedDrawdownPercent: 12.5,
      contributions: [
        { factorKey: "MKT_US", contribution: -0.3, direction: "headwind" },
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("US Recession")
    expect(out).toContain("MKT_US")
    expect(out).toContain("headwind")
  })

  test("returns null for an empty or unrelated shape", () => {
    expect(card({ object: "portfolio_analysis", exposures: [] })).toBeNull()
    expect(card({ object: "something_else" })).toBeNull()
    expect(card(null)).toBeNull()
  })
})

describe("financialsCard", () => {
  const card = financialsCard(plain)

  test("renders a financials trend with PoP revenue delta (real nested financials.income_statement shape)", () => {
    const out = card({
      object: "company_financials",
      ticker: "AAPL",
      companyName: "Apple Inc.",
      period: "annual",
      data: [
        { fiscal_year: 2026, financials: { income_statement: { revenue: 400_000_000, netIncome: 100_000_000, eps: 6.5 } } },
        { fiscal_year: 2025, financials: { income_statement: { revenue: 380_000_000, netIncome: 90_000_000, eps: 6.0 } } },
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("AAPL")
    expect(out).toContain("2026")
    expect(out).toContain("6.50")
  })

  test("returns null when no row yields a real metric (defers to JSON instead of an all-dash table)", () => {
    const out = card({
      object: "company_financials",
      ticker: "AAPL",
      data: [{ fiscal_year: 2026, financials: { income_statement: {} } }],
    })
    expect(out).toBeNull()
  })

  test("returns null for a non-financials shape", () => {
    expect(card({ object: "company_financials", data: [] })).toBeNull()
    expect(card({ nope: true })).toBeNull()
  })
})

describe("searchCard", () => {
  const card = searchCard(plain)

  test("renders filings and section excerpts from a fulltext_search value", () => {
    const out = card({
      object: "fulltext_search",
      query: "going concern",
      filings: { data: [{ ticker: "AMD", form: "10-K", companyName: "AMD Inc." }] },
      sections: { data: [{ title: "Risk Factors", snippet: "Our offering may cause dilution." }] },
    })
    expect(out).not.toBeNull()
    expect(out).toContain("going concern")
    expect(out).toContain("AMD")
    expect(out).toContain("Risk Factors")
    expect(out).toContain("dilution")
  })

  test("returns null when neither filings nor sections are present", () => {
    expect(card({ object: "fulltext_search", filings: { data: [] }, sections: { data: [] } })).toBeNull()
    expect(card({ object: "other" })).toBeNull()
  })
})

describe("traceCard", () => {
  const card = traceCard(plain)

  test("renders a trace with its lineage node chain", () => {
    const out = card({
      object: "trace",
      title: "Segmented revenue fact",
      summary: "Filing-derived revenue trace.",
      status: "supported",
      kind: "filing_fact",
      filing: { form: "10-K", accessionNumber: "0000320193-26-000123" },
      nodes: [
        { id: "n1", kind: "xbrl_fact", label: "Revenue tag", value: "us-gaap:Revenues" },
        { id: "n2", kind: "filing_excerpt", label: "10-K Item 7", value: "MD&A" },
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("Segmented revenue fact")
    expect(out).toContain("Revenue tag")
    expect(out).toContain("10-K Item 7")
    expect(out).toContain("0000320193-26-000123")
  })

  test("returns null for a non-trace shape", () => {
    expect(card({ object: "other" })).toBeNull()
    expect(card(null)).toBeNull()
  })
})

describe("citationsCard", () => {
  const card = citationsCard(plain)

  test("renders each hit's citation envelope (accession, snippet, source url)", () => {
    const out = card({
      object: "semantic_search",
      query: "revenue recognition risk",
      mode: "semantic",
      sections: {
        object: "list",
        data: [
          {
            ticker: "AAPL",
            accession: "0000320193-26-000123",
            section_key: "item7",
            highlighted_snippet: "We recognize revenue when...",
            source_url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000123/",
          },
        ],
        count: 1,
      },
    })
    expect(out).not.toBeNull()
    expect(out).toContain("revenue recognition risk")
    expect(out).toContain("AAPL")
    expect(out).toContain("0000320193-26-000123")
    expect(out).toContain("We recognize revenue when...")
    expect(out).toContain("https://www.sec.gov/Archives/edgar/data/320193/000032019326000123/")
  })

  test("returns null for a non-semantic-search shape or empty results", () => {
    expect(card({ object: "other" })).toBeNull()
    expect(card({ object: "semantic_search", query: "x", sections: { data: [] } })).toBeNull()
    expect(card(null)).toBeNull()
  })
})

describe("formatFilingStreamEvent", () => {
  test("formats a filing.published event with ticker, form, accession", () => {
    const line = formatFilingStreamEvent(plain, {
      event: "filing.published",
      filing: { accessionNumber: "0000320193-26-000123", form: "8-K", ticker: "AAPL", cik: "320193", completedAt: "2026-11-01T12:00:00Z" },
      cursor: "c1",
      deliveredAt: "2026-11-01T12:00:01Z",
    })
    expect(line).toContain("AAPL")
    expect(line).toContain("8-K")
    expect(line).toContain("0000320193-26-000123")
    expect(line).toContain("2026-11-01T12:00:01Z")
  })

  test("formats a connected event with its filters", () => {
    const line = formatFilingStreamEvent(plain, {
      event: "connected",
      connectionId: "conn_1",
      orgId: "org_1",
      filters: { forms: ["10-K", "8-K"], tickers: ["AAPL"] },
      cursor: null,
      serverTime: "2026-11-01T12:00:00Z",
    })
    expect(line).toContain("connected")
    expect(line).toContain("10-K,8-K")
    expect(line).toContain("AAPL")
  })

  test("formats a rate_limited event with its message", () => {
    const line = formatFilingStreamEvent(plain, { event: "rate_limited", message: "slow down", retryAfterMs: 1000 })
    expect(line).toContain("slow down")
  })

  test("falls back to raw JSON for an unrecognized event shape", () => {
    const line = formatFilingStreamEvent(plain, { event: "something_else", foo: "bar" })
    expect(line).toContain("something_else")
    expect(line).toContain("bar")
  })
})

describe("dilutionCard", () => {
  const card = dilutionCard(plain)

  test("renders ticker, risk band, score gauge, and factor breakdown", () => {
    const out = card({
      object: "dilution_rating",
      ticker: "AAPL",
      overallRisk: "elevated",
      numericScore: 62,
      regsho: true,
      freshness: { status: "fresh", asOf: "2026-11-01T00:00:00Z" },
      factors: [
        { key: "offering_ability", label: "Offering Ability", score: 0.7, weight: 0.3, explanation: "..." },
        { key: "historical", label: "Historical Dilution", score: 0.4, weight: 0.2, explanation: "..." },
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("AAPL")
    expect(out).toContain("ELEVATED")
    expect(out).toContain("62")
    expect(out).toContain("Reg SHO")
    expect(out).toContain("fresh")
    expect(out).toContain("Offering Ability")
    expect(out).toContain("Historical Dilution")
  })

  test("degrades gracefully for the leaner agent-view shape (no factors/freshness)", () => {
    const out = card({
      object: "dilution_rating",
      ticker: "MSFT",
      overallRisk: "low",
      numericScore: 12,
      factorExposures: { offering_ability: 0.1 },
    })
    expect(out).not.toBeNull()
    expect(out).toContain("MSFT")
    expect(out).toContain("LOW")
  })

  test("returns null for a non-dilution-rating shape", () => {
    expect(card({ object: "other" })).toBeNull()
    expect(card(null)).toBeNull()
  })
})

describe("monitorsCard", () => {
  const card = monitorsCard(plain)

  test("renders a list of monitors with name, query, active state, delivery", () => {
    const out = card({
      object: "list",
      data: [
        {
          object: "monitor",
          id: "mon_1",
          name: "8-K risk mentions",
          query: "material weakness",
          isActive: true,
          delivery: { type: "email", config: { to: "a@b.com" } },
        },
        { object: "monitor", id: "mon_2", name: "Paused search", query: "buyback", isActive: false },
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("8-K risk mentions")
    expect(out).toContain("material weakness")
    expect(out).toContain("email")
    expect(out).toContain("Paused search")
  })

  test("renders a single monitor (get/create response)", () => {
    const out = card({ object: "monitor", id: "mon_1", name: "Solo", query: "q", isActive: true })
    expect(out).not.toBeNull()
    expect(out).toContain("Solo")
  })

  test("returns null for a non-monitor shape or an empty list", () => {
    expect(card({ object: "other" })).toBeNull()
    expect(card({ object: "list", data: [] })).toBeNull()
    expect(card(null)).toBeNull()
  })
})

describe("newsCard", () => {
  const card = newsCard(plain)

  test("renders a list of news stories with symbol, headline, source, date", () => {
    const out = card({
      object: "list",
      data: [
        {
          object: "news_story",
          id: "news_1",
          headline: "Company files 8-K for material event",
          sourceName: "SEC EDGAR",
          publishedAt: "2026-11-01T00:00:00Z",
          symbols: ["AAPL"],
        },
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("AAPL")
    expect(out).toContain("Company files 8-K for material event")
    expect(out).toContain("SEC EDGAR")
  })

  test("returns null for a non-list shape or an empty list", () => {
    expect(card({ object: "other" })).toBeNull()
    expect(card({ object: "list", data: [] })).toBeNull()
    expect(card(null)).toBeNull()
  })
})

describe("factorDashboardCard", () => {
  const card = factorDashboardCard(plain)

  test("renders intraday returns, regime-ranked factors, and a ticker spotlight", () => {
    const out = card({
      object: "factor_dashboard",
      country: "US",
      category: "style",
      window: "1m",
      asOf: "2026-11-01T00:00:00Z",
      intraday: [{ factorKey: "VALUE", pureReturn: 0.012 }],
      regimePerformance: [{ factorKey: "MOMENTUM", direction: "tailwind", zScore: 1.4 }],
      spotlightSymbol: "AAPL",
      spotlightExposures: [{ factorKey: "QUALITY", beta: 0.8 }],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("Factor Dashboard")
    expect(out).toContain("VALUE")
    expect(out).toContain("MOMENTUM")
    expect(out).toContain("tailwind")
    expect(out).toContain("Spotlight: AAPL")
    expect(out).toContain("QUALITY")
    // Regression (Codex review, PR #1206): factor_exposure rows expose the
    // loading as `beta` — a divergingBar (not the "—" placeholder) proves it read that field.
    expect(out).not.toContain("QUALITY —")
  })

  test("renders a partial/degraded dashboard that only has spotlight data (Codex review, PR #1206)", () => {
    const out = card({
      object: "factor_dashboard",
      country: "US",
      spotlightSymbol: "AAPL",
      spotlightExposures: [{ factorKey: "QUALITY", beta: 1.1 }],
      intraday: [],
      regimePerformance: [],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("Spotlight: AAPL")
    expect(out).toContain("QUALITY")
  })

  test("returns null for a non-factor-dashboard shape or a truly empty dashboard", () => {
    expect(card({ object: "other" })).toBeNull()
    expect(card({ object: "factor_dashboard", intraday: [], regimePerformance: [], spotlightExposures: [] })).toBeNull()
    expect(card(null)).toBeNull()
  })
})

describe("extremeMovesCard", () => {
  const card = extremeMovesCard(plain)

  test("renders a list of extreme factor moves with direction and z-score", () => {
    const out = card({
      object: "list",
      data: [
        { object: "factor_extreme_move", factorKey: "MOMENTUM", direction: "up", pureReturn: 0.031, absZScore: 2.4 },
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("MOMENTUM")
    expect(out).toContain("up")
    expect(out).toContain("2.40")
  })

  test("returns null for a non-list shape or an empty list", () => {
    expect(card({ object: "other" })).toBeNull()
    expect(card({ object: "list", data: [] })).toBeNull()
    expect(card(null)).toBeNull()
  })
})

describe("macroRegimeCard", () => {
  const card = macroRegimeCard(plain)

  test("renders the regime label, confidence, drivers, and factor impacts", () => {
    const out = card({
      object: "list",
      data: [
        {
          key: "higher_for_longer",
          label: "Higher-for-longer backdrop",
          confidence: "high",
          drivers: [{ label: "Policy rate", explanation: "Latest policy series is 5.25%." }],
          factorImpacts: [{ factorKey: "VALUE", direction: "tailwind" }],
        },
      ],
    })
    expect(out).not.toBeNull()
    expect(out).toContain("Higher-for-longer backdrop")
    expect(out).toContain("high confidence")
    expect(out).toContain("Policy rate")
    expect(out).toContain("VALUE")
  })

  test("returns null when no item looks like a regime state", () => {
    expect(card({ object: "list", data: [{ foo: "bar" }] })).toBeNull()
    expect(card({ object: "other" })).toBeNull()
    expect(card(null)).toBeNull()
  })
})
