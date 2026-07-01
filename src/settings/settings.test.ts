import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_SETTINGS,
  globalSettingsPath,
  looksCredentialShaped,
  resolveSettings,
  saveGlobalSettings,
} from "./settings.ts"

describe("resolveSettings", () => {
  test("returns defaults when both sources are absent", () => {
    expect(resolveSettings(null, null).settings).toEqual(DEFAULT_SETTINGS)
  })

  test("applies a valid global theme", () => {
    const { settings } = resolveSettings(JSON.stringify({ theme: "xai" }), null)
    expect(settings.theme).toBe("xai")
  })

  test("project settings override global", () => {
    const { settings } = resolveSettings(JSON.stringify({ theme: "xai" }), JSON.stringify({ theme: "light" }))
    expect(settings.theme).toBe("light")
  })

  test("invalid JSON is ignored with a warning, defaults preserved", () => {
    const { settings, warnings } = resolveSettings("{not json", null)
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(warnings.some((w) => w.includes("not valid JSON"))).toBe(true)
  })

  test("unknown theme is ignored with a warning", () => {
    const { settings, warnings } = resolveSettings(JSON.stringify({ theme: "neon" }), null)
    expect(settings.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(warnings.some((w) => w.includes("unknown theme"))).toBe(true)
  })

  test("credential-shaped values are dropped with a warning (never stored)", () => {
    const { settings, warnings } = resolveSettings(JSON.stringify({ theme: "xai", accent: "secapi_live_abc123" }), null)
    expect(settings.accent).toBeUndefined()
    expect(settings.theme).toBe("xai")
    expect(warnings.some((w) => w.toLowerCase().includes("secret"))).toBe(true)
  })

  test("passes through accent, spinnerVerbs, and telemetryOptOut", () => {
    const { settings } = resolveSettings(
      JSON.stringify({ accent: "#ff6308", spinnerVerbs: ["Reconciling"], telemetryOptOut: true }),
      null,
    )
    expect(settings.accent).toBe("#ff6308")
    expect(settings.spinnerVerbs).toEqual(["Reconciling"])
    expect(settings.telemetryOptOut).toBe(true)
  })
})

describe("looksCredentialShaped", () => {
  test("flags API keys, bootstrap tokens, webhook secrets, JWTs", () => {
    expect(looksCredentialShaped("secapi_live_xxxxxxxx")).toBe(true)
    expect(looksCredentialShaped("agbt_abcdef")).toBe(true)
    expect(looksCredentialShaped("whsec_abcdef")).toBe(true)
    expect(looksCredentialShaped("eyJhbGciOiJIUzI1Ni00.payload")).toBe(true)
  })
  test("does not flag ordinary values", () => {
    expect(looksCredentialShaped("xai")).toBe(false)
    expect(looksCredentialShaped("#ff6308")).toBe(false)
  })
})

describe("globalSettingsPath", () => {
  test("honors SECAPI_SETTINGS_FILE override", () => {
    expect(globalSettingsPath({ SECAPI_SETTINGS_FILE: "/tmp/x.json" } as NodeJS.ProcessEnv, "/home/u")).toBe("/tmp/x.json")
  })
  test("defaults to ~/.config/secapi/settings.json", () => {
    expect(globalSettingsPath({} as NodeJS.ProcessEnv, "/home/u")).toBe("/home/u/.config/secapi/settings.json")
  })
})

describe("saveGlobalSettings", () => {
  test("writes merged settings at mode 0600 and rejects secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-settings-"))
    const file = join(dir, "settings.json")
    try {
      const env = { SECAPI_SETTINGS_FILE: file } as NodeJS.ProcessEnv
      const { path, settings } = saveGlobalSettings({ env, home: dir }, { theme: "xai" })
      expect(path).toBe(file)
      expect(settings.theme).toBe("xai")
      expect(existsSync(file)).toBe(true)
      // 0600 (owner read/write only)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      // merge: a second save keeps prior keys
      saveGlobalSettings({ env, home: dir }, { accent: "#ff6308" })
      const written = JSON.parse(readFileSync(file, "utf8"))
      expect(written.theme).toBe("xai")
      expect(written.accent).toBe("#ff6308")
      // secret rejection
      expect(() => saveGlobalSettings({ env, home: dir }, { accent: "secapi_live_zzz" })).toThrow(/secret/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
