// Rich resource cards (TTY-only). Each card reads the API value DEFENSIVELY and
// returns null when the shape isn't what it expects, so the renderer falls back
// to byte-identical JSON — a card can never produce broken output. Cards are
// bound to the active Theme and registered by hint in index.ts.

import type { CardRenderer, RenderHint } from "./renderer.ts"
import type { Theme } from "../theme/theme.ts"
import { heading, kv, metricRow, sparkline, table } from "./primitives.ts"

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

export function buildCards(theme: Theme): Partial<Record<RenderHint, CardRenderer>> {
  return {
    filing: filingCard(theme),
    factors: factorSparklinesCard(theme),
  }
}
