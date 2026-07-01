// Fuzzy command palette — a unified, searchable index over the slash commands
// and ALL ~135 CLI commands (from the registry, the single source of truth).
// Pure module so the ranking is unit-testable; the REPL renders the overlay.

import type { CommandRegistry } from "../registry/registry.ts"
import { SKILL_SHORTCUTS, skillIsMetered } from "../skills/catalog.ts"
import { SLASH_COMMANDS } from "./slash.ts"

export interface PaletteEntry {
  kind: "slash" | "command"
  /** Display label, e.g. "/help" or "filings latest". */
  label: string
  /** One-line description (slash summary or command usage). */
  detail: string
  /** Text inserted into the input when selected. */
  insert: string
  mutates?: boolean
  metered?: boolean
}

// AI-metered command keys (the two LLM-backed surfaces) — flagged in the palette
// so users see a 💲 before spending.
const METERED_KEYS = new Set([
  "intelligence company",
  "intelligence security",
  "intelligence earnings-preview",
  "intelligence footnotes-query",
])

export function buildPaletteEntries(registry: CommandRegistry): PaletteEntry[] {
  const slash: PaletteEntry[] = SLASH_COMMANDS.map((c) => ({
    kind: "slash",
    label: `/${c.name}`,
    detail: c.summary,
    insert: `/${c.name} `,
  }))
  const skills: PaletteEntry[] = SKILL_SHORTCUTS.map((s) => ({
    kind: "slash",
    label: `/${s.slash}`,
    detail: `workflow — ${s.summary}`,
    insert: `/${s.slash}${s.arg !== "none" ? " " : ""}`,
    metered: skillIsMetered(s),
  }))
  const commands: PaletteEntry[] = registry.all().map((spec) => ({
    kind: "command",
    label: spec.key,
    detail: spec.usage,
    insert: `${spec.key} `,
    mutates: spec.mutates,
    metered: METERED_KEYS.has(spec.key),
  }))
  return [...slash, ...skills, ...commands]
}

/** Subsequence match score, or null if `needle` isn't a subsequence of `hay`. */
function subseq(hay: string, needle: string): number | null {
  if (needle === "") return 0
  let score = 0
  let hi = 0
  let last = -1
  for (const ch of needle) {
    let found = -1
    for (; hi < hay.length; hi += 1) {
      if (hay[hi] === ch) {
        found = hi
        hi += 1
        break
      }
    }
    if (found === -1) return null
    score += last >= 0 && found === last + 1 ? 2 : 1
    score += found < 6 ? 1 : 0
    last = found
  }
  return score
}

/**
 * Filter + rank palette entries for a query. A leading "/" restricts to slash
 * commands; otherwise all entries are searched by label then detail.
 */
export function filterPalette(entries: PaletteEntry[], query: string, limit = 12): PaletteEntry[] {
  const slashOnly = query.startsWith("/")
  const needle = (slashOnly ? query.slice(1) : query).trim().toLowerCase()
  const pool = slashOnly ? entries.filter((e) => e.kind === "slash") : entries
  if (needle === "") return pool.slice(0, limit)

  const ranked: Array<{ entry: PaletteEntry; score: number }> = []
  for (const entry of pool) {
    const labelScore = subseq(entry.label.toLowerCase(), needle)
    const detailScore = subseq(entry.detail.toLowerCase(), needle)
    const best =
      labelScore === null ? detailScore : detailScore === null ? labelScore + 3 : Math.max(labelScore + 3, detailScore)
    if (best !== null) ranked.push({ entry, score: best })
  }
  return ranked
    .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
    .slice(0, limit)
    .map((r) => r.entry)
}
