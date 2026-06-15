#!/usr/bin/env node
import { readFileSync } from "node:fs"
import {
  AGENT_PROMPT_LIBRARY,
  AGENT_PROMPT_PERSONAS,
  PERSONA_DISPLAY,
  getPrompt,
  listPromptsByPersona,
  type AgentPrompt,
  type AgentPromptPersona,
} from "./generated-contracts/agent-prompts.js"
import { SecApiClient } from "@secapi/sdk-js"

const args = process.argv.slice(2)
const baseUrl = envCredential("SECAPI_BASE_URL", "SECAPI_API_BASE_URL", "OMNI_DATASTREAM_BASE_URL", "OMNI_DATASTREAM_API_BASE_URL") ?? "https://api.secapi.ai"
const STDIN_FLAG_NAME = "--api-key-stdin"
const STDIN_BEARER_FLAG_NAME = "--bearer-token-stdin"
const REJECTED_CREDENTIAL_FLAGS = new Set(["--api-key", "--bearer-token"])

// ANSI styling for human output. Gated by isTTY so pipes/redirects/CI emit plain text.
const TTY = process.stdout.isTTY === true
const BOLD = TTY ? "\x1b[1m" : ""
const DIM = TTY ? "\x1b[2m" : ""
const CYAN = TTY ? "\x1b[36m" : ""
const RESET = TTY ? "\x1b[0m" : ""

function isAgentPromptPersona(value: string): value is AgentPromptPersona {
  return (AGENT_PROMPT_PERSONAS as readonly string[]).includes(value)
}

function formatPersonasHuman() {
  console.log(`${BOLD}Available personas:${RESET}`)
  for (const slug of AGENT_PROMPT_PERSONAS) {
    const meta = PERSONA_DISPLAY[slug]
    console.log(`  ${CYAN}${meta.slug}${RESET}  ${BOLD}${meta.displayName}${RESET}`)
    console.log(`    ${DIM}${meta.summary}${RESET}`)
  }
  console.log("")
  console.log(`${DIM}Run 'secapi agents prompts list --persona <slug>' to see prompts for a persona. ${RESET}`)
}

function formatPromptsListHuman(persona: AgentPromptPersona | null, prompts: AgentPrompt[], totalCount: number) {
  if (persona) {
    const meta = PERSONA_DISPLAY[persona]
    console.log(`${BOLD}${meta.displayName}${RESET}  ${DIM}(${prompts.length} prompts · ${persona})${RESET}`)
    console.log(`${DIM}${meta.summary}${RESET}`)
    if (meta.framingNote) console.log(`${DIM}${meta.framingNote}${RESET}`)
    console.log("")
    for (const [i, p] of prompts.entries()) {
      const statusBadge = p.status === "v2-pending" ? `${DIM}[v2-pending]${RESET} ` : ""
      console.log(`${BOLD}${i + 1}. ${p.title}${RESET} ${statusBadge}${DIM}[${p.id}]${RESET}`)
      console.log(`   ${DIM}${p.category} · ${p.difficulty}${RESET}`)
      console.log(`   ${p.oneLiner}`)
      console.log(`   ${DIM}Tools:${RESET} ${CYAN}${p.expectedToolChain.map((s) => s.tool).join(" → ")}${RESET}`)
      console.log("")
    }
    console.log(`${DIM}Use 'secapi agents prompts read <id>' to see full prompt text.${RESET}`)
    console.log(`${DIM}Use 'secapi agents prompts copy <id>' to pipe a prompt body to clipboard.${RESET}`)
  } else {
    const totalLabel = prompts.length === totalCount
      ? `${prompts.length} entries`
      : `${prompts.length} of ${totalCount} entries`
    console.log(`${BOLD}Agent prompt library${RESET}  ${DIM}(${totalLabel} across ${AGENT_PROMPT_PERSONAS.length} personas)${RESET}`)
    console.log("")
    for (const slug of AGENT_PROMPT_PERSONAS) {
      const meta = PERSONA_DISPLAY[slug]
      const cohort = prompts.filter((p) => p.persona === slug)
      console.log(`${BOLD}${meta.displayName}${RESET}  ${DIM}(${cohort.length} · ${slug})${RESET}`)
      for (const p of cohort) {
        const statusBadge = p.status === "v2-pending" ? `${DIM}[v2]${RESET} ` : ""
        console.log(`  ${CYAN}${p.id}${RESET}  ${statusBadge}${p.title}`)
      }
      console.log("")
    }
    console.log(`${DIM}Filter with --persona <slug>. Read with 'secapi agents prompts read <id>'.${RESET}`)
  }
}

function formatPromptReadHuman(p: AgentPrompt) {
  const meta = PERSONA_DISPLAY[p.persona]
  const statusBadge = p.status === "v2-pending" ? ` ${DIM}[v2-pending]${RESET}` : ""
  console.log(`${BOLD}${p.title}${RESET}${statusBadge}`)
  console.log(`${DIM}${meta.displayName} · ${p.category} · ${p.difficulty} · ${p.id}${RESET}`)
  console.log("")
  console.log(`${DIM}${p.oneLiner}${RESET}`)
  console.log("")
  console.log(`${BOLD}Prompt${RESET}`)
  console.log("")
  for (const line of p.prompt.split("\n")) {
    console.log(`  ${line}`)
  }
  console.log("")
  console.log(`${BOLD}Expected tool chain${RESET}`)
  for (const [i, step] of p.expectedToolChain.entries()) {
    console.log(`  ${i + 1}. ${CYAN}${step.tool}${RESET}  ${DIM}${step.purpose}${RESET}`)
  }
  console.log("")
  console.log(`${BOLD}Expected output${RESET}`)
  console.log(`  ${p.expectedOutput}`)
  if (p.caveats && p.caveats.length > 0) {
    console.log("")
    console.log(`${BOLD}Caveats${RESET}`)
    for (const c of p.caveats) console.log(`  • ${c}`)
  }
  if (p.blockedBy && p.blockedBy.length > 0) {
    console.log("")
    console.log(`${BOLD}Blocked by${RESET} ${DIM}(v2-pending — ships when these merge)${RESET}`)
    for (const b of p.blockedBy) console.log(`  • ${b}`)
  }
  console.log("")
  console.log(`${DIM}Pipe to clipboard:${RESET} secapi agents prompts copy ${p.id} | pbcopy`)
}

function getFlag(name: string) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function hasFlag(name: string) {
  return args.includes(name)
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

function printRaw(value: string) {
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`)
}

function getNumberFlag(name: string) {
  const raw = getFlag(name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be numeric`)
  }
  return value
}

function getNullableIntegerFlag(name: string) {
  const raw = getFlag(name)
  if (raw === undefined) return undefined
  if (raw === "null") return null
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer or 'null'`)
  }
  return Math.trunc(value)
}

function getListFlag(name: string) {
  return getFlag(name)?.split(",").map((value) => value.trim()).filter(Boolean)
}

function getBooleanFlag(name: string) {
  if (!hasFlag(name)) return undefined
  const raw = getFlag(name)
  if (raw === undefined || raw.startsWith("--")) return true
  const normalized = raw.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  throw new Error(`${name} must be true or false`)
}

function parseJsonValue(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} must be valid JSON`)
  }
}

function getJsonInput(jsonFlag: string, fileFlag: string, label: string) {
  const inline = getFlag(jsonFlag)
  const file = getFlag(fileFlag)
  if (inline && file) throw new Error(`Use only one of ${jsonFlag} or ${fileFlag}`)
  if (inline) return parseJsonValue(inline, label)
  if (file) return parseJsonValue(readFileSync(file, "utf8"), label)
  return undefined
}

