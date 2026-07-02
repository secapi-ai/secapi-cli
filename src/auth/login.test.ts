import { describe, expect, test } from "bun:test"
import { buildLoginPlan } from "./login.ts"

const DEFAULT = "https://api.secapi.ai"

describe("buildLoginPlan", () => {
  test("defaults profile to 'default' and records the detected env var name", () => {
    const plan = buildLoginPlan({ apiKeyEnvSource: "SECAPI_API_KEY", stdin: false, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT })
    expect(plan).toEqual({ profile: "default", apiKeyEnv: "SECAPI_API_KEY", baseUrl: undefined, keyPresent: true, mode: "agent" })
  })

  test("uses the provided profile name and a non-default base URL", () => {
    const plan = buildLoginPlan({
      profileName: "prod",
      apiKeyEnvSource: "OMNI_OPERATOR_API_KEY",
      stdin: false,
      baseUrl: "http://127.0.0.1:8787",
      defaultBaseUrl: DEFAULT,
    })
    expect(plan.profile).toBe("prod")
    expect(plan.apiKeyEnv).toBe("OMNI_OPERATOR_API_KEY")
    expect(plan.baseUrl).toBe("http://127.0.0.1:8787")
  })

  test("records SECAPI_API_KEY by default when the key comes from stdin", () => {
    const plan = buildLoginPlan({ stdin: true, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT })
    expect(plan.apiKeyEnv).toBe("SECAPI_API_KEY")
    expect(plan.keyPresent).toBe(true)
  })

  test("stdin wins over a stale env source so verification and saved profile agree", () => {
    const plan = buildLoginPlan({ apiKeyEnvSource: "SECAPI_OPERATOR_API_KEY", stdin: true, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT })
    expect(plan.apiKeyEnv).toBe("SECAPI_API_KEY")
    expect(plan.keyPresent).toBe(true)
  })

  test("keyPresent is false when no env source and no stdin", () => {
    expect(buildLoginPlan({ stdin: false, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT }).keyPresent).toBe(false)
  })

  test("the recorded apiKeyEnv is always a name, never a value (env name in, env name out)", () => {
    // The plan only ever carries the SOURCE name it was given; it has no path to a secret.
    const plan = buildLoginPlan({ apiKeyEnvSource: "SECAPI_OPERATOR_API_KEY", stdin: false, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT })
    expect(plan.apiKeyEnv).toBe("SECAPI_OPERATOR_API_KEY")
  })
})

describe("login mode decision", () => {
  test("stdin is always agent mode, even on a TTY with forcePrompt set", () => {
    expect(buildLoginPlan({ stdin: true, isTty: true, forcePrompt: true, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT }).mode).toBe("agent")
  })

  test("non-TTY never prompts, even with no env source or forcePrompt", () => {
    expect(buildLoginPlan({ stdin: false, isTty: false, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT }).mode).toBe("agent")
    expect(buildLoginPlan({ stdin: false, isTty: false, forcePrompt: true, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT }).mode).toBe("agent")
  })

  test("--paste / --reonboard forces the prompt on a TTY even when an env key exists", () => {
    const plan = buildLoginPlan({ apiKeyEnvSource: "SECAPI_API_KEY", stdin: false, isTty: true, forcePrompt: true, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT })
    expect(plan.mode).toBe("paste")
  })

  test("--paste always records SECAPI_API_KEY, never a stale apiKeyEnvSource (verified credential and saved profile must agree)", () => {
    // Regression: a paste against a DIFFERENT env var name used to save a
    // profile pointing at the OLD (stale) source, even though the just-typed
    // key — not that env var — is what verified via me().
    const plan = buildLoginPlan({ apiKeyEnvSource: "OMNI_OPERATOR_API_KEY", stdin: false, isTty: true, forcePrompt: true, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT })
    expect(plan.mode).toBe("paste")
    expect(plan.apiKeyEnv).toBe("SECAPI_API_KEY")
  })

  test("human mode (no env key at all) also records SECAPI_API_KEY", () => {
    const plan = buildLoginPlan({ stdin: false, isTty: true, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT })
    expect(plan.mode).toBe("human")
    expect(plan.apiKeyEnv).toBe("SECAPI_API_KEY")
  })

  test("an env key on a TTY with no forcePrompt is agent mode (no unnecessary prompt)", () => {
    const plan = buildLoginPlan({ apiKeyEnvSource: "SECAPI_API_KEY", stdin: false, isTty: true, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT })
    expect(plan.mode).toBe("agent")
  })

  test("no env key on a TTY falls back to human mode", () => {
    const plan = buildLoginPlan({ stdin: false, isTty: true, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT })
    expect(plan.mode).toBe("human")
  })
})
