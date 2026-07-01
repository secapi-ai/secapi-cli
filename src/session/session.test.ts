import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  exportSessionAs,
  createSessionId,
  isSafeSessionId,
  latestSessionId,
  listSessions,
  loadSession,
  normalizeExportFormat,
  parseSession,
  redactSessionText,
  saveSession,
  serializeSession,
  serializeSessionMarkdown,
  serializeSessionNdjson,
  type SessionTranscript,
} from "./session.ts"

function transcript(id: string): SessionTranscript {
  return {
    object: "secapi_cli_session",
    id,
    startedAt: "2026-06-30T00:00:00.000Z",
    entries: [
      { ts: "2026-06-30T00:00:01.000Z", kind: "prompt", text: "◈ filings latest --ticker AAPL" },
      { ts: "2026-06-30T00:00:02.000Z", kind: "output", text: "AAPL · 10-K" },
    ],
  }
}

describe("serialization", () => {
  test("JSON round-trips through parseSession", () => {
    const t = transcript("sess_a")
    const parsed = parseSession(serializeSession(t))
    expect(parsed).toEqual(t)
  })
  test("NDJSON emits one object per entry", () => {
    const lines = serializeSessionNdjson(transcript("sess_a")).trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).kind).toBe("prompt")
  })
  test("Markdown includes prompts as headings", () => {
    expect(serializeSessionMarkdown(transcript("sess_a"))).toContain("## `filings latest --ticker AAPL`")
  })
  test("parseSession rejects non-session JSON and malformed entries", () => {
    expect(parseSession("{}")).toBeNull()
    expect(parseSession("not json")).toBeNull()
    expect(parseSession(JSON.stringify({ object: "secapi_cli_session", id: "x", entries: [{}] }))).toBeNull()
    expect(parseSession(JSON.stringify({ object: "secapi_cli_session", entries: [] }))).toBeNull() // no id
    expect(parseSession(JSON.stringify({ object: "secapi_cli_session", id: "../escape", startedAt: "2026-06-30T00:00:00.000Z", entries: [] }))).toBeNull()
    expect(parseSession(JSON.stringify({ object: "secapi_cli_session", id: "sess_bad", startedAt: 1, entries: [] }))).toBeNull()
  })

  test("serializers redact credential-shaped transcript text", () => {
    const t = transcript("sess_secret")
    t.entries = [
      { ts: "2026-06-30T00:00:01.000Z", kind: "prompt", text: "◈ api-keys create --api-key secapi_live_SHOULD_NOT_LEAK_123456" },
      { ts: "2026-06-30T00:00:02.000Z", kind: "output", text: '{"secret":"plain-one-time-secret","apiKey":"secapi_test_SHOULD_NOT_LEAK_123456"}' },
    ]
    const json = serializeSession(t)
    const markdown = serializeSessionMarkdown(t)
    const ndjson = serializeSessionNdjson(t)
    expect(`${json}\n${markdown}\n${ndjson}`).not.toContain("SHOULD_NOT_LEAK")
    expect(`${json}\n${markdown}\n${ndjson}`).not.toContain("plain-one-time-secret")
    expect(`${json}\n${markdown}\n${ndjson}`).toContain("[redacted]")
  })
  test("redacts bearer and assignment-style secrets", () => {
    expect(redactSessionText("Authorization: Bearer abcdefgh123456789")).not.toContain("abcdefgh123456789")
    expect(redactSessionText("token=abcdefghi secret: abcdefghi API key: abcdefghi")).not.toContain("abcdefghi")
  })
})

