import { describe, expect, test } from "bun:test"
import { colorCode, createTheme, detectColorSupport, parseHexColor, resolveThemeName } from "./theme.ts"

describe("detectColorSupport", () => {
  test("NO_COLOR is absolute — wins even over FORCE_COLOR", () => {
    expect(detectColorSupport({ NO_COLOR: "1", FORCE_COLOR: "3" }, true)).toBe("none")
    expect(detectColorSupport({ NO_COLOR: "" }, true)).toBe("none")
  })

  test("non-TTY without FORCE_COLOR is none (pipe-safe)", () => {
    expect(detectColorSupport({}, false)).toBe("none")
  })

  test("FORCE_COLOR forces color even when not a TTY", () => {
    expect(detectColorSupport({ FORCE_COLOR: "1" }, false)).toBe("ansi16")
    expect(detectColorSupport({ FORCE_COLOR: "2" }, false)).toBe("ansi256")
    expect(detectColorSupport({ FORCE_COLOR: "3" }, false)).toBe("truecolor")
  })

  test("COLORTERM=truecolor on a TTY yields truecolor", () => {
    expect(detectColorSupport({ COLORTERM: "truecolor" }, true)).toBe("truecolor")
    expect(detectColorSupport({ COLORTERM: "24bit" }, true)).toBe("truecolor")
  })

  test("TERM with 256 yields ansi256; plain TTY yields ansi16", () => {
    expect(detectColorSupport({ TERM: "xterm-256color" }, true)).toBe("ansi256")
    expect(detectColorSupport({ TERM: "xterm" }, true)).toBe("ansi16")
  })

  test("TERM=dumb is none unless forced", () => {
    expect(detectColorSupport({ TERM: "dumb" }, true)).toBe("none")
    expect(detectColorSupport({ TERM: "dumb", FORCE_COLOR: "1" }, false)).toBe("ansi16")
  })
})

describe("colorCode", () => {
  test("none yields empty string", () => {
    expect(colorCode([255, 99, 8], "none")).toBe("")
  })
  test("truecolor yields 38;2;r;g;b", () => {
    expect(colorCode([255, 99, 8], "truecolor")).toBe("\x1b[38;2;255;99;8m")
  })
  test("ansi256 yields a 38;5;N code", () => {
    expect(colorCode([255, 99, 8], "ansi256")).toMatch(/^\x1b\[38;5;\d+m$/)
  })
  test("ansi16 yields a base SGR code", () => {
    expect(colorCode([0, 170, 0], "ansi16")).toMatch(/^\x1b\[\d+m$/)
  })
})

describe("createTheme", () => {
  test("support 'none' makes every code empty and paint() an identity", () => {
    const t = createTheme({ name: "terminal", support: "none" })
    expect([t.bold, t.dim, t.reset, t.accent, t.heading, t.positive, t.negative]).toEqual(["", "", "", "", "", "", ""])
    expect(t.paint("accent", "x")).toBe("x")
  })

  test("truecolor terminal theme produces a teal accent and SGR attrs", () => {
    const t = createTheme({ name: "terminal", support: "truecolor" })
    expect(t.accent).toBe("\x1b[38;2;56;189;211m")
    expect(t.bold).toBe("\x1b[1m")
    expect(t.reset).toBe("\x1b[0m")
    expect(t.paint("accent", "AAPL")).toBe("\x1b[38;2;56;189;211mAAPL\x1b[0m")
  })

  test("xai theme uses Blaze Orange as the accent", () => {
    expect(createTheme({ name: "xai", support: "truecolor" }).accent).toBe("\x1b[38;2;255;99;8m")
  })

  test("accent override replaces the palette accent", () => {
    const t = createTheme({ name: "terminal", support: "truecolor", accent: [1, 2, 3] })
    expect(t.accent).toBe("\x1b[38;2;1;2;3m")
  })
})

describe("parseHexColor", () => {
  test("parses #rrggbb and rrggbb", () => {
    expect(parseHexColor("#ff6308")).toEqual([255, 99, 8])
    expect(parseHexColor("38bdd3")).toEqual([56, 189, 211])
  })
  test("rejects invalid hex", () => {
    expect(parseHexColor("")).toBeNull()
    expect(parseHexColor("#xyz")).toBeNull()
    expect(parseHexColor("#fff")).toBeNull()
  })
})

describe("resolveThemeName", () => {
  test("falls back to terminal for unknown/undefined", () => {
    expect(resolveThemeName(undefined)).toBe("terminal")
    expect(resolveThemeName("nonsense")).toBe("terminal")
    expect(resolveThemeName("xai")).toBe("xai")
  })
})
