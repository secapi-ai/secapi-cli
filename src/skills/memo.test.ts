import { describe, expect, test } from "bun:test"
import { findSkillShortcut } from "./catalog.ts"
import { buildDdMemo } from "./memo.ts"

describe("buildDdMemo", () => {
  const shortcut = findSkillShortcut("due-diligence")!

  test("assembles a titled Markdown memo with one section per step", () => {
    const memo = buildDdMemo(shortcut, "AAPL", [
      { label: "Resolve entity", command: "secapi entities resolve --ticker AAPL", metered: false, stdout: '{"ticker":"AAPL"}', stderr: "", ok: true },
      { label: "Synthesize (AI)", command: "secapi intelligence company --ticker AAPL --view compact", metered: true, stdout: '{"summary":"..."}', stderr: "", ok: true },
    ])
    expect(memo).toContain("# Company due diligence: AAPL")
    expect(memo).toContain("## Resolve entity")
    expect(memo).toContain('{"ticker":"AAPL"}')
    expect(memo).toContain("## Synthesize (AI) 💲")
    expect(memo).toContain("2 step(s), 0 failed")
  })

  test("surfaces a failed step's stderr instead of its (empty) stdout", () => {
    const memo = buildDdMemo(shortcut, "AAPL", [
      { label: "Company filings", command: "secapi filings latest --ticker AAPL", metered: false, stdout: "", stderr: "network error", ok: false },
    ])
    expect(memo).toContain("_Failed: network error_")
    expect(memo).toContain("1 step(s), 1 failed")
  })

  test("marks an ok step with empty output as (no output) rather than an empty code block", () => {
    const memo = buildDdMemo(shortcut, "AAPL", [
      { label: "Insider activity", command: "secapi insiders list --ticker AAPL", metered: false, stdout: "   ", stderr: "", ok: true },
    ])
    expect(memo).toContain("_(no output)_")
  })
})