describe("export formats", () => {
  test("normalizeExportFormat maps aliases and defaults to json", () => {
    expect(normalizeExportFormat("ndjson")).toBe("ndjson")
    expect(normalizeExportFormat("md")).toBe("md")
    expect(normalizeExportFormat("markdown")).toBe("md")
    expect(normalizeExportFormat(undefined)).toBe("json")
    expect(normalizeExportFormat("garbage")).toBe("json")
  })

  test("exportSessionAs writes the chosen format + extension (0600)", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-export-"))
    try {
      const env = { SECAPI_SESSIONS_DIR: dir } as NodeJS.ProcessEnv
      const t = transcript("sess_exp")
      const mdPath = exportSessionAs(env, dir, t, "md")
      expect(mdPath.endsWith("sess_exp.md")).toBe(true)
      expect(statSync(mdPath).mode & 0o777).toBe(0o600)
      expect(readFileSync(mdPath, "utf8")).toContain("# SEC API session")

      const ndPath = exportSessionAs(env, dir, t, "ndjson")
      expect(ndPath.endsWith("sess_exp.ndjson")).toBe(true)
      expect(readFileSync(ndPath, "utf8").trim().split("\n")).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("exportSessionAs rejects unsafe session ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-export-"))
    try {
      const env = { SECAPI_SESSIONS_DIR: dir } as NodeJS.ProcessEnv
      expect(() => exportSessionAs(env, dir, transcript("../escape"), "md")).toThrow("Session id")
      expect(existsSync(join(dir, "..", "escape.md"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("persistence", () => {
  test("createSessionId adds entropy beyond the timestamp", () => {
    const ids = Array.from({ length: 32 }, () => createSessionId(1_782_777_600_000))
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(isSafeSessionId(id)).toBe(true)
  })

  test("save/load/list round-trip at mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-sessions-"))
    try {
      const env = { SECAPI_SESSIONS_DIR: dir } as NodeJS.ProcessEnv
      const path = saveSession(env, dir, transcript("sess_one"))
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(loadSession(env, dir, "sess_one")?.id).toBe("sess_one")

      const t2 = transcript("sess_two")
      t2.startedAt = "2026-06-30T01:00:00.000Z"
      saveSession(env, dir, t2)
      const all = listSessions(env, dir)
      expect(all.map((s) => s.id)).toEqual(["sess_two", "sess_one"]) // newest first
      expect(latestSessionId(env, dir)).toBe("sess_two")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("missing session/dir → null / empty", () => {
    const env = { SECAPI_SESSIONS_DIR: join(tmpdir(), "secapi-nonexistent-xyz") } as NodeJS.ProcessEnv
    expect(loadSession(env, "/x", "nope")).toBeNull()
    expect(listSessions(env, "/x")).toEqual([])
    expect(latestSessionId(env, "/x")).toBeNull()
  })

  test("listSessions skips unreadable or malformed session files", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-sessions-"))
    try {
      const env = { SECAPI_SESSIONS_DIR: dir } as NodeJS.ProcessEnv
      saveSession(env, dir, transcript("sess_good"))
      writeFileSync(join(dir, "malformed.json"), "{not json", { mode: 0o600 })
      writeFileSync(join(dir, "bad-started-at.json"), JSON.stringify({ object: "secapi_cli_session", id: "sess_bad", startedAt: 1, entries: [] }), { mode: 0o600 })
      mkdirSync(join(dir, "directory.json"))
      expect(listSessions(env, dir).map((session) => session.id)).toEqual(["sess_good"])
      expect(latestSessionId(env, dir)).toBe("sess_good")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("listSessions orders by file write recency, not transcript startedAt", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-sessions-"))
    try {
      const env = { SECAPI_SESSIONS_DIR: dir } as NodeJS.ProcessEnv
      const newestStarted = transcript("sess_started_newer")
      newestStarted.startedAt = "2026-06-30T02:00:00.000Z"
      const olderStarted = transcript("sess_written_newer")
      olderStarted.startedAt = "2026-06-30T01:00:00.000Z"
      const firstPath = saveSession(env, dir, newestStarted)
      const secondPath = saveSession(env, dir, olderStarted)
      utimesSync(firstPath, new Date("2026-06-30T02:00:00.000Z"), new Date("2026-06-30T02:00:00.000Z"))
      utimesSync(secondPath, new Date("2026-06-30T03:00:00.000Z"), new Date("2026-06-30T03:00:00.000Z"))
      expect(listSessions(env, dir).map((session) => session.id)).toEqual(["sess_written_newer", "sess_started_newer"])
      expect(latestSessionId(env, dir)).toBe("sess_written_newer")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("session ids cannot traverse outside the sessions directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-sessions-"))
    try {
      const env = { SECAPI_SESSIONS_DIR: dir } as NodeJS.ProcessEnv
      expect(isSafeSessionId("sess_safe-1")).toBe(true)
      expect(isSafeSessionId("../escape")).toBe(false)
      expect(() => saveSession(env, dir, transcript("../escape"))).toThrow("Session id")
      expect(loadSession(env, dir, "../escape")).toBeNull()
      expect(existsSync(join(dir, "..", "escape.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("save/load redacts persisted transcripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-sessions-"))
    try {
      const env = { SECAPI_SESSIONS_DIR: dir } as NodeJS.ProcessEnv
      const t = transcript("sess_secret")
      t.entries = [
        { ts: "2026-06-30T00:00:01.000Z", kind: "output", text: '{"secret":"secapi_live_SHOULD_NOT_LEAK_123456"}' },
      ]
      const path = saveSession(env, dir, t)
      const raw = readFileSync(path, "utf8")
      expect(raw).not.toContain("SHOULD_NOT_LEAK")
      expect(raw).toContain("[redacted]")
      expect(loadSession(env, dir, "sess_secret")?.entries[0]?.text).toContain("[redacted]")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
