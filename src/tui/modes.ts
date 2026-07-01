// Interactive input modes, cycled with shift+tab (Grok/Claude-Code influence).
// Pure module so the cycle + metadata are unit-testable.
import type { ThemeRole } from "../theme/theme.ts"

export type ModeKey = "run" | "plan" | "ask"

export interface ModeMeta {
  key: ModeKey
  label: string
  /** Theme role used to color the mode indicator + spinner. */
  color: ThemeRole
  /** Short one-liner shown in help. */
  hint: string
}

// Cycle order for shift+tab.
export const MODES: ModeMeta[] = [
  { key: "run", label: "Run", color: "accent", hint: "execute commands immediately" },
  { key: "plan", label: "Plan", color: "warning", hint: "preview cost & endpoints before running" },
  { key: "ask", label: "Ask", color: "positive", hint: "read-only — never mutate or spend" },
]

export function modeMeta(key: ModeKey): ModeMeta {
  return MODES.find((m) => m.key === key) ?? MODES[0]
}

export function nextMode(current: ModeKey): ModeKey {
  const idx = MODES.findIndex((m) => m.key === current)
  return MODES[(idx + 1) % MODES.length].key
}

/** The ⏵⏵ mode indicator shown in the input border (empty for the default Run mode). */
export function modeIndicator(key: ModeKey): string {
  return key === "run" ? "" : "⏵⏵"
}
