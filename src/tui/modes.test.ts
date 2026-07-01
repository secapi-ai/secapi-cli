import { describe, expect, test } from "bun:test"
import { MODES, modeIndicator, modeMeta, nextMode } from "./modes.ts"

describe("modes", () => {
  test("cycles run → plan → ask → run", () => {
    expect(nextMode("run")).toBe("plan")
    expect(nextMode("plan")).toBe("ask")
    expect(nextMode("ask")).toBe("run")
  })

  test("modeMeta returns metadata with a theme color role", () => {
    expect(modeMeta("plan").label).toBe("Plan")
    expect(modeMeta("plan").color).toBe("warning")
    expect(modeMeta("ask").color).toBe("positive")
    expect(modeMeta("run").color).toBe("accent")
  })

  test("modeIndicator is empty for the default run mode, ⏵⏵ otherwise", () => {
    expect(modeIndicator("run")).toBe("")
    expect(modeIndicator("plan")).toBe("⏵⏵")
    expect(modeIndicator("ask")).toBe("⏵⏵")
  })

  test("there are exactly three modes", () => {
    expect(MODES.map((m) => m.key)).toEqual(["run", "plan", "ask"])
  })
})
