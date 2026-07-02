// Rich resource cards (TTY-only). Each card reads the API value DEFENSIVELY and
// returns null when the shape isn't what it expects, so the renderer falls back
// to byte-identical JSON — a card can never produce broken output. Cards are
// bound to the active Theme and registered by hint in index.ts.

import type { CardRenderer, RenderHint } from "./renderer.ts"
import type { Theme } from "../theme/theme.ts"
import { divergingBar, gauge, heading, hr, kv, metricRow, signedPct, sparkline, table } from "./primitives.ts"

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function str(record: Record<string, unknown> | null, ...names: string[]): string | undefined {
  if (!record) return undefined
  for (const name of names) {
    const v = record[name]
    if (typeof v === "string" && v !== "") return v
    if (typeof v === "number") return String(v)
  }
  return undefined
}

function num(record: Record<string, unknown> | null, ...names: string[]): number | undefined {
  if (!record) return undefined
  for (const name of names) {
    const v = record[name]
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return undefined
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function fmtUsd(value: number): string {
  const abs = Math.abs(value)
  const digits = abs >= 1_000_000_000 ? 2 : abs >= 1_000_000 ? 1 : 0
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(digits)}B`
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(digits)}M`
  return `$${value.toLocaleString()}`
}

function numberSeries(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const nums = value
    .map((v) => (typeof v === "number" ? v : typeof v === "object" && v !== null ? Number((v as Record<string, unknown>).value ?? (v as Record<string, unknown>).y ?? NaN) : Number(v)))
    .filter((n) => Number.isFinite(n))
  return nums.length >= 2 ? nums : null
}

function formatSeriesDelta(first: number, last: number) {
  if (first === 0) {
    const delta = last - first
    return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pts`
  }
  const change = ((last - first) / Math.abs(first)) * 100
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`
}

/** A freshness/confidence chip from a maturity-like field. */
function maturityChip(theme: Theme, maturity: string | undefined): string {
  if (!maturity) return ""
  const m = maturity.toLowerCase()
  const role = m === "ga" || m.includes("as-filed") || m === "final" ? "positive" : m.includes("estimate") || m.includes("preview") ? "warning" : "muted"
  return theme.paint(role, `● ${maturity}`)
}

/** Filing card — `secapi filings latest` / `filings search` (single result). */
export function filingCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    // `filings latest` returns the filing object; `search` may wrap it.
    const filing = asRecord(root?.filing) ?? root
    if (!filing) return null
    const form = str(filing, "formType", "form", "form_type")
    const accession = str(filing, "accessionNumber", "accession_number", "accession")
    if (!form && !accession) return null // not a filing shape → defer to JSON

    const ticker = str(filing, "ticker", "symbol") ?? str(root, "ticker", "symbol")
    const company = str(filing, "companyName", "company", "name")
    const filed = str(filing, "filingDate", "filing_date", "filedAt", "accepted_at", "acceptedAt")
    const fiscalYear = str(filing, "fiscalYear", "fiscal_year", "fy")
    const source = str(filing, "sourceUrl", "source_url", "url", "primaryDocumentUrl")
    const trace = str(filing, "traceId", "trace_id") ?? str(root, "traceId", "trace_id")
    const maturity = str(filing, "maturity") ?? str(root, "maturity")

    const lines: string[] = []
    lines.push(heading(theme, `${ticker ?? company ?? "Filing"}${form ? ` · ${form}` : ""}`, company && ticker ? company : undefined))
    lines.push(metricRow(theme, [form ?? "", fiscalYear ? `FY${fiscalYear}` : "", filed ? `filed ${filed}` : "", maturityChip(theme, maturity)].filter(Boolean) as string[]))
    if (accession) lines.push(kv(theme, "Accession", accession))
    if (source) lines.push(kv(theme, "Source", theme.paint("dimmed", source)))
    if (trace) lines.push(kv(theme, "Trace", theme.paint("dimmed", trace)))
    return lines.join("\n")
  }
}

