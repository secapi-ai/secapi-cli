#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  AGENT_PROMPT_LIBRARY,
  AGENT_PROMPT_PERSONAS,
  PERSONA_DISPLAY,
  getPrompt,
  listPromptsByPersona,
  type AgentPrompt,
  type AgentPromptPersona,
} from "./generated-contracts/agent-prompts.js"
import { SecApiClient, type FactorApiResponseMode, type ResponseView } from "@secapi/sdk-js"

let args = process.argv.slice(2)
let baseUrl = "https://api.secapi.ai"
let baseUrlArg: string | undefined
let profileArg: string | undefined
const STDIN_FLAG_NAME = "--api-key-stdin"
const STDIN_BEARER_FLAG_NAME = "--bearer-token-stdin"
const REJECTED_CREDENTIAL_FLAGS = new Set(["--api-key", "--bearer-token"])
const API_KEY_ENV_NAMES = [
  "SECAPI_OPERATOR_API_KEY",
  "SECAPI_API_KEY",
  "OMNI_OPERATOR_API_KEY",
  "OMNI_DATASTREAM_OPERATOR_API_KEY",
  "OMNI_DATASTREAM_API_KEY",
] as const
const BEARER_ENV_NAMES = ["SECAPI_BEARER_TOKEN", "OMNI_DATASTREAM_BEARER_TOKEN"] as const
const BASE_URL_ENV_NAMES = ["SECAPI_BASE_URL", "SECAPI_API_BASE_URL", "OMNI_DATASTREAM_BASE_URL", "OMNI_DATASTREAM_API_BASE_URL"] as const
const PROFILE_ENV_NAME = "SECAPI_PROFILE"
const PROFILE_CONFIG_FILE_ENV_NAME = "SECAPI_CONFIG_FILE"

// ANSI styling for human output. Gated by isTTY so pipes/redirects/CI emit plain text.
const TTY = process.stdout.isTTY === true
const BOLD = TTY ? "\x1b[1m" : ""
const DIM = TTY ? "\x1b[2m" : ""
const CYAN = TTY ? "\x1b[36m" : ""
const RESET = TTY ? "\x1b[0m" : ""

type CliExample = {
  id: string
  title: string
  goal: string
  command: string
  auth: "none" | "api_key" | "optional_api_key"
  callsApi: boolean
  mutates: boolean
  expectedOutput: "json" | "text"
  files?: Array<{
    path: string
    description: string
    json: unknown
  }>
}

const CLI_EXAMPLES: CliExample[] = [
  {
    id: "diagnose-setup",
    title: "Diagnose local setup",
    goal: "Check the active API origin, credential source, health, account context, and hosted MCP URL without printing secrets.",
    command: "secapi doctor",
    auth: "optional_api_key",
    callsApi: true,
    mutates: false,
    expectedOutput: "json",
  },
  {
    id: "resolve-company",
    title: "Resolve a company",
    goal: "Map a ticker to canonical SEC API entity metadata before choosing a filing or financial-data workflow.",
    command: "secapi entities resolve --ticker AAPL",
    auth: "api_key",
    callsApi: true,
    mutates: false,
    expectedOutput: "json",
  },
  {
    id: "latest-10k",
    title: "Fetch the latest annual report",
    goal: "Retrieve the latest 10-K for a company and preserve accession, source URL, freshness, provenance, and trace fields.",
    command: "secapi filings latest --ticker AAPL --form 10-K",
    auth: "api_key",
    callsApi: true,
    mutates: false,
    expectedOutput: "json",
  },
  {
    id: "risk-section-agent-view",
    title: "Extract a risk section for an agent",
    goal: "Pull Item 1A in the agent response shape for downstream summarization or citation workflows.",
    command: "secapi sections get --ticker AAPL --form 10-K --section item_1a --view agent",
    auth: "api_key",
    callsApi: true,
    mutates: false,
    expectedOutput: "json",
  },
  {
    id: "fulltext-search",
    title: "Search filing text",
    goal: "Find filings that mention a theme or risk phrase before hydrating specific sections or traces.",
    command: "secapi search fulltext --q \"supply chain disruption\" --form 10-K --limit 10",
    auth: "api_key",
    callsApi: true,
    mutates: false,
    expectedOutput: "json",
  },
  {
    id: "agent-context",
    title: "Give an agent the CLI inventory",
    goal: "Export command groups, auth posture, mutation posture, required flags, output shapes, and examples for planning.",
    command: "secapi agent-context --output secapi-cli-context.json",
    auth: "none",
    callsApi: false,
    mutates: false,
    expectedOutput: "json",
  },
  {
    id: "portfolio-holdings-file",
    title: "Analyze a portfolio from a holdings file",
    goal: "Use reusable holdings and benchmark JSON files for factor exposure workflows instead of pasting JSON into the shell.",
    command: "secapi portfolio analyze --holdings-file holdings.json --benchmark-label SPY --benchmark-holdings-file benchmark.json --keys VALUE,QUALITY --response-mode compact",
    auth: "api_key",
    callsApi: true,
    mutates: false,
    expectedOutput: "json",
    files: [
      {
        path: "holdings.json",
        description: "Array of portfolio holdings with symbols and weights that sum to 1.0.",
        json: [
          { symbol: "AAPL", weight: 0.6 },
          { symbol: "MSFT", weight: 0.4 },
        ],
      },
      {
        path: "benchmark.json",
        description: "Benchmark holdings used for tilt and what-if comparisons.",
        json: [
          { symbol: "SPY", weight: 1 },
        ],
      },
    ],
  },
  {
    id: "model-factor-analysis-files",
    title: "Run model factor analysis from files",
    goal: "Keep holdings and model metadata in versioned JSON files for repeatable model-portfolio analysis.",
    command: "secapi models factor-analysis --holdings-file holdings.json --model-file model.json --include-optimizer true --response-mode compact",
    auth: "api_key",
    callsApi: true,
    mutates: false,
    expectedOutput: "json",
    files: [
      {
        path: "holdings.json",
        description: "Array of model holdings with symbols and target weights.",
        json: [
          { symbol: "AAPL", weight: 0.6 },
          { symbol: "MSFT", weight: 0.4 },
        ],
      },
      {
        path: "model.json",
        description: "Model metadata attached to the factor-analysis request.",
        json: {
          id: "growth-core",
          label: "Growth Core",
          source: "model_builder",
        },
      },
    ],
  },
]

function formatExamplesHuman() {
  const lines = [
    `${BOLD}SEC API CLI starter examples${RESET}`,
    `${DIM}Run 'secapi examples' for JSON that agents can parse.${RESET}`,
    "",
  ]
  for (const [index, example] of CLI_EXAMPLES.entries()) {
    const authLabel = example.auth === "none"
      ? "no auth"
      : example.auth === "optional_api_key"
        ? "optional SECAPI_API_KEY"
        : "SECAPI_API_KEY"
    const networkLabel = example.callsApi ? "calls API" : "local"
    lines.push(`${BOLD}${index + 1}. ${example.title}${RESET} ${DIM}(${authLabel}, ${networkLabel}, ${example.expectedOutput})${RESET}`)
    lines.push(`   ${example.goal}`)
    for (const file of example.files ?? []) {
      lines.push(`   ${DIM}Create ${file.path}:${RESET} ${JSON.stringify(file.json)}`)
    }
    lines.push(`   ${CYAN}${example.command}${RESET}`)
    lines.push("")
  }
  lines.push(`${DIM}Add --request-summary to API examples when you need request ids, trace context, or billing headers.${RESET}`)
  writeOutput(lines.join("\n"))
}

function printExamples() {
  if (readBooleanFlag("--json") === false) {
    formatExamplesHuman()
  } else {
    print({
      object: "secapi_cli_examples",
      examples: CLI_EXAMPLES,
      next: {
        localDiscovery: "secapi agent-context",
        diagnostics: "secapi doctor",
        requestMetadata: "Add --request-summary to API examples when you need request ids, trace context, or billing headers.",
      },
    })
  }
}

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

function assertUniqueFlag(name: string) {
  const count = args.filter((arg) => arg === name || arg.startsWith(`${name}=`)).length
  if (count > 1) {
    throw new Error(`${name} may only be provided once`)
  }
}

function getUniqueFlag(name: string) {
  assertUniqueFlag(name)
  return getFlag(name)
}

function getStringFlag(name: string) {
  assertUniqueFlag(name)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === name) {
      const value = args[index + 1]
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
      return value
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1)
      if (!value) throw new Error(`${name} requires a value`)
      return value
    }
  }
  return undefined
}

function readBooleanFlag(name: string) {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === name) {
      const next = args[index + 1]
      values.push(next && !next.startsWith("--") ? next : "true")
    } else if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1))
    }
  }

  if (values.length === 0) return undefined
  if (values.length > 1) throw new Error(`${name} may only be provided once`)

  const normalized = values[0].trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  throw new Error(`${name} must be true or false`)
}

function hasFlag(name: string) {
  return readBooleanFlag(name) === true
}

function outputPathFlag() {
  return getStringFlag("--output")
}

function writeOutput(value: string, options: { ensureTrailingNewline?: boolean } = {}) {
  const rendered = options.ensureTrailingNewline === false
    ? value
    : (value.endsWith("\n") ? value : `${value}\n`)
  const outputPath = outputPathFlag()
  if (!outputPath) {
    process.stdout.write(rendered)
    return
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, rendered, { mode: 0o600 })
  chmodSync(outputPath, 0o600)
}

function print(value: unknown) {
  writeOutput(JSON.stringify(value, null, 2))
}

function printRaw(value: string) {
  writeOutput(value)
}

function shouldPrintHumanSummary() {
  const jsonFlag = readBooleanFlag("--json")
  if (jsonFlag !== undefined) return jsonFlag === false
  return TTY && !outputPathFlag()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function fieldString(record: Record<string, unknown> | null, name: string) {
  const value = record?.[name]
  return typeof value === "string" && value.trim() ? value : null
}

function fieldNumber(record: Record<string, unknown> | null, name: string) {
  const value = record?.[name]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function nestedRecord(record: Record<string, unknown> | null, name: string) {
  return asRecord(record?.[name])
}

function arrayField(record: Record<string, unknown> | null, name: string) {
  const value = record?.[name]
  return Array.isArray(value) ? value : []
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "not reported"
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none"
  if (typeof value === "boolean") return value ? "yes" : "no"
  return String(value)
}

function formatInteger(value: number | null | undefined) {
  return value === null || value === undefined ? "not reported" : new Intl.NumberFormat("en-US").format(value)
}

function formatUsdCents(value: number | null | undefined) {
  if (value === null || value === undefined) return "not reported"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100)
}

function humanSummaryLines(title: string, lines: string[]) {
  return [
    `${BOLD}${title}${RESET}`,
    ...lines.map((line) => `  ${line}`),
  ].join("\n")
}

function formatAccountHuman(commandKey: "me" | "billing show" | "usage show" | "limits show", value: unknown) {
  const root = asRecord(value)
  if (!root) return JSON.stringify(value, null, 2)

  if (commandKey === "me") {
    const principal = nestedRecord(root, "principal")
    return humanSummaryLines("SEC API account", [
      `Auth: ${displayValue(fieldString(principal, "authMode"))}`,
      `Principal: ${displayValue(fieldString(principal, "principalId"))}`,
      `Organization: ${displayValue(fieldString(principal, "orgId"))}`,
      `Plan: ${displayValue(fieldString(principal, "publicPlanKey"))}`,
      `Billing state: ${displayValue(fieldString(principal, "billingState"))}`,
      `Scopes: ${displayValue(arrayField(principal, "scopes"))}`,
      `Request: ${displayValue(fieldString(root, "requestId"))}`,
    ])
  }

  if (commandKey === "billing show") {
    const budget = nestedRecord(root, "budget")
    const monthlyQuotas = nestedRecord(root, "monthlyQuotas")
    const aiQuota = nestedRecord(monthlyQuotas, "ai_queries")
    const freeGrantTotal = fieldNumber(root, "freeGrantTotal")
    const freeGrantRemaining = fieldNumber(root, "freeGrantRemaining")
    const budgetUsed = fieldNumber(budget, "accruedUsageCents")
    const budgetCap = fieldNumber(budget, "spendCapCents")
    const quotaRemaining = fieldNumber(aiQuota, "remaining")
    const quotaLimit = fieldNumber(aiQuota, "limit")
    return humanSummaryLines("SEC API billing", [
      `Plan: ${displayValue(fieldString(root, "publicPlanKey"))}`,
      `Billing state: ${displayValue(fieldString(root, "billingState"))}`,
      `Rights: ${displayValue(fieldString(root, "rightsKey"))}`,
      `Card on file: ${displayValue(root.cardOnFile)}`,
      `Free grant: ${freeGrantRemaining === null && freeGrantTotal === null ? "not reported" : `${formatInteger(freeGrantRemaining)} / ${formatInteger(freeGrantTotal)} remaining`}`,
      `Budget: ${budgetUsed === null && budgetCap === null ? "not reported" : `${formatUsdCents(budgetUsed)} / ${formatUsdCents(budgetCap)} accrued`}`,
      `AI monthly quota: ${quotaRemaining === null && quotaLimit === null ? "not reported" : `${formatInteger(quotaRemaining)} / ${formatInteger(quotaLimit)} remaining`}`,
      `Request: ${displayValue(fieldString(root, "requestId"))}`,
    ])
  }

  if (commandKey === "usage show") {
    const meters = arrayField(root, "meters").map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    const topMeters = meters.slice(0, 5)
    return humanSummaryLines("SEC API usage", [
      `Organization: ${displayValue(fieldString(root, "orgId"))}`,
      `Total requests: ${formatInteger(fieldNumber(root, "totalRequests"))}`,
      `Recorded at: ${displayValue(fieldString(root, "recordedAt"))}`,
      topMeters.length
        ? `Top meters: ${topMeters.map((meter) => {
            const name = fieldString(meter, "meterClass") ?? "unknown"
            const count = formatInteger(fieldNumber(meter, "count"))
            const errors = formatInteger(fieldNumber(meter, "errorCount"))
            const latency = fieldNumber(meter, "avgLatencyMs")
            return `${name} ${count} requests, ${errors} errors${latency === null ? "" : `, ${latency}ms avg`}`
          }).join("; ")}`
        : "Top meters: none",
      `Request: ${displayValue(fieldString(root, "requestId"))}`,
    ])
  }

  const quotas = arrayField(root, "quotas").map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
  return humanSummaryLines("SEC API limits", [
    `Organization: ${displayValue(fieldString(root, "orgId"))}`,
    `Plan: ${displayValue(fieldString(root, "effectivePlanKey"))}`,
    `Billing state: ${displayValue(fieldString(root, "billingState"))}`,
    quotas.length
      ? `Quotas: ${quotas.slice(0, 6).map((quota) => {
          const name = fieldString(quota, "meterClass") ?? "unknown"
          const limit = formatInteger(fieldNumber(quota, "limit"))
          const period = displayValue(fieldString(quota, "period"))
          const allowed = displayValue(quota.allowed)
          return `${name} ${limit} per ${period} (${allowed})`
        }).join("; ")}`
      : "Quotas: none",
    `Request: ${displayValue(fieldString(root, "requestId"))}`,
  ])
}

function printAccountResult(commandKey: "me" | "billing show" | "usage show" | "limits show", value: unknown) {
  if (shouldPrintHumanSummary()) {
    writeOutput(formatAccountHuman(commandKey, value))
  } else {
    print(value)
  }
}

const DRY_RUN_MUTATION_COMMANDS = new Set([
  "api-keys create",
  "billing budget",
  "billing checkout",
  "billing portal",
  "streams create",
  "webhooks create",
  "webhooks replay-delivery",
  "webhooks rotate-secret",
])

function supportsMutationDryRun(commandKey: string | null | undefined) {
  return commandKey != null && DRY_RUN_MUTATION_COMMANDS.has(commandKey)
}

function mutationDryRun(commandKey: string, request: {
  method: string
  path: string
  body?: Record<string, unknown>
}) {
  print({
    object: "secapi_cli_dry_run",
    command: `secapi ${commandKey}`,
    mutates: true,
    callsApi: false,
    request: {
      method: request.method,
      baseUrl,
      path: request.path,
      url: `${baseUrl}${request.path}`,
      body: request.body ?? null,
    },
    next: `Remove --dry-run to send this ${request.method} request.`,
  })
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
  return readBooleanFlag(name)
}

function getEnumFlag<T extends string>(name: string, allowed: readonly T[], label: string): T | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  return getEnumFlagFromValue(name, raw, allowed, label)
}

