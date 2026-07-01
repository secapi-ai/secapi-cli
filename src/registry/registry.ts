// Command registry — the single queryable source of truth for the CLI surface.
//
// Phase 1 (strangler): the registry is *derived* from the existing
// `IMPLEMENTED_COMMAND_KEYS` + `agentContextCommandDetail()` metadata in
// index.ts, so it stays byte-for-byte consistent with `agent-context`, shell
// completion, and "did you mean". The legacy one-shot dispatch in main() is
// retained and continues to execute commands. Later phases migrate handler
// bodies onto `CommandSpec.run` and consume this same registry from the
// interactive palette (Phase 5) — one source of truth for both front doors.
//
// This module is intentionally pure (no imports from index.ts) so it is unit
// testable and free of side effects.

export type CommandAuth = "none" | "api_key" | "bearer" | "optional_api_key"

export type CommandOutput =
  | "json"
  | "json_or_csv"
  | "text"
  | "human_or_json"
  | "file_or_text"
  | "json_or_markdown"

export interface CommandSpec {
  /** Space-joined command key, e.g. "filings latest" or "doctor". */
  key: string
  /** Leading group token, e.g. "filings"; "root" for top-level commands. */
  group: string
  /** Fully-qualified invocation, e.g. "secapi filings latest". */
  command: string
  /** Human usage string. */
  usage: string
  auth: CommandAuth
  mutates: boolean
  output: CommandOutput
  requiredFlags: string[]
  examples: string[]
}

export interface CommandRegistry {
  /** Every spec, sorted by key. */
  all(): CommandSpec[]
  /** Lookup by exact key. */
  get(key: string): CommandSpec | undefined
  /** Every key, sorted. */
  keys(): string[]
  /** Specs grouped by leading token, groups sorted, commands sorted. */
  groups(): Array<{ group: string; commands: CommandSpec[] }>
  /** Subsequence fuzzy match over key + usage, ranked best-first (for the palette). */
  search(query: string): CommandSpec[]
}

/** Subsequence match: are all chars of `needle` present in `haystack` in order? */
function subsequenceScore(haystack: string, needle: string): number | null {
  if (needle.length === 0) return 0
  let score = 0
  let hi = 0
  let lastMatch = -1
  for (let ni = 0; ni < needle.length; ni += 1) {
    const ch = needle[ni]
    let found = -1
    for (; hi < haystack.length; hi += 1) {
      if (haystack[hi] === ch) {
        found = hi
        hi += 1
        break
      }
    }
    if (found === -1) return null
    // Reward adjacency (contiguous matches rank higher) and earlier matches.
    score += lastMatch >= 0 && found === lastMatch + 1 ? 2 : 1
    score += found < 8 ? 1 : 0
    lastMatch = found
  }
  return score
}

export function buildRegistry(specs: CommandSpec[]): CommandRegistry {
  const sorted = [...specs].sort((a, b) => a.key.localeCompare(b.key))
  const byKey = new Map(sorted.map((spec) => [spec.key, spec]))

  return {
    all: () => [...sorted],
    get: (key) => byKey.get(key),
    keys: () => sorted.map((spec) => spec.key),
    groups: () => {
      const groups = new Map<string, CommandSpec[]>()
      for (const spec of sorted) {
        const bucket = groups.get(spec.group) ?? []
        bucket.push(spec)
        groups.set(spec.group, bucket)
      }
      return [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([group, commands]) => ({ group, commands }))
    },
    search: (query) => {
      const needle = query.trim().toLowerCase()
      if (needle === "") return [...sorted]
      const ranked: Array<{ spec: CommandSpec; score: number }> = []
      for (const spec of sorted) {
        const keyScore = subsequenceScore(spec.key.toLowerCase(), needle)
        const usageScore = subsequenceScore(spec.usage.toLowerCase(), needle)
        const best =
          keyScore === null
            ? usageScore === null
              ? null
              : usageScore
            : usageScore === null
              ? keyScore + 3 // a key match outranks a usage-only match
              : Math.max(keyScore + 3, usageScore)
        if (best !== null) ranked.push({ spec, score: best })
      }
      return ranked
        .sort((a, b) => b.score - a.score || a.spec.key.localeCompare(b.spec.key))
        .map((entry) => entry.spec)
    },
  }
}
