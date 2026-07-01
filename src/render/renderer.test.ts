import { describe, expect, test } from "bun:test"
import { createRenderer, shouldRenderRich } from "./renderer.ts"

describe("createRenderer (JSON mode)", () => {
  test("json() is byte-identical to the legacy print()", () => {
    const out: string[] = []
    const r = createRenderer({ write: (t) => out.push(t) })
    const value = { object: "x", n: 1, nested: { a: [1, 2], b: "c" } }
    r.json(value)
    expect(out).toEqual([JSON.stringify(value, null, 2)])
  })

  test("raw() passes text through unchanged", () => {
    const out: string[] = []
    const r = createRenderer({ write: (t) => out.push(t) })
    r.raw("a,b,c\n1,2,3\n")
    expect(out).toEqual(["a,b,c\n1,2,3\n"])
  })

  test("resource() emits the same JSON as json() in Phase 1 (no rich cards yet)", () => {
    const jsonOut: string[] = []
    const resOut: string[] = []
    const value = { ticker: "AAPL", form: "10-K" }
    createRenderer({ write: (t) => jsonOut.push(t) }).json(value)
    createRenderer({ write: (t) => resOut.push(t) }).resource("filing", value)
    expect(resOut).toEqual(jsonOut)
  })
})

describe("resource() rich card path", () => {
  test("renders the card when rich + a card exists", () => {
    const out: string[] = []
    const r = createRenderer({ write: (t) => out.push(t), rich: true, cards: { filing: () => "CARD" } })
    r.resource("filing", { x: 1 })
    expect(out).toEqual(["CARD\n"])
  })

  test("falls back to JSON when the card returns null", () => {
    const out: string[] = []
    const r = createRenderer({ write: (t) => out.push(t), rich: true, cards: { filing: () => null } })
    r.resource("filing", { x: 1 })
    expect(out).toEqual([JSON.stringify({ x: 1 }, null, 2)])
  })

  test("falls back to JSON when the card throws (never breaks output)", () => {
    const out: string[] = []
    const r = createRenderer({
      write: (t) => out.push(t),
      rich: true,
      cards: {
        filing: () => {
          throw new Error("boom")
        },
      },
    })
    r.resource("filing", { x: 1 })
    expect(out).toEqual([JSON.stringify({ x: 1 }, null, 2)])
  })

  test("ignores cards entirely when not rich (pipe-safe)", () => {
    const out: string[] = []
    const r = createRenderer({ write: (t) => out.push(t), rich: false, cards: { filing: () => "CARD" } })
    r.resource("filing", { x: 1 })
    expect(out).toEqual([JSON.stringify({ x: 1 }, null, 2)])
  })
})

describe("shouldRenderRich (the pipe-safe selection rule)", () => {
  test("--json=true forces JSON even in a TTY", () => {
    expect(shouldRenderRich({ isTty: true, jsonFlag: true, hasOutputPath: false, noColor: false })).toBe(false)
  })

  test("non-TTY never renders rich", () => {
    expect(shouldRenderRich({ isTty: false, jsonFlag: undefined, hasOutputPath: false, noColor: false })).toBe(false)
  })

  test("--output path forces JSON", () => {
    expect(shouldRenderRich({ isTty: true, jsonFlag: undefined, hasOutputPath: true, noColor: false })).toBe(false)
  })

  test("NO_COLOR forces JSON", () => {
    expect(shouldRenderRich({ isTty: true, jsonFlag: undefined, hasOutputPath: false, noColor: true })).toBe(false)
  })

  test("plain TTY with no overrides renders rich", () => {
    expect(shouldRenderRich({ isTty: true, jsonFlag: undefined, hasOutputPath: false, noColor: false })).toBe(true)
  })

  test("--json=false renders rich only on a TTY", () => {
    expect(shouldRenderRich({ isTty: true, jsonFlag: false, hasOutputPath: false, noColor: false })).toBe(true)
    expect(shouldRenderRich({ isTty: false, jsonFlag: false, hasOutputPath: false, noColor: false })).toBe(false)
  })
})
