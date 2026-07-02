import { describe, expect, test } from "bun:test"
import { isSlash, matchSlashCommands, parseSlash, SLASH_COMMANDS } from "./slash.ts"

describe("slash parsing", () => {
  test("isSlash detects a leading slash (after trim)", () => {
    expect(isSlash("/help")).toBe(true)
    expect(isSlash("  /quit")).toBe(true)
    expect(isSlash("filings latest")).toBe(false)
  })

  test("parseSlash splits name + args", () => {
    expect(parseSlash("/theme xai")).toEqual({ name: "theme", args: ["xai"] })
    expect(parseSlash("/help")).toEqual({ name: "help", args: [] })
    expect(parseSlash("  /mode  ")).toEqual({ name: "mode", args: [] })
  })

  test("parseSlash returns null for non-slash input", () => {
    expect(parseSlash("filings latest")).toBeNull()
  })

  test("matchSlashCommands prefix-filters", () => {
    expect(matchSlashCommands("q").map((c) => c.name)).toEqual(["quit"])
    expect(matchSlashCommands("").length).toBe(SLASH_COMMANDS.length)
  })

  test("trace and reconcile are registered (Phase 8: lineage + prove-it citation)", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("trace")
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("reconcile")
  })

  test("monitor and news are registered (Phase 10: saved searches + news)", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("monitor")
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("news")
  })

  test("layouts, remember, and memories are registered (Phase 12: layouts + session memory)", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("layouts")
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("remember")
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("memories")
  })

  test("budget is registered (plan's slash catalog: budget awareness)", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("budget")
  })
})