/** Factor sparklines card — `secapi factors sparklines`. */
export function factorSparklinesCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    const items = (Array.isArray(root?.sparklines) && root?.sparklines) || (Array.isArray(root?.data) && root?.data) || (Array.isArray(value) && value)
    if (!Array.isArray(items) || items.length === 0) return null

    const rows: string[][] = []
    for (const raw of items) {
      const item = asRecord(raw)
      if (!item) continue
      const key = str(item, "key", "factorKey", "factor", "name")
      const series = numberSeries(item.points ?? item.series ?? item.values ?? item.spark)
      if (!key || !series) continue
      const last = series[series.length - 1]
      const first = series[0]
      rows.push([key, theme.paint("accent", sparkline(series)), formatSeriesDelta(first, last)])
    }
    if (rows.length === 0) return null

    return [
      heading(theme, "Factor sparklines", `${rows.length} factors`),
      table(theme, [{ header: "FACTOR" }, { header: "SPARK" }, { header: "Δ", align: "right" }], rows),
    ].join("\n")
  }
}

/**
 * Portfolio card — `secapi portfolio analyze` (factor exposures, diverging bars)
 * and `secapi portfolio stress-test` (scenario drawdown + top contributors).
 */
export function portfolioCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root) return null
    const object = str(root, "object")

    if (object === "portfolio_stress_test") {
      const scenario = str(root, "scenarioLabel", "scenarioKey")
      const drawdown = num(root, "estimatedDrawdownPercent")
      const contributions = arr(root.contributions).map(asRecord).filter((c): c is Record<string, unknown> => c !== null)
      const lines: string[] = []
      lines.push(heading(theme, "Portfolio stress test", scenario))
      if (drawdown !== undefined) lines.push(metricRow(theme, [`Est. drawdown ${signedPct(theme, -Math.abs(drawdown))}`]))
      if (contributions.length > 0) {
        const rows = contributions.slice(0, 8).map((c) => {
          const key = str(c, "factorKey") ?? "?"
          const contribution = num(c, "contribution") ?? 0
          const direction = str(c, "direction") ?? ""
          return [key, divergingBar(theme, contribution), direction]
        })
        lines.push(table(theme, [{ header: "FACTOR" }, { header: "CONTRIBUTION" }, { header: "DIR" }], rows))
      }
      return lines.length > 1 ? lines.join("\n") : null
    }

    if (object === "portfolio_analysis" || object === "portfolio_hedge") {
      const exposures = arr(root.exposures).map(asRecord).filter((e): e is Record<string, unknown> => e !== null)
      if (exposures.length === 0) return null
      const rows = exposures.slice(0, 12).map((e) => {
        const key = str(e, "factorKey", "key") ?? "?"
        const beta = num(e, "beta", "exposure") ?? 0
        return [key, divergingBar(theme, beta), beta.toFixed(2)]
      })
      const asOf = str(root, "asOf")
      return [
        heading(theme, object === "portfolio_hedge" ? "Portfolio hedge" : "Portfolio exposures", asOf ? `as of ${asOf}` : undefined),
        table(theme, [{ header: "FACTOR" }, { header: "EXPOSURE" }, { header: "β", align: "right" }], rows),
      ].join("\n")
    }

    return null
  }
}

/** Financials card — `secapi companies financials` (revenue/net income/EPS PoP+YoY). */
export function financialsCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root || str(root, "object") !== "company_financials") return null
    const records = arr(root.data).map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
    if (records.length === 0) return null

    const ticker = str(root, "ticker")
    const company = str(root, "companyName")
    const period = str(root, "period")
    // Income-statement metrics live under `financials.income_statement` (a
    // combined-statement record), not flat on the period row — falls back to a
    // flat lookup for other financials-shaped payloads (e.g. income-statements-only).
    const incomeOf = (r: Record<string, unknown>) => asRecord(asRecord(r.financials)?.income_statement) ?? r
    const rows = records.slice(0, 8).map((r, index) => {
      const label = str(r, "fiscal_year", "fiscalYear") ?? "?"
      const quarter = str(r, "fiscal_period", "fiscalPeriod")
      const income = incomeOf(r)
      const revenue = num(income, "revenue")
      const netIncome = num(income, "netIncome")
      const eps = num(income, "eps")
      const priorRecord = records[index + 1]
      const prior = priorRecord ? num(incomeOf(priorRecord), "revenue") : undefined
      const delta = revenue !== undefined && prior !== undefined && prior !== 0 ? signedPct(theme, ((revenue - prior) / Math.abs(prior)) * 100) : ""
      return [
        quarter ? `${label} ${quarter}` : String(label),
        revenue !== undefined ? fmtUsd(revenue) : "—",
        netIncome !== undefined ? fmtUsd(netIncome) : "—",
        eps !== undefined ? eps.toFixed(2) : "—",
        delta,
      ]
    })
    // If not a single row yielded any real metric, this isn't a shape we
    // understand — defer to JSON rather than rendering an all-dash table.
    if (!rows.some((row) => row[1] !== "—" || row[2] !== "—" || row[3] !== "—")) return null

    return [
      heading(theme, `${ticker ?? company ?? "Financials"}${period ? ` · ${period}` : ""}`, ticker && company ? company : undefined),
      table(theme, [{ header: "PERIOD" }, { header: "REVENUE", align: "right" }, { header: "NET INCOME", align: "right" }, { header: "EPS", align: "right" }, { header: "Δ REV", align: "right" }], rows),
    ].join("\n")
  }
}

