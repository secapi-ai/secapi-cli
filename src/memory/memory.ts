// Cross-session memory notes ("/remember" / "/memories") — small free-text
// reminders that persist across REPL sessions, distinct from full session
// transcripts (export/fork/rewind/resume). Mirrors schedule.ts's persistence
// shape: ~/.config/secapi/memory.json, mode 0600, env override.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { looksCredentialShaped } from "../settings/settings.ts"

export interface MemoryNote {
  id: string
  text: string
  createdAt: string
}

export function memoryPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.SECAPI_MEMORY_FILE?.trim() || join(home, ".config", "secapi", "memory.json")
}

export function parseMemory(raw: string | null): MemoryNote[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const notes = Array.isArray(parsed?.notes) ? parsed.notes : []
    return notes.filter(
      (n: unknown): n is MemoryNote =>
        n !== null && typeof n === "object"
        && typeof (n as MemoryNote).id === "string"
        && typeof (n as MemoryNote).text === "string",
    )
  } catch {
    return []
  }
}

export function loadMemory(env: NodeJS.ProcessEnv, home: string): MemoryNote[] {
  const path = memoryPath(env, home)
  return existsSync(path) ? parseMemory(readFileSync(path, "utf8")) : []
}

export function saveMemory(env: NodeJS.ProcessEnv, home: string, notes: MemoryNote[]): string {
  for (const note of notes) {
    if (looksCredentialShaped(note.text)) {
      throw new Error("Refusing to remember a note that looks like it contains a secret.")
    }
  }
  const path = memoryPath(env, home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ object: "secapi_cli_memory", notes }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}
