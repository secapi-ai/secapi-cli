import { describe, expect, test } from "bun:test"
import {
  expandBangCommand,
  expandMentionShorthand,
  isHelpAlias,
  LOOKUP_KEYS,
  matchLookupKeys,
  parseLookupQuery,
  parsePinContext,
} from "./affordances.ts"

describe("expandBangCommand", () => {
  test("extracts the shell command after !", () => {
    expect(expandBangCommand("!ls -la")).toBe("ls -la")
    expect(expandBangCommand("  !echo hi  ")).toBe("echo hi")
  })
  test("returns null for a bare ! or non-bang input", () => {
    expect(expandBangCommand("!")).toBeNull()
    expect(expandBangCommand("   !   ")).toBeNull()
    expect(expandBangCommand("filings latest")).toBeNull()
  })
})

describe("parsePinContext", () => {
  test("pins a note", () => {
    expect(parsePinContext("#focus on AAPL 10-K")).toEqual({ note: "focus on AAPL 10-K" })
  })
  test("a bare # clears the pin", () => {
    expect(parsePinContext("#")).toEqual({ clear: true })
    expect(parsePinContext("   #   ")).toEqual({ clear: true })
  })
  test("returns undefined for non-pin input", () => {
    expect(parsePinContext("filings latest")).toBeUndefined()
  })
})

describe("expandMentionShorthand", () => {
  test("expands a whole-input @ticker into entities resolve", () => {
    expect(expandMentionShorthand("@AAPL")).toBe("entities resolve --ticker AAPL")
    expect(expandMentionShorthand("@aapl")).toBe("entities resolve --ticker AAPL")
    expect(expandMentionShorthand("  @brk.b  ")).toBe("entities resolve --ticker BRK.B")
  })
  test("does not expand @ mentions embedded in a longer line", () => {
    expect(expandMentionShorthand("tell me about @AAPL please")).toBeNull()
  })
  test("returns null for non-mention input", () => {
    expect(expandMentionShorthand("filings latest")).toBeNull()
  })
})

describe("matchLookupKeys / parseLookupQuery", () => {
  test("prefix-matches known factor/form/section keys case-insensitively", () => {
    expect(matchLookupKeys("val")).toContain("VALUE")
    expect(matchLookupKeys("10-")).toEqual(expect.arrayContaining(["10-K", "10-Q"]))
    expect(matchLookupKeys("item_7")).toEqual(expect.arrayContaining(["item_7", "item_7a"]))
  })
  test("empty prefix returns the full cheatsheet", () => {
    expect(matchLookupKeys("")).toEqual([...LOOKUP_KEYS])
  })
  test("parseLookupQuery reads a : line", () => {
    expect(parseLookupQuery(":value")).toContain("VALUE")
    expect(parseLookupQuery("filings latest")).toBeNull()
  })
})

describe("isHelpAlias", () => {
  test("a bare ? is a help alias", () => {
    expect(isHelpAlias("?")).toBe(true)
    expect(isHelpAlias("  ?  ")).toBe(true)
  })
  test("? embedded in a longer line is not an alias", () => {
    expect(isHelpAlias("what is this?")).toBe(false)
  })
})
