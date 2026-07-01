import { describe, expect, test } from "bun:test"
import { decideWatch, defaultIntervalMs, isWatchable, resolveIntervalMs } from "./watch.ts"

describe("watch policy", () => {
  test("isWatchable covers the live-dashboard commands", () => {
    expect(isWatchable("factors dashboard")).toBe(true)
    expect(isWatchable("macro regimes")).toBe(true)
    expect(isWatchable("dilution score")).toBe(true)
    expect(isWatchable("filings latest")).toBe(false)
  })

  test("per-domain default intervals (factors fast, macro slow)", () => {
    expect(defaultIntervalMs("factors dashboard")).toBe(10_000)
    expect(defaultIntervalMs("dilution score")).toBe(60_000)
    expect(defaultIntervalMs("macro regimes")).toBe(600_000)
    expect(defaultIntervalMs("something else")).toBe(15_000)
  })

  test("resolveIntervalMs uses the flag (clamped) or the domain default", () => {
    expect(resolveIntervalMs("macro regimes", undefined)).toBe(600_000)
    expect(resolveIntervalMs("factors dashboard", 30)).toBe(30_000)
    expect(resolveIntervalMs("factors dashboard", 0.5)).toBe(2_000) // clamped up
    expect(resolveIntervalMs("factors dashboard", 99_999)).toBe(3_600_000) // clamped down
  })

  test("decideWatch: live only on TTY + --watch + not --once + not --json", () => {
    expect(decideWatch({ watchFlag: true, onceFlag: false, isTty: true, jsonFlag: undefined })).toEqual({ watch: true, singleShot: false })
    expect(decideWatch({ watchFlag: true, onceFlag: true, isTty: true, jsonFlag: undefined }).watch).toBe(false) // --once
    expect(decideWatch({ watchFlag: true, onceFlag: false, isTty: false, jsonFlag: undefined }).watch).toBe(false) // piped
    expect(decideWatch({ watchFlag: true, onceFlag: false, isTty: true, jsonFlag: true }).watch).toBe(false) // --json
    expect(decideWatch({ watchFlag: false, onceFlag: false, isTty: true, jsonFlag: undefined }).watch).toBe(false) // no --watch
    expect(decideWatch({ watchFlag: true, onceFlag: false, isTty: true, jsonFlag: undefined, hasOutputPath: true }).watch).toBe(false) // --output forces single-shot
  })

  test("singleShot is the complement of watch", () => {
    expect(decideWatch({ watchFlag: false, onceFlag: false, isTty: false, jsonFlag: undefined }).singleShot).toBe(true)
  })
})
