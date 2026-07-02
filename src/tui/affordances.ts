// Input affordances for the REPL: `!` bash escape, `#` pin-context, `:` factor/
// form/section key cheatsheet, `@` ticker/entity mention shorthand, and `?` as
// a bare alias for /help. Pure, unit-testable parsing/lookup — the REPL wires
// these into submit()/useInput().

/** `!<command>` → the shell command to run, or null if not a bang line. */
export function expandBangCommand(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith("!")) return null
  const command = trimmed.slice(1).trim()
  return command.length > 0 ? command : null
}

/**
 * `#<note>` pins a scratch note for the session (shown in /status, never sent
 * to the API). `#` alone clears the pin. Returns undefined if not a pin line.
 */
export function parsePinContext(input: string): { note: string } | { clear: true } | undefined {
  const trimmed = input.trim()
  if (!trimmed.startsWith("#")) return undefined
  const note = trimmed.slice(1).trim()
  return note.length > 0 ? { note } : { clear: true }
}

/** `@<ticker>` as the WHOLE input is shorthand for `entities resolve --ticker <ticker>`. */
export function expandMentionShorthand(input: string): string | null {
  const trimmed = input.trim()
  const match = trimmed.match(/^@([A-Za-z0-9.\-]{1,10})$/)
  return match ? `entities resolve --ticker ${match[1].toUpperCase()}` : null
}

// A cheatsheet, not a live lookup — canonical factor categories, common SEC
// form types, and standard filing section keys agents/humans reach for most.
export const LOOKUP_KEYS: readonly string[] = [
  "VALUE", "MOMENTUM", "QUALITY", "SIZE", "GROWTH", "LOW_VOL", "YIELD", "LEVERAGE",
  "10-K", "10-Q", "8-K", "DEF 14A", "S-1", "13F-HR", "SC 13D", "SC 13G", "4", "3", "5",
  "item_1a", "item_7", "item_7a", "item_8", "item_9a",
]

/** `:<prefix>` → matching known factor/form/section keys (case-insensitive prefix match). */
export function matchLookupKeys(prefix: string): string[] {
  const p = prefix.trim().toUpperCase()
  if (p.length === 0) return [...LOOKUP_KEYS]
  return LOOKUP_KEYS.filter((key) => key.toUpperCase().startsWith(p))
}

/** `:<prefix>` line → the matches, or null if not a lookup line. */
export function parseLookupQuery(input: string): string[] | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith(":")) return null
  return matchLookupKeys(trimmed.slice(1))
}

/** A bare `?` is an alias for `/help`. */
export function isHelpAlias(input: string): boolean {
  return input.trim() === "?"
}
