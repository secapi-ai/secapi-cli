import { describe, expect, test } from "bun:test"
import { buildLoginPlan } from "./login.ts"

const DEFAULT = "https://api.secapi.ai"

describe("buildLoginPlan", () => {
  test("defaults profile to 'default' and records the detected env var name", () => {
    const plan = buildLoginPlan({ apiKeyEnvSource: "SECAPI_API_KEY", stdin: false, baseUrl: DEFAULT, defaultBaseUrl: DEFAULT })
    expect(plan).toEqual({ profile: "default", apiKeyEnv: "SECAPI_API_KEY", baseUrl: undefined, keyPresent: true })
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
