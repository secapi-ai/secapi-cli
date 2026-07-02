import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadMemory, parseMemory, saveMemory, type MemoryNote } from "./memory.ts"

describe("persistence", () => {
  test("save/load round-trip at 0600; parseMemory drops malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-memory-"))
    try {
      const env = { SECAPI_MEMORY_FILE: join(dir, "m.json") } as NodeJS.ProcessEnv
      const note: MemoryNote = { id: "mem_1", text: "AAPL earnings call is next Tuesday", createdAt: "2026-06-30T00:00:00.000Z" }
      const path = saveMemory(env, dir, [note])
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(loadMemory(env, dir).map((n) => n.id)).toEqual(["mem_1"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("parseMemory tolerates garbage", () => {
    expect(parseMemory(null)).toEqual([])
    expect(parseMemory("not json")).toEqual([])
    expect(parseMemory(JSON.stringify({ notes: [{}, { id: "ok", text: "hi" }] })).length).toBe(1)
  })

  test("refuses to save a note that looks like a secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-memory-"))
    try {
      const env = { SECAPI_MEMORY_FILE: join(dir, "m.json") } as NodeJS.ProcessEnv
      const note: MemoryNote = { id: "mem_1", text: "my key is secapi_live_abc123", createdAt: "2026-06-30T00:00:00.000Z" }
      expect(() => saveMemory(env, dir, [note])).toThrow(/looks like it contains a secret/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
