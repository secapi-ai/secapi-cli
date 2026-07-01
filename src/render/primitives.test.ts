import { describe, expect, test } from "bun:test"
import { createTheme } from "../theme/theme.ts"
import { bar, divergingBar, gauge, ledgerLine, meter, metricRow, signedPct, sparkline, table, visibleWidth } from "./primitives.ts"

// "none" support → paint is identity, codes empty → deterministic plain output.
const plain = createTheme({ name: "terminal", support: "none" })

describe("sparkline", () => {
  test("maps a series across 8 ticks", () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe("▁▂▃▄▅▆▇█")
  })
  test("flat series → lowest tick", () => {
    expect(sparkline([5, 5, 5])).toBe("▁▁▁")
  })
  test("empty → empty", () => {
    expect(sparkline([])).toBe("")
  })
})

describe("bar", () => {
  test("full and empty", () => {
    expect(bar(1, 4)).toBe("████")
    expect(bar(0, 4)).toBe("    ")
  })
  test("clamps out-of-range", () => {
    expect(visibleWidth(bar(2, 5))).toBe(5)
    expect(visibleWidth(bar(-1, 5))).toBe(5)
  })
  test("rounds near-full partial cells without leaking undefined", () => {
    const rendered = bar(0.249, 4)
    expect(rendered).not.toContain("undefined")
    expect(visibleWidth(rendered)).toBe(4)
  })
})

describe("gauge / divergingBar", () => {
  test("gauge shows used/total", () => {
    expect(gauge(plain, "Free grant", 512, 1000, 10)).toContain("512 / 1000")
  })
  test("divergingBar centers on a pipe", () => {
    expect(divergingBar(plain, 0.5, 4)).toContain("│")
    expect(divergingBar(plain, -0.5, 4)).toContain("│")
  })
})

describe("ledgerLine", () => {
  test("renders ◆ id status — label", () => {
    expect(ledgerLine(plain, "q1", "done", "filings.latest AAPL")).toBe("◆ q1 done — filings.latest AAPL")
  })
})

describe("meter / metricRow", () => {
  test("meter joins parts with the clock glyph", () => {
    expect(meter(plain, ["318 calls", "$4.21"])).toBe("◷ 318 calls · $4.21")
  })
  test("metricRow joins cells with middots", () => {
    expect(metricRow(plain, ["AAPL", "10-K", "FY2025"])).toBe("AAPL · 10-K · FY2025")
  })
})

describe("table", () => {
  test("aligns columns under headers", () => {
    const out = table(plain, [{ header: "A" }, { header: "B", align: "right" }], [["xx", "1"], ["y", "22"]])
    const lines = out.split("\n")
    // col A width 2 (from "xx"), col B width 2 (from "22"), right-aligned header.
    expect(lines[0]).toBe("A    B")
    expect(lines[1]).toBe("xx   1")
    expect(lines).toHaveLength(3)
  })
})

describe("signedPct", () => {
  test("positive gets +, ▲", () => {
    expect(signedPct(plain, 2.34)).toBe("+2.3% ▲")
  })
  test("negative gets ▼", () => {
    expect(signedPct(plain, -1.2)).toBe("-1.2% ▼")
  })
  test("non-finite → dash", () => {
    expect(signedPct(plain, Number.NaN)).toBe("—")
  })
})
