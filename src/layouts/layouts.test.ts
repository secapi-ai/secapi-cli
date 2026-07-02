import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findLayout, loadLayouts, parseLayouts, saveLayouts, type SavedLayout } from "./layouts.ts"

describe("persistence", () => {
  test("save/load round-trip at 0600; parseLayouts drops malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-layouts-"))
    try {
      const env = { SECAPI_LAYOUTS_FILE: join(dir, "l.json") } as NodeJS.ProcessEnv
      const layout: SavedLayout = {
        id: "lay_1",
        name: "factors-desk",
        command: "factors dashboard --watch",
        createdAt: "2026-06-30T00:00:00.000Z",
      }
      const path = saveLayouts(env, dir, [layout])
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(loadLayouts(env, dir).map((l) => l.id)).toEqual(["lay_1"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("parseLayouts tolerates garbage", () => {
    expect(parseLayouts(null)).toEqual([])
    expect(parseLayouts("not json")).toEqual([])
    expect(parseLayouts(JSON.stringify({ layouts: [{}, { id: "ok", name: "n", command: "c" }] })).length).toBe(1)
  })
})

describe("findLayout", () => {
  const layouts: SavedLayout[] = [
    { id: "lay_1", name: "factors-desk", command: "factors dashboard --watch", createdAt: "2026-06-30T00:00:00.000Z" },
  ]

  test("matches by name or id", () => {
    expect(findLayout(layouts, "factors-desk")?.id).toBe("lay_1")
    expect(findLayout(layouts, "lay_1")?.name).toBe("factors-desk")
    expect(findLayout(layouts, "nope")).toBeUndefined()
  })
})
