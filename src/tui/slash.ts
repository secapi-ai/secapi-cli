// Slash-command parsing for the REPL. Phase 4 ships the meta/session commands;
// Phase 5 expands the catalog (palette, skill shortcuts, personas). Pure module.

export interface ParsedSlash {
  name: string
  args: string[]
}

export interface SlashCommand {
  name: string
  summary: string
}

// Built-in meta/session slash commands available in Phase 4.
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", summary: "Show interactive help and key shortcuts" },
  { name: "login", summary: "Verify your API key and save a no-secret profile" },
  { name: "logout", summary: "How to forget the active profile / credentials" },
  { name: "clear", summary: "Clear the screen" },
  { name: "theme", summary: "Show or set the color theme" },
  { name: "status", summary: "Show CLI version, command count, and current mode" },
  { name: "cost", summary: "Show the session command count" },
  { name: "budget", summary: "Show billing plan, free grant, budget cap, and AI quota (secapi billing show)" },
  { name: "mode", summary: "Show or cycle the input mode (run/plan/ask)" },
  { name: "skills", summary: "List workflow shortcuts (/due-diligence, /analyze, …)" },
  { name: "personas", summary: "List the agent prompt-library personas" },
  { name: "persona", summary: "Filter personas by a lens, e.g. /persona investment-manager" },
  { name: "prompts", summary: "Browse the agent prompt library" },
  { name: "prompt", summary: "Read one prompt by id, e.g. /prompt due-diligence-brief" },
  { name: "export", summary: "Save this session transcript to disk" },
  { name: "share", summary: "Export this session as shareable, redacted Markdown" },
  { name: "fork", summary: "Branch this session into a new one, keeping the transcript so far" },
  { name: "rewind", summary: "Undo the last turn(s): /rewind [n]" },
  { name: "resume", summary: "Reload the most recent saved session" },
  { name: "sessions", summary: "List saved sessions" },
  { name: "config", summary: "Show the resolved configuration (base URL, theme, profile)" },
  { name: "profile", summary: "List configured no-secret profiles" },
  { name: "whoami", summary: "Show the authenticated account (secapi me)" },
  { name: "doctor", summary: "Diagnose base URL, auth, health, and MCP setup" },
  { name: "model", summary: "There is no selectable LLM model — secapi calls the SEC API directly" },
  { name: "mcp", summary: "How to install the MCP server config (secapi mcp install)" },
  { name: "init", summary: "One-command MCP install for this project" },
  { name: "trace", summary: "Show the lineage/provenance chain for a trace id: /trace tr_..." },
  { name: "reconcile", summary: "Prove a figure against its source filing: /reconcile <query>" },
  { name: "monitor", summary: "List saved-search monitors, or /monitor <query> to save a new one" },
  { name: "news", summary: "Show recent news, or /news <ticker> to filter" },
  { name: "layouts", summary: "List saved dashboard layouts (secapi layouts save/run outside the REPL)" },
  { name: "remember", summary: "Remember a note across sessions: /remember <text>" },
  { name: "memories", summary: "List remembered notes" },
  { name: "quit", summary: "Exit the interactive session" },
  { name: "exit", summary: "Exit the interactive session" },
]

export function isSlash(input: string): boolean {
  return input.trimStart().startsWith("/")
}

/** Parse a "/name arg1 arg2" line. Returns null if not a slash line. */
export function parseSlash(input: string): ParsedSlash | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { name: "", args: [] }
  return { name: parts[0].toLowerCase(), args: parts.slice(1) }
}

/** Fuzzy-ish prefix match of slash command names for autocomplete menus. */
export function matchSlashCommands(prefix: string): SlashCommand[] {
  const p = prefix.toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(p))
}
