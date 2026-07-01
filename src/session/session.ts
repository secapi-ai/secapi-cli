// Session transcripts — persist, resume, export, and stream REPL sessions.
//
// Serialization (JSON / Markdown / NDJSON) is pure and unit-testable; the fs
// helpers are thin wrappers writing 0600 files under ~/.config/secapi/sessions.
// Transcripts contain only prompts and rendered output — never credentials.

import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"

export type SessionEntryKind = "prompt" | "output" | "info" | "error"

export interface SessionEntry {
  ts: string
  kind: SessionEntryKind
  text: string
}

export interface SessionTranscript {
  object: "secapi_cli_session"
  id: string
  startedAt: string
  entries: SessionEntry[]
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,96}$/

export function isSafeSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

export function createSessionId(now = Date.now()): string {
  return `sess_${now.toString(36)}_${randomBytes(6).toString("hex")}`
}

export function redactSessionText(text: string): string {
  return text
    .replace(/("[^"]*(?:api[\s_-]?key|apikey|authorization|bearer|password|secret|token)[^"]*"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/\b(Authorization\s*:\s*)Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\b(Authorization\s*[=:]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\b(--?(?:api-key|bearer-token|authorization|password|secret|token)\b\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/\b((?:api[\s_-]?key|apikey|authorization|bearer|password|secret|token)[\w .-]*\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(?:secapi_(?:live|test)|secapi_boot|ods_(?:live|test))_[A-Za-z0-9._~-]{8,}\b/g, "[redacted]")
    .replace(/\bopr_(?:live|test)_[A-Za-z0-9._~-]{8,}\b/g, "[redacted]")
    .replace(/\bbearer_[A-Za-z0-9._~-]{8,}\b/g, "[redacted]")
    .replace(/\bagbt_[A-Za-z0-9._~-]{8,}\b/g, "[redacted]")
    .replace(/\bwhsec_[A-Za-z0-9._~-]{8,}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
}

export function redactSessionEntry(entry: SessionEntry): SessionEntry {
  return { ...entry, text: redactSessionText(entry.text) }
}

export function redactSessionTranscript(transcript: SessionTranscript): SessionTranscript {
  return { ...transcript, entries: transcript.entries.map(redactSessionEntry) }
}

export function serializeSession(transcript: SessionTranscript): string {
  return `${JSON.stringify(redactSessionTranscript(transcript), null, 2)}\n`
}

/** One JSON object per line — for scripting / piping interactive runs. */
export function serializeSessionNdjson(transcript: SessionTranscript): string {
  return redactSessionTranscript(transcript).entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
}

export function serializeSessionMarkdown(transcript: SessionTranscript): string {
  const redacted = redactSessionTranscript(transcript)
  const lines = [`# SEC API session ${redacted.id}`, "", `Started ${redacted.startedAt}`, ""]
  for (const entry of redacted.entries) {
    if (entry.kind === "prompt") lines.push("", `## \`${entry.text.replace(/^◈\s*/, "")}\``, "")
    else lines.push("```", entry.text, "```")
  }
  return `${lines.join("\n")}\n`
}

export function parseSession(raw: string): SessionTranscript | null {
  try {
    const parsed = JSON.parse(raw)
    if (
      parsed
      && parsed.object === "secapi_cli_session"
      && typeof parsed.id === "string"
      && isSafeSessionId(parsed.id)
      && typeof parsed.startedAt === "string"
      && Array.isArray(parsed.entries)
      && parsed.entries.every(
        (e: unknown) =>
          e !== null &&
          typeof e === "object" &&
          typeof (e as SessionEntry).kind === "string" &&
          typeof (e as SessionEntry).text === "string",
      )
    ) {
      return redactSessionTranscript(parsed as SessionTranscript)
    }
  } catch {
    /* fall through */
  }
  return null
}

export type ExportFormat = "json" | "ndjson" | "md"

export function normalizeExportFormat(value: string | undefined): ExportFormat {
  const v = (value ?? "").toLowerCase()
  if (v === "ndjson") return "ndjson"
  if (v === "md" || v === "markdown") return "md"
  return "json"
}

/** Write the transcript in the chosen format to the sessions dir (mode 0600). */
export function exportSessionAs(
  env: NodeJS.ProcessEnv,
  home: string,
  transcript: SessionTranscript,
  format: ExportFormat,
): string {
  const { dir, path } = sessionPath(env, home, transcript.id, format)
  mkdirSync(dir, { recursive: true })
  const content =
    format === "ndjson"
      ? serializeSessionNdjson(transcript)
      : format === "md"
        ? serializeSessionMarkdown(transcript)
        : serializeSession(transcript)
  writeFileSync(path, content, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function sessionsDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.SECAPI_SESSIONS_DIR?.trim()
  return override || join(home, ".config", "secapi", "sessions")
}

function sessionPath(env: NodeJS.ProcessEnv, home: string, id: string, extension = "json"): { dir: string; path: string } {
  if (!isSafeSessionId(id)) throw new Error("Session id may only contain letters, numbers, underscores, and dashes.")
  const dir = resolve(sessionsDir(env, home))
  const path = resolve(dir, `${id}.${extension}`)
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`
  if (!path.startsWith(prefix)) throw new Error("Session path escaped the sessions directory.")
  return { dir, path }
}

export function saveSession(env: NodeJS.ProcessEnv, home: string, transcript: SessionTranscript): string {
  const { dir, path } = sessionPath(env, home, transcript.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, serializeSession(transcript), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function loadSession(env: NodeJS.ProcessEnv, home: string, id: string): SessionTranscript | null {
  if (!isSafeSessionId(id)) return null
  const { path } = sessionPath(env, home, id)
  if (!existsSync(path)) return null
  try {
    return parseSession(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

export interface SessionSummary {
  id: string
  startedAt: string
  entryCount: number
  path: string
}

export function listSessions(env: NodeJS.ProcessEnv, home: string): SessionSummary[] {
  const dir = sessionsDir(env, home)
  if (!existsSync(dir)) return []
  const summaries: Array<SessionSummary & { updatedAtMs: number }> = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue
    const path = join(dir, file)
    let transcript: SessionTranscript | null = null
    let updatedAtMs = 0
    try {
      updatedAtMs = statSync(path).mtimeMs
      transcript = parseSession(readFileSync(path, "utf8"))
    } catch {
      continue
    }
    if (transcript && isSafeSessionId(transcript.id)) {
      summaries.push({ id: transcript.id, startedAt: transcript.startedAt, entryCount: transcript.entries.length, path, updatedAtMs })
    }
  }
  return summaries
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.startedAt.localeCompare(a.startedAt))
    .map(({ updatedAtMs: _updatedAtMs, ...summary }) => summary)
}

/** Most-recent session id, or null. */
export function latestSessionId(env: NodeJS.ProcessEnv, home: string): string | null {
  return listSessions(env, home)[0]?.id ?? null
}
