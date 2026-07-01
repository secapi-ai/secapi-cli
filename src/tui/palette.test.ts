import { describe, expect, test } from "bun:test"
import { buildRegistry, type CommandSpec } from "../registry/registry.ts"
import { buildPaletteEntries, filterPalette } from "./palette.ts"

function spec(key: string, extra: Partial<CommandSpec> = {}): CommandSpec {
  const group = key.includes(" ") ? key.slice(0, key.indexOf(" ")) : "root"
  return { key, group, command: `secapi ${key}`, usage: `secapi ${key}`, auth: "api_key", mutates: false, output: "json", requiredFlags: [], examples: [], ...extra }
}

const registry = buildRegistry([
  spec("filings latest"),
  spec("factors catalog"),
  spec("api-keys create", { mutates: true }),
  spec("intelligence company"),
])

describe("buildPaletteEntries", () => {
  test("includes slash commands and every registry command", () => {
    const entries = buildPaletteEntries(registry)
    expect(entries.some((e) => e.kind === "slash" && e.label === "/help")).toBe(true)
    expect(entries.some((e) => e.kind === "command" && e.label === "filings latest")).toBe(true)
  })
  test("flags mutating + metered commands", () => {
    const entries = buildPaletteEntries(registry)
    expect(entries.find((e) => e.label === "api-keys create")?.mutates).toBe(true)
    expect(entries.find((e) => e.label === "intelligence company")?.metered).toBe(true)
  })
})

describe("filterPalette", () => {
  const entries = buildPaletteEntries(registry)

  test("a leading / restricts to slash commands", () => {
    const results = filterPalette(entries, "/")
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((e) => e.kind === "slash")).toBe(true)
  })

  test("fuzzy-matches command keys", () => {
    const results = filterPalette(entries, "filat")
    expect(results[0]?.label).toBe("filings latest")
  })

  test("empty query returns a capped pool", () => {
    expect(filterPalette(entries, "", 3).length).toBe(3)
  })

  test("/h ranks /help first", () => {
    expect(filterPalette(entries, "/h")[0]?.label).toBe("/help")
  })

  test("impossible query returns nothing", () => {
    expect(filterPalette(entries, "zzqzq")).toEqual([])
  })
})
