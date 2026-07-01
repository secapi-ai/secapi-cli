import { describe, expect, test } from "bun:test"
import { buildRegistry, type CommandSpec } from "./registry.ts"

function spec(key: string, overrides: Partial<CommandSpec> = {}): CommandSpec {
  const group = key.includes(" ") ? key.slice(0, key.indexOf(" ")) : "root"
  return {
    key,
    group,
    command: `secapi ${key}`,
    usage: `secapi ${key} [options]`,
    auth: "api_key",
    mutates: false,
    output: "json",
    requiredFlags: [],
    examples: [],
    ...overrides,
  }
}

const specs = [
  spec("filings latest"),
  spec("filings search"),
  spec("factors catalog"),
  spec("doctor", { auth: "optional_api_key" }),
  spec("me", { output: "human_or_json" }),
]

describe("buildRegistry", () => {
  test("all() returns specs sorted by key", () => {
    const reg = buildRegistry(specs)
    expect(reg.all().map((s) => s.key)).toEqual(["doctor", "factors catalog", "filings latest", "filings search", "me"])
  })

  test("get() resolves by exact key, undefined otherwise", () => {
    const reg = buildRegistry(specs)
    expect(reg.get("filings latest")?.command).toBe("secapi filings latest")
    expect(reg.get("nope")).toBeUndefined()
  })

  test("keys() returns sorted keys", () => {
    expect(buildRegistry(specs).keys()).toEqual([
      "doctor",
      "factors catalog",
      "filings latest",
      "filings search",
      "me",
    ])
  })

  test("groups() buckets by leading token, sorted (top-level commands group under 'root')", () => {
    const groups = buildRegistry(specs).groups()
    expect(groups.map((g) => g.group)).toEqual(["factors", "filings", "root"])
    const filings = groups.find((g) => g.group === "filings")
    expect(filings?.commands.map((c) => c.key)).toEqual(["filings latest", "filings search"])
    const root = groups.find((g) => g.group === "root")
    expect(root?.commands.map((c) => c.key)).toEqual(["doctor", "me"])
  })

  test("search('') returns everything", () => {
    expect(buildRegistry(specs).search("").length).toBe(specs.length)
  })

  test("search() finds by subsequence and ranks key matches first", () => {
    const reg = buildRegistry(specs)
    const results = reg.search("filat") // subsequence of "filings latest"
    expect(results[0]?.key).toBe("filings latest")
  })

  test("search() matches usage text when key does not match", () => {
    const reg = buildRegistry([spec("doctor", { usage: "secapi doctor — diagnose setup" })])
    expect(reg.search("diagnose").map((s) => s.key)).toContain("doctor")
  })

  test("search() returns empty for an impossible query", () => {
    expect(buildRegistry(specs).search("zzzzqqq")).toEqual([])
  })
})