/** Search results card — `secapi search fulltext` (filing hits + section excerpts). */
export function searchCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root || str(root, "object") !== "fulltext_search") return null
    const query = str(root, "query")
    const filings = arr(asRecord(root.filings)?.data).map(asRecord).filter((f): f is Record<string, unknown> => f !== null)
    const sections = arr(asRecord(root.sections)?.data).map(asRecord).filter((s): s is Record<string, unknown> => s !== null)
    if (filings.length === 0 && sections.length === 0) return null

    const lines: string[] = [heading(theme, `Search: "${query ?? ""}"`, `${filings.length} filings · ${sections.length} sections`)]
    if (filings.length > 0) {
      const rows = filings.slice(0, 8).map((f, index) => [
        String(index + 1),
        str(f, "ticker", "symbol") ?? "—",
        str(f, "form", "formType") ?? "—",
        str(f, "companyName", "company") ?? "—",
      ])
      lines.push(table(theme, [{ header: "#" }, { header: "TICKER" }, { header: "FORM" }, { header: "COMPANY" }], rows))
    }
    if (sections.length > 0) {
      lines.push(hr(theme))
      for (const section of sections.slice(0, 5)) {
        const title = str(section, "title", "key") ?? "Section"
        const snippet = str(section, "snippet")
        lines.push(kv(theme, title, snippet ? theme.paint("dimmed", snippet) : ""))
      }
    }
    return lines.join("\n")
  }
}

/** Trace / lineage run-view card — `secapi traces get` (provenance chain). */
export function traceCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root || str(root, "object") !== "trace") return null
    const title = str(root, "title")
    const summary = str(root, "summary")
    const status = str(root, "status")
    const kind = str(root, "kind")
    const nodes = arr(root.nodes).map(asRecord).filter((n): n is Record<string, unknown> => n !== null)
    const filing = asRecord(root.filing)

    const lines: string[] = [heading(theme, title ?? "Trace", kind)]
    if (summary) lines.push(kv(theme, "Summary", summary))
    if (status) lines.push(kv(theme, "Status", maturityChip(theme, status) || status))
    if (filing) {
      const accession = str(filing, "accessionNumber")
      const form = str(filing, "form")
      if (accession || form) lines.push(kv(theme, "Filing", [form, accession].filter(Boolean).join(" · ")))
    }
    if (nodes.length > 0) {
      lines.push(hr(theme))
      lines.push(theme.paint("muted", "Lineage:"))
      nodes.forEach((node, index) => {
        const label = str(node, "label") ?? str(node, "kind") ?? "step"
        const nodeValue = str(node, "value")
        const arrow = index === 0 ? "  " : theme.paint("dimmed", "→ ")
        lines.push(`${arrow}${label}${nodeValue ? theme.paint("dimmed", ` (${nodeValue})`) : ""}`)
      })
    }
    return lines.join("\n")
  }
}

/**
 * Citations / "prove it" card — `secapi search semantic` (and `/reconcile` in
 * the REPL). Each hit already carries the OMNI-3083 citation envelope
 * (accession, section_key, source_url, highlighted_snippet) added server-side
 * specifically so a claim can be traced back to the exact filing exhibit that
 * backs it — this card just surfaces those fields instead of burying them in
 * raw JSON.
 */
export function citationsCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root || str(root, "object") !== "semantic_search") return null
    const query = str(root, "query")
    const sections = arr(asRecord(root.sections)?.data).map(asRecord).filter((s): s is Record<string, unknown> => s !== null)
    if (sections.length === 0) return null

    const lines: string[] = [heading(theme, `Reconcile: "${query ?? ""}"`, `${sections.length} citation(s)`)]
    sections.slice(0, 8).forEach((section, index) => {
      const ticker = str(section, "ticker")
      const accession = str(section, "accession")
      const sectionKey = str(section, "section_key", "key")
      const sourceUrl = str(section, "source_url")
      const snippet = str(section, "highlighted_snippet", "snippet")
      lines.push(hr(theme))
      lines.push(kv(theme, `#${index + 1}`, [ticker, accession, sectionKey].filter(Boolean).join(" · ") || "—"))
      if (snippet) lines.push(theme.paint("dimmed", `  "${snippet}"`))
      if (sourceUrl) lines.push(kv(theme, "  Source", sourceUrl))
    })
    return lines.join("\n")
  }
}

