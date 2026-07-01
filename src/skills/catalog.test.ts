import { describe, expect, test } from "bun:test"
import { expandSkill, fillStepCommand, findSkillShortcut, SKILL_SHORTCUTS, skillIsMetered } from "./catalog.ts"

const INVALID_RECIPE_PATTERNS = [
  /companies overview\b/,
  /owners (?:compare-)?13f .*--ticker\b/,
  /--ticker\b.*--form 13F-HR\b/i,
  /^secapi intelligence company --view compact$/,
]

describe("skill catalog", () => {
  test("has all 9 skill shortcuts with unique slashes", () => {
    expect(SKILL_SHORTCUTS).toHaveLength(9)
    expect(new Set(SKILL_SHORTCUTS.map((s) => s.slash)).size).toBe(9)
  })

  test("every shortcut maps to a real skill dir and has steps", () => {
    for (const s of SKILL_SHORTCUTS) {
      expect(s.skill).toMatch(/^[a-z0-9-]+$/)
      expect(s.steps.length).toBeGreaterThan(0)
    }
  })

  test("findSkillShortcut resolves by slash", () => {
    expect(findSkillShortcut("due-diligence")?.title).toBe("Company due diligence")
    expect(findSkillShortcut("nope")).toBeUndefined()
  })

  test("skillIsMetered flags workflows with AI steps", () => {
    expect(skillIsMetered(findSkillShortcut("due-diligence")!)).toBe(true) // has intelligence step
    expect(skillIsMetered(findSkillShortcut("track-insiders")!)).toBe(false) // deterministic only
  })

  test("fillStepCommand substitutes ticker/country/holdings", () => {
    expect(fillStepCommand("companies overview --ticker {ticker}", "AAPL")).toBe("companies overview --ticker AAPL")
    expect(fillStepCommand("macro regimes --country {country}", "US")).toBe("macro regimes --country US")
  })

  test("expandSkill produces arg-filled `secapi` commands", () => {
    const steps = expandSkill(findSkillShortcut("due-diligence")!, "AAPL")
    expect(steps[0].command).toBe("secapi entities resolve --ticker AAPL")
    expect(steps.every((s) => s.command.startsWith("secapi "))).toBe(true)
    expect(steps.some((s) => s.metered)).toBe(true)
  })

  test("none-arg workflows ignore the arg", () => {
    const steps = expandSkill(findSkillShortcut("factor-dashboard")!, "")
    expect(steps[0].command).toContain("factors dashboard")
  })

  test("expanded shortcuts avoid known invalid required-flag recipes", () => {
    for (const shortcut of SKILL_SHORTCUTS) {
      const arg = shortcut.arg === "country" ? "US" : shortcut.arg === "holdings" ? "/tmp/holdings.json" : shortcut.arg === "ticker" ? "AAPL" : ""
      for (const step of expandSkill(shortcut, arg)) {
        for (const pattern of INVALID_RECIPE_PATTERNS) {
          expect(step.command).not.toMatch(pattern)
        }
      }
    }
  })

  test("ticker shortcuts do not promise 13F workflows", () => {
    for (const shortcut of SKILL_SHORTCUTS.filter((s) => s.arg === "ticker")) {
      const userFacingRecipe = [shortcut.title, shortcut.summary, ...shortcut.steps.flatMap((step) => [step.label, step.command])].join(" ")
      expect(userFacingRecipe).not.toMatch(/\b13F/i)
    }
  })
})
