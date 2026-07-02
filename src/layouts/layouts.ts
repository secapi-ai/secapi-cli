// Saved dashboard layouts — name a `secapi` command (typically a `--watch`
// dashboard) once, then re-run it by name. Mirrors schedule.ts's persistence
// shape exactly: ~/.config/secapi/layouts.json, mode 0600, env override.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface SavedLayout {
  id: string
  name: string
  /** A full `secapi` argument string, e.g. "factors dashboard --watch". */
  command: string
  createdAt: string
}

export function layoutsPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.SECAPI_LAYOUTS_FILE?.trim() || join(home, ".config", "secapi", "layouts.json")
}

export function parseLayouts(raw: string | null): SavedLayout[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const layouts = Array.isArray(parsed?.layouts) ? parsed.layouts : []
    return layouts.filter(
      (l: unknown): l is SavedLayout =>
        l !== null && typeof l === "object"
        && typeof (l as SavedLayout).id === "string"
        && typeof (l as SavedLayout).name === "string"
        && typeof (l as SavedLayout).command === "string",
    )
  } catch {
    return []
  }
}

export function loadLayouts(env: NodeJS.ProcessEnv, home: string): SavedLayout[] {
  const path = layoutsPath(env, home)
  return existsSync(path) ? parseLayouts(readFileSync(path, "utf8")) : []
}

export function saveLayouts(env: NodeJS.ProcessEnv, home: string, layouts: SavedLayout[]): string {
  const path = layoutsPath(env, home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ object: "secapi_cli_layouts", layouts }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function findLayout(layouts: SavedLayout[], nameOrId: string): SavedLayout | undefined {
  return layouts.find((l) => l.name === nameOrId || l.id === nameOrId)
}