function getEnumFlagFromValue<T extends string>(name: string, value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`${name} must be one of: ${allowed.join(", ")} (${label})`)
}

function getResponseViewFlag(name = "--view"): ResponseView | undefined {
  return getEnumFlag(name, ["default", "compact", "agent"], "response view")
}

function getFactorResponseModeFlag(name = "--response-mode"): FactorApiResponseMode | undefined {
  return getEnumFlag(name, ["compact", "standard", "verbose"], "factor response mode")
}

function getFactorViewResponseModeFlag(name = "--view"): FactorApiResponseMode | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  const aliases: Record<string, FactorApiResponseMode> = {
    agent: "compact",
    compact: "compact",
    default: "standard",
    standard: "standard",
    verbose: "verbose",
  }
  const normalized = raw.trim().toLowerCase()
  const mapped = aliases[normalized]
  if (mapped) return mapped
  throw new Error(`${name} must be one of: default, agent, compact, standard, verbose (factor response view)`)
}

function getCompactFullViewFlag(name = "--view"): "compact" | "full" | undefined {
  return getEnumFlag(name, ["compact", "full"], "compact/full view")
}

function getSemanticModeFlag(name = "--mode"): "keyword" | "semantic" | "hybrid" | undefined {
  return getEnumFlag(name, ["keyword", "semantic", "hybrid"], "semantic search mode")
}

function getEnforcementSourceTypeFlag(name = "--source-type"): "litigation_release" | "administrative_proceeding" | "aaer" | undefined {
  return getEnumFlag(name, ["litigation_release", "administrative_proceeding", "aaer"], "enforcement source type")
}

function getMeetingTypeFlag(name = "--meeting-type"): "annual" | "special" | undefined {
  return getEnumFlag(name, ["annual", "special"], "voting-results meeting type")
}

function getDilutionRiskFlag(name = "--overall-risk"): "low" | "moderate" | "elevated" | "high" | undefined {
  return getEnumFlag(name, ["low", "moderate", "elevated", "high"], "dilution risk")
}

function getFactorExtremeMoveSideFlag(name: "--side" | "--direction"): "both" | "up" | "down" | "flat" | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  return getEnumFlagFromValue<"both" | "up" | "down" | "flat">(name, raw.trim().toLowerCase(), ["both", "up", "down", "flat"], "factor extreme move side")
}

function getFactorExtremeMoveSortFlag(name = "--sort"): "abs_z_score" | "abs_scaled_return" | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  return getEnumFlagFromValue<"abs_z_score" | "abs_scaled_return">(name, raw.trim().toLowerCase().replace(/-/g, "_"), ["abs_z_score", "abs_scaled_return"], "factor extreme move sort")
}

function getFactorExtremePairSideFlag(name: "--side" | "--direction"): "both" | "factor1" | "factor2" | "flat" | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  return getEnumFlagFromValue<"both" | "factor1" | "factor2" | "flat">(name, raw.trim().toLowerCase(), ["both", "factor1", "factor2", "flat"], "factor extreme pair side")
}

function getFactorExtremePairSortFlag(name = "--sort"): "abs_z_score" | "abs_spread_return" | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  return getEnumFlagFromValue<"abs_z_score" | "abs_spread_return">(name, raw.trim().toLowerCase().replace(/-/g, "_"), ["abs_z_score", "abs_spread_return"], "factor extreme pair sort")
}

function getFactorValuationSideFlag(name: "--side" | "--signal"): "tailwind" | "headwind" | "neutral" | "all" | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  return getEnumFlagFromValue<"tailwind" | "headwind" | "neutral" | "all">(name, raw.trim().toLowerCase(), ["tailwind", "headwind", "neutral", "all"], "factor valuation side")
}

function getFactorValuationSortFlag(name = "--sort"): "opportunity_score" | "abs_z_score" | "factor_key" | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  return getEnumFlagFromValue<"opportunity_score" | "abs_z_score" | "factor_key">(name, raw.trim().toLowerCase().replace(/-/g, "_"), ["opportunity_score", "abs_z_score", "factor_key"], "factor valuation sort")
}

function getFactorValuationWeightingModeFlag(name: "--weighting-mode" | "--weighting"): "long_short_equal" | "long_leg_focus" | "short_leg_focus" | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  const aliases: Record<string, "long_short_equal" | "long_leg_focus" | "short_leg_focus"> = {
    equal_weight: "long_short_equal",
    equal_weighted: "long_short_equal",
    long_short: "long_short_equal",
    long_short_equal: "long_short_equal",
    long_short_equal_weight: "long_short_equal",
    long: "long_leg_focus",
    long_only: "long_leg_focus",
    long_leg: "long_leg_focus",
    long_leg_focus: "long_leg_focus",
    short: "short_leg_focus",
    short_only: "short_leg_focus",
    short_leg: "short_leg_focus",
    short_leg_focus: "short_leg_focus",
  }
  const normalized = raw.trim().toLowerCase().replace(/-/g, "_")
  const mapped = aliases[normalized]
  if (mapped) return mapped
  throw new Error(`${name} must be one of: long_short_equal, long_leg_focus, short_leg_focus (factor valuation weighting mode)`)
}

function getFactorValuationStockStanceFlag(name: "--stance" | "--side" | "--direction"): "beneficiaries" | "at_risk" | "both" | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  const aliases: Record<string, "beneficiaries" | "at_risk" | "both"> = {
    beneficiary: "beneficiaries",
    beneficiaries: "beneficiaries",
    long: "beneficiaries",
    winners: "beneficiaries",
    opportunity: "beneficiaries",
    opportunities: "beneficiaries",
    at_risk: "at_risk",
    risk: "at_risk",
    risks: "at_risk",
    short: "at_risk",
    losers: "at_risk",
    both: "both",
    all: "both",
  }
  const normalized = raw.trim().toLowerCase().replace(/-/g, "_")
  const mapped = aliases[normalized]
  if (mapped) return mapped
  throw new Error(`${name} must be one of: beneficiaries, at_risk, both (factor valuation stock stance)`)
}

function getFactorValuationStockSortFlag(name = "--sort"): "score" | "abs_beta" | "symbol" | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  return getEnumFlagFromValue<"score" | "abs_beta" | "symbol">(name, raw.trim().toLowerCase().replace(/-/g, "_"), ["score", "abs_beta", "symbol"], "factor valuation stock sort")
}

function getFactorSparklineMetricFlag(name = "--metric"): "scaled_return" | "pure_return" | "raw_return" | "z_score" | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  return getEnumFlagFromValue<"scaled_return" | "pure_return" | "raw_return" | "z_score">(name, raw.trim().toLowerCase().replace(/-/g, "_"), ["scaled_return", "pure_return", "raw_return", "z_score"], "factor sparkline metric")
}

function getPortfolioObjectiveFlag(name = "--objective"): "factor_neutral" | "min_drawdown" | "regime_aware" | undefined {
  return getEnumFlag(name, ["factor_neutral", "min_drawdown", "regime_aware"], "portfolio objective")
}

function getPortfolioHedgeModeFlag(name = "--mode"): "compact" | "standard" | undefined {
  return getEnumFlag(name, ["compact", "standard"], "portfolio hedge mode")
}

function getPortfolioAttributionFrequencyFlag(name = "--frequency"): "daily" | "weekly" | "monthly" | "quarterly" | "annual" | undefined {
  return getEnumFlag(name, ["daily", "weekly", "monthly", "quarterly", "annual"], "portfolio attribution frequency")
}

function getPortfolioAttributionExportFormatFlag(name = "--export-format"): "json" | "csv" | "both" | undefined {
  return getEnumFlag(name, ["json", "csv", "both"], "portfolio attribution export format")
}

function getPortfolioScenarioKeyFlag(name = "--scenario-key"): "us_recession" | "higher_for_longer" | "china_growth_scare" | undefined {
  return getEnumFlag(name, ["us_recession", "higher_for_longer", "china_growth_scare"], "portfolio stress scenario key")
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
    response_mode: getFactorResponseModeFlag("--response-mode") ?? getFactorViewResponseModeFlag("--view"),
    include: getListFlag("--include") ?? getListFlag("--expand"),
  }
}

type MacroCliResponseMode = "compact" | "standard" | "verbose" | "agent"

function getMacroResponseModeFlag(name = "--response-mode"): MacroCliResponseMode | undefined {
  const raw = getEnumFlag(name, ["compact", "standard", "verbose", "agent", "default"], "macro response mode")
  return raw === "default" ? "standard" : raw
}

function getMacroViewResponseModeFlag(name = "--view"): MacroCliResponseMode | undefined {
  const raw = getUniqueFlag(name)
  if (raw === undefined) return undefined
  const aliases: Record<string, MacroCliResponseMode> = {
    agent: "agent",
    compact: "compact",
    default: "standard",
    standard: "standard",
    verbose: "verbose",
  }
  const normalized = raw.trim().toLowerCase()
  const mapped = aliases[normalized]
  if (mapped) return mapped
  throw new Error(`${name} must be one of: default, agent, compact, standard, verbose (macro response view)`)
}

function macroResponseParams() {
  const include = getListFlag("--include") ?? getListFlag("--expand")
  return {
    response_mode: getMacroResponseModeFlag("--response-mode") ?? getMacroViewResponseModeFlag("--view"),
    include: include?.join(","),
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

type CliProfile = {
  name: string
  configPath: string
  baseUrl?: string
  apiKeyEnv?: string
  bearerTokenEnv?: string
}

type CliProfilesFile = {
  configPath: string
  exists: boolean
  profiles: Record<string, unknown>
}

type RequestSummary = {
  method: string
  path: string
  status: number
  requestId: string | null
  traceparent: string | null
  estimatedCost: string | null
  tokenCount: string | null
  tokenCountSource: string | null
  cacheHit: boolean | null
  maturity: string | null
  durationMs: number
}

const requestSummaries: RequestSummary[] = []

function wantsRequestSummary() {
  return hasFlag("--request-summary")
}

function captureFetch(): typeof fetch {
  return async (input, init) => {
    const startedAt = Date.now()
    const response = await fetch(input, init)
    const url = typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url)
    requestSummaries.push({
      method: (init?.method ?? (typeof input === "object" && "method" in input ? input.method : undefined) ?? "GET").toUpperCase(),
      path: url.pathname,
      status: response.status,
      requestId: response.headers.get("Request-Id") ?? response.headers.get("X-Correlation-Id"),
      traceparent: response.headers.get("traceparent"),
      estimatedCost: response.headers.get("SECAPI-Estimated-Cost"),
      tokenCount: response.headers.get("SECAPI-Token-Count"),
      tokenCountSource: response.headers.get("SECAPI-Token-Count-Source"),
      cacheHit: response.headers.get("SECAPI-Cache-Hit") === null ? null : response.headers.get("SECAPI-Cache-Hit") === "true",
      maturity: response.headers.get("SECAPI-Maturity"),
      durationMs: Date.now() - startedAt,
    })
    return response
  }
}

function emitRequestSummary() {
  if (!wantsRequestSummary()) return
  process.stderr.write(`${JSON.stringify({
    object: "secapi_cli_request_summary",
    requests: requestSummaries,
  }, null, 2)}\n`)
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
    const hasInlineValue = args.some((arg) => arg.startsWith(`${flag}=`))
    const hasSeparatedValue = args.some((arg, index) => arg === flag && args[index + 1] && !args[index + 1].startsWith("--"))
    if (hasInlineValue || hasSeparatedValue) {
      throw new Error(`${flag} does not accept a value. Pipe the credential through stdin instead.`)
    }
  }
}

function envCredential(...names: string[]) {
  return envCredentialWithSource(...names)?.value
}

function envCredentialWithSource(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return { source: name, value }
  }
  return undefined
}

function envNameValue(name: string | undefined) {
  if (!name) return undefined
  const value = process.env[name]?.trim()
  return value ? { source: name, value } : undefined
}

function activeProfileName() {
  if (profileArg) return { source: "--profile", value: profileArg }
  const envSource = envCredentialWithSource(PROFILE_ENV_NAME)
  return envSource ? { source: envSource.source, value: envSource.value } : undefined
}

function profileConfigPath() {
  return process.env[PROFILE_CONFIG_FILE_ENV_NAME]?.trim() || join(homedir(), ".config", "secapi", "profiles.json")
}

function looksCredentialShaped(value: string) {
  return /^(?:secapi|opr|ods)_(?:live|test|prod|dev)_/i.test(value) || /^bearer[_-]/i.test(value)
}

function safeProfileName(value: string, source: string) {
  if (looksCredentialShaped(value)) {
    throw new Error(`${source} must name a profile, not a credential value`)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${source} must be a profile name using letters, numbers, '.', '_' or '-'`)
  }
  return value
}

function normalizeBaseUrlValue(raw: string, label = "--base-url") {
  try {
    const url = new URL(raw)
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol")
    if (url.username || url.password) throw new Error("credentials are not allowed")
    if (url.search || url.hash) throw new Error("query strings and fragments are not allowed")
    return url.toString().replace(/\/+$/, "")
  } catch {
    throw new Error(`${label} must be an http(s) origin/path without embedded credentials, query, or fragment`)
  }
}

function profileEnvName(value: unknown, field: string) {
  if (value === undefined) return undefined
  if (typeof value === "string" && looksCredentialShaped(value)) {
    throw new Error(`Profile field ${field} must name an environment variable, not a credential value`)
  }
  if (typeof value !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    throw new Error(`Profile field ${field} must be an environment variable name`)
  }
  return value
}

function readProfilesFile(options: { allowMissing?: boolean } = {}): CliProfilesFile {
  const configPath = profileConfigPath()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"))
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
    if (code === "ENOENT" && options.allowMissing) return { configPath, exists: false, profiles: {} }
    if (code === "ENOENT") throw new Error(`You selected a profile, but profile config file ${configPath} does not exist`)
    throw new Error(`${configPath} is not valid JSON`)
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} must be a JSON object with a profiles object`)
  }
  const profiles = (parsed as Record<string, unknown>).profiles
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error(`${configPath} must contain a profiles object`)
  }
  return { configPath, exists: true, profiles: profiles as Record<string, unknown> }
}

