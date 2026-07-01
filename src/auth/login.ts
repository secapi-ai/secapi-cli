// `secapi login` decision logic — pure and unit-testable. The orchestration
// (verify via /v1/me, write the profile) lives in index.ts; this just decides
// WHAT to record. The cardinal rule: we persist the env-var NAME that holds the
// key, never the key itself.

export interface LoginPlanInput {
  /** Profile name to write (from --name / --profile), default "default". */
  profileName?: string
  /** The env var currently providing an API key (its NAME), if any. */
  apiKeyEnvSource?: string
  /** Whether a key is being piped via --api-key-stdin. */
  stdin: boolean
  /** Resolved base URL for this invocation. */
  baseUrl: string
  /** The CLI default base URL (omitted from the profile when unchanged). */
  defaultBaseUrl: string
}

export interface LoginPlan {
  profile: string
  /** The env var name to record in the profile (never a value). */
  apiKeyEnv: string
  /** Only set when the base URL differs from the default. */
  baseUrl?: string
  /** Whether a usable key is present (env var set or stdin). */
  keyPresent: boolean
}

export function buildLoginPlan(input: LoginPlanInput): LoginPlan {
  const profile = input.profileName?.trim() || "default"
  return {
    profile,
    apiKeyEnv: input.stdin ? "SECAPI_API_KEY" : input.apiKeyEnvSource ?? "SECAPI_API_KEY",
    baseUrl: input.baseUrl && input.baseUrl !== input.defaultBaseUrl ? input.baseUrl : undefined,
    keyPresent: Boolean(input.apiKeyEnvSource) || input.stdin,
  }
}

export const NO_KEY_MESSAGE =
  "No API key found. Set SECAPI_API_KEY (or another supported variable), or pipe one via --api-key-stdin, then run 'secapi login' again. Get a key at https://secapi.ai/app/api-keys."
