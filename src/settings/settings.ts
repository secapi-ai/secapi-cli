// Local CLI settings — cosmetics + safety preferences only, NEVER secrets.
//
// Two sources, project-over-global precedence (mirrors the existing base-url
// resolution): a global `~/.config/secapi/settings.json` (overridable via
// SECAPI_SETTINGS_FILE) and a per-repo `.secapi/settings.json` found by walking
// up from cwd. Both are validated to be secret-free: any credential-shaped
// string value is dropped with a warning, never stored or applied.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DEFAULT_THEME, isThemeName, type ThemeName } from "../theme/themes.ts"

export interface Settings {
  theme: ThemeName
  /** Accent override as #rrggbb (validated by the theme engine before use). */
  accent?: string
  /** Forward-compat preferences consumed by later phases (spinner/cost/etc.). */
  spinnerVerbs?: string[]
  defaultView?: string
  defaultResponseMode?: string
  telemetryOptOut?: boolean
}

export const DEFAULT_SETTINGS: Settings = { theme: DEFAULT_THEME }

// Reused secret shapes (kept in sync with index.ts redaction): API keys, bearer
// tokens, bootstrap tokens, webhook secrets, JWTs.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /secapi_(live|test|boot)_/i,
  /\bopr_[a-z0-9]/i,
  /\bods_[a-z0-9]/i,
  /\bagbt_[a-z0-9]/i,
  /\bwhsec_[a-z0-9]/i,
  /\beyJ[a-zA-Z0-9_-]{10,}\./, // JWT
  /bearer\s+[a-z0-9._-]{12,}/i,
]

export function looksCredentialShaped(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))
}

export interface ResolveResult {
  settings: Settings
  warnings: string[]
}

function coerce(raw: unknown, source: string, warnings: string[]): Partial<Settings> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== null) warnings.push(`Ignoring ${source}: expected a JSON object.`)
    return {}
  }
  const record = raw as Record<string, unknown>
  const out: Partial<Settings> = {}

  // Reject any credential-shaped string anywhere in the object (defense in depth).
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && looksCredentialShaped(value)) {
      warnings.push(`Ignoring ${source} key "${key}": looks like a secret. Settings never store credentials.`)
      delete record[key]
    }
  }

  if (typeof record.theme === "string") {
    if (isThemeName(record.theme)) out.theme = record.theme
    else warnings.push(`Ignoring ${source} theme "${record.theme}": unknown theme.`)
  }
  if (typeof record.accent === "string") out.accent = record.accent
  if (Array.isArray(record.spinnerVerbs) && record.spinnerVerbs.every((v) => typeof v === "string")) {
    out.spinnerVerbs = record.spinnerVerbs as string[]
  }
  if (typeof record.defaultView === "string") out.defaultView = record.defaultView
  if (typeof record.defaultResponseMode === "string") out.defaultResponseMode = record.defaultResponseMode
  if (typeof record.telemetryOptOut === "boolean") out.telemetryOptOut = record.telemetryOptOut
  return out
}

/** Pure resolver: merge global + project raw JSON strings into Settings. */
export function resolveSettings(globalRaw: string | null, projectRaw: string | null): ResolveResult {
  const warnings: string[] = []
  const parse = (raw: string | null, source: string): Partial<Settings> => {
    if (raw === null) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      warnings.push(`Ignoring ${source}: not valid JSON.`)
      return {}
    }
    return coerce(parsed, source, warnings)
  }
  const global = parse(globalRaw, "global settings")
  const project = parse(projectRaw, "project .secapi/settings.json")
  // Project overrides global; both override defaults.
  return { settings: { ...DEFAULT_SETTINGS, ...global, ...project }, warnings }
}

export function globalSettingsPath(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.SECAPI_SETTINGS_FILE?.trim()
  if (override) return override
  return join(home, ".config", "secapi", "settings.json")
}

/** Find the nearest `.secapi/settings.json` walking up from `startDir`. */
export function findProjectSettingsPath(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, ".secapi", "settings.json")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readIfExists(path: string | null): string | null {
  if (!path || !existsSync(path)) return null
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

export interface LoadSettingsOptions {
  env: NodeJS.ProcessEnv
  home: string
  cwd: string
}

export function loadSettings(options: LoadSettingsOptions): ResolveResult {
  const globalRaw = readIfExists(globalSettingsPath(options.env, options.home))
  const projectRaw = readIfExists(findProjectSettingsPath(options.cwd))
  return resolveSettings(globalRaw, projectRaw)
}

/**
 * Merge `patch` into the GLOBAL settings file and write it back (mode 0600).
 * Secret-shaped values are rejected before writing. Returns the written path
 * and merged settings. The project `.secapi/` file is never written by the CLI.
 */
export function saveGlobalSettings(
  options: { env: NodeJS.ProcessEnv; home: string },
  patch: Partial<Settings>,
): { path: string; settings: Settings } {
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "string" && looksCredentialShaped(value)) {
      throw new Error(`Refusing to write settings key "${key}": value looks like a secret.`)
    }
  }
  const path = globalSettingsPath(options.env, options.home)
  const existing = resolveSettings(readIfExists(path), null).settings
  const merged: Settings = { ...existing, ...patch }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return { path, settings: merged }
}
