import { describe, expect, test } from "bun:test"
import { createTheme } from "../theme/theme.ts"
import { factorSparklinesCard, filingCard } from "./cards.ts"

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
