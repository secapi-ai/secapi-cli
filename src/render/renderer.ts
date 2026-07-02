// Renderer boundary — the single chokepoint for everything written to stdout.
//
// This exists so the pipe-safe/agent-first JSON contract is *structurally*
// guaranteed: handlers return a value and hand it to the renderer; the renderer
// chosen for non-TTY / --json / --output is always pure JSON, byte-identical to
// the legacy `print()` (JSON.stringify(value, null, 2)). Rich, human-readable
// "cards" (Phase 3) are added ONLY to the TTY renderer's `resource()` path, so
// no handler can ever leak decoration into a pipe.
//
// Pure module: the actual byte sink (`writeOutput`, which owns the --output file
// behavior and 0600 mode) is injected, so this stays unit-testable.

export type RenderHint =
  | "generic"
  | "filing"
  | "factors"
  | "portfolio"
  | "financials"
  | "search"
  | "account"
  | "trace"
  | "citations"
  | "dilution"
  | "monitors"
  | "news"
  | "factorDashboard"
  | "extremeMoves"
  | "macroRegime"

export interface Renderer {
  /** Always emits machine-readable JSON (agent-context, --json, examples --json). */
  json(value: unknown): void
  /** Pass-through for already-formatted text (csv/ndjson/markdown/completion scripts). */
  raw(text: string): void
  /**
   * Render a resource value. In JSON mode this is byte-identical to `json()`.
   * In rich (TTY) mode a per-hint human card is rendered (added in Phase 3).
   */
  resource(hint: RenderHint, value: unknown): void
}

/**
 * A card renderer: turns a resource value into a human string, or returns null
 * to defer to JSON (e.g. when the value's shape isn't what the card expects).
 * Card functions are pre-bound to the active Theme in index.ts so this module
 * stays theme-agnostic and pure.
 */
export type CardRenderer = (value: unknown) => string | null

export interface RendererOptions {
  /** The byte sink — index.ts injects `writeOutput` (handles --output + 0600). */
  write: (text: string) => void
  /**
   * When true, `resource()` renders rich human cards (TTY only). The factory's
   * `shouldRenderRich` rule guarantees this is false for any pipe/--json/--output
   * context, so the JSON contract is structural.
   */
  rich?: boolean
  /** Theme-bound card renderers keyed by hint. Missing hints fall back to JSON. */
  cards?: Partial<Record<RenderHint, CardRenderer>>
}

export function createRenderer(options: RendererOptions): Renderer {
  const json = (value: unknown) => options.write(JSON.stringify(value, null, 2))
  return {
    json,
    raw: (text) => options.write(text),
    resource: (hint, value) => {
      const card = options.rich ? options.cards?.[hint] : undefined
      if (card) {
        try {
          const rendered = card(value)
          if (rendered !== null && rendered !== "") {
            options.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`)
            return
          }
        } catch {
          // Any card failure falls through to JSON — never break output.
        }
      }
      json(value)
    },
  }
}

export interface SelectRendererContext {
  /** process.stdout.isTTY === true */
  isTty: boolean
  /** Explicit --json flag: true forces JSON, false forces human, undefined defers to TTY. */
  jsonFlag: boolean | undefined
  /** Whether an --output <file> path was supplied. */
  hasOutputPath: boolean
  /** NO_COLOR (or similar) is set. */
  noColor: boolean
}

/**
 * The single selection rule (promoted from `shouldPrintHumanSummary`): decide
 * whether rich rendering is permitted. Returns false (JSON) for any non-TTY,
 * --json, or --output context — the structural guarantee for pipes/agents.
 */
export function shouldRenderRich(ctx: SelectRendererContext): boolean {
  if (ctx.jsonFlag === true) return false
  if (ctx.jsonFlag === false) return ctx.isTty // explicit human, but only meaningful on a TTY
  if (ctx.hasOutputPath) return false
  if (ctx.noColor) return false
  return ctx.isTty
}
