// Pure string primitives for the rich (TTY-only) renderer — tables, key/value
// rows, sparklines, bars, gauges, the ◆ action ledger, and minimal meters.
//
// xAI/Grok/X visual language: stark monochrome + one accent, hairline rules and
// a left rail instead of heavy boxes, "instrument-readout" mono labels, and
// no-bar meters. All functions take a Theme and return strings (no I/O), so
// they are unit-testable and never touch a pipe.

import type { Theme, ThemeRole } from "../theme/theme.ts"

const SPARK_TICKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const
const BAR_FULL = "█"
const BAR_PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const

/** Visible width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").length
}

function padEndVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text)
  return pad > 0 ? text + " ".repeat(pad) : text
}

function padStartVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text)
  return pad > 0 ? " ".repeat(pad) + text : text
}

/** A unicode sparkline from a numeric series (min→max mapped across 8 ticks). */
export function sparkline(values: number[]): string {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return ""
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  const span = max - min
  return values
    .map((v) => {
      if (!Number.isFinite(v)) return " "
      if (span === 0) return SPARK_TICKS[0]
      const idx = Math.round(((v - min) / span) * (SPARK_TICKS.length - 1))
      return SPARK_TICKS[Math.max(0, Math.min(SPARK_TICKS.length - 1, idx))]
    })
    .join("")
}

/** A fractional horizontal bar of `width` cells for ratio in [0,1]. */
export function bar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const cells = clamped * width
  const full = Math.floor(cells)
  const partialIdx = Math.min(BAR_PARTIALS.length - 1, Math.round((cells - full) * 8))
  let out = BAR_FULL.repeat(full)
  if (partialIdx > 0 && full < width) out += BAR_PARTIALS[partialIdx]
  return padEndVisible(out, width)
}

/** A labeled gauge line: "label  ▓▓▓░░  used / total". */
export function gauge(theme: Theme, label: string, used: number, total: number, width = 10): string {
  const ratio = total > 0 ? used / total : 0
  const filled = theme.paint(ratio >= 0.8 ? "warning" : "accent", bar(ratio, width))
  return `${padEndVisible(label, 14)} ${filled}  ${used} / ${total}`
}

/** A diverging bar centered on zero for value in [-1,1] across `half` cells/side. */
export function divergingBar(theme: Theme, value: number, half = 6): string {
  const v = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0))
  const cells = Math.round(Math.abs(v) * half)
  if (v >= 0) {
    return `${" ".repeat(half)}│${theme.paint("positive", "█".repeat(cells))}${" ".repeat(half - cells)}`
  }
  return `${" ".repeat(half - cells)}${theme.paint("negative", "█".repeat(cells))}│${" ".repeat(half)}`
}

/** A "key: value" line with a muted, fixed-width label. */
export function kv(theme: Theme, label: string, value: string, labelWidth = 12): string {
  return `  ${theme.paint("muted", padEndVisible(`${label}`, labelWidth))} ${value}`
}

/** An ◆ action-ledger line: "◆ <id> <status> — <label>" colored by status. */
export function ledgerLine(
  theme: Theme,
  id: string,
  status: "running" | "done" | "error",
  label: string,
): string {
  const role: ThemeRole = status === "done" ? "positive" : status === "error" ? "negative" : "accent"
  const diamond = theme.paint(role, "◆")
  return `${diamond} ${theme.paint("muted", id)} ${theme.paint(role, status)} ${theme.paint("muted", "—")} ${label}`
}

/** A minimal top-right meter, no progress bar: "◷ 318 calls · $4.21". */
export function meter(theme: Theme, parts: string[]): string {
  return theme.paint("muted", `◷ ${parts.join(" · ")}`)
}

/** A compact X-style metric row: "AAPL · 10-K · FY2025 · filed 2026-11-01". */
export function metricRow(theme: Theme, cells: string[]): string {
  return cells.filter((c) => c !== "").map((c, i) => (i === 0 ? theme.paint("heading", c) : c)).join(theme.paint("dimmed", " · "))
}

/** A hairline rule of `width` cells. */
export function hr(theme: Theme, width = 48): string {
  return theme.paint("border", "─".repeat(width))
}

export interface Column {
  header: string
  align?: "left" | "right"
}

/** A simple aligned table with a muted header row (ANSI-width aware). */
export function table(theme: Theme, columns: Column[], rows: string[][]): string {
  const widths = columns.map((col, i) =>
    Math.max(visibleWidth(col.header), ...rows.map((r) => visibleWidth(r[i] ?? ""))),
  )
  const fmt = (cells: string[], paintHeader: boolean) =>
    cells
      .map((cell, i) => {
        const w = widths[i]
        const aligned = columns[i]?.align === "right" ? padStartVisible(cell, w) : padEndVisible(cell, w)
        return paintHeader ? theme.paint("muted", aligned) : aligned
      })
      .join("  ")
  return [fmt(columns.map((c) => c.header), true), ...rows.map((r) => fmt(r, false))].join("\n")
}

/** A heading line with the brand mark + accent title + dim subtitle. */
export function heading(theme: Theme, title: string, subtitle?: string): string {
  const head = `${theme.paint("accent", "◈")} ${theme.bold}${theme.paint("heading", title)}${theme.reset}`
  return subtitle ? `${head}  ${theme.paint("dimmed", subtitle)}` : head
}

/** Format a signed percentage with an arrow + semantic color. */
export function signedPct(theme: Theme, value: number, digits = 1): string {
  if (!Number.isFinite(value)) return theme.paint("dimmed", "—")
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "·"
  const role: ThemeRole = value > 0 ? "positive" : value < 0 ? "negative" : "muted"
  const sign = value > 0 ? "+" : ""
  return theme.paint(role, `${sign}${value.toFixed(digits)}% ${arrow}`)
}