function profileFromRaw(name: string, raw: unknown, configPath: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Profile '${name}' was not found in ${configPath}`)
  }
  const profile = raw as Record<string, unknown>
  const baseUrlValue = profile.baseUrl
  if (baseUrlValue !== undefined && typeof baseUrlValue !== "string") {
    throw new Error("Profile field baseUrl must be a string")
  }
  return {
    name,
    configPath,
    baseUrl: baseUrlValue === undefined ? undefined : normalizeBaseUrlValue(baseUrlValue, "Profile field baseUrl"),
    apiKeyEnv: profileEnvName(profile.apiKeyEnv, "apiKeyEnv"),
    bearerTokenEnv: profileEnvName(profile.bearerTokenEnv, "bearerTokenEnv"),
  }
}

function activeProfile(): CliProfile | undefined {
  const selected = activeProfileName()
  if (!selected) return undefined
  const name = selected.value.trim()
  if (!name) return undefined
  safeProfileName(name, selected.source)
  const { configPath, profiles } = readProfilesFile()
  return profileFromRaw(name, profiles[name], configPath)
}

function consumeGlobalStringArg(name: string) {
  const values: string[] = []
  const nextArgs: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === name) {
      const value = args[index + 1]
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
      values.push(value)
      index += 1
    } else if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1)
      if (!value) throw new Error(`${name} requires a value`)
      values.push(value)
    } else {
      nextArgs.push(arg)
    }
  }
  if (values.length > 1) throw new Error(`${name} may only be provided once`)
  args = nextArgs
  return values[0]
}

function resolveBaseUrl() {
  return normalizeBaseUrlValue(baseUrlConfigSource().value)
}

function baseUrlConfigSource() {
  if (baseUrlArg) return { type: "flag", source: "--base-url", value: baseUrlArg }
  const envSource = envCredentialWithSource(...BASE_URL_ENV_NAMES)
  if (envSource) return { type: "env", source: envSource.source, value: envSource.value }
  const profile = activeProfile()
  if (profile?.baseUrl) return { type: "profile", source: profile.name, value: profile.baseUrl }
  return { type: "default", source: "default", value: "https://api.secapi.ai" }
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
    apiKey: apiKeyFromStdin ? stdinCredential : envCredential(...API_KEY_ENV_NAMES) ?? envNameValue(activeProfile()?.apiKeyEnv)?.value,
    bearerToken: bearerTokenFromStdin ? stdinCredential : envCredential(...BEARER_ENV_NAMES) ?? envNameValue(activeProfile()?.bearerTokenEnv)?.value,
  }
}

function credentialSourceSummary(credentials: CliCredentials) {
  const apiKeySource = credentials.apiKey
    ? (hasFlag(STDIN_FLAG_NAME) ? STDIN_FLAG_NAME : envCredentialWithSource(...API_KEY_ENV_NAMES)?.source ?? envNameValue(activeProfile()?.apiKeyEnv)?.source ?? "configured")
    : null
  const bearerTokenSource = credentials.bearerToken
    ? (hasFlag(STDIN_BEARER_FLAG_NAME) ? STDIN_BEARER_FLAG_NAME : envCredentialWithSource(...BEARER_ENV_NAMES)?.source ?? envNameValue(activeProfile()?.bearerTokenEnv)?.source ?? "configured")
    : null
  return {
    apiKey: {
      configured: Boolean(credentials.apiKey),
      source: apiKeySource,
    },
    bearerToken: {
      configured: Boolean(credentials.bearerToken),
      source: bearerTokenSource,
    },
  }
}

function localCredentialSourceSummary() {
  const profile = activeProfile()
  const apiKeySource = envCredentialWithSource(...API_KEY_ENV_NAMES) ?? envNameValue(profile?.apiKeyEnv)
  const bearerTokenSource = envCredentialWithSource(...BEARER_ENV_NAMES) ?? envNameValue(profile?.bearerTokenEnv)
  return {
    apiKey: {
      configured: Boolean(apiKeySource),
      source: apiKeySource?.source ?? null,
      stdinFlagPresent: hasFlag(STDIN_FLAG_NAME),
    },
    bearerToken: {
      configured: Boolean(bearerTokenSource),
      source: bearerTokenSource?.source ?? null,
      stdinFlagPresent: hasFlag(STDIN_BEARER_FLAG_NAME),
    },
  }
}

function localConfigReport() {
  const baseUrlSource = baseUrlConfigSource()
  const profile = activeProfile()
  return {
    object: "secapi_cli_config",
    cliVersion: cliVersion(),
    profile: profile
      ? {
          name: profile.name,
          source: activeProfileName()?.source ?? null,
          configPath: profile.configPath,
          apiKeyEnv: profile.apiKeyEnv ?? null,
          bearerTokenEnv: profile.bearerTokenEnv ?? null,
        }
      : null,
    baseUrl,
    baseUrlSource: {
      type: baseUrlSource.type,
      source: baseUrlSource.source,
    },
    auth: localCredentialSourceSummary(),
    mcp: {
      url: `${baseUrl.replace(/\/+$/, "")}/mcp`,
    },
    localOnly: true,
    note: "Credential values are never shown. secapi config show does not read stdin or call the API.",
  }
}

function localProfilesReport() {
  const selected = activeProfileName()
  const selectedName = selected?.value.trim() ? safeProfileName(selected.value.trim(), selected.source) : null
  const file = readProfilesFile({ allowMissing: true })
  const profiles = Object.entries(file.profiles)
    .map(([name, raw]) => profileFromRaw(safeProfileName(name, "Profile name"), raw, file.configPath))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((profile) => ({
      name: profile.name,
      selected: profile.name === selectedName,
      baseUrl: profile.baseUrl ?? null,
      apiKeyEnv: profile.apiKeyEnv ?? null,
      apiKeyConfigured: Boolean(envNameValue(profile.apiKeyEnv)),
      bearerTokenEnv: profile.bearerTokenEnv ?? null,
      bearerTokenConfigured: Boolean(envNameValue(profile.bearerTokenEnv)),
    }))

  return {
    object: "secapi_cli_profiles",
    configPath: file.configPath,
    exists: file.exists,
    active: selectedName,
    profiles,
    localOnly: true,
    note: "Credential values are never shown. secapi config profiles does not read stdin or call the API.",
  }
}

function defaultClient(credentials: CliCredentials) {
  return new SecApiClient({
    apiKey: credentials.apiKey,
    bearerToken: credentials.bearerToken,
    baseUrl,
    fetch: captureFetch(),
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
    fetch: captureFetch(),
  })
}

function sanitizeDiagnosticText(value: string, credentials: CliCredentials) {
  let out = value
  for (const secret of [credentials.apiKey, credentials.bearerToken]) {
    if (!secret) continue
    out = out.split(secret).join("[redacted]")
  }
  return out
}

function diagnosticError(error: unknown, credentials: CliCredentials) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {}
  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    status: typeof record.status === "number" ? record.status : null,
    code: typeof record.code === "string" ? record.code : null,
    requestId: typeof record.requestId === "string" ? record.requestId : null,
    message: sanitizeDiagnosticText(message, credentials),
  }
}

async function doctorCheck(fn: () => Promise<unknown>, credentials: CliCredentials) {
  try {
    return {
      ok: true,
      response: await fn(),
    }
  } catch (error) {
    return diagnosticError(error, credentials)
  }
}

async function runDoctor(apiClient: SecApiClient, credentials: CliCredentials) {
  const auth = credentialSourceSummary(credentials)
  const hasAuth = auth.apiKey.configured || auth.bearerToken.configured
  const health = await doctorCheck(() => apiClient.health({ retry: false }), credentials)
  const me = hasAuth
    ? await doctorCheck(() => apiClient.me({ retry: false }), credentials)
    : {
        ok: null,
        skipped: true,
        reason: "No SEC API credential found; set SECAPI_API_KEY or pipe one through --api-key-stdin to verify account context.",
      }
  const mcpUrl = `${baseUrl.replace(/\/+$/, "")}/mcp`

  const ok = health.ok === true && (!hasAuth || me.ok === true)
  return {
    object: "secapi_cli_doctor",
    ok,
    cliVersion: cliVersion(),
    baseUrl,
    auth,
    checks: {
      health,
      me,
    },
    mcp: {
      url: mcpUrl,
      authConfigured: hasAuth,
      authHeader: auth.apiKey.configured ? "x-api-key" : auth.bearerToken.configured ? "Authorization" : null,
      install: "secapi mcp install --client <claude-code|claude-desktop|cursor|windsurf|project>",
    },
  }
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

function unknownCommandLabel() {
  if (!args[0] || args[0].startsWith("-")) return "unknown"
  const label = [args[0], args[1] && !args[1].startsWith("-") ? args[1] : undefined]
    .filter((part): part is string => Boolean(part))
    .join(" ")
  return label || "unknown"
}

type CommandHelp = {
  usage: string
  summary: string
  flags?: string[]
  examples?: string[]
}

const COMMAND_HELP: Record<string, CommandHelp> = {
  health: {
    usage: "secapi health",
    summary: "Check API health. This command is safe to run without authentication.",
  },
  doctor: {
    usage: "secapi doctor",
    summary: "Run safe CLI diagnostics for base URL, auth, health, account context, and hosted MCP setup.",
    examples: ["secapi doctor"],
  },
  me: {
    usage: "secapi me",
    summary: "Show the authenticated user and organization context.",
    flags: ["--json=false", "--request-summary", "--output <file>"],
    examples: ["secapi me", "secapi me --json=false"],
  },
  "billing show": {
    usage: "secapi billing show [--json=false]",
    summary: "Show billing plan, state, grant, budget, and quota context.",
    flags: ["--json=false", "--request-summary", "--output <file>"],
    examples: ["secapi billing show", "secapi billing show --json=false"],
  },
  "usage show": {
    usage: "secapi usage show [--json=false]",
    summary: "Show recent account usage totals and top meter families.",
    flags: ["--json=false", "--request-summary", "--output <file>"],
    examples: ["secapi usage show", "secapi usage show --json=false"],
  },
  "limits show": {
    usage: "secapi limits show [--json=false]",
    summary: "Show effective plan limits and quota state.",
    flags: ["--json=false", "--request-summary", "--output <file>"],
    examples: ["secapi limits show", "secapi limits show --json=false"],
  },
  "macro search": {
    usage: "secapi macro search --q <query> [--country <country>] [--limit <n>]",
    summary: "Search macro indicator keys before fetching observations, releases, forecasts, or country reports.",
    flags: ["--q <query>", "--query <query>", "--country <country>", "--frequency <frequency>", "--limit <n>"],
    examples: ["secapi macro search --q inflation --country US --limit 10"],
  },
  "macro indicators": {
    usage: "secapi macro indicators --indicator <key> [--country <country>] [--response-mode compact|standard|verbose|agent]",
    summary: "Fetch macro observations for one country and indicator key.",
    flags: ["--indicator <key>", "--indicator-key <key>", "--country <country>", "--limit <n>", "--response-mode <mode>", "--view <mode>", "--include <fields>", "--expand <fields>"],
    examples: ["secapi macro indicators --country US --indicator CPIAUCSL --limit 12 --response-mode compact"],
  },
  "macro high-signal-pack": {
    usage: "secapi macro high-signal-pack [--country <country>] [--response-mode compact|standard|verbose|agent]",
    summary: "Fetch the compact high-signal macro pack for a country, with expansion controls for full series and trust metadata.",
    flags: ["--country <country>", "--response-mode <mode>", "--view <mode>", "--include <fields>", "--expand <fields>"],
    examples: ["secapi macro high-signal-pack --country US", "secapi macro high-signal-pack --country US --response-mode standard --include series,trust"],
  },
  "macro releases": {
    usage: "secapi macro releases [--country <country>] [--status released|scheduled] [--limit <n>]",
    summary: "Fetch released macro history by default, or upcoming scheduled events with --status scheduled.",
    flags: ["--country <country>", "--indicator <key>", "--indicator-key <key>", "--status <released|scheduled>", "--days <n>", "--limit <n>", "--response-mode <mode>", "--view <mode>", "--include <fields>", "--expand <fields>"],
    examples: ["secapi macro releases --country US --status released --limit 10", "secapi macro releases --country US --status scheduled --days 45 --response-mode compact"],
  },
  "macro calendar": {
    usage: "secapi macro calendar [--country <country>] [--days <n>] [--limit <n>]",
    summary: "Fetch upcoming scheduled macro releases only.",
    flags: ["--country <country>", "--indicator <key>", "--indicator-key <key>", "--days <n>", "--limit <n>", "--response-mode <mode>", "--view <mode>", "--include <fields>", "--expand <fields>"],
    examples: ["secapi macro calendar --country US --days 30 --limit 12 --response-mode compact"],
  },
  "macro forecasts": {
    usage: "secapi macro forecasts [--country <country>] [--indicator <key>] [--horizons <n>]",
    summary: "Fetch compact baseline macro forecasts; country-wide calls default to compact at the API.",
    flags: ["--country <country>", "--indicator <key>", "--indicator-key <key>", "--horizons <n>", "--response-mode <mode>", "--view <mode>", "--include <fields>", "--expand <fields>"],
    examples: ["secapi macro forecasts --country US --horizons 2 --response-mode compact"],
  },
  "macro regimes": {
    usage: "secapi macro regimes [--country <country>] [--lookback <window>]",
    summary: "Fetch the current macro regime classification as a list envelope.",
    flags: ["--country <country>", "--lookback <window>", "--response-mode <mode>", "--view <mode>", "--include <fields>", "--expand <fields>"],
    examples: ["secapi macro regimes --country US --lookback 18m --response-mode compact"],
  },
  "macro credit-ratings": {
    usage: "secapi macro credit-ratings [--country <country>]",
    summary: "List sovereign credit ratings for tracked countries and G20 members.",
    flags: ["--country <country>"],
    examples: ["secapi macro credit-ratings --country US"],
  },
  "macro credit-rating": {
    usage: "secapi macro credit-rating --country <country>",
    summary: "Fetch one country's sovereign credit rating by ISO country code.",
    flags: ["--country <country>"],
    examples: ["secapi macro credit-rating --country US"],
  },
  "entities resolve": {
    usage: "secapi entities resolve --ticker <symbol> | --cik <cik> | --query <name>",
    summary: "Resolve ticker, CIK, or company name to canonical SEC API entity metadata.",
    flags: ["--ticker <symbol>", "--cik <cik>", "--query <name>"],
    examples: ["secapi entities resolve --ticker AAPL"],
  },
  "filings search": {
    usage: "secapi filings search [--ticker <symbol>] [--form <form>] [--q <query>] [--limit <n>]",
    summary: "Search SEC filings by issuer, form type, text query, and pagination controls.",
    flags: ["--ticker <symbol>", "--form <form>", "--q <query>", "--limit <n>"],
    examples: ["secapi filings search --ticker AAPL --form 10-K --limit 5"],
  },
  "filings latest": {
    usage: "secapi filings latest --ticker <symbol> [--form <form>]",
    summary: "Fetch the latest filing for an issuer and optional form type.",
    flags: ["--ticker <symbol>", "--cik <cik>", "--form <form>"],
    examples: ["secapi filings latest --ticker AAPL --form 10-K"],
  },
  "sections get": {
    usage: "secapi sections get --ticker <symbol> --form 10-K --section <item>",
    summary: "Extract a filing section such as item_1a or item_7 from the latest matching filing.",
    flags: ["--ticker <symbol>", "--cik <cik>", "--form <form>", "--section <item>", "--view default|compact|agent"],
    examples: ["secapi sections get --ticker AAPL --form 10-K --section item_1a --view agent"],
  },
  "search fulltext": {
    usage: "secapi search fulltext --q <query> [--form <form>] [--limit <n>]",
    summary: "Run keyword search across filing text.",
    flags: ["--q <query>", "--form <form>", "--ticker <symbol>", "--limit <n>"],
    examples: ["secapi search fulltext --q \"supply chain\" --form 10-K --limit 10"],
  },
  "search semantic": {
    usage: "secapi search semantic --q <query> [--mode keyword|semantic|hybrid] [--view default|compact|agent]",
    summary: "Run semantic or hybrid filing search with response-shape controls.",
    flags: ["--q <query>", "--mode keyword|semantic|hybrid", "--view default|compact|agent", "--limit <n>"],
    examples: ["secapi search semantic --q \"supplier concentration\" --mode hybrid --view agent"],
  },
  "statements get": {
    usage: "secapi statements get --ticker <symbol> --statement <income|balance|cash|all> [--period annual|quarterly]",
    summary: "Retrieve normalized financial statements.",
    flags: ["--ticker <symbol>", "--cik <cik>", "--statement <name>", "--period <period>", "--limit <n>"],
    examples: ["secapi statements get --ticker AAPL --statement all --period annual --limit 1"],
  },
  "traces get": {
    usage: "secapi traces get --trace-id <trace_id>",
    summary: "Hydrate a single trace reference from a filing-derived response.",
    flags: ["--trace-id <trace_id>"],
    examples: ["secapi traces get --trace-id trc_..."],
  },
  "traces list": {
    usage: "secapi traces list --ids <trace_id_1,trace_id_2>",
    summary: "Hydrate multiple trace references in one request.",
    flags: ["--ids <comma-separated trace ids>"],
    examples: ["secapi traces list --ids trc_1,trc_2"],
  },
  "factors exposures": {
    usage: "secapi factors exposures --symbols <symbols>",
    summary: "Fetch factor exposure loadings for one or more symbols.",
    flags: ["--symbols <comma-separated symbols>", "--keys <factor keys>", "--view default|agent|compact|standard|verbose"],
    examples: ["secapi factors exposures --symbols AAPL,MSFT --view agent"],
  },
  "factors valuations": {
    usage: "secapi factors valuations [--keys <factor_keys>] [--side tailwind|headwind|neutral|all]",
    summary: "Rank factor-level valuation opportunities and risks.",
    flags: ["--keys <factor keys>", "--side <side>", "--sort opportunity_score|abs_z_score|factor_key", "--format json|csv"],
    examples: ["secapi factors valuations --keys VALUE,MOMENTUM --side all"],
  },
  "portfolio analyze": {
    usage: "secapi portfolio analyze --holdings-json <json> | --holdings-file <path>",
    summary: "Analyze portfolio factor exposure from a holdings payload.",
    flags: ["--holdings-json <json>", "--holdings-file <path>", "--benchmark-label <label>", "--benchmark-holdings-file <path>", "--keys <factor keys>"],
    examples: ["secapi portfolio analyze --holdings-file holdings.json --benchmark-label SPY --benchmark-holdings-file benchmark.json --keys VALUE,QUALITY"],
  },
  "agents personas": {
    usage: "secapi agents personas [--json]",
    summary: "List available agent prompt personas.",
    flags: ["--json"],
  },
  "agents prompts": {
    usage: "secapi agents prompts <list|read|copy> [...]",
    summary: "Browse, read, or copy SEC API prompt-library entries.",
    flags: ["--persona <slug>", "--include-v2", "--json"],
    examples: ["secapi agents prompts list --persona law-firm", "secapi agents prompts read law-firm-enforcement-history"],
  },
  examples: {
    usage: "secapi examples [--json=false]",
    summary: "Print safe starter workflows for humans and coding agents without making an API request.",
    flags: ["--json"],
    examples: ["secapi examples", "secapi examples --json=false"],
  },
  completion: {
    usage: "secapi completion <bash|zsh|fish>",
    summary: "Print shell completion scripts for the secapi and omni-sec binaries.",
    examples: ["secapi completion zsh > ~/.zfunc/_secapi", "secapi completion bash > ~/.secapi-completion.bash"],
  },
  "config show": {
    usage: "secapi config show",
    summary: "Print local CLI configuration with credential source names, never credential values.",
    flags: ["--base-url <url>", "--profile <name>", "--output <file>"],
    examples: ["secapi config show", "secapi --profile local config show", "secapi --base-url http://127.0.0.1:8787 config show"],
  },
  "config profiles": {
    usage: "secapi config profiles",
    summary: "List configured no-secret profiles with credential environment names, never credential values.",
    flags: ["--profile <name>", "--output <file>"],
    examples: ["secapi config profiles", "secapi --profile local config profiles"],
  },
  init: {
    usage: "secapi init --client <claude-code|claude-desktop|cursor|windsurf|project> [--print]",
    summary: "Write or print the hosted-MCP config for an agent client.",
    flags: ["--client <name>", "--print", STDIN_FLAG_NAME],
    examples: ["secapi init --client cursor --print"],
  },
  "mcp install": {
    usage: "secapi mcp install --client <claude-code|claude-desktop|cursor|windsurf|project> [--print]",
    summary: "Alias for agent-client MCP setup via secapi init.",
    flags: ["--client <name>", "--print", STDIN_FLAG_NAME],
    examples: ["secapi mcp install --client claude-code"],
  },
  "agent-context": {
    usage: "secapi agent-context",
    summary: "Emit machine-readable CLI discovery metadata for coding agents.",
  },
}

const GROUP_HELP: Record<string, string[]> = {
  agents: ["agents personas", "agents prompts"],
  billing: ["billing show", "billing quote", "billing budget", "billing checkout", "billing portal"],
  config: ["config show", "config profiles"],
  diagnostics: ["doctor", "diagnostics request", "diagnostics deliveries-summary"],
  entities: ["entities resolve"],
  factors: ["factors exposures", "factors valuations"],
  filings: ["filings search", "filings latest"],
  macro: ["macro search", "macro indicators", "macro high-signal-pack", "macro releases", "macro calendar", "macro forecasts", "macro regimes", "macro credit-ratings", "macro credit-rating"],
  mcp: ["mcp install"],
  limits: ["limits show"],
  portfolio: ["portfolio analyze"],
  search: ["search fulltext", "search semantic"],
  sections: ["sections get"],
  setup: ["init", "mcp install", "agent-context", "examples", "completion"],
  statements: ["statements get"],
  traces: ["traces get", "traces list"],
  usage: ["usage show"],
}

const IMPLEMENTED_COMMAND_KEYS = new Set([
  "admin deliveries-summary",
  "admin org",
  "admin orgs",
  "admin request",
  "agent bootstrap",
  "agent bootstrap-token",
  "agent-context",
  "agents context",
  "agents personas",
  "agents prompts",
  "agents setup",
  "api-keys create",
  "api-keys list",
  "artifacts bundle",
  "artifacts export",
  "artifacts list",
  "artifacts manifest",
  "artifacts reconcile",
  "artifacts summary",
  "billing budget",
  "billing checkout",
  "billing portal",
  "billing quote",
  "billing show",
  "companies balance-sheets",
  "companies cash-flow-statements",
  "companies financials",
  "companies income-statements",
  "companies ratios",
  "companies resolve",
  "companies search",
  "companies subsidiaries",
  "compensation compare",
  "compensation list",
  "completion",
  "config profiles",
  "config show",
  "dashboard overview",
  "diagnostics deliveries-summary",
  "diagnostics request",
  "doctor",
  "dilution cash-position",
  "dilution convertibles",
  "dilution corporate-actions",
  "dilution coverage",
  "dilution event",
  "dilution events",
  "dilution lockups",
  "dilution nasdaq-compliance",
  "dilution ratings",
  "dilution reverse-splits",
  "dilution rofr",
  "dilution score",
  "dilution share-float-history",
  "dilution warrants",
  "entities resolve",
  "examples",
  "events enforcement",
  "events export",
  "events list",
  "events ma",
  "events voting-results",
  "facts get",
  "factors bulk-download",
  "factors catalog",
  "factors correlations",
  "factors custom",
  "factors dashboard",
  "factors decomposition",
  "factors exposures",
  "factors extreme-moves",
  "factors extreme-pairs",
  "factors history",
  "factors pair-history",
  "factors pairs",
  "factors regime-performance",
  "factors related-stocks",
  "factors returns",
  "factors returns-intraday",
  "factors screen",
  "factors similarity-pack",
  "factors sparklines",
  "factors valuation-stocks",
  "factors valuations",
  "filings latest",
  "filings render",
  "filings search",
  "forms 144",
  "funds nport-holdings",
  "health",
  "init",
  "insiders list",
  "intelligence company",
  "intelligence earnings-preview",
  "intelligence footnotes-query",
  "intelligence security",
  "limits show",
  "macro calendar",
  "macro credit-rating",
  "macro credit-ratings",
  "macro forecasts",
  "macro high-signal-pack",
  "macro indicators",
  "macro regimes",
  "macro releases",
  "macro search",
  "mcp install",
  "me",
  "model-portfolios factor-view",
  "models factor-analysis",
  "observability export",
  "observability show",
  "offerings list",
  "org show",
  "owners 13f",
  "owners compare-13f",
  "portfolio analyze",
  "portfolio attribution",
  "portfolio hedge",
  "portfolio optimize",
  "portfolio stress-test",
  "search fulltext",
  "search semantic",
  "sections get",
  "sections search",
  "statements get",
  "stocks loadings",
  "strategies factor-rotation",
  "strategies regime-screen",
  "streams create",
  "streams events",
  "streams list",
  "traces get",
  "traces list",
  "usage show",
  "webhooks create",
  "webhooks deliveries",
  "webhooks list",
  "webhooks replay-delivery",
  "webhooks rotate-secret",
])

const EXTRA_KNOWN_OPTION_FLAGS = [
  "--accession-number",
  "--action-type",
  "--api-key",
  "--approval-threshold-cents",
  "--artifact-id",
  "--as-of-date-from",
  "--as-of-date-to",
  "--benchmark-holdings-file",
  "--benchmark-holdings-json",
  "--benchmark-label",
  "--body-file",
  "--body-json",
  "--base-url",
  "--cancel-url",
  "--candidates",
  "--category",
  "--cik",
  "--client",
  "--compact",
  "--constraints-file",
  "--constraints-json",
  "--country",
  "--cursor",
  "--cusip",
  "--date-from",
  "--date-to",
  "--date_from",
  "--date_to",
  "--days",
  "--delivery-id",
  "--description",
  "--destination-url",
  "--direction",
  "--dry-run",
  "--effective-date-from",
  "--effective-date-to",
  "--event-id",
  "--event-types",
  "--execution-date-from",
  "--execution-date-to",
  "--expand",
  "--export-format",
  "--f1",
  "--f2",
  "--factor",
  "--factor-key",
  "--factor1",
  "--factor2",
  "--factorKey",
  "--factors",
  "--figi",
  "--filed-at-from",
  "--filed-at-to",
  "--filing-date",
  "--filing-year",
  "--form",
  "--form-type",
  "--format",
  "--frequency",
  "--hedge-file",
  "--hedge-json",
  "--holdings-file",
  "--holdings-json",
  "--horizons",
  "--ids",
  "--include",
  "--include-attribution",
  "--include-hedge",
  "--include-optimizer",
  "--include-position-views",
  "--include-v2",
  "--indicator",
  "--indicator-key",
  "--is-atm",
  "--isin",
  "--json",
  "--key",
  "--keys",
  "--kind",
  "--label",
  "--limit",
  "--live",
  "--lookback",
  "--max-hedges",
  "--maxHedges",
  "--meeting-type",
  "--meter-class",
  "--method",
  "--metric",
  "--min-abs-z-score",
  "--min-z-score",
  "--minAbsZScore",
  "--min_z_score",
  "--mode",
  "--model",
  "--model-file",
  "--model-id",
  "--model-json",
  "--name",
  "--objective",
  "--offering-type",
  "--optimizer-file",
  "--optimizer-json",
  "--org-id",
  "--overall-risk",
  "--output",
  "--path",
  "--period",
  "--period-ended-from",
  "--period-ended-to",
  "--persona",
  "--plan",
  "--point-limit",
  "--pointLimit",
  "--point_limit",
  "--points",
  "--portfolio-id",
  "--print",
  "--profile",
  "--q",
  "--query",
  "--query-file",
  "--query-json",
  "--range",
  "--report-date",
  "--request-id",
  "--request-summary",
  "--response-mode",
  "--return-url",
  "--scenario-key",
  "--scopes",
  "--section",
  "--side",
  "--signal",
  "--since",
  "--soft-cap-cents",
  "--sort",
  "--source",
  "--source-type",
  "--spend-cap-cents",
  "--stance",
  "--statement",
  "--status",
  "--stream-id",
  "--success-url",
  "--symbol",
  "--symbols",
  "--tag",
  "--taxonomy",
  "--ticker",
  "--tickers",
  "--token",
  "--topics",
  "--trace-id",
  "--transport",
  "--ttl-seconds",
  "--type",
  "--unit",
  "--units",
  "--version",
  "--view",
  "--webhook-id",
  "--what-if-holdings-file",
  "--what-if-holdings-json",
  "--what-if-label",
  "--weighting",
  "--weighting-mode",
  "--window",
] as const

function wantsHelp() {
  return args.includes("--help") || args.includes("-h")
}

function printCommandHelp(key: string, help: CommandHelp) {
  const lines = [
    `Usage: ${help.usage}`,
    "",
    help.summary,
  ]
  if (help.flags?.length) {
    lines.push("", "Options:")
    for (const flag of help.flags) lines.push(`  ${flag}`)
  }
  if (help.examples?.length) {
    lines.push("", "Examples:")
    for (const example of help.examples) lines.push(`  ${example}`)
  }
  if (key === "doctor") {
    lines.push("", "Authentication: optional. Set SECAPI_API_KEY or pipe through --api-key-stdin to verify account context.")
  } else if (!["agent-context", "completion", "config profiles", "config show", "examples", "health"].includes(key)) {
    lines.push("", "Authentication: set SECAPI_API_KEY, SECAPI_OPERATOR_API_KEY, SECAPI_BEARER_TOKEN, or use a documented stdin credential flag when the command calls the API.")
  }
  process.stdout.write(`${lines.join("\n")}\n`)
}

function commandHelpForKey(key: string) {
  const help = COMMAND_HELP[key]
  if (help) return help
  if (!IMPLEMENTED_COMMAND_KEYS.has(key)) return undefined

  const detail = agentContextCommandDetail(key)
  const flags = [...detail.requiredFlags]
  const examples = [...detail.examples]
  if (DRY_RUN_MUTATION_COMMANDS.has(key)) {
    flags.push("--dry-run")
    const dryRunExample = examples[0] ? `${examples[0]} --dry-run` : `secapi ${key} --dry-run`
    examples.push(dryRunExample)
  }
  return {
    usage: detail.usage,
    summary: `${detail.mutates ? "Run" : "Fetch"} the ${key.replaceAll("-", " ")} workflow.`,
    flags,
    examples,
  } satisfies CommandHelp
}

function printGroupHelp(group: string, keys: string[]) {
  const lines = [
    `Usage: secapi ${group} <command> [options]`,
    "",
    `Commands in '${group}':`,
  ]
  for (const key of keys) {
    const help = commandHelpForKey(key)
    lines.push(`  ${help?.usage ?? `secapi ${key}`}`)
  }
  lines.push("", `Run 'secapi ${keys[0]} --help' for command-specific options.`)
  process.stdout.write(`${lines.join("\n")}\n`)
}

function editDistance(left: string, right: string) {
  const rows = Array.from({ length: left.length + 1 }, (_, row) => {
    const values = Array<number>(right.length + 1).fill(0)
    values[0] = row
    return values
  })
  for (let column = 0; column <= right.length; column += 1) rows[0][column] = column

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + cost,
      )
    }
  }
  return rows[left.length][right.length]
}

function knownCommandKeys() {
  return [...new Set([
    ...Object.keys(COMMAND_HELP),
    ...Object.values(GROUP_HELP).flat(),
  ])].sort()
}

function optionFlagName(arg: string) {
  if (!arg.startsWith("-") || arg === "--") return null
  if (!arg.startsWith("--")) return arg
  const equalsIndex = arg.indexOf("=")
  return equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg
}

function knownOptionFlags() {
  return new Set([
    ...GLOBAL_OPTION_FLAGS,
    STDIN_FLAG_NAME,
    STDIN_BEARER_FLAG_NAME,
    ...EXTRA_KNOWN_OPTION_FLAGS,
    ...Object.values(COMMAND_HELP)
      .flatMap((help) => help.flags ?? [])
      .map((flag) => flag.split(/\s+/)[0])
      .filter((flag) => flag.startsWith("-")),
  ])
}

const GLOBAL_OPTION_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--base-url",
  "--dry-run",
  "--output",
  "--profile",
  "--request-summary",
])

function optionFlagsFromText(value: string) {
  return value.match(/--[A-Za-z0-9_-]+|-[A-Za-z]/g) ?? []
}

function commandHasCuratedOptionMetadata(commandKey: string) {
  return STRICT_OPTION_COMMANDS.has(commandKey)
}

const STRICT_OPTION_COMMANDS = new Set([
  "agent-context",
  "agents context",
  "agents setup",
  "billing show",
  "completion",
  "config profiles",
  "config show",
  "doctor",
  "examples",
  "health",
  "init",
  "limits show",
  "mcp install",
  "me",
  "traces get",
  "traces list",
  "usage show",
])

function commandAllowedOptionFlags(commandKey: string) {
  if (!commandHasCuratedOptionMetadata(commandKey)) return null

  const help = commandHelpForKey(commandKey)
  const flags = new Set([
    ...GLOBAL_OPTION_FLAGS,
    STDIN_FLAG_NAME,
    STDIN_BEARER_FLAG_NAME,
  ])

  for (const source of [
    help?.usage,
    ...(help?.flags ?? []),
    ...(help?.examples ?? []),
    ...(AGENT_CONTEXT_COMMAND_OVERRIDES[commandKey]?.requiredFlags ?? []),
  ].filter((value): value is string => Boolean(value))) {
    for (const flag of optionFlagsFromText(source)) flags.add(flag)
  }

  if (DRY_RUN_MUTATION_COMMANDS.has(commandKey) || commandKey === "init" || commandKey === "mcp install" || commandKey === "agents setup") {
    flags.add("--dry-run")
  }

  return flags
}

function commandHelpKeyForArgs(group: string, command: string) {
  if (COMMAND_HELP[group]) return group
  const key = command && !command.startsWith("-") ? `${group} ${command}` : group
  return COMMAND_HELP[key] ? key : null
}

function implementedCommandKeyForArgs(group: string, command: string) {
  if (IMPLEMENTED_COMMAND_KEYS.has(group)) return group
  const key = command && !command.startsWith("-") ? `${group} ${command}` : group
  return IMPLEMENTED_COMMAND_KEYS.has(key) ? key : null
}

function agentContextCommandUsage(commandKey: string) {
  return COMMAND_HELP[commandKey]?.usage ?? `secapi ${commandKey}`
}

type AgentContextCommandDetail = {
  command: string
  usage: string
  auth: "none" | "api_key" | "bearer" | "optional_api_key"
  mutates: boolean
  output: "json" | "json_or_csv" | "text" | "human_or_json" | "file_or_text" | "json_or_markdown"
  requiredFlags: string[]
  examples: string[]
}

type AgentContextCommandOverride = Partial<Omit<AgentContextCommandDetail, "command" | "usage">>

const AGENT_CONTEXT_COMMAND_OVERRIDES: Record<string, AgentContextCommandOverride> = {
  "admin deliveries-summary": { requiredFlags: ["--org-id"], examples: ["secapi admin deliveries-summary --org-id org_... --limit 20"] },
  "admin org": { requiredFlags: ["--org-id"], examples: ["secapi admin org --org-id org_..."] },
  "admin request": { requiredFlags: ["--org-id", "--request-id"], examples: ["secapi admin request --org-id org_... --request-id req_..."] },
  "agent bootstrap": { auth: "none", mutates: true, requiredFlags: ["--token"], examples: ["secapi agent bootstrap --token agbt_... --label first-agent-key"] },
  "agent bootstrap-token": { auth: "bearer", mutates: true, requiredFlags: ["--label"], examples: ["secapi agent bootstrap-token --label ci --scopes read:sec --ttl-seconds 900"] },
  "agent-context": { auth: "none", output: "json", examples: ["secapi agent-context"] },
  "agents context": { auth: "none", output: "json", examples: ["secapi agents context"] },
  "agents personas": { auth: "none", output: "human_or_json", examples: ["secapi agents personas --json"] },
  "agents prompts": { auth: "none", output: "human_or_json", examples: ["secapi agents prompts list --persona law-firm", "secapi agents prompts read law-firm-enforcement-history"] },
  "agents setup": { auth: "optional_api_key", mutates: true, output: "file_or_text", requiredFlags: ["--client"], examples: ["secapi agents setup --client cursor --print"] },
  "api-keys create": { mutates: true, requiredFlags: ["--label"], examples: ["secapi api-keys create --label local-dev --scopes read:sec"] },
  "artifacts bundle": { mutates: true, requiredFlags: ["--ticker|--cik"], examples: ["secapi artifacts bundle --ticker AAPL --form 10-K --section item_1a"] },
  "artifacts export": { output: "json_or_markdown", requiredFlags: ["--artifact-id"], examples: ["secapi artifacts export --artifact-id art_... --format markdown"] },
  "artifacts manifest": { requiredFlags: ["--artifact-id"], examples: ["secapi artifacts manifest --artifact-id art_..."] },
  "artifacts reconcile": { mutates: true, requiredFlags: ["--artifact-id"], examples: ["secapi artifacts reconcile --artifact-id art_..."] },
  "billing budget": { mutates: true, examples: ["secapi billing budget --spend-cap-cents 900 --soft-cap-cents 500"] },
  "billing checkout": { mutates: true, requiredFlags: ["--plan"], examples: ["secapi billing checkout --plan personal"] },
  "billing portal": { mutates: true, examples: ["secapi billing portal"] },
  "billing quote": { examples: ["secapi billing quote --meter-class section_extract --units 10"] },
  "billing show": { output: "human_or_json", examples: ["secapi billing show", "secapi billing show --json=false"] },
  "companies balance-sheets": { requiredFlags: ["--ticker"], examples: ["secapi companies balance-sheets --ticker AAPL --period annual"] },
  "companies cash-flow-statements": { requiredFlags: ["--ticker"], examples: ["secapi companies cash-flow-statements --ticker AAPL --period annual"] },
  "companies financials": { requiredFlags: ["--ticker"], examples: ["secapi companies financials --ticker AAPL"] },
  "companies income-statements": { requiredFlags: ["--ticker"], examples: ["secapi companies income-statements --ticker AAPL --period annual"] },
  "companies ratios": { requiredFlags: ["--ticker"], examples: ["secapi companies ratios --ticker AAPL"] },
  "companies search": { requiredFlags: ["--q|--query"], examples: ["secapi companies search --q Apple"] },
  completion: { auth: "none", output: "text", examples: ["secapi completion zsh"] },
  "config profiles": { auth: "none", output: "json", examples: ["secapi config profiles", "secapi --profile local config profiles"] },
  "config show": { auth: "none", examples: ["secapi config show", "secapi --profile local config show", "secapi --base-url http://127.0.0.1:8787 config show"] },
  examples: { auth: "none", output: "human_or_json", examples: ["secapi examples", "secapi examples --json=false"] },
  "diagnostics request": { requiredFlags: ["--request-id"], examples: ["secapi diagnostics request --request-id req_..."] },
  doctor: { auth: "optional_api_key", examples: ["secapi doctor"] },
  "dilution event": { requiredFlags: ["--event-id"], examples: ["secapi dilution event --event-id dil_... --view agent"] },
  "dilution score": { requiredFlags: ["--ticker"], examples: ["secapi dilution score --ticker AAPL --view agent"] },
  "entities resolve": { requiredFlags: ["--ticker|--cik|--query|--name"], examples: ["secapi entities resolve --ticker AAPL"] },
  "events export": { output: "json", examples: ["secapi events export --kind webhook_delivery --format json"] },
  "factors bulk-download": { output: "json_or_csv", examples: ["secapi factors bulk-download --keys VALUE,MOMENTUM --format csv"] },
  "factors custom": { requiredFlags: ["--body-json|--body-file|--query-json|--query-file"], examples: ["secapi factors custom --body-file factor-query.json --response-mode compact"] },
  "factors decomposition": { requiredFlags: ["--ticker|--symbol"], examples: ["secapi factors decomposition --ticker AAPL"] },
  "factors exposures": { requiredFlags: ["--symbols|--tickers"], examples: ["secapi factors exposures --symbols AAPL,MSFT --view agent"] },
  "factors history": { output: "json_or_csv", requiredFlags: ["--factor|--factor-key|--key"], examples: ["secapi factors history --factor VALUE --response-mode compact"] },
  "factors pair-history": { requiredFlags: ["--factor1|--f1", "--factor2|--f2"], examples: ["secapi factors pair-history --factor1 VALUE --factor2 MOMENTUM --view agent"] },
  "factors related-stocks": { requiredFlags: ["--ticker|--symbol"], examples: ["secapi factors related-stocks --ticker AAPL --limit 10"] },
  "factors similarity-pack": { requiredFlags: ["--ticker|--symbol"], examples: ["secapi factors similarity-pack --ticker AAPL --candidates MSFT,NVDA"] },
  "factors sparklines": { output: "json_or_csv", examples: ["secapi factors sparklines --keys VALUE,MOMENTUM --points 32"] },
  "factors valuation-stocks": { output: "json_or_csv", examples: ["secapi factors valuation-stocks --factor VALUE --stance both --format csv"] },
  "factors valuations": { output: "json_or_csv", examples: ["secapi factors valuations --keys VALUE,MOMENTUM --side all"] },
  "filings latest": { requiredFlags: ["--ticker|--cik"], examples: ["secapi filings latest --ticker AAPL --form 10-K"] },
  "filings render": { requiredFlags: ["--ticker|--cik"], examples: ["secapi filings render --ticker AAPL --form 10-K"] },
  "filings search": { examples: ["secapi filings search --ticker AAPL --form 10-K --limit 5"] },
  "facts get": { requiredFlags: ["--tag"], examples: ["secapi facts get --ticker AAPL --tag Revenues --taxonomy us-gaap"] },
  health: { auth: "none", examples: ["secapi health"] },
  init: { auth: "optional_api_key", mutates: true, output: "file_or_text", requiredFlags: ["--client"], examples: ["secapi init --client cursor --print"] },
  "intelligence company": { requiredFlags: ["--ticker|--cik"], examples: ["secapi intelligence company --ticker AAPL --view compact"] },
  "intelligence earnings-preview": { requiredFlags: ["--ticker|--cik"], examples: ["secapi intelligence earnings-preview --ticker AAPL --view compact"] },
  "intelligence footnotes-query": { requiredFlags: ["--ticker|--cik", "--q|--query"], examples: ["secapi intelligence footnotes-query --ticker AAPL --q leases"] },
  "intelligence security": { requiredFlags: ["--ticker|--cik"], examples: ["secapi intelligence security --ticker AAPL --view compact"] },
  "limits show": { output: "human_or_json", examples: ["secapi limits show", "secapi limits show --json=false"] },
  "macro search": { requiredFlags: ["--q|--query"], examples: ["secapi macro search --q inflation --country US"] },
  "macro indicators": { requiredFlags: ["--indicator|--indicator-key"], examples: ["secapi macro indicators --country US --indicator CPIAUCSL --response-mode compact"] },
  "macro high-signal-pack": { examples: ["secapi macro high-signal-pack --country US", "secapi macro high-signal-pack --country US --response-mode standard --include series,trust"] },
  "macro releases": { examples: ["secapi macro releases --country US --status released --limit 10"] },
  "macro calendar": { examples: ["secapi macro calendar --country US --days 30 --limit 12 --response-mode compact"] },
  "macro forecasts": { examples: ["secapi macro forecasts --country US --horizons 2 --response-mode compact"] },
  "macro regimes": { examples: ["secapi macro regimes --country US --lookback 18m --response-mode compact"] },
  "macro credit-ratings": { examples: ["secapi macro credit-ratings --country US"] },
  "macro credit-rating": { requiredFlags: ["--country"], examples: ["secapi macro credit-rating --country US"] },
  me: { output: "human_or_json", examples: ["secapi me", "secapi me --json=false"] },
  "mcp install": { auth: "optional_api_key", mutates: true, output: "file_or_text", requiredFlags: ["--client"], examples: ["secapi mcp install --client claude-code"] },
  "model-portfolios factor-view": { requiredFlags: ["--portfolio-id"], examples: ["secapi model-portfolios factor-view --portfolio-id mp_... --response-mode compact"] },
  "models factor-analysis": { requiredFlags: ["--holdings-json|--holdings-file"], examples: ["secapi models factor-analysis --holdings-file holdings.json --model-id growth-core"] },
  "owners 13f": { requiredFlags: ["--cik"], examples: ["secapi owners 13f --cik 0001067983 --limit 25"] },
  "owners compare-13f": { requiredFlags: ["--cik"], examples: ["secapi owners compare-13f --cik 0001067983"] },
  "portfolio analyze": { requiredFlags: ["--holdings-json|--holdings-file"], examples: ["secapi portfolio analyze --holdings-file holdings.json --benchmark-label SPY --benchmark-holdings-file benchmark.json --keys VALUE,QUALITY"] },
  "portfolio attribution": { requiredFlags: ["--holdings-json|--holdings-file"], examples: ["secapi portfolio attribution --holdings-file holdings.json --frequency monthly"] },
  "portfolio hedge": { requiredFlags: ["--holdings-json|--holdings-file"], examples: ["secapi portfolio hedge --holdings-file holdings.json --objective factor_neutral"] },
  "portfolio optimize": { requiredFlags: ["--holdings-json|--holdings-file"], examples: ["secapi portfolio optimize --holdings-file holdings.json --objective min_drawdown"] },
  "portfolio stress-test": { requiredFlags: ["--holdings-json|--holdings-file"], examples: ["secapi portfolio stress-test --holdings-file holdings.json --scenario-key us_recession"] },
  "search fulltext": { requiredFlags: ["--q|--query"], examples: ["secapi search fulltext --q \"supply chain\" --form 10-K --limit 10"] },
  "search semantic": { requiredFlags: ["--q|--query"], examples: ["secapi search semantic --q \"supplier concentration\" --mode hybrid --view agent"] },
  "sections get": { requiredFlags: ["--ticker|--cik", "--section"], examples: ["secapi sections get --ticker AAPL --form 10-K --section item_1a --view agent"] },
  "sections search": { requiredFlags: ["--q|--query"], examples: ["secapi sections search --ticker AAPL --q risk --form 10-K"] },
  "statements get": { requiredFlags: ["--ticker|--cik"], examples: ["secapi statements get --ticker AAPL --statement all --period annual --limit 1"] },
  "stocks loadings": { requiredFlags: ["--ticker"], examples: ["secapi stocks loadings --ticker AAPL --keys VALUE,QUALITY"] },
  "streams create": { mutates: true, examples: ["secapi streams create --event-types artifact.created --transport poll"] },
  "streams events": { requiredFlags: ["--stream-id"], examples: ["secapi streams events --stream-id strm_... --limit 10"] },
  "traces get": { requiredFlags: ["--trace-id"], examples: ["secapi traces get --trace-id trc_..."] },
  "traces list": { requiredFlags: ["--ids"], examples: ["secapi traces list --ids trc_1,trc_2"] },
  "usage show": { output: "human_or_json", examples: ["secapi usage show", "secapi usage show --json=false"] },
  "webhooks create": { mutates: true, requiredFlags: ["--destination-url"], examples: ["secapi webhooks create --destination-url https://example.com/hooks/sec --event-types artifact.created"] },
  "webhooks deliveries": { requiredFlags: ["--webhook-id"], examples: ["secapi webhooks deliveries --webhook-id wh_... --limit 10"] },
  "webhooks replay-delivery": { mutates: true, requiredFlags: ["--webhook-id", "--delivery-id"], examples: ["secapi webhooks replay-delivery --webhook-id wh_... --delivery-id wdel_..."] },
  "webhooks rotate-secret": { mutates: true, requiredFlags: ["--webhook-id"], examples: ["secapi webhooks rotate-secret --webhook-id wh_..."] },
}

function defaultAgentContextAuth(commandKey: string): AgentContextCommandDetail["auth"] {
  if (commandKey.startsWith("agents ")) return "none"
  return "api_key"
}

function defaultAgentContextMutates(commandKey: string) {
  const mutatingTokens = ["create", "budget", "checkout", "portal", "bootstrap", "bundle", "reconcile", "rotate-secret", "replay-delivery"]
  return mutatingTokens.some((token) => commandKey.includes(token))
}

function defaultAgentContextOutput(commandKey: string): AgentContextCommandDetail["output"] {
  if (commandKey === "agents prompts" || commandKey === "agents personas") return "human_or_json"
  if (commandKey === "init" || commandKey === "mcp install" || commandKey === "agents setup") return "file_or_text"
  return "json"
}

function agentContextCommandDetail(commandKey: string): AgentContextCommandDetail {
  const override = AGENT_CONTEXT_COMMAND_OVERRIDES[commandKey] ?? {}
  const help = COMMAND_HELP[commandKey]
  return {
    command: `secapi ${commandKey}`,
    usage: help?.usage ?? override.examples?.[0] ?? agentContextCommandUsage(commandKey),
    auth: override.auth ?? defaultAgentContextAuth(commandKey),
    mutates: override.mutates ?? defaultAgentContextMutates(commandKey),
    output: override.output ?? defaultAgentContextOutput(commandKey),
    requiredFlags: override.requiredFlags ?? [],
    examples: override.examples ?? help?.examples ?? [],
  }
}

function agentContextCommandGroups() {
  const groups = new Map<string, { commands: string[]; details: AgentContextCommandDetail[] }>()
  for (const commandKey of [...IMPLEMENTED_COMMAND_KEYS].sort()) {
    const groupName = commandKey.includes(" ") ? commandKey.slice(0, commandKey.indexOf(" ")) : "root"
    const group = groups.get(groupName) ?? { commands: [], details: [] }
    group.commands.push(agentContextCommandUsage(commandKey))
    group.details.push(agentContextCommandDetail(commandKey))
    groups.set(groupName, group)
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, { commands, details }]) => ({ group, commands, details }))
}

function nearestCommandSuggestions(label: string) {
  const normalized = label.trim().toLowerCase()
  if (!normalized || normalized === "unknown") return []

  return knownCommandKeys()
    .map((command) => ({ command, distance: editDistance(normalized, command) }))
    .filter(({ command, distance }) => {
      const maxDistance = command.includes(" ") ? 4 : 2
      return distance > 0 && distance <= maxDistance
    })
    .sort((a, b) => a.distance - b.distance || a.command.localeCompare(b.command))
    .slice(0, 3)
    .map(({ command }) => command)
}

function unknownCommandError() {
  const label = unknownCommandLabel()
  const suggestions = nearestCommandSuggestions(label)
  const suggestionText = suggestions.length > 0
    ? `\nDid you mean ${suggestions.map((command) => `'secapi ${command}'`).join(" or ")}?`
    : ""
  return `Unknown command: secapi ${label}${suggestionText}\nRun 'secapi --help' to list supported commands.`
}

function nearestOptionSuggestions(flag: string) {
  const knownFlags = [...knownOptionFlags()].sort()
  const candidates = knownFlags
    .map((knownFlag) => ({ flag: knownFlag, distance: editDistance(flag, knownFlag) }))
    .filter(({ distance }) => distance > 0 && distance <= 3)
    .sort((a, b) => a.distance - b.distance || a.flag.localeCompare(b.flag))
  const nearestDistance = candidates[0]?.distance
  if (nearestDistance === undefined) return []
  return candidates
    .filter(({ distance }) => distance === nearestDistance)
    .slice(0, 3)
    .map(({ flag }) => flag)
}

function rejectUnknownOptionFlags(commandKey: string) {
  const knownFlags = knownOptionFlags()
  const allowedFlags = commandAllowedOptionFlags(commandKey)
  for (const arg of args) {
    const flag = optionFlagName(arg)
    if (!flag) continue
    if (knownFlags.has(flag)) {
      if (!allowedFlags || allowedFlags.has(flag)) continue
      throw new Error(
        `Unsupported option for secapi ${commandKey}: ${flag}\n` +
        `Run 'secapi ${commandKey} --help' for command-specific options.`,
      )
    }

    const suggestions = nearestOptionSuggestions(flag)
    const suggestionText = suggestions.length > 0
      ? `\nDid you mean ${suggestions.map((suggestion) => `'${suggestion}'`).join(" or ")}?`
      : ""
    throw new Error(
      `Unknown option for secapi ${commandKey}: ${flag}${suggestionText}\n` +
      `Run 'secapi ${commandKey} --help' for command-specific options.`,
    )
  }
}

const SUPPORTED_COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const

function completionUsageError() {
  return [
    "Usage: secapi completion <bash|zsh|fish>",
    "Examples:",
    "  secapi completion zsh > ~/.zfunc/_secapi",
    "  secapi completion bash > ~/.secapi-completion.bash",
    "  secapi completion fish > ~/.config/fish/completions/secapi.fish",
  ].join("\n")
}

function completionInventory() {
  const rootCommands = new Set<string>()
  const subcommandsByGroup = new Map<string, Set<string>>()

  for (const commandKey of [...IMPLEMENTED_COMMAND_KEYS].sort()) {
    const [group, subcommand] = commandKey.split(" ")
    rootCommands.add(group)
    if (!subcommand) continue
    const subcommands = subcommandsByGroup.get(group) ?? new Set<string>()
    subcommands.add(subcommand)
    subcommandsByGroup.set(group, subcommands)
  }

  subcommandsByGroup.set("completion", new Set(SUPPORTED_COMPLETION_SHELLS))

  return {
    rootCommands: [...rootCommands].sort(),
    optionFlags: [...knownOptionFlags()]
      .filter((flag) => !REJECTED_CREDENTIAL_FLAGS.has(flag))
      .sort(),
    subcommandsByGroup: [...subcommandsByGroup.entries()]
      .map(([group, subcommands]) => [group, [...subcommands].sort()] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  }
}

function renderBashCompletion() {
  const { rootCommands, optionFlags, subcommandsByGroup } = completionInventory()
  const lines = [
    "# secapi completion for bash",
    "_secapi_completion() {",
    "  local cur first",
    "  COMPREPLY=()",
    "  cur=\"${COMP_WORDS[COMP_CWORD]}\"",
    "  first=\"${COMP_WORDS[1]}\"",
    "",
    "  if [[ \"$cur\" == -* ]]; then",
    `    COMPREPLY=( $(compgen -W "${optionFlags.join(" ")}" -- "$cur") )`,
    "    return 0",
    "  fi",
    "",
    "  if [[ $COMP_CWORD -le 1 ]]; then",
    `    COMPREPLY=( $(compgen -W "${rootCommands.join(" ")}" -- "$cur") )`,
    "    return 0",
    "  fi",
    "",
    "  case \"$first\" in",
  ]
  for (const [group, subcommands] of subcommandsByGroup) {
    lines.push(`    ${group}) COMPREPLY=( $(compgen -W "${subcommands.join(" ")}" -- "$cur") ) ;;`)
  }
  lines.push(
    "  esac",
    "}",
    "complete -F _secapi_completion secapi",
    "complete -F _secapi_completion omni-sec",
  )
  return `${lines.join("\n")}\n`
}

function renderZshCompletion() {
  const { rootCommands, optionFlags, subcommandsByGroup } = completionInventory()
  const lines = [
    "#compdef secapi omni-sec",
    "",
    "_secapi() {",
    "  local -a commands options subcommands",
    `  commands=(${rootCommands.join(" ")})`,
    `  options=(${optionFlags.join(" ")})`,
    "",
    "  if [[ ${words[CURRENT]} == -* ]]; then",
    "    compadd -- $options",
    "    return",
    "  fi",
    "",
    "  if [[ $CURRENT -le 2 ]]; then",
    "    compadd -- $commands",
    "    return",
    "  fi",
    "",
    "  case ${words[2]} in",
  ]
  for (const [group, subcommands] of subcommandsByGroup) {
    lines.push(`    ${group}) subcommands=(${subcommands.join(" ")}) ;;`)
  }
  lines.push(
    "    *) subcommands=() ;;",
    "  esac",
    "  compadd -- $subcommands",
    "}",
    "",
    "_secapi \"$@\"",
  )
  return `${lines.join("\n")}\n`
}

function renderFishCompletion() {
  const { rootCommands, optionFlags, subcommandsByGroup } = completionInventory()
  const lines = [
    "# secapi completion for fish",
  ]
  for (const binary of ["secapi", "omni-sec"]) {
    lines.push(`complete -c ${binary} -f`)
    lines.push(`complete -c ${binary} -n "__fish_use_subcommand" -a "${rootCommands.join(" ")}"`)
    for (const [group, subcommands] of subcommandsByGroup) {
      lines.push(`complete -c ${binary} -n "__fish_seen_subcommand_from ${group}" -a "${subcommands.join(" ")}"`)
    }
    for (const flag of optionFlags) {
      if (flag.startsWith("--")) {
        lines.push(`complete -c ${binary} -l ${flag.slice(2)}`)
      } else if (/^-[A-Za-z]$/.test(flag)) {
        lines.push(`complete -c ${binary} -s ${flag.slice(1)}`)
      }
    }
  }
  return `${lines.join("\n")}\n`
}

function renderCompletionScript(shellArg?: string) {
  if (!shellArg || shellArg.startsWith("-")) throw new Error(completionUsageError())
  const shell = shellArg.trim().toLowerCase()
  if (!(SUPPORTED_COMPLETION_SHELLS as readonly string[]).includes(shell)) {
    throw new Error(`Unsupported completion shell: ${shell}\n${completionUsageError()}`)
  }

  if (shell === "bash") return renderBashCompletion()
  if (shell === "zsh") return renderZshCompletion()
  return renderFishCompletion()
}

function commandKeyForCurrentArgs() {
  const tokens = args.filter((arg) => !arg.startsWith("-")).slice(0, 3)
  for (let length = tokens.length; length >= 1; length--) {
    const key = tokens.slice(0, length).join(" ")
    if (IMPLEMENTED_COMMAND_KEYS.has(key)) return key
  }
  return undefined
}

function formatErrorForCurrentCommand(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (!/^--[\w-]+/.test(message) || !/\brequired\b/i.test(message) || message.includes("Usage:")) return message

  const commandKey = commandKeyForCurrentArgs()
  if (!commandKey) return message

  const help = commandHelpForKey(commandKey)
  const example = AGENT_CONTEXT_COMMAND_OVERRIDES[commandKey]?.examples?.[0] ?? help?.examples?.[0]
  const lines = [message]
  if (help) {
    lines.push("", `Usage: ${help.usage}`)
  }
  if (example) {
    lines.push(`Example: ${example}`)
  }
  lines.push(`Run 'secapi ${commandKey} --help' for command-specific options.`)
  return lines.join("\n")
}

function maybePrintCommandHelp(group: string, command: string) {
  if (!wantsHelp() || args.length === 0 || group === "help" || group === "--help" || group === "-h") return false

  const key = command && !command.startsWith("-") ? `${group} ${command}` : group
  const help = commandHelpForKey(key)
  if (help) {
    printCommandHelp(key, help)
    return true
  }

  const groupHelp = GROUP_HELP[group]
  if (groupHelp && (!command || command.startsWith("-"))) {
    printGroupHelp(group, groupHelp)
    return true
  }

  throw new Error(unknownCommandError())
}

async function main() {
  rejectCredentialArgvFlags()
  profileArg = consumeGlobalStringArg("--profile")
  baseUrlArg = consumeGlobalStringArg("--base-url")

  // --version / -v must short-circuit before help fallback so they print the bare
  // version rather than the full command banner.
  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    printRaw(cliVersion())
    return
  }

  const [group = "help", command = ""] = args
  const wantsFullRootHelp = group === "--help-all" || (group === "help" && command === "all")
  const isRootHelp = args.length === 0 || group === "help" || group === "--help" || group === "-h" || wantsFullRootHelp
  if (maybePrintCommandHelp(group, command)) return
  const implementedCommandKey = implementedCommandKeyForArgs(group, command)
  if (implementedCommandKey) rejectUnknownOptionFlags(implementedCommandKey)
  outputPathFlag()
  const wantsDryRun = hasFlag("--dry-run")
  if (wantsDryRun && implementedCommandKey && !supportsMutationDryRun(implementedCommandKey) && implementedCommandKey !== "init" && implementedCommandKey !== "mcp install" && implementedCommandKey !== "agents setup") {
    throw new Error(`--dry-run is not supported for secapi ${implementedCommandKey}\nRun 'secapi ${implementedCommandKey} --help' for supported options.`)
  }

  if (group === "completion") {
    printRaw(renderCompletionScript(command))
    return
  }

  if (group === "examples") {
    printExamples()
    return
  }

  if (group === "config" && command === "profiles") {
    print(localProfilesReport())
    return
  }

  if (!isRootHelp) baseUrl = resolveBaseUrl()
  if (group === "config" && command === "show") {
    print(localConfigReport())
    return
  }

  const setupPreviewCommands = new Set(["init", "mcp install", "agents setup"])
  const isSetupPreview =
    Boolean(implementedCommandKey && setupPreviewCommands.has(implementedCommandKey)) &&
    (hasFlag("--print") || wantsDryRun)
  const credentials =
    isRootHelp || isSetupPreview || (wantsDryRun && supportsMutationDryRun(implementedCommandKey))
      ? {}
      : await resolveCredentials()
  const apiClient = defaultClient(credentials)
  const anonymousClient = new SecApiClient({ baseUrl, fetch: captureFetch() })

  if (group === "health") {
    print(await apiClient.health())
    return
  }

  if (group === "doctor") {
    const report = await runDoctor(apiClient, credentials)
    print(report)
    if (!report.ok) process.exitCode = 1
    return
  }

  if (group === "me") {
    printAccountResult("me", await apiClient.me())
    return
  }

  if (group === "org" && command === "show") {
    print(await apiClient.org())
    return
  }

  if (group === "billing" && command === "show") {
    printAccountResult("billing show", await apiClient.billing())
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
    printAccountResult("usage show", await apiClient.usage())
    return
  }

  if (group === "limits" && command === "show") {
    printAccountResult("limits show", await apiClient.limits())
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
    const body = {
      label: getFlag("--label"),
      scopes: getListFlag("--scopes"),
      livemode: hasFlag("--live"),
    }
    if (wantsDryRun) {
      mutationDryRun("api-keys create", { method: "POST", path: "/v1/api_keys", body })
      return
    }
    print(await apiClient.createApiKey(body))
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
      writeOutput(prompt.prompt, { ensureTrailingNewline: false })
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
    const body = {
      spendCapCents: getNullableIntegerFlag("--spend-cap-cents"),
      softCapCents: getNullableIntegerFlag("--soft-cap-cents"),
      approvalThresholdCents: getNullableIntegerFlag("--approval-threshold-cents"),
    }
    if (wantsDryRun) {
      mutationDryRun("billing budget", { method: "PUT", path: "/v1/billing/budget", body })
      return
    }
    print(await apiClient.updateBillingBudget(body))
    return
  }

  if (group === "billing" && command === "checkout") {
    const planKey = getFlag("--plan")
    if (!planKey) throw new Error("--plan is required")
    const body = {
      planKey,
      successUrl: getFlag("--success-url"),
      cancelUrl: getFlag("--cancel-url"),
    }
    if (wantsDryRun) {
      mutationDryRun("billing checkout", { method: "POST", path: "/v1/billing/checkout", body })
      return
    }
    print(await apiClient.createCheckoutSession(body))
    return
  }

  if (group === "billing" && command === "portal") {
    const body = {
      returnUrl: getFlag("--return-url"),
    }
    if (wantsDryRun) {
      mutationDryRun("billing portal", { method: "POST", path: "/v1/billing/portal", body })
      return
    }
    print(await apiClient.createBillingPortalSession(body))
    return
  }

  if (group === "webhooks" && command === "list") {
    print(await apiClient.listWebhookEndpoints())
    return
  }

  if (group === "webhooks" && command === "create") {
    const destinationUrl = getFlag("--destination-url")
    if (!destinationUrl) throw new Error("--destination-url is required")
    const body = {
      destinationUrl,
      description: getFlag("--description"),
      subscribedEventTypes: getListFlag("--event-types"),
      livemode: hasFlag("--live"),
    }
    if (wantsDryRun) {
      mutationDryRun("webhooks create", { method: "POST", path: "/v1/webhook_endpoints", body })
      return
    }
    print(await apiClient.createWebhookEndpoint(body))
    return
  }

  if (group === "webhooks" && command === "rotate-secret") {
    const webhookId = getFlag("--webhook-id")
    if (!webhookId) throw new Error("--webhook-id is required")
    if (wantsDryRun) {
      mutationDryRun("webhooks rotate-secret", {
        method: "POST",
        path: `/v1/webhook_endpoints/${encodeURIComponent(webhookId)}/rotate_secret`,
      })
      return
    }
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
    if (wantsDryRun) {
      mutationDryRun("webhooks replay-delivery", {
        method: "POST",
        path: `/v1/webhook_endpoints/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      })
      return
    }
    print(await apiClient.replayWebhookDelivery(webhookId, deliveryId))
    return
  }

  if (group === "streams" && command === "list") {
    print(await apiClient.listStreamSubscriptions())
    return
  }

  if (group === "streams" && command === "create") {
    const transport = getEnumFlag("--transport", ["poll", "webhook_mirror", "websocket"] as const, "stream transport") ?? "poll"
    const body = {
      description: getFlag("--description"),
      eventTypes: getListFlag("--event-types"),
      transport,
      livemode: hasFlag("--live"),
    }
    if (wantsDryRun) {
      mutationDryRun("streams create", { method: "POST", path: "/v1/stream_subscriptions", body })
      return
    }
    print(await apiClient.createStreamSubscription(body))
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
      name: getFlag("--name") ?? getFlag("--query"),
    }))
    return
  }

  if (group === "traces" && command === "list") {
    const ids = getListFlag("--ids")
    if (!ids || ids.length === 0) throw new Error("--ids is required")
    print(await apiClient.listTraces({ ids }))
    return
  }

  if (group === "traces" && command === "get") {
    const traceId = getFlag("--trace-id") ?? args[2]
    if (!traceId || traceId.startsWith("--")) throw new Error("--trace-id is required")
    print(await apiClient.getTrace(traceId))
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
      mode: getSemanticModeFlag(),
      limit: getNumberFlag("--limit"),
      view: getResponseViewFlag(),
    }))
    return
  }

  if (group === "sections" && command === "get") {
    const sectionView = getResponseViewFlag()
    print(await apiClient.latestSection({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      form: getFlag("--form") ?? "10-K",
      sectionKey: getFlag("--section") ?? "item_1a",
      mode:
        sectionView === "agent" || sectionView === "compact"
          ? "compact"
          : sectionView === "default"
            ? "full"
            : getFlag("--mode") === "compact"
              ? "compact"
              : getFlag("--mode") === "full"
                ? "full"
                : undefined,
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
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
    }))
    return
  }

  if (group === "compensation" && command === "list") {
    print(await apiClient.compensation({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
    }))
    return
  }

  if (group === "events" && command === "enforcement") {
    print(await apiClient.enforcementActions({
      query: getFlag("--query") ?? undefined,
      source_type: getEnforcementSourceTypeFlag(),
      date_from: getFlag("--date-from") ?? undefined,
      date_to: getFlag("--date-to") ?? undefined,
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getResponseViewFlag(),
    }))
    return
  }

  if (group === "events" && command === "voting-results") {
    print(await apiClient.votingResultsEvents({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      date_from: getFlag("--date-from") ?? undefined,
      date_to: getFlag("--date-to") ?? undefined,
      meeting_type: getMeetingTypeFlag(),
      limit: getFlag("--limit") ? Number(getFlag("--limit")) : undefined,
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
    }))
    return
  }

  if (group === "dilution" && command === "event") {
    const eventId = getFlag("--event-id")
    if (!eventId) throw new Error("Usage: secapi dilution event --event-id <id> [--view agent]")
    print(await apiClient.dilutionEventDetail(eventId, { view: getResponseViewFlag() }))
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
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
    }))
    return
  }

  if (group === "dilution" && command === "ratings") {
    print(await apiClient.dilutionRatings({
      ticker: getFlag("--ticker"),
      overall_risk: getDilutionRiskFlag(),
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
    }))
    return
  }

  if (group === "dilution" && command === "score") {
    const ticker = getFlag("--ticker")
    if (!ticker) throw new Error("Usage: secapi dilution score --ticker <symbol> [--view agent]")
    print(await apiClient.dilutionScore({ ticker, view: getResponseViewFlag() }))
    return
  }

  if (group === "dilution" && command === "share-float-history") {
    print(await apiClient.dilutionShareFloatHistory({
      ticker: getFlag("--ticker"),
      as_of_date_from: getFlag("--as-of-date-from") ?? undefined,
      as_of_date_to: getFlag("--as-of-date-to") ?? undefined,
      cursor: getFlag("--cursor") ?? undefined,
      limit: getNumberFlag("--limit"),
      view: getResponseViewFlag(),
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
      view: getResponseViewFlag(),
    }))
    return
  }

  if (group === "companies" && command === "subsidiaries") {
    print(await apiClient.companySubsidiaries({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      view: getResponseViewFlag(),
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
  if (group === "macro" && command === "search") {
    const query = getFlag("--q") ?? getFlag("--query")
    if (!query) throw new Error("--q or --query is required")
    print(await apiClient.macroSearch({
      q: query,
      country: getFlag("--country"),
      frequency: getFlag("--frequency"),
      limit: getNumberFlag("--limit"),
    }))
    return
  }

  if (group === "macro" && command === "high-signal-pack") {
    print(await apiClient.macroHighSignalPack({
      country: getFlag("--country"),
      ...macroResponseParams(),
    }))
    return
  }

  if (group === "macro" && command === "regimes") {
    print(await apiClient.macroRegimes({
      country: getFlag("--country"),
      lookback: getFlag("--lookback"),
      ...macroResponseParams(),
    }))
    return
  }

  if (group === "macro" && command === "indicators") {
    const indicatorKey = getFlag("--indicator") ?? getFlag("--indicator-key")
    if (!indicatorKey) throw new Error("--indicator or --indicator-key is required")
    print(await apiClient.macroIndicators({
      country: getFlag("--country") ?? "US",
      indicator_key: indicatorKey,
      limit: getNumberFlag("--limit"),
      ...macroResponseParams(),
    }))
    return
  }

  if (group === "macro" && command === "releases") {
    print(await apiClient.macroReleases({
      country: getFlag("--country"),
      indicator_key: getFlag("--indicator") ?? getFlag("--indicator-key"),
      status: getEnumFlag("--status", ["released", "scheduled"], "macro release status"),
      days: getNumberFlag("--days"),
      limit: getNumberFlag("--limit"),
      ...macroResponseParams(),
    }))
    return
  }

  if (group === "macro" && command === "calendar") {
    print(await apiClient.macroCalendar({
      country: getFlag("--country"),
      indicator_key: getFlag("--indicator") ?? getFlag("--indicator-key"),
      days: getNumberFlag("--days"),
      limit: getNumberFlag("--limit"),
      ...macroResponseParams(),
    }))
    return
  }

  if (group === "macro" && command === "forecasts") {
    print(await apiClient.macroForecasts({
      country: getFlag("--country"),
      indicator_key: getFlag("--indicator") ?? getFlag("--indicator-key"),
      horizons: getNumberFlag("--horizons"),
      ...macroResponseParams(),
    }))
    return
  }

  if (group === "macro" && command === "credit-ratings") {
    print(await apiClient.macroCreditRatings({
      country: getFlag("--country"),
    }))
    return
  }

  if (group === "macro" && command === "credit-rating") {
    const country = getFlag("--country")
    if (!country) throw new Error("--country is required")
    print(await apiClient.macroCreditRating(country))
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
      metric: getFactorSparklineMetricFlag(),
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
      side: getFactorExtremeMoveSideFlag("--side"),
      direction: getFactorExtremeMoveSideFlag("--direction"),
      sort: getFactorExtremeMoveSortFlag(),
      min_z_score: getNumberFlag("--min-z-score") ?? getNumberFlag("--min_z_score"),
      minAbsZScore: getNumberFlag("--min-abs-z-score") ?? getNumberFlag("--minAbsZScore"),
      limit: getNumberFlag("--limit"),
      ...factorResponseParams(),
    }))
    return
  }

  if (group === "factors" && command === "extreme-pairs") {
    print(await apiClient.factorExtremePairs({
      keys: getListFlag("--keys"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      side: getFactorExtremePairSideFlag("--side"),
      direction: getFactorExtremePairSideFlag("--direction"),
      sort: getFactorExtremePairSortFlag(),
      min_z_score: getNumberFlag("--min-z-score") ?? getNumberFlag("--min_z_score"),
      minAbsZScore: getNumberFlag("--min-abs-z-score") ?? getNumberFlag("--minAbsZScore"),
      limit: getNumberFlag("--limit"),
      ...factorResponseParams(),
    }))
    return
  }

  if (group === "factors" && command === "valuations") {
    const params = {
      keys: getListFlag("--keys") ?? getListFlag("--factors"),
      category: getFlag("--category"),
      window: getFlag("--window"),
      lookback: getFlag("--lookback"),
      side: getFactorValuationSideFlag("--side"),
      signal: getFactorValuationSideFlag("--signal"),
      sort: getFactorValuationSortFlag(),
      weighting_mode: getFactorValuationWeightingModeFlag("--weighting-mode"),
      weighting: getFactorValuationWeightingModeFlag("--weighting"),
      limit: getNumberFlag("--limit"),
      response_mode: getFactorResponseModeFlag("--response-mode") ?? getFactorViewResponseModeFlag("--view"),
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
      signal: getFactorValuationSideFlag("--signal"),
      weighting_mode: getFactorValuationWeightingModeFlag("--weighting-mode"),
      weighting: getFactorValuationWeightingModeFlag("--weighting"),
      stance: getFactorValuationStockStanceFlag("--stance"),
      side: getFactorValuationStockStanceFlag("--side"),
      direction: getFactorValuationStockStanceFlag("--direction"),
      sort: getFactorValuationStockSortFlag(),
      limit: getNumberFlag("--limit"),
      response_mode: getFactorResponseModeFlag("--response-mode") ?? getFactorViewResponseModeFlag("--view"),
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
      ...factorResponseParams(),
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
      ...factorResponseParams(),
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
      frequency: getPortfolioAttributionFrequencyFlag(),
      exportFormat: getPortfolioAttributionExportFormatFlag(),
    }, factorResponseParams()))
    return
  }

  if (group === "portfolio" && command === "hedge") {
    print(await apiClient.portfolioHedge({
      ...portfolioWorkflowBody(),
      objective: getPortfolioObjectiveFlag(),
      mode: getPortfolioHedgeModeFlag(),
      constraints: getObjectInput("--constraints-json", "--constraints-file", "hedge constraints") as any,
    }, factorResponseParams()))
    return
  }

  if (group === "portfolio" && command === "optimize") {
    print(await apiClient.portfolioOptimize({
      ...portfolioWorkflowBody(),
      objective: getPortfolioObjectiveFlag(),
      maxHedges: getNumberFlag("--max-hedges") ?? getNumberFlag("--maxHedges"),
      constraints: getObjectInput("--constraints-json", "--constraints-file", "optimizer constraints") as any,
    }, factorResponseParams()))
    return
  }

  if (group === "portfolio" && command === "stress-test") {
    print(await apiClient.portfolioStressTest({
      ...portfolioWorkflowBody(),
      scenarioKey: getPortfolioScenarioKeyFlag(),
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
      view: getCompactFullViewFlag(),
    }))
    return
  }

  if (group === "intelligence" && command === "company") {
    print(await apiClient.intelligenceCompany({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      view: getCompactFullViewFlag(),
    }))
    return
  }

  if (group === "intelligence" && command === "earnings-preview") {
    print(await apiClient.intelligenceEarningsPreview({
      ticker: getFlag("--ticker"),
      cik: getFlag("--cik"),
      view: getCompactFullViewFlag(),
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

  // --- One-command MCP install (OMNI-4443) ---
  // `secapi init --client <name>` writes the hosted-MCP config for an agent
  // client. The API key is read from SECAPI_API_KEY / --api-key-stdin (never an
  // argv flag — see rejectCredentialArgvFlags); a placeholder is used otherwise.
  if (group === "init" || (group === "agents" && command === "setup") || (group === "mcp" && command === "install")) {
    const mcpUrl = `${baseUrl.replace(/\/+$/, "")}/mcp`
    // init's literal key comes ONLY from the documented SECAPI_API_KEY (or
    // --api-key-stdin) — never the operator-key chain that resolveCredentials
    // prefers, so init never persists an operator key into a client config.
    const initKeySource = hasFlag(STDIN_FLAG_NAME) ? credentials.apiKey : envCredential("SECAPI_API_KEY")
    const literalKey = initKeySource ?? "YOUR_API_KEY"
    const hasRealKey = Boolean(initKeySource)
    const dryRun = hasFlag("--print") || hasFlag("--dry-run")
    const positional = group === "init" && command && !command.startsWith("-")
      ? command
      : group === "mcp" && args[2] && !args[2].startsWith("-")
        ? args[2]
        : undefined
    const clientFlag = getFlag("--client")
    // A `-`-prefixed value means the client name was omitted (e.g. `--client --print`).
    const requested = clientFlag && !clientFlag.startsWith("-") ? clientFlag : positional
    const usageCommand = group === "mcp" ? "secapi mcp install" : "secapi init"

    const claudeDesktopPath = () => {
      const home = homedir()
      if (process.platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      return join(home, ".config", "Claude", "claude_desktop_config.json")
    }
    // keyValue: project-scoped (committable) files get an env-var REFERENCE so a
    // live key is never written to a file that lands in source control; global,
    // owner-only files get the literal key for convenience.
    type FileSpec = { kind: "file"; urlKey: "url" | "serverUrl"; httpType: boolean; keyValue: string; committable: boolean; path: () => string }
    const clients: Record<string, { kind: "command" } | FileSpec> = {
      "claude-code": { kind: "command" },
      "claude-desktop": { kind: "file", urlKey: "url", httpType: true, keyValue: literalKey, committable: false, path: claudeDesktopPath },
      cursor: { kind: "file", urlKey: "url", httpType: false, keyValue: "${SECAPI_API_KEY}", committable: true, path: () => join(process.cwd(), ".cursor", "mcp.json") },
      windsurf: { kind: "file", urlKey: "serverUrl", httpType: false, keyValue: "${env:SECAPI_API_KEY}", committable: false, path: () => join(homedir(), ".codeium", "windsurf", "mcp_config.json") },
      project: { kind: "file", urlKey: "url", httpType: true, keyValue: "${SECAPI_API_KEY}", committable: true, path: () => join(process.cwd(), ".mcp.json") },
    }
    const names = Object.keys(clients).join(", ")

    if (!requested) {
      process.stdout.write(`Usage: ${usageCommand} --client <${names}> [--print]\n\nWrites the SEC API hosted-MCP config (${mcpUrl}, x-api-key) for your agent client.\nProvide your API key via SECAPI_API_KEY (or ${STDIN_FLAG_NAME}); it is never read from an argv flag.\n`)
      return
    }
    const spec = clients[requested]
    if (!spec) throw new Error(`Unknown client '${requested}'. Supported: ${names}`)

    if (spec.kind === "command") {
      // Use $SECAPI_API_KEY (shell-expanded at run time) so no literal key is printed.
      process.stdout.write(`Add SEC API to Claude Code:\n\n  claude mcp add --transport http secapi ${mcpUrl} --header "x-api-key: \$SECAPI_API_KEY"\n`)
      if (!hasRealKey) process.stdout.write(`\nSet SECAPI_API_KEY in your environment first.\n`)
      return
    }

    const filePath = spec.path()
    let config: Record<string, unknown> = {}
    if (existsSync(filePath)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf8"))
      } catch {
        throw new Error(`Existing config at ${filePath} is not valid JSON; fix or move it before running init.`)
      }
      if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
        throw new Error(`Existing config at ${filePath} is not a JSON object; fix or move it before running init.`)
      }
      config = parsed as Record<string, unknown>
    }
    const existingServers = config.mcpServers
    if (existingServers !== undefined && (typeof existingServers !== "object" || existingServers === null || Array.isArray(existingServers))) {
      throw new Error(`Existing "mcpServers" in ${filePath} is not an object; fix or move it before running init.`)
    }
    const servers: Record<string, unknown> = existingServers ? existingServers as Record<string, unknown> : {}
    servers.secapi = {
      ...(spec.httpType ? { type: "http" } : {}),
      [spec.urlKey]: mcpUrl,
      headers: { "x-api-key": spec.keyValue },
    }
    config.mcpServers = servers
    const rendered = `${JSON.stringify(config, null, 2)}\n`

    if (dryRun) {
      process.stdout.write(`# ${filePath}\n${rendered}`)
      return
    }
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, rendered, { mode: 0o600 })
    // chmod after write: writeFileSync's mode only applies on CREATE, so an
    // already-existing config would otherwise keep its prior (looser) perms.
    chmodSync(filePath, 0o600)
    process.stdout.write(`Wrote SEC API MCP config for ${requested} to ${filePath}\n`)
    if (spec.keyValue.startsWith("$")) {
      process.stdout.write(`Set SECAPI_API_KEY in your environment so ${requested} can resolve the key.\n`)
    } else if (!hasRealKey) {
      process.stdout.write(`Replace YOUR_API_KEY in that file with your key (or set SECAPI_API_KEY and re-run).\n`)
    }
    if (spec.committable) {
      process.stdout.write(`Note: ${filePath} can be committed — it uses an env-var reference, not your literal key.\n`)
    }
    process.stdout.write(`Restart ${requested} to load the server.\n`)
    return
  }

  // `secapi agent-context` — machine-readable description of the CLI surface so
  // an agent can learn the whole tool in one call.
  if (group === "agent-context" || (group === "agents" && command === "context")) {
    print({
      object: "agent_context",
      cli: { binaries: ["secapi", "omni-sec"], version: cliVersion() },
      baseUrl,
      mcpUrl: `${baseUrl.replace(/\/+$/, "")}/mcp`,
      docs: "https://docs.secapi.ai",
      agentsPage: "https://secapi.ai/agents",
      auth: {
        header: "x-api-key",
        note: "Authenticate with the x-api-key header. Never send the API key as Authorization: Bearer.",
        envVars: ["SECAPI_API_KEY", "SECAPI_OPERATOR_API_KEY", "SECAPI_BEARER_TOKEN (WorkOS bearer, not an API key)", "SECAPI_PROFILE", "SECAPI_CONFIG_FILE"],
        stdin: [STDIN_FLAG_NAME, STDIN_BEARER_FLAG_NAME],
        baseUrl: "Pass --base-url <url> for one invocation, set SECAPI_BASE_URL for a shell/session default, or set SECAPI_PROFILE to select ~/.config/secapi/profiles.json.",
      },
      install: {
        mcp: `secapi init --client <claude-code|claude-desktop|cursor|windsurf|project> (alias: secapi mcp install --client <name>)`,
        skills: "npx skills add secapi-ai/secapi-skills --global",
      },
      commandGroups: agentContextCommandGroups(),
      conventions: {
        output: "JSON to stdout by default; pass --output <file> to write JSON/raw command output to a file instead of stdout.",
        correlation: "Request-Id header on every response. Pass --request-summary to keep command output on stdout and print request metadata to stderr.",
        guardrails: "Check GET /v1/billing and POST /v1/billing/quote before expensive or repeated workflows.",
      },
    })
    return
  }

  if (!isRootHelp) {
    throw new Error(unknownCommandError())
  }

  const rootHelpLines = [
    "SEC API CLI",
    "Preferred binary: secapi",
    "Compatibility alias: omni-sec",
    "",
    "Start here:",
    "  secapi doctor                         # diagnose base URL, auth, health, account, and MCP setup",
    "  secapi examples                       # starter workflows for humans and agents",
    "  secapi agent-context                  # machine-readable command inventory for agents",
    "  secapi config show                    # local config/auth-source summary; no API request",
    "  secapi config profiles                # list no-secret profiles; no API request",
    "",
    "Core workflows:",
    "  secapi entities resolve --ticker AAPL",
    "  secapi filings latest --ticker AAPL --form 10-K",
    "  secapi sections get --ticker AAPL --form 10-K --section item_1a --view agent",
    "  secapi search fulltext --q \"supply chain\" --form 10-K --limit 10",
    "  secapi statements get --ticker AAPL --statement all --period annual --limit 1",
    "  secapi traces get --trace-id trc_...",
    "",
    "Agent and automation setup:",
    "  secapi mcp install --client claude-code",
    "  secapi init --client cursor --print",
    "  secapi completion zsh",
    "",
    "Safe mutating previews:",
    "  secapi api-keys create --label local-dev --scopes read:sec --dry-run",
    "  secapi webhooks create --destination-url https://example.com/hooks/sec --event-types artifact.created --dry-run",
    "  secapi streams create --event-types artifact.created --transport poll --dry-run",
    "",
    "Discovery:",
    "  secapi <group> --help                  # group help, e.g. secapi filings --help",
    "  secapi <group> <command> --help        # command help, e.g. secapi filings latest --help",
    "  secapi help all                        # full command inventory",
    "  secapi --help-all                      # same as help all",
    "",
    "Global options:",
    "  --base-url <url>                      # override API origin for this invocation",
    "  --profile <name>                     # select a no-secret profile from ~/.config/secapi/profiles.json",
    "  --output <file>                       # write JSON/raw command output to a file",
    "  --request-summary                    # print request metadata JSON to stderr",
    "",
    "Environment:",
    "  SECAPI_API_KEY, SECAPI_BEARER_TOKEN, SECAPI_BASE_URL, SECAPI_PROFILE, SECAPI_CONFIG_FILE",
    `  Use ${STDIN_FLAG_NAME} or ${STDIN_BEARER_FLAG_NAME} for CI/agents; never pass credentials as argv flags.`,
  ]

  const fullCommandHelpLines = [
    "SEC API CLI",
    "Preferred binary: secapi",
    "Compatibility alias: omni-sec",
    "",
    "Global options:",
    "  --base-url <url>                     # override API origin for this invocation",
    "  --profile <name>                    # select a no-secret profile from ~/.config/secapi/profiles.json",
    "  --output <file>                       # write JSON/raw command output to a file",
    "  --request-summary                    # print request metadata JSON to stderr",
    "",
    "Commands:",
    "  secapi health",
    "  secapi config show",
    "  secapi config profiles",
    "  secapi examples",
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
    "  # Connect an agent (one-command MCP install)",
    "  secapi init --client claude-code        # prints the `claude mcp add` command",
    "  secapi init --client cursor             # writes .cursor/mcp.json",
    "  secapi mcp install --client cursor      # alias for agent-client MCP setup",
    "  secapi init --client claude-desktop --print   # dry-run the config",
    "  secapi agent-context                    # machine-readable CLI surface for agents",
    "  secapi completion zsh                   # shell completions for secapi and omni-sec",
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
    "  secapi traces get --trace-id trc_...",
    "  secapi traces list --ids trc_1,trc_2",
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
    "  secapi macro search --q inflation --country US",
    "  secapi macro high-signal-pack --country US",
    "  secapi macro regimes --country US --lookback 18m",
    "  secapi macro indicators --country US --indicator CPIAUCSL --response-mode compact",
    "  secapi macro releases --country US --status released",
    "  secapi macro calendar --country US --days 30 --limit 12 --response-mode compact",
    "  secapi macro forecasts --country US --response-mode compact",
    "  secapi macro credit-ratings --country US",
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
  const commandHelpLines = wantsFullRootHelp ? fullCommandHelpLines : rootHelpLines
  console.log(commandHelpLines.map((line) => (
    line
  )).join("\n"))
}

main().catch((error) => {
  console.error(formatErrorForCurrentCommand(error))
  process.exitCode = 1
}).finally(() => {
  emitRequestSummary()
})
