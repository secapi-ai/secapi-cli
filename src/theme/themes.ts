// Theme palettes — stark monochrome + a single accent (xAI/Grok/X influence),
// finance-tuned. Roles are RGB tuples; the theme engine (theme.ts) downsamples
// them to the terminal's detected color tier (truecolor / 256 / 16 / none).
//
// Semantic colors (positive/negative) are ALWAYS paired with arrows (▲▼) at the
// call sites, never color alone, so colorblind users never lose the signal.

export type Rgb = readonly [number, number, number]

export type ThemeRole =
  | "accent" // brand accent — active mode, selection, links, headings emphasis
  | "heading" // bright primary text
  | "muted" // secondary text
  | "dimmed" // tertiary / hints
  | "positive" // gains / fresh / cache-hit
  | "negative" // losses / errors
  | "warning" // budget / risk
  | "border" // hairlines, rails

export type Palette = Record<ThemeRole, Rgb>

export type ThemeName = "terminal" | "lights-out" | "light" | "xai" | "daltonized" | "ansi"

// Brand + signal anchors (verified xAI/Grok/X tokens, finance-adapted).
const SECAPI_CYAN: Rgb = [56, 189, 211] // default SEC brand accent (teal/cyan)
const BLAZE_ORANGE: Rgb = [255, 99, 8] // xAI signature accent
const GAIN_GREEN: Rgb = [63, 185, 80]
const LOSS_RED: Rgb = [248, 81, 73]
const WARN_AMBER: Rgb = [210, 153, 34]

// Daltonized (deuteranopia-safe): blue = positive, orange = negative.
const DALTON_BLUE: Rgb = [56, 135, 247]
const DALTON_ORANGE: Rgb = [236, 140, 30]

export const THEMES: Record<ThemeName, Palette> = {
  // Default: near-black canvas, grey-scale text, single cyan accent.
  terminal: {
    accent: SECAPI_CYAN,
    heading: [252, 252, 252],
    muted: [158, 158, 158],
    dimmed: [99, 99, 99],
    positive: GAIN_GREEN,
    negative: LOSS_RED,
    warning: WARN_AMBER,
    border: [40, 40, 45],
  },
  // X "Lights Out" — same foreground treatment; assumes a pure-black canvas.
  "lights-out": {
    accent: SECAPI_CYAN,
    heading: [255, 255, 255],
    muted: [148, 148, 148],
    dimmed: [90, 90, 90],
    positive: GAIN_GREEN,
    negative: LOSS_RED,
    warning: WARN_AMBER,
    border: [34, 34, 38],
  },
  // Light terminals — darker text roles for contrast on a light background.
  light: {
    accent: [13, 110, 130],
    heading: [17, 17, 17],
    muted: [82, 82, 82],
    dimmed: [130, 130, 130],
    positive: [26, 127, 55],
    negative: [193, 40, 47],
    warning: [154, 103, 0],
    border: [200, 200, 205],
  },
  // Bolder xAI-flavored variant: Blaze Orange as the single accent.
  xai: {
    accent: BLAZE_ORANGE,
    heading: [252, 252, 252],
    muted: [158, 158, 158],
    dimmed: [99, 99, 99],
    positive: GAIN_GREEN,
    negative: LOSS_RED,
    warning: WARN_AMBER,
    border: [40, 40, 45],
  },
  // Colorblind-friendly: blue/orange instead of green/red for gain/loss.
  daltonized: {
    accent: SECAPI_CYAN,
    heading: [252, 252, 252],
    muted: [158, 158, 158],
    dimmed: [99, 99, 99],
    positive: DALTON_BLUE,
    negative: DALTON_ORANGE,
    warning: WARN_AMBER,
    border: [40, 40, 45],
  },
  // Honors the terminal's own 16-color palette (RGB chosen to map cleanly to
  // the nearest named ANSI code by the engine's 16-color downsampler).
  ansi: {
    accent: [0, 170, 170], // cyan
    heading: [255, 255, 255], // bright white
    muted: [170, 170, 170], // white
    dimmed: [85, 85, 85], // bright black
    positive: [0, 170, 0], // green
    negative: [170, 0, 0], // red
    warning: [170, 85, 0], // yellow
    border: [85, 85, 85], // bright black
  },
}

export const DEFAULT_THEME: ThemeName = "terminal"

export function isThemeName(value: string): value is ThemeName {
  return value in THEMES
}

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[]