/**
 * Dilution-risk score card — `secapi dilution score`. This is also what
 * `dilution score --watch` redraws on every tick (the watch runtime just
 * re-spawns the one-shot command and captures its rich output), so a proper
 * gauge/factor-breakdown card here is what turns that from raw JSON on a
 * timer into an actual live dashboard.
 */
export function dilutionCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root || str(root, "object") !== "dilution_rating") return null
    const ticker = str(root, "ticker")
    const band = str(root, "overallRisk")
    const score = num(root, "numericScore")
    const freshness = asRecord(root.freshness)
    const factors = arr(root.factors).map(asRecord).filter((f): f is Record<string, unknown> => f !== null)

    const bandRole = band === "low" ? "positive" : band === "high" ? "negative" : "warning"
    const subtitle = band ? theme.paint(bandRole, band.toUpperCase()) : undefined
    const lines: string[] = [heading(theme, `${ticker ?? "—"} dilution risk`, subtitle)]
    if (typeof score === "number") lines.push(gauge(theme, "Score", Math.round(score), 100))
    if (root.regsho === true) lines.push(theme.paint("warning", "⚠ Reg SHO threshold list"))
    if (freshness) {
      const status = str(freshness, "status")
      const asOf = str(freshness, "asOf")
      if (status) lines.push(kv(theme, "Freshness", [status, asOf].filter(Boolean).join(" · ")))
    }
    if (factors.length > 0) {
      lines.push(hr(theme))
      lines.push(theme.paint("muted", "Factors:"))
      factors.slice(0, 6).forEach((factor) => {
        const label = str(factor, "label", "key") ?? "factor"
        const factorScore = num(factor, "score")
        lines.push(kv(theme, label, typeof factorScore === "number" ? factorScore.toFixed(2) : "—"))
      })
    }
    return lines.join("\n")
  }
}

/**
 * Monitor(s) card — `secapi monitors list` (a list of `monitor` items) or
 * `secapi monitors get`/`create` (a single `monitor`). Handles both shapes
 * since they share the same per-item renderer.
 */
export function monitorsCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root) return null
    const items = str(root, "object") === "monitor"
      ? [root]
      : str(root, "object") === "list"
        ? arr(root.data).map(asRecord).filter((m): m is Record<string, unknown> => m !== null && str(m, "object") === "monitor")
        : []
    if (items.length === 0) return null

    const lines: string[] = [heading(theme, "Monitors", `${items.length} saved search(es)`)]
    items.slice(0, 10).forEach((monitor, index) => {
      const name = str(monitor, "name") ?? "—"
      const query = str(monitor, "query")
      const isActive = monitor.isActive !== false
      const delivery = asRecord(monitor.delivery)
      const deliveryType = str(delivery, "type")
      lines.push(hr(theme))
      lines.push(kv(theme, `#${index + 1}`, `${name} ${theme.paint(isActive ? "positive" : "dimmed", isActive ? "● active" : "○ paused")}`))
      if (query) lines.push(theme.paint("dimmed", `  "${query}"`))
      if (deliveryType) lines.push(kv(theme, "  Delivery", deliveryType))
    })
    return lines.join("\n")
  }
}

/** News card — `secapi news` (a list of `news_story` items). */
export function newsCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root || str(root, "object") !== "list") return null
    const stories = arr(root.data).map(asRecord).filter((s): s is Record<string, unknown> => s !== null && str(s, "object") === "news_story")
    if (stories.length === 0) return null

    const lines: string[] = [heading(theme, "News", `${stories.length} stor${stories.length === 1 ? "y" : "ies"}`)]
    stories.slice(0, 10).forEach((story) => {
      const headline = str(story, "headline") ?? "—"
      const source = str(story, "sourceName")
      const publishedAt = str(story, "publishedAt")
      const symbols = arr(story.symbols).filter((s): s is string => typeof s === "string")
      lines.push(hr(theme))
      lines.push(kv(theme, symbols.length > 0 ? symbols.join(",") : "—", headline))
      lines.push(theme.paint("dimmed", `  ${[source, publishedAt].filter(Boolean).join(" · ")}`))
    })
    return lines.join("\n")
  }
}

