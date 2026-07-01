// Theme engine: detect the terminal's color capability and render role tokens
// to the right ANSI tier. Honors NO_COLOR / FORCE_COLOR / COLORTERM / TERM —
// the gap in the legacy code, which only checked isTTY.
//
// Critical invariant: when color support is "none" (non-TTY without FORCE_COLOR,
// or NO_COLOR set), every code is the empty string, so output is byte-identical
// to the legacy `TTY ? code : ""` constants and the 128 piped tests stay green.

import { DEFAULT_THEME, isThemeName, THEMES, type Palette, type Rgb, type ThemeName, type ThemeRole } from "./themes.ts"

export type { ThemeRole, ThemeName, Rgb } from "./themes.ts"

export type ColorSupport = "none" | "ansi16" | "ansi256" | "truecolor"

export interface ColorEnv {
  NO_COLOR?: string
  FORCE_COLOR?: string
  COLORTERM?: string
  TERM?: string
}

const RESET_CODE = "\x1b[0m"

export function detectColorSupport(env: ColorEnv, isTty: boolean): ColorSupport {
  // NO_COLOR (no-color.org) is absolute for this CLI: any presence disables
  // color, even over FORCE_COLOR. Pipe-safety/accessibility beats forced color.
  if (env.NO_COLOR !== undefined) return "none"
  const force = env.FORCE_COLOR
  const forced = force === "1" || force === "2" || force === "3" || force === "true" || force === ""
  if (!forced && !isTty) return "none"

  const colorterm = (env.COLORTERM ?? "").toLowerCase()
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor"
  if (force === "3") return "truecolor"

  const term = (env.TERM ?? "").toLowerCase()
  if (term === "dumb") return forced ? "ansi16" : "none"
  if (term.includes("256")) return "ansi256"
  if (force === "2") return "ansi256"
  return "ansi16"
}

// Nearest 16-color SGR foreground code for an RGB tuple (8 base + 8 bright).
function rgbToAnsi16(rgb: Rgb): number {
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  if (max < 40) return 90 // bright black (grey)
  const bright = max > 150
  const bit = (v: number) => (v > max / 2 ? 1 : 0)
  const code = bit(r) + bit(g) * 2 + bit(b) * 4 // 0..7 → black,red,green,yellow,blue,magenta,cyan,white
  return (bright ? 90 : 30) + code
}

// RGB → xterm-256 color index (the standard 6x6x6 cube + greyscale ramp).
function rgbToAnsi256(rgb: Rgb): number {
  const [r, g, b] = rgb
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  const q = (v: number) => Math.round((v / 255) * 5)
  return 16 + 36 * q(r) + 6 * q(g) + q(b)
}

export function colorCode(rgb: Rgb, support: ColorSupport): string {
  switch (support) {
    case "none":
      return ""
    case "truecolor":
      return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
    case "ansi256":
      return `\x1b[38;5;${rgbToAnsi256(rgb)}m`
    case "ansi16":
      return `\x1b[${rgbToAnsi16(rgb)}m`
  }
}

export interface Theme {
  name: ThemeName
  support: ColorSupport
  // SGR attribute codes (color-independent), empty when support is "none".
  bold: string
  dim: string
  reset: string
  // Role open-codes (empty when support is "none").
  accent: string
  heading: string
  muted: string
  dimmed: string
  positive: string
  negative: string
  warning: string
  border: string
  /** Wrap text in a role's color + reset (no-op when support is "none"). */
  paint(role: ThemeRole, text: string): string
}

export interface CreateThemeOptions {
  name?: ThemeName
  support: ColorSupport
  /** Override the accent role (e.g. from --accent or settings). */
  accent?: Rgb
}

export function createTheme(options: CreateThemeOptions): Theme {
  const name = options.name ?? DEFAULT_THEME
  const palette: Palette = { ...THEMES[name], ...(options.accent ? { accent: options.accent } : {}) }
  const support = options.support
  const code = (role: ThemeRole) => colorCode(palette[role], support)
  const reset = support === "none" ? "" : RESET_CODE
  const attr = (sgr: string) => (support === "none" ? "" : sgr)

  const roleCodes = {
    accent: code("accent"),
    heading: code("heading"),
    muted: code("muted"),
    dimmed: code("dimmed"),
    positive: code("positive"),
    negative: code("negative"),
    warning: code("warning"),
    border: code("border"),
  }

  return {
    name,
    support,
    bold: attr("\x1b[1m"),
    dim: attr("\x1b[2m"),
    reset,
    ...roleCodes,
    paint: (role, text) => {
      const open = code(role)
      return open === "" ? text : `${open}${text}${reset}`
    },
  }
}

/** Parse a #rrggbb / rrggbb hex string into an Rgb, or null if invalid. */
export function parseHexColor(input: string): Rgb | null {
  const hex = input.trim().replace(/^#/, "")
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

export function resolveThemeName(value: string | undefined, fallback: ThemeName = DEFAULT_THEME): ThemeName {
  if (value && isThemeName(value)) return value
  return fallback
}