function getObjectInput(jsonFlag: string, fileFlag: string, label: string) {
  const value = getJsonInput(jsonFlag, fileFlag, label)
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function getArrayInput(jsonFlag: string, fileFlag: string, label: string) {
  const value = getJsonInput(jsonFlag, fileFlag, label)
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a JSON array`)
  }
  return value
}

function getRequiredHoldings() {
  const holdings = getArrayInput("--holdings-json", "--holdings-file", "holdings")
  if (!holdings) throw new Error("--holdings-json or --holdings-file is required")
  return holdings as Array<{ symbol: string; weight: number; shares?: number | null; costBasis?: number | null }>
}

function factorResponseParams() {
  return {
    response_mode: (getFlag("--response-mode") ?? getFlag("--view")) as any,
    include: getListFlag("--include") ?? getListFlag("--expand"),
  }
}

function factorKeySelectionParams() {
  return {
    keys: getListFlag("--keys") ?? getListFlag("--factors"),
    category: getFlag("--category"),
    window: getFlag("--window"),
    lookback: getFlag("--lookback"),
    ...factorResponseParams(),
  }
}

function portfolioWorkflowBody() {
  return {
    country: getFlag("--country"),
    lookback: getFlag("--lookback"),
    category: getFlag("--category"),
    keys: getListFlag("--keys") ?? getListFlag("--factors"),
    holdings: getRequiredHoldings(),
  }
}

type CliCredentials = {
  apiKey?: string
  bearerToken?: string
}

function rejectedCredentialFlag(arg: string) {
  const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
  return REJECTED_CREDENTIAL_FLAGS.has(flag) ? flag : null
}

function rejectCredentialArgvFlags() {
  for (const arg of args) {
    const flag = rejectedCredentialFlag(arg)
    if (!flag) continue

    const envName = flag === "--api-key"
      ? "SECAPI_API_KEY, SECAPI_OPERATOR_API_KEY, OMNI_DATASTREAM_API_KEY, OMNI_OPERATOR_API_KEY, or OMNI_DATASTREAM_OPERATOR_API_KEY"
      : "SECAPI_BEARER_TOKEN or OMNI_DATASTREAM_BEARER_TOKEN"
    const stdinFlag = flag === "--api-key" ? STDIN_FLAG_NAME : STDIN_BEARER_FLAG_NAME
    throw new Error(
      `${flag} is no longer supported because argv credentials leak through shell history and process listings. ` +
      `Set ${envName}, or pipe the credential through ${stdinFlag}.`,
    )
  }

  for (const flag of [STDIN_FLAG_NAME, STDIN_BEARER_FLAG_NAME]) {
    if (args.some((arg) => arg.startsWith(`${flag}=`))) {
      throw new Error(`${flag} does not accept a value. Pipe the credential through stdin instead.`)
    }
  }
}

function envCredential(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

async function readCredentialFromStdin(flag: string) {
  if (process.stdin.isTTY) {
    throw new Error(`${flag} requires a piped credential on stdin`)
  }

  let data = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) {
    data += chunk
  }

  const credential = data.trim()
  if (!credential) {
    throw new Error(`${flag} received an empty credential from stdin`)
  }
  return credential
}

async function resolveCredentials(): Promise<CliCredentials> {
  const apiKeyFromStdin = hasFlag(STDIN_FLAG_NAME)
  const bearerTokenFromStdin = hasFlag(STDIN_BEARER_FLAG_NAME)
  if (apiKeyFromStdin && bearerTokenFromStdin) {
    throw new Error(`Use only one stdin credential option per invocation: ${STDIN_FLAG_NAME} or ${STDIN_BEARER_FLAG_NAME}`)
  }

  const stdinCredential = apiKeyFromStdin || bearerTokenFromStdin
    ? await readCredentialFromStdin(apiKeyFromStdin ? STDIN_FLAG_NAME : STDIN_BEARER_FLAG_NAME)
    : undefined

  return {
    apiKey: apiKeyFromStdin ? stdinCredential : envCredential(
      "SECAPI_OPERATOR_API_KEY",
      "SECAPI_API_KEY",
      "OMNI_OPERATOR_API_KEY",
      "OMNI_DATASTREAM_OPERATOR_API_KEY",
      "OMNI_DATASTREAM_API_KEY",
    ),
    bearerToken: bearerTokenFromStdin ? stdinCredential : envCredential("SECAPI_BEARER_TOKEN", "OMNI_DATASTREAM_BEARER_TOKEN"),
  }
}

function defaultClient(credentials: CliCredentials) {
  return new SecApiClient({
    apiKey: credentials.apiKey,
    bearerToken: credentials.bearerToken,
    baseUrl,
  })
}

function humanClient(credentials: CliCredentials) {
  const bearerToken = credentials.bearerToken
  if (!bearerToken) {
    throw new Error(`Bearer-authenticated commands require SECAPI_BEARER_TOKEN, OMNI_DATASTREAM_BEARER_TOKEN, or ${STDIN_BEARER_FLAG_NAME}`)
  }
  return new SecApiClient({
    bearerToken,
    baseUrl,
  })
}

function cliVersion(): string {
  // dist/index.js sits one level below the published package root, so package.json
  // resolves via ../package.json. In-repo (src/index.ts) it resolves via ../package.json too.
  try {
    const pkgUrl = new URL("../package.json", import.meta.url)
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string }
    if (typeof pkg.version === "string" && pkg.version) return pkg.version
  } catch {
    // fall through to unknown
  }
  return "unknown"
}

async function main() {
  rejectCredentialArgvFlags()

  // --version / -v must short-circuit before help fallback so they print the bare
  // version rather than the full command banner.
  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    printRaw(cliVersion())
    return
  }

  const credentials = await resolveCredentials()
  const [group = "help", command = ""] = args
  const apiClient = defaultClient(credentials)
  const anonymousClient = new SecApiClient({ baseUrl })

  if (group === "health") {
    print(await apiClient.health())
    return
  }

  if (group === "me") {
    print(await apiClient.me())
    return
  }

  if (group === "org" && command === "show") {
    print(await apiClient.org())
    return
  }

  if (group === "billing" && command === "show") {
    print(await apiClient.billing())
    return
  }

  if (group === "dashboard" && command === "overview") {
    print(await apiClient.dashboardOverview())
    return
  }

  if (group === "api-keys" && command === "list") {
    print(await apiClient.listApiKeys())
    return
  }

  if (group === "usage" && command === "show") {
    print(await apiClient.usage())
    return
  }

  if (group === "limits" && command === "show") {
    print(await apiClient.limits())
    return
  }

  if (group === "events" && command === "list") {
    print(await apiClient.events({
      kind: getFlag("--kind"),
      type: getFlag("--type"),
      requestId: getFlag("--request-id"),
      since: getFlag("--since"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "events" && command === "export") {
    print(await apiClient.exportEvents({
      kind: getFlag("--kind"),
      type: getFlag("--type"),
      requestId: getFlag("--request-id"),
      since: getFlag("--since"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      format: getFlag("--format") === "ndjson" ? "ndjson" : "json",
    }))
    return
  }

  if (group === "diagnostics" && command === "request") {
    const requestId = getFlag("--request-id")
    if (!requestId) throw new Error("--request-id is required")
    print(await apiClient.requestDiagnostics(requestId))
    return
  }

  if (group === "diagnostics" && command === "deliveries-summary") {
    print(await apiClient.deliverySummary({
      since: getFlag("--since"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "admin" && command === "orgs") {
    print(await apiClient.listAdminOrganizations({
      q: getFlag("--q"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "admin" && command === "org") {
    const orgId = getFlag("--org-id")
    if (!orgId) throw new Error("--org-id is required")
    print(await apiClient.getAdminOrganization(orgId, {
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "admin" && command === "request") {
    const orgId = getFlag("--org-id")
    const requestId = getFlag("--request-id")
    if (!orgId) throw new Error("--org-id is required")
    if (!requestId) throw new Error("--request-id is required")
    print(await apiClient.getAdminRequestDiagnostics(orgId, requestId))
    return
  }

  if (group === "admin" && command === "deliveries-summary") {
    const orgId = getFlag("--org-id")
    if (!orgId) throw new Error("--org-id is required")
    print(await apiClient.getAdminDeliverySummary(orgId, {
      since: getFlag("--since"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "observability" && command === "show") {
    print(await apiClient.observability())
    return
  }

  if (group === "observability" && command === "export") {
    print(await apiClient.exportObservability({
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "api-keys" && command === "create") {
    print(await apiClient.createApiKey({
      label: getFlag("--label"),
      scopes: getListFlag("--scopes"),
      livemode: hasFlag("--live"),
    }))
    return
  }

  if (group === "agent" && command === "bootstrap-token") {
    print(await humanClient(credentials).createAgentBootstrapToken({
      label: getFlag("--label"),
      scopes: getListFlag("--scopes"),
      ttlSeconds: getNumberFlag("--ttl-seconds"),
    }))
    return
  }

  if (group === "agent" && command === "bootstrap") {
    const token = getFlag("--token")
    if (!token) throw new Error("--token is required")
    print(await anonymousClient.bootstrapAgent({
      token,
      label: getFlag("--label"),
      scopes: getListFlag("--scopes"),
    }))
    return
  }

  // --- Agents (plural) namespace — prompt library (OMNI-3085) ---
  // Sibling to the singular `agent` namespace above (which handles bootstrap tokens).
  // The plural form was committed in docs/strategy/traction-dilution-epic.md as the
  // canonical location for the persona prompt library; the singular bootstrap
  // namespace is preserved unchanged.
  if (group === "agents" && command === "personas") {
    if (hasFlag("--json")) {
      print({
        object: "agent_prompt_personas",
        personas: AGENT_PROMPT_PERSONAS.map((slug) => PERSONA_DISPLAY[slug]),
      })
    } else {
      formatPersonasHuman()
    }
    return
  }

  if (group === "agents" && command === "prompts") {
    const subverb = args[2]
    if (!subverb || subverb.startsWith("-")) {
      throw new Error("Usage: secapi agents prompts <list|read|copy> [...]")
    }

    if (subverb === "list") {
      const personaFlag = getFlag("--persona")
      const includeV2 = hasFlag("--include-v2")
      const jsonMode = hasFlag("--json")

      let persona: AgentPromptPersona | null = null
      if (personaFlag !== undefined) {
        if (!isAgentPromptPersona(personaFlag)) {
          throw new Error(
            `Unknown persona '${personaFlag}'. Valid: ${AGENT_PROMPT_PERSONAS.join(", ")}`,
          )
        }
        persona = personaFlag
      }

      const prompts = persona
        ? listPromptsByPersona(persona, { includeV2Pending: includeV2 })
        : (includeV2
            ? [...AGENT_PROMPT_LIBRARY]
            : AGENT_PROMPT_LIBRARY.filter((p) => p.status === "v1"))

      if (jsonMode) {
        print({
          object: "agent_prompt_library",
          persona,
          includeV2Pending: includeV2,
          count: prompts.length,
          totalLibraryCount: AGENT_PROMPT_LIBRARY.length,
          prompts,
        })
      } else {
        formatPromptsListHuman(persona, prompts, AGENT_PROMPT_LIBRARY.length)
      }
      return
    }

    if (subverb === "read") {
      const id = args[3]
      if (!id || id.startsWith("-")) {
        throw new Error(
          "Usage: secapi agents prompts read <id>. Run 'secapi agents prompts list' to see IDs. ",
        )
      }
      const prompt = getPrompt(id)
      if (!prompt) {
        throw new Error(
          `Unknown prompt id '${id}'. Run 'secapi agents prompts list --include-v2' to see all available IDs.`,
        )
      }
      if (hasFlag("--json")) {
        print({ object: "agent_prompt", ...prompt })
      } else {
        formatPromptReadHuman(prompt)
      }
      return
    }

    if (subverb === "copy") {
      const id = args[3]
      if (!id || id.startsWith("-")) {
        throw new Error(
          "Usage: secapi agents prompts copy <id>. Pipe to clipboard via | pbcopy (macOS), | xclip -selection clipboard (Linux), or | clip (Windows). ",
        )
      }
      const prompt = getPrompt(id)
      if (!prompt) {
        throw new Error(
          `Unknown prompt id '${id}'. Run 'secapi agents prompts list --include-v2' to see all available IDs.`,
        )
      }
      // Bare prompt body to stdout — no decoration, no metadata, no trailing newline manipulation.
      // Caller pipes to pbcopy/xclip/clip.
      process.stdout.write(prompt.prompt)
      return
    }

    throw new Error(
      `Unknown 'agents prompts' subverb '${subverb}'. Valid: list, read, copy.`,
    )
  }

  if (group === "billing" && command === "quote") {
    print(await apiClient.quoteBilling({
      planKey: getFlag("--plan"),
      meterClass: getFlag("--meter-class"),
      path: getFlag("--path"),
      method: getFlag("--method"),
      units: getNumberFlag("--units"),
    }))
    return
  }

  if (group === "billing" && command === "budget") {
    print(await apiClient.updateBillingBudget({
      spendCapCents: getNullableIntegerFlag("--spend-cap-cents"),
      softCapCents: getNullableIntegerFlag("--soft-cap-cents"),
      approvalThresholdCents: getNullableIntegerFlag("--approval-threshold-cents"),
    }))
    return
  }

  if (group === "billing" && command === "checkout") {
    const planKey = getFlag("--plan")
    if (!planKey) throw new Error("--plan is required")
    print(await apiClient.createCheckoutSession({
      planKey,
      successUrl: getFlag("--success-url"),
      cancelUrl: getFlag("--cancel-url"),
    }))
    return
  }

  if (group === "billing" && command === "portal") {
    print(await apiClient.createBillingPortalSession({
      returnUrl: getFlag("--return-url"),
    }))
    return
  }

  if (group === "webhooks" && command === "list") {
    print(await apiClient.listWebhookEndpoints())
    return
  }

  if (group === "webhooks" && command === "create") {
    const destinationUrl = getFlag("--destination-url")
    if (!destinationUrl) throw new Error("--destination-url is required")
    print(await apiClient.createWebhookEndpoint({
      destinationUrl,
      description: getFlag("--description"),
      subscribedEventTypes: getListFlag("--event-types"),
      livemode: hasFlag("--live"),
    }))
    return
  }

  if (group === "webhooks" && command === "rotate-secret") {
    const webhookId = getFlag("--webhook-id")
    if (!webhookId) throw new Error("--webhook-id is required")
    print(await apiClient.rotateWebhookEndpointSecret(webhookId))
    return
  }

  if (group === "webhooks" && command === "deliveries") {
    const webhookId = getFlag("--webhook-id")
    if (!webhookId) throw new Error("--webhook-id is required")
    print(await apiClient.listWebhookDeliveries(webhookId, {
      eventId: getFlag("--event-id"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "webhooks" && command === "replay-delivery") {
    const webhookId = getFlag("--webhook-id")
    const deliveryId = getFlag("--delivery-id")
    if (!webhookId) throw new Error("--webhook-id is required")
    if (!deliveryId) throw new Error("--delivery-id is required")
    print(await apiClient.replayWebhookDelivery(webhookId, deliveryId))
    return
  }

  if (group === "streams" && command === "list") {
    print(await apiClient.listStreamSubscriptions())
    return
  }

  if (group === "streams" && command === "create") {
    print(await apiClient.createStreamSubscription({
      description: getFlag("--description"),
      eventTypes: getListFlag("--event-types"),
      transport: getFlag("--transport") === "webhook_mirror" ? "webhook_mirror" : "poll",
      livemode: hasFlag("--live"),
    }))
    return
  }

  if (group === "streams" && command === "events") {
    const streamId = getFlag("--stream-id")
    if (!streamId) throw new Error("--stream-id is required")
    print(await apiClient.streamEvents(streamId, {
      cursor: getFlag("--cursor"),
      type: getFlag("--type"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "entities" && command === "resolve") {
    print(await apiClient.resolveEntity({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      name: getFlag("--name"),
    }))
    return
  }

  if (group === "filings" && command === "search") {
    print(await apiClient.searchFilings({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      form: getFlag("--form"),
      q: getFlag("--q"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "filings" && command === "latest") {
    print(await apiClient.latestFiling({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      form: getFlag("--form") ?? "10-K",
    }))
    return
  }

  if (group === "filings" && command === "render") {
    print(await apiClient.renderLatestFiling({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      form: getFlag("--form") ?? "10-K",
    }))
    return
  }

  if (group === "sections" && command === "search") {
    print(await apiClient.searchSections({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      form: getFlag("--form"),
      q: getFlag("--q"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "search" && command === "fulltext") {
    const q = getFlag("--q") ?? getFlag("--query")
    if (!q) throw new Error("--q or --query is required")
    print(await apiClient.searchFulltext({
      q,
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      form: getFlag("--form"),
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "search" && command === "semantic") {
    const q = getFlag("--q") ?? getFlag("--query")
    if (!q) throw new Error("--q or --query is required")
    print(await apiClient.semanticSearch({
      q,
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      form: getFlag("--form"),
      filing_year: getNumberFlag("--filing-year"),
      mode: getFlag("--mode") as "keyword" | "semantic" | "hybrid" | undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "sections" && command === "get") {
    print(await apiClient.latestSection({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      form: getFlag("--form") ?? "10-K",
      sectionKey: getFlag("--section") ?? "item_1a",
      mode: getFlag("--mode") === "compact" ? "compact" : getFlag("--mode") === "full" ? "full" : undefined,
    }))
    return
  }

  if (group === "facts" && command === "get") {
    const tag = getFlag("--tag")
    if (!tag) throw new Error("--tag is required")
    print(await apiClient.facts({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      taxonomy: getFlag("--taxonomy") ?? "us-gaap",
      tag,
      unit: getFlag("--unit"),
      form: getFlag("--form"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "statements" && command === "get") {
    print(await apiClient.statementByKey(getFlag("--statement") ?? "balance_sheet", {
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      period: getFlag("--period") === "quarterly" ? "quarterly" : "annual",
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "owners" && command === "13f") {
    const cik = getFlag("--cik")
    if (!cik) throw new Error("--cik is required")
    print(await apiClient.latest13F({
      cik,
      reportDate: getFlag("--report-date") ?? undefined,
      filingDate: getFlag("--filing-date") ?? undefined,
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "owners" && command === "compare-13f") {
    const cik = getFlag("--cik")
    if (!cik) throw new Error("--cik is required")
    print(await apiClient.compare13F({
      cik,
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "insiders" && command === "list") {
    print(await apiClient.insiders({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "compensation" && command === "list") {
    print(await apiClient.compensation({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "forms" && command === "144") {
    print(await apiClient.form144Filings({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      date_from: getFlag("--date-from") ?? undefined,
      date_to: getFlag("--date-to") ?? undefined,
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "offerings" && command === "list") {
    print(await apiClient.offerings({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      date_from: getFlag("--date-from") ?? undefined,
      date_to: getFlag("--date-to") ?? undefined,
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "events" && command === "ma") {
    print(await apiClient.maEvents({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      date_from: getFlag("--date-from") ?? undefined,
      date_to: getFlag("--date-to") ?? undefined,
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "events" && command === "enforcement") {
    print(await apiClient.enforcementActions({
      query: getFlag("--query") ?? undefined,
      source_type: (getFlag("--source-type") as any) ?? undefined,
      date_from: getFlag("--date-from") ?? undefined,
      date_to: getFlag("--date-to") ?? undefined,
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "events" && command === "voting-results") {
    print(await apiClient.votingResultsEvents({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      date_from: getFlag("--date-from") ?? undefined,
      date_to: getFlag("--date-to") ?? undefined,
      meeting_type: (getFlag("--meeting-type") as any) ?? undefined,
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getFlag("--view") as any,
    }))
    return
  }

  // Dilution commands (OMNI-3091). All accept --view agent except `coverage`.
  if (group === "dilution" && command === "events") {
    const isAtmRaw = getFlag("--is-atm")
    print(await apiClient.dilutionEvents({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      accession_number: getFlag("--accession-number") ?? undefined,
      form_type: getFlag("--form-type") ?? undefined,
      offering_type: getFlag("--offering-type") ?? undefined,
      is_atm: isAtmRaw === undefined ? undefined : isAtmRaw === "true",
      filed_at_from: getFlag("--filed-at-from") ?? undefined,
      filed_at_to: getFlag("--filed-at-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "event") {
    const eventId = getFlag("--event-id")
    if (!eventId) throw new Error("Usage: secapi dilution event --event-id <id> [--view agent]")
    print(await apiClient.dilutionEventDetail(eventId, { view: getFlag("--view") as any }))
    return
  }

  if (group === "dilution" && command === "warrants") {
    print(await apiClient.dilutionWarrants({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      accession_number: getFlag("--accession-number") ?? undefined,
      form_type: getFlag("--form-type") ?? undefined,
      filed_at_from: getFlag("--filed-at-from") ?? undefined,
      filed_at_to: getFlag("--filed-at-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "convertibles") {
    print(await apiClient.dilutionConvertibles({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      accession_number: getFlag("--accession-number") ?? undefined,
      form_type: getFlag("--form-type") ?? undefined,
      filed_at_from: getFlag("--filed-at-from") ?? undefined,
      filed_at_to: getFlag("--filed-at-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "rofr") {
    print(await apiClient.dilutionRofr({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      accession_number: getFlag("--accession-number") ?? undefined,
      form_type: getFlag("--form-type") ?? undefined,
      filed_at_from: getFlag("--filed-at-from") ?? undefined,
      filed_at_to: getFlag("--filed-at-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "lockups") {
    print(await apiClient.dilutionLockups({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      accession_number: getFlag("--accession-number") ?? undefined,
      form_type: getFlag("--form-type") ?? undefined,
      filed_at_from: getFlag("--filed-at-from") ?? undefined,
      filed_at_to: getFlag("--filed-at-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "cash-position") {
    print(await apiClient.dilutionCashPosition({
      ticker: getFlag("--ticker"),
      period_ended_from: getFlag("--period-ended-from") ?? undefined,
      period_ended_to: getFlag("--period-ended-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "corporate-actions") {
    print(await apiClient.dilutionCorporateActions({
      ticker: getFlag("--ticker"),
      action_type: getFlag("--action-type") ?? undefined,
      effective_date_from: getFlag("--effective-date-from") ?? undefined,
      effective_date_to: getFlag("--effective-date-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "nasdaq-compliance") {
    print(await apiClient.dilutionNasdaqCompliance({
      ticker: getFlag("--ticker"),
      status: getFlag("--status") ?? undefined,
      date_from: getFlag("--date-from") ?? undefined,
      date_to: getFlag("--date-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "ratings") {
    print(await apiClient.dilutionRatings({
      ticker: getFlag("--ticker"),
      overall_risk: (getFlag("--overall-risk") as any) ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "reverse-splits") {
    print(await apiClient.dilutionReverseSplits({
      ticker: getFlag("--ticker"),
      execution_date_from: getFlag("--execution-date-from") ?? undefined,
      execution_date_to: getFlag("--execution-date-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "score") {
    const ticker = getFlag("--ticker")
    if (!ticker) throw new Error("Usage: secapi dilution score --ticker <symbol> [--view agent]")
    print(await apiClient.dilutionScore({ ticker, view: getFlag("--view") as any }))
    return
  }

  if (group === "dilution" && command === "share-float-history") {
    print(await apiClient.dilutionShareFloatHistory({
      ticker: getFlag("--ticker"),
      as_of_date_from: getFlag("--as-of-date-from") ?? undefined,
      as_of_date_to: getFlag("--as-of-date-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "dilution" && command === "coverage") {
    print(await apiClient.dilutionCoverage({ ticker: getFlag("--ticker") }))
    return
  }

  if (group === "funds" && command === "nport-holdings") {
    print(await apiClient.nportHoldings({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "companies" && command === "subsidiaries") {
    print(await apiClient.companySubsidiaries({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "compensation" && command === "compare") {
    print(await apiClient.compareCompensation({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "artifacts" && command === "bundle") {
    print(await apiClient.createArtifact({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      form: getFlag("--form") ?? "10-K",
      sectionKey: getFlag("--section") ?? "item_1a",
      kind: getFlag("--kind") ?? "markdown_bundle",
    }))
    return
  }

  if (group === "artifacts" && command === "list") {
    print(await apiClient.listArtifacts({
      kind: getFlag("--kind"),
      status: getFlag("--status"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
    }))
    return
  }

  if (group === "artifacts" && command === "summary") {
    print(await apiClient.artifactSummary())
    return
  }

  if (group === "artifacts" && command === "manifest") {
    const artifactId = getFlag("--artifact-id")
    if (!artifactId) {
      throw new Error("--artifact-id is required")
    }
    print(await apiClient.artifactManifest(artifactId))
    return
  }

  if (group === "artifacts" && command === "export") {
    const artifactId = getFlag("--artifact-id")
    if (!artifactId) {
      throw new Error("--artifact-id is required")
    }
    print(await apiClient.exportArtifact(artifactId, {
      format: getFlag("--format") === "markdown" ? "markdown" : "json",
    }))
    return
  }

  if (group === "artifacts" && command === "reconcile") {
    const artifactId = getFlag("--artifact-id")
    if (!artifactId) {
      throw new Error("--artifact-id is required")
    }
    print(await apiClient.reconcileArtifact(artifactId))
    return
  }

  // --- Macro commands ---
  if (group === "macro" && command === "high-signal-pack") {
    print(await apiClient.macroHighSignalPack({
      country: getFlag("--country"),
    }))
    return
  }

  if (group === "macro" && command === "regimes") {
    print(await apiClient.macroRegimes({
      country: getFlag("--country"),
      lookback: getFlag("--lookback"),
    }))
    return
  }

  if (group === "macro" && command === "indicators") {
    print(await apiClient.macroIndicators({
      country: getFlag("--country") ?? "US",
      indicator_key: getFlag("--indicator") ?? getFlag("--indicator-key") ?? "",
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "macro" && command === "releases") {
    print(await apiClient.macroReleases({
      country: getFlag("--country"),
      indicator_key: getFlag("--indicator") ?? getFlag("--indicator-key"),
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "macro" && command === "calendar") {
    print(await apiClient.macroCalendar({
      country: getFlag("--country"),
      days: getNumberFlag("--days"),
    }))
    return
  }

  if (group === "macro" && command === "forecasts") {
    print(await apiClient.macroForecasts({
      country: getFlag("--country"),
      indicator_key: getFlag("--indicator") ?? getFlag("--indicator-key"),
      horizons: getNumberFlag("--horizons"),
    }))
    return
  }

  if (group === "strategies" && command === "factor-rotation") {
    print(await apiClient.strategyFactorRotation({
      country: getFlag("--country"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "strategies" && command === "regime-screen") {
    print(await apiClient.strategyRegimeScreen({
      country: getFlag("--country"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  // --- Factor commands ---
  if (group === "factors" && command === "history") {
    const factorKey = getFlag("--factor") ?? getFlag("--factor-key") ?? getFlag("--key")
    if (!factorKey) throw new Error("--factor, --factor-key, or --key is required")
    const params = {
      range: getFlag("--range"),
      lookback: getFlag("--lookback"),
      window: getFlag("--window"),
      date_from: getFlag("--date-from") ?? getFlag("--date_from"),
      date_to: getFlag("--date-to") ?? getFlag("--date_to"),
      ...factorResponseParams(),
    }
    if (getFlag("--format") === "csv") printRaw(await apiClient.factorHistoryCsv(factorKey, params))
    else print(await apiClient.factorHistory(factorKey, params))
    return
  }

  if (group === "factors" && command === "sparklines") {
    const params = {
      ...factorKeySelectionParams(),
      range: getFlag("--range"),
      date_from: getFlag("--date-from") ?? getFlag("--date_from"),
      date_to: getFlag("--date-to") ?? getFlag("--date_to"),
      metric: getFlag("--metric") as any,
      points: getNumberFlag("--points") ?? getNumberFlag("--point-limit") ?? getNumberFlag("--pointLimit") ?? getNumberFlag("--point_limit"),
    }
    if (getFlag("--format") === "csv") printRaw(await apiClient.factorSparklinesCsv(params))
    else print(await apiClient.factorSparklines(params))
    return
  }

  if (group === "factors" && command === "returns-intraday") {
    print(await apiClient.factorReturnsIntraday({
      keys: getListFlag("--keys"),
      category: getFlag("--category"),
      window: getFlag("--window"),
    }))
    return
  }

  if (group === "factors" && command === "dashboard") {
    print(await apiClient.factorDashboard({
      country: getFlag("--country"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      limit: getNumberFlag("--limit"),
      ticker: getFlag("--ticker"),
      portfolioId: getFlag("--portfolio-id"),
      keys: getListFlag("--keys"),
      ...factorResponseParams(),
    }))
    return
  }

  if (group === "factors" && command === "screen") {
    print(await apiClient.factorScreen({
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "factors" && command === "extreme-moves") {
    print(await apiClient.factorExtremeMoves({
      keys: getListFlag("--keys"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      side: getFlag("--side") as any,
      direction: getFlag("--direction") as any,
      sort: getFlag("--sort") as any,
      min_z_score: getNumberFlag("--min-z-score") ?? getNumberFlag("--min_z_score"),
      minAbsZScore: getNumberFlag("--min-abs-z-score") ?? getNumberFlag("--minAbsZScore"),
      limit: getNumberFlag("--limit"),
      response_mode: getFlag("--response-mode") as any,
      include: getListFlag("--include"),
    }))
    return
  }

  if (group === "factors" && command === "extreme-pairs") {
    print(await apiClient.factorExtremePairs({
      keys: getListFlag("--keys"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      side: getFlag("--side") as any,
      direction: getFlag("--direction") as any,
      sort: getFlag("--sort") as any,
      min_z_score: getNumberFlag("--min-z-score") ?? getNumberFlag("--min_z_score"),
      minAbsZScore: getNumberFlag("--min-abs-z-score") ?? getNumberFlag("--minAbsZScore"),
      limit: getNumberFlag("--limit"),
      response_mode: getFlag("--response-mode") as any,
      include: getListFlag("--include"),
    }))
    return
  }

  if (group === "factors" && command === "valuations") {
    const params = {
      keys: getListFlag("--keys") ?? getListFlag("--factors"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      side: getFlag("--side") as any,
      signal: getFlag("--signal") as any,
      sort: getFlag("--sort") as any,
      weighting_mode: getFlag("--weighting-mode") as any,
      weighting: getFlag("--weighting") as any,
      limit: getNumberFlag("--limit"),
      response_mode: (getFlag("--response-mode") ?? getFlag("--view")) as any,
      include: getListFlag("--include") ?? getListFlag("--expand"),
    }
    if (getFlag("--format") === "csv") printRaw(await apiClient.factorValuationsCsv(params))
    else print(await apiClient.factorValuations(params))
    return
  }

  if (group === "factors" && command === "valuation-stocks") {
    const params = {
      factor: getFlag("--factor"),
      factorKey: getFlag("--factor-key") ?? getFlag("--factorKey"),
      key: getFlag("--key"),
      keys: getListFlag("--keys") ?? getListFlag("--factors"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      signal: getFlag("--signal") as any,
      weighting_mode: getFlag("--weighting-mode") as any,
      weighting: getFlag("--weighting") as any,
      stance: getFlag("--stance") as any,
      side: getFlag("--side") as any,
      direction: getFlag("--direction") as any,
      sort: getFlag("--sort") as any,
      limit: getNumberFlag("--limit"),
      response_mode: (getFlag("--response-mode") ?? getFlag("--view")) as any,
      include: getListFlag("--include") ?? getListFlag("--expand"),
    }
    if (getFlag("--format") === "csv") printRaw(await apiClient.factorValuationStocksCsv(params))
    else print(await apiClient.factorValuationStocks(params))
    return
  }

  if (group === "factors" && command === "pairs") {
    print(await apiClient.factorPairs({
      factor1: getFlag("--factor1"),
      factor2: getFlag("--factor2"),
      f1: getFlag("--f1"),
      f2: getFlag("--f2"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      response_mode: getFlag("--response-mode") as any,
      include: getListFlag("--include"),
    }))
    return
  }

  if (group === "factors" && command === "pair-history") {
    const f1 = getFlag("--factor1") ?? getFlag("--f1")
    const f2 = getFlag("--factor2") ?? getFlag("--f2")
    if (!f1 || !f2) throw new Error("--factor1/--f1 and --factor2/--f2 are required")
    print(await apiClient.factorPairHistory(f1, f2, {
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      range: getFlag("--range"),
      response_mode: getFlag("--response-mode") as any,
      include: getListFlag("--include"),
    }))
    return
  }

  if (group === "factors" && command === "decomposition") {
    const symbol = getFlag("--ticker") ?? getFlag("--symbol")
    if (!symbol) throw new Error("--ticker or --symbol is required")
    print(await apiClient.factorDecomposition({
      symbol,
      lookback: getFlag("--lookback"),
      window: getFlag("--window"),
    }))
    return
  }

  if (group === "factors" && command === "related-stocks") {
    const symbol = getFlag("--ticker") ?? getFlag("--symbol")
    if (!symbol) throw new Error("--ticker or --symbol is required")
    print(await apiClient.factorRelatedStocks({
      symbol,
      candidates: getListFlag("--candidates"),
      lookback: getFlag("--lookback"),
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "factors" && command === "similarity-pack") {
    const symbol = getFlag("--ticker") ?? getFlag("--symbol")
    if (!symbol) throw new Error("--ticker or --symbol is required")
    print(await apiClient.factorSimilarityPack({
      symbol,
      candidates: getListFlag("--candidates"),
      lookback: getFlag("--lookback"),
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "factors" && command === "catalog") {
    print(await apiClient.factorCatalog({
      category: getFlag("--category"),
      ...factorResponseParams(),
    }))
    return
  }

  if (group === "factors" && command === "returns") {
    print(await apiClient.factorReturns({
      keys: getListFlag("--keys"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
    }))
    return
  }

  if (group === "factors" && command === "exposures") {
    const symbols = getListFlag("--symbols") ?? getListFlag("--tickers")
    if (!symbols?.length) throw new Error("--symbols or --tickers is required")
    print(await apiClient.factorExposures({
      symbols,
      ...factorKeySelectionParams(),
      model: getFlag("--model") as any,
    } as any))
    return
  }

  if (group === "factors" && command === "bulk-download") {
    const params = factorKeySelectionParams()
    if (getFlag("--format") === "csv") printRaw(await apiClient.factorBulkDownloadCsv(params))
    else print(await apiClient.factorBulkDownload(params))
    return
  }

  if (group === "factors" && command === "custom") {
    const body = getObjectInput("--body-json", "--body-file", "custom factor request")
      ?? getObjectInput("--query-json", "--query-file", "custom factor request")
    if (!body) throw new Error("--body-json, --body-file, --query-json, or --query-file is required")
    print(await apiClient.factorCustom(body as any, factorResponseParams()))
    return
  }

  if (group === "factors" && command === "correlations") {
    print(await apiClient.factorCorrelations({
      keys: getListFlag("--keys"),
      category: getFlag("--category"),
      lookback: getFlag("--lookback"),
    }))
    return
  }

  if (group === "factors" && command === "regime-performance") {
    print(await apiClient.factorRegimePerformance({
      country: getFlag("--country"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  // --- Portfolio factor workflow commands ---
  if (group === "portfolio" && command === "analyze") {
    print(await apiClient.portfolioAnalyze({
      ...portfolioWorkflowBody(),
      benchmarkLabel: getFlag("--benchmark-label"),
      benchmarkHoldings: getArrayInput("--benchmark-holdings-json", "--benchmark-holdings-file", "benchmark holdings") as any,
      whatIfLabel: getFlag("--what-if-label"),
      whatIfHoldings: getArrayInput("--what-if-holdings-json", "--what-if-holdings-file", "what-if holdings") as any,
    }, factorResponseParams()))
    return
  }

  if (group === "portfolio" && command === "attribution") {
    print(await apiClient.portfolioAttribution({
      ...portfolioWorkflowBody(),
      window: getFlag("--window"),
      frequency: getFlag("--frequency") as any,
      exportFormat: getFlag("--export-format") as any,
    }, factorResponseParams()))
    return
  }

  if (group === "portfolio" && command === "hedge") {
    print(await apiClient.portfolioHedge({
      ...portfolioWorkflowBody(),
      objective: getFlag("--objective") as any,
      mode: getFlag("--mode") as any,
      constraints: getObjectInput("--constraints-json", "--constraints-file", "hedge constraints") as any,
    }, factorResponseParams()))
    return
  }

  if (group === "portfolio" && command === "optimize") {
    print(await apiClient.portfolioOptimize({
      ...portfolioWorkflowBody(),
      objective: getFlag("--objective") as any,
      maxHedges: getNumberFlag("--max-hedges") ?? getNumberFlag("--maxHedges"),
      constraints: getObjectInput("--constraints-json", "--constraints-file", "optimizer constraints") as any,
    }, factorResponseParams()))
    return
  }

  if (group === "portfolio" && command === "stress-test") {
    print(await apiClient.portfolioStressTest({
      ...portfolioWorkflowBody(),
      scenarioKey: getFlag("--scenario-key") as any,
    }, factorResponseParams()))
    return
  }

  // --- Stocks commands ---
  if (group === "stocks" && command === "loadings") {
    const ticker = getFlag("--ticker")
    if (!ticker) throw new Error("--ticker is required")
    print(await apiClient.stockLoadings(ticker, {
      keys: getListFlag("--keys"),
      category: getFlag("--category"),
      lookback: getFlag("--lookback"),
    }))
    return
  }

  // --- Model Portfolios commands ---
  if (group === "model-portfolios" && command === "factor-view") {
    const portfolioId = getFlag("--portfolio-id")
    if (!portfolioId) throw new Error("--portfolio-id is required")
    print(await apiClient.modelPortfolioFactorView(portfolioId, {
      keys: getListFlag("--keys"),
      category: getFlag("--category"),
      lookback: getFlag("--lookback"),
      ...factorResponseParams(),
    }))
    return
  }

  // --- Model factor workflow commands ---
  if (group === "models" && command === "factor-analysis") {
    const model = getObjectInput("--model-json", "--model-file", "model") ?? {
      id: getFlag("--model-id"),
      label: getFlag("--label"),
      source: getFlag("--source"),
    }
    print(await apiClient.modelFactorAnalysis({
      model: model as any,
      country: getFlag("--country"),
      lookback: getFlag("--lookback"),
      window: getFlag("--window"),
      category: getFlag("--category"),
      keys: getListFlag("--keys") ?? getListFlag("--factors"),
      include: {
        attribution: getBooleanFlag("--include-attribution"),
        hedge: getBooleanFlag("--include-hedge"),
        optimizer: getBooleanFlag("--include-optimizer"),
        positionViews: getBooleanFlag("--include-position-views"),
      },
      hedge: getObjectInput("--hedge-json", "--hedge-file", "hedge options") as any,
      optimizer: getObjectInput("--optimizer-json", "--optimizer-file", "optimizer options") as any,
      holdings: getRequiredHoldings(),
    }, factorResponseParams()))
    return
  }

  // --- Intelligence commands ---
  if (group === "intelligence" && command === "footnotes-query") {
    print(await apiClient.intelligenceFootnotesQuery({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      form: getFlag("--form"),
      query: getFlag("--q") ?? getFlag("--query"),
      topics: getListFlag("--topics") as any,
    }))
    return
  }

  if (group === "intelligence" && command === "security") {
    print(await apiClient.intelligenceSecurity({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "intelligence" && command === "company") {
    print(await apiClient.intelligenceCompany({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      view: getFlag("--view") as any,
    }))
    return
  }

  if (group === "intelligence" && command === "earnings-preview") {
    print(await apiClient.intelligenceEarningsPreview({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      view: getFlag("--view") as any,
    }))
    return
  }

  // --- Companies commands ---
  if (group === "companies" && command === "financials") {
    const ticker = getFlag("--ticker")
    if (!ticker) throw new Error("--ticker is required")
    print(await apiClient.companyFinancials({
      ticker,
      period: getFlag("--period") as any,
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "companies" && command === "ratios") {
    const ticker = getFlag("--ticker")
    if (!ticker) throw new Error("--ticker is required")
    print(await apiClient.companyRatios({
      ticker,
      period: getFlag("--period") as any,
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "companies" && command === "income-statements") {
    const ticker = getFlag("--ticker")
    if (!ticker) throw new Error("--ticker is required")
    print(await apiClient.companyIncomeStatements({
      ticker,
      period: getFlag("--period") as any,
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "companies" && command === "balance-sheets") {
    const ticker = getFlag("--ticker")
    if (!ticker) throw new Error("--ticker is required")
    print(await apiClient.companyBalanceSheets({
      ticker,
      period: getFlag("--period") as any,
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "companies" && command === "cash-flow-statements") {
    const ticker = getFlag("--ticker")
    if (!ticker) throw new Error("--ticker is required")
    print(await apiClient.companyCashFlowStatements({
      ticker,
      period: getFlag("--period") as any,
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "companies" && command === "resolve") {
    print(await apiClient.companyResolve({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      name: getFlag("--name"),
      figi: getFlag("--figi"),
      isin: getFlag("--isin"),
      cusip: getFlag("--cusip"),
      view: hasFlag("--compact") ? "compact" : undefined,
    }))
    return
  }

  if (group === "companies" && command === "search") {
    const q = getFlag("--q") ?? getFlag("--query")
    if (!q) throw new Error("--q or --query is required")
    print(await apiClient.companySearch({
      q,
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  const commandHelpLines = [
    "SEC API CLI",
    "Preferred binary: secapi",
    "Compatibility alias: omni-sec",
    "",
    "Commands:",
    "  secapi health",
    "  secapi me",
    "  secapi org show",
    "  secapi billing show",
    "  secapi dashboard overview",
    "  secapi billing quote --meter-class section_extract --units 10",
    "  secapi billing budget --spend-cap-cents 900 --soft-cap-cents 500 --approval-threshold-cents 750",
    "  secapi billing checkout --plan personal",
    "  secapi billing portal",
    "  secapi agent bootstrap-token --label ci --scopes read:sec --ttl-seconds 900",
    "  secapi agent bootstrap --token agbt_... --label first-agent-key",
    "",
    "  # Agent prompt library",
    "  secapi agents personas",
    "  secapi agents prompts list",
    "  secapi agents prompts list --persona law-firm",
    "  secapi agents prompts list --persona investment-manager --json",
    "  secapi agents prompts list --include-v2",
    "  secapi agents prompts read law-firm-enforcement-history",
    "  secapi agents prompts copy investment-manager-factor-decomposition | pbcopy",
    "  secapi api-keys list",
    "  SECAPI_API_KEY=... secapi api-keys list",
    "  SECAPI_OPERATOR_API_KEY=... secapi admin orgs --limit 20",
    "  OMNI_DATASTREAM_API_KEY=... omni-sec api-keys list  # compatibility env + binary alias",
    `  printf '%s' \"$SECAPI_API_KEY\" | secapi api-keys list ${STDIN_FLAG_NAME}`,
    "  secapi usage show",
    "  secapi limits show",
    "  secapi events list --kind event --limit 10",
    "  secapi events export --kind webhook_delivery --format json",
    "  secapi diagnostics request --request-id req_...",
    "  secapi diagnostics deliveries-summary --limit 50",
    "  secapi admin orgs --limit 20",
    "  secapi admin org --org-id org_...",
    "  secapi admin request --org-id org_... --request-id req_...",
    "  secapi admin deliveries-summary --org-id org_... --limit 20",
    "  secapi observability show",
    "  secapi observability export --limit 20",
    "  secapi api-keys create --label local-dev --scopes read:sec,write:artifacts",
    "  secapi webhooks list",
    "  secapi webhooks create --destination-url https://example.com/hooks/sec --event-types artifact.created,artifact.reconciled",
    "  secapi webhooks rotate-secret --webhook-id wh_...",
    "  secapi webhooks deliveries --webhook-id wh_... --limit 10",
    "  secapi webhooks replay-delivery --webhook-id wh_... --delivery-id wdel_...",
    "  secapi streams list",
    "  secapi streams create --event-types artifact.created,artifact.reconciled --transport poll",
    "  secapi streams events --stream-id strm_... --limit 10",
    "  secapi entities resolve --ticker AAPL",
    "  secapi filings search --ticker AAPL --form 10-K",
    "  secapi filings search --q risk factors --form 10-K",
    "  secapi filings latest --ticker AAPL --form 10-K",
    "  secapi filings render --ticker AAPL --form 10-K",
    "  secapi sections search --ticker AAPL --q risk --form 10-K",
    "  secapi sections get --ticker AAPL --form 10-K --section item_1a",
    "  secapi search fulltext --q \"supply chain\" --form 10-K --limit 10",
    "  secapi search semantic --q \"revenue concentration risk\" --ticker AAPL --mode hybrid [--view agent]",
    "  secapi facts get --ticker AAPL --tag Assets --form 10-K",
    "  secapi statements get --ticker AAPL --statement balance_sheet --period annual",
    "  secapi owners 13f --cik 0001067983 --limit 25 [--view agent]",
    "  secapi owners compare-13f --cik 0001067983 --limit 25",
    "  secapi insiders list --ticker AAPL --limit 10 [--view agent]",
    "  secapi compensation list --ticker AAPL --limit 10 [--view agent]",
    "  secapi compensation compare --ticker AAPL --limit 10",
    "",
    "  # Agent-mode endpoints (add --view agent for compact shape)",
    "  secapi forms 144 --ticker AAPL --limit 10 [--view agent]",
    "  secapi offerings list --ticker NVDA --limit 10 [--view agent]",
    "  secapi events ma --ticker MSFT --limit 10 [--view agent]",
    "  secapi events enforcement --query fraud --limit 10 [--view agent]",
    "  secapi events voting-results --ticker MSFT --limit 10 [--view agent]",
    "  secapi funds nport-holdings --ticker VTI --limit 25 [--view agent]",
    "  secapi companies subsidiaries --ticker AAPL [--view agent]",
    "",
    "  # Dilution endpoints — all support --view agent except `coverage`",
    "  secapi dilution events --ticker BBBB --is-atm true --limit 10 [--view agent]",
    "  secapi dilution event --event-id evt_... [--view agent]",
    "  secapi dilution warrants --ticker BBBB --limit 10 [--view agent]",
    "  secapi dilution convertibles --ticker BBBB --limit 10 [--view agent]",
    "  secapi dilution rofr --ticker BBBB --limit 10 [--view agent]",
    "  secapi dilution lockups --ticker BBBB --limit 10 [--view agent]",
    "  secapi dilution cash-position --ticker BBBB --limit 5 [--view agent]",
    "  secapi dilution corporate-actions --ticker BBBB --action-type reverse_split [--view agent]",
    "  secapi dilution nasdaq-compliance --status active --limit 10 [--view agent]",
    "  secapi dilution ratings --overall-risk high --limit 10 [--view agent]",
    "  secapi dilution reverse-splits --ticker BBBB --limit 5 [--view agent]",
    "  secapi dilution score --ticker BBBB [--view agent]",
    "  secapi dilution share-float-history --ticker BBBB --limit 12 [--view agent]",
    "  secapi dilution coverage [--ticker BBBB]",
    "  secapi artifacts bundle --ticker AAPL --form 10-K --section item_1a",
    "  secapi artifacts list --kind markdown_bundle --limit 10",
    "  secapi artifacts summary",
    "  secapi artifacts manifest --artifact-id art_...",
    "  secapi artifacts export --artifact-id art_... --format json",
    "  secapi artifacts reconcile --artifact-id art_...",
    "",
    "  # Macro",
    "  secapi macro high-signal-pack --country JP",
    "  secapi macro regimes --country US --lookback 18m",
    "  secapi macro indicators --country US --indicator GDP",
    "  secapi macro releases --country US",
    "  secapi macro calendar --country US --days 30",
    "  secapi macro forecasts --country US",
    "",
    "  # Factors",
    "  secapi factors catalog --category style",
    "  secapi factors returns --keys MOMENTUM,VALUE --window 1m",
    "  secapi factors history --factor VALUE --range 1y --include trust,series",
    "  secapi factors sparklines --keys MOMENTUM,VALUE --range 1y --points 64",
    "  secapi factors returns-intraday --window 1m",
    "  secapi factors dashboard --country US --category style --ticker AAPL",
    "  secapi factors screen --category style --limit 10",
    "  secapi factors extreme-moves --category style --window 1d --min-z-score 2 --limit 10",
    "  secapi factors extreme-pairs --category style --window 1m --min-z-score 1 --limit 10",
    "  secapi factors valuations --category style --signal tailwind --sort opportunity_score --limit 10",
    "  secapi factors valuation-stocks --factor VALUE --stance beneficiaries --limit 25",
    "  secapi factors pairs --factor1 VALUE --factor2 MOMENTUM --window 1m",
    "  secapi factors pair-history --factor1 VALUE --factor2 MOMENTUM --include series",
    "  secapi factors decomposition --ticker AAPL",
    "  secapi factors related-stocks --ticker AAPL --limit 10",
    "  secapi factors similarity-pack --ticker AAPL --limit 10",
    "  secapi factors exposures --symbols AAPL,MSFT --keys QUALITY,MOMENTUM",
    "  secapi factors bulk-download --keys VALUE,MOMENTUM --format csv",
    "  secapi factors custom --body-json '{\"symbol\":\"AAPL\",\"candidates\":[\"MSFT\"]}'",
    "  secapi factors correlations --keys MOMENTUM,VALUE",
    "  secapi factors regime-performance --country US",
    "",
    "  # Portfolio factor workflows",
    "  secapi portfolio analyze --holdings-json '[{\"symbol\":\"AAPL\",\"weight\":0.6},{\"symbol\":\"MSFT\",\"weight\":0.4}]'",
    "  secapi portfolio attribution --holdings-file holdings.json --window 1m --frequency weekly",
    "  secapi portfolio hedge --holdings-file holdings.json --objective min_drawdown --constraints-json '{\"maxHedges\":2}'",
    "  secapi portfolio optimize --holdings-file holdings.json --objective regime_aware --constraints-json '{\"maxCandidates\":3}'",
    "  secapi portfolio stress-test --holdings-file holdings.json --scenario-key higher_for_longer",
    "",
    "  # Factor strategies",
    "  secapi strategies factor-rotation --country US --category style --limit 5",
    "  secapi strategies regime-screen --country US --lookback 6m",
    "",
    "  # Stocks",
    "  secapi stocks loadings --ticker AAPL",
    "",
    "  # Model Portfolios",
    "  secapi model-portfolios factor-view --portfolio-id us_megacap_platforms",
    "  secapi models factor-analysis --holdings-file holdings.json --label 'AI leaders' --include-optimizer true",
    "",
    "  # Intelligence",
    "  secapi intelligence security --ticker AAPL",
    "  secapi intelligence company --ticker AAPL",
    "  secapi intelligence earnings-preview --ticker AAPL",
    "  secapi intelligence footnotes-query --ticker AAPL --topics lease,debt_covenant",
    "",
    "  # Companies (canonical financials)",
    "  secapi companies financials --ticker AAPL --period annual",
    "  secapi companies ratios --ticker AAPL --period annual",
    "  secapi companies income-statements --ticker AAPL",
    "  secapi companies balance-sheets --ticker AAPL",
    "  secapi companies cash-flow-statements --ticker AAPL",
    "  secapi companies resolve --ticker AAPL",
    "  secapi companies resolve --figi BBG000B9XRY4",
    "  secapi companies search --q Apple --limit 5",
    "",
    "Environment:",
    "  Preferred: SECAPI_API_KEY, SECAPI_BEARER_TOKEN, SECAPI_BASE_URL, SECAPI_API_BASE_URL, SECAPI_OPERATOR_API_KEY",
  ]
  console.log(commandHelpLines.map((line) => (
    line
  )).join("\n"))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