/**
 * Factor dashboard card — `secapi factors dashboard`, the plan's named
 * "flagship" --watch dashboard. Was raw print() until now, so --watch just
 * redrew a JSON blob on a timer; this surfaces the regime-ranked factors,
 * intraday returns, and (if present) a ticker spotlight instead.
 */
export function factorDashboardCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root || str(root, "object") !== "factor_dashboard") return null
    const country = str(root, "country")
    const category = str(root, "category")
    const window = str(root, "window")
    const asOf = str(root, "asOf")
    const regimePerformance = arr(root.regimePerformance).map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
    const intraday = arr(root.intraday).map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
    const spotlightExposures = arr(root.spotlightExposures).map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
    const spotlightSymbol = str(root, "spotlightSymbol")

    const lines: string[] = [
      heading(theme, "Factor Dashboard", [country, category, window].filter(Boolean).join(" · ") || undefined),
    ]
    if (asOf) lines.push(kv(theme, "As of", asOf))

    if (intraday.length > 0) {
      lines.push(hr(theme))
      lines.push(theme.paint("muted", "Intraday:"))
      const rows = intraday.slice(0, 8).map((row) => {
        const key = str(row, "factorKey") ?? "—"
        const pureReturn = num(row, "pureReturn", "rawReturn")
        return [key, typeof pureReturn === "number" ? signedPct(theme, pureReturn * 100) : "—"]
      })
      lines.push(table(theme, [{ header: "FACTOR" }, { header: "RETURN" }], rows))
    }

    if (regimePerformance.length > 0) {
      lines.push(hr(theme))
      lines.push(theme.paint("muted", "Regime-ranked factors:"))
      const rows = regimePerformance.slice(0, 8).map((row) => {
        const key = str(row, "factorKey") ?? "—"
        const direction = str(row, "direction") ?? "—"
        const zScore = num(row, "zScore")
        const directionRole = direction === "tailwind" ? "positive" : direction === "headwind" ? "negative" : "muted"
        return [key, theme.paint(directionRole, direction), typeof zScore === "number" ? zScore.toFixed(2) : "—"]
      })
      lines.push(table(theme, [{ header: "FACTOR" }, { header: "REGIME" }, { header: "Z" }], rows))
    }

    if (spotlightSymbol && spotlightExposures.length > 0) {
      lines.push(hr(theme))
      lines.push(theme.paint("muted", `Spotlight: ${spotlightSymbol}`))
      spotlightExposures.slice(0, 6).forEach((exposure) => {
        const key = str(exposure, "factorKey") ?? "—"
        // factor_exposure rows (getFactorExposures()) expose the loading as
        // `beta`, not `zScore`/`exposure` (Codex review, PR #1206).
        const beta = num(exposure, "beta")
        lines.push(typeof beta === "number" ? `  ${divergingBar(theme, beta / 3)} ${key}` : kv(theme, key, "—"))
      })
    }

    // A partial/degraded dashboard can have empty intraday/regimePerformance
    // while still carrying a populated ticker spotlight (Codex review, PR
    // #1206) — only fall back to JSON when there is truly nothing to show.
    if (intraday.length === 0 && regimePerformance.length === 0 && spotlightExposures.length === 0) return null
    return lines.join("\n")
  }
}

/** Factor extreme-moves card — `secapi factors extreme-moves` (a list of `factor_extreme_move` items). */
export function extremeMovesCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root || str(root, "object") !== "list") return null
    const moves = arr(root.data).map(asRecord).filter((m): m is Record<string, unknown> => m !== null && str(m, "object") === "factor_extreme_move")
    if (moves.length === 0) return null

    const lines: string[] = [heading(theme, "Extreme Factor Moves", `${moves.length} move(s)`)]
    const rows = moves.slice(0, 12).map((move) => {
      const key = str(move, "factorKey") ?? "—"
      const direction = str(move, "direction") ?? "—"
      const zScore = num(move, "absZScore")
      const scaledReturn = num(move, "pureReturn", "rawReturn")
      const directionRole = direction === "up" ? "positive" : direction === "down" ? "negative" : "muted"
      return [
        key,
        theme.paint(directionRole, direction),
        typeof scaledReturn === "number" ? signedPct(theme, scaledReturn * 100) : "—",
        typeof zScore === "number" ? zScore.toFixed(2) : "—",
      ]
    })
    lines.push(table(theme, [{ header: "FACTOR" }, { header: "DIR" }, { header: "RETURN" }, { header: "|Z|" }], rows))
    return lines.join("\n")
  }
}

