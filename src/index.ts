#!/usr/bin/env node
import {
  AGENT_PROMPT_LIBRARY,
  AGENT_PROMPT_PERSONAS,
  PERSONA_DISPLAY,
  getPrompt,
  listPromptsByPersona,
  type AgentPrompt,
  type AgentPromptPersona,
} from "@omni-datastream/contracts"
import { SecApiClient } from "@secapi/sdk-js"

const args = process.argv.slice(2)
const baseUrl = envCredential("SECAPI_BASE_URL", "SECAPI_API_BASE_URL", "OMNI_DATASTREAM_BASE_URL") ?? "https://api.secapi.ai"
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
  console.log(`${DIM}Run 'secapi agents prompts list --persona <slug>' to see prompts for a persona. Legacy alias: omni-sec.${RESET}`)
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

async function main() {
  rejectCredentialArgvFlags()
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
      throw new Error("Usage: secapi agents prompts <list|read|copy> [...] (legacy alias: omni-sec)")
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
          "Usage: secapi agents prompts read <id>. Run 'secapi agents prompts list' to see IDs. Legacy alias: omni-sec.",
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
          "Usage: secapi agents prompts copy <id>. Pipe to clipboard via | pbcopy (macOS), | xclip -selection clipboard (Linux), or | clip (Windows). Legacy alias: omni-sec.",
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
    if (!eventId) throw new Error("Usage: secapi dilution event --event-id <id> [--view agent] (legacy alias: omni-sec)")
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
    if (!ticker) throw new Error("Usage: secapi dilution score --ticker <symbol> [--view agent] (legacy alias: omni-sec)")
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

  // --- Factor commands ---
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

  if (group === "factors" && command === "catalog") {
    print(await apiClient.factorCatalog({
      category: getFlag("--category"),
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
    }))
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
    "  omni-sec health",
    "  omni-sec me",
    "  omni-sec org show",
    "  omni-sec billing show",
    "  omni-sec dashboard overview",
    "  omni-sec billing quote --meter-class section_extract --units 10",
    "  omni-sec billing budget --spend-cap-cents 900 --soft-cap-cents 500 --approval-threshold-cents 750",
    "  omni-sec billing checkout --plan personal",
    "  omni-sec billing portal",
    "  omni-sec agent bootstrap-token --label ci --scopes read:sec --ttl-seconds 900",
    "  omni-sec agent bootstrap --token agbt_... --label first-agent-key",
    "",
    "  # Agent prompt library",
    "  omni-sec agents personas",
    "  omni-sec agents prompts list",
    "  omni-sec agents prompts list --persona law-firm",
    "  omni-sec agents prompts list --persona investment-manager --json",
    "  omni-sec agents prompts list --include-v2",
    "  omni-sec agents prompts read law-firm-enforcement-history",
    "  omni-sec agents prompts copy investment-manager-factor-decomposition | pbcopy",
    "  omni-sec api-keys list",
    "  SECAPI_API_KEY=... omni-sec api-keys list",
    "  SECAPI_OPERATOR_API_KEY=... omni-sec admin orgs --limit 20",
    "  OMNI_DATASTREAM_API_KEY=... omni-sec api-keys list  # legacy env fallback",
    `  printf '%s' \"$SECAPI_API_KEY\" | omni-sec api-keys list ${STDIN_FLAG_NAME}`,
    "  omni-sec usage show",
    "  omni-sec limits show",
    "  omni-sec events list --kind event --limit 10",
    "  omni-sec events export --kind webhook_delivery --format json",
    "  omni-sec diagnostics request --request-id req_...",
    "  omni-sec diagnostics deliveries-summary --limit 50",
    "  omni-sec admin orgs --limit 20",
    "  omni-sec admin org --org-id org_...",
    "  omni-sec admin request --org-id org_... --request-id req_...",
    "  omni-sec admin deliveries-summary --org-id org_... --limit 20",
    "  omni-sec observability show",
    "  omni-sec observability export --limit 20",
    "  omni-sec api-keys create --label local-dev --scopes read:sec,write:artifacts",
    "  omni-sec webhooks list",
    "  omni-sec webhooks create --destination-url https://example.com/hooks/sec --event-types artifact.created,artifact.reconciled",
    "  omni-sec webhooks rotate-secret --webhook-id wh_...",
    "  omni-sec webhooks deliveries --webhook-id wh_... --limit 10",
    "  omni-sec webhooks replay-delivery --webhook-id wh_... --delivery-id wdel_...",
    "  omni-sec streams list",
    "  omni-sec streams create --event-types artifact.created,artifact.reconciled --transport poll",
    "  omni-sec streams events --stream-id strm_... --limit 10",
    "  omni-sec entities resolve --ticker AAPL",
    "  omni-sec filings search --ticker AAPL --form 10-K",
    "  omni-sec filings search --q risk factors --form 10-K",
    "  omni-sec filings latest --ticker AAPL --form 10-K",
    "  omni-sec filings render --ticker AAPL --form 10-K",
    "  omni-sec sections search --ticker AAPL --q risk --form 10-K",
    "  omni-sec sections get --ticker AAPL --form 10-K --section item_1a",
    "  omni-sec facts get --ticker AAPL --tag Assets --form 10-K",
    "  omni-sec statements get --ticker AAPL --statement balance_sheet --period annual",
    "  omni-sec owners 13f --cik 0001067983 --limit 25 [--view agent]",
    "  omni-sec owners compare-13f --cik 0001067983 --limit 25",
    "  omni-sec insiders list --ticker AAPL --limit 10 [--view agent]",
    "  omni-sec compensation list --ticker AAPL --limit 10 [--view agent]",
    "  omni-sec compensation compare --ticker AAPL --limit 10",
    "",
    "  # Agent-mode endpoints (add --view agent for compact shape)",
    "  omni-sec forms 144 --ticker AAPL --limit 10 [--view agent]",
    "  omni-sec offerings list --ticker NVDA --limit 10 [--view agent]",
    "  omni-sec events ma --ticker MSFT --limit 10 [--view agent]",
    "  omni-sec events enforcement --query fraud --limit 10 [--view agent]",
    "  omni-sec events voting-results --ticker MSFT --limit 10 [--view agent]",
    "  omni-sec funds nport-holdings --ticker VTI --limit 25 [--view agent]",
    "  omni-sec companies subsidiaries --ticker AAPL [--view agent]",
    "",
    "  # Dilution endpoints — all support --view agent except `coverage`",
    "  omni-sec dilution events --ticker BBBB --is-atm true --limit 10 [--view agent]",
    "  omni-sec dilution event --event-id evt_... [--view agent]",
    "  omni-sec dilution warrants --ticker BBBB --limit 10 [--view agent]",
    "  omni-sec dilution convertibles --ticker BBBB --limit 10 [--view agent]",
    "  omni-sec dilution rofr --ticker BBBB --limit 10 [--view agent]",
    "  omni-sec dilution lockups --ticker BBBB --limit 10 [--view agent]",
    "  omni-sec dilution cash-position --ticker BBBB --limit 5 [--view agent]",
    "  omni-sec dilution corporate-actions --ticker BBBB --action-type reverse_split [--view agent]",
    "  omni-sec dilution nasdaq-compliance --status active --limit 10 [--view agent]",
    "  omni-sec dilution ratings --overall-risk high --limit 10 [--view agent]",
    "  omni-sec dilution reverse-splits --ticker BBBB --limit 5 [--view agent]",
    "  omni-sec dilution score --ticker BBBB [--view agent]",
    "  omni-sec dilution share-float-history --ticker BBBB --limit 12 [--view agent]",
    "  omni-sec dilution coverage [--ticker BBBB]",
    "  omni-sec artifacts bundle --ticker AAPL --form 10-K --section item_1a",
    "  omni-sec artifacts list --kind markdown_bundle --limit 10",
    "  omni-sec artifacts summary",
    "  omni-sec artifacts manifest --artifact-id art_...",
    "  omni-sec artifacts export --artifact-id art_... --format json",
    "  omni-sec artifacts reconcile --artifact-id art_...",
    "",
    "  # Macro",
    "  omni-sec macro high-signal-pack --country JP",
    "  omni-sec macro regimes --country US --lookback 18m",
    "  omni-sec macro indicators --country US --indicator GDP",
    "  omni-sec macro releases --country US",
    "  omni-sec macro calendar --country US --days 30",
    "  omni-sec macro forecasts --country US",
    "",
    "  # Factors",
    "  omni-sec factors catalog --category style",
    "  omni-sec factors returns --keys MOMENTUM,VALUE --window 1m",
    "  omni-sec factors returns-intraday --window 1m",
    "  omni-sec factors dashboard --country US --category style --ticker AAPL",
    "  omni-sec factors screen --category style --limit 10",
    "  omni-sec factors decomposition --ticker AAPL",
    "  omni-sec factors related-stocks --ticker AAPL --limit 10",
    "  omni-sec factors correlations --keys MOMENTUM,VALUE",
    "  omni-sec factors regime-performance --country US",
    "",
    "  # Stocks",
    "  omni-sec stocks loadings --ticker AAPL",
    "",
    "  # Model Portfolios",
    "  omni-sec model-portfolios factor-view --portfolio-id us_megacap_platforms",
    "",
    "  # Intelligence",
    "  omni-sec intelligence security --ticker AAPL",
    "  omni-sec intelligence company --ticker AAPL",
    "  omni-sec intelligence earnings-preview --ticker AAPL",
    "  omni-sec intelligence footnotes-query --ticker AAPL --topics lease,debt_covenant",
    "",
    "  # Companies (canonical financials)",
    "  omni-sec companies financials --ticker AAPL --period annual",
    "  omni-sec companies ratios --ticker AAPL --period annual",
    "  omni-sec companies income-statements --ticker AAPL",
    "  omni-sec companies balance-sheets --ticker AAPL",
    "  omni-sec companies cash-flow-statements --ticker AAPL",
    "  omni-sec companies resolve --ticker AAPL",
    "  omni-sec companies resolve --figi BBG000B9XRY4",
    "  omni-sec companies search --q Apple --limit 5",
    "",
    "Environment:",
    "  Preferred: SECAPI_API_KEY, SECAPI_BEARER_TOKEN, SECAPI_BASE_URL, SECAPI_API_BASE_URL, SECAPI_OPERATOR_API_KEY",
    "  Compatibility fallbacks: OMNI_DATASTREAM_API_KEY, OMNI_DATASTREAM_BEARER_TOKEN, OMNI_DATASTREAM_BASE_URL, OMNI_OPERATOR_API_KEY, OMNI_DATASTREAM_OPERATOR_API_KEY",
  ]
  console.log(commandHelpLines.map((line) => (
    line === "Compatibility alias: omni-sec" ? line : line.replace(/\bomni-sec\b/g, "secapi")
  )).join("\n"))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
