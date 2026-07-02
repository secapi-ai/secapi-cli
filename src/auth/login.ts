// `secapi login` decision logic — pure and unit-testable. The orchestration
// (verify via /v1/me, write the profile) lives in index.ts; this just decides
// WHAT to record. The cardinal rule: we persist the env-var NAME that holds the
// key, never the key itself.

// The plan's three modes (Claude Code / Grok-CLI-influenced): "agent" reads a
// credential the environment already provides (env var or --api-key-stdin) —
// zero prompts, safe for CI; "human" is the interactive fallback when nothing
// is found and we're on a real terminal — a masked paste prompt; "paste" is
// the same masked prompt, but explicitly requested (--paste / --reonboard)
// even when an env credential IS present, so the user can re-authenticate
// without touching their shell config.
export type LoginMode = "agent" | "human" | "paste"

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
  /** True only in a real interactive terminal (stdout && stdin TTY). */
  isTty?: boolean
  /** --paste / --reonboard: force the interactive masked-prompt flow. */
  forcePrompt?: boolean
}

export interface LoginPlan {
  profile: string
  /** The env var name to record in the profile (never a value). */
  apiKeyEnv: string
  /** Only set when the base URL differs from the default. */
  baseUrl?: string
  /** Whether a usable key is present (env var set or stdin). */
  keyPresent: boolean
  /** Which of the three login modes this invocation resolved to. */
  mode: LoginMode
}

function decideLoginMode(input: LoginPlanInput): LoginMode {
  // An explicit pipe always wins — it's an unambiguous, non-interactive signal.
  if (input.stdin) return "agent"
  // Non-TTY (CI/agent runners) never prompts, no matter what else is true.
  if (!input.isTty) return "agent"
  if (input.forcePrompt) return "paste"
  if (input.apiKeyEnvSource) return "agent"
  return "human"
}

export function buildLoginPlan(input: LoginPlanInput): LoginPlan {
  const profile = input.profileName?.trim() || "default"
  const mode = decideLoginMode(input)
  // Any freshly-supplied credential (a stdin pipe or an interactive paste) is
  // always recorded as SECAPI_API_KEY — the same env var we tell the user to
  // export — never a stale apiKeyEnvSource left over from a previous key.
  // Without this, --paste/--reonboard could verify a NEW key via me() but
  // save a profile that still points at the OLD env var, so the two silently
  // disagree.
  const freshCredential = input.stdin || mode === "human" || mode === "paste"
  return {
    profile,
    apiKeyEnv: freshCredential ? "SECAPI_API_KEY" : input.apiKeyEnvSource ?? "SECAPI_API_KEY",
    baseUrl: input.baseUrl && input.baseUrl !== input.defaultBaseUrl ? input.baseUrl : undefined,
    keyPresent: Boolean(input.apiKeyEnvSource) || input.stdin,
    mode,
  }
}

export const NO_KEY_MESSAGE =
  "No API key found. Set SECAPI_API_KEY (or another supported variable), or pipe one via --api-key-stdin, then run 'secapi login' again. Get a key at https://secapi.ai/app/api-keys."