/** Macro regime card — `secapi macro regimes` (a list wrapping a single regime-state object). */
export function macroRegimeCard(theme: Theme): CardRenderer {
  return (value) => {
    const root = asRecord(value)
    if (!root || str(root, "object") !== "list") return null
    const items = arr(root.data).map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
    const regime = items.find((item) => typeof item.key === "string" && typeof item.label === "string")
    if (!regime) return null

    const confidence = str(regime, "confidence")
    const confidenceRole = confidence === "high" ? "positive" : confidence === "low" ? "warning" : "muted"
    const subtitle = confidence ? theme.paint(confidenceRole, `${confidence} confidence`) : undefined
    const lines: string[] = [heading(theme, str(regime, "label") ?? "Macro Regime", subtitle)]

    const drivers = arr(regime.drivers).map(asRecord).filter((d): d is Record<string, unknown> => d !== null)
    if (drivers.length > 0) {
      lines.push(hr(theme))
      lines.push(theme.paint("muted", "Drivers:"))
      drivers.slice(0, 6).forEach((driver) => {
        const label = str(driver, "label") ?? "driver"
        const explanation = str(driver, "explanation")
        lines.push(kv(theme, label, explanation ?? "—"))
      })
    }

    const factorImpacts = arr(regime.factorImpacts).map(asRecord).filter((f): f is Record<string, unknown> => f !== null)
    if (factorImpacts.length > 0) {
      lines.push(hr(theme))
      lines.push(theme.paint("muted", "Factor impacts:"))
      const rows = factorImpacts.slice(0, 8).map((impact) => {
        const key = str(impact, "factorKey") ?? "—"
        const direction = str(impact, "direction") ?? "—"
        const directionRole = direction === "tailwind" ? "positive" : direction === "headwind" ? "negative" : "muted"
        return [key, theme.paint(directionRole, direction)]
      })
      lines.push(table(theme, [{ header: "FACTOR" }, { header: "IMPACT" }], rows))
    }
    return lines.join("\n")
  }
}

/**
 * Format one `secapi streams watch` WS event as a single styled line (the
 * "streaming caret" from the plan). Not a resource() card — a live push
 * stream emits many lines over time rather than one resource at the end —
 * so this is a plain exported formatter the streams-watch handler calls
 * per event, TTY only; non-TTY emits raw NDJSON of the same event instead.
 */
export function formatFilingStreamEvent(theme: Theme, event: Record<string, unknown>): string {
  const kind = str(event, "event")
  if (kind === "filing.published") {
    const filing = asRecord(event.filing)
    const ticker = str(filing, "ticker") ?? "—"
    const form = str(filing, "form") ?? "—"
    const accession = str(filing, "accessionNumber") ?? "—"
    const deliveredAt = str(event, "deliveredAt")
    const caret = theme.paint("accent", "▏")
    return `${caret} ${theme.paint("heading", ticker)} ${theme.paint("muted", "·")} ${form} ${theme.paint("muted", "·")} ${accession}${deliveredAt ? theme.paint("dimmed", ` · ${deliveredAt}`) : ""}`
  }
  if (kind === "connected") {
    const filters = asRecord(event.filters)
    const forms = Array.isArray(filters?.forms) ? filters.forms.join(",") : ""
    const tickers = Array.isArray(filters?.tickers) ? filters.tickers.join(",") : ""
    const scope = forms || tickers ? ` — forms:${forms || "*"} tickers:${tickers || "*"}` : ""
    return theme.paint("positive", `● connected${scope}`)
  }
  if (kind === "rate_limited") {
    return theme.paint("warning", `⚠ ${str(event, "message") ?? "rate limited"}`)
  }
  return theme.paint("dimmed", JSON.stringify(event))
}

export function buildCards(theme: Theme): Partial<Record<RenderHint, CardRenderer>> {
  return {
    filing: filingCard(theme),
    factors: factorSparklinesCard(theme),
    portfolio: portfolioCard(theme),
    financials: financialsCard(theme),
    search: searchCard(theme),
    trace: traceCard(theme),
    citations: citationsCard(theme),
    dilution: dilutionCard(theme),
    monitors: monitorsCard(theme),
    news: newsCard(theme),
    factorDashboard: factorDashboardCard(theme),
    extremeMoves: extremeMovesCard(theme),
    macroRegime: macroRegimeCard(theme),
  }
}
